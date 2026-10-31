import type { OnboardingState, PermissionKind, TestCaptureResult } from "@ai-proctor/contracts";
import { describe, expect, it } from "vitest";
import {
  type ButtonContext,
  type CapturePhase,
  canContinue,
  captureFailed,
  captureNext,
  captureProblems,
  captureWorked,
  footerButtons,
  isOn,
  needsRestart,
  permissionCards,
  permissionsHeading,
  permissionsIntro,
  screenCaption,
  settingsApp,
  statusLabel,
  stepFooter,
  stepMarks,
  testCaptureShown,
  toStep,
  trayName,
} from "./onboardingModel";

const mac: OnboardingState = {
  platform: "macos",
  permissions: { screen: "granted", camera: "not_determined" },
  screen_required: true,
  camera_required: true,
  screenshots: true,
  accessibility: "denied",
  domains: false,
  ready: false,
  restart_needed: false,
  completed: false,
  start_step: 2,
};

const win: OnboardingState = {
  ...mac,
  platform: "windows",
  permissions: { screen: "granted", camera: "denied" },
};

const good: TestCaptureResult = {
  ok: true,
  screens: ["data:image/webp;base64,AAAA"],
  webcam: "data:image/webp;base64,BBBB",
  screen_error: null,
  webcam_error: null,
  restart_needed: false,
};

describe("steps", () => {
  it("marks the steps behind with a check and the current one", () => {
    expect(stepMarks(3).map((m) => [m.name, m.state, m.mark])).toEqual([
      ["Notice", "done", "✓"],
      ["Permissions", "done", "✓"],
      ["Test capture", "current", "3"],
      ["Done", "todo", "4"],
    ]);
    expect(stepMarks(1).map((m) => m.state)).toEqual(["current", "todo", "todo", "todo"]);
  });

  it("says which step of four", () => {
    expect(stepFooter(2)).toBe("Step 2 of 4");
  });

  it("skips the Test capture step when nothing would be captured", () => {
    expect(testCaptureShown(mac)).toBe(true);
    expect(testCaptureShown({ ...mac, screenshots: false })).toBe(true); // webcam only
    expect(testCaptureShown({ ...mac, camera_required: false })).toBe(true); // screenshots only
    expect(testCaptureShown({ ...mac, screenshots: false, camera_required: false })).toBe(false);
    expect(testCaptureShown(null)).toBe(true);
    // Window titles alone need Screen Recording but capture nothing: still no test step.
    expect(
      testCaptureShown({
        ...mac,
        screen_required: true,
        screenshots: false,
        camera_required: false,
      }),
    ).toBe(false);
  });

  it("counts three steps, with Done the third, when the test is skipped", () => {
    expect(stepMarks(4, false).map((m) => [m.name, m.state, m.mark])).toEqual([
      ["Notice", "done", "✓"],
      ["Permissions", "done", "✓"],
      ["Done", "current", "3"],
    ]);
    expect(stepMarks(2, false).map((m) => m.state)).toEqual(["done", "current", "todo"]);
    expect(stepFooter(2, false)).toBe("Step 2 of 3");
    expect(stepFooter(4, false)).toBe("Step 3 of 3");
  });

  it("keeps a step number from the core inside the flow", () => {
    expect([toStep(0), toStep(1), toStep(3), toStep(4), toStep(9), toStep(2.7)]).toEqual([
      1, 1, 3, 4, 4, 2,
    ]);
  });
});

describe("permission cards", () => {
  it("shows Screen Recording and Camera, each with its live status", () => {
    const cards = permissionCards(mac);
    expect(cards.map((c) => [c.name, c.status, c.on])).toEqual([
      ["Screen Recording", "Granted", true],
      ["Camera", "Not yet", false],
    ]);
  });

  it("skips the Camera card when the org's webcam setting is off", () => {
    expect(permissionCards({ ...mac, camera_required: false }).map((c) => c.kind)).toEqual([
      "screen",
    ]);
  });

  it("skips the Screen Recording card when nothing needs it", () => {
    expect(permissionCards({ ...mac, screen_required: false }).map((c) => c.kind)).toEqual([
      "camera",
    ]);
  });

  it("shows no card when nothing is required, and says so", () => {
    const none: OnboardingState = {
      ...mac,
      screen_required: false,
      camera_required: false,
      screenshots: false,
      ready: true,
    };
    const cards = permissionCards(none);
    expect(cards).toEqual([]);
    expect(permissionsHeading(cards)).toBe("No permissions needed");
    expect(permissionsIntro(none, cards)).toContain("doesn't collect anything that needs one");
    expect(canContinue(none)).toBe(true);
  });

  it("keeps the optional Accessibility card when nothing else is required", () => {
    const none: OnboardingState = {
      ...mac,
      screen_required: false,
      camera_required: false,
      domains: true,
      ready: true,
    };
    const cards = permissionCards(none);
    expect(cards.map((c) => c.kind)).toEqual(["accessibility"]);
    expect(permissionsHeading(cards)).toBe("No permissions needed");
    expect(permissionsIntro(none, cards)).toContain("Accessibility is optional");
  });

  it("counts only the shown required cards in the heading", () => {
    expect(permissionsHeading(permissionCards(mac))).toBe("Allow two permissions");
    expect(permissionsHeading(permissionCards({ ...mac, screen_required: false }))).toBe(
      "Allow a permission",
    );
    expect(permissionsHeading(permissionCards({ ...mac, camera_required: false }))).toBe(
      "Allow a permission",
    );
  });

  it("gives the three macOS steps and a button that asks the OS", () => {
    const [screen, camera] = permissionCards(mac);
    expect(camera?.steps).toEqual([
      "1 · Open System Settings → Privacy & Security",
      "2 · Choose Camera",
      "3 · Turn on AI Proctor, then come back here",
    ]);
    expect(camera?.cta).toBe("Open System Settings");
    expect(screen?.steps[2]).toBe("3 · AI Proctor is on — nothing else to do");
    expect(screen?.cta).toBeNull();
  });

  describe("restart after the settings were opened", () => {
    const off: OnboardingState = {
      ...mac,
      permissions: { screen: "denied", camera: "denied" },
      domains: true,
    };
    const asked = (...kinds: PermissionKind[]) => new Set<PermissionKind>(kinds);

    it("stays normal until the person was sent to the settings", () => {
      for (const card of permissionCards(off)) {
        expect(card.restart).toBe(false);
        expect(card.restartPrompt).toBeNull();
        expect(card.restartCta).toBeNull();
        expect(card.cta).toBe("Open System Settings");
      }
      // Asking for another kind changes nothing for this one.
      const [screen] = permissionCards(off, asked("accessibility"));
      expect(screen?.restart).toBe(false);
    });

    it("offers a restart for Screen Recording and Accessibility once asked and still off", () => {
      const [screen, camera, accessibility] = permissionCards(
        off,
        asked("screen", "camera", "accessibility"),
      );
      expect(screen?.restart).toBe(true);
      expect(screen?.restartPrompt).toBe("Turned it on? Restart AI Proctor to finish.");
      expect(screen?.restartCta).toBe("Restart AI Proctor");
      expect(screen?.cta).toBe("Open System Settings"); // kept as the secondary link
      expect(screen?.on).toBe(false);
      expect(accessibility?.restart).toBe(true);
      expect(accessibility?.cta).toBe("Open System Settings");
      expect(camera?.restart).toBe(false); // Camera takes effect live
    });

    it("also covers a permission that was never decided (not_determined)", () => {
      const [screen] = permissionCards(
        { ...off, permissions: { screen: "not_determined", camera: "denied" } },
        asked("screen"),
      );
      expect(screen?.restart).toBe(true);
    });

    it("is granted once the OS says so, whatever was asked", () => {
      const [screen, , accessibility] = permissionCards(
        { ...off, permissions: { screen: "granted", camera: "denied" }, accessibility: "granted" },
        asked("screen", "accessibility"),
      );
      for (const card of [screen, accessibility]) {
        expect(card?.restart).toBe(false);
        expect(card?.on).toBe(true);
        expect(card?.status).toBe("Granted");
        expect(card?.cta).toBeNull();
        expect(card?.restartCta).toBeNull();
      }
    });

    it("leaves Camera alone, and a device-blocked permission", () => {
      const [, camera] = permissionCards(off, asked("camera"));
      expect(camera?.restart).toBe(false);
      expect(camera?.cta).toBe("Open System Settings");
      const [screen] = permissionCards(
        { ...off, permissions: { screen: "restricted", camera: "denied" } },
        asked("screen"),
      );
      expect(screen?.restart).toBe(false);
    });

    it("never applies on Windows", () => {
      const cards = permissionCards(
        { ...win, permissions: { screen: "granted", camera: "denied" } },
        asked("screen", "camera", "accessibility"),
      );
      for (const card of cards) expect(card.restart).toBe(false);
    });
  });

  it("says when the device blocks a permission", () => {
    const [screen] = permissionCards({
      ...mac,
      permissions: { screen: "restricted", camera: "granted" },
    });
    expect(screen?.status).toBe("Restricted");
    expect(screen?.steps[2]).toContain("IT admin");
  });

  it("needs no Screen Recording step on Windows and guides the camera switches", () => {
    const [screen, camera] = permissionCards(win);
    expect(screen?.on).toBe(true);
    expect(screen?.cta).toBeNull();
    expect(screen?.steps[0]).toBe("Windows doesn't ask for a screen permission.");
    expect(camera?.status).toBe("Not yet");
    expect(camera?.steps).toEqual([
      "1 · Open Settings → Privacy & security → Camera",
      "2 · Turn on “Camera access”",
      "3 · Turn on “Let desktop apps access your camera”",
    ]);
    expect(camera?.cta).toBe("Open Camera settings");
  });

  it("is done with the Windows camera card once the switches are on", () => {
    const [, camera] = permissionCards({
      ...win,
      permissions: { screen: "granted", camera: "granted" },
    });
    expect(camera?.on).toBe(true);
    expect(camera?.cta).toBeNull();
  });

  describe("Accessibility (browser domains)", () => {
    const withDomains: OnboardingState = { ...mac, domains: true };

    it("is left out unless the org collects domains", () => {
      expect(permissionCards(mac).map((c) => c.kind)).toEqual(["screen", "camera"]);
      expect(permissionCards({ ...mac, camera_required: false }).map((c) => c.kind)).toEqual([
        "screen",
      ]);
    });

    it("is an optional third card with its own steps and a button that asks the OS", () => {
      const cards = permissionCards(withDomains);
      expect(cards.map((c) => c.kind)).toEqual(["screen", "camera", "accessibility"]);
      const accessibility = cards[2];
      expect(accessibility?.optional).toBe(true);
      expect(accessibility?.note).toContain("Optional");
      expect(accessibility?.status).toBe("Not yet");
      expect(accessibility?.pane).toBe("Accessibility");
      expect(accessibility?.steps).toEqual([
        "1 · Open System Settings → Privacy & Security",
        "2 · Choose Accessibility",
        "3 · Turn on AI Proctor, then come back here",
      ]);
      expect(accessibility?.cta).toBe("Open System Settings");
    });

    it("sits after Screen Recording when the webcam is off", () => {
      expect(
        permissionCards({ ...withDomains, camera_required: false }).map((c) => c.kind),
      ).toEqual(["screen", "accessibility"]);
    });

    it("is done once granted", () => {
      const card = permissionCards({ ...withDomains, accessibility: "granted" })[2];
      expect(card?.on).toBe(true);
      expect(card?.cta).toBeNull();
    });

    it("never shows on Windows, even if the state said domains are collected", () => {
      expect(
        permissionCards({ ...win, domains: true, accessibility: "unsupported" }).map((c) => c.kind),
      ).toEqual(["screen", "camera"]);
    });

    it("does not hold up Continue and is not counted in the heading", () => {
      expect(canContinue({ ...withDomains, ready: true })).toBe(true);
      expect(permissionsHeading(permissionCards(withDomains))).toBe("Allow two permissions");
      expect(permissionsHeading(permissionCards({ ...withDomains, camera_required: false }))).toBe(
        "Allow a permission",
      );
      expect(permissionsHeading(permissionCards({ ...mac, camera_required: false }))).toBe(
        "Allow a permission",
      );
    });
  });

  it("treats an OS with nothing to ask as on", () => {
    expect(isOn("unsupported")).toBe(true);
    expect(statusLabel("unsupported")).toBe("Not needed");
    expect(isOn("denied")).toBe(false);
    expect(isOn("not_determined")).toBe(false);
    expect(statusLabel("denied")).toBe("Not yet");
  });
});

describe("gating", () => {
  it("lets Continue through only when the core says the required permissions are on", () => {
    expect(canContinue(null)).toBe(false);
    expect(canContinue(mac)).toBe(false);
    expect(canContinue({ ...mac, ready: true })).toBe(true);
  });

  it("asks for a restart only when the core says so", () => {
    expect(needsRestart(mac)).toBe(false);
    expect(needsRestart({ ...mac, restart_needed: true })).toBe(true);
    expect(needsRestart(null)).toBe(false);
  });
});

describe("wording per platform", () => {
  it("names the settings app and the place the app lives", () => {
    expect(settingsApp("macos")).toBe("System Settings");
    expect(settingsApp("windows")).toBe("Settings");
    expect(trayName("macos")).toBe("menu bar");
    expect(trayName("windows")).toBe("system tray");
  });
});

describe("test capture", () => {
  const done = (result: Partial<TestCaptureResult>): CapturePhase => ({
    kind: "done",
    result: { ...good, ...result },
  });

  it("has nothing to say when it worked", () => {
    expect(captureProblems(done({}), "macos")).toEqual([]);
    expect(captureWorked(done({}))).toBe(true);
    expect(captureFailed(done({}))).toBe(false);
    expect(captureProblems({ kind: "capturing" }, "macos")).toEqual([]);
  });

  it("explains a missing Screen Recording permission", () => {
    const phase = done({ ok: false, screens: [], screen_error: "permission_missing" });
    expect(captureProblems(phase, "macos")).toEqual([
      "Screen Recording is off for AI Proctor. Turn it on in System Settings.",
    ]);
    expect(captureFailed(phase)).toBe(true);
  });

  it("asks for a restart when Screen Recording is on but still refused", () => {
    const phase = done({
      ok: false,
      screens: [],
      screen_error: "permission_missing",
      restart_needed: true,
    });
    expect(captureProblems(phase, "macos")[0]).toContain("Quit and reopen AI Proctor");
  });

  it("explains each webcam failure", () => {
    const problem = (webcam_error: TestCaptureResult["webcam_error"]) =>
      captureProblems(done({ ok: false, webcam: null, webcam_error }), "windows");
    expect(problem("camera_busy")[0]).toBe(
      "Another app is using your camera. Close it and retake.",
    );
    expect(problem("no_camera")[0]).toBe(
      "No camera found. Plug one in or ask your admin. Check-ins will still record your screen; the webcam part will be marked missing until a camera is available.",
    );
    expect(problem("permission_missing")[0]).toBe("The camera is off for AI Proctor.");
    expect(problem("failed")[0]).toContain("Retake");
  });

  it("doesn't promise screen recording to a webcam-only org with no camera", () => {
    const phase = done({ ok: false, webcam: null, webcam_error: "no_camera" });
    expect(captureProblems(phase, "windows", false)[0]).not.toContain("record your screen");
    expect(captureProblems(phase, "windows", false)[0]).toContain("marked missing");
  });

  it("reports both failures", () => {
    const phase = done({
      ok: false,
      screens: [],
      webcam: null,
      screen_error: "failed",
      webcam_error: "no_camera",
    });
    expect(captureProblems(phase, "macos")).toHaveLength(2);
  });

  it("reports a capture that could not run", () => {
    const phase: CapturePhase = { kind: "failed", message: "boom" };
    expect(captureProblems(phase, "macos")).toEqual(["The test capture didn't run: boom"]);
    expect(captureFailed(phase)).toBe(true);
    expect(captureWorked(phase)).toBe(false);
  });

  it("captions the preview, counting displays", () => {
    expect(screenCaption(1)).toBe("Screenshot · full screen, Display 1");
    expect(screenCaption(2)).toBe("Screenshot · full screen, Display 1 of 2");
  });
});

describe("footer buttons", () => {
  const ctx = (over: Partial<ButtonContext> = {}): ButtonContext => ({
    acknowledged: false,
    capture: { kind: "idle" },
    working: false,
    ...over,
  });

  it("follows the design's labels", () => {
    expect(footerButtons(1, ctx())).toEqual({ primary: "I’ve read this", secondary: null });
    expect(footerButtons(2, ctx())).toEqual({ primary: "Continue", secondary: "Back" });
    expect(footerButtons(3, ctx())).toEqual({ primary: "Looks good", secondary: "Retake" });
    expect(footerButtons(4, ctx())).toEqual({ primary: "Clock in now", secondary: "Close" });
  });

  it("just continues past a notice that was already acknowledged", () => {
    expect(footerButtons(1, ctx({ acknowledged: true })).primary).toBe("Continue");
  });

  it("goes back to the permissions when the capture failed", () => {
    expect(footerButtons(3, ctx({ capture: { kind: "failed", message: "x" } })).primary).toBe(
      "Back to permissions",
    );
    expect(
      footerButtons(3, ctx({ capture: { kind: "done", result: { ...good, ok: false } } })).primary,
    ).toBe("Back to permissions");
    expect(footerButtons(3, ctx({ capture: { kind: "done", result: good } })).primary).toBe(
      "Looks good",
    );
  });

  describe("when the webcam part fails", () => {
    const failed = (over: Partial<TestCaptureResult>): ButtonContext =>
      ctx({ capture: { kind: "done", result: { ...good, ok: false, webcam: null, ...over } } });

    it("no camera: lets the person finish without one", () => {
      const c = failed({ webcam_error: "no_camera" });
      expect(captureNext(c.capture)).toBe("finish_without_camera");
      expect(footerButtons(3, c)).toEqual({
        primary: "Finish without camera",
        secondary: "Retake",
      });
      expect(captureProblems(c.capture, "windows")[0]).toContain("marked missing");
    });

    it("camera busy: leads with Retake", () => {
      const c = failed({ webcam_error: "camera_busy" });
      expect(captureNext(c.capture)).toBe("retake");
      expect(footerButtons(3, c)).toEqual({
        primary: "Retake",
        secondary: "Finish without camera",
      });
      expect(captureProblems(c.capture, "windows")[0]).toContain("Close it and retake");
    });

    it("camera off for the app: back to the permissions", () => {
      const c = failed({ webcam_error: "permission_missing" });
      expect(captureNext(c.capture)).toBe("permissions");
      expect(footerButtons(3, c).primary).toBe("Back to permissions");
    });

    it("a screen failure wins over a missing camera", () => {
      const c = failed({
        screens: [],
        screen_error: "permission_missing",
        webcam_error: "no_camera",
      });
      expect(captureNext(c.capture)).toBe("permissions");
      expect(footerButtons(3, c).primary).toBe("Back to permissions");
    });
  });

  it("screen permission missing goes back to the permissions", () => {
    const capture: CapturePhase = {
      kind: "done",
      result: { ...good, ok: false, screens: [], screen_error: "permission_missing" },
    };
    expect(captureNext(capture)).toBe("permissions");
    expect(footerButtons(3, ctx({ capture })).primary).toBe("Back to permissions");
  });

  it("a good capture, or one still running, says looks good", () => {
    expect(captureNext({ kind: "done", result: good })).toBe("finish");
    expect(captureNext({ kind: "capturing" })).toBe("finish");
    expect(captureNext({ kind: "failed", message: "x" })).toBe("permissions");
  });

  it("only closes when the person is already clocked in", () => {
    expect(footerButtons(4, ctx({ working: true }))).toEqual({
      primary: "Close",
      secondary: null,
    });
  });
});
