// Words for a day's check-ins (#33, #124), shared by the timeline, the list and the
// detail panel. Pure, so the wording is tested without a browser.
import { DateTime } from "luxon";
import { type Checkin, deferralLabel, type Outcome } from "./timeline";

/** Marker and heading wording. A "failed" check-in is a failed challenge (CHK-12). */
export const outcomeLabel: Record<Outcome, string> = {
  pass: "Passed check-in",
  miss: "Missed check-in",
  failed: "Failed check-in",
  deferred: "Deferred check-in",
};

/** The one-word result shown in the list and the detail chip. */
export const outcomeWord: Record<Outcome, string> = {
  pass: "Passed",
  miss: "Missed",
  failed: "Failed",
  deferred: "Deferred",
};

export function deferralText(reason: string | null): string {
  return (reason && deferralLabel[reason]) || "Held back";
}

/** What the marker button says: the outcome, the time, and for a deferral the reason. */
export function markerLabel(c: Checkin, zone: string): string {
  const at = DateTime.fromISO(c.shownAt ?? c.scheduledAt, { zone }).toFormat("HH:mm");
  const reason =
    c.outcome === "deferred" ? ` (${deferralText(c.deferralReason).toLowerCase()})` : "";
  return `${outcomeLabel[c.outcome]} at ${at}${reason}`;
}

/** "11 min", "1 h 05 min": whole minutes, for display only. */
export function minutesText(m: number): string {
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
}

/** "1.8 s" from milliseconds. */
export function secondsText(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

// CHK-23 quick picks; the employee adds them from the tray (#37).
export const reasonLabel: Record<string, string> = {
  meeting: "Meeting",
  phone_call: "Phone call",
  break: "Break",
  away: "Away from desk",
  other: "Other",
};

/** The employee's explanation of a miss: the quick pick and the note, either may be missing. */
export function missReason(
  kind: string | null,
  note: string | null,
): { kind: string | null; note: string | null } {
  return { kind: kind ? (reasonLabel[kind] ?? kind) : null, note: note?.trim() || null };
}

/** What the device was doing when a check-in was shown (agent device_state). */
export function screenState(deviceState: string | null): string {
  switch (deviceState) {
    case "active":
      return "Unlocked";
    case "locked":
      return "Locked";
    case "asleep":
      return "Asleep";
    default:
      return deviceState ?? "Not recorded";
  }
}
