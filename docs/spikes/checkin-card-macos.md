# Spike #11: check-in card on macOS

Status: **done.** Chosen approach works for every case tested. Multi-monitor and a second Space are untested (no second display or Space on the test Mac) and are on the M6 device-test list.

## 1. Question

Can a Tauri v2 window be a check-in card that (CHK-10) shows always on top, including above full-screen apps, on a random monitor at a random position; (CHK-11) accepts mouse clicks but never takes keyboard focus; and (NFR-PERF-02) appears within 500 ms of its scheduled time?

## 2. Environment

macOS 26.7.1 · Apple M2 Max (MacBook Pro) · 1 display (built-in, 3456 × 2234 Retina) · Tauri 2 (CLI 2.12.3) · tauri-nspanel 2.1 · Rust 1.99.1. Results below are from the **bundled `.app`** unless marked otherwise (a binary launched from a shell inherits the terminal's permissions).

## 3. Approaches and results

### Approach 1: `tauri-nspanel` (chosen)

The card is a 360 × 200 Tauri webview window converted to an `NSPanel`:

- panel class: `can_become_key_window: false`, `can_become_main_window: false`, `is_floating_panel: true`, `hides_on_deactivate: false`
- style mask `NSWindowStyleMaskNonactivatingPanel`; collection behaviour `canJoinAllSpaces | fullScreenAuxiliary | stationary | ignoresCycle`; window level `kCGMainMenuWindowLevel + 1` (25)
- webview `accept_first_mouse(true)`; buttons `tabIndex = -1`, `mousedown` prevents focus
- shown with `orderFrontRegardless`; app activation policy `Accessory`
- random monitor from `available_monitors()`, random point inside its work area

| Case | Result |
|---|---|
| Shows above normal windows; frontmost app keeps focus | ✅ 14 cards over Claude, Finder, TextEdit, System Settings: frontmost unchanged, our app never active, card never key |
| First click registers on a non-key panel | ✅ every correct click passed on the first try |
| Wrong click reshuffles, then the right one passes (CHK-12) | ✅ |
| Typing, Enter, Space while the card is visible (CHK-11) | ✅ text went to TextEdit ("Hellooo" + newlines + spaces); no key event reached the card |
| Full-screen app in its own Space (TextEdit, Ctrl-Cmd-F) | ✅ card above it (screenshot), clicks pass, TextEdit keeps focus |
| Stage Manager on | ✅ card above the stage (screenshot), click passes |
| Keynote slideshow | ⚠️ card **shows** above the slideshow, but **cannot be clicked**: Keynote takes over the pointer while presenting. Not a problem in the product: CHK-03 defers check-ins during a presentation, and the presentation detector in #14 works (see `presence-signals.md`). |
| Trigger → first paint (NFR-PERF-02, ≤ 500 ms) | ✅ 36–101 ms (21 cards); `show()` itself 2.5–55 ms |
| Random position | ✅ distinct positions every time |
| Random monitor across two displays | 🚫 no second display (M6 checklist) |
| Another Space (desktop 2) | 🚫 no second Space set up (M6 checklist); `canJoinAllSpaces` is set |
| Launching the app shows no permission prompt | ✅ confirmed on screen |

### Approach 2: raw objc2 on the Tauri window

Not needed.

## 4. Chosen approach

Approach 1. Key code (`spikes/macos/src-tauri/src/card.rs`):

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
panel.order_front_regardless();
```

## 5. Known limitations

- During a Keynote (and presumably PowerPoint) slideshow the card is visible but unclickable; the scheduler must defer (CHK-03), which depends on the presentation detector.
- Multi-monitor placement and other Spaces are untested on hardware.
- macOS 13 (PRD minimum) untested; only macOS 26 was run.

## 6. Impact on the PRD or issues

- #20 (card): use approach 1 as written. The card gate must treat "presenting" as a deferral (already in the scheduler via `Platform::screen_shared`, which must include the presentation detector from #14).
- No PRD change needed.

## How to run the spike

```bash
cd spikes/macos/src-tauri
cargo tauri build --debug
open --env SPIKE_AUTO=30,3 "target/debug/bundle/macos/AI Proctor Spike.app"   # 3 cards, 30 s apart
```

Log: `~/Library/Logs/AIProctorSpike/spike.log`. Switches: `SPIKE_AUTO=<s>,<n>`, `SPIKE_LEVEL`, `SPIKE_CAPTURE=1`, `SPIKE_SCREEN_MODE=native`, `SPIKE_REQUEST=1` (asks for Screen Recording and Camera at launch), `SPIKE_MIN_LUMA`, `SPIKE_MAX_FRAMES`. Debug builds are ad-hoc signed: every rebuild resets the app's privacy grants.
