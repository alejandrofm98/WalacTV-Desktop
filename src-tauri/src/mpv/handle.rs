//! MpvInstance -- safe Rust wrapper around a raw mpv_handle.
//!
//! Lifecycle management, property get/set, command execution, and platform
//! window embedding. Based on Soia's handle.rs pattern.

use crate::mpv::ffi::{
    c_str_to_string, mpv_format, mpv_handle, MpvApi,
};
use crate::mpv::events::mpv_event_loop;
use std::ffi::{c_void, CString};
use std::os::raw::{c_char, c_int};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use parking_lot::Mutex;

// ---------------------------------------------------------------------------
// LinuxLoweringState — state for lowering mpv child window (Linux only)
// ---------------------------------------------------------------------------

/// State needed to lower the mpv child X11 window below the webview on Linux
/// so custom HTML controls render on top of the video.
///
/// Only constructed when `use_custom` is true (compositor detected and
/// `WALACTV_PLAYER_OSC` is not forced). On non-Linux platforms this is
/// always `None`.
#[allow(dead_code)]
pub struct LinuxLoweringState {
    /// X11 window ID of the top-level Tauri window (the wid given to mpv).
    pub top_xid: u64,
    /// Snapshot of children of `top_xid` taken BEFORE mpv created its child.
    pub pre_children: Vec<u64>,
    /// Set to true once the mpv child has been successfully lowered.
    pub child_lowered: AtomicBool,
}

// ---------------------------------------------------------------------------
// WindowsRaisingState — state for raising mpv child HWND (Windows only)
// ---------------------------------------------------------------------------

/// State needed to raise the mpv child HWND above the WebView2 control on
/// Windows so uosc renders on top of the video.
///
/// Only constructed when uosc is available (`uosc_main_path.is_some()`).
/// On non-Windows platforms this is always `None`.
#[allow(dead_code)]
pub struct WindowsRaisingState {
    /// HWND of the top-level Tauri window (the wid given to mpv).
    pub top_hwnd: i64,
    /// Snapshot of child HWNDs of `top_hwnd` taken BEFORE mpv created its child.
    pub pre_children: Vec<isize>,
    /// Set to true once the mpv child has been successfully raised.
    pub child_raised: AtomicBool,
}

// ---------------------------------------------------------------------------
// Locale fix – libmpv requires LC_NUMERIC="C"
// ---------------------------------------------------------------------------

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn ensure_numeric_locale() {
    // SAFETY: libmpv requires LC_NUMERIC to be "C" before mpv_create().
    unsafe {
        libc::setlocale(libc::LC_NUMERIC, b"C\0".as_ptr().cast());
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn ensure_numeric_locale() {
    // Windows builds of libmpv typically do not require this.
}

// ---------------------------------------------------------------------------
// Default options set before mpv_initialize()
// ---------------------------------------------------------------------------

/// Options applied via mpv_set_option_string before mpv_initialize().
///
/// Platform-dependent options:
/// - Linux with `use_custom`: no OSC, no mpv keyboard (HTML controls).
/// - Linux fallback (no compositor / WALACTV_PLAYER_OSC=1 / uosc unavailable): native OSC.
/// - Linux/Windows with uosc: mpv keyboard enabled for mouse input.
/// - Windows/macOS without uosc: no OSC, no mpv keyboard (HTML controls).
fn initial_options(_linux_use_custom: bool, uosc_available: bool) -> Vec<(&'static str, &'static str)> {
    let mut opts: Vec<(&'static str, &'static str)> = vec![
        ("ytdl", "no"),
        ("load-scripts", "yes"),
        ("keep-open", "yes"),
        ("vo", "gpu"),
    ];

    #[cfg(target_os = "linux")]
    opts.push(("gpu-context", "x11egl"));
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    opts.push(("gpu-context", "auto"));

    if uosc_available {
        // Keep the built-in OSC active until the uosc loader completes.
        // The loader disables it after main.lua succeeds.
        opts.push(("osc", "yes"));
        opts.push(("input-default-bindings", "no"));
        opts.push(("input-vo-keyboard", "yes"));
        opts.push(("input-cursor", "yes"));
        opts.push(("cursor-autohide", "3000"));
        return opts;
    }

    #[cfg(target_os = "linux")]
    if _linux_use_custom {
        // uosc not available with custom HTML controls: disable OSC so mpv
        // does not draw duplicate controls over the HTML overlay.
        opts.push(("osc", "no"));
        opts.push(("input-default-bindings", "no"));
        opts.push(("input-vo-keyboard", "no"));
    }
    // else: Linux fallback (no compositor / WALACTV_PLAYER_OSC=1 / uosc unavailable):
    // keep default OSC enabled so the user has native playback controls.

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        // No uosc: use HTML controls.
        opts.push(("osc", "no"));
        opts.push(("input-default-bindings", "no"));
        opts.push(("input-vo-keyboard", "no"));
    }

    opts
}

// ---------------------------------------------------------------------------
// MpvInstance
// ---------------------------------------------------------------------------

pub struct MpvInstance {
    handle: *mut mpv_handle,
    api: Arc<MpvApi>,
    event_thread: Mutex<Option<JoinHandle<()>>>,
    stop_flag: Arc<AtomicBool>,
    is_playing: Arc<AtomicBool>,
    app_handle: tauri::AppHandle,
    /// Render context for offscreen EGL/OpenGL rendering (Linux only).
    /// On Windows/macOS, wid embedding is used instead.
    #[cfg(target_os = "linux")]
    render_context: Option<Box<super::render_context::OffscreenRenderContext>>,
    /// X11 lowering state for Linux custom controls support.
    /// Populated only when using custom HTML controls with a compositor.
    /// On non-Linux or fallback mode, this is always None.
    pub linux_lowering: Option<Arc<LinuxLoweringState>>,
    /// Windows raising state for uosc z-order support.
    /// Populated only when uosc is available on Windows.
    /// On non-Windows or when uosc is not available, this is always None.
    pub windows_raising: Option<Arc<WindowsRaisingState>>,
}

// SAFETY: mpv_handle is thread-safe (libmpv is designed for this).
// MpvInstance only uses it through &self methods.
unsafe impl Send for MpvInstance {}
unsafe impl Sync for MpvInstance {}

impl MpvInstance {
    /// Create a new mpv context, set initial options, initialize, and set the
    /// window ID (`wid`) for hardware-accelerated rendering.
    ///
    /// `wid` is a platform-specific window identifier:
    /// - X11: X11 Window ID (c_ulong cast to i64)
    /// - Windows: HWND cast to i64
    /// - macOS: NSView pointer cast to i64 (for `wid` property) or render context
    ///
    /// uosc availability is determined from `uosc_main_path.is_some()` and
    /// controls whether uosc or the HTML overlay provides the UI.
    /// `_linux_use_custom` is preserved for API compatibility; the X11 lowering
    /// state is managed by `mpv_init` in the commands module.
    ///
    /// `uosc_main_path` and `uosc_fonts_dir`: when `Some` on Linux or Windows, the uosc
    /// modern OSC script is loaded (via a loader wrapper that fixes package.path)
    /// replacing the default mpv OSC.
    pub fn new(
        api: Arc<MpvApi>,
        wid: i64,
        app_handle: tauri::AppHandle,
        linux_use_custom: bool,
        uosc_main_path: Option<String>,
        uosc_fonts_dir: Option<String>,
    ) -> Result<Self, String> {
        ensure_numeric_locale();

        // SAFETY: Caller guarantees no concurrent mpv_create from another thread
        // in the same process (mpv requirement).
        let handle = unsafe { (api.mpv_create)() };
        if handle.is_null() {
            return Err("mpv_create returned null".to_string());
        }

        // ── Diagnostic: request TRACE-level log messages before any set_option ──
        // "trace" catches absolutely everything including lua script load messages.
        if let Ok(level_c) = CString::new("trace") {
            unsafe { (api.mpv_request_log_messages)(handle, level_c.as_ptr()) };
            eprintln!("[mpv-diagnostic] mpv_request_log_messages('trace') called on main handle");
        }

        let uosc_available = uosc_main_path.is_some();

        // Set options before initialize
        for (name, value) in initial_options(linux_use_custom, uosc_available) {
            if let Ok(c_name) = CString::new(name) {
                if let Ok(c_value) = CString::new(value) {
                    let ret = unsafe { (api.mpv_set_option_string)(handle, c_name.as_ptr(), c_value.as_ptr()) };
                    if ret < 0 {
                        log::warn!("mpv_set_option_string({name}={value}) returned {ret}");
                    }
                }
            }
        }

        // ── Window ID for embedding (before mpv_initialize) ────────────────
        if wid > 0 {
            if let Ok(c_wid) = CString::new(wid.to_string()) {
                if let Ok(c_name) = CString::new("wid") {
                    let ret = unsafe {
                        (api.mpv_set_option_string)(handle, c_name.as_ptr(), c_wid.as_ptr())
                    };
                    if ret < 0 {
                        unsafe { (api.mpv_destroy)(handle) };
                        return Err(format!("Setting wid={wid} failed with code {ret}"));
                    }
                }
            }
        }

        // ── UOSC-specific options (overrides initial_options, before mpv_initialize) ──
        #[cfg(any(target_os = "linux", target_os = "windows"))]
        if let (Some(ref loader_path), Some(ref fonts_dir)) = (uosc_main_path.as_ref(), uosc_fonts_dir.as_ref()) {
            eprintln!("[mpv-uosc] Applying uosc options: loader={loader_path}, fonts={fonts_dir}");

            // Load uosc via uosc.lua wrapper which sets package.path
            //    then dofiles main.lua. This avoids the `module 'lib/std' not found`
            //    error caused by mpv's --scripts not adding the script dir to Lua's
            //    package.path.
            if let Ok(c_value) = CString::new(loader_path.as_str()) {
                if let Ok(c_name) = CString::new("scripts") {
                    let ret = unsafe { (api.mpv_set_option_string)(handle, c_name.as_ptr(), c_value.as_ptr()) };
                    eprintln!("[mpv-uosc] set_option scripts={loader_path} returned {ret}");
                    if ret < 0 {
                        eprintln!("[mpv-uosc] 'scripts' failed ({ret}), trying 'script'...");
                        if let Ok(c_name2) = CString::new("script") {
                            let ret2 = unsafe { (api.mpv_set_option_string)(handle, c_name2.as_ptr(), c_value.as_ptr()) };
                            eprintln!("[mpv-uosc] set_option script={loader_path} returned {ret2}");
                            if ret2 < 0 {
                                eprintln!("[mpv-uosc] 'script' also failed ({ret2}), trying 'scripts-append'...");
                                if let Ok(c_name3) = CString::new("scripts-append") {
                                    let ret3 = unsafe { (api.mpv_set_option_string)(handle, c_name3.as_ptr(), c_value.as_ptr()) };
                                    eprintln!("[mpv-uosc] set_option scripts-append={loader_path} returned {ret3}");
                                    if ret3 < 0 {
                                        eprintln!("[mpv-uosc] All script-load options failed — uosc will NOT load");
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Set subtitle fonts directory for libass (uosc icon/texture fonts)
            if let Ok(c_name) = CString::new("sub-fonts-dir") {
                if let Ok(c_value) = CString::new(fonts_dir.as_str()) {
                    let ret_val = unsafe { (api.mpv_set_option_string)(handle, c_name.as_ptr(), c_value.as_ptr()) };
                    eprintln!("[mpv-uosc] set_option sub-fonts-dir={fonts_dir} returned {ret_val}");
                }
            }

            // Set OSD fonts directory for libass (uosc icon font via osd-overlay renderer)
            if let Ok(c_name) = CString::new("osd-fonts-dir") {
                if let Ok(c_value) = CString::new(fonts_dir.as_str()) {
                    let ret_val = unsafe { (api.mpv_set_option_string)(handle, c_name.as_ptr(), c_value.as_ptr()) };
                    eprintln!("[mpv-uosc] set_option osd-fonts-dir={fonts_dir} returned {ret_val}");
                }
            }

            // Set uosc configuration via script-opts
            // NOTE: script-opts values are comma-separated. Values that contain
            // commas (like color=foreground=ffffff,background=000000) would be
            // split incorrectly. Only set simple key=value options here.
            // Colors/opacity are set post-init via mpv commands (see below).
            if let Ok(c_name) = CString::new("script-opts") {
                if let Ok(c_value) = CString::new(
                    "uosc-scale=1,uosc-proximity_in=40,uosc-proximity_out=120,\
                     uosc-timeline_style=bar,uosc-timeline_size=52,\
                     uosc-controls_size=38,uosc-top_bar=always"
                ) {
                    let ret = unsafe { (api.mpv_set_option_string)(handle, c_name.as_ptr(), c_value.as_ptr()) };
                    eprintln!("[mpv-uosc] set_option script-opts=... returned {ret}");
                }
            }
        }

        // Initialize
        let ret = unsafe { (api.mpv_initialize)(handle) };
        if ret < 0 {
            unsafe { (api.mpv_destroy)(handle) };
            return Err(format!(
                "mpv_initialize failed: {} (code {})",
                super::ffi::mpv_error_string(ret),
                ret,
            ));
        }

        // Log loaded scripts to confirm uosc loaded (Linux/Windows)
        #[cfg(any(target_os = "linux", target_os = "windows"))]
        if uosc_main_path.is_some() {
            let ptr = unsafe { (api.mpv_get_property_string)(handle, b"script-names\0".as_ptr().cast()) };
            if !ptr.is_null() {
                let names = unsafe { c_str_to_string(ptr).unwrap_or_default() };
                eprintln!("[mpv-uosc] scripts loaded: {}", names);
                unsafe { (api.mpv_free)(ptr as *mut c_void) };
            } else {
                eprintln!("[mpv-uosc] WARNING: could not read script-names property — uosc may not have loaded");
            }
        }

        // Set hwdec to auto-safe (post-init, runtime-configurable)
        if let Ok(c_hwdec) = CString::new("auto-safe") {
            let _ = unsafe {
                (api.mpv_set_property_string)(handle, b"hwdec\0".as_ptr().cast(), c_hwdec.as_ptr())
            };
        }

        log::info!("MpvInstance created successfully");

        let stop_flag = Arc::new(AtomicBool::new(false));
        let is_playing = Arc::new(AtomicBool::new(false));

        Ok(MpvInstance {
            handle,
            api,
            event_thread: Mutex::new(None),
            stop_flag,
            is_playing,
            app_handle,
            #[cfg(target_os = "linux")]
            render_context: None,
            linux_lowering: None,
            windows_raising: None,
        })
    }

    // ------------------------------------------------------------------
    // Raw handle access (for event client creation)
    // ------------------------------------------------------------------

    /// Returns the raw mpv_handle pointer. Used internally for creating
    /// event-loop client handles.
    #[allow(dead_code)]
    pub(crate) fn raw_handle(&self) -> *mut mpv_handle {
        self.handle
    }

    /// Returns a reference to the API.
    #[allow(dead_code)]
    pub(crate) fn api(&self) -> &Arc<MpvApi> {
        &self.api
    }

    // ------------------------------------------------------------------
    // Properties
    // ------------------------------------------------------------------

    /// Set a string property on the mpv instance.
    pub fn set_property_str(&self, name: &str, value: &str) -> Result<(), String> {
        let c_name = CString::new(name).map_err(|_| "Property name contains null byte".to_string())?;
        let c_value = CString::new(value).map_err(|_| "Property value contains null byte".to_string())?;
        let ret = unsafe {
            (self.api.mpv_set_property_string)(self.handle, c_name.as_ptr(), c_value.as_ptr())
        };
        if ret < 0 {
            Err(format!("Failed to set '{name}': {} (code {ret})", super::ffi::mpv_error_string(ret)))
        } else {
            Ok(())
        }
    }

    /// Set a float property (converted to string for simplicity).
    pub fn set_property_f64(&self, name: &str, value: f64) -> Result<(), String> {
        self.set_property_str(name, &value.to_string())
    }

    /// Set an i64 property (converted to string).
    pub fn set_property_i64(&self, name: &str, value: i64) -> Result<(), String> {
        self.set_property_str(name, &value.to_string())
    }

    /// Set a boolean property (converted to "yes"/"no").
    pub fn set_property_bool(&self, name: &str, value: bool) -> Result<(), String> {
        self.set_property_str(name, if value { "yes" } else { "no" })
    }

    /// Get a property as a string.
    pub fn get_property_str(&self, name: &str) -> Result<String, String> {
        let c_name = CString::new(name).map_err(|_| "Property name contains null byte".to_string())?;
        let ptr = unsafe { (self.api.mpv_get_property_string)(self.handle, c_name.as_ptr()) };
        if ptr.is_null() {
            return Err(format!("Property '{name}' not available"));
        }
        let result = unsafe { c_str_to_string(ptr).unwrap_or_default() };
        unsafe { (self.api.mpv_free)(ptr as *mut c_void) };
        Ok(result)
    }

    /// Get a property as f64.
    pub fn get_property_f64(&self, name: &str) -> Result<f64, String> {
        let c_name = CString::new(name).map_err(|_| "Property name contains null byte".to_string())?;
        let mut value: f64 = 0.0;
        let ret = unsafe {
            (self.api.mpv_get_property)(
                self.handle,
                c_name.as_ptr(),
                mpv_format::MPV_FORMAT_DOUBLE,
                &mut value as *mut f64 as *mut c_void,
            )
        };
        if ret < 0 {
            Err(format!("Failed to get '{name}': {} (code {ret})", super::ffi::mpv_error_string(ret)))
        } else {
            Ok(value)
        }
    }

    /// Get a property as i64.
    pub fn get_property_i64(&self, name: &str) -> Result<i64, String> {
        let c_name = CString::new(name).map_err(|_| "Property name contains null byte".to_string())?;
        let mut value: i64 = 0;
        let ret = unsafe {
            (self.api.mpv_get_property)(
                self.handle,
                c_name.as_ptr(),
                mpv_format::MPV_FORMAT_INT64,
                &mut value as *mut i64 as *mut c_void,
            )
        };
        if ret < 0 {
            Err(format!("Failed to get '{name}': {} (code {ret})", super::ffi::mpv_error_string(ret)))
        } else {
            Ok(value)
        }
    }

    /// Get a property as bool (mpv flag).
    pub fn get_property_bool(&self, name: &str) -> Result<bool, String> {
        let c_name = CString::new(name).map_err(|_| "Property name contains null byte".to_string())?;
        let mut value: c_int = 0;
        let ret = unsafe {
            (self.api.mpv_get_property)(
                self.handle,
                c_name.as_ptr(),
                mpv_format::MPV_FORMAT_FLAG,
                &mut value as *mut c_int as *mut c_void,
            )
        };
        if ret < 0 {
            Err(format!("Failed to get '{name}': {} (code {ret})", super::ffi::mpv_error_string(ret)))
        } else {
            Ok(value != 0)
        }
    }

    // ------------------------------------------------------------------
    // Commands
    // ------------------------------------------------------------------

    /// Run an mpv command with the given string arguments.
    pub fn command(&self, args: &[&str]) -> Result<(), String> {
        let c_strings: Vec<CString> = args
            .iter()
            .map(|s| CString::new(*s).map_err(|_| "Argument contains null byte".to_string()))
            .collect::<Result<Vec<_>, _>>()?;

        let mut raw_args: Vec<*const c_char> =
            c_strings.iter().map(|c_str| c_str.as_ptr()).collect();
        raw_args.push(std::ptr::null());

        let ret = unsafe { (self.api.mpv_command)(self.handle, raw_args.as_ptr()) };
        if ret < 0 {
            Err(format!(
                "Command {:?} failed: {} (code {ret})",
                args,
                super::ffi::mpv_error_string(ret),
            ))
        } else {
            Ok(())
        }
    }

    // ------------------------------------------------------------------
    // File loading
    // ------------------------------------------------------------------

    /// Load a file/URL with optional start position.
    pub fn loadfile(&self, url: &str, start_position: Option<f64>) -> Result<(), String> {
        let url = CString::new(url).map_err(|_| "URL contains null byte".to_string())?;
        let loadmode = CString::new("replace").unwrap();
        let playlist_index = CString::new("-1").unwrap();

        // Keep pos_cstr alive in the outer scope so its pointer remains valid
        // through the mpv_command call below.
        let pos_cstr = start_position
            .map(|pos| {
                CString::new(format!("start={pos}"))
                    .map_err(|_| "Position string contains null byte".to_string())
            })
            .transpose()?;

        let mut args: Vec<*const c_char> = vec![
            b"loadfile\0".as_ptr().cast(),
            url.as_ptr(),
            loadmode.as_ptr(),
        ];
        if let Some(ref cstr) = pos_cstr {
            // mpv 0.38 added the playlist index before per-file options.
            // -1 preserves compatibility with older versions.
            args.push(playlist_index.as_ptr());
            args.push(cstr.as_ptr());
        }
        args.push(std::ptr::null());

        let ret = unsafe { (self.api.mpv_command)(self.handle, args.as_ptr()) };
        if ret < 0 {
            Err(format!(
                "loadfile failed: {} (code {ret})",
                super::ffi::mpv_error_string(ret),
            ))
        } else {
            Ok(())
        }
    }

    // ------------------------------------------------------------------
    // Property observation
    // ------------------------------------------------------------------

    /// Observe a property. The event loop will emit tauri events when its value changes.
    pub fn observe_property(&self, id: u64, name: &str, format: mpv_format) -> Result<(), String> {
        let c_name = CString::new(name).map_err(|_| "Property name contains null byte".to_string())?;
        let ret = unsafe {
            (self.api.mpv_observe_property)(self.handle, id, c_name.as_ptr(), format)
        };
        if ret < 0 {
            Err(format!(
                "observe_property '{name}' failed: {} (code {ret})",
                super::ffi::mpv_error_string(ret),
            ))
        } else {
            Ok(())
        }
    }

    // ------------------------------------------------------------------
    // Event loop
    // ------------------------------------------------------------------

    /// Start the background event loop thread that listens for mpv events
    /// and emits Tauri events to the frontend.
    ///
    /// The event loop observes these properties by default:
    /// - time-pos, duration, pause, media-title
    /// - track-list, eof-reached, demuxer-cache-time
    ///
    /// On Linux with custom controls, passes the lowering state so the
    /// event loop can lower the mpv child window on `file-loaded`.
    /// On Windows with uosc, passes the raising state so the event loop
    /// can raise the mpv child HWND above WebView2 on `file-loaded`.
    pub fn start_event_loop(&self) {
        self.stop_event_loop();

        self.stop_flag.store(false, Ordering::SeqCst);
        self.is_playing.store(false, Ordering::Relaxed);

        let app_handle = self.app_handle.clone();
        let api = Arc::clone(&self.api);
        // Raw pointer is not Send — cast to usize and back in closure
        let handle_ptr = self.handle as usize;
        let stop_flag = Arc::clone(&self.stop_flag);
        let is_playing = Arc::clone(&self.is_playing);
        let linux_lowering = self.linux_lowering.clone();
        let windows_raising = self.windows_raising.clone();

        let thread_handle = std::thread::Builder::new()
            .name("mpv-event-loop".into())
            .spawn(move || {
                let handle = handle_ptr as *mut mpv_handle;
                mpv_event_loop(app_handle, api, handle, stop_flag, is_playing, linux_lowering, windows_raising);
            })
            .expect("Failed to spawn mpv event loop thread");

        *self.event_thread.lock() = Some(thread_handle);
    }

    /// Stop the event loop thread gracefully.
    pub fn stop_event_loop(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        // Wake up mpv_wait_event so it breaks out of its loop quickly
        unsafe { (self.api.mpv_wakeup)(self.handle); }

        if let Some(handle) = self.event_thread.lock().take() {
            let _ = handle.join();
        }
    }

    /// Check whether the player is currently playing.
    pub fn is_playing(&self) -> bool {
        self.is_playing.load(Ordering::Acquire)
    }

    // ------------------------------------------------------------------
    // Offscreen render context (Linux only)
    // ------------------------------------------------------------------

    /// Set up an offscreen EGL render context using mpv_render_context.
    ///
    /// Deprecated: all platforms now use wid embedding. Kept to minimize
    /// churn — the render_context module and this method are preserved as
    /// dead code for future reference.
    ///
    /// `display_ptr` is the platform display pointer:
    /// - Wayland: `wl_display*` (obtained via wl_display_connect)
    /// - X11: `std::ptr::null_mut()` (EGL_DEFAULT_DISPLAY works for pbuffer)
    #[cfg(target_os = "linux")]
    #[allow(dead_code)]
    pub fn setup_render_context(
        &mut self,
        display_ptr: *mut std::ffi::c_void,
    ) -> Result<(), String> {
        let mpv_handle = self.handle;
        let api = Arc::clone(&self.api);

        let mut rc = super::render_context::OffscreenRenderContext::new(
            mpv_handle,
            &api,
            display_ptr,
        )?;

        // Start the render loop thread
        rc.start()?;

        self.render_context = Some(Box::new(rc));
        log::info!("Offscreen render context setup completo");
        Ok(())
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    /// Destroy the mpv instance and stop the event loop.
    pub fn destroy(mut self) {
        self.stop_event_loop();

        // Clean up the render context before destroying the mpv handle.
        // The render loop reads mpv properties (dwidth/dheight), so it must
        // be stopped first. mpv_render_context_free doesn't strictly need the
        // mpv handle, but it's safer to free it while the handle is alive.
        #[cfg(target_os = "linux")]
        {
            // Take ownership and drop. This calls OffscreenRenderContext::drop
            // which stops the render loop and frees mpv_render_context.
            let _ = self.render_context.take();
        }

        unsafe { (self.api.mpv_terminate_destroy)(self.handle); }
        self.handle = std::ptr::null_mut();
        log::info!("MpvInstance destroyed");
    }

    /// Update the target render size for the offscreen context.
    /// Called from the frontend when the canvas wrapper element resizes.
    #[cfg(target_os = "linux")]
    pub fn set_render_size(&self, width: u32, height: u32) {
        if let Some(ref rc) = self.render_context {
            rc.set_target_size(width, height);
        }
    }

    /// Get the latest rendered frame from the offscreen render context.
    /// Returns None if not using render context or no frame available yet.
    #[cfg(target_os = "linux")]
    pub fn get_render_frame(&self) -> Option<super::render_context::FrameBuffer> {
        self.render_context.as_ref().and_then(|rc| rc.get_frame())
    }
}

impl Drop for MpvInstance {
    fn drop(&mut self) {
        self.stop_event_loop();

        // mpv_render_context_free DEBE ejecutarse antes de mpv_destroy.
        // Drop fields despues del cuerpo del drop, asi que forzamos el drop aqui.
        #[cfg(target_os = "linux")]
        {
            self.render_context.take();
        }

        if !self.handle.is_null() {
            unsafe { (self.api.mpv_destroy)(self.handle); }
        }
    }
}
