//! WindowsVideoHost — app-lifetime popup HWND for mpv embedding.
//!
//! Provides a hidden top-level owned popup window that serves as the mpv `wid`
//! parent. Mpv renders into this popup as a child, keeping WebView2 hit-testing
//! intact. The popup is positioned to match the Tauri main window client area
//! via `sync()`.
//!
//! All show/hide/sync operations dispatch to the main thread when called from
//! the mpv event loop, using `run_on_main_thread` + channel.

use crate::mpv::ffi::{mpv_handle, MpvApi};
use std::ffi::{c_char, CString};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use std::{fs::OpenOptions, io::Write};
use tauri::AppHandle;

use windows_sys::Win32::Foundation::{GetLastError, ERROR_CLASS_ALREADY_EXISTS, HWND, POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetFocus, ReleaseCapture, SetActiveWindow, SetCapture, SetFocus, TrackMouseEvent, TME_LEAVE,
    TRACKMOUSEEVENT, VK_DOWN, VK_END, VK_ESCAPE, VK_F, VK_HOME, VK_LEFT, VK_M, VK_NEXT, VK_PRIOR,
    VK_RETURN, VK_RIGHT, VK_SPACE, VK_UP,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetClassNameW, GetClientRect, GetCursorPos,
    GetForegroundWindow, GetGUIThreadInfo, GetWindow, GetWindowRect, GetWindowThreadProcessId,
    IsWindow, IsWindowVisible, RegisterClassExW, SetForegroundWindow, SetWindowPos, ShowWindow,
    WindowFromPoint, GUITHREADINFO, GW_CHILD, HWND_TOP, MA_ACTIVATE, SWP_NOACTIVATE, SW_HIDE,
    SW_SHOW, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_MBUTTONDBLCLK, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEACTIVATE, WM_MOUSEHWHEEL, WM_MOUSEMOVE,
    WM_MOUSEWHEEL, WM_RBUTTONDBLCLK, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
    WNDCLASSEXW, WS_CLIPCHILDREN, WS_EX_TOOLWINDOW, WS_POPUP,
};

const WM_MOUSE_LEAVE: u32 = 0x02A3;

fn diagnostic_path() -> std::path::PathBuf {
    std::env::temp_dir().join("walactv-player.log")
}

pub fn diagnostic_log(message: impl AsRef<str>) {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(diagnostic_path())
    {
        let _ = writeln!(file, "[{timestamp}] {}", message.as_ref());
    }
}

struct InputBridge {
    api: Arc<MpvApi>,
    handle: usize,
}

static INPUT_BRIDGE: OnceLock<parking_lot::Mutex<Option<InputBridge>>> = OnceLock::new();

fn input_bridge() -> &'static parking_lot::Mutex<Option<InputBridge>> {
    INPUT_BRIDGE.get_or_init(|| parking_lot::Mutex::new(None))
}

pub fn register_input_bridge(api: Arc<MpvApi>, handle: *mut mpv_handle) {
    *input_bridge().lock() = Some(InputBridge {
        api,
        handle: handle as usize,
    });
    diagnostic_log("libmpv input bridge registered");
}

pub fn clear_input_bridge(handle: *mut mpv_handle) {
    let mut bridge = input_bridge().lock();
    if bridge
        .as_ref()
        .is_some_and(|bridge| bridge.handle == handle as usize)
    {
        *bridge = None;
        diagnostic_log("libmpv input bridge cleared");
    }
}

fn mpv_input_command(args: &[&str]) -> bool {
    let bridge = input_bridge().lock();
    let Some(bridge) = bridge.as_ref() else {
        return false;
    };
    let Ok(c_args) = args
        .iter()
        .map(|arg| CString::new(*arg))
        .collect::<Result<Vec<_>, _>>()
    else {
        return false;
    };
    let mut raw_args: Vec<*const c_char> = c_args.iter().map(|arg| arg.as_ptr()).collect();
    raw_args.push(std::ptr::null());
    unsafe { (bridge.api.mpv_command)(bridge.handle as *mut mpv_handle, raw_args.as_ptr()) >= 0 }
}

fn mpv_mouse_position(lparam: isize) -> bool {
    let x = (lparam as u32 & 0xffff) as u16 as i16 as i32;
    let y = ((lparam as u32 >> 16) & 0xffff) as u16 as i16 as i32;
    let x = x.to_string();
    let y = y.to_string();
    mpv_input_command(&["mouse", &x, &y])
}

fn mpv_key_name(vkey: u16) -> Option<&'static str> {
    const DIGITS: [&str; 10] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
    const LETTERS: [&str; 26] = [
        "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r",
        "s", "t", "u", "v", "w", "x", "y", "z",
    ];

    match vkey {
        VK_SPACE => Some("SPACE"),
        VK_LEFT => Some("LEFT"),
        VK_RIGHT => Some("RIGHT"),
        VK_UP => Some("UP"),
        VK_DOWN => Some("DOWN"),
        VK_RETURN => Some("ENTER"),
        VK_ESCAPE => Some("ESC"),
        VK_HOME => Some("HOME"),
        VK_END => Some("END"),
        VK_PRIOR => Some("PGUP"),
        VK_NEXT => Some("PGDWN"),
        VK_F => Some("f"),
        VK_M => Some("m"),
        0x30..=0x39 => Some(DIGITS[(vkey - 0x30) as usize]),
        0x41..=0x5a => Some(LETTERS[(vkey - 0x41) as usize]),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Window class registration (once per process)
// ---------------------------------------------------------------------------

static WND_CLASS_INIT: OnceLock<Result<(), u32>> = OnceLock::new();
static FIRST_MOUSE_FORWARD: AtomicBool = AtomicBool::new(false);
static FIRST_CLICK_FORWARD: AtomicBool = AtomicBool::new(false);
static FIRST_KEY_FORWARD: AtomicBool = AtomicBool::new(false);
static MOUSE_TRACKING: AtomicBool = AtomicBool::new(false);

/// Return the class name pointer, lazily encoding the wide string.
fn class_name() -> *const u16 {
    static NAME: OnceLock<Vec<u16>> = OnceLock::new();
    NAME.get_or_init(|| "WalacTVVideoHost\0".encode_utf16().collect())
        .as_ptr()
}

/// Register the popup window class once per process.
///
/// Uses a small window procedure that forwards popup input to mpv's child.
fn ensure_window_class() -> Result<(), u32> {
    WND_CLASS_INIT
        .get_or_init(|| unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            if instance.is_null() {
                return Err(GetLastError());
            }

            let mut wc: WNDCLASSEXW = std::mem::zeroed();
            wc.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
            wc.lpfnWndProc = Some(host_window_proc);
            wc.hInstance = instance;
            wc.lpszClassName = class_name();
            if RegisterClassExW(&wc) == 0 {
                let error = GetLastError();
                if error != ERROR_CLASS_ALREADY_EXISTS {
                    return Err(error);
                }
            }
            Ok(())
        })
        .as_ref()
        .map(|_| ())
        .map_err(|e| *e)
}

/// The popup wins hit-testing, so inject its input through libmpv commands.
unsafe extern "system" fn host_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: usize,
    lparam: isize,
) -> isize {
    if message == WM_MOUSEACTIVATE {
        SetFocus(hwnd);
        return MA_ACTIVATE as isize;
    }

    if message == WM_MOUSEMOVE {
        if !MOUSE_TRACKING.swap(true, Ordering::AcqRel) {
            let mut tracking = TRACKMOUSEEVENT {
                cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                dwFlags: TME_LEAVE,
                hwndTrack: hwnd,
                dwHoverTime: 0,
            };
            TrackMouseEvent(&mut tracking);
            mpv_input_command(&["keypress", "MOUSE_ENTER"]);
        }
        let delivered = mpv_mouse_position(lparam);
        if !FIRST_MOUSE_FORWARD.swap(true, Ordering::AcqRel) {
            diagnostic_log(format!("first mouse command delivered={delivered}"));
        }
        return 0;
    }

    if message == WM_MOUSE_LEAVE {
        MOUSE_TRACKING.store(false, Ordering::Release);
        mpv_input_command(&["keypress", "MOUSE_LEAVE"]);
        return 0;
    }

    let button = match message {
        WM_LBUTTONDOWN | WM_LBUTTONUP => Some("MBTN_LEFT"),
        WM_MBUTTONDOWN | WM_MBUTTONUP => Some("MBTN_MID"),
        WM_RBUTTONDOWN | WM_RBUTTONUP => Some("MBTN_RIGHT"),
        _ => None,
    };
    if let Some(button) = button {
        mpv_mouse_position(lparam);
        let is_down = matches!(message, WM_LBUTTONDOWN | WM_MBUTTONDOWN | WM_RBUTTONDOWN);
        if is_down {
            SetCapture(hwnd);
            mpv_input_command(&["keydown", button]);
            if !FIRST_CLICK_FORWARD.swap(true, Ordering::AcqRel) {
                diagnostic_log("first click delivered through libmpv keydown");
            }
        } else {
            mpv_input_command(&["keyup", button]);
            ReleaseCapture();
        }
        return 0;
    }

    let double_button = match message {
        WM_LBUTTONDBLCLK => Some("MBTN_LEFT_DBL"),
        WM_MBUTTONDBLCLK => Some("MBTN_MID_DBL"),
        WM_RBUTTONDBLCLK => Some("MBTN_RIGHT_DBL"),
        _ => None,
    };
    if let Some(button) = double_button {
        mpv_mouse_position(lparam);
        mpv_input_command(&["keypress", button]);
        return 0;
    }

    if matches!(message, WM_MOUSEWHEEL | WM_MOUSEHWHEEL) {
        let delta = ((wparam >> 16) & 0xffff) as u16 as i16;
        let key = match (message, delta.is_positive()) {
            (WM_MOUSEWHEEL, true) => "WHEEL_UP",
            (WM_MOUSEWHEEL, false) => "WHEEL_DOWN",
            (WM_MOUSEHWHEEL, true) => "WHEEL_RIGHT",
            _ => "WHEEL_LEFT",
        };
        let scale = (f64::from(delta.unsigned_abs()) / 120.0).to_string();
        mpv_input_command(&["keypress", key, &scale]);
        return 0;
    }

    if matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN | WM_KEYUP | WM_SYSKEYUP) {
        if let Some(key) = mpv_key_name(wparam as u16) {
            let command = if matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN) {
                "keydown"
            } else {
                "keyup"
            };
            mpv_input_command(&[command, key]);
            if command == "keydown" && !FIRST_KEY_FORWARD.swap(true, Ordering::AcqRel) {
                diagnostic_log("first key delivered through libmpv command");
            }
            return 0;
        }
    }

    DefWindowProcW(hwnd, message, wparam, lparam)
}

// ---------------------------------------------------------------------------
// WindowsVideoHost
// ---------------------------------------------------------------------------

/// App-lifetime top-level owned popup window for mpv embedding.
///
/// The popup is a hidden top-level (not child) window owned by the Tauri
/// main window (`WS_EX_TOOLWINDOW | WS_POPUP | WS_CLIPCHILDREN`, owner set).
/// Mpv creates a child of this popup via the `wid` property. Since the popup
/// is separate from the WebView2 HWND tree, WebView2 cannot re-order itself
/// on top. No `WindowFromPoint` interference occurs.
///
/// The popup is destroyed by the OS (as an owned window) when the owner
/// closes. No explicit `Drop` is needed.
pub struct WindowsVideoHost {
    app: AppHandle,
    main_thread_id: std::thread::ThreadId,
    owner: isize,
    popup: isize,
    visible: AtomicBool,
}

impl WindowsVideoHost {
    /// Create the hidden popup window under `parent_hwnd`.
    ///
    /// Must be called from the Tauri main thread (typically in `setup()`).
    pub fn new(app: AppHandle, parent_hwnd: i64) -> Result<Self, String> {
        let _ = std::fs::write(diagnostic_path(), "WalacTV Windows player diagnostics\n");
        diagnostic_log(format!("creating host owner=0x{:x}", parent_hwnd as usize));
        ensure_window_class()
            .map_err(|err| format!("RegisterClassExW failed: last_error={err}"))?;

        let parent: HWND = parent_hwnd as isize as *mut _;

        let popup = unsafe {
            CreateWindowExW(
                WS_EX_TOOLWINDOW,
                class_name(),
                std::ptr::null(),
                WS_POPUP | WS_CLIPCHILDREN,
                0,
                0,
                0,
                0,
                parent,
                std::ptr::null_mut(),
                GetModuleHandleW(std::ptr::null()),
                std::ptr::null_mut(),
            )
        };

        if popup.is_null() {
            return Err(format!("CreateWindowExW failed: last_error={}", unsafe {
                GetLastError()
            }));
        }

        diagnostic_log(format!("host created popup={}", describe_hwnd(popup)));

        Ok(WindowsVideoHost {
            app,
            main_thread_id: std::thread::current().id(),
            owner: parent_hwnd as isize,
            popup: popup as isize,
            visible: AtomicBool::new(false),
        })
    }

    /// Return the popup HWND suitable for mpv's `wid` property.
    pub fn wid(&self) -> i64 {
        self.popup as i64
    }

    /// Return whether the popup is currently marked visible.
    pub fn is_visible(&self) -> bool {
        self.visible.load(Ordering::Acquire)
    }

    // ------------------------------------------------------------------
    // Public operations (thread-safe, main-thread dispatch)
    // ------------------------------------------------------------------

    /// Show the popup: sync position, `ShowWindow(SW_SHOW)`,
    /// `SetForegroundWindow` (best-effort), `SetFocus` to child if any.
    ///
    /// The `visible` flag is set only after the main-thread operation
    /// succeeds.
    pub fn show(&self) -> Result<(), String> {
        let result = self.dispatch(|owner, popup| show_raw(owner, popup));
        if result.is_ok() {
            self.visible.store(true, Ordering::Release);
        }
        diagnostic_log(format!("show result={result:?}"));
        result
    }

    /// Hide the popup via `ShowWindow(SW_HIDE)`.
    ///
    /// The `visible` flag is cleared only after the main-thread operation
    /// succeeds.
    pub fn hide(&self) -> Result<(), String> {
        let result = self.dispatch(|_owner, popup| hide_raw(popup));
        if result.is_ok() {
            self.visible.store(false, Ordering::Release);
        }
        diagnostic_log(format!("hide result={result:?}"));
        result
    }

    /// Sync popup position and size to match the owner's client area.
    ///
    /// Does not change the `visible` flag.
    pub fn sync(&self) -> Result<(), String> {
        self.dispatch(|owner, popup| sync_raw(owner, popup))
    }

    /// Focus mpv's child after the video output HWND has been created.
    pub fn focus(&self) -> Result<(), String> {
        let result = self.dispatch(|_owner, popup| focus_child_raw(popup));
        diagnostic_log(format!("focus result={result:?}"));
        result
    }

    /// Record the current cursor hit-test and process-wide focus state.
    pub fn log_input_snapshot(&self) -> Result<(), String> {
        self.dispatch(|owner, popup| log_input_snapshot_raw(owner, popup))
    }

    // ------------------------------------------------------------------
    // Dispatch helpers
    // ------------------------------------------------------------------

    /// True if we are on the thread that created this host.
    fn is_main_thread(&self) -> bool {
        self.main_thread_id == std::thread::current().id()
    }

    /// Run `op(owner, popup)` on the main thread.
    ///
    /// If already on the main thread, executes inline. Otherwise dispatches
    /// via `run_on_main_thread` + channel with a 5-second timeout.
    fn dispatch(
        &self,
        op: impl FnOnce(isize, isize) -> Result<(), String> + Send + 'static,
    ) -> Result<(), String> {
        if self.is_main_thread() {
            return op(self.owner, self.popup);
        }

        let owner = self.owner;
        let popup = self.popup;
        let (tx, rx) = std::sync::mpsc::channel();

        self.app
            .run_on_main_thread(move || {
                let _ = tx.send(op(owner, popup));
            })
            .map_err(|e| format!("dispatch to main thread failed: {e}"))?;

        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "main thread dispatch timeout (5s)".to_string())?
    }
}

// ---------------------------------------------------------------------------
// Raw Win32 helpers  (called on main thread only, never construct Self)
// ---------------------------------------------------------------------------

/// Validate the popup HWND is still alive, sync its position/size to match
/// the owner's client rectangle, and position it at `HWND_TOP`.
fn sync_raw(owner: isize, popup: isize) -> Result<(), String> {
    unsafe {
        let popup: HWND = popup as *mut _;
        let owner: HWND = owner as *mut _;

        if IsWindow(popup) == 0 {
            return Err("popup window is no longer valid".to_string());
        }

        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if GetClientRect(owner, &mut rect) == 0 {
            return Err(format!(
                "GetClientRect failed: last_error={}",
                GetLastError()
            ));
        }

        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width < 1 || height < 1 {
            // Nothing to position; skip silently (e.g. minimized).
            return Ok(());
        }

        let mut pt = POINT { x: 0, y: 0 };
        if ClientToScreen(owner, &mut pt) == 0 {
            return Err(format!(
                "ClientToScreen failed: last_error={}",
                GetLastError()
            ));
        }

        if SetWindowPos(popup, HWND_TOP, pt.x, pt.y, width, height, SWP_NOACTIVATE) == 0 {
            return Err(format!(
                "SetWindowPos failed: last_error={}",
                GetLastError()
            ));
        }
    }
    Ok(())
}

/// Show the popup: sync, `ShowWindow(SW_SHOW)`, foreground, focus child.
fn show_raw(owner: isize, popup: isize) -> Result<(), String> {
    sync_raw(owner, popup)?;

    unsafe {
        let popup: HWND = popup as *mut _;

        // ShowWindow return value indicates previous visibility state, not
        // success/failure. Do not read GetLastError after ShowWindow.
        ShowWindow(popup, SW_SHOW);

        // Best-effort activation. The mpv child usually does not exist until
        // after loadfile, so the event loop focuses it again on FILE_LOADED.
        SetForegroundWindow(popup);
    }
    Ok(())
}

/// Focus mpv's child window, temporarily joining its Win32 input queue when
/// mpv created the child on a different thread.
fn focus_child_raw(popup: isize) -> Result<(), String> {
    unsafe {
        let popup: HWND = popup as *mut _;
        if IsWindow(popup) == 0 {
            return Err("popup window is no longer valid".to_string());
        }

        let child = GetWindow(popup, GW_CHILD);
        if child.is_null() {
            return Err("mpv child window is not available yet".to_string());
        }

        SetForegroundWindow(popup);

        let current_thread = GetCurrentThreadId();
        let child_thread = GetWindowThreadProcessId(child, std::ptr::null_mut());
        if child_thread == 0 {
            return Err(format!(
                "GetWindowThreadProcessId failed: last_error={}",
                GetLastError()
            ));
        }

        let attach_needed = current_thread != child_thread;
        if attach_needed && AttachThreadInput(current_thread, child_thread, 1) == 0 {
            return Err(format!(
                "AttachThreadInput failed: last_error={}",
                GetLastError()
            ));
        }

        SetActiveWindow(popup);
        SetFocus(child);
        let focused = GetFocus() == child;

        if attach_needed {
            AttachThreadInput(current_thread, child_thread, 0);
        }

        if !focused {
            return Err("SetFocus did not focus the mpv child window".to_string());
        }
    }
    Ok(())
}

fn describe_hwnd(hwnd: HWND) -> String {
    if hwnd.is_null() {
        return "NULL".to_string();
    }

    unsafe {
        let mut class_name = [0u16; 128];
        let class_len = GetClassNameW(hwnd, class_name.as_mut_ptr(), class_name.len() as i32);
        let class = String::from_utf16_lossy(&class_name[..class_len.max(0) as usize]);
        let mut rect: RECT = std::mem::zeroed();
        let has_rect = GetWindowRect(hwnd, &mut rect) != 0;
        let thread = GetWindowThreadProcessId(hwnd, std::ptr::null_mut());
        format!(
            "0x{:x} class={class:?} visible={} thread={thread} rect={}",
            hwnd as usize,
            IsWindowVisible(hwnd) != 0,
            if has_rect {
                format!("{},{},{},{}", rect.left, rect.top, rect.right, rect.bottom)
            } else {
                "unavailable".to_string()
            }
        )
    }
}

fn log_input_snapshot_raw(owner: isize, popup: isize) -> Result<(), String> {
    unsafe {
        let popup: HWND = popup as *mut _;
        if IsWindow(popup) == 0 {
            return Err("popup window is no longer valid".to_string());
        }

        let mut cursor = POINT { x: 0, y: 0 };
        let cursor_ok = GetCursorPos(&mut cursor) != 0;
        let under_cursor = if cursor_ok {
            WindowFromPoint(cursor)
        } else {
            std::ptr::null_mut()
        };
        let child = GetWindow(popup, GW_CHILD);
        let foreground = GetForegroundWindow();
        let foreground_thread = if foreground.is_null() {
            0
        } else {
            GetWindowThreadProcessId(foreground, std::ptr::null_mut())
        };
        let mut gui: GUITHREADINFO = std::mem::zeroed();
        gui.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
        let focus = if foreground_thread != 0 && GetGUIThreadInfo(foreground_thread, &mut gui) != 0
        {
            gui.hwndFocus
        } else {
            std::ptr::null_mut()
        };

        diagnostic_log(format!(
            "input cursor={},{} owner={} popup={} child={} under_cursor={} foreground={} focus={}",
            cursor.x,
            cursor.y,
            describe_hwnd(owner as *mut _),
            describe_hwnd(popup),
            describe_hwnd(child),
            describe_hwnd(under_cursor),
            describe_hwnd(foreground),
            describe_hwnd(focus),
        ));
    }
    Ok(())
}

/// Hide the popup via `ShowWindow(SW_HIDE)`.
fn hide_raw(popup: isize) -> Result<(), String> {
    unsafe {
        let popup: HWND = popup as *mut _;

        if IsWindow(popup) == 0 {
            return Err("popup window is no longer valid".to_string());
        }

        ShowWindow(popup, SW_HIDE);
    }
    Ok(())
}

// No explicit Drop — the OS destroys this owned popup when its owner HWND
// closes. An explicit DestroyWindow here would race with the main-thread
// dispatches from the event loop.
