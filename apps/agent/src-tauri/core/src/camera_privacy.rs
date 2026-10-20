//! Windows camera privacy settings (#59; AGT-03). Settings → Privacy & security →
//! Camera keeps two switches in the per-user consent store: "Camera access" and "Let
//! desktop apps access your camera". Either one set to Deny stops the agent (a desktop
//! app) from reading the camera. The reads happen in `agent-platform`; the parsing is
//! here so it runs in CI on every OS.

use crate::contracts::PermissionState;

/// "Camera access" for this user.
pub const CONSENT_KEY: &str =
    r"HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam";

/// "Let desktop apps access your camera".
pub const DESKTOP_APPS_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam\NonPackaged";

/// The `Value` entry of a key from `reg query <key> /v Value`, whose output looks like
///
/// ```text
/// HKEY_CURRENT_USER\Software\...\webcam
///     Value    REG_SZ    Allow
/// ```
///
/// `None` when the entry isn't there (reg.exe printed an error, or nothing).
pub fn parse_reg_value(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let (name, kind, value) = (parts.next()?, parts.next()?, parts.next()?);
        (name.eq_ignore_ascii_case("Value") && kind.eq_ignore_ascii_case("REG_SZ"))
            .then(|| value.to_owned())
    })
}

/// The camera permission from the two switches. Only an explicit "Deny" blocks: a
/// missing entry is Windows' default (allowed), and a camera that has never been used
/// has no entries at all.
pub fn camera_state(consent: Option<&str>, desktop_apps: Option<&str>) -> PermissionState {
    let denied = |value: Option<&str>| value.is_some_and(|v| v.eq_ignore_ascii_case("Deny"));
    if denied(consent) || denied(desktop_apps) {
        PermissionState::Denied
    } else {
        PermissionState::Granted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALLOW: &str = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam\r\n    Value    REG_SZ    Allow\r\n\r\n";

    #[test]
    fn reads_the_value_from_reg_query_output() {
        assert_eq!(parse_reg_value(ALLOW).as_deref(), Some("Allow"));
        assert_eq!(
            parse_reg_value("    Value    REG_SZ    Deny\n").as_deref(),
            Some("Deny")
        );
        assert_eq!(
            parse_reg_value("    value    reg_sz    Deny\n").as_deref(),
            Some("Deny"),
            "reg.exe's casing doesn't matter"
        );
    }

    #[test]
    fn a_missing_entry_or_an_error_has_no_value() {
        assert_eq!(parse_reg_value(""), None);
        assert_eq!(
            parse_reg_value(
                "ERROR: The system was unable to find the specified registry key or value.\r\n"
            ),
            None
        );
        assert_eq!(
            parse_reg_value("    LastUsedTimeStart    REG_QWORD    0x1d9\n"),
            None,
            "other entries are ignored"
        );
    }

    #[test]
    fn either_switch_off_blocks_the_camera() {
        assert_eq!(
            camera_state(Some("Allow"), Some("Allow")),
            PermissionState::Granted
        );
        assert_eq!(
            camera_state(Some("Deny"), Some("Allow")),
            PermissionState::Denied
        );
        assert_eq!(
            camera_state(Some("Allow"), Some("Deny")),
            PermissionState::Denied,
            "desktop apps are blocked while camera access is on"
        );
        assert_eq!(camera_state(Some("deny"), None), PermissionState::Denied);
    }

    #[test]
    fn nothing_set_means_windows_default_allow() {
        assert_eq!(camera_state(None, None), PermissionState::Granted);
        assert_eq!(camera_state(Some("Allow"), None), PermissionState::Granted);
    }
}
