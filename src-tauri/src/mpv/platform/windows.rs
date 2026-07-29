//! Windows-specific platform support for mpv embedding.
//!
//! On Windows, mpv embeds directly via HWND (the `wid` property).
//! No additional setup is needed — the HWND is extracted in platform/mod.rs.

/// On Windows, mpv uses the HWND directly via `wid` property.
/// No special video output configuration needed (mpv auto-detects).
pub fn video_output_config() -> (&'static str, &'static str, &'static str) {
    ("", "", "auto-safe")
}
