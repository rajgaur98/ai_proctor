//! #13: screenshot per display (ScreenCaptureKit), one webcam frame (AVFoundation),
//! permission checks that never prompt, downscale + WebP sizes and timings.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use block2::RcBlock;
use dispatch2::DispatchQueue;
use fast_image_resize as fir;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_av_foundation::{
    AVAuthorizationStatus, AVCaptureConnection, AVCaptureDevice, AVCaptureDeviceInput,
    AVCaptureOutput, AVCaptureSession, AVCaptureSessionPreset320x240, AVCaptureVideoDataOutput,
    AVCaptureVideoDataOutputSampleBufferDelegate, AVMediaTypeVideo,
};
use objc2_core_foundation::CFString;
use objc2_core_graphics::{
    CGDataProvider, CGImage, CGPreflightScreenCaptureAccess, CGRequestScreenCaptureAccess,
};
use objc2_core_media::CMSampleBuffer;
use objc2_core_video::{
    kCVPixelBufferPixelFormatTypeKey, kCVPixelFormatType_32BGRA, CVPixelBufferGetBaseAddress,
    CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight, CVPixelBufferGetWidth,
    CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{
    NSArray, NSDictionary, NSError, NSNumber, NSObject, NSObjectProtocol, NSString,
};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCScreenshotManager, SCShareableContent, SCStreamConfiguration,
};

use crate::log::log;

const MAX_WIDTH: u32 = 1280;
const SCREEN_QUALITY: f32 = 60.0;
const WEBCAM_QUALITY: f32 = 60.0;

/// Moves an Objective-C object across threads; the spike only reads it on the other side.
struct Sendable<T>(T);
unsafe impl<T> Send for Sendable<T> {}

// --- Permissions (never prompt) ---------------------------------------------

pub fn screen_permission() -> bool {
    CGPreflightScreenCaptureAccess()
}

pub fn camera_permission() -> &'static str {
    let Some(video) = (unsafe { AVMediaTypeVideo }) else {
        return "no AVMediaTypeVideo";
    };
    match unsafe { AVCaptureDevice::authorizationStatusForMediaType(video) } {
        AVAuthorizationStatus::Authorized => "authorized",
        AVAuthorizationStatus::Denied => "denied",
        AVAuthorizationStatus::Restricted => "restricted",
        AVAuthorizationStatus::NotDetermined => "not determined",
        _ => "unknown",
    }
}

pub fn log_permissions(context: &str) {
    let t = Instant::now();
    let screen = screen_permission();
    let camera = camera_permission();
    log(&format!(
        "PERMISSIONS ({context}) screen recording={screen} camera={camera} (checked in {:.2} ms, no prompt expected)",
        t.elapsed().as_secs_f64() * 1000.0
    ));
}

/// Onboarding path: these calls may show the system prompt.
pub fn request_access() {
    let screen = CGRequestScreenCaptureAccess();
    log(&format!("REQUEST screen recording -> {screen}"));
    if let Some(video) = unsafe { AVMediaTypeVideo } {
        let block = RcBlock::new(|granted: objc2::runtime::Bool| {
            log(&format!("REQUEST camera -> {}", granted.as_bool()));
        });
        unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(video, &block) };
    }
}

// --- Full capture -----------------------------------------------------------

#[derive(Clone, Copy, Debug)]
pub enum ScreenMode {
    /// ScreenCaptureKit scales to <= 1280 px wide on the GPU.
    SckScaled,
    /// Capture at native pixels, downscale on the CPU with fast_image_resize.
    NativeCpuResize,
}

/// SPIKE_SCREEN_MODE=native compares CPU downscaling; default lets SCK scale.
pub fn mode_from_env() -> ScreenMode {
    match std::env::var("SPIKE_SCREEN_MODE").as_deref() {
        Ok("native") => ScreenMode::NativeCpuResize,
        _ => ScreenMode::SckScaled,
    }
}

/// Captures every display and one webcam frame in parallel, writes WebP files, and
/// logs sizes and timings. `started` is the click that passed the check-in.
pub fn capture_all(started: Instant, mode: ScreenMode) {
    let dir = out_dir();
    let screen_ok = screen_permission();
    let camera = camera_permission();

    let screens = {
        let dir = dir.clone();
        std::thread::spawn(move || {
            if screen_ok {
                capture_screens(&dir, mode)
            } else {
                log("SCREEN skipped: Screen Recording not granted (CAP-08 reason: permission_missing)");
                Vec::new()
            }
        })
    };
    let webcam = {
        let dir = dir.clone();
        std::thread::spawn(move || {
            if camera == "authorized" {
                capture_webcam(&dir)
            } else {
                log(&format!(
                    "WEBCAM skipped: camera {camera} (CAP-08 reason: permission_missing)"
                ));
                None
            }
        })
    };
    let screens = screens.join().unwrap_or_default();
    let webcam = webcam.join().ok().flatten();

    let total: usize = screens.iter().sum::<usize>() + webcam.unwrap_or(0);
    log(&format!(
        "CAPTURE DONE {:.0} ms after click | {} screen file(s) {:?} bytes, webcam {:?} bytes, total {total} bytes | mode {mode:?} | {}",
        started.elapsed().as_secs_f64() * 1000.0,
        screens.len(),
        screens,
        webcam,
        dir.display()
    ));
}

fn out_dir() -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let dir = crate::log::path()
        .parent()
        .unwrap()
        .join("captures")
        .join(stamp.to_string());
    let _ = std::fs::create_dir_all(&dir);
    dir
}

// --- Screens ----------------------------------------------------------------

fn capture_screens(dir: &Path, mode: ScreenMode) -> Vec<usize> {
    let t0 = Instant::now();
    let (tx, rx) = mpsc::channel();
    let handler = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            let content = unsafe { Retained::retain(content) };
            let error =
                unsafe { Retained::retain(error) }.map(|e| e.localizedDescription().to_string());
            let _ = tx.send(Sendable((content, error)));
        },
    );
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&handler) };
    let Ok(Sendable((content, error))) = rx.recv_timeout(Duration::from_secs(5)) else {
        log("SCREEN shareable content timed out");
        return Vec::new();
    };
    let Some(content) = content else {
        log(&format!("SCREEN shareable content error: {error:?}"));
        return Vec::new();
    };
    let displays = unsafe { content.displays() };
    log(&format!(
        "SCREEN {} display(s), shareable content in {:.0} ms",
        displays.len(),
        t0.elapsed().as_secs_f64() * 1000.0
    ));

    let mut sizes = Vec::new();
    for (index, display) in displays.iter().enumerate() {
        if let Some(size) = capture_display(dir, index + 1, &display, mode) {
            sizes.push(size);
        }
    }
    sizes
}

fn capture_display(
    dir: &Path,
    index: usize,
    display: &SCDisplay,
    mode: ScreenMode,
) -> Option<usize> {
    let t0 = Instant::now();
    let (points_w, points_h) = unsafe { (display.width() as u32, display.height() as u32) };
    let filter = unsafe {
        SCContentFilter::initWithDisplay_excludingWindows(
            SCContentFilter::alloc(),
            display,
            &NSArray::new(),
        )
    };
    let (req_w, req_h) = match mode {
        ScreenMode::SckScaled => {
            let w = points_w.min(MAX_WIDTH);
            (w, (points_h as u64 * w as u64 / points_w as u64) as u32)
        }
        // Backing pixels; Retina displays are 2x their point size.
        ScreenMode::NativeCpuResize => {
            let scale = unsafe { filter.pointPixelScale() } as u32;
            (points_w * scale.max(1), points_h * scale.max(1))
        }
    };
    let config = unsafe { SCStreamConfiguration::new() };
    unsafe {
        config.setWidth(req_w as usize);
        config.setHeight(req_h as usize);
        config.setShowsCursor(false);
    }

    let (tx, rx) = mpsc::channel();
    let handler = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
        let image = unsafe { image.as_ref() }.map(bgra_from_cgimage);
        let error =
            unsafe { Retained::retain(error) }.map(|e| e.localizedDescription().to_string());
        let _ = tx.send((image, error));
    });
    unsafe {
        SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
            &filter,
            &config,
            Some(&handler),
        )
    };
    let Ok((image, error)) = rx.recv_timeout(Duration::from_secs(5)) else {
        log(&format!("SCREEN {index} capture timed out"));
        return None;
    };
    let Some((w, h, rgb)) = image else {
        log(&format!("SCREEN {index} capture error: {error:?}"));
        return None;
    };
    let captured_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let t1 = Instant::now();
    let (w2, h2, rgb) = downscale(w, h, rgb, MAX_WIDTH);
    let resize_ms = t1.elapsed().as_secs_f64() * 1000.0;
    let t2 = Instant::now();
    let webp = webp::Encoder::from_rgb(&rgb, w2, h2).encode(SCREEN_QUALITY);
    let encode_ms = t2.elapsed().as_secs_f64() * 1000.0;
    let _ = std::fs::write(dir.join(format!("screen-{index}.webp")), &*webp);

    log(&format!(
        "SCREEN {index}: {points_w}x{points_h} pt, captured {w}x{h} in {captured_ms:.0} ms, resized to {w2}x{h2} in {resize_ms:.0} ms, WebP q{SCREEN_QUALITY} {} bytes ({:.0} KB, target <= 150 KB) in {encode_ms:.0} ms",
        webp.len(),
        webp.len() as f64 / 1024.0
    ));
    Some(webp.len())
}

/// Copies a CGImage (BGRA from ScreenCaptureKit, SDR) into tightly packed RGB.
fn bgra_from_cgimage(image: &CGImage) -> (u32, u32, Vec<u8>) {
    let w = CGImage::width(Some(image));
    let h = CGImage::height(Some(image));
    let stride = CGImage::bytes_per_row(Some(image));
    let provider = CGImage::data_provider(Some(image));
    let data = CGDataProvider::data(provider.as_deref()).expect("image data");
    let bytes = data.to_vec();
    (w as u32, h as u32, bgra_rows_to_rgb(&bytes, w, h, stride))
}

fn bgra_rows_to_rgb(bytes: &[u8], w: usize, h: usize, stride: usize) -> Vec<u8> {
    let mut rgb = Vec::with_capacity(w * h * 3);
    for row in 0..h {
        let line = &bytes[row * stride..row * stride + w * 4];
        for px in line.chunks_exact(4) {
            rgb.extend_from_slice(&[px[2], px[1], px[0]]);
        }
    }
    rgb
}

fn downscale(w: u32, h: u32, rgb: Vec<u8>, max_w: u32) -> (u32, u32, Vec<u8>) {
    if w <= max_w {
        return (w, h, rgb);
    }
    let dw = max_w;
    let dh = (h as u64 * dw as u64 / w as u64) as u32;
    let src = fir::images::Image::from_vec_u8(w, h, rgb, fir::PixelType::U8x3).expect("src image");
    let mut dst = fir::images::Image::new(dw, dh, fir::PixelType::U8x3);
    fir::Resizer::new()
        .resize(
            &src,
            &mut dst,
            &fir::ResizeOptions::new()
                .resize_alg(fir::ResizeAlg::Convolution(fir::FilterType::Bilinear)),
        )
        .expect("resize");
    (dw, dh, dst.into_vec())
}

// --- Webcam -----------------------------------------------------------------

struct GrabberIvars {
    started: Instant,
    frames: AtomicU32,
    last_luma: Mutex<Option<f64>>,
    tx: Mutex<Option<mpsc::Sender<(u32, u32, Vec<u8>, u32)>>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "AIProctorSpikeFrameGrabber"]
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
    fn new(tx: mpsc::Sender<(u32, u32, Vec<u8>, u32)>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(GrabberIvars {
            started: Instant::now(),
            frames: AtomicU32::new(0),
            last_luma: Mutex::new(None),
            tx: Mutex::new(Some(tx)),
        });
        unsafe { msg_send![super(this), init] }
    }

    /// Waits for auto-exposure to settle: takes the first frame (from the 3rd on)
    /// whose mean luma is within 2 levels of the previous one, or frame 30.
    fn on_frame(&self, sample: &CMSampleBuffer) {
        let ivars = self.ivars();
        if ivars.tx.lock().unwrap().is_none() {
            return;
        }
        let n = ivars.frames.fetch_add(1, Ordering::SeqCst) + 1;
        let Some(buffer) = (unsafe { sample.image_buffer() }) else {
            return;
        };
        let (w, h, rgb) = unsafe {
            CVPixelBufferLockBaseAddress(&buffer, CVPixelBufferLockFlags::ReadOnly);
            let w = CVPixelBufferGetWidth(&buffer);
            let h = CVPixelBufferGetHeight(&buffer);
            let stride = CVPixelBufferGetBytesPerRow(&buffer);
            let base = CVPixelBufferGetBaseAddress(&buffer) as *const u8;
            let bytes = std::slice::from_raw_parts(base, stride * h);
            let rgb = bgra_rows_to_rgb(bytes, w, h, stride);
            CVPixelBufferUnlockBaseAddress(&buffer, CVPixelBufferLockFlags::ReadOnly);
            (w as u32, h as u32, rgb)
        };
        let luma = rgb
            .chunks_exact(3)
            .map(|p| 0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64)
            .sum::<f64>()
            / (w * h) as f64;
        let mut last = ivars.last_luma.lock().unwrap();
        log(&format!(
            "WEBCAM frame {n} at {:.0} ms, {w}x{h}, mean luma {luma:.1}",
            ivars.started.elapsed().as_secs_f64() * 1000.0
        ));
        let settled = n >= 3 && last.is_some_and(|prev| (luma - prev).abs() < 2.0);
        *last = Some(luma);
        if settled || n >= 30 {
            if let Some(tx) = ivars.tx.lock().unwrap().take() {
                let _ = tx.send((w, h, rgb, n));
            }
        }
    }
}

fn capture_webcam(dir: &Path) -> Option<usize> {
    let t0 = Instant::now();
    let video = unsafe { AVMediaTypeVideo }?;
    let Some(device) = (unsafe { AVCaptureDevice::defaultDeviceWithMediaType(video) }) else {
        log("WEBCAM skipped: no camera (CAP-08 reason: no_camera)");
        return None;
    };
    let busy = unsafe { device.isInUseByAnotherApplication() };
    let input = match unsafe { AVCaptureDeviceInput::deviceInputWithDevice_error(&device) } {
        Ok(input) => input,
        Err(e) => {
            log(&format!(
                "WEBCAM open failed (busy elsewhere={busy}): {}",
                e.localizedDescription()
            ));
            return None;
        }
    };
    let session = unsafe { AVCaptureSession::new() };
    let output = unsafe { AVCaptureVideoDataOutput::new() };
    let (tx, rx) = mpsc::channel();
    let grabber = FrameGrabber::new(tx);
    let queue = DispatchQueue::new("ai-proctor.spike.camera", None);
    unsafe {
        session.beginConfiguration();
        session.setSessionPreset(AVCaptureSessionPreset320x240);
        session.addInput(&input);
        // Ask for BGRA so frames copy straight into RGB.
        let key: &NSString =
            &*(kCVPixelBufferPixelFormatTypeKey as *const CFString as *const NSString);
        let format = NSNumber::new_u32(kCVPixelFormatType_32BGRA);
        let settings =
            NSDictionary::<NSString, AnyObject>::from_slices(&[key], &[&*format as &AnyObject]);
        output.setVideoSettings(Some(&settings));
        output.setAlwaysDiscardsLateVideoFrames(true);
        output
            .setSampleBufferDelegate_queue(Some(ProtocolObject::from_ref(&*grabber)), Some(&queue));
        session.addOutput(&output);
        session.commitConfiguration();
        session.startRunning();
    }
    let opened_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let frame = rx.recv_timeout(Duration::from_secs(5));
    unsafe { session.stopRunning() };
    let camera_on_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let Ok((w, h, rgb, frame_no)) = frame else {
        log(&format!(
            "WEBCAM no frame within 5 s (busy elsewhere={busy})"
        ));
        return None;
    };

    let t1 = Instant::now();
    let webp = webp::Encoder::from_rgb(&rgb, w, h).encode(WEBCAM_QUALITY);
    let encode_ms = t1.elapsed().as_secs_f64() * 1000.0;
    let _ = std::fs::write(dir.join("webcam.webp"), &*webp);
    log(&format!(
        "WEBCAM: busy elsewhere={busy}, session started in {opened_ms:.0} ms, used frame {frame_no}, camera on for {camera_on_ms:.0} ms (target < 1000), {w}x{h} WebP q{WEBCAM_QUALITY} {} bytes ({:.1} KB, target <= 20 KB) in {encode_ms:.0} ms",
        webp.len(),
        webp.len() as f64 / 1024.0
    ));
    Some(webp.len())
}
