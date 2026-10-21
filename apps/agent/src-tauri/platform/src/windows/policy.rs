//! Values IT sets through MDM (#86): Intune, or any tool that writes the policy
//! registry. Only `HKEY_LOCAL_MACHINE` is read, which a standard user can't write.
//! Needs a device test (no Windows machine yet).

use agent_core::enrollment::{TOKEN_KEY, WINDOWS_POLICY_KEY};
use windows::core::HSTRING;
use windows::Win32::System::Registry::{
    RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY,
};

/// Longest value read, in bytes (UTF-16, with the terminating null). A token is 48
/// characters; anything far longer isn't one.
const MAX_BYTES: u32 = 1024;

/// `EnrollmentToken` under `HKLM\SOFTWARE\Policies\AIProctor\Agent` (64-bit view).
pub fn enrollment_token() -> Option<String> {
    machine_string(WINDOWS_POLICY_KEY, TOKEN_KEY)
}

/// A `REG_SZ` value under `HKEY_LOCAL_MACHINE`, or `None` when it's missing, of
/// another type or too long.
fn machine_string(key: &str, name: &str) -> Option<String> {
    let (key, name) = (HSTRING::from(key), HSTRING::from(name));
    let flags = RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY;
    let mut size = 0u32;
    // First the size, in bytes including the null.
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            &key,
            &name,
            flags,
            None,
            None,
            Some(&mut size),
        )
    };
    if status.is_err() || !(2..=MAX_BYTES).contains(&size) {
        return None;
    }
    let mut buf = vec![0u16; (size as usize).div_ceil(2)];
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            &key,
            &name,
            flags,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    if status.is_err() {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..len]))
}
