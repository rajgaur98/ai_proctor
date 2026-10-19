//! macOS (objc2: ScreenCaptureKit, AVFoundation, AppKit, CoreAudio, CoreMediaIO).
//! Presence signals (idle, lock/sleep, camera/mic, sharing/presenting) are real, from
//! spike #14 (`docs/spikes/presence-signals.md`). Capture, permissions and the rest
//! stay stubs until the features that need them land.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use agent_core::contracts::{PermissionState, Permissions};
use agent_core::platform::{
    CallState, CaptureError, Click, Foreground, Frame, Platform, SessionState,
};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2_app_kit::NSWorkspace;
use objc2_core_audio::{
    kAudioDevicePropertyDeviceIsRunningSomewhere, kAudioHardwarePropertyDefaultInputDevice,
    kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    AudioObjectGetPropertyData, AudioObjectPropertyAddress,
};
use objc2_core_foundation::{CFArray, CFDictionary};
use objc2_core_graphics::{
    CGDisplayBounds, CGEventSource, CGEventSourceStateID, CGEventType, CGGetActiveDisplayList,
    CGSessionCopyCurrentDictionary, CGWindowListCopyWindowInfo, CGWindowListOption,
};
use objc2_core_media_io::{
    kCMIODevicePropertyDeviceIsRunningSomewhere, kCMIOHardwarePropertyDevices,
    kCMIOObjectPropertyElementMain, kCMIOObjectPropertyScopeGlobal, kCMIOObjectSystemObject,
    CMIOObjectGetPropertyData, CMIOObjectGetPropertyDataSize, CMIOObjectPropertyAddress,
};
use objc2_foundation::{
    NSArray, NSDictionary, NSNotification, NSNumber, NSObjectProtocol, NSString,
};

/// Notification tokens, kept alive so the observers stay registered.
struct Observer(#[allow(dead_code)] Retained<ProtocolObject<dyn NSObjectProtocol>>);

// The tokens are only held, never messaged, after registration.
unsafe impl Send for Observer {}

#[derive(Default)]
pub struct MacPlatform {
    asleep: Arc<AtomicBool>,
    observing: AtomicBool,
    observers: Mutex<Vec<Observer>>,
}

impl MacPlatform {
    pub fn new() -> Self {
        let platform = Self::default();
        platform.start_observers();
        platform
    }

    /// Registers the NSWorkspace sleep/wake observers. Idempotent, called by `new()`.
    /// Registration is thread-safe; notifications are delivered on the main run
    /// loop, so the app's main loop (Tauri's) must be running for sleep state to
    /// update. Without it `session_state` still reports Locked via the session poll.
    pub fn start_observers(&self) {
        if self.observing.swap(true, Ordering::SeqCst) {
            return;
        }
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        let (will_sleep, did_wake) = unsafe {
            (
                objc2_app_kit::NSWorkspaceWillSleepNotification,
                objc2_app_kit::NSWorkspaceDidWakeNotification,
            )
        };
        let mut tokens = Vec::new();
        for (name, asleep) in [(will_sleep, true), (did_wake, false)] {
            let flag = Arc::clone(&self.asleep);
            let block = RcBlock::new(move |_: NonNull<NSNotification>| {
                flag.store(asleep, Ordering::SeqCst);
                tracing::debug!(asleep, "system sleep state changed");
            });
            let token = unsafe {
                center.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
            };
            tokens.push(Observer(token));
        }
        if let Ok(mut held) = self.observers.lock() {
            held.extend(tokens);
        }
        tracing::info!(platform = "macos", "sleep/wake observers registered");
    }
}

impl Platform for MacPlatform {
    fn idle_seconds(&self) -> u64 {
        // kCGAnyInputEventType = ~0
        let secs = CGEventSource::seconds_since_last_event_type(
            CGEventSourceStateID::CombinedSessionState,
            CGEventType(u32::MAX),
        );
        if secs.is_finite() && secs > 0.0 {
            secs as u64
        } else {
            0
        }
    }

    fn session_state(&self) -> SessionState {
        if self.asleep.load(Ordering::SeqCst) {
            SessionState::Asleep
        } else if screen_locked() {
            SessionState::Locked
        } else {
            SessionState::Active
        }
    }

    fn call_state(&self) -> CallState {
        CallState {
            camera: camera_running(),
            mic: mic_running(),
        }
    }

    fn screen_shared(&self) -> bool {
        let windows = window_list();
        if is_sharing(&windows) {
            return true;
        }
        let Some(pid) = frontmost_pid() else {
            return false;
        };
        is_presenting(&windows, &display_bounds(), pid)
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

// --- Decision rules (pure, unit-tested) ---------------------------------------

/// A rectangle in global display coordinates.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// One on-screen window from `CGWindowListCopyWindowInfo`.
#[derive(Clone, Debug, Default)]
struct WindowInfo {
    owner_pid: i32,
    title: String,
    layer: i64,
    bounds: Rect,
}

/// Presentation (Keynote/PowerPoint slideshow): the frontmost app owns a window
/// above normal level covering a whole display. A full-screen app only has a thin
/// strip above normal level, so it is not a presentation.
fn is_presenting(windows: &[WindowInfo], displays: &[Rect], pid: i32) -> bool {
    windows
        .iter()
        .filter(|w| w.owner_pid == pid && w.layer > 0)
        .any(|w| displays.contains(&w.bounds))
}

/// A window title that suggests an active screen share (Meet/Chrome "... is sharing
/// your screen", Zoom share toolbar, Teams sharing bar). Titles are only filled in
/// when Screen Recording is granted.
fn is_sharing(windows: &[WindowInfo]) -> bool {
    // Only the indicator wording: broad words ("presenting", "screen share")
    // also match page and document titles and would hold check-ins back for as
    // long as such a window is open. Meet/Chrome/Brave verified in spike #14;
    // Zoom's toolbar unverified (M6 device list).
    const HINTS: [&str; 5] = [
        "is sharing your screen",
        "is sharing a window",
        "is sharing a tab",
        "is sharing this tab",
        "zoom share toolbar",
    ];
    windows.iter().any(|w| {
        let title = w.title.to_lowercase();
        HINTS.iter().any(|h| title.contains(h))
    })
}

// --- OS reads --------------------------------------------------------------------

/// `CGSSessionScreenIsLocked` in the current session dictionary.
fn screen_locked() -> bool {
    let Some(dict) = CGSessionCopyCurrentDictionary() else {
        tracing::debug!("no session dictionary, assuming unlocked");
        return false;
    };
    let dict: &NSDictionary<NSString, AnyObject> =
        unsafe { &*(&*dict as *const CFDictionary as *const NSDictionary<NSString, AnyObject>) };
    dict.objectForKey(&NSString::from_str("CGSSessionScreenIsLocked"))
        .and_then(|v| v.downcast::<NSNumber>().ok())
        .is_some_and(|n| n.boolValue())
}

/// CoreMediaIO: true if any video device is running in any process.
fn camera_running() -> bool {
    let devices_addr = CMIOObjectPropertyAddress {
        mSelector: kCMIOHardwarePropertyDevices,
        mScope: kCMIOObjectPropertyScopeGlobal,
        mElement: kCMIOObjectPropertyElementMain,
    };
    let mut size = 0u32;
    let status = unsafe {
        CMIOObjectGetPropertyDataSize(
            kCMIOObjectSystemObject,
            &devices_addr,
            0,
            std::ptr::null(),
            &mut size,
        )
    };
    if status != 0 {
        tracing::debug!(
            status,
            "camera device list size failed, assuming not in use"
        );
        return false;
    }
    if size == 0 {
        return false;
    }
    let mut ids = vec![0u32; size as usize / std::mem::size_of::<u32>()];
    let mut used = 0u32;
    let status = unsafe {
        CMIOObjectGetPropertyData(
            kCMIOObjectSystemObject,
            &devices_addr,
            0,
            std::ptr::null(),
            size,
            &mut used,
            ids.as_mut_ptr() as *mut c_void,
        )
    };
    if status != 0 {
        tracing::debug!(status, "camera device list failed, assuming not in use");
        return false;
    }
    let running_addr = CMIOObjectPropertyAddress {
        mSelector: kCMIODevicePropertyDeviceIsRunningSomewhere,
        mScope: kCMIOObjectPropertyScopeGlobal,
        mElement: kCMIOObjectPropertyElementMain,
    };
    ids.iter().any(|id| {
        let mut running = 0u32;
        let mut used = 0u32;
        let status = unsafe {
            CMIOObjectGetPropertyData(
                *id,
                &running_addr,
                0,
                std::ptr::null(),
                std::mem::size_of::<u32>() as u32,
                &mut used,
                &mut running as *mut u32 as *mut c_void,
            )
        };
        status == 0 && running != 0
    })
}

/// CoreAudio: true if the default input device is running in any process.
fn mic_running() -> bool {
    let mut device: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    let addr = AudioObjectPropertyAddress {
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let status = unsafe {
        AudioObjectGetPropertyData(
            kAudioObjectSystemObject as u32,
            NonNull::from(&addr),
            0,
            std::ptr::null(),
            NonNull::from(&mut size),
            NonNull::from(&mut device).cast(),
        )
    };
    if status != 0 {
        tracing::debug!(
            status,
            "default input device lookup failed, assuming mic idle"
        );
        return false;
    }
    if device == 0 {
        return false;
    }
    let mut running: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    let addr = AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let status = unsafe {
        AudioObjectGetPropertyData(
            device,
            NonNull::from(&addr),
            0,
            std::ptr::null(),
            NonNull::from(&mut size),
            NonNull::from(&mut running).cast(),
        )
    };
    if status != 0 {
        tracing::debug!(status, "mic running query failed, assuming mic idle");
        return false;
    }
    running != 0
}

fn frontmost_pid() -> Option<i32> {
    NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .map(|app| app.processIdentifier())
}

/// On-screen windows. Titles are only filled in when Screen Recording is granted.
fn window_list() -> Vec<WindowInfo> {
    // kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements
    let Some(list) = CGWindowListCopyWindowInfo(CGWindowListOption(1 | 16), 0) else {
        tracing::debug!("window list unavailable, assuming no sharing");
        return Vec::new();
    };
    let list: &NSArray<NSDictionary<NSString, AnyObject>> = unsafe {
        &*(&*list as *const CFArray as *const NSArray<NSDictionary<NSString, AnyObject>>)
    };
    let text = |d: &NSDictionary<NSString, AnyObject>, k: &str| {
        d.objectForKey(&NSString::from_str(k))
            .and_then(|v| v.downcast::<NSString>().ok())
            .map(|s| s.to_string())
            .unwrap_or_default()
    };
    let number = |d: &NSDictionary<NSString, AnyObject>, k: &str| {
        d.objectForKey(&NSString::from_str(k))
            .and_then(|v| v.downcast::<NSNumber>().ok())
            .map(|n| n.doubleValue())
            .unwrap_or(0.0)
    };
    list.iter()
        .map(|d| {
            let bounds = d
                .objectForKey(&NSString::from_str("kCGWindowBounds"))
                .and_then(|v| v.downcast::<NSDictionary>().ok())
                .map(|b| {
                    let b: &NSDictionary<NSString, AnyObject> =
                        unsafe { &*(Retained::as_ptr(&b) as *const _) };
                    Rect {
                        x: number(b, "X"),
                        y: number(b, "Y"),
                        width: number(b, "Width"),
                        height: number(b, "Height"),
                    }
                })
                .unwrap_or_default();
            WindowInfo {
                owner_pid: number(&d, "kCGWindowOwnerPID") as i32,
                title: text(&d, "kCGWindowName"),
                layer: number(&d, "kCGWindowLayer") as i64,
                bounds,
            }
        })
        .collect()
}

fn display_bounds() -> Vec<Rect> {
    let mut ids = [0u32; 16];
    let mut count = 0u32;
    unsafe { CGGetActiveDisplayList(16, ids.as_mut_ptr(), &mut count) };
    ids[..(count as usize).min(ids.len())]
        .iter()
        .map(|id| {
            let r = CGDisplayBounds(*id);
            Rect {
                x: r.origin.x,
                y: r.origin.y,
                width: r.size.width,
                height: r.size.height,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    };
    const SECOND: Rect = Rect {
        x: 1920.0,
        y: 0.0,
        width: 1280.0,
        height: 720.0,
    };

    fn window(pid: i32, title: &str, layer: i64, bounds: Rect) -> WindowInfo {
        WindowInfo {
            owner_pid: pid,
            title: title.into(),
            layer,
            bounds,
        }
    }

    #[test]
    fn slideshow_window_above_normal_level_covering_display_is_presenting() {
        let windows = [window(10, "", 0, MAIN), window(10, "", 9, MAIN)];
        assert!(is_presenting(&windows, &[MAIN], 10));
    }

    #[test]
    fn presenting_on_second_display() {
        let windows = [window(10, "", 26, SECOND)];
        assert!(is_presenting(&windows, &[MAIN, SECOND], 10));
    }

    #[test]
    fn normal_level_window_covering_display_is_not_presenting() {
        let windows = [window(10, "Editor", 0, MAIN)];
        assert!(!is_presenting(&windows, &[MAIN], 10));
    }

    #[test]
    fn full_screen_app_top_strip_is_not_presenting() {
        let strip = Rect {
            height: 38.0,
            ..MAIN
        };
        let windows = [window(10, "", 20, strip), window(10, "Doc", 0, MAIN)];
        assert!(!is_presenting(&windows, &[MAIN], 10));
    }

    #[test]
    fn covering_window_of_another_app_is_not_presenting() {
        let windows = [window(11, "", 9, MAIN)];
        assert!(!is_presenting(&windows, &[MAIN], 10));
    }

    #[test]
    fn no_displays_or_windows_is_not_presenting() {
        assert!(!is_presenting(&[], &[MAIN], 10));
        assert!(!is_presenting(&[window(10, "", 9, MAIN)], &[], 10));
    }

    #[test]
    fn meet_sharing_window_is_sharing() {
        let windows = [window(
            1,
            "meet.google.com is sharing your screen.",
            25,
            MAIN,
        )];
        assert!(is_sharing(&windows));
    }

    #[test]
    fn sharing_hints_match_case_insensitively() {
        let windows = [window(1, "MEET.GOOGLE.COM IS SHARING A WINDOW.", 25, MAIN)];
        assert!(is_sharing(&windows));
    }

    #[test]
    fn ordinary_and_untitled_windows_are_not_sharing() {
        let windows = [
            window(1, "Inbox - Mail", 0, MAIN),
            window(2, "", 0, MAIN),
            window(3, "Quarterly report.pptx", 0, MAIN),
            // Page titles that merely mention sharing must not hold check-ins back.
            window(4, "How to screen share on a Mac - YouTube", 0, MAIN),
            window(5, "Presenting Q3 results.key", 0, MAIN),
        ];
        assert!(!is_sharing(&windows));
        assert!(!is_sharing(&[]));
    }
}
