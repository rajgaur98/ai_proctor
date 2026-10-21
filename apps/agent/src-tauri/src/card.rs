//! The check-in card window (#20), as chosen in spike #11
//! (docs/spikes/checkin-card-macos.md): on macOS a non-activating `NSPanel` that
//! never becomes key, joins every Space and floats above full-screen apps, so
//! typing keeps going to the app the person is using. Shown on a random monitor
//! at a random position.

use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder,
};

use agent_core::contracts::CardChallenge;
use agent_core::platform::ScreenRect;

use crate::AgentState;

pub const LABEL: &str = "card";
/// Must match `ipcEvents` in packages/contracts/src/ipc.ts.
pub const EVENT_CHALLENGE: &str = "card_challenge";
/// The design's size, used until the first card brings its own (CHK-15: each card
/// varies it a little, `CardLook`).
const WIDTH: f64 = 360.0;
const HEIGHT: f64 = 220.0;

#[cfg(target_os = "macos")]
mod panel {
    use tauri_nspanel::tauri_panel;

    tauri_panel! {
        panel!(CardPanel {
            config: {
                can_become_key_window: false,
                can_become_main_window: false,
                is_floating_panel: true,
                hides_on_deactivate: false,
                works_when_modal: true
            }
        })
    }

    /// kCGMainMenuWindowLevel + 1: above full-screen apps and the menu bar.
    pub const LEVEL: i64 = 25;
}

/// Creates the hidden card window once, at startup.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("card.html".into()))
        .title("Check-in")
        .inner_size(WIDTH, HEIGHT)
        .decorations(false)
        .resizable(false)
        .visible(false)
        .focused(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .accept_first_mouse(true)
        .build()?;

    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::{CollectionBehavior, StyleMask, WebviewWindowExt};
        let panel = window.to_panel::<panel::CardPanel>().map_err(panel_error)?;
        panel
            .add_style_mask(StyleMask::empty().nonactivating_panel().into())
            .map_err(panel_error)?;
        panel.set_collection_behavior(
            CollectionBehavior::new()
                .can_join_all_spaces()
                .full_screen_auxiliary()
                .stationary()
                .ignores_cycle()
                .into(),
        );
        panel.set_level(panel::LEVEL);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    Ok(())
}

#[cfg(target_os = "macos")]
fn panel_error(e: impl std::fmt::Debug) -> tauri::Error {
    tauri::Error::Io(std::io::Error::other(format!("card panel: {e:?}")))
}

/// Shows `challenge` on a random monitor at a random spot, without taking focus, at
/// the size its look asks for (CHK-15). Window calls run on the main thread.
pub fn show(app: &AppHandle, challenge: CardChallenge) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window(LABEL) else {
            tracing::error!("card window missing");
            return;
        };
        let (width, height) = (challenge.look.width as f64, challenge.look.height as f64);
        let (width, height) = if width > 0.0 && height > 0.0 {
            (width, height)
        } else {
            (WIDTH, HEIGHT)
        };
        let _ = window.set_size(LogicalSize::new(width, height));
        let monitors = window.available_monitors().unwrap_or_default();
        if !monitors.is_empty() {
            let monitor = &monitors[fastrand::usize(..monitors.len())];
            let area = monitor.work_area();
            let scale = monitor.scale_factor();
            let max_x = (area.size.width as i32 - (width * scale) as i32).max(1);
            let max_y = (area.size.height as i32 - (height * scale) as i32).max(1);
            let x = area.position.x + fastrand::i32(0..max_x);
            let y = area.position.y + fastrand::i32(0..max_y);
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
        let _ = handle.emit_to(LABEL, EVENT_CHALLENGE, challenge);
        #[cfg(target_os = "macos")]
        {
            use tauri_nspanel::ManagerExt;
            match handle.get_webview_panel(LABEL) {
                Ok(panel) => panel.order_front_regardless(),
                Err(error) => tracing::error!(?error, "card panel missing"),
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            // Windows behaviour (no activation) is spike #12's job.
            let _ = window.show();
        }
        // ANT-02: watch the card's area for injected clicks while it is up.
        match (window.outer_position(), window.outer_size()) {
            (Ok(position), Ok(size)) => {
                handle.state::<AgentState>().start_input_guard(ScreenRect {
                    x: position.x,
                    y: position.y,
                    width: size.width,
                    height: size.height,
                })
            }
            _ => tracing::warn!("card window area unknown: input guard not started"),
        }
    });
}

/// Sends a reshuffled challenge to the card already on screen.
pub fn update(app: &AppHandle, challenge: CardChallenge) {
    let _ = app.emit_to(LABEL, EVENT_CHALLENGE, challenge);
}

pub fn hide(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        {
            use tauri_nspanel::ManagerExt;
            if let Ok(panel) = handle.get_webview_panel(LABEL) {
                panel.hide();
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            if let Some(window) = handle.get_webview_window(LABEL) {
                let _ = window.hide();
            }
        }
    });
}
