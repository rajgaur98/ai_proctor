import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type CsvCell, csvCell, toCsv } from "./csv.ts";

/** A strict RFC 4180 reader (CRLF rows, quoted cells), to check what toCsv writes. */
function parse(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  return rows;
}

describe("csvCell", () => {
  it("leaves plain text alone", () => {
    expect(csvCell("Erin Employee")).toBe("Erin Employee");
    expect(csvCell("7.43")).toBe("7.43");
  });

  it("quotes commas, quotes and line breaks, doubling quotes", () => {
    expect(csvCell("Acme, Inc.")).toBe('"Acme, Inc."');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("a\r\nb")).toBe('"a\r\nb"');
  });

  it("defuses formulas with a leading apostrophe", () => {
    for (const bad of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\rx", " =cmd|' /C calc'!A0"]) {
      expect(csvCell(bad).replace(/^"/, "").startsWith("'")).toBe(true);
    }
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
  });

  it("writes numbers, booleans and empties as they are", () => {
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(0.5)).toBe("0.5");
    expect(csvCell(true)).toBe("true");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(Number.NaN)).toBe("");
  });
});

describe("toCsv", () => {
  it("ends every row with CRLF and writes nothing for no rows", () => {
    expect(toCsv([["a", "b"], ["c"]])).toBe("a,b\r\nc\r\n");
    expect(toCsv([])).toBe("");
  });

  const risky = fc
    .array(fc.constantFrom(..."ab ,\"\r\n=+-@\t'é1".split("")), { maxLength: 12 })
    .map((cs) => cs.join(""));
  const cell: fc.Arbitrary<CsvCell> = fc.oneof(risky, fc.string({ maxLength: 12 }));

  it("reads back to the same cells, formula guard aside", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(cell, { minLength: 1, maxLength: 5 }), { maxLength: 6 }),
        (rows) => {
          const expected = rows.map((r) =>
            r.map((c) => {
              const out = csvCell(c);
              return out.startsWith('"') ? out.slice(1, -1).replace(/""/g, '"') : out;
            }),
          );
          expect(parse(toCsv(rows))).toEqual(expected);
        },
      ),
    );
  });

  it("never lets a text cell start with a formula character", () => {
    fc.assert(
      fc.property(risky, (text) => {
        const [[out]] = [parse(toCsv([[text]]))[0] ?? [""]];
        expect(out).not.toMatch(/^[=+\-@\t\r]/);
        // Nothing but the apostrophe is added, and only when needed.
        expect(out === text || out === `'${text}`).toBe(true);
      }),
    );
  });
});
