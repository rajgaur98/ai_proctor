//! State changes sent as events the moment they happen (STS-01): idle, lock,
//! sleep and calls. A screen share or presentation counts as a call (STS rule 8):
//! it starts and ends `call_start`/`call_end` with its own source, so the server
//! stays In meeting until every source has ended. The heartbeat repeats the same state every 60 s; these events
//! let the live grid change within seconds (STS-03).
//!
//! Only while working: a break, a pause or clock-out collects nothing, and the
//! tracker starts clean when work resumes (the server resets presence on
//! clock-in too).

use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};

use crate::platform::{Platform, ScreenShare, SessionState};

/// Org default (`idle_threshold_min`), the same the server uses.
pub const DEFAULT_IDLE_THRESHOLD: Duration = Duration::minutes(10);

/// One event to queue: type, time and payload, per the agent-event contract.
#[derive(Clone, Debug, PartialEq)]
pub struct StateEvent {
    pub event_type: &'static str,
    pub at: DateTime<Utc>,
    pub payload: Value,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Reported {
    idle: bool,
    session: SessionStateKey,
    camera: bool,
    mic: bool,
    share: Option<ScreenShare>,
}

/// `SessionState` without the `Default` meaning drifting: Active until told.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum SessionStateKey {
    #[default]
    Active,
    Locked,
    Asleep,
}

impl From<SessionState> for SessionStateKey {
    fn from(s: SessionState) -> Self {
        match s {
            SessionState::Active => Self::Active,
            SessionState::Locked => Self::Locked,
            SessionState::Asleep => Self::Asleep,
        }
    }
}

#[derive(Debug)]
pub struct PresenceTracker {
    idle_threshold: Duration,
    reported: Reported,
}

impl Default for PresenceTracker {
    fn default() -> Self {
        Self {
            idle_threshold: DEFAULT_IDLE_THRESHOLD,
            reported: Reported::default(),
        }
    }
}

impl PresenceTracker {
    pub fn set_idle_threshold(&mut self, threshold: Duration) {
        self.idle_threshold = threshold;
    }

    /// Not working: forget what was reported, emit nothing.
    pub fn reset(&mut self) {
        self.reported = Reported::default();
    }

    /// Reads the platform and returns the events for whatever changed since the
    /// last call, in a stable order (session, idle, call starts, call ends).
    pub fn observe(&mut self, platform: &dyn Platform, now: DateTime<Utc>) -> Vec<StateEvent> {
        let idle_s = platform.idle_seconds();
        let call = platform.call_state();
        let current = Reported {
            idle: Duration::seconds(idle_s as i64) >= self.idle_threshold,
            session: platform.session_state().into(),
            camera: call.camera,
            mic: call.mic,
            share: platform.screen_share(),
        };
        let before = std::mem::replace(&mut self.reported, current);
        let mut events = Vec::new();
        let mut push = |event_type, payload| {
            events.push(StateEvent {
                event_type,
                at: now,
                payload,
            })
        };

        if before.session != current.session {
            // Leaving the old state first, so lock → sleep → wake reads naturally.
            match before.session {
                SessionStateKey::Locked => push("unlock", json!({})),
                SessionStateKey::Asleep => push("wake", json!({})),
                SessionStateKey::Active => {}
            }
            match current.session {
                SessionStateKey::Locked => push("lock", json!({})),
                SessionStateKey::Asleep => push("sleep", json!({})),
                SessionStateKey::Active => {}
            }
        }
        if before.idle != current.idle {
            if current.idle {
                let since = now - Duration::seconds(idle_s as i64);
                push("idle_start", json!({ "since": since }));
            } else {
                push("idle_end", json!({}));
            }
        }
        // Each source is its own call; the share is one source at a time, so a
        // switch between sharing and presenting is an end and a start.
        let sources = [
            ("camera", before.camera, current.camera),
            ("mic", before.mic, current.mic),
            (
                "screen_share",
                before.share == Some(ScreenShare::Sharing),
                current.share == Some(ScreenShare::Sharing),
            ),
            (
                "presenting",
                before.share == Some(ScreenShare::Presenting),
                current.share == Some(ScreenShare::Presenting),
            ),
        ];
        // Starts before ends, so a switch (share → presenting) never passes through
        // a moment with no call and leaves a zero-length Active period behind.
        for (event_type, starting) in [("call_start", true), ("call_end", false)] {
            for (source, was, is) in sources {
                if was != is && is == starting {
                    push(event_type, json!({ "source": source }));
                }
            }
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::FakePlatform;
    use crate::platform::{CallState, ScreenShare};

    fn t(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    fn types(events: &[StateEvent]) -> Vec<&str> {
        events.iter().map(|e| e.event_type).collect()
    }

    #[test]
    fn nothing_changes_nothing_is_sent() {
        let fake = FakePlatform::default();
        let mut p = PresenceTracker::default();
        assert!(p.observe(&fake, t("2026-10-20T10:00:00Z")).is_empty());
        assert!(p.observe(&fake, t("2026-10-20T10:00:05Z")).is_empty());
    }

    #[test]
    fn idle_starts_at_the_threshold_with_the_time_input_stopped() {
        let fake = FakePlatform::default();
        let mut p = PresenceTracker::default();
        fake.update(|s| s.idle_seconds = 599);
        assert!(p.observe(&fake, t("2026-10-20T10:00:00Z")).is_empty());
        fake.update(|s| s.idle_seconds = 605);
        let events = p.observe(&fake, t("2026-10-20T10:00:06Z"));
        assert_eq!(types(&events), ["idle_start"]);
        // 10:00:06 minus 605 s of no input.
        assert_eq!(events[0].payload["since"], "2026-10-20T09:50:01Z");
        fake.update(|s| s.idle_seconds = 2);
        assert_eq!(
            types(&p.observe(&fake, t("2026-10-20T10:01:00Z"))),
            ["idle_end"]
        );
    }

    #[test]
    fn the_org_threshold_applies() {
        let fake = FakePlatform::default();
        let mut p = PresenceTracker::default();
        p.set_idle_threshold(Duration::minutes(5));
        fake.update(|s| s.idle_seconds = 300);
        assert_eq!(
            types(&p.observe(&fake, t("2026-10-20T10:00:00Z"))),
            ["idle_start"]
        );
    }

    #[test]
    fn lock_sleep_wake_unlock() {
        let fake = FakePlatform::default();
        let mut p = PresenceTracker::default();
        fake.update(|s| s.session = SessionState::Locked);
        assert_eq!(
            types(&p.observe(&fake, t("2026-10-20T10:00:00Z"))),
            ["lock"]
        );
        fake.update(|s| s.session = SessionState::Asleep);
        assert_eq!(
            types(&p.observe(&fake, t("2026-10-20T10:00:05Z"))),
            ["unlock", "sleep"]
        );
        fake.update(|s| s.session = SessionState::Locked);
        assert_eq!(
            types(&p.observe(&fake, t("2026-10-20T11:00:00Z"))),
            ["wake", "lock"]
        );
        fake.update(|s| s.session = SessionState::Active);
        assert_eq!(
            types(&p.observe(&fake, t("2026-10-20T11:00:05Z"))),
            ["unlock"]
        );
    }

    #[test]
    fn camera_and_mic_are_separate_calls() {
        let fake = FakePlatform::default();
        let mut p = PresenceTracker::default();
        fake.update(|s| {
            s.call = CallState {
                camera: true,
                mic: true,
            }
        });
        let events = p.observe(&fake, t("2026-10-20T10:00:00Z"));
        assert_eq!(types(&events), ["call_start", "call_start"]);
        assert_eq!(events[0].payload["source"], "camera");
        assert_eq!(events[1].payload["source"], "mic");
        fake.update(|s| {
            s.call = CallState {
                camera: false,
                mic: true,
            }
        });
        let events = p.observe(&fake, t("2026-10-20T10:05:00Z"));
        assert_eq!(types(&events), ["call_end"]);
        assert_eq!(events[0].payload["source"], "camera");
    }

    #[test]
    fn a_screen_share_is_a_call_from_start_to_end() {
        let fake = FakePlatform::default();
        let mut p = PresenceTracker::default();
        fake.update(|s| s.screen_share = Some(ScreenShare::Sharing));
        let events = p.observe(&fake, t("2026-10-20T10:00:00Z"));
        assert_eq!(types(&events), ["call_start"]);
        assert_eq!(events[0].payload["source"], "screen_share");
        assert!(p.observe(&fake, t("2026-10-20T10:00:05Z")).is_empty());
        fake.update(|s| s.screen_share = None);
        let events = p.observe(&fake, t("2026-10-20T10:30:00Z"));
        assert_eq!(types(&events), ["call_end"]);
        assert_eq!(events[0].payload["source"], "screen_share");
    }

    #[test]
    fn a_presentation_is_a_call_of_its_own_source() {
        let fake = FakePlatform::default();
        let mut p = PresenceTracker::default();
        fake.update(|s| s.screen_share = Some(ScreenShare::Presenting));
        let events = p.observe(&fake, t("2026-10-20T10:00:00Z"));
        assert_eq!(types(&events), ["call_start"]);
        assert_eq!(events[0].payload["source"], "presenting");
        fake.update(|s| s.screen_share = None);
        let events = p.observe(&fake, t("2026-10-20T10:10:00Z"));
        assert_eq!(types(&events), ["call_end"]);
        assert_eq!(events[0].payload["source"], "presenting");
    }

    #[test]
    fn switching_from_sharing_to_presenting_starts_before_it_ends() {
        let fake = FakePlatform::default();
        let mut p = PresenceTracker::default();
        fake.update(|s| s.screen_share = Some(ScreenShare::Sharing));
        p.observe(&fake, t("2026-10-20T10:00:00Z"));
        fake.update(|s| s.screen_share = Some(ScreenShare::Presenting));
        let events = p.observe(&fake, t("2026-10-20T10:05:00Z"));
        assert_eq!(types(&events), ["call_start", "call_end"]);
        assert_eq!(events[0].payload["source"], "presenting");
        assert_eq!(events[1].payload["source"], "screen_share");
    }

    #[test]
    fn a_call_and_a_share_overlap_as_separate_sources() {
        let fake = FakePlatform::default();
        let mut p = PresenceTracker::default();
        fake.update(|s| s.call.mic = true);
        assert_eq!(
            types(&p.observe(&fake, t("2026-10-20T10:00:00Z"))),
            ["call_start"]
        );
        // The share starts while the mic is open, the mic closes first: the share
        // alone keeps the meeting going, so only the mic's end is reported.
        fake.update(|s| s.screen_share = Some(ScreenShare::Sharing));
        let events = p.observe(&fake, t("2026-10-20T10:05:00Z"));
        assert_eq!(types(&events), ["call_start"]);
        assert_eq!(events[0].payload["source"], "screen_share");
        fake.update(|s| s.call.mic = false);
        let events = p.observe(&fake, t("2026-10-20T10:20:00Z"));
        assert_eq!(types(&events), ["call_end"]);
        assert_eq!(events[0].payload["source"], "mic");
        fake.update(|s| s.screen_share = None);
        let events = p.observe(&fake, t("2026-10-20T10:25:00Z"));
        assert_eq!(types(&events), ["call_end"]);
        assert_eq!(events[0].payload["source"], "screen_share");
    }

    #[test]
    fn a_share_running_after_a_reset_is_reported_again() {
        let fake = FakePlatform::default();
        let mut p = PresenceTracker::default();
        fake.update(|s| s.screen_share = Some(ScreenShare::Sharing));
        p.observe(&fake, t("2026-10-20T10:00:00Z"));
        p.reset();
        assert_eq!(
            types(&p.observe(&fake, t("2026-10-20T10:20:00Z"))),
            ["call_start"]
        );
    }

    #[test]
    fn after_a_reset_current_state_is_reported_again() {
        let fake = FakePlatform::default();
        let mut p = PresenceTracker::default();
        fake.update(|s| {
            s.call = CallState {
                camera: false,
                mic: true,
            }
        });
        assert_eq!(
            types(&p.observe(&fake, t("2026-10-20T10:00:00Z"))),
            ["call_start"]
        );
        // A break: the server shows On break; on return the call is reported fresh.
        p.reset();
        assert_eq!(
            types(&p.observe(&fake, t("2026-10-20T10:20:00Z"))),
            ["call_start"]
        );
    }
}
