import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { csvField, toCsv } from "./csv.ts";

/** A minimal RFC 4180 reader, to check what the writer produced. */
function parse(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  return rows;
}

describe("csvField", () => {
  it("leaves plain text alone", () => {
    expect(csvField("Erin Employee")).toBe("Erin Employee");
    expect(csvField("erin@acme.test")).toBe("erin@acme.test");
  });

  it("quotes commas, quotes and line breaks, doubling quotes", () => {
    expect(csvField("Smith, Jo")).toBe('"Smith, Jo"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("a\nb")).toBe('"a\nb"');
    expect(csvField("a\r\nb")).toBe('"a\r\nb"');
  });

  it("writes empty for null and undefined, and plain numbers and booleans", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
    expect(csvField(3)).toBe("3");
    expect(csvField(-3)).toBe("-3");
    expect(csvField(true)).toBe("true");
  });

  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1", "\n=1", '=HYPERLINK("http://x","y")'])(
    "defuses a formula: %j",
    (text) => {
      expect(csvField(text).replace(/^"/, "").startsWith("'")).toBe(true);
    },
  );

  it("only guards the start of the text", () => {
    expect(csvField("a=b")).toBe("a=b");
    expect(csvField("x-ray")).toBe("x-ray");
  });

  it("guards and quotes together", () => {
    expect(csvField('=A1,"b"')).toBe(`"'=A1,""b"""`);
  });
});

describe("toCsv", () => {
  it("ends every record with CRLF", () => {
    expect(toCsv([["a", "b"], ["c"]])).toBe("a,b\r\nc\r\n");
    expect(toCsv([])).toBe("");
  });

  it("round-trips any text apart from the formula guard", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.string({ unit: "binary" }), { minLength: 1, maxLength: 5 }), {
          minLength: 1,
          maxLength: 5,
        }),
        (rows) => {
          const unguarded = (s: string) => (/^[=+\-@\t\r\n]/.test(s) ? `'${s}` : s);
          expect(parse(toCsv(rows))).toEqual(rows.map((r) => r.map(unguarded)));
        },
      ),
    );
  });
});
