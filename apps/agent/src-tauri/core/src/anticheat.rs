//! Anti-cheat signals the agent adds to a check-in's `flags` (#26, #63; ANT-02,
//! ANT-03, ANT-05, ANT-06, ANT-07). Raw state only: the server turns each into a
//! "needs review" row for the manager (`internal.anticheat_from_checkin`) and never
//! into a penalty (ANT-08). Nothing here changes a check-in's outcome, status or time.
//!
//! The decisions are pure and live here so every OS uses the same tables and they run
//! in CI; the platforms only read the names and numbers they're fed.

use crate::platform::{CameraDevice, RunEnvironment};

/// ANT-03: clicks on the card that looked synthetic, let through (macOS), with their
/// number: `synthetic_click:2`.
pub const SYNTHETIC_CLICK_FLAG: &str = "synthetic_click";
/// ANT-05: the webcam frame came from a known virtual camera, with its name:
/// `virtual_camera:OBS Virtual Camera`.
pub const VIRTUAL_CAMERA_FLAG: &str = "virtual_camera";
/// ANT-06: the webcam frame is near-identical to an earlier passed check-in's, with
/// the distance between their hashes: `duplicate_frame:2`.
pub const DUPLICATE_FRAME_FLAG: &str = "duplicate_frame";
/// ANT-07: the agent ran inside a virtual machine when the card was shown.
pub const VIRTUAL_MACHINE_FLAG: &str = "virtual_machine";
/// ANT-07: the session was a remote one (Remote Desktop) or remotely controlled.
pub const REMOTE_SESSION_FLAG: &str = "remote_session";

/// The contract caps a flag at 40 characters; `virtual_camera:` takes 15.
const CAMERA_NAME_MAX: usize = 24;

/// ANT-05: cameras that show whatever a program feeds them (a video file, a still, a
/// scene), matched case-insensitively anywhere in the device's name or model. Cameras
/// that relay a live camera with effects (NVIDIA Broadcast, phone-as-webcam apps) are
/// left out on purpose: they show the person, so flagging them would only be noise.
/// Data, not logic: add a name here when a new one turns up.
pub const VIRTUAL_CAMERAS: &[&str] = &[
    "obs virtual camera",
    "obs-camera",
    "obs camera extension",
    "manycam",
    "xsplit vcam",
    "splitcam",
    "e2esoft",
    "camtwist",
    "snap camera",
    "vmix video",
    "unity video capture",
    "altercam",
    "webcamoid",
    "webcammax",
    "fake webcam",
    "streamlabs",
    "ndi video",
    "ndi webcam",
    "newtek ndi",
    "elgato virtual camera",
    "virtual camera",
    "virtualcam",
    "virtual webcam",
];

/// Whether the camera is a known virtual device (ANT-05).
pub fn is_virtual_camera(device: &CameraDevice) -> bool {
    let name = device.name.to_lowercase();
    let model = device.model.as_deref().unwrap_or("").to_lowercase();
    VIRTUAL_CAMERAS
        .iter()
        .any(|v| name.contains(v) || model.contains(v))
}

/// The flag for a virtual camera: its name, cut to what the contract allows and to
/// plain characters, so the reviewer sees which program it was.
pub fn virtual_camera_flag(device: &CameraDevice) -> String {
    let name: String = device
        .name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'))
        .take(CAMERA_NAME_MAX)
        .collect();
    let name = name.trim();
    if name.is_empty() {
        VIRTUAL_CAMERA_FLAG.to_owned()
    } else {
        format!("{VIRTUAL_CAMERA_FLAG}:{name}")
    }
}

/// ANT-07: the flags for where the agent runs, in a fixed order.
pub fn environment_flags(env: RunEnvironment) -> Vec<String> {
    let mut flags = Vec::new();
    if env.virtual_machine {
        flags.push(VIRTUAL_MACHINE_FLAG.to_owned());
    }
    if env.remote_session {
        flags.push(REMOTE_SESSION_FLAG.to_owned());
    }
    flags
}

/// ANT-07: hardware names a hypervisor gives its guests (BIOS manufacturer and product
/// on Windows, `hw.model` on macOS), matched case-insensitively.
const VM_HARDWARE: &[&str] = &[
    "vmware",
    "virtualbox",
    "innotek",
    "qemu",
    "kvm",
    "parallels",
    "xen",
    "bochs",
    "bhyve",
    "virtualmac",
    "amazon ec2",
    "google compute engine",
];

/// Whether a machine's manufacturer and model are a hypervisor's (ANT-07). Hyper-V
/// and Azure guests say "Microsoft Corporation" / "Virtual Machine": a Surface says
/// "Microsoft Corporation" too, so for Microsoft only the model counts.
pub fn is_vm_hardware(manufacturer: &str, model: &str) -> bool {
    let (manufacturer, model) = (manufacturer.to_lowercase(), model.to_lowercase());
    if manufacturer.contains("microsoft") && model.trim() == "virtual machine" {
        return true;
    }
    VM_HARDWARE
        .iter()
        .any(|v| manufacturer.contains(v) || model.contains(v))
}

/// ANT-07: whether a CPUID hypervisor vendor (leaf 0x4000_0000) is one only guests
/// see. "Microsoft Hv" is left out: Windows with virtualization-based security (on
/// by default on many Windows 11 PCs) runs the host itself on Hyper-V and reports it.
pub fn is_guest_hypervisor(vendor: &str) -> bool {
    const GUESTS: &[&str] = &[
        "VMwareVMware",
        "VBoxVBoxVBox",
        "KVMKVMKVM",
        "prl hyperv",
        " lrpepyh  vr",
        "XenVMMXenVMM",
        "TCGTCGTCGTCG",
        "bhyve bhyve",
        "ACRNACRNACRN",
        "QNXQVMBSQG",
    ];
    let vendor = vendor.trim_matches('\0');
    GUESTS.iter().any(|g| vendor.trim() == g.trim())
}

/// ANT-03 (macOS): whether a mouse event looks posted by a program rather than a
/// device. `source_pid` is the event's `kCGEventSourceUnixProcessID`: 0 for the
/// hardware, the poster's pid for an event made with `CGEventPost` (auto-clickers,
/// AppleScript, `cliclick`). `state_id` is its `kCGEventSourceStateID`; only the
/// private state (-1), which no device uses, counts on its own: the hardware's is
/// the HID state (1), and a program may borrow that, so it proves nothing either way.
/// Best effort: remote-control and assistive tools (Screen Sharing, Voice Control)
/// post events too, which is why this only flags and never blocks.
pub fn is_synthetic_event(source_pid: i64, state_id: i64, own_pid: i64) -> bool {
    const PRIVATE_STATE: i64 = -1;
    (source_pid != 0 && source_pid != own_pid) || state_id == PRIVATE_STATE
}

#[cfg(test)]
mod tests {
    use super::*;

    fn camera(name: &str, model: Option<&str>) -> CameraDevice {
        CameraDevice {
            name: name.into(),
            model: model.map(Into::into),
        }
    }

    #[test]
    fn known_virtual_cameras_are_recognised_by_name_or_model() {
        for name in [
            "OBS Virtual Camera",
            "OBS-Camera",
            "ManyCam Virtual Webcam",
            "XSplit VCam",
            "Snap Camera",
            "e2eSoft iVCam",
            "CamTwist",
            "Unity Video Capture",
        ] {
            assert!(is_virtual_camera(&camera(name, None)), "{name}");
        }
        assert!(is_virtual_camera(&camera(
            "Camera",
            Some("OBS Camera Extension")
        )));
    }

    #[test]
    fn real_and_relaying_cameras_are_not_virtual() {
        for name in [
            "FaceTime HD Camera",
            "Integrated Webcam",
            "Logitech BRIO",
            "HD Pro Webcam C920",
            "Integrated Camera",
            "NVIDIA Broadcast",
            "Continuity Camera",
            "",
        ] {
            assert!(!is_virtual_camera(&camera(name, None)), "{name}");
        }
    }

    #[test]
    fn the_camera_flag_carries_a_clean_short_name() {
        assert_eq!(
            virtual_camera_flag(&camera("OBS Virtual Camera", None)),
            "virtual_camera:OBS Virtual Camera"
        );
        let flag = virtual_camera_flag(&camera(
            "ManyCam Virtual Webcam (Pro) — very long name™",
            None,
        ));
        assert_eq!(flag, "virtual_camera:ManyCam Virtual Webcam P");
        assert!(flag.len() <= 40, "{}", flag.len());
        assert_eq!(virtual_camera_flag(&camera("™", None)), "virtual_camera");
    }

    #[test]
    fn environment_flags_follow_the_signals() {
        assert!(environment_flags(RunEnvironment::default()).is_empty());
        assert_eq!(
            environment_flags(RunEnvironment {
                virtual_machine: true,
                remote_session: true
            }),
            ["virtual_machine", "remote_session"]
        );
        assert_eq!(
            environment_flags(RunEnvironment {
                virtual_machine: false,
                remote_session: true
            }),
            ["remote_session"]
        );
    }

    #[test]
    fn hypervisor_hardware_names_are_recognised() {
        for (maker, model) in [
            ("VMware, Inc.", "VMware Virtual Platform"),
            ("innotek GmbH", "VirtualBox"),
            ("QEMU", "Standard PC (Q35 + ICH9, 2009)"),
            (
                "Parallels Software International Inc.",
                "Parallels Virtual Platform",
            ),
            ("Microsoft Corporation", "Virtual Machine"),
            ("Xen", "HVM domU"),
            ("Amazon EC2", "t3.large"),
            ("", "VirtualMac2,1"),
            ("", "VMware7,1"),
        ] {
            assert!(is_vm_hardware(maker, model), "{maker} / {model}");
        }
    }

    #[test]
    fn real_hardware_is_not_a_vm() {
        for (maker, model) in [
            ("Microsoft Corporation", "Surface Laptop 5"),
            ("Dell Inc.", "XPS 13 9310"),
            ("LENOVO", "20XW004GUS"),
            ("", "Mac14,6"),
            ("", "MacBookPro18,3"),
            ("", ""),
        ] {
            assert!(!is_vm_hardware(maker, model), "{maker} / {model}");
        }
    }

    #[test]
    fn only_guest_hypervisor_vendors_count() {
        assert!(is_guest_hypervisor("VMwareVMware"));
        assert!(is_guest_hypervisor("KVMKVMKVM\0\0\0"));
        assert!(is_guest_hypervisor("VBoxVBoxVBox"));
        assert!(!is_guest_hypervisor("Microsoft Hv"), "a VBS host says this");
        assert!(!is_guest_hypervisor(""));
        assert!(!is_guest_hypervisor("GenuineIntel"));
    }

    #[test]
    fn hardware_events_are_not_synthetic() {
        assert!(!is_synthetic_event(0, 1, 4242));
        assert!(
            !is_synthetic_event(0, 0, 4242),
            "the state alone proves nothing"
        );
        // Posted by another program, even with the HID state borrowed.
        assert!(is_synthetic_event(911, 1, 4242));
        assert!(is_synthetic_event(911, 0, 4242));
        // A private event source is never a device.
        assert!(is_synthetic_event(0, -1, 4242));
        // Our own process never counts as the poster.
        assert!(!is_synthetic_event(4242, 1, 4242));
    }
}
