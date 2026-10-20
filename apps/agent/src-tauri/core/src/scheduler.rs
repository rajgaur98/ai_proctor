//! Check-in scheduler (LLD 02 check-in machine; CHK-01..05, NFR-PERF-02).
//!
//! Draws the next check-in time uniformly at random and writes it to disk before
//! arming, so a restart keeps the same time. When it is due, the gate reads the
//! platform: calls, screen sharing or presenting defer it (not a miss); a locked or
//! sleeping Mac shows nothing. Once the condition clears, the card comes within
//! 2 minutes. Breaks, pauses and clock-out cancel it.
//!
//! A deferral leaves one record (`Decision::Deferred`, once per due check-in, with
//! the due time and the reason); recording it changes nothing about when the card
//! comes. A lock leaves none.
//!
//! The next check-in time stays inside this module: it is never part of
//! `AgentStatus` or any IPC payload.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::clock::Clock;
use crate::platform::{Platform, ScreenShare, SessionState};

/// Org interval settings (CHK-01). Defaults: 20–90 min; EU preset 45–120 min.
#[derive(Clone, Debug, PartialEq)]
pub struct SchedulePolicy {
    pub min: Duration,
    pub max: Duration,
}

impl Default for SchedulePolicy {
    fn default() -> Self {
        Self {
            min: Duration::minutes(20),
            max: Duration::minutes(90),
        }
    }
}

impl SchedulePolicy {
    pub fn eu() -> Self {
        Self {
            min: Duration::minutes(45),
            max: Duration::minutes(120),
        }
    }
}

/// CHK-02: after a miss, 5–10 min.
const AFTER_MISS: (i64, i64) = (5 * 60, 10 * 60);
/// CHK-03/04: once the blocking condition clears, show within 2 min.
const AFTER_CLEAR_MAX_S: i64 = 120;

/// Why a due check-in is not shown right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Hold {
    /// Camera or mic in use, screen shared, or presenting (CHK-03).
    Deferred,
    /// Locked or asleep (CHK-04).
    Locked,
}

/// Why a check-in was deferred (CHK-03); the `deferral_reason` of a deferred check-in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeferralReason {
    /// Camera or microphone in use by another app.
    Call,
    /// A screen share is running.
    ScreenShare,
    /// A full-screen presentation is running.
    Presenting,
}

impl DeferralReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Call => "call",
            Self::ScreenShare => "screen_share",
            Self::Presenting => "presenting",
        }
    }
}

/// A due check-in that was held for a call, a share or a presentation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Deferral {
    /// The originally drawn time, reported as `scheduled_at`.
    pub due_at: DateTime<Utc>,
    pub reason: DeferralReason,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Nothing scheduled (not working).
    Idle,
    /// Not due yet.
    Wait,
    /// Due but held back; check again soon.
    Held(Hold),
    /// Due but deferred, the first time for this check-in: record it. Later polls
    /// of the same hold answer `Held(Hold::Deferred)`.
    Deferred(Deferral),
    /// Show the card now. `scheduled_at` is the original due time.
    Show { scheduled_at: DateTime<Utc> },
}

/// How a shown check-in ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Pass,
    Miss,
    Failed,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduleSnapshot {
    /// When the next card is due (or re-due after a hold cleared).
    pub next_at: Option<DateTime<Utc>>,
    /// The originally drawn time, reported as `scheduled_at`.
    pub scheduled_at: Option<DateTime<Utc>>,
    /// Set while a due check-in is held back.
    pub held: Option<Hold>,
    /// A deferral was already reported for this check-in, so a hold that lasts, or
    /// comes back, leaves one record. Reset when the next check-in is armed.
    #[serde(default)]
    pub deferral_recorded: bool,
}

/// Random numbers, injectable for tests.
pub trait Random: Send + Sync {
    /// Uniform integer in `[lo, hi]`.
    fn between(&self, lo: i64, hi: i64) -> i64;
}

pub struct ThreadRandom;

impl Random for ThreadRandom {
    fn between(&self, lo: i64, hi: i64) -> i64 {
        fastrand::i64(lo..=hi)
    }
}

pub trait ScheduleStore: Send + Sync {
    fn load(&self) -> Option<ScheduleSnapshot>;
    fn save(&self, snapshot: &ScheduleSnapshot);
}

pub struct FileScheduleStore {
    path: PathBuf,
}

impl FileScheduleStore {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join("schedule.json"),
        }
    }
}

impl ScheduleStore for FileScheduleStore {
    fn load(&self) -> Option<ScheduleSnapshot> {
        serde_json::from_slice(&std::fs::read(&self.path).ok()?).ok()
    }

    fn save(&self, snapshot: &ScheduleSnapshot) {
        let tmp = self.path.with_extension("json.tmp");
        let result = serde_json::to_vec(snapshot)
            .map_err(std::io::Error::other)
            .and_then(|bytes| std::fs::write(&tmp, bytes))
            .and_then(|()| std::fs::rename(&tmp, &self.path));
        if let Err(e) = result {
            tracing::error!(error = %e, "could not save the check-in schedule");
        }
    }
}

pub struct Scheduler {
    state: Mutex<ScheduleSnapshot>,
    policy: Mutex<SchedulePolicy>,
    clock: Arc<dyn Clock>,
    platform: Arc<dyn Platform>,
    random: Arc<dyn Random>,
    store: Arc<dyn ScheduleStore>,
}

impl Scheduler {
    pub fn new(
        policy: SchedulePolicy,
        clock: Arc<dyn Clock>,
        platform: Arc<dyn Platform>,
        random: Arc<dyn Random>,
        store: Arc<dyn ScheduleStore>,
    ) -> Self {
        let state = store.load().unwrap_or_default();
        Self {
            state: Mutex::new(state),
            policy: Mutex::new(policy),
            clock,
            platform,
            random,
            store,
        }
    }

    pub fn set_policy(&self, policy: SchedulePolicy) {
        *self.policy.lock().unwrap() = policy;
    }

    /// Working started (clock-in, end of break/pause): arm a check-in unless one
    /// is already armed (e.g. after a restart mid-shift).
    pub fn start(&self) {
        let mut state = self.state.lock().unwrap();
        if state.next_at.is_none() {
            let policy = self.policy.lock().unwrap().clone();
            self.arm(
                &mut state,
                policy.min.num_seconds(),
                policy.max.num_seconds(),
            );
        }
    }

    /// Clock-out, a break or a pause: drop the armed check-in without a miss.
    pub fn cancel(&self) {
        let mut state = self.state.lock().unwrap();
        *state = ScheduleSnapshot::default();
        self.store.save(&state);
    }

    /// Call on a timer (and right after `wake_in` elapses).
    pub fn poll(&self) -> Decision {
        let mut state = self.state.lock().unwrap();
        let Some(next_at) = state.next_at else {
            return Decision::Idle;
        };
        let now = self.clock.now();
        if now < next_at {
            return Decision::Wait;
        }
        if let Some((hold, reason)) = self.gate() {
            let mut changed = false;
            if state.held != Some(hold) {
                tracing::info!(?hold, "check-in due but held");
                state.held = Some(hold);
                changed = true;
            }
            let report = reason.filter(|_| !state.deferral_recorded);
            if report.is_some() {
                state.deferral_recorded = true;
                changed = true;
            }
            if changed {
                self.store.save(&state);
            }
            return match report {
                Some(reason) => Decision::Deferred(Deferral {
                    due_at: state.scheduled_at.unwrap_or(next_at),
                    reason,
                }),
                None => Decision::Held(hold),
            };
        }
        if state.held.take().is_some() {
            // Cleared: show within 2 min, at a random moment so it isn't predictable.
            let delay = self.random.between(0, AFTER_CLEAR_MAX_S);
            state.next_at = Some(now + Duration::seconds(delay));
            self.store.save(&state);
            if delay > 0 {
                return Decision::Wait;
            }
        }
        let scheduled_at = state.scheduled_at.unwrap_or(next_at);
        // The card is now in flight; nothing is armed until its outcome.
        state.next_at = None;
        self.store.save(&state);
        Decision::Show { scheduled_at }
    }

    /// The card finished: arm the next one (CHK-01 / CHK-02).
    pub fn finished(&self, outcome: Outcome) {
        let mut state = self.state.lock().unwrap();
        state.held = None;
        match outcome {
            Outcome::Pass => {
                let policy = self.policy.lock().unwrap().clone();
                self.arm(
                    &mut state,
                    policy.min.num_seconds(),
                    policy.max.num_seconds(),
                );
            }
            Outcome::Miss | Outcome::Failed => self.arm(&mut state, AFTER_MISS.0, AFTER_MISS.1),
        }
    }

    /// How long the runner may sleep before polling again. Precise when the
    /// check-in is armed (NFR-PERF-02: card within 500 ms), coarse while held.
    pub fn wake_in(&self) -> Option<std::time::Duration> {
        let state = self.state.lock().unwrap();
        let next_at = state.next_at?;
        if state.held.is_some() {
            return Some(std::time::Duration::from_secs(2));
        }
        let until = (next_at - self.clock.now()).to_std().unwrap_or_default();
        Some(until.min(std::time::Duration::from_secs(60)))
    }

    /// What holds a due check-in back, and for a deferral, why. A call wins over a
    /// share, and a share over a presentation, when several apply.
    fn gate(&self) -> Option<(Hold, Option<DeferralReason>)> {
        if self.platform.session_state() != SessionState::Active {
            return Some((Hold::Locked, None));
        }
        let reason = if self.platform.call_state().in_call() {
            DeferralReason::Call
        } else {
            match self.platform.screen_share()? {
                ScreenShare::Sharing => DeferralReason::ScreenShare,
                ScreenShare::Presenting => DeferralReason::Presenting,
            }
        };
        Some((Hold::Deferred, Some(reason)))
    }

    fn arm(&self, state: &mut ScheduleSnapshot, lo_s: i64, hi_s: i64) {
        let at = self.clock.now() + Duration::seconds(self.random.between(lo_s, hi_s));
        state.next_at = Some(at);
        state.scheduled_at = Some(at);
        state.held = None;
        state.deferral_recorded = false;
        // On disk before it counts as armed, so a restart keeps the same time.
        self.store.save(state);
    }

    #[cfg(test)]
    fn snapshot(&self) -> ScheduleSnapshot {
        self.state.lock().unwrap().clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::FakeClock;
    use crate::fake::FakePlatform;
    use crate::platform::CallState;

    /// Returns `lo` or `hi` on demand, so tests know exactly when things fire.
    struct Fixed(Mutex<Vec<bool>>);

    impl Fixed {
        fn lows() -> Arc<Self> {
            Arc::new(Self(Mutex::new(Vec::new())))
        }
    }

    impl Random for Fixed {
        fn between(&self, lo: i64, hi: i64) -> i64 {
            if self.0.lock().unwrap().pop().unwrap_or(false) {
                hi
            } else {
                lo
            }
        }
    }

    #[derive(Default)]
    struct MemoryStore(Mutex<Option<ScheduleSnapshot>>);

    impl ScheduleStore for MemoryStore {
        fn load(&self) -> Option<ScheduleSnapshot> {
            self.0.lock().unwrap().clone()
        }
        fn save(&self, s: &ScheduleSnapshot) {
            *self.0.lock().unwrap() = Some(s.clone());
        }
    }

    struct Rig {
        clock: Arc<FakeClock>,
        platform: Arc<FakePlatform>,
        store: Arc<MemoryStore>,
        random: Arc<Fixed>,
        scheduler: Scheduler,
    }

    fn rig() -> Rig {
        let clock = Arc::new(FakeClock::at("2026-10-19T09:00:00Z"));
        let platform = Arc::new(FakePlatform::default());
        let store = Arc::new(MemoryStore::default());
        let random = Fixed::lows();
        let scheduler = Scheduler::new(
            SchedulePolicy::default(),
            clock.clone(),
            platform.clone(),
            random.clone(),
            store.clone(),
        );
        Rig {
            clock,
            platform,
            store,
            random,
            scheduler,
        }
    }

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn nothing_is_scheduled_until_work_starts() {
        let r = rig();
        assert_eq!(r.scheduler.poll(), Decision::Idle);
        assert_eq!(r.scheduler.wake_in(), None);
    }

    #[test]
    fn draws_between_min_and_max_and_shows_when_due() {
        let r = rig();
        r.scheduler.start(); // low end: 20 min
        r.clock.advance(Duration::minutes(19));
        assert_eq!(r.scheduler.poll(), Decision::Wait);
        r.clock.advance(Duration::minutes(1));
        assert_eq!(
            r.scheduler.poll(),
            Decision::Show {
                scheduled_at: at("2026-10-19T09:20:00Z")
            }
        );
    }

    #[test]
    fn the_draw_spans_the_whole_interval() {
        let r = rig();
        r.random.0.lock().unwrap().push(true); // high end: 90 min
        r.scheduler.start();
        assert_eq!(
            r.scheduler.snapshot().next_at,
            Some(at("2026-10-19T10:30:00Z"))
        );

        // Real randomness stays inside [20, 90] min.
        for _ in 0..1000 {
            let s = ThreadRandom.between(20 * 60, 90 * 60);
            assert!((1200..=5400).contains(&s));
        }
    }

    #[test]
    fn eu_preset_is_45_to_120_minutes() {
        assert_eq!(
            SchedulePolicy::eu(),
            SchedulePolicy {
                min: Duration::minutes(45),
                max: Duration::minutes(120)
            }
        );
    }

    #[test]
    fn after_a_miss_the_next_one_comes_in_5_to_10_minutes() {
        let r = rig();
        r.scheduler.start();
        r.clock.advance(Duration::minutes(20));
        assert!(matches!(r.scheduler.poll(), Decision::Show { .. }));
        r.scheduler.finished(Outcome::Miss);
        assert_eq!(
            r.scheduler.snapshot().next_at,
            Some(at("2026-10-19T09:25:00Z"))
        );
        r.random.0.lock().unwrap().push(true);
        r.scheduler.finished(Outcome::Failed);
        assert_eq!(
            r.scheduler.snapshot().next_at,
            Some(at("2026-10-19T09:30:00Z"))
        );
    }

    #[test]
    fn a_call_defers_without_a_miss_and_shows_within_two_minutes_after() {
        let r = rig();
        r.scheduler.start();
        r.platform.update(|s| {
            s.call = CallState {
                camera: true,
                mic: true,
            }
        });
        r.clock.advance(Duration::minutes(20));
        assert_eq!(
            r.scheduler.poll(),
            Decision::Deferred(Deferral {
                due_at: at("2026-10-19T09:20:00Z"),
                reason: DeferralReason::Call
            })
        );
        r.clock.advance(Duration::minutes(40));
        assert_eq!(
            r.scheduler.poll(),
            Decision::Held(Hold::Deferred),
            "still in the call"
        );

        r.platform.update(|s| s.call = CallState::default());
        r.random.0.lock().unwrap().push(true); // show 120 s after the call ends
        assert_eq!(r.scheduler.poll(), Decision::Wait);
        r.clock.advance(Duration::seconds(119));
        assert_eq!(r.scheduler.poll(), Decision::Wait);
        r.clock.advance(Duration::seconds(1));
        assert_eq!(
            r.scheduler.poll(),
            Decision::Show {
                scheduled_at: at("2026-10-19T09:20:00Z")
            },
            "reported against its original time"
        );
    }

    #[test]
    fn screen_sharing_defers_too() {
        let r = rig();
        r.scheduler.start();
        r.platform
            .update(|s| s.screen_share = Some(ScreenShare::Sharing));
        r.clock.advance(Duration::minutes(20));
        assert!(matches!(r.scheduler.poll(), Decision::Deferred(_)));
        assert_eq!(r.scheduler.poll(), Decision::Held(Hold::Deferred));
    }

    fn due_with(r: &Rig, set: impl FnOnce(&mut crate::fake::FakeState)) -> Decision {
        r.scheduler.start();
        r.platform.update(set);
        r.clock.advance(Duration::minutes(20));
        r.scheduler.poll()
    }

    fn deferred(reason: DeferralReason) -> Decision {
        Decision::Deferred(Deferral {
            due_at: at("2026-10-19T09:20:00Z"),
            reason,
        })
    }

    #[test]
    fn the_deferral_names_what_held_it() {
        let call = CallState {
            camera: false,
            mic: true,
        };
        assert_eq!(
            due_with(&rig(), |s| s.call = call),
            deferred(DeferralReason::Call)
        );
        assert_eq!(
            due_with(&rig(), |s| s.screen_share = Some(ScreenShare::Sharing)),
            deferred(DeferralReason::ScreenShare)
        );
        assert_eq!(
            due_with(&rig(), |s| s.screen_share = Some(ScreenShare::Presenting)),
            deferred(DeferralReason::Presenting)
        );
        assert_eq!(
            due_with(&rig(), |s| {
                s.call = call;
                s.screen_share = Some(ScreenShare::Presenting);
            }),
            deferred(DeferralReason::Call),
            "a call wins when several apply"
        );
    }

    #[test]
    fn a_long_hold_is_reported_once() {
        let r = rig();
        r.scheduler.start();
        r.platform
            .update(|s| s.screen_share = Some(ScreenShare::Sharing));
        r.clock.advance(Duration::minutes(20));
        assert!(matches!(r.scheduler.poll(), Decision::Deferred(_)));
        for _ in 0..30 {
            r.clock.advance(Duration::minutes(1));
            assert_eq!(r.scheduler.poll(), Decision::Held(Hold::Deferred));
        }
        // The share ends and a call starts: still the same check-in.
        r.platform.update(|s| {
            s.screen_share = None;
            s.call.mic = true;
        });
        assert_eq!(r.scheduler.poll(), Decision::Held(Hold::Deferred));
    }

    #[test]
    fn a_lock_during_a_hold_does_not_report_again() {
        let r = rig();
        r.scheduler.start();
        r.platform.update(|s| s.call.mic = true);
        r.clock.advance(Duration::minutes(20));
        assert!(matches!(r.scheduler.poll(), Decision::Deferred(_)));
        r.platform.update(|s| s.session = SessionState::Locked);
        assert_eq!(r.scheduler.poll(), Decision::Held(Hold::Locked));
        r.platform.update(|s| s.session = SessionState::Active);
        assert_eq!(r.scheduler.poll(), Decision::Held(Hold::Deferred));
    }

    #[test]
    fn a_restart_during_a_hold_does_not_report_again() {
        let r = rig();
        r.scheduler.start();
        r.platform.update(|s| s.call.mic = true);
        r.clock.advance(Duration::minutes(20));
        assert!(matches!(r.scheduler.poll(), Decision::Deferred(_)));
        let restarted = Scheduler::new(
            SchedulePolicy::default(),
            r.clock.clone(),
            r.platform.clone(),
            r.random.clone(),
            r.store.clone(),
        );
        assert_eq!(restarted.poll(), Decision::Held(Hold::Deferred));
    }

    #[test]
    fn each_check_in_gets_its_own_deferral() {
        let r = rig();
        r.scheduler.start();
        r.platform.update(|s| s.call.mic = true);
        r.clock.advance(Duration::minutes(20));
        assert!(matches!(r.scheduler.poll(), Decision::Deferred(_)));
        r.platform.update(|s| s.call = CallState::default());
        assert!(matches!(r.scheduler.poll(), Decision::Show { .. }));
        r.scheduler.finished(Outcome::Pass);

        r.platform.update(|s| s.call.mic = true);
        r.clock.advance(Duration::minutes(20));
        assert_eq!(
            r.scheduler.poll(),
            Decision::Deferred(Deferral {
                due_at: at("2026-10-19T09:40:00Z"),
                reason: DeferralReason::Call
            })
        );
    }

    #[test]
    fn a_deferral_does_not_move_the_card() {
        // Recording the deferral changes nothing: the card still comes once the
        // call ends, against the original time (CHK-03).
        let r = rig();
        r.scheduler.start();
        r.platform.update(|s| s.call.mic = true);
        r.clock.advance(Duration::minutes(25));
        assert!(matches!(r.scheduler.poll(), Decision::Deferred(_)));
        r.platform.update(|s| s.call = CallState::default());
        assert_eq!(
            r.scheduler.poll(),
            Decision::Show {
                scheduled_at: at("2026-10-19T09:20:00Z")
            }
        );
    }

    #[test]
    fn locked_shows_nothing_and_unlock_brings_a_card_within_two_minutes() {
        let r = rig();
        r.scheduler.start();
        r.platform.update(|s| s.session = SessionState::Locked);
        r.clock.advance(Duration::minutes(25));
        assert_eq!(
            r.scheduler.poll(),
            Decision::Held(Hold::Locked),
            "a lock leaves no deferral"
        );
        r.platform.update(|s| s.session = SessionState::Active);
        // Random 0: shows at once on unlock.
        assert!(matches!(r.scheduler.poll(), Decision::Show { .. }));
    }

    #[test]
    fn cancel_drops_the_armed_checkin() {
        let r = rig();
        r.scheduler.start();
        r.scheduler.cancel();
        r.clock.advance(Duration::hours(3));
        assert_eq!(r.scheduler.poll(), Decision::Idle);
    }

    #[test]
    fn the_schedule_survives_a_restart() {
        let r = rig();
        r.scheduler.start();
        let armed = r.scheduler.snapshot().next_at;
        let restarted = Scheduler::new(
            SchedulePolicy::default(),
            r.clock.clone(),
            r.platform.clone(),
            r.random.clone(),
            r.store.clone(),
        );
        restarted.start(); // already armed: keeps the same time
        assert_eq!(restarted.snapshot().next_at, armed);
    }

    #[test]
    fn wake_in_lands_on_the_due_time() {
        let r = rig();
        r.scheduler.start();
        r.clock
            .advance(Duration::minutes(19) + Duration::seconds(30));
        assert_eq!(
            r.scheduler.wake_in(),
            Some(std::time::Duration::from_secs(30))
        );
    }

    #[test]
    fn the_status_shown_to_the_ui_has_no_schedule_in_it() {
        let status = crate::status::agent_status(
            &FakePlatform::default(),
            crate::contracts::ShiftState::Working,
            true,
            "0.1.0",
            crate::status::Tray::default(),
        );
        let json = serde_json::to_string(&status).unwrap();
        assert!(
            !json.contains("next") && !json.contains("schedul"),
            "{json}"
        );
    }
}
