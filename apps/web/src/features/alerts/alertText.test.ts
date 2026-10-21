import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { ALERT_KINDS, alertDay, alertText, dayLabel, KIND_LABELS } from "./alertText";

describe("alertText", () => {
  it("says how many misses", () => {
    expect(alertText("consecutive_misses", { misses: 4, threshold: 3 })).toBe(
      "4 missed check-ins in a row",
    );
  });

  it("names the thresholds the org set", () => {
    expect(alertText("offline", { threshold_min: 30 })).toBe(
      "Offline for over 30 min during a shift",
    );
    expect(alertText("late_clock_in", { grace_min: 20 })).toBe(
      "Not clocked in 20 min after the shift started",
    );
    expect(alertText("pause_over_cap", { cap_min: 90 })).toBe(
      "Pauses over the daily cap of 90 min",
    );
  });

  it("falls back when details are missing", () => {
    expect(alertText("consecutive_misses", null)).toBe("Several missed check-ins in a row");
    expect(alertText("tamper", {})).toContain("Tamper");
  });

  it("says why a Tamper alert was raised", () => {
    expect(alertText("tamper", { reason: "capture_blocked" })).toBe(
      "Tamper: capture blocked, needs review",
    );
    expect(alertText("tamper", { reason: "agent_stopped" })).toBe(
      "Tamper: agent stopped, needs review",
    );
    expect(alertText("tamper", { reason: "no_heartbeat" })).toBe(
      "Tamper: no heartbeat, needs review",
    );
    expect(alertText("tamper", { reason: "something_new" })).toContain("Tamper");
  });
});

describe("dayLabel", () => {
  const now = DateTime.fromISO("2026-10-20T12:00:00", { zone: "UTC" });

  it("labels today, yesterday and older days", () => {
    expect(dayLabel("2026-10-20T01:00:00Z", now)).toBe("Today");
    expect(dayLabel("2026-10-19T23:00:00Z", now)).toBe("Yesterday");
    expect(dayLabel("2026-10-12T09:00:00Z", now)).toBe("12 Oct");
  });
});

describe("alertDay", () => {
  it("is the date in the employee's zone", () => {
    expect(alertDay("2026-10-20T22:30:00Z", "Asia/Kolkata")).toBe("2026-10-21");
    expect(alertDay("2026-10-20T22:30:00Z", "UTC")).toBe("2026-10-20");
  });
});

describe("KIND_LABELS", () => {
  it("names every kind", () => {
    expect(ALERT_KINDS).toHaveLength(5);
    for (const k of ALERT_KINDS) expect(KIND_LABELS[k]).not.toBe("");
  });
});
