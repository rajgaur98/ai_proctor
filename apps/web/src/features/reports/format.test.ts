import { describe, expect, it } from "vitest";
import { formatRate, formatResponse } from "./format";

describe("formatRate", () => {
  it("rounds to a whole percent for display, and shows a dash for no check-ins", () => {
    expect(formatRate(0.625)).toBe("63%");
    expect(formatRate(1)).toBe("100%");
    expect(formatRate(0)).toBe("0%");
    expect(formatRate(null)).toBe("—");
  });
});

describe("formatResponse", () => {
  it("picks the unit that reads best", () => {
    expect(formatResponse(null)).toBe("—");
    expect(formatResponse(150)).toBe("150 ms");
    expect(formatResponse(999.4)).toBe("999 ms");
    expect(formatResponse(3000)).toBe("3.0 s");
    expect(formatResponse(18_250)).toBe("18.3 s");
    expect(formatResponse(65_000)).toBe("1 min 05 s");
    expect(formatResponse(59_990)).toBe("1 min 00 s");
  });
});
