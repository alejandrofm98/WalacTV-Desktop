//! Tauri #[tauri::command] functions for mpv player control.
//!
//! Each command receives the global PlayerState, locks the inner MpvInstance
//! (if initialized), and delegates to its methods. Commands return
//! `Result<T, String>` so Tauri serializes errors as `{ error: ... }` to the
//! frontend.

use crate::mpv::ffi::{mpv_format, ensure_libmpv_installed, MpvApi, MpvError};
use crate::mpv::handle::{MpvInstance, LinuxLoweringState};
use crate::mpv::platform;
use parking_lot::Mutex;
use serde::Serialize;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri::ipc::Response;

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
    let instance = guard.as_ref().ok_or_else(|| "Player not initialized".to_string())?;
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
// UOSC path resolution (Linux only)
// ---------------------------------------------------------------------------

/// Resolve uosc loader script and fonts paths using Tauri's resource resolution.
///
/// Tries multiple strategies in order:
/// 1. `app.path().resource_dir()` → `uosc/uosc.lua` (production bundle layout)
/// 2. `app.path().resource_dir()` → `resources/uosc/uosc.lua` (dev alternative)
/// 3. `std::env::current_exe()` parent → `resources/uosc/uosc.lua`
/// 4. `std::env::current_dir()` → `resources/uosc/uosc.lua`
///
/// Returns `(loader_path, fonts_dir_path)` — both `None` if unresolvable.
#[cfg(target_os = "linux")]
fn resolve_uosc_paths(app: &AppHandle) -> (Option<String>, Option<String>) {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();

    // Strategy 1: resource_dir production bundle (uosc/* mapped to uosc/*)
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("uosc/uosc.lua"));
        candidates.push(dir.join("resources/uosc/uosc.lua"));
    }

    // Strategy 2: exe parent (dev mode — target/debug/../resources/uosc/...)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("resources/uosc/uosc.lua"));
            // dev: exe is target/debug/walactv-desktop; go up twice
            if let Some(grandparent) = parent.parent() {
                candidates.push(grandparent.join("resources/uosc/uosc.lua"));
                // src-tauri is typically one more up from target/
                if let Some(great) = grandparent.parent() {
                    candidates.push(great.join("resources/uosc/uosc.lua"));
                }
            }
        }
    }

    // Strategy 3: cwd (running `cargo check` from src-tauri/)
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("resources/uosc/uosc.lua"));
        // cargo tauri dev from project root: resources live in src-tauri/
        candidates.push(cwd.join("src-tauri/resources/uosc/uosc.lua"));
    }

    for path in &candidates {
        if path.exists() {
            eprintln!("[mpv-uosc] Found uosc.lua at: {}", path.display());
            let loader_path = path.to_string_lossy().to_string();

            let fonts_dir = path.parent().unwrap().join("fonts");
            let fonts_str = if fonts_dir.exists() {
                eprintln!("[mpv-uosc] Found fonts dir at: {}", fonts_dir.display());
                Some(fonts_dir.to_string_lossy().to_string())
            } else {
                eprintln!("[mpv-uosc] WARNING: fonts dir NOT found at: {}", fonts_dir.display());
                None
            };

            return (Some(loader_path), fonts_str);
        }
    }

    eprintln!("[mpv-uosc] WARNING: uosc scripts not found — falling back to native OSC");
    (None, None)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Initialize the mpv player.
///
/// 1. Loads libmpv dynamically (first call only, cached in state.api)
/// 2. Extracts the platform window ID from the Tauri window
/// 3. Detects compositor and computes custom-controls mode (Linux only)
/// 4. Creates MpvInstance with wid embedding (all platforms)
/// 5. Sets platform-specific VO options (gpu-context)
/// 6. Stores X11 lowering state for custom controls (Linux only)
/// 7. Starts the event loop
///
/// Returns `{"mode": "wid", "os": "...", "useCustom": bool}`.
/// - `mode`: always `"wid"` — all platforms use native wid embedding.
/// - `os`: platform OS string (e.g. `"linux"`, `"windows"`, `"macos"`).
/// - `useCustom`: true on Linux when compositor is active and HTML controls
///   should be used (mpv OSC disabled, child window lowered).
#[tauri::command]
pub fn mpv_init(
    app: AppHandle,
    state: State<'_, PlayerState>,
    window: tauri::Window,
) -> Result<serde_json::Value, String> {
    // Load libmpv (cached after first load)
    // If it fails with LibraryNotFound, try auto-install and retry once.
    let api = {
        let mut api_guard = state.api.lock();
        if let Some(api) = api_guard.as_ref() {
            Arc::clone(api)
        } else {
            match MpvApi::load() {
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
                            match MpvApi::load() {
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

    // Get platform window ID for wid embedding
    // On X11/Windows: returns the native window handle.
    // On Wayland (with GDK_BACKEND=x11 fallback): returns X11 XID via XWayland.
    let wid = platform::get_mpv_wid(&window)?;

    // ── Linux: detect compositor and compute custom-controls mode ──────
    #[cfg(target_os = "linux")]
    let use_custom = {
        // overlay-HTML disabled — X11+GPU compositing limitation, using native OSC.
        // The env override WALACTV_PLAYER_OSC is still honored for diagnostics/testing
        // but the actual decision is forced to false.
        let osc_env = std::env::var("WALACTV_PLAYER_OSC");
        let force_osc = osc_env.as_deref().map(|v| v == "1").unwrap_or(false);
        let has_compositor = platform::linux::detect_compositor();
        eprintln!("[mpv-init] WALACTV_PLAYER_OSC={:?}, compositor={}, wid=0x{:x}",
            osc_env, has_compositor, wid);
        if force_osc {
            log::info!("mpv_init: WALACTV_PLAYER_OSC=1 — forzando OSC nativo");
        }
        let result = false;  // was: !force_osc && has_compositor — overlay HTML disabled, always use native OSC
        eprintln!("[mpv-init] use_custom={} (overlay-HTML disabled, using native OSC)", result);
        result
    };
    #[cfg(not(target_os = "linux"))]
    let use_custom = false;

    // ── Linux: resolve uosc paths for modern UI ──────────────────────
    #[cfg(target_os = "linux")]
    let (uosc_main_path, uosc_fonts_dir) = resolve_uosc_paths(&app);
    #[cfg(not(target_os = "linux"))]
    let (uosc_main_path, uosc_fonts_dir) = (None, None);
    #[cfg(target_os = "linux")]
    let uosc_available = uosc_main_path.is_some(); // snapshot before move into new()

    // ── Linux: snapshot pre-children before mpv creates its child ─────
    #[cfg(target_os = "linux")]
    let linux_init_state: Option<(u64, Vec<u64>)> = if use_custom {
        match platform::linux::snapshot_children(wid as u64) {
            Ok(children) => {
                eprintln!("[mpv-init] {} pre-hijos snapshoted para 0x{:x}", children.len(), wid);
                log::info!("mpv_init: {} hijos X11 capturados antes de crear mpv", children.len());
                Some((wid as u64, children))
            }
            Err(e) => {
                log::warn!("mpv_init: No se pudieron capturar hijos X11: {e}");
                None
            }
        }
    } else {
        None
    };
    #[cfg(not(target_os = "linux"))]
    let linux_init_state: Option<(u64, Vec<u64>)> = None;

    // Create the player instance — sets INITIAL_OPTIONS, wid, hwdec, uosc
    let mut instance = MpvInstance::new(api, wid, app.clone(), use_custom, uosc_main_path, uosc_fonts_dir)?;

    // ── Linux: store X11 lowering state for custom controls ────────────
    #[cfg(target_os = "linux")]
    if let Some((top_xid, pre_children)) = linux_init_state {
        instance.linux_lowering = Some(Arc::new(LinuxLoweringState {
            top_xid,
            pre_children,
            child_lowered: AtomicBool::new(false),
        }));
        log::info!("mpv_init: Estado de bajada X11 configurado (top_xid=0x{:x})", top_xid);
    }

    // Configure platform-specific video output
    #[cfg(target_os = "linux")]
    {
        // X11 wid embedding with GPU-accelerated x11egl.
        // mpv renders directly into a child X11 window via the `wid` property.
        let _ = instance.set_property_str("vo", "gpu");
        let _ = instance.set_property_str("gpu-context", "x11egl");
        let osc_state = if uosc_available { "no (uosc)" } else if use_custom { "no" } else { "yes" };
        let keyboard_state = if uosc_available { "yes" } else { "no" };
        eprintln!("[mpv-init] Opciones: osc={osc_state}, input-default-bindings=no, input-vo-keyboard={keyboard_state}");
    }

    #[cfg(target_os = "windows")]
    {
        let _ = instance.set_property_str("vo", "gpu");
        let _ = instance.set_property_str("gpu-context", "auto");
    }

    #[cfg(target_os = "macos")]
    {
        let _ = instance.set_property_str("vo", "gpu");
        let _ = instance.set_property_str("gpu-context", "auto");
    }

    // Start event loop
    instance.start_event_loop();

    // Store in state
    {
        let mut guard = state.inner.lock();
        *guard = Some(instance);
    }

    log::info!(
        "mpv_init: player inicializado correctamente (modo wid, os={}, useCustom={})",
        std::env::consts::OS,
        use_custom,
    );

    // nativeControls=true when uosc is available (Linux only).
    // When true, the mpv child window renders its own controls via OSD/libass
    // and the HTML overlay is hidden. When false, the React PlayerOverlay handles UI.
    #[cfg(target_os = "linux")]
    let native_controls = uosc_available;
    #[cfg(not(target_os = "linux"))]
    let native_controls = false;

    Ok(serde_json::json!({
        "mode": "wid",
        "os": std::env::consts::OS,
        "useCustom": use_custom,
        "nativeControls": native_controls,
    }))
}

/// Load a media file or URL for playback.
#[tauri::command]
pub fn mpv_loadfile(
    state: State<'_, PlayerState>,
    url: String,
    start_position: Option<f64>,
) -> Result<(), String> {
    // start_position from the frontend is in milliseconds; mpv expects seconds
    let start_seconds = start_position.map(|ms| ms / 1000.0);
    with_player(&state, |instance| {
        instance.loadfile(&url, start_seconds)
    })
}

/// Set an mpv property.
/// Accepts property value as a JSON value (string, number, bool).
#[tauri::command]
pub fn mpv_set_property(
    state: State<'_, PlayerState>,
    name: String,
    value: serde_json::Value,
) -> Result<(), String> {
    with_player(&state, |instance| {
        match value {
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
        }
    })
}

/// Get an mpv property as a JSON value.
#[tauri::command]
pub fn mpv_get_property(
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
pub fn mpv_command(
    state: State<'_, PlayerState>,
    args: Vec<String>,
) -> Result<(), String> {
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    with_player(&state, |instance| instance.command(&refs))
}

/// Observe a property so the event loop emits changes to the frontend.
#[tauri::command]
pub fn mpv_observe_property(
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
    with_player(&state, |instance| instance.observe_property(id, &name, format))
}

/// Destroy the mpv player and release all resources.
#[tauri::command]
pub fn mpv_destroy(state: State<'_, PlayerState>) -> Result<(), String> {
    let mut guard = state.inner.lock();
    if let Some(instance) = guard.take() {
        instance.destroy();
        log::info!("mpv_destroy: player destroyed");
    }
    Ok(())
}

/// Get the current player state info (initialized, playing).
#[tauri::command]
pub fn mpv_get_state(state: State<'_, PlayerState>) -> Result<PlayerStateInfo, String> {
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
pub fn mpv_get_render_frame(
    state: State<'_, PlayerState>,
) -> Result<Response, String> {
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

/// Get available audio tracks.
#[tauri::command]
pub fn mpv_get_audio_tracks(
    _state: State<'_, PlayerState>,
) -> Result<Vec<crate::mpv::events::MpvTrackInfo>, String> {
    // Track list is obtained via observed property; return empty list for now.
    // Full track list is available via the "mpv://tracks-changed" event.
    Ok(Vec::new())
}

/// Get available subtitle tracks.
#[tauri::command]
pub fn mpv_get_sub_tracks(
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
pub fn mpv_get_variant_tracks(
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
                let _codec = t.get("codec").and_then(|v| v.as_str()).unwrap_or("").to_string();
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
/// without updating).
#[tauri::command]
pub fn mpv_set_render_size(
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
pub fn ensure_libmpv_installed_command() -> Result<String, String> {
    let result = ensure_libmpv_installed()?;
    log::info!("ensure_libmpv_installed: {result}");
    Ok(result)
}

/// Check whether libmpv was loaded successfully and report version info.
#[tauri::command]
pub fn mpv_check_health(
    _state: State<'_, PlayerState>,
) -> Result<MpvVersionInfo, String> {
    let loaded = _state.api.lock().is_some();
    let version = if loaded {
        // Access version via the loaded API
        with_player(&_state, |instance| {
            Ok(instance.get_property_str("mpv-version").ok())
        })
        .ok()
        .flatten()
    } else {
        // Try loading just to check version
        match MpvApi::load() {
            Ok(api) => {
                let c_name = match std::ffi::CString::new("mpv-version") {
                    Ok(n) => n,
                    Err(_) => return Ok(MpvVersionInfo { loaded: false, version: None }),
                };
                let ctx = unsafe { (api.mpv_create)() };
                if ctx.is_null() {
                    return Ok(MpvVersionInfo { loaded: false, version: None });
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
