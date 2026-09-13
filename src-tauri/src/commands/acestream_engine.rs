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
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tauri::Manager;

/// Script de auto-instalacion user-space (Linux). Ver scripts/.
#[cfg(target_os = "linux")]
const INSTALL_SCRIPT: &str = include_str!("../../../scripts/install-acestream-linux.sh");
#[cfg(target_os = "linux")]
const BUNDLE_MARKER: &str = "walactv-acestream-bundle-v1";

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
    /// Linux: la app puede auto-instalar el bundle user-space.
    pub can_install: bool,
}

fn port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

fn status_of(state: &AcestreamEngineState) -> EngineStatus {
    let can_install = cfg!(target_os = "linux");
    if state.managed_alive() {
        return EngineStatus {
            mode: "managed".to_string(),
            managed: true,
            port: ENGINE_PORT,
            can_install,
        };
    }
    if port_open(ENGINE_PORT) {
        return EngineStatus {
            mode: "external".to_string(),
            managed: false,
            port: ENGINE_PORT,
            can_install,
        };
    }
    EngineStatus {
        mode: "off".to_string(),
        managed: false,
        port: ENGINE_PORT,
        can_install,
    }
}

/// Candidate (binary, args) pairs, first existing one wins.
fn engine_candidates() -> Vec<(PathBuf, Vec<String>)> {
    #[cfg(target_os = "linux")]
    {
        vec![
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
        ]
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
        out
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        Vec::new()
    }
}

fn candidate_exists(bin: &Path) -> bool {
    if bin.is_absolute() {
        return bin.is_file();
    }
    // PATH lookup for bare names (e.g. acestreamplayer.engine from snap bin).
    std::env::var_os("PATH").is_some_and(|paths| {
        std::env::split_paths(&paths).any(|dir| dir.join(bin).is_file())
    })
}

/// Directorio del bundle user-space (Linux). None si no se puede resolver.
#[cfg(target_os = "linux")]
fn bundled_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("acestream"))
}

/// Bundle valido: binario + python portable + pylibs + marcador de version.
#[cfg(target_os = "linux")]
fn bundled_valid(dir: &Path) -> bool {
    if !dir.join("acestreamengine").is_file() { return false; }
    if !dir.join("python/bin/python3").exists() { return false; }
    if !dir.join("pylibs").is_dir() { return false; }
    std::fs::read_to_string(dir.join(".walactv-bundle"))
        .map(|s| s.contains(BUNDLE_MARKER))
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn bundled_state_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("acestream-state"))
}

/// Mata restos huerfanos de nuestro engine (p. ej. SIGKILL de la app, que no
/// pasa por CloseRequested). Solo toca procesos con NUESTRO state-dir en su
/// cmdline, nunca el engine del usuario. Sin dependencias (lee /proc).
#[cfg(target_os = "linux")]
fn kill_stale_bundled(state_dir: &Path) {
    let marker = state_dir.display().to_string();
    let own_pid = std::process::id();
    let procs = std::fs::read_dir("/proc").map(|rd| {
        rd.filter_map(|entry| {
            let entry = entry.ok()?;
            let pid: u32 = entry.file_name().to_str()?.parse().ok()?;
            Some((pid, entry.path().join("cmdline")))
        })
        .collect::<Vec<_>>()
    });
    let procs = match procs {
        Ok(p) => p,
        Err(_) => return,
    };
    for (pid, cmdline_path) in procs {
        if pid == own_pid {
            continue;
        }
        let cmdline = std::fs::read(&cmdline_path).unwrap_or_default();
        // cmdline va separada por NULs; basta con buscar el state-dir dentro.
        if cmdline.windows(marker.len()).any(|w| w == marker.as_bytes()) {
            log::info!("acestream-sidecar: limpiando huerfano pid={pid}");
            // SIGTERM primero; el engine suele salir limpio.
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
    }
    // Espera breve a que liberen el puerto antes de spawnear.
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if !port_open(ENGINE_PORT) {
            break;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

/// Lanza un binario con env propio y espera a que abra el puerto.
fn launch_and_wait(
    bin: &PathBuf,
    args: &[String],
    extra_env: &[(String, String)],
    state: &tauri::State<'_, AcestreamEngineState>,
) -> Result<EngineStatus, String> {
    log::info!("acestream-sidecar: lanzando {}", bin.display());
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: sin consola visible del engine.
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("No se pudo lanzar {}: {e}", bin.display()))?;
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if port_open(ENGINE_PORT) {
            *state.inner.lock() = Some(child);
            log::info!("acestream-sidecar: engine gestionado listo");
            return Ok(status_of(state));
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(format!(
                    "El engine ({}) se cerro al arrancar (exit {}).",
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
    Err("El engine tardo demasiado en arrancar (25s). Revisa firewall/antivirus.".to_string())
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
    // Linux: el bundle user-space (auto-instalable) va primero.
    #[cfg(target_os = "linux")]
    if let Some(dir) = bundled_dir(&app) {
        if bundled_valid(&dir) {
            if let Some(state_path) = bundled_state_dir(&app) {
                kill_stale_bundled(&state_path);
            }
            let state_dir = bundled_state_dir(&app)
                .map(|d| d.display().to_string())
                .unwrap_or_default();
            let lib = dir.join("lib").display().to_string();
            let pylib = dir.join("python/lib").display().to_string();
            let envs = vec![
                (
                    "LD_LIBRARY_PATH".to_string(),
                    format!("{lib}:{pylib}"),
                ),
                (
                    "PYTHONHOME".to_string(),
                    dir.join("python").display().to_string(),
                ),
                (
                    "PYTHONPATH".to_string(),
                    dir.join("pylibs").display().to_string(),
                ),
            ];
            let args: Vec<String> = [
                "--lib-path",
                &dir.display().to_string(),
                "--disable-sentry",
                "--client-console",
                "--state-dir",
                &state_dir,
            ]
            .iter()
            .map(|s| s.to_string())
            .collect();
            return launch_and_wait(&dir.join("acestreamengine"), &args, &envs, &state);
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    let _ = &app;

    let mut tried: Vec<String> = Vec::new();
    for (bin, args) in candidates {
        if !candidate_exists(&bin) {
            continue;
        }
        tried.push(bin.display().to_string());
        match launch_and_wait(&bin, &args, &[], &state) {
            Ok(status) => return Ok(status),
            Err(e) => {
                log::warn!("acestream-sidecar: fallo {}: {e}", bin.display());
                // Si el puerto se abrio entre medias (otro engine), reusar.
                if port_open(ENGINE_PORT) {
                    return Ok(status_of(&state));
                }
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
            "No hay engine Acestream instalado. Puedes instalarlo con un clic\n\
             desde el panel de prueba, o manual (`sudo snap install acestreamplayer`)."
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

fn tail_text(bytes: &[u8], max_chars: usize) -> String {
    let s = String::from_utf8_lossy(bytes);
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max_chars {
        return s.into_owned();
    }
    chars[chars.len() - max_chars..].iter().collect()
}

/// Auto-instala el bundle user-space (Linux, ~250 MB en disco, ~110 MB de
/// descarga). Bloqueante durante minutos: llamar solo bajo accion del usuario.
#[tauri::command]
pub fn acestream_engine_install(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = &app;
        return Err("La auto-instalacion solo esta disponible en Linux.".to_string());
    }
    #[cfg(target_os = "linux")]
    {
        let dir = bundled_dir(&app)
            .ok_or_else(|| "No se pudo resolver el directorio de datos.".to_string())?;
        if bundled_valid(&dir) {
            return Ok(dir.display().to_string());
        }
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("No se pudo crear {}: {e}", dir.display()))?;
        let script_path = std::env::temp_dir().join("walactv-install-acestream.sh");
        std::fs::write(&script_path, INSTALL_SCRIPT)
            .map_err(|e| format!("No se pudo preparar el instalador: {e}"))?;
        log::info!("acestream-sidecar: instalando bundle en {}", dir.display());
        let out = Command::new("bash")
            .arg(&script_path)
            .arg(&dir)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("No se pudo ejecutar el instalador: {e}"))?;
        let _ = std::fs::remove_file(&script_path);
        if !out.status.success() {
            return Err(format!(
                "La instalacion fallo:\n{}",
                tail_text(&out.stderr, 1500)
            ));
        }
        if !bundled_valid(&dir) {
            return Err("El instalador termino pero el bundle quedo incompleto.".to_string());
        }
        log::info!("acestream-sidecar: bundle instalado");
        Ok(dir.display().to_string())
    }
}
