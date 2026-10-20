//! The decisions behind the Windows input guard (ANT-02), kept free of Win32 types
//! so they are unit-tested on every OS. The hook callback in `windows.rs` only
//! reads the event and applies the `Verdict` from here.

use agent_core::platform::ScreenRect;

/// `MSLLHOOKSTRUCT.flags`: the event was injected (SendInput and friends).
pub const LLMHF_INJECTED: u32 = 0x01;
/// `MSLLHOOKSTRUCT.flags`: injected by a process running at a lower integrity level.
pub const LLMHF_LOWER_IL_INJECTED: u32 = 0x02;

// Low-level mouse messages (`wParam` of the hook callback).
pub const WM_LBUTTONDOWN: u32 = 0x0201;
pub const WM_LBUTTONUP: u32 = 0x0202;
pub const WM_RBUTTONDOWN: u32 = 0x0204;
pub const WM_RBUTTONUP: u32 = 0x0205;
pub const WM_MBUTTONDOWN: u32 = 0x0207;
pub const WM_MBUTTONUP: u32 = 0x0208;
pub const WM_XBUTTONDOWN: u32 = 0x020B;
pub const WM_XBUTTONUP: u32 = 0x020C;

/// What the hook does with one mouse event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Let it through.
    Pass,
    /// An injected button release inside the card: swallowed, not counted (the
    /// press was).
    Swallow,
    /// An injected button press inside the card: swallowed and counted.
    SwallowAndCount,
}

/// Whether the event came from `SendInput` or similar rather than a device.
pub fn is_injected(flags: u32) -> bool {
    flags & (LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED) != 0
}

fn is_press(message: u32) -> bool {
    matches!(
        message,
        WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN
    )
}

fn is_release(message: u32) -> bool {
    matches!(
        message,
        WM_LBUTTONUP | WM_RBUTTONUP | WM_MBUTTONUP | WM_XBUTTONUP
    )
}

/// Only injected button events inside the card are touched: moves, the wheel and
/// everything outside the card (the person's real work) pass.
pub fn judge(message: u32, flags: u32, x: i32, y: i32, card: &ScreenRect) -> Verdict {
    if !is_injected(flags) || !card.contains(x, y) {
        return Verdict::Pass;
    }
    if is_press(message) {
        Verdict::SwallowAndCount
    } else if is_release(message) {
        Verdict::Swallow
    } else {
        Verdict::Pass
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WM_MOUSEMOVE: u32 = 0x0200;
    const WM_MOUSEWHEEL: u32 = 0x020A;

    fn card() -> ScreenRect {
        ScreenRect {
            x: 100,
            y: 50,
            width: 360,
            height: 220,
        }
    }

    #[test]
    fn both_injected_flags_count_as_injected() {
        assert!(is_injected(LLMHF_INJECTED));
        assert!(is_injected(LLMHF_LOWER_IL_INJECTED));
        assert!(is_injected(LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED));
        assert!(
            is_injected(0x80 | LLMHF_INJECTED),
            "other bits don't hide it"
        );
    }

    #[test]
    fn a_hardware_event_is_not_injected() {
        assert!(!is_injected(0));
        assert!(!is_injected(0x80), "unrelated flag bits");
    }

    #[test]
    fn an_injected_press_inside_the_card_is_swallowed_and_counted() {
        for message in [
            WM_LBUTTONDOWN,
            WM_RBUTTONDOWN,
            WM_MBUTTONDOWN,
            WM_XBUTTONDOWN,
        ] {
            assert_eq!(
                judge(message, LLMHF_INJECTED, 200, 100, &card()),
                Verdict::SwallowAndCount
            );
        }
        assert_eq!(
            judge(WM_LBUTTONDOWN, LLMHF_LOWER_IL_INJECTED, 200, 100, &card()),
            Verdict::SwallowAndCount
        );
    }

    #[test]
    fn an_injected_release_inside_the_card_is_swallowed_but_not_counted() {
        for message in [WM_LBUTTONUP, WM_RBUTTONUP, WM_MBUTTONUP, WM_XBUTTONUP] {
            assert_eq!(
                judge(message, LLMHF_INJECTED, 200, 100, &card()),
                Verdict::Swallow
            );
        }
    }

    #[test]
    fn real_clicks_always_pass() {
        assert_eq!(judge(WM_LBUTTONDOWN, 0, 200, 100, &card()), Verdict::Pass);
        assert_eq!(judge(WM_LBUTTONUP, 0, 200, 100, &card()), Verdict::Pass);
    }

    #[test]
    fn injected_clicks_outside_the_card_pass() {
        // Left of, above, right of (the edge is outside) and below it.
        for (x, y) in [(99, 100), (200, 49), (460, 100), (200, 270)] {
            assert_eq!(
                judge(WM_LBUTTONDOWN, LLMHF_INJECTED, x, y, &card()),
                Verdict::Pass,
                "({x}, {y})"
            );
        }
        assert_eq!(
            judge(WM_LBUTTONDOWN, LLMHF_INJECTED, 100, 50, &card()),
            Verdict::SwallowAndCount,
            "the top-left corner is inside"
        );
    }

    #[test]
    fn injected_moves_and_wheel_inside_the_card_pass() {
        assert_eq!(
            judge(WM_MOUSEMOVE, LLMHF_INJECTED, 200, 100, &card()),
            Verdict::Pass
        );
        assert_eq!(
            judge(WM_MOUSEWHEEL, LLMHF_INJECTED, 200, 100, &card()),
            Verdict::Pass
        );
    }

    #[test]
    fn a_card_on_a_monitor_left_of_the_primary_has_negative_coordinates() {
        let left = ScreenRect {
            x: -1920,
            y: 0,
            width: 360,
            height: 220,
        };
        assert_eq!(
            judge(WM_LBUTTONDOWN, LLMHF_INJECTED, -1800, 10, &left),
            Verdict::SwallowAndCount
        );
        assert_eq!(
            judge(WM_LBUTTONDOWN, LLMHF_INJECTED, 100, 10, &left),
            Verdict::Pass
        );
    }
}
