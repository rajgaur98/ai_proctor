import { describe, expect, it } from "vitest";
import { Invite } from "./invites";

const base = {
  email: "nora@acme.test",
  full_name: "Nora New",
  role: "employee",
  manager_id: "00000000-0000-4000-8000-0000000000b1",
  work_country: "US",
  work_state: "NY",
  timezone: "America/New_York",
};

describe("Invite", () => {
  it("accepts a US invite with a state", () => {
    expect(Invite.safeParse(base).success).toBe(true);
  });

  it("needs a state for the US and none elsewhere", () => {
    expect(Invite.safeParse({ ...base, work_state: null }).success).toBe(false);
    expect(Invite.safeParse({ ...base, work_country: "IN", work_state: null }).success).toBe(true);
    expect(Invite.safeParse({ ...base, work_country: "IN" }).success).toBe(false);
  });

  it("rejects owners, bad emails and blank names", () => {
    expect(Invite.safeParse({ ...base, role: "owner" }).success).toBe(false);
    expect(Invite.safeParse({ ...base, email: "nora" }).success).toBe(false);
    expect(Invite.safeParse({ ...base, full_name: "  " }).success).toBe(false);
  });
});
