import { describe, expect, it } from "vitest";
import {
  appLabel,
  asTimelineSegments,
  type CaptureView,
  type DaySegment,
  filesOf,
  imagesExpired,
  minutesText,
  missReasonLabel,
  placeSegments,
  recentViews,
  sampleMinute,
  typeTotals,
  viewedBy,
  viewerLabel,
  whenLabel,
  workedSeconds,
} from "./helpers";

const zone = "America/Los_Angeles";
const at = (hhmm: string) => `2026-10-19T${hhmm}:00-07:00`;
const ms = (hhmm: string) => Date.parse(at(hhmm));
const seg = (type: DaySegment["type"], from: string, to: string, over = {}): DaySegment => ({
  type,
  start: at(from),
  end: at(to),
  counted: true,
  excluded: false,
  ...over,
});

describe("placeSegments", () => {
  const span = { start: ms("09:00"), end: ms("17:00") };

  it("positions segments on the bar", () => {
    const [a, b] = placeSegments(span, [
      seg("verified", "09:00", "11:00"),
      seg("idle", "11:00", "12:00"),
    ]);
    expect(a?.left).toBe(0);
    expect(a?.width).toBeCloseTo(25);
    expect(b?.left).toBeCloseTo(25);
    expect(b?.width).toBeCloseTo(12.5);
  });

  it("clips to the span and drops what falls outside", () => {
    const placed = placeSegments(span, [
      seg("verified", "08:00", "10:00"),
      seg("break", "17:30", "18:00"),
    ]);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.left).toBe(0);
    expect(placed[0]?.width).toBeCloseTo(12.5);
  });
});

describe("asTimelineSegments", () => {
  it("keeps the times, as milliseconds", () => {
    expect(asTimelineSegments([seg("verified", "09:00", "10:00")])).toEqual([
      {
        type: "verified",
        start: ms("09:00"),
        end: ms("10:00"),
        flagged: false,
        excluded: false,
        counted: true,
      },
    ]);
  });
});

describe("typeTotals", () => {
  it("adds seconds per type in legend order, skipping empty types", () => {
    const span = { start: ms("09:00"), end: ms("12:00") };
    const totals = typeTotals(span, [
      seg("break", "10:00", "10:30"),
      seg("verified", "09:00", "10:00"),
      seg("verified", "10:30", "11:00"),
      seg("idle", "11:00", "13:00"),
    ]);
    expect(totals).toEqual([
      { type: "verified", seconds: 5400 },
      { type: "idle", seconds: 3600 },
      { type: "break", seconds: 1800 },
    ]);
  });
});

describe("workedSeconds", () => {
  it("counts counted time that a manager has not excluded, from exact seconds", () => {
    expect(
      workedSeconds([
        seg("verified", "09:00", "10:00"),
        seg("idle", "10:00", "10:15", { excluded: true }),
        seg("break", "10:15", "10:45", { counted: false }),
        { ...seg("verified", "10:45", "11:00"), end: "2026-10-19T11:00:07-07:00" },
      ]),
    ).toBe(3600 + 907);
  });
});

describe("minutesText", () => {
  it("rounds to the minute for display", () => {
    expect(minutesText(0)).toBe("0 min");
    expect(minutesText(45 * 60 + 20)).toBe("45 min");
    expect(minutesText(5 * 3600 + 3 * 60 + 29)).toBe("5 h 03 min");
  });
});

describe("miss reasons", () => {
  it("labels the quick picks and passes unknown kinds through", () => {
    expect(missReasonLabel("phone_call")).toBe("Phone call");
    expect(missReasonLabel("away")).toBe("Away from desk");
    expect(missReasonLabel("other_thing")).toBe("other_thing");
    expect(missReasonLabel(null)).toBeNull();
  });
});

describe("who viewed", () => {
  const now = Date.parse("2026-10-19T22:30:00Z"); // 15:30 in LA
  const view = (over: Partial<CaptureView>): CaptureView => ({
    viewedAt: "2026-10-19T22:10:00Z",
    viewerId: "m1",
    viewerName: "Sarah Lee",
    viewerRole: "manager",
    checkinId: "c1",
    checkinAt: "2026-10-19T16:41:00Z",
    ...over,
  });

  it("labels the viewer with their role; an owner is an admin to the employee", () => {
    expect(viewerLabel({ viewerName: "Sarah Lee", viewerRole: "manager" })).toBe(
      "Sarah Lee (manager)",
    );
    expect(viewerLabel({ viewerName: "Nikhil Rao", viewerRole: "owner" })).toBe(
      "Nikhil Rao (admin)",
    );
    expect(viewerLabel({ viewerName: null, viewerRole: null })).toBe(
      "Someone who has left the workspace",
    );
  });

  it("says Not viewed without a view of that check-in", () => {
    expect(viewedBy([view({ checkinId: "c2" })], "c1", zone, now)).toBe("Not viewed");
    expect(viewedBy([], "c1", zone, now)).toBe("Not viewed");
  });

  it("names the latest viewer and time", () => {
    const views = [
      view({ viewedAt: "2026-10-19T22:09:00Z" }),
      view({ viewedAt: "2026-10-19T22:10:00Z" }),
    ];
    expect(viewedBy(views, "c1", zone, now)).toBe("Viewed by Sarah Lee · today 15:10");
  });

  it("counts other viewers", () => {
    const views = [
      view({}),
      view({ viewerId: "a1", viewerName: "Nikhil Rao", viewedAt: "2026-10-19T21:00:00Z" }),
      view({ viewerId: "a2", viewerName: "Ada Admin", viewedAt: "2026-10-19T20:00:00Z" }),
    ];
    expect(viewedBy(views, "c1", zone, now)).toBe("Viewed by Sarah Lee and 2 others · today 15:10");
    expect(viewedBy(views.slice(0, 2), "c1", zone, now)).toBe(
      "Viewed by Sarah Lee and 1 other · today 15:10",
    );
  });

  it("writes earlier days with the date", () => {
    expect(whenLabel("2026-10-17T00:45:00Z", zone, now)).toBe("Fri 16 Oct 17:45");
    expect(whenLabel("2026-10-19T22:10:00Z", zone, now)).toBe("today 15:10");
  });

  it("keeps the last N days, newest first", () => {
    const views = [
      view({ viewedAt: "2026-09-01T10:00:00Z" }),
      view({ viewedAt: "2026-10-10T10:00:00Z" }),
      view({ viewedAt: "2026-10-18T10:00:00Z" }),
    ];
    expect(recentViews(views, 30, now).map((v) => v.viewedAt)).toEqual([
      "2026-10-18T10:00:00Z",
      "2026-10-10T10:00:00Z",
    ]);
  });
});

describe("captures", () => {
  it("lists what a check-in captured", () => {
    expect(filesOf(["screen-1.webp", "screen-2.webp", "webcam.webp"])).toEqual({
      screens: 2,
      webcam: true,
    });
    expect(filesOf([])).toEqual({ screens: 0, webcam: false });
    expect(filesOf(["other.png"])).toEqual({ screens: 0, webcam: false });
  });

  it("expires images after the retention days", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    expect(imagesExpired("2026-10-01T12:00:00Z", 30, now)).toBe(false);
    expect(imagesExpired("2026-09-18T11:59:00Z", 30, now)).toBe(true);
    expect(imagesExpired("2026-10-12T12:00:00Z", 7, now)).toBe(false);
  });

  it("names the app with the most time in the minute", () => {
    expect(
      appLabel([
        { appName: "VS Code", domain: null, seconds: 20 },
        { appName: "Chrome", domain: "jira.example.com", seconds: 40 },
      ]),
    ).toBe("Chrome · jira.example.com");
    expect(appLabel([{ appName: "VS Code", domain: null, seconds: 20 }])).toBe("VS Code");
    expect(appLabel([])).toBeNull();
  });

  it("finds the minute a check-in was answered in", () => {
    expect(sampleMinute("2026-10-19T16:41:37.250Z", "2026-10-19T16:40:00Z")).toBe(
      "2026-10-19T16:41:00.000Z",
    );
    expect(sampleMinute(null, "2026-10-19T16:40:12Z")).toBe("2026-10-19T16:40:00.000Z");
  });
});
