//! MDM enrollment (#86, AGT-01): IT deploys the agent with an org enrollment token in
//! its managed configuration (macOS managed preferences, Windows policy registry;
//! `docs/deploy/mdm.md`). The agent reads it through `Platform::managed_enrollment_token`
//! and sends it with `register_device` after the employee signs in, so the server can
//! check that the person belongs to the org that manages this computer.
//!
//! The token never goes into logs: only its prefix (`apet_` and four characters,
//! which the dashboard shows too).

use crate::platform::Platform;
use crate::sync::SyncError;

/// The preference key (macOS, domain `com.aiproctor.agent`) and registry value
/// (Windows) that hold the token.
pub const TOKEN_KEY: &str = "EnrollmentToken";
/// Windows: `HKEY_LOCAL_MACHINE\` + this key.
pub const WINDOWS_POLICY_KEY: &str = r"SOFTWARE\Policies\AIProctor\Agent";
/// macOS: the app's preference domain (its bundle id).
pub const MACOS_DOMAIN: &str = "com.aiproctor.agent";

const PREFIX: &str = "apet_";
const RANDOM_LEN: usize = 43;

/// The token as the server expects it, or `None` when `raw` isn't shaped like one
/// (whitespace around it, as a pasted profile value often has, is dropped).
pub fn normalize(raw: &str) -> Option<String> {
    let token = raw.trim();
    let rest = token.strip_prefix(PREFIX)?;
    (rest.len() == RANDOM_LEN
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
    .then(|| token.to_owned())
}

/// What may be logged about a token.
pub fn prefix(token: &str) -> &str {
    token.get(..PREFIX.len() + 4).unwrap_or(PREFIX)
}

/// The managed token for this computer, if IT set one. A malformed value is logged
/// (without the value) and ignored: the agent then enrolls like a manual install,
/// and the admin sees the device without a token in the dashboard.
pub fn managed_token(platform: &dyn Platform) -> Option<String> {
    let raw = platform.managed_enrollment_token()?;
    match normalize(&raw) {
        Some(token) => {
            tracing::info!(
                prefix = prefix(&token),
                "managed install: enrollment token found"
            );
            Some(token)
        }
        None => {
            tracing::warn!(
                length = raw.len(),
                "managed install: the enrollment token in the MDM configuration is malformed; ignored"
            );
            None
        }
    }
}

/// Why the server refused to enroll this computer at sign-in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The person signed in with an account from another org than the token's.
    OrgMismatch,
    /// An admin revoked the token and this is a new device.
    TokenRevoked,
    /// The server doesn't know the token.
    TokenInvalid,
}

impl Refusal {
    /// The server's reason (`register_device` raises it as the message).
    pub fn from_reason(reason: &str) -> Option<Self> {
        if reason.contains("enrollment_org_mismatch") {
            Some(Self::OrgMismatch)
        } else if reason.contains("enrollment_token_revoked") {
            Some(Self::TokenRevoked)
        } else if reason.contains("enrollment_token_invalid") {
            Some(Self::TokenInvalid)
        } else {
            None
        }
    }

    pub fn from_error(error: &SyncError) -> Option<Self> {
        match error {
            SyncError::SignedOut(reason) | SyncError::Refused(reason) => Self::from_reason(reason),
            _ => None,
        }
    }

    /// What the person is told (the agent signs them out).
    pub fn message(self) -> &'static str {
        match self {
            Self::OrgMismatch => {
                "This computer is managed by another organization. Sign in with your work account, or ask your IT team."
            }
            Self::TokenRevoked => {
                "This computer's enrollment was revoked. Ask your IT team for a new configuration, then sign in again."
            }
            Self::TokenInvalid => {
                "This computer's enrollment token isn't valid. Ask your IT team to check the AI Proctor configuration."
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::FakePlatform;

    const TOKEN: &str = "apet_local-test-token-for-acme-remote-not-secret";

    #[test]
    fn accepts_only_apet_and_43_base64url_characters() {
        assert_eq!(normalize(TOKEN).as_deref(), Some(TOKEN));
        assert_eq!(normalize(&format!("  {TOKEN}\n")).as_deref(), Some(TOKEN));
        assert_eq!(normalize(""), None);
        assert_eq!(normalize("apet_"), None);
        assert_eq!(normalize(&TOKEN[..TOKEN.len() - 1]), None, "too short");
        assert_eq!(normalize(&format!("{TOKEN}0")), None, "too long");
        assert_eq!(normalize(&TOKEN.replace("apet_", "xxxx_")), None);
        assert_eq!(normalize(&TOKEN.replace('-', "+")), None, "base64url only");
        assert_eq!(normalize(&TOKEN.replace("local", "lo al")), None);
    }

    #[test]
    fn logs_only_the_prefix() {
        assert_eq!(prefix(TOKEN), "apet_loca");
        assert_eq!(prefix("apet"), "apet_");
    }

    #[test]
    fn reads_the_token_from_the_platform() {
        let platform = FakePlatform::default();
        assert_eq!(managed_token(&platform), None, "a manual install has none");

        platform.update(|s| s.enrollment_token = Some(format!(" {TOKEN} ")));
        assert_eq!(managed_token(&platform).as_deref(), Some(TOKEN));

        platform.update(|s| s.enrollment_token = Some("paste the token here".into()));
        assert_eq!(
            managed_token(&platform),
            None,
            "a malformed value is ignored"
        );
    }

    #[test]
    fn maps_the_servers_refusals() {
        let body = |m: &str| SyncError::SignedOut(m.into());
        assert_eq!(
            Refusal::from_error(&body("enrollment_org_mismatch")),
            Some(Refusal::OrgMismatch)
        );
        assert_eq!(
            Refusal::from_error(&body("enrollment_token_revoked")),
            Some(Refusal::TokenRevoked)
        );
        assert_eq!(
            Refusal::from_error(&SyncError::Refused("403: enrollment_token_invalid".into())),
            Some(Refusal::TokenInvalid)
        );
        assert_eq!(Refusal::from_error(&body("user_inactive")), None);
        assert_eq!(Refusal::from_error(&SyncError::Revoked), None);
        assert_eq!(
            Refusal::from_error(&SyncError::Retry("enrollment_org_mismatch".into())),
            None,
            "only an answer from the server counts"
        );
    }
}
