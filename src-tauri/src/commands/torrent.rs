//! Tauri commands for local BitTorrent playback.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use librqbit::api::TorrentIdOrHash;
use librqbit::http_api::{HttpApi, HttpApiOptions};
use librqbit::storage::StorageFactoryExt;
use librqbit::tracing_subscriber_config_utils::{init_logging, InitLoggingOptions, LineBroadcast};
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, Api, ConnectionOptions, DhtSessionConfig,
    ListenerMode, ListenerOptions, ManagedTorrent, Session, SessionOptions, TorrentStatsState,
};
use librqbit_dualstack_sockets::TcpListener;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::commands::torrent_storage::{sweep_stale_spill_dirs, BudgetStorageFactory};

const VIDEO_EXTENSIONS: &[&str] = &[
    "avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ts", "webm", "wmv",
];

pub struct TorrentEngine {
    session: Arc<Session>,
    http_port: u16,
}

pub struct TorrentState {
    engine: tokio::sync::Mutex<Option<Arc<TorrentEngine>>>,
}

impl TorrentState {
    pub fn new() -> Self {
        Self {
            engine: tokio::sync::Mutex::new(None),
        }
    }

    async fn get_or_create(&self, app: &AppHandle) -> Result<Arc<TorrentEngine>, String> {
        let mut guard = self.engine.lock().await;
        if let Some(engine) = guard.as_ref() {
            return Ok(Arc::clone(engine));
        }

        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("No se pudo resolver el directorio de datos: {error}"))?;
        let torrent_dir = data_dir.join("torrents");
        std::fs::create_dir_all(&torrent_dir)
            .map_err(|error| format!("No se pudo crear el directorio torrent: {error}"))?;

        // Clean up leftover media data from older disk-based runs and
        // interrupted sessions. Spilled pieces live under the OS temp dir
        // (see sweep_stale_spill_dirs), never here, so the whole directory
        // is stale if present.
        if let Ok(entries) = std::fs::read_dir(&torrent_dir) {            let mut removed = 0u32;
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if std::fs::remove_dir_all(&path).is_ok() {
                        removed += 1;
                    }
                } else if std::fs::remove_file(&path).is_ok() {
                    removed += 1;
                }
            }
            if removed > 0 {
                eprintln!("[torrent] limpieza: {removed} entradas huerfanas eliminadas");
            }
        }

        // Spill files from crashed sessions (see torrent_storage.rs). Only
        // day-old dirs are removed, so live instances are never affected.
        sweep_stale_spill_dirs();

        let session = Session::new_with_opts(
            torrent_dir,
            SessionOptions {
                dht: Some(DhtSessionConfig {
                    persistence: None,
                    ..Default::default()
                }),
                listen: Some(ListenerOptions {
                    mode: ListenerMode::TcpOnly,
                    listen_addr: SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)),
                    enable_upnp_port_forwarding: false,
                    ..Default::default()
                }),
                connect: Some(ConnectionOptions::default()),
                ipv4_only: true,
                ..Default::default()
            },
        )
        .await
        .map_err(|error| format!("No se pudo iniciar rqbit: {error:#}"))?;

        let listener = TcpListener::bind_tcp(
            SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
            Default::default(),
        )
        .map_err(|error| format!("No se pudo abrir el servidor local torrent: {error}"))?;
        let http_port = listener.bind_addr().port();
        let logging = init_logging(InitLoggingOptions {
            default_rust_log_value: Some("librqbit=warn"),
            log_file: None,
            log_file_rust_log: None,
            log_file_json: false,
        });
        let (reload_tx, line_broadcast): (
            tokio::sync::mpsc::UnboundedSender<String>,
            LineBroadcast,
        ) = match logging {
            Ok(logging) => (logging.rust_log_reload_tx, logging.line_broadcast),
            Err(error) => {
                log::debug!("Logging rqbit ya estaba inicializado: {error:#}");
                let (reload_tx, _reload_rx) = tokio::sync::mpsc::unbounded_channel();
                let (line_broadcast, _receiver) = tokio::sync::broadcast::channel(16);
                (reload_tx, line_broadcast)
            }
        };
        let api = Api::new(session.clone(), Some(reload_tx), Some(line_broadcast));
        let http_api = HttpApi::new(
            api,
            Some(HttpApiOptions {
                read_only: false,
                ..Default::default()
            }),
        );

        tauri::async_runtime::spawn(async move {
            if let Err(error) = http_api.make_http_api_and_run(listener, None).await {
                log::error!("Servidor HTTP torrent detenido: {error:#}");
            }
        });

        let engine = Arc::new(TorrentEngine { session, http_port });
        *guard = Some(Arc::clone(&engine));
        Ok(engine)
    }
}

impl Default for TorrentState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentStartRequest {
    pub info_hash: String,
    pub file_idx: Option<usize>,
    pub max_download_mb: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentStreamInfo {
    pub url: String,
    pub info_hash: String,
    pub file_idx: usize,
}

fn choose_file_idx(handle: &Arc<ManagedTorrent>) -> Result<usize, String> {
    handle
        .with_metadata(|metadata| {
            let files: Vec<_> = metadata.info.iter_file_details().enumerate().collect();
            files
                .iter()
                .filter(|(_, file)| {
                    file.filename
                        .to_string()
                        .rsplit('.')
                        .next()
                        .map(|extension| {
                            VIDEO_EXTENSIONS.contains(&extension.to_lowercase().as_str())
                        })
                        .unwrap_or(false)
                })
                .max_by_key(|(_, file)| file.len)
                .or_else(|| files.iter().max_by_key(|(_, file)| file.len))
                .map(|(index, _)| *index)
                .ok_or_else(|| "El torrent no contiene archivos reproducibles".to_string())
        })
        .map_err(|error| format!("No se pudo leer la metadata torrent: {error:#}"))?
}

fn validate_file_idx(handle: &Arc<ManagedTorrent>, file_idx: usize) -> Result<(), String> {
    let file_count = handle
        .with_metadata(|metadata| metadata.info.iter_file_details().count())
        .map_err(|error| format!("No se pudo leer la metadata torrent: {error:#}"))?;
    if file_idx >= file_count {
        return Err(format!(
            "El archivo torrent {file_idx} no existe (hay {file_count} archivos)"
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn torrent_start(
    app: AppHandle,
    state: State<'_, TorrentState>,
    request: TorrentStartRequest,
) -> Result<TorrentStreamInfo, String> {
    let info_hash = request.info_hash.trim().to_ascii_lowercase();
    if !info_hash
        .chars()
        .all(|character| character.is_ascii_hexdigit())
        || info_hash.len() != 40
    {
        return Err("infoHash torrent invalido".to_string());
    }

    let engine = state.get_or_create(&app).await?;
    let max_mb = request.max_download_mb.unwrap_or(2048);
    let add_options = AddTorrentOptions {
        only_files: request.file_idx.map(|file_idx| vec![file_idx]),
        overwrite: true,
        storage_factory: Some(BudgetStorageFactory::new(max_mb).boxed()),
        ..Default::default()
    };
    let magnet = format!("magnet:?xt=urn:btih:{info_hash}");
    let response = engine
        .session
        .add_torrent(AddTorrent::from_url(magnet), Some(add_options))
        .await
        .map_err(|error| format!("No se pudo resolver el magnet: {error:#}"))?;
    let handle = match response {
        AddTorrentResponse::Added(_, handle) | AddTorrentResponse::AlreadyManaged(_, handle) => {
            handle
        }
        AddTorrentResponse::ListOnly(_) => {
            return Err("rqbit devolvio metadata sin iniciar el torrent".to_string());
        }
    };

    let file_idx = match request.file_idx {
        Some(file_idx) => {
            validate_file_idx(&handle, file_idx)?;
            file_idx
        }
        None => choose_file_idx(&handle)?,
    };
    handle
        .wait_until_initialized()
        .await
        .map_err(|error| format!("No se pudo inicializar el torrent: {error:#}"))?;
    let actual_hash = handle.info_hash().as_string();
    Ok(TorrentStreamInfo {
        url: format!(
            "http://127.0.0.1:{}/torrents/{actual_hash}/stream/{file_idx}",
            engine.http_port
        ),
        info_hash: actual_hash,
        file_idx,
    })
}

#[tauri::command]
pub async fn torrent_stop(state: State<'_, TorrentState>, info_hash: String) -> Result<(), String> {
    let info_hash = info_hash.trim().to_ascii_lowercase();
    let guard = state.engine.lock().await;
    let Some(engine) = guard.as_ref() else {
        return Ok(());
    };
    let torrent = TorrentIdOrHash::try_from(info_hash.as_str())
        .map_err(|error| format!("infoHash torrent invalido: {error:#}"))?;
    engine
        .session
        .delete(torrent, true)
        .await
        .map_err(|error| format!("No se pudo limpiar el torrent: {error:#}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentStatsDto {
    /// Metadata recibida y torrent en marcha.
    pub ready: bool,
    pub finished: bool,
    pub total_bytes: u64,
    pub progress_bytes: u64,
    /// Velocidad de descarga en bytes/segundo.
    pub download_rate_bps: u64,
}

/// Estadisticas en vivo del torrent activo (para el overlay de carga).
#[tauri::command]
pub async fn torrent_stats(
    state: State<'_, TorrentState>,
    info_hash: String,
) -> Result<TorrentStatsDto, String> {
    let info_hash = info_hash.trim().to_ascii_lowercase();
    let guard = state.engine.lock().await;
    let Some(engine) = guard.as_ref() else {
        return Err("Motor torrent no iniciado".to_string());
    };
    let torrent = TorrentIdOrHash::try_from(info_hash.as_str())
        .map_err(|error| format!("infoHash torrent invalido: {error:#}"))?;
    let handle: Arc<ManagedTorrent> = engine
        .session
        .get(torrent)
        .ok_or_else(|| "Torrent no activo".to_string())?;
    let stats = handle.stats();
    let (download_rate_bps, ready) = match stats.live {
        Some(live) => (live.download_speed.as_bytes(), true),
        None => (
            0,
            matches!(stats.state, TorrentStatsState::Live),
        ),
    };
    Ok(TorrentStatsDto {
        ready,
        finished: stats.finished,
        total_bytes: stats.total_bytes,
        progress_bytes: stats.progress_bytes,
        download_rate_bps,
    })
}
