//! One check-in card (LLD 02 check-in machine; CHK-10..14, CHK-20..22, CHK-24).
//!
//! The scheduler decides *when*; this decides what the card asks and how it
//! ended. Clicks are validated here, in Rust: the webview only reports which
//! button was pressed. Two wrong clicks fail the challenge, a wrong click
//! reshuffles the buttons, and the countdown running out is a miss.

use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::platform::{Platform, SessionState};
use crate::scheduler::{Outcome, Random};

/// CHK-20: 90 s by default, 30–300 s per org.
pub const DEFAULT_COUNTDOWN: Duration = Duration::seconds(90);
pub const MIN_COUNTDOWN: Duration = Duration::seconds(30);
pub const MAX_COUNTDOWN: Duration = Duration::seconds(300);
/// CHK-12: the second wrong click fails the challenge.
pub const MAX_WRONG_CLICKS: u8 = 2;

/// Org and per-employee card settings.
#[derive(Clone, Debug, PartialEq)]
pub struct CardPolicy {
    pub countdown: Duration,
    /// Accessibility extension for one employee, added to the countdown (CHK-21).
    pub extension: Duration,
    /// CHK-22: optional sound and OS notification when the card appears.
    pub sound: bool,
    pub notify: bool,
}

impl Default for CardPolicy {
    fn default() -> Self {
        Self {
            countdown: DEFAULT_COUNTDOWN,
            extension: Duration::zero(),
            sound: false,
            notify: false,
        }
    }
}

impl CardPolicy {
    /// How long the card stays up: the org countdown clamped to 30–300 s, plus the
    /// employee's extension.
    pub fn window(&self) -> Duration {
        self.countdown.clamp(MIN_COUNTDOWN, MAX_COUNTDOWN) + self.extension.max(Duration::zero())
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
            flags: Vec::new(),
        }
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
                "flags": self.flags,
            }),
        }
    }
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
}
