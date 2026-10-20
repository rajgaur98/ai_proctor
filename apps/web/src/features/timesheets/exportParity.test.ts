// The export must add up exactly like the dashboard (#45, TS-06): the same segments run
// through the week summary here and through the export's totals in packages/core.
import { type ExportSegment, sumSegments } from "@ai-proctor/core";
import { describe, expect, it } from "vitest";
import { type BreakdownRow, summarizeWeek } from "./summary";
import { weekDays } from "./weeks";

/** A small seeded generator, so a failure repeats. */
function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const days = weekDays("2026-03-16");
const types = ["verified", "meeting", "idle", "unverified", "away", "offline", "break", "manual"];
const projects = [null, "p1", "p2"];

function segments(next: () => number): ExportSegment[] {
  const pick = <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)] as T;
  return Array.from({ length: 1 + Math.floor(next() * 60) }, () => {
    const flagged = next() < 0.3;
    const projectId = pick(projects);
    return {
      userId: "u1",
      employee: "Erin Employee",
      email: "erin@acme.test",
      timezone: "UTC",
      day: pick(days),
      startLocal: "",
      endLocal: "",
      type: pick(types),
      projectId,
      project: projectId,
      client: null,
      billable: next() < 0.5,
      counted: next() < 0.9,
      flagged,
      excluded: flagged && next() < 0.5,
      seconds: 1 + Math.floor(next() * 5 * 3600),
      status: "draft",
      approver: null,
    };
  });
}

describe("export totals match the dashboard's week summary", () => {
  it("for 200 random weeks", () => {
    const next = random(45);
    for (let i = 0; i < 200; i++) {
      const segs = segments(next);
      const rows: BreakdownRow[] = segs.map((s) => ({
        day: s.day,
        type: s.type,
        projectId: s.projectId,
        counted: s.counted,
        flagged: s.flagged,
        excluded: s.excluded,
        seconds: s.seconds,
      }));
      const week = summarizeWeek(rows, days).total;
      const exported = sumSegments(segs);
      expect(exported.worked).toBe(week.worked);
      expect(exported.flagged).toBe(week.flagged);
      expect(exported.excluded).toBe(week.excluded);
      expect(exported.breakTime).toBe(week.breakTime);
      expect(exported.manual).toBe(week.manual);
      // The dashboard's per-project split adds up to the same worked time.
      expect([...week.byProject.values()].reduce((a, b) => a + b, 0)).toBe(exported.worked);
    }
  });
});
