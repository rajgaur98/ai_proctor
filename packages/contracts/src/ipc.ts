// IPC between the agent's React windows and its Rust core. These Zod schemas are the
// source of truth: `pnpm --filter @ai-proctor/contracts gen` writes them to
// generated/ipc.schema.json, which the Rust core turns into serde types at compile time.
import { z } from "zod";

export const PermissionState = z
  .enum(["granted", "denied", "not_determined", "restricted", "unsupported"])
  .meta({ id: "PermissionState" });

export const Permissions = z
  .object({
    screen: PermissionState,
    camera: PermissionState,
  })
  .meta({ id: "Permissions" });

// Shift states from the LLD state machine (section 02).
export const ShiftState = z
  .enum(["off_shift", "working", "on_break", "paused"])
  .meta({ id: "ShiftState" });

/** A project the person can log to (PRJ-02). */
export const ProjectRef = z
  .object({ id: z.string(), name: z.string(), client: z.string().nullable() })
  .meta({ id: "ProjectRef" });

export const CheckinOutcome = z.enum(["pass", "miss", "failed"]).meta({ id: "CheckinOutcome" });

/** The latest check-in today, for "Last check-in 10:42 · passed". */
export const LastCheckin = z
  .object({ at: z.string(), outcome: CheckinOutcome })
  .meta({ id: "LastCheckin" });

/** A miss today the person hasn't given a reason for yet (CHK-23). */
export const MissedCheckin = z
  .object({ id: z.string(), at: z.string() })
  .meta({ id: "MissedCheckin" });

/**
 * Where the monitoring notice stands for this person (AGT-04/05). `required` is true
 * while they have never acknowledged one: nothing is collected and clocking in is
 * blocked. A newer version after that only asks for a review (`acknowledged` false).
 */
export const NoticeStatus = z
  .object({ version: z.int().nonnegative(), acknowledged: z.boolean(), required: z.boolean() })
  .meta({ id: "NoticeStatus" });

/** The notice text, in the sections of the Onboarding design's first step (plain text). */
export const NoticeBody = z
  .object({
    intro: z.string().optional(),
    collected: z.string(),
    when: z.string(),
    who: z.string(),
    retention: z.string(),
    rights: z.string(),
    grievance: z.string().optional(),
  })
  .meta({ id: "NoticeBody" });

/** The current notice for the notice window. */
export const NoticeContent = z
  .object({ version: z.int().nonnegative(), acknowledged: z.boolean(), body: NoticeBody })
  .meta({ id: "NoticeContent" });

// What the tray popover shows (EMP-01). Never includes the next check-in time.
export const AgentStatus = z
  .object({
    shift: ShiftState,
    signed_in: z.boolean(),
    /** The signed-in account, shown in the popover. */
    account_email: z.string().nullable(),
    agent_version: z.string(),
    permissions: Permissions,
    clocked_in_at: z.string().nullable(),
    /** When the current break or pause began. */
    phase_started_at: z.string().nullable(),
    pause_ends_at: z.string().nullable(),
    pause_planned_min: z.int().nonnegative().nullable(),
    /** Display only; the timesheet itself is computed on the server. */
    worked_today_s: z.int().nonnegative(),
    pause_used_today_s: z.int().nonnegative(),
    pause_daily_cap_s: z.int().nonnegative(),
    project: ProjectRef.nullable(),
    projects: z.array(ProjectRef),
    last_checkin: LastCheckin.nullable(),
    missed_checkin: MissedCheckin.nullable(),
    /** The monitoring notice; null before the first config from the server. */
    notice: NoticeStatus.nullable(),
    /**
     * Browser domains are collected here (activity sampling is on) but macOS Accessibility is
     * off, so the tray offers Fix. Optional permission: never Capture blocked, never Tamper.
     * Always false on Windows, which has no such permission.
     */
    accessibility_missing: z.boolean(),
  })
  .meta({ id: "AgentStatus" });

/**
 * The permissions the onboarding flow asks for (AGT-03). Accessibility (macOS, browser domains)
 * is optional: the flow finishes without it.
 */
export const PermissionKind = z
  .enum(["screen", "camera", "accessibility"])
  .meta({ id: "PermissionKind" });

export const OnboardingPlatform = z
  .enum(["macos", "windows", "other"])
  .meta({ id: "OnboardingPlatform" });

/**
 * What the onboarding flow's permission and finish steps need (AGT-03). `ready` is the core's
 * gate: every permission this person's collection needs is on (the same rule as the tray's
 * warning and the server's Tamper check); one nothing uses is neither shown nor waited for.
 */
export const OnboardingState = z
  .object({
    platform: OnboardingPlatform,
    permissions: Permissions,
    /**
     * Screen Recording is needed: screenshots are on, or window titles are collected. When
     * false, the Screen Recording card is skipped.
     */
    screen_required: z.boolean(),
    /** Camera is needed: the org's webcam setting is on. When false, the Camera card is skipped. */
    camera_required: z.boolean(),
    /**
     * The org takes screenshots. With `camera_required`, this is what a test capture would
     * show; when neither is on the Test capture step has nothing to show and is skipped.
     */
    screenshots: z.boolean(),
    /** Accessibility as the OS reports it. Optional: it never gates `ready`. */
    accessibility: PermissionState,
    /**
     * Browser domains are collected (activity sampling is on) and the OS has an Accessibility
     * permission: the optional Accessibility card shows. False on Windows.
     */
    domains: z.boolean(),
    ready: z.boolean(),
    /** The OS says Screen Recording is on but a capture still failed: reopen the app. */
    restart_needed: z.boolean(),
    /** The flow has been finished on this device. */
    completed: z.boolean(),
    /** The step the window was last opened at (1 to 4), for a window that loads late. */
    start_step: z.int().nonnegative(),
  })
  .meta({ id: "OnboardingState" });

/** Why a test capture failed; the same reasons a check-in records. */
export const TestCaptureFailure = z
  .enum(["permission_missing", "camera_busy", "no_camera", "failed"])
  .meta({ id: "TestCaptureFailure" });

/**
 * The test capture (AGT-03): the images go to the onboarding window as data URLs (WebP) to be
 * shown and dropped. They are never stored or uploaded.
 */
export const TestCaptureResult = z
  .object({
    ok: z.boolean(),
    /** One per display. */
    screens: z.array(z.string()),
    webcam: z.string().nullable(),
    screen_error: TestCaptureFailure.nullable(),
    webcam_error: TestCaptureFailure.nullable(),
    restart_needed: z.boolean(),
  })
  .meta({ id: "TestCaptureResult" });

/** Result of a command that only succeeds or fails with a message for the user. */
export const CommandResult = z
  .object({ ok: z.boolean(), error: z.string().nullable() })
  .meta({ id: "CommandResult" });

/**
 * The check-in card (CHK-10..12, CHK-20..22): "Click {target}" with three buttons.
 * Sent when the card appears and again after a wrong click reshuffles it.
 * Clicks are judged in the Rust core, never in the webview.
 */
/**
 * How one card looks (CHK-15): its size and style vary a little from card to card so
 * an auto-clicker can't find the buttons by matching a saved picture. The core picks
 * it within the design's limits; the card window takes the size, the page the rest.
 */
export const CardLook = z
  .object({
    /** Window size in logical pixels (the design's card is ~360 × 220). */
    width: z.int().nonnegative(),
    height: z.int().nonnegative(),
    radius: z.int().nonnegative(),
    padding: z.int().nonnegative(),
    /** Space between the number buttons. */
    gap: z.int().nonnegative(),
    button_height: z.int().nonnegative(),
    /** Font size of the numbers on the buttons, in pixels. */
    digit_size: z.int().nonnegative(),
    /** Which of the design's button fills: 0 page, 1 sunken, 2 soft accent. */
    tint: z.int().min(0).max(2),
  })
  .meta({ id: "CardLook" });

export const CardChallenge = z
  .object({
    card_id: z.string(),
    target: z.int().nonnegative(),
    options: z.array(z.int().nonnegative()).length(3),
    /** Countdown left when this was sent; the card counts down locally from it. */
    remaining_s: z.int().nonnegative(),
    wrong_clicks: z.int().nonnegative(),
    /** Play a short sound when the card appears (org setting). */
    sound: z.boolean(),
    /** Current project name, or null when none is set. */
    project: z.string().nullable(),
    /** CHK-15: the same for the whole card, through reshuffles. */
    look: CardLook,
  })
  .meta({ id: "CardChallenge" });

/** How the core judged a click; "ignored" for a stale card or a synthetic click. */
export const CardClickResult = z
  .enum(["pass", "wrong", "failed", "ignored"])
  .meta({ id: "CardClickResult" });

/** Commands the UI can `invoke`, with their argument and result schemas. */
export const ipcCommands = {
  get_status: { args: z.object({}), result: AgentStatus },
  /** Emails a magic link (AGT-02); sign-in completes when the link opens the agent. */
  sign_in_start: { args: z.object({ email: z.string() }), result: CommandResult },
  sign_out: { args: z.object({}), result: CommandResult },
  /** A mouse or trackpad click on the card button showing `value`. */
  card_click: {
    args: z.object({ card_id: z.string(), value: z.int(), trusted: z.boolean() }),
    result: CardClickResult,
  },
  /** SHF-02, PRJ-02: clock in, optionally on a project. */
  clock_in: { args: z.object({ project_id: z.string().nullable() }), result: CommandResult },
  clock_out: { args: z.object({}), result: CommandResult },
  /** BRK-01: open-ended (null) or 15 / 30 / 60 min. */
  break_start: { args: z.object({ planned_min: z.int().nullable() }), result: CommandResult },
  break_end: { args: z.object({}), result: CommandResult },
  /** BRK-03: 5 / 10 / 15 min, optional private reason; again while paused extends. */
  pause_start: {
    args: z.object({ minutes: z.int(), reason: z.string().max(200).nullable() }),
    result: CommandResult,
  },
  pause_end: { args: z.object({}), result: CommandResult },
  switch_project: { args: z.object({ project_id: z.string().nullable() }), result: CommandResult },
  /** CHK-23: a quick pick and/or a note on today's missed check-in. */
  set_miss_reason: {
    args: z.object({
      checkin_id: z.string(),
      kind: z.enum(["meeting", "phone_call", "break", "away", "other"]).nullable(),
      note: z.string().max(500).nullable(),
    }),
    result: CommandResult,
  },
  /** Opens My data, the monitoring notice, or the macOS privacy settings to fix a permission. */
  open_link: {
    args: z.object({
      target: z.enum([
        "my_data",
        "notice",
        "screen_settings",
        "camera_settings",
        "accessibility_settings",
      ]),
    }),
    result: CommandResult,
  },
  /** The notice window's content: the current notice, or null before the server has sent one. */
  get_notice: { args: z.object({}), result: NoticeContent.nullable() },
  /** Opens (or focuses) the notice window; the tray's "Review the monitoring notice". */
  show_notice: { args: z.object({}), result: CommandResult },
  /** AGT-04: "I've read this". `version` is the one on screen; the core refuses a stale one. */
  acknowledge_notice: { args: z.object({ version: z.int().nonnegative() }), result: CommandResult },
  /** The onboarding flow's permission state, polled on its Permissions step. */
  onboarding_state: { args: z.object({}), result: OnboardingState },
  /**
   * "Open System Settings": asks the OS for the permission (macOS shows its prompt), then
   * opens the right privacy pane (Windows: the camera privacy page).
   */
  request_permission: { args: z.object({ kind: PermissionKind }), result: CommandResult },
  /** Takes one screenshot (and one webcam frame when the webcam is on); nothing is kept. */
  test_capture: { args: z.object({}), result: TestCaptureResult },
  /** Marks the flow finished on this device; refused while a required permission is off. */
  finish_onboarding: { args: z.object({}), result: CommandResult },
  /** Opens (or focuses) the onboarding window at `step` (1 notice, 2 permissions, 3 test, 4 done). */
  show_onboarding: { args: z.object({ step: z.int().min(1).max(4) }), result: CommandResult },
  /** Hides the onboarding window; its test images are dropped. */
  close_onboarding: { args: z.object({}), result: CommandResult },
  /** Quits and reopens the app: macOS applies a new Screen Recording grant to a fresh process. */
  restart_app: { args: z.object({}), result: CommandResult },
  /** "Switch project" on the card: opens the popover; never blocks the card. */
  card_switch_project: { args: z.object({}), result: CommandResult },
} as const;

/** Events the core `emit`s to the UI, with their payload schemas. */
export const ipcEvents = {
  status_changed: AgentStatus,
  card_challenge: CardChallenge,
  /** The onboarding window was brought up at this step; it starts the flow from there. */
  onboarding_open: z.object({ step: z.int().min(1).max(4) }),
  /** The onboarding window was closed: drop anything it holds (test images). */
  onboarding_closed: z.object({}),
} as const;

export type PermissionState = z.infer<typeof PermissionState>;
export type PermissionKind = z.infer<typeof PermissionKind>;
export type OnboardingPlatform = z.infer<typeof OnboardingPlatform>;
export type OnboardingState = z.infer<typeof OnboardingState>;
export type TestCaptureFailure = z.infer<typeof TestCaptureFailure>;
export type TestCaptureResult = z.infer<typeof TestCaptureResult>;
export type Permissions = z.infer<typeof Permissions>;
export type ShiftState = z.infer<typeof ShiftState>;
export type AgentStatus = z.infer<typeof AgentStatus>;
export type CommandResult = z.infer<typeof CommandResult>;
export type CardLook = z.infer<typeof CardLook>;
export type CardChallenge = z.infer<typeof CardChallenge>;
export type ProjectRef = z.infer<typeof ProjectRef>;
export type NoticeStatus = z.infer<typeof NoticeStatus>;
export type NoticeBody = z.infer<typeof NoticeBody>;
export type NoticeContent = z.infer<typeof NoticeContent>;
export type LastCheckin = z.infer<typeof LastCheckin>;
export type MissedCheckin = z.infer<typeof MissedCheckin>;
export type CardClickResult = z.infer<typeof CardClickResult>;
export type IpcCommand = keyof typeof ipcCommands;
export type IpcEvent = keyof typeof ipcEvents;
export type IpcArgs<C extends IpcCommand> = z.infer<(typeof ipcCommands)[C]["args"]>;
export type IpcResult<C extends IpcCommand> = z.infer<(typeof ipcCommands)[C]["result"]>;
export type IpcPayload<E extends IpcEvent> = z.infer<(typeof ipcEvents)[E]>;
