//! Camera and microphone in use by another app, from Windows' consent store (#167;
//! CHK-03 "In meeting"). Every app that opens the camera or microphone gets a key
//! under `CapabilityAccessManager\ConsentStore\{webcam,microphone}` with
//! `LastUsedTimeStart` / `LastUsedTimeStop` (FILETIME as a QWORD); `Stop` is 0 while
//! the device is open. Desktop apps sit under `NonPackaged` (the key name is the exe
//! path with `\` written as `#`), store apps directly under the key. The reads live
//! in `agent-platform`; the rules are here so they run in CI on every OS.
//!
//! An app that crashes with the device open never writes its `Stop`, so its entry
//! reads "in use" until the next boot. Entries that started before the last boot
//! can't be live and are ignored (#174).

/// Under HKEY_CURRENT_USER.
pub const CONSENT_STORE: &str =
    r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore";

/// The subkey holding the desktop apps of a device key.
pub const NON_PACKAGED: &str = "NonPackaged";

/// One app's entry for a device.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    pub start: u64,
    pub stop: u64,
}

/// FILETIME ticks (100 ns) per millisecond.
const TICKS_PER_MS: u64 = 10_000;

impl Usage {
    /// Opened and not closed yet.
    pub fn in_use(&self) -> bool {
        self.start != 0 && self.stop == 0
    }

    /// Opened and not closed yet, and opened since the system booted
    /// (`boot_filetime` is a FILETIME). An entry that predates the boot is a
    /// leftover from a crash, not a live call.
    pub fn in_use_since(&self, boot_filetime: u64) -> bool {
        self.in_use() && self.start >= boot_filetime
    }
}

/// When the system booted, as a FILETIME: `now_filetime` minus the uptime in
/// milliseconds (`GetTickCount64`, which counts time asleep too).
pub fn boot_filetime(now_filetime: u64, uptime_ms: u64) -> u64 {
    now_filetime.saturating_sub(uptime_ms.saturating_mul(TICKS_PER_MS))
}

/// True if the consent store key name `key` (`C:#Users#me#app#agent.exe`) is the
/// running agent, whose own use of the camera (a check-in's webcam frame) must not
/// count as a call. Case-insensitive, like Windows paths.
pub fn is_own_entry(key: &str, own_exe: &str) -> bool {
    !own_exe.is_empty() && key.replace('#', "\\").eq_ignore_ascii_case(own_exe)
}

/// True if any entry other than the agent's is in use and started since
/// `boot_filetime` (0 trusts every entry).
pub fn device_in_use<'a>(
    entries: impl IntoIterator<Item = (&'a str, Usage)>,
    own_exe: &str,
    boot_filetime: u64,
) -> bool {
    entries
        .into_iter()
        .any(|(key, usage)| usage.in_use_since(boot_filetime) && !is_own_entry(key, own_exe))
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPEN: Usage = Usage {
        start: 133_800_000_000_000_000,
        stop: 0,
    };
    const CLOSED: Usage = Usage {
        start: 133_800_000_000_000_000,
        stop: 133_800_000_100_000_000,
    };
    const OWN: &str = r"C:\Program Files\AI Proctor\ai-proctor-agent.exe";
    /// The system booted before `OPEN` / `CLOSED` started.
    const BOOT: u64 = 133_700_000_000_000_000;

    #[test]
    fn open_means_started_and_not_stopped() {
        assert!(OPEN.in_use());
        assert!(!CLOSED.in_use());
        assert!(!Usage::default().in_use(), "never used");
    }

    #[test]
    fn the_key_name_is_the_path_with_hashes() {
        assert!(is_own_entry(
            "C:#Program Files#AI Proctor#ai-proctor-agent.exe",
            OWN
        ));
        assert!(is_own_entry(
            "c:#program files#ai proctor#AI-PROCTOR-AGENT.EXE",
            OWN
        ));
        assert!(!is_own_entry("C:#Program Files#Zoom#bin#Zoom.exe", OWN));
        assert!(!is_own_entry("anything", ""));
    }

    #[test]
    fn another_app_using_the_device_is_a_call() {
        let zoom = "C:#Program Files#Zoom#bin#Zoom.exe";
        assert!(device_in_use([(zoom, OPEN)], OWN, BOOT));
        assert!(!device_in_use([(zoom, CLOSED)], OWN, BOOT));
        assert!(!device_in_use([], OWN, BOOT));
    }

    #[test]
    fn the_agents_own_use_is_not_a_call() {
        let own = "C:#Program Files#AI Proctor#ai-proctor-agent.exe";
        assert!(!device_in_use([(own, OPEN)], OWN, BOOT));
        let teams = "MSTeams_8wekyb3d8bbwe";
        assert!(device_in_use([(own, OPEN), (teams, OPEN)], OWN, BOOT));
    }

    #[test]
    fn an_entry_left_open_by_a_crash_before_boot_is_not_a_call() {
        let zoom = "C:#Program Files#Zoom#bin#Zoom.exe";
        let stale = Usage {
            start: BOOT - 1,
            stop: 0,
        };
        assert!(stale.in_use());
        assert!(!stale.in_use_since(BOOT));
        assert!(!device_in_use([(zoom, stale)], OWN, BOOT));
        // Another app really in a call still counts.
        assert!(device_in_use(
            [(zoom, stale), ("MSTeams_x", OPEN)],
            OWN,
            BOOT
        ));
        // Started exactly at boot is live; boot 0 trusts everything.
        let at_boot = Usage {
            start: BOOT,
            stop: 0,
        };
        assert!(at_boot.in_use_since(BOOT));
        assert!(device_in_use([(zoom, stale)], OWN, 0));
    }

    #[test]
    fn boot_is_now_minus_uptime() {
        // 1 hour up: 3.6e6 ms = 3.6e10 ticks.
        assert_eq!(
            boot_filetime(133_800_036_000_000_000, 3_600_000),
            133_800_000_000_000_000
        );
        assert_eq!(boot_filetime(100, 1), 0, "never below zero");
        assert_eq!(boot_filetime(5, u64::MAX), 0, "no overflow");
    }
}
