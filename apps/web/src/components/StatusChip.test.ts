import { describe, expect, it } from "vitest";
import { statusStyle } from "./StatusChip";

describe("statusStyle", () => {
  it("has a label for every status (never colour alone, NFR-UX-01)", () => {
    const labels = Object.values(statusStyle).map((s) => s.label);
    expect(labels).toHaveLength(10);
    expect(new Set(labels).size).toBe(10);
  });

  it("uses distinct shapes for the states that matter most", () => {
    expect(statusStyle.offline.shape).toBe("ring");
    expect(statusStyle.tamper.shape).toBe("diamond");
    expect(statusStyle.paused.shape).toBe("square");
    expect(statusStyle.off_shift.shape).toBe("dash");
  });
});
