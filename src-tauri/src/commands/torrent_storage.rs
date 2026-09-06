//! In-memory torrent storage with bounded RAM and a disk spill tier.
//!
//! Pieces live in RAM up to the configured budget (default 2GB, user
//! configurable). Once the budget is exceeded, the oldest completed pieces
//! are moved to small per-piece files under the OS temp dir instead of being
//! discarded. Reads check RAM first, then the spill files.
//!
//! Why the spill tier exists: rqbit's chunk tracker keeps a piece marked as
//! "have" once downloaded. If we discarded the bytes (as the pure sliding
//! window did), any re-read of an evicted range — resume after pause,
//! reconnect, demuxer re-probe, seek back — failed in `pread_exact`, which
//! broke the HTTP stream and stalled playback permanently with no error
//! surfaced (mpv sat cache-empty forever). With the spill tier the bytes are
//! always servable, so `have` stays truthful and playback recovers.
//!
//! Bounds and cleanup:
//! - RAM stays bounded by the user's budget (`budget_bytes == 0` disables
//!   eviction entirely, same as before).
//! - Spilled bytes are bounded by the torrent size itself and are transient:
//!   each storage instance gets a unique spill dir which is removed when the
//!   storage is dropped (torrent stop/unload). Stale dirs from crashes are
//!   swept at engine start (see `sweep_stale_spill_dirs`).
//!
//! Tradeoff: re-reads served from disk are slower than RAM, but they only
//! happen on seeks/reconnects, never during linear playback (the hot window
//! stays in RAM).

use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use anyhow::Context;
use librqbit::{
    storage::{BoxStorageFactory, StorageFactory, StorageFactoryExt, TorrentStorage},
    FileInfos, ManagedTorrentShared, TorrentMetadata,
};
use librqbit_core::lengths::{Lengths, ValidPieceIndex};
use parking_lot::RwLock;

const MB: u64 = 1024 * 1024;

/// Sweep spill dirs older than this (crash leftovers). Live instances always
/// use fresh dirs, so age-based sweeping can never touch active data.
const STALE_SPILL_AGE_SECS: u64 = 24 * 3600;

static SPILL_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

fn spill_root() -> PathBuf {
    std::env::temp_dir().join(format!("walactv-spill-{}", std::process::id()))
}

/// Remove spill dirs from previous runs (identified by age, never by name
/// alone, so concurrently running instances are unaffected).
pub fn sweep_stale_spill_dirs() -> u32 {
    let temp = std::env::temp_dir();
    let entries = std::fs::read_dir(&temp).map(|r| r.collect::<Vec<_>>()).unwrap_or_default();
    let mut removed = 0u32;
    for entry in entries.into_iter().flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("walactv-spill-") || !path.is_dir() {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .and_then(|t| t.elapsed().map_err(|_| std::io::Error::other("clock skew")))
            .map(|age| age.as_secs() > STALE_SPILL_AGE_SECS)
            .unwrap_or(false);
        if stale && std::fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        eprintln!("[torrent-storage] limpieza: {removed} dirs spill huerfanos eliminados");
    }
    removed
}

/// Storage factory carrying the byte budget. `budget_bytes == 0` means
/// unlimited (eviction disabled).
#[derive(Clone)]
pub struct BudgetStorageFactory {
    budget_bytes: u64,
}

impl BudgetStorageFactory {
    pub fn new(max_download_mb: u64) -> Self {
        Self {
            budget_bytes: if max_download_mb == 0 {
                0
            } else {
                max_download_mb.saturating_mul(MB)
            },
        }
    }
}

impl StorageFactory for BudgetStorageFactory {
    type Storage = BudgetStorage;

    fn create(
        &self,
        _shared: &ManagedTorrentShared,
        metadata: &TorrentMetadata,
    ) -> anyhow::Result<BudgetStorage> {
        BudgetStorage::new(
            *metadata.lengths(),
            metadata.file_infos.clone(),
            self.budget_bytes,
        )
    }

    fn clone_box(&self) -> BoxStorageFactory {
        self.clone().boxed()
    }
}

struct PieceData {
    bytes: Box<[u8]>,
    /// Whether this piece was already counted in `stored_bytes`/`order`.
    /// Chunks arrive through `pwrite_all` (which pre-inserts the entry)
    /// before rqbit reports completion, so completion must not early-return
    /// on presence alone — otherwise the budget would never engage and RAM
    /// would grow unbounded.
    counted: bool,
}

struct Inner {
    lengths: Lengths,
    file_infos: FileInfos,
    pieces: HashMap<ValidPieceIndex, PieceData>,
    order: VecDeque<ValidPieceIndex>,
    budget_bytes: u64,
    stored_bytes: u64,
    evicted_pieces: u64,
    /// Reads that found neither RAM nor spill data (piece genuinely missing).
    /// A spike here means the player asked for never-downloaded ranges.
    pread_misses: u64,
    /// Unique dir for spilled pieces. Created lazily on first spill so small
    /// torrents never touch disk. `None` is also the "already moved" state
    /// used by `take()` to avoid double-deleting the dir on drop.
    spill_dir: Option<PathBuf>,
}

pub struct BudgetStorage {
    inner: RwLock<Inner>,
}

impl BudgetStorage {
    fn new(lengths: Lengths, file_infos: FileInfos, budget_bytes: u64) -> anyhow::Result<Self> {
        Ok(Self {
            inner: RwLock::new(Inner {
                lengths,
                file_infos,
                pieces: HashMap::new(),
                order: VecDeque::new(),
                budget_bytes,
                stored_bytes: 0,
                evicted_pieces: 0,
                pread_misses: 0,
                spill_dir: None,
            }),
        })
    }

    fn piece_for_offset(&self, file_id: usize, offset: u64) -> anyhow::Result<(ValidPieceIndex, usize)> {
        let g = self.inner.read();
        let fi = &g.file_infos[file_id];
        let abs_offset = fi.offset_in_torrent + offset;
        let piece_len = g.lengths.default_piece_length() as u64;
        let piece_id: u32 = (abs_offset / piece_len).try_into()?;
        let piece_offset = abs_offset % piece_len;
        let piece_id = g
            .lengths
            .validate_piece_index(piece_id)
            .context("piece index invalido")?;
        Ok((piece_id, piece_offset as usize))
    }

    fn spill_path(dir: &Path, piece_id: ValidPieceIndex) -> PathBuf {
        dir.join(format!("piece-{}.bin", piece_id.get()))
    }

    /// Move one RAM piece to its spill file. Returns true when the piece no
    /// longer occupies RAM (spilled or was already gone).
    fn spill_one(g: &mut Inner, piece_id: ValidPieceIndex) -> bool {
        let dir = match g.spill_dir.clone() {
            Some(dir) => dir,
            None => {
                let dir = spill_root().join(format!(
                    "t-{}-{}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or_default(),
                    SPILL_DIR_COUNTER.fetch_add(1, Ordering::Relaxed),
                ));
                if std::fs::create_dir_all(&dir).is_err() {
                    return false;
                }
                g.spill_dir = Some(dir.clone());
                eprintln!("[torrent-storage] spill a disco activado: {}", dir.display());
                dir
            }
        };
        let Some(piece) = g.pieces.remove(&piece_id) else {
            return true;
        };
        let path = Self::spill_path(&dir, piece_id);
        if std::fs::write(&path, &piece.bytes).is_err() {
            // Disk failed: put the bytes back so `have` stays truthful.
            g.pieces.insert(piece_id, piece);
            return false;
        }
        g.stored_bytes = g.stored_bytes.saturating_sub(piece.bytes.len() as u64);
        g.evicted_pieces += 1;
        true
    }
}

impl Drop for BudgetStorage {
    fn drop(&mut self) {
        if let Some(dir) = self.inner.get_mut().spill_dir.take() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

impl TorrentStorage for BudgetStorage {
    fn init(
        &mut self,
        _shared: &ManagedTorrentShared,
        _metadata: &TorrentMetadata,
    ) -> anyhow::Result<()> {
        Ok(())
    }

    fn pread_exact(&self, file_id: usize, offset: u64, buf: &mut [u8]) -> anyhow::Result<()> {
        let (piece_id, piece_offset) = self.piece_for_offset(file_id, offset)?;
        // Fast path: RAM.
        {
            let g = self.inner.read();
            if let Some(piece) = g.pieces.get(&piece_id) {
                buf.copy_from_slice(&piece.bytes[piece_offset..piece_offset + buf.len()]);
                return Ok(());
            }
        }
        // Slow path: spill file (seek-back / reconnect / resume re-read).
        let path = {
            let g = self.inner.read();
            g.spill_dir.as_ref().map(|dir| Self::spill_path(dir, piece_id))
        };
        if let Some(path) = path {
            if let Ok(bytes) = std::fs::read(&path) {
                if piece_offset + buf.len() <= bytes.len() {
                    buf.copy_from_slice(&bytes[piece_offset..piece_offset + buf.len()]);
                    return Ok(());
                }
            }
        }
        let mut g = self.inner.write();
        g.pread_misses += 1;
        if g.pread_misses % 32 == 1 {
            eprintln!(
                "[torrent-storage] pread sin datos: pieza {piece_id:?} no disponible (fallos={})",
                g.pread_misses
            );
        }
        anyhow::bail!("pieza {piece_id:?} no disponible (no descargada)")
    }

    fn pwrite_all(&self, file_id: usize, offset: u64, buf: &[u8]) -> anyhow::Result<()> {
        let (piece_id, piece_offset) = self.piece_for_offset(file_id, offset)?;
        let mut g = self.inner.write();
        let piece_len = g.lengths.default_piece_length() as usize;
        let entry = g
            .pieces
            .entry(piece_id)
            .or_insert_with(|| PieceData {
                bytes: vec![0; piece_len].into_boxed_slice(),
                counted: false,
            });
        let end = piece_offset + buf.len();
        entry.bytes[piece_offset..end].copy_from_slice(buf);
        Ok(())
    }

    fn remove_file(&self, _file_id: usize, _filename: &Path) -> anyhow::Result<()> {
        Ok(())
    }

    fn remove_directory_if_empty(&self, _path: &Path) -> anyhow::Result<()> {
        Ok(())
    }

    fn ensure_file_length(&self, _file_id: usize, _length: u64) -> anyhow::Result<()> {
        Ok(())
    }

    fn take(&self) -> anyhow::Result<Box<dyn TorrentStorage>> {
        let mut g = self.inner.write();
        let pieces = std::mem::take(&mut g.pieces).into_iter().collect();
        let order = std::mem::take(&mut g.order);
        let spill_dir = g.spill_dir.take();
        Ok(Box::new(BudgetStorage {
            inner: RwLock::new(Inner {
                lengths: g.lengths,
                file_infos: g.file_infos.clone(),
                pieces,
                order,
                budget_bytes: g.budget_bytes,
                stored_bytes: 0,
                evicted_pieces: g.evicted_pieces,
                pread_misses: g.pread_misses,
                spill_dir,
            }),
        }))
    }

    fn on_piece_completed(&self, piece_id: ValidPieceIndex) -> anyhow::Result<()> {
        let mut g = self.inner.write();
        // The entry always exists here (chunks arrive via pwrite_all first),
        // so presence alone must not skip accounting — use the flag instead.
        if let Some(entry) = g.pieces.get_mut(&piece_id) {
            if entry.counted {
                return Ok(());
            }
            entry.counted = true;
        }
        g.order.push_back(piece_id);
        let len = g.lengths.default_piece_length() as u64;
        g.stored_bytes += len;
        if g.budget_bytes > 0 {
            while g.stored_bytes > g.budget_bytes && g.order.len() > 1 {
                let oldest = g
                    .order
                    .pop_front()
                    .expect("order no vacio mientras len > 1");
                if !Self::spill_one(&mut g, oldest) {
                    // Spill failed (disk error): stop this round, keep the
                    // bytes in RAM so `have` stays truthful. Retry next time.
                    g.order.push_front(oldest);
                    eprintln!("[torrent-storage] spill fallido, pausa de descarte");
                    break;
                }
            }
            if g.evicted_pieces > 0 && g.evicted_pieces % 32 == 0 {
                eprintln!(
                    "[torrent-storage] piezas en spill={} piezas_ram={} ram_aprox={}MB budget={}MB",
                    g.evicted_pieces,
                    g.order.len(),
                    g.stored_bytes / MB,
                    g.budget_bytes / MB
                );
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use librqbit::file_info::FileInfo;
    use librqbit_core::torrent_metainfo::FileDetailsAttrs;

    const PIECE_LEN: u32 = 16 * 1024;

    fn single_file_storage(budget_mb: u64, total_bytes: u64) -> (BudgetStorage, u32) {
        let lengths = Lengths::new(total_bytes, PIECE_LEN).expect("lengths");
        let total_pieces = total_bytes.div_ceil(PIECE_LEN as u64) as usize;
        let file_infos: FileInfos = vec![FileInfo {
            relative_filename: PathBuf::from("video.mkv"),
            offset_in_torrent: 0,
            piece_range: 0..total_pieces as u32,
            attrs: FileDetailsAttrs::default(),
            len: total_bytes,
        }];
        let storage = BudgetStorage::new(lengths, file_infos, budget_mb * MB).expect("storage");
        (storage, total_pieces as u32)
    }

    fn write_full_piece(storage: &BudgetStorage, piece_id: u32) {
        let idx = storage
            .inner
            .read()
            .lengths
            .validate_piece_index(piece_id)
            .expect("valid piece");
        let total = storage.inner.read().lengths.total_length();
        let start = piece_id as u64 * PIECE_LEN as u64;
        let len = ((total - start).min(PIECE_LEN as u64)) as usize;
        let data = vec![(piece_id % 251) as u8; len];
        storage.pwrite_all(0, start, &data).expect("write piece");
        storage.on_piece_completed(idx).expect("completed");
    }

    fn read_at(storage: &BudgetStorage, offset: u64, len: usize) -> Vec<u8> {
        let mut buf = vec![0u8; len];
        storage.pread_exact(0, offset, &mut buf).expect("read");
        buf
    }

    #[test]
    fn spilled_pieces_stay_readable() {
        // 8 pieces of 16 KiB with a ~4-piece (64 KiB) budget: completing all
        // forces the oldest ones to spill to disk.
        let total = PIECE_LEN as u64 * 8;
        let lengths = Lengths::new(total, PIECE_LEN).expect("lengths");
        let file_infos: FileInfos = vec![FileInfo {
            relative_filename: PathBuf::from("video.mkv"),
            offset_in_torrent: 0,
            piece_range: 0..8,
            attrs: FileDetailsAttrs::default(),
            len: total,
        }];
        let storage = BudgetStorage::new(lengths, file_infos, 64 * 1024).expect("storage");
        for piece_id in 0..8u32 {
            let start = piece_id as u64 * PIECE_LEN as u64;
            let data = vec![(piece_id % 251) as u8; PIECE_LEN as usize];
            storage.pwrite_all(0, start, &data).expect("write");
            let idx = storage
                .inner
                .read()
                .lengths
                .validate_piece_index(piece_id)
                .expect("valid");
            storage.on_piece_completed(idx).expect("completed");
        }
        // Oldest pieces must have spilled (RAM capped at ~4 pieces).
        assert!(storage.inner.read().evicted_pieces > 0);
        // …but every byte of the file must still read back correctly.
        for piece_id in 0..8u32 {
            let start = piece_id as u64 * PIECE_LEN as u64;
            let got = read_at(&storage, start, PIECE_LEN as usize);
            assert_eq!(got, vec![(piece_id % 251) as u8; PIECE_LEN as usize]);
        }
    }

    #[test]
    fn missing_piece_still_errors() {
        let total = PIECE_LEN as u64 * 2;
        let (storage, _) = single_file_storage(0, total);
        let mut buf = vec![0u8; 16];
        assert!(storage.pread_exact(0, 0, &mut buf).is_err());
    }

    #[test]
    fn unlimited_budget_never_spills() {
        let total = PIECE_LEN as u64 * 4;
        let (storage, total_pieces) = single_file_storage(0, total);
        for piece_id in 0..total_pieces {
            write_full_piece(&storage, piece_id);
        }
        assert_eq!(storage.inner.read().evicted_pieces, 0);
        assert!(storage.inner.read().spill_dir.is_none());
    }
}
