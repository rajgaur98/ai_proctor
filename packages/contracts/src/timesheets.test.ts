import { describe, expect, it } from "vitest";
import { ReturnComment, TimesheetReason } from "./timesheets";

describe("TimesheetReason", () => {
  it("needs a reason of up to 500 characters, trimmed", () => {
    expect(TimesheetReason.parse("  Idle before lunch  ")).toBe("Idle before lunch");
    expect(TimesheetReason.safeParse("   ").success).toBe(false);
    expect(TimesheetReason.safeParse("x".repeat(501)).success).toBe(false);
    expect(TimesheetReason.safeParse("x".repeat(500)).success).toBe(true);
  });
});

describe("ReturnComment", () => {
  it("needs a comment", () => {
    expect(ReturnComment.safeParse("").success).toBe(false);
    expect(ReturnComment.safeParse("Please add the Thursday visit").success).toBe(true);
  });
});
