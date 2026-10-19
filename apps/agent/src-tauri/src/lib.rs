//! Tauri shell for the agent: tray icon, popover window, and the IPC surface
//! defined in `packages/contracts`. Agent logic lives in `agent-core`.

pub mod account;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use account::Account;
use agent_core::auth::{AuthError, REDIRECT_URL};
use agent_core::clock::{Clock, SystemClock};
use agent_core::contracts::{AgentStatus, CommandResult, ShiftState};
use agent_core::keystore::KeyStore;
use agent_core::outbox::{Outbox, OutboxError, UPLOAD_MAX_BYTES};
use agent_core::platform::{Platform, SessionState};
use agent_core::scheduler::{FileScheduleStore, SchedulePolicy, Scheduler, ThreadRandom};
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

pub struct AgentState {
    platform: Arc<dyn Platform>,
    session: Mutex<Session>,
    /// Never exposed over IPC: the next check-in time stays in the core.
    scheduler: Scheduler,
    /// `None` when this build has no server configured (see `account::api_config`).
    account: Option<Arc<Account>>,
    /// The last sign-in link handled, so a link delivered twice is used once.
    last_redirect: Mutex<Option<String>>,
}

impl AgentState {
    pub fn new(
        platform: Arc<dyn Platform>,
        session: Session,
        scheduler: Scheduler,
        account: Option<Arc<Account>>,
    ) -> Self {
        let state = Self {
            platform,
            session: Mutex::new(session),
            scheduler,
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
        let session = self.session.lock().unwrap();
        agent_core::status::agent_status(
            self.platform.as_ref(),
            session.shift(),
            session.signed_in(),
            email,
            env!("CARGO_PKG_VERSION"),
        )
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
        match self.heartbeat().filter(|_| heartbeat_due) {
            Some(heartbeat) => account.heartbeat(&heartbeat).map(|()| true),
            None => Ok(false),
        }
    }

    /// Runs a transition; failures are logged and shown as a notification.
    fn act(&self, what: &str, f: impl FnOnce(&mut Session) -> Result<(), TransitionError>) {
        let result = f(&mut self.session.lock().unwrap());
        if let Err(error) = result {
            tracing::warn!(%error, what, "transition refused");
            self.platform
                .notify(&format!("Couldn't {what}"), &error.to_string());
        }
        self.sync_schedule();
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

fn open_outbox(data_dir: &std::path::Path) -> Result<Outbox, String> {
    let keychain = agent_platform::keychain::OsKeychain;
    let key =
        agent_core::keystore::get_or_create(&keychain, OUTBOX_KEY).map_err(|e| e.to_string())?;
    Outbox::open(&data_dir.join("outbox"), &key).map_err(|e: OutboxError| e.to_string())
}

/// `get_status`: what the tray popover shows.
#[tauri::command]
fn get_status(state: tauri::State<'_, AgentState>) -> AgentStatus {
    state.status()
}

/// `sign_in_start`: emails a magic link to `email`.
#[tauri::command]
async fn sign_in_start(app: AppHandle, email: String) -> CommandResult {
    off_main_thread(move || app.state::<AgentState>().start_sign_in(&email)).await
}

/// `sign_out`: ends the shift and the session.
#[tauri::command]
async fn sign_out(app: AppHandle) -> CommandResult {
    off_main_thread(move || {
        let state = app.state::<AgentState>();
        state.sign_out();
        let _ = app.emit_to(POPOVER, EVENT_STATUS_CHANGED, state.status());
        Ok(())
    })
    .await
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

fn open_account(
    data_dir: &std::path::Path,
    clock: Arc<dyn Clock>,
    outbox: Option<Arc<Outbox>>,
) -> Option<Arc<Account>> {
    let Some(config) = account::api_config() else {
        tracing::warn!("no server configured (AI_PROCTOR_SUPABASE_URL); sign-in is off");
        return None;
    };
    let keychain: Arc<dyn KeyStore> = Arc::new(agent_platform::keychain::OsKeychain);
    match Account::new(config, keychain, clock, outbox, data_dir) {
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
    builder
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![get_status, sign_in_start, sign_out])
        .setup(|app| {
            let log_dir = app.path().app_log_dir()?;
            std::fs::create_dir_all(&log_dir)?;
            // Leaked on purpose: the guard must live as long as the process.
            let guard = agent_core::logging::init(&log_dir).map_err(|e| e.to_string())?;
            Box::leak(Box::new(guard));
            tracing::info!(version = env!("CARGO_PKG_VERSION"), "agent started");

            let data_dir = app.path().app_data_dir()?;
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
                SchedulePolicy::default(),
                clock,
                platform.clone(),
                Arc::new(ThreadRandom),
                Arc::new(FileScheduleStore::new(&data_dir)),
            );
            app.manage(AgentState::new(platform, session, scheduler, account));
            app.manage(OutboxState(outbox));
            spawn_ticker(app.handle().clone());
            spawn_sync(app.handle().clone());

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

/// Sends queued events and heartbeats in the background; backs off while the
/// server is unreachable, signs out when the server ends the session.
fn spawn_sync(app: AppHandle) {
    std::thread::spawn(move || {
        let mut backoff = Backoff::default();
        let mut last_heartbeat: Option<Instant> = None;
        let mut last_prune: Option<Instant> = None;
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
            std::thread::sleep(wait);
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
            clock,
            platform.clone(),
            Arc::new(ThreadRandom),
            Arc::new(FileScheduleStore::new(dir)),
        );
        AgentState::new(platform, session, scheduler, None)
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
