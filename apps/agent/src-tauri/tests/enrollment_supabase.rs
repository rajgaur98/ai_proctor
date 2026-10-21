//! MDM enrollment (#86) end to end against a local Supabase (`scripts/stack.sh up`):
//! an admin creates an org token, a managed install signs in with it (magic link),
//! the admin revokes it, the enrolled install keeps working and a new install is
//! refused and signed out. Skipped unless AI_PROCTOR_SUPABASE_URL,
//! AI_PROCTOR_SUPABASE_ANON_KEY and AI_PROCTOR_MAILPIT_URL are set (see CLAUDE.md).

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use agent_core::clock::{Clock, SystemClock};
use agent_core::enrollment::Refusal;
use agent_core::keystore::{KeyStore, MemoryKeyStore};
use agent_core::outbox::Outbox;
use agent_core::sync::ApiConfig;
use ai_proctor_agent::account::Account;
use serde_json::{json, Value};

const EMAIL: &str = "lucas@acme.test";
const ADMIN: &str = "admin@acme.test";

fn env() -> Option<(ApiConfig, String)> {
    Some((
        ApiConfig {
            url: std::env::var("AI_PROCTOR_SUPABASE_URL").ok()?,
            anon_key: std::env::var("AI_PROCTOR_SUPABASE_ANON_KEY").ok()?,
        },
        std::env::var("AI_PROCTOR_MAILPIT_URL").ok()?,
    ))
}

/// The admin's access token (seed password, local stack only).
fn admin_token(config: &ApiConfig) -> String {
    let reply: Value = reqwest::blocking::Client::new()
        .post(format!("{}/auth/v1/token", config.url))
        .query(&[("grant_type", "password")])
        .header("apikey", &config.anon_key)
        .json(&json!({ "email": ADMIN, "password": "password123" }))
        .send()
        .unwrap()
        .json()
        .unwrap();
    reply["access_token"].as_str().unwrap().to_owned()
}

fn rpc(config: &ApiConfig, token: &str, name: &str, body: Value) -> Value {
    let response = reqwest::blocking::Client::new()
        .post(format!("{}/rest/v1/rpc/{name}", config.url))
        .header("apikey", &config.anon_key)
        .bearer_auth(token)
        .json(&body)
        .send()
        .unwrap();
    let status = response.status();
    let text = response.text().unwrap();
    assert!(status.is_success(), "{name}: {status} {text}");
    serde_json::from_str(&text).unwrap_or(Value::Null)
}

/// Follows the newest magic link for `email` up to its aiproctor:// redirect, as
/// the browser would (as in sign_in_supabase.rs).
fn redirect_from_email(mailpit: &str, email: &str) -> String {
    let http = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    for _ in 0..50 {
        let list: Value = http
            .get(format!("{mailpit}/api/v1/search"))
            .query(&[("query", format!("to:{email}"))])
            .send()
            .unwrap()
            .json()
            .unwrap();
        if let Some(id) = list["messages"][0]["ID"].as_str() {
            let message: Value = http
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

/// Signs `account` in as Lucas through a fresh magic link.
fn sign_in(account: &Account, mailpit: &str) -> Result<(), agent_core::sync::SyncError> {
    let _ = reqwest::blocking::Client::new()
        .delete(format!("{mailpit}/api/v1/messages"))
        .send();
    account.start_sign_in(EMAIL).unwrap();
    let redirect = redirect_from_email(mailpit, EMAIL);
    account.complete_sign_in(&redirect)
}

/// One install: its own data folder (install id) and keychain.
struct Install {
    dir: tempfile::TempDir,
    keys: Arc<dyn KeyStore>,
    outbox: Arc<Outbox>,
}

impl Install {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let outbox = Arc::new(Outbox::open(&dir.path().join("outbox"), &[9u8; 32]).unwrap());
        Self {
            dir,
            keys: Arc::new(MemoryKeyStore::default()),
            outbox,
        }
    }

    fn account(&self, config: &ApiConfig, token: Option<&str>) -> Account {
        let clock: Arc<dyn Clock> = Arc::new(SystemClock::default());
        Account::new(
            config.clone(),
            self.keys.clone(),
            clock,
            Some(self.outbox.clone()),
            Path::new(self.dir.path()),
        )
        .unwrap()
        .with_enrollment_token(token.map(str::to_owned))
    }
}

fn devices_enrolled(config: &ApiConfig, admin: &str, token_id: &str) -> i64 {
    rpc(config, admin, "list_enrollment_tokens", json!({}))
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == token_id)
        .map(|t| t["devices"].as_i64().unwrap())
        .expect("token listed")
}

#[test]
fn managed_install_enrolls_and_a_revoked_token_stops_new_devices() {
    let Some((config, mailpit)) = env() else {
        eprintln!("skipped: AI_PROCTOR_SUPABASE_URL / _ANON_KEY / _MAILPIT_URL not set");
        return;
    };
    let admin = admin_token(&config);
    let created = rpc(
        &config,
        &admin,
        "create_enrollment_token",
        json!({ "p_label": "Integration test" }),
    );
    let token_id = created[0]["id"].as_str().unwrap().to_owned();
    let token = created[0]["token"].as_str().unwrap().to_owned();
    assert!(agent_core::enrollment::normalize(&token).is_some());

    // A managed Mac: Lucas signs in, the install enrolls with the org token.
    let mac = Install::new();
    let first = mac.account(&config, Some(&token));
    sign_in(&first, &mailpit).unwrap();
    assert!(first.attached());
    assert_eq!(devices_enrolled(&config, &admin, &token_id), 1);

    // IT revokes the token: the enrolled install keeps working after a restart.
    rpc(
        &config,
        &admin,
        "revoke_enrollment_token",
        json!({ "p_id": token_id }),
    );
    let restarted = mac.account(&config, Some(&token));
    restarted.restore().unwrap();
    assert!(restarted.attached());
    assert_eq!(devices_enrolled(&config, &admin, &token_id), 1);

    // A new install with the revoked token is refused, and isn't left signed in.
    std::thread::sleep(Duration::from_secs(2));
    let other = Install::new();
    let refused = other.account(&config, Some(&token));
    let error = sign_in(&refused, &mailpit).unwrap_err();
    assert_eq!(Refusal::from_error(&error), Some(Refusal::TokenRevoked));
    assert!(!refused.attached());
    assert!(
        !refused.has_stored_session(),
        "signed out after the refusal"
    );

    // A token that isn't one of ours is refused the same way.
    std::thread::sleep(Duration::from_secs(2));
    let bogus = other.account(
        &config,
        Some("apet_this-is-not-a-real-token-but-looks-like-123"),
    );
    let error = sign_in(&bogus, &mailpit).unwrap_err();
    assert_eq!(Refusal::from_error(&error), Some(Refusal::TokenInvalid));
    assert!(!bogus.has_stored_session());

    restarted.sign_out();
}
