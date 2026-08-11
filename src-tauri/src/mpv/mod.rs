//! libmpv FFI bindings and safe Rust wrappers for WalacTV Desktop.
//!
//! Architecture (inspired by Soia + OpenPlayer):
//! - `ffi`: Dynamic library loading via libloading, all mpv FFI types
//! - `handle`: MpvInstance — safe wrapper around mpv_handle lifecycle
//! - `events`: Background event loop that emits Tauri events
//! - `platform`: Platform-specific window handle extraction
//! - `render_context`: Offscreen EGL+OpenGL mpv_render_context (Linux only)

pub mod ffi;
pub use ffi::MpvError;
pub mod events;
pub mod handle;
pub mod platform;

#[cfg(target_os = "linux")]
#[allow(dead_code)]
pub mod render_context;
