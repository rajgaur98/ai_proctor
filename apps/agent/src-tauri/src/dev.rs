//! Debug-build switches that isolate a run from the real install, so tests can
//! drive the bundle unattended (#99). Absent from release builds.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use agent_core::contracts::Permissions;
use agent_core::keystore::{KeyStore, KeyStoreError};
use agent_core::platform::{
    CallState, CaptureError, Foreground, Frame, InjectedInput, Platform, ScreenRect, SessionState,
};

/// Outbox, session, schedule and install id go here instead of the app data dir.
pub const DATA_DIR_VAR: &str = "AI_PROCTOR_DEV_DATA_DIR";
/// Secrets go to files in this directory instead of the OS keychain (no prompt).
pub const KEYSTORE_VAR: &str = "AI_PROCTOR_DEV_KEYSTORE";
/// Path of the control socket (`dev_control.rs`, Unix only).
#[cfg(unix)]
pub const CONTROL_VAR: &str = "AI_PROCTOR_DEV_CONTROL";
/// Set (to anything) to report the session as unlocked: an unattended Mac is
/// usually locked, which holds every check-in (CHK-04).
pub const ACTIVE_SESSION_VAR: &str = "AI_PROCTOR_DEV_ACTIVE_SESSION";

fn dir_from_env(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from)
}

pub fn data_dir() -> Option<PathBuf> {
    dir_from_env(DATA_DIR_VAR)
}

pub fn keystore() -> Option<FileKeyStore> {
    dir_from_env(KEYSTORE_VAR).map(FileKeyStore::new)
}

#[cfg(unix)]
pub fn control_path() -> Option<PathBuf> {
    dir_from_env(CONTROL_VAR)
}

/// The real platform, except that the session always reads as unlocked when
/// `AI_PROCTOR_DEV_ACTIVE_SESSION` is set.
pub fn platform(real: Arc<dyn Platform>) -> Arc<dyn Platform> {
    if std::env::var_os(ACTIVE_SESSION_VAR).is_some() {
        tracing::warn!("dev platform: the session always reads as unlocked");
        return Arc::new(ActiveSession(real));
    }
    real
}

struct ActiveSession(Arc<dyn Platform>);

impl Platform for ActiveSession {
    fn idle_seconds(&self) -> u64 {
        self.0.idle_seconds()
    }
    fn session_state(&self) -> SessionState {
        SessionState::Active
    }
    fn call_state(&self) -> CallState {
        self.0.call_state()
    }
    fn screen_share(&self) -> Option<agent_core::platform::ScreenShare> {
        self.0.screen_share()
    }
    fn foreground(&self) -> Option<Foreground> {
        self.0.foreground()
    }
    fn capture_screens(&self, max_width: u32) -> Result<Vec<Frame>, CaptureError> {
        self.0.capture_screens(max_width)
    }
    fn capture_webcam(&self, width: u32, height: u32) -> Result<Frame, CaptureError> {
        self.0.capture_webcam(width, height)
    }
    fn permissions(&self) -> Permissions {
        self.0.permissions()
    }
    fn request_permission(&self, kind: agent_core::contracts::PermissionKind) {
        self.0.request_permission(kind)
    }
    fn start_input_guard(&self, area: ScreenRect) {
        self.0.start_input_guard(area)
    }
    fn stop_input_guard(&self) -> InjectedInput {
        self.0.stop_input_guard()
    }
    fn notify(&self, title: &str, body: &str) {
        self.0.notify(title, body)
    }
    fn install_watchdog(
        &self,
        spec: &agent_core::watchdog::WatchdogSpec,
    ) -> Result<agent_core::watchdog::WatchdogState, agent_core::watchdog::WatchdogError> {
        self.0.install_watchdog(spec)
    }
    fn uninstall_watchdog(&self) -> Result<(), agent_core::watchdog::WatchdogError> {
        self.0.uninstall_watchdog()
    }
    fn watchdog_installed(&self) -> bool {
        self.0.watchdog_installed()
    }
    fn boot_time(&self) -> Option<chrono::DateTime<chrono::Utc>> {
        self.0.boot_time()
    }
    fn on_session_end(&self, handler: agent_core::platform::SessionEndHandler) {
        self.0.on_session_end(handler)
    }
}

/// One file per secret, unencrypted: for throwaway test runs only.
pub struct FileKeyStore {
    dir: PathBuf,
}

impl FileKeyStore {
    pub fn new(dir: impl AsRef<Path>) -> Self {
        Self {
            dir: dir.as_ref().to_owned(),
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        let safe: String = name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        self.dir.join(safe)
    }
}

fn unavailable(error: std::io::Error) -> KeyStoreError {
    KeyStoreError::Unavailable(error.to_string())
}

impl KeyStore for FileKeyStore {
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, KeyStoreError> {
        match std::fs::read(self.path(name)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(unavailable(e)),
        }
    }

    fn set(&self, name: &str, secret: &[u8]) -> Result<(), KeyStoreError> {
        std::fs::create_dir_all(&self.dir).map_err(unavailable)?;
        std::fs::write(self.path(name), secret).map_err(unavailable)
    }

    fn delete(&self, name: &str) -> Result<(), KeyStoreError> {
        match std::fs::remove_file(self.path(name)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(unavailable(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_round_trip_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileKeyStore::new(dir.path().join("keys"));
        assert_eq!(store.get("refresh-token").unwrap(), None);
        store.set("refresh-token", b"abc").unwrap();
        assert_eq!(store.get("refresh-token").unwrap(), Some(b"abc".to_vec()));
        store.delete("refresh-token").unwrap();
        store.delete("refresh-token").unwrap();
        assert_eq!(store.get("refresh-token").unwrap(), None);
    }
}
