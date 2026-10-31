// Teams, clients and projects imports.
import { describe, expect, it } from "vitest";
import { ctx } from "./fixture.test-helper";
import { previewImport } from "./preview";

const errorsOf = (kind: "teams" | "clients" | "projects", csv: string) =>
  previewImport(kind, csv, ctx).rows.flatMap((r) =>
    r.errors.map((e) => `${r.row} ${e.field}: ${e.message}`),
  );

describe("teams import", () => {
  it("creates teams, adds and moves members, and matches names in any case", () => {
    const p = previewImport(
      "teams",
      "Team,Members\nEngineering,eli@acme.test\nsales,erin@acme.test; eli@acme.test\nSUPPORT,\n",
      ctx,
    );
    expect(p.rows.map((r) => [r.key, r.status, r.changes])).toEqual([
      ["Engineering", "create", []],
      ["sales", "error", []],
      ["SUPPORT", "unchanged", []],
    ]);
    expect(p.rows[1]?.errors).toEqual([
      {
        field: "members",
        message: 'eli@acme.test is also in "Engineering" on row 2. A person can be in one team.',
      },
    ]);
    const ok = previewImport("teams", "team,members\nsales,erin@acme.test; eli@acme.test\n", ctx);
    expect(ok.rows[0]?.changes).toEqual([
      "adds eli@acme.test",
      "moves erin@acme.test from Support",
    ]);
    expect(ok.payload).toEqual({
      kind: "teams",
      items: [
        {
          rows: [2],
          action: "update",
          name: "Sales",
          members: ["erin@acme.test", "eli@acme.test"],
        },
      ],
    });
  });

  it("explains missing names, repeats, long names and unknown people", () => {
    expect(
      errorsOf(
        "teams",
        `team,members\n,eli@acme.test\nOps,\nops,\n${"x".repeat(81)},\nQA,"nobody@acme.test, gone@acme.test"\n`,
      ),
    ).toEqual([
      "2 team: The team name is missing.",
      '4 team: The team "ops" is also on row 3.',
      "5 team: The team name is longer than 80 characters.",
      "6 members: nobody@acme.test isn't in your organisation. Import people first.",
      "6 members: gone@acme.test is deactivated.",
    ]);
  });
});

describe("clients import", () => {
  it("creates new clients, updates archived, and leaves the rest", () => {
    const p = previewImport(
      "clients",
      "Client Name,Status\nGlobex,\nold client,active\nACME CORP,no\n",
      ctx,
    );
    // "Status" isn't a column, so archived isn't read from it.
    expect(p.ignoredColumns).toEqual(["Status"]);
    expect(p.rows.map((r) => r.status)).toEqual(["create", "unchanged", "unchanged"]);
    const q = previewImport("clients", "name,archived\nGlobex,\nold client,active\n", ctx);
    expect(q.rows.map((r) => [r.status, r.changes])).toEqual([
      ["create", []],
      ["update", ["makes it active"]],
    ]);
    expect(q.payload).toEqual({
      kind: "clients",
      items: [
        { rows: [2], action: "create", name: "Globex", archived: false },
        { rows: [3], action: "update", name: "Old Client", archived: false },
      ],
    });
  });

  it("explains missing names, repeats and bad yes/no values", () => {
    expect(errorsOf("clients", "name,archived\n,yes\nGlobex,\nglobex  ,\nInitech,maybe\n")).toEqual(
      [
        "2 name: The client name is missing.",
        '4 name: The client "globex" is also on row 3.',
        '5 archived: "maybe" should be yes, no, archived or active.',
      ],
    );
  });
});

describe("projects import", () => {
  it("matches on client and name, keeps empty cells, and adds members", () => {
    const p = previewImport(
      "projects",
      "Project,Client,Billable,Archived,Members\n" +
        "website,acme corp,,,eli@acme.test\n" +
        "Website,,,,\n" +
        "Internal,,non-billable,,\n",
      ctx,
    );
    expect(p.rows.map((r) => [r.key, r.status, r.changes])).toEqual([
      ["acme corp / website", "update", ["adds eli@acme.test"]],
      ["Website", "create", []],
      ["Internal", "unchanged", []],
    ]);
    expect(p.payload).toEqual({
      kind: "projects",
      items: [
        {
          rows: [2],
          action: "update",
          name: "Website",
          client: "Acme Corp",
          billable: true,
          archived: false,
          members: ["eli@acme.test"],
        },
        {
          rows: [3],
          action: "create",
          name: "Website",
          client: null,
          billable: true,
          archived: false,
          members: [],
        },
      ],
    });
  });

  it("explains unknown clients and people, repeats and bad values", () => {
    expect(
      errorsOf(
        "projects",
        "project,client,billable,members\n" +
          "Apollo,Nope Inc,,\n" +
          "Apollo,,,\n" +
          "apollo,,,\n" +
          "Zeus,,sometimes,nobody@acme.test\n" +
          ",Acme Corp,,\n",
      ),
    ).toEqual([
      '2 client: There\'s no client named "Nope Inc". Import clients first, or leave it empty.',
      '4 project: The project "apollo" is also on row 3.',
      '5 billable: "sometimes" should be yes, no, billable, non-billable, nonbillable or not billable.',
      "5 members: nobody@acme.test isn't in your organisation. Import people first.",
      "6 project: The project name is missing.",
    ]);
  });
});
