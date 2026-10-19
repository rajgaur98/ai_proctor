//! Tauri shell for the agent: tray icon, popover window, and the IPC surface
//! defined in `packages/contracts`. Agent logic lives in `agent-core`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_core::clock::{Clock, SystemClock};
use agent_core::contracts::AgentStatus;
use agent_core::outbox::{Outbox, OutboxError};
use agent_core::platform::Platform;
use agent_core::scheduler::{FileScheduleStore, SchedulePolicy, Scheduler, ThreadRandom};
use agent_core::session::{
    EventSink, FileSessionStore, OutboxSink, Session, SessionPolicy, TransitionError,
};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Rect, WindowEvent};

const POPOVER: &str = "popover";

/// Event names; must match `ipcEvents` in packages/contracts/src/ipc.ts.
pub const EVENT_STATUS_CHANGED: &str = "status_changed";

/// How often the session's time-driven rules run (auto clock-in, pause end,
/// forgotten clock-out).
const TICK: Duration = Duration::from_secs(5);

pub struct AgentState {
    platform: Arc<dyn Platform>,
    session: Mutex<Session>,
    /// Never exposed over IPC: the next check-in time stays in the core.
    scheduler: Scheduler,
}

impl AgentState {
    pub fn new(platform: Arc<dyn Platform>, session: Session, scheduler: Scheduler) -> Self {
        let state = Self {
            platform,
            session: Mutex::new(session),
            scheduler,
        };
        state.sync_schedule();
        state
    }

    /// Working arms the next check-in; a break, a pause or clock-out cancels it
    /// without a miss (LLD 02). The card loop that polls it arrives with #20.
    fn sync_schedule(&self) {
        if self.session.lock().unwrap().shift() == agent_core::contracts::ShiftState::Working {
            self.scheduler.start();
        } else {
            self.scheduler.cancel();
        }
    }

    pub fn status(&self) -> AgentStatus {
        let session = self.session.lock().unwrap();
        agent_core::status::agent_status(
            self.platform.as_ref(),
            session.shift(),
            session.signed_in(),
            env!("CARGO_PKG_VERSION"),
        )
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

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_status])
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
            let scheduler = Scheduler::new(
                SchedulePolicy::default(),
                clock,
                platform.clone(),
                Arc::new(ThreadRandom),
                Arc::new(FileScheduleStore::new(&data_dir)),
            );
            app.manage(AgentState::new(platform, session, scheduler));
            app.manage(OutboxState(outbox));
            spawn_ticker(app.handle().clone());

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
        AgentState::new(platform, session, scheduler)
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
}
