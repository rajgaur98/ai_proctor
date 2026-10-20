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

use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde_json::{json, Value};

use crate::outbox::Outbox;

/// How often the last-alive time is written (every write is a synced commit).
pub const ALIVE_EVERY: Duration = Duration::seconds(15);

const LAST_ALIVE: &str = "last_alive";
const CLEAN_EXIT: &str = "clean_exit";

/// How the previous run ended, as the contract names it (`agent_restart.reason`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestartReason {
    /// It stopped without exiting normally: a kill, a crash.
    Killed,
    /// It exited normally (the OS asked it to quit, or a logout).
    Exited,
    /// The device started up again since the last-alive time.
    Rebooted,
}

impl RestartReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Killed => "killed",
            Self::Exited => "exited",
            Self::Rebooted => "rebooted",
        }
    }
}

/// What the previous run left in the store.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviousRun {
    pub last_alive_at: DateTime<Utc>,
    pub clean_exit: bool,
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
        } else if previous.clean_exit {
            RestartReason::Exited
        } else {
            RestartReason::Killed
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
                clean_exit: outbox.state(CLEAN_EXIT).ok().flatten().as_deref() == Some("1"),
            });
        let liveness = Self {
            outbox,
            last_beat: Mutex::new(None),
        };
        liveness.write(now, false);
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
        self.write(now, false);
    }

    /// A normal exit: the next run reads it as `exited`, not `killed`.
    pub fn exited(&self, now: DateTime<Utc>) {
        self.write(now, true);
    }

    fn write(&self, now: DateTime<Utc>, clean: bool) {
        *self.last_beat.lock().unwrap() = Some(now);
        let result = self
            .outbox
            .set_state(
                LAST_ALIVE,
                &now.to_rfc3339_opts(SecondsFormat::Millis, true),
            )
            .and_then(|()| {
                self.outbox
                    .set_state(CLEAN_EXIT, if clean { "1" } else { "0" })
            });
        if let Err(error) = result {
            tracing::error!(%error, "last-alive time not saved");
        }
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
            clean_exit: false,
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
}
