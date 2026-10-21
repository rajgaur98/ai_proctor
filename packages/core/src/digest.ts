// The managers' daily digest (PRD 4.12 ALR-03, #67): what internal.digest_eval puts in
// an email's payload, and the lines the send-emails function writes from it. Pure, so
// the email and the tests share it.
//
// Seconds stay raw whole seconds; the totals are added up from them and only the
// display rounds (to the minute, like the dashboard: clockHours).

import { clockHours } from "./exportRows.ts";

/** One direct report's yesterday, as the digest payload carries it. */
export interface DigestReport {
  user_id: string;
  full_name: string;
  worked_s: number;
  flagged_s: number;
  misses: number;
  late_clock_ins: number;
}

/** One line of the digest, ready to show. */
export interface DigestLine {
  userId: string;
  name: string;
  /** "7:26" (hours:minutes). */
  worked: string;
  flagged: string;
  misses: number;
  lateClockIns: number;
}

export interface DigestSummary {
  lines: DigestLine[];
  total: Omit<DigestLine, "userId" | "name">;
}

const whole = (n: unknown): number => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
};

/** The digest's lines by name, and the team's totals added up from the raw seconds. */
export function digestSummary(reports: readonly DigestReport[]): DigestSummary {
  const sorted = [...reports].sort(
    (a, b) => a.full_name.localeCompare(b.full_name, "en") || a.user_id.localeCompare(b.user_id),
  );
  let worked = 0;
  let flagged = 0;
  let misses = 0;
  let late = 0;
  const lines = sorted.map((r) => {
    const line = {
      userId: r.user_id,
      name: r.full_name,
      worked: clockHours(whole(r.worked_s)),
      flagged: clockHours(whole(r.flagged_s)),
      misses: whole(r.misses),
      lateClockIns: whole(r.late_clock_ins),
    };
    worked += whole(r.worked_s);
    flagged += whole(r.flagged_s);
    misses += line.misses;
    late += line.lateClockIns;
    return line;
  });
  return {
    lines,
    total: {
      worked: clockHours(worked),
      flagged: clockHours(flagged),
      misses,
      lateClockIns: late,
    },
  };
}

/** "1 missed check-in", "2 missed check-ins". */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One report's line as plain text: "Erin Employee: 7:26 worked, 0:30 flagged, 1 missed check-in, 1 late clock-in". */
export function digestLineText(l: Omit<DigestLine, "userId">): string {
  return [
    `${l.name}: ${l.worked} worked`,
    `${l.flagged} flagged`,
    plural(l.misses, "missed check-in", "missed check-ins"),
    plural(l.lateClockIns, "late clock-in", "late clock-ins"),
  ].join(", ");
}
