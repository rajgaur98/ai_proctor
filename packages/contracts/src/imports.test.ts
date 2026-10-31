import { describe, expect, it } from "vitest";
import { IMPORT_MAX_ROWS, ImportPayload, ImportPerson, ImportShifts } from "./imports";

const person = {
  rows: [2],
  action: "create",
  email: "nora@acme.test",
  full_name: "Nora New",
  role: "employee",
  manager_email: "max@acme.test",
  team: null,
  work_country: "US",
  work_state: "NY",
  timezone: "America/New_York",
};

describe("ImportPerson", () => {
  it("accepts a new US employee with a state and a manager", () => {
    expect(ImportPerson.safeParse(person).success).toBe(true);
  });

  it("needs a state for the US and none elsewhere", () => {
    expect(ImportPerson.safeParse({ ...person, work_state: null }).success).toBe(false);
    expect(
      ImportPerson.safeParse({ ...person, work_country: "IN", work_state: null }).success,
    ).toBe(true);
  });

  it("gives everyone but the owner a manager, and never invites an owner", () => {
    expect(ImportPerson.safeParse({ ...person, manager_email: null }).success).toBe(false);
    const owner = { ...person, role: "owner", manager_email: null };
    expect(ImportPerson.safeParse(owner).success).toBe(false);
    expect(ImportPerson.safeParse({ ...owner, action: "update" }).success).toBe(true);
  });
});

describe("ImportShifts", () => {
  it("takes one to seven shifts with HH:MM times", () => {
    const shift = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:30", timezone: "UTC" };
    const item = { rows: [2], action: "update", email: "a@acme.test", shifts: [shift] };
    expect(ImportShifts.safeParse(item).success).toBe(true);
    expect(ImportShifts.safeParse({ ...item, shifts: [] }).success).toBe(false);
    expect(ImportShifts.safeParse({ ...item, shifts: Array(8).fill(shift) }).success).toBe(false);
    expect(ImportShifts.safeParse({ ...item, shifts: [{ ...shift, start: "9:00" }] }).success).toBe(
      false,
    );
  });
});

describe("ImportPayload", () => {
  it("is one kind of item, at least one and at most the row limit", () => {
    const client = { rows: [2], action: "create", name: "Acme", archived: false };
    expect(ImportPayload.safeParse({ kind: "clients", items: [client] }).success).toBe(true);
    expect(ImportPayload.safeParse({ kind: "clients", items: [] }).success).toBe(false);
    expect(ImportPayload.safeParse({ kind: "people", items: [client] }).success).toBe(false);
    expect(
      ImportPayload.safeParse({ kind: "clients", items: Array(IMPORT_MAX_ROWS + 1).fill(client) })
        .success,
    ).toBe(false);
  });
});
