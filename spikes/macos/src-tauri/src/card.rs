//! #11: check-in card as a non-activating NSPanel (approach 1: tauri-nspanel).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, StyleMask, WebviewWindowExt};

use crate::log::log;
use crate::macos;

pub const LABEL: &str = "card";
const WIDTH: f64 = 360.0;
const HEIGHT: f64 = 200.0;

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

/// Window level to test. Values are CGWindowLevel constants.
pub fn level_value(name: &str) -> i64 {
    match name {
        "floating" => 3,         // NSFloatingWindowLevel
        "mainmenu+1" => 25,      // kCGMainMenuWindowLevel + 1 (= NSStatusWindowLevel)
        "popup" => 101,          // NSPopUpMenuWindowLevel
        "screensaver" => 1000,   // NSScreenSaverWindowLevel
        "screensaver+1" => 1001, // above the screen saver
        _ => 25,
    }
}

/// State of the card currently on screen.
struct Showing {
    id: u64,
    trigger: Instant,
    target: u8,
    wrong: u8,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static SHOWING: Mutex<Option<Showing>> = Mutex::new(None);
static AUTO_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize)]
struct Challenge {
    id: u64,
    target: u8,
    order: [u8; 3],
}

pub fn create(app: &AppHandle, level: &str) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("card.html".into()))
        .title("Check-in")
        .inner_size(WIDTH, HEIGHT)
        .decorations(false)
        .resizable(false)
        .visible(false)
        .focused(false)
        .always_on_top(true)
        .skip_taskbar(true)
        // A click on a non-key window must reach the web content on the first click.
        .accept_first_mouse(true)
        .build()?;

    let panel = window
        .to_panel::<CardPanel>()
        .expect("convert card window to NSPanel");
    panel
        .add_style_mask(StyleMask::empty().nonactivating_panel().into())
        .expect("make card panel non-activating");
    panel.set_collection_behavior(
        CollectionBehavior::new()
            .can_join_all_spaces()
            .full_screen_auxiliary()
            .stationary()
            .ignores_cycle()
            .into(),
    );
    panel.set_level(level_value(level));
    log(&format!(
        "card panel created at level {level} ({})",
        level_value(level)
    ));
    Ok(())
}

pub fn set_level(app: &AppHandle, level: &str) {
    if let Ok(panel) = app.get_webview_panel(LABEL) {
        panel.set_level(level_value(level));
        log(&format!(
            "card level set to {level} ({})",
            level_value(level)
        ));
    }
}

/// Shows the card on a random monitor at a random position. `trigger` is when the
/// check-in was due, for the NFR-PERF-02 latency measurement.
pub fn show(app: &AppHandle, trigger: Instant) {
    let window = app.get_webview_window(LABEL).expect("card window");
    let before = macos::frontmost_app();

    let monitors = window.available_monitors().unwrap_or_default();
    let Some(monitor) =
        (!monitors.is_empty()).then(|| &monitors[fastrand::usize(..monitors.len())])
    else {
        log("no monitors found");
        return;
    };
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let card_w = (WIDTH * scale) as i32;
    let card_h = (HEIGHT * scale) as i32;
    let max_x = (area.size.width as i32 - card_w).max(1);
    let max_y = (area.size.height as i32 - card_h).max(1);
    let x = area.position.x + fastrand::i32(0..max_x);
    let y = area.position.y + fastrand::i32(0..max_y);
    let _ = window.set_position(PhysicalPosition::new(x, y));

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let target = fastrand::u8(1..=9);
    let challenge = Challenge {
        id,
        target,
        order: shuffled_with(target),
    };
    *SHOWING.lock().unwrap() = Some(Showing {
        id,
        trigger,
        target,
        wrong: 0,
    });
    let _ = window.emit_to(LABEL, "card:challenge", challenge);

    let panel = app.get_webview_panel(LABEL).expect("card panel");
    // On screen without activating the app or making the panel key.
    panel.order_front_regardless();
    let shown_ms = trigger.elapsed().as_secs_f64() * 1000.0;

    log(&format!(
        "#{id} SHOW monitor={:?} ({}/{} monitors) at ({x},{y}) | frontmost before={before} after={} | our app active={} | card is key={} | show() returned after {shown_ms:.1} ms",
        monitor.name().map(String::as_str).unwrap_or("?"),
        monitors.iter().position(|m| m.name() == monitor.name()).map_or(0, |i| i + 1),
        monitors.len(),
        macos::frontmost_app(),
        macos::our_app_active(),
        panel.as_panel().isKeyWindow(),
    ));
}

pub fn painted(id: u64) {
    if let Some(s) = SHOWING.lock().unwrap().as_ref().filter(|s| s.id == id) {
        log(&format!(
            "#{id} PAINTED {:.1} ms after trigger (NFR-PERF-02 target <= 500 ms)",
            s.trigger.elapsed().as_secs_f64() * 1000.0
        ));
    }
}

/// Returns the new button order after a wrong click, or None when the card closes.
pub fn click(app: &AppHandle, id: u64, value: u8) -> Option<[u8; 3]> {
    let mut guard = SHOWING.lock().unwrap();
    let s = guard.as_mut().filter(|s| s.id == id)?;
    let elapsed = s.trigger.elapsed().as_millis();
    let context = format!(
        "frontmost={} | our app active={} | card is key={}",
        macos::frontmost_app(),
        macos::our_app_active(),
        app.get_webview_panel(LABEL)
            .map(|p| p.as_panel().isKeyWindow())
            .unwrap_or(false)
    );
    if value == s.target {
        log(&format!(
            "#{id} CLICK {value} = PASS after {elapsed} ms | {context}"
        ));
        *guard = None;
        hide_later(app, Duration::from_secs(2));
        return None;
    }
    s.wrong += 1;
    if s.wrong >= 2 {
        log(&format!(
            "#{id} CLICK {value} wrong x2 = FAILED | {context}"
        ));
        *guard = None;
        hide_later(app, Duration::from_millis(500));
        return None;
    }
    log(&format!(
        "#{id} CLICK {value} wrong, reshuffling | {context}"
    ));
    Some(shuffled_with(s.target))
}

pub fn key_received(key: &str) {
    log(&format!(
        "KEY reached the card webview: {key:?} (CHK-11 violation)"
    ));
}

pub fn hide(app: &AppHandle) {
    if let Ok(panel) = app.get_webview_panel(LABEL) {
        panel.hide();
    }
}

fn hide_later(app: &AppHandle, after: Duration) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(after);
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || hide(&handle));
    });
}

/// Shows the card every `interval` for `count` rounds; unanswered cards count as a
/// miss after 20 s.
pub fn start_auto(app: &AppHandle, interval: Duration, count: u32) {
    if AUTO_RUNNING.swap(true, Ordering::SeqCst) {
        log("auto mode already running");
        return;
    }
    log(&format!(
        "auto mode: {count} cards, every {}s",
        interval.as_secs()
    ));
    let app = app.clone();
    std::thread::spawn(move || {
        for round in 1..=count {
            std::thread::sleep(interval);
            if !AUTO_RUNNING.load(Ordering::SeqCst) {
                break;
            }
            let trigger = Instant::now();
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || show(&handle, trigger));
            std::thread::sleep(Duration::from_secs(20));
            let missed = SHOWING.lock().unwrap().take();
            if let Some(s) = missed {
                log(&format!(
                    "#{} MISS (no correct click in 20 s), round {round}/{count}",
                    s.id
                ));
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || hide(&handle));
            }
        }
        AUTO_RUNNING.store(false, Ordering::SeqCst);
        log("auto mode finished");
    });
}

pub fn stop_auto() {
    AUTO_RUNNING.store(false, Ordering::SeqCst);
    log("auto mode stopping after the current round");
}

fn shuffled_with(target: u8) -> [u8; 3] {
    let mut others: Vec<u8> = (1..=9).filter(|n| *n != target).collect();
    fastrand::shuffle(&mut others);
    let mut order = [target, others[0], others[1]];
    fastrand::shuffle(&mut order);
    order
}
