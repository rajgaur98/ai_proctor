//! The agent's account end to end against a local Supabase (`pnpm db:start`):
//! magic link → device registration → queued events synced → heartbeat → restore
//! from the keychain → sign-out. Skipped unless AI_PROCTOR_SUPABASE_URL,
//! AI_PROCTOR_SUPABASE_ANON_KEY and AI_PROCTOR_MAILPIT_URL are set (see CLAUDE.md).

use std::sync::Arc;
use std::time::Duration;

use agent_core::capture::{capture, CapturePolicy};
use agent_core::checkin::{Card, CardPolicy};
use agent_core::clock::{Clock, SystemClock};
use agent_core::fake::FakePlatform;
use agent_core::keystore::{KeyStore, MemoryKeyStore};
use agent_core::outbox::Outbox;
use agent_core::platform::SessionState;
use agent_core::presence::PresenceTracker;
use agent_core::scheduler::{Outcome, ThreadRandom};
use agent_core::session::{FileSessionStore, OutboxSink, Session, SessionPolicy};
use agent_core::sync::{ApiConfig, Heartbeat, SyncError};
use ai_proctor_agent::account::Account;

const EMAIL: &str = "erin@acme.test";

fn env() -> Option<(ApiConfig, String)> {
    Some((
        ApiConfig {
            url: std::env::var("AI_PROCTOR_SUPABASE_URL").ok()?,
            anon_key: std::env::var("AI_PROCTOR_SUPABASE_ANON_KEY").ok()?,
        },
        std::env::var("AI_PROCTOR_MAILPIT_URL").ok()?,
    ))
}

/// Follows the newest magic link for `email` up to its aiproctor:// redirect,
/// as the browser would.
fn redirect_from_email(mailpit: &str, email: &str) -> String {
    let http = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    for _ in 0..50 {
        let list: serde_json::Value = http
            .get(format!("{mailpit}/api/v1/search"))
            .query(&[("query", format!("to:{email}"))])
            .send()
            .unwrap()
            .json()
            .unwrap();
        if let Some(id) = list["messages"][0]["ID"].as_str() {
            let message: serde_json::Value = http
                .get(format!("{mailpit}/api/v1/message/{id}"))
                .send()
                .unwrap()
                .json()
                .unwrap();
            let text = message["Text"].as_str().unwrap_or_default();
            if let Some(start) = text.find("http") {
                let link: String = text[start..]
                    .chars()
                    .take_while(|c| !c.is_whitespace() && *c != ')')
                    .collect();
                let response = http.get(&link).send().unwrap();
                return response.headers()["location"].to_str().unwrap().to_owned();
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("no magic link for {email}");
}

#[test]
fn sign_in_register_sync_and_sign_out() {
    let Some((config, mailpit)) = env() else {
        eprintln!("skipped: AI_PROCTOR_SUPABASE_URL / _ANON_KEY / _MAILPIT_URL not set");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let clock: Arc<dyn Clock> = Arc::new(SystemClock::default());
    let outbox = Arc::new(Outbox::open(&dir.path().join("outbox"), &[7u8; 32]).unwrap());
    let keys: Arc<dyn KeyStore> = Arc::new(MemoryKeyStore::default());
    let account = |outbox: &Arc<Outbox>| {
        Account::new(
            config.clone(),
            keys.clone(),
            clock.clone(),
            Some(outbox.clone()),
            dir.path(),
        )
        .unwrap()
    };

    let _ = reqwest::blocking::Client::new()
        .delete(format!("{mailpit}/api/v1/messages"))
        .send();
    let first = account(&outbox);
    first.start_sign_in(EMAIL).unwrap();
    let redirect = redirect_from_email(&mailpit, EMAIL);
    first.complete_sign_in(&redirect).unwrap();
    assert!(first.attached());
    assert_eq!(first.email().as_deref(), Some(EMAIL));
    // Erin's seeded shift (Mon–Fri 09:00–17:00, Los Angeles) arrives with the config.
    let config = first.take_config().expect("config fetched on attach");
    assert_eq!(config.session_policy().shifts.len(), 1);
    assert!(first.take_config().is_none(), "handed over once");

    // A shift recorded locally reaches the server, with a heartbeat in between.
    let platform = Arc::new(FakePlatform::default());
    let fake_platform = platform.clone();
    let mut session = Session::new(
        SessionPolicy::default(),
        clock.clone(),
        platform,
        Arc::new(OutboxSink {
            outbox: outbox.clone(),
            clock: clock.clone(),
        }),
        Arc::new(FileSessionStore::new(dir.path())),
    );
    session.sign_in();
    session.clock_in(None).unwrap();
    assert_eq!(first.sync().unwrap().accepted, 1, "clock_in accepted");

    // State changes go out as events (STS-01) and the server takes them.
    let mut presence = PresenceTracker::default();
    fake_platform.update(|s| {
        s.session = SessionState::Locked;
        s.idle_seconds = 700;
        s.call.mic = true;
    });
    let events = presence.observe(fake_platform.as_ref(), clock.now());
    for e in &events {
        outbox
            .append(
                e.event_type,
                e.at,
                clock.mono_ms(),
                e.payload.clone(),
                clock.now(),
            )
            .unwrap();
    }
    assert_eq!(
        first.sync().unwrap().accepted,
        3,
        "lock, idle_start, call_start accepted"
    );
    fake_platform.update(|s| {
        s.session = SessionState::Active;
        s.idle_seconds = 0;
        s.call.mic = false;
    });
    for e in presence.observe(fake_platform.as_ref(), clock.now()) {
        outbox
            .append(e.event_type, e.at, clock.mono_ms(), e.payload, clock.now())
            .unwrap();
    }
    assert_eq!(
        first.sync().unwrap().accepted,
        3,
        "unlock, idle_end, call_end accepted"
    );
    first
        .heartbeat(&Heartbeat {
            idle_s: 3,
            locked: false,
            in_call: false,
            permissions: serde_json::json!({ "screen": "granted", "camera": "granted" }),
        })
        .unwrap();
    // A check-in card that passed, queued the way the card runner does it.
    let now = clock.now();
    let card = Card::show(
        now,
        now,
        &CardPolicy::default(),
        fake_platform.as_ref(),
        &ThreadRandom,
        None,
    );
    let mut pass = card.finish(Outcome::Pass, clock.now());
    let captured = capture(fake_platform.as_ref(), &CapturePolicy::default());
    captured.attach(&mut pass.payload);
    let event = outbox
        .append(
            "checkin",
            pass.at,
            clock.mono_ms(),
            pass.payload,
            clock.now(),
        )
        .unwrap();
    for (name, bytes) in &captured.files {
        outbox
            .add_upload(event.id, name, bytes, clock.now())
            .unwrap();
    }
    let stats = first.sync().unwrap();
    assert_eq!(stats.accepted, 1, "checkin accepted");
    assert_eq!(stats.uploaded, 2, "screenshot and webcam frame stored");

    session.clock_out().unwrap();
    assert_eq!(first.sync().unwrap().accepted, 1, "clock_out accepted");
    assert!(outbox.pending(10).unwrap().is_empty(), "everything acked");

    // Next launch: the refresh token in the keychain restores the session and the
    // same install registers as the same device.
    let second = account(&outbox);
    assert!(second.has_stored_session());
    second.restore().unwrap();
    assert!(second.attached());

    second.sign_out();
    assert!(!second.attached());
    assert!(!second.has_stored_session());
    assert!(matches!(
        account(&outbox).restore(),
        Err(SyncError::SignedOut(_))
    ));
}
