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
  it("reads a timesheet comment (#265): where it is and its length", () => {
    expect(actionLabel("timesheet.commented")).toBe("Commented on a timesheet");
    expect(
      summarize(
        "timesheet.commented",
        { target: "row", period_start: "2026-10-19", length: 27, comment_id: "c" },
        nameOf,
      ),
    ).toBe("On a row · week of 2026-10-19 · 27 characters");
    expect(
      summarize(
        "timesheet.commented",
        { target: "entry", period_start: "2026-10-19", length: 1 },
        nameOf,
      ),
    ).toBe("On a manual entry · week of 2026-10-19 · 1 character");
  });

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

  it("reads miss reason changes without the remark (#252)", () => {
    expect(actionLabel("checkin.miss_reason_set")).toBe("Set a miss reason");
    expect(
      summarize(
        "checkin.miss_reason_set",
        { from_kind: null, to_kind: "other", from_note_length: 0, to_note_length: 10 },
        nameOf,
      ),
    ).toBe("None (no remark) → Other (remark 10 characters)");
    expect(
      summarize(
        "checkin.miss_reason_set",
        { from_kind: "meeting", to_kind: "phone_call", from_note_length: 1, to_note_length: 0 },
        nameOf,
      ),
    ).toBe("Meeting (remark 1 character) → Phone call (no remark)");
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

  it("sums up an import (#256)", () => {
    expect(actionLabel("import.applied")).toBe("Imported data");
    expect(
      summarize("import.applied", { kind: "people", created: 2, updated: 1, rows: 3 }, nameOf),
    ).toBe("People · 2 added, 1 updated · 3 rows");
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

  it("reads list exports (#255): page, format, rows and the page's filters", () => {
    expect(actionLabel("export.created")).toBe("Exported a list");
    expect(
      summarize(
        "export.created",
        { page: "alerts", format: "xlsx", row_count: 1, filters: { kind: "Missed check-ins" } },
        nameOf,
      ),
    ).toBe("alerts · XLSX · 1 row · kind: Missed check-ins");
    expect(
      summarize(
        "export.created",
        { page: "people", format: "csv", row_count: 4, filters: {} },
        nameOf,
      ),
    ).toBe("people · CSV · 4 rows");
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
