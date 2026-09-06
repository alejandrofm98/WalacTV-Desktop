//! Frontend diagnostics sink: lets the web UI append lines to the same
//! `walactv-player.log` file the native backend uses, so prod issues can be
//! traced without devtools. Best-effort: never fails the caller.

/// Append one line to the player diagnostic log (Windows only for now).
#[tauri::command]
pub fn debug_log(message: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        crate::mpv::platform::windows::diagnostic_log(format!("[ui] {message}"));
    }
    #[cfg(not(target_os = "windows"))]
    {
        eprintln!("[ui] {message}");
    }
    Ok(())
}
