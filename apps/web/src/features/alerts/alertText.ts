// What an alert says in the list (ALR-01). The alert's details come from alert_eval.
import type { Enums, Json } from "@ai-proctor/contracts";
import { DateTime } from "luxon";

export type AlertKind = Enums<"alert_kind">;

function num(details: Json, key: string): number | null {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return null;
  const v = details[key];
  return typeof v === "number" ? v : null;
}

/** One short line for the alert. */
export function alertText(kind: AlertKind, details: Json): string {
  switch (kind) {
    case "consecutive_misses":
      return `${num(details, "misses") ?? "Several"} missed check-ins in a row`;
    case "offline":
      return `Offline for over ${num(details, "threshold_min") ?? "15"} min during a shift`;
    case "tamper":
      return "Tamper: capture blocked or agent not reporting";
    case "late_clock_in":
      return `Not clocked in ${num(details, "grace_min") ?? "15"} min after the shift started`;
    case "pause_over_cap":
      return `Pauses over the daily cap of ${num(details, "cap_min") ?? "60"} min`;
  }
}

/** "Today", "Yesterday" or "20 Oct", in the viewer's zone. */
export function dayLabel(iso: string, now: DateTime = DateTime.local()): string {
  const t = DateTime.fromISO(iso).setZone(now.zone);
  if (t.hasSame(now, "day")) return "Today";
  if (t.hasSame(now.minus({ days: 1 }), "day")) return "Yesterday";
  return t.toFormat("d LLL");
}
