import { describe, expect, it } from "vitest";
import { rangeLabel, rangeProblem, statusLabel } from "./range";

describe("rangeProblem", () => {
  const today = "2026-11-03";

  it("accepts a range that starts today", () => {
    expect(rangeProblem("2026-11-03", "2026-11-10", today)).toBeNull();
    expect(rangeProblem("2026-11-03", "2026-11-03", today)).toBeNull();
  });

  it("refuses missing dates, the past and a backwards range", () => {
    expect(rangeProblem("", "2026-11-10", today)).toMatch(/Choose/);
    expect(rangeProblem("2026-11-02", "2026-11-10", today)).toMatch(/past/);
    expect(rangeProblem("2026-11-05", "2026-11-04", today)).toMatch(/before/);
  });

  it("allows 90 days and refuses 91", () => {
    expect(rangeProblem("2026-11-03", "2027-02-01", today)).toBeNull();
    expect(rangeProblem("2026-11-03", "2027-02-02", today)).toMatch(/90/);
  });
});

describe("rangeLabel", () => {
  it("shows one day or a range", () => {
    expect(rangeLabel("2026-11-03", "2026-11-03")).toBe("3 Nov 2026");
    expect(rangeLabel("2026-11-03", "2026-11-10")).toBe("3 Nov – 10 Nov 2026");
    expect(rangeLabel("2026-12-30", "2027-01-03")).toBe("30 Dec 2026 – 3 Jan 2027");
  });
});

describe("statusLabel", () => {
  it("names each stage and why one ended early", () => {
    expect(statusLabel({ status: "upcoming", endReason: null })).toBe("Upcoming");
    expect(statusLabel({ status: "active", endReason: null })).toBe("Active");
    expect(statusLabel({ status: "completed", endReason: null })).toBe("Completed");
    expect(statusLabel({ status: "ended", endReason: "manual" })).toBe("Ended early");
    expect(statusLabel({ status: "ended", endReason: null })).toBe("Ended early");
    expect(statusLabel({ status: "ended", endReason: "deactivated" })).toBe(
      "Ended early (deactivated)",
    );
    expect(statusLabel({ status: "ended", endReason: "demoted" })).toBe(
      "Ended early (made an employee)",
    );
  });
});
