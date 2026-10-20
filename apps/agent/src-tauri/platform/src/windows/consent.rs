//! Camera and microphone in use by another app (CHK-03 deferral, "In meeting"),
//! read from the per-user consent store. See `agent_core::consent_store` for the
//! layout and the rules; this only reads the registry.

use std::sync::OnceLock;

use agent_core::consent_store::{boot_filetime, device_in_use, Usage, CONSENT_STORE, NON_PACKAGED};
use agent_core::platform::CallState;
use windows::core::{HSTRING, PWSTR};
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
    RRF_RT_REG_QWORD,
};
use windows::Win32::System::SystemInformation::{GetSystemTimeAsFileTime, GetTickCount64};

/// An open registry key, closed on drop.
struct Key(HKEY);

impl Key {
    fn open(parent: HKEY, path: &str) -> Option<Self> {
        let mut key = HKEY::default();
        let status =
            unsafe { RegOpenKeyExW(parent, &HSTRING::from(path), None, KEY_READ, &mut key) };
        status.is_ok().then_some(Self(key))
    }

    /// Names of the subkeys.
    fn subkeys(&self) -> Vec<String> {
        let mut names = Vec::new();
        for index in 0.. {
            let mut buf = [0u16; 512];
            let mut len = buf.len() as u32;
            let status = unsafe {
                RegEnumKeyExW(
                    self.0,
                    index,
                    Some(PWSTR(buf.as_mut_ptr())),
                    &mut len,
                    None,
                    None,
                    None,
                    None,
                )
            };
            if status.is_err() {
                break;
            }
            names.push(String::from_utf16_lossy(&buf[..len as usize]));
        }
        names
    }

    fn qword(&self, name: &str) -> Option<u64> {
        let mut value = 0u64;
        let mut size = size_of::<u64>() as u32;
        let status = unsafe {
            RegGetValueW(
                self.0,
                None,
                &HSTRING::from(name),
                RRF_RT_REG_QWORD,
                None,
                Some(&mut value as *mut u64 as *mut _),
                Some(&mut size),
            )
        };
        status.is_ok().then_some(value)
    }
}

impl Drop for Key {
    fn drop(&mut self) {
        let _ = unsafe { RegCloseKey(self.0) };
    }
}

/// One app's start/stop times. A missing `Stop` counts as stopped: Windows writes
/// both together, so a lone `Start` is not a reliable "open".
fn usage(parent: &Key, name: &str) -> Option<Usage> {
    let key = Key::open(parent.0, name)?;
    Some(Usage {
        start: key.qword("LastUsedTimeStart").unwrap_or(0),
        stop: key.qword("LastUsedTimeStop").unwrap_or(u64::MAX),
    })
}

/// Every app's entry under `webcam` or `microphone`: store apps directly, desktop
/// apps under `NonPackaged`.
fn entries(device: &str) -> Vec<(String, Usage)> {
    let Some(root) = Key::open(HKEY_CURRENT_USER, &format!(r"{CONSENT_STORE}\{device}")) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for name in root.subkeys() {
        if name == NON_PACKAGED {
            if let Some(desktop) = Key::open(root.0, NON_PACKAGED) {
                for app in desktop.subkeys() {
                    if let Some(u) = usage(&desktop, &app) {
                        found.push((app, u));
                    }
                }
            }
        } else if let Some(u) = usage(&root, &name) {
            found.push((name, u));
        }
    }
    found
}

/// The running agent's executable path, whose own camera use is not a call.
fn own_exe() -> &'static str {
    static OWN: OnceLock<String> = OnceLock::new();
    OWN.get_or_init(|| {
        std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    })
}

/// When the system booted, as a FILETIME. Entries left open by a crash from before
/// that are not calls (`agent_core::consent_store`).
fn boot() -> u64 {
    let now = unsafe { GetSystemTimeAsFileTime() };
    let now = u64::from(now.dwHighDateTime) << 32 | u64::from(now.dwLowDateTime);
    boot_filetime(now, unsafe { GetTickCount64() })
}

pub fn call_state() -> CallState {
    let boot = boot();
    let in_use = |device: &str| {
        let entries = entries(device);
        device_in_use(
            entries.iter().map(|(k, u)| (k.as_str(), *u)),
            own_exe(),
            boot,
        )
    };
    CallState {
        camera: in_use("webcam"),
        mic: in_use("microphone"),
    }
}
