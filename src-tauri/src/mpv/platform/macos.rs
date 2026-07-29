//! macOS-specific platform support for mpv embedding.
//!
//! On macOS, mpv can use either:
//! 1. `wid` property with the NSView pointer (requires libmpv built with macos support)
//! 2. mpv_render_context with Cocoa OpenGL (more complex but better integration)
//!
//! Currently using approach 1 (wid with NSView).

/// Video output config for macOS.
/// Uses `libmpv` backend for native macOS rendering.
pub fn video_output_config() -> (&'static str, &'static str, &'static str) {
    ("libmpv", "", "auto-safe")
}
