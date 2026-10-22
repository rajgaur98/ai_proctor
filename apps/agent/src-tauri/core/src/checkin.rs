//! One check-in card (LLD 02 check-in machine; CHK-10..14, CHK-20..22, CHK-24).
//!
//! The scheduler decides *when*; this decides what the card asks and how it
//! ended. Clicks are validated here, in Rust: the webview only reports which
//! button was pressed. Two wrong clicks fail the challenge, a wrong click
//! reshuffles the buttons, and the countdown running out is a miss.

use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::anticheat::{environment_flags, SYNTHETIC_CLICK_FLAG};
use crate::platform::{GuardMode, InjectedInput, Platform, SessionState};
use crate::scheduler::{Deferral, Outcome, Random};

/// CHK-20: 90 s by default, 30–300 s per org.
pub const DEFAULT_COUNTDOWN: Duration = Duration::seconds(90);
pub const MIN_COUNTDOWN: Duration = Duration::seconds(30);
pub const MAX_COUNTDOWN: Duration = Duration::seconds(300);
/// CHK-12: the second wrong click fails the challenge.
pub const MAX_WRONG_CLICKS: u8 = 2;
/// ANT-02: the flag on a check-in whose card was clicked by injected input, with
/// the number of swallowed clicks (`injected_click:3`). Raw state only: the server
/// turns it into a "needs review" flag and never into a penalty.
pub const INJECTED_CLICK_FLAG: &str = "injected_click";

/// Org and per-employee card settings.
#[derive(Clone, Debug, PartialEq)]
pub struct CardPolicy {
    pub countdown: Duration,
    /// Accessibility extension for one employee, added to the countdown (CHK-21).
    pub extension: Duration,
    /// CHK-22: optional sound and OS notification when the card appears.
    pub sound: bool,
    pub notify: bool,
    /// #168: the person uses assistive input (set by an admin), so injected clicks on
    /// the card are let through instead of blocked. Still counted and flagged.
    pub assistive_input: bool,
}

impl Default for CardPolicy {
    fn default() -> Self {
        Self {
            countdown: DEFAULT_COUNTDOWN,
            extension: Duration::zero(),
            sound: false,
            notify: false,
            assistive_input: false,
        }
    }
}

impl CardPolicy {
    /// How long the card stays up: the org countdown clamped to 30–300 s, plus the
    /// employee's extension.
    pub fn window(&self) -> Duration {
        self.countdown.clamp(MIN_COUNTDOWN, MAX_COUNTDOWN) + self.extension.max(Duration::zero())
    }

    /// What the input guard does with injected clicks on this card (ANT-02, #168).
    pub fn guard_mode(&self) -> GuardMode {
        if self.assistive_input {
            GuardMode::CountOnly
        } else {
            GuardMode::Block
        }
    }
}

/// "Click 7": three distinct numbers 1–9, one of them the target, in random order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Challenge {
    pub target: u8,
    pub options: [u8; 3],
}

impl Challenge {
    pub fn new(random: &dyn Random) -> Self {
        let target = random.between(1, 9) as u8;
        Self::around(target, random)
    }

    /// Same target, new decoys and a new order (CHK-12 reshuffle).
    pub fn reshuffle(&mut self, random: &dyn Random) {
        *self = Self::around(self.target, random);
    }

    fn around(target: u8, random: &dyn Random) -> Self {
        let mut pool: Vec<u8> = (1..=9).filter(|n| *n != target).collect();
        let mut options = vec![target];
        for _ in 0..2 {
            let i = random.between(0, pool.len() as i64 - 1) as usize;
            options.push(pool.swap_remove(i));
        }
        // Fisher–Yates.
        for i in (1..options.len()).rev() {
            let j = random.between(0, i as i64) as usize;
            options.swap(i, j);
        }
        Self {
            target,
            options: [options[0], options[1], options[2]],
        }
    }
}

/// CHK-15: how one card looks. Size and style vary a little from card to card, inside
/// the design's limits, so an auto-clicker can't find the buttons by matching a saved
/// picture of the card; the numbers, their order and their place already change. The
/// smallest card still fits its content (header, "Click 7", the buttons, the footer)
/// and the smallest numbers stay large; colours only switch between the design's own
/// fills, all of which keep the accent text readable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CardLook {
    /// Window size in logical pixels.
    pub width: u32,
    pub height: u32,
    pub radius: u32,
    pub padding: u32,
    pub gap: u32,
    pub button_height: u32,
    pub digit_size: u32,
    /// 0 page, 1 sunken, 2 soft accent.
    pub tint: u32,
}

impl CardLook {
    /// The design's card (~360 × 220), and what every card varies around.
    pub const BASE: Self = Self {
        width: 360,
        height: 220,
        radius: 12,
        padding: 16,
        gap: 12,
        button_height: 56,
        digit_size: 24,
        tint: 0,
    };
    pub const WIDTH: (u32, u32) = (340, 384);
    pub const HEIGHT: (u32, u32) = (210, 236);
    pub const RADIUS: (u32, u32) = (8, 16);
    pub const PADDING: (u32, u32) = (14, 20);
    pub const GAP: (u32, u32) = (8, 18);
    pub const BUTTON_HEIGHT: (u32, u32) = (50, 60);
    pub const DIGIT_SIZE: (u32, u32) = (22, 28);
    pub const TINTS: u32 = 3;

    pub fn random(random: &dyn Random) -> Self {
        let pick = |(lo, hi): (u32, u32)| random.between(lo.into(), hi.into()) as u32;
        Self {
            width: pick(Self::WIDTH),
            height: pick(Self::HEIGHT),
            radius: pick(Self::RADIUS),
            padding: pick(Self::PADDING),
            gap: pick(Self::GAP),
            button_height: pick(Self::BUTTON_HEIGHT),
            digit_size: pick(Self::DIGIT_SIZE),
            tint: pick((0, Self::TINTS - 1)),
        }
    }
}

/// What a click did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClickResult {
    Pass,
    /// Wrong; the buttons were reshuffled.
    Wrong,
    Failed,
}

/// A card on screen.
#[derive(Clone, Debug, PartialEq)]
pub struct Card {
    pub id: Uuid,
    pub scheduled_at: DateTime<Utc>,
    pub shown_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub challenge: Challenge,
    pub wrong_clicks: u8,
    pub idle_s_at_show: u64,
    pub device_state: &'static str,
    pub project_id: Option<Uuid>,
    pub flags: Vec<String>,
    /// Injected clicks the input guard counted on this card (ANT-02): swallowed, or
    /// let through for assistive input (#168).
    pub injected_clicks: u32,
    /// What the input guard does with them, from the policy the card was shown with.
    pub guard_mode: GuardMode,
    /// Clicks on this card that looked synthetic and were let through (ANT-03).
    pub synthetic_clicks: u32,
    /// CHK-15: chosen when the card is shown, kept through reshuffles.
    pub look: CardLook,
}

/// How the card ended, ready to queue as a `checkin` event.
#[derive(Clone, Debug, PartialEq)]
pub struct Finished {
    pub outcome: Outcome,
    /// When it ended: the click, or the end of the countdown for a miss.
    pub at: DateTime<Utc>,
    pub payload: Value,
}

impl Card {
    pub fn show(
        scheduled_at: DateTime<Utc>,
        now: DateTime<Utc>,
        policy: &CardPolicy,
        platform: &dyn Platform,
        random: &dyn Random,
        project_id: Option<Uuid>,
    ) -> Self {
        Self {
            id: Uuid::now_v7(),
            scheduled_at,
            shown_at: now,
            expires_at: now + policy.window(),
            challenge: Challenge::new(random),
            wrong_clicks: 0,
            idle_s_at_show: platform.idle_seconds(),
            device_state: match platform.session_state() {
                SessionState::Active => "active",
                SessionState::Locked => "locked",
                SessionState::Asleep => "asleep",
            },
            project_id,
            // ANT-07: a virtual machine or a remote session, as the card was shown.
            flags: environment_flags(platform.run_environment()),
            injected_clicks: 0,
            guard_mode: policy.guard_mode(),
            synthetic_clicks: 0,
            look: CardLook::random(random),
        }
    }

    /// What the input guard saw while the card was up (ANT-02, ANT-03). The check-in
    /// still ends by its own outcome: blocked injected clicks never reached the card and
    /// count for nothing; let-through ones (assistive input, #168) and the
    /// synthetic-looking ones are only noted.
    pub fn record_injected(&mut self, input: InjectedInput) {
        self.injected_clicks = self.injected_clicks.saturating_add(input.count);
        self.synthetic_clicks = self.synthetic_clicks.saturating_add(input.synthetic);
    }

    /// Seconds left on the countdown, for the card's display.
    pub fn remaining_s(&self, now: DateTime<Utc>) -> u32 {
        (self.expires_at - now)
            .num_seconds()
            .clamp(0, u32::MAX as i64) as u32
    }

    pub fn expired(&self, now: DateTime<Utc>) -> bool {
        now >= self.expires_at
    }

    /// A real mouse or trackpad click on the button showing `value`.
    pub fn click(&mut self, value: u8, random: &dyn Random) -> ClickResult {
        if value == self.challenge.target {
            return ClickResult::Pass;
        }
        self.wrong_clicks += 1;
        if self.wrong_clicks >= MAX_WRONG_CLICKS {
            return ClickResult::Failed;
        }
        self.challenge.reshuffle(random);
        ClickResult::Wrong
    }

    /// The card ended with a click (`Pass`, `Failed`) at `at`, or ran out (`Miss`).
    pub fn finish(&self, outcome: Outcome, at: DateTime<Utc>) -> Finished {
        let (at, responded_at, response_ms) = match outcome {
            Outcome::Miss => (self.expires_at.min(at), None, None),
            Outcome::Pass | Outcome::Failed => (
                at,
                Some(at),
                Some((at - self.shown_at).num_milliseconds().max(0)),
            ),
        };
        let outcome_name = match outcome {
            Outcome::Pass => "pass",
            Outcome::Miss => "miss",
            Outcome::Failed => "failed",
        };
        let mut flags = self.flags.clone();
        if self.injected_clicks > 0 {
            flags.push(format!("{INJECTED_CLICK_FLAG}:{}", self.injected_clicks));
        }
        if self.synthetic_clicks > 0 {
            flags.push(format!("{SYNTHETIC_CLICK_FLAG}:{}", self.synthetic_clicks));
        }
        Finished {
            outcome,
            at,
            payload: json!({
                "scheduled_at": self.scheduled_at,
                "shown_at": self.shown_at,
                "responded_at": responded_at,
                "outcome": outcome_name,
                "response_ms": response_ms,
                "wrong_clicks": self.wrong_clicks,
                "idle_s_at_show": self.idle_s_at_show,
                "device_state": self.device_state,
                "object_keys": [],
                "project_id": self.project_id,
                "flags": flags,
            }),
        }
    }
}

/// The `checkin` event for a due check-in that was held for a call, a share or a
/// presentation (CHK-03): nothing was shown, so no response and no capture.
pub fn deferred_payload(deferral: &Deferral, project_id: Option<Uuid>) -> Value {
    json!({
        "scheduled_at": deferral.due_at,
        "shown_at": null,
        "responded_at": null,
        "outcome": "deferred",
        "deferral_reason": deferral.reason.as_str(),
        "response_ms": null,
        "wrong_clicks": 0,
        "idle_s_at_show": null,
        "device_state": null,
        "object_keys": [],
        "project_id": project_id,
        "flags": [],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::FakePlatform;
    use crate::scheduler::ThreadRandom;

    /// Returns `lo` every time: deterministic decoys and order.
    struct Low;
    impl Random for Low {
        fn between(&self, lo: i64, _hi: i64) -> i64 {
            lo
        }
    }

    fn t(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    fn card(random: &dyn Random) -> Card {
        let platform = FakePlatform::default();
        platform.update(|s| s.idle_seconds = 42);
        Card::show(
            t("2026-10-20T10:00:00Z"),
            t("2026-10-20T10:00:03Z"),
            &CardPolicy::default(),
            &platform,
            random,
            None,
        )
    }

    #[test]
    fn challenges_have_three_distinct_numbers_including_the_target() {
        for _ in 0..500 {
            let c = Challenge::new(&ThreadRandom);
            assert!((1..=9).contains(&c.target));
            assert!(c.options.contains(&c.target));
            assert!(c.options.iter().all(|n| (1..=9).contains(n)));
            assert!(
                c.options[0] != c.options[1]
                    && c.options[1] != c.options[2]
                    && c.options[0] != c.options[2]
            );
        }
    }

    #[test]
    fn the_target_lands_in_every_position() {
        let mut seen = [false; 3];
        for _ in 0..300 {
            let c = Challenge::new(&ThreadRandom);
            seen[c.options.iter().position(|n| *n == c.target).unwrap()] = true;
        }
        assert_eq!(seen, [true; 3]);
    }

    #[test]
    fn countdown_is_clamped_and_extended() {
        let mut p = CardPolicy::default();
        assert_eq!(p.window(), Duration::seconds(90));
        p.countdown = Duration::seconds(5);
        assert_eq!(p.window(), Duration::seconds(30));
        p.countdown = Duration::seconds(900);
        assert_eq!(p.window(), Duration::seconds(300));
        p.extension = Duration::seconds(60);
        assert_eq!(p.window(), Duration::seconds(360));
    }

    #[test]
    fn right_click_passes_with_response_time() {
        let mut c = card(&Low);
        assert_eq!(c.click(c.challenge.target, &Low), ClickResult::Pass);
        let done = c.finish(Outcome::Pass, t("2026-10-20T10:00:15.250Z"));
        assert_eq!(done.payload["outcome"], "pass");
        assert_eq!(done.payload["response_ms"], 12_250);
        assert_eq!(done.payload["responded_at"], "2026-10-20T10:00:15.250Z");
        assert_eq!(done.payload["wrong_clicks"], 0);
        assert_eq!(done.payload["idle_s_at_show"], 42);
        assert_eq!(done.payload["device_state"], "active");
        assert_eq!(done.payload["object_keys"], json!([]));
    }

    #[test]
    fn a_wrong_click_reshuffles_and_the_second_fails() {
        let mut c = card(&ThreadRandom);
        let wrong = *c
            .challenge
            .options
            .iter()
            .find(|n| **n != c.challenge.target)
            .unwrap();
        let before = c.challenge.clone();
        assert_eq!(c.click(wrong, &ThreadRandom), ClickResult::Wrong);
        assert_eq!(
            c.challenge.target, before.target,
            "same target after reshuffle"
        );
        assert_eq!(c.wrong_clicks, 1);

        let wrong = *c
            .challenge
            .options
            .iter()
            .find(|n| **n != c.challenge.target)
            .unwrap();
        assert_eq!(c.click(wrong, &ThreadRandom), ClickResult::Failed);
        let done = c.finish(Outcome::Failed, t("2026-10-20T10:00:10Z"));
        assert_eq!(done.payload["outcome"], "failed");
        assert_eq!(done.payload["wrong_clicks"], 2);
        assert_eq!(done.payload["response_ms"], 7_000);
    }

    #[test]
    fn a_card_without_injected_clicks_has_no_flags() {
        let mut c = card(&Low);
        c.record_injected(InjectedInput::default());
        let done = c.finish(Outcome::Pass, t("2026-10-20T10:00:15Z"));
        assert_eq!(done.payload["flags"], json!([]));
        assert_eq!(done.payload["outcome"], "pass");
    }

    #[test]
    fn injected_clicks_add_a_flag_with_their_count() {
        let mut c = card(&Low);
        c.record_injected(InjectedInput {
            count: 2,
            synthetic: 0,
        });
        c.record_injected(InjectedInput {
            count: 1,
            synthetic: 0,
        });
        let done = c.finish(Outcome::Pass, t("2026-10-20T10:00:15Z"));
        assert_eq!(done.payload["flags"], json!(["injected_click:3"]));
        // The outcome is still the card's own: the flag is only a note.
        assert_eq!(done.payload["outcome"], "pass");
        assert_eq!(done.payload["wrong_clicks"], 0);
        assert_eq!(done.payload["response_ms"], 12_000);
    }

    #[test]
    fn a_miss_with_injected_clicks_is_still_a_miss_with_the_flag() {
        let mut c = card(&Low);
        c.record_injected(InjectedInput {
            count: 4,
            synthetic: 0,
        });
        let done = c.finish(Outcome::Miss, t("2026-10-20T10:01:34Z"));
        assert_eq!(done.outcome, Outcome::Miss);
        assert_eq!(done.payload["outcome"], "miss");
        assert_eq!(done.payload["flags"], json!(["injected_click:4"]));
    }

    #[test]
    fn the_injected_flag_comes_after_other_flags() {
        let mut c = card(&Low);
        c.flags.push("dev_marked".into());
        c.record_injected(InjectedInput {
            count: 1,
            synthetic: 0,
        });
        let done = c.finish(Outcome::Failed, t("2026-10-20T10:00:10Z"));
        assert_eq!(
            done.payload["flags"],
            json!(["dev_marked", "injected_click:1"])
        );
    }

    #[test]
    fn synthetic_clicks_are_flagged_with_their_count_and_change_nothing() {
        let mut c = card(&Low);
        c.record_injected(InjectedInput {
            count: 0,
            synthetic: 2,
        });
        let done = c.finish(Outcome::Pass, t("2026-10-20T10:00:15Z"));
        assert_eq!(done.payload["flags"], json!(["synthetic_click:2"]));
        assert_eq!(done.payload["outcome"], "pass");
        assert_eq!(done.payload["response_ms"], 12_000);
    }

    #[test]
    fn a_card_in_a_vm_or_remote_session_carries_those_flags() {
        use crate::platform::RunEnvironment;
        let platform = FakePlatform::default();
        platform.update(|s| {
            s.environment = RunEnvironment {
                virtual_machine: true,
                remote_session: true,
            }
        });
        let mut c = Card::show(
            t("2026-10-20T10:00:00Z"),
            t("2026-10-20T10:00:03Z"),
            &CardPolicy::default(),
            &platform,
            &Low,
            None,
        );
        c.record_injected(InjectedInput {
            count: 1,
            synthetic: 0,
        });
        let done = c.finish(Outcome::Miss, t("2026-10-20T10:01:34Z"));
        assert_eq!(
            done.payload["flags"],
            json!(["virtual_machine", "remote_session", "injected_click:1"])
        );
        assert_eq!(done.payload["outcome"], "miss");
    }

    #[test]
    fn card_looks_stay_within_the_design_limits_and_vary() {
        let within = |v: u32, (lo, hi): (u32, u32)| (lo..=hi).contains(&v);
        let mut widths = std::collections::HashSet::new();
        let mut tints = std::collections::HashSet::new();
        for _ in 0..400 {
            let l = CardLook::random(&ThreadRandom);
            assert!(within(l.width, CardLook::WIDTH), "{l:?}");
            assert!(within(l.height, CardLook::HEIGHT), "{l:?}");
            assert!(within(l.radius, CardLook::RADIUS), "{l:?}");
            assert!(within(l.padding, CardLook::PADDING), "{l:?}");
            assert!(within(l.gap, CardLook::GAP), "{l:?}");
            assert!(within(l.button_height, CardLook::BUTTON_HEIGHT), "{l:?}");
            assert!(within(l.digit_size, CardLook::DIGIT_SIZE), "{l:?}");
            assert!(l.tint < CardLook::TINTS, "{l:?}");
            // The content fits the smallest card: padding, header and footer (18 px
            // each), the ask (31 px), the buttons, three 12 px gaps and the border.
            assert!(
                2 * l.padding + 18 + 18 + 31 + l.button_height + 36 + 2 <= l.height,
                "{l:?}"
            );
            widths.insert(l.width);
            tints.insert(l.tint);
        }
        assert!(widths.len() > 10, "sizes vary");
        assert_eq!(tints.len(), 3, "every fill is used");
        let base = CardLook::BASE;
        assert!(within(base.width, CardLook::WIDTH) && within(base.height, CardLook::HEIGHT));
    }

    #[test]
    fn a_card_keeps_its_look_through_a_reshuffle() {
        let mut c = card(&ThreadRandom);
        let look = c.look;
        let wrong = *c
            .challenge
            .options
            .iter()
            .find(|n| **n != c.challenge.target)
            .unwrap();
        c.click(wrong, &ThreadRandom);
        assert_eq!(c.look, look);
    }

    #[test]
    fn a_miss_records_times_and_no_response() {
        let c = card(&Low);
        assert!(!c.expired(t("2026-10-20T10:01:32Z")));
        assert_eq!(c.remaining_s(t("2026-10-20T10:01:30Z")), 3);
        assert!(c.expired(t("2026-10-20T10:01:33Z")));
        let done = c.finish(Outcome::Miss, t("2026-10-20T10:01:34Z"));
        assert_eq!(
            done.at,
            t("2026-10-20T10:01:33Z"),
            "ends when the countdown ran out"
        );
        assert_eq!(done.payload["outcome"], "miss");
        assert_eq!(done.payload["scheduled_at"], "2026-10-20T10:00:00Z");
        assert_eq!(done.payload["shown_at"], "2026-10-20T10:00:03Z");
        assert!(done.payload["responded_at"].is_null());
        assert!(done.payload["response_ms"].is_null());
        assert_eq!(done.payload["object_keys"], json!([]));
    }

    #[test]
    fn a_deferral_records_the_due_time_and_reason_with_no_response_or_capture() {
        use crate::scheduler::DeferralReason;
        let payload = deferred_payload(
            &Deferral {
                due_at: t("2026-10-20T10:00:00Z"),
                reason: DeferralReason::ScreenShare,
            },
            None,
        );
        assert_eq!(payload["outcome"], "deferred");
        assert_eq!(payload["deferral_reason"], "screen_share");
        assert_eq!(payload["scheduled_at"], "2026-10-20T10:00:00Z");
        assert!(payload["shown_at"].is_null());
        assert!(payload["responded_at"].is_null());
        assert!(payload["response_ms"].is_null());
        assert_eq!(payload["object_keys"], json!([]));
    }
}
