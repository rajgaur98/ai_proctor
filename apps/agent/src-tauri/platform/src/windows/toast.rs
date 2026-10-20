//! OS notifications on Windows (#174). A toast through `ToastNotificationManager`
//! first; if it can't be raised, a tray balloon through `Shell_NotifyIconW`.
//!
//! Why a toast needs an app identity: Windows shows a toast only for an app user
//! model ID (AUMID) it knows, and for a desktop (unpackaged) app that means a Start
//! menu shortcut stamped with the AUMID. Tauri's NSIS installer stamps the bundle
//! identifier on its shortcuts, so the identifier is used here. That makes toasts
//! work from the installed app and leaves them silently dropped from a bare binary
//! (`tauri dev`, `cargo run`): `Show` still succeeds there, so a balloon can't
//! replace them. A balloon needs no identity at all, which is why it is the
//! fallback for a toast that errors (WinRT unavailable, malformed content). No
//! crates are added: both paths are in the `windows` crate. Nothing here has run on
//! a Windows device yet (checklist on the PR).

use std::time::Duration;

use agent_core::toast::{toast_xml, truncate_utf16, BALLOON_TEXT_MAX, BALLOON_TITLE_MAX};
use windows::core::{w, HSTRING};
use windows::Data::Xml::Dom::XmlDocument;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_INFO, NIIF_INFO, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, LoadIconW, HWND_MESSAGE, IDI_APPLICATION, WINDOW_EX_STYLE,
    WINDOW_STYLE,
};
use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

use super::com::Apartment;

/// The AUMID: the bundle identifier in `tauri.conf.json`, which the NSIS installer
/// writes onto the Start menu and desktop shortcuts. Keep the two equal.
const APP_USER_MODEL_ID: &str = "com.aiproctor.agent";

/// How long the balloon icon stays up. Removing the icon removes the balloon, and
/// Windows shows a balloon for about this long.
const BALLOON_SHOWN: Duration = Duration::from_secs(8);

/// Raises a notification without waiting for it to be seen.
pub fn notify(title: &str, body: &str) {
    if let Err(error) = show_toast(title, body) {
        tracing::debug!(%error, "toast failed, showing a balloon");
        show_balloon(title, body);
    }
}

fn show_toast(title: &str, body: &str) -> windows::core::Result<()> {
    // WinRT needs COM on this thread (`notify` is called from worker threads).
    let _com = Apartment::enter();
    let xml = XmlDocument::new()?;
    xml.LoadXml(&HSTRING::from(toast_xml(title, body)))?;
    let toast = ToastNotification::CreateToastNotification(&xml)?;
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_USER_MODEL_ID))?
        .Show(&toast)
}

/// A balloon from a tray icon on a thread of its own: it owns a message-only window
/// for the icon and keeps the icon for `BALLOON_SHOWN`, so the caller isn't held up.
fn show_balloon(title: &str, body: &str) {
    let title = truncate_utf16(title, BALLOON_TITLE_MAX);
    let body = truncate_utf16(body, BALLOON_TEXT_MAX);
    let spawned = std::thread::Builder::new()
        .name("ai-proctor-balloon".into())
        .spawn(move || balloon(&title, &body));
    if let Err(error) = spawned {
        tracing::warn!(%error, "balloon thread did not start");
    }
}

/// `text` into a fixed UTF-16 buffer; the rest stays NUL (already cut to fit).
fn copy_utf16(into: &mut [u16], text: &str) {
    for (slot, unit) in into.iter_mut().zip(text.encode_utf16()) {
        *slot = unit;
    }
}

fn balloon(title: &str, body: &str) {
    // The predefined STATIC class: a window to own the icon without registering one.
    let window = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("STATIC"),
            w!(""),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            None,
            None,
        )
    };
    let Ok(window) = window else {
        tracing::warn!("balloon window was not created");
        return;
    };
    show_icon(window, title, body);
    let _ = unsafe { DestroyWindow(window) };
}

fn show_icon(window: HWND, title: &str, body: &str) {
    let mut data = NOTIFYICONDATAW {
        cbSize: size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: window,
        uID: 1,
        uFlags: NIF_ICON | NIF_INFO,
        hIcon: unsafe { LoadIconW(None, IDI_APPLICATION) }.unwrap_or_default(),
        dwInfoFlags: NIIF_INFO,
        ..Default::default()
    };
    copy_utf16(&mut data.szInfoTitle, title);
    copy_utf16(&mut data.szInfo, body);
    if unsafe { Shell_NotifyIconW(NIM_ADD, &data) }.as_bool() {
        std::thread::sleep(BALLOON_SHOWN);
        let _ = unsafe { Shell_NotifyIconW(NIM_DELETE, &data) };
    } else {
        tracing::warn!("balloon icon was not added");
    }
}
