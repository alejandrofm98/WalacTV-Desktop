#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::path::PathBuf;
use serde::Serialize;
use tauri::Manager;

#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(windows)]
use std::fs::OpenOptions;

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

fn mpv_socket_path() -> String {
    #[cfg(unix)]
    { format!("/tmp/walactv-mpv.{}.sock", std::process::id()) }
    #[cfg(windows)]
    { r"\\.\pipe\walactv-mpv".to_string() }
}

fn send_mpv_command(socket_path: &str, command: &str) -> Result<String, String> {
    let msg = format!("{}\n", command);
    let mut buf = String::new();

    #[cfg(unix)]
    {
        let mut stream = UnixStream::connect(socket_path).map_err(|e| e.to_string())?;
        stream.write_all(msg.as_bytes()).map_err(|e| e.to_string())?;
        stream.read_to_string(&mut buf).map_err(|e| e.to_string())?;
    }

    #[cfg(windows)]
    {
        let mut pipe = OpenOptions::new()
            .write(true)
            .read(true)
            .open(socket_path)
            .map_err(|e| e.to_string())?;
        pipe.write_all(msg.as_bytes()).map_err(|e| e.to_string())?;
        pipe.read_to_string(&mut buf).map_err(|e| e.to_string())?;
    }

    Ok(buf.trim().to_string())
}

#[tauri::command]
fn open_in_mpv(app: tauri::AppHandle, url: String, start_seconds: Option<u64>) -> Result<String, String> {
    let mpv = resolve_mpv(&app);
    let socket_path = mpv_socket_path();
    let mut args = vec![
        "--fullscreen".to_string(),
        "--vo=gpu".to_string(),
        "--hwdec=auto-safe".to_string(),
        format!("--input-ipc-server={}", socket_path),
    ];
    if let Some(secs) = start_seconds {
        args.push(format!("--start={}", secs));
    }
    args.push(url);
    std::process::Command::new(mpv)
        .args(&args)
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                MPV_ERR_NO_BINARY.to_string()
            } else {
                e.to_string()
            }
        })?;
    Ok(socket_path)
}

#[tauri::command]
fn mpv_seek(socket_path: String, position_secs: f64) -> Result<(), String> {
    let cmd = format!(r#"{{"command":["seek",{},"absolute"]}}"#, position_secs);
    send_mpv_command(&socket_path, &cmd)?;
    Ok(())
}

#[tauri::command]
fn mpv_get_position(socket_path: String) -> Result<f64, String> {
    let resp = send_mpv_command(&socket_path, r#"{"command":["get_property","time-pos"]}"#)?;
    let v: serde_json::Value = serde_json::from_str(&resp).map_err(|e| e.to_string())?;
    v["data"].as_f64().ok_or_else(|| "no position data".to_string())
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
        .invoke_handler(tauri::generate_handler![open_in_mpv, mpv_seek, mpv_get_position, get_scale_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
