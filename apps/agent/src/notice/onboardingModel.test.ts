import type { OnboardingState, TestCaptureResult } from "@ai-proctor/contracts";
import { describe, expect, it } from "vitest";
import {
  type ButtonContext,
  type CapturePhase,
  canContinue,
  captureFailed,
  captureProblems,
  captureWorked,
  footerButtons,
  isOn,
  needsRestart,
  permissionCards,
  permissionsHeading,
  screenCaption,
  settingsApp,
  statusLabel,
  stepFooter,
  stepMarks,
  toStep,
  trayName,
} from "./onboardingModel";

const mac: OnboardingState = {
  platform: "macos",
  permissions: { screen: "granted", camera: "not_determined" },
  webcam: true,
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
    expect(permissionCards({ ...mac, webcam: false }).map((c) => c.kind)).toEqual(["screen"]);
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
      expect(permissionCards({ ...mac, webcam: false }).map((c) => c.kind)).toEqual(["screen"]);
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
      expect(permissionCards({ ...withDomains, webcam: false }).map((c) => c.kind)).toEqual([
        "screen",
        "accessibility",
      ]);
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
      expect(permissionsHeading(permissionCards({ ...withDomains, webcam: false }))).toBe(
        "Allow a permission",
      );
      expect(permissionsHeading(permissionCards({ ...mac, webcam: false }))).toBe(
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
    expect(problem("camera_busy")[0]).toContain("in use by another app");
    expect(problem("no_camera")[0]).toBe("No camera was found.");
    expect(problem("permission_missing")[0]).toBe("The camera is off for AI Proctor.");
    expect(problem("failed")[0]).toContain("Retake");
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

  it("only closes when the person is already clocked in", () => {
    expect(footerButtons(4, ctx({ working: true }))).toEqual({
      primary: "Close",
      secondary: null,
    });
  });
});
