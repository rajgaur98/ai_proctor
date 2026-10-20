//! One webcam frame through a Media Foundation source reader (CAP-01, CAP-06). The
//! reader's video processor converts whatever the camera sends to RGB32; warm-up
//! frames are skipped with the same rule as macOS (lit and steady), then the frame
//! is scaled to the requested width. Privacy-setting and busy-camera errors come
//! back as `PermissionMissing` / `CameraBusy` (`agent_core::camera_privacy`).

use std::time::{Duration, Instant};

use agent_core::camera_privacy::webcam_error;
use agent_core::pixels::{
    bgra_to_rgba_scaled, fit_width, flip_rows, mean_luma_bgra, webcam_frame_ready,
};
use agent_core::platform::{CaptureError, Frame};
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFAttributes, IMFMediaSource, IMFSourceReader, MFCreateAttributes,
    MFCreateMediaType, MFCreateSourceReaderFromMediaSource, MFEnumDeviceSources, MFMediaType_Video,
    MFShutdown, MFStartup, MFVideoFormat_RGB32, MFSTARTUP_FULL, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
    MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_SIZE,
    MF_MT_MAJOR_TYPE, MF_MT_SUBTYPE, MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING,
    MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_VERSION,
};
use windows::Win32::System::Com::CoTaskMemFree;

use super::com::Apartment;

/// Longest the camera may take to produce a frame at all.
const FRAME_BUDGET: Duration = Duration::from_secs(4);
/// After this long the next frame is taken even if the exposure is still moving
/// (macOS gives up after ~3 s of frames; slower cameras need a clock, not a count).
const SETTLE_BUDGET: Duration = Duration::from_secs(3);

fn failed(what: &str, error: windows::core::Error) -> CaptureError {
    match webcam_error(error.code().0) {
        CaptureError::Failed(_) => CaptureError::Failed(format!("{what}: {error}")),
        known => known,
    }
}

/// Media Foundation started for this thread's use; shut down on drop.
struct Foundation;

impl Foundation {
    fn start() -> Result<Self, CaptureError> {
        unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }
            .map_err(|e| failed("media foundation", e))?;
        Ok(Self)
    }
}

impl Drop for Foundation {
    fn drop(&mut self) {
        let _ = unsafe { MFShutdown() };
    }
}

/// The first video capture device, activated as a media source.
fn first_camera() -> Result<IMFMediaSource, CaptureError> {
    let mut attributes = None;
    unsafe { MFCreateAttributes(&mut attributes, 1) }.map_err(|e| failed("attributes", e))?;
    let attributes: IMFAttributes =
        attributes.ok_or_else(|| CaptureError::Failed("attributes: none created".into()))?;
    unsafe {
        attributes.SetGUID(
            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
            &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
        )
    }
    .map_err(|e| failed("attributes", e))?;

    let mut devices: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    unsafe { MFEnumDeviceSources(&attributes, &mut devices, &mut count) }
        .map_err(|e| failed("camera list", e))?;
    if devices.is_null() || count == 0 {
        return Err(CaptureError::NoCamera);
    }
    // Take the first device, then release the rest and the array itself.
    let list = unsafe { std::slice::from_raw_parts_mut(devices, count as usize) };
    let first = list[0].clone();
    for device in list.iter_mut() {
        drop(device.take());
    }
    unsafe { CoTaskMemFree(Some(devices as *const _)) };
    let first = first.ok_or(CaptureError::NoCamera)?;
    unsafe { first.ActivateObject::<IMFMediaSource>() }.map_err(|e| failed("camera open", e))
}

/// A reader that hands out RGB32 frames at the camera's own size.
fn reader_for(source: &IMFMediaSource) -> Result<IMFSourceReader, CaptureError> {
    let mut attributes = None;
    unsafe { MFCreateAttributes(&mut attributes, 1) }.map_err(|e| failed("attributes", e))?;
    let attributes: IMFAttributes =
        attributes.ok_or_else(|| CaptureError::Failed("attributes: none created".into()))?;
    unsafe { attributes.SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1) }
        .map_err(|e| failed("attributes", e))?;
    let reader = unsafe { MFCreateSourceReaderFromMediaSource(source, &attributes) }
        .map_err(|e| failed("camera reader", e))?;
    let wanted = unsafe { MFCreateMediaType() }.map_err(|e| failed("media type", e))?;
    unsafe {
        wanted
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .and_then(|_| wanted.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32))
            .map_err(|e| failed("media type", e))?;
        reader
            .SetCurrentMediaType(FIRST_VIDEO as u32, None, &wanted)
            .map_err(|e| failed("camera format", e))?;
    }
    Ok(reader)
}

const FIRST_VIDEO: i32 = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0;

/// Frame size and row stride of the format the reader settled on. A negative stride
/// means the rows run bottom-up, which is also what RGB32 without a stride means.
fn frame_layout(reader: &IMFSourceReader) -> Result<(usize, usize, usize, bool), CaptureError> {
    let kind = unsafe { reader.GetCurrentMediaType(FIRST_VIDEO as u32) }
        .map_err(|e| failed("camera format", e))?;
    let size =
        unsafe { kind.GetUINT64(&MF_MT_FRAME_SIZE) }.map_err(|e| failed("camera format", e))?;
    let (width, height) = ((size >> 32) as usize, (size & 0xFFFF_FFFF) as usize);
    let stride = unsafe { kind.GetUINT32(&MF_MT_DEFAULT_STRIDE) }
        .map(|s| s as i32)
        .ok();
    let (row, bottom_up) = match stride {
        Some(s) => (s.unsigned_abs() as usize, s < 0),
        None => (width * 4, true),
    };
    Ok((width, height, row, bottom_up))
}

/// The bytes of the sample's buffer.
fn sample_bytes(sample: &windows::Win32::Media::MediaFoundation::IMFSample) -> Option<Vec<u8>> {
    let buffer = unsafe { sample.ConvertToContiguousBuffer() }.ok()?;
    let mut data = std::ptr::null_mut();
    let mut len = 0u32;
    unsafe { buffer.Lock(&mut data, None, Some(&mut len)) }.ok()?;
    let bytes = if data.is_null() {
        None
    } else {
        Some(unsafe { std::slice::from_raw_parts(data, len as usize) }.to_vec())
    };
    let _ = unsafe { buffer.Unlock() };
    bytes
}

/// A settled frame at most `width` wide. Blocks up to `FRAME_BUDGET` with the camera
/// light on meanwhile.
pub fn capture(width: u32, _height: u32) -> Result<Frame, CaptureError> {
    let _com = Apartment::enter();
    let _mf = Foundation::start()?;
    let source = first_camera()?;
    let result = frames(&source, width);
    let _ = unsafe { source.Shutdown() };
    result
}

fn frames(source: &IMFMediaSource, width: u32) -> Result<Frame, CaptureError> {
    let reader = reader_for(source)?;
    let (w, h, stride, bottom_up) = frame_layout(&reader)?;
    let (out_w, out_h) = fit_width(w as u32, h as u32, width)
        .ok_or_else(|| CaptureError::Failed("camera reports no frame size".into()))?;
    let started = Instant::now();
    let mut previous = None;
    let mut n = 0u32;
    while started.elapsed() < FRAME_BUDGET {
        let mut sample = None;
        unsafe { reader.ReadSample(FIRST_VIDEO as u32, 0, None, None, None, Some(&mut sample)) }
            .map_err(|e| failed("camera frame", e))?;
        let Some(bytes) = sample.as_ref().and_then(sample_bytes) else {
            continue;
        };
        n += 1;
        let bytes = if bottom_up {
            flip_rows(&bytes, h, stride)
        } else {
            Some(bytes)
        };
        let Some(bytes) = bytes else {
            continue;
        };
        let Some(luma) = mean_luma_bgra(&bytes, w, h, stride) else {
            continue;
        };
        let ready = webcam_frame_ready(n, luma, previous) || started.elapsed() >= SETTLE_BUDGET;
        tracing::debug!(
            frame = n,
            width = w,
            height = h,
            luma,
            ready,
            "webcam frame"
        );
        previous = Some(luma);
        if !ready {
            continue;
        }
        let rgba = bgra_to_rgba_scaled(&bytes, w, h, stride, out_w as usize, out_h as usize)
            .ok_or_else(|| CaptureError::Failed("camera pixel buffer too short".into()))?;
        tracing::debug!(
            camera_on_ms = started.elapsed().as_millis() as u64,
            width = out_w,
            height = out_h,
            "webcam frame captured"
        );
        return Ok(Frame {
            display: None,
            width: out_w,
            height: out_h,
            rgba,
        });
    }
    Err(CaptureError::Failed("no webcam frame within 4 s".into()))
}
