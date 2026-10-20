// Pure helpers for the onboarding window (#59; AGT-03, rendered by OnboardingWindow.tsx):
// the four steps of the Onboarding design, the permission cards and what a test capture
// says. Free of React so they're easy to test.
import type {
  OnboardingPlatform,
  OnboardingState,
  PermissionKind,
  PermissionState,
  TestCaptureFailure,
  TestCaptureResult,
} from "@ai-proctor/contracts";

export type Step = 1 | 2 | 3 | 4;

export const STEPS = ["Notice", "Permissions", "Test capture", "Done"] as const;

/** A step number from the core, kept inside the flow. */
export function toStep(n: number): Step {
  const step = Math.min(Math.max(Math.trunc(n), 1), 4);
  return step as Step;
}

export interface StepMark {
  step: Step;
  name: string;
  state: "done" | "current" | "todo";
  /** The circle's text: a check once the step is behind, else its number. */
  mark: string;
}

/** The progress strip across the top: done steps show a check. */
export function stepMarks(current: Step): StepMark[] {
  return STEPS.map((name, i) => {
    const step = (i + 1) as Step;
    const state = step < current ? "done" : step === current ? "current" : "todo";
    return { step, name, state, mark: state === "done" ? "✓" : String(step) };
  });
}

export function stepFooter(step: Step): string {
  return `Step ${step} of ${STEPS.length}`;
}

/** What the platform's settings app is called in the instructions. */
export function settingsApp(platform: OnboardingPlatform): string {
  return platform === "windows" ? "Settings" : "System Settings";
}

const on = new Set<PermissionState>(["granted", "unsupported"]);

/** The permission is on, or the OS has nothing to ask for. */
export function isOn(state: PermissionState): boolean {
  return on.has(state);
}

export function statusLabel(state: PermissionState): string {
  if (state === "granted") return "Granted";
  if (state === "unsupported") return "Not needed";
  if (state === "restricted") return "Restricted";
  return "Not yet";
}

export interface PermissionCard {
  kind: PermissionKind;
  name: string;
  on: boolean;
  status: string;
  /** The numbered instructions under the illustration. */
  steps: string[];
  /** The button's text; null when there is nothing to open. */
  cta: string | null;
  /** The pane name drawn in the illustration. */
  pane: string;
}

function card(
  kind: PermissionKind,
  platform: OnboardingPlatform,
  state: PermissionState,
): PermissionCard {
  const name = kind === "screen" ? "Screen Recording" : "Camera";
  const app = settingsApp(platform);
  const base = { kind, name, on: isOn(state), status: statusLabel(state), pane: name };

  if (platform === "windows") {
    if (kind === "screen") {
      return {
        ...base,
        steps: ["Windows doesn't ask for a screen permission.", "Nothing to turn on."],
        cta: null,
      };
    }
    return {
      ...base,
      steps: base.on
        ? ["Camera access is on for desktop apps.", "Nothing else to do."]
        : [
            `1 · Open ${app} → Privacy & security → Camera`,
            "2 · Turn on “Camera access”",
            "3 · Turn on “Let desktop apps access your camera”",
          ],
      cta: base.on ? null : "Open Camera settings",
    };
  }

  const third =
    state === "restricted"
      ? "3 · Your device settings block this. Ask your IT admin."
      : base.on
        ? "3 · AI Proctor is on — nothing else to do"
        : "3 · Turn on AI Proctor, then come back here";
  return {
    ...base,
    steps: [`1 · Open ${app} → Privacy & Security`, `2 · Choose ${name}`, third],
    cta: base.on ? null : `Open ${app}`,
  };
}

/** The cards the permission step shows: the camera only when the org's webcam setting is on. */
export function permissionCards(state: OnboardingState): PermissionCard[] {
  const cards = [card("screen", state.platform, state.permissions.screen)];
  if (state.webcam) cards.push(card("camera", state.platform, state.permissions.camera));
  return cards;
}

/** Continue is enabled once what the core requires is on. */
export function canContinue(state: OnboardingState | null): boolean {
  return state?.ready === true;
}

/** Where the person goes to use the app: the macOS menu bar, or the Windows tray. */
export function trayName(platform: OnboardingPlatform): string {
  return platform === "windows" ? "system tray" : "menu bar";
}

/** Screen Recording is on but macOS hasn't applied it: only reopening the app helps. */
export function needsRestart(state: OnboardingState | null): boolean {
  return state?.restart_needed === true;
}

/** The test capture as the window sees it. */
export type CapturePhase =
  | { kind: "idle" }
  | { kind: "capturing" }
  | { kind: "done"; result: TestCaptureResult }
  | { kind: "failed"; message: string };

const webcamProblems: Record<TestCaptureFailure, string> = {
  permission_missing: "The camera is off for AI Proctor.",
  camera_busy: "The camera is in use by another app. Close it and retake.",
  no_camera: "No camera was found.",
  failed: "The webcam frame didn't work. Retake it.",
};

/** What went wrong, in plain words; empty when the capture worked. */
export function captureProblems(phase: CapturePhase, platform: OnboardingPlatform): string[] {
  if (phase.kind === "failed") return [`The test capture didn't run: ${phase.message}`];
  if (phase.kind !== "done") return [];
  const { result } = phase;
  const problems: string[] = [];
  if (result.screen_error) {
    problems.push(
      result.screen_error === "permission_missing"
        ? result.restart_needed
          ? "Screen Recording is on, but macOS only applies it to a fresh start. Quit and reopen AI Proctor."
          : `Screen Recording is off for AI Proctor. Turn it on in ${settingsApp(platform)}.`
        : "The screenshot didn't work. Retake it.",
    );
  }
  if (result.webcam_error) problems.push(webcamProblems[result.webcam_error]);
  return problems;
}

/** The capture ran and came back with a problem, or didn't run at all. */
export function captureFailed(phase: CapturePhase): boolean {
  return phase.kind === "failed" || (phase.kind === "done" && !phase.result.ok);
}

/** "Looks good" needs a capture that worked; a failed one goes back to the permissions. */
export function captureWorked(phase: CapturePhase): boolean {
  return phase.kind === "done" && phase.result.ok;
}

/** Caption under the screenshot preview. */
export function screenCaption(count: number): string {
  if (count > 1) return `Screenshot · full screen, Display 1 of ${count}`;
  return "Screenshot · full screen, Display 1";
}

export interface Buttons {
  primary: string;
  /** Null: no second button. */
  secondary: string | null;
}

export interface ButtonContext {
  /** The notice on step 1 has been acknowledged. */
  acknowledged: boolean;
  capture: CapturePhase;
  /** Already clocked in, so "Clock in now" doesn't apply. */
  working: boolean;
}

/** The footer buttons, as labelled in the design; step 3's primary follows the capture. */
export function footerButtons(step: Step, ctx: ButtonContext): Buttons {
  switch (step) {
    case 1:
      return { primary: ctx.acknowledged ? "Continue" : "I’ve read this", secondary: null };
    case 2:
      return { primary: "Continue", secondary: "Back" };
    case 3:
      return {
        primary: captureFailed(ctx.capture) ? "Back to permissions" : "Looks good",
        secondary: "Retake",
      };
    case 4:
      return ctx.working
        ? { primary: "Close", secondary: null }
        : { primary: "Clock in now", secondary: "Close" };
  }
}
