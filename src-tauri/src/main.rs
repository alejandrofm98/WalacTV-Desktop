#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::io;
use serde::Serialize;
use tauri::Manager;

const MPV_ERR_NO_BINARY: &str = "MPV_NO_BINARY";

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

fn resolve_mpv(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().resource_dir() {
        let bundled = dir.join("resources").join("mpv").join("mpv.exe");
        if bundled.exists() {
            return bundled;
        }
    }
    PathBuf::from("mpv")
}

#[tauri::command]
fn open_in_mpv(app: tauri::AppHandle, url: String, start_seconds: Option<u64>) -> Result<(), String> {
    let mpv = resolve_mpv(&app);
    let mut args = vec!["--fullscreen".to_string(), "--vo=gpu".to_string(), "--hwdec=auto-safe".to_string()];
    if let Some(secs) = start_seconds {
        args.push(format!("--start={}", secs));
    }
    args.push(url);
    std::process::Command::new(mpv)
        .args(&args)
        .spawn()
        .map_err(|e| {
            if e.kind() == io::ErrorKind::NotFound {
                MPV_ERR_NO_BINARY.to_string()
            } else {
                e.to_string()
            }
        })?;
    Ok(())
}

#[tauri::command]
fn get_scale_info(app: tauri::AppHandle) -> Result<ScaleInfo, String> {
    let window = app.get_webview_window("main").ok_or("Main window not found")?;
    let monitor = window.current_monitor().map_err(|e| e.to_string())?.ok_or("No monitor detected")?;
    let size = monitor.size();
    Ok(ScaleInfo {
        scale_factor: adaptive_scale(size.height),
        width: size.width,
        height: size.height,
    })
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let size = monitor.size();
                    let new_w = (size.width as f64 * 0.75).round() as u32;
                    let new_h = (size.height as f64 * 0.75).round() as u32;
                    let _ = window.set_size(tauri::PhysicalSize::new(new_w, new_h));
                    let _ = window.center();
                }
            }
            Ok(())
        })
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![open_in_mpv, get_scale_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
