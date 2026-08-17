//! In-memory sliding-window torrent storage.
//!
//! Stores torrent pieces in RAM instead of disk, and evicts the oldest
//! completed pieces once the stored bytes exceed the configured budget.
//! Because rqbit streams sequentially (pieces near the playhead are
//! downloaded first and played in order), the oldest pieces are exactly the
//! ones already consumed, so playback is unaffected while disk usage stays 0
//! and RAM stays bounded by the user's budget (default 2GB, configurable).
//!
//! Tradeoff: seeking back to an evicted range fails (the piece data is gone);
//! normal forward playback works uninterrupted.

use std::{
    collections::{HashMap, VecDeque},
    path::Path,
};

use anyhow::Context;
use librqbit::{
    storage::{BoxStorageFactory, StorageFactory, StorageFactoryExt, TorrentStorage},
    FileInfos, ManagedTorrentShared, TorrentMetadata,
};
use librqbit_core::lengths::{Lengths, ValidPieceIndex};
use parking_lot::RwLock;

const MB: u64 = 1024 * 1024;

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
}

struct Inner {
    lengths: Lengths,
    file_infos: FileInfos,
    pieces: HashMap<ValidPieceIndex, PieceData>,
    order: VecDeque<ValidPieceIndex>,
    budget_bytes: u64,
    stored_bytes: u64,
    evicted_pieces: u64,
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
        let g = self.inner.read();
        let piece = g
            .pieces
            .get(&piece_id)
            .with_context(|| format!("pieza {piece_id:?} no disponible (descartada o no descargada)"))?;
        buf.copy_from_slice(&piece.bytes[piece_offset..piece_offset + buf.len()]);
        Ok(())
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
        Ok(Box::new(BudgetStorage {
            inner: RwLock::new(Inner {
                lengths: g.lengths,
                file_infos: g.file_infos.clone(),
                pieces,
                order,
                budget_bytes: g.budget_bytes,
                stored_bytes: 0,
                evicted_pieces: g.evicted_pieces,
            }),
        }))
    }

    fn on_piece_completed(&self, piece_id: ValidPieceIndex) -> anyhow::Result<()> {
        let mut g = self.inner.write();
        if g.pieces.contains_key(&piece_id) {
            return Ok(());
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
                if let Some(piece) = g.pieces.remove(&oldest) {
                    g.stored_bytes = g.stored_bytes.saturating_sub(piece.bytes.len() as u64);
                    g.evicted_pieces += 1;
                }
            }
            if g.evicted_pieces > 0 && g.evicted_pieces % 32 == 0 {
                eprintln!(
                    "[torrent-storage] piezas descartadas={} piezas_activas={} ram_aprox={}MB budget={}MB",
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