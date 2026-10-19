//! Throwaway macOS spike app. #11: check-in card. #13 and #14 add modules later.

mod card;
mod log;
mod macos;

use std::time::{Duration, Instant};

use tauri::AppHandle;

#[tauri::command]
fn show_card(app: AppHandle, delay_s: u64) {
    let trigger_in = Duration::from_secs(delay_s);
    log::log(&format!("show_card scheduled in {delay_s}s"));
    std::thread::spawn(move || {
        std::thread::sleep(trigger_in);
        let trigger = Instant::now();
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || card::show(&handle, trigger));
    });
}

#[tauri::command]
fn hide_card(app: AppHandle) {
    card::hide(&app);
}

#[tauri::command]
fn set_card_level(app: AppHandle, level: String) {
    card::set_level(&app, &level);
}

#[tauri::command]
fn start_auto(app: AppHandle, interval_s: u64, count: u32) {
    card::start_auto(&app, Duration::from_secs(interval_s), count);
}

#[tauri::command]
fn stop_auto() {
    card::stop_auto();
}

#[tauri::command]
fn card_painted(id: u64) {
    card::painted(id);
}

#[tauri::command]
fn card_click(app: AppHandle, id: u64, value: u8) -> Option<[u8; 3]> {
    card::click(&app, id, value)
}

#[tauri::command]
fn card_key(key: String) {
    card::key_received(&key);
}

#[tauri::command]
fn log_path() -> String {
    log::path().display().to_string()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_nspanel::init())
        .invoke_handler(tauri::generate_handler![
            show_card,
            hide_card,
            set_card_level,
            start_auto,
            stop_auto,
            card_painted,
            card_click,
            card_key,
            log_path
        ])
        .setup(|app| {
            log::init(app.handle());
            // Tray-style agent: no Dock icon, never the "main" app.
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            log::log(&format!(
                "spike started, pid {} (bundled: {})",
                std::process::id(),
                std::env::current_exe()
                    .map(|p| p.to_string_lossy().contains(".app/Contents/MacOS"))
                    .unwrap_or(false)
            ));
            let level = std::env::var("SPIKE_LEVEL").unwrap_or_else(|_| "mainmenu+1".into());
            card::create(app.handle(), &level)?;
            // SPIKE_AUTO=<interval_s>,<count> starts auto mode at launch (headless runs).
            if let Some((interval, count)) = std::env::var("SPIKE_AUTO")
                .ok()
                .and_then(|v| {
                    v.split_once(',')
                        .map(|(a, b)| (a.parse().ok(), b.parse().ok()))
                })
                .and_then(|(a, b)| Some((a?, b?)))
            {
                card::start_auto(app.handle(), Duration::from_secs(interval), count);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the spike app");
}
