//! COM on a worker thread. Capture and UI Automation run on threads of their own
//! (a stuck driver or browser must not hang the caller), and each needs COM.

use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

/// COM initialised for the current thread; undone on drop. If the thread already
/// has COM in another mode (the call fails), the guard is a no-op and COM still
/// works, so the caller carries on either way.
pub struct Apartment {
    initialized: bool,
}

impl Apartment {
    pub fn enter() -> Self {
        // S_OK and S_FALSE (already initialised the same way) both count and both
        // need the matching CoUninitialize.
        let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
        Self { initialized }
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        if self.initialized {
            unsafe { CoUninitialize() };
        }
    }
}
