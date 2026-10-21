//! The `Platform` trait: the only boundary between agent logic and OS APIs
//! (LLD section 01). macOS and Windows implement it in `agent-platform`; tests use
//! `FakePlatform`.

use std::sync::Arc;

use chrono::{DateTime, Utc};

use crate::contracts::{PermissionKind, PermissionState, Permissions};
use crate::watchdog::{WatchdogError, WatchdogSpec, WatchdogState};

/// Whether the user's session is usable right now.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SessionState {
    #[default]
    Active,
    Locked,
    Asleep,
}

/// Camera or microphone in use by another app (CHK-03 deferral, "In meeting").
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CallState {
    pub camera: bool,
    pub mic: bool,
}

impl CallState {
    pub fn in_call(&self) -> bool {
        self.camera || self.mic
    }
}

/// Why the screen counts as shared (CHK-03). Recorded as the reason on a deferred
/// check-in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScreenShare {
    /// A screen share is running (Meet, Zoom, Teams, Webex).
    Sharing,
    /// A full-screen presentation (slideshow) is running.
    Presenting,
}

/// The frontmost app, for activity sampling (#25). Title and domain may be withheld
/// by policy or missing permissions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Foreground {
    pub app: String,
    pub title: Option<String>,
    pub domain: Option<String>,
    /// The display (1-based, as in `Frame.display`) the app's front window is on;
    /// `None` when unknown (no Screen Recording, no window, not supported).
    pub display: Option<u32>,
}

/// One captured image as raw pixels; blur and WebP encoding happen in
/// `capture`, the same on every OS.
#[derive(Clone, PartialEq, Eq)]
pub struct Frame {
    /// Display index (1-based) for screenshots; `None` for the webcam.
    pub display: Option<u32>,
    pub width: u32,
    pub height: u32,
    /// RGBA, 8 bits per channel, row by row (`width * height * 4` bytes).
    pub rgba: Vec<u8>,
}

impl std::fmt::Debug for Frame {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Frame")
            .field("display", &self.display)
            .field("width", &self.width)
            .field("height", &self.height)
            .field("bytes", &self.rgba.len())
            .finish()
    }
}

/// Why a capture failed. Stored with the check-in, which still passes (CAP-08).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CaptureError {
    #[error("permission missing")]
    PermissionMissing,
    #[error("camera in use by another app")]
    CameraBusy,
    #[error("no camera")]
    NoCamera,
    #[error("not supported on this platform")]
    Unsupported,
    #[error("capture failed: {0}")]
    Failed(String),
}

/// A rectangle on the virtual screen in physical pixels (origin top-left; the
/// position can be negative on a monitor left of or above the primary one).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl ScreenRect {
    /// Whether the point is inside (left and top edges in, right and bottom edges out).
    pub fn contains(&self, x: i32, y: i32) -> bool {
        let (x, y) = (i64::from(x), i64::from(y));
        let (left, top) = (i64::from(self.x), i64::from(self.y));
        x >= left
            && y >= top
            && x < left + i64::from(self.width)
            && y < top + i64::from(self.height)
    }
}

/// What the input guard saw while the card was up (ANT-02, #26; ANT-03, #63).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InjectedInput {
    /// Injected mouse clicks inside the card, none of which reached it (Windows).
    pub count: u32,
    /// Clicks on the card that look synthetic but were let through: flag only, never
    /// blocked (macOS, best effort: the OS can't always tell).
    pub synthetic: u32,
}

/// The camera `capture_webcam` uses, as the OS names it (ANT-05). Never opens it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CameraDevice {
    /// What the person sees in camera pickers ("FaceTime HD Camera", "OBS Virtual
    /// Camera").
    pub name: String,
    /// The model or driver id where the OS has one (macOS `modelID`); `None` elsewhere.
    pub model: Option<String>,
}

/// Where the agent runs (ANT-07). Best effort and raw: true only when the OS says so
/// plainly; anything unknown reads false.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RunEnvironment {
    /// Inside a virtual machine (a hypervisor guest).
    pub virtual_machine: bool,
    /// The session is shown on another computer (Remote Desktop) or remotely controlled.
    pub remote_session: bool,
}

/// Called when the OS announces that the person's session is ending (#159).
pub type SessionEndHandler = Arc<dyn Fn() + Send + Sync>;

pub trait Platform: Send + Sync {
    fn idle_seconds(&self) -> u64;
    fn session_state(&self) -> SessionState;
    fn call_state(&self) -> CallState;
    /// Screen sharing or a full-screen presentation (CHK-03 deferral).
    fn screen_share(&self) -> Option<ScreenShare>;
    fn foreground(&self) -> Option<Foreground>;
    fn capture_screens(&self, max_width: u32) -> Result<Vec<Frame>, CaptureError>;
    fn capture_webcam(&self, width: u32, height: u32) -> Result<Frame, CaptureError>;
    /// CAP-07: whether the webcam frame shows a face, worked out on the device with the
    /// OS's face *detector* (macOS Vision face rectangles, Windows FaceAnalysis): never
    /// recognition, landmarks or anything that could tell one person from another.
    /// Only the answer leaves this call; nothing about the face (position, size, crops,
    /// embeddings) is kept or returned. `None` when detection couldn't run (unsupported,
    /// the detector failed), which is not the same as "no face". Takes tens of
    /// milliseconds: call it from the capture's worker thread.
    fn detect_face(&self, frame: &Frame) -> Option<bool>;
    /// Current Screen Recording / Camera permission. Must never show a prompt.
    fn permissions(&self) -> Permissions;
    /// Accessibility (macOS; reading the browser's domain, #114), kept apart from
    /// `permissions()`: it is optional, so it is never reported as a permission change
    /// (the server would read that as Tamper). `Unsupported` where the OS has no such
    /// permission (Windows). Must never show a prompt.
    fn accessibility_permission(&self) -> PermissionState;
    /// Asks the OS for a permission, showing its own prompt where it has one (macOS
    /// Screen Recording, Camera and Accessibility, onboarding #59, #169). Returns
    /// without waiting for the answer; `permissions()` and `accessibility_permission()`
    /// report it. A no-op where there is nothing to ask.
    fn request_permission(&self, kind: PermissionKind);
    /// Starts watching for injected mouse clicks inside `area` (the card window)
    /// and swallowing them, so they never reach the card (ANT-02). Called when the
    /// card is shown; a second call replaces the first.
    fn start_input_guard(&self, area: ScreenRect);
    /// Stops the guard and returns what it swallowed since `start_input_guard`
    /// (zero when none was running or the OS can't tell). On macOS nothing is
    /// swallowed: clicks that look synthetic are only counted (ANT-03).
    fn stop_input_guard(&self) -> InjectedInput;
    /// The camera `capture_webcam` would use, by name, without opening it (ANT-05).
    /// `None` when there is none or the OS can't say.
    fn camera_device(&self) -> Option<CameraDevice>;
    /// Whether the agent runs in a virtual machine or a remote session (ANT-07).
    /// Cheap enough to call for every check-in card.
    fn run_environment(&self) -> RunEnvironment;
    /// OS notification (CHK-13 optional check-in notification).
    fn notify(&self, title: &str, body: &str);
    /// ANT-01: registers the helper the OS runs to start the agent again if it is
    /// killed (macOS LaunchAgent, Windows scheduled task). Safe to call at every
    /// launch: an existing registration with the same content is left alone.
    fn install_watchdog(&self, spec: &WatchdogSpec) -> Result<WatchdogState, WatchdogError>;
    /// Removes the helper (uninstall, or a dev build trying the agent without one).
    fn uninstall_watchdog(&self) -> Result<(), WatchdogError>;
    fn watchdog_installed(&self) -> bool;
    /// When the device last started up, to tell a reboot from a kill (ANT-01).
    /// `None` when the OS can't say.
    fn boot_time(&self) -> Option<DateTime<Utc>>;
    /// ANT-01: registers the one handler to call when the OS announces a logout,
    /// restart or shutdown (macOS `NSWorkspaceWillPowerOff`; Windows `WM_ENDSESSION`
    /// and the logoff session notification). The handler runs on the OS's own thread,
    /// right then: on Windows the process can be ended as soon as it returns, so it
    /// must clock out and mark the exit before it does, and quickly. A second call
    /// replaces the first; an announcement the OS then takes back is not reported.
    fn on_session_end(&self, handler: SessionEndHandler);
    /// AGT-01 (#86): the org enrollment token IT set through MDM, raw (the caller
    /// checks its shape: `enrollment::managed_token`). macOS reads the forced
    /// (managed) preference `EnrollmentToken` of `com.aiproctor.agent`; Windows the
    /// `EnrollmentToken` value under `HKLM\SOFTWARE\Policies\AIProctor\Agent`. `None` on
    /// a manual install. Never shows anything; cheap enough to call at launch.
    fn managed_enrollment_token(&self) -> Option<String>;
}
