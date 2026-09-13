//! Managed Acestream engine sidecar (spike).
//!
//! UX goal: the engine runs while the app runs, with no manual install step.
//! No downloads at runtime. Windows bundles the official engine subtree
//! (ace_console.exe, via scripts/fetch-acestream-windows.sh in CI); Linux
//! reuses a system engine (no upstream 24.04/py3.12 tarball exists).
//!
//! Strategy:
//! - If 127.0.0.1:6878 answers, use the external engine (user's own).
//! - Otherwise launch a known engine headless as our child process
//!   and kill it on app close (only if we started it).
//!
//! Windows candidates (bundled first, then system):
//! - `<resource_dir>/acestream/ace_console.exe` (bundle propio)
//! - `%APPDATA%/ACEStream/engine/ace_engine.exe`, `%LOCALAPPDATA%`, ... (sistema)
//!
//! Linux candidates (first existing binary wins):
//! - `acestreamplayer.engine --client-console` (snap, includes its runtime)
//! - `/opt/acestream/start-engine --client-console` (manual tarball install)
//! - `/usr/bin/acestreamengine --client-console`
//!
//! macOS: no official engine build exists; ensure() returns a guidance error.

use parking_lot::Mutex;
use serde::Serialize;
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Default engine HTTP API port. Kept in sync with src/acestream/acestream.ts.
const ENGINE_PORT: u16 = 6878;

/// How long to wait for a freshly spawned engine to open its HTTP port.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(25);
const STARTUP_POLL: Duration = Duration::from_millis(500);

pub struct AcestreamEngineState {
    inner: Mutex<Option<Child>>,
}

impl AcestreamEngineState {
    pub fn new() -> Self {
        AcestreamEngineState {
            inner: Mutex::new(None),
        }
    }

    /// Kill the managed child if we started one. Safe to call repeatedly.
    pub fn stop_managed(&self) {
        let child = self.inner.lock().take();
        if let Some(mut child) = child {
            log::info!("acestream-sidecar: deteniendo engine gestionado");
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn managed_alive(&self) -> bool {
        let mut guard = self.inner.lock();
        match guard.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(None) => true,
                _ => {
                    *guard = None;
                    false
                }
            },
            None => false,
        }
    }
}

impl Default for AcestreamEngineState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    /// "external" (engine ajeno en uso), "managed" (hijo nuestro) u "off".
    pub mode: String,
    pub managed: bool,
    pub port: u16,
}

fn port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

fn status_of(state: &AcestreamEngineState) -> EngineStatus {
    if state.managed_alive() {
        return EngineStatus {
            mode: "managed".to_string(),
            managed: true,
            port: ENGINE_PORT,
        };
    }
    if port_open(ENGINE_PORT) {
        return EngineStatus {
            mode: "external".to_string(),
            managed: false,
            port: ENGINE_PORT,
        };
    }
    EngineStatus {
        mode: "off".to_string(),
        managed: false,
        port: ENGINE_PORT,
    }
}

/// Candidate (binary, args) pairs, first existing one wins.
fn engine_candidates() -> Vec<(PathBuf, Vec<String>)> {
    #[cfg(target_os = "linux")]
    {
        return vec![
            (
                PathBuf::from("acestreamplayer.engine"),
                vec!["--client-console".to_string()],
            ),
            (
                PathBuf::from("/opt/acestream/start-engine"),
                vec!["--client-console".to_string()],
            ),
            (
                PathBuf::from("/usr/bin/acestreamengine"),
                vec!["--client-console".to_string()],
            ),
        ];
    }
    #[cfg(target_os = "windows")]
    {
        // Instalaciones tipicas del engine en Windows (todas per-usuario o
        // Program Files segun el instalador). Sin probar en maquina real.
        let mut dirs: Vec<PathBuf> = Vec::new();
        for var in ["APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "ProgramFiles(x86)"] {
            if let Ok(base) = std::env::var(var) {
                dirs.push(PathBuf::from(base));
            }
        }
        // Deduplica (PROGRAMFILES y ProgramFiles(x86) pueden coincidir).
        dirs.sort();
        dirs.dedup();
        let mut out = Vec::new();
        for base in dirs {
            out.push((
                base.join("ACEStream/engine/ace_engine.exe"),
                vec!["--client-console".to_string()],
            ));
            // Variante con espacio (instaladores antiguos).
            out.push((
                base.join("ACE Stream/engine/ace_engine.exe"),
                vec!["--client-console".to_string()],
            ));
        }
        return out;
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        return Vec::new();
    }
}

fn candidate_exists(bin: &PathBuf) -> bool {
    if bin.is_absolute() {
        return bin.is_file();
    }
    // PATH lookup for bare names (e.g. acestreamplayer.engine from snap bin).
    std::env::var_os("PATH").map_or(false, |paths| {
        std::env::split_paths(&paths).any(|dir| dir.join(bin).is_file())
    })
}

/// Ensure an engine is available: reuse external or spawn a managed child.
/// Blocking command (up to STARTUP_TIMEOUT) so Tauri runs it off-thread.
#[tauri::command]
pub fn acestream_engine_ensure(
    app: tauri::AppHandle,
    state: tauri::State<'_, AcestreamEngineState>,
) -> Result<EngineStatus, String> {
    if port_open(ENGINE_PORT) {
        log::info!("acestream-sidecar: usando engine externo en 6878");
        return Ok(status_of(&state));
    }
    if state.managed_alive() {
        return Ok(status_of(&state));
    }

    #[cfg(target_os = "windows")]
    let mut candidates = engine_candidates();
    #[cfg(not(target_os = "windows"))]
    let candidates = engine_candidates();
    // Windows: el engine empaquetado con la app va primero (no requiere
    // instalacion aparte). En dev o Linux sin bundle se omita en silencio.
    #[cfg(target_os = "windows")]
    if let Ok(res_dir) = app.path().resource_dir() {
        let bundled = res_dir.join("acestream").join("ace_console.exe");
        if bundled.is_file() {
            log::info!("acestream-sidecar: usando bundle propio");
            candidates.insert(
                0,
                (bundled, vec!["--client-console".to_string()]),
            );
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = &app;

    let mut tried: Vec<String> = Vec::new();
    for (bin, args) in candidates {
        if !candidate_exists(&bin) {
            continue;
        }
        tried.push(bin.display().to_string());
        log::info!("acestream-sidecar: lanzando {}", bin.display());
        let mut cmd = Command::new(&bin);
        cmd.args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW: sin consola visible del engine.
            cmd.creation_flags(0x08000000);
        }
        match cmd.spawn() {
            Ok(child) => {
                let mut child = child;
                // Nota: sin kill_on_drop (no disponible en este toolchain);
                // el hijo se mata en release/timeout/close (ver stop_managed).
                let deadline = Instant::now() + STARTUP_TIMEOUT;
                while Instant::now() < deadline {
                    if port_open(ENGINE_PORT) {
                        *state.inner.lock() = Some(child);
                        log::info!("acestream-sidecar: engine gestionado listo");
                        return Ok(status_of(&state));
                    }
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            return Err(format!(
                                "El engine ({} ) se cerro al arrancar (exit {}).",
                                bin.display(),
                                status
                            ));
                        }
                        Ok(None) => {}
                        Err(e) => {
                            let _ = child.kill();
                            return Err(format!("No se pudo supervisar el engine: {e}"));
                        }
                    }
                    std::thread::sleep(STARTUP_POLL);
                }
                let _ = child.kill();
                return Err(
                    "El engine tardo demasiado en arrancar (25s). Revisa firewall/antivirus."
                        .to_string(),
                );
            }
            Err(e) => {
                log::warn!("acestream-sidecar: no se pudo lanzar {}: {e}", bin.display());
            }
        }
    }

    if tried.is_empty() {
        #[cfg(target_os = "windows")]
        return Err(
            "No hay engine Acestream instalado. Instala Ace Stream desde\n\
             https://acestream.org y reabre la app (el firewall pedira permiso\n\
             la primera vez)."
                .to_string(),
        );
        #[cfg(target_os = "linux")]
        return Err(
            "No hay engine Acestream instalado. Instala Ace Stream (snap en Linux:\n\
             `sudo snap install acestreamplayer`) y reabre la app."
                .to_string(),
        );
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        return Err("No hay engine Acestream disponible en este sistema.".to_string());
    }
    Err(format!(
        "Ningun engine arranco (probados: {}).",
        tried.join(", ")
    ))
}

#[tauri::command]
pub fn acestream_engine_status(
    state: tauri::State<'_, AcestreamEngineState>,
) -> EngineStatus {
    status_of(&state)
}

/// Stop the managed child (no-op for external engines).
#[tauri::command]
pub fn acestream_engine_release(state: tauri::State<'_, AcestreamEngineState>) {
    state.stop_managed();
}
