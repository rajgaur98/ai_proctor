import { describe, expect, it } from "vitest";
import { flagCheckinIds, flagText } from "./flagText";

describe("flagText", () => {
  it("describes injected clicks", () => {
    expect(flagText("injected_click", { clicks: 3, checkin_ids: [] })).toEqual({
      title: "Check-in clicks from another program",
      detail: "3 clicks on the card didn't come from a mouse or trackpad and were blocked.",
    });
    expect(flagText("injected_click", { clicks: 1 }).detail).toBe(
      "1 click on the card didn't come from a mouse or trackpad and was blocked.",
    );
  });

  it("describes fast responses with the fastest time", () => {
    expect(flagText("fast_response", { count: 2, min_response_ms: 250 }).detail).toBe(
      "2 check-ins were answered in under 0.3 s (fastest 250 ms).",
    );
    expect(flagText("fast_response", { count: 1, min_response_ms: 120 }).detail).toBe(
      "1 check-in was answered in under 0.3 s (fastest 120 ms).",
    );
  });

  it("describes even response times with the numbers behind them", () => {
    expect(flagText("low_variance", { passes: 6, mean_ms: 4000, cv: 0.0198 }).detail).toBe(
      "6 check-ins were answered in almost the same time: average 4.0 s, spread 2.0%.",
    );
  });

  it("falls back when details are missing", () => {
    expect(flagText("fast_response", null).detail).toBe(
      "Some check-ins were answered in under 0.3 s.",
    );
    expect(flagText("low_variance", {}).detail).toBe(
      "Check-ins were answered in almost the same time.",
    );
    expect(flagText("injected_click", {}).detail).toContain("Some clicks");
  });

  it("never calls anyone a cheat", () => {
    for (const kind of ["injected_click", "fast_response", "low_variance"] as const) {
      const { title, detail } = flagText(kind, {});
      expect(`${title} ${detail}`).not.toMatch(/cheat|violation|fraud|fake/i);
    }
  });
});

describe("flagCheckinIds", () => {
  it("lists the check-ins a flag points at", () => {
    expect(flagCheckinIds({ checkin_ids: ["a", "b", 3] })).toEqual(["a", "b"]);
  });

  it("is empty when there are none", () => {
    expect(flagCheckinIds({ passes: 5 })).toEqual([]);
    expect(flagCheckinIds(null)).toEqual([]);
    expect(flagCheckinIds([])).toEqual([]);
  });
});
