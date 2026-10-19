//! macOS (objc2: ScreenCaptureKit, AVFoundation, AppKit, CoreAudio, CoreMediaIO).
//! Presence signals (idle, lock/sleep, camera/mic, sharing/presenting) are real, from
//! spike #14 (`docs/spikes/presence-signals.md`). Capture and permissions are real,
//! from spike #13 (`docs/spikes/capture.md`); they return raw RGBA pixels, encoding
//! happens in `agent_core::capture`. The rest stays a stub until its feature lands.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use agent_core::contracts::{PermissionState, Permissions};
use agent_core::platform::{
    CallState, CaptureError, Click, Foreground, Frame, Platform, SessionState,
};
use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_app_kit::NSWorkspace;
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
use objc2_core_foundation::{CFArray, CFDictionary, CFString};
use objc2_core_graphics::{
    CGDataProvider, CGDisplayBounds, CGEventSource, CGEventSourceStateID, CGEventType,
    CGGetActiveDisplayList, CGImage, CGPreflightScreenCaptureAccess,
    CGSessionCopyCurrentDictionary, CGWindowListCopyWindowInfo, CGWindowListOption,
};
use objc2_core_media::CMSampleBuffer;
use objc2_core_media_io::{
    kCMIODevicePropertyDeviceIsRunningSomewhere, kCMIOHardwarePropertyDevices,
    kCMIOObjectPropertyElementMain, kCMIOObjectPropertyScopeGlobal, kCMIOObjectSystemObject,
    CMIOObjectGetPropertyData, CMIOObjectGetPropertyDataSize, CMIOObjectPropertyAddress,
};
use objc2_core_video::{
    kCVPixelBufferHeightKey, kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferWidthKey,
    kCVPixelFormatType_32BGRA, CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow,
    CVPixelBufferGetHeight, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress,
    CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{
    NSArray, NSDictionary, NSError, NSNotification, NSNumber, NSObject, NSObjectProtocol, NSString,
};
use objc2_screen_capture_kit::{
    SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration,
};

/// How long a capture may take before the caller gets `Failed`, so a completion
/// handler that never fires cannot hang the check-in.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(5);

/// A webcam frame is accepted once its mean luma reaches this (warm-up frames are
/// black) and is within `SETTLE_DELTA` of the previous frame.
const MIN_LUMA: f64 = 15.0;
const SETTLE_DELTA: f64 = 2.0;
/// Give up waiting for the exposure to settle after this many frames (~3 s).
const MAX_WEBCAM_FRAMES: u32 = 90;

/// `SCStreamErrorUserDeclined`: Screen Recording refused by the user (TCC).
const SC_ERROR_USER_DECLINED: isize = -3801;

/// Moves an Objective-C object across threads; it is only read on the other side.
struct Sendable<T>(T);
unsafe impl<T> Send for Sendable<T> {}

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

    /// App name only; titles and domains come with activity sampling (#25).
    fn foreground(&self) -> Option<Foreground> {
        let app = NSWorkspace::sharedWorkspace()
            .frontmostApplication()?
            .localizedName()?
            .to_string();
        Some(Foreground {
            app,
            title: None,
            domain: None,
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

/// Webcam settle rule: real exposure (luma >= `MIN_LUMA`) and stable against the
/// previous frame, or the frame budget is spent. `n` is the 1-based frame number.
fn webcam_frame_ready(n: u32, luma: f64, previous: Option<f64>) -> bool {
    let settled = luma >= MIN_LUMA && previous.is_some_and(|p| (luma - p).abs() < SETTLE_DELTA);
    settled || n >= MAX_WEBCAM_FRAMES
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
        Some(e) => {
            let description = e.localizedDescription().to_string();
            if is_tcc_declined(e.code(), &description) {
                CaptureError::PermissionMissing
            } else {
                CaptureError::Failed(format!("{what}: {description}"))
            }
        }
        None => CaptureError::Failed(format!("{what}: no result")),
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

/// One ScreenCaptureKit screenshot per display, started together and collected
/// under one deadline. SCK scales on the GPU to `max_width`.
fn capture_screens(max_width: u32) -> Result<Vec<Frame>, CaptureError> {
    let deadline = Instant::now() + CAPTURE_TIMEOUT;
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

    let displays = unsafe { content.displays() };
    if displays.is_empty() {
        return Err(CaptureError::Failed("no displays".into()));
    }
    // Start every display, keep filter and configuration alive until it completes.
    let mut pending = Vec::new();
    for (index, display) in displays.iter().enumerate() {
        let (points_w, points_h) = unsafe { (display.width() as f64, display.height() as f64) };
        let filter = unsafe {
            SCContentFilter::initWithDisplay_excludingWindows(
                SCContentFilter::alloc(),
                &display,
                &NSArray::new(),
            )
        };
        let scale = unsafe { filter.pointPixelScale() } as f64;
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
        pending.push((index as u32 + 1, rx, filter, config, handler));
    }

    let mut frames = Vec::new();
    let mut first_error = None;
    for (index, rx, _filter, _config, _handler) in pending {
        let wait = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(wait) {
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
    // A missing permission fails the whole capture; partial failures keep the
    // displays that did work (the check-in still passes, CAP-08).
    match (frames.is_empty(), first_error) {
        (true, Some(e)) => Err(e),
        (true, None) => Err(CaptureError::Failed("no displays captured".into())),
        (false, _) => Ok(frames),
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
        let (w, h, stride, bytes) = unsafe {
            CVPixelBufferLockBaseAddress(&buffer, CVPixelBufferLockFlags::ReadOnly);
            let w = CVPixelBufferGetWidth(&buffer);
            let h = CVPixelBufferGetHeight(&buffer);
            let stride = CVPixelBufferGetBytesPerRow(&buffer);
            let base = CVPixelBufferGetBaseAddress(&buffer) as *const u8;
            let bytes = if base.is_null() {
                Vec::new()
            } else {
                std::slice::from_raw_parts(base, stride * h).to_vec()
            };
            CVPixelBufferUnlockBaseAddress(&buffer, CVPixelBufferLockFlags::ReadOnly);
            (w, h, stride, bytes)
        };
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
    fn dark_warm_up_frames_never_settle() {
        // Identical black frames are stable but have no exposure.
        assert!(!webcam_frame_ready(3, 12.0, Some(12.0)));
        assert!(!webcam_frame_ready(2, 0.0, Some(0.0)));
    }

    #[test]
    fn first_frame_and_unstable_frames_do_not_settle() {
        assert!(!webcam_frame_ready(1, 150.0, None));
        assert!(!webcam_frame_ready(4, 155.0, Some(12.0)));
        assert!(!webcam_frame_ready(5, 150.0, Some(152.5)));
    }

    #[test]
    fn exposed_stable_frame_settles() {
        assert!(webcam_frame_ready(5, 158.0, Some(157.0)));
        assert!(webcam_frame_ready(3, 15.0, Some(14.5)));
    }

    #[test]
    fn frame_budget_ends_the_wait() {
        assert!(!webcam_frame_ready(89, 5.0, Some(50.0)));
        assert!(webcam_frame_ready(90, 5.0, Some(50.0)));
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
}
