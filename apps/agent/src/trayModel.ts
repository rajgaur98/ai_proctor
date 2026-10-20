// Pure helpers for the tray popover (#37, rendered by Tray.tsx): formatting, countdowns and which state to
// show. Kept free of React so they're easy to test.
import type {
  AgentStatus,
  LastCheckin,
  MissedCheckin,
  ProjectRef,
  ShiftState,
} from "@ai-proctor/contracts";

export type PermissionTarget = "screen_settings" | "camera_settings";

export interface PermissionIssue {
  kind: "screen" | "camera";
  /** Names the permission in the warning banner. */
  label: string;
  target: PermissionTarget;
}

/** Which status chip to draw; "blocked" is the design's "Capture blocked". */
export type ChipKind = "off" | "active" | "paused" | "break" | "blocked";

/**
 * What the tray says about the monitoring notice (#48): "required" while nothing has been
 * acknowledged (clocking in is blocked), "review" when a newer version is waiting (work
 * carries on under the old one), null otherwise.
 */
export type NoticePrompt = "required" | "review" | null;

export interface TrayView {
  phase: ShiftState;
  chip: ChipKind;
  /** Permissions that stop capture while signed in; each gets a warning with Fix. */
  issues: PermissionIssue[];
  /** A miss today without a reason yet; the reason card sits above the phase content. */
  missed: MissedCheckin | null;
  notice: NoticePrompt;
}

export function noticePrompt(notice: AgentStatus["notice"]): NoticePrompt {
  if (!notice) return null;
  if (notice.required) return "required";
  return notice.acknowledged ? null : "review";
}

/** Quick picks for a missed check-in (CHK-23), in the order the design shows them. */
export const missReasons = [
  { kind: "meeting", label: "Meeting" },
  { kind: "phone_call", label: "Phone call" },
  { kind: "break", label: "Break" },
  { kind: "away", label: "Away from desk" },
  { kind: "other", label: "Other" },
] as const;

export type MissReasonKind = (typeof missReasons)[number]["kind"];

export const breakChoices: readonly { planned_min: number | null; label: string }[] = [
  { planned_min: null, label: "Open-ended" },
  { planned_min: 15, label: "15 min" },
  { planned_min: 30, label: "30 min" },
  { planned_min: 60, label: "60 min" },
];

export const pauseMinutes = [5, 10, 15] as const;

export const PAUSE_REASON_MAX = 200;
export const MISS_NOTE_MAX = 500;

const blocking = new Set(["denied", "not_determined"]);

export function permissionIssues(permissions: AgentStatus["permissions"]): PermissionIssue[] {
  const issues: PermissionIssue[] = [];
  if (blocking.has(permissions.screen)) {
    issues.push({ kind: "screen", label: "Screen recording", target: "screen_settings" });
  }
  if (blocking.has(permissions.camera)) {
    issues.push({ kind: "camera", label: "Camera", target: "camera_settings" });
  }
  return issues;
}

/** What the signed-in popover shows for this status. */
export function trayView(status: AgentStatus): TrayView {
  const issues = permissionIssues(status.permissions);
  const chip: ChipKind =
    status.shift === "off_shift"
      ? "off"
      : status.shift === "paused"
        ? "paused"
        : status.shift === "on_break"
          ? "break"
          : issues.length > 0
            ? "blocked"
            : "active";
  return {
    phase: status.shift,
    chip,
    issues,
    missed: status.missed_checkin,
    notice: noticePrompt(status.notice),
  };
}

export const chipLabel: Record<ChipKind, string> = {
  off: "Off shift",
  active: "Active",
  paused: "Paused",
  break: "On break",
  blocked: "Capture blocked",
};

/** "5 h 12 min", "22 min", "0 min"; whole minutes, rounded down. */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** "8:41" for a countdown; never negative. */
export function formatCountdown(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Whole seconds until `endsAt`, or null when there's no (valid) end time. */
export function secondsUntil(endsAt: string | null, nowMs: number): number | null {
  if (!endsAt) return null;
  const end = Date.parse(endsAt);
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.ceil((end - nowMs) / 1000));
}

/** Whole seconds since `startedAt`, or null when there's no (valid) start time. */
export function secondsSince(startedAt: string | null, nowMs: number): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  return Math.max(0, Math.floor((nowMs - start) / 1000));
}

/**
 * Worked time to show: the figure from the last status plus the time since it arrived
 * while on shift. Display only; the server computes the timesheet.
 */
export function liveWorkedSeconds(
  workedTodayS: number,
  receivedAtMs: number,
  nowMs: number,
  running: boolean,
): number {
  if (!running) return workedTodayS;
  return workedTodayS + Math.max(0, Math.floor((nowMs - receivedAtMs) / 1000));
}

/** Local "HH:MM" for an ISO timestamp. */
export function formatClock(iso: string | null): string {
  if (!iso) return "--:--";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue 7 Oct", for the header. */
export function formatDay(nowMs: number): string {
  const d = new Date(nowMs);
  return `${weekdays[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
}

export interface Allowance {
  /** "45 of 60 min left today" */
  text: string;
  /** Share of today's allowance still unused, 0 to 100. */
  leftPercent: number;
}

/** Pause allowance for the day (BRK-04), from seconds used and the daily cap. */
export function pauseAllowance(usedS: number, capS: number): Allowance {
  if (capS <= 0) return { text: "No pause allowance today", leftPercent: 0 };
  const leftS = Math.max(0, capS - Math.max(0, usedS));
  return {
    text: `${Math.floor(leftS / 60)} of ${Math.round(capS / 60)} min left today`,
    leftPercent: Math.round((leftS / capS) * 100),
  };
}

/** Coarse text for a screen reader; changes once a minute so it isn't read every second. */
export function countdownAnnouncement(secondsLeft: number): string {
  const minutes = Math.ceil(secondsLeft / 60);
  if (secondsLeft <= 0) return "Pause is over";
  if (secondsLeft < 60) return "Less than a minute left";
  return minutes === 1 ? "1 minute left" : `${minutes} minutes left`;
}

type CheckinOutcome = LastCheckin["outcome"];

const outcomeText: Record<CheckinOutcome, string> = {
  pass: "passed",
  miss: "missed",
  failed: "failed",
};

export function checkinOutcomeText(outcome: CheckinOutcome): string {
  return outcomeText[outcome];
}

/** "Client · Project" when the project has a client. */
export function projectLabel(project: ProjectRef): string {
  return project.client ? `${project.client} · ${project.name}` : project.name;
}

/** Empty or whitespace-only text becomes null for the optional fields in the contract. */
export function blankToNull(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

/** Save stays disabled until there's a quick pick or a note. */
export function canSaveMissReason(kind: MissReasonKind | null, note: string): boolean {
  return kind !== null || blankToNull(note) !== null;
}
