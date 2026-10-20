//! Windows (windows-rs). Presence signals (idle, lock/sleep, camera/mic, sharing)
//! and capture (Desktop Duplication, Media Foundation) are real (#167); the pieces
//! live in `windows/`, the decision rules in `agent_core` so they test on every OS.
//! The input guard (ANT-02) is a low-level mouse hook below. Nothing here has run on
//! a Windows device yet: see the device checklists on the PRs. Notifications stay a
//! stub.
//!
//! `::windows` is the windows-rs crate; plain `windows` would be this module.

mod com;
mod consent;
mod foreground;
mod screen;
mod session;
mod webcam;

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
use std::time::{Duration, Instant};

use agent_core::contracts::{PermissionKind, PermissionState, Permissions};
use agent_core::platform::{
    CallState, CaptureError, Foreground, Frame, InjectedInput, Platform, ScreenRect, ScreenShare,
    SessionState,
};
use agent_core::watchdog::{
    self, WatchdogError, WatchdogOutcome, WatchdogSpec, WatchdogState, LABEL, SUPERVISED_ARG,
};
use chrono::{DateTime, Utc};

/// How long a capture may take before the caller gets `Failed`, so a stuck driver
/// cannot hang the check-in.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(8);

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

/// The registry read behind `permissions()` is reused this long: status is asked for
/// several times a second and each read starts two `reg.exe` processes.
const CAMERA_CACHE: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct WindowsPlatform {
    guard: Mutex<Option<HookThread>>,
    camera: Mutex<Option<(Instant, PermissionState)>>,
}

impl WindowsPlatform {
    pub fn new() -> Self {
        // Without the listener the lock state is polled and sleep is not reported.
        let listening = session::start_listener();
        tracing::info!(platform = "windows", listening, "platform ready");
        Self::default()
    }

    /// The camera privacy switches (AGT-03), read at most every `CAMERA_CACHE`.
    fn camera_permission(&self) -> PermissionState {
        let mut cache = self.camera.lock().unwrap();
        if let Some((at, state)) = cache.as_ref() {
            if at.elapsed() < CAMERA_CACHE {
                return *state;
            }
        }
        let state = registry::camera_permission();
        *cache = Some((Instant::now(), state));
        state
    }
}

/// Runs `work` on a thread of its own and waits `CAPTURE_TIMEOUT` for it. A capture
/// stuck in a driver call is abandoned (its thread ends whenever the call returns).
fn with_timeout<T: Send + 'static>(
    what: &str,
    work: impl FnOnce() -> Result<T, CaptureError> + Send + 'static,
) -> Result<T, CaptureError> {
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name(format!("ai-proctor-{what}"))
        .spawn(move || {
            let _ = tx.send(work());
        })
        .map_err(|e| CaptureError::Failed(format!("{what} thread: {e}")))?;
    rx.recv_timeout(CAPTURE_TIMEOUT)
        .unwrap_or_else(|_| Err(CaptureError::Failed(format!("{what} timed out"))))
}

impl Platform for WindowsPlatform {
    fn idle_seconds(&self) -> u64 {
        session::idle()
    }

    fn session_state(&self) -> SessionState {
        session::state()
    }

    fn call_state(&self) -> CallState {
        consent::call_state()
    }

    fn screen_share(&self) -> Option<ScreenShare> {
        foreground::screen_share()
    }

    /// Frontmost window's app (the executable's name), its title and, for browsers,
    /// the page's domain. Never prompts: Windows has no permission for any of it.
    fn foreground(&self) -> Option<Foreground> {
        foreground::foreground()
    }

    /// One frame per monitor. Blocks until done (up to 8 s): call from a worker
    /// thread, not the UI thread.
    fn capture_screens(&self, max_width: u32) -> Result<Vec<Frame>, CaptureError> {
        with_timeout("screens", move || screen::capture(max_width))
    }

    /// One webcam frame, at most `width` wide. Blocks until done (up to 8 s) with the
    /// camera light on meanwhile: call from a worker thread. Without the camera
    /// privacy switches on it fails with `PermissionMissing` before opening the camera.
    fn capture_webcam(&self, width: u32, height: u32) -> Result<Frame, CaptureError> {
        if self.camera_permission() != PermissionState::Granted {
            return Err(CaptureError::PermissionMissing);
        }
        with_timeout("webcam", move || webcam::capture(width, height))
    }

    /// Capturing the screen needs no permission on Windows; the camera follows the
    /// Settings → Privacy & security → Camera switches.
    fn permissions(&self) -> Permissions {
        Permissions {
            screen: PermissionState::Granted,
            camera: self.camera_permission(),
        }
    }

    /// Windows has no Accessibility permission to ask for: reading the browser's domain
    /// through UI Automation needs none.
    fn accessibility_permission(&self) -> PermissionState {
        PermissionState::Unsupported
    }

    /// Windows has no prompt to trigger: the person turns the camera switches on in
    /// Settings (`ms-settings:privacy-webcam`, opened by the onboarding window).
    fn request_permission(&self, _kind: PermissionKind) {}

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

    fn install_watchdog(&self, spec: &WatchdogSpec) -> Result<WatchdogState, WatchdogError> {
        task::install(spec)
    }

    fn uninstall_watchdog(&self) -> Result<(), WatchdogError> {
        task::uninstall()
    }

    fn watchdog_installed(&self) -> bool {
        task::exists()
    }

    fn boot_time(&self) -> Option<DateTime<Utc>> {
        task::boot_time()
    }
}

/// The camera privacy switches in the per-user consent store, read with `reg.exe`.
/// Needs a device test (no Windows machine yet).
mod registry {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    use agent_core::camera_privacy::{
        camera_state, parse_reg_value, CONSENT_KEY, DESKTOP_APPS_KEY,
    };

    use super::PermissionState;

    /// No console window flashing up for each call.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn value(key: &str) -> Option<String> {
        let output = Command::new("reg.exe")
            .args(["query", key, "/v", "Value"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        parse_reg_value(&String::from_utf8_lossy(&output.stdout))
    }

    pub fn camera_permission() -> PermissionState {
        camera_state(
            value(CONSENT_KEY).as_deref(),
            value(DESKTOP_APPS_KEY).as_deref(),
        )
    }
}

/// The watchdog as a per-user scheduled task (`schtasks.exe`): starts the agent at
/// sign-in and again a minute after an abnormal exit. The task XML comes from
/// `agent_core::watchdog`. Needs a device test (no Windows machine yet).
mod task {
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::{Command, Output};

    use super::*;

    /// No console window flashing up for each call.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn run(program: &str, args: &[&str]) -> Option<Output> {
        Command::new(program)
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()
    }

    fn succeeded(output: Option<Output>) -> bool {
        output.is_some_and(|o| o.status.success())
    }

    pub fn exists() -> bool {
        succeeded(run("schtasks.exe", &["/Query", "/TN", LABEL]))
    }

    /// `DOMAIN\user` of the signed-in person, for the task's trigger and principal.
    fn user() -> Result<String, WatchdogError> {
        let name =
            std::env::var("USERNAME").map_err(|_| WatchdogError::Failed("no USERNAME".into()))?;
        Ok(match std::env::var("USERDOMAIN") {
            Ok(domain) if !domain.is_empty() => format!("{domain}\\{name}"),
            _ => name,
        })
    }

    /// A copy of the XML last registered, next to the agent's data, so the next
    /// launch can tell whether anything changed without parsing Task Scheduler's output.
    fn marker() -> Result<PathBuf, WatchdogError> {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| WatchdogError::Failed("no LOCALAPPDATA".into()))?;
        Ok(base.join(LABEL).join("watchdog-task.xml"))
    }

    /// `schtasks /XML` wants UTF-16 with a byte-order mark.
    fn utf16le(xml: &str) -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in xml.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes
    }

    pub fn install(spec: &WatchdogSpec) -> Result<WatchdogState, WatchdogError> {
        let supervised = std::env::args().any(|a| a == SUPERVISED_ARG);
        let xml = watchdog::scheduled_task_xml(spec, &user()?);
        let marker = marker()?;
        let existed = exists();
        if existed && std::fs::read_to_string(&marker).is_ok_and(|saved| saved == xml) {
            return Ok(WatchdogState {
                outcome: WatchdogOutcome::Unchanged,
                supervised,
                handed_over: false,
            });
        }
        let failed = |e: std::io::Error| WatchdogError::Failed(e.to_string());
        let file = std::env::temp_dir().join(format!("{LABEL}-task.xml"));
        std::fs::write(&file, utf16le(&xml)).map_err(failed)?;
        let created = run(
            "schtasks.exe",
            &[
                "/Create",
                "/TN",
                LABEL,
                "/XML",
                &file.to_string_lossy(),
                "/F",
            ],
        );
        let _ = std::fs::remove_file(&file);
        let created =
            created.ok_or_else(|| WatchdogError::Failed("schtasks.exe not found".into()))?;
        if !created.status.success() {
            return Err(WatchdogError::Failed(
                String::from_utf8_lossy(&created.stderr).trim().to_owned(),
            ));
        }
        if let Some(dir) = marker.parent() {
            std::fs::create_dir_all(dir).map_err(failed)?;
        }
        std::fs::write(&marker, &xml).map_err(failed)?;
        // This process isn't the task's, so a kill isn't covered until the next
        // sign-in starts the task's own copy; nothing is handed over now.
        Ok(WatchdogState {
            outcome: if existed {
                WatchdogOutcome::Updated
            } else {
                WatchdogOutcome::Installed
            },
            supervised,
            handed_over: false,
        })
    }

    pub fn uninstall() -> Result<(), WatchdogError> {
        if exists() && !succeeded(run("schtasks.exe", &["/Delete", "/TN", LABEL, "/F"])) {
            return Err(WatchdogError::Failed("schtasks /Delete failed".into()));
        }
        if let Ok(marker) = marker() {
            let _ = std::fs::remove_file(marker);
        }
        Ok(())
    }

    /// The device's last start-up, from WMI through PowerShell (a second or so; asked
    /// only when the agent restarts during a shift).
    pub fn boot_time() -> Option<DateTime<Utc>> {
        let out = run(
            "powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
            ],
        )?;
        parse_boot_time(&String::from_utf8_lossy(&out.stdout))
    }

    fn parse_boot_time(text: &str) -> Option<DateTime<Utc>> {
        DateTime::parse_from_rfc3339(text.trim())
            .ok()
            .map(|t| t.with_timezone(&Utc))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn the_task_file_is_utf16_with_a_byte_order_mark() {
            assert_eq!(
                utf16le("<a>é"),
                [0xFF, 0xFE, b'<', 0, b'a', 0, b'>', 0, 0xE9, 0]
            );
        }

        #[test]
        fn reads_powershells_round_trip_time() {
            assert_eq!(
                parse_boot_time("2026-10-20T08:19:05.1234567Z\r\n"),
                Some(
                    "2026-10-20T08:19:05Z".parse::<DateTime<Utc>>().unwrap()
                        + chrono::Duration::nanoseconds(123_456_700)
                )
            );
            assert_eq!(parse_boot_time(""), None);
        }
    }
}
