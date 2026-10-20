//! Idle time, lock and sleep (ACT-01). Idle is `GetLastInputInfo`. Lock and sleep
//! come from a hidden window on its own thread that receives
//! `WM_WTSSESSION_CHANGE` (session lock/unlock) and `WM_POWERBROADCAST` (suspend/
//! resume), the Windows counterpart of the macOS workspace observers. If that
//! window can't be created, the lock state is read from the session each time and
//! sleep is not reported.

use std::mem::size_of;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use agent_core::platform::SessionState;
use agent_core::session_signals::{
    idle_seconds, power_event, session_event, session_flags_locked, SessionEvent, SessionFlags,
};
use windows::core::{w, PWSTR};
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Power::RegisterSuspendResumeNotification;
use windows::Win32::System::RemoteDesktop::{
    WTSFreeMemory, WTSQuerySessionInformationW, WTSRegisterSessionNotification, WTSSessionInfoEx,
    NOTIFY_FOR_THIS_SESSION, WTSINFOEXW, WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION,
};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
    TranslateMessage, DEVICE_NOTIFY_WINDOW_HANDLE, MSG, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE,
    WNDCLASSW, WS_EX_TOOLWINDOW, WS_OVERLAPPED,
};

/// What the notifications have said so far.
static FLAGS: Mutex<SessionFlags> = Mutex::new(SessionFlags {
    asleep: false,
    locked: false,
});
/// True once the notification window is up and `FLAGS` can be trusted.
static LISTENING: AtomicBool = AtomicBool::new(false);
/// The window thread is started at most once (the window class can be registered
/// once).
static STARTED: AtomicBool = AtomicBool::new(false);

/// How long `start_listener` waits for the window thread to report.
const START_TIMEOUT: Duration = Duration::from_secs(2);

/// Whole seconds since the last keyboard or mouse input in this session.
pub fn idle() -> u64 {
    let mut info = LASTINPUTINFO {
        cbSize: size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    if unsafe { GetLastInputInfo(&mut info) }.as_bool() {
        idle_seconds(info.dwTime, unsafe { GetTickCount() })
    } else {
        0
    }
}

pub fn state() -> SessionState {
    if LISTENING.load(Ordering::SeqCst) {
        return FLAGS.lock().map(|f| f.state()).unwrap_or_default();
    }
    SessionFlags {
        locked: session_locked().unwrap_or(false),
        asleep: false,
    }
    .state()
}

/// Starts the notification window once. Returns whether it is listening.
pub fn start_listener() -> bool {
    if STARTED.swap(true, Ordering::SeqCst) {
        return LISTENING.load(Ordering::SeqCst);
    }
    let (tx, rx) = mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("ai-proctor-session".into())
        .spawn(move || listen(tx));
    if spawned.is_err() {
        tracing::warn!("session watcher thread did not start");
        return false;
    }
    let up = rx.recv_timeout(START_TIMEOUT).unwrap_or(false);
    LISTENING.store(up, Ordering::SeqCst);
    up
}

fn record(event: SessionEvent) {
    if let Ok(mut flags) = FLAGS.lock() {
        *flags = flags.apply(event);
    }
    tracing::debug!(?event, "session state changed");
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let event = match msg {
        WM_WTSSESSION_CHANGE => session_event(wparam.0),
        WM_POWERBROADCAST => power_event(wparam.0),
        _ => None,
    };
    if let Some(event) = event {
        record(event);
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// Creates the hidden window, registers for the notifications, reports through
/// `ready`, then pumps messages for the life of the process. It is a normal
/// top-level window that is never shown (message-only windows don't get the
/// broadcast power messages).
fn listen(ready: mpsc::Sender<bool>) {
    let hwnd = match create_window() {
        Ok(hwnd) => hwnd,
        Err(e) => {
            tracing::warn!(error = %e, "session watcher window failed");
            let _ = ready.send(false);
            return;
        }
    };
    if let Err(e) = unsafe { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) } {
        tracing::warn!(error = %e, "session notifications failed");
        let _ = ready.send(false);
        return;
    }
    // Modern Standby machines only report suspend/resume to registered windows;
    // classic sleep reaches the window anyway, so a failure here is not fatal.
    if let Err(e) =
        unsafe { RegisterSuspendResumeNotification(HANDLE(hwnd.0), DEVICE_NOTIFY_WINDOW_HANDLE) }
    {
        tracing::debug!(error = %e, "suspend/resume registration failed");
    }
    if let Some(locked) = session_locked() {
        if let Ok(mut flags) = FLAGS.lock() {
            flags.locked = locked;
        }
    }
    tracing::info!(
        platform = "windows",
        "session and power notifications registered"
    );
    let _ = ready.send(true);
    let mut msg = MSG::default();
    while unsafe { GetMessageW(&mut msg, None, 0, 0) }.0 > 0 {
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

fn create_window() -> windows::core::Result<HWND> {
    let instance = unsafe { GetModuleHandleW(None) }?.into();
    let class = WNDCLASSW {
        lpfnWndProc: Some(window_proc),
        hInstance: instance,
        lpszClassName: w!("AIProctorSessionWatcher"),
        ..Default::default()
    };
    if unsafe { RegisterClassW(&class) } == 0 {
        return Err(windows::core::Error::from_thread());
    }
    unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW,
            class.lpszClassName,
            w!(""),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            None,
            None,
            Some(instance),
            None,
        )
    }
}

/// Whether the session reports itself locked, from `WTSInfoEx` (Windows 8 and
/// later). `None` if it can't be read.
fn session_locked() -> Option<bool> {
    let mut buffer = PWSTR::null();
    let mut len = 0u32;
    unsafe {
        WTSQuerySessionInformationW(
            Some(WTS_CURRENT_SERVER_HANDLE),
            WTS_CURRENT_SESSION,
            WTSSessionInfoEx,
            &mut buffer,
            &mut len,
        )
    }
    .ok()?;
    let info = buffer.0 as *const WTSINFOEXW;
    let flags = if len as usize >= size_of::<WTSINFOEXW>() && !info.is_null() {
        let info = unsafe { std::ptr::read_unaligned(info) };
        if info.Level == 1 {
            Some(unsafe { info.Data.WTSInfoExLevel1.SessionFlags })
        } else {
            None
        }
    } else {
        None
    };
    unsafe { WTSFreeMemory(buffer.0 as *mut _) };
    flags.map(session_flags_locked)
}
