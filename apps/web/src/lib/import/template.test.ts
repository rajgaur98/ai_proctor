import type { ImportKind } from "@ai-proctor/contracts";
import { describe, expect, it } from "vitest";
import { ctx } from "./fixture.test-helper";
import { previewImport } from "./preview";
import { importTemplate, templateFileName } from "./template";
import type { ImportContext } from "./types";

// The templates' examples name these people; the team and client are in the fixture.
const examplePeople = ["jane.doe@example.com", "sam.lee@example.com", "manager@example.com"].map(
  (email) => ({
    email,
    full_name: email,
    role: "manager" as const,
    manager_email: "olga@acme.test",
    team: null,
    work_country: "US",
    work_state: "NY",
    timezone: "America/New_York",
    active: true,
  }),
);
const withExamples: ImportContext = { ...ctx, people: [...ctx.people, ...examplePeople] };

describe("import templates", () => {
  it("are a header row and one example row", () => {
    expect(importTemplate("people")).toBe(
      "email,name,role,manager_email,team,country,state,timezone\r\n" +
        "jane.doe@example.com,Jane Doe,employee,manager@example.com,Support,US,NY,America/New_York\r\n",
    );
    expect(importTemplate("shifts")).toBe(
      "email,days,start,end,timezone\r\njane.doe@example.com,Mon-Fri,09:00,17:30,America/New_York\r\n",
    );
    expect(templateFileName("projects")).toBe("ai-proctor-projects-import-template.csv");
  });

  it("import cleanly as they are", () => {
    const kinds: ImportKind[] = ["people", "teams", "clients", "projects", "shifts"];
    for (const kind of kinds) {
      // The people template's example is a new person; the others refer to existing ones.
      const context =
        kind === "people"
          ? {
              ...withExamples,
              people: withExamples.people.filter((p) => p.email !== "jane.doe@example.com"),
            }
          : withExamples;
      const p = previewImport(kind, importTemplate(kind), context);
      expect(p.fileErrors, kind).toEqual([]);
      expect(p.ignoredColumns, kind).toEqual([]);
      expect(
        p.rows.map((r) => r.errors),
        kind,
      ).toEqual([[]]);
    }
  });
});
