import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { alertText, dayLabel } from "./alertText";

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
});

describe("dayLabel", () => {
  const now = DateTime.fromISO("2026-10-20T12:00:00", { zone: "UTC" });

  it("labels today, yesterday and older days", () => {
    expect(dayLabel("2026-10-20T01:00:00Z", now)).toBe("Today");
    expect(dayLabel("2026-10-19T23:00:00Z", now)).toBe("Yesterday");
    expect(dayLabel("2026-10-12T09:00:00Z", now)).toBe("12 Oct");
  });
});
