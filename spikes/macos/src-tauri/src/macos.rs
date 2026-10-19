//! Small AppKit queries used to check that the card never steals focus.

use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSWorkspace};

/// Name of the app that currently owns keyboard focus (the frontmost app).
pub fn frontmost_app() -> String {
    let workspace = NSWorkspace::sharedWorkspace();
    workspace
        .frontmostApplication()
        .and_then(|app| app.localizedName())
        .map(|name| name.to_string())
        .unwrap_or_else(|| "?".into())
}

/// Whether this spike app became the active app (it must not, for CHK-11).
pub fn our_app_active() -> bool {
    MainThreadMarker::new()
        .map(|mtm| NSApplication::sharedApplication(mtm).isActive())
        .unwrap_or(false)
}
