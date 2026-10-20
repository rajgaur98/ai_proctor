// Presence status rules (PRD 4.6, STS-02). Evaluated in priority order; the first
// match wins. Mirrored in SQL by internal.compute_status(); both are checked
// against vectors/status.json, so they cannot drift apart.

export const presenceStatuses = [
  "off_shift",
  "tamper",
  "offline",
  "on_break",
  "paused",
  "away_locked",
  "away",
  "in_meeting",
  "idle",
  "active",
] as const;

export type PresenceStatus = (typeof presenceStatuses)[number];

/** Raw state the server knows about one employee. */
export interface StatusInput {
  clocked_in: boolean;
  /** Agent killed/blocked during clock-in, or capture permission missing. */
  tamper: boolean;
  /** Clocked in with no heartbeat for more than 3 minutes. */
  offline: boolean;
  on_break: boolean;
  paused: boolean;
  /** Screen locked or device asleep. */
  locked: boolean;
  /** Outcome of the most recent check-in, if any. A deferral is neither pass nor miss. */
  last_checkin: "pass" | "miss" | "failed" | "deferred" | null;
  /** Camera or mic in use by another app. */
  in_call: boolean;
  /** No input for at least the idle threshold. */
  idle: boolean;
}

export function computeStatus(s: StatusInput): PresenceStatus {
  if (!s.clocked_in) return "off_shift";
  if (s.tamper) return "tamper";
  if (s.offline) return "offline";
  if (s.on_break) return "on_break";
  if (s.paused) return "paused";
  if (s.locked) return "away_locked";
  if (s.last_checkin === "miss" || s.last_checkin === "failed") return "away";
  if (s.in_call) return "in_meeting";
  if (s.idle) return "idle";
  return "active";
}
