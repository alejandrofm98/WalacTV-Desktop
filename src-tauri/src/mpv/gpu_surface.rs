//! Native GPU target that belongs to the same Tauri client as the webview.

#[cfg(target_os = "windows")]
use raw_window_handle::{HasWindowHandle, RawWindowHandle};
#[cfg(target_os = "windows")]
use tauri::AppHandle;
#[cfg(target_os = "windows")]
use tauri::Manager;

pub struct GpuVideoSurface {
    #[cfg(target_os = "windows")]
    main: isize,
    #[cfg(target_os = "windows")]
    video: isize,
}

// GTK confines access to the main thread; Win32 serializes access through the
// parent window. The renderer honors those platform constraints.
unsafe impl Send for GpuVideoSurface {}
unsafe impl Sync for GpuVideoSurface {}

impl GpuVideoSurface {
    #[cfg(target_os = "windows")]
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let window = app
            .get_window("main")
            .ok_or_else(|| "Main window not found".to_string())?;
        let handle = window.window_handle().map_err(|error| error.to_string())?;
        match handle.as_raw() {
            RawWindowHandle::Win32(handle) => windows::create(handle.hwnd.get()),
            _ => Err("GPU video surface requires a Win32 HWND".to_string()),
        }
    }

    #[cfg(target_os = "windows")]
    pub fn sync(&self) -> Result<(), String> {
        windows::sync(self.main, self.video)
    }

    #[cfg(target_os = "windows")]
    pub fn show(&self) -> Result<(), String> {
        windows::show(self.main, self.video)
    }

    #[cfg(target_os = "windows")]
    pub fn hide(&self) -> Result<(), String> {
        windows::hide(self.video)
    }

    #[cfg(target_os = "windows")]
    pub fn create_gl_context(&self) -> Result<WindowsGlContext, String> {
        windows::create_gl_context(self.video)
    }

    #[cfg(target_os = "windows")]
    pub fn size(&self) -> (i32, i32) {
        windows::size(self.video)
    }

    /// Resolve a graphics API symbol for libmpv's OpenGL renderer.
    ///
    /// # Safety
    /// `name` must point to a valid null-terminated function name.
    #[cfg(target_os = "windows")]
    pub unsafe fn get_proc_address(name: *const std::ffi::c_char) -> *mut std::ffi::c_void {
        unsafe { windows::get_proc_address(name) }
    }
}

#[cfg(target_os = "windows")]
pub struct WindowsGlContext {
    hwnd: isize,
    dc: isize,
    glrc: isize,
}

#[cfg(target_os = "windows")]
unsafe impl Send for WindowsGlContext {}

#[cfg(target_os = "windows")]
impl WindowsGlContext {
    pub fn make_current(&self) -> Result<(), String> {
        windows::make_current(self.dc, self.glrc)
    }

    pub fn swap_buffers(&self) {
        windows::swap_buffers(self.dc);
    }
}

#[cfg(target_os = "windows")]
impl Drop for WindowsGlContext {
    fn drop(&mut self) {
        windows::destroy_gl_context(self.hwnd, self.dc, self.glrc);
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_CLASS_ALREADY_EXISTS, HWND, RECT};
    use windows_sys::Win32::Graphics::Gdi::{CreateSolidBrush, GetDC, ReleaseDC};
    use windows_sys::Win32::Graphics::OpenGL::{
        wglCreateContext, wglDeleteContext, wglGetProcAddress, wglMakeCurrent, ChoosePixelFormat,
        SetPixelFormat, SwapBuffers, PFD_DOUBLEBUFFER, PFD_DRAW_TO_WINDOW, PFD_MAIN_PLANE,
        PFD_SUPPORT_OPENGL, PFD_TYPE_RGBA, PIXELFORMATDESCRIPTOR,
    };
    use windows_sys::Win32::System::LibraryLoader::{
        GetModuleHandleA, GetModuleHandleW, GetProcAddress,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, GetClientRect, RegisterClassExW, SetWindowPos, ShowWindow,
        CS_OWNDC, HWND_BOTTOM, SWP_NOACTIVATE, SW_HIDE, SW_SHOW, WNDCLASSEXW, WS_CHILD,
        WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_EX_NOACTIVATE,
    };

    static CLASS: OnceLock<Result<(), u32>> = OnceLock::new();

    fn class_name() -> *const u16 {
        static NAME: OnceLock<Vec<u16>> = OnceLock::new();
        NAME.get_or_init(|| "WalacTVGpuSurface\0".encode_utf16().collect())
            .as_ptr()
    }

    fn register_class() -> Result<(), String> {
        CLASS
            .get_or_init(|| unsafe {
                let instance = GetModuleHandleW(std::ptr::null());
                let mut class: WNDCLASSEXW = std::mem::zeroed();
                class.cbSize = std::mem::size_of::<WNDCLASSEXW>() as u32;
                class.style = CS_OWNDC;
                class.lpfnWndProc = Some(DefWindowProcW);
                class.hInstance = instance;
                class.lpszClassName = class_name();
                class.hbrBackground = CreateSolidBrush(0x002d1b07);
                if RegisterClassExW(&class) == 0 {
                    let error = GetLastError();
                    if error != ERROR_CLASS_ALREADY_EXISTS {
                        return Err(error);
                    }
                }
                Ok(())
            })
            .as_ref()
            .map(|_| ())
            .map_err(|error| format!("RegisterClassExW failed: {error}"))
    }

    pub fn create(main: isize) -> Result<super::GpuVideoSurface, String> {
        register_class()?;
        let video = unsafe {
            CreateWindowExW(
                WS_EX_NOACTIVATE,
                class_name(),
                std::ptr::null(),
                WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                0,
                0,
                1,
                1,
                main as HWND,
                std::ptr::null_mut(),
                GetModuleHandleW(std::ptr::null()),
                std::ptr::null(),
            )
        };
        if video.is_null() {
            return Err(format!("CreateWindowExW failed: {}", unsafe {
                GetLastError()
            }));
        }
        Ok(super::GpuVideoSurface {
            main,
            video: video as isize,
        })
    }

    pub fn sync(main: isize, video: isize) -> Result<(), String> {
        unsafe {
            let mut rect: RECT = std::mem::zeroed();
            if GetClientRect(main as HWND, &mut rect) == 0 {
                return Err(format!("GetClientRect failed: {}", GetLastError()));
            }
            if SetWindowPos(
                video as HWND,
                HWND_BOTTOM,
                0,
                0,
                rect.right - rect.left,
                rect.bottom - rect.top,
                SWP_NOACTIVATE,
            ) == 0
            {
                return Err(format!("SetWindowPos failed: {}", GetLastError()));
            }
        }
        Ok(())
    }

    pub fn show(main: isize, video: isize) -> Result<(), String> {
        sync(main, video)?;
        unsafe { ShowWindow(video as HWND, SW_SHOW) };
        Ok(())
    }

    pub fn hide(video: isize) -> Result<(), String> {
        unsafe { ShowWindow(video as HWND, SW_HIDE) };
        Ok(())
    }

    pub fn create_gl_context(video: isize) -> Result<super::WindowsGlContext, String> {
        unsafe {
            let dc = GetDC(video as HWND);
            if dc.is_null() {
                return Err(format!("GetDC failed: {}", GetLastError()));
            }
            let descriptor = PIXELFORMATDESCRIPTOR {
                nSize: std::mem::size_of::<PIXELFORMATDESCRIPTOR>() as u16,
                nVersion: 1,
                dwFlags: PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER,
                iPixelType: PFD_TYPE_RGBA,
                cColorBits: 32,
                cRedBits: 0,
                cRedShift: 0,
                cGreenBits: 0,
                cGreenShift: 0,
                cBlueBits: 0,
                cBlueShift: 0,
                cAlphaBits: 8,
                cAlphaShift: 0,
                cAccumBits: 0,
                cAccumRedBits: 0,
                cAccumGreenBits: 0,
                cAccumBlueBits: 0,
                cAccumAlphaBits: 0,
                cDepthBits: 0,
                cStencilBits: 0,
                cAuxBuffers: 0,
                iLayerType: PFD_MAIN_PLANE as u8,
                bReserved: 0,
                dwLayerMask: 0,
                dwVisibleMask: 0,
                dwDamageMask: 0,
            };
            let format = ChoosePixelFormat(dc, &descriptor);
            if format == 0 || SetPixelFormat(dc, format, &descriptor) == 0 {
                let error = GetLastError();
                ReleaseDC(video as HWND, dc);
                return Err(format!("WGL pixel format setup failed: {error}"));
            }
            let glrc = wglCreateContext(dc);
            if glrc.is_null() {
                let error = GetLastError();
                ReleaseDC(video as HWND, dc);
                return Err(format!("wglCreateContext failed: {error}"));
            }
            Ok(super::WindowsGlContext {
                hwnd: video,
                dc: dc as isize,
                glrc: glrc as isize,
            })
        }
    }

    pub fn make_current(dc: isize, glrc: isize) -> Result<(), String> {
        if unsafe { wglMakeCurrent(dc as _, glrc as _) } == 0 {
            return Err(format!("wglMakeCurrent failed: {}", unsafe {
                GetLastError()
            }));
        }
        Ok(())
    }

    pub fn swap_buffers(dc: isize) {
        unsafe { SwapBuffers(dc as _) };
    }

    pub fn destroy_gl_context(hwnd: isize, dc: isize, glrc: isize) {
        unsafe {
            wglMakeCurrent(std::ptr::null_mut(), std::ptr::null_mut());
            wglDeleteContext(glrc as _);
            ReleaseDC(hwnd as HWND, dc as _);
        }
    }

    pub fn size(video: isize) -> (i32, i32) {
        unsafe {
            let mut rect: RECT = std::mem::zeroed();
            if GetClientRect(video as HWND, &mut rect) == 0 {
                return (1, 1);
            }
            (
                (rect.right - rect.left).max(1),
                (rect.bottom - rect.top).max(1),
            )
        }
    }

    pub unsafe fn get_proc_address(name: *const std::ffi::c_char) -> *mut std::ffi::c_void {
        if let Some(function) = unsafe { wglGetProcAddress(name.cast()) } {
            let address = function as *const () as usize;
            if !matches!(address, 0 | 1 | 2 | 3 | usize::MAX) {
                return address as *mut std::ffi::c_void;
            }
        }
        let module = unsafe { GetModuleHandleA(c"opengl32.dll".as_ptr().cast()) };
        if module.is_null() {
            return std::ptr::null_mut();
        }
        unsafe { GetProcAddress(module, name.cast()) }
            .map(|function| function as *const () as *mut std::ffi::c_void)
            .unwrap_or(std::ptr::null_mut())
    }
}
