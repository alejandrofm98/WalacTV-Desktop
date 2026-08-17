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

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use crate::mpv::ffi::{
        mpv_opengl_init_params, mpv_render_context, mpv_render_param, MPV_RENDER_PARAM_API_TYPE,
        MPV_RENDER_PARAM_FLIP_Y, MPV_RENDER_PARAM_INVALID, MPV_RENDER_PARAM_OPENGL_FBO,
        MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,
    };
    use std::ffi::{c_char, c_void};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Condvar, Mutex};

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

    pub struct Renderer {
        stop: Arc<AtomicBool>,
        wake: Arc<RenderWake>,
        thread: Option<std::thread::JoinHandle<()>>,
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
            let stop_for_thread = Arc::clone(&stop);
            let wake_for_thread = Arc::clone(&wake);
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
                        ready_tx,
                    );
                    if let Err(error) = result {
                        log::error!("Windows GPU renderer stopped: {error}");
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
            })
        }

        pub fn stop(&mut self) {
            self.stop.store(true, Ordering::Release);
            self.wake.changed.notify_one();
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn run_render_loop(
        handle: *mut mpv_handle,
        api: Arc<MpvApi>,
        surface: Arc<GpuVideoSurface>,
        stop: Arc<AtomicBool>,
        wake: Arc<RenderWake>,
        ready: std::sync::mpsc::Sender<Result<(), String>>,
    ) -> Result<(), String> {
        let gl = match surface.create_gl_context().and_then(|gl| {
            gl.make_current()?;
            Ok(gl)
        }) {
            Ok(gl) => gl,
            Err(error) => {
                let _ = ready.send(Err(error.clone()));
                return Err(error);
            }
        };
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
            let _ = ready.send(Err(error.clone()));
            return Err(error);
        }
        unsafe {
            (api.mpv_render_context_set_update_callback)(
                context,
                Some(request_redraw),
                Arc::as_ptr(&wake).cast_mut().cast(),
            );
        }
        let _ = ready.send(Ok(()));

        let render_result = (|| -> Result<(), String> {
            let mut previous_size = (0, 0);
            while !stop.load(Ordering::Acquire) {
                let mut dirty = wake.dirty.lock().map_err(|error| error.to_string())?;
                if !*dirty {
                    let (guard, _) = wake
                        .changed
                        .wait_timeout(dirty, std::time::Duration::from_millis(100))
                        .map_err(|error| error.to_string())?;
                    dirty = guard;
                }
                let size = surface.size();
                if !*dirty && size == previous_size {
                    continue;
                }
                *dirty = false;
                drop(dirty);
                previous_size = size;

                gl.make_current()?;
                let mut target = MpvOpenglFbo {
                    fbo: 0,
                    w: size.0,
                    h: size.1,
                    internal_format: 0,
                };
                let mut flip_y = 1i32;
                let mut params = [
                    mpv_render_param {
                        type_: MPV_RENDER_PARAM_OPENGL_FBO,
                        data: (&mut target as *mut MpvOpenglFbo).cast(),
                    },
                    mpv_render_param {
                        type_: MPV_RENDER_PARAM_FLIP_Y,
                        data: (&mut flip_y as *mut i32).cast(),
                    },
                    mpv_render_param {
                        type_: MPV_RENDER_PARAM_INVALID,
                        data: std::ptr::null_mut(),
                    },
                ];
                let result =
                    unsafe { (api.mpv_render_context_render)(context, params.as_mut_ptr()) };
                if result >= 0 {
                    gl.swap_buffers();
                    unsafe { (api.mpv_render_context_report_swap)(context) };
                }
            }
            Ok(())
        })();

        unsafe {
            (api.mpv_render_context_set_update_callback)(context, None, std::ptr::null_mut());
            (api.mpv_render_context_free)(context);
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
