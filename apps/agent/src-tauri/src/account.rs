//! The signed-in account: magic-link sign-in (#16), device registration (#17) and
//! the background sync of the outbox (#23, #24).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use agent_core::auth::{self, Auth, AuthError};
use agent_core::clock::Clock;
use agent_core::config::AgentConfig;
use agent_core::keystore::KeyStore;
use agent_core::outbox::Outbox;
use agent_core::sync::{Api, ApiConfig, DeviceIdentity, Heartbeat, SyncError, SyncStats, Syncer};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// The dashboard (My data, monitoring notice): run-time environment first, then
/// the build's; local dev otherwise.
pub fn dashboard_url() -> String {
    std::env::var("AI_PROCTOR_DASHBOARD_URL")
        .ok()
        .or_else(|| option_env!("AI_PROCTOR_DASHBOARD_URL").map(str::to_owned))
        .unwrap_or_else(|| "http://localhost:5173".into())
        .trim_end_matches('/')
        .to_owned()
}

/// Supabase project for this build: runtime environment first (dev, tests), then
/// what the release build was compiled with. Without it the agent can't sign in.
pub fn api_config() -> Option<ApiConfig> {
    let url = std::env::var("AI_PROCTOR_SUPABASE_URL")
        .ok()
        .or_else(|| option_env!("AI_PROCTOR_SUPABASE_URL").map(str::to_owned))?;
    let anon_key = std::env::var("AI_PROCTOR_SUPABASE_ANON_KEY")
        .ok()
        .or_else(|| option_env!("AI_PROCTOR_SUPABASE_ANON_KEY").map(str::to_owned))?;
    Some(ApiConfig {
        url: url.trim_end_matches('/').to_owned(),
        anon_key,
    })
}

pub struct Account {
    auth: Arc<Auth>,
    config: ApiConfig,
    outbox: Option<Arc<Outbox>>,
    clock: Arc<dyn Clock>,
    data_dir: PathBuf,
    syncer: Mutex<Option<Syncer>>,
    /// Config fetched but not yet applied by the app, and the version it has.
    pending_config: Mutex<Option<AgentConfig>>,
    config_version: Mutex<Option<i64>>,
}

impl Account {
    pub fn new(
        config: ApiConfig,
        keys: Arc<dyn KeyStore>,
        clock: Arc<dyn Clock>,
        outbox: Option<Arc<Outbox>>,
        data_dir: &Path,
    ) -> Result<Self, AuthError> {
        let auth = Auth::new(config.clone(), keys, clock.clone())?;
        Ok(Self {
            auth: Arc::new(auth),
            config,
            outbox,
            clock,
            data_dir: data_dir.to_owned(),
            syncer: Mutex::new(None),
            pending_config: Mutex::new(None),
            config_version: Mutex::new(None),
        })
    }

    pub fn email(&self) -> Option<String> {
        self.auth.current().and_then(|s| s.email)
    }

    /// The device is registered and the syncer armed for this session.
    pub fn attached(&self) -> bool {
        self.syncer.lock().unwrap().is_some()
    }

    pub fn has_stored_session(&self) -> bool {
        self.auth.has_stored_session()
    }

    /// Step 1 of sign-in: email the magic link.
    pub fn start_sign_in(&self, email: &str) -> Result<(), AuthError> {
        self.auth.start(email)
    }

    /// The magic link came back as `aiproctor://auth?code=…`.
    pub fn complete_sign_in(&self, redirect: &str) -> Result<(), SyncError> {
        self.auth.complete(redirect)?;
        self.attach_device()
    }

    /// Resumes the stored session (refresh token in the keychain): at launch, or
    /// later if the network was down then.
    pub fn restore(&self) -> Result<(), SyncError> {
        self.auth.refresh()?;
        self.attach_device()
    }

    /// Ends the session here and on the server (best effort when offline).
    pub fn sign_out(&self) {
        *self.syncer.lock().unwrap() = None;
        self.auth.sign_out();
    }

    /// Registers this install (idempotent) and refreshes so the access token
    /// carries the device_id claim, then arms the syncer.
    fn attach_device(&self) -> Result<(), SyncError> {
        let api = Api::new(self.config.clone(), self.auth.clone())?;
        let registration = api.register_device(
            platform_name(),
            &os_version(),
            env!("CARGO_PKG_VERSION"),
            &self.hardware_hash(),
        )?;
        let session = self.auth.refresh()?;
        let org_id = auth::claims(&session.access_token)
            .and_then(|c| c.org_id)
            .ok_or_else(|| SyncError::SignedOut("account has no organisation".into()))?;
        tracing::info!(device_id = %registration.device_id, "device registered");
        let Some(outbox) = self.outbox.clone() else {
            return Err(SyncError::Refused(
                "the local queue is unavailable (keychain)".into(),
            ));
        };
        let syncer = Syncer::new(
            api,
            outbox,
            self.clock.clone(),
            DeviceIdentity {
                device_id: registration.device_id,
                org_id,
                user_id: session.user_id,
            },
        );
        let config = syncer.config()?;
        *self.syncer.lock().unwrap() = Some(syncer);
        self.keep_config(config);
        Ok(())
    }

    fn keep_config(&self, config: AgentConfig) {
        tracing::info!(
            policy_version = config.policy_version,
            config_version = config.version(),
            shifts = config.shifts.len(),
            "config received"
        );
        *self.config_version.lock().unwrap() = Some(config.version());
        *self.pending_config.lock().unwrap() = Some(config);
    }

    /// New config from the server since the last call, for the app to apply.
    pub fn take_config(&self) -> Option<AgentConfig> {
        self.pending_config.lock().unwrap().take()
    }

    pub fn sync(&self) -> Result<SyncStats, SyncError> {
        match self.syncer.lock().unwrap().as_ref() {
            Some(syncer) => syncer.sync_once(),
            None => Ok(SyncStats::default()),
        }
    }

    /// Sends a heartbeat; when its config_version differs from the config in use
    /// (the org's policy or something about this person changed), fetches the new config (`take_config`).
    pub fn heartbeat(&self, heartbeat: &Heartbeat) -> Result<(), SyncError> {
        let config = {
            let syncer = self.syncer.lock().unwrap();
            let Some(syncer) = syncer.as_ref() else {
                return Ok(());
            };
            let reply = syncer.heartbeat(heartbeat)?;
            if *self.config_version.lock().unwrap() == Some(reply.config_version()) {
                return Ok(());
            }
            syncer.config()?
        };
        self.keep_config(config);
        Ok(())
    }

    /// AGT-04: acknowledges the notice, then fetches the config again: the server now
    /// lets this person collect what that version describes (`take_config`).
    pub fn acknowledge_notice(&self, notice_id: Uuid) -> Result<(), SyncError> {
        let config = {
            let syncer = self.syncer.lock().unwrap();
            let Some(syncer) = syncer.as_ref() else {
                return Err(SyncError::Retry("not connected yet".into()));
            };
            syncer.api().acknowledge_notice(notice_id)?;
            syncer.config()?
        };
        self.keep_config(config);
        Ok(())
    }

    /// Fetches the config now (the notice changed under the person's feet).
    pub fn refresh_config(&self) -> Result<(), SyncError> {
        let config = {
            let syncer = self.syncer.lock().unwrap();
            let Some(syncer) = syncer.as_ref() else {
                return Err(SyncError::Retry("not connected yet".into()));
            };
            syncer.config()?
        };
        self.keep_config(config);
        Ok(())
    }

    /// CHK-23: sends what's queued first, so the server has the check-in.
    pub fn set_miss_reason(
        &self,
        checkin_id: Uuid,
        kind: Option<&str>,
        note: Option<&str>,
    ) -> Result<(), SyncError> {
        let syncer = self.syncer.lock().unwrap();
        let Some(syncer) = syncer.as_ref() else {
            return Err(SyncError::Retry("not connected yet".into()));
        };
        syncer.sync_once()?;
        syncer.api().set_miss_reason(checkin_id, kind, note)
    }

    /// A stable, non-identifying id for this install: SHA-256 of a random id kept
    /// in the app data folder (re-installing makes a new device).
    fn hardware_hash(&self) -> String {
        let path = self.data_dir.join("install-id");
        let id = std::fs::read_to_string(&path)
            .ok()
            .filter(|s| Uuid::parse_str(s.trim()).is_ok());
        let id = id.unwrap_or_else(|| {
            let id = Uuid::now_v7().to_string();
            let _ = std::fs::write(&path, &id);
            id
        });
        hex(&Sha256::digest(
            format!("ai-proctor-install:{}", id.trim()).as_bytes(),
        ))
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else {
        "macos"
    }
}

fn os_version() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
        {
            let v = String::from_utf8_lossy(&out.stdout).trim().to_owned();
            if !v.is_empty() {
                return v;
            }
        }
    }
    std::env::consts::OS.to_owned()
}
