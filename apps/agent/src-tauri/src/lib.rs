//! Tauri shell for the agent: tray icon, popover window, and the IPC surface
//! defined in `packages/contracts`. Agent logic lives in `agent-core`.

use std::sync::{Arc, Mutex};

use agent_core::contracts::{AgentStatus, ShiftState};
use agent_core::platform::Platform;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Rect, WindowEvent};

const POPOVER: &str = "popover";

/// Event names; must match `ipcEvents` in packages/contracts/src/ipc.ts.
pub const EVENT_STATUS_CHANGED: &str = "status_changed";

pub struct AgentState {
    platform: Arc<dyn Platform>,
    shift: Mutex<ShiftState>,
    signed_in: Mutex<bool>,
}

impl AgentState {
    pub fn new(platform: Arc<dyn Platform>) -> Self {
        Self {
            platform,
            shift: Mutex::new(ShiftState::OffShift),
            signed_in: Mutex::new(false),
        }
    }

    pub fn status(&self) -> AgentStatus {
        agent_core::status::agent_status(
            self.platform.as_ref(),
            *self.shift.lock().unwrap(),
            *self.signed_in.lock().unwrap(),
            env!("CARGO_PKG_VERSION"),
        )
    }
}

/// `get_status`: what the tray popover shows.
#[tauri::command]
fn get_status(state: tauri::State<'_, AgentState>) -> AgentStatus {
    state.status()
}

pub fn run() {
    tauri::Builder::default()
        .manage(AgentState::new(agent_platform::current()))
        .invoke_handler(tauri::generate_handler![get_status])
        .setup(|app| {
            let log_dir = app.path().app_log_dir()?;
            std::fs::create_dir_all(&log_dir)?;
            // Leaked on purpose: the guard must live as long as the process.
            let guard = agent_core::logging::init(&log_dir).map_err(|e| e.to_string())?;
            Box::leak(Box::new(guard));
            tracing::info!(version = env!("CARGO_PKG_VERSION"), "agent started");

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

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let quit = MenuItem::with_id(app, "quit", "Quit AI Proctor", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quit])?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("bundle icon"))
        .tooltip("AI Proctor")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "quit" {
                tracing::info!("quit from tray menu");
                app.exit(0);
            }
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
    use agent_core::contracts::PermissionState;
    use agent_core::fake::FakePlatform;

    use super::*;

    #[test]
    fn status_starts_off_shift_and_signed_out() {
        let state = AgentState::new(Arc::new(FakePlatform::default()));
        let status = state.status();
        assert_eq!(status.shift, ShiftState::OffShift);
        assert!(!status.signed_in);
        assert_eq!(status.agent_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(status.permissions.screen, PermissionState::Granted);
    }
}
