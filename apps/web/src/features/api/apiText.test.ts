import { describe, expect, it } from "vitest";
import { allScopes, endOfDay, explain, keyStatus, scopeSummary } from "./apiText";

describe("API keys", () => {
  it("offers every scope the database knows, once", () => {
    expect(allScopes).toEqual([
      "people:read",
      "teams:read",
      "projects:read",
      "projects:write",
      "shifts:read",
      "timesheets:read",
      "time:read",
      "time:write",
      "checkins:read",
      "reports:read",
      "alerts:read",
      "timeoff:read",
    ]);
  });

  it("summarizes a key's scopes by resource", () => {
    expect(scopeSummary(["time:write", "people:read", "time:read"])).toBe(
      "People: read · Time: read, write",
    );
    expect(scopeSummary(["projects:write"])).toBe("Clients, projects and tasks: write");
    expect(scopeSummary(["timeoff:read", "alerts:read"])).toBe("Alerts: read · Time off: read");
    expect(scopeSummary([])).toBe("");
  });

  it("reads a key as active until it is revoked or expires", () => {
    const now = new Date("2026-11-05T12:00:00Z");
    expect(keyStatus({ revokedAt: null, expiresAt: null }, now)).toBe("Active");
    expect(keyStatus({ revokedAt: null, expiresAt: "2026-11-06T00:00:00Z" }, now)).toBe("Active");
    expect(keyStatus({ revokedAt: null, expiresAt: "2026-11-05T11:00:00Z" }, now)).toBe("Expired");
    expect(keyStatus({ revokedAt: "2026-11-01T00:00:00Z", expiresAt: null }, now)).toBe("Revoked");
  });

  it("expires at the end of the chosen local day", () => {
    const end = new Date(endOfDay("2027-01-31"));
    expect([end.getFullYear(), end.getMonth(), end.getDate(), end.getHours()]).toEqual([
      2027, 0, 31, 23,
    ]);
  });

  it("explains the server's refusals and passes anything else through", () => {
    expect(explain("invalid_scopes")).toMatch(/at least one/);
    expect(explain("admin_only")).toMatch(/owners and admins/);
    expect(explain("something new")).toBe("something new");
  });
});
