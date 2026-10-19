# Spike #13: screenshot + webcam capture (macOS section)

Status: **macOS done.** Windows section waits for a Windows machine (M6).

## 1. Question

On macOS: can we take one screenshot per display (ScreenCaptureKit) and one webcam frame (AVFoundation), detect missing Screen Recording / Camera permission without triggering a prompt, downscale to ≤ 1280 px wide and encode WebP ~q60 within the 150 KB / 20 KB targets (CAP-06), and how long from the passing click to all files ready (CAP-01, CAP-03, CAP-08, AGT-07)?

## 2. Environment

macOS 26.7.1 · Apple M2 Max · 1 display (1728 × 1117 pt, 3456 × 2234 px) · built-in FaceTime HD camera · Rust 1.99.1, objc2 0.6 / objc2-* 0.3, `webp` 0.3 (libwebp), `fast_image_resize` 6. Dependencies optimized in the dev build used for timings. Results from the **bundled `.app`**.

## 3. Results

### Permissions (no prompt)

`CGPreflightScreenCaptureAccess()` and `AVCaptureDevice.authorizationStatus(for: .video)`.

| Case | Result |
|---|---|
| Launch with nothing granted | screen = false, camera = not determined, checked in 3–13 ms; **no prompt** (confirmed on screen); both captures skip with `permission_missing` (CAP-08) |
| `CGRequestScreenCaptureAccess` + `requestAccess(for: .video)` (onboarding) | camera: system prompt, granted; screen: returns false and macOS sends the user to System Settings |
| Revoke Screen Recording, choose **Quit & Reopen** | restarted app reads screen = false: Tamper can be raised at once |
| Revoke Screen Recording, choose **Later** (app keeps running) | ⚠️ `CGPreflightScreenCaptureAccess` **still returns true**, but `SCShareableContent` fails with "The user declined TCCs for application, window, display capture". The agent must treat that error as `permission_missing` / Tamper, not trust the cached preflight |
| Debug rebuild | ad-hoc signature changes, macOS forgets both grants (expected; signed release builds keep them) |

`SCShareableContent` itself triggers the Screen Recording prompt when access is missing, so the agent calls it only after the preflight returns true.

### Screenshot (ScreenCaptureKit, `SCScreenshotManager`, macOS 14+)

| Mode | Capture | Resize | WebP q60 | Size | Click → done |
|---|---|---|---|---|---|
| **A. SCK scales on the GPU** (config width 1280) | 1280 × 827 in 247–415 ms | none | 66–80 ms | 32–53 KB | 0.7–0.8 s |
| B. Native 3456 × 2234 + CPU resize | 1.1–1.2 s | ~1 s | 54–104 ms | 36–40 KB | ~2.5 s |

All far under 150 KB. `SCShareableContent` enumeration took 147–219 ms and can be cached between check-ins.

### Webcam (AVFoundation)

`AVCaptureSession` + `AVCaptureVideoDataOutput` (BGRA) with a Rust delegate class. First run used the 320 × 240 **session preset**, which the built-in camera **ignored** (frames came at 1920 × 1080). Setting `kCVPixelBufferWidthKey`/`HeightKey` = 320 × 240 in `videoSettings` fixed it.

| Run | Frame | Camera on (light) | Size |
|---|---|---|---|
| 1080p frames (preset ignored) | frame 7 after exposure settled | 4.4 s (matches what Raj saw: 4–5 s) | 17.4 KB |
| **320 × 240 via videoSettings** (chosen) | frame 6 at 1.35 s, mean luma 158 | **1.6–1.7 s** | **3.6 KB** |
| Camera already in use by Photo Booth | works (macOS shares the camera) | 2.4 s (1080p run) | 17.6 KB |

Exposure ramp at 320 × 240 (30 fps): frames 1–3 are dark (luma ~12, warm-up), frame 4 jumps to ~155. The settle rule must require real exposure (`mean luma ≥ 15` and stable within 2 levels), otherwise it accepts the identical black warm-up frames (which it did in one run).

`AVCaptureDevice.isInUseByAnotherApplication` stayed **false** while Photo Booth used the camera, so it is useless for CAP-08 "camera busy"; and since the camera is shared, "busy" doesn't block capture on macOS anyway.

## 4. Chosen approach

- Screenshots: **mode A**, one `SCScreenshotManager` call per display at ≤ 1280 px wide, run in parallel with the webcam.
- Webcam: `AVCaptureVideoDataOutput` with `videoSettings` = BGRA, 320 × 240; take the first frame with mean luma ≥ 15 that is within 2 levels of the previous one (max 90 frames), stop the session immediately.
- Permissions: preflight both before every capture; additionally map an `SCShareableContent` TCC error to `permission_missing`.

```rust
let config = SCStreamConfiguration::new();
config.setWidth(1280);
config.setHeight(points_h * 1280 / points_w);
config.setShowsCursor(false);
SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(&filter, &config, Some(&handler));

// webcam
let settings = NSDictionary::from_slices(
    &[kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferWidthKey, kCVPixelBufferHeightKey],
    &[NSNumber::new_u32(kCVPixelFormatType_32BGRA), NSNumber::new_u32(320), NSNumber::new_u32(240)],
);
output.setVideoSettings(Some(&settings));
```

## 5. Known limitations

- The camera takes ~1.2–1.4 s to deliver its first frame on this Mac, so the light is on ≥ 1.6 s; tech-stack's "webcam frame < 1 s" is not reachable here (see 6).
- One display only; CAP-03 (one image per display) is coded but untested with two (M6).
- `SCScreenshotManager` needs macOS 14; the PRD minimum (13) needs a single-frame `SCStream` fallback, not built here.
- Dark-room exposure not tested separately; the luma rule caps at 90 frames (~3 s) if exposure never settles.

## 6. Impact on the PRD or issues

- **Tech-stack week-1 spike target "webcam frame < 1 s"**: measured 1.6–1.7 s from session start to frame (camera warm-up is ~1.3 s). Proposal: target ≤ 2 s camera-on time. Listed in `docs/progress.md`.
- **CAP-08 "camera in use"**: on macOS the camera is shared, so a busy camera doesn't make capture fail; keep the reason for Windows.
- #21 (capture pipeline): use the chosen approach above; add the TCC-error → `permission_missing` mapping and feed it to Tamper (#58).

## How to run

See `docs/spikes/checkin-card-macos.md`. `SPIKE_CAPTURE=1` captures once at launch; `SPIKE_SCREEN_MODE=native` uses mode B. Files land in `~/Library/Logs/AIProctorSpike/captures/<timestamp>/` (local only, never committed).
