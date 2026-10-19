# Spike #14: presence signals (macOS section)

Status: **macOS done.** Windows section waits for a Windows machine (M6). Zoom, FaceTime and Microsoft Teams were not run; Google Meet in Brave covered the call, camera, mic and screen-share cases, and FaceTime/Zoom use the same camera and mic devices.

## 1. Question

Which macOS APIs reliably tell the agent that the camera or mic is in use (CHK-03 deferral), that the screen is being shared or a presentation is running (CHK-03/04), that the screen is locked or the Mac asleep, and how long the user has been idle (STS-01)? What are the false positives and negatives?

## 2. Environment

macOS 26.7.1 · Apple M2 Max · 1 display · built-in camera and mic · Brave (Google Meet), Keynote, TextEdit. Bundled spike `.app` with Screen Recording granted (needed for window titles).

## 3. Approaches and results

The spike polls once a second and logs changes; notification observers log events.

| Signal | API | Result |
|---|---|---|
| Camera in use | CoreMediaIO `kCMIODevicePropertyDeviceIsRunningSomewhere` on every device | ✅ on when Meet video started, off when video stopped; on when Photo Booth opened |
| Camera in use (comparison) | AVFoundation `isInUseByAnotherApplication` | ❌ stayed **false** throughout (Meet, Photo Booth): not usable |
| Mic in use | CoreAudio `kAudioDevicePropertyDeviceIsRunningSomewhere`, default input | ✅ on when joining Meet (also with video off), off when leaving |
| Screen sharing | on-screen window titles containing "is sharing", "sharing your screen", … | ✅ Meet: "meet.google.com is sharing your screen." window owned by Brave for exactly the 14 s presented. Needs Screen Recording (window names) |
| Presentation (slideshow) | frontmost app owns a window **above layer 0 covering a whole display** | ✅ Keynote: `presenting` true 4 s after Keynote came forward (slideshow start), false on Esc. Measured windows: layer 9, then 26, at full display bounds; the system menu bar window disappears |
| Full-screen app (not a presentation) | frontmost app owns a thin window above layer 0 spanning the display's top edge | ✅ TextEdit full screen: `fullscreen` true for exactly the 15 s, `presenting` stayed false |
| Lock / unlock | distributed `com.apple.screenIsLocked` / `screenIsUnlocked` | ✅ instant; poll fallback `CGSessionCopyCurrentDictionary()["CGSSessionScreenIsLocked"]` agreed within 1 s; frontmost app becomes `loginwindow` while locked |
| Sleep / wake | `NSWorkspaceWillSleep` / `DidWake`, `ScreensDidSleep` / `ScreensDidWake` | ✅ all fired; sleeping also locked, waking unlocked |
| Idle seconds | `CGEventSourceSecondsSinceLastEventType(combinedSessionState, kCGAnyInputEventType)` | ✅ crossed 30 s / 60 s while untouched, reset on input |

First attempt at full-screen detection ("a layer-0 window equal to the display bounds") was wrong: it never fired for TextEdit or Keynote. The rules above come from dumping `CGWindowListCopyWindowInfo` during each mode.

## 4. Chosen approach

- **In a call (CHK-03)**: CoreMediaIO camera running somewhere **or** CoreAudio default input running somewhere.
- **Screen sharing (CHK-03)**: sharing-indicator window titles (needs Screen Recording; Meet/Chrome/Brave text verified, Zoom/Teams strings unverified).
- **Presenting (CHK-03)**: frontmost app owns a window with layer > 0 whose bounds equal a display's bounds. Full-screen apps (thin layer > 0 strip at the top) are **not** presenting, and the card works above them (spike #11).
- **Locked / asleep (CHK-04)**: distributed lock notifications + NSWorkspace sleep/wake, with the session-dictionary poll as fallback.
- **Idle (STS-01)**: `CGEventSourceSecondsSinceLastEventType`, polled.

```rust
fn is_presenting(windows: &[WindowInfo], pid: i32) -> bool {
    let displays = display_bounds();
    windows.iter()
        .filter(|w| w.owner_pid == pid && w.layer > 0)
        .any(|w| displays.iter().any(|d| *d == w.bounds))
}
```

## 5. Known limitations

- Screen-share detection depends on each app's wording; Zoom and Teams sharing bars are unverified (Teams not installed), and it needs Screen Recording (without it, titles are empty).
- Only the default input device is checked for the mic.
- Presentation rule verified with Keynote only; PowerPoint and full-screen video players should be checked before the pilot.
- A full-screen video in a browser may look like a presentation (window above layer 0 covering the display): a likely false positive that defers check-ins, which is the safe direction.

## 6. Impact on the PRD or issues

- #25/#19/#20: `Platform::call_state` = CoreMediaIO camera + CoreAudio mic; `Platform::screen_shared` = sharing windows **or** presenting (as above).
- No PRD change needed. Add PowerPoint and Zoom/Teams sharing to the M6 device-test list.
