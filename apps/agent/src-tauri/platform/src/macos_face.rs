//! CAP-07 face presence on macOS: Vision's `VNDetectFaceRectanglesRequest` on the
//! webcam frame. Detection only: the request finds face rectangles, never landmarks
//! or anything that could tell one person from another, and the only thing kept from
//! it is whether it found at least one. The rectangles are dropped with the request.
//!
//! There is no objc2 crate for Vision in the dependency tree, so this sends the few
//! messages it needs through the objc2 runtime (the classes have been in Vision since
//! macOS 10.13) instead of adding one.

use std::ptr;

use agent_core::platform::Frame;
use objc2::msg_send;
use objc2::rc::{autoreleasepool, Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject};
use objc2_core_foundation::{CFData, CFRetained};
use objc2_core_graphics::{
    CGBitmapInfo, CGColorRenderingIntent, CGColorSpace, CGDataProvider, CGImage, CGImageAlphaInfo,
};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSString};

// The Vision classes are looked up by name at run time; this links the framework so
// they are there to find.
#[link(name = "Vision", kind = "framework")]
extern "C" {}

/// Whether Vision finds a face in the frame; `None` when it couldn't look (the frame
/// is malformed, the classes are missing or the request failed).
pub fn detect_face(frame: &Frame) -> Option<bool> {
    let image = cg_image(frame)?;
    autoreleasepool(|_| {
        let request_class = AnyClass::get(c"VNDetectFaceRectanglesRequest")?;
        let handler_class = AnyClass::get(c"VNImageRequestHandler")?;
        let options = NSDictionary::<NSString, AnyObject>::new();
        // SAFETY: both classes are Vision's; the selectors and argument types are
        // those of their documented initialisers and methods (`init`,
        // `initWithCGImage:options:`, `performRequests:error:`, `results`).
        unsafe {
            let request: Retained<AnyObject> = msg_send![request_class, new];
            let handler: Allocated<AnyObject> = msg_send![handler_class, alloc];
            let handler: Option<Retained<AnyObject>> =
                msg_send![handler, initWithCGImage: &*image, options: &*options];
            let handler = handler?;
            let requests = NSArray::from_retained_slice(std::slice::from_ref(&request));
            let performed: Result<(), Retained<NSError>> =
                msg_send![&handler, performRequests: &*requests, error: _];
            if let Err(error) = performed {
                tracing::warn!(error = %error.localizedDescription(), "face detection failed");
                return None;
            }
            let results: Option<Retained<NSArray<AnyObject>>> = msg_send![&request, results];
            Some(results.is_some_and(|r| r.count() > 0))
        }
    })
}

/// The frame's RGBA pixels as a CGImage (alpha ignored), for Vision.
fn cg_image(frame: &Frame) -> Option<CFRetained<CGImage>> {
    let (width, height) = (frame.width as usize, frame.height as usize);
    if width == 0 || height == 0 || frame.rgba.len() != width * height * 4 {
        return None;
    }
    let data = CFData::from_bytes(&frame.rgba);
    let provider = CGDataProvider::with_cf_data(Some(&data))?;
    let space = CGColorSpace::new_device_rgb()?;
    // SAFETY: the provider holds width * height * 4 bytes, 8-bit RGBX rows with no
    // padding, as described; `decode` may be null.
    unsafe {
        CGImage::new(
            width,
            height,
            8,
            32,
            width * 4,
            Some(&space),
            CGBitmapInfo(CGImageAlphaInfo::NoneSkipLast.0),
            Some(&provider),
            ptr::null(),
            false,
            CGColorRenderingIntent::RenderingIntentDefault,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(width: u32, height: u32, rgba: Vec<u8>) -> Frame {
        Frame {
            display: None,
            width,
            height,
            rgba,
        }
    }

    #[test]
    fn vision_runs_and_finds_no_face_in_a_plain_frame() {
        let plain = frame(320, 240, [128, 120, 110, 255].repeat(320 * 240));
        assert_eq!(detect_face(&plain), Some(false));
    }

    #[test]
    fn a_malformed_frame_is_not_looked_at() {
        assert_eq!(detect_face(&frame(320, 240, vec![0; 10])), None);
        assert_eq!(detect_face(&frame(0, 0, Vec::new())), None);
    }
}
