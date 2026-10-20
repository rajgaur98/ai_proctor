import { describe, expect, it } from "vitest";
import { parseCsv } from "../features/people/csv";
import { toCsv } from "./csv";

describe("toCsv", () => {
  it("quotes commas, quotes and line breaks, and ends lines with CRLF", () => {
    expect(
      toCsv([
        ["a", "b"],
        ["x, y", 'say "hi"'],
        ["two\nlines", ""],
      ]),
    ).toBe('a,b\r\n"x, y","say ""hi"""\r\n"two\nlines",\r\n');
  });

  it("round-trips through the parser", () => {
    const rows = [
      ["time", "details"],
      ["2026-03-09T23:30:00-04:00", '{"from":"employee","to":"manager"}'],
      ["x", "a, b\r\nc"],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });

  it("defuses spreadsheet formulas", () => {
    expect(toCsv([["=HYPERLINK(1)", "+1", "-1", "@SUM", "\tx", "ok"]])).toBe(
      "'=HYPERLINK(1),'+1,'-1,'@SUM,'\tx,ok\r\n",
    );
  });
});
