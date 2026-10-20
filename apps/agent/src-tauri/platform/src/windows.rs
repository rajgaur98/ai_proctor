//! Windows (windows-rs: Graphics.Capture, Media Foundation, Win32 hooks, WTS).
//! Stub until the M1+ features implement each method.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use agent_core::contracts::{PermissionKind, PermissionState, Permissions};
use agent_core::platform::{
    CallState, CaptureError, Click, Foreground, Frame, Platform, ScreenShare, SessionState,
};
use agent_core::watchdog::{
    self, WatchdogError, WatchdogOutcome, WatchdogSpec, WatchdogState, LABEL, SUPERVISED_ARG,
};
use chrono::{DateTime, Utc};

/// The registry read behind `permissions()` is reused this long: status is asked for
/// several times a second and each read starts two `reg.exe` processes.
const CAMERA_CACHE: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct WindowsPlatform {
    camera: Mutex<Option<(Instant, PermissionState)>>,
}

impl WindowsPlatform {
    pub fn new() -> Self {
        tracing::info!(platform = "windows", "platform stub in use");
        Self::default()
    }

    /// The camera privacy switches (AGT-03), read at most every `CAMERA_CACHE`.
    fn camera_permission(&self) -> PermissionState {
        let mut cache = self.camera.lock().unwrap();
        if let Some((at, state)) = cache.as_ref() {
            if at.elapsed() < CAMERA_CACHE {
                return state.clone();
            }
        }
        let state = registry::camera_permission();
        *cache = Some((Instant::now(), state.clone()));
        state
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

    fn screen_share(&self) -> Option<ScreenShare> {
        None
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

    /// Capturing the screen needs no permission on Windows; the camera follows the
    /// Settings → Privacy & security → Camera switches.
    fn permissions(&self) -> Permissions {
        Permissions {
            screen: PermissionState::Granted,
            camera: self.camera_permission(),
        }
    }

    /// Windows has no prompt to trigger: the person turns the camera switches on in
    /// Settings (`ms-settings:privacy-webcam`, opened by the onboarding window).
    fn request_permission(&self, _kind: PermissionKind) {}

    fn is_injected(&self, _click: &Click) -> bool {
        false
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
