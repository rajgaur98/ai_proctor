//! macOS (objc2: ScreenCaptureKit, AVFoundation, AppKit, CoreAudio, CoreMediaIO).
//! Presence signals (idle, lock/sleep, camera/mic, sharing/presenting) are real, from
//! spike #14 (`docs/spikes/presence-signals.md`). Capture and permissions are real,
//! from spike #13 (`docs/spikes/capture.md`); they return raw RGBA pixels, encoding
//! happens in `agent_core::capture`. The rest stays a stub until its feature lands.

use std::collections::{HashSet, VecDeque};
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use agent_core::contracts::{PermissionKind, PermissionState, Permissions};
use agent_core::foreground::{clean_title, domain_of, domain_of_address};
use agent_core::pixels::webcam_frame_ready;
use agent_core::platform::{
    CallState, CameraDevice, CaptureError, Foreground, Frame, InjectedInput, Platform,
    RunEnvironment, ScreenRect, ScreenShare, SessionEndHandler, SessionState,
};
use agent_core::watchdog::{WatchdogError, WatchdogSpec, WatchdogState};
use block2::RcBlock;
use chrono::{DateTime, Utc};
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_app_kit::NSWorkspace;
use objc2_application_services::{
    kAXTrustedCheckOptionPrompt, AXError, AXIsProcessTrusted, AXIsProcessTrustedWithOptions,
    AXUIElement,
};
use objc2_av_foundation::{
    AVAuthorizationStatus, AVCaptureConnection, AVCaptureDevice, AVCaptureDeviceInput,
    AVCaptureOutput, AVCaptureSession, AVCaptureVideoDataOutput,
    AVCaptureVideoDataOutputSampleBufferDelegate, AVMediaTypeVideo,
};
use objc2_core_audio::{
    kAudioDevicePropertyDeviceIsRunningSomewhere, kAudioHardwarePropertyDefaultInputDevice,
    kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    AudioObjectGetPropertyData, AudioObjectPropertyAddress,
};
use objc2_core_foundation::{
    CFArray, CFBoolean, CFDictionary, CFRetained, CFString, CFType, CFURL,
};
use objc2_core_graphics::{
    CGDataProvider, CGDisplayBounds, CGDisplayCopyDisplayMode, CGDisplayMode, CGEventSource,
    CGEventSourceStateID, CGEventType, CGGetActiveDisplayList, CGImage,
    CGPreflightScreenCaptureAccess, CGRequestScreenCaptureAccess, CGSessionCopyCurrentDictionary,
    CGWindowListCopyWindowInfo, CGWindowListOption,
};
use objc2_core_media::{CMSampleBuffer, CMTime, CMTimeFlags};
use objc2_core_media_io::{
    kCMIODevicePropertyDeviceIsRunningSomewhere, kCMIOHardwarePropertyDevices,
    kCMIOObjectPropertyElementMain, kCMIOObjectPropertyScopeGlobal, kCMIOObjectSystemObject,
    CMIOObjectGetPropertyData, CMIOObjectGetPropertyDataSize, CMIOObjectPropertyAddress,
};
use objc2_core_video::{
    kCVPixelBufferHeightKey, kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferWidthKey,
    kCVPixelFormatType_32BGRA, CVPixelBuffer, CVPixelBufferGetBaseAddress,
    CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight, CVPixelBufferGetWidth,
    CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{
    NSArray, NSDictionary, NSError, NSNotification, NSNumber, NSObject, NSObjectProtocol,
    NSProcessInfo, NSString,
};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCFrameStatus, SCScreenshotManager, SCShareableContent, SCStream,
    SCStreamConfiguration, SCStreamDelegate, SCStreamFrameInfoStatus, SCStreamOutput,
    SCStreamOutputType,
};

/// How long a capture may take before the caller gets `Failed`, so a completion
/// handler that never fires cannot hang the check-in.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);

/// `SCStreamErrorUserDeclined`: Screen Recording refused by the user (TCC).
const SC_ERROR_USER_DECLINED: isize = -3801;

/// Accessibility reads: per-message timeout so a hung browser cannot block, and
/// the bounds of the search for the page's `AXWebArea` (called every ~5 s).
const AX_MESSAGE_TIMEOUT_SECS: f32 = 0.25;
const AX_MAX_DEPTH: usize = 8;
const AX_MAX_ELEMENTS: usize = 300;
const AX_BUDGET: Duration = Duration::from_millis(750);
/// Most browser pids remembered as already switched to accessibility mode.
const AX_ENABLED_MAX_PIDS: usize = 64;

/// Bundle identifiers of the browsers whose address we read (Chromium family,
/// Safari, Firefox), including beta/dev/canary builds.
const BROWSER_BUNDLES: [&str; 19] = [
    "com.google.Chrome",
    "com.google.Chrome.beta",
    "com.google.Chrome.dev",
    "com.google.Chrome.canary",
    "com.microsoft.edgemac",
    "com.microsoft.edgemac.Beta",
    "com.microsoft.edgemac.Dev",
    "com.microsoft.edgemac.Canary",
    "com.apple.Safari",
    "com.apple.SafariTechnologyPreview",
    "org.mozilla.firefox",
    "org.mozilla.firefoxdeveloperedition",
    "org.mozilla.nightly",
    "com.brave.Browser",
    "com.brave.Browser.beta",
    "com.brave.Browser.nightly",
    "company.thebrowser.Browser",
    "com.vivaldi.Vivaldi",
    "com.operasoftware.Opera",
];

/// Moves an Objective-C object across threads; it is only read on the other side.
struct Sendable<T>(T);
unsafe impl<T> Send for Sendable<T> {}

/// Notification tokens, kept alive so the observers stay registered.
struct Observer(#[allow(dead_code)] Retained<ProtocolObject<dyn NSObjectProtocol>>);

// The tokens are only held, never messaged, after registration.
unsafe impl Send for Observer {}

/// Shows the Screen Recording prompt (first time only; afterwards macOS just returns
/// the current answer and the person has to use System Settings).
fn request_screen() {
    let screen = CGRequestScreenCaptureAccess();
    tracing::info!(screen, "asked for Screen Recording");
}

/// Shows the Camera prompt while the answer is still undecided. The reply arrives
/// later; `camera_permission()` reads it.
fn request_camera() {
    if let Some(video) = unsafe { AVMediaTypeVideo } {
        let block = RcBlock::new(|granted: objc2::runtime::Bool| {
            tracing::info!(granted = granted.as_bool(), "asked for Camera");
        });
        unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(video, &block) };
    }
}

/// Asks macOS for Accessibility, opening its pane with the app listed (browser
/// domains, #25). The optional card of the onboarding flow asks through
/// `request_permission` (#169); debug builds also call it at launch with
/// AI_PROCTOR_DEV_REQUEST_PERMISSIONS=1.
pub fn request_accessibility() {
    let key: &NSString =
        unsafe { &*(kAXTrustedCheckOptionPrompt as *const CFString as *const NSString) };
    let yes = NSNumber::new_bool(true);
    let options = NSDictionary::<NSString, AnyObject>::from_slices(&[key], &[&*yes as &AnyObject]);
    let options: &CFDictionary =
        unsafe { &*(&*options as *const NSDictionary<NSString, AnyObject> as *const CFDictionary) };
    let trusted = unsafe { AXIsProcessTrustedWithOptions(Some(options)) };
    tracing::info!(trusted, "asked for Accessibility");
}

#[derive(Default)]
pub struct MacPlatform {
    asleep: Arc<AtomicBool>,
    /// Called by the power-off observer (#159).
    session_end: Arc<Mutex<Option<SessionEndHandler>>>,
    observing: AtomicBool,
    observers: Mutex<Vec<Observer>>,
    /// Chromium pids already asked to build their accessibility tree.
    ax_enabled: Mutex<HashSet<i32>>,
    /// ANT-03: the card's synthetic-click monitor while the card is up.
    card_guard: Mutex<Option<crate::macos_anticheat::CardGuard>>,
}

impl MacPlatform {
    pub fn new() -> Self {
        let platform = Self::default();
        platform.start_observers();
        platform
    }

    /// Registers the NSWorkspace sleep/wake and power-off observers. Idempotent,
    /// called by `new()`.
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
        // Posted before the logout, restart or shutdown asks apps to quit (#159,
        // ANT-01). It doesn't say which of the three it is; the agent doesn't need to
        // know. Another app can still cancel the logout afterwards: the shift is
        // then already clocked out and the person clocks in again.
        let will_power_off = unsafe { objc2_app_kit::NSWorkspaceWillPowerOffNotification };
        let handler = Arc::clone(&self.session_end);
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            tracing::info!("the session is ending (logout, restart or shutdown)");
            let handler = handler.lock().ok().and_then(|h| h.clone());
            if let Some(handler) = handler {
                handler();
            }
        });
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(will_power_off),
                None,
                None,
                &block,
            )
        };
        tokens.push(Observer(token));
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
        tracing::info!(
            platform = "macos",
            "sleep/wake and power-off observers registered"
        );
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

    fn screen_share(&self) -> Option<ScreenShare> {
        let windows = window_list();
        if is_sharing(&windows) {
            return Some(ScreenShare::Sharing);
        }
        let pid = frontmost_pid()?;
        is_presenting(&windows, &display_bounds(), pid).then_some(ScreenShare::Presenting)
    }

    /// Frontmost app, its frontmost window's title (needs Screen Recording, else
    /// `None`) and, for browsers, the page's domain (needs Accessibility, else
    /// `None`). Never prompts for either.
    fn foreground(&self) -> Option<Foreground> {
        let front = NSWorkspace::sharedWorkspace().frontmostApplication()?;
        let app = front.localizedName()?.to_string();
        let pid = front.processIdentifier();
        let windows = window_list();
        let title = foreground_title(&windows, pid);
        let display = foreground_display(&windows, &display_bounds(), pid);
        let bundle = front
            .bundleIdentifier()
            .map(|id| id.to_string())
            .unwrap_or_default();
        let domain = if is_browser_bundle(&bundle) {
            browser_domain(pid, is_chromium_bundle(&bundle), &self.ax_enabled)
        } else {
            None
        };
        Some(Foreground {
            app,
            title,
            domain,
            display,
        })
    }

    /// One frame per display. Blocks until done (up to 5 s): call from a worker
    /// thread, not the UI thread. Never prompts: without Screen Recording it fails
    /// with `PermissionMissing` before touching ScreenCaptureKit.
    fn capture_screens(&self, max_width: u32) -> Result<Vec<Frame>, CaptureError> {
        if !CGPreflightScreenCaptureAccess() {
            return Err(CaptureError::PermissionMissing);
        }
        capture_screens(max_width)
    }

    /// One webcam frame at `width` x `height`. Blocks until done (up to 5 s) with the
    /// camera light on meanwhile: call from a worker thread, not the UI thread.
    fn capture_webcam(&self, width: u32, height: u32) -> Result<Frame, CaptureError> {
        if camera_permission() != PermissionState::Granted {
            return Err(CaptureError::PermissionMissing);
        }
        capture_webcam(width, height)
    }

    /// CAP-07: Vision face rectangles on the frame (detection only, `macos_face`).
    fn detect_face(&self, frame: &Frame) -> Option<bool> {
        crate::macos_face::detect_face(frame)
    }

    fn permissions(&self) -> Permissions {
        Permissions {
            screen: if CGPreflightScreenCaptureAccess() {
                PermissionState::Granted
            } else {
                PermissionState::Denied
            },
            camera: camera_permission(),
        }
    }

    /// Whether the app is trusted for Accessibility (browser domains, #114). macOS only
    /// answers yes or no, so "not yet" and "turned off" both read as `Denied`.
    fn accessibility_permission(&self) -> PermissionState {
        if unsafe { AXIsProcessTrusted() } {
            PermissionState::Granted
        } else {
            PermissionState::Denied
        }
    }

    fn request_permission(&self, kind: PermissionKind) {
        match kind {
            PermissionKind::Screen => request_screen(),
            PermissionKind::Camera => request_camera(),
            PermissionKind::Accessibility => request_accessibility(),
        }
    }

    /// ANT-03: counts presses on the card that look synthetic, letting them through
    /// (flag only; see `macos_anticheat`). No permission needed.
    fn start_input_guard(&self, area: ScreenRect) {
        let old = self.card_guard.lock().unwrap().take();
        if let Some(old) = old {
            old.stop();
        }
        let guard = crate::macos_anticheat::CardGuard::start(area);
        *self.card_guard.lock().unwrap() = Some(guard);
    }

    fn stop_input_guard(&self) -> InjectedInput {
        let guard = self.card_guard.lock().unwrap().take();
        guard.map(|g| g.stop()).unwrap_or_default()
    }

    fn camera_device(&self) -> Option<CameraDevice> {
        crate::macos_anticheat::camera_device()
    }

    fn run_environment(&self) -> RunEnvironment {
        crate::macos_anticheat::run_environment()
    }

    fn notify(&self, title: &str, body: &str) {
        crate::macos_notify::notify(title, body);
    }

    fn install_watchdog(&self, spec: &WatchdogSpec) -> Result<WatchdogState, WatchdogError> {
        crate::launchd::install(spec)
    }

    fn uninstall_watchdog(&self) -> Result<(), WatchdogError> {
        crate::launchd::uninstall()
    }

    fn watchdog_installed(&self) -> bool {
        crate::launchd::installed()
    }

    fn boot_time(&self) -> Option<DateTime<Utc>> {
        crate::launchd::boot_time()
    }

    fn on_session_end(&self, handler: SessionEndHandler) {
        if let Ok(mut held) = self.session_end.lock() {
            *held = Some(handler);
        }
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

/// Title of the app's frontmost normal window: the first layer-0 window of `pid`
/// with a non-empty title, in front-to-back order. Trimmed, capped at
/// `MAX_TITLE_CHARS` (`clean_title`). Titles are empty without Screen Recording, so
/// this is `None`.
fn foreground_title(windows: &[WindowInfo], pid: i32) -> Option<String> {
    windows
        .iter()
        .filter(|w| w.owner_pid == pid && w.layer == 0)
        .find_map(|w| clean_title(&w.title))
}

/// The display (1-based, in `display_bounds` order) holding the centre of the app's
/// front window: the first layer-0 window of `pid` with a size, front to back. Its
/// title is not needed, so this works without Screen Recording. `None` when the app
/// has no such window or the centre is on no display.
fn foreground_display(windows: &[WindowInfo], displays: &[Rect], pid: i32) -> Option<u32> {
    let window = windows.iter().find(|w| {
        w.owner_pid == pid && w.layer == 0 && w.bounds.width > 0.0 && w.bounds.height > 0.0
    })?;
    let cx = window.bounds.x + window.bounds.width / 2.0;
    let cy = window.bounds.y + window.bounds.height / 2.0;
    displays
        .iter()
        .position(|d| cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height)
        .map(|i| i as u32 + 1)
}

/// True for the browsers we read a domain from, by bundle identifier.
fn is_browser_bundle(bundle_id: &str) -> bool {
    BROWSER_BUNDLES.contains(&bundle_id)
}

/// True for the Chromium-based browsers, which only build their web accessibility
/// tree once an assistive client asks (`AXManualAccessibility`). Safari and Firefox
/// are not.
fn is_chromium_bundle(bundle_id: &str) -> bool {
    is_browser_bundle(bundle_id)
        && !bundle_id.starts_with("com.apple.Safari")
        && !bundle_id.starts_with("org.mozilla.")
}

/// Copies BGRA rows (ScreenCaptureKit / AVFoundation order) into tightly packed
/// RGBA, dropping any per-row padding (`stride` >= `width * 4`). `None` if the buffer
/// is too short for the stated size.
fn bgra_to_rgba(bytes: &[u8], width: usize, height: usize, stride: usize) -> Option<Vec<u8>> {
    let row = width.checked_mul(4)?;
    if height == 0 {
        return Some(Vec::new());
    }
    if stride < row || bytes.len() < stride.checked_mul(height - 1)?.checked_add(row)? {
        return None;
    }
    let mut rgba = Vec::with_capacity(row * height);
    for y in 0..height {
        let line = &bytes[y * stride..y * stride + row];
        for px in line.as_chunks::<4>().0 {
            rgba.extend_from_slice(&[px[2], px[1], px[0], 255]);
        }
    }
    Some(rgba)
}

/// Mean Rec. 601 luma (0..255) of BGRA rows, ignoring row padding.
fn mean_luma_bgra(bytes: &[u8], width: usize, height: usize, stride: usize) -> Option<f64> {
    let row = width.checked_mul(4)?;
    if width == 0 || height == 0 {
        return Some(0.0);
    }
    if stride < row || bytes.len() < stride.checked_mul(height - 1)?.checked_add(row)? {
        return None;
    }
    let mut sum = 0.0;
    for y in 0..height {
        for px in bytes[y * stride..y * stride + row].as_chunks::<4>().0 {
            sum += 0.299 * px[2] as f64 + 0.587 * px[1] as f64 + 0.114 * px[0] as f64;
        }
    }
    Some(sum / (width * height) as f64)
}

/// Output size for a display: at most `max_width` wide (never upscaled past the
/// display's pixel width), height proportional. `scale` is points to pixels.
fn display_capture_size(
    points_w: f64,
    points_h: f64,
    scale: f64,
    max_width: u32,
) -> Option<(u32, u32)> {
    if !(points_w >= 1.0 && points_h >= 1.0) || max_width == 0 {
        return None;
    }
    let scale = if scale >= 1.0 { scale } else { 1.0 };
    let px_w = (points_w * scale).round();
    let px_h = (points_h * scale).round();
    let w = px_w.min(max_width as f64);
    let h = (px_h * w / px_w).round().max(1.0);
    Some((w as u32, h as u32))
}

/// Points to pixels for a display, from its pixel and point widths. 1x when either
/// is nonsense.
fn pixel_scale(points_w: f64, pixel_w: f64) -> f64 {
    if points_w >= 1.0 && pixel_w >= points_w {
        pixel_w / points_w
    } else {
        1.0
    }
}

/// Which API takes the screenshots.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScreenshotApi {
    /// `SCScreenshotManager` (macOS 14+).
    Manager,
    /// A short-lived `SCStream` per display (macOS 13, the PRD minimum).
    Stream,
}

/// `SCScreenshotManager` and `SCContentFilter.pointPixelScale` arrive in macOS 14.
const SCREENSHOT_MANAGER_MIN_MACOS: isize = 14;

/// `force_stream` is the debug switch that runs the macOS 13 path on a newer Mac.
fn screenshot_api(os_major: isize, force_stream: bool) -> ScreenshotApi {
    if os_major >= SCREENSHOT_MANAGER_MIN_MACOS && !force_stream {
        ScreenshotApi::Manager
    } else {
        ScreenshotApi::Stream
    }
}

/// Debug builds only: AI_PROCTOR_DEV_FORCE_SCSTREAM=1 takes screenshots with the
/// macOS 13 `SCStream` path whatever the OS version.
#[cfg(debug_assertions)]
fn force_stream() -> bool {
    std::env::var("AI_PROCTOR_DEV_FORCE_SCSTREAM").is_ok_and(|v| v == "1")
}

#[cfg(not(debug_assertions))]
fn force_stream() -> bool {
    false
}

/// A stream sample is a screenshot only when it is a complete frame; idle, blank and
/// suspended samples carry no new pixels. No status at all is taken as complete.
fn frame_status_is_complete(status: Option<isize>) -> bool {
    status.is_none_or(|s| s == SCFrameStatus::Complete.0)
}

/// ScreenCaptureKit's "user declined TCC" error. `CGPreflightScreenCaptureAccess`
/// can stay true after the grant is revoked and the app keeps running, so this is
/// the reliable signal (spike #13).
fn is_tcc_declined(code: isize, description: &str) -> bool {
    code == SC_ERROR_USER_DECLINED || description.to_lowercase().contains("declined tcc")
}

// --- OS reads --------------------------------------------------------------------

/// Camera authorization without prompting.
fn camera_permission() -> PermissionState {
    let Some(video) = (unsafe { AVMediaTypeVideo }) else {
        return PermissionState::Unsupported;
    };
    match unsafe { AVCaptureDevice::authorizationStatusForMediaType(video) } {
        AVAuthorizationStatus::Authorized => PermissionState::Granted,
        AVAuthorizationStatus::Denied => PermissionState::Denied,
        AVAuthorizationStatus::Restricted => PermissionState::Restricted,
        AVAuthorizationStatus::NotDetermined => PermissionState::NotDetermined,
        _ => PermissionState::Unsupported,
    }
}

/// Maps a ScreenCaptureKit error to the capture error stored with the check-in.
fn sck_error(error: *mut NSError, what: &str) -> CaptureError {
    match unsafe { Retained::retain(error) } {
        Some(e) => sck_ns_error(&e, what),
        None => CaptureError::Failed(format!("{what}: no result")),
    }
}

fn sck_ns_error(error: &NSError, what: &str) -> CaptureError {
    let description = error.localizedDescription().to_string();
    if is_tcc_declined(error.code(), &description) {
        CaptureError::PermissionMissing
    } else {
        CaptureError::Failed(format!("{what}: {description}"))
    }
}

/// Copies a CGImage (BGRA from ScreenCaptureKit, SDR) into tightly packed RGBA.
fn rgba_from_cgimage(image: &CGImage) -> Result<(u32, u32, Vec<u8>), CaptureError> {
    let w = CGImage::width(Some(image));
    let h = CGImage::height(Some(image));
    let stride = CGImage::bytes_per_row(Some(image));
    let provider = CGImage::data_provider(Some(image));
    let data = CGDataProvider::data(provider.as_deref())
        .ok_or_else(|| CaptureError::Failed("screenshot has no pixel data".into()))?;
    let bytes = data.to_vec();
    let rgba = bgra_to_rgba(&bytes, w, h, stride)
        .ok_or_else(|| CaptureError::Failed("screenshot pixel buffer too short".into()))?;
    Ok((w as u32, h as u32, rgba))
}

type ScreenResult = Result<(u32, u32, Vec<u8>), CaptureError>;

/// How long to wait for stopped streams to confirm, so a handler that never fires
/// cannot hold up the check-in.
const STREAM_STOP_TIMEOUT: Duration = Duration::from_secs(1);

/// One screenshot request in flight, per display.
struct Shot {
    index: u32,
    rx: mpsc::Receiver<ScreenResult>,
    /// Filter, configuration and handlers, kept alive until the request completes.
    keep: Box<dyn std::any::Any>,
    /// The short-lived stream (macOS 13 path), stopped once the frame is in.
    stream: Option<Retained<SCStream>>,
}

fn os_major() -> isize {
    NSProcessInfo::processInfo()
        .operatingSystemVersion()
        .majorVersion
}

/// One ScreenCaptureKit screenshot per display, started together and collected
/// under one deadline. SCK scales on the GPU to `max_width`. macOS 14+ uses
/// `SCScreenshotManager`; macOS 13 takes the first frame of a short-lived `SCStream`.
fn capture_screens(max_width: u32) -> Result<Vec<Frame>, CaptureError> {
    let deadline = Instant::now() + CAPTURE_TIMEOUT;
    let api = screenshot_api(os_major(), force_stream());
    tracing::debug!(?api, "screenshot api");
    let (tx, rx) = mpsc::channel();
    let handler = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            let result = match unsafe { Retained::retain(content) } {
                Some(content) => Ok(Sendable(content)),
                None => Err(sck_error(error, "shareable content")),
            };
            let _ = tx.send(result);
        },
    );
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&handler) };
    let content = match rx.recv_timeout(CAPTURE_TIMEOUT) {
        Ok(Ok(Sendable(content))) => content,
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "shareable content failed");
            return Err(e);
        }
        Err(_) => return Err(CaptureError::Failed("shareable content timed out".into())),
    };

    // Ordered by display ID, like `display_bounds`, so `screen-N` and the display
    // `foreground()` reports for an excluded app (CAP-04) are the same screen.
    let mut displays: Vec<_> = unsafe { content.displays() }.iter().collect();
    if displays.is_empty() {
        return Err(CaptureError::Failed("no displays".into()));
    }
    displays.sort_by_key(|d| unsafe { d.displayID() });
    // Start every display, keep filter and configuration alive until it completes.
    let mut pending = Vec::new();
    for (index, display) in displays.iter().enumerate() {
        let (points_w, points_h) = unsafe { (display.width() as f64, display.height() as f64) };
        let filter = unsafe {
            SCContentFilter::initWithDisplay_excludingWindows(
                SCContentFilter::alloc(),
                display,
                &NSArray::new(),
            )
        };
        let scale = match api {
            ScreenshotApi::Manager => (unsafe { filter.pointPixelScale() }) as f64,
            // `pointPixelScale` does not exist before macOS 14.
            ScreenshotApi::Stream => display_pixel_scale(display, points_w),
        };
        let Some((w, h)) = display_capture_size(points_w, points_h, scale, max_width) else {
            tracing::warn!(display = index + 1, points_w, points_h, "bad display size");
            continue;
        };
        let config = unsafe { SCStreamConfiguration::new() };
        unsafe {
            config.setWidth(w as usize);
            config.setHeight(h as usize);
            config.setShowsCursor(false);
        }
        let index = index as u32 + 1;
        pending.push(match api {
            ScreenshotApi::Manager => start_manager_shot(index, filter, config),
            ScreenshotApi::Stream => start_stream_shot(index, filter, config),
        });
    }

    let mut frames = Vec::new();
    let mut first_error = None;
    // Stopping streams: (confirmation, stream and handler kept alive until then).
    let mut stopping = Vec::new();
    let mut alive = Vec::new();
    for Shot {
        index,
        rx,
        keep,
        stream,
    } in pending
    {
        let wait = deadline.saturating_duration_since(Instant::now());
        let result = rx.recv_timeout(wait);
        // Whatever the outcome, the stream must not keep recording.
        if let Some(stream) = stream {
            let (stopped_tx, stopped_rx) = mpsc::channel();
            let stopped = RcBlock::new(move |_error: *mut NSError| {
                let _ = stopped_tx.send(());
            });
            unsafe { stream.stopCaptureWithCompletionHandler(Some(&stopped)) };
            stopping.push(stopped_rx);
            alive.push(Box::new((stream, stopped)) as Box<dyn std::any::Any>);
        }
        alive.push(keep);
        match result {
            Ok(Ok((width, height, rgba))) => frames.push(Frame {
                display: Some(index),
                width,
                height,
                rgba,
            }),
            Ok(Err(e)) => {
                tracing::warn!(display = index, error = %e, "screenshot failed");
                first_error.get_or_insert(e);
            }
            Err(_) => {
                tracing::warn!(display = index, "screenshot timed out");
                first_error.get_or_insert(CaptureError::Failed("screenshot timed out".into()));
            }
        }
    }
    let stop_deadline = Instant::now() + STREAM_STOP_TIMEOUT;
    for stopped in stopping {
        let wait = stop_deadline.saturating_duration_since(Instant::now());
        if stopped.recv_timeout(wait).is_err() {
            tracing::warn!("screenshot stream did not confirm stop");
        }
    }
    drop(alive);
    // A missing permission fails the whole capture; partial failures keep the
    // displays that did work (the check-in still passes, CAP-08).
    match (frames.is_empty(), first_error) {
        (true, Some(e)) => Err(e),
        (true, None) => Err(CaptureError::Failed("no displays captured".into())),
        (false, _) => Ok(frames),
    }
}

/// Points to pixels for a display on systems without `pointPixelScale`: the active
/// mode's pixel width over the display's width in points.
fn display_pixel_scale(display: &SCDisplay, points_w: f64) -> f64 {
    let mode = CGDisplayCopyDisplayMode(unsafe { display.displayID() });
    pixel_scale(points_w, CGDisplayMode::pixel_width(mode.as_deref()) as f64)
}

/// macOS 14+: `SCScreenshotManager` takes the image.
fn start_manager_shot(
    index: u32,
    filter: Retained<SCContentFilter>,
    config: Retained<SCStreamConfiguration>,
) -> Shot {
    let (tx, rx) = mpsc::channel::<ScreenResult>();
    let handler = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
        let result = match unsafe { image.as_ref() } {
            Some(image) => rgba_from_cgimage(image),
            None => Err(sck_error(error, "screenshot")),
        };
        let _ = tx.send(result);
    });
    unsafe {
        SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
            &filter,
            &config,
            Some(&handler),
        )
    };
    Shot {
        index,
        rx,
        keep: Box::new((filter, config, handler)),
        stream: None,
    }
}

/// macOS 13: a stream that is started for the first complete frame and then stopped.
/// BGRA at the target size, the slowest rate and the shallowest queue, no cursor.
fn start_stream_shot(
    index: u32,
    filter: Retained<SCContentFilter>,
    config: Retained<SCStreamConfiguration>,
) -> Shot {
    let (tx, rx) = mpsc::channel::<ScreenResult>();
    unsafe {
        config.setPixelFormat(kCVPixelFormatType_32BGRA);
        config.setMinimumFrameInterval(CMTime {
            value: 1,
            timescale: 1,
            flags: CMTimeFlags::Valid,
            epoch: 0,
        });
        config.setQueueDepth(3);
    }
    let output = ScreenStreamOutput::new(tx.clone());
    let queue = DispatchQueue::new("ai-proctor.screenshot", None);
    let stream = unsafe {
        SCStream::initWithFilter_configuration_delegate(
            SCStream::alloc(),
            &filter,
            &config,
            Some(ProtocolObject::from_ref(&*output)),
        )
    };
    let added = unsafe {
        stream.addStreamOutput_type_sampleHandlerQueue_error(
            ProtocolObject::from_ref(&*output),
            SCStreamOutputType::Screen,
            Some(&queue),
        )
    };
    if let Err(e) = added {
        let _ = tx.send(Err(sck_ns_error(&e, "screenshot")));
        return Shot {
            index,
            rx,
            keep: Box::new((filter, config, output, queue, stream)),
            stream: None,
        };
    }
    // A refused start (Screen Recording declined) arrives here, not as a frame.
    let started = RcBlock::new(move |error: *mut NSError| {
        if !error.is_null() {
            let _ = tx.send(Err(sck_error(error, "screenshot")));
        }
    });
    unsafe { stream.startCaptureWithCompletionHandler(Some(&started)) };
    Shot {
        index,
        rx,
        keep: Box::new((filter, config, output, queue, started)),
        stream: Some(stream),
    }
}

struct StreamOutputIvars {
    tx: Mutex<Option<mpsc::Sender<ScreenResult>>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "AIProctorScreenStreamOutput"]
    #[ivars = StreamOutputIvars]
    struct ScreenStreamOutput;

    unsafe impl NSObjectProtocol for ScreenStreamOutput {}

    unsafe impl SCStreamOutput for ScreenStreamOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn did_output(
            &self,
            _stream: &SCStream,
            sample: &CMSampleBuffer,
            kind: SCStreamOutputType,
        ) {
            if kind == SCStreamOutputType::Screen {
                self.on_sample(sample);
            }
        }
    }

    unsafe impl SCStreamDelegate for ScreenStreamOutput {
        #[unsafe(method(stream:didStopWithError:))]
        fn did_stop(&self, _stream: &SCStream, error: &NSError) {
            self.finish(Err(sck_ns_error(error, "screenshot")));
        }
    }
);

impl ScreenStreamOutput {
    fn new(tx: mpsc::Sender<ScreenResult>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(StreamOutputIvars {
            tx: Mutex::new(Some(tx)),
        });
        unsafe { msg_send![super(this), init] }
    }

    /// Hands the result to the waiting caller; anything after the first is ignored.
    fn finish(&self, result: ScreenResult) {
        if let Ok(mut tx) = self.ivars().tx.lock() {
            if let Some(tx) = tx.take() {
                let _ = tx.send(result);
            }
        }
    }

    /// Takes the first complete frame: BGRA pixels copied out of the pixel buffer
    /// (honouring its row stride) and swapped to RGBA.
    fn on_sample(&self, sample: &CMSampleBuffer) {
        if self.ivars().tx.lock().map_or(true, |tx| tx.is_none()) {
            return;
        }
        if !frame_status_is_complete(sample_frame_status(sample)) {
            return;
        }
        let Some(buffer) = (unsafe { sample.image_buffer() }) else {
            return;
        };
        let (w, h, stride, bytes) = copy_pixel_buffer(&buffer);
        self.finish(match bgra_to_rgba(&bytes, w, h, stride) {
            Some(rgba) => Ok((w as u32, h as u32, rgba)),
            None => Err(CaptureError::Failed(
                "screenshot pixel buffer too short".into(),
            )),
        });
    }
}

/// The `SCFrameStatus` ScreenCaptureKit attaches to a stream sample, if any.
fn sample_frame_status(sample: &CMSampleBuffer) -> Option<isize> {
    let attachments = unsafe { sample.sample_attachments_array(false) }?;
    // CFArray and NSArray are toll-free bridged; the element is a CFDictionary.
    let attachments: &NSArray<NSDictionary<NSString, AnyObject>> =
        unsafe { &*(&*attachments as *const CFArray as *const NSArray<_>) };
    let info = attachments.firstObject()?;
    let status = info.objectForKey(unsafe { SCStreamFrameInfoStatus })?;
    status.downcast_ref::<NSNumber>().map(|n| n.integerValue())
}

/// Copies a BGRA pixel buffer out while it is locked: (width, height, row stride,
/// bytes). The bytes are empty when the buffer has no base address.
fn copy_pixel_buffer(buffer: &CVPixelBuffer) -> (usize, usize, usize, Vec<u8>) {
    unsafe {
        CVPixelBufferLockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly);
        let w = CVPixelBufferGetWidth(buffer);
        let h = CVPixelBufferGetHeight(buffer);
        let stride = CVPixelBufferGetBytesPerRow(buffer);
        let base = CVPixelBufferGetBaseAddress(buffer) as *const u8;
        let bytes = if base.is_null() {
            Vec::new()
        } else {
            std::slice::from_raw_parts(base, stride * h).to_vec()
        };
        CVPixelBufferUnlockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly);
        (w, h, stride, bytes)
    }
}

struct GrabberIvars {
    frames: AtomicU32,
    last_luma: Mutex<Option<f64>>,
    tx: Mutex<Option<mpsc::Sender<Frame>>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "AIProctorFrameGrabber"]
    #[ivars = GrabberIvars]
    struct FrameGrabber;

    unsafe impl NSObjectProtocol for FrameGrabber {}

    unsafe impl AVCaptureVideoDataOutputSampleBufferDelegate for FrameGrabber {
        #[unsafe(method(captureOutput:didOutputSampleBuffer:fromConnection:))]
        fn did_output(
            &self,
            _output: &AVCaptureOutput,
            sample: &CMSampleBuffer,
            _conn: &AVCaptureConnection,
        ) {
            self.on_frame(sample);
        }
    }
);

impl FrameGrabber {
    fn new(tx: mpsc::Sender<Frame>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(GrabberIvars {
            frames: AtomicU32::new(0),
            last_luma: Mutex::new(None),
            tx: Mutex::new(Some(tx)),
        });
        unsafe { msg_send![super(this), init] }
    }

    /// Hands the first settled frame (see `webcam_frame_ready`) to the waiting
    /// caller; later frames are ignored.
    fn on_frame(&self, sample: &CMSampleBuffer) {
        let ivars = self.ivars();
        if ivars.tx.lock().map_or(true, |tx| tx.is_none()) {
            return;
        }
        let n = ivars.frames.fetch_add(1, Ordering::SeqCst) + 1;
        let Some(buffer) = (unsafe { sample.image_buffer() }) else {
            return;
        };
        // Copy the pixels out while the buffer is locked; the luma check and the
        // RGBA swap happen on the copy.
        let (w, h, stride, bytes) = copy_pixel_buffer(&buffer);
        let Some(luma) = mean_luma_bgra(&bytes, w, h, stride) else {
            return;
        };
        let Ok(mut last) = ivars.last_luma.lock() else {
            return;
        };
        let ready = webcam_frame_ready(n, luma, *last);
        tracing::debug!(
            frame = n,
            width = w,
            height = h,
            luma,
            ready,
            "webcam frame"
        );
        *last = Some(luma);
        if !ready {
            return;
        }
        let Some(rgba) = bgra_to_rgba(&bytes, w, h, stride) else {
            return;
        };
        if let Ok(mut tx) = ivars.tx.lock() {
            if let Some(tx) = tx.take() {
                let _ = tx.send(Frame {
                    display: None,
                    width: w as u32,
                    height: h as u32,
                    rgba,
                });
            }
        }
    }
}

/// AVFoundation: BGRA frames scaled by the capture pipeline to `width` x `height`
/// (the session preset alone was ignored by the built-in camera, spike #13). Stops
/// the session as soon as a settled frame arrives.
fn capture_webcam(width: u32, height: u32) -> Result<Frame, CaptureError> {
    let t0 = Instant::now();
    let Some(video) = (unsafe { AVMediaTypeVideo }) else {
        return Err(CaptureError::Unsupported);
    };
    let Some(device) = (unsafe { AVCaptureDevice::defaultDeviceWithMediaType(video) }) else {
        return Err(CaptureError::NoCamera);
    };
    let input = unsafe { AVCaptureDeviceInput::deviceInputWithDevice_error(&device) }
        .map_err(|e| CaptureError::Failed(format!("camera open: {}", e.localizedDescription())))?;
    let session = unsafe { AVCaptureSession::new() };
    let output = unsafe { AVCaptureVideoDataOutput::new() };
    let (tx, rx) = mpsc::channel();
    let grabber = FrameGrabber::new(tx);
    let queue = DispatchQueue::new("ai-proctor.camera", None);
    unsafe {
        session.beginConfiguration();
        session.addInput(&input);
        let ns = |k: &CFString| -> &NSString { &*(k as *const CFString as *const NSString) };
        let format = NSNumber::new_u32(kCVPixelFormatType_32BGRA);
        let w = NSNumber::new_u32(width);
        let h = NSNumber::new_u32(height);
        let settings = NSDictionary::<NSString, AnyObject>::from_slices(
            &[
                ns(kCVPixelBufferPixelFormatTypeKey),
                ns(kCVPixelBufferWidthKey),
                ns(kCVPixelBufferHeightKey),
            ],
            &[&*format as &AnyObject, &*w as &AnyObject, &*h as &AnyObject],
        );
        output.setVideoSettings(Some(&settings));
        output.setAlwaysDiscardsLateVideoFrames(true);
        output
            .setSampleBufferDelegate_queue(Some(ProtocolObject::from_ref(&*grabber)), Some(&queue));
        session.addOutput(&output);
        session.commitConfiguration();
        session.startRunning();
    }
    let frame = rx.recv_timeout(CAPTURE_TIMEOUT);
    unsafe {
        session.stopRunning();
        output.setSampleBufferDelegate_queue(None, None);
    }
    match frame {
        Ok(frame) => {
            tracing::debug!(
                camera_on_ms = t0.elapsed().as_millis() as u64,
                width = frame.width,
                height = frame.height,
                "webcam frame captured"
            );
            Ok(frame)
        }
        Err(_) => Err(CaptureError::Failed("no webcam frame within 5 s".into())),
    }
}

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

/// Bounds of the active displays, ordered by display ID (the order `capture_screens`
/// numbers them in).
fn display_bounds() -> Vec<Rect> {
    let mut ids = [0u32; 16];
    let mut count = 0u32;
    unsafe { CGGetActiveDisplayList(16, ids.as_mut_ptr(), &mut count) };
    let count = (count as usize).min(ids.len());
    let ids = &mut ids[..count];
    ids.sort_unstable();
    ids.iter()
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

/// One accessibility attribute of `element`, `None` on any AX error.
fn ax_attribute(element: &AXUIElement, name: &str) -> Option<CFRetained<CFType>> {
    let mut value: *const CFType = std::ptr::null();
    let status = unsafe {
        element.copy_attribute_value(&CFString::from_str(name), NonNull::from(&mut value))
    };
    if status != AXError::Success {
        return None;
    }
    NonNull::new(value.cast_mut()).map(|v| unsafe { CFRetained::from_raw(v) })
}

/// A URL attribute value, which is a `CFURL` (`AXURL`) or a `CFString` (`AXDocument`).
fn ax_url_string(value: &CFType) -> Option<String> {
    if let Some(url) = value.downcast_ref::<CFURL>() {
        return Some(url.string().to_string());
    }
    value.downcast_ref::<CFString>().map(|s| s.to_string())
}

/// Breadth-first search below `root` for the first element `matches` accepts,
/// bounded by depth, element count and time.
fn find_element(
    root: CFRetained<AXUIElement>,
    what: &str,
    matches: impl Fn(&AXUIElement) -> bool,
) -> Option<CFRetained<AXUIElement>> {
    let deadline = Instant::now() + AX_BUDGET;
    let mut queue = VecDeque::from([(root, 0usize)]);
    let mut visited = 0;
    while let Some((element, depth)) = queue.pop_front() {
        if visited >= AX_MAX_ELEMENTS || Instant::now() >= deadline {
            tracing::debug!(visited, what, "accessibility search budget spent");
            return None;
        }
        visited += 1;
        if matches(&element) {
            return Some(element);
        }
        if depth >= AX_MAX_DEPTH {
            continue;
        }
        let Some(children) = ax_attribute(&element, "AXChildren") else {
            continue;
        };
        let Ok(children) = children.downcast::<CFArray>() else {
            continue;
        };
        // AXChildren is an array of AXUIElement; the downcast below checks each.
        let children = unsafe { CFRetained::cast_unchecked::<CFArray<CFType>>(children) };
        for child in children.iter() {
            if let Ok(child) = child.downcast::<AXUIElement>() {
                queue.push_back((child, depth + 1));
            }
        }
    }
    None
}

/// A string attribute of `element`, `None` if missing or not a string.
fn ax_string(element: &AXUIElement, name: &str) -> Option<String> {
    ax_attribute(element, name)?
        .downcast_ref::<CFString>()
        .map(|s| s.to_string())
}

/// The page's `AXWebArea` below `root`.
fn find_web_area(root: CFRetained<AXUIElement>) -> Option<CFRetained<AXUIElement>> {
    find_element(root, "web area", |e| {
        ax_string(e, "AXRole").is_some_and(|r| r == "AXWebArea")
    })
}

/// The Chromium address bar below `root`: an `AXTextField` whose description or
/// title mentions "address" ("Address and search bar").
fn find_address_bar(root: CFRetained<AXUIElement>) -> Option<CFRetained<AXUIElement>> {
    let mentions_address = |e: &AXUIElement, name| {
        ax_string(e, name).is_some_and(|s| s.to_lowercase().contains("address"))
    };
    find_element(root, "address bar", |e| {
        ax_string(e, "AXRole").is_some_and(|r| r == "AXTextField")
            && (mentions_address(e, "AXDescription") || mentions_address(e, "AXTitle"))
    })
}

/// Asks a Chromium browser to build its accessibility tree, once per pid. Without
/// this it exposes no `AXWebArea`. The tree is built asynchronously, so the first
/// lookup after this may still find nothing.
fn enable_chromium_accessibility(app: &AXUIElement, pid: i32, enabled: &Mutex<HashSet<i32>>) {
    let Ok(mut enabled) = enabled.lock() else {
        return;
    };
    if enabled.contains(&pid) {
        return;
    }
    let status = unsafe {
        app.set_attribute_value(
            &CFString::from_str("AXManualAccessibility"),
            CFBoolean::new(true).as_ref(),
        )
    };
    if status != AXError::Success {
        tracing::debug!(?status, "could not enable browser accessibility");
        return;
    }
    if enabled.len() >= AX_ENABLED_MAX_PIDS {
        enabled.clear();
    }
    enabled.insert(pid);
    tracing::debug!("enabled browser accessibility");
}

/// Domain of the page in the browser's focused window, via Accessibility. `None`
/// without the permission (checked without prompting), when the browser exposes no
/// URL, or when the search runs out of budget. Needs Accessibility only. Chromium
/// browsers are first asked to build their tree, and fall back to the address bar
/// when the web area has no URL.
fn browser_domain(pid: i32, chromium: bool, enabled: &Mutex<HashSet<i32>>) -> Option<String> {
    if !unsafe { AXIsProcessTrusted() } {
        tracing::debug!("accessibility not granted, no browser domain");
        return None;
    }
    let app = unsafe { AXUIElement::new_application(pid) };
    unsafe { app.set_messaging_timeout(AX_MESSAGE_TIMEOUT_SECS) };
    if chromium {
        enable_chromium_accessibility(&app, pid, enabled);
    }
    let window = ax_attribute(&app, "AXFocusedWindow")?
        .downcast::<AXUIElement>()
        .ok()?;
    // Chromium and Safari: the web area's AXURL. Firefox may only expose the
    // window's AXDocument.
    let from_web_area = find_web_area(window.clone())
        .and_then(|area| ax_attribute(&area, "AXURL"))
        .and_then(|v| ax_url_string(&v));
    let url = from_web_area
        .or_else(|| ax_attribute(&window, "AXDocument").and_then(|v| ax_url_string(&v)));
    let mut domain = url.as_deref().and_then(domain_of);
    if domain.is_none() && chromium {
        domain = find_address_bar(window)
            .and_then(|field| ax_string(&field, "AXValue"))
            .as_deref()
            .and_then(domain_of_address);
    }
    tracing::debug!(found = domain.is_some(), "browser domain read");
    domain
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

    #[test]
    fn title_is_the_frontmost_normal_window_of_the_app() {
        let windows = [
            window(11, "Other app", 0, MAIN),
            window(10, "Toolbar", 25, MAIN),
            window(10, "", 0, MAIN),
            window(10, "  Report.docx  ", 0, MAIN),
            window(10, "Older window", 0, MAIN),
        ];
        assert_eq!(
            foreground_title(&windows, 10).as_deref(),
            Some("Report.docx")
        );
    }

    #[test]
    fn foreground_display_is_the_one_holding_the_front_window_centre() {
        let displays = [MAIN, SECOND];
        let on_main = Rect {
            x: 100.0,
            y: 100.0,
            width: 800.0,
            height: 600.0,
        };
        let on_second = Rect {
            x: 2000.0,
            y: 50.0,
            width: 600.0,
            height: 400.0,
        };
        assert_eq!(
            foreground_display(&[window(10, "A", 0, on_main)], &displays, 10),
            Some(1)
        );
        assert_eq!(
            foreground_display(&[window(10, "A", 0, on_second)], &displays, 10),
            Some(2)
        );
    }

    #[test]
    fn foreground_display_uses_the_centre_of_a_window_spanning_displays() {
        let displays = [MAIN, SECOND];
        // Mostly on the second display: centre x = 1800 + 500 = 2300.
        let mostly_second = Rect {
            x: 1800.0,
            y: 0.0,
            width: 1000.0,
            height: 500.0,
        };
        assert_eq!(
            foreground_display(&[window(10, "A", 0, mostly_second)], &displays, 10),
            Some(2)
        );
        // Mostly on the main display: centre x = 1000 + 300 = 1300.
        let mostly_main = Rect {
            x: 1000.0,
            y: 0.0,
            width: 600.0,
            height: 500.0,
        };
        assert_eq!(
            foreground_display(&[window(10, "A", 0, mostly_main)], &displays, 10),
            Some(1)
        );
    }

    #[test]
    fn foreground_display_takes_the_apps_frontmost_normal_window() {
        let displays = [MAIN, SECOND];
        let on_main = Rect {
            x: 0.0,
            y: 0.0,
            width: 400.0,
            height: 300.0,
        };
        let on_second = Rect {
            x: 2000.0,
            y: 0.0,
            width: 400.0,
            height: 300.0,
        };
        let windows = [
            window(11, "Other app", 0, on_main),
            window(10, "Menu", 25, on_main),
            window(10, "", 0, Rect::default()),
            window(10, "", 0, on_second),
            window(10, "Older", 0, on_main),
        ];
        assert_eq!(foreground_display(&windows, &displays, 10), Some(2));
    }

    #[test]
    fn foreground_display_is_none_when_unknown() {
        let displays = [MAIN, SECOND];
        let nowhere = Rect {
            x: 9000.0,
            y: 9000.0,
            width: 100.0,
            height: 100.0,
        };
        assert_eq!(foreground_display(&[], &displays, 10), None);
        assert_eq!(
            foreground_display(&[window(11, "A", 0, MAIN)], &displays, 10),
            None
        );
        assert_eq!(
            foreground_display(&[window(10, "A", 25, MAIN)], &displays, 10),
            None
        );
        assert_eq!(
            foreground_display(&[window(10, "A", 0, nowhere)], &displays, 10),
            None
        );
        assert_eq!(
            foreground_display(&[window(10, "A", 0, MAIN)], &[], 10),
            None
        );
    }

    #[test]
    fn title_is_none_without_titles_or_windows() {
        assert_eq!(foreground_title(&[], 10), None);
        let untitled = [window(10, "", 0, MAIN), window(10, "   ", 0, MAIN)];
        assert_eq!(foreground_title(&untitled, 10), None);
        assert_eq!(foreground_title(&[window(11, "Mail", 0, MAIN)], 10), None);
    }

    #[test]
    fn long_titles_are_capped_by_characters() {
        let long = "é".repeat(600);
        let windows = [window(10, &long, 0, MAIN)];
        let title = foreground_title(&windows, 10).unwrap_or_default();
        assert_eq!(
            title.chars().count(),
            agent_core::foreground::MAX_TITLE_CHARS
        );
    }

    #[test]
    fn known_browsers_are_recognised_by_bundle_id() {
        for id in [
            "com.google.Chrome",
            "com.microsoft.edgemac",
            "com.apple.Safari",
            "org.mozilla.firefox",
            "com.brave.Browser",
            "company.thebrowser.Browser",
        ] {
            assert!(is_browser_bundle(id), "{id}");
        }
        assert!(!is_browser_bundle("com.apple.finder"));
        assert!(!is_browser_bundle("com.google.Chrome.helper"));
        assert!(!is_browser_bundle(""));
    }

    #[test]
    fn chromium_family_is_told_apart_from_safari_and_firefox() {
        for id in [
            "com.google.Chrome",
            "com.google.Chrome.beta",
            "com.google.Chrome.dev",
            "com.google.Chrome.canary",
            "com.microsoft.edgemac",
            "com.microsoft.edgemac.Beta",
            "com.microsoft.edgemac.Dev",
            "com.microsoft.edgemac.Canary",
            "com.brave.Browser",
            "com.brave.Browser.beta",
            "com.brave.Browser.nightly",
            "company.thebrowser.Browser",
            "com.vivaldi.Vivaldi",
            "com.operasoftware.Opera",
        ] {
            assert!(is_chromium_bundle(id), "{id}");
        }
        for id in [
            "com.apple.Safari",
            "com.apple.SafariTechnologyPreview",
            "org.mozilla.firefox",
            "org.mozilla.nightly",
            "com.apple.finder",
            "",
        ] {
            assert!(!is_chromium_bundle(id), "{id}");
        }
    }

    #[test]
    fn bgra_is_swapped_to_rgba_with_opaque_alpha() {
        // Two pixels: B,G,R,A = (1,2,3,x) and (4,5,6,x).
        let bytes = [1, 2, 3, 0, 4, 5, 6, 0];
        assert_eq!(
            bgra_to_rgba(&bytes, 2, 1, 8),
            Some(vec![3, 2, 1, 255, 6, 5, 4, 255])
        );
    }

    #[test]
    fn row_padding_is_dropped() {
        // 1 px wide, 2 rows, stride 8 (4 bytes of padding per row).
        let bytes = [
            1, 2, 3, 9, 0xEE, 0xEE, 0xEE, 0xEE, 4, 5, 6, 9, 0xEE, 0xEE, 0xEE, 0xEE,
        ];
        assert_eq!(
            bgra_to_rgba(&bytes, 1, 2, 8),
            Some(vec![3, 2, 1, 255, 6, 5, 4, 255])
        );
        // The last row needs no trailing padding.
        assert_eq!(
            bgra_to_rgba(&bytes[..12], 1, 2, 8).map(|v| v.len()),
            Some(8)
        );
    }

    #[test]
    fn short_or_inconsistent_buffers_are_rejected() {
        assert_eq!(bgra_to_rgba(&[0; 7], 2, 1, 8), None);
        assert_eq!(bgra_to_rgba(&[0; 16], 2, 1, 4), None);
        assert_eq!(bgra_to_rgba(&[], 0, 0, 0), Some(Vec::new()));
    }

    #[test]
    fn mean_luma_of_bgra_uses_rec601_and_ignores_padding() {
        let white = [255, 255, 255, 255, 0, 0, 0, 0];
        let black = [0, 0, 0, 255, 0, 0, 0, 0];
        let luma = mean_luma_bgra(&white, 1, 1, 8).unwrap_or(-1.0);
        assert!((luma - 255.0).abs() < 1e-9);
        assert_eq!(mean_luma_bgra(&black, 1, 1, 8), Some(0.0));
        // One white, one black row: 127.5.
        let both = [255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0];
        let luma = mean_luma_bgra(&both, 1, 2, 8).unwrap_or(-1.0);
        assert!((luma - 127.5).abs() < 1e-9);
        assert_eq!(mean_luma_bgra(&[0; 3], 1, 1, 4), None);
    }

    #[test]
    fn retina_display_is_scaled_down_to_max_width() {
        // 1728 x 1117 pt at 2x: 3456 px wide, capped to 1280.
        assert_eq!(
            display_capture_size(1728.0, 1117.0, 2.0, 1280),
            Some((1280, 827))
        );
    }

    #[test]
    fn small_display_is_not_upscaled() {
        assert_eq!(
            display_capture_size(1024.0, 768.0, 1.0, 1280),
            Some((1024, 768))
        );
        // 2x display whose pixel width is under the cap.
        assert_eq!(
            display_capture_size(512.0, 300.0, 2.0, 1280),
            Some((1024, 600))
        );
    }

    #[test]
    fn bad_display_sizes_are_rejected() {
        assert_eq!(display_capture_size(0.0, 100.0, 2.0, 1280), None);
        assert_eq!(display_capture_size(100.0, 0.0, 2.0, 1280), None);
        assert_eq!(display_capture_size(100.0, 100.0, 2.0, 0), None);
        // A nonsense scale falls back to 1x.
        assert_eq!(
            display_capture_size(800.0, 600.0, 0.0, 1280),
            Some((800, 600))
        );
    }

    #[test]
    fn tcc_declined_error_is_recognised() {
        assert!(is_tcc_declined(-3801, ""));
        assert!(is_tcc_declined(
            1,
            "The user declined TCCs for application, window, display capture"
        ));
        assert!(!is_tcc_declined(-3805, "Stream was interrupted"));
    }

    #[test]
    fn manager_from_macos_14_stream_before() {
        assert_eq!(screenshot_api(13, false), ScreenshotApi::Stream);
        assert_eq!(screenshot_api(12, false), ScreenshotApi::Stream);
        assert_eq!(screenshot_api(14, false), ScreenshotApi::Manager);
        assert_eq!(screenshot_api(26, false), ScreenshotApi::Manager);
    }

    #[test]
    fn forcing_the_stream_path_wins_on_any_version() {
        assert_eq!(screenshot_api(14, true), ScreenshotApi::Stream);
        assert_eq!(screenshot_api(26, true), ScreenshotApi::Stream);
        assert_eq!(screenshot_api(13, true), ScreenshotApi::Stream);
    }

    #[test]
    fn pixel_scale_is_pixels_over_points() {
        assert_eq!(pixel_scale(1728.0, 3456.0), 2.0);
        assert_eq!(pixel_scale(1920.0, 1920.0), 1.0);
        // A 13 path size comes out the same as the 14+ one: 3456 px capped to 1280.
        let scale = pixel_scale(1728.0, 3456.0);
        assert_eq!(
            display_capture_size(1728.0, 1117.0, scale, 1280),
            Some((1280, 827))
        );
    }

    #[test]
    fn nonsense_pixel_scale_falls_back_to_1x() {
        assert_eq!(pixel_scale(0.0, 100.0), 1.0);
        assert_eq!(pixel_scale(1920.0, 0.0), 1.0);
        assert_eq!(pixel_scale(1920.0, 960.0), 1.0);
    }

    #[test]
    fn only_complete_frames_are_screenshots() {
        assert!(frame_status_is_complete(Some(SCFrameStatus::Complete.0)));
        assert!(frame_status_is_complete(None));
        assert!(!frame_status_is_complete(Some(SCFrameStatus::Idle.0)));
        assert!(!frame_status_is_complete(Some(SCFrameStatus::Blank.0)));
        assert!(!frame_status_is_complete(Some(SCFrameStatus::Suspended.0)));
        assert!(!frame_status_is_complete(Some(SCFrameStatus::Started.0)));
    }

    /// Takes one screenshot per display with the macOS 13 `SCStream` path, whatever
    /// the OS version. Needs Screen Recording for the process that runs it (the
    /// terminal or the Claude app), so it is ignored by default. Run it by hand:
    ///
    /// `cargo test -p agent-platform --lib stream_screenshot -- --ignored --nocapture`
    #[test]
    #[ignore = "needs Screen Recording; run by hand"]
    fn stream_screenshot_captures_every_display() {
        assert!(
            CGPreflightScreenCaptureAccess(),
            "grant Screen Recording to the terminal first"
        );
        std::env::set_var("AI_PROCTOR_DEV_FORCE_SCSTREAM", "1");
        assert_eq!(
            screenshot_api(os_major(), force_stream()),
            ScreenshotApi::Stream
        );
        let frames = capture_screens(1280).expect("capture");
        assert!(!frames.is_empty());
        for frame in &frames {
            assert!(frame.width >= 1 && frame.width <= 1280, "{}", frame.width);
            assert_eq!(
                frame.rgba.len(),
                frame.width as usize * frame.height as usize * 4
            );
            assert!(frame.rgba.as_chunks::<4>().0.iter().all(|px| px[3] == 255));
            assert!(frame.rgba.iter().any(|&b| b != 0), "frame is all black");
        }
    }
}
