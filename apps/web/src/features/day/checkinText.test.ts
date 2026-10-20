import { describe, expect, it } from "vitest";
import { markerLabel, minutesText, missReason, screenState, secondsText } from "./checkinText";

describe("markerLabel", () => {
  const c = {
    id: "1",
    scheduledAt: "2026-10-19T14:00:00Z",
    shownAt: "2026-10-19T14:03:12Z",
    outcome: "miss" as const,
    deferralReason: null,
  };

  it("says the outcome and the time it was shown", () => {
    expect(markerLabel(c, "UTC")).toBe("Missed check-in at 14:03");
  });

  it("adds why a deferral waited, at the time it was due", () => {
    expect(
      markerLabel(
        { ...c, shownAt: null, outcome: "deferred", deferralReason: "screen_share" },
        "UTC",
      ),
    ).toBe("Deferred check-in at 14:00 (screen shared)");
  });
});

describe("text", () => {
  it("rounds only for display", () => {
    expect(minutesText(11)).toBe("11 min");
    expect(minutesText(65)).toBe("1 h 05 min");
    expect(secondsText(1840)).toBe("1.8 s");
  });

  it("names the quick pick and keeps the note", () => {
    expect(missReason("phone_call", "Client call")).toEqual({
      kind: "Phone call",
      note: "Client call",
    });
    expect(missReason(null, "  ")).toEqual({ kind: null, note: null });
  });

  it("names the screen state", () => {
    expect(screenState("locked")).toBe("Locked");
    expect(screenState("active")).toBe("Unlocked");
    expect(screenState(null)).toBe("Not recorded");
  });
});
