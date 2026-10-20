//! Pixel helpers for platforms that hand over BGRA surfaces (Windows: Desktop
//! Duplication, Media Foundation; #167). Pure, so the maths runs in CI on every OS;
//! the surface reads live in `agent-platform`.

/// A webcam frame is accepted once its mean luma reaches this (warm-up frames are
/// black) and is within `SETTLE_DELTA` of the previous frame.
pub const MIN_LUMA: f64 = 15.0;
pub const SETTLE_DELTA: f64 = 2.0;
/// Give up waiting for the exposure to settle after this many frames (~3 s).
pub const MAX_WEBCAM_FRAMES: u32 = 90;

/// Output size for a surface of `width` x `height`: at most `max_width` wide (never
/// upscaled), height proportional. `None` for an empty surface or `max_width` 0.
pub fn fit_width(width: u32, height: u32, max_width: u32) -> Option<(u32, u32)> {
    if width == 0 || height == 0 || max_width == 0 {
        return None;
    }
    let w = width.min(max_width);
    let h = ((height as u64 * w as u64 + width as u64 / 2) / width as u64).max(1) as u32;
    Some((w, h))
}

/// True if `bytes` holds `height` rows of `width` BGRA pixels `stride` bytes apart
/// (the last row needs no padding).
fn fits(bytes: &[u8], width: usize, height: usize, stride: usize) -> bool {
    let Some(row) = width.checked_mul(4) else {
        return false;
    };
    if width == 0 || height == 0 || stride < row {
        return false;
    }
    stride
        .checked_mul(height - 1)
        .and_then(|n| n.checked_add(row))
        .is_some_and(|need| bytes.len() >= need)
}

/// BGRA rows, `stride` bytes apart, as tightly packed RGBA scaled to `out_w` x
/// `out_h` with a box filter (every source pixel counts once, so text stays legible
/// and the work is one pass over the surface). Alpha becomes opaque: Desktop
/// Duplication and Media Foundation RGB32 leave it undefined. `None` if the buffer
/// is too short for the stated size or a dimension is 0.
pub fn bgra_to_rgba_scaled(
    bytes: &[u8],
    width: usize,
    height: usize,
    stride: usize,
    out_w: usize,
    out_h: usize,
) -> Option<Vec<u8>> {
    if !fits(bytes, width, height, stride) || out_w == 0 || out_h == 0 {
        return None;
    }
    let (out_w, out_h) = (out_w.min(width), out_h.min(height));
    let mut rgba = Vec::with_capacity(out_w * out_h * 4);
    for oy in 0..out_h {
        let y0 = oy * height / out_h;
        let y1 = ((oy + 1) * height / out_h).max(y0 + 1);
        for ox in 0..out_w {
            let x0 = ox * width / out_w;
            let x1 = ((ox + 1) * width / out_w).max(x0 + 1);
            let (mut b, mut g, mut r) = (0u32, 0u32, 0u32);
            for y in y0..y1 {
                let row = &bytes[y * stride + x0 * 4..y * stride + x1 * 4];
                for px in row.as_chunks::<4>().0 {
                    b += px[0] as u32;
                    g += px[1] as u32;
                    r += px[2] as u32;
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as u32;
            rgba.extend_from_slice(&[(r / n) as u8, (g / n) as u8, (b / n) as u8, 255]);
        }
    }
    Some(rgba)
}

/// Rotates tightly packed RGBA clockwise by `quarter_turns` x 90 degrees (any
/// integer), returning the new width, height and pixels.
pub fn rotate_rgba(
    rgba: Vec<u8>,
    width: usize,
    height: usize,
    quarter_turns: u32,
) -> (usize, usize, Vec<u8>) {
    let turns = quarter_turns % 4;
    if turns == 0 || rgba.len() != width * height * 4 {
        return (width, height, rgba);
    }
    let (out_w, out_h) = if turns == 2 {
        (width, height)
    } else {
        (height, width)
    };
    let mut out = vec![0u8; rgba.len()];
    for y in 0..height {
        for x in 0..width {
            // Where source pixel (x, y) lands after the turn.
            let (nx, ny) = match turns {
                1 => (height - 1 - y, x),
                2 => (width - 1 - x, height - 1 - y),
                _ => (y, width - 1 - x),
            };
            let from = (y * width + x) * 4;
            let to = (ny * out_w + nx) * 4;
            out[to..to + 4].copy_from_slice(&rgba[from..from + 4]);
        }
    }
    (out_w, out_h, out)
}

/// A screen surface as upright RGBA at most `max_width` wide, from BGRA rows
/// `stride` apart. Scales in the surface's own orientation first (cheaper) and turns
/// the small image upright after, so the width limit applies to what the person
/// sees; `quarter_turns` is the clockwise turn that makes the surface upright.
pub fn surface_to_upright_rgba(
    bytes: &[u8],
    width: usize,
    height: usize,
    stride: usize,
    quarter_turns: u32,
    max_width: u32,
) -> Option<(u32, u32, Vec<u8>)> {
    let sideways = quarter_turns % 2 == 1;
    let (seen_w, seen_h) = if sideways {
        (height, width)
    } else {
        (width, height)
    };
    let (out_w, out_h) = fit_width(seen_w as u32, seen_h as u32, max_width)?;
    let (surface_w, surface_h) = if sideways {
        (out_h as usize, out_w as usize)
    } else {
        (out_w as usize, out_h as usize)
    };
    let rgba = bgra_to_rgba_scaled(bytes, width, height, stride, surface_w, surface_h)?;
    let (w, h, rgba) = rotate_rgba(rgba, surface_w, surface_h, quarter_turns);
    Some((w as u32, h as u32, rgba))
}

/// The rows of a bottom-up surface (Media Foundation RGB32 has a negative stride) in
/// top-down order, tightly packed at `stride` bytes per row. `None` if the buffer is
/// shorter than `height` rows.
pub fn flip_rows(bytes: &[u8], height: usize, stride: usize) -> Option<Vec<u8>> {
    if stride == 0 || bytes.len() < stride.checked_mul(height)? {
        return None;
    }
    let mut flipped = Vec::with_capacity(stride * height);
    for row in bytes[..stride * height].chunks_exact(stride).rev() {
        flipped.extend_from_slice(row);
    }
    Some(flipped)
}

/// Mean Rec. 601 luma (0..255) of BGRA rows, ignoring row padding. Sampled on a
/// coarse grid (about 4k pixels): it only has to tell a black warm-up frame from a
/// lit one and notice the exposure still moving.
pub fn mean_luma_bgra(bytes: &[u8], width: usize, height: usize, stride: usize) -> Option<f64> {
    if width == 0 || height == 0 {
        return Some(0.0);
    }
    if !fits(bytes, width, height, stride) {
        return None;
    }
    let step = ((width * height / 4096) as f64).sqrt().ceil().max(1.0) as usize;
    let (mut sum, mut count) = (0.0, 0u64);
    for y in (0..height).step_by(step) {
        for x in (0..width).step_by(step) {
            let px = &bytes[y * stride + x * 4..y * stride + x * 4 + 4];
            sum += 0.299 * px[2] as f64 + 0.587 * px[1] as f64 + 0.114 * px[0] as f64;
            count += 1;
        }
    }
    Some(sum / count as f64)
}

/// Webcam settle rule: real exposure (luma >= `MIN_LUMA`) and stable against the
/// previous frame, or the frame budget is spent. `n` is the 1-based frame number.
pub fn webcam_frame_ready(n: u32, luma: f64, previous: Option<f64>) -> bool {
    let settled = luma >= MIN_LUMA && previous.is_some_and(|p| (luma - p).abs() < SETTLE_DELTA);
    settled || n >= MAX_WEBCAM_FRAMES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fits_the_width_without_upscaling() {
        assert_eq!(fit_width(2560, 1440, 1280), Some((1280, 720)));
        assert_eq!(fit_width(1920, 1080, 1280), Some((1280, 720)));
        assert_eq!(fit_width(1024, 768, 1280), Some((1024, 768)));
        assert_eq!(fit_width(1080, 1920, 1280), Some((1080, 1920)));
        assert_eq!(fit_width(3000, 1, 1280), Some((1280, 1)), "never 0 high");
        assert_eq!(fit_width(0, 10, 1280), None);
        assert_eq!(fit_width(10, 10, 0), None);
    }

    #[test]
    fn swaps_blue_and_red_and_drops_row_padding() {
        // 2x1 BGRA with 4 bytes of padding per row.
        let bytes = [1, 2, 3, 0, 4, 5, 6, 0, 9, 9, 9, 9];
        assert_eq!(
            bgra_to_rgba_scaled(&bytes, 2, 1, 12, 2, 1),
            Some(vec![3, 2, 1, 255, 6, 5, 4, 255])
        );
    }

    #[test]
    fn a_short_buffer_or_empty_size_is_rejected() {
        assert_eq!(bgra_to_rgba_scaled(&[0; 7], 2, 1, 8, 2, 1), None);
        assert_eq!(bgra_to_rgba_scaled(&[0; 8], 2, 1, 4, 2, 1), None, "stride");
        assert_eq!(bgra_to_rgba_scaled(&[0; 8], 2, 1, 8, 0, 1), None);
        assert_eq!(bgra_to_rgba_scaled(&[], 0, 0, 0, 1, 1), None);
    }

    #[test]
    fn the_box_filter_averages_each_block() {
        // 4x2: left half black, right half white (BGRA) -> 2x1: black, white.
        let mut bytes = Vec::new();
        for _ in 0..2 {
            bytes.extend_from_slice(&[0, 0, 0, 255, 0, 0, 0, 255]);
            bytes.extend_from_slice(&[255, 255, 255, 255, 255, 255, 255, 255]);
        }
        assert_eq!(
            bgra_to_rgba_scaled(&bytes, 4, 2, 16, 2, 1),
            Some(vec![0, 0, 0, 255, 255, 255, 255, 255])
        );
        // 2x1 of black + white averaged into one pixel.
        let two = [0, 0, 0, 255, 255, 255, 255, 255];
        assert_eq!(
            bgra_to_rgba_scaled(&two, 2, 1, 8, 1, 1),
            Some(vec![127, 127, 127, 255])
        );
    }

    #[test]
    fn never_scales_up() {
        let px = [10, 20, 30, 0];
        assert_eq!(
            bgra_to_rgba_scaled(&px, 1, 1, 4, 4, 4),
            Some(vec![30, 20, 10, 255])
        );
    }

    #[test]
    fn a_non_integer_ratio_uses_every_pixel_once() {
        // 3x1 -> 2x1: boxes [0,1) and [1,3).
        let bytes = [0, 0, 0, 0, 100, 100, 100, 0, 200, 200, 200, 0];
        assert_eq!(
            bgra_to_rgba_scaled(&bytes, 3, 1, 12, 2, 1),
            Some(vec![0, 0, 0, 255, 150, 150, 150, 255])
        );
    }

    /// 2 wide, 3 high: pixel values 1..=6, row by row.
    fn sample() -> Vec<u8> {
        (1..=6u8).flat_map(|v| [v, 0, 0, 255]).collect()
    }

    fn first_channel(rgba: &[u8]) -> Vec<u8> {
        rgba.as_chunks::<4>().0.iter().map(|p| p[0]).collect()
    }

    #[test]
    fn rotates_clockwise_in_quarter_turns() {
        // 1 2 / 3 4 / 5 6
        let (w, h, out) = rotate_rgba(sample(), 2, 3, 1);
        assert_eq!((w, h), (3, 2));
        assert_eq!(first_channel(&out), [5, 3, 1, 6, 4, 2]);
        let (w, h, out) = rotate_rgba(sample(), 2, 3, 2);
        assert_eq!((w, h), (2, 3));
        assert_eq!(first_channel(&out), [6, 5, 4, 3, 2, 1]);
        let (w, h, out) = rotate_rgba(sample(), 2, 3, 3);
        assert_eq!((w, h), (3, 2));
        assert_eq!(first_channel(&out), [2, 4, 6, 1, 3, 5]);
    }

    #[test]
    fn zero_or_four_turns_change_nothing() {
        for turns in [0, 4, 8] {
            let (w, h, out) = rotate_rgba(sample(), 2, 3, turns);
            assert_eq!((w, h, out), (2, 3, sample()));
        }
    }

    #[test]
    fn an_upright_surface_keeps_its_shape() {
        let surface = [10u8, 20, 30, 0].repeat(8); // 4x2
        let (w, h, rgba) = surface_to_upright_rgba(&surface, 4, 2, 16, 0, 1280).unwrap();
        assert_eq!((w, h, rgba.len()), (4, 2, 32));
        assert_eq!(&rgba[..4], [30, 20, 10, 255]);
    }

    #[test]
    fn a_turned_surface_is_limited_by_the_width_it_ends_up_with() {
        let surface = [10u8, 20, 30, 0].repeat(8); // 4x2, turned: 2 wide, 4 high
        let (w, h, _) = surface_to_upright_rgba(&surface, 4, 2, 16, 1, 1).unwrap();
        assert_eq!((w, h), (1, 2));
        let (w, h, _) = surface_to_upright_rgba(&surface, 4, 2, 16, 2, 2).unwrap();
        assert_eq!((w, h), (2, 1));
        assert!(surface_to_upright_rgba(&surface[..10], 4, 2, 16, 0, 1280).is_none());
    }

    #[test]
    fn flips_a_bottom_up_surface() {
        let bytes = [1, 1, 2, 2, 3, 3];
        assert_eq!(flip_rows(&bytes, 3, 2), Some(vec![3, 3, 2, 2, 1, 1]));
        assert_eq!(flip_rows(&bytes, 4, 2), None);
        assert_eq!(flip_rows(&bytes, 3, 0), None);
    }

    #[test]
    fn luma_of_black_and_white() {
        let black = vec![0u8; 16 * 4];
        assert_eq!(mean_luma_bgra(&black, 4, 4, 16), Some(0.0));
        let white = vec![255u8; 16 * 4];
        assert!((mean_luma_bgra(&white, 4, 4, 16).unwrap() - 255.0).abs() < 0.01);
        assert_eq!(mean_luma_bgra(&black[..10], 4, 4, 16), None);
    }

    #[test]
    fn luma_of_a_large_frame_is_sampled() {
        let grey = vec![100u8; 640 * 480 * 4];
        assert!((mean_luma_bgra(&grey, 640, 480, 640 * 4).unwrap() - 100.0).abs() < 0.01);
    }

    #[test]
    fn a_webcam_frame_is_ready_once_lit_and_steady() {
        assert!(!webcam_frame_ready(1, 0.0, None), "black warm-up frame");
        assert!(!webcam_frame_ready(2, 40.0, None), "no previous frame");
        assert!(!webcam_frame_ready(3, 40.0, Some(30.0)), "exposure moving");
        assert!(!webcam_frame_ready(4, 5.0, Some(5.0)), "steady but dark");
        assert!(webcam_frame_ready(5, 40.0, Some(39.0)));
        assert!(
            webcam_frame_ready(MAX_WEBCAM_FRAMES, 0.0, None),
            "frame budget spent"
        );
    }
}
