//! Monitor geometry (#167): a stable display order, which display a window is on,
//! whether a window covers one, and how Desktop Duplication's rotation maps to a
//! turn of the image. Pure, so it runs in CI on every OS; the monitor and window
//! reads live in `agent-platform`.

/// A rectangle in virtual-desktop pixels (Win32 `RECT`: right and bottom are
/// exclusive).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn new(left: i32, top: i32, right: i32, bottom: i32) -> Self {
        Self {
            left,
            top,
            right,
            bottom,
        }
    }

    pub fn width(&self) -> i32 {
        self.right - self.left
    }

    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }

    /// Pixels shared with `other` (0 if they don't touch).
    pub fn overlap(&self, other: &Rect) -> i64 {
        let w = (self.right.min(other.right) as i64 - self.left.max(other.left) as i64).max(0);
        let h = (self.bottom.min(other.bottom) as i64 - self.top.max(other.top) as i64).max(0);
        w * h
    }
}

/// The monitors in display order: left to right, then top to bottom, one entry per
/// distinct rectangle (a mirrored display shows the same desktop, so it counts
/// once). `screen-N` and `Foreground.display` both index into this, 1-based.
pub fn display_order(mut rects: Vec<Rect>) -> Vec<Rect> {
    rects.sort();
    rects.dedup();
    rects
}

/// The 0-based index in `displays` of the display `window` is mostly on (the most
/// pixels; the earlier display on a tie). `None` if it overlaps none, or is empty.
pub fn display_of_window(window: &Rect, displays: &[Rect]) -> Option<usize> {
    let mut best: Option<(usize, i64)> = None;
    for (i, d) in displays.iter().enumerate() {
        let area = window.overlap(d);
        if area > 0 && best.is_none_or(|(_, a)| area > a) {
            best = Some((i, area));
        }
    }
    best.map(|(i, _)| i)
}

/// True if `window` covers all of `display` (a slideshow, a full-screen app).
pub fn covers(window: &Rect, display: &Rect) -> bool {
    display.width() > 0
        && display.height() > 0
        && window.left <= display.left
        && window.top <= display.top
        && window.right >= display.right
        && window.bottom >= display.bottom
}

/// Clockwise quarter turns that make a Desktop Duplication surface upright, from
/// `DXGI_OUTDUPL_DESC.Rotation` (1 identity, 2 rotate90, 3 rotate180, 4 rotate270).
/// Rotate90 is a panel turned 90 degrees counter-clockwise, whose surface holds the
/// desktop turned clockwise, so the fix is a counter-clockwise turn. Not verified
/// without a rotated monitor (device checklist, #167): this is the one line to swap
/// if portrait screens come out sideways.
pub fn upright_quarter_turns(dxgi_rotation: i32) -> u32 {
    match dxgi_rotation {
        2 => 3,
        3 => 2,
        4 => 1,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEFT: Rect = Rect {
        left: -1920,
        top: 0,
        right: 0,
        bottom: 1080,
    };
    const MAIN: Rect = Rect {
        left: 0,
        top: 0,
        right: 2560,
        bottom: 1440,
    };
    const ABOVE: Rect = Rect {
        left: 0,
        top: -1080,
        right: 1920,
        bottom: 0,
    };

    #[test]
    fn displays_are_ordered_left_to_right_then_top_to_bottom() {
        assert_eq!(display_order(vec![MAIN, ABOVE, LEFT]), [LEFT, ABOVE, MAIN]);
    }

    #[test]
    fn a_mirrored_display_counts_once() {
        assert_eq!(display_order(vec![MAIN, MAIN, LEFT]), [LEFT, MAIN]);
        assert_eq!(display_order(vec![]), []);
    }

    #[test]
    fn a_window_belongs_to_the_display_with_most_of_it() {
        let shown = [LEFT, MAIN];
        let mostly_main = Rect::new(-200, 100, 1000, 800);
        assert_eq!(display_of_window(&mostly_main, &shown), Some(1));
        let mostly_left = Rect::new(-1500, 100, 300, 800);
        assert_eq!(display_of_window(&mostly_left, &shown), Some(0));
        let inside_main = Rect::new(100, 100, 400, 400);
        assert_eq!(display_of_window(&inside_main, &shown), Some(1));
    }

    #[test]
    fn a_window_on_no_display_or_empty_has_none() {
        let shown = [LEFT, MAIN];
        assert_eq!(
            display_of_window(&Rect::new(5000, 0, 6000, 500), &shown),
            None
        );
        assert_eq!(display_of_window(&Rect::new(10, 10, 10, 10), &shown), None);
        assert_eq!(display_of_window(&MAIN, &[]), None);
    }

    #[test]
    fn an_even_split_picks_the_earlier_display() {
        let shown = [LEFT, MAIN];
        assert_eq!(
            display_of_window(&Rect::new(-100, 0, 100, 100), &shown),
            Some(0)
        );
    }

    #[test]
    fn covering_needs_every_edge() {
        assert!(covers(&MAIN, &MAIN));
        assert!(
            covers(&Rect::new(-8, -8, 2568, 1448), &MAIN),
            "shadow borders"
        );
        assert!(
            !covers(&Rect::new(0, 0, 2560, 1400), &MAIN),
            "taskbar strip"
        );
        assert!(!covers(&LEFT, &MAIN));
        assert!(!covers(&MAIN, &Rect::default()), "empty display");
    }

    #[test]
    fn rotation_maps_to_quarter_turns() {
        assert_eq!(upright_quarter_turns(0), 0);
        assert_eq!(upright_quarter_turns(1), 0);
        assert_eq!(upright_quarter_turns(2), 3);
        assert_eq!(upright_quarter_turns(3), 2);
        assert_eq!(upright_quarter_turns(4), 1);
    }
}
