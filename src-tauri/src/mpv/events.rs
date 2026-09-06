//! Event loop thread for libmpv.
//!
//! Polls mpv_wait_event in a loop, processes property changes, and emits
//! Tauri events to the frontend. Based on Soia's event_loop.rs pattern.

use crate::mpv::ffi::{
    c_str_to_string, mpv_event_end_file, mpv_event_id, mpv_event_log_message, mpv_event_property,
    mpv_format, mpv_handle, mpv_node, MpvApi,
};
use serde::Serialize;
use serde_json::json;
use std::ffi::{c_char, c_int, CStr, CString};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
#[cfg(target_os = "windows")]
use std::time::Duration;
#[cfg(target_os = "windows")]
use tauri::Manager;
use tauri::{AppHandle, Emitter};

// ---------------------------------------------------------------------------
// Observed property IDs (must match handle.rs if changed)
// ---------------------------------------------------------------------------

const TIME_POS_ID: u64 = 1;
const DURATION_ID: u64 = 2;
const PAUSE_ID: u64 = 3;
const TRACK_LIST_ID: u64 = 4;
const MEDIA_TITLE_ID: u64 = 5;
const EOF_REACHED_ID: u64 = 6;
const DEMUXER_CACHE_TIME_ID: u64 = 7;
const PAUSED_FOR_CACHE_ID: u64 = 8;
const VOLUME_ID: u64 = 9;
const SPEED_ID: u64 = 10;
const WIDTH_ID: u64 = 11;
const HEIGHT_ID: u64 = 12;
#[cfg(target_os = "windows")]
const FULLSCREEN_ID: u64 = 13;
const AUDIO_TRACK_ID: u64 = 14;
const SUBTITLE_TRACK_ID: u64 = 15;

// ---------------------------------------------------------------------------
// Payload structs for Tauri events
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MpvProgressPayload {
    pub time_pos: f64,
    pub duration: f64,
    pub buffered_pos: f64,
    pub is_playing: bool,
    pub is_buffering: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MpvEndFilePayload {
    pub reason: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MpvTracksPayload {
    pub tracks: Vec<MpvTrackInfo>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MpvTrackInfo {
    pub id: i64,
    pub track_type: String,
    pub title: String,
    pub lang: String,
    pub selected: bool,
    pub codec: Option<String>,
    pub codec_desc: Option<String>,
    pub decoder_desc: Option<String>,
    pub demux_w: Option<i64>,
    pub demux_h: Option<i64>,
    pub demux_fps: Option<f64>,
    pub demux_bitrate: Option<i64>,
    pub demux_samplerate: Option<i64>,
    pub demux_channels: Option<String>,
    pub demux_channel_count: Option<i64>,
    pub fps: Option<f64>,
    pub default: Option<bool>,
    pub forced: Option<bool>,
    pub external: Option<bool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MpvFileLoadedPayload;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MpvRestartPayload;

// ---------------------------------------------------------------------------
// Event loop
// ---------------------------------------------------------------------------

/// Main event loop. Runs in a dedicated thread.
///
/// Observes a fixed set of properties and forwards their changes to the
/// frontend via Tauri's event system.
///
/// # Safety
/// `handle` must be a live libmpv handle owned by the event-loop lifetime.
pub unsafe fn mpv_event_loop(
    app_handle: AppHandle,
    api: Arc<MpvApi>,
    handle: *mut mpv_handle,
    stop_flag: Arc<AtomicBool>,
    is_playing: Arc<AtomicBool>,
) {
    // Create a client handle for event processing (reduces interference
    // with the main mpv_handle operations).
    let client_name = CString::new("walactv-event-loop").unwrap();
    let event_client = unsafe { (api.mpv_create_client)(handle, client_name.as_ptr()) };
    if event_client.is_null() {
        log::error!("mpv_event_loop: failed to create event client");
        return;
    }

    // mpv_request_log_messages is per-handle; keep important diagnostics while
    // avoiding verbose messages that may contain sensitive stream URLs.
    let log_level = if cfg!(any(target_os = "windows", debug_assertions)) {
        "info"
    } else {
        "warn"
    };
    if let Ok(level_c) = std::ffi::CString::new(log_level) {
        unsafe { (api.mpv_request_log_messages)(event_client, level_c.as_ptr()) };
    }
    eprintln!("[mpv-event] request_log_messages({log_level}) called on event client");

    // Observe properties
    observe(
        &api,
        event_client,
        TIME_POS_ID,
        "time-pos",
        mpv_format::MPV_FORMAT_DOUBLE,
    );
    observe(
        &api,
        event_client,
        DURATION_ID,
        "duration",
        mpv_format::MPV_FORMAT_DOUBLE,
    );
    observe(
        &api,
        event_client,
        PAUSE_ID,
        "pause",
        mpv_format::MPV_FORMAT_FLAG,
    );
    observe(
        &api,
        event_client,
        TRACK_LIST_ID,
        "track-list",
        mpv_format::MPV_FORMAT_NODE,
    );
    observe(
        &api,
        event_client,
        AUDIO_TRACK_ID,
        "aid",
        mpv_format::MPV_FORMAT_STRING,
    );
    observe(
        &api,
        event_client,
        SUBTITLE_TRACK_ID,
        "sid",
        mpv_format::MPV_FORMAT_STRING,
    );
    observe(
        &api,
        event_client,
        MEDIA_TITLE_ID,
        "media-title",
        mpv_format::MPV_FORMAT_STRING,
    );
    observe(
        &api,
        event_client,
        EOF_REACHED_ID,
        "eof-reached",
        mpv_format::MPV_FORMAT_FLAG,
    );
    observe(
        &api,
        event_client,
        DEMUXER_CACHE_TIME_ID,
        "demuxer-cache-time",
        mpv_format::MPV_FORMAT_DOUBLE,
    );
    observe(
        &api,
        event_client,
        PAUSED_FOR_CACHE_ID,
        "paused-for-cache",
        mpv_format::MPV_FORMAT_FLAG,
    );
    observe(
        &api,
        event_client,
        VOLUME_ID,
        "volume",
        mpv_format::MPV_FORMAT_DOUBLE,
    );
    observe(
        &api,
        event_client,
        SPEED_ID,
        "speed",
        mpv_format::MPV_FORMAT_DOUBLE,
    );
    observe(
        &api,
        event_client,
        WIDTH_ID,
        "width",
        mpv_format::MPV_FORMAT_INT64,
    );
    observe(
        &api,
        event_client,
        HEIGHT_ID,
        "height",
        mpv_format::MPV_FORMAT_INT64,
    );
    #[cfg(target_os = "windows")]
    observe(
        &api,
        event_client,
        FULLSCREEN_ID,
        "fullscreen",
        mpv_format::MPV_FORMAT_FLAG,
    );

    log::info!("mpv_event_loop: started, observing properties");

    // State tracking
    let mut last_time_pos: f64 = 0.0;
    let mut last_duration: f64 = 0.0;
    let mut last_buffered_pos: f64 = 0.0;
    let mut last_is_paused: bool = false;
    let mut last_is_buffering: bool = false;
    let mut last_demuxer_cache_time: f64 = 0.0;
    let mut end_file_emitted: bool = false;
    loop {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }

        if take_back_request(&api, event_client) {
            let _ = app_handle.emit("player://close", ());
        }

        let event = unsafe { (api.mpv_wait_event)(event_client, 0.1) };
        if event.is_null() {
            continue;
        }

        let ev = unsafe { &*event };

        match ev.event_id {
            mpv_event_id::MPV_EVENT_SHUTDOWN => {
                log::info!("mpv_event_loop: received SHUTDOWN, exiting");
                break;
            }

            mpv_event_id::MPV_EVENT_START_FILE => {
                end_file_emitted = false;
                is_playing.store(false, Ordering::Relaxed);
                let _ = app_handle.emit("mpv://start-file", ());
            }

            mpv_event_id::MPV_EVENT_FILE_LOADED => {
                is_playing.store(true, Ordering::Relaxed);
                end_file_emitted = false;
                let _ = app_handle.emit("mpv://file-loaded", MpvFileLoadedPayload);
                emit_unified_event(&app_handle, "file-loaded", None);

                #[cfg(target_os = "windows")]
                log_windows_mpv_state(&api, event_client);

            }

            mpv_event_id::MPV_EVENT_PLAYBACK_RESTART => {
                is_playing.store(!last_is_paused, Ordering::Relaxed);
                let _ = app_handle.emit("mpv://playback-restart", MpvRestartPayload);
                emit_unified_event(&app_handle, "playback-restart", None);
            }

            mpv_event_id::MPV_EVENT_END_FILE => {
                is_playing.store(false, Ordering::Relaxed);
                let reason = if !ev.data.is_null() {
                    let end_file = unsafe { &*(ev.data as *const mpv_event_end_file) };
                    end_file_reason_label(end_file.reason).to_string()
                } else {
                    "unknown".to_string()
                };
                eprintln!("[mpv-events] MPV_EVENT_END_FILE: reason={reason}");

                if !(end_file_emitted && reason == "eof") {
                    let _ = app_handle.emit(
                        "mpv://end-file",
                        MpvEndFilePayload {
                            reason: reason.clone(),
                        },
                    );
                    emit_unified_event(
                        &app_handle,
                        "end-file",
                        Some(json!({ "reason": reason.clone() })),
                    );
                }
                end_file_emitted = reason == "eof";

                // Force final progress update
                emit_progress(
                    &app_handle,
                    last_time_pos,
                    last_duration,
                    last_buffered_pos,
                    false,
                    last_is_buffering,
                );
            }

            mpv_event_id::MPV_EVENT_PROPERTY_CHANGE => {
                if ev.data.is_null() {
                    continue;
                }
                let prop = unsafe { &*(ev.data as *const mpv_event_property) };
                let value_ptr = prop.data;

                match ev.reply_usrdata {
                    TIME_POS_ID => {
                        if prop.format == mpv_format::MPV_FORMAT_DOUBLE && !value_ptr.is_null() {
                            last_time_pos = unsafe { *(value_ptr as *mut f64) };
                            last_buffered_pos = compute_buffered_pos(
                                last_time_pos,
                                last_duration,
                                last_demuxer_cache_time,
                            );
                        }
                    }

                    DURATION_ID => {
                        if prop.format == mpv_format::MPV_FORMAT_DOUBLE && !value_ptr.is_null() {
                            last_duration = unsafe { *(value_ptr as *mut f64) };
                            last_buffered_pos = compute_buffered_pos(
                                last_time_pos,
                                last_duration,
                                last_demuxer_cache_time,
                            );
                        }
                    }

                    PAUSE_ID => {
                        if prop.format == mpv_format::MPV_FORMAT_FLAG && !value_ptr.is_null() {
                            let is_paused = unsafe { *(value_ptr as *mut c_int) != 0 };
                            last_is_paused = is_paused;
                            is_playing.store(!is_paused, Ordering::Relaxed);
                            let _ = app_handle.emit("mpv://pause", !is_paused);
                            emit_unified_event(
                                &app_handle,
                                "state-change",
                                Some(json!({
                                    "pause": is_paused,
                                    "buffering": last_is_buffering,
                                })),
                            );
                        }
                    }

                    TRACK_LIST_ID => {
                        if prop.format == mpv_format::MPV_FORMAT_NODE && !value_ptr.is_null() {
                            let node = unsafe { &*(value_ptr as *mut mpv_node) };
                            let tracks = parse_track_list(node);
                            let _ = app_handle
                                .emit("mpv://tracks-changed", MpvTracksPayload { tracks });
                            emit_unified_event(&app_handle, "tracks-changed", None);
                        }
                    }

                    AUDIO_TRACK_ID | SUBTITLE_TRACK_ID => {
                        emit_unified_event(&app_handle, "tracks-changed", None);
                    }

                    MEDIA_TITLE_ID => {
                        if prop.format == mpv_format::MPV_FORMAT_STRING && !value_ptr.is_null() {
                            let title_ptr = unsafe { *(value_ptr as *mut *mut c_char) };
                            if let Some(title) = unsafe { c_str_to_string(title_ptr) } {
                                let _ = app_handle.emit("mpv://media-title", &title);
                                emit_unified_event(
                                    &app_handle,
                                    "media-title",
                                    Some(json!({ "title": title })),
                                );
                            }
                        } else if prop.format == mpv_format::MPV_FORMAT_NONE {
                            let _ = app_handle.emit("mpv://media-title", "");
                            emit_unified_event(
                                &app_handle,
                                "media-title",
                                Some(json!({ "title": "" })),
                            );
                        }
                    }

                    EOF_REACHED_ID => {
                        if prop.format == mpv_format::MPV_FORMAT_FLAG && !value_ptr.is_null() {
                            let eof = unsafe { *(value_ptr as *mut c_int) != 0 };
                            if eof && !end_file_emitted {
                                let _ = app_handle.emit("mpv://eof-reached", true);
                                emit_unified_event(&app_handle, "eof-reached", None);
                                end_file_emitted = true;
                            }
                        }
                    }

                    DEMUXER_CACHE_TIME_ID => {
                        if prop.format == mpv_format::MPV_FORMAT_DOUBLE && !value_ptr.is_null() {
                            last_demuxer_cache_time = unsafe { *(value_ptr as *mut f64) };
                            if last_demuxer_cache_time.is_finite() {
                                last_buffered_pos = compute_buffered_pos(
                                    last_time_pos,
                                    last_duration,
                                    last_demuxer_cache_time,
                                );
                            }
                        }
                    }

                    PAUSED_FOR_CACHE_ID => {
                        if prop.format == mpv_format::MPV_FORMAT_FLAG && !value_ptr.is_null() {
                            last_is_buffering = unsafe { *(value_ptr as *mut c_int) != 0 };
                            // Cache stalls don't touch `pause`, so without
                            // this the frontend would never learn mpv ran out
                            // of data (frozen frame, no overlay). Forward the
                            // combined state exactly like PAUSE_ID does.
                            emit_unified_event(
                                &app_handle,
                                "state-change",
                                Some(json!({
                                    "pause": last_is_paused,
                                    "buffering": last_is_buffering,
                                })),
                            );
                        }
                    }

                    VOLUME_ID => {
                        if prop.format == mpv_format::MPV_FORMAT_DOUBLE && !value_ptr.is_null() {
                            let volume = unsafe { *(value_ptr as *mut f64) };
                            let normalized = (volume / 100.0).clamp(0.0, 1.0);
                            let _ = app_handle.emit("mpv://volume", normalized);
                            emit_unified_event(
                                &app_handle,
                                "volume",
                                Some(json!({ "volume": normalized })),
                            );
                        }
                    }

                    SPEED_ID => {
                        if prop.format == mpv_format::MPV_FORMAT_DOUBLE && !value_ptr.is_null() {
                            let speed = unsafe { *(value_ptr as *mut f64) };
                            if speed.is_finite() && speed > 0.0 {
                                let _ = app_handle.emit("mpv://speed", speed);
                                emit_unified_event(
                                    &app_handle,
                                    "speed",
                                    Some(json!({ "speed": speed })),
                                );
                            }
                        }
                    }

                    WIDTH_ID | HEIGHT_ID => {
                        // Could emit video-resolution if desired
                    }

                    #[cfg(target_os = "windows")]
                    FULLSCREEN_ID => {
                        if prop.format == mpv_format::MPV_FORMAT_FLAG && !value_ptr.is_null() {
                            let is_fullscreen = unsafe { *(value_ptr as *mut c_int) != 0 };
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.set_fullscreen(is_fullscreen);
                            }
                        }
                    }

                    _ => {}
                }

                // Emit progress updates on time-pos changes
                if ev.reply_usrdata == TIME_POS_ID
                    || ev.reply_usrdata == DURATION_ID
                    || ev.reply_usrdata == PAUSED_FOR_CACHE_ID
                {
                    emit_progress(
                        &app_handle,
                        last_time_pos,
                        last_duration,
                        last_buffered_pos,
                        !last_is_paused,
                        last_is_buffering,
                    );
                }
            }

            mpv_event_id::MPV_EVENT_LOG_MESSAGE => {
                if !ev.data.is_null() {
                    let log_msg = unsafe { &*(ev.data as *const mpv_event_log_message) };
                    let prefix_s = if log_msg.prefix.is_null() {
                        "(null)".to_string()
                    } else {
                        unsafe { CStr::from_ptr(log_msg.prefix).to_string_lossy().to_string() }
                    };
                    let level_s = if log_msg.level.is_null() {
                        "(null)".to_string()
                    } else {
                        unsafe { CStr::from_ptr(log_msg.level).to_string_lossy().to_string() }
                    };
                    let text_s = if log_msg.text.is_null() {
                        "(null)".to_string()
                    } else {
                        unsafe {
                            CStr::from_ptr(log_msg.text)
                                .to_string_lossy()
                                .trim()
                                .to_string()
                        }
                    };
                    eprintln!("[mpv-log] {}: {}: {}", prefix_s, level_s, text_s);
                    #[cfg(target_os = "windows")]
                    {
                        let prefix = prefix_s.to_ascii_lowercase();
                        if ["uosc", "osc", "lua", "input", "win32"]
                            .iter()
                            .any(|value| prefix.contains(value))
                        {
                            crate::mpv::platform::windows::diagnostic_log(format!(
                                "mpv[{prefix_s}/{level_s}] {text_s}"
                            ));
                        }
                    }
                }
            }

            mpv_event_id::MPV_EVENT_SEEK => {
                let _ = app_handle.emit("mpv://seek", ());
                emit_unified_event(&app_handle, "seek", None);
            }

            _ => {
                // Ignore unhandled events
            }
        }
    }

    unsafe {
        (api.mpv_destroy)(event_client);
    }
    log::info!("mpv_event_loop: exited");
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

fn observe(api: &MpvApi, client: *mut mpv_handle, id: u64, name: &str, format: mpv_format) {
    let c_name = CString::new(name).expect("Property name contains null byte");
    let ret = unsafe { (api.mpv_observe_property)(client, id, c_name.as_ptr(), format) };
    if ret < 0 {
        log::warn!("observe_property({name}) failed: {ret}");
    }
}

#[cfg(target_os = "windows")]
fn command(api: &MpvApi, client: *mut mpv_handle, args: &[&str]) {
    let Ok(values) = args
        .iter()
        .map(|arg| CString::new(*arg))
        .collect::<Result<Vec<_>, _>>()
    else {
        return;
    };
    let mut pointers = values.iter().map(|arg| arg.as_ptr()).collect::<Vec<_>>();
    pointers.push(std::ptr::null());
    let result = unsafe { (api.mpv_command)(client, pointers.as_ptr()) };
    if result < 0 {
        log::warn!("mpv command {args:?} failed: {result}");
    }
}

#[cfg(target_os = "windows")]
fn string_property(api: &MpvApi, client: *mut mpv_handle, name: &str) -> String {
    let Ok(name) = CString::new(name) else {
        return "invalid-name".to_string();
    };
    let value = unsafe { (api.mpv_get_property_string)(client, name.as_ptr()) };
    if value.is_null() {
        return "unavailable".to_string();
    }
    let result = unsafe { CStr::from_ptr(value).to_string_lossy().to_string() };
    unsafe { (api.mpv_free)(value.cast()) };
    result
}

#[cfg(target_os = "windows")]
fn log_windows_mpv_state(api: &MpvApi, client: *mut mpv_handle) {
    crate::mpv::platform::windows::diagnostic_log(format!(
        "file-loaded mpv-state script-names={:?} osc={:?} input-vo-keyboard={:?} input-cursor={:?}",
        string_property(api, client, "script-names"),
        string_property(api, client, "osc"),
        string_property(api, client, "input-vo-keyboard"),
        string_property(api, client, "input-cursor"),
    ));
}

fn take_back_request(api: &MpvApi, client: *mut mpv_handle) -> bool {
    let value = unsafe { (api.mpv_get_property_string)(client, c"force-media-title".as_ptr()) };
    if value.is_null() {
        return false;
    }
    let requested = unsafe { CStr::from_ptr(value) }.to_bytes() == b"__walactv_back__";
    unsafe { (api.mpv_free)(value.cast()) };
    requested
}

fn end_file_reason_label(reason: c_int) -> &'static str {
    match reason {
        0 => "eof",
        2 => "stop",
        3 => "quit",
        4 => "error",
        5 => "redirect",
        _ => "unknown",
    }
}

fn sanitize_f64(value: f64) -> f64 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn compute_buffered_pos(time_pos: f64, duration: f64, cache_time: f64) -> f64 {
    let safe_pos = sanitize_f64(time_pos);
    let safe_cache = sanitize_f64(cache_time);
    // Some mpv builds report absolute cache-end, others "seconds ahead"
    let absolute = safe_cache.abs() > safe_pos.abs() && safe_cache > safe_pos;
    let mut buffered = if absolute {
        safe_cache
    } else {
        safe_pos + safe_cache
    };
    if duration.is_finite() && duration > 0.0 {
        buffered = buffered.min(duration);
    }
    buffered.max(safe_pos)
}

fn emit_progress(
    app_handle: &AppHandle,
    time_pos: f64,
    duration: f64,
    buffered_pos: f64,
    is_playing: bool,
    is_buffering: bool,
) {
    let safe_time_pos = sanitize_f64(time_pos);
    let safe_duration = sanitize_f64(duration);
    let safe_buffered_pos = sanitize_f64(buffered_pos);

    let _ = app_handle.emit(
        "mpv://progress",
        MpvProgressPayload {
            time_pos: safe_time_pos,
            duration: safe_duration,
            buffered_pos: safe_buffered_pos,
            is_playing,
            is_buffering,
        },
    );

    // Unified event for frontend
    let _ = app_handle.emit(
        "mpv://event",
        json!({
            "type": "time-update",
            "position": safe_time_pos,
            "duration": safe_duration,
        }),
    );
}

/// Emit a unified mpv://event with the given type and optional fields.
fn emit_unified_event(app_handle: &AppHandle, event_type: &str, extra: Option<serde_json::Value>) {
    let mut payload = json!({ "type": event_type });
    if let Some(extras) = extra {
        if let Some(obj) = extras.as_object() {
            for (k, v) in obj {
                payload[k] = v.clone();
            }
        }
    }
    let _ = app_handle.emit("mpv://event", payload);
}

fn parse_track_list(node: &mpv_node) -> Vec<MpvTrackInfo> {
    let mut tracks = Vec::new();

    if node.format != mpv_format::MPV_FORMAT_NODE_ARRAY
        && node.format != mpv_format::MPV_FORMAT_NODE_MAP
    {
        return tracks;
    }

    let list = unsafe { &*node.u.list };
    if list.num <= 0 || list.values.is_null() {
        return tracks;
    }

    for i in 0..list.num as isize {
        let entry = unsafe { &*list.values.offset(i) };
        if entry.format != mpv_format::MPV_FORMAT_NODE_MAP {
            continue;
        }
        let map = unsafe { &*entry.u.list };

        let get_str = |key: &str| -> Option<String> {
            for j in 0..map.num as isize {
                let k = unsafe { CStr::from_ptr(*map.keys.offset(j)) };
                if k.to_str().ok() == Some(key) {
                    let v = unsafe { &*map.values.offset(j) };
                    if v.format == mpv_format::MPV_FORMAT_STRING {
                        return unsafe { c_str_to_string(v.u.string) };
                    }
                }
            }
            None
        };

        let get_i64 = |key: &str| -> Option<i64> {
            for j in 0..map.num as isize {
                let k = unsafe { CStr::from_ptr(*map.keys.offset(j)) };
                if k.to_str().ok() == Some(key) {
                    let v = unsafe { &*map.values.offset(j) };
                    if v.format == mpv_format::MPV_FORMAT_INT64 {
                        return Some(unsafe { v.u.int64 });
                    }
                }
            }
            None
        };

        let get_f64 = |key: &str| -> Option<f64> {
            for j in 0..map.num as isize {
                let k = unsafe { CStr::from_ptr(*map.keys.offset(j)) };
                if k.to_str().ok() == Some(key) {
                    let v = unsafe { &*map.values.offset(j) };
                    if v.format == mpv_format::MPV_FORMAT_DOUBLE {
                        return Some(unsafe { v.u.double_ });
                    }
                }
            }
            None
        };

        let get_bool = |key: &str| -> Option<bool> {
            for j in 0..map.num as isize {
                let k = unsafe { CStr::from_ptr(*map.keys.offset(j)) };
                if k.to_str().ok() == Some(key) {
                    let v = unsafe { &*map.values.offset(j) };
                    if v.format == mpv_format::MPV_FORMAT_FLAG {
                        return Some(unsafe { v.u.flag != 0 });
                    }
                }
            }
            None
        };

        let id = get_i64("id").unwrap_or(0);
        let track_type = get_str("type").unwrap_or_default();
        let title = get_str("title")
            .or_else(|| get_str("lang"))
            .unwrap_or_else(|| "Unknown".to_string());
        let lang = get_str("lang").unwrap_or_default();
        let selected = get_bool("selected").unwrap_or(false);

        tracks.push(MpvTrackInfo {
            id,
            track_type,
            title,
            lang,
            selected,
            codec: get_str("codec"),
            codec_desc: get_str("codec-desc"),
            decoder_desc: get_str("decoder-desc"),
            demux_w: get_i64("demux-w"),
            demux_h: get_i64("demux-h"),
            demux_fps: get_f64("demux-fps"),
            demux_bitrate: get_i64("demux-bitrate"),
            demux_samplerate: get_i64("demux-samplerate"),
            demux_channels: get_str("demux-channels"),
            demux_channel_count: get_i64("demux-channel-count"),
            fps: get_f64("fps"),
            default: get_bool("default"),
            forced: get_bool("forced"),
            external: get_bool("external"),
        });
    }

    tracks
}
