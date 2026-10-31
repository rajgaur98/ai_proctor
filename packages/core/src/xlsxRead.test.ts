import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { xlsxWorkbook } from "./xlsx.ts";
import { formatKind, readXlsxTable, serialText, unescapeXml } from "./xlsxRead.ts";
import { crc32 } from "./zip.ts";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

async function table(bytes: Uint8Array) {
  const result = await readXlsxTable(bytes);
  if (!result.ok) throw new Error(result.error);
  return result.table;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A ZIP with deflated entries, as spreadsheets save them (zip.ts only writes stored). */
async function zipDeflated(files: Record<string, string>): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = enc.encode(text);
    const packed = await deflate(data);
    const n = enc.encode(name);
    const local = new Uint8Array(30 + n.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(14, crc32(data), true);
    lv.setUint32(18, packed.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    const dir = new Uint8Array(46 + n.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(10, 8, true);
    dv.setUint32(16, crc32(data), true);
    dv.setUint32(20, packed.length, true);
    dv.setUint32(24, data.length, true);
    dv.setUint16(28, n.length, true);
    dv.setUint32(42, offset, true);
    dir.set(n, 46);
    parts.push(local, packed);
    central.push(dir);
    offset += local.length + packed.length;
  }
  const size = central.reduce((s, d) => s + d.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let p = 0;
  for (const part of all) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

// What Excel writes: shared strings, a prefixed namespace, cells without r attributes,
// a custom date format and a sheet that isn't called sheet1.xml.
const excelLike = {
  "xl/workbook.xml":
    '<?xml version="1.0"?><x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:workbookPr/><x:sheets><x:sheet name="People &amp; teams" sheetId="7" r:id="rId3"/></x:sheets></x:workbook>',
  "xl/_rels/workbook.xml.rels":
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="styles.xml"/><Relationship Id="rId3" Type="x" Target="/xl/worksheets/data.xml"/></Relationships>',
  "xl/sharedStrings.xml":
    '<sst count="5" uniqueCount="5"><si><t>email</t></si><si><t>name</t></si><si><t>joined</t></si><si><r><t>Doe, </t></r><r><rPr><b/></rPr><t xml:space="preserve">Jane &#x1F600;</t></r><rPh><t>ドウ</t></rPh></si><si/></sst>',
  "xl/styles.xml":
    '<styleSheet><numFmts count="2"><numFmt numFmtId="170" formatCode="dd/mm/yyyy"/><numFmt numFmtId="171" formatCode="&quot;h&quot;0.00"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="170" applyNumberFormat="1"/><xf numFmtId="171"/></cellXfs></styleSheet>',
  "xl/worksheets/data.xml":
    '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>' +
    '<x:row r="1"><x:c t="s"><x:v>0</x:v></x:c><x:c t="s"><x:v>1</x:v></x:c><x:c t="s"><x:v>2</x:v></x:c><x:c><x:v>1</x:v></x:c></x:row>' +
    '<x:row r="3"><x:c r="A3" t="str"><x:f>LOWER("J@X.TEST")</x:f><x:v>j@x.test</x:v></x:c><x:c r="B3" t="s"><x:v>3</x:v></x:c><x:c r="C3" s="1"><x:v>46326</x:v></x:c><x:c r="D3" s="2"><x:v>7.5</x:v></x:c></x:row>' +
    '<x:row r="4"><x:c r="B4" t="s"><x:v>4</x:v></x:c><x:c r="D4" t="e"><x:v>#DIV/0!</x:v></x:c><x:c r="F4" t="b"><x:v>0</x:v></x:c></x:row>' +
    "</x:sheetData></x:worksheet>",
};

describe("readXlsxTable", () => {
  it("reads what openpyxl saves: deflated, inline and rich strings, dates and times", async () => {
    const t = await table(fixture("openpyxl.xlsx"));
    expect(t.header).toEqual([
      "email",
      "days",
      "start",
      "end",
      "starts on",
      "logged at",
      "hours",
      "active",
      "note",
    ]);
    expect(t.rows).toEqual([
      {
        row: 2,
        cells: [
          "erin@acme.test",
          "Mon-Fri",
          "09:00",
          "17:30",
          "2026-10-31",
          "2026-10-31 09:15",
          "0.3",
          "TRUE",
          "Bold & <plain>",
        ],
      },
      {
        row: 4,
        cells: [
          "lucas@acme.test",
          "Sat",
          "22:00",
          "02:00",
          "1999-12-31",
          "",
          "1234567",
          "FALSE",
          "Zoë 😀",
        ],
      },
    ]);
  });

  it("reads the 1904 date system", async () => {
    expect((await table(fixture("openpyxl-1904.xlsx"))).rows[0]?.cells).toEqual(["2026-01-02"]);
  });

  it("reads what Excel saves: shared strings, prefixes, custom formats, formulas", async () => {
    const t = await table(await zipDeflated(excelLike));
    expect(t.header).toEqual(["email", "name", "joined", "1"]);
    expect(t.rows).toEqual([
      { row: 3, cells: ["j@x.test", "Doe, Jane 😀", "2026-10-31", "7.5"] },
      { row: 4, cells: ["", "", "", "#DIV/0!", "", "FALSE"] },
    ]);
  });

  it("reads back our own writer's workbook", async () => {
    const rows = [
      ["email", "name", "hours"],
      ["a@x.test", "=not a formula", 7.25],
      ["b@x.test", 'Ann <&> "Q"', 12],
    ];
    const t = await table(xlsxWorkbook([{ name: "Sheet", rows }]));
    expect([t.header, ...t.rows.map((r) => r.cells)]).toEqual(
      rows.map((r) => r.map((c) => String(c))),
    );
  });

  it("round-trips any text through our writer", async () => {
    const text = fc
      .string({ unit: fc.constantFrom("a", " ", "<", "&", '"', "'", "é", "😀", "=", "\t") })
      .filter((s) => s.trim() !== "");
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(text, { minLength: 2, maxLength: 2 }), { minLength: 2, maxLength: 8 }),
        async (rows) => {
          const t = await table(xlsxWorkbook([{ name: "S", rows }]));
          expect([t.header, ...t.rows.map((r) => r.cells)]).toEqual(rows);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("explains files that aren't workbooks, damaged ones and too many rows", async () => {
    expect(await readXlsxTable(new TextEncoder().encode("email,name\n"))).toEqual({
      ok: false,
      error: "The file isn't an Excel workbook (.xlsx).",
    });
    const good = await zipDeflated(excelLike);
    const broken = good.slice();
    broken[60] = (broken[60] ?? 0) ^ 0xff;
    expect(await readXlsxTable(broken)).toEqual({ ok: false, error: "The workbook is damaged." });
    expect(await readXlsxTable(good, { maxRows: 1 })).toMatchObject({ ok: false });
  });
});

describe("number formats and serials", () => {
  it("tells dates and times from numbers", () => {
    expect(formatKind("dd/mm/yyyy")).toBe("date");
    expect(formatKind("mmm-yy")).toBe("date");
    expect(formatKind("h:mm AM/PM")).toBe("time");
    expect(formatKind("[h]:mm")).toBe("time");
    expect(formatKind("yyyy-mm-dd hh:mm")).toBe("datetime");
    expect(formatKind('"h"0.00')).toBeNull();
    expect(formatKind("[Red]#,##0.00")).toBeNull();
    expect(formatKind("0%")).toBeNull();
  });

  it("turns serials into dates and times", () => {
    expect(serialText(46326, "date")).toBe("2026-10-31");
    expect(serialText(0.375, "time")).toBe("09:00");
    expect(serialText(0.3754, "time")).toBe("09:00:35");
    expect(serialText(46326.5, "datetime")).toBe("2026-10-31 12:00");
    expect(serialText(0, "date", true)).toBe("1904-01-01");
  });

  it("unescapes named and numeric entities", () => {
    expect(unescapeXml("&lt;a&gt; &amp;amp; &#65;&#x42; &quot;&apos;")).toBe("<a> &amp; AB \"'");
  });
});
