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
  it("reads team changes", () => {
    expect(
      summarize(
        "member.team_changed",
        { from: null, from_name: null, to: "t", to_name: "Support" },
        nameOf,
      ),
    ).toBe("No team → Support");
    expect(summarize("team.renamed", { from: "Eng", to: "Engineering" }, nameOf)).toBe(
      "Eng → Engineering",
    );
    expect(summarize("team.deleted", { name: "Support", members: ["a", "b"] }, nameOf)).toBe(
      "Support · 2 members",
    );
    expect(
      summarize(
        "team.policy_changed",
        { name: "Support", changed: { idle_threshold_min: { from: null, to: 3 } } },
        nameOf,
      ),
    ).toBe("Support · 1 setting");
    expect(actionLabel("team.policy_changed")).toBe("Changed a team's policy");
  });

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

  it("reads assistive input changes", () => {
    expect(actionLabel("member.assistive_input_changed")).toBe("Changed assistive input");
    expect(summarize("member.assistive_input_changed", { from: false, to: true }, nameOf)).toBe(
      "Off → On",
    );
    expect(summarize("member.assistive_input_changed", { from: true, to: false }, nameOf)).toBe(
      "On → Off",
    );
    expect(summarize("member.assistive_input_changed", {}, nameOf)).toBe("— → —");
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

  it("names enrollment tokens by label and prefix only", () => {
    const meta = { token_id: "t1", label: "Jamf: Macs", prefix: "apet_AbCd" };
    expect(actionLabel("enrollment_token.used")).toBe("Enrolled a device");
    expect(summarize("enrollment_token.created", meta, nameOf)).toBe("Jamf: Macs · apet_AbCd…");
    expect(summarize("enrollment_token.used", { ...meta, device_id: "d1" }, nameOf)).toBe(
      "With Jamf: Macs · apet_AbCd…",
    );
    expect(summarize("enrollment_token.revoked", {}, nameOf)).toBe("—");
  });

  it("shows unknown metadata as JSON and nothing as a dash", () => {
    expect(summarize("timesheet.approved", { week: "2026-W10" }, nameOf)).toBe(
      '{"week":"2026-W10"}',
    );
    expect(summarize("timesheet.approved", {}, nameOf)).toBe("—");
    expect(summarize("member.deactivated", {}, nameOf)).toBe("—");
  });
});
