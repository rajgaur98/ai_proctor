//! End-to-end sync against a local Supabase (`pnpm db:start`). Skipped unless
//! AI_PROCTOR_SUPABASE_URL and AI_PROCTOR_SUPABASE_ANON_KEY are set, e.g.:
//!
//!   eval "$(pnpm supabase status -o env | grep -E '^(API_URL|ANON_KEY)=')"
//!   AI_PROCTOR_SUPABASE_URL=$API_URL AI_PROCTOR_SUPABASE_ANON_KEY=$ANON_KEY \
//!     cargo test -p agent-core --test sync_supabase

use std::sync::Arc;

use agent_core::clock::{Clock, SystemClock};
use agent_core::outbox::Outbox;
use agent_core::sync::{
    Api, ApiConfig, DeviceIdentity, Heartbeat, SyncError, Syncer, TokenProvider,
};
use chrono::SecondsFormat;
use serde_json::json;
use uuid::Uuid;

struct Password(String);

impl TokenProvider for Password {
    fn access_token(&self) -> Result<String, SyncError> {
        Ok(self.0.clone())
    }
}

#[test]
fn queued_events_and_captures_reach_supabase() {
    let (Ok(url), Ok(anon_key)) = (
        std::env::var("AI_PROCTOR_SUPABASE_URL"),
        std::env::var("AI_PROCTOR_SUPABASE_ANON_KEY"),
    ) else {
        eprintln!("skipped: AI_PROCTOR_SUPABASE_URL / _ANON_KEY not set");
        return;
    };

    // Seeded employee (supabase/seed.sql).
    let session: serde_json::Value = reqwest::blocking::Client::new()
        .post(format!("{url}/auth/v1/token?grant_type=password"))
        .header("apikey", &anon_key)
        .json(&json!({ "email": "lucas@acme.test", "password": "password123" }))
        .send()
        .unwrap()
        .json()
        .unwrap();
    let token = session["access_token"]
        .as_str()
        .expect("signed in")
        .to_owned();

    let config = ApiConfig { url, anon_key };
    let api = Api::new(config.clone(), Arc::new(Password(token.clone()))).unwrap();
    let hardware = format!("it-{}", Uuid::now_v7());
    let registration = api
        .register_device("macos", "26.7", "0.1.0", &hardware)
        .unwrap();

    let dir = tempfile::tempdir().unwrap();
    let outbox = Arc::new(Outbox::open(dir.path(), &[5u8; 32]).unwrap());
    let clock: Arc<dyn Clock> = Arc::new(SystemClock::default());
    let now = clock.now();
    outbox
        .append("clock_in", now, 1, json!({ "reason": "manual" }), now)
        .unwrap();
    let checkin = outbox
        .append(
            "checkin",
            now,
            2,
            json!({
                "scheduled_at": now.to_rfc3339_opts(SecondsFormat::Millis, true),
                "outcome": "pass",
                "wrong_clicks": 0,
                "object_keys": ["screen-1.webp"],
                "flags": [],
            }),
            now,
        )
        .unwrap();
    outbox
        .add_upload(
            checkin.id,
            "screen-1.webp",
            b"RIFF\x1a\0\0\0WEBPVP8 it",
            now,
        )
        .unwrap();
    outbox
        .append("clock_out", now, 3, json!({ "reason": "manual" }), now)
        .unwrap();

    let syncer = Syncer::new(
        Api::new(config, Arc::new(Password(token))).unwrap(),
        outbox.clone(),
        clock,
        DeviceIdentity {
            device_id: registration.device_id,
            org_id: Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap(),
            user_id: Uuid::parse_str("00000000-0000-4000-8000-0000000000c2").unwrap(),
        },
    );

    let stats = syncer.sync_once().unwrap();
    assert_eq!(
        (stats.accepted, stats.rejected, stats.uploaded),
        (3, 0, 1),
        "{stats:?}"
    );
    assert_eq!(outbox.stats().unwrap().pending_events, 0);
    assert_eq!(
        outbox.stats().unwrap().uploads,
        0,
        "uploaded file deleted locally"
    );

    // Nothing left: a second pass sends nothing.
    assert_eq!(syncer.sync_once().unwrap(), Default::default());

    let reply = syncer
        .heartbeat(&Heartbeat {
            idle_s: 3,
            locked: false,
            in_call: false,
            permissions: json!({}),
        })
        .unwrap();
    assert_eq!(reply.policy_version, 1);
    assert!(
        syncer.clock_offset().num_seconds().abs() < 5,
        "local stack shares this clock"
    );
}
