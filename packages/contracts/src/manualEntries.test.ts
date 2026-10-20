import { describe, expect, it } from "vitest";
import { ManualEntryRequest } from "./manualEntries";

const base = {
  start_at: "2026-03-16T14:00:00-07:00",
  end_at: "2026-03-16T15:00:00-07:00",
  project_id: "00000000-0000-4000-8000-0000000000f1",
  reason: "Client visit",
};

describe("ManualEntryRequest", () => {
  it("accepts a request with or without a project", () => {
    expect(ManualEntryRequest.safeParse(base).success).toBe(true);
    expect(ManualEntryRequest.safeParse({ ...base, project_id: null }).success).toBe(true);
  });

  it("needs the end after the start, within 24 hours", () => {
    expect(ManualEntryRequest.safeParse({ ...base, end_at: base.start_at }).success).toBe(false);
    expect(
      ManualEntryRequest.safeParse({ ...base, end_at: "2026-03-17T14:00:01-07:00" }).success,
    ).toBe(false);
    expect(
      ManualEntryRequest.safeParse({ ...base, end_at: "2026-03-17T14:00:00-07:00" }).success,
    ).toBe(true);
  });

  it("needs a reason of up to 500 characters", () => {
    expect(ManualEntryRequest.safeParse({ ...base, reason: "   " }).success).toBe(false);
    expect(ManualEntryRequest.safeParse({ ...base, reason: "x".repeat(501) }).success).toBe(false);
  });
});
