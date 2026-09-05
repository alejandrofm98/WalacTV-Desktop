//! libmpv Render API integration for the native GPU surface.

use crate::mpv::ffi::{mpv_handle, MpvApi};
use crate::mpv::gpu_surface::GpuVideoSurface;
use std::sync::Arc;

pub struct GpuRenderer {
    inner: platform::Renderer,
}

impl GpuRenderer {
    pub fn start(
        app: tauri::AppHandle,
        handle: *mut mpv_handle,
        api: Arc<MpvApi>,
        surface: Arc<GpuVideoSurface>,
    ) -> Result<Self, String> {
        Ok(Self {
            inner: platform::Renderer::start(app, handle, api, surface)?,
        })
    }

    pub fn stop(&mut self) {
        self.inner.stop();
    }

    /// Latest readback frame (Windows CPU-readback backend).
    #[cfg(target_os = "windows")]
    pub fn latest_frame(&self) -> Option<RenderFrame> {
        self.inner.latest_frame()
    }

    /// Frame counter of the latest readback frame (Windows).
    #[cfg(target_os = "windows")]
    pub fn frame_counter(&self) -> u32 {
        self.inner.frame_counter()
    }

    /// Target render size from the frontend (Windows).
    #[cfg(target_os = "windows")]
    pub fn set_target_size(&self, width: u32, height: u32) {
        self.inner.set_target_size(width, height);
    }
}

impl Drop for GpuRenderer {
    fn drop(&mut self) {
        self.stop();
    }
}


#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    /// Linux uses the offscreen EGL Render API backend with CPU readback
    /// (`mpv::render_context`), not this standalone renderer.
    pub struct Renderer;

    impl Renderer {
        pub fn start(
            _app: tauri::AppHandle,
            _handle: *mut mpv_handle,
            _api: Arc<MpvApi>,
            _surface: Arc<GpuVideoSurface>,
        ) -> Result<Self, String> {
            Err("Linux GPU renderer is not used (offscreen CPU readback backend)".to_string())
        }

        pub fn stop(&mut self) {}
    }
}

/// Latest CPU-readback frame shared between the render thread and Tauri
/// commands. Same role as the Linux offscreen `FrameBuffer`, so the frontend
/// `<canvas>` path (`useRenderFrame` + `mpv_get_render_frame`) works
/// identically on Windows.
#[cfg(target_os = "windows")]
#[derive(Clone)]
pub struct RenderFrame {
    pub width: u32,
    pub height: u32,
    pub counter: u64,
    pub pixels: Vec<u8>,
}

impl RenderFrame {
    fn empty() -> Self {
        Self {
            width: 0,
            height: 0,
            counter: 0,
            pixels: Vec::new(),
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use crate::mpv::ffi::{
        mpv_opengl_init_params, mpv_render_context, mpv_render_param, MPV_RENDER_PARAM_API_TYPE,
        MPV_RENDER_PARAM_INVALID, MPV_RENDER_PARAM_OPENGL_FBO, MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,
    };
    use std::ffi::{c_char, c_void, CString};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Condvar, Mutex};

    type GLuint = u32;
    type GLint = i32;
    type GLsizei = i32;
    type GLenum = u32;

    const GL_FRAMEBUFFER: GLenum = 0x8D40;
    const GL_COLOR_ATTACHMENT0: GLenum = 0x8CE0;
    const GL_TEXTURE_2D: GLenum = 0x0DE1;
    const GL_RGBA: GLenum = 0x1908;
    const GL_RGBA8: GLenum = 0x8058;
    const GL_UNSIGNED_BYTE: GLenum = 0x1401;
    const GL_FRAMEBUFFER_COMPLETE: GLenum = 0x8CD5;
    const GL_PACK_ALIGNMENT: GLenum = 0x0D05;
    const GL_LINEAR: GLenum = 0x2601;
    const GL_TEXTURE_MIN_FILTER: GLenum = 0x2801;
    const GL_TEXTURE_MAG_FILTER: GLenum = 0x2800;

    // PBO (pixel buffer object) — async readback, mirrors Linux.
    const GL_PIXEL_PACK_BUFFER: GLenum = 0x88EB;
    const GL_STREAM_READ: GLenum = 0x88E0;
    const GL_MAP_READ_BIT: u32 = 0x0001;

    #[repr(C)]
    struct MpvOpenglFbo {
        fbo: i32,
        w: i32,
        h: i32,
        internal_format: i32,
    }

    struct RenderWake {
        dirty: Mutex<bool>,
        changed: Condvar,
    }

    unsafe extern "C" fn get_proc_address(_ctx: *mut c_void, name: *const c_char) -> *mut c_void {
        unsafe { GpuVideoSurface::get_proc_address(name) }
    }

    unsafe extern "C" fn request_redraw(ctx: *mut c_void) {
        if ctx.is_null() {
            return;
        }
        let wake = unsafe { &*(ctx as *const RenderWake) };
        if let Ok(mut dirty) = wake.dirty.lock() {
            *dirty = true;
            wake.changed.notify_one();
        }
    }

    struct WglGl {
        gl_gen_framebuffers: unsafe extern "C" fn(GLsizei, *mut GLuint),
        gl_bind_framebuffer: unsafe extern "C" fn(GLenum, GLuint),
        gl_framebuffer_texture_2d: unsafe extern "C" fn(GLenum, GLenum, GLenum, GLuint, GLint),
        gl_check_framebuffer_status: unsafe extern "C" fn(GLenum) -> GLenum,
        gl_delete_framebuffers: unsafe extern "C" fn(GLsizei, *const GLuint),
        gl_gen_textures: unsafe extern "C" fn(GLsizei, *mut GLuint),
        gl_bind_texture: unsafe extern "C" fn(GLenum, GLuint),
        gl_tex_image_2d: unsafe extern "C" fn(
            GLenum,
            GLint,
            GLint,
            GLsizei,
            GLsizei,
            GLint,
            GLenum,
            GLenum,
            *const c_void,
        ),
        gl_tex_parameter_i: unsafe extern "C" fn(GLenum, GLenum, GLint),
        gl_delete_textures: unsafe extern "C" fn(GLsizei, *const GLuint),
        gl_read_pixels:
            unsafe extern "C" fn(GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, *mut c_void),
        gl_pixel_store_i: unsafe extern "C" fn(GLenum, GLint),
        gl_get_error: unsafe extern "C" fn() -> GLenum,
    }

    /// Resolve OpenGL functions through the WGL context (wglGetProcAddress
    /// with opengl32.dll fallback). Must be called with a current context.
    fn load_wgl_gl() -> Result<WglGl, String> {
        macro_rules! load {
            ($name:expr, $sig:ty) => {{
                let c_name =
                    CString::new($name).map_err(|_| format!("bad GL name: {}", $name))?;
                let ptr = unsafe { GpuVideoSurface::get_proc_address(c_name.as_ptr()) };
                if ptr.is_null() {
                    return Err(format!("GL function {} no disponible", $name));
                }
                unsafe { std::mem::transmute::<*mut c_void, $sig>(ptr) }
            }};
        }
        Ok(WglGl {
            gl_gen_framebuffers: load!(
                "glGenFramebuffers",
                unsafe extern "C" fn(GLsizei, *mut GLuint)
            ),
            gl_bind_framebuffer: load!("glBindFramebuffer", unsafe extern "C" fn(GLenum, GLuint)),
            gl_framebuffer_texture_2d: load!(
                "glFramebufferTexture2D",
                unsafe extern "C" fn(GLenum, GLenum, GLenum, GLuint, GLint)
            ),
            gl_check_framebuffer_status: load!(
                "glCheckFramebufferStatus",
                unsafe extern "C" fn(GLenum) -> GLenum
            ),
            gl_delete_framebuffers: load!(
                "glDeleteFramebuffers",
                unsafe extern "C" fn(GLsizei, *const GLuint)
            ),
            gl_gen_textures: load!("glGenTextures", unsafe extern "C" fn(GLsizei, *mut GLuint)),
            gl_bind_texture: load!("glBindTexture", unsafe extern "C" fn(GLenum, GLuint)),
            gl_tex_image_2d: load!(
                "glTexImage2D",
                unsafe extern "C" fn(
                    GLenum,
                    GLint,
                    GLint,
                    GLsizei,
                    GLsizei,
                    GLint,
                    GLenum,
                    GLenum,
                    *const c_void,
                )
            ),
            gl_tex_parameter_i: load!(
                "glTexParameteri",
                unsafe extern "C" fn(GLenum, GLenum, GLint)
            ),
            gl_delete_textures: load!(
                "glDeleteTextures",
                unsafe extern "C" fn(GLsizei, *const GLuint)
            ),
            gl_read_pixels: load!(
                "glReadPixels",
                unsafe extern "C" fn(GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, *mut c_void)
            ),
            gl_pixel_store_i: load!("glPixelStorei", unsafe extern "C" fn(GLenum, GLint)),
            gl_get_error: load!("glGetError", unsafe extern "C" fn() -> GLenum),
        })
    }

    /// PBO functions for async readback. Loaded leniently: if any symbol is
    /// missing, the loop falls back to synchronous glReadPixels.
    struct PboGl {
        gl_gen_buffers: unsafe extern "C" fn(GLsizei, *mut GLuint),
        gl_bind_buffer: unsafe extern "C" fn(GLenum, GLuint),
        gl_buffer_data: unsafe extern "C" fn(GLenum, isize, *const c_void, GLenum),
        gl_map_buffer_range:
            unsafe extern "C" fn(GLenum, isize, isize, u32) -> *mut c_void,
        gl_unmap_buffer: unsafe extern "C" fn(GLenum) -> u8,
        gl_delete_buffers: unsafe extern "C" fn(GLsizei, *const GLuint),
    }

    fn load_pbo_gl() -> Option<PboGl> {
        macro_rules! proc {
            ($str:expr) => {{
                let c_name = CString::new($str).ok()?;
                let p = unsafe { GpuVideoSurface::get_proc_address(c_name.as_ptr()) };
                if p.is_null() {
                    return None;
                }
                unsafe { std::mem::transmute::<*mut c_void, _>(p) }
            }};
        }
        // Return None (sync fallback) if any symbol is missing.
        let gl_gen_buffers: unsafe extern "C" fn(GLsizei, *mut GLuint) =
            proc!("glGenBuffers");
        let gl_bind_buffer: unsafe extern "C" fn(GLenum, GLuint) = proc!("glBindBuffer");
        let gl_buffer_data: unsafe extern "C" fn(GLenum, isize, *const c_void, GLenum) =
            proc!("glBufferData");
        let gl_map_buffer_range: unsafe extern "C" fn(GLenum, isize, isize, u32) -> *mut c_void =
            proc!("glMapBufferRange");
        let gl_unmap_buffer: unsafe extern "C" fn(GLenum) -> u8 = proc!("glUnmapBuffer");
        let gl_delete_buffers: unsafe extern "C" fn(GLsizei, *const GLuint) =
            proc!("glDeleteBuffers");
        Some(PboGl {
            gl_gen_buffers,
            gl_bind_buffer,
            gl_buffer_data,
            gl_map_buffer_range,
            gl_unmap_buffer,
            gl_delete_buffers,
        })
    }

    fn create_fbo(gl: &WglGl, width: u32, height: u32) -> Result<(GLuint, GLuint), String> {
        let mut fbo_id: GLuint = 0;
        let mut tex_id: GLuint = 0;
        unsafe {
            (gl.gl_gen_framebuffers)(1, &mut fbo_id);
            (gl.gl_bind_framebuffer)(GL_FRAMEBUFFER, fbo_id);
            (gl.gl_gen_textures)(1, &mut tex_id);
            (gl.gl_bind_texture)(GL_TEXTURE_2D, tex_id);
            (gl.gl_tex_image_2d)(
                GL_TEXTURE_2D,
                0,
                GL_RGBA8 as GLint,
                width as GLsizei,
                height as GLsizei,
                0,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                std::ptr::null(),
            );
            (gl.gl_tex_parameter_i)(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR as GLint);
            (gl.gl_tex_parameter_i)(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR as GLint);
            (gl.gl_framebuffer_texture_2d)(
                GL_FRAMEBUFFER,
                GL_COLOR_ATTACHMENT0,
                GL_TEXTURE_2D,
                tex_id,
                0,
            );
            let status = (gl.gl_check_framebuffer_status)(GL_FRAMEBUFFER);
            if status != GL_FRAMEBUFFER_COMPLETE {
                (gl.gl_delete_framebuffers)(1, &fbo_id);
                (gl.gl_delete_textures)(1, &tex_id);
                return Err(format!("FBO incompleto: status 0x{status:x}"));
            }
            (gl.gl_bind_framebuffer)(GL_FRAMEBUFFER, 0);
            (gl.gl_bind_texture)(GL_TEXTURE_2D, 0);
        }
        Ok((fbo_id, tex_id))
    }

    fn resize_fbo(gl: &WglGl, tex_id: GLuint, fbo_id: GLuint, width: u32, height: u32) {
        unsafe {
            (gl.gl_bind_texture)(GL_TEXTURE_2D, tex_id);
            (gl.gl_tex_image_2d)(
                GL_TEXTURE_2D,
                0,
                GL_RGBA8 as GLint,
                width as GLsizei,
                height as GLsizei,
                0,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                std::ptr::null(),
            );
            (gl.gl_bind_framebuffer)(GL_FRAMEBUFFER, fbo_id);
            let status = (gl.gl_check_framebuffer_status)(GL_FRAMEBUFFER);
            if status != GL_FRAMEBUFFER_COMPLETE {
                crate::mpv::platform::windows::diagnostic_log(format!(
                    "FBO incompleto tras resize: status 0x{status:x}"
                ));
            }
            (gl.gl_bind_texture)(GL_TEXTURE_2D, 0);
        }
    }

    pub struct Renderer {
        stop: Arc<AtomicBool>,
        wake: Arc<RenderWake>,
        thread: Option<std::thread::JoinHandle<()>>,
        frames: Arc<Mutex<RenderFrame>>,
        /// Target render size reported by the frontend ResizeObserver
        /// (canvas CSS size x devicePixelRatio), capped to READBACK_MAX.
        target: Arc<Mutex<(u32, u32)>>,
    }

    impl Renderer {
        pub fn start(
            _app: tauri::AppHandle,
            handle: *mut mpv_handle,
            api: Arc<MpvApi>,
            surface: Arc<GpuVideoSurface>,
        ) -> Result<Self, String> {
            let stop = Arc::new(AtomicBool::new(false));
            let wake = Arc::new(RenderWake {
                dirty: Mutex::new(true),
                changed: Condvar::new(),
            });
            let frames = Arc::new(Mutex::new(RenderFrame::empty()));
            let target = Arc::new(Mutex::new((READBACK_MAX_W as u32, READBACK_MAX_H as u32)));
            let stop_for_thread = Arc::clone(&stop);
            let wake_for_thread = Arc::clone(&wake);
            let frames_for_thread = Arc::clone(&frames);
            let target_for_thread = Arc::clone(&target);
            let handle = handle as usize;
            let (ready_tx, ready_rx) = std::sync::mpsc::channel();
            let thread = std::thread::Builder::new()
                .name("mpv-wgl-render".into())
                .spawn(move || {
                    let result = run_render_loop(
                        handle as *mut mpv_handle,
                        api,
                        surface,
                        stop_for_thread,
                        wake_for_thread,
                        frames_for_thread,
                        target_for_thread,
                        ready_tx,
                    );
                    if let Err(error) = result {
                        log::error!("Windows GPU renderer stopped: {error}");
                        crate::mpv::platform::windows::diagnostic_log(format!(
                            "mpv-wgl-render stopped: {error}"
                        ));
                    } else {
                        crate::mpv::platform::windows::diagnostic_log(
                            "mpv-wgl-render thread exited cleanly",
                        );
                    }
                })
                .map_err(|error| error.to_string())?;

            ready_rx
                .recv_timeout(std::time::Duration::from_secs(10))
                .map_err(|_| "Windows GPU renderer initialization timed out".to_string())??;
            Ok(Self {
                stop,
                wake,
                thread: Some(thread),
                frames,
                target,
            })
        }

        pub fn stop(&mut self) {
            self.stop.store(true, Ordering::Release);
            self.wake.changed.notify_one();
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }

        pub fn latest_frame(&self) -> Option<RenderFrame> {
            self.frames.lock().ok().and_then(|fb| {
                if fb.counter == 0 || fb.pixels.is_empty() {
                    None
                } else {
                    Some(fb.clone())
                }
            })
        }

        pub fn frame_counter(&self) -> u32 {
            self.frames.lock().map(|fb| fb.counter as u32).unwrap_or(0)
        }

        /// Update the target render size from the frontend ResizeObserver.
        /// Values are clamped to the readback cap below.
        pub fn set_target_size(&self, width: u32, height: u32) {
            if let Ok(mut target) = self.target.lock() {
                *target = (width, height);
            }
            // Wake the loop so it picks up the new size promptly.
            if let Ok(mut dirty) = self.wake.dirty.lock() {
                *dirty = true;
                self.wake.changed.notify_one();
            }
        }
    }

    /// Readback render size cap. 1280x720 keeps full-frame IPC + canvas
    /// upload (~3.7MB) fast enough for 24fps; the canvas upscales to the
    /// window on the GPU for free. 1080p frames (~8.3MB) capped the
    /// frontend at ~11fps on this path.
    const READBACK_MAX_W: i32 = 1280;
    const READBACK_MAX_H: i32 = 720;

    /// Effective render size: frontend target when smaller than the window
    /// (e.g. small player area), otherwise the cap above.
    fn clamp_size(window: (i32, i32), target: (u32, u32)) -> (u32, u32) {
        let w = window.0.min(target.0 as i32).clamp(16, READBACK_MAX_W) as u32;
        let h = window.1.min(target.1 as i32).clamp(16, READBACK_MAX_H) as u32;
        (w, h)
    }

    fn run_render_loop(
        handle: *mut mpv_handle,
        api: Arc<MpvApi>,
        surface: Arc<GpuVideoSurface>,
        stop: Arc<AtomicBool>,
        wake: Arc<RenderWake>,
        frames: Arc<Mutex<RenderFrame>>,
        target: Arc<Mutex<(u32, u32)>>,
        ready: std::sync::mpsc::Sender<Result<(), String>>,
    ) -> Result<(), String> {
        crate::mpv::platform::windows::diagnostic_log("mpv-wgl-render thread started");
        let gl_ctx = match surface.create_gl_context().and_then(|gl| {
            gl.make_current()?;
            Ok(gl)
        }) {
            Ok(gl) => {
                crate::mpv::platform::windows::diagnostic_log("WGL context current");
                gl
            }
            Err(error) => {
                crate::mpv::platform::windows::diagnostic_log(format!(
                    "WGL context failed: {error}"
                ));
                let _ = ready.send(Err(error.clone()));
                return Err(error);
            }
        };
        // Resolve the GL functions used for the FBO + readback path. Needs
        // the current context (wglGetProcAddress for >1.1 entry points).
        let gl = match load_wgl_gl() {
            Ok(gl) => gl,
            Err(error) => {
                crate::mpv::platform::windows::diagnostic_log(format!(
                    "GL load failed: {error}"
                ));
                let _ = ready.send(Err(error.clone()));
                return Err(error);
            }
        };
        unsafe {
            (gl.gl_pixel_store_i)(GL_PACK_ALIGNMENT, 4);
        }
        let mut init = mpv_opengl_init_params {
            get_proc_address: Some(get_proc_address),
            get_proc_address_ctx: std::ptr::null_mut(),
        };
        let mut api_name = b"opengl\0".to_vec();
        let mut context: *mut mpv_render_context = std::ptr::null_mut();
        let mut params = [
            mpv_render_param {
                type_: MPV_RENDER_PARAM_API_TYPE,
                data: api_name.as_mut_ptr().cast(),
            },
            mpv_render_param {
                type_: MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,
                data: (&mut init as *mut mpv_opengl_init_params).cast(),
            },
            mpv_render_param {
                type_: MPV_RENDER_PARAM_INVALID,
                data: std::ptr::null_mut(),
            },
        ];
        let result =
            unsafe { (api.mpv_render_context_create)(&mut context, handle, params.as_mut_ptr()) };
        if result < 0 || context.is_null() {
            let error = format!("mpv_render_context_create failed with code {result}");
            crate::mpv::platform::windows::diagnostic_log(error.clone());
            let _ = ready.send(Err(error.clone()));
            return Err(error);
        }
        crate::mpv::platform::windows::diagnostic_log("mpv_render_context_create ok");
        // Offscreen FBO + texture for the CPU readback path (same approach
        // as Linux): the native window only hosts the GL context, frames go
        // to the frontend canvas, so nothing depends on Win32 composition.
        // Created BEFORE signalling ready: a dead render thread with a live
        // player instance would mean a permanently black canvas.
        let initial_target = target.lock().map(|t| *t).unwrap_or((1280, 720));
        let (init_w, init_h) = clamp_size(surface.size(), initial_target);
        let (fbo_id, tex_id) = match create_fbo(&gl, init_w, init_h) {
            Ok(ids) => ids,
            Err(error) => {
                crate::mpv::platform::windows::diagnostic_log(format!(
                    "FBO create failed: {error}"
                ));
                unsafe {
                    (api.mpv_render_context_set_update_callback)(
                        context,
                        None,
                        std::ptr::null_mut(),
                    );
                    (api.mpv_render_context_free)(context);
                }
                let _ = ready.send(Err(error.clone()));
                return Err(error);
            }
        };
        crate::mpv::platform::windows::diagnostic_log(format!(
            "FBO created {init_w}x{init_h}"
        ));
        unsafe {
            (api.mpv_render_context_set_update_callback)(
                context,
                Some(request_redraw),
                Arc::as_ptr(&wake).cast_mut().cast(),
            );
        }
        let _ = ready.send(Ok(()));
        let mut current_size = (init_w, init_h);

        let render_result = (|| -> Result<(), String> {
            // Reusable pixel buffer (reallocated on resize).
            let mut pixels: Vec<u8> = Vec::new();
            let mut stored: u64 = 0;
            // Double-buffered PBOs for async readback (mirrors Linux): the
            // current frame DMAs into PBO[next] while the previous one is
            // mapped from PBO[next^1] without stalling the GL pipeline.
            let pbo = load_pbo_gl();
            let mut pbo_ids = [0u32; 2];
            let mut pbo_ready = false;
            let mut ready_dims = (0u32, 0u32);
            let mut pbo_next = 0usize;
            if let Some(ref pg) = pbo {
                unsafe {
                    (pg.gl_gen_buffers)(2, pbo_ids.as_mut_ptr());
                }
                crate::mpv::platform::windows::diagnostic_log("PBO async readback activo");
            } else {
                crate::mpv::platform::windows::diagnostic_log(
                    "PBO no disponible; readback sincrono",
                );
            }
            // Backend pacing stats (render + readback-issue cost per frame).
            let mut cost_accum = std::time::Duration::ZERO;
            let mut cost_count: u64 = 0;
            while !stop.load(Ordering::Acquire) {
                let mut dirty = wake.dirty.lock().map_err(|error| error.to_string())?;
                if !*dirty {
                    let (guard, _) = wake
                        .changed
                        .wait_timeout(dirty, std::time::Duration::from_millis(100))
                        .map_err(|error| error.to_string())?;
                    dirty = guard;
                }
                let wanted = target.lock().map(|t| *t).unwrap_or((1280, 720));
                let size = clamp_size(surface.size(), wanted);
                if !*dirty && size == current_size {
                    continue;
                }
                *dirty = false;
                drop(dirty);

                if size != current_size {
                    resize_fbo(&gl, tex_id, fbo_id, size.0, size.1);
                    current_size = size;
                    crate::mpv::platform::windows::diagnostic_log(format!(
                        "FBO resized {}x{}",
                        size.0, size.1
                    ));
                }

                // A transient make_current failure (e.g. window being
                // resized/destroyed) must not kill the thread permanently:
                // skip this frame and retry on the next wake.
                if let Err(error) = gl_ctx.make_current() {
                    crate::mpv::platform::windows::diagnostic_log(format!(
                        "make_current transient failure, skipping frame: {error}"
                    ));
                    continue;
                }
                unsafe {
                    (gl.gl_bind_framebuffer)(GL_FRAMEBUFFER, fbo_id);
                }
                let target = MpvOpenglFbo {
                    fbo: fbo_id as i32,
                    w: size.0 as i32,
                    h: size.1 as i32,
                    internal_format: 0,
                };
                let mut params = [
                    mpv_render_param {
                        type_: MPV_RENDER_PARAM_OPENGL_FBO,
                        data: (&target as *const MpvOpenglFbo).cast_mut().cast(),
                    },
                    mpv_render_param {
                        type_: MPV_RENDER_PARAM_INVALID,
                        data: std::ptr::null_mut(),
                    },
                ];
                let result =
                    unsafe { (api.mpv_render_context_render)(context, params.as_mut_ptr()) };
                let gl_err = unsafe { (gl.gl_get_error)() };
                if gl_err != 0 {
                    crate::mpv::platform::windows::diagnostic_log(format!(
                        "GL error tras mpv_render: 0x{gl_err:x}"
                    ));
                }
                if result >= 0 {
                    let frame_start = std::time::Instant::now();
                    // mpv may leave another framebuffer bound — re-bind ours.
                    unsafe {
                        (gl.gl_bind_framebuffer)(GL_FRAMEBUFFER, fbo_id);
                    }
                    if let Some(ref pg) = pbo {
                        // 1. Finalize the PREVIOUS async readback (it had a
                        // full frame interval to complete — no stall).
                        if pbo_ready {
                            unsafe {
                                (pg.gl_bind_buffer)(GL_PIXEL_PACK_BUFFER, pbo_ids[pbo_next ^ 1]);
                            }
                            let mapped = unsafe {
                                (pg.gl_map_buffer_range)(
                                    GL_PIXEL_PACK_BUFFER,
                                    0,
                                    (ready_dims.0 * ready_dims.1 * 4) as isize,
                                    GL_MAP_READ_BIT,
                                )
                            };
                            if !mapped.is_null() {
                                let buf_size = (ready_dims.0 * ready_dims.1 * 4) as usize;
                                let mut fresh = vec![0u8; buf_size];
                                unsafe {
                                    std::ptr::copy_nonoverlapping(
                                        mapped as *const u8,
                                        fresh.as_mut_ptr(),
                                        buf_size,
                                    );
                                    (pg.gl_unmap_buffer)(GL_PIXEL_PACK_BUFFER);
                                }
                                stored = stored.wrapping_add(1);
                                if let Ok(mut fb) = frames.lock() {
                                    fb.width = ready_dims.0;
                                    fb.height = ready_dims.1;
                                    fb.counter = stored;
                                    fb.pixels = fresh;
                                }
                            }
                            unsafe {
                                (pg.gl_bind_buffer)(GL_PIXEL_PACK_BUFFER, 0);
                            }
                        }
                        // 2. Issue async readback of the CURRENT frame.
                        let buf_size = (size.0 * size.1 * 4) as isize;
                        unsafe {
                            (pg.gl_bind_buffer)(GL_PIXEL_PACK_BUFFER, pbo_ids[pbo_next]);
                            (pg.gl_buffer_data)(
                                GL_PIXEL_PACK_BUFFER,
                                buf_size,
                                std::ptr::null(),
                                GL_STREAM_READ,
                            );
                            (gl.gl_read_pixels)(
                                0,
                                0,
                                size.0 as GLsizei,
                                size.1 as GLsizei,
                                GL_RGBA,
                                GL_UNSIGNED_BYTE,
                                std::ptr::null_mut(),
                            );
                            (pg.gl_bind_buffer)(GL_PIXEL_PACK_BUFFER, 0);
                            (gl.gl_bind_framebuffer)(GL_FRAMEBUFFER, 0);
                        }
                        ready_dims = size;
                        pbo_ready = true;
                        pbo_next ^= 1;
                    } else {
                        // Synchronous readback (fallback).
                        unsafe {
                            let needed = (size.0 * size.1 * 4) as usize;
                            if pixels.len() != needed {
                                pixels.resize(needed, 0);
                            }
                            (gl.gl_read_pixels)(
                                0,
                                0,
                                size.0 as GLsizei,
                                size.1 as GLsizei,
                                GL_RGBA,
                                GL_UNSIGNED_BYTE,
                                pixels.as_mut_ptr().cast(),
                            );
                            (gl.gl_bind_framebuffer)(GL_FRAMEBUFFER, 0);
                        }
                        stored = stored.wrapping_add(1);
                        if let Ok(mut fb) = frames.lock() {
                            fb.width = size.0;
                            fb.height = size.1;
                            fb.counter = stored;
                            fb.pixels.clear();
                            fb.pixels.extend_from_slice(&pixels);
                        }
                    }
                    unsafe { (api.mpv_render_context_report_swap)(context) };
                    cost_accum += frame_start.elapsed();
                    cost_count += 1;
                    if stored == 1 || stored % 300 == 0 {
                        let avg_ms = if cost_count > 0 {
                            cost_accum.as_secs_f64() * 1000.0 / cost_count as f64
                        } else {
                            0.0
                        };
                        crate::mpv::platform::windows::diagnostic_log(format!(
                            "readback {stored} frames ({}x{}) pbo={} issue_avg={:.1}ms",
                            size.0,
                            size.1,
                            pbo.is_some(),
                            avg_ms
                        ));
                        cost_accum = std::time::Duration::ZERO;
                        cost_count = 0;
                    }
                } else {
                    crate::mpv::platform::windows::diagnostic_log(format!(
                        "mpv_render failed: {result}"
                    ));
                }
            }
            if let Some(ref pg) = pbo {
                unsafe {
                    (pg.gl_delete_buffers)(2, pbo_ids.as_ptr());
                }
            }
            Ok(())
        })();

        unsafe {
            (api.mpv_render_context_set_update_callback)(context, None, std::ptr::null_mut());
            (api.mpv_render_context_free)(context);
            (gl.gl_delete_framebuffers)(1, &fbo_id);
            (gl.gl_delete_textures)(1, &tex_id);
        }
        render_result
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    pub struct Renderer;
    impl Renderer {
        pub fn start(
            _app: tauri::AppHandle,
            _handle: *mut mpv_handle,
            _api: Arc<MpvApi>,
            _surface: Arc<GpuVideoSurface>,
        ) -> Result<Self, String> {
            Err("macOS GPU renderer is not implemented".to_string())
        }
        pub fn stop(&mut self) {}
    }
}
