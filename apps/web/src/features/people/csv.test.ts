import { describe, expect, it } from "vitest";
import { type InviteDefaults, invitesFromCsv, parseCsv } from "./csv";

const max = "00000000-0000-4000-8000-0000000000b1";
const ada = "00000000-0000-4000-8000-0000000000a1";
const managers = new Map([
  ["manager@acme.test", max],
  ["admin@acme.test", ada],
]);
const defaults: InviteDefaults = {
  role: "employee",
  managerId: max,
  country: "US",
  state: "NY",
  timezone: "America/New_York",
};

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, CRLF and blank lines", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n\n1,2')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["1", "2"],
    ]);
  });
});

describe("invitesFromCsv", () => {
  it("reads rows by header name and fills in the dialog's defaults", () => {
    const { invites, errors } = invitesFromCsv(
      "Name,Email,Manager Email,Country,State,Timezone\n" +
        "Nora New,NORA@acme.test,,,,\n" +
        "Ravi Rao,ravi@acme.test,admin@acme.test,IN,,Asia/Kolkata\n",
      managers,
      defaults,
    );
    expect(errors).toEqual([]);
    expect(invites).toEqual([
      {
        email: "nora@acme.test",
        full_name: "Nora New",
        role: "employee",
        manager_id: max,
        work_country: "US",
        work_state: "NY",
        timezone: "America/New_York",
      },
      {
        email: "ravi@acme.test",
        full_name: "Ravi Rao",
        role: "employee",
        manager_id: ada,
        work_country: "IN",
        work_state: null,
        timezone: "Asia/Kolkata",
      },
    ]);
  });

  it("reports bad rows by line and keeps the good ones", () => {
    const { invites, errors } = invitesFromCsv(
      "email,full_name,manager_email,role\n" +
        "a@acme.test,Ann,nobody@acme.test,\n" +
        "b@acme.test,Bob,,owner\n" +
        "c@acme.test,Cy,,\n" +
        "c@acme.test,Cy again,,\n",
      managers,
      defaults,
    );
    expect(invites.map((i) => i.email)).toEqual(["c@acme.test"]);
    expect(errors.map((e) => e.line)).toEqual([2, 3, 5]);
    expect(errors[0]?.message).toMatch(/nobody@acme.test/);
  });

  it("needs email and name columns", () => {
    expect(invitesFromCsv("email\nx@acme.test", managers, defaults).errors[0]?.line).toBe(1);
  });
});
