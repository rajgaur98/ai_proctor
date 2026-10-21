//! `FakePlatform`: a scriptable `Platform` for tests, so agent logic runs in CI
//! without a screen or camera.

use std::sync::Mutex;

use chrono::{DateTime, Utc};

use crate::contracts::{PermissionKind, PermissionState, Permissions};
use crate::platform::{
    CallState, CameraDevice, CaptureError, Foreground, Frame, InjectedInput, Platform,
    RunEnvironment, ScreenRect, ScreenShare, SessionEndHandler, SessionState,
};
use crate::watchdog::{WatchdogError, WatchdogOutcome, WatchdogSpec, WatchdogState};

/// Every field can be changed mid-test through the setters.
#[derive(Debug)]
pub struct FakePlatform {
    state: Mutex<FakeState>,
    session_end: Mutex<Option<Handler>>,
}

/// The registered session-end handler (closures have no `Debug`).
struct Handler(SessionEndHandler);

impl std::fmt::Debug for Handler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SessionEndHandler")
    }
}

#[derive(Clone, Debug)]
pub struct FakeState {
    pub idle_seconds: u64,
    pub session: SessionState,
    pub call: CallState,
    pub screen_share: Option<ScreenShare>,
    pub foreground: Option<Foreground>,
    pub permissions: Permissions,
    /// macOS Accessibility (browser domains); `Unsupported` stands for Windows.
    pub accessibility: PermissionState,
    /// The permissions `request_permission` was called for, in order.
    pub permission_requests: Vec<PermissionKind>,
    pub displays: u32,
    /// What the screenshot does while the permission reads Granted (macOS can fail
    /// a capture after revoking while still saying "granted").
    pub screen: Result<(), CaptureError>,
    pub camera: Result<(), CaptureError>,
    /// Injected clicks the guard will report when it stops (ANT-02).
    pub injected_clicks: u32,
    /// Synthetic-looking clicks the guard will report when it stops (ANT-03, macOS).
    pub synthetic_clicks: u32,
    /// The camera `camera_device` names (ANT-05).
    pub camera_device: Option<CameraDevice>,
    /// What `run_environment` reports (ANT-07).
    pub environment: RunEnvironment,
    /// The scene the webcam sees. `None`: a different one for every capture, as a real
    /// camera never sends the same frame twice; a number repeats the same frame (ANT-06).
    pub webcam_scene: Option<u64>,
    /// Webcam captures so far (picks the next scene when none is set).
    pub webcam_captures: u64,
    /// What `detect_face` answers (CAP-07): a face, no face, or `None` (detection
    /// couldn't run).
    pub face: Option<bool>,
    /// Frames `detect_face` was asked about, so a test can see it never ran.
    pub face_checks: u32,
    /// The area the input guard is watching; `None` when it isn't running.
    pub input_guard: Option<ScreenRect>,
    pub notifications: Vec<(String, String)>,
    /// The registered watchdog, if any.
    pub watchdog: Option<WatchdogSpec>,
    /// This process was started by the watchdog.
    pub supervised: bool,
    /// `install_watchdog` starts the watchdog's own copy (macOS first run).
    pub hands_over: bool,
    /// `install_watchdog` fails with this.
    pub watchdog_error: Option<WatchdogError>,
    pub boot_time: Option<DateTime<Utc>>,
}

impl Default for FakeState {
    fn default() -> Self {
        Self {
            idle_seconds: 0,
            session: SessionState::Active,
            call: CallState::default(),
            screen_share: None,
            foreground: None,
            permissions: Permissions {
                screen: PermissionState::Granted,
                camera: PermissionState::Granted,
            },
            accessibility: PermissionState::Granted,
            permission_requests: Vec::new(),
            displays: 1,
            screen: Ok(()),
            camera: Ok(()),
            injected_clicks: 0,
            synthetic_clicks: 0,
            camera_device: Some(CameraDevice {
                name: "FaceTime HD Camera".into(),
                model: None,
            }),
            environment: RunEnvironment::default(),
            webcam_scene: None,
            webcam_captures: 0,
            face: Some(true),
            face_checks: 0,
            input_guard: None,
            notifications: Vec::new(),
            watchdog: None,
            supervised: false,
            hands_over: false,
            watchdog_error: None,
            boot_time: None,
        }
    }
}

impl Default for FakePlatform {
    fn default() -> Self {
        Self::new(FakeState::default())
    }
}

impl FakePlatform {
    pub fn new(state: FakeState) -> Self {
        Self {
            state: Mutex::new(state),
            session_end: Mutex::new(None),
        }
    }

    /// The OS announces a logout, restart or shutdown: calls the registered handler
    /// (if any), as the real platforms do.
    pub fn end_session(&self) {
        let handler = self
            .session_end
            .lock()
            .unwrap()
            .as_ref()
            .map(|h| h.0.clone());
        if let Some(handler) = handler {
            handler();
        }
    }

    /// Changes the fake's state, e.g. `fake.update(|s| s.idle_seconds = 700)`.
    pub fn update(&self, change: impl FnOnce(&mut FakeState)) {
        change(&mut self.state.lock().unwrap());
    }

    pub fn snapshot(&self) -> FakeState {
        self.state.lock().unwrap().clone()
    }

    /// A screen-like test image: a soft background with small high-contrast
    /// "text" blocks, so blur and compression behave as they would on a screen.
    fn frame(display: Option<u32>, width: u32, height: u32) -> Frame {
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                // Lines of 7 × 10 px glyph blocks with gaps, on a light gradient.
                let glyph = (y % 18) < 10 && (x % 8) < 6 && (x / 8 + y / 18) % 6 != 0;
                let v = if glyph {
                    30
                } else {
                    230 - (y * 20 / height.max(1)) as u8
                };
                rgba.extend_from_slice(&[v, v, v.saturating_add(10), 255]);
            }
        }
        Frame {
            display,
            width,
            height,
            rgba,
        }
    }

    /// A webcam-like test image: 16 px blocks of shades drawn from `scene`, so two
    /// scenes hash far apart and the same scene hashes the same (ANT-06).
    fn webcam_frame(width: u32, height: u32, scene: u64) -> Frame {
        let columns = width.div_ceil(16);
        let mut rng = fastrand::Rng::with_seed(scene);
        let shades: Vec<u8> = (0..columns * height.div_ceil(16))
            .map(|_| rng.u8(40..=220))
            .collect();
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                let v = shades[((y / 16) * columns + x / 16) as usize];
                rgba.extend_from_slice(&[v, v.saturating_sub(10), v, 255]);
            }
        }
        Frame {
            display: None,
            width,
            height,
            rgba,
        }
    }
}

impl Platform for FakePlatform {
    fn idle_seconds(&self) -> u64 {
        self.state.lock().unwrap().idle_seconds
    }

    fn session_state(&self) -> SessionState {
        self.state.lock().unwrap().session
    }

    fn call_state(&self) -> CallState {
        self.state.lock().unwrap().call
    }

    fn screen_share(&self) -> Option<ScreenShare> {
        self.state.lock().unwrap().screen_share
    }

    fn foreground(&self) -> Option<Foreground> {
        self.state.lock().unwrap().foreground.clone()
    }

    fn capture_screens(&self, max_width: u32) -> Result<Vec<Frame>, CaptureError> {
        let state = self.state.lock().unwrap();
        if state.permissions.screen != PermissionState::Granted {
            return Err(CaptureError::PermissionMissing);
        }
        state.screen.clone()?;
        Ok((1..=state.displays)
            .map(|d| Self::frame(Some(d), max_width, max_width * 10 / 16))
            .collect())
    }

    fn capture_webcam(&self, width: u32, height: u32) -> Result<Frame, CaptureError> {
        let mut state = self.state.lock().unwrap();
        if state.permissions.camera != PermissionState::Granted {
            return Err(CaptureError::PermissionMissing);
        }
        state.camera.clone()?;
        state.webcam_captures += 1;
        let scene = state.webcam_scene.unwrap_or(state.webcam_captures);
        Ok(Self::webcam_frame(width, height, scene))
    }

    fn detect_face(&self, frame: &Frame) -> Option<bool> {
        let mut state = self.state.lock().unwrap();
        assert!(
            frame.display.is_none(),
            "faces are only looked for on the webcam frame"
        );
        state.face_checks += 1;
        state.face
    }

    fn permissions(&self) -> Permissions {
        self.state.lock().unwrap().permissions.clone()
    }

    fn accessibility_permission(&self) -> PermissionState {
        self.state.lock().unwrap().accessibility
    }

    fn request_permission(&self, kind: PermissionKind) {
        self.state.lock().unwrap().permission_requests.push(kind);
    }

    fn start_input_guard(&self, area: ScreenRect) {
        self.state.lock().unwrap().input_guard = Some(area);
    }

    fn stop_input_guard(&self) -> InjectedInput {
        let mut state = self.state.lock().unwrap();
        // Like the real guard: what it counted is reported once, then it's clear.
        if state.input_guard.take().is_none() {
            return InjectedInput::default();
        }
        InjectedInput {
            count: std::mem::take(&mut state.injected_clicks),
            synthetic: std::mem::take(&mut state.synthetic_clicks),
        }
    }

    fn camera_device(&self) -> Option<CameraDevice> {
        self.state.lock().unwrap().camera_device.clone()
    }

    fn run_environment(&self) -> RunEnvironment {
        self.state.lock().unwrap().environment
    }

    fn notify(&self, title: &str, body: &str) {
        self.state
            .lock()
            .unwrap()
            .notifications
            .push((title.into(), body.into()));
    }

    fn install_watchdog(&self, spec: &WatchdogSpec) -> Result<WatchdogState, WatchdogError> {
        let mut state = self.state.lock().unwrap();
        if let Some(error) = state.watchdog_error.clone() {
            return Err(error);
        }
        let outcome = match &state.watchdog {
            None => WatchdogOutcome::Installed,
            Some(current) if current == spec => WatchdogOutcome::Unchanged,
            Some(_) => WatchdogOutcome::Updated,
        };
        state.watchdog = Some(spec.clone());
        Ok(WatchdogState {
            outcome,
            supervised: state.supervised,
            handed_over: state.hands_over && !state.supervised,
        })
    }

    fn uninstall_watchdog(&self) -> Result<(), WatchdogError> {
        self.state.lock().unwrap().watchdog = None;
        Ok(())
    }

    fn watchdog_installed(&self) -> bool {
        self.state.lock().unwrap().watchdog.is_some()
    }

    fn on_session_end(&self, handler: SessionEndHandler) {
        *self.session_end.lock().unwrap() = Some(Handler(handler));
    }

    fn boot_time(&self) -> Option<DateTime<Utc>> {
        self.state.lock().unwrap().boot_time
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_one_frame_per_display() {
        let fake = FakePlatform::default();
        fake.update(|s| s.displays = 2);
        let frames = fake.capture_screens(1280).unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[1].display, Some(2));
        assert!(frames.iter().all(|f| f.width == 1280));
    }

    #[test]
    fn missing_permission_fails_capture_without_panicking() {
        let fake = FakePlatform::default();
        fake.update(|s| s.permissions.camera = PermissionState::Denied);
        assert_eq!(
            fake.capture_webcam(320, 240),
            Err(CaptureError::PermissionMissing)
        );
        assert!(fake.capture_screens(1280).is_ok());
    }

    #[test]
    fn busy_camera_is_reported() {
        let fake = FakePlatform::default();
        fake.update(|s| s.camera = Err(CaptureError::CameraBusy));
        assert_eq!(fake.capture_webcam(320, 240), Err(CaptureError::CameraBusy));
    }

    #[test]
    fn installing_the_watchdog_twice_changes_nothing_the_second_time() {
        let fake = FakePlatform::default();
        let spec = WatchdogSpec {
            executable: "/Applications/AI Proctor.app/Contents/MacOS/agent".into(),
        };
        assert!(!fake.watchdog_installed());
        assert_eq!(
            fake.install_watchdog(&spec).unwrap().outcome,
            WatchdogOutcome::Installed
        );
        assert_eq!(
            fake.install_watchdog(&spec).unwrap().outcome,
            WatchdogOutcome::Unchanged
        );
        let moved = WatchdogSpec {
            executable: "/Users/lucas/AI Proctor.app/Contents/MacOS/agent".into(),
        };
        assert_eq!(
            fake.install_watchdog(&moved).unwrap().outcome,
            WatchdogOutcome::Updated
        );
        assert_eq!(fake.snapshot().watchdog, Some(moved));
        fake.uninstall_watchdog().unwrap();
        assert!(!fake.watchdog_installed());
    }

    #[test]
    fn records_notifications() {
        let fake = FakePlatform::default();
        fake.notify("Check-in", "Click 7");
        assert_eq!(
            fake.snapshot().notifications,
            vec![("Check-in".into(), "Click 7".into())]
        );
    }
}
