//! Encrypted offline outbox (LLD 01/03; NFR-REL-01, NFR-SEC-03, CHK-05).
//!
//! Every event and capture file goes through here, so nothing is lost offline or
//! across a crash. Events get a UUIDv7 id and a per-device `seq`; their payloads
//! are AES-256-GCM encrypted with the event id as associated data, so a swapped or
//! damaged row fails to decrypt and is quarantined instead of blocking the queue.
//! Capture files are encrypted on disk and only handed to the uploader once their
//! check-in event has been acknowledged.
//!
//! Retention (LLD 03): acked events are kept 24 h for debugging; rejected events 7
//! days. Past 7 days or the size cap, the oldest images are dropped; events never.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use uuid::Uuid;

use crate::keystore::Key;

pub const ACKED_RETENTION: Duration = Duration::hours(24);
pub const REJECTED_RETENTION: Duration = Duration::days(7);
pub const UPLOAD_MAX_AGE: Duration = Duration::days(7);
pub const UPLOAD_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

const NONCE_LEN: usize = 12;

#[derive(Debug, thiserror::Error)]
pub enum OutboxError {
    #[error("database: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("file: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("encryption failed")]
    Crypto,
}

/// One queued event, decrypted.
#[derive(Clone, Debug, PartialEq)]
pub struct OutboxEvent {
    pub id: Uuid,
    pub seq: u64,
    pub event_type: String,
    pub at: DateTime<Utc>,
    pub mono_ms: u64,
    pub payload: serde_json::Value,
}

impl OutboxEvent {
    /// The element the agent_events RPC expects (packages/contracts/src/events.ts).
    pub fn to_wire(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id,
            "seq": self.seq,
            "type": self.event_type,
            "at": self.at.to_rfc3339_opts(SecondsFormat::Millis, true),
            "mono_ms": self.mono_ms,
            "payload": self.payload,
        })
    }
}

/// A capture file ready to upload (its check-in event is acked).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingUpload {
    pub id: i64,
    pub checkin_id: Uuid,
    pub name: String,
    pub bytes: Vec<u8>,
}

/// What the server said about a batch (agent_events reply).
#[derive(Clone, Debug, Default)]
pub struct SyncReply {
    pub accepted: Vec<Uuid>,
    pub duplicates: Vec<Uuid>,
    pub rejected: Vec<(Uuid, String)>,
    pub acked_seq: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OutboxStats {
    pub pending_events: u64,
    pub corrupt_events: u64,
    pub uploads: u64,
    pub upload_bytes: u64,
}

pub struct Outbox {
    conn: Mutex<Connection>,
    cipher: Aes256Gcm,
    uploads_dir: PathBuf,
}

impl Outbox {
    /// Opens (or creates) the outbox in `dir`.
    pub fn open(dir: &Path, key: &Key) -> Result<Self, OutboxError> {
        std::fs::create_dir_all(dir)?;
        let uploads_dir = dir.join("uploads");
        std::fs::create_dir_all(&uploads_dir)?;
        let conn = Connection::open(dir.join("outbox.sqlite3"))?;
        conn.pragma_update(None, "journal_mode", "wal")?;
        // FULL: a committed event survives power loss, not just a killed process.
        conn.pragma_update(None, "synchronous", "full")?;
        conn.execute_batch(
            "create table if not exists meta (key text primary key, value text not null);
             create table if not exists events (
               seq integer primary key,
               id text not null unique,
               type text not null,
               at text not null,
               mono_ms integer not null,
               nonce blob not null,
               payload blob not null,
               created_at text not null,
               acked_at text,
               rejected_reason text,
               corrupt integer not null default 0
             );
             create table if not exists uploads (
               id integer primary key,
               checkin_id text not null,
               name text not null,
               file text not null,
               size integer not null,
               created_at text not null,
               unique (checkin_id, name)
             );",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
            cipher: Aes256Gcm::new(key.into()),
            uploads_dir,
        })
    }

    /// Queues an event; assigns its id and the next seq atomically.
    pub fn append(
        &self,
        event_type: &str,
        at: DateTime<Utc>,
        mono_ms: u64,
        payload: serde_json::Value,
        now: DateTime<Utc>,
    ) -> Result<OutboxEvent, OutboxError> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let last: Option<i64> = tx.query_row("select max(seq) from events", [], |r| r.get(0))?;
        let floor: Option<String> = tx
            .query_row("select value from meta where key = 'last_seq'", [], |r| {
                r.get(0)
            })
            .optional()?;
        // last_seq survives pruning of acked rows, so seq never goes backwards.
        let seq = last
            .unwrap_or(0)
            .max(floor.and_then(|v| v.parse().ok()).unwrap_or(0))
            + 1;
        let id = Uuid::now_v7();
        let (nonce, sealed) = self.seal(&serde_json::to_vec(&payload)?, id.as_bytes())?;
        tx.execute(
            "insert into events (seq, id, type, at, mono_ms, nonce, payload, created_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                seq,
                id.to_string(),
                event_type,
                ts(at),
                mono_ms as i64,
                nonce,
                sealed,
                ts(now)
            ],
        )?;
        tx.execute(
            "insert into meta (key, value) values ('last_seq', ?1)
             on conflict (key) do update set value = excluded.value",
            params![seq.to_string()],
        )?;
        tx.commit()?;
        Ok(OutboxEvent {
            id,
            seq: seq as u64,
            event_type: event_type.into(),
            at,
            mono_ms,
            payload,
        })
    }

    /// Unsent events in seq order, at most `limit`. Rows that fail to decrypt are
    /// marked corrupt and skipped, so one bad row never blocks the queue.
    pub fn pending(&self, limit: usize) -> Result<Vec<OutboxEvent>, OutboxError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "select seq, id, type, at, mono_ms, nonce, payload from events
             where acked_at is null and rejected_reason is null and corrupt = 0
             order by seq limit ?1",
        )?;
        let rows = stmt
            .query_map(params![limit as i64], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, Vec<u8>>(5)?,
                    r.get::<_, Vec<u8>>(6)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let mut events = Vec::with_capacity(rows.len());
        for (seq, id, event_type, at, mono_ms, nonce, sealed) in rows {
            let decoded = Uuid::parse_str(&id).ok().and_then(|uuid| {
                let plain = self.open_sealed(&nonce, &sealed, uuid.as_bytes()).ok()?;
                let payload = serde_json::from_slice(&plain).ok()?;
                let at = DateTime::parse_from_rfc3339(&at).ok()?.with_timezone(&Utc);
                Some(OutboxEvent {
                    id: uuid,
                    seq: seq as u64,
                    event_type,
                    at,
                    mono_ms: mono_ms as u64,
                    payload,
                })
            });
            match decoded {
                Some(event) => events.push(event),
                None => {
                    tracing::error!(seq, "outbox event failed to decrypt; quarantined");
                    conn.execute("update events set corrupt = 1 where seq = ?1", params![seq])?;
                }
            }
        }
        Ok(events)
    }

    /// Records the server's answer. Accepted and duplicate events are done;
    /// rejected ones keep their reason and are never retried; everything at or
    /// below `acked_seq` was processed by the server.
    pub fn apply_reply(&self, reply: &SyncReply, now: DateTime<Utc>) -> Result<(), OutboxError> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        for id in reply.accepted.iter().chain(&reply.duplicates) {
            tx.execute(
                "update events set acked_at = coalesce(acked_at, ?2) where id = ?1",
                params![id.to_string(), ts(now)],
            )?;
        }
        for (id, reason) in &reply.rejected {
            tracing::warn!(%id, reason, "event rejected by the server");
            tx.execute(
                "update events set rejected_reason = ?2 where id = ?1",
                params![id.to_string(), reason],
            )?;
        }
        tx.execute(
            "update events set acked_at = coalesce(acked_at, ?2)
             where seq <= ?1 and rejected_reason is null",
            params![reply.acked_seq as i64, ts(now)],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Stores a capture file, encrypted, until its check-in event is acked.
    pub fn add_upload(
        &self,
        checkin_id: Uuid,
        name: &str,
        bytes: &[u8],
        now: DateTime<Utc>,
    ) -> Result<(), OutboxError> {
        let file = format!("{}.bin", Uuid::now_v7());
        let (nonce, sealed) = self.seal(bytes, upload_aad(checkin_id, name).as_bytes())?;
        let mut blob = nonce;
        blob.extend_from_slice(&sealed);
        // Write then rename, so a crash never leaves a half-written file behind a row.
        let tmp = self.uploads_dir.join(format!("{file}.tmp"));
        std::fs::write(&tmp, &blob)?;
        std::fs::rename(&tmp, self.uploads_dir.join(&file))?;
        self.conn.lock().unwrap().execute(
            "insert into uploads (checkin_id, name, file, size, created_at) values (?1, ?2, ?3, ?4, ?5)",
            params![checkin_id.to_string(), name, file, blob.len() as i64, ts(now)],
        )?;
        Ok(())
    }

    /// Files whose check-in event the server has acknowledged, oldest first.
    pub fn ready_uploads(&self, limit: usize) -> Result<Vec<PendingUpload>, OutboxError> {
        let rows: Vec<(i64, String, String, String)> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "select u.id, u.checkin_id, u.name, u.file from uploads u
                 join events e on e.id = u.checkin_id
                 where e.acked_at is not null and e.rejected_reason is null
                 order by u.id limit ?1",
            )?;
            let rows = stmt
                .query_map(params![limit as i64], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut ready = Vec::with_capacity(rows.len());
        for (id, checkin_id, name, file) in rows {
            let checkin_id = Uuid::parse_str(&checkin_id).map_err(|_| OutboxError::Crypto)?;
            let blob = std::fs::read(self.uploads_dir.join(&file))?;
            if blob.len() < NONCE_LEN {
                return Err(OutboxError::Crypto);
            }
            let (nonce, sealed) = blob.split_at(NONCE_LEN);
            let bytes =
                self.open_sealed(nonce, sealed, upload_aad(checkin_id, &name).as_bytes())?;
            ready.push(PendingUpload {
                id,
                checkin_id,
                name,
                bytes,
            });
        }
        Ok(ready)
    }

    /// The file is in Storage (or already was): drop the row and the local copy.
    pub fn mark_uploaded(&self, upload_id: i64) -> Result<(), OutboxError> {
        let conn = self.conn.lock().unwrap();
        let file: Option<String> = conn
            .query_row(
                "select file from uploads where id = ?1",
                params![upload_id],
                |r| r.get(0),
            )
            .optional()?;
        conn.execute("delete from uploads where id = ?1", params![upload_id])?;
        drop(conn);
        if let Some(file) = file {
            remove_if_exists(&self.uploads_dir.join(file))?;
        }
        Ok(())
    }

    /// Applies retention. Events are only removed once the server has them (24 h
    /// after the ack) or rejected them (after 7 days); files are dropped when
    /// their check-in was rejected, when older than 7 days, or oldest-first above
    /// `max_upload_bytes`.
    pub fn prune(&self, now: DateTime<Utc>, max_upload_bytes: u64) -> Result<(), OutboxError> {
        let mut doomed: Vec<String> = Vec::new();
        {
            let mut conn = self.conn.lock().unwrap();
            let tx = conn.transaction()?;
            // Files for rejected check-ins can never be uploaded.
            doomed.extend(take_files(
                &tx,
                "select u.id, u.file from uploads u join events e on e.id = u.checkin_id
                 where e.rejected_reason is not null",
                params![],
            )?);
            doomed.extend(take_files(
                &tx,
                "select id, file from uploads where created_at < ?1",
                params![ts(now - UPLOAD_MAX_AGE)],
            )?);
            let mut total: i64 =
                tx.query_row("select coalesce(sum(size), 0) from uploads", [], |r| {
                    r.get(0)
                })?;
            while total as u64 > max_upload_bytes {
                let oldest: Option<(i64, String, i64)> = tx
                    .query_row(
                        "select id, file, size from uploads order by id limit 1",
                        [],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .optional()?;
                let Some((id, file, size)) = oldest else {
                    break;
                };
                tracing::warn!(
                    id,
                    size,
                    "outbox over its size cap; dropping the oldest image"
                );
                tx.execute("delete from uploads where id = ?1", params![id])?;
                doomed.push(file);
                total -= size;
            }
            tx.execute(
                "delete from events where acked_at is not null and acked_at < ?1
                 and id not in (select checkin_id from uploads)",
                params![ts(now - ACKED_RETENTION)],
            )?;
            tx.execute(
                "delete from events where rejected_reason is not null and created_at < ?1",
                params![ts(now - REJECTED_RETENTION)],
            )?;
            tx.commit()?;
        }
        for file in doomed {
            remove_if_exists(&self.uploads_dir.join(file))?;
        }
        Ok(())
    }

    pub fn stats(&self) -> Result<OutboxStats, OutboxError> {
        let conn = self.conn.lock().unwrap();
        let count = |sql: &str| {
            conn.query_row(sql, [], |r| r.get::<_, i64>(0))
                .map(|n| n as u64)
        };
        Ok(OutboxStats {
            pending_events: count(
                "select count(*) from events where acked_at is null and rejected_reason is null and corrupt = 0",
            )?,
            corrupt_events: count("select count(*) from events where corrupt = 1")?,
            uploads: count("select count(*) from uploads")?,
            upload_bytes: count("select coalesce(sum(size), 0) from uploads")?,
        })
    }

    fn seal(&self, plain: &[u8], aad: &[u8]) -> Result<(Vec<u8>, Vec<u8>), OutboxError> {
        let mut nonce = [0u8; NONCE_LEN];
        getrandom::fill(&mut nonce).map_err(|_| OutboxError::Crypto)?;
        let sealed = self
            .cipher
            .encrypt(&Nonce::from(nonce), Payload { msg: plain, aad })
            .map_err(|_| OutboxError::Crypto)?;
        Ok((nonce.to_vec(), sealed))
    }

    fn open_sealed(&self, nonce: &[u8], sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>, OutboxError> {
        let nonce = Nonce::try_from(nonce).map_err(|_| OutboxError::Crypto)?;
        self.cipher
            .decrypt(&nonce, Payload { msg: sealed, aad })
            .map_err(|_| OutboxError::Crypto)
    }
}

fn ts(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn upload_aad(checkin_id: Uuid, name: &str) -> String {
    format!("{checkin_id}/{name}")
}

fn take_files(
    tx: &rusqlite::Transaction<'_>,
    select: &str,
    args: impl rusqlite::Params,
) -> Result<Vec<String>, OutboxError> {
    let rows: Vec<(i64, String)> = tx
        .prepare(select)?
        .query_map(args, |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (id, _) in &rows {
        tx.execute("delete from uploads where id = ?1", params![id])?;
    }
    Ok(rows.into_iter().map(|(_, file)| file).collect())
}

fn remove_if_exists(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const KEY: Key = [7u8; 32];

    fn t0() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-19T09:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn open(dir: &Path) -> Outbox {
        Outbox::open(dir, &KEY).unwrap()
    }

    fn lock(outbox: &Outbox, n: u64) -> OutboxEvent {
        outbox.append("lock", t0(), n, json!({}), t0()).unwrap()
    }

    #[test]
    fn assigns_increasing_seq_and_v7_ids() {
        let dir = tempfile::tempdir().unwrap();
        let outbox = open(dir.path());
        let a = lock(&outbox, 1);
        let b = lock(&outbox, 2);
        assert_eq!((a.seq, b.seq), (1, 2));
        assert_eq!(a.id.get_version_num(), 7);
        assert!(a.id < b.id, "v7 ids sort by creation time");
    }

    #[test]
    fn pending_returns_decrypted_events_in_seq_order() {
        let dir = tempfile::tempdir().unwrap();
        let outbox = open(dir.path());
        let a = outbox
            .append("clock_in", t0(), 5, json!({"reason": "manual"}), t0())
            .unwrap();
        lock(&outbox, 6);
        let pending = outbox.pending(10).unwrap();
        assert_eq!(pending.len(), 2);
        assert_eq!(pending[0], a);
        assert_eq!(pending[0].to_wire()["payload"]["reason"], "manual");
        assert_eq!(pending[0].to_wire()["at"], "2026-10-19T09:00:00.000Z");
    }

    #[test]
    fn payloads_are_encrypted_at_rest() {
        let dir = tempfile::tempdir().unwrap();
        let outbox = open(dir.path());
        outbox
            .append(
                "app_session",
                t0(),
                1,
                json!({"app": "SecretProjectApp"}),
                t0(),
            )
            .unwrap();
        drop(outbox);
        let raw = std::fs::read(dir.path().join("outbox.sqlite3")).unwrap();
        let wal = std::fs::read(dir.path().join("outbox.sqlite3-wal")).unwrap_or_default();
        let needle = b"SecretProjectApp";
        assert!(!raw.windows(needle.len()).any(|w| w == needle));
        assert!(!wal.windows(needle.len()).any(|w| w == needle));
    }

    #[test]
    fn survives_a_restart_and_keeps_counting() {
        let dir = tempfile::tempdir().unwrap();
        {
            let outbox = open(dir.path());
            lock(&outbox, 1);
            lock(&outbox, 2);
        }
        let outbox = open(dir.path());
        assert_eq!(outbox.pending(10).unwrap().len(), 2);
        assert_eq!(lock(&outbox, 3).seq, 3);
    }

    #[test]
    fn seq_never_reuses_numbers_after_pruning() {
        let dir = tempfile::tempdir().unwrap();
        let outbox = open(dir.path());
        let a = lock(&outbox, 1);
        outbox
            .apply_reply(
                &SyncReply {
                    accepted: vec![a.id],
                    acked_seq: 1,
                    ..Default::default()
                },
                t0(),
            )
            .unwrap();
        outbox
            .prune(t0() + Duration::days(2), UPLOAD_MAX_BYTES)
            .unwrap();
        assert_eq!(outbox.stats().unwrap().pending_events, 0);
        assert_eq!(lock(&outbox, 2).seq, 2);
    }

    #[test]
    fn a_corrupt_row_is_quarantined_and_does_not_block_the_queue() {
        let dir = tempfile::tempdir().unwrap();
        let outbox = open(dir.path());
        let a = lock(&outbox, 1);
        let b = lock(&outbox, 2);
        outbox
            .conn
            .lock()
            .unwrap()
            .execute("update events set payload = x'00' where seq = 1", [])
            .unwrap();
        let pending = outbox.pending(10).unwrap();
        assert_eq!(pending.iter().map(|e| e.id).collect::<Vec<_>>(), vec![b.id]);
        assert_eq!(outbox.stats().unwrap().corrupt_events, 1);
        assert!(outbox.pending(10).unwrap().iter().all(|e| e.id != a.id));
    }

    #[test]
    fn a_different_key_cannot_read_the_queue() {
        let dir = tempfile::tempdir().unwrap();
        lock(&open(dir.path()), 1);
        let other = Outbox::open(dir.path(), &[9u8; 32]).unwrap();
        assert!(other.pending(10).unwrap().is_empty());
        assert_eq!(other.stats().unwrap().corrupt_events, 1);
    }

    #[test]
    fn apply_reply_settles_accepted_duplicate_rejected_and_contiguous_events() {
        let dir = tempfile::tempdir().unwrap();
        let outbox = open(dir.path());
        let e: Vec<_> = (1..=5).map(|n| lock(&outbox, n)).collect();
        outbox
            .apply_reply(
                &SyncReply {
                    accepted: vec![e[0].id],
                    duplicates: vec![e[1].id],
                    rejected: vec![(e[2].id, "not_clocked_in".into())],
                    // e[3] was processed but its id was lost with the reply.
                    acked_seq: 4,
                },
                t0(),
            )
            .unwrap();
        let pending = outbox.pending(10).unwrap();
        assert_eq!(
            pending.iter().map(|x| x.id).collect::<Vec<_>>(),
            vec![e[4].id]
        );
    }

    #[test]
    fn uploads_wait_for_their_checkin_to_be_acked() {
        let dir = tempfile::tempdir().unwrap();
        let outbox = open(dir.path());
        let checkin = outbox
            .append("checkin", t0(), 1, json!({"outcome": "pass"}), t0())
            .unwrap();
        outbox
            .add_upload(checkin.id, "screen-1.webp", b"RIFF-webp-bytes", t0())
            .unwrap();
        assert!(
            outbox.ready_uploads(10).unwrap().is_empty(),
            "not before the ack"
        );

        outbox
            .apply_reply(
                &SyncReply {
                    accepted: vec![checkin.id],
                    acked_seq: 1,
                    ..Default::default()
                },
                t0(),
            )
            .unwrap();
        let ready = outbox.ready_uploads(10).unwrap();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].bytes, b"RIFF-webp-bytes");
        assert_eq!(ready[0].checkin_id, checkin.id);

        outbox.mark_uploaded(ready[0].id).unwrap();
        assert_eq!(outbox.stats().unwrap().uploads, 0);
        assert_eq!(
            std::fs::read_dir(dir.path().join("uploads"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn files_of_a_rejected_checkin_are_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let outbox = open(dir.path());
        let checkin = outbox.append("checkin", t0(), 1, json!({}), t0()).unwrap();
        outbox
            .add_upload(checkin.id, "screen-1.webp", b"x", t0())
            .unwrap();
        outbox
            .apply_reply(
                &SyncReply {
                    rejected: vec![(checkin.id, "checkin_while_paused".into())],
                    acked_seq: 1,
                    ..Default::default()
                },
                t0(),
            )
            .unwrap();
        outbox.prune(t0(), UPLOAD_MAX_BYTES).unwrap();
        assert_eq!(outbox.stats().unwrap().uploads, 0);
    }

    #[test]
    fn over_the_size_cap_the_oldest_images_go_first_and_events_stay() {
        let dir = tempfile::tempdir().unwrap();
        let outbox = open(dir.path());
        let checkin = outbox.append("checkin", t0(), 1, json!({}), t0()).unwrap();
        for n in 1..=3 {
            outbox
                .add_upload(checkin.id, &format!("screen-{n}.webp"), &[0u8; 100], t0())
                .unwrap();
        }
        let per_file = outbox.stats().unwrap().upload_bytes / 3;
        outbox.prune(t0(), per_file * 2).unwrap();

        let names: Vec<String> = outbox
            .conn
            .lock()
            .unwrap()
            .prepare("select name from uploads order by id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(names, vec!["screen-2.webp", "screen-3.webp"]);
        assert_eq!(
            outbox.stats().unwrap().pending_events,
            1,
            "events are never dropped"
        );
    }

    #[test]
    fn keeps_a_week_of_offline_events_and_drops_week_old_images() {
        let dir = tempfile::tempdir().unwrap();
        let outbox = open(dir.path());
        let checkin = outbox.append("checkin", t0(), 1, json!({}), t0()).unwrap();
        outbox
            .add_upload(checkin.id, "screen-1.webp", b"x", t0())
            .unwrap();
        outbox
            .prune(t0() + Duration::days(6), UPLOAD_MAX_BYTES)
            .unwrap();
        assert_eq!(
            outbox.stats().unwrap().uploads,
            1,
            "6 days offline: images kept"
        );
        outbox
            .prune(t0() + Duration::days(8), UPLOAD_MAX_BYTES)
            .unwrap();
        assert_eq!(
            outbox.stats().unwrap().uploads,
            0,
            "past 7 days: images dropped"
        );
        assert_eq!(
            outbox.stats().unwrap().pending_events,
            1,
            "the event is still queued"
        );
    }
}
