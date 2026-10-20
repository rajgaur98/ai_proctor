//! The onboarding window (#48, #59; AGT-03, AGT-04, AGT-05, EMP-05): the four steps of
//! the Onboarding design, 720×560. Step 1 is the monitoring notice, 2 the permissions,
//! 3 a test capture, 4 "You're set". One ordinary window (unlike the check-in card):
//! the person reads and presses the buttons. Created hidden at startup; closing it
//! only hides it, so the tray can bring it back at any step. The label stays
//! `notice`, which the capability file names.

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::EVENT_ONBOARDING_CLOSED;

pub const LABEL: &str = "notice";
const WIDTH: f64 = 720.0;
const HEIGHT: f64 = 560.0;

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("notice.html".into()))
        .title("Set up AI Proctor")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .center()
        .visible(false)
        .build()?;
    let handle = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = handle.hide();
            closed(handle.app_handle());
        }
    });
    Ok(())
}

/// Tells the window it was closed, so it drops the test images it holds.
fn closed(app: &AppHandle) {
    let _ = app.emit_to(LABEL, EVENT_ONBOARDING_CLOSED, serde_json::json!({}));
}

/// Brings the window to the front. Window calls run on the main thread.
pub fn show(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window(LABEL) else {
            tracing::error!("onboarding window missing");
            return;
        };
        let _ = window.center();
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    });
}

pub fn hide(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window(LABEL) {
            let _ = window.hide();
        }
        closed(&handle);
    });
}
