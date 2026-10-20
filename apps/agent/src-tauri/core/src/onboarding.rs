//! Guided permission onboarding (#59; AGT-03). The window walks the person through
//! Screen Recording and Camera (macOS) or the camera privacy switches (Windows),
//! proves both work with a test capture, and says it is done. This is the logic
//! behind it: when it is finished, what the permission step may let through, and what
//! the test capture shows. Nothing from a test capture is kept: the previews exist
//! only in the reply to the window.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::capture::Captured;
use crate::contracts::{
    OnboardingPlatform, OnboardingState, PermissionState, Permissions, TestCaptureFailure,
    TestCaptureResult,
};
use crate::permissions::blocks;
use crate::platform::CaptureError;

/// Bumped when the flow changes enough that everyone should see it again.
pub const FLOW_VERSION: u32 = 1;

/// The flow's four steps, as in the design: Notice, Permissions, Test capture, Done.
pub const FIRST_STEP: u8 = 1;
pub const PERMISSIONS_STEP: u8 = 2;
pub const LAST_STEP: u8 = 4;

/// Where "finished on this device" is kept.
pub trait OnboardingStore: Send + Sync {
    /// The flow version last finished here, if any.
    fn load(&self) -> Option<u32>;
    fn save(&self, version: u32, at: DateTime<Utc>);
}

#[derive(Serialize, Deserialize)]
struct Saved {
    version: u32,
    completed_at: DateTime<Utc>,
}

/// JSON file, replaced atomically.
pub struct FileOnboardingStore {
    path: PathBuf,
}

impl FileOnboardingStore {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join("onboarding.json"),
        }
    }
}

impl OnboardingStore for FileOnboardingStore {
    fn load(&self) -> Option<u32> {
        let text = std::fs::read_to_string(&self.path).ok()?;
        serde_json::from_str::<Saved>(&text)
            .map(|saved| saved.version)
            .inspect_err(
                |e| tracing::error!(error = %e, "onboarding file unreadable; asking again"),
            )
            .ok()
    }

    fn save(&self, version: u32, at: DateTime<Utc>) {
        let tmp = self.path.with_extension("json.tmp");
        let result = serde_json::to_vec(&Saved {
            version,
            completed_at: at,
        })
        .map_err(std::io::Error::other)
        .and_then(|bytes| std::fs::write(&tmp, bytes))
        .and_then(|()| std::fs::rename(&tmp, &self.path));
        if let Err(e) = result {
            tracing::error!(error = %e, "could not save that onboarding is done");
        }
    }
}

/// Keeps nothing across runs: for builds and tests without a data directory.
#[derive(Default)]
pub struct MemoryOnboardingStore(Mutex<Option<u32>>);

impl OnboardingStore for MemoryOnboardingStore {
    fn load(&self) -> Option<u32> {
        *self.0.lock().unwrap()
    }

    fn save(&self, version: u32, _at: DateTime<Utc>) {
        *self.0.lock().unwrap() = Some(version);
    }
}

/// Where onboarding stands on this device.
pub struct Onboarding {
    store: Arc<dyn OnboardingStore>,
    completed: bool,
    /// The window has been opened for onboarding in this run (by the core or by the
    /// person), so the core doesn't open it again by itself.
    opened: bool,
    /// The step the window was last opened at, for a window that loads after the event.
    start_step: u8,
    /// Screen Recording reads as granted, yet a test capture failed for lack of it.
    restart_needed: bool,
}

impl Onboarding {
    pub fn new(store: Arc<dyn OnboardingStore>) -> Self {
        let completed = store.load().is_some_and(|v| v >= FLOW_VERSION);
        Self {
            store,
            completed,
            opened: false,
            start_step: FIRST_STEP,
            restart_needed: false,
        }
    }

    pub fn completed(&self) -> bool {
        self.completed
    }

    pub fn restart_needed(&self) -> bool {
        self.restart_needed
    }

    pub fn start_step(&self) -> u8 {
        self.start_step
    }

    /// The window is being opened at `step`.
    pub fn opened_at(&mut self, step: u8) {
        self.opened = true;
        self.start_step = step.clamp(FIRST_STEP, LAST_STEP);
    }

    /// True once per run: a signed-in person who has acknowledged a notice but hasn't
    /// finished onboarding on this device gets the permission step. Someone who still
    /// has to acknowledge gets the notice window, which carries on into the flow.
    pub fn take_prompt(&mut self, signed_in: bool, acknowledged: bool) -> bool {
        if self.completed || self.opened || !signed_in || !acknowledged {
            return false;
        }
        self.opened_at(PERMISSIONS_STEP);
        true
    }

    pub fn complete(&mut self, now: DateTime<Utc>) {
        self.completed = true;
        self.store.save(FLOW_VERSION, now);
    }

    /// A test capture finished: records whether the person needs to reopen the app.
    pub fn capture_tested(&mut self, captured: &Captured, os: &Permissions) {
        self.restart_needed = needs_restart(captured, os);
    }
}

/// What the permission step needs before Continue: Screen Recording is on, and the
/// camera too when the org's webcam setting is on (Camera is skipped otherwise).
pub fn ready(permissions: &Permissions, webcam: bool) -> bool {
    !blocks(&permissions.screen) && !(webcam && blocks(&permissions.camera))
}

/// macOS can say Screen Recording is on while ScreenCaptureKit still refuses, until
/// the app is reopened (spike #13). A permission failure with the OS saying "granted"
/// is that case.
pub fn needs_restart(captured: &Captured, os: &Permissions) -> bool {
    captured.screen_error == Some(CaptureError::PermissionMissing)
        && os.screen == PermissionState::Granted
}

pub fn state(
    platform: OnboardingPlatform,
    permissions: Permissions,
    webcam: bool,
    onboarding: &Onboarding,
) -> OnboardingState {
    OnboardingState {
        platform,
        ready: ready(&permissions, webcam),
        permissions,
        webcam,
        restart_needed: onboarding.restart_needed(),
        completed: onboarding.completed(),
        start_step: onboarding.start_step().into(),
    }
}

fn failure(error: &CaptureError) -> TestCaptureFailure {
    match error {
        CaptureError::PermissionMissing => TestCaptureFailure::PermissionMissing,
        CaptureError::CameraBusy => TestCaptureFailure::CameraBusy,
        CaptureError::NoCamera => TestCaptureFailure::NoCamera,
        CaptureError::Unsupported | CaptureError::Failed(_) => TestCaptureFailure::Failed,
    }
}

fn data_url(webp: &[u8]) -> String {
    format!(
        "data:image/webp;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(webp)
    )
}

/// The reply to the window: the captures as the manager would see them, as data URLs.
pub fn test_result(captured: &Captured, os: &Permissions) -> TestCaptureResult {
    let image = |name: &str| {
        captured
            .files
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, bytes)| data_url(bytes))
    };
    TestCaptureResult {
        ok: captured.screen_error.is_none() && captured.webcam_error.is_none(),
        screens: captured
            .files
            .iter()
            .filter(|(n, _)| n.starts_with("screen-"))
            .map(|(_, bytes)| data_url(bytes))
            .collect(),
        webcam: image("webcam.webp"),
        screen_error: captured.screen_error.as_ref().map(failure),
        webcam_error: captured.webcam_error.as_ref().map(failure),
        restart_needed: needs_restart(captured, os),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::{self, CapturePolicy};
    use crate::fake::FakePlatform;
    use crate::platform::Platform;

    fn perms(screen: PermissionState, camera: PermissionState) -> Permissions {
        Permissions { screen, camera }
    }

    fn t(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    fn memory() -> Onboarding {
        Onboarding::new(Arc::new(MemoryOnboardingStore::default()))
    }

    #[test]
    fn continue_needs_screen_recording_and_the_camera_only_when_the_webcam_is_on() {
        use PermissionState::*;
        assert!(ready(&perms(Granted, Granted), true));
        assert!(!ready(&perms(Denied, Granted), true));
        assert!(!ready(&perms(NotDetermined, Granted), false));
        assert!(!ready(&perms(Granted, NotDetermined), true));
        assert!(!ready(&perms(Granted, Restricted), true));
        assert!(
            ready(&perms(Granted, Denied), false),
            "webcam off: the camera isn't asked for"
        );
        assert!(
            ready(&perms(Unsupported, Unsupported), true),
            "nothing to ask where the OS has no permission"
        );
    }

    #[test]
    fn state_carries_the_gate_and_where_to_start() {
        let mut o = memory();
        o.opened_at(2);
        let s = state(
            OnboardingPlatform::Macos,
            perms(PermissionState::Granted, PermissionState::NotDetermined),
            true,
            &o,
        );
        assert!(!s.ready && !s.completed && !s.restart_needed);
        assert_eq!(s.start_step, 2);
        assert!(s.webcam);
        let s = state(
            OnboardingPlatform::Macos,
            perms(PermissionState::Granted, PermissionState::NotDetermined),
            false,
            &o,
        );
        assert!(s.ready && !s.webcam);
    }

    #[test]
    fn the_window_opens_once_for_someone_who_has_acknowledged_but_not_onboarded() {
        let mut o = memory();
        assert!(!o.take_prompt(false, true), "not signed in");
        assert!(!o.take_prompt(true, false), "the notice comes first");
        assert!(o.take_prompt(true, true));
        assert_eq!(o.start_step(), PERMISSIONS_STEP);
        assert!(!o.take_prompt(true, true), "once per run");
    }

    #[test]
    fn a_window_the_person_opened_is_not_opened_again_by_the_core() {
        let mut o = memory();
        o.opened_at(1);
        assert!(!o.take_prompt(true, true), "the flow is already on screen");
    }

    #[test]
    fn completion_is_kept_and_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(FileOnboardingStore::new(dir.path()));
        let mut o = Onboarding::new(store.clone());
        assert!(!o.completed());
        o.complete(t("2026-10-20T09:00:00Z"));
        assert!(o.completed());

        let mut again = Onboarding::new(Arc::new(FileOnboardingStore::new(dir.path())));
        assert!(again.completed());
        assert!(!again.take_prompt(true, true), "nothing more to ask");
    }

    #[test]
    fn an_older_flow_version_is_asked_again() {
        let dir = tempfile::tempdir().unwrap();
        FileOnboardingStore::new(dir.path()).save(FLOW_VERSION - 1, t("2026-10-20T09:00:00Z"));
        assert!(!Onboarding::new(Arc::new(FileOnboardingStore::new(dir.path()))).completed());
    }

    #[test]
    fn an_unreadable_file_means_not_done() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("onboarding.json"), "not json").unwrap();
        assert!(!Onboarding::new(Arc::new(FileOnboardingStore::new(dir.path()))).completed());
    }

    #[test]
    fn a_test_capture_becomes_previews_through_the_capture_pipeline() {
        let fake = FakePlatform::default();
        let captured = capture::capture(&fake, &CapturePolicy::default());
        let result = test_result(&captured, &fake.permissions());
        assert!(result.ok && !result.restart_needed);
        assert_eq!(result.screens.len(), 1);
        let prefix = "data:image/webp;base64,";
        assert!(result.screens[0].starts_with(prefix));
        let webcam = result.webcam.unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&webcam[prefix.len()..])
            .unwrap();
        assert_eq!(
            &bytes[..4],
            b"RIFF",
            "the encoded WebP, as the manager gets it"
        );
        assert_eq!((result.screen_error, result.webcam_error), (None, None));
    }

    #[test]
    fn a_failed_capture_says_why_and_the_rest_still_shows() {
        let fake = FakePlatform::default();
        fake.update(|s| s.camera = Err(CaptureError::CameraBusy));
        let captured = capture::capture(&fake, &CapturePolicy::default());
        let result = test_result(&captured, &fake.permissions());
        assert!(!result.ok);
        assert_eq!(result.screens.len(), 1);
        assert_eq!(result.webcam, None);
        assert_eq!(result.webcam_error, Some(TestCaptureFailure::CameraBusy));
    }

    #[test]
    fn granted_but_refused_means_reopen_the_app() {
        let fake = FakePlatform::default();
        // macOS still says "granted" while ScreenCaptureKit declines (spike #13).
        fake.update(|s| s.screen = Err(CaptureError::PermissionMissing));
        let captured = capture::capture(&fake, &CapturePolicy::default());
        let os = fake.permissions();
        let result = test_result(&captured, &os);
        assert!(!result.ok && result.restart_needed);
        assert_eq!(
            result.screen_error,
            Some(TestCaptureFailure::PermissionMissing)
        );

        let mut o = memory();
        o.capture_tested(&captured, &os);
        assert!(o.restart_needed());
        // The next capture works: the flag clears.
        fake.update(|s| s.screen = Ok(()));
        let captured = capture::capture(&fake, &CapturePolicy::default());
        o.capture_tested(&captured, &os);
        assert!(!o.restart_needed());
    }

    #[test]
    fn a_denied_permission_is_not_a_restart_problem() {
        let fake = FakePlatform::default();
        fake.update(|s| s.permissions.screen = PermissionState::Denied);
        let captured = capture::capture(&fake, &CapturePolicy::default());
        let result = test_result(&captured, &fake.permissions());
        assert!(!result.ok && !result.restart_needed);
    }

    #[test]
    fn nothing_is_attempted_that_the_policy_turns_off() {
        let fake = FakePlatform::default();
        fake.update(|s| s.permissions.camera = PermissionState::Denied);
        let policy = CapturePolicy {
            webcam: false,
            ..CapturePolicy::default()
        };
        let captured = capture::capture(&fake, &policy);
        let result = test_result(&captured, &fake.permissions());
        assert!(result.ok, "webcam off: its permission doesn't matter");
        assert_eq!((result.webcam, result.webcam_error), (None, None));
    }
}
