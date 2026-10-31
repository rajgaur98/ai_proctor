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

/**
 * The Test capture step has something to show: the org takes screenshots or the webcam is on.
 * With neither it would capture nothing, so the flow skips it (Permissions goes straight to Done).
 */
export function testCaptureShown(state: OnboardingState | null): boolean {
  return state === null || state.screenshots || state.camera_required;
}

/** The steps the person walks through, as the strip and footer count them. */
function visibleSteps(capture: boolean): Step[] {
  return ([1, 2, 3, 4] as const).filter((step) => capture || step !== 3);
}

/**
 * The progress strip across the top: done steps show a check. With the test capture skipped
 * the strip has three steps and Done is the third.
 */
export function stepMarks(current: Step, capture = true): StepMark[] {
  return visibleSteps(capture).map((step, i) => {
    const state = step < current ? "done" : step === current ? "current" : "todo";
    return {
      step,
      name: STEPS[step - 1] as string,
      state,
      mark: state === "done" ? "✓" : String(i + 1),
    };
  });
}

export function stepFooter(step: Step, capture = true): string {
  const steps = visibleSteps(capture);
  return `Step ${steps.indexOf(step) + 1} of ${steps.length}`;
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
  /** Optional permissions can be skipped: the flow finishes without them. */
  optional: boolean;
  /** One line under the name saying what the permission is for; null when obvious. */
  note: string | null;
  /**
   * macOS applies Screen Recording and Accessibility only to a fresh start. Set once the
   * person has been sent to the settings and the OS still says no: the card then offers
   * a restart (`restartPrompt`, `restartCta`) and `cta` becomes the secondary link.
   */
  restart: boolean;
  restartPrompt: string | null;
  restartCta: string | null;
}

/** The permissions macOS applies only after the app restarts (Camera takes effect live). */
const needsRestartToApply = new Set<PermissionKind>(["screen", "accessibility"]);

/** What each permission is called on the card and in the settings pane. */
const permissionNames: Record<PermissionKind, string> = {
  screen: "Screen Recording",
  camera: "Camera",
  accessibility: "Accessibility",
};

function card(
  kind: PermissionKind,
  platform: OnboardingPlatform,
  state: PermissionState,
  asked: boolean,
): PermissionCard {
  const name = permissionNames[kind];
  const app = settingsApp(platform);
  const optional = kind === "accessibility";
  const restart =
    asked &&
    platform === "macos" &&
    needsRestartToApply.has(kind) &&
    state !== "granted" &&
    state !== "unsupported" &&
    state !== "restricted";
  const base = {
    kind,
    name,
    on: isOn(state),
    status: statusLabel(state),
    pane: name,
    optional,
    restart,
    restartPrompt: restart ? "Turned it on? Restart AI Proctor to finish." : null,
    restartCta: restart ? "Restart AI Proctor" : null,
    note: optional
      ? "Optional. Lets AI Proctor note the website’s domain (not the full address) while you use a browser. Skip it if you prefer."
      : null,
  };

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

/**
 * The cards the permission step shows: Screen Recording and Camera only when this person's
 * collection needs them (the core says so with `screen_required` and `camera_required`, the
 * rule the tray's warning uses), and the optional Accessibility card only when browser domains
 * are collected and the OS has that permission (`domains`; never on Windows).
 * `asked` holds the kinds the person was sent to the settings for in this onboarding session:
 * a Screen Recording or Accessibility card in it that is still off offers a restart.
 */
export function permissionCards(
  state: OnboardingState,
  asked: ReadonlySet<PermissionKind> = new Set(),
): PermissionCard[] {
  const cards: PermissionCard[] = [];
  const { platform } = state;
  if (state.screen_required) {
    cards.push(card("screen", platform, state.permissions.screen, asked.has("screen")));
  }
  if (state.camera_required) {
    cards.push(card("camera", platform, state.permissions.camera, asked.has("camera")));
  }
  if (state.domains && platform === "macos") {
    cards.push(card("accessibility", platform, state.accessibility, asked.has("accessibility")));
  }
  return cards;
}

/** How many of the shown cards the flow needs: the optional ones don't count. */
export function requiredCount(cards: PermissionCard[]): number {
  return cards.filter((c) => !c.optional).length;
}

/** The heading: counts only the permissions the flow needs, not the optional ones. */
export function permissionsHeading(cards: PermissionCard[]): string {
  const count = requiredCount(cards);
  if (count === 0) return "No permissions needed";
  return count > 1 ? "Allow two permissions" : "Allow a permission";
}

/** The line under the heading. */
export function permissionsIntro(state: OnboardingState, cards: PermissionCard[]): string {
  const optional = cards.some((c) => c.optional);
  if (requiredCount(cards) === 0) {
    return optional
      ? "Your organization doesn't collect anything that needs one. Accessibility is optional: you can skip it and carry on."
      : "Your organization doesn't collect anything that needs one. Carry on whenever you're ready.";
  }
  const base =
    state.platform === "windows"
      ? "Windows asks nothing for the screen. AI Proctor only uses the camera during a check-in you pass."
      : "macOS asks once. AI Proctor only uses Screen Recording and Camera during a check-in you pass.";
  return optional ? `${base} Accessibility is optional: you can skip it and carry on.` : base;
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

/** What a webcam failure says; `screenshots` is whether check-ins also capture the screen. */
function webcamProblem(error: TestCaptureFailure, screenshots: boolean): string {
  switch (error) {
    case "permission_missing":
      return "The camera is off for AI Proctor.";
    case "camera_busy":
      return "Another app is using your camera. Close it and retake.";
    case "no_camera":
      return screenshots
        ? "No camera found. Plug one in or ask your admin. Check-ins will still record your screen; the webcam part will be marked missing until a camera is available."
        : "No camera found. Plug one in or ask your admin. Check-ins will still go through; the webcam part will be marked missing until a camera is available.";
    case "failed":
      return "The webcam frame didn't work. Retake it.";
  }
}

/** What went wrong, in plain words; empty when the capture worked. */
export function captureProblems(
  phase: CapturePhase,
  platform: OnboardingPlatform,
  screenshots = true,
): string[] {
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
  if (result.webcam_error) problems.push(webcamProblem(result.webcam_error, screenshots));
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

/**
 * What the test step offers next (AGT-03, CAP-05):
 * - `finish`: the capture worked (or hasn't come back yet): "Looks good".
 * - `permissions`: the screen failed, the camera is off for the app, or the capture couldn't
 *   run: only the permissions step can fix that.
 * - `finish_without_camera`: the screen is fine but there is no camera to find. Plugging one
 *   in is out of the app's hands, so the person may finish; check-ins mark the webcam missing.
 * - `retake`: another app holds the camera. Closing it and retaking fixes it, so Retake leads
 *   (finishing without it stays available).
 */
export type CaptureNext = "finish" | "permissions" | "finish_without_camera" | "retake";

export function captureNext(phase: CapturePhase): CaptureNext {
  if (phase.kind === "failed") return "permissions";
  if (phase.kind !== "done" || phase.result.ok) return "finish";
  const { screen_error, webcam_error } = phase.result;
  // A screen problem keeps the old way out, whatever the camera says.
  if (screen_error) return "permissions";
  if (webcam_error === "no_camera") return "finish_without_camera";
  if (webcam_error === "camera_busy") return "retake";
  return "permissions";
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

function testStepButtons(next: CaptureNext): Buttons {
  switch (next) {
    case "permissions":
      return { primary: "Back to permissions", secondary: "Retake" };
    case "finish_without_camera":
      return { primary: "Finish without camera", secondary: "Retake" };
    case "retake":
      return { primary: "Retake", secondary: "Finish without camera" };
    case "finish":
      return { primary: "Looks good", secondary: "Retake" };
  }
}

/** The footer buttons, as labelled in the design; step 3's primary follows the capture. */
export function footerButtons(step: Step, ctx: ButtonContext): Buttons {
  switch (step) {
    case 1:
      return { primary: ctx.acknowledged ? "Continue" : "I’ve read this", secondary: null };
    case 2:
      return { primary: "Continue", secondary: "Back" };
    case 3:
      return testStepButtons(captureNext(ctx.capture));
    case 4:
      return ctx.working
        ? { primary: "Close", secondary: null }
        : { primary: "Clock in now", secondary: "Close" };
  }
}
