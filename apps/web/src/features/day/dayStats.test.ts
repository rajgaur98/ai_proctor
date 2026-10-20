import { describe, expect, it } from "vitest";
import { summarizeWeek } from "../timesheets/summary";
import { statCards } from "./dayStats";
import type { DaySegment } from "./timeline";

const base = Date.parse("2026-10-19T16:00:00Z");
const at = (min: number) => base + min * 60_000;
const seg = (
  type: DaySegment["type"],
  from: number,
  to: number,
  extra: Partial<DaySegment> = {},
): DaySegment => ({
  type,
  start: at(from),
  end: at(to),
  counted: type !== "break",
  flagged: ["idle", "unverified", "away", "offline", "pause_over_cap"].includes(type),
  excluded: false,
  ...extra,
});
const time = (ms: number) => `t${(ms - base) / 60_000}`;
const card = (cards: ReturnType<typeof statCards>, key: string) => cards.find((c) => c.key === key);

describe("statCards", () => {
  const segs = [
    seg("verified", 0, 90),
    seg("meeting", 90, 135),
    seg("pause", 135, 150),
    seg("idle", 150, 162),
    seg("break", 162, 207),
    seg("unverified", 207, 238),
  ];
  const checkins = [
    { outcome: "pass" as const },
    { outcome: "pass" as const },
    { outcome: "miss" as const },
    { outcome: "failed" as const },
    { outcome: "deferred" as const },
  ];

  it("adds verified time with meetings and says how much was a meeting", () => {
    const c = card(statCards(segs, checkins, time), "verified");
    expect(c?.value).toBe("2 h 15 min");
    expect(c?.note).toBe("incl. 45 min in meetings");
  });

  it("flags idle and unverified time, the way the timesheet does", () => {
    const cards = statCards(segs, checkins, time);
    expect(card(cards, "flagged")?.value).toBe("43 min");
    expect(card(cards, "flagged")?.note).toBe("idle 12 min · unverified 31 min");
    const sheet = summarizeWeek(
      segs.map((s) => ({
        day: "d",
        type: s.type,
        projectId: null,
        counted: s.counted,
        flagged: s.flagged,
        excluded: s.excluded,
        seconds: (s.end - s.start) / 1000,
      })),
      ["d"],
    ).total;
    expect(sheet.flagged).toBe(43 * 60);
    expect(sheet.breakTime).toBe(45 * 60);
  });

  it("counts pauses and shows when the break was", () => {
    const cards = statCards(segs, checkins, time);
    expect(card(cards, "pause")).toMatchObject({ value: "15 min", note: "1 pause" });
    expect(card(cards, "break")).toMatchObject({ value: "45 min", note: "t162–t207" });
  });

  it("counts check-ins that were shown, not deferred ones", () => {
    expect(card(statCards(segs, checkins, time), "checkins")).toMatchObject({
      value: "2 of 4",
      note: "1 missed · 1 failed · 1 deferred",
    });
    expect(card(statCards([], [{ outcome: "pass" }], time), "checkins")?.note).toBe("all passed");
  });

  it("leaves excluded flagged time out of Flagged and names it", () => {
    const cards = statCards([seg("idle", 0, 10, { excluded: true })], [], time);
    expect(card(cards, "flagged")).toMatchObject({ value: "0 min", note: "10 min excluded" });
  });

  it("is quiet on an empty day", () => {
    const cards = statCards([], [], time);
    expect(cards.map((c) => c.value)).toEqual(["0 min", "0 min", "0 min", "0 min", "0 of 0"]);
    expect(card(cards, "flagged")?.note).toBe("nothing flagged");
    expect(card(cards, "break")?.note).toBe("no break");
  });

  it("merges a pause split at midnight into one and shows time over the cap", () => {
    const cards = statCards(
      [seg("pause", 0, 10), seg("pause_over_cap", 10, 15), seg("verified", 30, 60)],
      [],
      time,
    );
    expect(card(cards, "pause")).toMatchObject({
      value: "15 min",
      note: "1 pause · 5 min over the cap, flagged",
    });
    expect(card(cards, "flagged")?.note).toBe("pause over cap 5 min");
  });
});
