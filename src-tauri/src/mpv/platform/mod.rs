//! Platform-specific window handle extraction for mpv.
//!
//! Provides a unified interface to get the platform window ID (wid) that
//! mpv uses for hardware-accelerated video output embedding.

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "windows")]
pub mod windows;
#[cfg(target_os = "macos")]
pub mod macos;

use libloading::Library;
use raw_window_handle::RawWindowHandle;
use std::ffi::c_void;

/// Extract the platform window ID from a Tauri window handle.
///
/// Returns an i64 suitable for passing to mpv's `wid` property on X11/Windows,
/// or the NSView pointer on macOS.
pub fn get_mpv_wid(window: &impl raw_window_handle::HasWindowHandle) -> Result<i64, String> {
    let handle = window
        .window_handle()
        .map_err(|e| format!("Failed to get window handle: {e}"))?;
    raw_handle_to_wid(handle.as_raw())
}

/// Obtener el `wl_display*` del compositor Wayland.
///
/// No intenta extraerlo del WebView de Tauri (que no lo expone en
/// Tauri 2 + WebKitGTK). En su lugar, se conecta al display global del
/// compositor via `wl_display_connect(NULL)`, que funciona porque el
/// proceso ya esta conectado al bus Wayland.
#[cfg(target_os = "linux")]
pub fn get_wayland_display() -> Result<*mut c_void, String> {
    // SAFETY: Loading a well-known system library by soname is safe.
    // libwayland-client.so.0 is a standard component of any Wayland session.
    let lib = unsafe {
        Library::new("libwayland-client.so.0")
            .map_err(|e| format!("No se pudo cargar libwayland-client: {e}"))?
    };

    let wl_display_connect: extern "C" fn(*const std::ffi::c_char) -> *mut c_void = unsafe {
        *lib.get(b"wl_display_connect\0")
            .map_err(|e| format!("wl_display_connect symbol not found: {e}"))?
    };

    let display = wl_display_connect(std::ptr::null());
    if display.is_null() {
        return Err(
            "No se pudo conectar al Wayland display. Asegurate de estar en una sesion Wayland."
                .into(),
        );
    }

    // Leak the Library so the display connection stays alive.
    // The display pointer is valid for the lifetime of the process.
    std::mem::forget(lib);

    Ok(display)
}

#[cfg(not(target_os = "linux"))]
pub fn get_wayland_display() -> Result<*mut c_void, String> {
    Err("Wayland solo es soportado en Linux".into())
}

/// Convert a RawWindowHandle to an mpv-compatible window ID.
fn raw_handle_to_wid(handle: RawWindowHandle) -> Result<i64, String> {
    match handle {
        #[cfg(target_os = "linux")]
        RawWindowHandle::Xlib(h) => {
            if h.window == 0 {
                return Err("X11 window ID is 0".to_string());
            }
            Ok(h.window as i64)
        }

        #[cfg(target_os = "linux")]
        RawWindowHandle::Xcb(h) => {
            let window: u32 = h.window.get();
            if window == 0 {
                return Err("XCB window ID is 0".to_string());
            }
            Ok(window as i64)
        }

        #[cfg(target_os = "linux")]
        RawWindowHandle::Wayland(_) => {
            // Wayland does not support the `wid` property.
            // Return 0 — the caller must create a render context instead.
            Ok(0i64)
        }

        #[cfg(target_os = "windows")]
        RawWindowHandle::Win32(h) => {
            let hwnd = h.hwnd.get();
            if hwnd.is_null() {
                return Err("HWND is null".to_string());
            }
            Ok(hwnd as i64)
        }

        #[cfg(target_os = "macos")]
        RawWindowHandle::AppKit(h) => {
            let ns_view = h.ns_view.as_ptr();
            if ns_view.is_null() {
                return Err("NSView is null".to_string());
            }
            Ok(ns_view as i64)
        }

        _ => Err(format!(
            "Unsupported raw window handle for {}",
            std::env::consts::OS,
        )),
    }
}
