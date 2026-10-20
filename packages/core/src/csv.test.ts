import { describe, expect, it } from "vitest";
import { columnsOf, csvCell, toCsv } from "./csv.ts";

describe("csvCell", () => {
  it("writes plain values as they are", () => {
    expect(csvCell("hello")).toBe("hello");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(-3.5)).toBe("-3.5");
    expect(csvCell(true)).toBe("true");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("quotes commas, quotes and line breaks", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("one\ntwo")).toBe('"one\ntwo"');
    expect(csvCell("one\r\ntwo")).toBe('"one\r\ntwo"');
  });

  it("guards text that a spreadsheet would run as a formula", () => {
    expect(csvCell("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1+1")).toBe("'-1+1");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("\tTab")).toBe("'\tTab");
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
  });

  it("does not guard numbers or text that merely contains those characters", () => {
    expect(csvCell(-1)).toBe("-1");
    expect(csvCell("a=b")).toBe("a=b");
    expect(csvCell("2026-10-20")).toBe("2026-10-20");
  });

  it("writes objects and arrays as JSON", () => {
    expect(csvCell(["a", "b"])).toBe('"[""a"",""b""]"');
    expect(csvCell({ k: 1 })).toBe('"{""k"":1}"');
  });
});

describe("toCsv", () => {
  it("writes a header and a row per object, with CRLF", () => {
    const csv = toCsv(
      ["id", "note"],
      [
        { id: 1, note: "ok" },
        { id: 2, note: "=bad" },
      ],
    );
    expect(csv).toBe("id,note\r\n1,ok\r\n2,'=bad\r\n");
  });

  it("leaves missing keys empty and ignores keys outside the columns", () => {
    expect(toCsv(["a", "b"], [{ a: 1, c: 3 }])).toBe("a,b\r\n1,\r\n");
  });

  it("is just the header for no rows", () => {
    expect(toCsv(["a"], [])).toBe("a\r\n");
  });
});

describe("columnsOf", () => {
  it("takes keys in first-seen order across rows", () => {
    expect(
      columnsOf([
        { a: 1, b: 2 },
        { c: 3, a: 4 },
      ]),
    ).toEqual(["a", "b", "c"]);
    expect(columnsOf([])).toEqual([]);
  });
});
