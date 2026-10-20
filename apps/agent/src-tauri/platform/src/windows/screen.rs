//! One screenshot per monitor through DXGI Desktop Duplication (CAP-01, CAP-03,
//! CAP-06). Per monitor: a Direct3D device on its adapter, one duplicated frame
//! copied to a CPU-readable texture, then scaled (box filter), swizzled to RGBA and
//! turned upright by `agent_core::pixels`. SDR desktops arrive as BGRA8; HDR ones as
//! half-float scRGB (`DXGI_FORMAT_R16G16B16A16_FLOAT`), tone mapped to sRGB by
//! `agent_core::pixels::hdr_surface_to_upright_rgba` (#174). Everything is released before the next
//! monitor. Monitors are ordered left to right, top to bottom, so `screen-N` always
//! names the same monitor (`agent_core::displays`).
//!
//! Desktop Duplication is refused on the secure desktop (lock screen, UAC) and for
//! sessions with no GPU output (some RDP sessions); those come back as `Failed`.
//! Windows has no screen-capture permission, so `PermissionMissing` never occurs.

use std::time::{Duration, Instant};

use agent_core::displays::{display_order, upright_quarter_turns, Rect};
use agent_core::pixels::{hdr_surface_to_upright_rgba, surface_to_upright_rgba};
use agent_core::platform::{CaptureError, Frame};
use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_CPU_ACCESS_READ,
    D3D11_CREATE_DEVICE_FLAG, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R16G16B16A16_FLOAT,
};
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput1, IDXGIOutputDuplication,
    IDXGIResource, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
};

/// How long to wait for the first frame of a duplication. Creating one marks the
/// whole screen as updated, so it normally arrives at once.
const FRAME_WAIT: Duration = Duration::from_secs(1);
const FRAME_POLL_MS: u32 = 250;

fn failed(what: &str, error: windows::core::Error) -> CaptureError {
    CaptureError::Failed(format!("{what}: {error}"))
}

/// A monitor that is part of the desktop, with the adapter that drives it.
struct Monitor {
    rect: Rect,
    adapter: IDXGIAdapter1,
    output: IDXGIOutput1,
}

/// Every output attached to the desktop, on every adapter.
fn monitors() -> Result<Vec<Monitor>, CaptureError> {
    let factory: IDXGIFactory1 =
        unsafe { CreateDXGIFactory1() }.map_err(|e| failed("dxgi factory", e))?;
    let mut found = Vec::new();
    for a in 0.. {
        let Ok(adapter) = (unsafe { factory.EnumAdapters1(a) }) else {
            break;
        };
        for o in 0.. {
            let Ok(output) = (unsafe { adapter.EnumOutputs(o) }) else {
                break;
            };
            let Ok(desc) = (unsafe { output.GetDesc() }) else {
                continue;
            };
            if !desc.AttachedToDesktop.as_bool() {
                continue;
            }
            let Ok(output) = output.cast::<IDXGIOutput1>() else {
                continue;
            };
            let r = desc.DesktopCoordinates;
            found.push(Monitor {
                rect: Rect::new(r.left, r.top, r.right, r.bottom),
                adapter: adapter.clone(),
                output,
            });
        }
    }
    Ok(found)
}

/// A frame held by the duplication, handed back on drop.
struct Acquired<'a>(&'a IDXGIOutputDuplication);

impl Drop for Acquired<'_> {
    fn drop(&mut self) {
        let _ = unsafe { self.0.ReleaseFrame() };
    }
}

fn create_device(
    adapter: &IDXGIAdapter1,
) -> Result<(ID3D11Device, ID3D11DeviceContext), CaptureError> {
    let mut device = None;
    let mut context = None;
    unsafe {
        D3D11CreateDevice(
            adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_FLAG(0),
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
    }
    .map_err(|e| failed("d3d11 device", e))?;
    match (device, context) {
        (Some(device), Some(context)) => Ok((device, context)),
        _ => Err(CaptureError::Failed("d3d11 device: none created".into())),
    }
}

/// Waits for a frame that carries a desktop image (a frame with only a pointer
/// update has `LastPresentTime` 0).
fn acquire<'a>(
    duplication: &'a IDXGIOutputDuplication,
) -> Result<(Acquired<'a>, IDXGIResource), CaptureError> {
    let deadline = Instant::now() + FRAME_WAIT;
    loop {
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource = None;
        match unsafe { duplication.AcquireNextFrame(FRAME_POLL_MS, &mut info, &mut resource) } {
            Ok(()) => {
                let frame = Acquired(duplication);
                match resource {
                    Some(resource) if info.LastPresentTime != 0 => return Ok((frame, resource)),
                    _ => drop(frame),
                }
            }
            Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {}
            Err(e) => return Err(failed("acquire frame", e)),
        }
        if Instant::now() >= deadline {
            return Err(CaptureError::Failed("no desktop frame".into()));
        }
    }
}

/// One monitor as RGBA at most `max_width` wide and upright.
fn grab(monitor: &Monitor, max_width: u32) -> Result<(u32, u32, Vec<u8>), CaptureError> {
    let (device, context) = create_device(&monitor.adapter)?;
    let duplication = unsafe { monitor.output.DuplicateOutput(&device) }
        .map_err(|e| failed("duplicate output", e))?;
    let turns = upright_quarter_turns(unsafe { duplication.GetDesc() }.Rotation.0);
    let (_frame, resource) = acquire(&duplication)?;
    let texture: ID3D11Texture2D = resource.cast().map_err(|e| failed("frame texture", e))?;

    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { texture.GetDesc(&mut desc) };
    let hdr = match desc.Format {
        DXGI_FORMAT_B8G8R8A8_UNORM => false,
        DXGI_FORMAT_R16G16B16A16_FLOAT => true,
        format => {
            return Err(CaptureError::Failed(format!(
                "unsupported surface format {}",
                format.0
            )))
        }
    };
    desc.Usage = D3D11_USAGE_STAGING;
    desc.BindFlags = 0;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
    desc.MiscFlags = 0;
    let mut staging = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut staging)) }
        .map_err(|e| failed("staging texture", e))?;
    let staging =
        staging.ok_or_else(|| CaptureError::Failed("staging texture: none created".into()))?;
    unsafe { context.CopyResource(&staging, &texture) };

    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe { context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }
        .map_err(|e| failed("map frame", e))?;
    let (width, height, stride) = (
        desc.Width as usize,
        desc.Height as usize,
        mapped.RowPitch as usize,
    );
    let bytes = unsafe { std::slice::from_raw_parts(mapped.pData as *const u8, stride * height) };
    let rgba = if hdr {
        hdr_surface_to_upright_rgba(bytes, width, height, stride, turns, max_width)
    } else {
        surface_to_upright_rgba(bytes, width, height, stride, turns, max_width)
    };
    unsafe { context.Unmap(&staging, 0) };
    rgba.ok_or_else(|| CaptureError::Failed("screenshot pixel buffer too short".into()))
}

/// One frame per monitor, `display` set to the monitor's 1-based place in display
/// order. A monitor that fails is skipped (the check-in still passes, CAP-08); the
/// capture fails only if none worked.
pub fn capture(max_width: u32) -> Result<Vec<Frame>, CaptureError> {
    let monitors = monitors()?;
    let order = display_order(monitors.iter().map(|m| m.rect).collect());
    if order.is_empty() {
        return Err(CaptureError::Failed("no displays".into()));
    }
    let mut frames = Vec::new();
    let mut first_error = None;
    for (index, rect) in order.iter().enumerate() {
        // A mirrored display is listed on more than one output; the first will do.
        let Some(monitor) = monitors.iter().find(|m| m.rect == *rect) else {
            continue;
        };
        let number = index as u32 + 1;
        match grab(monitor, max_width) {
            Ok((width, height, rgba)) => frames.push(Frame {
                display: Some(number),
                width,
                height,
                rgba,
            }),
            Err(e) => {
                tracing::warn!(display = number, error = %e, "screenshot failed");
                first_error.get_or_insert(e);
            }
        }
    }
    match (frames.is_empty(), first_error) {
        (true, Some(e)) => Err(e),
        (true, None) => Err(CaptureError::Failed("no displays captured".into())),
        (false, _) => Ok(frames),
    }
}
