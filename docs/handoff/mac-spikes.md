# Spike guide: macOS (#11, #13, #14)

Detailed guide for the week-1 macOS spikes. The overall session handoff is `docs/handoff/mac-session.md`; its confirm-first step covers these spikes too.

## Scope

| Issue | What to prove on macOS | Output |
|---|---|---|
| #11 | Check-in card: always on top (including above full-screen apps and other Spaces), never takes keyboard focus, accepts mouse clicks, random monitor + position | `docs/spikes/checkin-card-macos.md` |
| #13 (macOS half) | Screenshot per monitor (ScreenCaptureKit), one webcam frame (AVFoundation), detect missing permissions without prompting, downscale + WebP sizes and timings | `docs/spikes/capture.md` (macOS section) |
| #14 (macOS half) | Camera in use, mic in use, screen sharing / full-screen presentation, lock/unlock, sleep/wake, idle seconds | `docs/spikes/presence-signals.md` (macOS section) |

Out of scope: #12 and the Windows halves of #13/#14, and production code. Spike code is throwaway and lives in `spikes/macos/`, separate from `apps/` and `packages/`.

## Setup

The session-level environment setup in `docs/handoff/mac-session.md` covers the tools. Record the macOS version, chip and number of displays in each spike write-up.

## How to run the spikes

- Put all spike code in `spikes/macos/` as one minimal Tauri v2 app (Rust + a plain HTML page; no React needed). Keep it out of the pnpm workspace and any Cargo workspace.
- **Permission attribution matters.** A binary launched from your shell inherits Claude's macOS permissions, so prompts appear for Claude, not the app. For every permission result, also test a bundled build (`cargo tauri build --debug`, then `open` the `.app`) and report both. Only the bundled result counts.
- **When you need Raj to do something physical**, stop and give numbered steps (e.g. "1. Open Keynote and start a full-screen slideshow. 2. Wait for the card. 3. Type `hello` while it is visible. 4. Click button 7. Tell me what happened."). Wait for the answer. Use `screencapture -x /tmp/shot.png` and read the image to verify what you can yourself.
- Timebox: about 2 days of effort per spike. If an approach fails, write down why and try the next one; don't polish.

### #11 check-in card
- Approach 1: `tauri-nspanel` (v2 branch) to turn the window into a non-activating `NSPanel` (`NSWindowStyleMaskNonactivatingPanel`), level above `NSScreenSaverWindowLevel` or `kCGMainMenuWindowLevel + 1`, collection behaviour `canJoinAllSpaces | fullScreenAuxiliary | stationary`.
- Approach 2 (if 1 fails): raw objc2 on the Tauri window handle with the same settings.
- Test matrix: normal desktop, full-screen app in its own Space, Keynote/PowerPoint slideshow, external monitor, Stage Manager on/off. For each: does it appear, does the frontmost app keep keyboard focus (type while visible), does a click register, does Enter/Space do nothing.
- Measure time from "show" call to visible (target ≤ 500 ms, NFR-PERF-02).

### #13 capture (macOS)
- Screenshot: `SCScreenshotManager` (macOS 14+) per display; note the fallback for macOS 12.3–13 (`SCStream` single frame).
- Webcam: `AVCaptureSession` single frame at 320×240.
- Permission checks without prompting: `CGPreflightScreenCaptureAccess()`, `AVCaptureDevice.authorizationStatus(for: .video)`. Confirm neither triggers a prompt.
- Encode: downscale to 1280 px wide, WebP quality ~60 (try the `image` + `webp` crates). Record size per screenshot and webcam frame against the 150 KB / 20 KB targets, and the time from click to both files ready.
- Revoke permission while the app runs and record what each API returns.

### #14 presence signals (macOS)
- Camera in use: CoreMediaIO `kCMIODevicePropertyDeviceIsRunningSomewhere`. Mic in use: CoreAudio `kAudioDevicePropertyDeviceIsRunningSomewhere`. Test with Zoom, Google Meet in Chrome, FaceTime, and Photo Booth.
- Screen sharing / presenting: find what works (e.g. `CGWindowListCopyWindowInfo` for sharing indicators, full-screen window detection). This is the hardest one; document false positives and negatives honestly.
- Lock/unlock: `com.apple.screenIsLocked` / `com.apple.screenIsUnlocked` distributed notifications, plus `CGSessionCopyCurrentDictionary` as a poll fallback. Sleep/wake: `NSWorkspaceWillSleepNotification` / `DidWake`.
- Idle seconds: `CGEventSourceSecondsSinceLastEventType`.

## Write-up format (each `docs/spikes/*.md`)

1. Question · 2. Environment (macOS version, chip, displays) · 3. Approaches tried, with results per test case · 4. **Chosen approach** with the key code snippet · 5. Known limitations · 6. Impact on the PRD or issues (anything that can't be met as written goes to "Blocked on Raj" in `docs/progress.md`).

## Git and PRs

- One branch and PR per spike: `11-spike-checkin-card-macos`, `13-spike-capture-macos`, `14-spike-presence-macos`, each based on the default branch (independent of the feature stacks).
- PR body: `Closes #11` for the card spike. For #13 and #14 use `Refs #13` / `Refs #14`, since the Windows halves are still open.
- Commit the write-up and the spike code. Don't commit build output (`spikes/macos/target`, `.app` bundles).
- Raj reviews and merges unless `docs/progress.md` says otherwise.

## Done when

All three write-ups are merged or in open PRs, each with a chosen approach (or a clear "not possible, here is why"), and `docs/progress.md` shows #11 done and the macOS halves of #13/#14 done.
