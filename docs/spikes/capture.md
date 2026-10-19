# Spike #13: screenshot + webcam capture (macOS section)

Status: **macOS in progress.** Screenshot path measured; webcam, permission prompts and revocation are pending Raj's run on the bundled app. Windows section waits for a Windows machine (M6).

## 1. Question

On macOS: can we take one screenshot per display (ScreenCaptureKit) and one webcam frame (AVFoundation), detect missing Screen Recording / Camera permission without triggering a prompt, downscale to ≤ 1280 px wide and encode WebP ~q60 within the 150 KB / 20 KB targets (CAP-06), and how long from the passing click to all files ready (CAP-01, CAP-03, CAP-08, AGT-07)?

## 2. Environment

macOS 26.7.1 · Apple M2 Max · 1 display (built-in, 1728 × 1117 pt, 3456 × 2234 px) · built-in FaceTime HD camera · Rust 1.99.1, objc2 0.6 / objc2-* 0.3, `webp` 0.3 (libwebp), `fast_image_resize` 6. Dependencies optimized (`opt-level = 3`) in the dev build used for timings.

## 3. Approaches and results

### Permission checks (no prompt)

`CGPreflightScreenCaptureAccess()` and `AVCaptureDevice.authorizationStatus(for: .video)`.

| Case | Result |
|---|---|
| Shell binary (inherits the launching terminal's grants) | screen = true, camera = not determined |
| Bundled `.app`, never granted | screen = false, camera = not determined; both captures skipped with reason `permission_missing` (CAP-08), capture "done" in 1 ms |
| Check duration | 8 ms bundled, 51–63 ms from the shell on first call (framework load) |
| No prompt appears on either check | ⏳ Raj to confirm (session can't see the screen yet) |
| Revoke while running: what each API returns | ⏳ Raj |

Note: `SCShareableContent` itself triggers the Screen Recording prompt when access is missing, so the agent must call it **only after** the preflight returns true.

### Screenshot (ScreenCaptureKit, `SCScreenshotManager`, macOS 14+)

Two ways to get to 1280 px:

| Mode | Capture | Resize | WebP q60 | Size | Click → done |
|---|---|---|---|---|---|
| **A. SCK scales on the GPU** (`SCStreamConfiguration` width 1280) | 1280 × 827 in 330–415 ms | none | 69–80 ms | 34–42 KB | 704–781 ms |
| B. Native 3456 × 2234, CPU resize (`fast_image_resize`, bilinear) | 1103–1192 ms | 984–1239 ms* | 54–104 ms | 36–40 KB | 2530–2654 ms |

\* Includes the spike's unoptimized BGRA→RGB copy of 7.7 M pixels; a release build will be faster, but B also copies 9× more pixels across from the GPU.

All screenshots are far under the 150 KB target (screen content was a browser page). `SCShareableContent` enumeration took 159–219 ms of the totals and can be cached between check-ins.

### Webcam (AVFoundation)

`AVCaptureSession` preset 320 × 240, `AVCaptureVideoDataOutput` in BGRA with a Rust delegate class (`define_class!`). Frames are taken from the first one whose mean luma is within 2 levels of the previous frame (auto-exposure settled), from frame 3 on, max frame 30; the session stops immediately after. Logged per frame: index, time since open, mean luma.

| Case | Result |
|---|---|
| Frame size and WebP q60 bytes vs 20 KB | ⏳ Raj (needs camera grant on the bundle) |
| Camera-on duration (light on) vs < 1 s goal | ⏳ |
| Frames until exposure settles, dark room vs lit | ⏳ |
| Camera busy in Zoom/FaceTime (`isInUseByAnotherApplication`, open error) | ⏳ |

## 4. Chosen approach

Screenshots: **mode A** (ScreenCaptureKit scales on the GPU to ≤ 1280 px wide; one `SCScreenshotManager` call per display, run in parallel with the webcam). Webcam: pending results.

```rust
let config = SCStreamConfiguration::new();
config.setWidth(1280);
config.setHeight(points_h * 1280 / points_w);
config.setShowsCursor(false);
let filter = SCContentFilter::initWithDisplay_excludingWindows(SCContentFilter::alloc(), &display, &NSArray::new());
SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(&filter, &config, Some(&handler));
// handler: CGImage (BGRA) -> RGB -> webp::Encoder::from_rgb(..).encode(60.0)
```

## 5. Known limitations

- One display only; CAP-03 (one image per display) is coded but untested with two.
- `SCScreenshotManager` needs macOS 14. The PRD minimum is macOS 13, which needs a single-frame `SCStream` fallback; not built or tested here.
- Debug builds are ad-hoc signed; rebuilding can reset the app's permission grants, so permission tests use one final build.

## 6. Impact on the PRD or issues

None so far: sizes are well under target. To be completed after the webcam results.

## How to run

See `docs/spikes/checkin-card-macos.md`. Extra switches: `SPIKE_CAPTURE=1` captures once at launch; `SPIKE_SCREEN_MODE=native` uses mode B. Files land in `~/Library/Logs/AIProctorSpike/captures/<timestamp>/` (local only, never committed).
