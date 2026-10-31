import { describe, expect, it } from "vitest";
import { ctx } from "./fixture.test-helper";
import { previewImport } from "./preview";
import type { ImportContext } from "./types";

const people = (csv: string, context: ImportContext = ctx) => previewImport("people", csv, context);
const errorsOf = (csv: string, context?: ImportContext) =>
  people(csv, context).rows.flatMap((r) =>
    r.errors.map((e) => `${r.row} ${e.field}: ${e.message}`),
  );

describe("people import", () => {
  it("invites new people, filling empty cells from the defaults", () => {
    const p = people(
      "Email,Name,Role,Manager email,Team,Country,State,Time zone\r\n" +
        "Nora@Acme.test,Nora New,,,support,,,\r\n" +
        "ravi@acme.test,Ravi Rao,manager,ada@acme.test,,IN,,Asia/Kolkata\r\n",
    );
    expect(p.fileErrors).toEqual([]);
    expect(p.rows.map((r) => [r.key, r.status])).toEqual([
      ["nora@acme.test", "create"],
      ["ravi@acme.test", "create"],
    ]);
    expect(p.payload).toEqual({
      kind: "people",
      items: [
        {
          rows: [2],
          action: "create",
          email: "nora@acme.test",
          full_name: "Nora New",
          role: "employee",
          manager_email: "max@acme.test",
          team: "Support",
          work_country: "US",
          work_state: "NY",
          timezone: "America/New_York",
        },
        {
          rows: [3],
          action: "create",
          email: "ravi@acme.test",
          full_name: "Ravi Rao",
          role: "manager",
          manager_email: "ada@acme.test",
          team: null,
          work_country: "IN",
          work_state: null,
          timezone: "Asia/Kolkata",
        },
      ],
    });
  });

  it("updates existing people by email; empty cells keep what they have", () => {
    const p = people(
      "email,name,role,manager_email,team,work location,timezone\n" +
        "ERIN@acme.test,,,,Sales,,\n" +
        "eli@acme.test,Eli E.,manager,ada@acme.test,,US-TX,\n" +
        "max@acme.test,,,,,,\n",
    );
    expect(p.rows.map((r) => [r.key, r.status, r.changes])).toEqual([
      ["erin@acme.test", "update", ["team: Support → Sales"]],
      [
        "eli@acme.test",
        "update",
        [
          "name: Eli Employee → Eli E.",
          "role: employee → manager",
          "manager: max@acme.test → ada@acme.test",
        ],
      ],
      ["max@acme.test", "unchanged", []],
    ]);
    expect(p.counts).toEqual({ create: 0, update: 2, unchanged: 1, error: 0 });
    expect(p.payload?.items.map((i) => ("email" in i ? i.email : ""))).toEqual([
      "erin@acme.test",
      "eli@acme.test",
    ]);
    expect(p.payload?.items[0]).toMatchObject({
      action: "update",
      full_name: "Erin Employee",
      team: "Sales",
      work_country: "IN",
      work_state: null,
      timezone: "Asia/Kolkata",
    });
  });

  it("re-importing the same file changes nothing", () => {
    const csv =
      "email,name,role,manager_email,team,country,state,timezone\n" +
      "erin@acme.test,Erin Employee,employee,max@acme.test,Support,IN,,Asia/Kolkata\n";
    const p = people(csv);
    expect(p.rows[0]?.status).toBe("unchanged");
    expect(p.payload).toBeNull();
  });

  it("explains bad cells in plain words, per field", () => {
    expect(
      errorsOf(
        "email,name,role,manager_email,team,country,state,timezone\n" +
          ",No Email,,,,,,\n" +
          "bad@,Bad,boss,nope,Nowhere,USA,XYZ,Mars/Base\n" +
          "in@acme.test,In,,,,IN,KA,\n" +
          "us@acme.test,Us,,,,US,,UTC\n",
        {
          ...ctx,
          defaults: {
            role: "employee",
            manager_email: "max@acme.test",
            work_country: "IN",
            work_state: null,
            timezone: "America/New_York",
          },
        },
      ),
    ).toEqual([
      "2 email: The email is missing.",
      '3 email: "bad@" isn\'t an email address.',
      '3 role: "boss" isn\'t a role. Use admin, manager or employee.',
      '3 manager_email: "nope" isn\'t an email address.',
      '3 team: There\'s no team named "Nowhere". Add it on the Teams page or import teams first.',
      '3 state: "XYZ" isn\'t a state code. Use two letters, like NY.',
      '3 timezone: "Mars/Base" isn\'t a time zone. Use a name like America/New_York or Asia/Kolkata.',
      "4 state: Only US work locations have a state.",
      "5 state: A US work location needs a state, like NY.",
    ]);
  });

  it("needs every value for a new person when there are no defaults", () => {
    const bare: ImportContext = {
      me: ctx.me,
      people: ctx.people,
      teams: ctx.teams,
      clients: ctx.clients,
      projects: ctx.projects,
      shifts: ctx.shifts,
    };
    expect(errorsOf("email\nnew@acme.test\n", bare)).toEqual([
      "2 name: The name is missing.",
      "2 manager_email: The manager's email is missing.",
      "2 country: The country is missing.",
      "2 timezone: The time zone is missing.",
    ]);
  });

  it("catches the same email twice and deactivated people", () => {
    expect(errorsOf("email,name\nnew@acme.test,A\nNEW@acme.test,B\ngone@acme.test,Gone\n")).toEqual(
      [
        "3 email: new@acme.test is also on row 2.",
        "4 email: gone@acme.test is deactivated. Reactivate them on the People page first.",
      ],
    );
  });

  it("checks managers across the file and the org", () => {
    expect(
      errorsOf(
        "email,name,role,manager_email\n" +
          "a@acme.test,A,employee,nobody@acme.test\n" +
          "b@acme.test,B,employee,gone@acme.test\n" +
          "c@acme.test,C,employee,eli@acme.test\n" +
          "d@acme.test,D,employee,a@acme.test\n" +
          "e@acme.test,E,manager,e@acme.test\n",
      ),
    ).toEqual([
      "2 manager_email: No one with email nobody@acme.test is in this file or in your organisation.",
      "3 manager_email: gone@acme.test is deactivated, so they can't be a manager.",
      "4 manager_email: eli@acme.test is an employee. A manager must be a manager, admin or owner.",
      "5 manager_email: a@acme.test (row 2) is an employee. A manager must be a manager, admin or owner.",
      "6 manager_email: A person can't be their own manager.",
    ]);
  });

  it("lets a new manager in the file manage others, and applies managers first", () => {
    const p = people(
      "email,name,role,manager_email\n" +
        "rep@acme.test,Rep,employee,boss@acme.test\n" +
        "eli@acme.test,,,boss@acme.test\n" +
        "boss@acme.test,Boss,manager,bigboss@acme.test\n" +
        "bigboss@acme.test,Big Boss,admin,olga@acme.test\n",
    );
    expect(p.counts.error).toBe(0);
    expect(p.payload?.items.map((i) => ("email" in i ? i.email : ""))).toEqual([
      "bigboss@acme.test",
      "boss@acme.test",
      "rep@acme.test",
      "eli@acme.test",
    ]);
  });

  it("refuses a reporting loop", () => {
    expect(errorsOf("email,manager_email\nada@acme.test,max@acme.test\n")).toEqual([
      "2 manager_email: This makes a reporting loop: ada@acme.test → max@acme.test → ada@acme.test.",
    ]);
  });

  it("keeps the owner's role and doesn't give ownership, or change your own role", () => {
    expect(
      errorsOf(
        "email,role,manager_email\n" +
          "olga@acme.test,admin,\n" +
          "eli@acme.test,owner,\n" +
          "ada@acme.test,manager,\n",
      ),
    ).toEqual([
      "2 role: The owner's role can't be changed here.",
      "3 role: Ownership can't be given by import. Use admin, manager or employee.",
      "4 role: You can't change your own role.",
    ]);
    expect(errorsOf("email,manager_email\nolga@acme.test,max@acme.test\n")).toEqual([
      "2 manager_email: The owner has no manager.",
    ]);
    expect(people("email,name\nolga@acme.test,Olga O.\n").payload?.items[0]).toMatchObject({
      role: "owner",
      manager_email: null,
    });
  });

  it("won't make a manager an employee while people still report to them", () => {
    expect(errorsOf("email,role\nmax@acme.test,employee\n")).toEqual([
      "2 role: 2 people still report to max@acme.test. Give them another manager first.",
    ]);
    const moved =
      "email,role,manager_email\n" +
      "max@acme.test,employee,\n" +
      "erin@acme.test,,ada@acme.test\n" +
      "eli@acme.test,,ada@acme.test\n";
    expect(people(moved).counts).toEqual({ create: 0, update: 3, unchanged: 0, error: 0 });
  });

  it("reads a combined work location and flags one that disagrees", () => {
    const p = people("email,location\nerin@acme.test,US-WA\n");
    expect(p.rows[0]?.changes).toEqual(["work location: IN → US-WA"]);
    expect(errorsOf("email,location,country\nerin@acme.test,US-WA,IN\n")).toEqual([
      "2 country: The country (IN) and the work location (US) disagree.",
    ]);
  });

  it("flags values past the last column", () => {
    expect(errorsOf("email,name\nerin@acme.test,Erin Employee,extra\n")).toEqual([
      "2 null: This row has more values than the header has columns.",
    ]);
  });
});
