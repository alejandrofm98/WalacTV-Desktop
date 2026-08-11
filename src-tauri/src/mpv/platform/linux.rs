//! Linux-specific platform support for mpv.
//!
//! Provides display server detection (is_wayland / is_x11) used to
//! determine how to obtain the EGL display pointer for the offscreen
//! render context.
//!
//! Also provides X11 helpers for lowering the mpv child window below
//! the webview so custom HTML controls can render on top of the video
//! (Phase-2 custom controls).

use std::ffi::c_void;

/// Detect whether a compositor is running on the X11 display.
///
/// Interns the `_NET_WM_CM_S0` atom and checks `XGetSelectionOwner`.
/// Returns `true` if an owner exists (compositor running), `false` if
/// no compositor or any X11 error occurs (never panics).
pub fn detect_compositor() -> bool {
    unsafe {
        let display = x11::xlib::XOpenDisplay(std::ptr::null());
        if display.is_null() {
            eprintln!("[mpv-compositor] No se pudo abrir el display X11");
            return false;
        }

        let atom_name = b"_NET_WM_CM_S0\0";
        let atom = x11::xlib::XInternAtom(
            display,
            atom_name.as_ptr() as *const std::ffi::c_char,
            0, // False = create if not exists
        );

        if atom == 0 {
            eprintln!("[mpv-compositor] XInternAtom devolvio 0");
            x11::xlib::XCloseDisplay(display);
            return false;
        }

        let owner = x11::xlib::XGetSelectionOwner(display, atom);
        let has_compositor = owner != 0;

        if has_compositor {
            eprintln!(
                "[mpv-compositor] Compositor detectado (owner: 0x{:x})",
                owner
            );
        } else {
            eprintln!("[mpv-compositor] No se detecto compositor");
        }

        x11::xlib::XCloseDisplay(display);
        has_compositor
    }
}

/// Snapshot the current child X11 windows of `top_xid` via XQueryTree.
///
/// Returns a vector of child XIDs. Used before creating the mpv instance
/// so we can later identify and lower the child window mpv creates.
pub fn snapshot_children(top_xid: u64) -> Result<Vec<u64>, String> {
    unsafe {
        let display = x11::xlib::XOpenDisplay(std::ptr::null());
        if display.is_null() {
            return Err("No se pudo abrir el display X11".to_string());
        }

        let mut root: x11::xlib::Window = 0;
        let mut parent: x11::xlib::Window = 0;
        let mut children: *mut x11::xlib::Window = std::ptr::null_mut();
        let mut nchildren: std::ffi::c_uint = 0;

        let status = x11::xlib::XQueryTree(
            display,
            top_xid as x11::xlib::Window,
            &mut root,
            &mut parent,
            &mut children,
            &mut nchildren,
        );

        if status == 0 {
            x11::xlib::XCloseDisplay(display);
            return Err("XQueryTree fallo".to_string());
        }

        let result = if !children.is_null() {
            let slice = std::slice::from_raw_parts(children, nchildren as usize);
            let vec: Vec<u64> = slice.to_vec();
            x11::xlib::XFree(children as *mut c_void);
            vec
        } else {
            Vec::new()
        };

        eprintln!(
            "[mpv-snapshot] {} hijos capturados para 0x{:x}",
            result.len(),
            top_xid
        );

        x11::xlib::XCloseDisplay(display);
        Ok(result)
    }
}

/// Lower the mpv child window(s) below the webview.
///
/// Opens a new X11 display connection, queries the current children of
/// `top_xid`, finds any child XIDs that are NOT in `pre_children` (these
/// are the windows mpv created), and calls `XLowerWindow` on each.
///
/// Returns `Ok(true)` if one or more new children were lowered,
/// `Ok(false)` if no new child found yet (caller should retry on next
/// `file-loaded` event), or `Err` on X11 failures.
pub fn lower_mpv_child(top_xid: u64, pre_children: &[u64]) -> Result<bool, String> {
    unsafe {
        let display = x11::xlib::XOpenDisplay(std::ptr::null());
        if display.is_null() {
            return Err("No se pudo abrir el display X11".to_string());
        }

        let mut root: x11::xlib::Window = 0;
        let mut parent: x11::xlib::Window = 0;
        let mut children: *mut x11::xlib::Window = std::ptr::null_mut();
        let mut nchildren: std::ffi::c_uint = 0;

        let status = x11::xlib::XQueryTree(
            display,
            top_xid as x11::xlib::Window,
            &mut root,
            &mut parent,
            &mut children,
            &mut nchildren,
        );

        if status == 0 {
            x11::xlib::XCloseDisplay(display);
            return Err("XQueryTree fallo".to_string());
        }

        let current_children: Vec<x11::xlib::Window> = if !children.is_null() {
            let slice = std::slice::from_raw_parts(children, nchildren as usize);
            let vec = slice.to_vec();
            x11::xlib::XFree(children as *mut c_void);
            vec
        } else {
            Vec::new()
        };

        eprintln!(
            "[mpv-lowering] current_children={}, pre_children={}",
            current_children.len(),
            pre_children.len()
        );

        // Find children present now but NOT in the pre-snapshot
        let new_children: Vec<x11::xlib::Window> = current_children
            .iter()
            .copied()
            .filter(|&w| !pre_children.contains(&w))
            .collect();

        if new_children.is_empty() {
            eprintln!("[mpv-lowering] No se encontraron nuevas ventanas hijas (se reintentara)");
            x11::xlib::XCloseDisplay(display);
            return Ok(false);
        }

        for &child in &new_children {
            eprintln!("[mpv-lowering] Bajando ventana mpv: 0x{:x}", child);
            x11::xlib::XLowerWindow(display, child);
        }

        x11::xlib::XFlush(display);
        x11::xlib::XCloseDisplay(display);

        eprintln!(
            "[mpv-lowering] {} ventana(s) mpv bajada(s) correctamente",
            new_children.len()
        );
        Ok(true)
    }
}

/// Check if the session is Wayland.
///
/// If `GDK_BACKEND` is set to `"x11"` (forced by `auto_fallback_to_x11()` in
/// `lib.rs` when running under Wayland), the window runs via XWayland and we
/// must NOT take the Wayland render path.
pub fn is_wayland() -> bool {
    if let Ok(backend) = std::env::var("GDK_BACKEND") {
        if backend.eq_ignore_ascii_case("x11") {
            return false;
        }
    }
    std::env::var("XDG_SESSION_TYPE")
        .ok()
        .map(|t| t.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false)
}

/// Check if the session is X11.
pub fn is_x11() -> bool {
    let session = std::env::var("XDG_SESSION_TYPE").ok();
    match session.as_deref() {
        Some("x11") => true,
        Some("wayland") => false,
        _ => {
            // Default to X11 if DISPLAY is set
            std::env::var("DISPLAY").is_ok()
        }
    }
}

/// Determine mpv video output and GPU context based on the display server.
pub fn video_output_config() -> (&'static str, &'static str, &'static str) {
    if is_wayland() {
        // Wayland: use gpu with wayland EGL
        ("gpu", "wayland", "auto-safe")
    } else {
        // X11: prefer GPU with x11egl, fallback to x11 software
        ("gpu", "x11egl", "auto-safe")
    }
}
