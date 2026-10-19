//! #14: presence signals on macOS. Polls once a second and logs every change, so
//! each signal can be checked against what Raj does (calls, sharing, locking).

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::Mutex;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2_app_kit::NSWorkspace;
use objc2_av_foundation::{AVCaptureDevice, AVMediaTypeVideo};
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
    NSArray, NSDictionary, NSDistributedNotificationCenter, NSNotification, NSNumber,
    NSObjectProtocol, NSString,
};

use crate::log::log;

#[derive(Clone, Debug, Default, PartialEq)]
struct Snapshot {
    camera_cmio: bool,
    camera_avf: bool,
    mic: bool,
    locked: bool,
    frontmost: String,
    frontmost_fullscreen: bool,
    presenting: bool,
    sharing_windows: Vec<String>,
    idle_bucket: u64,
}

static OBSERVERS: Mutex<Vec<Sendable<Retained<ProtocolObject<dyn NSObjectProtocol>>>>> =
    Mutex::new(Vec::new());

struct Sendable<T>(#[allow(dead_code)] T);
unsafe impl<T> Send for Sendable<T> {}

/// Registers notification observers (main thread) and starts the 1 s poll.
pub fn start() {
    observe_notifications();
    std::thread::spawn(|| {
        let mut last = Snapshot::default();
        loop {
            let now = snapshot();
            if now != last {
                log_changes(&last, &now);
                last = now;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

/// Logs every signal once (control-window button).
pub fn log_all() {
    let s = snapshot();
    log(&format!(
        "SIGNALS idle={:.0}s camera(cmio)={} camera(avf)={} mic={} locked={} frontmost={} fullscreen={} sharing_windows={:?}",
        idle_seconds(),
        s.camera_cmio,
        s.camera_avf,
        s.mic,
        s.locked,
        s.frontmost,
        s.frontmost_fullscreen,
        s.sharing_windows
    ));
}

fn log_changes(a: &Snapshot, b: &Snapshot) {
    let mut changes = Vec::new();
    if a.camera_cmio != b.camera_cmio {
        changes.push(format!(
            "camera(cmio) {} -> {}",
            a.camera_cmio, b.camera_cmio
        ));
    }
    if a.camera_avf != b.camera_avf {
        changes.push(format!("camera(avf) {} -> {}", a.camera_avf, b.camera_avf));
    }
    if a.mic != b.mic {
        changes.push(format!("mic {} -> {}", a.mic, b.mic));
    }
    if a.locked != b.locked {
        changes.push(format!("locked(poll) {} -> {}", a.locked, b.locked));
    }
    if a.frontmost != b.frontmost || a.frontmost_fullscreen != b.frontmost_fullscreen {
        changes.push(format!(
            "frontmost {} (fullscreen={}) -> {} (fullscreen={})",
            a.frontmost, a.frontmost_fullscreen, b.frontmost, b.frontmost_fullscreen
        ));
    }
    if a.presenting != b.presenting {
        changes.push(format!("presenting {} -> {}", a.presenting, b.presenting));
    }
    if a.sharing_windows != b.sharing_windows {
        changes.push(format!(
            "sharing windows {:?} -> {:?}",
            a.sharing_windows, b.sharing_windows
        ));
    }
    if a.idle_bucket != b.idle_bucket {
        changes.push(format!("idle >= {}s", b.idle_bucket));
    }
    if !changes.is_empty() {
        log(&format!("SIGNAL {}", changes.join(" | ")));
    }
}

fn snapshot() -> Snapshot {
    let (frontmost, pid) = frontmost();
    let windows = window_list();
    let idle = idle_seconds() as u64;
    Snapshot {
        camera_cmio: camera_running_cmio(),
        camera_avf: camera_in_use_avf(),
        mic: mic_running(),
        locked: screen_locked(),
        frontmost_fullscreen: pid.is_some_and(|pid| is_fullscreen(&windows, pid)),
        presenting: pid.is_some_and(|pid| is_presenting(&windows, pid)),
        frontmost,
        sharing_windows: sharing_windows(&windows),
        // Coarse buckets so the log shows threshold crossings, not every second.
        idle_bucket: [0, 30, 60, 300, 600]
            .into_iter()
            .filter(|t| idle >= *t)
            .max()
            .unwrap_or(0),
    }
}

// --- Idle -------------------------------------------------------------------

pub fn idle_seconds() -> f64 {
    // kCGAnyInputEventType = ~0
    CGEventSource::seconds_since_last_event_type(
        CGEventSourceStateID::CombinedSessionState,
        CGEventType(u32::MAX),
    )
}

// --- Camera -----------------------------------------------------------------

/// CoreMediaIO: true if any video device is running in any process.
fn camera_running_cmio() -> bool {
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
    if status != 0 || size == 0 {
        return false;
    }
    let count = size as usize / std::mem::size_of::<u32>();
    let mut ids = vec![0u32; count];
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

/// AVFoundation's view of the default camera (for comparison with CoreMediaIO).
fn camera_in_use_avf() -> bool {
    let Some(video) = (unsafe { AVMediaTypeVideo }) else {
        return false;
    };
    unsafe { AVCaptureDevice::defaultDeviceWithMediaType(video) }
        .is_some_and(|d| unsafe { d.isInUseByAnotherApplication() })
}

// --- Microphone -------------------------------------------------------------

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
    if status != 0 || device == 0 {
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
    status == 0 && running != 0
}

// --- Lock -------------------------------------------------------------------

/// Poll fallback: CGSSessionScreenIsLocked in the current session dictionary.
fn screen_locked() -> bool {
    let Some(dict) = CGSessionCopyCurrentDictionary() else {
        return false;
    };
    let dict: &NSDictionary<NSString, AnyObject> =
        unsafe { &*(&*dict as *const CFDictionary as *const NSDictionary<NSString, AnyObject>) };
    dict.objectForKey(&NSString::from_str("CGSSessionScreenIsLocked"))
        .and_then(|v| v.downcast::<NSNumber>().ok())
        .is_some_and(|n| n.boolValue())
}

// --- Windows: full screen and sharing ---------------------------------------

struct WindowInfo {
    owner: String,
    owner_pid: i32,
    name: String,
    layer: i64,
    bounds: (f64, f64, f64, f64),
}

fn frontmost() -> (String, Option<i32>) {
    let app = NSWorkspace::sharedWorkspace().frontmostApplication();
    (
        app.as_ref()
            .and_then(|a| a.localizedName())
            .map(|n| n.to_string())
            .unwrap_or_else(|| "?".into()),
        app.map(|a| a.processIdentifier()),
    )
}

/// On-screen windows. Names are only filled in when Screen Recording is granted.
fn window_list() -> Vec<WindowInfo> {
    // kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements
    let Some(list) = CGWindowListCopyWindowInfo(CGWindowListOption(1 | 16), 0) else {
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
                    (
                        number(b, "X"),
                        number(b, "Y"),
                        number(b, "Width"),
                        number(b, "Height"),
                    )
                })
                .unwrap_or_default();
            WindowInfo {
                owner: text(&d, "kCGWindowOwnerName"),
                owner_pid: number(&d, "kCGWindowOwnerPID") as i32,
                name: text(&d, "kCGWindowName"),
                layer: number(&d, "kCGWindowLayer") as i64,
                bounds,
            }
        })
        .collect()
}

fn display_bounds() -> Vec<(f64, f64, f64, f64)> {
    let mut ids = [0u32; 16];
    let mut count = 0u32;
    unsafe { CGGetActiveDisplayList(16, ids.as_mut_ptr(), &mut count) };
    ids[..count as usize]
        .iter()
        .map(|id| {
            let r = CGDisplayBounds(*id);
            (r.origin.x, r.origin.y, r.size.width, r.size.height)
        })
        .collect()
}

/// Full-screen app (own Space): measured on macOS 26, the app owns a thin window
/// above normal level spanning the display's top edge (its menu-bar strip) and
/// the system menu bar stays listed. Not a presentation; the card still shows.
fn is_fullscreen(windows: &[WindowInfo], pid: i32) -> bool {
    let displays = display_bounds();
    windows
        .iter()
        .filter(|w| w.owner_pid == pid && w.layer > 0)
        .any(|w| {
            displays.iter().any(|d| {
                w.bounds.0 == d.0 && w.bounds.1 == d.1 && w.bounds.2 == d.2 && w.bounds.3 < 60.0
            })
        })
}

/// Presentation (Keynote/PowerPoint slideshow): measured on macOS 26, the
/// frontmost app owns a window above normal level covering a whole display
/// (Keynote: layer 9, then 26) and the system menu bar disappears. CHK-03 defers.
fn is_presenting(windows: &[WindowInfo], pid: i32) -> bool {
    let displays = display_bounds();
    windows
        .iter()
        .filter(|w| w.owner_pid == pid && w.layer > 0)
        .any(|w| displays.iter().any(|d| *d == w.bounds))
}

/// Windows whose title suggests an active screen share (Zoom share toolbar,
/// Chrome/Brave "… is sharing your screen", Teams sharing bar, macOS indicators).
fn sharing_windows(windows: &[WindowInfo]) -> Vec<String> {
    let hints = [
        "is sharing",
        "sharing your screen",
        "share toolbar",
        "screen share",
        "screen sharing",
        "presenting",
        "sharing control",
    ];
    let mut found: Vec<String> = windows
        .iter()
        .filter(|w| {
            let name = w.name.to_lowercase();
            hints.iter().any(|h| name.contains(h))
        })
        .map(|w| format!("{}: {}", w.owner, w.name))
        .collect();
    found.sort();
    found.dedup();
    found
}

// --- Notifications ----------------------------------------------------------

fn observe_notifications() {
    let mut observers = OBSERVERS.lock().unwrap();
    let distributed = NSDistributedNotificationCenter::defaultCenter();
    for name in [
        "com.apple.screenIsLocked",
        "com.apple.screenIsUnlocked",
        "com.apple.screensaver.didstart",
        "com.apple.screensaver.didstop",
    ] {
        let block = RcBlock::new(move |n: NonNull<NSNotification>| {
            let name = unsafe { n.as_ref() }.name();
            log(&format!("EVENT (distributed) {name}"));
        });
        let token = unsafe {
            distributed.addObserverForName_object_queue_usingBlock(
                Some(&NSString::from_str(name)),
                None,
                None,
                &block,
            )
        };
        observers.push(Sendable(token));
    }

    let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
    let names = unsafe {
        [
            objc2_app_kit::NSWorkspaceWillSleepNotification,
            objc2_app_kit::NSWorkspaceDidWakeNotification,
            objc2_app_kit::NSWorkspaceScreensDidSleepNotification,
            objc2_app_kit::NSWorkspaceScreensDidWakeNotification,
            objc2_app_kit::NSWorkspaceSessionDidResignActiveNotification,
            objc2_app_kit::NSWorkspaceSessionDidBecomeActiveNotification,
        ]
    };
    for name in names {
        let block = RcBlock::new(move |n: NonNull<NSNotification>| {
            let name = unsafe { n.as_ref() }.name();
            log(&format!("EVENT (workspace) {name}"));
        });
        let token = unsafe {
            workspace.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block)
        };
        observers.push(Sendable(token));
    }
    log("signals: observing lock/unlock, screensaver, sleep/wake, display sleep, session switch");
}
