import { describe, expect, it } from "vitest";
import { type LockFacts, lockBannerText } from "./lockBannerText";

// Times without an offset read in the test's own zone, so the output doesn't depend on it.
const base: LockFacts = {
  sheet: { status: "submitted", submittedAt: "2026-10-20T14:02:00", approvedAt: null },
  employeeId: "erin",
  employeeName: "Erin Employee",
  viewerId: "max",
  approverId: null,
  approverName: null,
};
const approved: LockFacts = {
  ...base,
  sheet: {
    status: "approved",
    submittedAt: "2026-10-20T14:02:00",
    approvedAt: "2026-10-21T09:10:00",
  },
  approverId: "max",
  approverName: "Max Manager",
};

describe("lockBannerText", () => {
  it("says who submitted and when", () => {
    expect(lockBannerText(base)).toBe(
      "Submitted by Erin Employee on Tue 20 Oct, 14:02. Locked for Erin while it's reviewed.",
    );
    expect(lockBannerText({ ...base, viewerId: "erin" })).toBe(
      "Submitted by you on Tue 20 Oct, 14:02. Locked while your manager reviews it.",
    );
  });

  it("says who approved and when", () => {
    expect(lockBannerText({ ...approved, viewerId: "erin" })).toBe(
      "Approved by Max Manager on Wed 21 Oct, 09:10. Locked until it's reopened.",
    );
    expect(lockBannerText(approved)).toBe(
      "Approved by you on Wed 21 Oct, 09:10. Locked until it's reopened.",
    );
    expect(lockBannerText({ ...approved, viewerId: "erin", approverName: null })).toBe(
      "Approved on Wed 21 Oct, 09:10. Locked until it's reopened.",
    );
  });

  it("says a week approved itself on submit (TS-16)", () => {
    expect(lockBannerText({ ...approved, approverId: null, approverName: null })).toBe(
      "Approved automatically on Wed 21 Oct, 09:10, as no approval is needed. Locked until it's reopened.",
    );
  });

  it("has nothing for a draft or returned week", () => {
    expect(lockBannerText({ ...base, sheet: { ...base.sheet, status: "draft" } })).toBeNull();
    expect(lockBannerText({ ...base, sheet: { ...base.sheet, status: "returned" } })).toBeNull();
  });
});
