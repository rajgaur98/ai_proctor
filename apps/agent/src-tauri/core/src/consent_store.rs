//! Camera and microphone in use by another app, from Windows' consent store (#167;
//! CHK-03 "In meeting"). Every app that opens the camera or microphone gets a key
//! under `CapabilityAccessManager\ConsentStore\{webcam,microphone}` with
//! `LastUsedTimeStart` / `LastUsedTimeStop` (FILETIME as a QWORD); `Stop` is 0 while
//! the device is open. Desktop apps sit under `NonPackaged` (the key name is the exe
//! path with `\` written as `#`), store apps directly under the key. The reads live
//! in `agent-platform`; the rules are here so they run in CI on every OS.

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

impl Usage {
    /// Opened and not closed yet.
    pub fn in_use(&self) -> bool {
        self.start != 0 && self.stop == 0
    }
}

/// True if the consent store key name `key` (`C:#Users#me#app#agent.exe`) is the
/// running agent, whose own use of the camera (a check-in's webcam frame) must not
/// count as a call. Case-insensitive, like Windows paths.
pub fn is_own_entry(key: &str, own_exe: &str) -> bool {
    !own_exe.is_empty() && key.replace('#', "\\").eq_ignore_ascii_case(own_exe)
}

/// True if any entry other than the agent's is in use.
pub fn device_in_use<'a>(
    entries: impl IntoIterator<Item = (&'a str, Usage)>,
    own_exe: &str,
) -> bool {
    entries
        .into_iter()
        .any(|(key, usage)| usage.in_use() && !is_own_entry(key, own_exe))
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
        assert!(device_in_use([(zoom, OPEN)], OWN));
        assert!(!device_in_use([(zoom, CLOSED)], OWN));
        assert!(!device_in_use([], OWN));
    }

    #[test]
    fn the_agents_own_use_is_not_a_call() {
        let own = "C:#Program Files#AI Proctor#ai-proctor-agent.exe";
        assert!(!device_in_use([(own, OPEN)], OWN));
        let teams = "MSTeams_8wekyb3d8bbwe";
        assert!(device_in_use([(own, OPEN), (teams, OPEN)], OWN));
    }
}
