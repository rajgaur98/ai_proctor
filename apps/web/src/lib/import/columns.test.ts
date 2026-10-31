import { describe, expect, it } from "vitest";
import { COLUMNS, mapColumns } from "./columns";
import { normalizeHeader } from "./values";

describe("mapColumns", () => {
  it("matches headers whatever their case, spacing or common other name", () => {
    const map = mapColumns("people", [
      "E-mail",
      "Full Name",
      "Reports To",
      "Time Zone",
      "'=Team",
      "Location",
    ]);
    expect(map.errors).toEqual([]);
    expect([...map.index]).toEqual([
      ["email", 0],
      ["name", 1],
      ["manager_email", 2],
      ["timezone", 3],
      ["team", 4],
      ["work_location", 5],
    ]);
  });

  it("lists columns it doesn't know and skips empty header cells", () => {
    const map = mapColumns("clients", ["Client", "", "Notes", "Owner"]);
    expect(map.errors).toEqual([]);
    expect(map.ignored).toEqual(["Notes", "Owner"]);
  });

  it("refuses two columns that mean the same thing, and missing required ones", () => {
    expect(mapColumns("people", ["email", "Manager", "Reports to"]).errors).toEqual([
      'The columns "Manager" and "Reports to" both mean manager_email. Keep one.',
    ]);
    expect(mapColumns("shifts", ["email", "days"]).errors).toEqual([
      "The file needs the start column.",
      "The file needs the end column.",
    ]);
  });

  it("never gives one header two meanings in a kind", () => {
    for (const [kind, specs] of Object.entries(COLUMNS)) {
      const seen = new Map<string, string>();
      for (const spec of specs) {
        for (const name of [spec.name, ...spec.synonyms]) {
          const key = normalizeHeader(name);
          expect(seen.get(key) ?? spec.name, `${kind}: ${name}`).toBe(spec.name);
          seen.set(key, spec.name);
        }
      }
    }
  });
});
