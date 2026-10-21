import { describe, expect, it } from "vitest";
import {
  draftFrom,
  type OverrideValues,
  overrideSummary,
  sameOverrides,
  toOverrides,
  validateOverrides,
} from "./overrides";

const org: OverrideValues = {
  checkin_min_interval_min: 20,
  checkin_max_interval_min: 90,
  checkin_response_s: 90,
  idle_threshold_min: 10,
  auto_clock_in: false,
  forgotten_clock_out_min: 30,
};

describe("draftFrom", () => {
  it("turns on the groups a team overrides and fills the rest from the org", () => {
    const d = draftFrom({ checkin_min_interval_min: 15, checkin_max_interval_min: 30 }, org);
    expect(d.on).toEqual({
      interval: true,
      response: false,
      idle: false,
      autoClockIn: false,
      clockOut: false,
    });
    expect(d.values).toEqual({
      ...org,
      checkin_min_interval_min: 15,
      checkin_max_interval_min: 30,
    });
  });

  it("starts from the org's values when a team overrides nothing", () => {
    const d = draftFrom({}, org);
    expect(Object.values(d.on).some(Boolean)).toBe(false);
    expect(d.values).toEqual(org);
  });
});

describe("toOverrides", () => {
  it("sends only the groups that are on", () => {
    const d = draftFrom({}, org);
    d.on.idle = true;
    d.on.autoClockIn = true;
    d.values.idle_threshold_min = 3;
    d.values.auto_clock_in = true;
    d.values.checkin_response_s = 45; // edited, then left off: not sent
    expect(toOverrides(d)).toEqual({ idle_threshold_min: 3, auto_clock_in: true });
  });

  it("sends both ends of the interval", () => {
    const d = draftFrom({}, org);
    d.on.interval = true;
    expect(toOverrides(d)).toEqual({ checkin_min_interval_min: 20, checkin_max_interval_min: 90 });
  });
});

describe("validateOverrides", () => {
  it("checks the org policy's ranges and the interval's order", () => {
    const d = draftFrom({ checkin_min_interval_min: 40, checkin_max_interval_min: 30 }, org);
    expect(validateOverrides(d).errors).toEqual({
      checkin_max_interval_min: "Must be at least the shortest interval",
    });
    d.values.checkin_max_interval_min = 60;
    d.on.response = true;
    d.values.checkin_response_s = 10;
    expect(validateOverrides(d).errors?.checkin_response_s).toBe(
      "Enter a whole number from 30 to 300",
    );
  });

  it("refuses a blank number", () => {
    const d = draftFrom({ idle_threshold_min: 5 }, org);
    d.values.idle_threshold_min = Number.NaN;
    expect(validateOverrides(d).errors?.idle_threshold_min).toBeDefined();
  });

  it("ignores values of groups that are off", () => {
    const d = draftFrom({}, org);
    d.values.checkin_response_s = 10;
    expect(validateOverrides(d)).toEqual({ data: {}, errors: null });
  });
});

describe("sameOverrides", () => {
  it("ignores key order", () => {
    expect(
      sameOverrides(
        { idle_threshold_min: 3, checkin_response_s: 60 },
        { checkin_response_s: 60, idle_threshold_min: 3 },
      ),
    ).toBe(true);
    expect(sameOverrides({ idle_threshold_min: 3 }, {})).toBe(false);
  });
});

describe("overrideSummary", () => {
  it("names each overridden setting", () => {
    expect(
      overrideSummary({
        checkin_min_interval_min: 15,
        checkin_max_interval_min: 30,
        checkin_response_s: 60,
        idle_threshold_min: 3,
        auto_clock_in: true,
        forgotten_clock_out_min: 45,
      }),
    ).toEqual([
      "Check-ins every 15 to 30 min",
      "60 s to respond",
      "Idle after 3 min",
      "Auto clock-in on",
      "Clocked out 45 min after a shift",
    ]);
    expect(overrideSummary({ checkin_min_interval_min: 30, checkin_max_interval_min: 30 })).toEqual(
      ["Check-ins every 30 min"],
    );
    expect(overrideSummary({})).toEqual([]);
  });
});
