//! OS implementations of `agent_core::platform::Platform`. Real API calls land with
//! the features that need them (capture #21, activity #25, anti-cheat #26,
//! permissions #58/#59); until then these are stubs that report "nothing happening"
//! and fail captures with `Unsupported`.

use std::sync::Arc;

use agent_core::platform::Platform;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod unsupported;
#[cfg(target_os = "windows")]
mod windows;

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
