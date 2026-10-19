# Spike #14: presence signals (macOS section)

Status: **macOS in progress.** Signals are implemented and report sane baseline values; every case below needs Raj to do something (start a call, share a screen, lock, sleep). Windows section waits for a Windows machine (M6).

## 1. Question

Which macOS APIs reliably tell the agent that the camera or mic is in use (CHK-03 deferral), that the screen is being shared or a presentation is full screen (CHK-04), that the screen is locked or the Mac asleep, and how long the user has been idle (STS-01)? What are the false positives and negatives?

## 2. Environment

macOS 26.7.1 · Apple M2 Max · 1 display · built-in camera and mic. Test apps installed: Zoom, Google Chrome (Meet), FaceTime, Photo Booth, Keynote, Slack. Microsoft Teams not installed.

## 3. Approaches

The spike polls every second and logs only changes (`SIGNAL …` lines), plus notification events (`EVENT …` lines):

| Signal | API | Notes |
|---|---|---|
| Camera in use | CoreMediaIO `kCMIODevicePropertyDeviceIsRunningSomewhere` on every device from `kCMIOHardwarePropertyDevices` | Logged as `camera(cmio)` |
| Camera in use (comparison) | AVFoundation `AVCaptureDevice.default(for: .video).isInUseByAnotherApplication` | Logged as `camera(avf)` |
| Mic in use | CoreAudio `kAudioDevicePropertyDeviceIsRunningSomewhere` on the default input device | Other input devices not checked yet |
| Screen sharing | `CGWindowListCopyWindowInfo` on-screen windows whose title contains "is sharing", "sharing your screen", "share toolbar", "screen share", "screen sharing", "presenting", "sharing control" | Window titles need Screen Recording permission |
| Full-screen presentation | Frontmost app owns a layer-0 window whose bounds equal a display's bounds (`CGDisplayBounds`) | Covers full-screen apps, slideshows, full-screen video |
| Lock / unlock | Distributed notifications `com.apple.screenIsLocked` / `screenIsUnlocked`; poll fallback `CGSessionCopyCurrentDictionary()["CGSSessionScreenIsLocked"]` | Both logged for comparison |
| Screen saver | `com.apple.screensaver.didstart` / `didstop` | |
| Sleep / wake | `NSWorkspaceWillSleepNotification` / `DidWake`, `ScreensDidSleep` / `ScreensDidWake` | |
| Fast user switching | `NSWorkspaceSessionDidResignActive` / `DidBecomeActive` | |
| Idle seconds | `CGEventSourceSecondsSinceLastEventType(combinedSessionState, kCGAnyInputEventType)` | Logged at 30 / 60 / 300 / 600 s crossings |

## 4. Results

Baseline (nothing running): camera false (both APIs), mic false, not locked, frontmost Brave Browser not full screen, no sharing windows. All observers registered.

| Case | camera(cmio) | camera(avf) | mic | sharing / full screen | Result |
|---|---|---|---|---|---|
| Zoom call, video on | | | | | ⏳ |
| Zoom call, video off, mic on | | | | | ⏳ |
| Zoom screen share | | | | | ⏳ |
| Google Meet in Chrome, video on | | | | | ⏳ |
| Meet "present a tab / window / screen" | | | | | ⏳ |
| FaceTime call | | | | | ⏳ |
| Photo Booth open (camera, no call) | | | | | ⏳ (expected false positive for "in a call") |
| Keynote slideshow | | | | | ⏳ |
| Full-screen app (not presenting) | | | | | ⏳ (expected false positive for "presenting") |
| Lock (Ctrl-Cmd-Q) / unlock | | | | | ⏳ |
| Sleep (Apple menu → Sleep) / wake | | | | | ⏳ |
| Idle 60 s without touching anything | | | | | ⏳ |

## 5. Chosen approach

Pending results.

## 6. Known limitations

- Window-title heuristics depend on each app's wording and break when apps rename their sharing bars; they also need Screen Recording.
- Only the default input device is checked for the mic.
- Teams is not installed, so its sharing bar is untested.

## 7. Impact on the PRD or issues

To be filled in after the manual run.
