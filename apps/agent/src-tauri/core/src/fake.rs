//! `FakePlatform`: a scriptable `Platform` for tests, so agent logic runs in CI
//! without a screen or camera.

use std::sync::Mutex;

use crate::contracts::{PermissionState, Permissions};
use crate::platform::{
    CallState, CaptureError, Foreground, Frame, InjectedInput, Platform, ScreenRect, SessionState,
};

/// Every field can be changed mid-test through the setters.
#[derive(Debug)]
pub struct FakePlatform {
    state: Mutex<FakeState>,
}

#[derive(Clone, Debug)]
pub struct FakeState {
    pub idle_seconds: u64,
    pub session: SessionState,
    pub call: CallState,
    pub screen_shared: bool,
    pub foreground: Option<Foreground>,
    pub permissions: Permissions,
    pub displays: u32,
    pub camera: Result<(), CaptureError>,
    /// Injected clicks the guard will report when it stops (ANT-02).
    pub injected_clicks: u32,
    /// The area the input guard is watching; `None` when it isn't running.
    pub input_guard: Option<ScreenRect>,
    pub notifications: Vec<(String, String)>,
}

impl Default for FakeState {
    fn default() -> Self {
        Self {
            idle_seconds: 0,
            session: SessionState::Active,
            call: CallState::default(),
            screen_shared: false,
            foreground: None,
            permissions: Permissions {
                screen: PermissionState::Granted,
                camera: PermissionState::Granted,
            },
            displays: 1,
            camera: Ok(()),
            injected_clicks: 0,
            input_guard: None,
            notifications: Vec::new(),
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

    fn screen_shared(&self) -> bool {
        self.state.lock().unwrap().screen_shared
    }

    fn foreground(&self) -> Option<Foreground> {
        self.state.lock().unwrap().foreground.clone()
    }

    fn capture_screens(&self, max_width: u32) -> Result<Vec<Frame>, CaptureError> {
        let state = self.state.lock().unwrap();
        if state.permissions.screen != PermissionState::Granted {
            return Err(CaptureError::PermissionMissing);
        }
        Ok((1..=state.displays)
            .map(|d| Self::frame(Some(d), max_width, max_width * 10 / 16))
            .collect())
    }

    fn capture_webcam(&self, width: u32, height: u32) -> Result<Frame, CaptureError> {
        let state = self.state.lock().unwrap();
        if state.permissions.camera != PermissionState::Granted {
            return Err(CaptureError::PermissionMissing);
        }
        state
            .camera
            .clone()
            .map(|()| Self::frame(None, width, height))
    }

    fn permissions(&self) -> Permissions {
        self.state.lock().unwrap().permissions.clone()
    }

    fn start_input_guard(&self, area: ScreenRect) {
        self.state.lock().unwrap().input_guard = Some(area);
    }

    fn stop_input_guard(&self) -> InjectedInput {
        let mut state = self.state.lock().unwrap();
        // Like the real guard: what it counted is reported once, then it's clear.
        let count = if state.input_guard.take().is_some() {
            std::mem::take(&mut state.injected_clicks)
        } else {
            0
        };
        InjectedInput { count }
    }

    fn notify(&self, title: &str, body: &str) {
        self.state
            .lock()
            .unwrap()
            .notifications
            .push((title.into(), body.into()));
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
    fn records_notifications() {
        let fake = FakePlatform::default();
        fake.notify("Check-in", "Click 7");
        assert_eq!(
            fake.snapshot().notifications,
            vec![("Check-in".into(), "Click 7".into())]
        );
    }
}
