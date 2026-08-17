//! Tauri #[tauri::command] functions for mpv player control.
//!
//! Each command receives the global PlayerState, locks the inner MpvInstance
//! (if initialized), and delegates to its methods. Commands return
//! `Result<T, String>` so Tauri serializes errors as `{ error: ... }` to the
//! frontend.

use crate::mpv::ffi::{ensure_libmpv_installed, mpv_format, MpvApi, MpvError};
use crate::mpv::handle::MpvInstance;
#[cfg(target_os = "macos")]
use crate::mpv::platform;
use parking_lot::Mutex;
use serde::Serialize;
use std::sync::Arc;
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, State};

// ---------------------------------------------------------------------------
// PlayerState — managed Tauri state
// ---------------------------------------------------------------------------

/// Global player state holding an optional MpvInstance.
/// The instance is created by `mpv_init` and destroyed by `mpv_destroy`.
pub struct PlayerState {
    pub inner: Mutex<Option<MpvInstance>>,
    pub api: Mutex<Option<Arc<MpvApi>>>,
}

impl PlayerState {
    pub fn new() -> Self {
        PlayerState {
            inner: Mutex::new(None),
            api: Mutex::new(None),
        }
    }
}

impl Default for PlayerState {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Helper — run a closure with the locked player instance
// ---------------------------------------------------------------------------

fn with_player<F, T>(state: &PlayerState, f: F) -> Result<T, String>
where
    F: FnOnce(&MpvInstance) -> Result<T, String>,
{
    let guard = state.inner.lock();
    let instance = guard
        .as_ref()
        .ok_or_else(|| "Player not initialized".to_string())?;
    f(instance)
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerStateInfo {
    pub initialized: bool,
    pub is_playing: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvVersionInfo {
    pub loaded: bool,
    pub version: Option<String>,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Initialize the mpv player.
///
/// 1. Loads libmpv dynamically (first call only, cached in state.api)
/// 2. Shows and synchronizes the native GPU video surface.
/// 3. Creates libmpv with `vo=libmpv` and no native input/OSC.
/// 4. Starts the Render API and event-loop threads.
///
/// Returns render mode with React controls enabled.
#[tauri::command]
pub async fn mpv_init(
    app: AppHandle,
    state: State<'_, PlayerState>,
    window: tauri::Window,
) -> Result<serde_json::Value, String> {
    // On Windows, sync/show the GPU surface used by the Render API backend
    // (mpv renders into a GPU surface below the transparent overlay).
    #[cfg(target_os = "windows")]
    let gpu_surface = app.state::<Arc<crate::mpv::gpu_surface::GpuVideoSurface>>();
    #[cfg(target_os = "windows")]
    {
        gpu_surface.sync()?;
        gpu_surface.show()?;
    }

    #[cfg(not(target_os = "macos"))]
    let _ = &window;
    let resource_dir = app.path().resource_dir().ok();

    // Load libmpv (cached after first load)
    // If it fails with LibraryNotFound, try auto-install and retry once.
    let api = {
        let mut api_guard = state.api.lock();
        if let Some(api) = api_guard.as_ref() {
            Arc::clone(api)
        } else {
            match MpvApi::load(resource_dir.as_deref()) {
                Ok(api) => {
                    *api_guard = Some(Arc::clone(&api));
                    api
                }
                Err(MpvError::LibraryNotFound(msg)) => {
                    log::info!("libmpv no encontrada — intentando instalacion automatica...");
                    let _ = app.emit("mpv://dependency-installing", ());

                    match ensure_libmpv_installed() {
                        Ok(path) => {
                            log::info!("libmpv instalada en {path}, reintentando carga...");
                            match MpvApi::load(resource_dir.as_deref()) {
                                Ok(api) => {
                                    *api_guard = Some(Arc::clone(&api));
                                    let _ = app.emit("mpv://dependency-ready", ());
                                    api
                                }
                                Err(e) => {
                                    let _ = app.emit("mpv://dependency-install-failed", ());
                                    return Err(format!(
                                        "No se pudo cargar libmpv incluso despues de instalar: {e}. \
                                         Reintenta o instala manualmente."
                                    ));
                                }
                            }
                        }
                        Err(install_err) => {
                            let _ = app.emit("mpv://dependency-install-failed", ());
                            return Err(format!(
                                "{msg}\n\nIntento de instalacion automatica fallo:\n{install_err}"
                            ));
                        }
                    }
                }
                Err(e) => return Err(e.to_string()),
            }
        }
    };

    // Serialize the complete player lifecycle. React may request another init
    // before the previous instance has been torn down.
    let mut player_guard = state.inner.lock();

    // Keep the Windows mpv context alive for the lifetime of the app. Reuse the
    // Render API context and show its GPU surface when the player opens again.
    #[cfg(target_os = "windows")]
    if let Some(instance) = player_guard.as_ref() {
        let _ = instance.set_property_str("force-media-title", "");
        gpu_surface.sync()?;
        gpu_surface.show()?;

        return Ok(serde_json::json!({
            "mode": "render",
            "os": std::env::consts::OS,
            "useCustom": true,
            "nativeControls": false,
        }));
    }

    if let Some(previous) = player_guard.take() {
        previous.destroy();
    }

        // On Windows, clone the GPU surface for the Render API backend.
    #[cfg(target_os = "windows")]
    let gpu_surface = Arc::clone(&app.state::<Arc<crate::mpv::gpu_surface::GpuVideoSurface>>());

    // The Render API backend is used on Windows (GPU surface) and Linux
    // (offscreen EGL with CPU readback). Both enable React custom controls
    // (`useCustom: true`). macOS uses native wid embedding + uosc.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let use_custom = true;
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    let use_custom = false;

    // On Linux, mpv renders offscreen via EGL (CPU readback). The `wid`
    // property is not used; the frontend pulls frames with
    // `mpv_get_render_frame` and draws them on a `<canvas>`.

    let instance = if use_custom {
        // Render API path: mpv renders offscreen (Linux) or into the native
        // surface below the transparent overlay (Windows).
        #[cfg(target_os = "windows")]
        {
            let mut instance = MpvInstance::new(api, 0, app.clone(), true, None, None, true)?;
            instance.start_gpu_renderer(gpu_surface)?;
            instance
        }
        #[cfg(target_os = "linux")]
        {
            let mut instance = MpvInstance::new(api, 0, app.clone(), true, None, None, true)?;
            // Offscreen EGL render context: mpv renders into an FBO and the
            // frontend reads the pixels via mpv_get_render_frame. Pass a null
            // display pointer so EGL uses EGL_PLATFORM_SURFACELESS_MESA (Mesa)
            // for offscreen rendering; the Wayland platform display does not
            // expose RGBA8 pbuffer configs for ES/OpenGL contexts.
            unsafe { instance.setup_render_context(std::ptr::null_mut()) }?;
            instance
        }
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        unreachable!("use_custom is only true on Windows and Linux")
    } else {
        // Native wid + uosc path (macOS).
        #[cfg(target_os = "macos")]
        {
            let wid = platform::get_mpv_wid(&window)?;
            MpvInstance::new(api, wid, app.clone(), false, None, None, false)?
        }
        #[cfg(not(target_os = "macos"))]
        unreachable!("wid path is only available on macOS")
    };

    // Start event loop, then keep the player in app state.
    instance.start_event_loop();
    *player_guard = Some(instance);

    log::info!(
        "mpv_init: player inicializado correctamente (modo {}, os={}, useCustom={})",
        if use_custom { "render" } else { "wid-uosc" },
        std::env::consts::OS,
        use_custom,
    );

    Ok(serde_json::json!({
        "mode": if use_custom { "render" } else { "wid" },
        "os": std::env::consts::OS,
        "useCustom": use_custom,
        "nativeControls": !use_custom,
    }))
}

/// Load a media file or URL for playback.
#[tauri::command]
pub async fn mpv_loadfile(
    state: State<'_, PlayerState>,
    url: String,
    start_position: Option<f64>,
) -> Result<(), String> {
    // start_position from the frontend is in milliseconds; mpv expects seconds
    let start_seconds = start_position.map(|ms| ms / 1000.0);
    with_player(&state, |instance| instance.loadfile(&url, start_seconds))
}

/// Set an mpv property.
/// Accepts property value as a JSON value (string, number, bool).
#[tauri::command]
pub async fn mpv_set_property(
    state: State<'_, PlayerState>,
    name: String,
    value: serde_json::Value,
) -> Result<(), String> {
    with_player(&state, |instance| match value {
        serde_json::Value::String(s) => instance.set_property_str(&name, &s),
        serde_json::Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                instance.set_property_f64(&name, f)
            } else if let Some(i) = n.as_i64() {
                instance.set_property_i64(&name, i)
            } else {
                instance.set_property_str(&name, &n.to_string())
            }
        }
        serde_json::Value::Bool(b) => instance.set_property_bool(&name, b),
        _ => instance.set_property_str(&name, &value.to_string()),
    })
}

/// Get an mpv property as a JSON value.
#[tauri::command]
pub async fn mpv_get_property(
    state: State<'_, PlayerState>,
    name: String,
) -> Result<serde_json::Value, String> {
    with_player(&state, |instance| {
        // Try string first, then double, then i64, then bool
        if let Ok(s) = instance.get_property_str(&name) {
            return Ok(serde_json::Value::String(s));
        }
        if let Ok(n) = instance.get_property_f64(&name) {
            return Ok(serde_json::json!(n));
        }
        if let Ok(n) = instance.get_property_i64(&name) {
            return Ok(serde_json::json!(n));
        }
        if let Ok(b) = instance.get_property_bool(&name) {
            return Ok(serde_json::Value::Bool(b));
        }
        Err(format!("Could not read property '{name}'"))
    })
}

/// Run an arbitrary mpv command with string arguments.
#[tauri::command]
pub async fn mpv_command(state: State<'_, PlayerState>, args: Vec<String>) -> Result<(), String> {
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    with_player(&state, |instance| instance.command(&refs))
}

/// Observe a property so the event loop emits changes to the frontend.
#[tauri::command]
pub async fn mpv_observe_property(
    state: State<'_, PlayerState>,
    id: u64,
    name: String,
    format_str: String,
) -> Result<(), String> {
    let format = match format_str.to_lowercase().as_str() {
        "string" => mpv_format::MPV_FORMAT_STRING,
        "double" | "f64" => mpv_format::MPV_FORMAT_DOUBLE,
        "int64" | "i64" => mpv_format::MPV_FORMAT_INT64,
        "flag" | "bool" => mpv_format::MPV_FORMAT_FLAG,
        "node" => mpv_format::MPV_FORMAT_NODE,
        _ => return Err(format!("Unknown mpv format: {format_str}")),
    };
    with_player(&state, |instance| {
        instance.observe_property(id, &name, format)
    })
}

/// Destroy the mpv player and release all resources.
#[tauri::command]
#[cfg(target_os = "windows")]
pub async fn mpv_destroy(app: AppHandle, state: State<'_, PlayerState>) -> Result<(), String> {
    let player_guard = state.inner.lock();
    if let Some(instance) = player_guard.as_ref() {
        let _ = instance.set_property_str("force-media-title", "");
        let _ = instance.command(&["stop"]);
    }
    drop(player_guard);

    if let Some(surface) = app.try_state::<Arc<crate::mpv::gpu_surface::GpuVideoSurface>>() {
        let _ = surface.hide();
    }
    log::info!("mpv_destroy: Windows player stopped and hidden");
    Ok(())
}

/// Destroy the mpv player and release all resources.
#[tauri::command]
#[cfg(not(target_os = "windows"))]
pub async fn mpv_destroy(_app: AppHandle, state: State<'_, PlayerState>) -> Result<(), String> {
    // Take the instance under the same lock held throughout mpv_init so destroy
    // cannot hide or tear down a newly initialized player midway through init.
    let mut player_guard = state.inner.lock();
    let instance = player_guard.take();

    if let Some(instance) = instance {
        instance.destroy();
        log::info!("mpv_destroy: player destroyed");
    }
    drop(player_guard);
    Ok(())
}

/// Get the current player state info (initialized, playing).
#[tauri::command]
pub async fn mpv_get_state(state: State<'_, PlayerState>) -> Result<PlayerStateInfo, String> {
    let guard = state.inner.lock();
    match guard.as_ref() {
        Some(instance) => Ok(PlayerStateInfo {
            initialized: true,
            is_playing: instance.is_playing(),
        }),
        None => Ok(PlayerStateInfo {
            initialized: false,
            is_playing: false,
        }),
    }
}

/// Get the latest rendered frame from the offscreen render context.
///
/// Returns raw binary: [width:u32 LE][height:u32 LE][counter:u32 LE][RGBA8 pixels].
/// The frontend parses the header and renders via ImageData on a `<canvas>`.
///
/// Returns an empty frame (all-zeros header) if no frame is available yet.
#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn mpv_get_render_frame(state: State<'_, PlayerState>) -> Result<Response, String> {
    let guard = state.inner.lock();
    match guard.as_ref() {
        Some(instance) => {
            match instance.get_render_frame() {
                Some(fb) => {
                    let w = fb.width;
                    let h = fb.height;
                    let counter = fb.frame_count as u32;
                    let pixels = fb.data;

                    let mut bytes = Vec::with_capacity(12 + pixels.len());
                    bytes.extend_from_slice(&w.to_le_bytes());
                    bytes.extend_from_slice(&h.to_le_bytes());
                    bytes.extend_from_slice(&counter.to_le_bytes());
                    bytes.extend_from_slice(&pixels);

                    Ok(Response::new(bytes))
                }
                None => {
                    // Return empty frame — all-zeros header signals "no frame"
                    let mut bytes = Vec::with_capacity(12);
                    bytes.extend_from_slice(&0u32.to_le_bytes());
                    bytes.extend_from_slice(&0u32.to_le_bytes());
                    bytes.extend_from_slice(&0u32.to_le_bytes());
                    Ok(Response::new(bytes))
                }
            }
        }
        None => Err("Player no inicializado".to_string()),
    }
}

/// Get the frame counter of the latest rendered frame.
/// Cheap — the frontend polls this every animation frame and only fetches the
/// full frame via `mpv_get_render_frame` when the counter advances.
#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn mpv_get_frame_counter(state: State<'_, PlayerState>) -> Result<u32, String> {
    let guard = state.inner.lock();
    match guard.as_ref() {
        Some(instance) => Ok(instance.get_frame_counter()),
        None => Err("Player no inicializado".to_string()),
    }
}

/// Get available audio tracks.
#[tauri::command]
pub async fn mpv_get_audio_tracks(
    _state: State<'_, PlayerState>,
) -> Result<Vec<crate::mpv::events::MpvTrackInfo>, String> {
    // Track list is obtained via observed property; return empty list for now.
    // Full track list is available via the "mpv://tracks-changed" event.
    Ok(Vec::new())
}

/// Get available subtitle tracks.
#[tauri::command]
pub async fn mpv_get_sub_tracks(
    _state: State<'_, PlayerState>,
) -> Result<Vec<crate::mpv::events::MpvTrackInfo>, String> {
    Ok(Vec::new())
}

/// Get available variant tracks (video quality levels).
///
/// Reads the `track-list` property from mpv and returns video tracks with
/// their resolution and codec information as `VariantTrack` items.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VariantTrack {
    pub id: i64,
    pub height: i32,
    pub width: i32,
    pub bandwidth: i64,
    pub active: bool,
    pub label: String,
}

#[tauri::command]
pub async fn mpv_get_variant_tracks(
    state: State<'_, PlayerState>,
) -> Result<Vec<VariantTrack>, String> {
    with_player(&state, |instance| {
        let track_list_json = instance.get_property_str("track-list")?;

        let tracks: Vec<serde_json::Value> = serde_json::from_str(&track_list_json)
            .map_err(|e| format!("Failed to parse track-list JSON: {e}"))?;

        let variants: Vec<VariantTrack> = tracks
            .iter()
            .filter(|t| t.get("type").and_then(|v| v.as_str()) == Some("video"))
            .filter_map(|t| {
                let id = t.get("id")?.as_i64()?;
                let height = t.get("height")?.as_i64()? as i32;
                let width = t.get("width")?.as_i64()? as i32;
                let bandwidth = t.get("demux-bitrate").and_then(|v| v.as_i64()).unwrap_or(0);
                let _codec = t
                    .get("codec")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let label = if height >= 2160 {
                    format!("4K ({height}p)")
                } else if height >= 1440 {
                    format!("1440p ({height}p)")
                } else {
                    format!("{height}p")
                };
                Some(VariantTrack {
                    id,
                    height,
                    width,
                    bandwidth,
                    active: false,
                    label,
                })
            })
            .collect();

        Ok(variants)
    })
}

/// Set the target render size for the offscreen EGL render context.
///
/// Called from the frontend when the video wrapper element resizes.
/// Values are clamped to [16, 3840]. Zeros are ignored (the command returns
/// without updating). The render loop additionally caps the target at
/// 1920x1080 (quality-preserving; the readback stays at display resolution).
#[tauri::command]
pub async fn mpv_set_render_size(
    state: State<'_, PlayerState>,
    width: u32,
    height: u32,
) -> Result<(), String> {
    if width == 0 || height == 0 {
        return Ok(());
    }
    let w = width.clamp(16, 3840);
    let h = height.clamp(16, 3840);
    with_player(&state, |instance| {
        #[cfg(target_os = "linux")]
        instance.set_render_size(w, h);
        Ok(())
    })
}

/// Attempt to auto-install libmpv (Linux only).
///
/// Downloads and extracts libmpv.so.2 from the system package manager
/// into the user's local data directory. Returns the installation path
/// on success or an error description on failure.
#[tauri::command]
pub async fn ensure_libmpv_installed_command() -> Result<String, String> {
    let result = ensure_libmpv_installed()?;
    log::info!("ensure_libmpv_installed: {result}");
    Ok(result)
}

/// Check whether libmpv was loaded successfully and report version info.
#[tauri::command]
pub async fn mpv_check_health(_state: State<'_, PlayerState>) -> Result<MpvVersionInfo, String> {
    let loaded = _state.api.lock().is_some();
    let version = if loaded {
        // Access version via the loaded API
        with_player(&_state, |instance| {
            Ok(instance.get_property_str("mpv-version").ok())
        })
        .ok()
        .flatten()
    } else {
        // Try loading just to check version. No resource_dir here:
        // health checks normally run after mpv_init, which has already
        // resolved the bundled DLLs. This fallback is a no-op in that case.
        match MpvApi::load(None) {
            Ok(api) => {
                let c_name = match std::ffi::CString::new("mpv-version") {
                    Ok(n) => n,
                    Err(_) => {
                        return Ok(MpvVersionInfo {
                            loaded: false,
                            version: None,
                        })
                    }
                };
                let ctx = unsafe { (api.mpv_create)() };
                if ctx.is_null() {
                    return Ok(MpvVersionInfo {
                        loaded: false,
                        version: None,
                    });
                }
                let _ = unsafe { (api.mpv_initialize)(ctx) };
                let ptr = unsafe { (api.mpv_get_property_string)(ctx, c_name.as_ptr()) };
                let ver = if !ptr.is_null() {
                    let s = unsafe { crate::mpv::ffi::c_str_to_string(ptr).unwrap_or_default() };
                    unsafe { (api.mpv_free)(ptr as *mut std::ffi::c_void) };
                    Some(s)
                } else {
                    None
                };
                unsafe { (api.mpv_terminate_destroy)(ctx) };
                drop(api);
                ver
            }
            Err(_) => None,
        }
    };

    Ok(MpvVersionInfo { loaded, version })
}
