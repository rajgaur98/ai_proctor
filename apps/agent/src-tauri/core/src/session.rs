//! Shift state machine (LLD 02; SHF-02..05, BRK-01/03/05). It decides whether
//! anything is collected at all: check-ins, captures and activity sampling run only
//! while `Working` and the screen is unlocked. Every transition is written to the
//! outbox as an event; the server enforces the same machine.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::clock::Clock;
use crate::contracts::ShiftState;
use crate::outbox::Outbox;
use crate::platform::{Platform, SessionState};
use crate::shift::{self, Shift};

/// Org settings the machine needs (from the cached policy).
#[derive(Clone, Debug, PartialEq)]
pub struct SessionPolicy {
    /// SHF-03: clock in automatically on first input inside the shift window.
    pub auto_clock_in: bool,
    /// SHF-04: minutes without input after shift end before auto clock-out.
    pub forgotten_clock_out_after: Duration,
    pub shifts: Vec<Shift>,
    /// The employee's time zone, for "today".
    pub timezone: chrono_tz::Tz,
}

impl Default for SessionPolicy {
    fn default() -> Self {
        Self {
            auto_clock_in: false,
            forgotten_clock_out_after: Duration::minutes(30),
            shifts: Vec::new(),
            timezone: chrono_tz::UTC,
        }
    }
}

/// Input within this many seconds counts as "the user just did something".
const RECENT_INPUT_S: u64 = 60;

/// Pause presets (BRK-03).
pub const PAUSE_PRESETS: [u32; 3] = [5, 10, 15];
/// Break presets (BRK-01); `None` is open-ended.
pub const BREAK_PRESETS: [u32; 3] = [15, 30, 60];

/// What survives a restart.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub signed_in: bool,
    pub shift: ShiftPhase,
    pub clocked_in_at: Option<DateTime<Utc>>,
    pub project_id: Option<Uuid>,
    pub pause_until: Option<DateTime<Utc>>,
    /// When the current phase (working, break, pause) began.
    #[serde(default)]
    pub phase_started_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub pause_planned_min: Option<u32>,
    #[serde(default)]
    pub today: DayTally,
}

/// Closed time for the tray's "Time today" and pause allowance (EMP-01). For
/// display only: the timesheet is computed on the server (#40, #41).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DayTally {
    /// The employee-local day these totals belong to.
    pub date: Option<chrono::NaiveDate>,
    /// Working and pause time (pauses count as worked within the cap; breaks don't).
    pub worked_s: i64,
    pub pause_s: i64,
}

/// What the tray shows for today, open phase included.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Today {
    pub worked_s: i64,
    pub pause_s: i64,
}

/// Serializable mirror of `ShiftState` (the contract type has no `Default`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShiftPhase {
    #[default]
    OffShift,
    Working,
    OnBreak,
    Paused,
}

impl From<ShiftPhase> for ShiftState {
    fn from(s: ShiftPhase) -> Self {
        match s {
            ShiftPhase::OffShift => ShiftState::OffShift,
            ShiftPhase::Working => ShiftState::Working,
            ShiftPhase::OnBreak => ShiftState::OnBreak,
            ShiftPhase::Paused => ShiftState::Paused,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum TransitionError {
    #[error("not signed in")]
    NotSignedIn,
    #[error("already clocked in")]
    AlreadyClockedIn,
    #[error("the monitoring notice hasn't been acknowledged yet")]
    NoticeNotAcknowledged,
    #[error("not clocked in")]
    NotClockedIn,
    #[error("on a break")]
    OnBreak,
    #[error("paused")]
    Paused,
    #[error("not on a break")]
    NotOnBreak,
    #[error("not paused")]
    NotPaused,
    #[error("not a preset: {0} min")]
    InvalidDuration(u32),
    #[error("could not record the event: {0}")]
    Sink(String),
}

/// Where transition events go. Production: the outbox.
pub trait EventSink: Send + Sync {
    fn emit(
        &self,
        event_type: &str,
        at: DateTime<Utc>,
        payload: serde_json::Value,
    ) -> Result<(), String>;
}

/// Writes transition events to the outbox with the clock's monotonic time.
pub struct OutboxSink {
    pub outbox: Arc<Outbox>,
    pub clock: Arc<dyn Clock>,
}

impl EventSink for OutboxSink {
    fn emit(
        &self,
        event_type: &str,
        at: DateTime<Utc>,
        payload: serde_json::Value,
    ) -> Result<(), String> {
        self.outbox
            .append(
                event_type,
                at,
                self.clock.mono_ms(),
                payload,
                self.clock.now(),
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

/// Where the snapshot is kept between runs.
pub trait SessionStore: Send + Sync {
    fn load(&self) -> Option<SessionSnapshot>;
    fn save(&self, snapshot: &SessionSnapshot);
}

/// JSON file, replaced atomically.
pub struct FileSessionStore {
    path: PathBuf,
}

impl FileSessionStore {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join("session.json"),
        }
    }
}

impl SessionStore for FileSessionStore {
    fn load(&self) -> Option<SessionSnapshot> {
        let text = std::fs::read_to_string(&self.path).ok()?;
        serde_json::from_str(&text)
            .inspect_err(
                |e| tracing::error!(error = %e, "session file unreadable; starting clocked out"),
            )
            .ok()
    }

    fn save(&self, snapshot: &SessionSnapshot) {
        let tmp = self.path.with_extension("json.tmp");
        let result = serde_json::to_vec(snapshot)
            .map_err(std::io::Error::other)
            .and_then(|bytes| std::fs::write(&tmp, bytes))
            .and_then(|()| std::fs::rename(&tmp, &self.path));
        if let Err(e) = result {
            tracing::error!(error = %e, "could not save the session");
        }
    }
}

pub struct Session {
    state: SessionSnapshot,
    policy: SessionPolicy,
    clock: Arc<dyn Clock>,
    platform: Arc<dyn Platform>,
    sink: Arc<dyn EventSink>,
    store: Arc<dyn SessionStore>,
    /// AGT-04: false until the person has acknowledged a monitoring notice; nobody
    /// can clock in (by hand or automatically) while it is. Not saved: the app
    /// sets it from the server's config after every launch.
    collection_allowed: bool,
}

impl Session {
    pub fn new(
        policy: SessionPolicy,
        clock: Arc<dyn Clock>,
        platform: Arc<dyn Platform>,
        sink: Arc<dyn EventSink>,
        store: Arc<dyn SessionStore>,
    ) -> Self {
        let state = store.load().unwrap_or_default();
        Self {
            state,
            policy,
            clock,
            platform,
            sink,
            store,
            collection_allowed: true,
        }
    }

    pub fn shift(&self) -> ShiftState {
        self.state.shift.into()
    }

    pub fn signed_in(&self) -> bool {
        self.state.signed_in
    }

    pub fn project_id(&self) -> Option<Uuid> {
        self.state.project_id
    }

    pub fn set_policy(&mut self, policy: SessionPolicy) {
        self.policy = policy;
    }

    /// AGT-04: whether a monitoring notice has been acknowledged. Clocking out and
    /// everything else on a shift already under way is unaffected.
    pub fn set_collection_allowed(&mut self, allowed: bool) {
        self.collection_allowed = allowed;
    }

    /// SHF-05: check-ins, captures and activity sampling run only while working
    /// and the screen is unlocked and awake.
    pub fn collecting(&self) -> bool {
        self.state.shift == ShiftPhase::Working
            && self.platform.session_state() == SessionState::Active
    }

    pub fn sign_in(&mut self) {
        self.state.signed_in = true;
        self.save();
    }

    /// Signing out (or being revoked) ends the shift.
    pub fn sign_out(&mut self) -> Result<(), TransitionError> {
        if self.state.shift != ShiftPhase::OffShift {
            self.clock_out_at(self.clock.now(), "auto")?;
        }
        self.state.signed_in = false;
        self.save();
        Ok(())
    }

    /// SHF-02: clock in from the tray, optionally on a project.
    pub fn clock_in(&mut self, project_id: Option<Uuid>) -> Result<(), TransitionError> {
        self.clock_in_with(project_id, "manual")
    }

    pub fn clock_out(&mut self) -> Result<(), TransitionError> {
        self.require_clocked_in()?;
        self.clock_out_at(self.clock.now(), "manual")
    }

    pub fn start_break(&mut self, planned_min: Option<u32>) -> Result<(), TransitionError> {
        self.require_working()?;
        if let Some(min) = planned_min.filter(|m| !BREAK_PRESETS.contains(m)) {
            return Err(TransitionError::InvalidDuration(min));
        }
        self.emit("break_start", json!({ "planned_min": planned_min }))?;
        self.enter(ShiftPhase::OnBreak, self.clock.now());
        self.save();
        Ok(())
    }

    pub fn end_break(&mut self) -> Result<(), TransitionError> {
        if self.state.shift != ShiftPhase::OnBreak {
            return Err(TransitionError::NotOnBreak);
        }
        self.emit("break_end", json!({}))?;
        self.enter(ShiftPhase::Working, self.clock.now());
        self.save();
        Ok(())
    }

    /// BRK-03: pause for a preset; extending is a new pause (BRK-05). The
    /// optional reason stays private to the employee on the server.
    pub fn start_pause(&mut self, minutes: u32) -> Result<(), TransitionError> {
        self.start_pause_with_reason(minutes, None)
    }

    pub fn start_pause_with_reason(
        &mut self,
        minutes: u32,
        reason: Option<&str>,
    ) -> Result<(), TransitionError> {
        if self.state.shift == ShiftPhase::Paused {
            self.end_pause()?;
        }
        self.require_working()?;
        if !PAUSE_PRESETS.contains(&minutes) {
            return Err(TransitionError::InvalidDuration(minutes));
        }
        let mut payload = json!({ "planned_min": minutes });
        if let Some(reason) = reason.map(str::trim).filter(|r| !r.is_empty()) {
            payload["reason"] = json!(reason.chars().take(200).collect::<String>());
        }
        self.emit("pause_start", payload)?;
        let now = self.clock.now();
        self.enter(ShiftPhase::Paused, now);
        self.state.pause_until = Some(now + Duration::minutes(minutes.into()));
        self.state.pause_planned_min = Some(minutes);
        self.save();
        Ok(())
    }

    pub fn end_pause(&mut self) -> Result<(), TransitionError> {
        if self.state.shift != ShiftPhase::Paused {
            return Err(TransitionError::NotPaused);
        }
        self.emit("pause_end", json!({}))?;
        self.enter(ShiftPhase::Working, self.clock.now());
        self.state.pause_until = None;
        self.state.pause_planned_min = None;
        self.save();
        Ok(())
    }

    pub fn switch_project(&mut self, project_id: Option<Uuid>) -> Result<(), TransitionError> {
        self.require_clocked_in()?;
        self.emit("project_switch", json!({ "project_id": project_id }))?;
        self.state.project_id = project_id;
        self.save();
        Ok(())
    }

    /// Runs the time-driven rules; call every few seconds.
    pub fn tick(&mut self) -> Result<(), TransitionError> {
        if !self.state.signed_in {
            return Ok(());
        }
        let now = self.clock.now();
        match self.state.shift {
            ShiftPhase::OffShift => self.maybe_auto_clock_in(now),
            ShiftPhase::Paused if self.state.pause_until.is_some_and(|until| now >= until) => {
                // BRK-05: auto-resume at the end, with a notification.
                self.end_pause()?;
                self.platform.notify("Pause over", "You're back at work.");
                Ok(())
            }
            _ => self.maybe_forgotten_clock_out(now),
        }
    }

    fn maybe_auto_clock_in(&mut self, now: DateTime<Utc>) -> Result<(), TransitionError> {
        if !self.policy.auto_clock_in
            || !self.collection_allowed
            || shift::window_containing(&self.policy.shifts, now).is_none()
            || self.platform.idle_seconds() > RECENT_INPUT_S
        {
            return Ok(());
        }
        self.clock_in_with(None, "auto")?;
        self.platform.notify(
            "Clocked in",
            "Your shift has started, so AI Proctor clocked you in.",
        );
        Ok(())
    }

    /// SHF-04: no input for the configured time after shift end → clock out at the
    /// last activity time (the server flags the day via reason "auto").
    fn maybe_forgotten_clock_out(&mut self, now: DateTime<Utc>) -> Result<(), TransitionError> {
        let Some(clocked_in_at) = self.state.clocked_in_at else {
            return Ok(());
        };
        if shift::window_containing(&self.policy.shifts, now).is_some() {
            return Ok(());
        }
        let Some(shift_end) = shift::last_end_before(&self.policy.shifts, now) else {
            return Ok(());
        };
        let idle = Duration::seconds(self.platform.idle_seconds() as i64);
        let last_activity = (now - idle).max(clocked_in_at);
        if shift_end <= clocked_in_at
            || now - shift_end.max(last_activity) < self.policy.forgotten_clock_out_after
        {
            return Ok(());
        }
        tracing::info!(%last_activity, "forgotten clock-out; clocking out at last activity");
        self.clock_out_at(last_activity, "auto")
    }

    fn clock_in_with(
        &mut self,
        project_id: Option<Uuid>,
        reason: &str,
    ) -> Result<(), TransitionError> {
        if !self.state.signed_in {
            return Err(TransitionError::NotSignedIn);
        }
        if self.state.shift != ShiftPhase::OffShift {
            return Err(TransitionError::AlreadyClockedIn);
        }
        if !self.collection_allowed {
            return Err(TransitionError::NoticeNotAcknowledged);
        }
        self.emit(
            "clock_in",
            json!({ "project_id": project_id, "reason": reason }),
        )?;
        let now = self.clock.now();
        self.enter(ShiftPhase::Working, now);
        self.state.clocked_in_at = Some(now);
        self.state.project_id = project_id;
        self.save();
        Ok(())
    }

    fn clock_out_at(&mut self, at: DateTime<Utc>, reason: &str) -> Result<(), TransitionError> {
        self.sink
            .emit("clock_out", at, json!({ "reason": reason }))
            .map_err(TransitionError::Sink)?;
        self.enter(ShiftPhase::OffShift, at);
        self.state.clocked_in_at = None;
        self.state.pause_until = None;
        self.state.pause_planned_min = None;
        self.save();
        Ok(())
    }

    fn require_clocked_in(&self) -> Result<(), TransitionError> {
        if !self.state.signed_in {
            return Err(TransitionError::NotSignedIn);
        }
        if self.state.shift == ShiftPhase::OffShift {
            return Err(TransitionError::NotClockedIn);
        }
        Ok(())
    }

    fn require_working(&self) -> Result<(), TransitionError> {
        self.require_clocked_in()?;
        match self.state.shift {
            ShiftPhase::OnBreak => Err(TransitionError::OnBreak),
            ShiftPhase::Paused => Err(TransitionError::Paused),
            _ => Ok(()),
        }
    }

    /// Closes the current phase into today's tally and starts `phase` at `at`.
    fn enter(&mut self, phase: ShiftPhase, at: DateTime<Utc>) {
        self.add_to_tally(at);
        self.state.shift = phase;
        self.state.phase_started_at = (phase != ShiftPhase::OffShift).then_some(at);
    }

    fn add_to_tally(&mut self, at: DateTime<Utc>) {
        let date = at.with_timezone(&self.policy.timezone).date_naive();
        if self.state.today.date != Some(date) {
            self.state.today = DayTally {
                date: Some(date),
                ..DayTally::default()
            };
        }
        let (worked, paused) = self.open_phase(at);
        self.state.today.worked_s += worked;
        self.state.today.pause_s += paused;
    }

    /// Worked and pause seconds of the open phase up to `at`, from today's
    /// local midnight at the earliest.
    fn open_phase(&self, at: DateTime<Utc>) -> (i64, i64) {
        let Some(start) = self.state.phase_started_at else {
            return (0, 0);
        };
        let midnight = at
            .with_timezone(&self.policy.timezone)
            .date_naive()
            .and_hms_opt(0, 0, 0)
            .and_then(|m| m.and_local_timezone(self.policy.timezone).earliest())
            .map(|m| m.with_timezone(&Utc))
            .unwrap_or(start);
        let secs = (at - start.max(midnight)).num_seconds().max(0);
        match self.state.shift {
            ShiftPhase::Working => (secs, 0),
            ShiftPhase::Paused => (secs, secs),
            ShiftPhase::OnBreak | ShiftPhase::OffShift => (0, 0),
        }
    }

    /// Time today for the tray (EMP-01): closed phases plus the open one.
    pub fn today(&self) -> Today {
        let now = self.clock.now();
        let date = now.with_timezone(&self.policy.timezone).date_naive();
        let (closed_worked, closed_pause) = if self.state.today.date == Some(date) {
            (self.state.today.worked_s, self.state.today.pause_s)
        } else {
            (0, 0)
        };
        let (worked, paused) = self.open_phase(now);
        Today {
            worked_s: closed_worked + worked,
            pause_s: closed_pause + paused,
        }
    }

    pub fn snapshot(&self) -> &SessionSnapshot {
        &self.state
    }

    fn emit(&self, event_type: &str, payload: serde_json::Value) -> Result<(), TransitionError> {
        self.sink
            .emit(event_type, self.clock.now(), payload)
            .map_err(TransitionError::Sink)
    }

    fn save(&self) {
        self.store.save(&self.state);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use chrono::NaiveTime;

    use super::*;
    use crate::clock::FakeClock;
    use crate::fake::FakePlatform;

    #[derive(Default)]
    struct RecordingSink(Mutex<Vec<(String, DateTime<Utc>, serde_json::Value)>>);

    impl EventSink for RecordingSink {
        fn emit(
            &self,
            event_type: &str,
            at: DateTime<Utc>,
            payload: serde_json::Value,
        ) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .push((event_type.into(), at, payload));
            Ok(())
        }
    }

    impl RecordingSink {
        fn types(&self) -> Vec<String> {
            self.0
                .lock()
                .unwrap()
                .iter()
                .map(|(t, _, _)| t.clone())
                .collect()
        }
        fn last(&self) -> (String, DateTime<Utc>, serde_json::Value) {
            self.0.lock().unwrap().last().cloned().unwrap()
        }
    }

    #[derive(Default)]
    struct MemoryStore(Mutex<Option<SessionSnapshot>>);

    impl SessionStore for MemoryStore {
        fn load(&self) -> Option<SessionSnapshot> {
            self.0.lock().unwrap().clone()
        }
        fn save(&self, snapshot: &SessionSnapshot) {
            *self.0.lock().unwrap() = Some(snapshot.clone());
        }
    }

    struct Rig {
        clock: Arc<FakeClock>,
        platform: Arc<FakePlatform>,
        sink: Arc<RecordingSink>,
        store: Arc<MemoryStore>,
        session: Session,
    }

    /// Monday 2026-10-19 08:50 in Los Angeles; shift 9–17 LA, Mon–Fri.
    fn rig(policy: SessionPolicy) -> Rig {
        let clock = Arc::new(FakeClock::at("2026-10-19T15:50:00Z"));
        let platform = Arc::new(FakePlatform::default());
        let sink = Arc::new(RecordingSink::default());
        let store = Arc::new(MemoryStore::default());
        let mut session = Session::new(
            policy,
            clock.clone(),
            platform.clone(),
            sink.clone(),
            store.clone(),
        );
        session.sign_in();
        Rig {
            clock,
            platform,
            sink,
            store,
            session,
        }
    }

    fn shift_policy(auto_clock_in: bool) -> SessionPolicy {
        SessionPolicy {
            auto_clock_in,
            forgotten_clock_out_after: Duration::minutes(30),
            shifts: vec![Shift {
                days: vec![1, 2, 3, 4, 5],
                start: NaiveTime::from_hms_opt(9, 0, 0).unwrap(),
                end: NaiveTime::from_hms_opt(17, 0, 0).unwrap(),
                tz: chrono_tz::America::Los_Angeles,
            }],
            timezone: chrono_tz::America::Los_Angeles,
        }
    }

    #[test]
    fn clock_in_with_a_project_and_out_again() {
        let mut r = rig(SessionPolicy::default());
        let project = Uuid::now_v7();
        r.session.clock_in(Some(project)).unwrap();
        assert_eq!(r.session.shift(), ShiftState::Working);
        let (kind, _, payload) = r.sink.last();
        assert_eq!(kind, "clock_in");
        assert_eq!(
            payload,
            json!({ "project_id": project, "reason": "manual" })
        );

        r.session.clock_out().unwrap();
        assert_eq!(r.session.shift(), ShiftState::OffShift);
        assert_eq!(r.sink.last().2, json!({ "reason": "manual" }));
    }

    #[test]
    fn signed_out_agents_cannot_clock_in() {
        let mut r = rig(SessionPolicy::default());
        r.session.sign_out().unwrap();
        assert_eq!(r.session.clock_in(None), Err(TransitionError::NotSignedIn));
        assert!(r.sink.types().is_empty());
    }

    #[test]
    fn illegal_transitions_are_refused_without_events() {
        let mut r = rig(SessionPolicy::default());
        assert_eq!(
            r.session.start_break(None),
            Err(TransitionError::NotClockedIn)
        );
        r.session.clock_in(None).unwrap();
        assert_eq!(
            r.session.clock_in(None),
            Err(TransitionError::AlreadyClockedIn)
        );
        r.session.start_break(Some(15)).unwrap();
        assert_eq!(r.session.start_pause(5), Err(TransitionError::OnBreak));
        assert_eq!(r.session.end_pause(), Err(TransitionError::NotPaused));
        r.session.end_break().unwrap();
        assert_eq!(
            r.session.start_pause(7),
            Err(TransitionError::InvalidDuration(7))
        );
        assert_eq!(r.sink.types(), vec!["clock_in", "break_start", "break_end"]);
    }

    #[test]
    fn collection_runs_only_while_working_and_unlocked() {
        let mut r = rig(SessionPolicy::default());
        assert!(!r.session.collecting(), "clocked out");
        r.session.clock_in(None).unwrap();
        assert!(r.session.collecting());
        r.platform.update(|s| s.session = SessionState::Locked);
        assert!(!r.session.collecting(), "locked");
        r.platform.update(|s| s.session = SessionState::Active);
        r.session.start_pause(5).unwrap();
        assert!(
            !r.session.collecting(),
            "paused: nothing collected (BRK-04)"
        );
        r.session.end_pause().unwrap();
        r.session.start_break(None).unwrap();
        assert!(!r.session.collecting(), "on break (BRK-01)");
    }

    #[test]
    fn a_pause_resumes_by_itself_with_a_notification() {
        let mut r = rig(SessionPolicy::default());
        r.session.clock_in(None).unwrap();
        r.session.start_pause(10).unwrap();
        r.clock.advance(Duration::minutes(9));
        r.session.tick().unwrap();
        assert_eq!(r.session.shift(), ShiftState::Paused);
        r.clock.advance(Duration::minutes(1));
        r.session.tick().unwrap();
        assert_eq!(r.session.shift(), ShiftState::Working);
        assert_eq!(r.sink.last().0, "pause_end");
        assert_eq!(r.platform.snapshot().notifications.len(), 1);
    }

    #[test]
    fn extending_a_pause_is_a_new_pause() {
        let mut r = rig(SessionPolicy::default());
        r.session.clock_in(None).unwrap();
        r.session.start_pause(5).unwrap();
        r.session.start_pause(10).unwrap();
        assert_eq!(
            r.sink.types(),
            vec!["clock_in", "pause_start", "pause_end", "pause_start"]
        );
    }

    #[test]
    fn auto_clock_in_on_first_input_inside_the_shift() {
        let mut r = rig(shift_policy(true));
        r.platform.update(|s| s.idle_seconds = 3);
        r.session.tick().unwrap();
        assert_eq!(
            r.session.shift(),
            ShiftState::OffShift,
            "08:50 is before the shift"
        );

        r.clock.advance(Duration::minutes(15)); // 09:05
        r.platform.update(|s| s.idle_seconds = 900);
        r.session.tick().unwrap();
        assert_eq!(
            r.session.shift(),
            ShiftState::OffShift,
            "no recent input yet"
        );

        r.platform.update(|s| s.idle_seconds = 2);
        r.session.tick().unwrap();
        assert_eq!(r.session.shift(), ShiftState::Working);
        assert_eq!(r.sink.last().2["reason"], "auto");
        assert_eq!(r.platform.snapshot().notifications[0].0, "Clocked in");
    }

    #[test]
    fn no_auto_clock_in_when_the_org_setting_is_off() {
        let mut r = rig(shift_policy(false));
        r.clock.advance(Duration::minutes(15));
        r.platform.update(|s| s.idle_seconds = 1);
        r.session.tick().unwrap();
        assert_eq!(r.session.shift(), ShiftState::OffShift);
    }

    #[test]
    fn nobody_clocks_in_before_acknowledging_the_notice() {
        let mut r = rig(shift_policy(true));
        r.session.set_collection_allowed(false);
        assert_eq!(
            r.session.clock_in(None),
            Err(TransitionError::NoticeNotAcknowledged)
        );
        assert!(r.sink.types().is_empty(), "nothing is recorded");

        // Auto clock-in waits too, quietly: no error, no notification, no event.
        r.clock.advance(Duration::minutes(15)); // 09:05, inside the shift
        r.platform.update(|s| s.idle_seconds = 1);
        r.session.tick().unwrap();
        assert_eq!(r.session.shift(), ShiftState::OffShift);
        assert!(r.platform.snapshot().notifications.is_empty());

        r.session.set_collection_allowed(true);
        r.session.tick().unwrap();
        assert_eq!(r.session.shift(), ShiftState::Working);
    }

    #[test]
    fn a_shift_under_way_carries_on_when_the_notice_flag_drops() {
        let mut r = rig(SessionPolicy::default());
        r.session.clock_in(None).unwrap();
        r.session.set_collection_allowed(false);
        assert!(r.session.start_break(None).is_ok());
        r.session.end_break().unwrap();
        r.session.clock_out().unwrap();
        assert_eq!(
            r.session.clock_in(None),
            Err(TransitionError::NoticeNotAcknowledged)
        );
    }

    #[test]
    fn forgotten_clock_out_happens_at_the_last_activity_time() {
        let mut r = rig(shift_policy(false));
        r.clock.advance(Duration::minutes(15)); // 09:05
        r.session.clock_in(None).unwrap();
        // 17:20: shift ended 20 min ago, user left at 16:50.
        r.clock.advance(Duration::minutes(8 * 60 + 15));
        r.platform.update(|s| s.idle_seconds = 30 * 60);
        r.session.tick().unwrap();
        assert_eq!(
            r.session.shift(),
            ShiftState::Working,
            "only 20 min past shift end"
        );

        // 17:40: 40 min past the end and 50 min idle.
        r.clock.advance(Duration::minutes(20));
        r.platform.update(|s| s.idle_seconds = 50 * 60);
        r.session.tick().unwrap();
        assert_eq!(r.session.shift(), ShiftState::OffShift);
        let (kind, at, payload) = r.sink.last();
        assert_eq!(
            (kind.as_str(), payload["reason"].as_str()),
            ("clock_out", Some("auto"))
        );
        assert_eq!(
            at,
            DateTime::parse_from_rfc3339("2026-10-19T23:50:00Z").unwrap()
        );
    }

    #[test]
    fn working_late_with_input_is_not_a_forgotten_clock_out() {
        let mut r = rig(shift_policy(false));
        r.clock.advance(Duration::minutes(15));
        r.session.clock_in(None).unwrap();
        r.clock.advance(Duration::minutes(9 * 60)); // 18:05, an hour past the end
        r.platform.update(|s| s.idle_seconds = 5);
        r.session.tick().unwrap();
        assert_eq!(r.session.shift(), ShiftState::Working);
    }

    #[test]
    fn state_survives_a_restart() {
        let r = rig(SessionPolicy::default());
        let mut session = r.session;
        session.clock_in(None).unwrap();
        session.start_pause(15).unwrap();
        drop(session);

        let restored = Session::new(
            SessionPolicy::default(),
            r.clock.clone(),
            r.platform.clone(),
            r.sink.clone(),
            r.store.clone(),
        );
        assert_eq!(restored.shift(), ShiftState::Paused);
        assert!(restored.signed_in());
    }

    #[test]
    fn file_store_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileSessionStore::new(dir.path());
        assert_eq!(store.load(), None);
        let snapshot = SessionSnapshot {
            signed_in: true,
            shift: ShiftPhase::OnBreak,
            ..Default::default()
        };
        store.save(&snapshot);
        assert_eq!(store.load(), Some(snapshot));
    }

    #[test]
    fn today_counts_work_and_pauses_but_not_breaks() {
        let mut r = rig(SessionPolicy::default());
        let (s, clock) = (&mut r.session, &r.clock);
        s.clock_in(None).unwrap();
        clock.advance(Duration::minutes(60));
        s.start_pause_with_reason(10, Some("  doctor  ")).unwrap();
        clock.advance(Duration::minutes(10));
        s.end_pause().unwrap();
        s.start_break(None).unwrap();
        clock.advance(Duration::minutes(30));
        s.end_break().unwrap();
        clock.advance(Duration::minutes(20));
        let pause = r
            .sink
            .0
            .lock()
            .unwrap()
            .iter()
            .find(|(t, _, _)| t == "pause_start")
            .cloned()
            .unwrap();
        assert_eq!(
            pause.2["reason"], "doctor",
            "trimmed, kept private on the server"
        );
        let today = r.session.today();
        assert_eq!(
            today.worked_s,
            90 * 60,
            "60 + 10 paused + 20, break excluded"
        );
        assert_eq!(today.pause_s, 10 * 60);
    }

    #[test]
    fn today_starts_over_at_local_midnight() {
        let mut r = rig(SessionPolicy::default());
        // 15:50 UTC → clock in at 23:00 UTC (the default zone), 3 h later it's 02:00.
        r.clock.advance(Duration::minutes(7 * 60 + 10));
        r.session.clock_in(None).unwrap();
        r.clock.advance(Duration::hours(3));
        assert_eq!(
            r.session.today().worked_s,
            2 * 3600,
            "only the hours after midnight are today"
        );
    }
}
