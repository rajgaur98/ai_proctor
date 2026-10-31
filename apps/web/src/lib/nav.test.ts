import { describe, expect, it } from "vitest";
import { homeFor, initials, navFor } from "./nav";

describe("navFor", () => {
  it("gives managers the team pages", () => {
    expect(navFor("manager").map((l) => l.label)).toEqual([
      "Live team",
      "Timesheets",
      "Reports",
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
      "/my-day",
      "/notice",
    ]);
  });

  it("keeps Reports from employees", () => {
    expect(navFor("employee").map((l) => l.to)).not.toContain("/reports");
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
