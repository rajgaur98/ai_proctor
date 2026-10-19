//! Agent sign-in (#16; AGT-02, NFR-SEC-03): magic link with PKCE.
//!
//! 1. `start` makes a PKCE verifier, keeps it in the keychain, and asks Supabase
//!    Auth to email a magic link carrying only the challenge. `create_user` is off:
//!    only invited employees can sign in.
//! 2. The link opens the browser, Supabase verifies it and redirects to
//!    `aiproctor://auth?code=…`, which the OS hands to the agent (deep link).
//! 3. `complete` exchanges the code with the verifier, which never left the agent,
//!    and stores the refresh token in the keychain.
//! 4. `access_token` refreshes in the background; a refused refresh (session
//!    ended, user deactivated, device revoked) signs the agent out.

use std::sync::{Arc, Mutex};
use std::time::Duration as StdDuration;

use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::clock::Clock;
use crate::keystore::KeyStore;
use crate::sync::{ApiConfig, SyncError, TokenProvider};

pub const REDIRECT_URL: &str = "aiproctor://auth";
const REFRESH_TOKEN_KEY: &str = "refresh-token";
const VERIFIER_KEY: &str = "pkce-verifier";
/// Refresh this long before the access token expires.
const REFRESH_MARGIN: Duration = Duration::seconds(60);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    /// RFC 7636: 32 random bytes as base64url (43 chars); S256 challenge.
    pub fn generate() -> Result<Self, AuthError> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| AuthError::Local(e.to_string()))?;
        Ok(Self::from_verifier(base64url(&bytes)))
    }

    pub fn from_verifier(verifier: String) -> Self {
        let challenge = base64url(&Sha256::digest(verifier.as_bytes()));
        Self {
            verifier,
            challenge,
        }
    }
}

fn base64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AuthError {
    #[error("network: {0}")]
    Network(String),
    /// Supabase refused (bad or expired link, unknown email, ended session).
    #[error("refused: {0}")]
    Refused(String),
    #[error("no sign-in in progress on this device")]
    NoPendingSignIn,
    #[error("{0}")]
    Local(String),
}

/// A Supabase Auth session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: DateTime<Utc>,
    pub user_id: Uuid,
    pub email: Option<String>,
}

#[derive(Deserialize)]
struct TokenReply {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
    user: TokenUser,
}

#[derive(Deserialize)]
struct TokenUser {
    id: Uuid,
    email: Option<String>,
}

/// Claims the agent needs from its access token (set by the access-token hook).
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct Claims {
    pub sub: Option<Uuid>,
    pub org_id: Option<Uuid>,
    pub device_id: Option<Uuid>,
    pub app_role: Option<String>,
}

/// Reads the payload of a JWT without verifying it: the server verifies; the agent
/// only needs to know its own org, user and device.
pub fn claims(access_token: &str) -> Option<Claims> {
    let payload = access_token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub struct Auth {
    http: reqwest::blocking::Client,
    config: ApiConfig,
    keys: Arc<dyn KeyStore>,
    clock: Arc<dyn Clock>,
    session: Mutex<Option<Session>>,
}

impl Auth {
    pub fn new(
        config: ApiConfig,
        keys: Arc<dyn KeyStore>,
        clock: Arc<dyn Clock>,
    ) -> Result<Self, AuthError> {
        let http = reqwest::blocking::Client::builder()
            .timeout(StdDuration::from_secs(30))
            .build()
            .map_err(|e| AuthError::Network(e.to_string()))?;
        Ok(Self {
            http,
            config,
            keys,
            clock,
            session: Mutex::new(None),
        })
    }

    /// A refresh token survives restarts: is one stored?
    pub fn has_stored_session(&self) -> bool {
        matches!(self.keys.get(REFRESH_TOKEN_KEY), Ok(Some(_)))
    }

    pub fn current(&self) -> Option<Session> {
        self.session.lock().unwrap().clone()
    }

    /// Step 1: email a magic link for `email`.
    pub fn start(&self, email: &str) -> Result<(), AuthError> {
        let email = email.trim();
        if !email.contains('@') {
            return Err(AuthError::Refused("enter your work email".into()));
        }
        let pkce = Pkce::generate()?;
        self.keys
            .set(VERIFIER_KEY, pkce.verifier.as_bytes())
            .map_err(|e| AuthError::Local(e.to_string()))?;
        let response = self
            .http
            .post(format!("{}/auth/v1/otp", self.config.url))
            .query(&[("redirect_to", REDIRECT_URL)])
            .header("apikey", &self.config.anon_key)
            .json(&json!({
                "email": email,
                "create_user": false,
                "code_challenge": pkce.challenge,
                "code_challenge_method": "s256",
            }))
            .send()
            .map_err(|e| AuthError::Network(e.to_string()))?;
        checked(response).map(|_| ())
    }

    /// Step 3: the deep link `aiproctor://auth?code=…` arrived.
    pub fn complete(&self, redirect: &str) -> Result<Session, AuthError> {
        let code =
            auth_code(redirect).ok_or_else(|| AuthError::Refused(error_description(redirect)))?;
        let verifier = self
            .keys
            .get(VERIFIER_KEY)
            .map_err(|e| AuthError::Local(e.to_string()))?
            .and_then(|v| String::from_utf8(v).ok())
            .ok_or(AuthError::NoPendingSignIn)?;
        let response = self
            .http
            .post(format!("{}/auth/v1/token", self.config.url))
            .query(&[("grant_type", "pkce")])
            .header("apikey", &self.config.anon_key)
            .json(&json!({ "auth_code": code, "code_verifier": verifier }))
            .send()
            .map_err(|e| AuthError::Network(e.to_string()))?;
        let session = self.store(parse(&checked(response)?)?)?;
        let _ = self.keys.delete(VERIFIER_KEY);
        Ok(session)
    }

    /// Exchanges the stored refresh token for a new session.
    pub fn refresh(&self) -> Result<Session, AuthError> {
        let refresh_token = self
            .keys
            .get(REFRESH_TOKEN_KEY)
            .map_err(|e| AuthError::Local(e.to_string()))?
            .and_then(|v| String::from_utf8(v).ok())
            .ok_or_else(|| AuthError::Refused("not signed in".into()))?;
        let response = self
            .http
            .post(format!("{}/auth/v1/token", self.config.url))
            .query(&[("grant_type", "refresh_token")])
            .header("apikey", &self.config.anon_key)
            .json(&json!({ "refresh_token": refresh_token }))
            .send()
            .map_err(|e| AuthError::Network(e.to_string()))?;
        match checked(response) {
            Ok(text) => self.store(parse(&text)?),
            Err(AuthError::Refused(reason)) => {
                // The session is over (signed out elsewhere, deactivated, revoked).
                self.forget();
                Err(AuthError::Refused(reason))
            }
            Err(e) => Err(e),
        }
    }

    /// Ends the session locally and on the server (best effort).
    pub fn sign_out(&self) {
        if let Some(session) = self.current() {
            let _ = self
                .http
                .post(format!("{}/auth/v1/logout", self.config.url))
                .header("apikey", &self.config.anon_key)
                .bearer_auth(&session.access_token)
                .send();
        }
        self.forget();
    }

    fn forget(&self) {
        *self.session.lock().unwrap() = None;
        let _ = self.keys.delete(REFRESH_TOKEN_KEY);
    }

    fn store(&self, reply: TokenReply) -> Result<Session, AuthError> {
        self.keys
            .set(REFRESH_TOKEN_KEY, reply.refresh_token.as_bytes())
            .map_err(|e| AuthError::Local(e.to_string()))?;
        let session = Session {
            expires_at: self.clock.now() + Duration::seconds(reply.expires_in),
            access_token: reply.access_token,
            refresh_token: reply.refresh_token,
            user_id: reply.user.id,
            email: reply.user.email,
        };
        *self.session.lock().unwrap() = Some(session.clone());
        Ok(session)
    }
}

impl TokenProvider for Auth {
    fn access_token(&self) -> Result<String, SyncError> {
        if let Some(session) = self.current() {
            if session.expires_at - self.clock.now() > REFRESH_MARGIN {
                return Ok(session.access_token);
            }
        }
        Ok(self.refresh()?.access_token)
    }
}

/// For the sync loop: network trouble and a locked keychain are retried; a refused
/// session means the person is signed out.
impl From<AuthError> for SyncError {
    fn from(error: AuthError) -> Self {
        match error {
            AuthError::Network(e) | AuthError::Local(e) => SyncError::Retry(e),
            e => SyncError::SignedOut(e.to_string()),
        }
    }
}

fn parse(text: &str) -> Result<TokenReply, AuthError> {
    serde_json::from_str(text).map_err(|e| AuthError::Local(format!("unexpected token reply: {e}")))
}

/// The body of a 2xx reply, or the Auth error mapped to retry (network, 5xx,
/// 429) or refused.
fn checked(response: reqwest::blocking::Response) -> Result<String, AuthError> {
    let status = response.status().as_u16();
    let text = response
        .text()
        .map_err(|e| AuthError::Network(e.to_string()))?;
    if (200..300).contains(&status) {
        return Ok(text);
    }
    let message = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| {
            v["msg"]
                .as_str()
                .or(v["error_description"].as_str())
                .or(v["message"].as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| text.chars().take(200).collect());
    if status >= 500 || status == 429 {
        return Err(AuthError::Network(format!("{status}: {message}")));
    }
    Err(AuthError::Refused(message))
}

/// `aiproctor://auth?code=…` → the code.
pub fn auth_code(redirect: &str) -> Option<String> {
    query_param(redirect, "code")
}

fn error_description(redirect: &str) -> String {
    query_param(redirect, "error_description")
        .or_else(|| query_param(redirect, "error"))
        .unwrap_or_else(|| "the sign-in link had no code".into())
}

fn query_param(url: &str, name: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let from_query = parsed
        .query_pairs()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned());
    // Supabase puts errors in the fragment for some flows.
    from_query.or_else(|| {
        parsed.fragment().and_then(|f| {
            reqwest::Url::parse(&format!("x:?{f}"))
                .ok()?
                .query_pairs()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.into_owned())
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::FakeClock;
    use crate::keystore::MemoryKeyStore;

    #[test]
    fn pkce_matches_the_rfc_7636_example() {
        let pkce = Pkce::from_verifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".into());
        assert_eq!(
            pkce.challenge,
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn generated_verifiers_are_43_url_safe_chars_and_unique() {
        let a = Pkce::generate().unwrap();
        let b = Pkce::generate().unwrap();
        assert_eq!(a.verifier.len(), 43);
        assert!(a
            .verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(a.verifier, b.verifier);
    }

    #[test]
    fn reads_the_code_or_the_error_from_the_redirect() {
        assert_eq!(
            auth_code("aiproctor://auth?code=abc-123").as_deref(),
            Some("abc-123")
        );
        assert_eq!(auth_code("aiproctor://auth#error=access_denied"), None);
        assert_eq!(
            error_description("aiproctor://auth#error=access_denied&error_description=Email+link+is+invalid+or+has+expired"),
            "Email link is invalid or has expired"
        );
    }

    #[test]
    fn reads_the_hook_claims_from_an_access_token() {
        let payload = base64url(
            br#"{"sub":"00000000-0000-4000-8000-0000000000c1","org_id":"00000000-0000-4000-8000-000000000001","app_role":"employee"}"#,
        );
        let claims = claims(&format!("h.{payload}.s")).unwrap();
        assert_eq!(claims.app_role.as_deref(), Some("employee"));
        assert_eq!(
            claims.org_id,
            Some(Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap())
        );
        assert_eq!(claims.device_id, None);
    }

    #[test]
    fn completing_without_a_pending_sign_in_is_refused() {
        let auth = Auth::new(
            ApiConfig {
                url: "http://127.0.0.1:9".into(),
                anon_key: "anon".into(),
            },
            Arc::new(MemoryKeyStore::default()),
            Arc::new(FakeClock::at("2026-10-20T00:00:00Z")),
        )
        .unwrap();
        assert_eq!(
            auth.complete("aiproctor://auth?code=x"),
            Err(AuthError::NoPendingSignIn)
        );
        assert!(!auth.has_stored_session());
    }
}
