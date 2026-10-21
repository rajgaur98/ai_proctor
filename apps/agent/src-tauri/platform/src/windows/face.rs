//! CAP-07 face presence on Windows: `Windows.Media.FaceAnalysis.FaceDetector` on the
//! webcam frame. Detection only: the detector returns face boxes, never landmarks or
//! anything that could tell one person from another, and the only thing kept is
//! whether it found at least one. The grey copy of the frame and the boxes are dropped
//! when this returns.

use agent_core::pixels::rgba_to_gray8;
use agent_core::platform::Frame;
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::FaceAnalysis::FaceDetector;
use windows::Storage::Streams::DataWriter;

use super::com::Apartment;

/// Whether the detector finds a face; `None` when it can't look (not supported on this
/// edition of Windows, the frame is malformed, or the detector failed).
pub fn detect(frame: &Frame) -> Option<bool> {
    let _com = Apartment::enter();
    match run(frame) {
        Ok(found) => found,
        Err(error) => {
            tracing::warn!(%error, "face detection failed");
            None
        }
    }
}

fn run(frame: &Frame) -> windows::core::Result<Option<bool>> {
    // Gray8 is what the detector takes on desktop Windows; check rather than assume.
    let format = BitmapPixelFormat::Gray8;
    if !FaceDetector::IsSupported()? || !FaceDetector::IsBitmapPixelFormatSupported(format)? {
        return Ok(None);
    }
    let (Some(gray), Ok(width), Ok(height)) = (
        rgba_to_gray8(&frame.rgba, frame.width, frame.height),
        i32::try_from(frame.width),
        i32::try_from(frame.height),
    ) else {
        return Ok(None);
    };
    let writer = DataWriter::new()?;
    writer.WriteBytes(&gray)?;
    let buffer = writer.DetachBuffer()?;
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(&buffer, format, width, height)?;
    let detector = FaceDetector::CreateAsync()?.join()?;
    let faces = detector.DetectFacesAsync(&bitmap)?.join()?;
    Ok(Some(faces.Size()? > 0))
}
