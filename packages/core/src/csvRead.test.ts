import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { toCsv } from "./csv.ts";
import { CSV_IMPORT_MAX_ROWS, detectDelimiter, readCsv, unguardCell } from "./csvRead.ts";

function table(text: string, options?: Parameters<typeof readCsv>[1]) {
  const result = readCsv(text, options);
  if (!result.ok) throw new Error(result.error);
  return result.table;
}

describe("readCsv", () => {
  it("reads quotes, doubled quotes, commas and line breaks inside quotes", () => {
    const t = table('name,note\r\n"Doe, Jane","said ""hi""\r\nthen left"\r\nBob,plain\r\n');
    expect(t.header).toEqual(["name", "note"]);
    expect(t.rows).toEqual([
      { row: 2, cells: ["Doe, Jane", 'said "hi"\r\nthen left'] },
      { row: 3, cells: ["Bob", "plain"] },
    ]);
  });

  it("drops a byte order mark and takes LF, CRLF and lone CR", () => {
    const t = table("﻿a,b\n1,2\r\n3,4\r5,6");
    expect(t.header).toEqual(["a", "b"]);
    expect(t.rows.map((r) => r.cells)).toEqual([
      ["1", "2"],
      ["3", "4"],
      ["5", "6"],
    ]);
  });

  it("skips blank rows but numbers rows as a spreadsheet does", () => {
    const t = table("\n a , b \n\n1,2\n , \n3,4\n\n");
    expect(t.header).toEqual([" a ", " b "]);
    expect(t.rows.map((r) => r.row)).toEqual([4, 6]);
  });

  it("numbers a row after a multi-line cell by records, not lines", () => {
    const t = table('a\n"x\ny"\nz\n');
    expect(t.rows).toEqual([
      { row: 2, cells: ["x\ny"] },
      { row: 3, cells: ["z"] },
    ]);
  });

  it("keeps text after a closing quote and quotes inside unquoted cells", () => {
    expect(table('a,b\n"ab"c,d"e\n').rows[0]?.cells).toEqual(["abc", 'd"e']);
  });

  it("keeps ragged rows as they are", () => {
    expect(table("a,b,c\n1\n1,2,3,4\n").rows.map((r) => r.cells)).toEqual([
      ["1"],
      ["1", "2", "3", "4"],
    ]);
  });

  it("reads semicolon and tab files from the header row", () => {
    expect(detectDelimiter("email;name\nx,y")).toBe(";");
    expect(detectDelimiter("email\tname\n")).toBe("\t");
    expect(detectDelimiter('"a;b",c')).toBe(",");
    expect(detectDelimiter("email")).toBe(",");
    const t = table('email;name\r\na@x.test;"Doe; Jane"\r\n');
    expect(t.delimiter).toBe(";");
    expect(t.rows[0]?.cells).toEqual(["a@x.test", "Doe; Jane"]);
  });

  it("explains an empty file, a header alone and a quote that never closes", () => {
    expect(readCsv("")).toEqual({ ok: false, error: "The file is empty." });
    expect(readCsv(" , \n\n")).toEqual({ ok: false, error: "The file is empty." });
    expect(readCsv("email,name\r\n")).toEqual({
      ok: false,
      error: "The file has a header row but no data rows.",
    });
    expect(readCsv('a,b\n1,2\n"open,3\n')).toEqual({
      ok: false,
      error: "A quoted value that starts on row 3 never ends.",
    });
  });

  it("refuses more than 5,000 data rows", () => {
    expect(CSV_IMPORT_MAX_ROWS).toBe(5000);
    const rows = (n: number) => `email\n${"a@x.test\n".repeat(n)}`;
    expect(readCsv(rows(5000)).ok).toBe(true);
    expect(readCsv(rows(5001))).toEqual({
      ok: false,
      error: "The file has 5,001 rows; the limit is 5,000. Split it into smaller files.",
    });
    expect(readCsv(rows(3), { maxRows: 2 }).ok).toBe(false);
  });
});

describe("unguardCell", () => {
  it("takes off the apostrophe toCsv puts before formula-like text", () => {
    expect(unguardCell("'=SUM(A1)")).toBe("=SUM(A1)");
    expect(unguardCell("'+1")).toBe("+1");
    expect(unguardCell("' -2")).toBe(" -2");
    expect(unguardCell("'@x")).toBe("@x");
    expect(unguardCell("'\tx")).toBe("\tx");
  });

  it("leaves every other apostrophe alone", () => {
    expect(unguardCell("O'Brien")).toBe("O'Brien");
    expect(unguardCell("'quoted'")).toBe("'quoted'");
    expect(unguardCell("=raw")).toBe("=raw");
  });
});

describe("round trip with toCsv (#65's writer)", () => {
  // Any text, including quotes, separators, line breaks and formula starts. A cell that
  // itself starts with an apostrophe before formula-like text is the one value the guard
  // can't tell apart, so it is left out.
  const cell = fc
    .string({
      unit: fc.constantFrom(
        "a",
        "Z",
        " ",
        ",",
        '"',
        "\r",
        "\n",
        "\t",
        "=",
        "+",
        "-",
        "@",
        "'",
        "é",
        "😀",
      ),
    })
    .filter((s) => !/^'(?:\s*[=+\-@]|[\t\r])/.test(s));
  // Blank rows are skipped on read, so every row has a non-blank cell.
  const csvTable = fc.integer({ min: 1, max: 5 }).chain((width) =>
    fc.array(
      fc
        .array(cell, { minLength: width, maxLength: width })
        .filter((r) => r.some((c) => c.trim() !== "")),
      { minLength: 2, maxLength: 20 },
    ),
  );

  it("reads back exactly what it wrote", () => {
    fc.assert(
      fc.property(csvTable, (rows) => {
        const t = table(toCsv(rows), { delimiter: "," });
        const read = [t.header, ...t.rows.map((r) => r.cells)].map((r) => r.map(unguardCell));
        expect(read).toEqual(rows);
        expect(t.rows.map((r) => r.row)).toEqual(rows.slice(1).map((_, i) => i + 2));
      }),
      { numRuns: 500 },
    );
  });

  it("reads the same with a byte order mark and LF line ends", () => {
    fc.assert(
      fc.property(
        csvTable.filter((rows) => rows.every((r) => r.every((c) => !/[\r\n]/.test(c)))),
        (rows) => {
          const text = `﻿${toCsv(rows).replace(/\r\n/g, "\n")}`;
          const t = table(text, { delimiter: "," });
          expect([t.header, ...t.rows.map((r) => r.cells)].map((r) => r.map(unguardCell))).toEqual(
            rows,
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});
