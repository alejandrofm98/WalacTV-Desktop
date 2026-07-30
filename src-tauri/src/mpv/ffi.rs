//! Direct FFI bindings to libmpv via libloading.
//!
//! All function pointers are resolved at runtime from libmpv.so (Linux),
//! libmpv-2.dll (Windows), or libmpv.dylib (macOS).
//!
//! Based on the approach used by Soia (https://github.com/FengZeng/soia).

use libloading::Library;
use std::ffi::{c_char, c_int, c_void, CStr};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

// ---------------------------------------------------------------------------
// Opaque handle types
// ---------------------------------------------------------------------------

#[repr(C)]
pub struct mpv_handle([u8; 0]);

#[repr(C)]
pub struct mpv_render_context([u8; 0]);

// ---------------------------------------------------------------------------
// Render API types (mpv/render.h)
// ---------------------------------------------------------------------------

/// Parameters passed to mpv render API functions.
/// Terminated by an entry with type_ = MPV_RENDER_PARAM_INVALID (0).
#[repr(C)]
pub struct mpv_render_param {
    pub type_: i32,
    pub data: *mut c_void,
}

/// OpenGL initialization parameters for mpv_render_context_create.
#[repr(C)]
pub struct mpv_opengl_init_params {
    pub get_proc_address:
        Option<unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void>,
    pub get_proc_address_ctx: *mut c_void,
}

// ---------------------------------------------------------------------------
// mpv_render_param_type constants (from mpv/render.h)
// ---------------------------------------------------------------------------

pub const MPV_RENDER_PARAM_INVALID: i32 = 0;
pub const MPV_RENDER_PARAM_API_TYPE: i32 = 1;
pub const MPV_RENDER_PARAM_OPENGL_INIT_PARAMS: i32 = 2;
pub const MPV_RENDER_PARAM_OPENGL_FBO: i32 = 3;
pub const MPV_RENDER_PARAM_FLIP_Y: i32 = 4;
pub const MPV_RENDER_PARAM_FLIP_DEPTH: i32 = 5;

// ---------------------------------------------------------------------------
// MpvError — typed errors for the mpv module
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum MpvError {
    /// libmpv shared library could not be found/loaded.
    LibraryNotFound(String),
    /// The current platform is not supported.
    UnsupportedPlatform,
    /// A required symbol could not be resolved in the loaded library.
    SymbolNotFound(String),
}

impl fmt::Display for MpvError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MpvError::LibraryNotFound(msg) => write!(f, "{msg}"),
            MpvError::UnsupportedPlatform => write!(f, "Plataforma no soportada"),
            MpvError::SymbolNotFound(msg) => write!(f, "{msg}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

pub const MPV_ERROR_SUCCESS: c_int = 0;
pub const MPV_ERROR_EVENT_QUEUE_FULL: c_int = -1;
pub const MPV_ERROR_NOMEM: c_int = -2;
pub const MPV_ERROR_UNINITIALIZED: c_int = -3;
pub const MPV_ERROR_INVALID_PARAMETER: c_int = -4;
pub const MPV_ERROR_OPTION_NOT_FOUND: c_int = -5;
pub const MPV_ERROR_OPTION_FORMAT: c_int = -6;
pub const MPV_ERROR_OPTION_ERROR: c_int = -7;
pub const MPV_ERROR_PROPERTY_NOT_FOUND: c_int = -8;
pub const MPV_ERROR_PROPERTY_FORMAT: c_int = -9;
pub const MPV_ERROR_PROPERTY_UNAVAILABLE: c_int = -10;
pub const MPV_ERROR_PROPERTY_ERROR: c_int = -11;
pub const MPV_ERROR_COMMAND: c_int = -12;
pub const MPV_ERROR_LOADING_FAILED: c_int = -13;
pub const MPV_ERROR_AO_INIT_FAILED: c_int = -14;
pub const MPV_ERROR_VO_INIT_FAILED: c_int = -15;
pub const MPV_ERROR_NOTHING_TO_PLAY: c_int = -16;
pub const MPV_ERROR_UNKNOWN_FORMAT: c_int = -17;
pub const MPV_ERROR_UNSUPPORTED: c_int = -18;
pub const MPV_ERROR_NOT_IMPLEMENTED: c_int = -19;
pub const MPV_ERROR_GENERIC: c_int = -20;

/// Returns a human-readable description of an mpv error code.
pub fn mpv_error_string(code: c_int) -> &'static str {
    match code {
        MPV_ERROR_SUCCESS => "exito",
        MPV_ERROR_EVENT_QUEUE_FULL => "cola de eventos llena",
        MPV_ERROR_NOMEM => "sin memoria",
        MPV_ERROR_UNINITIALIZED => "no inicializado",
        MPV_ERROR_INVALID_PARAMETER => "parametro invalido",
        MPV_ERROR_OPTION_NOT_FOUND => "opcion no encontrada",
        MPV_ERROR_OPTION_FORMAT => "formato de opcion invalido",
        MPV_ERROR_OPTION_ERROR => "error en opcion",
        MPV_ERROR_PROPERTY_NOT_FOUND => "propiedad no encontrada",
        MPV_ERROR_PROPERTY_FORMAT => "formato de propiedad invalido",
        MPV_ERROR_PROPERTY_UNAVAILABLE => "propiedad no disponible",
        MPV_ERROR_PROPERTY_ERROR => "error de propiedad",
        MPV_ERROR_COMMAND => "error de comando",
        MPV_ERROR_LOADING_FAILED => "fallo al cargar archivo",
        MPV_ERROR_AO_INIT_FAILED => "fallo al inicializar salida de audio",
        MPV_ERROR_VO_INIT_FAILED => "fallo al inicializar salida de video",
        MPV_ERROR_NOTHING_TO_PLAY => "nada que reproducir",
        MPV_ERROR_UNKNOWN_FORMAT => "formato desconocido",
        MPV_ERROR_UNSUPPORTED => "no soportado",
        MPV_ERROR_NOT_IMPLEMENTED => "operacion no implementada",
        MPV_ERROR_GENERIC => "error generico",
        _ => "error desconocido",
    }
}

// ---------------------------------------------------------------------------
// mpv_format
// ---------------------------------------------------------------------------

#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq)]
#[allow(non_camel_case_types)]
pub enum mpv_format {
    MPV_FORMAT_NONE = 0,
    MPV_FORMAT_STRING = 1,
    MPV_FORMAT_OSD_STRING = 2,
    MPV_FORMAT_FLAG = 3,
    MPV_FORMAT_INT64 = 4,
    MPV_FORMAT_DOUBLE = 5,
    MPV_FORMAT_NODE = 6,
    MPV_FORMAT_NODE_ARRAY = 7,
    MPV_FORMAT_NODE_MAP = 8,
}

// ---------------------------------------------------------------------------
// mpv_event_id
// ---------------------------------------------------------------------------

#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq)]
#[allow(non_camel_case_types)]
pub enum mpv_event_id {
    MPV_EVENT_NONE = 0,
    MPV_EVENT_SHUTDOWN = 1,
    MPV_EVENT_LOG_MESSAGE = 2,
    MPV_EVENT_GET_PROPERTY_REPLY = 3,
    MPV_EVENT_SET_PROPERTY_REPLY = 4,
    MPV_EVENT_COMMAND_REPLY = 5,
    MPV_EVENT_START_FILE = 6,
    MPV_EVENT_END_FILE = 7,
    MPV_EVENT_FILE_LOADED = 8,
    MPV_EVENT_TICK = 14,
    MPV_EVENT_CLIENT_MESSAGE = 16,
    MPV_EVENT_VIDEO_RECONFIG = 17,
    MPV_EVENT_AUDIO_RECONFIG = 18,
    MPV_EVENT_SEEK = 20,
    MPV_EVENT_PLAYBACK_RESTART = 21,
    MPV_EVENT_PROPERTY_CHANGE = 22,
    MPV_EVENT_QUEUE_OVERFLOW = 24,
    MPV_EVENT_HOOK = 25,
}

impl From<c_int> for mpv_event_id {
    fn from(id: c_int) -> Self {
        match id {
            0 => mpv_event_id::MPV_EVENT_NONE,
            1 => mpv_event_id::MPV_EVENT_SHUTDOWN,
            2 => mpv_event_id::MPV_EVENT_LOG_MESSAGE,
            3 => mpv_event_id::MPV_EVENT_GET_PROPERTY_REPLY,
            4 => mpv_event_id::MPV_EVENT_SET_PROPERTY_REPLY,
            5 => mpv_event_id::MPV_EVENT_COMMAND_REPLY,
            6 => mpv_event_id::MPV_EVENT_START_FILE,
            7 => mpv_event_id::MPV_EVENT_END_FILE,
            8 => mpv_event_id::MPV_EVENT_FILE_LOADED,
            14 => mpv_event_id::MPV_EVENT_TICK,
            16 => mpv_event_id::MPV_EVENT_CLIENT_MESSAGE,
            17 => mpv_event_id::MPV_EVENT_VIDEO_RECONFIG,
            18 => mpv_event_id::MPV_EVENT_AUDIO_RECONFIG,
            20 => mpv_event_id::MPV_EVENT_SEEK,
            21 => mpv_event_id::MPV_EVENT_PLAYBACK_RESTART,
            22 => mpv_event_id::MPV_EVENT_PROPERTY_CHANGE,
            24 => mpv_event_id::MPV_EVENT_QUEUE_OVERFLOW,
            25 => mpv_event_id::MPV_EVENT_HOOK,
            _ => mpv_event_id::MPV_EVENT_NONE,
        }
    }
}

// ---------------------------------------------------------------------------
// mpv_event and related structs
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Debug)]
pub struct mpv_event {
    pub event_id: mpv_event_id,
    pub error: c_int,
    pub reply_usrdata: u64,
    pub data: *mut c_void,
}

#[repr(C)]
#[derive(Debug)]
pub struct mpv_event_property {
    pub name: *const c_char,
    pub format: mpv_format,
    pub data: *mut c_void,
}

#[repr(C)]
#[derive(Debug)]
pub struct mpv_event_end_file {
    pub reason: c_int,
    pub error: c_int,
    pub playlist_entry_id: i64,
    pub playlist_insert_id: i64,
    pub playlist_insert_num_entries: c_int,
}

#[repr(C)]
#[derive(Debug)]
pub struct mpv_event_log_message {
    pub prefix: *const c_char,
    pub level: *const c_char,
    pub text: *const c_char,
    pub log_level: c_int,
}

// ---------------------------------------------------------------------------
// mpv_node types (for complex property access)
// ---------------------------------------------------------------------------

#[repr(C)]
pub struct mpv_node {
    pub u: mpv_node_union,
    pub format: mpv_format,
}

#[repr(C)]
pub union mpv_node_union {
    pub string: *mut c_char,
    pub flag: c_int,
    pub int64: i64,
    pub double_: f64,
    pub list: *mut mpv_node_list,
}

#[repr(C)]
pub struct mpv_node_list {
    pub num: c_int,
    pub values: *mut mpv_node,
    pub keys: *mut *mut c_char,
}

// ---------------------------------------------------------------------------
// MpvApi - dynamically loaded function pointers
// ---------------------------------------------------------------------------

pub struct MpvApi {
    /// Keep the library alive for the lifetime of these function pointers.
    pub _lib: Library,

    // -- Core lifecycle --
    pub mpv_create: unsafe extern "C" fn() -> *mut mpv_handle,
    pub mpv_initialize: unsafe extern "C" fn(*mut mpv_handle) -> c_int,
    pub mpv_destroy: unsafe extern "C" fn(*mut mpv_handle),
    pub mpv_terminate_destroy: unsafe extern "C" fn(*mut mpv_handle),
    pub mpv_create_client:
        unsafe extern "C" fn(*mut mpv_handle, *const c_char) -> *mut mpv_handle,

    // -- Options (before init) --
    pub mpv_set_option_string:
        unsafe extern "C" fn(*mut mpv_handle, *const c_char, *const c_char) -> c_int,
    pub mpv_request_log_messages:
        unsafe extern "C" fn(*mut mpv_handle, *const c_char),

    // -- Properties --
    pub mpv_set_property_string:
        unsafe extern "C" fn(*mut mpv_handle, *const c_char, *const c_char) -> c_int,
    pub mpv_set_property:
        unsafe extern "C" fn(*mut mpv_handle, *const c_char, mpv_format, *mut c_void) -> c_int,
    pub mpv_get_property_string:
        unsafe extern "C" fn(*mut mpv_handle, *const c_char) -> *mut c_char,
    pub mpv_get_property:
        unsafe extern "C" fn(*mut mpv_handle, *const c_char, mpv_format, *mut c_void) -> c_int,
    pub mpv_free: unsafe extern "C" fn(*mut c_void),

    // -- Commands --
    pub mpv_command:
        unsafe extern "C" fn(*mut mpv_handle, *const *const c_char) -> c_int,

    // -- Events --
    pub mpv_observe_property:
        unsafe extern "C" fn(*mut mpv_handle, u64, *const c_char, mpv_format) -> c_int,
    pub mpv_unobserve_property:
        unsafe extern "C" fn(*mut mpv_handle, u64) -> c_int,
    pub mpv_wait_event:
        unsafe extern "C" fn(*mut mpv_handle, f64) -> *mut mpv_event,
    pub mpv_wakeup: unsafe extern "C" fn(*mut mpv_handle),
    pub mpv_request_event:
        unsafe extern "C" fn(*mut mpv_handle, mpv_event_id, c_int) -> c_int,

    // -- Render context (Wayland / macOS) --
    pub mpv_render_context_create:
        unsafe extern "C" fn(
            *mut *mut mpv_render_context,
            *mut mpv_handle,
            *mut mpv_render_param,
        ) -> c_int,
    pub mpv_render_context_free: unsafe extern "C" fn(*mut mpv_render_context),
    pub mpv_render_context_render:
        unsafe extern "C" fn(*mut mpv_render_context, *mut mpv_render_param) -> c_int,
    pub mpv_render_context_report_swap:
        unsafe extern "C" fn(*mut mpv_render_context),
    pub mpv_render_context_set_update_callback:
        unsafe extern "C" fn(
            *mut mpv_render_context,
            Option<unsafe extern "C" fn(*mut c_void)>,
            *mut c_void,
        ),
}

// Safety: MpvApi owns the Library which is Send+Sync, and function pointers
// are plain addresses that are safe to share across threads.
unsafe impl Send for MpvApi {}
unsafe impl Sync for MpvApi {}

impl MpvApi {
    /// Load libmpv dynamically and resolve all function pointers.
    ///
    /// `resource_dir` is the platform resource directory (from
    /// `app.path().resource_dir()` on Tauri). It is used on Windows to locate
    /// the bundled `libmpv-2.dll` inside the installer's `libmpv/` subdir.
    /// On Linux/macOS it is unused (system paths / Homebrew are searched).
    ///
    /// Returns `MpvError::LibraryNotFound` with platform-specific install
    /// instructions when the shared library cannot be loaded.
    pub fn load(resource_dir: Option<&Path>) -> Result<Arc<Self>, MpvError> {
        #[cfg(not(target_os = "windows"))]
        let _ = resource_dir;

        let lib = unsafe {
            #[cfg(target_os = "linux")]
            {
                // 1. Try the local (auto-installed) bundle path first
                let local_path = local_libmpv_path();
                if local_path.exists() {
                    match Library::new(&local_path) {
                        Ok(lib) => lib,
                        Err(e) => {
                            log::warn!(
                                "libmpv.so.2 local bundle exists but failed to load: {e}. \
                                 Trying system path..."
                            );
                            Library::new("libmpv.so.2")
                                .or_else(|_| Library::new("libmpv.so"))
                                .map_err(|e2| MpvError::LibraryNotFound(format!(
                                    "No se pudo cargar libmpv.so: {e}. {e2}. \
                                     El bundle local en {} fallo y la libreria \
                                     del sistema tampoco esta disponible.\n\n\
                                     Instalá libmpv-dev en tu sistema:\n  \
                                     Debian/Ubuntu: sudo apt install libmpv-dev\n  \
                                     Fedora:       sudo dnf install mpv-libs-devel\n  \
                                     Arch:         sudo pacman -S mpv\n  \
                                     openSUSE:     sudo zypper install mpv-devel",
                                    local_path.display()
                                )))?
                        }
                    }
                } else {
                    // 2. Local bundle doesn't exist — try system paths
                    Library::new("libmpv.so.2")
                        .or_else(|_| Library::new("libmpv.so"))
                        .map_err(|e| MpvError::LibraryNotFound(format!(
                            "No se pudo cargar libmpv.so: {e}. \
                             La app puede intentar instalarlo automaticamente \
                             (reintentá desde la interfaz).\
                             \n\nInstalá libmpv-dev en tu sistema:\n  \
                             Debian/Ubuntu: sudo apt install libmpv-dev\n  \
                             Fedora:       sudo dnf install mpv-libs-devel\n  \
                             Arch:         sudo pacman -S mpv\n  \
                             openSUSE:     sudo zypper install mpv-devel\n\n\
                             Después de instalar, reiniciá la app."
                        )))?
                }
            }
            #[cfg(target_os = "windows")]
            {
                // Search order:
                //  1. <resource_dir>/libmpv-2.dll  (bundled via beforeBundleCommand copy)
                //  2. <resource_dir>/libmpv.dll
                //  3. <resource_dir>/libmpv/libmpv-2.dll  (legacy bundle layout)
                //  4. <resource_dir>/libmpv/libmpv.dll
                //  5. libmpv-2.dll in EXE dir (manual install)
                //  6. libmpv.dll in EXE dir (manual install)
                let mut candidates: Vec<PathBuf> = Vec::new();
                if let Some(rd) = resource_dir {
                    candidates.push(rd.join("libmpv-2.dll"));
                    candidates.push(rd.join("libmpv.dll"));
                    candidates.push(rd.join("libmpv").join("libmpv-2.dll"));
                    candidates.push(rd.join("libmpv").join("libmpv.dll"));
                }
                candidates.push(PathBuf::from("libmpv-2.dll"));
                candidates.push(PathBuf::from("libmpv.dll"));

                let mut last_err: Option<libloading::Error> = None;
                let mut loaded: Option<Library> = None;
                for path in &candidates {
                    match Library::new(path) {
                        Ok(lib) => {
                            log::info!("libmpv cargado desde {}", path.display());
                            loaded = Some(lib);
                            break;
                        }
                        Err(e) => {
                            log::debug!("libmpv no encontrado en {}: {e}", path.display());
                            last_err = Some(e);
                        }
                    }
                }
                loaded.ok_or_else(|| {
                    let e = last_err
                        .as_ref()
                        .map(|e| e.to_string())
                        .unwrap_or_else(|| "no candidates".to_string());
                    MpvError::LibraryNotFound(format!(
                        "No se pudo cargar libmpv-2.dll: {e}. \
                         Buscado en:\n  - {}\
                         \nAsegurate de que libmpv-2.dll está bundleado \
                         en el installer o instalalo desde:\n  \
                         https://mpv.srsfckn.biz/",
                        candidates
                            .iter()
                            .map(|p| p.display().to_string())
                            .collect::<Vec<_>>()
                            .join("\n  - ")
                    ))
                })?
            }
            #[cfg(target_os = "macos")]
            {
                Library::new("libmpv.dylib")
                    .or_else(|_| Library::new("/opt/homebrew/lib/libmpv.dylib"))
                    .or_else(|_| Library::new("/usr/local/lib/libmpv.dylib"))
                    .map_err(|e| MpvError::LibraryNotFound(format!(
                        "No se pudo cargar libmpv.dylib: {e}. \
                         Instalá mpv via Homebrew:\n  \
                         brew install mpv\n\n\
                         Después de instalar, reiniciá la app."
                    )))?
            }
            #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
            {
                compile_error!("unsupported platform");
                // SAFETY: unreachable due to compile_error! above
                std::mem::zeroed()
            }
        };

        // Resolve each symbol to the correct function pointer type.
        // libloading's get() returns a Symbol<T> where T must match the actual
        // function signature. We use a series of explicit loads.
        unsafe {
            let mpv_create: extern "C" fn() -> *mut mpv_handle =
                *lib.get(b"mpv_create\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_create: {e}")))?;

            let mpv_initialize: extern "C" fn(*mut mpv_handle) -> c_int =
                *lib.get(b"mpv_initialize\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_initialize: {e}")))?;

            let mpv_destroy: extern "C" fn(*mut mpv_handle) =
                *lib.get(b"mpv_destroy\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_destroy: {e}")))?;

            let mpv_terminate_destroy: extern "C" fn(*mut mpv_handle) =
                *lib.get(b"mpv_terminate_destroy\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_terminate_destroy: {e}")))?;

            let mpv_create_client: extern "C" fn(*mut mpv_handle, *const c_char) -> *mut mpv_handle =
                *lib.get(b"mpv_create_client\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_create_client: {e}")))?;

            let mpv_set_option_string: extern "C" fn(*mut mpv_handle, *const c_char, *const c_char) -> c_int =
                *lib.get(b"mpv_set_option_string\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_set_option_string: {e}")))?;

            let mpv_request_log_messages: extern "C" fn(*mut mpv_handle, *const c_char) =
                *lib.get(b"mpv_request_log_messages\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_request_log_messages: {e}")))?;

            let mpv_set_property_string: extern "C" fn(*mut mpv_handle, *const c_char, *const c_char) -> c_int =
                *lib.get(b"mpv_set_property_string\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_set_property_string: {e}")))?;

            let mpv_set_property: extern "C" fn(*mut mpv_handle, *const c_char, mpv_format, *mut c_void) -> c_int =
                *lib.get(b"mpv_set_property\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_set_property: {e}")))?;

            let mpv_get_property_string: extern "C" fn(*mut mpv_handle, *const c_char) -> *mut c_char =
                *lib.get(b"mpv_get_property_string\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_get_property_string: {e}")))?;

            let mpv_get_property: extern "C" fn(*mut mpv_handle, *const c_char, mpv_format, *mut c_void) -> c_int =
                *lib.get(b"mpv_get_property\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_get_property: {e}")))?;

            let mpv_free: extern "C" fn(*mut c_void) =
                *lib.get(b"mpv_free\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_free: {e}")))?;

            let mpv_command: extern "C" fn(*mut mpv_handle, *const *const c_char) -> c_int =
                *lib.get(b"mpv_command\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_command: {e}")))?;

            let mpv_observe_property: extern "C" fn(*mut mpv_handle, u64, *const c_char, mpv_format) -> c_int =
                *lib.get(b"mpv_observe_property\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_observe_property: {e}")))?;

            let mpv_unobserve_property: extern "C" fn(*mut mpv_handle, u64) -> c_int =
                *lib.get(b"mpv_unobserve_property\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_unobserve_property: {e}")))?;

            let mpv_wait_event: extern "C" fn(*mut mpv_handle, f64) -> *mut mpv_event =
                *lib.get(b"mpv_wait_event\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_wait_event: {e}")))?;

            let mpv_wakeup: extern "C" fn(*mut mpv_handle) =
                *lib.get(b"mpv_wakeup\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_wakeup: {e}")))?;

            let mpv_request_event: extern "C" fn(*mut mpv_handle, mpv_event_id, c_int) -> c_int =
                *lib.get(b"mpv_request_event\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_request_event: {e}")))?;

            let mpv_render_context_create: extern "C" fn(*mut *mut mpv_render_context, *mut mpv_handle, *mut mpv_render_param) -> c_int =
                *lib.get(b"mpv_render_context_create\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_render_context_create: {e}")))?;

            let mpv_render_context_free: extern "C" fn(*mut mpv_render_context) =
                *lib.get(b"mpv_render_context_free\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_render_context_free: {e}")))?;

            let mpv_render_context_render: extern "C" fn(*mut mpv_render_context, *mut mpv_render_param) -> c_int =
                *lib.get(b"mpv_render_context_render\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_render_context_render: {e}")))?;

            let mpv_render_context_report_swap: extern "C" fn(*mut mpv_render_context) =
                *lib.get(b"mpv_render_context_report_swap\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_render_context_report_swap: {e}")))?;

            let mpv_render_context_set_update_callback:
                extern "C" fn(*mut mpv_render_context, Option<unsafe extern "C" fn(*mut c_void)>, *mut c_void) =
                *lib.get(b"mpv_render_context_set_update_callback\0")
                    .map_err(|e| MpvError::SymbolNotFound(format!("mpv_render_context_set_update_callback: {e}")))?;

            Ok(Arc::new(MpvApi {
                _lib: lib,
                mpv_create,
                mpv_initialize,
                mpv_destroy,
                mpv_terminate_destroy,
                mpv_create_client,
                mpv_set_option_string,
                mpv_request_log_messages,
                mpv_set_property_string,
                mpv_set_property,
                mpv_get_property_string,
                mpv_get_property,
                mpv_free,
                mpv_command,
                mpv_observe_property,
                mpv_unobserve_property,
                mpv_wait_event,
                mpv_wakeup,
                mpv_request_event,
                mpv_render_context_create,
                mpv_render_context_free,
                mpv_render_context_render,
                mpv_render_context_report_swap,
                mpv_render_context_set_update_callback,
            }))
        }
    }
}

// ---------------------------------------------------------------------------
// Local (bundled) libmpv path resolution
// ---------------------------------------------------------------------------

/// Returns the directory where the auto-installer places libmpv.so.2.
///
/// Linux:   $XDG_DATA_HOME/walactv-desktop/libmpv/
///          or ~/.local/share/walactv-desktop/libmpv/
fn local_libmpv_dir() -> PathBuf {
    let base = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME")
                .unwrap_or_else(|_| "/tmp".to_string());
            PathBuf::from(home).join(".local").join("share")
        });
    base.join("walactv-desktop").join("libmpv")
}

/// Full path to the local libmpv.so.2 bundle copy.
fn local_libmpv_path() -> PathBuf {
    local_libmpv_dir().join("libmpv.so.2")
}

/// Embedded install script (keep in sync with scripts/install-libmpv-linux.sh).
#[cfg(target_os = "linux")]
const INSTALL_SCRIPT: &str = include_str!("../../../scripts/install-libmpv-linux.sh");

/// Run the auto-install script to download and extract libmpv.so.2.
///
/// On success returns the path where libmpv.so.2 was installed.
/// On failure returns a descriptive error string.
#[cfg(target_os = "linux")]
pub fn ensure_libmpv_installed() -> Result<String, String> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    // Already installed locally — fast path
    let local = local_libmpv_path();
    if local.exists() {
        return Ok(local.to_string_lossy().to_string());
    }

    // Ensure the target directory exists
    let dir = local_libmpv_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("No se pudo crear {dir:?}: {e}"))?;

    // Write the embedded script to a temp file
    let script_dir = std::env::temp_dir().join("walactv-libmpv-install");
    std::fs::create_dir_all(&script_dir)
        .map_err(|e| format!("No se pudo crear temp dir: {e}"))?;

    let script_path = script_dir.join("install-libmpv-linux.sh");
    {
        let mut file = std::fs::File::create(&script_path)
            .map_err(|e| format!("No se pudo crear script temporal: {e}"))?;
        file.write_all(INSTALL_SCRIPT.as_bytes())
            .map_err(|e| format!("No se pudo escribir script temporal: {e}"))?;
        // Make executable
        let metadata = file.metadata()
            .map_err(|e| format!("No se pudo leer metadata: {e}"))?;
        let mut perms = metadata.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms)
            .map_err(|e| format!("No se pudo hacer script ejecutable: {e}"))?;
    }

    // Run the script
    let output = std::process::Command::new("bash")
        .arg(&script_path)
        .output()
        .map_err(|e| format!("No se pudo ejecutar el script de instalacion: {e}"))?;

    // Capture stdout and stderr
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    // Cleanup temp script
    let _ = std::fs::remove_file(&script_path);

    if output.status.success() {
        if local.exists() {
            log::info!("libmpv auto-install succeeded: {}", stdout.trim());
            Ok(local.to_string_lossy().to_string())
        } else {
            // Script claimed success but file doesn't exist
            let msg = format!(
                "El script de instalacion reporto exito pero {} no existe.\n\
                 Script output:\n{stdout}\n{stderr}",
                local.display()
            );
            Err(msg)
        }
    } else {
        let msg = format!(
            "No se pudo instalar libmpv automaticamente.\n\
             Script output:\n{stdout}\n{stderr}\n\
             Instalalo manualmente segun tu distro:\n  \
             Debian/Ubuntu: sudo apt install libmpv-dev\n  \
             Fedora:       sudo dnf install mpv-libs-devel\n  \
             Arch:         sudo pacman -S mpv\n  \
             openSUSE:     sudo zypper install mpv-devel"
        );
        Err(msg)
    }
}

/// Non-Linux stub: on Windows/macOS, libmpv is bundled or installed via
/// Homebrew — auto-install is not needed.
#[cfg(not(target_os = "linux"))]
pub fn ensure_libmpv_installed() -> Result<String, String> {
    Err("Auto-install no soportado en esta plataforma.".to_string())
}

// ---------------------------------------------------------------------------
// C string helpers
// ---------------------------------------------------------------------------

/// Helper trait to convert an mpv C string to a Rust String.
/// The caller must ensure the pointer is valid and will free it via mpv_free
/// if it was allocated by mpv.
pub(crate) unsafe fn c_str_to_string(ptr: *const c_char) -> Option<String> {
    if ptr.is_null() {
        None
    } else {
        CStr::from_ptr(ptr).to_str().ok().map(String::from)
    }
}
