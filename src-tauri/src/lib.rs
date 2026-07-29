//! WalacTV Desktop — Tauri 2 application library root.
//!
//! This library crate provides the backend logic including:
//! - libmpv FFI bindings and player lifecycle
//! - Tauri commands for player control
//! - Platform-specific window embedding

pub mod commands;
pub mod mpv;

use commands::player::{
    ensure_libmpv_installed_command, mpv_check_health, mpv_command, mpv_destroy,
    mpv_get_audio_tracks, mpv_get_property, mpv_get_state, mpv_get_sub_tracks,
    mpv_get_variant_tracks, mpv_init, mpv_loadfile, mpv_observe_property,
    mpv_set_property, mpv_set_render_size, PlayerState,
};

#[cfg(target_os = "linux")]
use commands::player::mpv_get_render_frame;

use serde::Serialize;
use tauri::image::Image;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

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

/// Try to detect Wayland and fall back to X11 if possible.
///
/// libmpv does not support embedding via the `wid` property on Wayland
/// (it requires `mpv_render_context` with EGL). As a temporary workaround,
/// we attempt to force GDK_BACKEND=x11 so Tauri's WebKitGTK runs under
/// XWayland, making the X11 window handle available to mpv.
fn auto_fallback_to_x11() {
    let is_wayland = std::env::var("WAYLAND_DISPLAY").is_ok()
        || std::env::var("XDG_SESSION_TYPE")
            .ok()
            .map(|t| t.to_ascii_lowercase() == "wayland")
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
    auto_fallback_to_x11();

    tauri::Builder::default()
        .manage(PlayerState::new())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
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

            // Register global Escape shortcut so the player can always be
            // closed, even when the mpv child window has keyboard focus.
            match app.global_shortcut().register("Escape") {
                Ok(_) => eprintln!("[global-shortcut] Escape registered globally"),
                Err(e) => eprintln!("[global-shortcut] Failed to register Escape: {e}"),
            };

            Ok(())
        })
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let _ = app.emit("player://close", ());
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_scale_info,
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
            #[cfg(target_os = "linux")]
            mpv_get_render_frame,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
