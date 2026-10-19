//! Magic-link sign-in end to end against a local Supabase (`pnpm db:start`): send
//! the link, read it from the local mail catcher (Mailpit), follow it to the
//! `aiproctor://auth?code=…` redirect, exchange the code, refresh, sign out.
//! Skipped unless AI_PROCTOR_SUPABASE_URL, AI_PROCTOR_SUPABASE_ANON_KEY and
//! AI_PROCTOR_MAILPIT_URL are set (see CLAUDE.md).

use std::sync::Arc;
use std::time::Duration;

use agent_core::auth::{self, Auth, AuthError, REDIRECT_URL};
use agent_core::clock::SystemClock;
use agent_core::keystore::MemoryKeyStore;
use agent_core::sync::{ApiConfig, TokenProvider};

fn env() -> Option<(ApiConfig, String)> {
    Some((
        ApiConfig {
            url: std::env::var("AI_PROCTOR_SUPABASE_URL").ok()?,
            anon_key: std::env::var("AI_PROCTOR_SUPABASE_ANON_KEY").ok()?,
        },
        std::env::var("AI_PROCTOR_MAILPIT_URL").ok()?,
    ))
}

/// The newest magic link Mailpit holds for `email`, after `since` (unix seconds).
fn magic_link(mailpit: &str, email: &str) -> String {
    let http = reqwest::blocking::Client::new();
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
                if link.contains("/auth/v1/verify") {
                    return link;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("no magic link for {email}");
}

#[test]
fn magic_link_sign_in_round_trip() {
    let Some((config, mailpit)) = env() else {
        eprintln!("skipped: AI_PROCTOR_SUPABASE_URL / _ANON_KEY / _MAILPIT_URL not set");
        return;
    };
    let http = reqwest::blocking::Client::new();
    // Start from an empty mailbox so the newest link is ours.
    let _ = http.delete(format!("{mailpit}/api/v1/messages")).send();

    let auth = Auth::new(
        config.clone(),
        Arc::new(MemoryKeyStore::default()),
        Arc::new(SystemClock::default()),
    )
    .unwrap();

    // Only invited (existing) users get a link.
    auth.start("nobody@acme.test").ok();
    auth.start("lucas@acme.test").unwrap();

    // The browser's part: follow the link, stop at the custom-scheme redirect.
    let link = magic_link(&mailpit, "lucas@acme.test");
    let no_redirects = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let response = no_redirects.get(&link).send().unwrap();
    let location = response.headers()["location"].to_str().unwrap().to_owned();
    assert!(location.starts_with(REDIRECT_URL), "{location}");

    let session = auth.complete(&location).unwrap();
    assert_eq!(session.email.as_deref(), Some("lucas@acme.test"));
    let claims = auth::claims(&session.access_token).unwrap();
    assert_eq!(claims.sub, Some(session.user_id));
    assert!(claims.org_id.is_some(), "the access-token hook adds org_id");
    assert!(
        auth.has_stored_session(),
        "refresh token kept in the keychain"
    );

    // The same link can't be used twice.
    let replay = no_redirects.get(&link).send().unwrap();
    let replay_location = replay.headers()["location"].to_str().unwrap().to_owned();
    assert!(
        auth::auth_code(&replay_location).is_none(),
        "{replay_location}"
    );

    // Background refresh hands out a fresh token.
    let refreshed = auth.refresh().unwrap();
    assert_ne!(refreshed.access_token, session.access_token);
    assert!(auth.access_token().is_ok());

    // Sign-out ends the session: the old refresh token no longer works.
    auth.sign_out();
    assert!(!auth.has_stored_session());
    assert!(matches!(auth.refresh(), Err(AuthError::Refused(_))));
}
