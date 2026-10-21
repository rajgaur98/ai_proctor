import { describe, expect, it } from "vitest";
import { columnName, readXlsx, XLSX_MAX_ROWS, xlsxWorkbook, xmlText } from "./xlsx.ts";
import { readZip } from "./zip.ts";

const parts = (bytes: Uint8Array) =>
  new Map(readZip(bytes).map((e) => [e.name, new TextDecoder().decode(e.data)]));

describe("xlsxWorkbook", () => {
  const book = xlsxWorkbook([
    {
      name: "Per day",
      rows: [
        [
          { value: "Name", style: { bold: true } },
          { value: "Hours", style: { bold: true } },
        ],
        ["Erin", { value: 7.43, style: { hours: true } }],
        ["Lucas", { value: 9, style: { hours: true, highlight: true } }],
      ],
      widths: [20, 10],
      freezeHeader: true,
    },
    { name: "Weekly totals", rows: [["x"]] },
  ]);

  it("has the parts a spreadsheet needs, each listed in the content types", () => {
    const p = parts(book);
    expect([...p.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
    ]);
    const types = p.get("[Content_Types].xml") ?? "";
    for (const name of [
      "/xl/workbook.xml",
      "/xl/styles.xml",
      "/xl/worksheets/sheet1.xml",
      "/xl/worksheets/sheet2.xml",
    ]) {
      expect(types).toContain(`PartName="${name}"`);
    }
    expect(p.get("_rels/.rels")).toContain('Target="xl/workbook.xml"');
    expect(p.get("xl/_rels/workbook.xml.rels")).toContain('Target="worksheets/sheet2.xml"');
    expect(p.get("xl/_rels/workbook.xml.rels")).toContain('Target="styles.xml"');
    expect(p.get("xl/workbook.xml")).toContain('<sheet name="Per day" sheetId="1" r:id="rId1"/>');
  });

  it("writes widths and a frozen header row", () => {
    const sheet = parts(book).get("xl/worksheets/sheet1.xml") ?? "";
    expect(sheet).toContain('<col min="1" max="1" width="20" customWidth="1"/>');
    expect(sheet).toContain('state="frozen"');
  });

  it("reads back with values and styles", () => {
    const [day, weekly] = readXlsx(book);
    expect(day?.name).toBe("Per day");
    expect(weekly?.name).toBe("Weekly totals");
    expect(day?.rows.map((r) => r.map((c) => c.value))).toEqual([
      ["Name", "Hours"],
      ["Erin", 7.43],
      ["Lucas", 9],
    ]);
    expect(day?.rows[0]?.[0]?.style).toEqual({ bold: true, hours: false, highlight: false });
    expect(day?.rows[1]?.[1]?.style).toEqual({ bold: false, hours: true, highlight: false });
    expect(day?.rows[2]?.[1]?.style).toEqual({ bold: false, hours: true, highlight: true });
    expect(day?.rows[2]?.[0]?.style.highlight).toBe(false);
  });

  it("writes text as inline strings, never as formulas, exactly as given", () => {
    const evil = ["=SUM(1,2)", "+1", "-2", "@cmd", "\tx", 'a & <b> "c"'];
    const sheet = readXlsx(xlsxWorkbook([{ name: "S", rows: [evil] }]))[0];
    expect(sheet?.rows[0]?.map((c) => c.value)).toEqual(evil);
    const xml = parts(xlsxWorkbook([{ name: "S", rows: [evil] }])).get("xl/worksheets/sheet1.xml");
    expect(xml).not.toContain("<f>");
    expect(xml?.match(/t="inlineStr"/g)).toHaveLength(evil.length);
  });

  it("drops characters XML can't carry and keeps the rest", () => {
    expect(xmlText("a\u0000b\u0007c\td\ne\rf")).toBe("abc\td\ne\rf");
    expect(xmlText("x\ud800y")).toBe("xy");
    expect(xmlText("emoji 😀 ok")).toBe("emoji 😀 ok");
    expect(xmlText('<&>"')).toBe("&lt;&amp;&gt;&quot;");
  });

  it("leaves empty cells out and skips columns", () => {
    const sheet = readXlsx(
      xlsxWorkbook([{ name: "S", rows: [["a", null, undefined, Number.NaN, "e"]] }]),
    )[0];
    expect(sheet?.rows[0]?.map((c) => c.value)).toEqual(["a", null, null, null, "e"]);
  });

  it("refuses bad or repeated sheet names, no sheets, and too many rows", () => {
    expect(() => xlsxWorkbook([])).toThrow();
    expect(() => xlsxWorkbook([{ name: "a/b", rows: [] }])).toThrow(/sheet name/);
    expect(() => xlsxWorkbook([{ name: "x".repeat(32), rows: [] }])).toThrow(/sheet name/);
    expect(() =>
      xlsxWorkbook([
        { name: "Same", rows: [] },
        { name: "same", rows: [] },
      ]),
    ).toThrow(/sheet name/);
    const rows = Array.from({ length: XLSX_MAX_ROWS + 1 }, () => []);
    expect(() => xlsxWorkbook([{ name: "Big", rows }])).toThrow(/too many rows/);
  });
});

describe("columnName", () => {
  it("counts like a spreadsheet", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual([
      "A",
      "B",
      "Z",
      "AA",
      "AB",
      "AZ",
      "BA",
      "ZZ",
      "AAA",
    ]);
  });
});
