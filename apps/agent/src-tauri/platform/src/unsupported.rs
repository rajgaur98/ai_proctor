//! Any other OS: compiles so CI can build the workspace; never shipped.
//! Stub until the M1+ features implement each method.

use agent_core::contracts::{PermissionKind, PermissionState, Permissions};
use agent_core::platform::{
    CallState, CameraDevice, CaptureError, Foreground, Frame, GuardMode, InjectedInput, Platform,
    RunEnvironment, ScreenRect, ScreenShare, SessionEndHandler, SessionState,
};
use agent_core::watchdog::{WatchdogError, WatchdogSpec, WatchdogState};
use chrono::{DateTime, Utc};

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

    fn detect_face(&self, _frame: &Frame) -> Option<bool> {
        None
    }

    fn permissions(&self) -> Permissions {
        Permissions {
            screen: PermissionState::Unsupported,
            camera: PermissionState::Unsupported,
        }
    }

    fn accessibility_permission(&self) -> PermissionState {
        PermissionState::Unsupported
    }

    fn request_permission(&self, _kind: PermissionKind) {}

    fn start_input_guard(&self, _area: ScreenRect, _mode: GuardMode) {}

    fn stop_input_guard(&self) -> InjectedInput {
        InjectedInput::default()
    }

    fn camera_device(&self) -> Option<CameraDevice> {
        None
    }

    fn run_environment(&self) -> RunEnvironment {
        RunEnvironment::default()
    }

    fn notify(&self, title: &str, _body: &str) {
        tracing::debug!(title, "notification (stub)");
    }

    fn install_watchdog(&self, _spec: &WatchdogSpec) -> Result<WatchdogState, WatchdogError> {
        Err(WatchdogError::Unsupported)
    }

    fn uninstall_watchdog(&self) -> Result<(), WatchdogError> {
        Ok(())
    }

    fn watchdog_installed(&self) -> bool {
        false
    }

    fn boot_time(&self) -> Option<DateTime<Utc>> {
        None
    }

    fn on_session_end(&self, _handler: SessionEndHandler) {}

    fn managed_enrollment_token(&self) -> Option<String> {
        None
    }
}
