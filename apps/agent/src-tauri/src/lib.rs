//! Tauri shell for the agent: tray icon, popover window, and the IPC surface
//! defined in `packages/contracts`. Agent logic lives in `agent-core`.

pub mod account;
mod card;
#[cfg(debug_assertions)]
mod dev;
#[cfg(all(debug_assertions, unix))]
mod dev_control;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use account::Account;
use agent_core::activity::{self, ActivityPolicy, Sampler};
use agent_core::auth::{AuthError, REDIRECT_URL};
use agent_core::capture::{self, CapturePolicy, Captured};
use agent_core::checkin::{deferred_payload, Card, CardPolicy, ClickResult, Finished};
use agent_core::clock::{Clock, SystemClock};
use agent_core::config::ProjectConfig;
use agent_core::contracts::{
    AgentStatus, CardChallenge, CardClickResult, CheckinOutcome, CommandResult, LastCheckin,
    MissedCheckin, PermissionState, ProjectRef, ShiftState,
};
use agent_core::keystore::KeyStore;
use agent_core::outbox::{Outbox, OutboxError, UPLOAD_MAX_BYTES};
use agent_core::platform::{CaptureError, Platform, SessionState};
use agent_core::presence::PresenceTracker;
use agent_core::scheduler::{
    Decision, FileScheduleStore, Outcome, Random, SchedulePolicy, Scheduler, ThreadRandom,
};
use agent_core::session::{
    EventSink, FileSessionStore, OutboxSink, Session, SessionPolicy, TransitionError,
};
use agent_core::sync::{Backoff, Heartbeat, SyncError};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Rect, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

const POPOVER: &str = "popover";

/// Event names; must match `ipcEvents` in packages/contracts/src/ipc.ts.
pub const EVENT_STATUS_CHANGED: &str = "status_changed";

/// How often the session's time-driven rules run (auto clock-in, pause end,
/// forgotten clock-out).
const TICK: Duration = Duration::from_secs(5);

/// The sync loop: send queued events this often, heartbeat while clocked in
/// (STS-01), prune the outbox now and then.
const SYNC_EVERY: Duration = Duration::from_secs(10);
const HEARTBEAT_EVERY: Duration = Duration::from_secs(60);
const PRUNE_EVERY: Duration = Duration::from_secs(3600);

/// While a card is up, how often the runner checks its countdown.
const CARD_TICK: Duration = Duration::from_millis(250);
/// The card stays up briefly after the click so the result can be read.
const PASS_LINGER: Duration = Duration::from_millis(800);

/// CAP-08: this many permission failures in a row report the permission as
/// missing (Tamper on the server, STS rule 2).
const PERMISSION_FAILURES_FOR_TAMPER: u32 = 2;

/// What a click on the card did. A pass comes back unqueued: its captures are
/// taken off the UI thread (`finish_pass`).
#[derive(Debug, PartialEq)]
struct ClickReply {
    result: CardClickResult,
    /// The reshuffled card after a wrong click.
    next: Option<CardChallenge>,
    pass: Option<Finished>,
}

impl ClickReply {
    fn just(result: CardClickResult) -> Self {
        Self {
            result,
            next: None,
            pass: None,
        }
    }
}

/// Consecutive capture permission failures, and what was last reported.
#[derive(Debug, Default)]
struct PermissionWatch {
    screen_failures: u32,
    camera_failures: u32,
    reported_missing: bool,
}

/// What the card runner should do with the window.
#[derive(Debug, PartialEq)]
enum CardAction {
    Nothing,
    Show(CardChallenge),
    Hide,
}

pub struct AgentState {
    platform: Arc<dyn Platform>,
    clock: Arc<dyn Clock>,
    session: Mutex<Session>,
    /// Never exposed over IPC: the next check-in time stays in the core.
    scheduler: Scheduler,
    /// Check-in outcomes are queued here; `None` when the keychain is unavailable.
    outbox: Option<Arc<Outbox>>,
    /// The card on screen, if any.
    card: Mutex<Option<Card>>,
    card_policy: CardPolicy,
    capture_policy: CapturePolicy,
    permission_watch: Mutex<PermissionWatch>,
    /// Activity sampling (#25); org settings arrive with the policy work.
    activity: Mutex<Sampler>,
    /// Idle, lock, sleep and call changes sent as events (STS-01).
    presence: Mutex<PresenceTracker>,
    /// The sync thread, woken early when there's something to send right away.
    sync_thread: Mutex<Option<std::thread::Thread>>,
    random: Arc<dyn Random>,
    /// From the server config (#29, #38): projects to pick and the pause allowance.
    projects: Mutex<Vec<ProjectConfig>>,
    pause_daily_cap_s: Mutex<i64>,
    /// For the tray: today's latest check-in, and a miss still without a reason.
    last_checkin: Mutex<Option<(chrono::DateTime<chrono::Utc>, Outcome)>>,
    missed_checkin: Mutex<Option<(uuid::Uuid, chrono::DateTime<chrono::Utc>)>>,
    /// `None` when this build has no server configured (see `account::api_config`).
    account: Option<Arc<Account>>,
    /// The last sign-in link handled, so a link delivered twice is used once.
    last_redirect: Mutex<Option<String>>,
}

impl AgentState {
    pub fn new(
        platform: Arc<dyn Platform>,
        clock: Arc<dyn Clock>,
        session: Session,
        scheduler: Scheduler,
        outbox: Option<Arc<Outbox>>,
        account: Option<Arc<Account>>,
    ) -> Self {
        let state = Self {
            platform,
            clock,
            session: Mutex::new(session),
            scheduler,
            outbox,
            card: Mutex::new(None),
            // Org card settings arrive with the policy work; defaults until then.
            card_policy: CardPolicy::default(),
            capture_policy: CapturePolicy::default(),
            permission_watch: Mutex::new(PermissionWatch::default()),
            activity: Mutex::new(Sampler::new(ActivityPolicy::default())),
            presence: Mutex::new(PresenceTracker::default()),
            sync_thread: Mutex::new(None),
            random: Arc::new(ThreadRandom),
            projects: Mutex::new(Vec::new()),
            pause_daily_cap_s: Mutex::new(60 * 60),
            last_checkin: Mutex::new(None),
            missed_checkin: Mutex::new(None),
            account,
            last_redirect: Mutex::new(None),
        };
        state.sync_schedule();
        state
    }

    /// Working arms the next check-in; a break, a pause or clock-out cancels it
    /// without a miss (LLD 02). The card loop that polls it arrives with #20.
    fn sync_schedule(&self) {
        if self.session.lock().unwrap().shift() == ShiftState::Working {
            self.scheduler.start();
        } else {
            self.scheduler.cancel();
        }
    }

    pub fn status(&self) -> AgentStatus {
        let email = self.account.as_ref().and_then(|a| a.email());
        let projects = self.projects.lock().unwrap().clone();
        let session = self.session.lock().unwrap();
        let snap = session.snapshot();
        let today = session.today();
        let iso = |t: chrono::DateTime<chrono::Utc>| t.to_rfc3339();
        let project_ref = |p: &ProjectConfig| ProjectRef {
            id: p.id.to_string(),
            name: p.name.clone(),
            client: p.client.clone(),
        };
        let today_date = self.clock.now().date_naive();
        let tray = agent_core::status::Tray {
            account_email: email,
            clocked_in_at: snap.clocked_in_at.map(iso),
            phase_started_at: snap.phase_started_at.map(iso),
            pause_ends_at: snap.pause_until.map(iso),
            pause_planned_min: snap.pause_planned_min,
            worked_today_s: today.worked_s,
            pause_used_today_s: today.pause_s,
            pause_daily_cap_s: *self.pause_daily_cap_s.lock().unwrap(),
            project: snap
                .project_id
                .and_then(|id| projects.iter().find(|p| p.id == id))
                .map(project_ref),
            projects: projects.iter().map(project_ref).collect(),
            last_checkin: self
                .last_checkin
                .lock()
                .unwrap()
                .filter(|(at, _)| at.date_naive() == today_date)
                .map(|(at, outcome)| LastCheckin {
                    at: iso(at),
                    outcome: match outcome {
                        Outcome::Pass => CheckinOutcome::Pass,
                        Outcome::Miss => CheckinOutcome::Miss,
                        Outcome::Failed => CheckinOutcome::Failed,
                    },
                }),
            missed_checkin: self
                .missed_checkin
                .lock()
                .unwrap()
                .filter(|(_, at)| at.date_naive() == today_date)
                .map(|(id, at)| MissedCheckin {
                    id: id.to_string(),
                    at: iso(at),
                }),
        };
        agent_core::status::agent_status(
            self.platform.as_ref(),
            session.shift(),
            session.signed_in(),
            env!("CARGO_PKG_VERSION"),
            tray,
        )
    }

    /// The card runner's step: show a due check-in, end one that ran out, or drop
    /// one that a break, pause or clock-out cancelled (no miss then, LLD 02).
    fn card_tick(&self) -> CardAction {
        let now = self.clock.now();
        let mut card = self.card.lock().unwrap();
        if let Some(current) = card.as_ref() {
            if self.session.lock().unwrap().shift() != ShiftState::Working {
                tracing::info!("check-in cancelled by a shift change");
                *card = None;
                return CardAction::Hide;
            }
            if current.expired(now) {
                let finished = current.finish(Outcome::Miss, now);
                *card = None;
                self.record(finished);
                return CardAction::Hide;
            }
            return CardAction::Nothing;
        }
        let scheduled_at = match self.scheduler.poll() {
            Decision::Show { scheduled_at } => scheduled_at,
            Decision::Deferred(deferral) => {
                // Held for a call, a share or a presentation: leave a record, show
                // nothing and capture nothing (CHK-03). The card comes later as usual.
                tracing::info!(reason = deferral.reason.as_str(), "check-in deferred");
                let payload =
                    deferred_payload(&deferral, self.session.lock().unwrap().project_id());
                self.append_checkin(now, payload);
                return CardAction::Nothing;
            }
            _ => return CardAction::Nothing,
        };
        let shown = Card::show(
            scheduled_at,
            now,
            &self.card_policy,
            self.platform.as_ref(),
            self.random.as_ref(),
            self.session.lock().unwrap().project_id(),
        );
        tracing::info!(card = %shown.id, "check-in shown");
        if self.card_policy.notify {
            self.platform
                .notify("Check-in", "Click the number shown on the card.");
        }
        let challenge = self.challenge(&shown);
        *card = Some(shown);
        CardAction::Show(challenge)
    }

    /// The card on screen, as the card window shows it.
    #[cfg(all(debug_assertions, unix))]
    fn current_challenge(&self) -> Option<CardChallenge> {
        self.card
            .lock()
            .unwrap()
            .as_ref()
            .map(|c| self.challenge(c))
    }

    /// Marks the card on screen: the flag goes on its `checkin` event.
    #[cfg(all(debug_assertions, unix))]
    fn flag_card(&self, flag: &str) {
        if let Some(card) = self.card.lock().unwrap().as_mut() {
            if !card.flags.iter().any(|f| f == flag) {
                card.flags.push(flag.to_owned());
            }
        }
    }

    /// A click on the card. Only real pointer clicks count (CHK-11); anything for
    /// a card that is no longer up is ignored.
    fn card_click(&self, card_id: &str, value: i64, trusted: bool) -> ClickReply {
        let mut card = self.card.lock().unwrap();
        let Some(current) = card.as_mut().filter(|c| c.id.to_string() == card_id) else {
            return ClickReply::just(CardClickResult::Ignored);
        };
        if !trusted || !(1..=9).contains(&value) {
            tracing::warn!(trusted, value, "card click ignored");
            return ClickReply::just(CardClickResult::Ignored);
        }
        let now = self.clock.now();
        match current.click(value as u8, self.random.as_ref()) {
            ClickResult::Wrong => ClickReply {
                next: Some(self.challenge(current)),
                ..ClickReply::just(CardClickResult::Wrong)
            },
            ClickResult::Pass => {
                let finished = current.finish(Outcome::Pass, now);
                *card = None;
                self.scheduler.finished(Outcome::Pass);
                ClickReply {
                    pass: Some(finished),
                    ..ClickReply::just(CardClickResult::Pass)
                }
            }
            ClickResult::Failed => {
                let finished = current.finish(Outcome::Failed, now);
                *card = None;
                self.record(finished);
                ClickReply::just(CardClickResult::Failed)
            }
        }
    }

    /// CAP-01: a pass captures screens and the webcam (per policy), then queues the
    /// check-in with the file names; the files upload once the server has
    /// accepted it. Takes ~2 s (camera warm-up): never on the UI thread.
    fn finish_pass(&self, mut finished: Finished) {
        let captured = capture::capture(self.platform.as_ref(), &self.capture_policy);
        tracing::info!(
            files = captured.files.len(),
            screen_error = ?captured.screen_error,
            webcam_error = ?captured.webcam_error,
            "captured"
        );
        self.watch_permissions(&captured);
        captured.attach(&mut finished.payload);
        let Some(id) = self.queue(finished) else {
            return;
        };
        if let Some(outbox) = &self.outbox {
            for (name, bytes) in &captured.files {
                if let Err(error) = outbox.add_upload(id, name, bytes, self.clock.now()) {
                    tracing::error!(%error, name, "capture not queued");
                }
            }
        }
    }

    /// CAP-08: a capture that fails for lack of permission twice in a row reports
    /// the permission missing (`permission_change`), which the server turns into
    /// Tamper; the next good capture reports it back. Covers macOS keeping a stale
    /// "granted" after Screen Recording is revoked (spike #13).
    fn watch_permissions(&self, captured: &Captured) {
        let mut watch = self.permission_watch.lock().unwrap();
        let count = |failures: &mut u32, error: &Option<CaptureError>| match error {
            Some(CaptureError::PermissionMissing) => *failures += 1,
            Some(_) => {}
            None => *failures = 0,
        };
        if self.capture_policy.screenshots != capture::ScreenshotMode::Off {
            count(&mut watch.screen_failures, &captured.screen_error);
        }
        if self.capture_policy.webcam {
            count(&mut watch.camera_failures, &captured.webcam_error);
        }
        let screen_missing = watch.screen_failures >= PERMISSION_FAILURES_FOR_TAMPER;
        let camera_missing = watch.camera_failures >= PERMISSION_FAILURES_FOR_TAMPER;
        let missing = screen_missing || camera_missing;
        if missing == watch.reported_missing {
            return;
        }
        let mut permissions = self.platform.permissions();
        if screen_missing {
            permissions.screen = PermissionState::Denied;
        }
        if camera_missing {
            permissions.camera = PermissionState::Denied;
        }
        tracing::warn!(?permissions, "capture permissions changed");
        let payload = serde_json::to_value(&permissions).unwrap_or_default();
        if let Some(outbox) = &self.outbox {
            let now = self.clock.now();
            if let Err(error) =
                outbox.append("permission_change", now, self.clock.mono_ms(), payload, now)
            {
                tracing::error!(%error, "permission change not queued");
                return;
            }
        }
        watch.reported_missing = missing;
    }

    /// ACT-01: samples the frontmost app while working (and unlocked); anything
    /// else ends the current buckets. Finished minutes go to the outbox.
    fn activity_tick(&self) {
        let collecting = self.session.lock().unwrap().collecting();
        let foreground = collecting.then(|| self.platform.foreground()).flatten();
        let now = self.clock.now();
        let sessions = {
            let mut sampler = self.activity.lock().unwrap();
            if collecting {
                sampler.sample(now, foreground)
            } else {
                sampler.stop()
            }
        };
        self.queue_activity(sessions);
    }

    /// A shift change (clock-out, break, pause, and back) closes the open buckets
    /// there and then, so none spans the change; the time since the last sample
    /// isn't counted (#105).
    fn flush_activity(&self) {
        let sessions = self.activity.lock().unwrap().stop();
        self.queue_activity(sessions);
    }

    fn queue_activity(&self, sessions: Vec<activity::AppSession>) {
        let now = self.clock.now();
        let Some(outbox) = &self.outbox else {
            return;
        };
        for session in sessions {
            if let Err(error) = outbox.append(
                "app_session",
                session.end,
                self.clock.mono_ms(),
                session.payload(),
                now,
            ) {
                tracing::error!(%error, "activity not queued");
            }
        }
    }

    /// STS-01: while working, queues an event for each idle, lock, sleep or call
    /// change and wakes the sync loop so it goes out now, not on the next tick.
    /// Nothing on a break, a pause or off shift.
    fn presence_tick(&self) {
        let working = self.session.lock().unwrap().shift() == ShiftState::Working;
        let events = {
            let mut presence = self.presence.lock().unwrap();
            if !working {
                presence.reset();
                return;
            }
            presence.observe(self.platform.as_ref(), self.clock.now())
        };
        if events.is_empty() {
            return;
        }
        let Some(outbox) = &self.outbox else {
            return;
        };
        for e in events {
            tracing::info!(event = e.event_type, "state change");
            if let Err(error) = outbox.append(
                e.event_type,
                e.at,
                self.clock.mono_ms(),
                e.payload,
                self.clock.now(),
            ) {
                tracing::error!(%error, "state change not queued");
            }
        }
        self.nudge_sync();
    }

    fn nudge_sync(&self) {
        if let Some(thread) = self.sync_thread.lock().unwrap().as_ref() {
            thread.unpark();
        }
    }

    fn challenge(&self, card: &Card) -> CardChallenge {
        CardChallenge {
            card_id: card.id.to_string(),
            target: card.challenge.target.into(),
            options: card.challenge.options.map(i64::from),
            remaining_s: card.remaining_s(self.clock.now()).into(),
            wrong_clicks: card.wrong_clicks.into(),
            sound: self.card_policy.sound,
            project: self.session.lock().unwrap().project_id().and_then(|id| {
                self.projects
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|p| p.id == id)
                    .map(|p| p.name.clone())
            }),
        }
    }

    /// Queues the `checkin` event and arms the next check-in (CHK-01/02).
    fn record(&self, finished: Finished) {
        let outcome = finished.outcome;
        self.queue(finished);
        self.scheduler.finished(outcome);
    }

    /// Queues a `checkin` event; its id keys the capture uploads.
    fn queue(&self, finished: Finished) -> Option<uuid::Uuid> {
        tracing::info!(outcome = ?finished.outcome, "check-in finished");
        let (at, outcome) = (finished.at, finished.outcome);
        self.append_checkin(at, finished.payload).inspect(|id| {
            *self.last_checkin.lock().unwrap() = Some((at, outcome));
            if outcome == Outcome::Miss {
                *self.missed_checkin.lock().unwrap() = Some((*id, at));
            }
        })
    }

    fn append_checkin(
        &self,
        at: chrono::DateTime<chrono::Utc>,
        payload: serde_json::Value,
    ) -> Option<uuid::Uuid> {
        let Some(outbox) = &self.outbox else {
            tracing::error!("check-in not queued: the local queue is unavailable");
            return None;
        };
        outbox
            .append(
                "checkin",
                at,
                self.clock.mono_ms(),
                payload,
                self.clock.now(),
            )
            .map(|event| event.id)
            .map_err(|error| tracing::error!(%error, "check-in not queued"))
            .ok()
    }

    fn account(&self) -> Result<&Arc<Account>, String> {
        self.account
            .as_ref()
            .ok_or_else(|| "This copy of AI Proctor has no server set up.".to_owned())
    }

    fn start_sign_in(&self, email: &str) -> Result<(), String> {
        let email = email.trim();
        if !email.contains('@') {
            return Err("Enter your work email.".into());
        }
        self.account()?.start_sign_in(email).map_err(|e| match e {
            AuthError::Refused(_) => {
                "This email isn't invited yet. Ask your admin for an invite.".to_owned()
            }
            _ => "Couldn't send the link right now. Try again in a minute.".to_owned(),
        })
    }

    /// The magic link opened `aiproctor://auth?code=…`.
    fn complete_sign_in(&self, redirect: &str) {
        {
            let mut last = self.last_redirect.lock().unwrap();
            if last.as_deref() == Some(redirect) {
                return;
            }
            *last = Some(redirect.to_owned());
        }
        let Ok(account) = self.account() else {
            return;
        };
        match account.complete_sign_in(redirect) {
            Ok(()) => {
                self.session.lock().unwrap().sign_in();
                self.apply_new_config();
                tracing::info!("signed in");
                let email = account.email().unwrap_or_default();
                self.platform.notify("Signed in to AI Proctor", &email);
            }
            Err(error) => {
                tracing::warn!(%error, "sign-in link refused");
                let body = match error {
                    SyncError::Retry(_) => "Couldn't reach the server. Open the link again in a minute.",
                    _ => "The link has expired or was already used. Send a new one from the menu bar.",
                };
                self.platform.notify("Couldn't sign in", body);
            }
        }
    }

    /// Signs out from the popover: ends the shift, sends what is queued, then ends
    /// the session on the server.
    fn sign_out(&self) {
        self.act("sign out", |s| s.sign_out());
        if let Some(account) = &self.account {
            if let Err(error) = account.sync() {
                tracing::warn!(%error, "sign-out: queued events stay for the next sign-in");
            }
            account.sign_out();
        }
        tracing::info!("signed out");
    }

    /// The server ended the session (expired, user deactivated) or revoked this
    /// device: stop collecting and say so.
    fn signed_out_by_server(&self, error: &SyncError) {
        tracing::warn!(%error, "signed out by the server");
        self.act("sign out", |s| s.sign_out());
        if let Some(account) = &self.account {
            account.sign_out();
        }
        let body = match error {
            SyncError::Revoked => "Your admin removed this device. Sign in again to keep tracking.",
            _ => "Your session ended. Sign in again from the menu bar.",
        };
        self.platform.notify("Signed out of AI Proctor", body);
    }

    /// What the heartbeat says: nothing while off shift, only "alive" during a
    /// break or pause (no idle, lock or call state), the full state while working.
    fn heartbeat(&self) -> Option<Heartbeat> {
        match self.session.lock().unwrap().shift() {
            ShiftState::OffShift => None,
            ShiftState::OnBreak | ShiftState::Paused => Some(Heartbeat {
                idle_s: 0,
                locked: false,
                in_call: false,
                permissions: serde_json::Value::Null,
            }),
            ShiftState::Working => Some(Heartbeat {
                idle_s: self.platform.idle_seconds(),
                locked: self.platform.session_state() != SessionState::Active,
                in_call: self.platform.call_state().in_call(),
                permissions: serde_json::to_value(self.platform.permissions()).unwrap_or_default(),
            }),
        }
    }

    /// One pass of the sync loop. Returns whether a heartbeat went out.
    fn sync_round(&self, heartbeat_due: bool) -> Result<bool, SyncError> {
        let Some(account) = &self.account else {
            return Ok(false);
        };
        if !self.session.lock().unwrap().signed_in() {
            return Ok(false);
        }
        if !account.attached() {
            account.restore()?;
        }
        account.sync()?;
        let sent = match self.heartbeat().filter(|_| heartbeat_due) {
            Some(heartbeat) => account.heartbeat(&heartbeat).map(|()| true)?,
            None => false,
        };
        self.apply_new_config();
        Ok(sent)
    }

    /// Shifts and session policy from the server (#29), once they've changed.
    fn apply_new_config(&self) {
        let Some(config) = self.account.as_ref().and_then(|a| a.take_config()) else {
            return;
        };
        self.apply_config(&config);
    }

    fn apply_config(&self, config: &agent_core::config::AgentConfig) {
        let policy = config.session_policy();
        tracing::info!(
            shifts = policy.shifts.len(),
            auto_clock_in = policy.auto_clock_in,
            "session policy updated"
        );
        self.session.lock().unwrap().set_policy(policy);
        *self.projects.lock().unwrap() = config.projects.clone();
        *self.pause_daily_cap_s.lock().unwrap() = config.pause_daily_cap_s();
        // Same setting the server uses for Idle (minutes; default 10).
        if let Some(min) = config.policy["idle_threshold_min"]
            .as_i64()
            .filter(|m| (1..=240).contains(m))
        {
            self.presence
                .lock()
                .unwrap()
                .set_idle_threshold(chrono::Duration::minutes(min));
        }
    }

    /// Runs a transition; failures are logged and shown as a notification.
    fn act(&self, what: &str, f: impl FnOnce(&mut Session) -> Result<(), TransitionError>) {
        if let Err(error) = self.act_checked(what, f) {
            self.platform
                .notify(&format!("Couldn't {what}"), &error.to_string());
        }
    }

    /// `act`, handing the failure back too.
    fn act_checked(
        &self,
        what: &str,
        f: impl FnOnce(&mut Session) -> Result<(), TransitionError>,
    ) -> Result<(), TransitionError> {
        let (before, result, after) = {
            let mut session = self.session.lock().unwrap();
            let before = session.shift();
            let result = f(&mut session);
            (before, result, session.shift())
        };
        if before != after {
            self.flush_activity();
        }
        if let Err(error) = &result {
            tracing::warn!(%error, what, "transition refused");
        }
        self.sync_schedule();
        result
    }

    /// A transition from the popover: the error comes back to show there.
    fn try_act(
        &self,
        what: &str,
        f: impl FnOnce(&mut Session) -> Result<(), TransitionError>,
    ) -> Result<(), String> {
        self.act_checked(what, f).map_err(|error| error.to_string())
    }
}

/// Used when the outbox is unavailable: every transition fails, so nothing is
/// recorded or collected without the encrypted queue.
struct UnavailableSink;

impl EventSink for UnavailableSink {
    fn emit(
        &self,
        _: &str,
        _: chrono::DateTime<chrono::Utc>,
        _: serde_json::Value,
    ) -> Result<(), String> {
        Err("the local queue is unavailable (keychain)".into())
    }
}

/// The encrypted outbox, or `None` when the keychain could not provide its key
/// (nothing is collected then; the watchdog will surface it as Tamper, #58).
pub struct OutboxState(pub Option<Arc<Outbox>>);

/// Name of the outbox key in the OS keychain.
const OUTBOX_KEY: &str = "outbox-key";

/// Where secrets live: the OS keychain. Debug builds can use files instead
/// (`AI_PROCTOR_DEV_KEYSTORE`), so an unattended run raises no keychain prompt.
fn key_store() -> Arc<dyn KeyStore> {
    #[cfg(debug_assertions)]
    if let Some(store) = dev::keystore() {
        tracing::warn!("dev keystore: secrets are kept in files");
        return Arc::new(store);
    }
    Arc::new(agent_platform::keychain::OsKeychain)
}

/// The app data dir; debug builds can point it elsewhere (`AI_PROCTOR_DEV_DATA_DIR`).
fn data_dir(app: &tauri::App) -> tauri::Result<std::path::PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(dir) = dev::data_dir() {
        tracing::warn!(dir = %dir.display(), "dev data dir");
        std::fs::create_dir_all(&dir)?;
        return Ok(dir);
    }
    app.path().app_data_dir()
}

fn open_outbox(data_dir: &std::path::Path) -> Result<Outbox, String> {
    let key = agent_core::keystore::get_or_create(key_store().as_ref(), OUTBOX_KEY)
        .map_err(|e| e.to_string())?;
    Outbox::open(&data_dir.join("outbox"), &key).map_err(|e: OutboxError| e.to_string())
}

// Commands take snake_case arguments, as in packages/contracts/src/ipc.ts (Tauri's
// default would expect camelCase from JavaScript and reject `card_id`).

/// `get_status`: what the tray popover shows.
#[tauri::command(rename_all = "snake_case")]
fn get_status(state: tauri::State<'_, AgentState>) -> AgentStatus {
    state.status()
}

/// `sign_in_start`: emails a magic link to `email`.
#[tauri::command(rename_all = "snake_case")]
async fn sign_in_start(app: AppHandle, email: String) -> CommandResult {
    off_main_thread(move || app.state::<AgentState>().start_sign_in(&email)).await
}

/// `sign_out`: ends the shift and the session.
#[tauri::command(rename_all = "snake_case")]
async fn sign_out(app: AppHandle) -> CommandResult {
    off_main_thread(move || {
        end_session(&app);
        Ok(())
    })
    .await
}

fn end_session(app: &AppHandle) {
    let state = app.state::<AgentState>();
    state.sign_out();
    let _ = app.emit_to(POPOVER, EVENT_STATUS_CHANGED, state.status());
}

/// `card_click`: judged here, in Rust. A wrong click sends the reshuffled card.
#[tauri::command(rename_all = "snake_case")]
fn card_click(app: AppHandle, card_id: String, value: i64, trusted: bool) -> CardClickResult {
    click_card(&app, &card_id, value, trusted)
}

/// The click and what follows it: the reshuffled card, hiding it, the captures.
fn click_card(app: &AppHandle, card_id: &str, value: i64, trusted: bool) -> CardClickResult {
    let state = app.state::<AgentState>();
    let reply = state.card_click(card_id, value, trusted);
    if let Some(challenge) = reply.next {
        card::update(app, challenge);
    }
    if matches!(
        reply.result,
        CardClickResult::Pass | CardClickResult::Failed
    ) {
        let hide = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(PASS_LINGER);
            card::hide(&hide);
        });
    }
    if let Some(pass) = reply.pass {
        let app = app.clone();
        std::thread::spawn(move || app.state::<AgentState>().finish_pass(pass));
    }
    reply.result
}

/// Runs a popover transition and pushes the new status (EMP-01).
fn tray_act(
    app: &AppHandle,
    what: &str,
    f: impl FnOnce(&mut Session) -> Result<(), TransitionError>,
) -> CommandResult {
    let state = app.state::<AgentState>();
    let result = state.try_act(what, f);
    let _ = app.emit_to(POPOVER, EVENT_STATUS_CHANGED, state.status());
    CommandResult {
        ok: result.is_ok(),
        error: result.err(),
    }
}

fn parse_project(project_id: Option<String>) -> Result<Option<uuid::Uuid>, String> {
    project_id
        .map(|p| uuid::Uuid::parse_str(&p).map_err(|_| "Unknown project.".to_owned()))
        .transpose()
}

#[tauri::command(rename_all = "snake_case")]
fn clock_in(app: AppHandle, project_id: Option<String>) -> CommandResult {
    match parse_project(project_id) {
        Ok(project) => tray_act(&app, "clock in", |s| s.clock_in(project)),
        Err(error) => CommandResult {
            ok: false,
            error: Some(error),
        },
    }
}

#[tauri::command(rename_all = "snake_case")]
fn clock_out(app: AppHandle) -> CommandResult {
    tray_act(&app, "clock out", |s| s.clock_out())
}

#[tauri::command(rename_all = "snake_case")]
fn break_start(app: AppHandle, planned_min: Option<i64>) -> CommandResult {
    let planned = planned_min.and_then(|m| u32::try_from(m).ok());
    tray_act(&app, "start a break", |s| s.start_break(planned))
}

#[tauri::command(rename_all = "snake_case")]
fn break_end(app: AppHandle) -> CommandResult {
    tray_act(&app, "end the break", |s| s.end_break())
}

#[tauri::command(rename_all = "snake_case")]
fn pause_start(app: AppHandle, minutes: i64, reason: Option<String>) -> CommandResult {
    let minutes = u32::try_from(minutes).unwrap_or(0);
    tray_act(&app, "pause", |s| {
        s.start_pause_with_reason(minutes, reason.as_deref())
    })
}

#[tauri::command(rename_all = "snake_case")]
fn pause_end(app: AppHandle) -> CommandResult {
    tray_act(&app, "resume", |s| s.end_pause())
}

#[tauri::command(rename_all = "snake_case")]
fn switch_project(app: AppHandle, project_id: Option<String>) -> CommandResult {
    match parse_project(project_id) {
        Ok(project) => tray_act(&app, "switch project", |s| s.switch_project(project)),
        Err(error) => CommandResult {
            ok: false,
            error: Some(error),
        },
    }
}

/// CHK-23: reason for today's miss; network call, so off the UI thread.
#[tauri::command(rename_all = "snake_case")]
async fn set_miss_reason(
    app: AppHandle,
    checkin_id: String,
    kind: Option<String>,
    note: Option<String>,
) -> CommandResult {
    off_main_thread(move || {
        let state = app.state::<AgentState>();
        let id = uuid::Uuid::parse_str(&checkin_id).map_err(|_| "Unknown check-in.".to_owned())?;
        state
            .account()?
            .set_miss_reason(id, kind.as_deref(), note.as_deref())
            .map_err(|_| "Couldn't save the reason. Try again in a minute.".to_owned())?;
        let mut missed = state.missed_checkin.lock().unwrap();
        if missed.is_some_and(|(m, _)| m == id) {
            *missed = None;
        }
        drop(missed);
        let _ = app.emit_to(POPOVER, EVENT_STATUS_CHANGED, state.status());
        Ok(())
    })
    .await
}

/// My data and the notice live on the dashboard (#48, #49); the privacy panes
/// are where a missing permission is fixed (#58, #59).
#[tauri::command(rename_all = "snake_case")]
fn open_link(target: String) -> CommandResult {
    let dashboard = account::dashboard_url();
    let url = match target.as_str() {
        "my_data" => format!("{dashboard}/me"),
        "notice" => format!("{dashboard}/notice"),
        "screen_settings" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture".into()
        }
        "camera_settings" => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera".into()
        }
        _ => {
            return CommandResult {
                ok: false,
                error: Some("Unknown link.".into()),
            }
        }
    };
    let opened = if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
    } else {
        std::process::Command::new("open").arg(&url).spawn()
    };
    match opened {
        Ok(_) => CommandResult {
            ok: true,
            error: None,
        },
        Err(error) => CommandResult {
            ok: false,
            error: Some(error.to_string()),
        },
    }
}

/// `card_switch_project`: opens the popover next to the card; the card stays.
#[tauri::command(rename_all = "snake_case")]
fn card_switch_project(app: AppHandle) -> CommandResult {
    if let Some(popover) = app.get_webview_window(POPOVER) {
        let _ = popover.show();
        let _ = popover.set_focus();
        let _ = app.emit_to(
            POPOVER,
            EVENT_STATUS_CHANGED,
            app.state::<AgentState>().status(),
        );
    }
    CommandResult {
        ok: true,
        error: None,
    }
}

/// Network calls block; run them on a worker thread, never the UI thread.
async fn off_main_thread(f: impl FnOnce() -> Result<(), String> + Send + 'static) -> CommandResult {
    let result = tauri::async_runtime::spawn_blocking(f)
        .await
        .unwrap_or_else(|e| Err(e.to_string()));
    CommandResult {
        ok: result.is_ok(),
        error: result.err(),
    }
}

fn handle_deep_links(app: &AppHandle, urls: Vec<tauri::Url>) {
    for url in urls {
        let url = url.to_string();
        if !url.starts_with(REDIRECT_URL) {
            continue;
        }
        let app = app.clone();
        std::thread::spawn(move || {
            let state = app.state::<AgentState>();
            state.complete_sign_in(&url);
            let _ = app.emit_to(POPOVER, EVENT_STATUS_CHANGED, state.status());
        });
    }
}

/// Org intervals arrive with the policy work; defaults until then. Debug builds
/// accept `AI_PROCTOR_DEV_CHECKIN_S` (one fixed interval, in seconds) so the card
/// can be tried by hand.
fn schedule_policy() -> SchedulePolicy {
    #[cfg(debug_assertions)]
    if let Some(s) = std::env::var("AI_PROCTOR_DEV_CHECKIN_S")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
    {
        tracing::warn!(seconds = s, "dev check-in interval");
        let every = chrono::Duration::seconds(s.max(5));
        return SchedulePolicy {
            min: every,
            max: every,
        };
    }
    SchedulePolicy::default()
}

fn open_account(
    data_dir: &std::path::Path,
    clock: Arc<dyn Clock>,
    outbox: Option<Arc<Outbox>>,
) -> Option<Arc<Account>> {
    let Some(config) = account::api_config() else {
        tracing::warn!("no server configured (AI_PROCTOR_SUPABASE_URL); sign-in is off");
        return None;
    };
    match Account::new(config, key_store(), clock, outbox, data_dir) {
        Ok(account) => Some(Arc::new(account)),
        Err(error) => {
            tracing::error!(%error, "sign-in unavailable");
            None
        }
    }
}

pub fn run() {
    let builder = tauri::Builder::default();
    // Must be the first plugin: a second launch (Windows, Linux) hands its
    // aiproctor:// link to this process and exits.
    #[cfg(any(windows, target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}));
    // The check-in card is an NSPanel (card.rs); without this, to_panel() panics.
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    builder
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            get_status,
            sign_in_start,
            sign_out,
            card_click,
            card_switch_project,
            clock_in,
            clock_out,
            break_start,
            break_end,
            pause_start,
            pause_end,
            switch_project,
            set_miss_reason,
            open_link
        ])
        .setup(|app| {
            let log_dir = app.path().app_log_dir()?;
            std::fs::create_dir_all(&log_dir)?;
            // Leaked on purpose: the guard must live as long as the process.
            let guard = agent_core::logging::init(&log_dir).map_err(|e| e.to_string())?;
            Box::leak(Box::new(guard));
            tracing::info!(version = env!("CARGO_PKG_VERSION"), "agent started");

            let data_dir = data_dir(app)?;
            let outbox = match open_outbox(&data_dir) {
                Ok(outbox) => {
                    tracing::info!(stats = ?outbox.stats().ok(), "outbox open");
                    Some(Arc::new(outbox))
                }
                Err(error) => {
                    tracing::error!(%error, "outbox unavailable; nothing will be collected");
                    None
                }
            };
            let clock: Arc<dyn Clock> = Arc::new(SystemClock::default());
            let platform = agent_platform::current();
            // Debug builds only, until guided onboarding (#59) asks properly.
            #[cfg(debug_assertions)]
            if std::env::var("AI_PROCTOR_DEV_REQUEST_PERMISSIONS").as_deref() == Ok("1") {
                agent_platform::request_permissions();
                agent_platform::request_notification_permission();
            }
            #[cfg(debug_assertions)]
            let platform = dev::platform(platform);
            let sink: Arc<dyn EventSink> = match &outbox {
                Some(outbox) => Arc::new(OutboxSink { outbox: outbox.clone(), clock: clock.clone() }),
                None => Arc::new(UnavailableSink),
            };
            // Org policy (auto clock-in, shifts) arrives with register_device / the
            // heartbeat once sign-in (#16) lands; until then, defaults.
            let session = Session::new(
                SessionPolicy::default(),
                clock.clone(),
                platform.clone(),
                sink,
                Arc::new(FileSessionStore::new(&data_dir)),
            );
            tracing::info!(shift = ?session.shift(), signed_in = session.signed_in(), "session restored");
            let account = open_account(&data_dir, clock.clone(), outbox.clone());
            let scheduler = Scheduler::new(
                schedule_policy(),
                clock.clone(),
                platform.clone(),
                Arc::new(ThreadRandom),
                Arc::new(FileScheduleStore::new(&data_dir)),
            );
            app.manage(AgentState::new(
                platform,
                clock.clone(),
                session,
                scheduler,
                outbox.clone(),
                account,
            ));
            app.manage(OutboxState(outbox));
            spawn_ticker(app.handle().clone());
            spawn_sync(app.handle().clone());
            card::create(app.handle())?;
            spawn_card_runner(app.handle().clone());
            spawn_activity(app.handle().clone());
            #[cfg(all(debug_assertions, unix))]
            if let Some(path) = dev::control_path() {
                dev_control::spawn(app.handle().clone(), &path)?;
            }

            let handle = app.handle().clone();
            app.deep_link()
                .on_open_url(move |event| handle_deep_links(&handle, event.urls()));
            // Windows and Linux: the link that launched the agent.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                handle_deep_links(app.handle(), urls);
            }

            // Menu bar agent: no Dock icon, never takes over as the active app.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            build_tray(app.handle())?;

            let popover = app
                .get_webview_window(POPOVER)
                .expect("popover window in tauri.conf.json");
            let handle = popover.clone();
            popover.on_window_event(move |event| {
                if let WindowEvent::Focused(false) = event {
                    let _ = handle.hide();
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the agent");
}

fn spawn_ticker(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);
        let state = app.state::<AgentState>();
        let before = state.status();
        state.act("update the shift", |s| s.tick());
        let after = state.status();
        if after != before {
            let _ = app.emit_to(POPOVER, EVENT_STATUS_CHANGED, after);
        }
    });
}

/// Shows check-ins when the scheduler says so and ends them when they run out.
/// Sleeps until the next one is due (≤ 500 ms late, NFR-PERF-02).
fn spawn_card_runner(app: AppHandle) {
    std::thread::spawn(move || loop {
        let state = app.state::<AgentState>();
        match state.card_tick() {
            CardAction::Show(challenge) => card::show(&app, challenge),
            CardAction::Hide => card::hide(&app),
            CardAction::Nothing => {}
        }
        let wait = if state.card.lock().unwrap().is_some() {
            CARD_TICK
        } else {
            state.scheduler.wake_in().unwrap_or(TICK).min(TICK)
        };
        std::thread::sleep(wait);
    });
}

fn spawn_activity(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(activity::SAMPLE_EVERY);
        let state = app.state::<AgentState>();
        state.presence_tick();
        state.activity_tick();
    });
}

/// Sends queued events and heartbeats in the background; backs off while the
/// server is unreachable, signs out when the server ends the session.
fn spawn_sync(app: AppHandle) {
    std::thread::spawn(move || {
        let mut backoff = Backoff::default();
        let mut last_heartbeat: Option<Instant> = None;
        let mut last_prune: Option<Instant> = None;
        *app.state::<AgentState>().sync_thread.lock().unwrap() = Some(std::thread::current());
        loop {
            let state = app.state::<AgentState>();
            let due = last_heartbeat.is_none_or(|t| t.elapsed() >= HEARTBEAT_EVERY);
            let wait = match state.sync_round(due) {
                Ok(sent) => {
                    if sent {
                        last_heartbeat = Some(Instant::now());
                    }
                    backoff.success();
                    SYNC_EVERY
                }
                Err(error @ (SyncError::SignedOut(_) | SyncError::Revoked)) => {
                    state.signed_out_by_server(&error);
                    let _ = app.emit_to(POPOVER, EVENT_STATUS_CHANGED, state.status());
                    SYNC_EVERY
                }
                Err(error) => {
                    let wait = backoff.failure();
                    tracing::warn!(%error, retry_in = ?wait, "sync failed");
                    wait
                }
            };
            if last_prune.is_none_or(|t| t.elapsed() >= PRUNE_EVERY) {
                if let Some(outbox) = &app.state::<OutboxState>().0 {
                    if let Err(error) = outbox.prune(chrono::Utc::now(), UPLOAD_MAX_BYTES) {
                        tracing::warn!(%error, "outbox prune failed");
                    }
                }
                last_prune = Some(Instant::now());
            }
            // A state change (nudge_sync) wakes it early.
            std::thread::park_timeout(wait);
        }
    });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let clock_in = MenuItem::with_id(app, "clock_in", "Clock in", true, None::<&str>)?;
    let clock_out = MenuItem::with_id(app, "clock_out", "Clock out", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit AI Proctor", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&clock_in, &clock_out, &quit])?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("bundle icon"))
        .tooltip("AI Proctor")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let state = app.state::<AgentState>();
            match event.id.as_ref() {
                "clock_in" => state.act("clock in", |s| s.clock_in(None)),
                "clock_out" => state.act("clock out", |s| s.clock_out()),
                "quit" => {
                    tracing::info!("quit from tray menu");
                    app.exit(0);
                }
                _ => {}
            }
            let _ = app.emit_to(POPOVER, EVENT_STATUS_CHANGED, state.status());
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                toggle_popover(tray.app_handle(), rect);
            }
        })
        .build(app)?;
    Ok(())
}

/// Shows the popover centred under the tray icon (above it when the tray is at the
/// bottom of the screen, as on Windows), or hides it if it is open.
fn toggle_popover(app: &AppHandle, tray: Rect) {
    let Some(popover) = app.get_webview_window(POPOVER) else {
        return;
    };
    if popover.is_visible().unwrap_or(false) {
        let _ = popover.hide();
        return;
    }
    let scale = popover.scale_factor().unwrap_or(1.0);
    let tray_pos = tray.position.to_physical::<f64>(scale);
    let tray_size = tray.size.to_physical::<f64>(scale);
    let size = popover.outer_size().unwrap_or_default();
    let x = tray_pos.x + tray_size.width / 2.0 - size.width as f64 / 2.0;
    let monitor_height = popover
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.size().height as f64)
        .unwrap_or(f64::MAX);
    let y = if tray_pos.y > monitor_height / 2.0 {
        tray_pos.y - size.height as f64
    } else {
        tray_pos.y + tray_size.height
    };
    let _ = popover.set_position(PhysicalPosition::new(x.max(0.0), y.max(0.0)));
    let _ = popover.show();
    let _ = popover.set_focus();
    let status = app.state::<AgentState>().status();
    let _ = app.emit_to(POPOVER, EVENT_STATUS_CHANGED, status);
}

#[cfg(test)]
mod tests {
    use agent_core::clock::FakeClock;
    use agent_core::contracts::{PermissionState, ShiftState};
    use agent_core::fake::FakePlatform;

    use super::*;

    fn state(dir: &std::path::Path, sink: Arc<dyn EventSink>) -> AgentState {
        let platform = Arc::new(FakePlatform::default());
        let clock = Arc::new(FakeClock::at("2026-10-19T09:00:00Z"));
        let session = Session::new(
            SessionPolicy::default(),
            clock.clone(),
            platform.clone(),
            sink,
            Arc::new(FileSessionStore::new(dir)),
        );
        let scheduler = Scheduler::new(
            SchedulePolicy::default(),
            clock.clone(),
            platform.clone(),
            Arc::new(ThreadRandom),
            Arc::new(FileScheduleStore::new(dir)),
        );
        AgentState::new(platform, clock, session, scheduler, None, None)
    }

    /// Signed in and working, with one clock shared by everything and the outbox
    /// wired to both the session and the check-ins.
    struct Working {
        state: AgentState,
        outbox: Arc<Outbox>,
        clock: Arc<FakeClock>,
        platform: Arc<FakePlatform>,
        _dir: tempfile::TempDir,
    }

    fn working() -> Working {
        let dir = tempfile::tempdir().unwrap();
        let platform = Arc::new(FakePlatform::default());
        let clock = Arc::new(FakeClock::at("2026-10-19T09:00:00Z"));
        let outbox = Arc::new(Outbox::open(&dir.path().join("outbox"), &[1u8; 32]).unwrap());
        let session = Session::new(
            SessionPolicy::default(),
            clock.clone(),
            platform.clone(),
            Arc::new(OutboxSink {
                outbox: outbox.clone(),
                clock: clock.clone(),
            }),
            Arc::new(FileSessionStore::new(dir.path())),
        );
        let scheduler = Scheduler::new(
            SchedulePolicy::default(),
            clock.clone(),
            platform.clone(),
            Arc::new(ThreadRandom),
            Arc::new(FileScheduleStore::new(dir.path())),
        );
        let state = AgentState::new(
            platform.clone(),
            clock.clone(),
            session,
            scheduler,
            Some(outbox.clone()),
            None,
        );
        state.session.lock().unwrap().sign_in();
        state.act("clock in", |s| s.clock_in(None));
        Working {
            state,
            outbox,
            clock,
            platform,
            _dir: dir,
        }
    }

    impl Working {
        /// Past the longest interval (90 min): the card is due.
        fn card_due(&self) -> CardChallenge {
            assert_eq!(self.state.card_tick(), CardAction::Nothing, "not due yet");
            self.clock.advance(chrono::Duration::minutes(91));
            match self.state.card_tick() {
                CardAction::Show(challenge) => challenge,
                other => panic!("expected a card, got {other:?}"),
            }
        }

        fn checkins(&self) -> Vec<serde_json::Value> {
            self.events("checkin")
        }

        fn events(&self, event_type: &str) -> Vec<serde_json::Value> {
            self.outbox
                .pending(100)
                .unwrap()
                .into_iter()
                .filter(|e| e.event_type == event_type)
                .map(|e| e.payload)
                .collect()
        }

        /// A card that passes; its captures and event, as the command does them.
        fn pass(&self) {
            let card = self.card_due();
            let reply = self.state.card_click(&card.card_id, card.target, true);
            self.state.finish_pass(reply.pass.unwrap());
        }
    }

    fn wrong(c: &CardChallenge) -> i64 {
        c.options.iter().find(|n| **n != c.target).copied().unwrap()
    }

    // Found only when the bundle first ran on a Mac (#98): each of these broke the
    // app at runtime while every other test passed.

    #[test]
    fn every_window_gets_ipc() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let allowed: Vec<&str> = capability["windows"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|w| w.as_str())
            .collect();
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let mut windows: Vec<&str> = conf["app"]["windows"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|w| w["label"].as_str())
            .collect();
        windows.push(card::LABEL);
        for w in windows {
            assert!(
                allowed.contains(&w),
                "window `{w}` is missing from the capability"
            );
        }
    }

    #[test]
    fn commands_take_the_contracts_snake_case_arguments() {
        let bare = concat!("#[tauri::", "command]");
        let source = include_str!("lib.rs");
        let offenders = source.lines().filter(|l| l.trim() == bare).count();
        assert_eq!(offenders, 0, "a command would expect camelCase arguments");
    }

    #[test]
    fn the_card_panel_plugin_is_registered() {
        let card = include_str!("card.rs");
        let source = include_str!("lib.rs");
        if card.contains("to_panel") {
            assert!(
                source.contains(concat!("tauri_nspanel::", "init()")),
                "card.rs makes an NSPanel, so run() must register tauri_nspanel"
            );
        }
    }

    #[test]
    fn status_starts_off_shift_and_signed_out() {
        let dir = tempfile::tempdir().unwrap();
        let status = state(dir.path(), Arc::new(UnavailableSink)).status();
        assert_eq!(status.shift, ShiftState::OffShift);
        assert!(!status.signed_in);
        assert_eq!(status.agent_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(status.permissions.screen, PermissionState::Granted);
    }

    #[test]
    fn without_the_outbox_nothing_can_be_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path(), Arc::new(UnavailableSink));
        state.session.lock().unwrap().sign_in();
        state.act("clock in", |s| s.clock_in(None));
        assert_eq!(state.status().shift, ShiftState::OffShift);
    }

    #[test]
    fn clocking_in_writes_to_the_outbox() {
        let dir = tempfile::tempdir().unwrap();
        let outbox = Arc::new(Outbox::open(&dir.path().join("outbox"), &[1u8; 32]).unwrap());
        let clock = Arc::new(FakeClock::at("2026-10-19T09:00:00Z"));
        let state = state(
            dir.path(),
            Arc::new(OutboxSink {
                outbox: outbox.clone(),
                clock,
            }),
        );
        state.session.lock().unwrap().sign_in();
        state.act("clock in", |s| s.clock_in(None));
        assert_eq!(state.status().shift, ShiftState::Working);
        let pending = outbox.pending(10).unwrap();
        assert_eq!(pending[0].event_type, "clock_in");
        assert!(
            state.scheduler.wake_in().is_some(),
            "clocking in arms a check-in"
        );

        state.act("start a break", |s| s.start_break(None));
        assert_eq!(state.scheduler.wake_in(), None, "a break cancels it");
    }

    #[test]
    fn a_right_click_passes_and_arms_the_next_checkin() {
        let w = working();
        let card = w.card_due();
        assert_eq!(card.remaining_s, 90);
        assert!(card.options.contains(&card.target));
        assert_eq!(
            w.state.card_tick(),
            CardAction::Nothing,
            "one card at a time"
        );

        w.clock.advance(chrono::Duration::seconds(4));
        let reply = w.state.card_click(&card.card_id, card.target, true);
        assert_eq!((reply.result, &reply.next), (CardClickResult::Pass, &None));
        assert!(w.checkins().is_empty(), "queued once the captures are done");
        w.state.finish_pass(reply.pass.unwrap());

        let checkins = w.checkins();
        assert_eq!(checkins.len(), 1);
        assert_eq!(checkins[0]["outcome"], "pass");
        assert_eq!(checkins[0]["response_ms"], 4000);
        assert!(w.state.scheduler.wake_in().is_some(), "next check-in armed");
        assert_eq!(
            w.state.card_click(&card.card_id, card.target, true).result,
            CardClickResult::Ignored,
            "the card is gone"
        );
    }

    #[test]
    fn a_wrong_click_reshuffles_and_two_fail() {
        let w = working();
        let card = w.card_due();
        let reply = w.state.card_click(&card.card_id, wrong(&card), true);
        assert_eq!(reply.result, CardClickResult::Wrong);
        let next = reply.next.unwrap();
        assert_eq!((next.target, next.wrong_clicks), (card.target, 1));
        assert!(w.checkins().is_empty());

        let reply = w.state.card_click(&card.card_id, wrong(&next), true);
        assert_eq!(reply.result, CardClickResult::Failed);
        assert_eq!(reply.pass, None);
        let checkins = w.checkins();
        assert_eq!(checkins[0]["outcome"], "failed");
        assert_eq!(checkins[0]["wrong_clicks"], 2);
    }

    #[test]
    fn only_real_clicks_on_the_current_card_count() {
        let w = working();
        let card = w.card_due();
        assert_eq!(
            w.state.card_click("someone-else", card.target, true).result,
            CardClickResult::Ignored
        );
        assert_eq!(
            w.state.card_click(&card.card_id, card.target, false).result,
            CardClickResult::Ignored
        );
        assert_eq!(
            w.state.card_click(&card.card_id, 0, true).result,
            CardClickResult::Ignored
        );
        assert!(w.checkins().is_empty());
    }

    #[test]
    fn a_pass_lists_its_captures_and_queues_the_files() {
        let w = working();
        w.pass();
        let checkins = w.checkins();
        assert_eq!(
            checkins[0]["object_keys"],
            serde_json::json!(["screen-1.webp", "webcam.webp"])
        );
        assert!(checkins[0].get("capture_errors").is_none());
        assert_eq!(w.outbox.stats().unwrap().uploads, 2);
    }

    #[test]
    fn a_failed_capture_still_passes_and_repeated_permission_failures_report_it() {
        let w = working();
        w.platform
            .update(|s| s.permissions.screen = PermissionState::Denied);
        w.pass();
        let first = &w.checkins()[0];
        assert_eq!(first["outcome"], "pass");
        assert_eq!(first["capture_errors"]["screen"], "permission_missing");
        assert_eq!(first["object_keys"], serde_json::json!(["webcam.webp"]));
        assert!(
            w.events("permission_change").is_empty(),
            "once isn't repeated"
        );

        w.pass();
        let changes = w.events("permission_change");
        assert_eq!(
            changes,
            [serde_json::json!({ "screen": "denied", "camera": "granted" })]
        );
        w.pass();
        assert_eq!(w.events("permission_change").len(), 1, "reported once");

        w.platform
            .update(|s| s.permissions.screen = PermissionState::Granted);
        w.pass();
        let changes = w.events("permission_change");
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[1]["screen"], "granted", "reported back");
    }

    #[test]
    fn activity_is_sampled_while_working_and_flushed_on_a_break() {
        let w = working();
        w.platform.update(|s| {
            s.foreground = Some(agent_core::platform::Foreground {
                app: "Safari".into(),
                title: Some("Docs".into()),
                domain: Some("docs.example.com".into()),
                display: None,
            })
        });
        // 09:00:00 .. 09:01:30 in 5 s steps.
        for _ in 0..=18 {
            w.state.activity_tick();
            w.clock.advance(chrono::Duration::seconds(5));
        }
        let sessions = w.events("app_session");
        assert_eq!(sessions.len(), 1, "the 09:00 minute is over");
        assert_eq!(sessions[0]["app"], "Safari");
        assert_eq!(sessions[0]["start"], "2026-10-19T09:00:00Z");
        assert_eq!(sessions[0]["end"], "2026-10-19T09:01:00Z");

        w.state.act("start a break", |s| s.start_break(None));
        w.state.activity_tick();
        let sessions = w.events("app_session");
        assert_eq!(sessions.len(), 2, "the open minute is sent when work stops");
        assert_eq!(sessions[1]["end"], "2026-10-19T09:01:30Z");

        w.clock.advance(chrono::Duration::seconds(5));
        w.state.activity_tick();
        assert_eq!(w.events("app_session").len(), 2, "nothing on a break");
    }

    /// Past the longest interval with `hold` in effect: the check-in is due and held.
    fn deferred_by(w: &Working, hold: impl FnOnce(&mut agent_core::fake::FakeState)) {
        w.platform.update(hold);
        w.clock.advance(chrono::Duration::minutes(91));
        assert_eq!(w.state.card_tick(), CardAction::Nothing, "nothing is shown");
    }

    #[test]
    fn a_held_checkin_leaves_one_deferred_record_with_the_reason_and_no_capture() {
        let w = working();
        deferred_by(&w, |s| s.call.mic = true);
        for _ in 0..20 {
            w.clock.advance(chrono::Duration::minutes(1));
            assert_eq!(w.state.card_tick(), CardAction::Nothing);
        }
        let checkins = w.checkins();
        assert_eq!(checkins.len(), 1, "one record however long the call lasts");
        assert_eq!(checkins[0]["outcome"], "deferred");
        assert_eq!(checkins[0]["deferral_reason"], "call");
        assert!(checkins[0]["shown_at"].is_null());
        assert!(checkins[0]["response_ms"].is_null());
        assert_eq!(checkins[0]["object_keys"], serde_json::json!([]));
        assert_eq!(w.outbox.stats().unwrap().uploads, 0, "nothing captured");
        assert!(
            w.state.scheduler.wake_in().is_some(),
            "still scheduled: the card comes after the call"
        );
    }

    #[test]
    fn the_deferral_names_a_share_or_a_presentation() {
        use agent_core::platform::ScreenShare;
        for (share, reason) in [
            (ScreenShare::Sharing, "screen_share"),
            (ScreenShare::Presenting, "presenting"),
        ] {
            let w = working();
            deferred_by(&w, |s| s.screen_share = Some(share));
            let checkins = w.checkins();
            assert_eq!(checkins.len(), 1);
            assert_eq!(checkins[0]["deferral_reason"], reason);
        }
    }

    #[test]
    fn the_card_still_comes_after_the_hold_against_the_original_time() {
        let w = working();
        deferred_by(&w, |s| s.call.mic = true);
        w.platform.update(|s| s.call = Default::default());
        // Within 2 min of the call ending (CHK-03).
        let mut shown = None;
        for _ in 0..=120 {
            if let CardAction::Show(challenge) = w.state.card_tick() {
                shown = Some(challenge);
                break;
            }
            w.clock.advance(chrono::Duration::seconds(1));
        }
        let card = shown.expect("the card comes within 2 minutes");
        let reply = w.state.card_click(&card.card_id, card.target, true);
        w.state.finish_pass(reply.pass.unwrap());

        let checkins = w.checkins();
        assert_eq!(checkins.len(), 2);
        assert_eq!(checkins[0]["outcome"], "deferred");
        assert_eq!(checkins[1]["outcome"], "pass");
        assert_eq!(checkins[1]["scheduled_at"], checkins[0]["scheduled_at"]);
        assert_eq!(
            checkins[1]["object_keys"],
            serde_json::json!(["screen-1.webp", "webcam.webp"])
        );
    }

    #[test]
    fn a_lock_leaves_no_deferred_record() {
        let w = working();
        deferred_by(&w, |s| s.session = SessionState::Locked);
        assert!(w.checkins().is_empty());
    }

    #[test]
    fn a_card_that_runs_out_is_a_miss() {
        let w = working();
        w.card_due();
        w.clock.advance(chrono::Duration::seconds(89));
        assert_eq!(w.state.card_tick(), CardAction::Nothing);
        w.clock.advance(chrono::Duration::seconds(2));
        assert_eq!(w.state.card_tick(), CardAction::Hide);
        let checkins = w.checkins();
        assert_eq!(checkins[0]["outcome"], "miss");
        assert!(checkins[0]["response_ms"].is_null());
        assert!(w.state.scheduler.wake_in().unwrap() <= Duration::from_secs(60));
    }

    #[test]
    fn a_break_during_the_card_cancels_it_without_a_miss() {
        let w = working();
        w.card_due();
        w.state.act("start a break", |s| s.start_break(None));
        assert_eq!(w.state.card_tick(), CardAction::Hide);
        assert!(w.checkins().is_empty());
        assert_eq!(w.state.scheduler.wake_in(), None);
    }

    #[test]
    fn config_from_the_server_sets_shifts_and_auto_clock_in() {
        let dir = tempfile::tempdir().unwrap();
        let outbox = Arc::new(Outbox::open(&dir.path().join("outbox"), &[1u8; 32]).unwrap());
        let clock = Arc::new(FakeClock::at("2026-10-19T09:00:00Z"));
        let state = state(dir.path(), Arc::new(OutboxSink { outbox, clock }));
        state.session.lock().unwrap().sign_in();
        state.act("update the shift", |s| s.tick());
        assert_eq!(state.status().shift, ShiftState::OffShift, "no shift yet");

        // Monday 2026-10-19 09:00 UTC is inside an 08:00–17:00 UTC shift.
        let config: agent_core::config::AgentConfig = serde_json::from_value(serde_json::json!({
            "policy": { "auto_clock_in": true },
            "policy_version": 2,
            "timezone": "UTC",
            "shifts": [{ "days": [1], "start": "08:00", "end": "17:00", "timezone": "UTC" }]
        }))
        .unwrap();
        state.apply_config(&config);
        state.act("update the shift", |s| s.tick());
        assert_eq!(
            state.status().shift,
            ShiftState::Working,
            "auto clock-in (SHF-03)"
        );
    }

    #[test]
    fn state_changes_are_queued_while_working_only() {
        let w = working();
        w.platform.update(|s| s.session = SessionState::Locked);
        w.state.presence_tick();
        assert_eq!(w.events("lock").len(), 1, "locked while working: sent");
        w.state.presence_tick();
        assert_eq!(w.events("lock").len(), 1, "only on change");

        w.platform.update(|s| s.session = SessionState::Active);
        w.state.act("start a break", |s| s.start_break(None));
        w.platform.update(|s| s.call.mic = true);
        w.state.presence_tick();
        assert!(
            w.events("unlock").is_empty() && w.events("call_start").is_empty(),
            "nothing on a break"
        );

        w.state.act("end the break", |s| s.end_break());
        w.state.presence_tick();
        assert_eq!(
            w.events("call_start").len(),
            1,
            "reported fresh after the break"
        );
    }

    #[test]
    fn a_screen_share_is_queued_as_a_call_while_working() {
        use agent_core::platform::ScreenShare;
        let w = working();
        w.platform
            .update(|s| s.screen_share = Some(ScreenShare::Sharing));
        w.state.presence_tick();
        let starts = w.events("call_start");
        assert_eq!(starts.len(), 1, "share started: a call starts");
        assert_eq!(starts[0]["source"], "screen_share");

        w.platform.update(|s| s.screen_share = None);
        w.state.presence_tick();
        let ends = w.events("call_end");
        assert_eq!(ends.len(), 1, "share ended: the call ends");
        assert_eq!(ends[0]["source"], "screen_share");
    }

    #[test]
    fn the_org_idle_threshold_comes_with_the_config() {
        let w = working();
        let config: agent_core::config::AgentConfig = serde_json::from_value(serde_json::json!({
            "policy": { "idle_threshold_min": 2 },
            "policy_version": 2,
            "timezone": "UTC",
            "shifts": []
        }))
        .unwrap();
        w.state.apply_config(&config);
        w.platform.update(|s| s.idle_seconds = 130);
        w.state.presence_tick();
        assert_eq!(w.events("idle_start").len(), 1);
    }

    #[test]
    fn the_tray_status_has_today_projects_and_the_last_miss() {
        let w = working();
        let config: agent_core::config::AgentConfig = serde_json::from_value(serde_json::json!({
            "policy": { "pause_daily_max_min": 45 },
            "policy_version": 2,
            "timezone": "UTC",
            "shifts": [],
            "projects": [{ "id": "0190f5b0-0000-7000-8000-0000000000f1", "name": "Website revamp", "client": "Northwind" }]
        }))
        .unwrap();
        w.state.apply_config(&config);
        let project = uuid::Uuid::parse_str("0190f5b0-0000-7000-8000-0000000000f1").unwrap();
        w.state.act("switch", |s| s.switch_project(Some(project)));

        w.card_due();
        w.clock.advance(chrono::Duration::seconds(91));
        assert_eq!(w.state.card_tick(), CardAction::Hide, "a miss");
        w.state
            .act("pause", |s| s.start_pause_with_reason(5, Some("call")));
        w.clock.advance(chrono::Duration::minutes(2));

        let status = w.state.status();
        assert_eq!(status.projects.len(), 1);
        assert_eq!(
            status.project.as_ref().map(|p| p.name.as_str()),
            Some("Website revamp")
        );
        assert_eq!(status.pause_daily_cap_s, 45 * 60);
        assert_eq!(status.pause_used_today_s, 120);
        assert_eq!(status.pause_planned_min, Some(5));
        assert!(status.pause_ends_at.is_some());
        assert!(status.worked_today_s >= 91 * 60, "the shift so far counts");
        assert!(
            status.missed_checkin.is_some(),
            "the miss waits for a reason"
        );
        assert_eq!(
            status.last_checkin.map(|c| c.outcome),
            Some(agent_core::contracts::CheckinOutcome::Miss)
        );
        let json = serde_json::to_string(&w.state.status()).unwrap();
        assert!(!json.contains("next"), "never the next check-in time");
    }

    #[test]
    fn a_quick_clock_out_and_in_never_spans_both_shifts() {
        let w = working();
        w.platform.update(|s| {
            s.foreground = Some(agent_core::platform::Foreground {
                app: "Xcode".into(),
                title: None,
                domain: None,
                display: None,
            })
        });
        for _ in 0..4 {
            w.state.activity_tick();
            w.clock.advance(chrono::Duration::seconds(5));
        }
        // 09:00:20: out and back in before the next 5 s sample.
        w.state.act("clock out", |s| s.clock_out());
        let out_at = w.clock.now();
        w.clock.advance(chrono::Duration::seconds(2));
        w.state.act("clock in", |s| s.clock_in(None));
        let in_at = w.clock.now();
        for _ in 0..3 {
            w.clock.advance(chrono::Duration::seconds(5));
            w.state.activity_tick();
        }
        w.state.act("clock out", |s| s.clock_out());

        let buckets = w.events("app_session");
        assert_eq!(buckets.len(), 2, "one per shift: {buckets:?}");
        let t = |v: &serde_json::Value| {
            v.as_str()
                .unwrap()
                .parse::<chrono::DateTime<chrono::Utc>>()
                .unwrap()
        };
        assert!(
            t(&buckets[0]["end"]) <= out_at,
            "first ends by the clock-out"
        );
        assert!(
            t(&buckets[1]["start"]) >= in_at,
            "second starts after the clock-in"
        );
    }

    #[test]
    fn heartbeat_is_content_free_during_a_break_and_off_while_off_shift() {
        let dir = tempfile::tempdir().unwrap();
        let outbox = Arc::new(Outbox::open(&dir.path().join("outbox"), &[1u8; 32]).unwrap());
        let clock = Arc::new(FakeClock::at("2026-10-19T09:00:00Z"));
        let state = state(dir.path(), Arc::new(OutboxSink { outbox, clock }));
        state.session.lock().unwrap().sign_in();
        assert_eq!(state.heartbeat(), None, "off shift: no heartbeat");

        state.act("clock in", |s| s.clock_in(None));
        let working = state.heartbeat().unwrap();
        assert_eq!(working.permissions["screen"], "granted");

        state.act("start a break", |s| s.start_break(None));
        let on_break = state.heartbeat().unwrap();
        assert_eq!(on_break.idle_s, 0);
        assert!(!on_break.locked && !on_break.in_call);
        assert!(on_break.permissions.is_null());
    }

    #[test]
    fn without_a_server_sign_in_explains_and_sync_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path(), Arc::new(UnavailableSink));
        assert!(state.start_sign_in("lucas@acme.test").is_err());
        assert_eq!(
            state.start_sign_in("lucas").unwrap_err(),
            "Enter your work email."
        );
        state.session.lock().unwrap().sign_in();
        assert_eq!(state.sync_round(true), Ok(false));
    }
}
