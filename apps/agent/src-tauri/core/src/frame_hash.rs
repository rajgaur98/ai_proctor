//! Duplicate webcam frames (ANT-06, #63): a perceptual hash of each passed check-in's
//! webcam frame, compared with the hashes of the last few passes, so a still image or
//! a replayed frame fed to the camera shows up as "needs review".
//!
//! Where the comparison lives: here, on the device, before the check-in is queued.
//! * Nothing new leaves the device. The server gets the flag and the distance
//!   (`duplicate_frame:2`), never a hash; the frame itself goes up exactly as before,
//!   and is deleted with the other captures by retention. A hash kept on the server
//!   would outlive the image it was made from.
//! * The hashes stay in the outbox's encrypted state (`Outbox::set_state`), at most
//!   `HISTORY_LEN` of them and none older than `HISTORY_MAX_AGE`.
//! * It works offline, like the rest of the check-in: the flag is on the event before
//!   it is queued, as the injected-click count is.
//!
//! The cost is that only this device's earlier frames are compared, which is the
//! case that matters (a looped feed on the machine doing the check-ins).
//!
//! The hash is a 256-bit difference hash: the frame in grey, shrunk to 17 × 16, one
//! bit per pair of neighbours (is the right one brighter). It keeps the rough layout
//! of light and dark and nothing else: no face can be told from it, and the image
//! can't be rebuilt from it. Two captures of a real camera differ by noise, light and
//! movement; a frame fed in again comes out (almost) bit for bit the same.

use std::collections::VecDeque;

use chrono::{DateTime, Duration, Utc};
use image::imageops::{self, FilterType};
use image::RgbaImage;
use serde::{Deserialize, Serialize};

use crate::anticheat::DUPLICATE_FRAME_FLAG;

/// The grid: 17 columns give 16 comparisons per row, 16 rows.
const GRID_W: u32 = 17;
const GRID_H: u32 = 16;
pub const HASH_BITS: u32 = 256;
/// At most this many of the 256 bits may differ for two frames to count as the same.
/// Deliberately tight (about 1 %): it is meant for a frame fed in again, not for
/// someone who sits very still, and the reviewer sees both images.
pub const DUPLICATE_MAX_DISTANCE: u32 = 3;
/// Frames whose grey grid varies less than this (standard deviation, 0–255) say
/// nothing: a covered or dark camera, or a blank feed. They're neither hashed nor kept.
pub const MIN_CONTRAST: f64 = 6.0;
/// Passes remembered: about two working days of check-ins.
pub const HISTORY_LEN: usize = 20;
pub const HISTORY_MAX_AGE: Duration = Duration::days(14);
/// The outbox state key the history is kept under.
pub const STATE_KEY: &str = "webcam_hashes";

/// A 256-bit difference hash of one webcam frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameHash(pub [u64; 4]);

impl FrameHash {
    /// The hash of a frame; `None` for one too flat to say anything (`MIN_CONTRAST`).
    pub fn of(image: &RgbaImage) -> Option<Self> {
        if image.width() == 0 || image.height() == 0 {
            return None;
        }
        let grey = imageops::grayscale(image);
        let small = imageops::resize(&grey, GRID_W, GRID_H, FilterType::Triangle);
        let values: Vec<f64> = small.pixels().map(|p| f64::from(p.0[0])).collect();
        let mean = values.iter().sum::<f64>() / values.len() as f64;
        let var = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64;
        if var.sqrt() < MIN_CONTRAST {
            return None;
        }
        let mut bits = [0u64; 4];
        let mut i = 0usize;
        for y in 0..GRID_H {
            for x in 0..GRID_W - 1 {
                let (left, right) = (small.get_pixel(x, y).0[0], small.get_pixel(x + 1, y).0[0]);
                if right > left {
                    bits[i / 64] |= 1 << (i % 64);
                }
                i += 1;
            }
        }
        Some(Self(bits))
    }

    /// How many of the 256 bits differ.
    pub fn distance(&self, other: &Self) -> u32 {
        self.0
            .iter()
            .zip(other.0.iter())
            .map(|(a, b)| (a ^ b).count_ones())
            .sum()
    }

    fn to_hex(self) -> String {
        self.0.iter().map(|w| format!("{w:016x}")).collect()
    }

    fn from_hex(text: &str) -> Option<Self> {
        if text.len() != 64 || !text.is_ascii() {
            return None;
        }
        let mut words = [0u64; 4];
        for (i, word) in words.iter_mut().enumerate() {
            *word = u64::from_str_radix(&text[i * 16..(i + 1) * 16], 16).ok()?;
        }
        Some(Self(words))
    }
}

#[derive(Serialize, Deserialize)]
struct Stored {
    at: DateTime<Utc>,
    hash: String,
}

/// The hashes of the last passes on this device, oldest first.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FrameHistory {
    entries: VecDeque<(DateTime<Utc>, FrameHash)>,
}

impl FrameHistory {
    /// From the outbox state; anything unreadable starts an empty history.
    pub fn parse(state: Option<&str>) -> Self {
        let stored: Vec<Stored> = state
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        Self {
            entries: stored
                .into_iter()
                .filter_map(|s| Some((s.at, FrameHash::from_hex(&s.hash)?)))
                .collect(),
        }
    }

    /// For the outbox state.
    pub fn serialize(&self) -> String {
        let stored: Vec<Stored> = self
            .entries
            .iter()
            .map(|(at, h)| Stored {
                at: *at,
                hash: h.to_hex(),
            })
            .collect();
        serde_json::to_string(&stored).unwrap_or_else(|_| "[]".into())
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Compares a new pass's frame with the remembered ones, then remembers it. Returns
    /// the smallest distance when it is within `DUPLICATE_MAX_DISTANCE` of one of them.
    pub fn check(&mut self, hash: FrameHash, now: DateTime<Utc>) -> Option<u32> {
        self.entries
            .retain(|(at, _)| *at <= now && now - *at <= HISTORY_MAX_AGE);
        let nearest = self.entries.iter().map(|(_, h)| h.distance(&hash)).min();
        self.entries.push_back((now, hash));
        while self.entries.len() > HISTORY_LEN {
            self.entries.pop_front();
        }
        nearest.filter(|d| *d <= DUPLICATE_MAX_DISTANCE)
    }
}

/// The check-in flag for a duplicate frame (`duplicate_frame:2`).
pub fn duplicate_flag(distance: u32) -> String {
    format!("{DUPLICATE_FRAME_FLAG}:{}", distance.min(HASH_BITS))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    /// A 320 × 240 "scene": a gradient with a darker blob at (cx, cy), plus noise.
    fn scene(cx: i64, cy: i64, seed: u64) -> RgbaImage {
        let mut rng = fastrand::Rng::with_seed(seed);
        RgbaImage::from_fn(320, 240, |x, y| {
            let (dx, dy) = (x as i64 - cx, y as i64 - cy);
            let blob = if dx * dx + dy * dy < 50 * 50 { 90 } else { 0 };
            let base = 60 + (x * 120 / 320) as i64 + (y * 40 / 240) as i64 - blob;
            let v = (base + rng.i64(-6..=6)).clamp(0, 255) as u8;
            image::Rgba([v, v, v, 255])
        })
    }

    #[test]
    fn the_same_frame_hashes_the_same() {
        let a = FrameHash::of(&scene(160, 120, 1)).unwrap();
        let b = FrameHash::of(&scene(160, 120, 1)).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.distance(&b), 0);
    }

    #[test]
    fn a_refed_frame_with_fresh_noise_is_still_near_identical() {
        let a = FrameHash::of(&scene(160, 120, 1)).unwrap();
        let b = FrameHash::of(&scene(160, 120, 2)).unwrap();
        assert!(
            a.distance(&b) <= DUPLICATE_MAX_DISTANCE,
            "{}",
            a.distance(&b)
        );
    }

    #[test]
    fn a_moved_subject_is_far_apart() {
        let a = FrameHash::of(&scene(160, 120, 1)).unwrap();
        let b = FrameHash::of(&scene(100, 140, 1)).unwrap();
        assert!(
            a.distance(&b) > DUPLICATE_MAX_DISTANCE * 3,
            "{}",
            a.distance(&b)
        );
    }

    #[test]
    fn a_flat_frame_says_nothing() {
        let black = RgbaImage::from_pixel(320, 240, image::Rgba([3, 3, 3, 255]));
        assert_eq!(FrameHash::of(&black), None);
        assert_eq!(FrameHash::of(&RgbaImage::new(0, 0)), None);
    }

    #[test]
    fn history_flags_a_repeat_and_round_trips() {
        let mut history = FrameHistory::default();
        let first = FrameHash::of(&scene(160, 120, 1)).unwrap();
        let other = FrameHash::of(&scene(90, 60, 3)).unwrap();
        assert_eq!(history.check(first, t("2026-10-20T10:00:00Z")), None);
        assert_eq!(history.check(other, t("2026-10-20T10:40:00Z")), None);
        assert_eq!(history.check(first, t("2026-10-20T11:30:00Z")), Some(0));

        let reread = FrameHistory::parse(Some(&history.serialize()));
        assert_eq!(reread, history);
        assert_eq!(reread.len(), 3);
    }

    #[test]
    fn old_and_excess_hashes_are_forgotten() {
        let mut history = FrameHistory::default();
        let repeat = FrameHash::of(&scene(160, 120, 1)).unwrap();
        history.check(repeat, t("2026-10-01T10:00:00Z"));
        // Fifteen days later the old frame is gone: no flag.
        assert_eq!(history.check(repeat, t("2026-10-16T10:00:00Z")), None);
        assert_eq!(history.len(), 1);

        let mut history = FrameHistory::default();
        for i in 0..(HISTORY_LEN as u64 + 5) {
            let h = FrameHash([i, !i, i << 7, i.rotate_left(13)]);
            history.check(h, t("2026-10-20T10:00:00Z") + Duration::minutes(i as i64));
        }
        assert_eq!(history.len(), HISTORY_LEN);
    }

    #[test]
    fn unreadable_state_starts_empty() {
        assert!(FrameHistory::parse(None).is_empty());
        assert!(FrameHistory::parse(Some("not json")).is_empty());
        assert!(
            FrameHistory::parse(Some(r#"[{"at":"2026-10-20T10:00:00Z","hash":"zz"}]"#)).is_empty()
        );
    }

    #[test]
    fn the_flag_carries_the_distance() {
        assert_eq!(duplicate_flag(2), "duplicate_frame:2");
        assert_eq!(duplicate_flag(999), "duplicate_frame:256");
    }
}
