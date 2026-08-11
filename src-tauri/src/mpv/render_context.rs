//! Offscreen render context for mpv using EGL + OpenGL offscreen rendering.
//!
//! Works on both X11 and Wayland via EGL pbuffer surfaces. The display
//! pointer is obtained from the platform layer (wl_display on Wayland,
//! null/EGL_DEFAULT_DISPLAY on X11), and EGL creates an offscreen pbuffer
//! context for mpv_render_context to render into.
//!
//! ## Render path
//! 1. Load EGL dynamically (libEGL.so)
//! 2. Create EGL display (Wayland/X11 platform or legacy), pbuffer surface, context
//! 3. Create `mpv_render_context` with OpenGL API
//! 4. Create FBO + texture, render loop reads back via glReadPixels
//! 5. Frame buffer exposed to frontend as raw binary via command
//!
//! ## Frame delivery (CPU readback - Option D)
//! After each render call pixels are read from FBO into a Vec<u8>.
//! The frontend calls `mpv_get_render_frame` to get the latest frame.
//!
//! ## Performance
//! glReadPixels is synchronous; for 1080p60 RGBA: ~8MB/frame.
//! Acceptable for SD/HD but not 4K. TODO: zero-copy via shared texture.

#![cfg(target_os = "linux")]

use crate::mpv::ffi::{
    mpv_format, mpv_handle, mpv_opengl_init_params, mpv_render_context, mpv_render_param, MpvApi,
    MPV_RENDER_PARAM_API_TYPE, MPV_RENDER_PARAM_INVALID, MPV_RENDER_PARAM_OPENGL_FBO,
    MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,
};
use libloading::Library;
use std::ffi::{c_char, c_void, CString};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{JoinHandle, Thread};
use std::time::Duration;

// ---------------------------------------------------------------------------
// GL types & constants
// ---------------------------------------------------------------------------

type GLuint = u32;
type GLint = i32;
type GLsizei = i32;
type GLenum = u32;
type GLfloat = f32;

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
const GL_COLOR_BUFFER_BIT: GLenum = 0x4000;

// ---------------------------------------------------------------------------
// MPV OpenGL FBO parameter struct
// ---------------------------------------------------------------------------

/// Matches mpv_opengl_fbo: mpv expects a pointer to this 16-byte struct
/// (not a bare i32), otherwise it reads garbage for w/h.
#[repr(C)]
struct MpvOpenglFbo {
    fbo: i32,
    w: i32,
    h: i32,
    internal_format: i32,
}

// ---------------------------------------------------------------------------
// EGL types & constants
// ---------------------------------------------------------------------------

type EGLint = i32;
type EGLBoolean = i32;

const EGL_NO_DISPLAY: *mut c_void = std::ptr::null_mut();
const EGL_NO_CONTEXT: *mut c_void = std::ptr::null_mut();
const EGL_NO_SURFACE: *mut c_void = std::ptr::null_mut();

const EGL_OPENGL_API: EGLint = 0x30A2;
const EGL_OPENGL_ES_API: EGLint = 0x30A0;
const EGL_ALPHA_SIZE: EGLint = 0x3021;
const EGL_PLATFORM_WAYLAND_EXT: EGLenum = 0x31D8;
const EGL_PLATFORM_X11_EXT: EGLenum = 0x31D5;
const EGL_PLATFORM_SURFACELESS_MESA: EGLenum = 0x31DD;
const EGL_BLUE_SIZE: EGLint = 0x3022;
const EGL_GREEN_SIZE: EGLint = 0x3023;
const EGL_RED_SIZE: EGLint = 0x3024;
const EGL_RENDERABLE_TYPE: EGLint = 0x3040;
const EGL_OPENGL_BIT: EGLint = 0x0020;
const EGL_SURFACE_TYPE: EGLint = 0x3033;
const EGL_PBUFFER_BIT: EGLint = 0x0001;
const EGL_NONE: EGLint = 0x3038;
const EGL_WIDTH: EGLint = 0x3057;
const EGL_HEIGHT: EGLint = 0x3056;
const EGL_CONTEXT_MAJOR_VERSION: EGLint = 0x3098;
const EGL_CONTEXT_MINOR_VERSION: EGLint = 0x30FB;
const EGL_CONTEXT_OPENGL_PROFILE_MASK: EGLint = 0x30FD;
const EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT: EGLint = 0x00000001;
const EGL_CONTEXT_CLIENT_VERSION: EGLint = 0x3098;
const EGL_OPENGL_ES2_BIT: EGLint = 0x0004;
const EGL_OPENGL_ES3_BIT_KHR: EGLint = 0x0040;

// ---------------------------------------------------------------------------
// Global get_proc_address callback for mpv_render_context
// ---------------------------------------------------------------------------

static EGL_GET_PROC_ADDR: std::sync::OnceLock<unsafe extern "C" fn(*const c_char) -> *mut c_void> =
    std::sync::OnceLock::new();

/// `get_proc_address` callback passed to mpv via mpv_opengl_init_params.
/// mpv calls this to resolve OpenGL function pointers at runtime.
pub(crate) unsafe extern "C" fn mpv_get_proc_address(
    _ctx: *mut c_void,
    name: *const c_char,
) -> *mut c_void {
    if let Some(func) = EGL_GET_PROC_ADDR.get() {
        unsafe { func(name) }
    } else {
        std::ptr::null_mut()
    }
}

// ---------------------------------------------------------------------------
// EGL API — dynamically loaded from libEGL.so (once, cached globally)
// ---------------------------------------------------------------------------

struct EglApi {
    _lib: Library,
    egl_get_display: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
    egl_get_platform_display:
        unsafe extern "C" fn(EGLenum, *mut c_void, *const EGLint) -> *mut c_void,
    has_platform_display: bool,
    egl_initialize: unsafe extern "C" fn(*mut c_void, *mut EGLint, *mut EGLint) -> EGLBoolean,
    egl_bind_api: unsafe extern "C" fn(EGLint) -> EGLBoolean,
    egl_choose_config: unsafe extern "C" fn(
        *mut c_void,
        *const EGLint,
        *mut *mut c_void,
        EGLint,
        *mut EGLint,
    ) -> EGLBoolean,
    egl_create_context:
        unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *const EGLint) -> *mut c_void,
    egl_create_pbuffer_surface:
        unsafe extern "C" fn(*mut c_void, *mut c_void, *const EGLint) -> *mut c_void,
    egl_destroy_surface: unsafe extern "C" fn(*mut c_void, *mut c_void) -> EGLBoolean,
    egl_make_current:
        unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *mut c_void) -> EGLBoolean,
    egl_destroy_context: unsafe extern "C" fn(*mut c_void, *mut c_void) -> EGLBoolean,
    egl_terminate: unsafe extern "C" fn(*mut c_void) -> EGLBoolean,
    egl_get_proc_address: unsafe extern "C" fn(*const c_char) -> *mut c_void,
    egl_get_error: unsafe extern "C" fn() -> EGLint,
}

type EGLenum = u32;

unsafe extern "C" fn egl_get_platform_display_stub(
    _platform: EGLenum,
    _native_display: *mut c_void,
    _attrib_list: *const EGLint,
) -> *mut c_void {
    EGL_NO_DISPLAY
}

// Safety: all function pointers are plain addresses, Library is Send.
unsafe impl Send for EglApi {}
unsafe impl Sync for EglApi {}

static EGL_API: Mutex<Option<&'static EglApi>> = Mutex::new(None);

/// Load EGL functions (once) and return a static reference.
fn load_egl() -> Result<&'static EglApi, String> {
    let mut guard = EGL_API.lock().unwrap();
    if let Some(api) = *guard {
        return Ok(api);
    }
    #[allow(non_snake_case)]
    let api = unsafe {
        let lib = Library::new("libEGL.so.1")
            .or_else(|_| Library::new("libEGL.so"))
            .map_err(|e| format!("No se pudo cargar libEGL.so: {e}"))?;

        macro_rules! sym {
            ($name:ident, $sig:ty) => {
                #[allow(non_snake_case)]
                let $name: $sig = *lib
                    .get(concat!(stringify!($name), "\0").as_bytes())
                    .map_err(|e| format!("EGL symbol {}: {e}", stringify!($name)))?;
            };
        }

        sym!(
            eglGetDisplay,
            unsafe extern "C" fn(*mut c_void) -> *mut c_void
        );
        let (eglGetPlatformDisplay, has_platform_display) = {
            let platform_fn = lib
                .get::<unsafe extern "C" fn(EGLenum, *mut c_void, *const EGLint) -> *mut c_void>(b"eglGetPlatformDisplayEXT\0")
                .or_else(|_| lib.get::<unsafe extern "C" fn(EGLenum, *mut c_void, *const EGLint) -> *mut c_void>(b"eglGetPlatformDisplay\0"));
            match platform_fn {
                Ok(s) => (*s, true),
                Err(_) => (
                    egl_get_platform_display_stub
                        as unsafe extern "C" fn(EGLenum, *mut c_void, *const EGLint) -> *mut c_void,
                    false,
                ),
            }
        };
        sym!(
            eglInitialize,
            unsafe extern "C" fn(*mut c_void, *mut EGLint, *mut EGLint) -> EGLBoolean
        );
        sym!(eglBindAPI, unsafe extern "C" fn(EGLint) -> EGLBoolean);
        sym!(
            eglChooseConfig,
            unsafe extern "C" fn(
                *mut c_void,
                *const EGLint,
                *mut *mut c_void,
                EGLint,
                *mut EGLint,
            ) -> EGLBoolean
        );
        sym!(
            eglCreateContext,
            unsafe extern "C" fn(
                *mut c_void,
                *mut c_void,
                *mut c_void,
                *const EGLint,
            ) -> *mut c_void
        );
        sym!(
            eglCreatePbufferSurface,
            unsafe extern "C" fn(*mut c_void, *mut c_void, *const EGLint) -> *mut c_void
        );
        sym!(
            eglDestroySurface,
            unsafe extern "C" fn(*mut c_void, *mut c_void) -> EGLBoolean
        );
        sym!(
            eglMakeCurrent,
            unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *mut c_void) -> EGLBoolean
        );
        sym!(
            eglDestroyContext,
            unsafe extern "C" fn(*mut c_void, *mut c_void) -> EGLBoolean
        );
        sym!(
            eglTerminate,
            unsafe extern "C" fn(*mut c_void) -> EGLBoolean
        );
        sym!(
            eglGetProcAddress,
            unsafe extern "C" fn(*const c_char) -> *mut c_void
        );
        sym!(eglGetError, unsafe extern "C" fn() -> EGLint);

        let _ = EGL_GET_PROC_ADDR.set(eglGetProcAddress);

        Ok(EglApi {
            _lib: lib,
            egl_get_display: eglGetDisplay,
            egl_get_platform_display: eglGetPlatformDisplay,
            has_platform_display,
            egl_initialize: eglInitialize,
            egl_bind_api: eglBindAPI,
            egl_choose_config: eglChooseConfig,
            egl_create_context: eglCreateContext,
            egl_create_pbuffer_surface: eglCreatePbufferSurface,
            egl_destroy_surface: eglDestroySurface,
            egl_make_current: eglMakeCurrent,
            egl_destroy_context: eglDestroyContext,
            egl_terminate: eglTerminate,
            egl_get_proc_address: eglGetProcAddress,
            egl_get_error: eglGetError,
        })
    };
    match api {
        Ok(api) => {
            // Leak into static memory — lives for program duration
            let leaked: &'static EglApi = Box::leak(Box::new(api));
            *guard = Some(leaked);
            Ok(leaked)
        }
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// EGL context lifecycle
// ---------------------------------------------------------------------------

struct EglContext {
    display: *mut c_void,
    surface: *mut c_void,
    context: *mut c_void,
}

struct CreatedEglContext {
    egl: EglContext,
    api_type: &'static str,
}
// Safety: EGL contexts are thread-safe; we only use them on one thread at a time.
unsafe impl Send for EglContext {}

fn create_egl_context(display_ptr: *mut c_void) -> Result<CreatedEglContext, String> {
    let api = load_egl()?;

    // Try platform display, then legacy get_display.
    // On Wayland (display_ptr = wl_display*): try EGL_PLATFORM_WAYLAND_EXT.
    // On X11 (display_ptr = null): pbuffer works with EGL_DEFAULT_DISPLAY.
    // On X11 (display_ptr = Display*): try EGL_PLATFORM_X11_EXT.
    let egl_display = unsafe {
        // Determine the best display handle to pass to eglGetDisplay
        let native_display = if display_ptr.is_null() {
            std::ptr::null_mut()
        } else {
            display_ptr
        };

        // Try platform-specific EGL extensions
        let platform_display = if api.has_platform_display {
            if display_ptr.is_null() {
                // No native display — try surfaceless (Mesa) first.
                // Under XWayland, eglGetDisplay(NULL) picks a Wayland-platform
                // EGL display whose config list is unusable. Surfaceless avoids that.
                let s = (api.egl_get_platform_display)(
                    EGL_PLATFORM_SURFACELESS_MESA,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                );
                if !s.is_null() && s != EGL_NO_DISPLAY {
                    eprintln!("render_context: surfaceless platform display seleccionado");
                    s
                } else {
                    // Surfaceless not available, fall through to legacy
                    EGL_NO_DISPLAY
                }
            } else {
                // Has native display — try Wayland first, then X11
                let w = (api.egl_get_platform_display)(
                    EGL_PLATFORM_WAYLAND_EXT,
                    display_ptr,
                    std::ptr::null(),
                );
                if !w.is_null() && w != EGL_NO_DISPLAY {
                    w
                } else {
                    let x = (api.egl_get_platform_display)(
                        EGL_PLATFORM_X11_EXT,
                        display_ptr,
                        std::ptr::null(),
                    );
                    if !x.is_null() && x != EGL_NO_DISPLAY {
                        x
                    } else {
                        EGL_NO_DISPLAY
                    }
                }
            }
        } else {
            EGL_NO_DISPLAY
        };

        if !platform_display.is_null() && platform_display != EGL_NO_DISPLAY {
            platform_display
        } else {
            (api.egl_get_display)(native_display)
        }
    };
    if egl_display.is_null() || egl_display == EGL_NO_DISPLAY {
        let egl_err = unsafe { (api.egl_get_error)() };
        eprintln!("EGL display fallo: 0x{egl_err:x}");
        return Err(format!("eglGetDisplay/eglGetPlatformDisplay fallo: no EGL display disponible (EGL error 0x{egl_err:x})"));
    }

    let mut major: EGLint = 0;
    let mut minor: EGLint = 0;
    if unsafe { (api.egl_initialize)(egl_display, &mut major, &mut minor) } == 0 {
        let egl_err = unsafe { (api.egl_get_error)() };
        eprintln!("EGL initialize fallo: 0x{egl_err:x}");
        return Err(format!("eglInitialize fallo (EGL error 0x{egl_err:x})"));
    }
    log::info!("EGL inicializado: {}.{}", major, minor);

    // Try OpenGL ES 3.0 first, then ES 2.0, then OpenGL desktop.
    // Most Wayland compositors / drivers expose GLES via pbuffer more reliably
    // than desktop OpenGL core without a real window.
    if let Ok(ctx) = try_create_es_context(api, egl_display, 3) {
        return Ok(CreatedEglContext {
            egl: ctx,
            api_type: "opengl",
        });
    }
    log::warn!("OpenGL ES 3.0 no disponible, intentando ES 2.0");

    if let Ok(ctx) = try_create_es_context(api, egl_display, 2) {
        return Ok(CreatedEglContext {
            egl: ctx,
            api_type: "opengl",
        });
    }
    log::warn!("OpenGL ES 2.0 no disponible, intentando OpenGL desktop");

    if let Ok(ctx) = try_create_desktop_gl_context(api, egl_display) {
        return Ok(CreatedEglContext {
            egl: ctx,
            api_type: "opengl",
        });
    }

    unsafe {
        (api.egl_terminate)(egl_display);
    }
    Err("No se pudo crear ningun contexto EGL (ES3, ES2, ni OpenGL desktop)".to_string())
}

fn try_create_es_context(
    api: &EglApi,
    egl_display: *mut c_void,
    version: EGLint,
) -> Result<EglContext, String> {
    let renderable_bit = if version >= 3 {
        EGL_OPENGL_ES3_BIT_KHR
    } else {
        EGL_OPENGL_ES2_BIT
    };

    if unsafe { (api.egl_bind_api)(EGL_OPENGL_ES_API) } == 0 {
        let egl_err = unsafe { (api.egl_get_error)() };
        eprintln!("EGL bind API ES{} fallo: 0x{egl_err:x}", version);
        return Err(format!(
            "eglBindAPI(EGL_OPENGL_ES_API) fallo (EGL error 0x{egl_err:x})"
        ));
    }

    let config_attribs: &[EGLint] = &[
        EGL_RED_SIZE,
        8,
        EGL_GREEN_SIZE,
        8,
        EGL_BLUE_SIZE,
        8,
        EGL_ALPHA_SIZE,
        8,
        EGL_RENDERABLE_TYPE,
        renderable_bit,
        EGL_SURFACE_TYPE,
        EGL_PBUFFER_BIT,
        EGL_NONE,
    ];
    let mut egl_config: *mut c_void = std::ptr::null_mut();
    let mut num_configs: EGLint = 0;
    let ok = unsafe {
        (api.egl_choose_config)(
            egl_display,
            config_attribs.as_ptr(),
            &mut egl_config,
            1,
            &mut num_configs,
        )
    };
    if ok == 0 || num_configs == 0 {
        // Retry with relaxed attributes (drop ALPHA_SIZE — some Mesa drivers
        // don't expose RGBA8 pbuffer configs under surfaceless/Wayland).
        let relaxed_attribs: &[EGLint] = &[
            EGL_RED_SIZE,
            8,
            EGL_GREEN_SIZE,
            8,
            EGL_BLUE_SIZE,
            8,
            EGL_RENDERABLE_TYPE,
            renderable_bit,
            EGL_SURFACE_TYPE,
            EGL_PBUFFER_BIT,
            EGL_NONE,
        ];
        let ok = unsafe {
            (api.egl_choose_config)(
                egl_display,
                relaxed_attribs.as_ptr(),
                &mut egl_config,
                1,
                &mut num_configs,
            )
        };
        if ok == 0 || num_configs == 0 {
            let egl_err = unsafe { (api.egl_get_error)() };
            eprintln!(
                "EGL choose config ES{} fallo (relaxed tambien): 0x{egl_err:x}",
                version
            );
            return Err(format!(
                "eglChooseConfig ES{}: no config compatible (EGL error 0x{egl_err:x})",
                version
            ));
        }
        log::info!(
            "EGL ES{} config obtenido con atributos relajados (sin ALPHA_SIZE)",
            version
        );
    }

    let pbuffer_attribs: &[EGLint] = &[EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE];
    let pbuffer_surface = unsafe {
        (api.egl_create_pbuffer_surface)(egl_display, egl_config, pbuffer_attribs.as_ptr())
    };
    if pbuffer_surface.is_null() || pbuffer_surface == EGL_NO_SURFACE {
        let egl_err = unsafe { (api.egl_get_error)() };
        eprintln!("EGL pbuffer surface ES{} fallo: 0x{egl_err:x}", version);
        return Err(format!(
            "eglCreatePbufferSurface ES{} fallo (EGL error 0x{egl_err:x})",
            version
        ));
    }

    let context_attribs: &[EGLint] = &[EGL_CONTEXT_CLIENT_VERSION, version, EGL_NONE];
    let egl_context = unsafe {
        (api.egl_create_context)(
            egl_display,
            egl_config,
            EGL_NO_CONTEXT,
            context_attribs.as_ptr(),
        )
    };
    if egl_context.is_null() || egl_context == EGL_NO_CONTEXT {
        let egl_err = unsafe { (api.egl_get_error)() };
        eprintln!("EGL ES{} context fallo: 0x{egl_err:x}", version);
        unsafe {
            (api.egl_destroy_surface)(egl_display, pbuffer_surface);
        }
        return Err(format!(
            "eglCreateContext ES{} fallo (EGL error 0x{egl_err:x})",
            version
        ));
    }

    log::info!("EGL context: OpenGL ES {}.0", version);
    Ok(EglContext {
        display: egl_display,
        surface: pbuffer_surface,
        context: egl_context,
    })
}

fn try_create_desktop_gl_context(
    api: &EglApi,
    egl_display: *mut c_void,
) -> Result<EglContext, String> {
    if unsafe { (api.egl_bind_api)(EGL_OPENGL_API) } == 0 {
        let egl_err = unsafe { (api.egl_get_error)() };
        eprintln!("EGL bind API OpenGL fallo: 0x{egl_err:x}");
        return Err(format!(
            "eglBindAPI(EGL_OPENGL_API) fallo (EGL error 0x{egl_err:x})"
        ));
    }

    let config_attribs: &[EGLint] = &[
        EGL_RED_SIZE,
        8,
        EGL_GREEN_SIZE,
        8,
        EGL_BLUE_SIZE,
        8,
        EGL_ALPHA_SIZE,
        8,
        EGL_RENDERABLE_TYPE,
        EGL_OPENGL_BIT,
        EGL_SURFACE_TYPE,
        EGL_PBUFFER_BIT,
        EGL_NONE,
    ];
    let mut egl_config: *mut c_void = std::ptr::null_mut();
    let mut num_configs: EGLint = 0;
    let ok = unsafe {
        (api.egl_choose_config)(
            egl_display,
            config_attribs.as_ptr(),
            &mut egl_config,
            1,
            &mut num_configs,
        )
    };
    if ok == 0 || num_configs == 0 {
        // Retry with relaxed attributes (drop ALPHA_SIZE).
        let relaxed_attribs: &[EGLint] = &[
            EGL_RED_SIZE,
            8,
            EGL_GREEN_SIZE,
            8,
            EGL_BLUE_SIZE,
            8,
            EGL_RENDERABLE_TYPE,
            EGL_OPENGL_BIT,
            EGL_SURFACE_TYPE,
            EGL_PBUFFER_BIT,
            EGL_NONE,
        ];
        let ok = unsafe {
            (api.egl_choose_config)(
                egl_display,
                relaxed_attribs.as_ptr(),
                &mut egl_config,
                1,
                &mut num_configs,
            )
        };
        if ok == 0 || num_configs == 0 {
            let egl_err = unsafe { (api.egl_get_error)() };
            eprintln!("EGL choose config OpenGL fallo (relaxed tambien): 0x{egl_err:x}");
            return Err(format!(
                "eglChooseConfig OpenGL: no config compatible (EGL error 0x{egl_err:x})"
            ));
        }
        log::info!("EGL OpenGL config obtenido con atributos relajados (sin ALPHA_SIZE)");
    }

    let pbuffer_attribs: &[EGLint] = &[EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE];
    let pbuffer_surface = unsafe {
        (api.egl_create_pbuffer_surface)(egl_display, egl_config, pbuffer_attribs.as_ptr())
    };
    if pbuffer_surface.is_null() || pbuffer_surface == EGL_NO_SURFACE {
        let egl_err = unsafe { (api.egl_get_error)() };
        eprintln!("EGL pbuffer surface OpenGL fallo: 0x{egl_err:x}");
        return Err(format!(
            "eglCreatePbufferSurface OpenGL fallo (EGL error 0x{egl_err:x})"
        ));
    }

    let context_attribs: &[EGLint] = &[
        EGL_CONTEXT_MAJOR_VERSION,
        3,
        EGL_CONTEXT_MINOR_VERSION,
        3,
        EGL_CONTEXT_OPENGL_PROFILE_MASK,
        EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT,
        EGL_NONE,
    ];
    let egl_context = unsafe {
        (api.egl_create_context)(
            egl_display,
            egl_config,
            EGL_NO_CONTEXT,
            context_attribs.as_ptr(),
        )
    };
    let egl_context = if !egl_context.is_null() && egl_context != EGL_NO_CONTEXT {
        log::info!("EGL context: OpenGL 3.3 core profile");
        egl_context
    } else {
        let egl_err = unsafe { (api.egl_get_error)() };
        eprintln!("EGL OpenGL 3.3 core context fallo: 0x{egl_err:x}, intentando 3.0 compatibility");
        let fallback: &[EGLint] = &[
            EGL_CONTEXT_MAJOR_VERSION,
            3,
            EGL_CONTEXT_MINOR_VERSION,
            0,
            EGL_NONE,
        ];
        let ctx = unsafe {
            (api.egl_create_context)(egl_display, egl_config, EGL_NO_CONTEXT, fallback.as_ptr())
        };
        if ctx.is_null() || ctx == EGL_NO_CONTEXT {
            let egl_err2 = unsafe { (api.egl_get_error)() };
            eprintln!("EGL OpenGL 3.0 context fallo: 0x{egl_err2:x}");
            unsafe {
                (api.egl_destroy_surface)(egl_display, pbuffer_surface);
            }
            return Err(format!(
                "eglCreateContext OpenGL fallo (EGL error 0x{egl_err2:x})"
            ));
        }
        log::info!("EGL context: OpenGL 3.0 compatibility");
        ctx
    };

    Ok(EglContext {
        display: egl_display,
        surface: pbuffer_surface,
        context: egl_context,
    })
}

fn destroy_egl_context(ctx: EglContext) {
    let api = match load_egl() {
        Ok(a) => a,
        Err(_) => return,
    };
    unsafe {
        (api.egl_make_current)(ctx.display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
        if !ctx.context.is_null() && ctx.context != EGL_NO_CONTEXT {
            (api.egl_destroy_context)(ctx.display, ctx.context);
        }
        if !ctx.surface.is_null() && ctx.surface != EGL_NO_SURFACE {
            (api.egl_destroy_surface)(ctx.display, ctx.surface);
        }
        (api.egl_terminate)(ctx.display);
    }
}

/// Run a closure with EGL context current, then release.
fn with_egl_current<F, R>(egl: &EglContext, f: F) -> R
where
    F: FnOnce() -> R,
{
    let api = load_egl().expect("EGL ya deberia estar cargado");
    unsafe {
        (api.egl_make_current)(egl.display, egl.surface, egl.surface, egl.context);
    }
    let result = f();
    unsafe {
        (api.egl_make_current)(egl.display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    }
    result
}

// ---------------------------------------------------------------------------
// OpenGL functions (loaded via eglGetProcAddress)
// ---------------------------------------------------------------------------

struct GlFunctions {
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
    gl_finish: unsafe extern "C" fn(),
    gl_get_error: unsafe extern "C" fn() -> GLenum,
    gl_clear_color: unsafe extern "C" fn(GLfloat, GLfloat, GLfloat, GLfloat),
    gl_clear: unsafe extern "C" fn(GLenum),
}

fn load_gl() -> Result<GlFunctions, String> {
    let egl = load_egl()?;

    macro_rules! egl_proc {
        ($name:expr) => {{
            let c_name = CString::new($name).unwrap();
            unsafe { (egl.egl_get_proc_address)(c_name.as_ptr()) }
        }};
    }

    macro_rules! gl_fn {
        ($field:ident, $sig:ty, $str:expr) => {
            let ptr = egl_proc!($str);
            if ptr.is_null() {
                return Err(format!("GL function {} no disponible", $str));
            }
            let $field: $sig = unsafe { std::mem::transmute(ptr) };
        };
    }

    gl_fn!(
        gl_gen_framebuffers,
        unsafe extern "C" fn(GLsizei, *mut GLuint),
        "glGenFramebuffers"
    );
    gl_fn!(
        gl_bind_framebuffer,
        unsafe extern "C" fn(GLenum, GLuint),
        "glBindFramebuffer"
    );
    gl_fn!(
        gl_framebuffer_texture_2d,
        unsafe extern "C" fn(GLenum, GLenum, GLenum, GLuint, GLint),
        "glFramebufferTexture2D"
    );
    gl_fn!(
        gl_check_framebuffer_status,
        unsafe extern "C" fn(GLenum) -> GLenum,
        "glCheckFramebufferStatus"
    );
    gl_fn!(
        gl_delete_framebuffers,
        unsafe extern "C" fn(GLsizei, *const GLuint),
        "glDeleteFramebuffers"
    );
    gl_fn!(
        gl_gen_textures,
        unsafe extern "C" fn(GLsizei, *mut GLuint),
        "glGenTextures"
    );
    gl_fn!(
        gl_bind_texture,
        unsafe extern "C" fn(GLenum, GLuint),
        "glBindTexture"
    );
    gl_fn!(
        gl_tex_image_2d,
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
        ),
        "glTexImage2D"
    );
    gl_fn!(
        gl_tex_parameter_i,
        unsafe extern "C" fn(GLenum, GLenum, GLint),
        "glTexParameteri"
    );
    gl_fn!(
        gl_delete_textures,
        unsafe extern "C" fn(GLsizei, *const GLuint),
        "glDeleteTextures"
    );
    gl_fn!(
        gl_read_pixels,
        unsafe extern "C" fn(GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, *mut c_void),
        "glReadPixels"
    );
    gl_fn!(
        gl_pixel_store_i,
        unsafe extern "C" fn(GLenum, GLint),
        "glPixelStorei"
    );
    gl_fn!(gl_finish, unsafe extern "C" fn(), "glFinish");
    gl_fn!(gl_get_error, unsafe extern "C" fn() -> GLenum, "glGetError");
    gl_fn!(
        gl_clear_color,
        unsafe extern "C" fn(GLfloat, GLfloat, GLfloat, GLfloat),
        "glClearColor"
    );
    gl_fn!(gl_clear, unsafe extern "C" fn(GLenum), "glClear");

    Ok(GlFunctions {
        gl_gen_framebuffers,
        gl_bind_framebuffer,
        gl_framebuffer_texture_2d,
        gl_check_framebuffer_status,
        gl_delete_framebuffers,
        gl_gen_textures,
        gl_bind_texture,
        gl_tex_image_2d,
        gl_tex_parameter_i,
        gl_delete_textures,
        gl_read_pixels,
        gl_pixel_store_i,
        gl_finish,
        gl_get_error,
        gl_clear_color,
        gl_clear,
    })
}

// ---------------------------------------------------------------------------
// FBO management
// ---------------------------------------------------------------------------

fn create_fbo(gl: &GlFunctions, width: u32, height: u32) -> Result<(GLuint, GLuint), String> {
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
        let err = (gl.gl_get_error)();
        if err != 0 {
            eprintln!("glTexImage2D error en create_fbo: 0x{err:x}");
        }
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

        // Clear FBO to opaque black on creation
        (gl.gl_clear_color)(0.0, 0.0, 0.0, 1.0);
        (gl.gl_clear)(GL_COLOR_BUFFER_BIT);

        (gl.gl_bind_framebuffer)(GL_FRAMEBUFFER, 0);
        (gl.gl_bind_texture)(GL_TEXTURE_2D, 0);
    }

    Ok((fbo_id, tex_id))
}

fn resize_fbo(gl: &GlFunctions, tex_id: GLuint, fbo_id: GLuint, width: u32, height: u32) {
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
        let err = (gl.gl_get_error)();
        if err != 0 {
            eprintln!("glTexImage2D error en resize_fbo: 0x{err:x}");
        }

        (gl.gl_bind_framebuffer)(GL_FRAMEBUFFER, fbo_id);
        let status = (gl.gl_check_framebuffer_status)(GL_FRAMEBUFFER);
        if status != GL_FRAMEBUFFER_COMPLETE {
            eprintln!("FBO incompleto despues de resize: status 0x{status:x}");
        }

        (gl.gl_bind_texture)(GL_TEXTURE_2D, 0);
    }
}

// ---------------------------------------------------------------------------
// Frame buffer (shared between render thread and Tauri commands)
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct FrameBuffer {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub frame_count: u64,
}

impl FrameBuffer {
    fn new() -> Self {
        Self {
            data: Vec::new(),
            width: 0,
            height: 0,
            frame_count: 0,
        }
    }
}

// ---------------------------------------------------------------------------
// Update callback (mpv_render_context_set_update_callback)
// ---------------------------------------------------------------------------

struct MpvUpdateCtx {
    pending: AtomicBool,
    thread: Mutex<Option<Thread>>,
}

/// mpv calls this from any thread when a new frame is available.
/// Must be fast and must NOT call mpv/EGL/GL APIs.
unsafe extern "C" fn mpv_render_update_callback(ctx: *mut c_void) {
    if ctx.is_null() {
        return;
    }
    let state = &*(ctx as *mut MpvUpdateCtx);
    state.pending.store(true, Ordering::Release);
    if let Ok(guard) = state.thread.lock() {
        if let Some(ref thread) = *guard {
            thread.unpark();
        }
    }
}

// ---------------------------------------------------------------------------
// OffscreenRenderContext
// ---------------------------------------------------------------------------

pub struct OffscreenRenderContext {
    egl: Option<EglContext>,
    mpv_rc: *mut mpv_render_context,
    fbo_id: GLuint,
    tex_id: GLuint,
    current_width: u32,
    current_height: u32,
    frame_buffer: Arc<Mutex<FrameBuffer>>,
    mpv_handle: *mut mpv_handle,
    api: Arc<MpvApi>,
    stop_flag: Arc<AtomicBool>,
    render_thread: Option<JoinHandle<()>>,
    update_ctx_ptr: *mut c_void,
    /// Shared target render size (set by frontend via ResizeObserver).
    /// Updated from any Tauri command thread, read from render loop thread.
    target_size: Arc<Mutex<(u32, u32)>>,
}

impl OffscreenRenderContext {
    /// Create the render context: EGL context, FBO, mpv_render_context.
    /// Everything happens with EGL current.
    ///
    /// `display_ptr` is a platform-specific display handle:
    /// - Wayland: `wl_display*`
    /// - X11 / fallback: `std::ptr::null_mut()` (EGL_DEFAULT_DISPLAY works for pbuffer)
    ///
    /// # Safety
    /// `mpv_handle` and `display_ptr` must remain valid for the context creation
    /// call and must refer to handles owned by the caller.
    pub unsafe fn new(
        mpv_handle: *mut mpv_handle,
        api: &Arc<MpvApi>,
        display_ptr: *mut c_void,
    ) -> Result<Self, String> {
        load_egl()?;
        let created = create_egl_context(display_ptr)?;
        let egl = created.egl;
        let api_type_str = CString::new(created.api_type).unwrap();

        with_egl_current(&egl, || -> Result<(GLuint, GLuint), String> {
            let gl = load_gl()?;
            let (fbo_id, tex_id) = create_fbo(&gl, 1920, 1080)?;
            unsafe {
                (gl.gl_pixel_store_i)(GL_PACK_ALIGNMENT, 4);
            }
            Ok((fbo_id, tex_id))
        })
        .and_then(|(fbo_id, tex_id)| {
            // mpv_render_context_create needs EGL current too.
            // Re-make current if it was released.
            let init_params = mpv_opengl_init_params {
                get_proc_address: Some(mpv_get_proc_address),
                get_proc_address_ctx: std::ptr::null_mut(),
            };

            let mut create_params = [
                mpv_render_param {
                    type_: MPV_RENDER_PARAM_API_TYPE,
                    data: api_type_str.as_ptr() as *mut c_void,
                },
                mpv_render_param {
                    type_: MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,
                    data: &init_params as *const _ as *mut c_void,
                },
                mpv_render_param {
                    type_: MPV_RENDER_PARAM_INVALID,
                    data: std::ptr::null_mut(),
                },
            ];

            // Need EGL current for mpv_render_context_create
            with_egl_current(&egl, || -> Result<*mut mpv_render_context, String> {
                let mut mpv_rc: *mut mpv_render_context = std::ptr::null_mut();
                let ret = unsafe {
                    (api.mpv_render_context_create)(
                        &mut mpv_rc,
                        mpv_handle,
                        create_params.as_mut_ptr(),
                    )
                };
                if ret < 0 || mpv_rc.is_null() {
                    Err(format!(
                        "mpv_render_context_create fallo: {} (codigo {ret})",
                        crate::mpv::ffi::mpv_error_string(ret),
                    ))
                } else {
                    Ok(mpv_rc)
                }
            })
            .map(|mpv_rc| {
                // Register update callback so mpv can signal new frames
                let update_ctx = Box::into_raw(Box::new(MpvUpdateCtx {
                    pending: AtomicBool::new(false),
                    thread: Mutex::new(None),
                }));
                unsafe {
                    (api.mpv_render_context_set_update_callback)(
                        mpv_rc,
                        Some(mpv_render_update_callback),
                        update_ctx as *mut c_void,
                    );
                }
                log::info!("mpv_render_context creado (offscreen, FBO {fbo_id})");
                let target_size = Arc::new(Mutex::new((1920u32, 1080u32)));
                OffscreenRenderContext {
                    egl: Some(egl),
                    mpv_rc,
                    fbo_id,
                    tex_id,
                    current_width: 1920,
                    current_height: 1080,
                    frame_buffer: Arc::new(Mutex::new(FrameBuffer::new())),
                    mpv_handle,
                    api: Arc::clone(api),
                    stop_flag: Arc::new(AtomicBool::new(false)),
                    render_thread: None,
                    update_ctx_ptr: update_ctx as *mut c_void,
                    target_size,
                }
            })
        })
    }

    /// Start the render loop on a dedicated thread.
    /// The EGL context is moved to the render thread (self.egl becomes None).
    pub fn start(&mut self) -> Result<(), String> {
        if self.render_thread.is_some() {
            return Ok(());
        }
        self.stop_flag.store(false, Ordering::SeqCst);

        let egl = self
            .egl
            .take()
            .ok_or_else(|| "EGL context ya movido al thread de render".to_string())?;
        // Cast raw pointers to usize for thread-safety, cast back inside closure
        let mpv_rc_val = self.mpv_rc as usize;
        let mpv_handle_val = self.mpv_handle as usize;
        let fbo_id = self.fbo_id;
        let tex_id = self.tex_id;
        let mut current_w = self.current_width;
        let mut current_h = self.current_height;
        let frame_buffer = Arc::clone(&self.frame_buffer);
        let stop_flag = Arc::clone(&self.stop_flag);
        let api = Arc::clone(&self.api);
        let update_ctx_ptr = self.update_ctx_ptr as usize;
        let target_size = Arc::clone(&self.target_size);

        let handle = std::thread::Builder::new()
            .name("mpv-render-loop".into())
            .spawn(move || {
                // Restore raw pointers from usize
                let mpv_rc = mpv_rc_val as *mut mpv_render_context;
                let mpv_handle = mpv_handle_val as *mut mpv_handle;

                let egl_api = match load_egl() {
                    Ok(a) => a,
                    Err(e) => {
                        log::error!("Render loop: EGL load fallo: {e}");
                        return;
                    }
                };

                unsafe {
                    (egl_api.egl_make_current)(egl.display, egl.surface, egl.surface, egl.context);
                }

                let gl = match load_gl() {
                    Ok(g) => g,
                    Err(e) => {
                        log::error!("Render loop: GL load fallo: {e}");
                        return;
                    }
                };

                log::info!("Render loop iniciado");

                // Wire up update callback: store this thread handle so mpv can
                // wake us when a new frame is available.
                let update_ctx = unsafe { &mut *(update_ctx_ptr as *mut MpvUpdateCtx) };
                *update_ctx.thread.lock().unwrap() = Some(std::thread::current());

                let mut render_params = vec![
                    mpv_render_param {
                        type_: MPV_RENDER_PARAM_OPENGL_FBO,
                        data: std::ptr::null_mut(),
                    },
                    mpv_render_param {
                        type_: MPV_RENDER_PARAM_INVALID,
                        data: std::ptr::null_mut(),
                    },
                ];

                let mut render_count: u64 = 0;
                let mut park_timeout_ms: u64 = 33;

                while !stop_flag.load(Ordering::Relaxed) {
                    // Clear the update-pending flag set by the callback
                    update_ctx.pending.swap(false, Ordering::AcqRel);

                    let dw = read_mpv_dimension(&api, mpv_handle, "dwidth") as u32;
                    let dh = read_mpv_dimension(&api, mpv_handle, "dheight") as u32;

                    // Read target render size from frontend (clamped to safety cap 1920x1080)
                    let (target_w, target_h) = *target_size.lock().unwrap();
                    let max_w = target_w.clamp(16, 1920);
                    let max_h = target_h.clamp(16, 1080);

                    let (render_w, render_h) = if dw > 0 && dh > 0 {
                        cap_resolution(dw, dh, max_w, max_h)
                    } else {
                        (current_w, current_h)
                    };

                    if (dw > 0 && dh > 0) && (render_w != current_w || render_h != current_h) {
                        log::info!("FBO resize: {}x{} -> {}x{} (original {}x{} target {}x{})", current_w, current_h, render_w, render_h, dw, dh, max_w, max_h);
                        resize_fbo(&gl, tex_id, fbo_id, render_w, render_h);
                        current_w = render_w;
                        current_h = render_h;
                    }

                    unsafe {
                        (gl.gl_bind_framebuffer)(GL_FRAMEBUFFER, fbo_id);
                    }

                    let fbo_params = MpvOpenglFbo {
                        fbo: fbo_id as i32,
                        w: render_w as i32,
                        h: render_h as i32,
                        internal_format: 0,
                    };
                    render_params[0] = mpv_render_param {
                        type_: MPV_RENDER_PARAM_OPENGL_FBO,
                        data: &fbo_params as *const _ as *mut c_void,
                    };

                    unsafe { (gl.gl_finish)(); }

                    let ret = unsafe {
                        (api.mpv_render_context_render)(mpv_rc, render_params.as_mut_ptr())
                    };

                    let gl_err = unsafe { (gl.gl_get_error)() };
                    if gl_err != 0 {
                        eprintln!("glGetError despues de mpv_render_context_render: 0x{gl_err:x}");
                    }

                    if ret >= 0 {
                        // mpv_render_context_render may leave another framebuffer
                        // bound — re-bind our FBO before readback.
                        unsafe { (gl.gl_bind_framebuffer)(GL_FRAMEBUFFER, fbo_id); }

                        let buf_size = (render_w * render_h * 4) as usize;
                        let mut pixels = vec![0u8; buf_size];
                        unsafe {
                            (gl.gl_read_pixels)(
                                0, 0,
                                render_w as GLsizei, render_h as GLsizei,
                                GL_RGBA, GL_UNSIGNED_BYTE,
                                pixels.as_mut_ptr() as *mut c_void,
                            );
                        }

                        let read_err = unsafe { (gl.gl_get_error)() };
                        if read_err != 0 {
                            eprintln!("glGetError despues de glReadPixels: 0x{read_err:x}");
                        }

                        if let Ok(mut fb) = frame_buffer.lock() {
                            fb.data = pixels;
                            fb.width = render_w;
                            fb.height = render_h;
                            fb.frame_count = fb.frame_count.wrapping_add(1);
                        }

                        unsafe { (gl.gl_bind_framebuffer)(GL_FRAMEBUFFER, 0); }
                        unsafe { (api.mpv_render_context_report_swap)(mpv_rc); }
                    } else if ret < 0 {
                        eprintln!("mpv_render: {} (codigo {})",
                            crate::mpv::ffi::mpv_error_string(ret), ret);
                        unsafe { (gl.gl_bind_framebuffer)(GL_FRAMEBUFFER, 0); }
                    }

                    render_count = render_count.wrapping_add(1);
                    if render_count.is_multiple_of(30) {
                        let (frame_count, px0, px_mid) = frame_buffer
                            .lock()
                            .map(|fb| {
                                let px0 = if fb.data.len() >= 4 {
                                    [fb.data[0], fb.data[1], fb.data[2], fb.data[3]]
                                } else {
                                    [0, 0, 0, 0]
                                };
                                let mid_x = (fb.width / 2) as usize;
                                let mid_y = (fb.height / 2) as usize;
                                let off = (mid_y * fb.width as usize + mid_x) * 4;
                                let px_mid = if off + 4 <= fb.data.len() {
                                    [fb.data[off], fb.data[off + 1], fb.data[off + 2], fb.data[off + 3]]
                                } else {
                                    [0, 0, 0, 0]
                                };
                                (fb.frame_count, px0, px_mid)
                            })
                            .unwrap_or((0, [0, 0, 0, 0], [0, 0, 0, 0]));
                        eprintln!(
                            "[mpv-render] iter={} ret={} dw={}x{} frames={} px0=[{},{},{},{}] pxMid=[{},{},{},{}]",
                            render_count, ret, dw, dh, frame_count,
                            px0[0], px0[1], px0[2], px0[3],
                            px_mid[0], px_mid[1], px_mid[2], px_mid[3],
                        );
                    }

                    // Adaptive frame pacing: read fps once after playback stabilizes
                    if render_count == 120 {
                        let fps = read_mpv_property_f64(&api, mpv_handle, "estimated-vf-fps");
                        let fps = if fps <= 0.0 {
                            read_mpv_property_f64(&api, mpv_handle, "container-fps")
                        } else {
                            fps
                        };
                        if fps > 45.0 {
                            park_timeout_ms = 16;
                            log::info!("render loop: fps={:.1}, park_timeout=16ms (60fps)", fps);
                        } else {
                            log::info!("render loop: fps={:.1}, park_timeout=33ms", fps);
                        }
                    }

                    std::thread::park_timeout(Duration::from_millis(park_timeout_ms));
                }

                // Liberar mpv_render_context ANTES de destruir EGL
                unsafe {
                    (api.mpv_render_context_free)(mpv_rc);
                }
                // Cleanup EGL on this thread
                unsafe {
                    (egl_api.egl_make_current)(egl.display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
                }
                destroy_egl_context(egl);
                log::info!("Render loop finalizado");
            })
            .map_err(|e| format!("No se pudo crear render loop thread: {e}"))?;

        self.render_thread = Some(handle);
        Ok(())
    }

    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(handle) = self.render_thread.take() {
            handle.thread().unpark();
            let _ = handle.join();
            // El render thread ya libero mpv_rc y EGL
            self.mpv_rc = std::ptr::null_mut();
        }
        // Free the update callback context (no longer needed after thread ends)
        if !self.update_ctx_ptr.is_null() {
            unsafe {
                drop(Box::from_raw(self.update_ctx_ptr as *mut MpvUpdateCtx));
            }
            self.update_ctx_ptr = std::ptr::null_mut();
        }
    }

    /// Get the latest rendered frame (for frontend consumption).
    pub fn get_frame(&self) -> Option<FrameBuffer> {
        self.frame_buffer.lock().ok().map(|fb| fb.clone())
    }

    /// Update the target render size from the frontend.
    /// Values are clamped to [16, 3840] by the caller before this is called.
    pub fn set_target_size(&self, width: u32, height: u32) {
        if let Ok(mut target) = self.target_size.lock() {
            *target = (width, height);
        }
    }
}

impl Drop for OffscreenRenderContext {
    fn drop(&mut self) {
        self.stop();
        // Si el render thread arranco, ya libero mpv_rc y lo nullamos en stop()
        // Si no arranco (mpv_rc aun no nulo), liberamos aqui
        if !self.mpv_rc.is_null() {
            unsafe {
                (self.api.mpv_render_context_free)(self.mpv_rc);
            }
            self.mpv_rc = std::ptr::null_mut();
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Contain-fit (w, h) within max_w × max_h preserving aspect ratio.
/// Never upscales beyond the original (w, h). If w or h is 0, returns unchanged.
fn cap_resolution(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if w == 0 || h == 0 {
        return (w, h);
    }
    if w <= max_w && h <= max_h {
        return (w, h);
    }
    let scale = (max_w as f64 / w as f64).min(max_h as f64 / h as f64);
    let capped_w = (w as f64 * scale) as u32;
    let capped_h = (h as f64 * scale) as u32;
    (capped_w.max(1), capped_h.max(1))
}

/// Read an mpv property as f64 (double). Returns 0.0 on failure.
fn read_mpv_property_f64(api: &MpvApi, handle: *mut mpv_handle, prop: &str) -> f64 {
    let c_name = match std::ffi::CString::new(prop) {
        Ok(n) => n,
        Err(_) => return 0.0,
    };
    let mut val: f64 = 0.0;
    let ret = unsafe {
        (api.mpv_get_property)(
            handle,
            c_name.as_ptr(),
            mpv_format::MPV_FORMAT_DOUBLE,
            &mut val as *mut f64 as *mut c_void,
        )
    };
    if ret < 0 {
        0.0
    } else {
        val
    }
}

fn read_mpv_dimension(api: &MpvApi, handle: *mut mpv_handle, prop: &str) -> i32 {
    let c_name = match std::ffi::CString::new(prop) {
        Ok(n) => n,
        Err(_) => return 0,
    };
    let mut val: i64 = 0;
    let ret = unsafe {
        (api.mpv_get_property)(
            handle,
            c_name.as_ptr(),
            mpv_format::MPV_FORMAT_INT64,
            &mut val as *mut i64 as *mut c_void,
        )
    };
    if ret < 0 {
        0
    } else {
        val as i32
    }
}
