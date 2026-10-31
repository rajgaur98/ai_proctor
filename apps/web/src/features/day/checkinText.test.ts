import { describe, expect, it } from "vitest";
import {
  markerLabel,
  minutesText,
  missReason,
  missReasonLine,
  noFace,
  screenState,
  secondsText,
} from "./checkinText";

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

  it("adds the employee's reason and remark to a miss (#252)", () => {
    expect(
      markerLabel({ ...c, missedReasonKind: "phone_call", missedReason: "Client call" }, "UTC"),
    ).toBe("Missed check-in at 14:03 (Phone call: “Client call”)");
    expect(markerLabel({ ...c, missedReasonKind: "break", missedReason: null }, "UTC")).toBe(
      "Missed check-in at 14:03 (Break)",
    );
    expect(markerLabel({ ...c, missedReasonKind: null, missedReason: " " }, "UTC")).toBe(
      "Missed check-in at 14:03",
    );
  });

  it("adds a no-face hint to a pass whose frame showed none (CAP-07)", () => {
    const pass = { ...c, outcome: "pass" as const };
    expect(markerLabel({ ...pass, facePresent: false }, "UTC")).toBe(
      "Passed check-in at 14:03, no face detected (needs review)",
    );
    expect(markerLabel({ ...pass, facePresent: true }, "UTC")).toBe("Passed check-in at 14:03");
    expect(markerLabel({ ...pass, facePresent: null }, "UTC")).toBe("Passed check-in at 14:03");
  });
});

describe("noFace (CAP-07)", () => {
  it("is only a pass checked with no face found", () => {
    expect(noFace({ outcome: "pass", facePresent: false })).toBe(true);
    expect(noFace({ outcome: "pass", facePresent: true })).toBe(false);
    expect(noFace({ outcome: "pass", facePresent: null })).toBe(false);
    expect(noFace({ outcome: "pass" })).toBe(false);
    expect(noFace({ outcome: "miss", facePresent: false })).toBe(false);
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

  it("puts a miss's reason on one short line", () => {
    expect(missReasonLine("meeting", null)).toBe("Meeting");
    expect(missReasonLine(null, "Ran\n late")).toBe("“Ran late”");
    expect(missReasonLine("other", "Fire drill")).toBe("Other: “Fire drill”");
    expect(missReasonLine(null, null)).toBe("No reason given");
    const long = missReasonLine("other", "x".repeat(200));
    expect(long).toBe(`Other: “${"x".repeat(59)}…”`);
  });

  it("names the screen state", () => {
    expect(screenState("locked")).toBe("Locked");
    expect(screenState("active")).toBe("Unlocked");
    expect(screenState(null)).toBe("Not recorded");
  });
});
