//! Local evidence for ANT-01. A killed agent can't say it was killed, so while it
//! runs it keeps a last-alive time in the encrypted store, plus a flag that a normal
//! exit sets. The next run (the watchdog starts one within seconds) compares them
//! with the clock and the device's boot time and reports an `agent_restart` event
//! saying how the previous run ended. The server turns a `killed` gap during
//! clock-in into Tamper (needs review, never a penalty, ANT-08); the agent only
//! reports what it saw.
//!
//! No network involved: an agent that is running but offline keeps writing
//! last-alive, never restarts, and reports nothing here. That is how the server tells
//! "offline" from "killed".
//!
//! A logout, restart or shutdown is not a kill (#159). The OS announces it first, the
//! agent clocks the person out and marks the run as ended by the session, so the gap
//! that follows is never Tamper. A quit that did not come with that announcement
//! (an Apple Event, `osascript`) while clocked in is the same act as stopping the
//! agent from the tray, which is refused, so it counts as a kill: see `classify_exit`.

use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde_json::{json, Value};

use crate::outbox::Outbox;

/// How often the last-alive time is written (every write is a synced commit).
pub const ALIVE_EVERY: Duration = Duration::seconds(15);

const LAST_ALIVE: &str = "last_alive";
const CLEAN_EXIT: &str = "clean_exit";
/// `CLEAN_EXIT` values: a plain normal exit, and one the OS asked for (logout,
/// restart, shutdown). Anything else is no exit at all.
const EXITED: &str = "1";
const SESSION_END: &str = "session_end";

/// How long an announced session end stays valid. A logout another app cancels
/// leaves the agent running; a quit this much later is not part of it.
pub const SESSION_END_VALID_FOR: Duration = Duration::minutes(5);

/// How the previous run ended, as the contract names it (`agent_restart.reason`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestartReason {
    /// It stopped without exiting normally: a kill, a crash.
    Killed,
    /// It exited normally (a planned restart, or a quit while off shift).
    Exited,
    /// The OS ended the session (logout, restart, shutdown) and the agent said so
    /// before it went.
    SessionEnd,
    /// The device started up again since the last-alive time.
    Rebooted,
}

impl RestartReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Killed => "killed",
            Self::Exited => "exited",
            Self::SessionEnd => "session_end",
            Self::Rebooted => "rebooted",
        }
    }
}

/// How the previous run ended, as far as it could say.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ended {
    /// It never marked an exit.
    Abruptly,
    Exited,
    SessionEnd,
}

/// What the previous run left in the store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviousRun {
    pub last_alive_at: DateTime<Utc>,
    pub ended: Ended,
}

/// The `agent_restart` event for a run that follows `previous`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestartReport {
    pub last_alive_at: DateTime<Utc>,
    pub reason: RestartReason,
}

impl RestartReport {
    pub fn new(previous: &PreviousRun, boot_time: Option<DateTime<Utc>>) -> Self {
        let reason = if boot_time.is_some_and(|boot| boot > previous.last_alive_at) {
            RestartReason::Rebooted
        } else {
            match previous.ended {
                Ended::SessionEnd => RestartReason::SessionEnd,
                Ended::Exited => RestartReason::Exited,
                Ended::Abruptly => RestartReason::Killed,
            }
        };
        Self {
            last_alive_at: previous.last_alive_at,
            reason,
        }
    }

    /// The event payload (packages/contracts/src/events.ts `agent_restart`).
    pub fn payload(&self) -> Value {
        json!({
            "last_alive_at": self.last_alive_at.to_rfc3339_opts(SecondsFormat::Millis, true),
            "reason": self.reason.as_str(),
        })
    }
}

pub struct Liveness {
    outbox: Arc<Outbox>,
    last_beat: Mutex<Option<DateTime<Utc>>>,
}

impl Liveness {
    /// Reads what the previous run left behind, then marks this run as started
    /// (not exited) with `now` as its first sign of life.
    pub fn start(outbox: Arc<Outbox>, now: DateTime<Utc>) -> (Self, Option<PreviousRun>) {
        let previous = outbox
            .state(LAST_ALIVE)
            .ok()
            .flatten()
            .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
            .map(|t| PreviousRun {
                last_alive_at: t.with_timezone(&Utc),
                ended: match outbox.state(CLEAN_EXIT).ok().flatten().as_deref() {
                    Some(EXITED) => Ended::Exited,
                    Some(SESSION_END) => Ended::SessionEnd,
                    _ => Ended::Abruptly,
                },
            });
        let liveness = Self {
            outbox,
            last_beat: Mutex::new(None),
        };
        liveness.write(now, None);
        (liveness, previous)
    }

    /// Call often; writes at most every `ALIVE_EVERY`.
    pub fn beat(&self, now: DateTime<Utc>) {
        {
            let mut last = self.last_beat.lock().unwrap();
            if last.is_some_and(|t| now - t < ALIVE_EVERY && now >= t) {
                return;
            }
            *last = Some(now);
        }
        self.write(now, None);
    }

    /// A normal exit: the next run reads it as `exited`, not `killed`.
    pub fn exited(&self, now: DateTime<Utc>) {
        self.write(now, Some(EXITED));
    }

    /// The OS is ending the session (logout, restart, shutdown): the next run reads
    /// it as `session_end`, never `killed` (#159).
    pub fn session_ended(&self, now: DateTime<Utc>) {
        self.write(now, Some(SESSION_END));
    }

    fn write(&self, now: DateTime<Utc>, exit: Option<&str>) {
        *self.last_beat.lock().unwrap() = Some(now);
        let result = self
            .outbox
            .set_state(
                LAST_ALIVE,
                &now.to_rfc3339_opts(SecondsFormat::Millis, true),
            )
            .and_then(|()| self.outbox.set_state(CLEAN_EXIT, exit.unwrap_or("0")));
        if let Err(error) = result {
            tracing::error!(%error, "last-alive time not saved");
        }
    }
}

/// How a run that is exiting counts. Only an exit that reaches the app's exit event
/// is classified; a kill never does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitKind {
    /// Off shift, or a restart the agent asked for itself: marked `exited`, exit 0.
    Normal,
    /// The OS announced a logout, restart or shutdown (#159): marked `session_end`,
    /// exit 0 so the watchdog does not start a new run in a session that is going.
    SessionEnd,
    /// A quit while clocked in that nothing announced: an Apple Event or `osascript`
    /// quit on macOS, a window close on Windows. The tray refuses Quit mid-shift
    /// because stopping the agent then is what Tamper (ANT-01) is for, so this is
    /// not marked and the exit is non-zero: the watchdog starts the agent again and
    /// the next run reports `killed`. Needs review, never a penalty (ANT-08).
    Interrupted,
}

/// What an exit counts as. `planned`: the agent is exiting on purpose (the restart
/// for a new permission). `session_end_at`: when the OS announced the end of the
/// session, if it did; it only counts for `SESSION_END_VALID_FOR`.
pub fn classify_exit(
    on_shift: bool,
    planned: bool,
    session_end_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> ExitKind {
    if session_end_at.is_some_and(|at| now - at < SESSION_END_VALID_FOR) {
        ExitKind::SessionEnd
    } else if planned || !on_shift {
        ExitKind::Normal
    } else {
        ExitKind::Interrupted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    fn outbox(dir: &std::path::Path) -> Arc<Outbox> {
        Arc::new(Outbox::open(dir, &[5u8; 32]).unwrap())
    }

    #[test]
    fn the_first_run_has_no_previous_run() {
        let dir = tempfile::tempdir().unwrap();
        let (_, previous) = Liveness::start(outbox(dir.path()), t("2026-10-20T09:00:00Z"));
        assert_eq!(previous, None);
    }

    #[test]
    fn a_run_that_never_exited_is_reported_killed_with_its_last_sign_of_life() {
        let dir = tempfile::tempdir().unwrap();
        {
            let (alive, _) = Liveness::start(outbox(dir.path()), t("2026-10-20T09:00:00Z"));
            alive.beat(t("2026-10-20T09:00:20Z"));
            alive.beat(t("2026-10-20T09:00:40Z"));
            // killed here
        }
        let (_, previous) = Liveness::start(outbox(dir.path()), t("2026-10-20T09:05:00Z"));
        let previous = previous.unwrap();
        assert_eq!(previous.last_alive_at, t("2026-10-20T09:00:40Z"));
        let report = RestartReport::new(&previous, None);
        assert_eq!(report.reason, RestartReason::Killed);
        assert_eq!(
            report.payload(),
            json!({ "last_alive_at": "2026-10-20T09:00:40.000Z", "reason": "killed" })
        );
    }

    #[test]
    fn a_normal_exit_is_reported_exited() {
        let dir = tempfile::tempdir().unwrap();
        {
            let (alive, _) = Liveness::start(outbox(dir.path()), t("2026-10-20T09:00:00Z"));
            alive.exited(t("2026-10-20T09:10:00Z"));
        }
        let (_, previous) = Liveness::start(outbox(dir.path()), t("2026-10-20T09:11:00Z"));
        let report = RestartReport::new(&previous.unwrap(), None);
        assert_eq!(report.reason, RestartReason::Exited);
        assert_eq!(report.last_alive_at, t("2026-10-20T09:10:00Z"));
    }

    #[test]
    fn a_run_after_a_normal_exit_that_is_then_killed_is_killed_again() {
        let dir = tempfile::tempdir().unwrap();
        {
            let (alive, _) = Liveness::start(outbox(dir.path()), t("2026-10-20T09:00:00Z"));
            alive.exited(t("2026-10-20T09:10:00Z"));
        }
        {
            // The next run starts and is killed: the old "exited" must not linger.
            let (_, _) = Liveness::start(outbox(dir.path()), t("2026-10-20T09:11:00Z"));
        }
        let (_, previous) = Liveness::start(outbox(dir.path()), t("2026-10-20T09:20:00Z"));
        assert_eq!(
            RestartReport::new(&previous.unwrap(), None).reason,
            RestartReason::Killed
        );
    }

    #[test]
    fn a_device_that_started_up_since_is_rebooted_not_killed() {
        let previous = PreviousRun {
            last_alive_at: t("2026-10-20T17:00:00Z"),
            ended: Ended::Abruptly,
        };
        let boot = Some(t("2026-10-21T08:30:00Z"));
        assert_eq!(
            RestartReport::new(&previous, boot).reason,
            RestartReason::Rebooted
        );
        // Booted long before the last sign of life: the kill stands.
        let boot = Some(t("2026-10-19T08:30:00Z"));
        assert_eq!(
            RestartReport::new(&previous, boot).reason,
            RestartReason::Killed
        );
    }

    #[test]
    fn writes_are_spaced_out() {
        let dir = tempfile::tempdir().unwrap();
        let store = outbox(dir.path());
        let (alive, _) = Liveness::start(store.clone(), t("2026-10-20T09:00:00Z"));
        alive.beat(t("2026-10-20T09:00:05Z"));
        alive.beat(t("2026-10-20T09:00:10Z"));
        assert_eq!(
            store.state(LAST_ALIVE).unwrap().as_deref(),
            Some("2026-10-20T09:00:00.000Z"),
            "inside the interval: not written"
        );
        alive.beat(t("2026-10-20T09:00:15Z"));
        assert_eq!(
            store.state(LAST_ALIVE).unwrap().as_deref(),
            Some("2026-10-20T09:00:15.000Z")
        );
    }

    #[test]
    fn a_clock_set_back_still_writes() {
        let dir = tempfile::tempdir().unwrap();
        let store = outbox(dir.path());
        let (alive, _) = Liveness::start(store.clone(), t("2026-10-20T09:00:00Z"));
        alive.beat(t("2026-10-20T08:00:00Z"));
        assert_eq!(
            store.state(LAST_ALIVE).unwrap().as_deref(),
            Some("2026-10-20T08:00:00.000Z")
        );
    }

    #[test]
    fn a_session_end_is_reported_as_session_end_not_killed() {
        let dir = tempfile::tempdir().unwrap();
        {
            let (alive, _) = Liveness::start(outbox(dir.path()), t("2026-10-20T09:00:00Z"));
            alive.session_ended(t("2026-10-20T17:00:00Z"));
        }
        let (_, previous) = Liveness::start(outbox(dir.path()), t("2026-10-21T08:00:00Z"));
        let report = RestartReport::new(&previous.unwrap(), None);
        assert_eq!(report.reason, RestartReason::SessionEnd);
        assert_eq!(
            report.payload(),
            json!({ "last_alive_at": "2026-10-20T17:00:00.000Z", "reason": "session_end" })
        );
    }

    #[test]
    fn a_shutdown_followed_by_a_boot_is_rebooted() {
        let previous = PreviousRun {
            last_alive_at: t("2026-10-20T17:00:00Z"),
            ended: Ended::SessionEnd,
        };
        let boot = Some(t("2026-10-21T08:30:00Z"));
        assert_eq!(
            RestartReport::new(&previous, boot).reason,
            RestartReason::Rebooted
        );
    }

    #[test]
    fn a_session_end_does_not_linger_into_the_next_run() {
        let dir = tempfile::tempdir().unwrap();
        {
            let (alive, _) = Liveness::start(outbox(dir.path()), t("2026-10-20T09:00:00Z"));
            alive.session_ended(t("2026-10-20T17:00:00Z"));
        }
        {
            let (_, _) = Liveness::start(outbox(dir.path()), t("2026-10-21T08:00:00Z"));
        }
        let (_, previous) = Liveness::start(outbox(dir.path()), t("2026-10-21T09:00:00Z"));
        assert_eq!(previous.unwrap().ended, Ended::Abruptly);
    }

    const NOW: &str = "2026-10-20T17:00:00Z";

    #[test]
    fn a_logout_while_clocked_in_is_a_session_end() {
        let announced = Some(t("2026-10-20T16:59:59Z"));
        assert_eq!(
            classify_exit(true, false, announced, t(NOW)),
            ExitKind::SessionEnd
        );
    }

    #[test]
    fn a_session_end_wins_over_a_planned_exit() {
        let announced = Some(t(NOW));
        assert_eq!(
            classify_exit(true, true, announced, t(NOW)),
            ExitKind::SessionEnd
        );
    }

    #[test]
    fn a_quit_while_clocked_in_that_nothing_announced_is_interrupted() {
        assert_eq!(
            classify_exit(true, false, None, t(NOW)),
            ExitKind::Interrupted
        );
    }

    #[test]
    fn a_cancelled_logout_does_not_excuse_a_later_quit() {
        let announced = Some(t("2026-10-20T16:50:00Z"));
        assert_eq!(
            classify_exit(true, false, announced, t(NOW)),
            ExitKind::Interrupted,
            "ten minutes on, the announcement has expired"
        );
    }

    #[test]
    fn a_quit_off_shift_or_a_planned_restart_is_normal() {
        assert_eq!(classify_exit(false, false, None, t(NOW)), ExitKind::Normal);
        assert_eq!(classify_exit(true, true, None, t(NOW)), ExitKind::Normal);
    }
}
