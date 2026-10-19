import { describe, expect, it } from "vitest";
import { homeFor, initials, navFor } from "./nav";

describe("navFor", () => {
  it("gives managers the team pages", () => {
    expect(navFor("manager").map((l) => l.label)).toEqual([
      "Live team",
      "Timesheets",
      "Projects",
      "Policy",
    ]);
  });

  it("gives owners and admins the admin set", () => {
    expect(navFor("owner")).toEqual(navFor("admin"));
    expect(navFor("admin").map((l) => l.label)).toContain("People");
  });

  it("gives employees only their own pages", () => {
    expect(navFor("employee").map((l) => l.to)).toEqual(["/me", "/my-timesheet", "/notice"]);
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
