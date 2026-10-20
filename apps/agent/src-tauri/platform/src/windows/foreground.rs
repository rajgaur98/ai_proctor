//! The frontmost window (ACT-01..03), screen sharing and presenting (CHK-03).
//! Window, process and monitor reads here; the rules (names, titles, domains,
//! sharing hints, display order) are in `agent_core::foreground` and
//! `agent_core::displays`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use agent_core::displays::{covers, display_of_window, display_order, Rect};
use agent_core::foreground::{
    app_name, browser_kind, clean_title, domain_of_address, is_sharing_title, is_slide_show,
    BrowserKind, CHROMIUM_OMNIBOX_CLASS, FIREFOX_URLBAR_ID,
};
use agent_core::platform::{Foreground, ScreenShare};
use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, HDC, HMONITOR};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationValuePattern, TreeScope_Descendants,
    UIA_AutomationIdPropertyId, UIA_ClassNamePropertyId, UIA_ValuePatternId,
};
use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_PRESENTATION_MODE};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible,
};

use super::com::Apartment;

/// Reading a browser's address bar goes through the browser's process and can stall
/// if it hangs; the caller waits this long and moves on without a domain.
const ADDRESS_TIMEOUT: Duration = Duration::from_millis(750);

/// An open process handle, closed on drop.
struct Process(HANDLE);

impl Drop for Process {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

fn window_text(hwnd: HWND) -> String {
    let mut buf = [0u16; 1024];
    let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..len.max(0) as usize])
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let len = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..len.max(0) as usize])
}

fn window_rect(hwnd: HWND) -> Option<Rect> {
    let mut r = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut r) }.ok()?;
    Some(Rect::new(r.left, r.top, r.right, r.bottom))
}

/// Full path of the executable of process `pid`. `None` for processes we may not
/// open (elevated apps while the agent is not).
fn image_path(pid: u32) -> Option<String> {
    let process =
        Process(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?);
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            process.0,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
    }
    .ok()?;
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

unsafe extern "system" fn collect_monitor(
    _monitor: HMONITOR,
    _hdc: HDC,
    rect: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let rects = unsafe { &mut *(data.0 as *mut Vec<Rect>) };
    if let Some(r) = unsafe { rect.as_ref() } {
        rects.push(Rect::new(r.left, r.top, r.right, r.bottom));
    }
    BOOL(1)
}

/// The monitors in display order (the same order the screenshots use).
pub fn displays() -> Vec<Rect> {
    let mut rects: Vec<Rect> = Vec::new();
    let _ = unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(collect_monitor),
            LPARAM(&mut rects as *mut Vec<Rect> as isize),
        )
    };
    display_order(rects)
}

/// The display (1-based, as in `Frame.display`) the window is mostly on.
fn display_index(hwnd: HWND) -> Option<u32> {
    let rect = window_rect(hwnd)?;
    display_of_window(&rect, &displays()).map(|i| i as u32 + 1)
}

/// The frontmost window's app, title and, for browsers, the page's domain. `None`
/// when nothing is in front (locked, desktop transitions) or the process can't be
/// read.
pub fn foreground() -> Option<Foreground> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_invalid() {
        return None;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    let app = app_name(&image_path(pid)?)?;
    let title = clean_title(&window_text(hwnd));
    let domain = browser_kind(&app).and_then(|kind| browser_domain(hwnd, kind));
    // The display is worked out here for the day `Foreground` carries it (#106, so
    // an excluded app blanks only its own screen); for now it is only logged.
    tracing::trace!(app, display = ?display_index(hwnd), "foreground window");
    Some(Foreground { app, title, domain })
}

/// The page's domain from the address bar, on a helper thread so a hung browser
/// costs `ADDRESS_TIMEOUT` and not the sampler. One read at a time: while one is
/// stuck, later ones give up at once.
fn browser_domain(hwnd: HWND, kind: BrowserKind) -> Option<String> {
    static BUSY: AtomicBool = AtomicBool::new(false);
    if BUSY.swap(true, Ordering::SeqCst) {
        return None;
    }
    let (tx, rx) = mpsc::channel();
    let handle = hwnd.0 as usize;
    let spawned = std::thread::Builder::new()
        .name("ai-proctor-address".into())
        .spawn(move || {
            let address = address_bar(HWND(handle as *mut _), kind);
            BUSY.store(false, Ordering::SeqCst);
            let _ = tx.send(address);
        });
    if spawned.is_err() {
        BUSY.store(false, Ordering::SeqCst);
        return None;
    }
    rx.recv_timeout(ADDRESS_TIMEOUT)
        .ok()
        .flatten()
        .and_then(|value| domain_of_address(&value))
}

/// The address bar's text through UI Automation: Chromium's is the `Edit` of class
/// `OmniboxViewViews`, Firefox's the one with automation id `urlbar-input`.
fn address_bar(hwnd: HWND, kind: BrowserKind) -> Option<String> {
    let _com = Apartment::enter();
    let automation: IUIAutomation =
        unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.ok()?;
    let root = unsafe { automation.ElementFromHandle(hwnd) }.ok()?;
    let (property, value) = match kind {
        BrowserKind::Chromium => (UIA_ClassNamePropertyId, CHROMIUM_OMNIBOX_CLASS),
        BrowserKind::Firefox => (UIA_AutomationIdPropertyId, FIREFOX_URLBAR_ID),
    };
    let condition =
        unsafe { automation.CreatePropertyCondition(property, &VARIANT::from(value)) }.ok()?;
    let edit = unsafe { root.FindFirst(TreeScope_Descendants, &condition) }.ok()?;
    let pattern: IUIAutomationValuePattern =
        unsafe { edit.GetCurrentPatternAs(UIA_ValuePatternId) }.ok()?;
    let text = unsafe { pattern.CurrentValue() }.ok()?;
    Some(text.to_string())
}

unsafe extern "system" fn collect_title(hwnd: HWND, data: LPARAM) -> BOOL {
    let titles = unsafe { &mut *(data.0 as *mut Vec<String>) };
    if unsafe { IsWindowVisible(hwnd) }.as_bool() && !unsafe { IsIconic(hwnd) }.as_bool() {
        let title = window_text(hwnd);
        if !title.is_empty() {
            titles.push(title);
        }
    }
    BOOL(1)
}

/// Titles of the visible, unminimised top-level windows.
fn window_titles() -> Vec<String> {
    let mut titles: Vec<String> = Vec::new();
    let _ = unsafe {
        EnumWindows(
            Some(collect_title),
            LPARAM(&mut titles as *mut Vec<String> as isize),
        )
    };
    titles
}

/// A sharing indicator window is open, or a slideshow fills a monitor (or Windows'
/// own presentation mode is on).
pub fn screen_share() -> Option<ScreenShare> {
    if window_titles().iter().any(|t| is_sharing_title(t)) {
        return Some(ScreenShare::Sharing);
    }
    (presentation_mode() || slide_show_in_front()).then_some(ScreenShare::Presenting)
}

/// Windows' "presentation settings" mode (`presentationsettings.exe`).
fn presentation_mode() -> bool {
    unsafe { SHQueryUserNotificationState() }.is_ok_and(|state| state == QUNS_PRESENTATION_MODE)
}

/// The frontmost window is a slideshow covering a whole monitor.
fn slide_show_in_front() -> bool {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_invalid() || !is_slide_show(&class_name(hwnd), &window_text(hwnd)) {
        return false;
    }
    window_rect(hwnd).is_some_and(|rect| displays().iter().any(|d| covers(&rect, d)))
}
