//! Agent side of the sync protocol (LLD 03; STS-01, NFR-REL-01, CAP-06).
//!
//! `Api` talks to PostgREST and Storage with the user's JWT (reqwest + rustls with
//! the OS certificate store and system proxy). `Syncer` drains the outbox in
//! batches (≤ 100 events, ≤ 256 KB), applies each reply, corrects for clock drift,
//! uploads capture files only after their check-in is acked, and sends heartbeats.
//! Only the outbox is the hand-off: a crash or a dropped connection loses nothing.

use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::clock::Clock;
use crate::config::AgentConfig;
use crate::outbox::{Outbox, OutboxError, OutboxEvent, PendingUpload, SyncReply};

pub const MAX_EVENTS_PER_BATCH: usize = 100;
pub const MAX_BATCH_BYTES: usize = 256 * 1024;
/// Correct queued events' timestamps when the device clock is off by more.
pub const MAX_CLOCK_DRIFT: Duration = Duration::seconds(2);

#[derive(Clone, Debug)]
pub struct ApiConfig {
    /// e.g. https://<project>.supabase.co or http://127.0.0.1:54321
    pub url: String,
    pub anon_key: String,
}

/// Supplies a valid access token (sign-in and refresh live in #16).
pub trait TokenProvider: Send + Sync {
    fn access_token(&self) -> Result<String, SyncError>;
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SyncError {
    /// Network or server trouble; try again later with backoff.
    #[error("temporary: {0}")]
    Retry(String),
    /// The session is gone (expired, signed out, user deactivated).
    #[error("signed out: {0}")]
    SignedOut(String),
    /// This device was revoked by an admin; stop collecting.
    #[error("device revoked")]
    Revoked,
    /// The server refused the request itself (a bug on our side); don't retry it.
    #[error("refused: {0}")]
    Refused(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Registration {
    pub device_id: Uuid,
    pub policy: Value,
    pub policy_version: i64,
}

#[derive(Clone, Debug, Deserialize)]
struct EventsReply {
    accepted: Vec<Uuid>,
    duplicates: Vec<Uuid>,
    rejected: Vec<RejectedEvent>,
    acked_seq: u64,
    server_time: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize)]
struct RejectedEvent {
    id: Option<Uuid>,
    reason: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct HeartbeatReply {
    pub server_time: DateTime<Utc>,
    pub policy_version: i64,
    pub commands: Vec<String>,
}

/// What the agent reports every 60 s while clocked in (STS-01).
#[derive(Clone, Debug, PartialEq)]
pub struct Heartbeat {
    pub idle_s: u64,
    pub locked: bool,
    pub in_call: bool,
    pub permissions: Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UploadResult {
    Stored,
    /// Already in Storage (an earlier attempt succeeded): done.
    AlreadyThere,
    /// The storage policy refused it; never retried.
    Refused(String),
}

pub struct Api {
    http: reqwest::blocking::Client,
    config: ApiConfig,
    tokens: Arc<dyn TokenProvider>,
}

impl Api {
    pub fn new(config: ApiConfig, tokens: Arc<dyn TokenProvider>) -> Result<Self, SyncError> {
        let http = reqwest::blocking::Client::builder()
            .timeout(StdDuration::from_secs(30))
            .user_agent(concat!("ai-proctor-agent/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| SyncError::Retry(e.to_string()))?;
        Ok(Self {
            http,
            config,
            tokens,
        })
    }

    fn rpc(&self, name: &str, body: &Value) -> Result<Value, SyncError> {
        let token = self.tokens.access_token()?;
        let response = self
            .http
            .post(format!("{}/rest/v1/rpc/{name}", self.config.url))
            .header("apikey", &self.config.anon_key)
            .bearer_auth(token)
            .json(body)
            .send()
            .map_err(|e| SyncError::Retry(e.to_string()))?;
        let status = response.status().as_u16();
        let text = response
            .text()
            .map_err(|e| SyncError::Retry(e.to_string()))?;
        if (200..300).contains(&status) {
            return serde_json::from_str(&text).map_err(|e| SyncError::Refused(e.to_string()));
        }
        Err(rpc_error(status, &text))
    }

    pub fn register_device(
        &self,
        platform: &str,
        os_version: &str,
        agent_version: &str,
        hardware_hash: &str,
    ) -> Result<Registration, SyncError> {
        let reply = self.rpc(
            "register_device",
            &json!({
                "platform": platform,
                "os_version": os_version,
                "agent_version": agent_version,
                "hardware_hash": hardware_hash,
            }),
        )?;
        Ok(Registration {
            device_id: serde_json::from_value(reply["device_id"].clone())
                .map_err(|e| SyncError::Refused(e.to_string()))?,
            policy: reply["policy"].clone(),
            policy_version: reply["policy_version"].as_i64().unwrap_or(0),
        })
    }

    fn agent_events(&self, device_id: Uuid, events: &[Value]) -> Result<EventsReply, SyncError> {
        let reply = self.rpc(
            "agent_events",
            &json!({ "device_id": device_id, "events": events }),
        )?;
        serde_json::from_value(reply).map_err(|e| SyncError::Refused(e.to_string()))
    }

    /// Org policy and this person's shifts (#29).
    pub fn agent_config(&self, device_id: Uuid) -> Result<AgentConfig, SyncError> {
        let reply = self.rpc("agent_config", &json!({ "p_device_id": device_id }))?;
        serde_json::from_value(reply).map_err(|e| SyncError::Refused(e.to_string()))
    }

    pub fn heartbeat(
        &self,
        device_id: Uuid,
        sent_at: DateTime<Utc>,
        heartbeat: &Heartbeat,
    ) -> Result<HeartbeatReply, SyncError> {
        let reply = self.rpc(
            "agent_heartbeat",
            &json!({
                "device_id": device_id,
                "sent_at": sent_at,
                "idle_s": heartbeat.idle_s,
                "locked": heartbeat.locked,
                "in_call": heartbeat.in_call,
                "agent_version": env!("CARGO_PKG_VERSION"),
                "permissions": heartbeat.permissions,
            }),
        )?;
        serde_json::from_value(reply).map_err(|e| SyncError::Refused(e.to_string()))
    }

    pub fn upload_capture(
        &self,
        object_path: &str,
        bytes: Vec<u8>,
    ) -> Result<UploadResult, SyncError> {
        let token = self.tokens.access_token()?;
        let response = self
            .http
            .post(format!(
                "{}/storage/v1/object/captures/{object_path}",
                self.config.url
            ))
            .header("apikey", &self.config.anon_key)
            .bearer_auth(token)
            .header("content-type", "image/webp")
            .body(bytes)
            .send()
            .map_err(|e| SyncError::Retry(e.to_string()))?;
        let status = response.status().as_u16();
        let text = response.text().unwrap_or_default();
        storage_result(status, &text)
    }
}

/// PostgREST error → SyncError. Our RPCs raise their reason as the message.
fn rpc_error(status: u16, body: &str) -> SyncError {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["message"].as_str().map(str::to_owned))
        .unwrap_or_else(|| body.chars().take(200).collect());
    match (status, message.as_str()) {
        (_, "device_revoked" | "device_not_found" | "device_mismatch") => SyncError::Revoked,
        (401, _) | (_, "user_inactive" | "not_signed_in" | "user_not_provisioned") => {
            SyncError::SignedOut(message)
        }
        (408 | 429, _) | (500.., _) => SyncError::Retry(format!("{status}: {message}")),
        _ => SyncError::Refused(format!("{status}: {message}")),
    }
}

/// Storage answers denials with HTTP 400 and the real status in the body.
fn storage_result(status: u16, body: &str) -> Result<UploadResult, SyncError> {
    if (200..300).contains(&status) {
        return Ok(UploadResult::Stored);
    }
    let inner = serde_json::from_str::<Value>(body).ok();
    let code = inner
        .as_ref()
        .and_then(|v| {
            v["statusCode"]
                .as_str()
                .and_then(|s| s.parse().ok())
                .or(v["statusCode"].as_u64())
        })
        .map(|c| c as u16)
        .unwrap_or(status);
    let message = inner
        .as_ref()
        .and_then(|v| v["message"].as_str().map(str::to_owned))
        .unwrap_or_default();
    match code {
        409 => Ok(UploadResult::AlreadyThere),
        401 => Err(SyncError::SignedOut(message)),
        403 => Ok(UploadResult::Refused(message)),
        408 | 429 | 500.. => Err(SyncError::Retry(format!("{code}: {message}"))),
        _ => Ok(UploadResult::Refused(format!("{code}: {message}"))),
    }
}

/// Exponential backoff from 2 s to 5 min with ±25 % jitter (LLD 03).
#[derive(Debug, Default)]
pub struct Backoff {
    failures: u32,
}

impl Backoff {
    pub const MIN: StdDuration = StdDuration::from_secs(2);
    pub const MAX: StdDuration = StdDuration::from_secs(300);

    pub fn success(&mut self) {
        self.failures = 0;
    }

    /// Records a failure and returns how long to wait before the next attempt.
    pub fn failure(&mut self) -> StdDuration {
        self.failures = self.failures.saturating_add(1);
        let base = Self::MIN.as_secs_f64() * 2f64.powi(self.failures.min(16) as i32 - 1);
        let capped = base.min(Self::MAX.as_secs_f64());
        let jitter = 0.75 + fastrand::f64() * 0.5;
        StdDuration::from_secs_f64((capped * jitter).min(Self::MAX.as_secs_f64()))
    }
}

/// Who and where this device is, from registration and the JWT.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceIdentity {
    pub device_id: Uuid,
    pub org_id: Uuid,
    pub user_id: Uuid,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncStats {
    pub accepted: usize,
    pub duplicates: usize,
    pub rejected: usize,
    pub uploaded: usize,
}

pub struct Syncer {
    api: Api,
    outbox: Arc<Outbox>,
    clock: Arc<dyn Clock>,
    identity: DeviceIdentity,
    /// server_time − device time, from the latest reply.
    offset: Mutex<Duration>,
}

impl Syncer {
    pub fn new(
        api: Api,
        outbox: Arc<Outbox>,
        clock: Arc<dyn Clock>,
        identity: DeviceIdentity,
    ) -> Self {
        Self {
            api,
            outbox,
            clock,
            identity,
            offset: Mutex::new(Duration::zero()),
        }
    }

    pub fn clock_offset(&self) -> Duration {
        *self.offset.lock().unwrap()
    }

    /// Sends everything queued, then uploads every file that is ready.
    pub fn sync_once(&self) -> Result<SyncStats, SyncError> {
        let mut stats = SyncStats::default();
        loop {
            let events = self.outbox.pending(MAX_EVENTS_PER_BATCH).map_err(local)?;
            if events.is_empty() {
                break;
            }
            let batch = self.batch(&events);
            let sent_at = self.clock.now();
            let reply = self.api.agent_events(self.identity.device_id, &batch)?;
            self.record_offset(sent_at, reply.server_time);
            stats.accepted += reply.accepted.len();
            stats.duplicates += reply.duplicates.len();
            stats.rejected += reply.rejected.len();
            self.outbox
                .apply_reply(
                    &SyncReply {
                        accepted: reply.accepted,
                        duplicates: reply.duplicates,
                        rejected: reply
                            .rejected
                            .into_iter()
                            .filter_map(|r| r.id.map(|id| (id, r.reason)))
                            .collect(),
                        acked_seq: reply.acked_seq,
                    },
                    self.clock.now(),
                )
                .map_err(local)?;
        }
        loop {
            let ready = self.outbox.ready_uploads(10).map_err(local)?;
            if ready.is_empty() {
                break;
            }
            for upload in ready {
                let path = self.object_path(&upload)?;
                match self.api.upload_capture(&path, upload.bytes)? {
                    UploadResult::Stored | UploadResult::AlreadyThere => stats.uploaded += 1,
                    UploadResult::Refused(reason) => {
                        tracing::error!(%reason, checkin = %upload.checkin_id, "capture refused by storage; dropped");
                    }
                }
                self.outbox.mark_uploaded(upload.id).map_err(local)?;
            }
        }
        Ok(stats)
    }

    pub fn config(&self) -> Result<AgentConfig, SyncError> {
        self.api.agent_config(self.identity.device_id)
    }

    pub fn heartbeat(&self, heartbeat: &Heartbeat) -> Result<HeartbeatReply, SyncError> {
        let sent_at = self.clock.now();
        let reply = self
            .api
            .heartbeat(self.identity.device_id, sent_at, heartbeat)?;
        self.record_offset(sent_at, reply.server_time);
        Ok(reply)
    }

    /// Wire events, at most MAX_BATCH_BYTES, with `at` corrected for drift.
    fn batch(&self, events: &[OutboxEvent]) -> Vec<Value> {
        let offset = self.clock_offset();
        let correct = offset.abs() > MAX_CLOCK_DRIFT;
        let mut batch = Vec::new();
        let mut bytes = 2;
        for event in events {
            let mut event = event.clone();
            if correct {
                event.at += offset;
            }
            let wire = event.to_wire();
            let size = wire.to_string().len() + 1;
            if !batch.is_empty() && bytes + size > MAX_BATCH_BYTES {
                break;
            }
            bytes += size;
            batch.push(wire);
        }
        batch
    }

    fn record_offset(&self, sent_at: DateTime<Utc>, server_time: DateTime<Utc>) {
        // Half the round trip is unknown; the server time is close enough for a
        // 2 s threshold.
        *self.offset.lock().unwrap() = server_time - sent_at;
    }

    /// {org}/{user}/{YYYY-MM-DD}/{checkin_id}/{name}, the date being the
    /// check-in's scheduled date in UTC (storage policy, #24).
    fn object_path(&self, upload: &PendingUpload) -> Result<String, SyncError> {
        let payload = self
            .outbox
            .payload(upload.checkin_id)
            .map_err(local)?
            .ok_or_else(|| SyncError::Refused("check-in event missing for upload".into()))?;
        let date = payload["scheduled_at"]
            .as_str()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|t| t.with_timezone(&Utc).date_naive())
            .ok_or_else(|| SyncError::Refused("check-in has no scheduled_at".into()))?;
        Ok(object_path(
            &self.identity,
            date,
            upload.checkin_id,
            &upload.name,
        ))
    }
}

pub fn object_path(
    identity: &DeviceIdentity,
    date: NaiveDate,
    checkin_id: Uuid,
    name: &str,
) -> String {
    format!(
        "{}/{}/{}/{checkin_id}/{name}",
        identity.org_id,
        identity.user_id,
        date.format("%Y-%m-%d")
    )
}

fn local(e: OutboxError) -> SyncError {
    SyncError::Retry(format!("outbox: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::FakeClock;

    struct NoTokens;
    impl TokenProvider for NoTokens {
        fn access_token(&self) -> Result<String, SyncError> {
            Err(SyncError::SignedOut("test".into()))
        }
    }

    fn syncer(dir: &std::path::Path, clock: Arc<FakeClock>) -> Syncer {
        let api = Api::new(
            ApiConfig {
                url: "http://127.0.0.1:9".into(),
                anon_key: "anon".into(),
            },
            Arc::new(NoTokens),
        )
        .unwrap();
        let outbox = Arc::new(Outbox::open(dir, &[3u8; 32]).unwrap());
        Syncer::new(
            api,
            outbox,
            clock,
            DeviceIdentity {
                device_id: Uuid::nil(),
                org_id: Uuid::nil(),
                user_id: Uuid::nil(),
            },
        )
    }

    #[test]
    fn maps_rpc_errors_to_what_the_agent_should_do() {
        let body = |m: &str| format!(r#"{{"code":"42501","message":"{m}"}}"#);
        assert_eq!(rpc_error(403, &body("device_revoked")), SyncError::Revoked);
        assert!(matches!(
            rpc_error(403, &body("user_inactive")),
            SyncError::SignedOut(_)
        ));
        assert!(matches!(
            rpc_error(401, r#"{"message":"JWT expired"}"#),
            SyncError::SignedOut(_)
        ));
        assert!(matches!(rpc_error(503, "upstream"), SyncError::Retry(_)));
        assert!(matches!(
            rpc_error(400, &body("batch_too_large")),
            SyncError::Refused(_)
        ));
    }

    #[test]
    fn maps_storage_answers() {
        assert_eq!(storage_result(200, "{}"), Ok(UploadResult::Stored));
        assert_eq!(
            storage_result(
                400,
                r#"{"statusCode":"409","error":"Duplicate","message":"The resource already exists"}"#
            ),
            Ok(UploadResult::AlreadyThere)
        );
        assert!(matches!(
            storage_result(
                400,
                r#"{"statusCode":"403","message":"new row violates row-level security policy"}"#
            ),
            Ok(UploadResult::Refused(_))
        ));
        assert!(matches!(
            storage_result(502, "bad gateway"),
            Err(SyncError::Retry(_))
        ));
    }

    #[test]
    fn backoff_grows_from_2_seconds_to_5_minutes() {
        let mut backoff = Backoff::default();
        let first = backoff.failure();
        assert!(first >= StdDuration::from_millis(1500) && first <= StdDuration::from_millis(2500));
        for _ in 0..20 {
            assert!(backoff.failure() <= Backoff::MAX);
        }
        assert!(backoff.failure() >= StdDuration::from_secs(225));
        backoff.success();
        assert!(backoff.failure() <= StdDuration::from_millis(2500));
    }

    #[test]
    fn batches_stop_at_256_kb() {
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(FakeClock::at("2026-10-19T09:00:00Z"));
        let s = syncer(dir.path(), clock.clone());
        for n in 0..60 {
            s.outbox
                .append(
                    "app_session",
                    clock.now(),
                    n,
                    json!({ "app": "x".repeat(10_000) }),
                    clock.now(),
                )
                .unwrap();
        }
        let events = s.outbox.pending(100).unwrap();
        let batch = s.batch(&events);
        assert!(batch.len() < 60);
        assert!(serde_json::to_string(&batch).unwrap().len() <= MAX_BATCH_BYTES);
    }

    #[test]
    fn corrects_timestamps_only_beyond_2_seconds_of_drift() {
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(FakeClock::at("2026-10-19T09:00:00Z"));
        let s = syncer(dir.path(), clock.clone());
        s.outbox
            .append("lock", clock.now(), 1, json!({}), clock.now())
            .unwrap();
        let events = s.outbox.pending(1).unwrap();

        s.record_offset(clock.now(), clock.now() + Duration::seconds(1));
        assert_eq!(s.batch(&events)[0]["at"], "2026-10-19T09:00:00.000Z");

        s.record_offset(clock.now(), clock.now() + Duration::seconds(90));
        assert_eq!(s.batch(&events)[0]["at"], "2026-10-19T09:01:30.000Z");
    }

    #[test]
    fn object_paths_follow_the_storage_policy() {
        let identity = DeviceIdentity {
            device_id: Uuid::nil(),
            org_id: Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap(),
            user_id: Uuid::parse_str("00000000-0000-4000-8000-0000000000c1").unwrap(),
        };
        let checkin = Uuid::parse_str("00000000-0000-4000-8000-0000000000f1").unwrap();
        assert_eq!(
            object_path(&identity, NaiveDate::from_ymd_opt(2026, 10, 19).unwrap(), checkin, "screen-1.webp"),
            "00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000c1/2026-10-19/00000000-0000-4000-8000-0000000000f1/screen-1.webp"
        );
    }

    #[test]
    fn a_signed_out_agent_keeps_everything_queued() {
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(FakeClock::at("2026-10-19T09:00:00Z"));
        let s = syncer(dir.path(), clock.clone());
        s.outbox
            .append("lock", clock.now(), 1, json!({}), clock.now())
            .unwrap();
        assert!(matches!(s.sync_once(), Err(SyncError::SignedOut(_))));
        assert_eq!(s.outbox.stats().unwrap().pending_events, 1);
    }
}
