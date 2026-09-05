//! WalacTV Desktop — Tauri 2 application library root.
//!
//! This library crate provides the backend logic including:
//! - libmpv FFI bindings and player lifecycle
//! - Tauri commands for player control
//! - Platform-specific window embedding

pub mod commands;
pub mod mpv;

use commands::credentials::{
    secure_credentials_clear, secure_credentials_load, secure_credentials_save,
};
use commands::player::{
    ensure_libmpv_installed_command, mpv_check_health, mpv_command, mpv_destroy,
    mpv_get_audio_tracks, mpv_get_property, mpv_get_state, mpv_get_sub_tracks,
    mpv_get_variant_tracks, mpv_init, mpv_loadfile, mpv_observe_property, mpv_set_property,
    mpv_set_render_size, PlayerState,
};
use commands::torrent::{torrent_start, torrent_stop, TorrentState};

#[cfg(any(target_os = "linux", target_os = "windows"))]
use commands::player::{mpv_get_frame_counter, mpv_get_render_frame};

use serde::Serialize;
use tauri::image::Image;
use tauri::{Manager, WebviewUrl};

/// URL for the main window webview (dev server in debug, bundled index in
/// production).
fn build_main_url(app: &tauri::App) -> WebviewUrl {
    #[cfg(debug_assertions)]
    {
        WebviewUrl::External(
            app.config()
                .build
                .dev_url
                .clone()
                .expect("devUrl is required"),
        )
    }
    #[cfg(not(debug_assertions))]
    {
        WebviewUrl::App("index.html".into())
    }
}

/// URL for the transparent controls overlay window. The overlay loads the same
/// app but signals `?surface=overlay` so the frontend renders only the player
/// controls (the native video lives in the main window via `wid` embedding).
/// Only used on the non-Linux two-window architecture.
#[cfg(not(target_os = "linux"))]
fn build_overlay_url(app: &tauri::App) -> WebviewUrl {
    #[cfg(debug_assertions)]
    {
        let mut s = app
            .config()
            .build
            .dev_url
            .clone()
            .expect("devUrl is required")
            .to_string();
        if !s.contains('?') {
            s.push('?');
        } else if !s.ends_with('&') && !s.ends_with('?') {
            s.push('&');
        }
        s.push_str("surface=overlay");
        WebviewUrl::External(s.parse().expect("valid overlay url"))
    }
    #[cfg(not(debug_assertions))]
    {
        WebviewUrl::App("index.html?surface=overlay".into())
    }
}

/// Position and size the transparent overlay exactly over the video area of
/// the main window. Uses inner position/size so the overlay aligns with the
/// webview client area (where the `<video>` player element and HTML controls
/// live), not the window decorations. Only used on the non-Linux two-window
/// architecture.
#[cfg(not(target_os = "linux"))]
fn sync_overlay_to_main(app: &tauri::AppHandle) {
    let Some(main) = app.get_window("main") else { return };
    let Some(overlay) = app.get_window("overlay") else { return };
    // Prefer inner position/size (client area) for pixel-perfect alignment
    // of the transparent overlay over the webview.
    if let (Ok(pos), Ok(size)) = (main.inner_position(), main.inner_size()) {
        let _ = overlay.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
        let _ = overlay.set_size(tauri::PhysicalSize::new(size.width, size.height));
    } else if let (Ok(pos), Ok(size)) = (main.outer_position(), main.outer_size()) {
        // Fallback to outer position if inner isn't available
        let _ = overlay.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
        let _ = overlay.set_size(tauri::PhysicalSize::new(size.width, size.height));
    }
}

/// Two-window architecture (OpenPlayer/Stremio-style):
/// - `main`: opaque window hosting the app UI and the native libmpv video
///   surface (Windows GPU surface; the webview canvas on Linux).
/// - `overlay`: a transparent always-on-top window, aligned over `main`, that
///   hosts the HTML player controls (built from `?surface=overlay`).
///
/// On Linux this is a single window: mpv renders offscreen (EGL + CPU
/// readback) and the frontend draws frames on a `<canvas>` in the webview.
#[cfg(not(target_os = "linux"))]
fn create_main_window(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // NOTE: the main window stays opaque on purpose. On Windows mpv renders
    // offscreen (WGL FBO + CPU readback, like Linux) and the frontend draws
    // the frames on a `<canvas>` — no native video window is ever shown, so
    // no WebView2 transparency (airspace) is needed.
    let main = tauri::window::WindowBuilder::new(app, "main")
        .title("WalacTV")
        .inner_size(1280.0, 720.0)
        .resizable(true)
        .center()
        .visible(true)
        .build()?;

    main.add_child(
        tauri::webview::WebviewBuilder::new("main", build_main_url(app)).auto_resize(),
        tauri::LogicalPosition::new(0, 0),
        main.inner_size()?,
    )?;

    if let Ok(overlay) = tauri::webview::WebviewWindowBuilder::new(
        app,
        "overlay",
        build_overlay_url(app),
    )
    .title("WalacTV")
    .inner_size(1280.0, 720.0)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .skip_taskbar(true)
    .resizable(false)
    .always_on_top(true)
    .background_color(tauri::utils::config::Color(0, 0, 0, 0))
    .visible(false)
    .build()
    {
        let _ = overlay.set_background_color(Some(tauri::utils::config::Color(0, 0, 0, 0)));
        sync_overlay_to_main(&app.handle());
    }

    // Keep the overlay aligned with the main window as it moves/resizes.
    let app_handle = app.handle().clone();
    main.on_window_event(move |event| {
        use tauri::WindowEvent;
        if matches!(
            event,
            WindowEvent::Moved(_)
                | WindowEvent::Resized(_)
                | WindowEvent::ScaleFactorChanged { .. }
        ) {
            sync_overlay_to_main(&app_handle);
        }
    });

    Ok(())
}

/// Single-window Linux layout.
///
/// Video no longer uses a native GLArea underlay: mpv renders offscreen via
/// EGL (CPU readback) and the frontend draws the frames on a `<canvas>` inside
/// the webview (`useRenderFrame` + `mpv_get_render_frame`). This avoids the
/// WebKitGTK painting conflict caused by a realized GtkGLArea in the same
/// window, so the plain webview stays fully functional.
#[cfg(target_os = "linux")]
fn create_main_window(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let main = tauri::window::WindowBuilder::new(app, "main")
        .title("WalacTV")
        .inner_size(1280.0, 720.0)
        .resizable(true)
        .center()
        .visible(true)
        .build()?;

    main.add_child(
        tauri::webview::WebviewBuilder::new("main", build_main_url(app)).auto_resize(),
        tauri::LogicalPosition::new(0, 0),
        main.inner_size()?,
    )?;

    Ok(())
}

#[derive(Serialize)]
struct ScaleInfo {
    scale_factor: f64,
    width: u32,
    height: u32,
}

fn adaptive_scale(monitor_height: u32) -> f64 {
    match monitor_height {
        h if h >= 2160 => 1.75,
        h if h >= 1440 => 1.25,
        _ => 1.0,
    }
}

#[tauri::command]
fn get_scale_info(app: tauri::AppHandle) -> Result<ScaleInfo, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("No monitor detected")?;
    let size = monitor.size();
    Ok(ScaleInfo {
        scale_factor: adaptive_scale(size.height),
        width: size.width,
        height: size.height,
    })
}

/// Force GDK to run under X11. Only used in legacy/debug mode
/// (WALACTV_FORCE_X11=1); the Render API path works natively on Wayland.
fn auto_fallback_to_x11() {
    let is_wayland = std::env::var("WAYLAND_DISPLAY").is_ok()
        || std::env::var("XDG_SESSION_TYPE")
            .ok()
            .map(|t| t.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false);

    if !is_wayland {
        return;
    }

    log::info!(
        "Wayland detectado. Intentando forzar GDK_BACKEND=x11 para compatibilidad con mpv..."
    );

    // Attempt to force X11 via GDK_BACKEND (affects WebKitGTK).
    // This only works if the Tauri app hasn't already initialized the display.
    std::env::set_var("GDK_BACKEND", "x11");

    // Workaround for some GPU drivers that cause rendering issues under XWayland.
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

    log::info!(
        "GDK_BACKEND=x11 y WEBKIT_DISABLE_DMABUF_RENDERER=1 seteados. \
         Si la app igual falla, el error mostrara instrucciones de X11."
    );
}

/// Run the Tauri application.
pub fn run() {
    // Linux renders video through the libmpv Render API into an offscreen EGL
    // context (CPU readback drawn on a webview canvas), so `wid` embedding and
    // the old GDK_BACKEND=x11 workaround are obsolete. Keep the native Wayland
    // backend when available; force X11 only on explicit request
    // (WALACTV_FORCE_X11=1) for legacy/debug setups. On a pure X11 session the
    // app uses GDK's default backend and runs the same Render API path.
    if std::env::var("WALACTV_FORCE_X11").is_ok() {
        log::info!("forzando GDK_BACKEND=x11 (modo legado)");
        auto_fallback_to_x11();
    } else if std::env::var("WAYLAND_DISPLAY").is_ok() {
        std::env::set_var("GDK_BACKEND", "wayland");
        log::info!(
            "Linux: backend nativo Wayland (Render API + EGL). \
             Use WALACTV_FORCE_X11=1 para forzar X11."
        );
    } else {
        log::info!(
            "Linux: sesion X11 detectada (sin WAYLAND_DISPLAY). \
             El Render API (offscreen EGL + readback CPU) funciona igual."
        );
    }

    tauri::Builder::default()
        .manage(PlayerState::new())
        .manage(TorrentState::new())
        .setup(|app| {
            create_main_window(app)?;

            if let Some(window) = app.get_window("main") {
                let icon_bytes = include_bytes!("../icons/icon.png");
                match Image::from_bytes(icon_bytes) {
                    Ok(icon) => {
                        if let Err(e) = window.set_icon(icon) {
                            eprintln!("Failed to set window icon: {}", e);
                        }
                    }
                    Err(e) => eprintln!("Failed to load icon bytes: {}", e),
                }
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let size = monitor.size();
                    let new_w = (size.width as f64 * 0.75).round() as u32;
                    let new_h = (size.height as f64 * 0.75).round() as u32;
                    let _ = window.set_size(tauri::PhysicalSize::new(new_w, new_h));
                    let _ = window.center();
                }
            }

            // Create the native GPU video surface (Windows Render API backend).
            // It must be managed BEFORE any mpv_init call, which retrieves it
            // via app.state::<Arc<GpuVideoSurface>>(). Missing this manage()
            // panics inside mpv_init, breaking all playback on Windows
            // (Linux never touches this state, which is why it worked there).
            #[cfg(target_os = "windows")]
            {
                let surface = std::sync::Arc::new(
                    crate::mpv::gpu_surface::GpuVideoSurface::new(app.handle())?,
                );
                if let Err(e) = surface.sync() {
                    eprintln!("GpuVideoSurface initial sync failed: {e}");
                }
                app.manage(surface);

                // Keep the child GPU surface sized to the main window client area.
                let main_window = app.get_window("main").ok_or("Main window not found")?;
                let app_clone = app.handle().clone();
                main_window.on_window_event(move |event| {
                    use tauri::WindowEvent;
                    let should_sync = matches!(
                        event,
                        WindowEvent::Moved(_)
                            | WindowEvent::Resized(_)
                            | WindowEvent::ScaleFactorChanged { .. }
                    );
                    if should_sync {
                        if let Some(surface) = app_clone
                            .try_state::<std::sync::Arc<crate::mpv::gpu_surface::GpuVideoSurface>>()
                        {
                            let _ = surface.sync();
                        }
                    }
                });
            }

            Ok(())
        })
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            get_scale_info,
            secure_credentials_save,
            secure_credentials_load,
            secure_credentials_clear,
            mpv_init,
            mpv_loadfile,
            mpv_set_property,
            mpv_get_property,
            mpv_command,
            mpv_observe_property,
            mpv_destroy,
            mpv_get_state,
            mpv_get_audio_tracks,
            mpv_get_sub_tracks,
            mpv_get_variant_tracks,
            mpv_check_health,
            ensure_libmpv_installed_command,
            mpv_set_render_size,
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            mpv_get_render_frame,
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            mpv_get_frame_counter,
            torrent_start,
            torrent_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}

#[cfg(test)]
mod tests {
    use super::adaptive_scale;

    #[test]
    fn adaptive_scale_uses_expected_display_breakpoints() {
        assert_eq!(adaptive_scale(1080), 1.0);
        assert_eq!(adaptive_scale(1440), 1.25);
        assert_eq!(adaptive_scale(2160), 1.75);
    }

    #[test]
    fn adaptive_scale_handles_values_around_breakpoints() {
        assert_eq!(adaptive_scale(1439), 1.0);
        assert_eq!(adaptive_scale(1441), 1.25);
        assert_eq!(adaptive_scale(2159), 1.25);
        assert_eq!(adaptive_scale(2161), 1.75);
    }
}
