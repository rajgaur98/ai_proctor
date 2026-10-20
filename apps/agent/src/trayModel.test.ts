import type { AgentStatus } from "@ai-proctor/contracts";
import { describe, expect, it } from "vitest";
import {
  blankToNull,
  canSaveMissReason,
  checkinOutcomeText,
  countdownAnnouncement,
  formatClock,
  formatCountdown,
  formatDay,
  formatDuration,
  liveWorkedSeconds,
  noticePrompt,
  pauseAllowance,
  permissionIssues,
  projectLabel,
  secondsSince,
  secondsUntil,
  trayView,
} from "./trayModel";

const base: AgentStatus = {
  shift: "working",
  signed_in: true,
  account_email: "lucas@acme.test",
  agent_version: "0.1.0",
  permissions: { screen: "granted", camera: "granted" },
  clocked_in_at: null,
  phase_started_at: null,
  pause_ends_at: null,
  pause_planned_min: null,
  worked_today_s: 0,
  pause_used_today_s: 0,
  pause_daily_cap_s: 3600,
  project: null,
  projects: [],
  last_checkin: null,
  missed_checkin: null,
  notice: null,
};

describe("formatDuration", () => {
  it("shows hours and minutes, rounded down", () => {
    expect(formatDuration(5 * 3600 + 12 * 60)).toBe("5 h 12 min");
    expect(formatDuration(5 * 3600 + 12 * 60 + 59)).toBe("5 h 12 min");
  });
  it("drops the hours under an hour", () => {
    expect(formatDuration(22 * 60)).toBe("22 min");
    expect(formatDuration(59)).toBe("0 min");
    expect(formatDuration(0)).toBe("0 min");
  });
  it("keeps 0 minutes on a whole hour", () => {
    expect(formatDuration(3600)).toBe("1 h 0 min");
  });
  it("never goes negative", () => {
    expect(formatDuration(-30)).toBe("0 min");
  });
});

describe("formatCountdown", () => {
  it("formats minutes and padded seconds", () => {
    expect(formatCountdown(8 * 60 + 41)).toBe("8:41");
    expect(formatCountdown(65)).toBe("1:05");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(15 * 60)).toBe("15:00");
  });
  it("rounds a partial second up and clamps negatives", () => {
    expect(formatCountdown(8.2)).toBe("0:09");
    expect(formatCountdown(-5)).toBe("0:00");
  });
});

describe("secondsUntil / secondsSince", () => {
  const now = Date.parse("2026-10-07T08:00:00Z");
  it("counts down to an end time and stops at zero", () => {
    expect(secondsUntil("2026-10-07T08:08:41Z", now)).toBe(521);
    expect(secondsUntil("2026-10-07T07:59:00Z", now)).toBe(0);
  });
  it("counts up from a start time", () => {
    expect(secondsSince("2026-10-07T07:38:00Z", now)).toBe(22 * 60);
    expect(secondsSince("2026-10-07T08:01:00Z", now)).toBe(0);
  });
  it("returns null without a usable time", () => {
    expect(secondsUntil(null, now)).toBeNull();
    expect(secondsUntil("nope", now)).toBeNull();
    expect(secondsSince(null, now)).toBeNull();
    expect(secondsSince("nope", now)).toBeNull();
  });
});

describe("liveWorkedSeconds", () => {
  it("adds the time since the status arrived while working", () => {
    expect(liveWorkedSeconds(1000, 10_000, 70_000, true)).toBe(1060);
  });
  it("holds still when not working", () => {
    expect(liveWorkedSeconds(1000, 10_000, 70_000, false)).toBe(1000);
  });
  it("ignores a clock that went backwards", () => {
    expect(liveWorkedSeconds(1000, 70_000, 10_000, true)).toBe(1000);
  });
});

describe("formatClock / formatDay", () => {
  it("shows local HH:MM", () => {
    expect(formatClock(new Date(2026, 9, 7, 9, 2).toISOString())).toBe("09:02");
    expect(formatClock(new Date(2026, 9, 7, 14, 30).toISOString())).toBe("14:30");
  });
  it("falls back for a missing or bad time", () => {
    expect(formatClock(null)).toBe("--:--");
    expect(formatClock("nope")).toBe("--:--");
  });
  it("shows weekday, day and month", () => {
    expect(formatDay(new Date(2026, 9, 7, 12).getTime())).toBe("Wed 7 Oct");
    expect(formatDay(new Date(2026, 0, 1, 12).getTime())).toBe("Thu 1 Jan");
  });
});

describe("pauseAllowance", () => {
  it("shows minutes left of the daily cap with the share unused", () => {
    expect(pauseAllowance(900, 3600)).toEqual({ text: "45 of 60 min left today", leftPercent: 75 });
    expect(pauseAllowance(1800, 3600)).toEqual({
      text: "30 of 60 min left today",
      leftPercent: 50,
    });
  });
  it("rounds minutes left down", () => {
    expect(pauseAllowance(870, 3600).text).toBe("45 of 60 min left today");
  });
  it("stops at zero when the cap is used up or exceeded", () => {
    expect(pauseAllowance(3600, 3600)).toEqual({ text: "0 of 60 min left today", leftPercent: 0 });
    expect(pauseAllowance(4000, 3600).leftPercent).toBe(0);
  });
  it("handles no allowance", () => {
    expect(pauseAllowance(0, 0)).toEqual({ text: "No pause allowance today", leftPercent: 0 });
  });
});

describe("countdownAnnouncement", () => {
  it("only changes once a minute", () => {
    expect(countdownAnnouncement(521)).toBe("9 minutes left");
    expect(countdownAnnouncement(481)).toBe("9 minutes left");
    expect(countdownAnnouncement(61)).toBe("2 minutes left");
    expect(countdownAnnouncement(60)).toBe("1 minute left");
    expect(countdownAnnouncement(59)).toBe("Less than a minute left");
    expect(countdownAnnouncement(0)).toBe("Pause is over");
  });
});

describe("permissionIssues", () => {
  it("flags denied and not-determined permissions", () => {
    expect(permissionIssues({ screen: "denied", camera: "granted" })).toEqual([
      { kind: "screen", label: "Screen recording" },
    ]);
    expect(permissionIssues({ screen: "granted", camera: "not_determined" })).toEqual([
      { kind: "camera", label: "Camera" },
    ]);
    expect(permissionIssues({ screen: "denied", camera: "denied" })).toHaveLength(2);
  });
  it("leaves granted, restricted and unsupported alone", () => {
    expect(permissionIssues({ screen: "granted", camera: "granted" })).toEqual([]);
    expect(permissionIssues({ screen: "restricted", camera: "unsupported" })).toEqual([]);
  });
});

describe("trayView", () => {
  it("maps each shift state to a chip", () => {
    expect(trayView({ ...base, shift: "off_shift" }).chip).toBe("off");
    expect(trayView({ ...base, shift: "working" }).chip).toBe("active");
    expect(trayView({ ...base, shift: "paused" }).chip).toBe("paused");
    expect(trayView({ ...base, shift: "on_break" }).chip).toBe("break");
  });
  it("shows Capture blocked only while working with a permission off", () => {
    const denied = { screen: "denied", camera: "granted" } as const;
    expect(trayView({ ...base, permissions: denied }).chip).toBe("blocked");
    expect(trayView({ ...base, shift: "paused", permissions: denied }).chip).toBe("paused");
    expect(trayView({ ...base, shift: "off_shift", permissions: denied }).chip).toBe("off");
  });
  it("keeps the permission warning in every state", () => {
    const denied = { screen: "denied", camera: "granted" } as const;
    for (const shift of ["off_shift", "working", "paused", "on_break"] as const) {
      expect(trayView({ ...base, shift, permissions: denied }).issues).toHaveLength(1);
    }
  });
  it("passes the missed check-in through", () => {
    const missed = { id: "c1", at: "2026-10-07T08:33:00Z" };
    expect(trayView({ ...base, missed_checkin: missed }).missed).toEqual(missed);
    expect(trayView(base).missed).toBeNull();
  });
  it("reports the phase", () => {
    expect(trayView({ ...base, shift: "on_break" }).phase).toBe("on_break");
  });
});

describe("small helpers", () => {
  it("words a check-in outcome", () => {
    expect(checkinOutcomeText("pass")).toBe("passed");
    expect(checkinOutcomeText("miss")).toBe("missed");
    expect(checkinOutcomeText("failed")).toBe("failed");
  });
  it("prefixes the client when there is one", () => {
    expect(projectLabel({ id: "p1", name: "Redesign", client: "Acme" })).toBe("Acme · Redesign");
    expect(projectLabel({ id: "p2", name: "Internal", client: null })).toBe("Internal");
  });
  it("turns blank text into null", () => {
    expect(blankToNull("")).toBeNull();
    expect(blankToNull("   ")).toBeNull();
    expect(blankToNull("  school run ")).toBe("school run");
  });
  it("enables Save once there is a pick or a note", () => {
    expect(canSaveMissReason(null, "")).toBe(false);
    expect(canSaveMissReason(null, "  ")).toBe(false);
    expect(canSaveMissReason("meeting", "")).toBe(true);
    expect(canSaveMissReason(null, "ran late")).toBe(true);
  });
});

describe("noticePrompt", () => {
  it("is quiet without a notice or once it is acknowledged", () => {
    expect(noticePrompt(null)).toBeNull();
    expect(noticePrompt({ version: 1, acknowledged: true, required: false })).toBeNull();
  });
  it("blocks until the first acknowledgement", () => {
    expect(noticePrompt({ version: 1, acknowledged: false, required: true })).toBe("required");
  });
  it("asks for a review of a newer version without blocking", () => {
    expect(noticePrompt({ version: 2, acknowledged: false, required: false })).toBe("review");
  });
  it("reaches the tray view", () => {
    const status = { ...base, notice: { version: 2, acknowledged: false, required: false } };
    expect(trayView(status).notice).toBe("review");
    expect(trayView(base).notice).toBeNull();
  });
});
