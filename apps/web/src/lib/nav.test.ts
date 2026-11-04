import { describe, expect, it } from "vitest";
import { homeFor, initials, navFor } from "./nav";

describe("navFor", () => {
  it("gives managers the team pages", () => {
    expect(navFor("manager").map((l) => l.label)).toEqual([
      "Live team",
      "Timesheets",
      "Time off",
      "Reports",
      "Insights",
      "Projects",
    ]);
    expect(navFor("manager").map((l) => l.to)).not.toContain("/policy");
  });

  it("gives owners and admins the admin set", () => {
    expect(navFor("owner")).toEqual(navFor("admin"));
    expect(navFor("admin").map((l) => l.label)).toContain("People");
    expect(navFor("admin").map((l) => l.label)).toContain("Teams");
    expect(navFor("admin").map((l) => l.label)).toContain("Reports");
    expect(navFor("admin").map((l) => l.label)).toContain("Projects");
    expect(navFor("admin").map((l) => l.label)).toContain("Policy");
    expect(navFor("admin").map((l) => l.label)).toContain("Monitoring notice");
  });

  it("keeps imports to owners and admins", () => {
    expect(navFor("admin").map((l) => l.to)).toContain("/settings/import");
    expect(navFor("manager").map((l) => l.to)).not.toContain("/settings/import");
    expect(navFor("employee").map((l) => l.to)).not.toContain("/settings/import");
  });

  it("keeps the audit log to owners and admins", () => {
    expect(navFor("owner").map((l) => l.to)).toContain("/audit");
    expect(navFor("manager").map((l) => l.to)).not.toContain("/audit");
    expect(navFor("employee").map((l) => l.to)).not.toContain("/audit");
  });

  it("gives employees only their own pages", () => {
    expect(navFor("employee").map((l) => l.to)).toEqual([
      "/me",
      "/my-timesheet",
      "/time-off",
      "/my-day",
      "/notice",
    ]);
  });

  it("gives everyone Time off (#304)", () => {
    for (const role of ["owner", "admin", "manager", "employee"] as const) {
      expect(navFor(role).map((l) => l.to)).toContain("/time-off");
    }
  });

  it("keeps Reports from employees", () => {
    expect(navFor("employee").map((l) => l.to)).not.toContain("/reports");
  });

  it("gives managers, owners and admins Insights; employees see theirs in My data (#305)", () => {
    expect(navFor("manager").map((l) => l.to)).toContain("/insights");
    expect(navFor("admin").map((l) => l.to)).toContain("/insights");
    expect(navFor("employee").map((l) => l.to)).not.toContain("/insights");
  });

  it("lands each role on its first page", () => {
    expect(homeFor("employee")).toBe("/me");
    expect(homeFor("manager")).toBe("/team");
  });
});

describe("initials", () => {
  it("takes the first two names", () => {
    expect(initials("Lucas Martin")).toBe("LM");
    expect(initials("ada")).toBe("A");
  });
});
