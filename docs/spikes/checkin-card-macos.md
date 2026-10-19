# Spike #11: check-in card on macOS

Status: **in progress.** Automated checks are done; the cases that need a person (clicks, typing, full-screen apps, Keynote, Stage Manager) are pending Raj's run. Multi-monitor cases are blocked: no second display.

## 1. Question

Can a Tauri v2 window be a check-in card that (CHK-10) shows always on top, including above full-screen apps and on other Spaces, on a random monitor at a random position; (CHK-11) accepts mouse clicks but never takes keyboard focus; and (NFR-PERF-02) appears within 500 ms of its scheduled time?

## 2. Environment

macOS 26.7.1 · Apple M2 Max (MacBook Pro) · 1 display (built-in, 3456 × 2234 Retina) · Tauri 2 (CLI 2.12.3) · tauri-nspanel 2.1 · Rust 1.99.1.

## 3. Approaches and results

### Approach 1: `tauri-nspanel` (chosen, pending the manual cases)

The card is a 360 × 200 Tauri webview window converted to an `NSPanel`:

- panel class: `can_become_key_window: false`, `can_become_main_window: false`, `is_floating_panel: true`, `hides_on_deactivate: false`
- style mask: `NSWindowStyleMaskNonactivatingPanel`
- collection behaviour: `canJoinAllSpaces | fullScreenAuxiliary | stationary | ignoresCycle`
- window level: `kCGMainMenuWindowLevel + 1` (25) by default; the spike can switch to 3, 101, 1000, 1001 at runtime
- webview: `accept_first_mouse(true)` so the first click on a non-key window reaches the buttons; buttons have `tabIndex = -1` and `mousedown` prevents focus
- shown with `orderFrontRegardless` (never `makeKeyAndOrderFront`); app activation policy `Accessory` (no Dock icon)
- position: random monitor from `available_monitors()`, random point inside that monitor's work area (excludes menu bar and Dock)

Each show logs the frontmost app before and after, whether our app became active, whether the card is the key window, and time from trigger to first paint (two `requestAnimationFrame`s after the challenge renders). Each click logs the same focus facts. Any key event reaching the card's webview is logged as a CHK-11 violation.

| Case | Binary from shell | Bundled `.app` | Result |
|---|---|---|---|
| Shows above normal windows, frontmost app unchanged | Claude frontmost before and after, app active = false, card key = false (2 cards) | Finder frontmost before and after, app active = false, card key = false (2 cards) | ✅ |
| Time from trigger to first paint (NFR-PERF-02, ≤ 500 ms) | 36–101 ms (5 cards) | 55–64 ms (2 cards) | ✅ |
| `show()` call itself | 2.5–6.0 ms | 4.6–5.5 ms | ✅ |
| Random position within the work area | 5 distinct positions | 2 distinct positions | ✅ (one display) |
| Click on the right number registers on the first click; frontmost app unchanged | | | ⏳ Raj |
| Typing, Enter and Space while the card is visible go to the frontmost app, none reach the card | | | ⏳ Raj (synthetic keystrokes need Accessibility, which this session doesn't have) |
| Full-screen app in its own Space | | | ⏳ Raj |
| Keynote slideshow | | | ⏳ Raj |
| Stage Manager on / off | | | ⏳ Raj |
| Other Space (desktop 2) | | | ⏳ Raj |
| Random monitor across two displays | | | 🚫 no second display |

Early finding: when our own app was launched seconds before (its control window frontmost), the log correctly shows our app as frontmost. In the real agent there is no regular window at check-in time, so that case doesn't apply.

### Approach 2: raw objc2 on the Tauri window

Not tried yet; only needed if approach 1 fails a manual case.

## 4. Chosen approach

Approach 1 so far. Key code (`spikes/macos/src-tauri/src/card.rs`):

```rust
tauri_panel! {
    panel!(CardPanel {
        config: {
            can_become_key_window: false,
            can_become_main_window: false,
            is_floating_panel: true,
            hides_on_deactivate: false,
            works_when_modal: true
        }
    })
}

let window = WebviewWindowBuilder::new(app, "card", WebviewUrl::App("card.html".into()))
    .inner_size(360.0, 200.0)
    .decorations(false)
    .visible(false)
    .focused(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .accept_first_mouse(true)
    .build()?;
let panel = window.to_panel::<CardPanel>()?;
panel.add_style_mask(StyleMask::empty().nonactivating_panel().into())?;
panel.set_collection_behavior(
    CollectionBehavior::new().can_join_all_spaces().full_screen_auxiliary().stationary().ignores_cycle().into(),
);
panel.set_level(25); // kCGMainMenuWindowLevel + 1
// show:
panel.order_front_regardless();
```

## 5. Known limitations

- Multi-monitor placement is untested (one display).
- macOS 13 (PRD minimum) is untested; these AppKit calls exist there, but only macOS 26 was run.
- Window level 25 sits below the screen saver and some system UI (Notification Center, Control Center). Whether it shows above a Keynote slideshow is one of the pending cases; if not, level 1000/1001 is the next try.

## 6. Impact on the PRD or issues

None so far. To be filled in after the manual cases.

## How to run the spike

```bash
cd spikes/macos/src-tauri
cargo tauri build --debug
open "target/debug/bundle/macos/AI Proctor Spike.app"                     # control window
open --env SPIKE_AUTO=30,20 "target/debug/bundle/macos/AI Proctor Spike.app"  # 20 cards, 30 s apart
```

Log: `~/Library/Logs/AIProctorSpike/spike.log`. `SPIKE_LEVEL=floating|mainmenu+1|popup|screensaver|screensaver+1` picks the window level at launch.
