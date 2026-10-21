//! Where the agent runs (ANT-07, #63): a Remote Desktop session or a remotely
//! controlled one from the system metrics, a virtual machine from the BIOS strings
//! and the CPUID hypervisor vendor. Best effort, flag only; the tables are in
//! `agent_core::anticheat`. Needs a device test (no Windows machine yet).

use std::sync::OnceLock;

use agent_core::anticheat::{is_guest_hypervisor, is_vm_hardware};
use agent_core::platform::RunEnvironment;
use windows::core::HSTRING;
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_REMOTECONTROL, SM_REMOTESESSION,
};

/// Read once per run: the machine doesn't stop being a VM.
static VIRTUAL_MACHINE: OnceLock<bool> = OnceLock::new();

pub fn current() -> RunEnvironment {
    RunEnvironment {
        virtual_machine: *VIRTUAL_MACHINE.get_or_init(virtual_machine),
        remote_session: remote_session(),
    }
}

/// SM_REMOTESESSION: this session is a Remote Desktop one. SM_REMOTECONTROL: the
/// console session is being shadowed (remote control).
fn remote_session() -> bool {
    unsafe { GetSystemMetrics(SM_REMOTESESSION) != 0 || GetSystemMetrics(SM_REMOTECONTROL) != 0 }
}

fn virtual_machine() -> bool {
    let maker = bios("SystemManufacturer").unwrap_or_default();
    let model = bios("SystemProductName").unwrap_or_default();
    let vendor = hypervisor_vendor().unwrap_or_default();
    let vm = is_vm_hardware(&maker, &model) || is_guest_hypervisor(&vendor);
    tracing::info!(maker, model, vendor, vm, "run environment");
    vm
}

/// A string under `HKLM\HARDWARE\DESCRIPTION\System\BIOS` (no admin rights needed).
fn bios(name: &str) -> Option<String> {
    let key = HSTRING::from(r"HARDWARE\DESCRIPTION\System\BIOS");
    let value = HSTRING::from(name);
    let mut buffer = [0u16; 256];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            &key,
            &value,
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size),
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let chars = (size as usize / 2).min(buffer.len());
    let text = String::from_utf16_lossy(&buffer[..chars]);
    Some(text.trim_end_matches('\0').trim().to_owned())
}

/// The CPUID hypervisor vendor (leaf 0x4000_0000), when the hypervisor bit is set.
#[cfg(target_arch = "x86_64")]
#[allow(unused_unsafe)]
fn hypervisor_vendor() -> Option<String> {
    use std::arch::x86_64::__cpuid;
    let features = unsafe { __cpuid(1) };
    if features.ecx & (1 << 31) == 0 {
        return None;
    }
    let leaf = unsafe { __cpuid(0x4000_0000) };
    let bytes: Vec<u8> = [leaf.ebx, leaf.ecx, leaf.edx]
        .iter()
        .flat_map(|r| r.to_le_bytes())
        .collect();
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Arm64 Windows: no CPUID; the BIOS strings still count.
#[cfg(not(target_arch = "x86_64"))]
fn hypervisor_vendor() -> Option<String> {
    None
}
