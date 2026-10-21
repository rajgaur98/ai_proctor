//! Captures after a passed check-in (#21; CAP-01..06, CAP-08).
//!
//! The platform returns raw pixels; everything after that happens here, on the
//! device: excluded apps are replaced with a placeholder, blur is applied when the
//! org asks for it, and frames are downscaled and encoded as WebP. A failure never
//! fails the check-in: it is recorded as the reason instead.

use image::imageops::{self, FilterType};
use image::RgbaImage;
use serde_json::{json, Value};

use crate::anticheat::{is_virtual_camera, virtual_camera_flag};
use crate::frame_hash::FrameHash;
use crate::platform::{CaptureError, Frame, Platform};

/// CAP-06: screenshots at most 1280 px wide, the webcam at 320 × 240, WebP ~q60.
pub const SCREEN_MAX_WIDTH: u32 = 1280;
pub const WEBCAM_WIDTH: u32 = 320;
pub const WEBCAM_HEIGHT: u32 = 240;
pub const WEBP_QUALITY: f32 = 60.0;

/// CAP-04 defaults: common password managers.
pub const DEFAULT_EXCLUDED_APPS: &[&str] = &[
    "1Password",
    "Bitwarden",
    "Dashlane",
    "LastPass",
    "KeePassXC",
    "Keeper",
    "NordPass",
    "Enpass",
    "Keychain Access",
    "Passwords",
];

/// CAP-02: org screenshot policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScreenshotMode {
    Full,
    Blurred,
    Off,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CapturePolicy {
    pub screenshots: ScreenshotMode,
    /// CAP-05: org webcam policy.
    pub webcam: bool,
    /// App names (case-insensitive) whose screen is never captured.
    pub excluded_apps: Vec<String>,
}

impl Default for CapturePolicy {
    fn default() -> Self {
        Self {
            screenshots: ScreenshotMode::Full,
            webcam: true,
            excluded_apps: default_excluded_apps(),
        }
    }
}

impl CapturePolicy {
    /// Nothing is captured: what someone who has acknowledged no notice may collect
    /// (AGT-04), and what a signed-out device runs with.
    pub fn off() -> Self {
        Self {
            screenshots: ScreenshotMode::Off,
            webcam: false,
            ..Self::default()
        }
    }
}

/// CAP-04: the built-in list, used only when the server's config has none.
pub fn default_excluded_apps() -> Vec<String> {
    DEFAULT_EXCLUDED_APPS
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// What a capture produced: files to upload, and why anything is missing.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Captured {
    /// (object name, WebP bytes); names match the `object_keys` contract.
    pub files: Vec<(String, Vec<u8>)>,
    pub screen_error: Option<CaptureError>,
    pub webcam_error: Option<CaptureError>,
    pub flags: Vec<String>,
    /// ANT-06: the webcam frame's perceptual hash, for the duplicate check; never
    /// uploaded (`frame_hash`). `None` without a frame or for a flat one.
    pub webcam_hash: Option<FrameHash>,
}

impl Captured {
    /// Adds the object names, failure reasons and flags to a `checkin` payload.
    pub fn attach(&self, payload: &mut Value) {
        payload["object_keys"] = json!(self.files.iter().map(|(n, _)| n).collect::<Vec<_>>());
        let mut errors = serde_json::Map::new();
        if let Some(e) = &self.screen_error {
            errors.insert("screen".into(), json!(failure(e)));
        }
        if let Some(e) = &self.webcam_error {
            errors.insert("webcam".into(), json!(failure(e)));
        }
        if !errors.is_empty() {
            payload["capture_errors"] = Value::Object(errors);
        }
        if let Some(flags) = payload["flags"].as_array_mut() {
            flags.extend(self.flags.iter().map(|f| json!(f)));
        }
    }
}

/// The contract's `CaptureFailure` value for an error.
pub fn failure(error: &CaptureError) -> &'static str {
    match error {
        CaptureError::PermissionMissing => "permission_missing",
        CaptureError::CameraBusy => "camera_busy",
        CaptureError::NoCamera => "no_camera",
        CaptureError::Unsupported | CaptureError::Failed(_) => "failed",
    }
}

/// Screenshots and the webcam frame, taken in parallel (camera warm-up is the slow
/// part, ~1.5 s on a MacBook, spike #13).
pub fn capture(platform: &dyn Platform, policy: &CapturePolicy) -> Captured {
    let excluded = excluded_screens(platform, policy);
    let (screens, webcam) = std::thread::scope(|scope| {
        let webcam = scope.spawn(|| {
            policy
                .webcam
                .then(|| platform.capture_webcam(WEBCAM_WIDTH, WEBCAM_HEIGHT))
        });
        let screens = match policy.screenshots {
            ScreenshotMode::Off => None,
            _ => Some(platform.capture_screens(SCREEN_MAX_WIDTH)),
        };
        (screens, webcam.join().unwrap_or(None))
    });

    let mut captured = Captured::default();
    match screens {
        None => {}
        Some(Err(e)) => captured.screen_error = Some(e),
        Some(Ok(frames)) => {
            if !matches!(excluded, Excluded::No) {
                captured.flags.push("excluded_app".into());
            }
            for (i, frame) in frames.into_iter().enumerate() {
                let display = frame.display.unwrap_or(i as u32 + 1);
                let blank = excluded.covers(display);
                let image = match to_image(frame, SCREEN_MAX_WIDTH) {
                    Some(image) if blank => placeholder(image.width(), image.height()),
                    Some(image) if policy.screenshots == ScreenshotMode::Blurred => blur(&image),
                    Some(image) => image,
                    None => {
                        captured.screen_error = Some(CaptureError::Failed("bad frame".into()));
                        continue;
                    }
                };
                captured
                    .files
                    .push((format!("screen-{display}.webp"), encode(&image)));
            }
        }
    }
    match webcam {
        None => {}
        Some(Err(e)) => captured.webcam_error = Some(e),
        Some(Ok(frame)) => match to_image(frame, WEBCAM_WIDTH) {
            Some(image) => {
                captured.webcam_hash = FrameHash::of(&image);
                captured.files.push(("webcam.webp".into(), encode(&image)));
                // ANT-05: the frame came from a known virtual camera. Only asked once
                // there is a frame, so a missing or busy camera says nothing.
                if let Some(device) = platform.camera_device().filter(is_virtual_camera) {
                    captured.flags.push(virtual_camera_flag(&device));
                }
            }
            None => captured.webcam_error = Some(CaptureError::Failed("bad frame".into())),
        },
    }
    captured
}

/// Which screens an excluded app is on (CAP-04).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Excluded {
    /// No excluded app in front.
    No,
    /// An excluded app is in front and its display is unknown: every screen is
    /// replaced (privacy first).
    AllScreens,
    /// An excluded app is in front on this display (1-based): only it is replaced.
    Display(u32),
}

impl Excluded {
    fn covers(self, display: u32) -> bool {
        match self {
            Excluded::No => false,
            Excluded::AllScreens => true,
            Excluded::Display(n) => n == display,
        }
    }
}

fn excluded_screens(platform: &dyn Platform, policy: &CapturePolicy) -> Excluded {
    let Some(fg) = platform.foreground() else {
        return Excluded::No;
    };
    if !policy
        .excluded_apps
        .iter()
        .any(|app| app.eq_ignore_ascii_case(&fg.app))
    {
        return Excluded::No;
    }
    fg.display.map_or(Excluded::AllScreens, Excluded::Display)
}

/// RGBA pixels as an image, downscaled to `max_width` if the platform sent more.
fn to_image(frame: Frame, max_width: u32) -> Option<RgbaImage> {
    let image = RgbaImage::from_raw(frame.width, frame.height, frame.rgba)?;
    if image.width() <= max_width {
        return Some(image);
    }
    let height = (image.height() as u64 * max_width as u64 / image.width() as u64).max(1) as u32;
    Some(imageops::resize(
        &image,
        max_width,
        height,
        FilterType::Triangle,
    ))
}

/// CAP-02 "Blurred": strong enough that text can't be read, cheap enough for the
/// < 10 % CPU budget: shrink 24×, then scale back up.
fn blur(image: &RgbaImage) -> RgbaImage {
    let (w, h) = image.dimensions();
    let small = imageops::resize(
        image,
        (w / 24).max(1),
        (h / 24).max(1),
        FilterType::Triangle,
    );
    imageops::resize(&small, w, h, FilterType::Triangle)
}

/// CAP-04: a plain grey frame in place of a screen showing an excluded app.
fn placeholder(width: u32, height: u32) -> RgbaImage {
    RgbaImage::from_pixel(width, height, image::Rgba([0x9a, 0x9c, 0xa0, 0xff]))
}

fn encode(image: &RgbaImage) -> Vec<u8> {
    webp::Encoder::from_rgba(image.as_raw(), image.width(), image.height())
        .encode(WEBP_QUALITY)
        .to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::PermissionState;
    use crate::fake::FakePlatform;
    use crate::platform::Foreground;

    fn names(c: &Captured) -> Vec<&str> {
        c.files.iter().map(|(n, _)| n.as_str()).collect()
    }

    fn file<'a>(c: &'a Captured, name: &str) -> &'a [u8] {
        &c.files.iter().find(|(n, _)| n == name).unwrap().1
    }

    #[test]
    fn one_screenshot_per_display_and_a_webcam_frame_within_size_targets() {
        let fake = FakePlatform::default();
        fake.update(|s| s.displays = 2);
        let c = capture(&fake, &CapturePolicy::default());
        assert_eq!(names(&c), ["screen-1.webp", "screen-2.webp", "webcam.webp"]);
        assert!(
            file(&c, "screen-1.webp").len() <= 150 * 1024,
            "{}",
            file(&c, "screen-1.webp").len()
        );
        assert!(file(&c, "webcam.webp").len() <= 20 * 1024);
        assert_eq!(&file(&c, "webcam.webp")[..4], b"RIFF");
        assert_eq!(
            (c.screen_error.as_ref(), c.webcam_error.as_ref()),
            (None, None)
        );
    }

    #[test]
    fn policy_off_captures_nothing() {
        let fake = FakePlatform::default();
        let policy = CapturePolicy {
            screenshots: ScreenshotMode::Off,
            webcam: false,
            ..CapturePolicy::default()
        };
        assert_eq!(capture(&fake, &policy), Captured::default());
    }

    #[test]
    fn blurred_screens_lose_their_detail() {
        let fake = FakePlatform::default();
        let full = capture(&fake, &CapturePolicy::default());
        let blurred = capture(
            &fake,
            &CapturePolicy {
                screenshots: ScreenshotMode::Blurred,
                ..CapturePolicy::default()
            },
        );
        let (full, blurred) = (
            file(&full, "screen-1.webp"),
            file(&blurred, "screen-1.webp"),
        );
        assert!(
            blurred.len() * 3 < full.len(),
            "blur {} vs full {}",
            blurred.len(),
            full.len()
        );
    }

    #[test]
    fn an_excluded_app_in_front_replaces_the_screens() {
        let fake = FakePlatform::default();
        fake.update(|s| {
            s.foreground = Some(Foreground {
                app: "1password".into(),
                title: None,
                domain: None,
                display: None,
            })
        });
        let c = capture(&fake, &CapturePolicy::default());
        assert_eq!(c.flags, ["excluded_app"]);
        let grey = encode(&placeholder(1280, 800));
        assert_eq!(file(&c, "screen-1.webp"), grey.as_slice());
        assert!(
            names(&c).contains(&"webcam.webp"),
            "the webcam is unaffected"
        );
    }

    fn two_displays_with_1password_on(display: Option<u32>) -> Captured {
        let fake = FakePlatform::default();
        fake.update(|s| {
            s.displays = 2;
            s.foreground = Some(Foreground {
                app: "1Password".into(),
                title: None,
                domain: None,
                display,
            })
        });
        capture(&fake, &CapturePolicy::default())
    }

    #[test]
    fn an_excluded_app_replaces_only_the_screen_it_is_on() {
        let grey = encode(&placeholder(1280, 800));
        for (on, other) in [(1, 2), (2, 1)] {
            let c = two_displays_with_1password_on(Some(on));
            assert_eq!(c.flags, ["excluded_app"]);
            assert_eq!(file(&c, &format!("screen-{on}.webp")), grey.as_slice());
            assert_ne!(
                file(&c, &format!("screen-{other}.webp")),
                grey.as_slice(),
                "display {other} is captured normally"
            );
        }
    }

    #[test]
    fn an_excluded_app_on_an_unknown_display_replaces_every_screen() {
        let c = two_displays_with_1password_on(None);
        let grey = encode(&placeholder(1280, 800));
        assert_eq!(c.flags, ["excluded_app"]);
        assert_eq!(file(&c, "screen-1.webp"), grey.as_slice());
        assert_eq!(file(&c, "screen-2.webp"), grey.as_slice());
    }

    #[test]
    fn an_ordinary_app_leaves_every_screen_alone() {
        let fake = FakePlatform::default();
        fake.update(|s| {
            s.displays = 2;
            s.foreground = Some(Foreground {
                app: "Safari".into(),
                title: None,
                domain: None,
                display: Some(1),
            })
        });
        let c = capture(&fake, &CapturePolicy::default());
        let grey = encode(&placeholder(1280, 800));
        assert!(c.flags.is_empty());
        assert_ne!(file(&c, "screen-1.webp"), grey.as_slice());
        assert_ne!(file(&c, "screen-2.webp"), grey.as_slice());
    }

    #[test]
    fn failures_are_recorded_and_the_rest_still_captured() {
        let fake = FakePlatform::default();
        fake.update(|s| {
            s.permissions.screen = PermissionState::Denied;
            s.camera = Err(CaptureError::NoCamera);
        });
        let c = capture(&fake, &CapturePolicy::default());
        assert!(c.files.is_empty());
        let mut payload = json!({ "object_keys": [], "flags": [] });
        c.attach(&mut payload);
        assert_eq!(
            payload["capture_errors"],
            json!({ "screen": "permission_missing", "webcam": "no_camera" })
        );

        fake.update(|s| s.permissions.screen = PermissionState::Granted);
        let c = capture(&fake, &CapturePolicy::default());
        let mut payload = json!({ "object_keys": [], "flags": [] });
        c.attach(&mut payload);
        assert_eq!(payload["object_keys"], json!(["screen-1.webp"]));
        assert_eq!(payload["capture_errors"], json!({ "webcam": "no_camera" }));
    }

    #[test]
    fn a_virtual_camera_is_flagged_by_name_and_the_frame_kept() {
        use crate::platform::CameraDevice;
        let fake = FakePlatform::default();
        fake.update(|s| {
            s.camera_device = Some(CameraDevice {
                name: "OBS Virtual Camera".into(),
                model: None,
            })
        });
        let c = capture(&fake, &CapturePolicy::default());
        assert_eq!(c.flags, ["virtual_camera:OBS Virtual Camera"]);
        assert!(names(&c).contains(&"webcam.webp"));

        // A real camera, no camera, or the webcam off: no flag.
        fake.update(|s| {
            s.camera_device = Some(CameraDevice {
                name: "FaceTime HD Camera".into(),
                model: None,
            })
        });
        assert!(capture(&fake, &CapturePolicy::default()).flags.is_empty());
        fake.update(|s| {
            s.camera_device = Some(CameraDevice {
                name: "OBS Virtual Camera".into(),
                model: None,
            });
            s.camera = Err(CaptureError::NoCamera);
        });
        assert!(capture(&fake, &CapturePolicy::default()).flags.is_empty());
        fake.update(|s| s.camera = Ok(()));
        let off = CapturePolicy {
            webcam: false,
            ..CapturePolicy::default()
        };
        assert!(capture(&fake, &off).flags.is_empty());
    }

    #[test]
    fn the_webcam_frame_is_hashed_and_a_repeated_scene_hashes_the_same() {
        let fake = FakePlatform::default();
        let first = capture(&fake, &CapturePolicy::default())
            .webcam_hash
            .unwrap();
        let second = capture(&fake, &CapturePolicy::default())
            .webcam_hash
            .unwrap();
        assert!(
            first.distance(&second) > 20,
            "a real camera's frames differ"
        );
        fake.update(|s| s.webcam_scene = Some(7));
        let a = capture(&fake, &CapturePolicy::default())
            .webcam_hash
            .unwrap();
        let b = capture(&fake, &CapturePolicy::default())
            .webcam_hash
            .unwrap();
        assert_eq!(a.distance(&b), 0);
        let off = CapturePolicy {
            webcam: false,
            ..CapturePolicy::default()
        };
        assert_eq!(capture(&fake, &off).webcam_hash, None);
    }

    #[test]
    fn oversized_frames_are_downscaled() {
        let frame = Frame {
            display: Some(1),
            width: 2560,
            height: 1600,
            rgba: vec![128; 2560 * 1600 * 4],
        };
        let image = to_image(frame, SCREEN_MAX_WIDTH).unwrap();
        assert_eq!(image.dimensions(), (1280, 800));
    }
}
