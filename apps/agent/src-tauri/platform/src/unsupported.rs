//! Any other OS: compiles so CI can build the workspace; never shipped.
//! Stub until the M1+ features implement each method.

use agent_core::contracts::{PermissionState, Permissions};
use agent_core::platform::{
    CallState, CaptureError, Click, Foreground, Frame, Platform, ScreenShare, SessionState,
};

#[derive(Default)]
pub struct UnsupportedPlatform;

impl Platform for UnsupportedPlatform {
    fn idle_seconds(&self) -> u64 {
        0
    }

    fn session_state(&self) -> SessionState {
        SessionState::Active
    }

    fn call_state(&self) -> CallState {
        CallState::default()
    }

    fn screen_share(&self) -> Option<ScreenShare> {
        None
    }

    fn foreground(&self) -> Option<Foreground> {
        None
    }

    fn capture_screens(&self, _max_width: u32) -> Result<Vec<Frame>, CaptureError> {
        Err(CaptureError::Unsupported)
    }

    fn capture_webcam(&self, _width: u32, _height: u32) -> Result<Frame, CaptureError> {
        Err(CaptureError::Unsupported)
    }

    fn permissions(&self) -> Permissions {
        Permissions {
            screen: PermissionState::Unsupported,
            camera: PermissionState::Unsupported,
        }
    }

    fn is_injected(&self, _click: &Click) -> bool {
        false
    }

    fn notify(&self, title: &str, _body: &str) {
        tracing::debug!(title, "notification (stub)");
    }
}
