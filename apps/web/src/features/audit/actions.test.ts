import { describe, expect, it } from "vitest";
import { actionLabel, knownActions, summarize } from "./actions";

const names: Record<string, string> = { max: "Max Manager", ada: "Ada Admin" };
const nameOf = (id: string | null) => (id ? (names[id] ?? id.slice(0, 8)) : "nobody");

describe("actionLabel", () => {
  it("names the known actions and falls back to the raw name", () => {
    expect(actionLabel("member.role_changed")).toBe("Changed a role");
    expect(actionLabel("timesheet.approved")).toBe("timesheet.approved");
    expect(knownActions).toContain("audit_log.exported");
  });
});

describe("summarize", () => {
  it("reads role, manager and location changes", () => {
    expect(summarize("member.role_changed", { from: "employee", to: "manager" }, nameOf)).toBe(
      "Employee → Manager",
    );
    expect(summarize("member.manager_changed", { from: "max", to: "ada" }, nameOf)).toBe(
      "Max Manager → Ada Admin",
    );
    expect(
      summarize(
        "member.location_changed",
        { from: { country: "US", state: "CA" }, to: { country: "IN", state: null } },
        nameOf,
      ),
    ).toBe("US · CA → IN");
  });

  it("counts shifts and files", () => {
    expect(summarize("member.shifts_changed", { from: [1, 2], to: [1] }, nameOf)).toBe(
      "2 shifts → 1 shift",
    );
    expect(
      summarize("capture.viewed", { checkin_id: "0190f5b0-0000", objects: ["a", "b"] }, nameOf),
    ).toBe("Check-in 0190f5b0 · 2 files");
  });

  it("describes an export with its filters", () => {
    expect(
      summarize(
        "audit_log.exported",
        { row_count: 12, filters: { actions: ["capture.viewed"], from: "2026-03-01" } },
        nameOf,
      ),
    ).toBe("12 rows · actions: capture.viewed · from 2026-03-01");
  });

  it("shows unknown metadata as JSON and nothing as a dash", () => {
    expect(summarize("timesheet.approved", { week: "2026-W10" }, nameOf)).toBe(
      '{"week":"2026-W10"}',
    );
    expect(summarize("timesheet.approved", {}, nameOf)).toBe("—");
    expect(summarize("member.deactivated", {}, nameOf)).toBe("—");
  });
});
