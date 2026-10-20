//! OS implementations of `agent_core::platform::Platform`. Real API calls land with
//! the features that need them (capture #21, activity #25, anti-cheat #26,
//! permissions #58/#59); until then these are stubs that report "nothing happening"
//! and fail captures with `Unsupported`.

use std::sync::Arc;

use agent_core::platform::Platform;

pub mod input_guard;
pub mod keychain;

#[cfg(target_os = "macos")]
mod launchd;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
mod macos_notify;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod unsupported;
#[cfg(target_os = "windows")]
mod windows;

/// Shows the Accessibility prompt (browser domains, #25), which onboarding doesn't
/// cover. Debug builds use it; a no-op where there's nothing to ask.
pub fn request_accessibility() {
    #[cfg(target_os = "macos")]
    macos::request_accessibility();
}

/// Asks for permission to show notifications (macOS prompt; first call only). Until
/// guided onboarding (#59) the app calls it only from the debug permission path;
/// `Platform::notify` never asks, it does nothing without permission.
pub fn request_notification_permission() {
    #[cfg(target_os = "macos")]
    macos_notify::request_permission();
}

/// The platform for the OS this binary was built for.
pub fn current() -> Arc<dyn Platform> {
    #[cfg(target_os = "macos")]
    return Arc::new(macos::MacPlatform::new());
    #[cfg(target_os = "windows")]
    return Arc::new(windows::WindowsPlatform::new());
    // Linux only builds so CI can compile and test the workspace.
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Arc::new(unsupported::UnsupportedPlatform);
}
