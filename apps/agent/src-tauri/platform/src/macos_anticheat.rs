//! macOS anti-cheat signals (#63): synthetic clicks on the card (ANT-03), the camera's
//! name (ANT-05) and whether the Mac is a virtual machine or being screen-shared into
//! (ANT-07). Best effort and flag only; the decisions are in `agent_core::anticheat`.
//!
//! Synthetic clicks: while the card is up, a local event monitor (our own process's
//! events only, so no Accessibility or Input Monitoring permission) reads the
//! CoreGraphics event behind each mouse press on the card. A press from the trackpad
//! or a mouse comes from the HID system with no posting process; one made with
//! `CGEventPost` (an auto-clicker, AppleScript, `cliclick`) names the process that
//! posted it, or comes from a private event source. Nothing is blocked: macOS has no
//! way to tell every case apart (a program injecting at the HID level looks like a
//! device), and remote-control and assistive tools post events too, so the card still
//! takes the click and the check-in only carries `synthetic_click:<n>` for the manager
//! to look at. Each press's source pid and state are logged, so a device test can
//! confirm what a real click reads as.

use std::ffi::{c_char, c_int, c_void, CString};
use std::process::Command;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use agent_core::anticheat::{is_synthetic_event, is_vm_hardware};
use agent_core::platform::{CameraDevice, InjectedInput, RunEnvironment, ScreenRect};
use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSEvent, NSEventMask};
use objc2_av_foundation::{AVCaptureDevice, AVMediaTypeVideo};
use objc2_core_graphics::{CGDisplayBounds, CGEvent, CGEventField, CGMainDisplayID};

/// The event monitor's token, moved to the main thread to be removed there.
struct Token(Retained<AnyObject>);
// Only handed to `removeMonitor:` on the main thread.
unsafe impl Send for Token {}

/// One card's guard: the monitor (installed on the main thread, maybe a moment after
/// `start`) and what it has counted.
pub struct CardGuard {
    monitor: Arc<Mutex<Option<Token>>>,
    synthetic: Arc<AtomicU32>,
}

impl CardGuard {
    /// Starts counting synthetic-looking presses on the card at `area` (physical
    /// pixels, top-left origin, as Tauri reports the window).
    pub fn start(area: ScreenRect) -> Self {
        let monitor: Arc<Mutex<Option<Token>>> = Arc::default();
        let synthetic = Arc::new(AtomicU32::new(0));
        let (slot, count) = (Arc::clone(&monitor), Arc::clone(&synthetic));
        on_main(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let card = card_window(mtm, area);
            if card.is_none() {
                tracing::warn!("card window not found: watching every window of the app");
            }
            let own_pid = i64::from(std::process::id());
            let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
                let e = unsafe { event.as_ref() };
                if card.is_none_or(|n| e.windowNumber() == n) {
                    if let Some(cg) = e.CGEvent() {
                        let pid = CGEvent::integer_value_field(
                            Some(&cg),
                            CGEventField::EventSourceUnixProcessID,
                        );
                        let state = CGEvent::integer_value_field(
                            Some(&cg),
                            CGEventField::EventSourceStateID,
                        );
                        let synthetic = is_synthetic_event(pid, state, own_pid);
                        tracing::info!(
                            source_pid = pid,
                            source_state = state,
                            synthetic,
                            "card press"
                        );
                        if synthetic {
                            count.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                }
                // Always passed on: flag only, never blocked (ANT-03).
                event.as_ptr()
            });
            let mask = NSEventMask::LeftMouseDown
                | NSEventMask::RightMouseDown
                | NSEventMask::OtherMouseDown;
            let token =
                unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &block) };
            match token {
                Some(token) => *slot.lock().unwrap() = Some(Token(token)),
                None => tracing::warn!("card event monitor not installed"),
            }
        });
        Self { monitor, synthetic }
    }

    /// Removes the monitor and returns what it counted.
    pub fn stop(self) -> InjectedInput {
        let synthetic = self.synthetic.load(Ordering::SeqCst);
        let slot = self.monitor;
        // Queued after the install if that hasn't run yet: the main queue is serial.
        on_main(move || {
            if let Some(Token(token)) = slot.lock().unwrap().take() {
                unsafe { NSEvent::removeMonitor(&token) };
            }
        });
        InjectedInput {
            count: 0,
            synthetic,
        }
    }
}

/// Runs `work` on the main thread: now if this is it, else queued.
fn on_main(work: impl FnOnce() + Send + 'static) {
    if MainThreadMarker::new().is_some() {
        work();
    } else {
        DispatchQueue::main().exec_async(work);
    }
}

/// The window number of our window at `area`: AppKit frames are in points from the
/// bottom-left of the main display; Tauri's are physical pixels from its top-left.
fn card_window(mtm: MainThreadMarker, area: ScreenRect) -> Option<isize> {
    let main_height = CGDisplayBounds(CGMainDisplayID()).size.height;
    let windows = NSApplication::sharedApplication(mtm).windows();
    let matches: Vec<isize> = windows
        .iter()
        .filter(|w| w.isVisible())
        .filter(|w| {
            let frame = w.frame();
            let scale = w.backingScaleFactor();
            let x = frame.origin.x * scale;
            let y = (main_height - (frame.origin.y + frame.size.height)) * scale;
            (x - f64::from(area.x)).abs() <= 3.0 && (y - f64::from(area.y)).abs() <= 3.0
        })
        .map(|w| w.windowNumber())
        .collect();
    match matches.as_slice() {
        [only] => Some(*only),
        _ => None,
    }
}

/// The default camera (the one `capture_webcam` opens), by name and model id.
pub fn camera_device() -> Option<CameraDevice> {
    let video = unsafe { AVMediaTypeVideo }?;
    let device = unsafe { AVCaptureDevice::defaultDeviceWithMediaType(video) }?;
    let (name, model) = unsafe { (device.localizedName(), device.modelID()) };
    Some(CameraDevice {
        name: name.to_string(),
        model: Some(model.to_string()).filter(|m| !m.is_empty()),
    })
}

/// Read once per run: the Mac doesn't stop being a VM.
static VIRTUAL_MACHINE: OnceLock<bool> = OnceLock::new();

pub fn run_environment() -> RunEnvironment {
    RunEnvironment {
        virtual_machine: *VIRTUAL_MACHINE.get_or_init(virtual_machine),
        remote_session: screen_sharing_in(),
    }
}

/// `kern.hv_vmm_present` is 1 inside a hypervisor guest (Apple Virtualization,
/// Parallels, VMware, UTM); `hw.model` names the guest hardware ("VirtualMac2,1").
fn virtual_machine() -> bool {
    let hv = sysctl_int("kern.hv_vmm_present").unwrap_or(0);
    let model = sysctl_string("hw.model").unwrap_or_default();
    let vm = hv == 1 || is_vm_hardware("", &model);
    tracing::info!(hv_vmm_present = hv, model, vm, "run environment");
    vm
}

/// Someone is connected to this Mac with Screen Sharing or Remote Management: macOS
/// starts `screensharingd` for an incoming session and ends it afterwards. Other
/// remote-control apps (TeamViewer, AnyDesk) aren't seen.
fn screen_sharing_in() -> bool {
    Command::new("/usr/bin/pgrep")
        .args(["-x", "screensharingd"])
        .output()
        .is_ok_and(|o| o.status.success())
}

extern "C" {
    fn sysctlbyname(
        name: *const c_char,
        oldp: *mut c_void,
        oldlenp: *mut usize,
        newp: *mut c_void,
        newlen: usize,
    ) -> c_int;
}

fn sysctl_int(name: &str) -> Option<i32> {
    let name = CString::new(name).ok()?;
    let mut value: i32 = 0;
    let mut len = std::mem::size_of::<i32>();
    let rc = unsafe {
        sysctlbyname(
            name.as_ptr(),
            (&mut value as *mut i32).cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    (rc == 0).then_some(value)
}

fn sysctl_string(name: &str) -> Option<String> {
    let name = CString::new(name).ok()?;
    let mut buffer = [0u8; 128];
    let mut len = buffer.len();
    let rc = unsafe {
        sysctlbyname(
            name.as_ptr(),
            buffer.as_mut_ptr().cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return None;
    }
    let text = &buffer[..len.min(buffer.len())];
    let end = text.iter().position(|b| *b == 0).unwrap_or(text.len());
    Some(String::from_utf8_lossy(&text[..end]).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sysctl_reads_this_macs_model_and_hypervisor_state() {
        assert!(sysctl_string("hw.model").is_some_and(|m| !m.is_empty()));
        assert!(matches!(sysctl_int("kern.hv_vmm_present"), Some(0 | 1)));
        assert_eq!(sysctl_int("no.such.key"), None);
    }
}
