//! The macOS watchdog (ANT-01): a LaunchAgent in `~/Library/LaunchAgents` that runs
//! the agent at login and again whenever it is killed. The plist comes from
//! `agent_core::watchdog`; this runs `launchctl`.
//!
//! First run is the awkward one: the person opened the app from Finder, so that
//! process isn't launchd's, and a kill would not bring it back. So once the job is
//! loaded the agent asks launchd to start its own copy and, when that is running,
//! tells the caller to exit (`handed_over`).

use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use agent_core::watchdog::{
    self, WatchdogError, WatchdogOutcome, WatchdogSpec, WatchdogState, LABEL, SUPERVISED_ARG,
};
use chrono::{DateTime, Utc};

/// How long to wait for launchd to start its copy before carrying on as we are.
const START_WAIT: Duration = Duration::from_secs(8);

fn home() -> Result<PathBuf, WatchdogError> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| WatchdogError::Failed("no home folder".into()))
}

fn plist_path() -> Result<PathBuf, WatchdogError> {
    Ok(watchdog::launch_agent_path(&home()?))
}

fn run(program: &str, args: &[&str]) -> Option<std::process::Output> {
    Command::new(program).args(args).output().ok()
}

fn succeeded(output: Option<std::process::Output>) -> bool {
    output.is_some_and(|o| o.status.success())
}

/// `gui/<uid>`: the per-user domain a LaunchAgent lives in.
fn domain() -> Result<String, WatchdogError> {
    let out = run("id", &["-u"]).ok_or_else(|| WatchdogError::Failed("id -u failed".into()))?;
    let uid = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    if uid.is_empty() || !uid.bytes().all(|b| b.is_ascii_digit()) {
        return Err(WatchdogError::Failed(format!("unexpected uid {uid:?}")));
    }
    Ok(format!("gui/{uid}"))
}

fn loaded(domain: &str) -> bool {
    succeeded(run("launchctl", &["print", &format!("{domain}/{LABEL}")]))
}

fn running(domain: &str) -> bool {
    run("launchctl", &["print", &format!("{domain}/{LABEL}")])
        .map(|o| job_is_running(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or(false)
}

/// `launchctl print` lists `state = running` for a job with a live process.
fn job_is_running(print_output: &str) -> bool {
    print_output.lines().any(|l| l.trim() == "state = running")
}

/// launchd starts the agent with the job's label as `XPC_SERVICE_NAME`; the plist
/// also passes `--watchdog`.
pub fn supervised() -> bool {
    std::env::var("XPC_SERVICE_NAME").is_ok_and(|v| v == LABEL)
        || std::env::args().any(|a| a == SUPERVISED_ARG)
}

pub fn install(spec: &WatchdogSpec) -> Result<WatchdogState, WatchdogError> {
    let path = plist_path()?;
    let outcome = watchdog::write_if_changed(&path, &watchdog::launch_agent_plist(spec))?;
    if supervised() {
        // launchd started this process: nothing to hand over. A rewritten plist is
        // read the next time the job loads.
        return Ok(WatchdogState {
            outcome,
            supervised: true,
            handed_over: false,
        });
    }
    let domain = domain()?;
    let target = format!("{domain}/{LABEL}");
    let plist = path.to_string_lossy().into_owned();
    let started = if loaded(&domain) {
        if outcome == WatchdogOutcome::Updated {
            // The job was loaded from the old file: load it again from the new one.
            run("launchctl", &["bootout", &target]);
            succeeded(run("launchctl", &["bootstrap", &domain, &plist]))
        } else if running(&domain) {
            true
        } else {
            succeeded(run("launchctl", &["kickstart", &target]))
        }
    } else {
        // RunAtLoad starts it.
        succeeded(run("launchctl", &["bootstrap", &domain, &plist]))
    };
    let handed_over = started && wait_until_running(&domain);
    tracing::info!(?outcome, started, handed_over, "watchdog installed");
    Ok(WatchdogState {
        outcome,
        supervised: false,
        handed_over,
    })
}

fn wait_until_running(domain: &str) -> bool {
    let deadline = Instant::now() + START_WAIT;
    while Instant::now() < deadline {
        if running(domain) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

pub fn uninstall() -> Result<(), WatchdogError> {
    // Unloading stops a running copy, which may be this process; the file goes first
    // so nothing loads it again.
    let path = plist_path()?;
    watchdog::remove_file(&path)?;
    if let Ok(domain) = domain() {
        run("launchctl", &["bootout", &format!("{domain}/{LABEL}")]);
    }
    Ok(())
}

pub fn installed() -> bool {
    plist_path().is_ok_and(|p| p.exists())
}

/// `sysctl -n kern.boottime` prints `{ sec = 1729412345, usec = 123456 } Tue …`.
pub fn boot_time() -> Option<DateTime<Utc>> {
    let out = run("sysctl", &["-n", "kern.boottime"])?;
    parse_boot_time(&String::from_utf8_lossy(&out.stdout))
}

fn parse_boot_time(text: &str) -> Option<DateTime<Utc>> {
    let after = text.split("sec =").nth(1)?;
    let secs: i64 = after
        .trim_start()
        .split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .ok()?;
    DateTime::from_timestamp(secs, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_boot_time_from_sysctl() {
        let out = "{ sec = 1729412345, usec = 123456 } Sun Oct 20 08:19:05 2024\n";
        assert_eq!(
            parse_boot_time(out),
            DateTime::from_timestamp(1_729_412_345, 0)
        );
        assert_eq!(parse_boot_time("nonsense"), None);
        assert_eq!(parse_boot_time("{ sec = , usec = 1 }"), None);
    }

    #[test]
    fn sees_a_running_job_in_launchctl_print() {
        let running = "gui/501/com.aiproctor.agent = {\n\tactive count = 1\n\tstate = running\n\tprogram = /x\n}";
        let waiting = "gui/501/com.aiproctor.agent = {\n\tstate = waiting\n}";
        assert!(job_is_running(running));
        assert!(!job_is_running(waiting));
    }
}
