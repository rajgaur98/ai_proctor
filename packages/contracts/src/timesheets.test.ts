import { describe, expect, it } from "vitest";
import { ReturnComment, TimesheetComment, TimesheetReason } from "./timesheets";

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

describe("TimesheetComment", () => {
  it("needs a comment of up to 2,000 characters, trimmed", () => {
    expect(TimesheetComment.parse("  Was this the checkout work?  ")).toBe(
      "Was this the checkout work?",
    );
    expect(TimesheetComment.safeParse("   ").success).toBe(false);
    expect(TimesheetComment.safeParse("x".repeat(2000)).success).toBe(true);
    expect(TimesheetComment.safeParse("x".repeat(2001)).success).toBe(false);
  });
});
