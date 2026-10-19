import { describe, expect, it } from "vitest";
import { employeeZoneTitle, formatTime } from "./time";

const iso = "2026-10-19T17:03:00Z";

describe("formatTime", () => {
  it("shows the viewer's own zone without a label", () => {
    expect(formatTime(iso, "Asia/Kolkata", "Asia/Kolkata")).toBe("22:33");
  });

  it("labels any other zone", () => {
    expect(formatTime(iso, "America/Los_Angeles", "Asia/Kolkata")).toBe("10:03 PDT");
  });
});

describe("employeeZoneTitle", () => {
  it("describes the instant in the employee's zone", () => {
    expect(employeeZoneTitle(iso, "America/Chicago")).toBe(
      "Mon 19 Oct, 12:03 CDT (employee's time, America/Chicago)",
    );
  });
});
