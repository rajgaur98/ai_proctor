//! The `Platform` trait: the only boundary between agent logic and OS APIs
//! (LLD section 01). macOS and Windows implement it in `agent-platform`; tests use
//! `FakePlatform`.

use crate::contracts::Permissions;

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

/// The frontmost app, for activity sampling (#25). Title and domain may be withheld
/// by policy or missing permissions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Foreground {
    pub app: String,
    pub title: Option<String>,
    pub domain: Option<String>,
}

/// One encoded image (WebP).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Frame {
    /// Display index (1-based) for screenshots; `None` for the webcam.
    pub display: Option<u32>,
    pub width: u32,
    pub height: u32,
    pub webp: Vec<u8>,
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

/// A click on the check-in card, checked for synthetic input (anti-cheat, #26).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Click {
    pub x: f64,
    pub y: f64,
}

pub trait Platform: Send + Sync {
    fn idle_seconds(&self) -> u64;
    fn session_state(&self) -> SessionState;
    fn call_state(&self) -> CallState;
    /// Screen sharing or a full-screen presentation (CHK-04 deferral).
    fn screen_shared(&self) -> bool;
    fn foreground(&self) -> Option<Foreground>;
    fn capture_screens(&self, max_width: u32) -> Result<Vec<Frame>, CaptureError>;
    fn capture_webcam(&self, width: u32, height: u32) -> Result<Frame, CaptureError>;
    /// Current Screen Recording / Camera permission. Must never show a prompt.
    fn permissions(&self) -> Permissions;
    fn is_injected(&self, click: &Click) -> bool;
    /// OS notification (CHK-13 optional check-in notification).
    fn notify(&self, title: &str, body: &str);
}
