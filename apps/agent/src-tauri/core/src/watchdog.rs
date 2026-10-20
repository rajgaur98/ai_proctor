//! The watchdog (ANT-01): a helper the OS runs that starts the agent again if it is
//! killed. macOS uses a LaunchAgent (`KeepAlive`), Windows a per-user scheduled
//! task. The files they need are generated here, the same on every OS, so they are
//! unit-tested in CI; the platform crates only run `launchctl` / `schtasks`.
//!
//! Both restart the agent after an abnormal exit only. A normal exit (code 0) is
//! the tray's "Quit", which the agent refuses while the person is clocked in, so
//! stopping the agent mid-shift always looks like a kill. The agent reports that
//! gap when it comes back (`liveness`).

use std::path::{Path, PathBuf};

/// Label of the LaunchAgent and name of the scheduled task. Same as the bundle id.
pub const LABEL: &str = "com.aiproctor.agent";

/// Passed to the agent by the watchdog, so a Windows instance knows it is
/// supervised.
pub const SUPERVISED_ARG: &str = "--watchdog";

/// Seconds between a kill and the restart (launchd's `ThrottleInterval`).
pub const RESTART_AFTER_S: u32 = 10;

/// What the watchdog starts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatchdogSpec {
    /// The installed agent executable (inside the .app on macOS).
    pub executable: PathBuf,
}

/// What `install_watchdog` did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WatchdogOutcome {
    /// Registered for the first time.
    Installed,
    /// Registered before with different content (the app moved, a new version):
    /// rewritten.
    Updated,
    /// Already registered exactly like this: nothing touched.
    Unchanged,
}

/// The state of the watchdog after `install_watchdog`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WatchdogState {
    pub outcome: WatchdogOutcome,
    /// This process was started by the watchdog, so a kill is covered.
    pub supervised: bool,
    /// The watchdog has started its own copy of the agent (macOS first run), so this
    /// unsupervised process should exit and leave the work to it.
    pub handed_over: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum WatchdogError {
    #[error("not supported on this platform")]
    Unsupported,
    #[error("{0}")]
    Failed(String),
}

/// The agent is run from a place a watchdog can point at: a macOS app moved to its
/// folder, not a translocated or temporary copy (the path changes every launch).
pub fn stable_executable(path: &Path) -> bool {
    let text = path.to_string_lossy();
    !text.contains("/AppTranslocation/") && !text.starts_with("/private/var/folders/")
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// `~/Library/LaunchAgents/com.aiproctor.agent.plist`. Runs the agent at login and
/// again whenever it exits unsuccessfully (a kill, a crash). `SuccessfulExit` false
/// leaves a normal quit alone.
pub fn launch_agent_plist(spec: &WatchdogSpec) -> String {
    let exe = xml_escape(&spec.executable.to_string_lossy());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>{SUPERVISED_ARG}</string>
  </array>
  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>{LABEL}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>{RESTART_AFTER_S}</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
"#
    )
}

/// Where the plist goes, under the user's home folder.
pub fn launch_agent_path(home: &Path) -> PathBuf {
    home.join("Library")
        .join("LaunchAgents")
        .join(format!("{LABEL}.plist"))
}

/// Writes `contents` to `path` unless the file already has exactly that, and says
/// which it was. Creates the folder. Idempotent: running it twice changes nothing.
pub fn write_if_changed(path: &Path, contents: &str) -> Result<WatchdogOutcome, WatchdogError> {
    let failed = |e: std::io::Error| WatchdogError::Failed(format!("{}: {e}", path.display()));
    let outcome = match std::fs::read_to_string(path) {
        Ok(existing) if existing == contents => return Ok(WatchdogOutcome::Unchanged),
        Ok(_) => WatchdogOutcome::Updated,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => WatchdogOutcome::Installed,
        Err(e) => return Err(failed(e)),
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(failed)?;
    }
    let tmp = path.with_extension("plist.tmp");
    std::fs::write(&tmp, contents)
        .and_then(|()| std::fs::rename(&tmp, path))
        .map_err(failed)?;
    Ok(outcome)
}

/// Removes the file; not there is fine.
pub fn remove_file(path: &Path) -> Result<(), WatchdogError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(WatchdogError::Failed(format!("{}: {e}", path.display()))),
    }
}

/// The scheduled task (Task Scheduler XML, for `schtasks /Create /XML`): starts the
/// agent when `user` signs in, and starts it again a minute after an abnormal exit,
/// up to 999 times. One instance at a time; no time limit; not stopped on battery.
pub fn scheduled_task_xml(spec: &WatchdogSpec, user: &str) -> String {
    let exe = xml_escape(&spec.executable.to_string_lossy());
    let user = xml_escape(user);
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts AI Proctor at sign-in and again if it is stopped.</Description>
    <URI>\{LABEL}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{exe}</Command>
      <Arguments>{SUPERVISED_ARG}</Arguments>
    </Exec>
  </Actions>
</Task>
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> WatchdogSpec {
        WatchdogSpec {
            executable: PathBuf::from(
                "/Applications/AI Proctor.app/Contents/MacOS/ai-proctor-agent",
            ),
        }
    }

    #[test]
    fn the_plist_restarts_after_a_kill_but_not_after_a_quit() {
        let plist = launch_agent_plist(&spec());
        assert!(plist.contains("<key>Label</key>\n  <string>com.aiproctor.agent</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>\n  <true/>"));
        assert!(plist.contains("<key>SuccessfulExit</key>\n    <false/>"));
        assert!(plist.contains("<key>ThrottleInterval</key>\n  <integer>10</integer>"));
        assert!(plist.contains(
            "<string>/Applications/AI Proctor.app/Contents/MacOS/ai-proctor-agent</string>\n    <string>--watchdog</string>"
        ));
    }

    #[test]
    fn paths_are_escaped_in_both_files() {
        let tricky = WatchdogSpec {
            executable: PathBuf::from("/Apps/A&B <x>/agent"),
        };
        assert!(launch_agent_plist(&tricky).contains("/Apps/A&amp;B &lt;x&gt;/agent"));
        assert!(
            scheduled_task_xml(&tricky, r"ACME\lucas").contains("/Apps/A&amp;B &lt;x&gt;/agent")
        );
    }

    #[test]
    fn the_task_starts_at_sign_in_and_restarts_on_failure() {
        let xml = scheduled_task_xml(&spec(), r"ACME\lucas");
        assert!(xml.contains("<LogonTrigger>"));
        assert!(xml.contains(r"<UserId>ACME\lucas</UserId>"));
        assert!(xml.contains(
            "<RestartOnFailure>\n      <Interval>PT1M</Interval>\n      <Count>999</Count>"
        ));
        assert!(xml.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"));
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(xml.contains("<Arguments>--watchdog</Arguments>"));
        assert!(xml.contains("<RunLevel>LeastPrivilege</RunLevel>"));
    }

    #[test]
    fn the_plist_lives_in_the_users_launch_agents_folder() {
        assert_eq!(
            launch_agent_path(Path::new("/Users/lucas")),
            PathBuf::from("/Users/lucas/Library/LaunchAgents/com.aiproctor.agent.plist")
        );
    }

    #[test]
    fn writing_twice_changes_nothing_the_second_time() {
        let dir = tempfile::tempdir().unwrap();
        let path = launch_agent_path(dir.path());
        let plist = launch_agent_plist(&spec());
        assert_eq!(
            write_if_changed(&path, &plist),
            Ok(WatchdogOutcome::Installed)
        );
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(
            write_if_changed(&path, &plist),
            Ok(WatchdogOutcome::Unchanged)
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            modified,
            "an unchanged file is not rewritten"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), plist);
    }

    #[test]
    fn a_moved_app_rewrites_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = launch_agent_path(dir.path());
        write_if_changed(&path, &launch_agent_plist(&spec())).unwrap();
        let moved = WatchdogSpec {
            executable: PathBuf::from("/Users/lucas/Apps/AI Proctor.app/Contents/MacOS/agent"),
        };
        assert_eq!(
            write_if_changed(&path, &launch_agent_plist(&moved)),
            Ok(WatchdogOutcome::Updated)
        );
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("/Users/lucas/Apps/"));
    }

    #[test]
    fn removing_a_missing_file_is_fine() {
        let dir = tempfile::tempdir().unwrap();
        let path = launch_agent_path(dir.path());
        assert_eq!(remove_file(&path), Ok(()));
        write_if_changed(&path, "x").unwrap();
        assert_eq!(remove_file(&path), Ok(()));
        assert!(!path.exists());
    }

    #[test]
    fn a_translocated_or_temporary_copy_is_not_a_place_to_point_at() {
        assert!(stable_executable(Path::new(
            "/Applications/AI Proctor.app/Contents/MacOS/agent"
        )));
        assert!(!stable_executable(Path::new(
            "/private/var/folders/ab/T/AppTranslocation/X/d/AI Proctor.app/Contents/MacOS/agent"
        )));
        assert!(!stable_executable(Path::new(
            "/private/var/folders/ab/T/agent"
        )));
    }
}
