//! Windows (windows-rs: Graphics.Capture, Media Foundation, Win32 hooks, WTS).
//! Stub until the M1+ features implement each method, except the input guard
//! (ANT-02), which is real.
//!
//! `::windows` is the windows-rs crate; plain `windows` would be this module.

use std::sync::atomic::{AtomicI32, AtomicU32, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread::JoinHandle;

use ::windows::core::PCWSTR;
use ::windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use ::windows::Win32::System::LibraryLoader::GetModuleHandleW;
use ::windows::Win32::System::Threading::GetCurrentThreadId;
use ::windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, PeekMessageW, PostThreadMessageW, SetWindowsHookExW,
    UnhookWindowsHookEx, HC_ACTION, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE, WH_MOUSE_LL, WM_QUIT,
};

use agent_core::contracts::{PermissionState, Permissions};
use agent_core::platform::{
    CallState, CaptureError, Foreground, Frame, InjectedInput, Platform, ScreenRect, SessionState,
};

use crate::input_guard::{judge, Verdict};

// What the hook callback reads. It is a plain function with no closure state, so the
// card's area and the running count live here; one guard runs at a time.
static AREA_X: AtomicI32 = AtomicI32::new(0);
static AREA_Y: AtomicI32 = AtomicI32::new(0);
static AREA_W: AtomicU32 = AtomicU32::new(0);
static AREA_H: AtomicU32 = AtomicU32::new(0);
static INJECTED_CLICKS: AtomicU32 = AtomicU32::new(0);

fn set_area(area: ScreenRect) {
    AREA_X.store(area.x, Ordering::Relaxed);
    AREA_Y.store(area.y, Ordering::Relaxed);
    AREA_W.store(area.width, Ordering::Relaxed);
    AREA_H.store(area.height, Ordering::Relaxed);
}

fn area() -> ScreenRect {
    ScreenRect {
        x: AREA_X.load(Ordering::Relaxed),
        y: AREA_Y.load(Ordering::Relaxed),
        width: AREA_W.load(Ordering::Relaxed),
        height: AREA_H.load(Ordering::Relaxed),
    }
}

/// `WH_MOUSE_LL` callback. Kept tiny: Windows drops hooks that answer slowly. The
/// decision is `input_guard::judge`; a non-zero result swallows the event.
unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        // SAFETY: for HC_ACTION, `lparam` points to a valid MSLLHOOKSTRUCT for the
        // duration of the call.
        let event = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        match judge(
            wparam.0 as u32,
            event.flags,
            event.pt.x,
            event.pt.y,
            &area(),
        ) {
            Verdict::Pass => {}
            Verdict::Swallow => return LRESULT(1),
            Verdict::SwallowAndCount => {
                INJECTED_CLICKS.fetch_add(1, Ordering::Relaxed);
                return LRESULT(1);
            }
        }
    }
    // SAFETY: passes the hook's own arguments on, as documented.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// The hook's thread: installs it, then pumps messages (a low-level hook only runs
/// while its thread does) until `WM_QUIT`. Reports its thread id once the hook is in.
fn hook_thread(ready: mpsc::Sender<Result<u32, String>>) {
    // SAFETY: plain Win32 calls with valid arguments; `mouse_proc` has the HOOKPROC
    // signature.
    let hook = unsafe {
        let module = GetModuleHandleW(PCWSTR::null())
            .map(|m| HINSTANCE(m.0))
            .ok();
        SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), module, 0)
    };
    let hook = match hook {
        Ok(hook) => hook,
        Err(error) => {
            let _ = ready.send(Err(error.to_string()));
            return;
        }
    };
    let mut msg = MSG::default();
    // SAFETY: as above. Peeking creates this thread's message queue, so a
    // `WM_QUIT` posted right after `ready` is not lost.
    unsafe {
        let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
        let _ = ready.send(Ok(GetCurrentThreadId()));
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {}
        let _ = UnhookWindowsHookEx(hook);
    }
}

/// A running hook thread.
struct HookThread {
    id: u32,
    join: JoinHandle<()>,
}

impl HookThread {
    fn stop(self) {
        // SAFETY: posts a message to a thread this process started.
        let posted = unsafe { PostThreadMessageW(self.id, WM_QUIT, WPARAM(0), LPARAM(0)) };
        match posted {
            Ok(()) => {
                let _ = self.join.join();
            }
            // Joining would wait forever for a thread that never hears the message.
            Err(error) => tracing::warn!(%error, "input guard thread could not be stopped"),
        }
    }
}

#[derive(Default)]
pub struct WindowsPlatform {
    guard: Mutex<Option<HookThread>>,
}

impl WindowsPlatform {
    pub fn new() -> Self {
        tracing::info!(platform = "windows", "platform stub in use");
        Self::default()
    }
}

impl Platform for WindowsPlatform {
    fn idle_seconds(&self) -> u64 {
        0
    }

    fn session_state(&self) -> SessionState {
        SessionState::Active
    }

    fn call_state(&self) -> CallState {
        CallState::default()
    }

    fn screen_shared(&self) -> bool {
        false
    }

    fn foreground(&self) -> Option<Foreground> {
        None
    }

    fn capture_screens(&self, _max_width: u32) -> Result<Vec<Frame>, CaptureError> {
        Err(CaptureError::Unsupported)
    }

    fn capture_webcam(&self, _width: u32, _height: u32) -> Result<Frame, CaptureError> {
        Err(CaptureError::Unsupported)
    }

    fn permissions(&self) -> Permissions {
        Permissions {
            screen: PermissionState::Unsupported,
            camera: PermissionState::Unsupported,
        }
    }

    fn start_input_guard(&self, area: ScreenRect) {
        let mut guard = self.guard.lock().unwrap();
        if let Some(old) = guard.take() {
            old.stop();
        }
        set_area(area);
        INJECTED_CLICKS.store(0, Ordering::Relaxed);
        let (ready_tx, ready_rx) = mpsc::channel();
        let join = std::thread::Builder::new()
            .name("input-guard".into())
            .spawn(move || hook_thread(ready_tx));
        let join = match join {
            Ok(join) => join,
            Err(error) => {
                tracing::warn!(%error, "input guard thread did not start");
                return;
            }
        };
        match ready_rx.recv() {
            Ok(Ok(id)) => *guard = Some(HookThread { id, join }),
            // The card still works without the guard; the check-in just carries no
            // injected-click flag.
            Ok(Err(error)) => tracing::warn!(%error, "input guard hook was not installed"),
            Err(_) => tracing::warn!("input guard thread ended early"),
        }
    }

    fn stop_input_guard(&self) -> InjectedInput {
        let Some(thread) = self.guard.lock().unwrap().take() else {
            return InjectedInput::default();
        };
        thread.stop();
        InjectedInput {
            count: INJECTED_CLICKS.swap(0, Ordering::Relaxed),
        }
    }

    fn notify(&self, title: &str, _body: &str) {
        tracing::debug!(title, "notification (stub)");
    }
}
