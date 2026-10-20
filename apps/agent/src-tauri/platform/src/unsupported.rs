//! Any other OS: compiles so CI can build the workspace; never shipped.
//! Stub until the M1+ features implement each method.

use agent_core::contracts::{PermissionState, Permissions};
use agent_core::platform::{
    CallState, CaptureError, Foreground, Frame, InjectedInput, Platform, ScreenRect, SessionState,
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

    fn screen_shared(&self) -> bool {
        false
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

    fn start_input_guard(&self, _area: ScreenRect) {}

    fn stop_input_guard(&self) -> InjectedInput {
        InjectedInput::default()
    }

    fn notify(&self, title: &str, _body: &str) {
        tracing::debug!(title, "notification (stub)");
    }
}
