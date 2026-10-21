// A small XLSX (SpreadsheetML) writer for the timesheet export (TS-20, TS-19). Pure:
// sheets of cells in, the file's bytes out, packed by zip.ts, so the Edge Function and
// the dashboard share it without a library.
//
// What it supports is what the export needs: strings and numbers, a bold style for the
// header and Total rows, the "0.00" number format for decimal hours, one highlight fill
// (overtime, TS-19), column widths and a frozen header row.
//
// Text is always written as an inline string (t="inlineStr"). A spreadsheet never runs
// an inline string as a formula, whatever it starts with, so names and project titles
// (user text) are written exactly as they are, with no CSV-style apostrophe. Characters
// XML 1.0 cannot carry (control characters other than tab, line feed and carriage
// return, and U+FFFE/FFFF and lone surrogates) are dropped.

import { readZip, zipStored } from "./zip.ts";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Excel's limit, header included. */
export const XLSX_MAX_ROWS = 1_048_576;

export interface CellStyle {
  bold?: boolean;
  /** Decimal hours: shown with two decimals ("0.00"). */
  hours?: boolean;
  /** The highlight fill (the dashboard's warning background). */
  highlight?: boolean;
}

export type CellValue = string | number | null | undefined;
export type XlsxCell = CellValue | { value: CellValue; style?: CellStyle };

export interface XlsxSheet {
  /** Up to 31 characters, none of : \ / ? * [ ]; unique in the workbook. */
  name: string;
  rows: XlsxCell[][];
  /** Column widths in characters; columns without one get the default. */
  widths?: number[];
  /** Keep the first row in view while scrolling. */
  freezeHeader?: boolean;
}

/** The dashboard's --warnbg (light theme), as ARGB. */
const HIGHLIGHT_ARGB = "FFFBF3DF";
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// Fast path: nothing outside tab, LF, CR and the ranges XML 1.0 allows in the basic
// plane. Anything else (control characters, U+FFFE/FFFF, surrogates) goes to dropBadXml.
const ONLY_XML = /^[\t\n\r\u0020-\ud7ff\ue000-\ufffd]*$/;

/** Drops what XML 1.0 can't carry: control characters other than tab, LF and CR,
 * U+FFFE and U+FFFF, and lone surrogates (a pair is one code point and is kept). */
function dropBadXml(s: string): string {
  if (ONLY_XML.test(s)) return s;
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const control = c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d;
    if (control || c === 0xfffe || c === 0xffff || (c >= 0xd800 && c <= 0xdfff)) continue;
    out += ch;
  }
  return out;
}

/** Text as XML character data or an attribute value. */
export function xmlText(s: string): string {
  return dropBadXml(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
export function columnName(index: number): string {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function cellParts(cell: XlsxCell): { value: CellValue; style: CellStyle } {
  if (cell !== null && typeof cell === "object")
    return { value: cell.value, style: cell.style ?? {} };
  return { value: cell, style: {} };
}

/** The cell formats in use, in order: index 0 is the plain one every workbook needs. */
class Styles {
  private readonly keys = ["0|0|0"];

  index(style: CellStyle): number {
    const key = `${style.bold ? 1 : 0}|${style.hours ? 1 : 0}|${style.highlight ? 1 : 0}`;
    let i = this.keys.indexOf(key);
    if (i < 0) {
      this.keys.push(key);
      i = this.keys.length - 1;
    }
    return i;
  }

  xml(): string {
    const xfs = this.keys.map((key) => {
      const [bold, hours, fill] = key.split("|");
      // numFmtId 2 is the built-in "0.00"; fontId 1 is bold; fillId 2 is the highlight.
      return `<xf numFmtId="${hours === "1" ? 2 : 0}" fontId="${bold === "1" ? 1 : 0}" fillId="${fill === "1" ? 2 : 0}" borderId="0" xfId="0"${hours === "1" ? ' applyNumberFormat="1"' : ""}${bold === "1" ? ' applyFont="1"' : ""}${fill === "1" ? ' applyFill="1"' : ""}/>`;
    });
    return (
      `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">` +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
      '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      `<fill><patternFill patternType="solid"><fgColor rgb="${HIGHLIGHT_ARGB}"/><bgColor indexed="64"/></patternFill></fill></fills>` +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      "</styleSheet>"
    );
  }
}

function cellXml(ref: string, cell: XlsxCell, styles: Styles): string {
  const { value, style } = cellParts(cell);
  const s = styles.index(style);
  const sAttr = s === 0 ? "" : ` s="${s}"`;
  if (
    value === null ||
    value === undefined ||
    (typeof value === "number" && !Number.isFinite(value))
  ) {
    return s === 0 ? "" : `<c r="${ref}"${sAttr}/>`;
  }
  if (typeof value === "number") return `<c r="${ref}"${sAttr}><v>${value}</v></c>`;
  return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
}

function sheetXml(sheet: XlsxSheet, styles: Styles): string {
  const rows = sheet.rows.map((row, r) => {
    const cells = row.map((cell, c) => cellXml(`${columnName(c)}${r + 1}`, cell, styles)).join("");
    return `<row r="${r + 1}">${cells}</row>`;
  });
  const views = sheet.freezeHeader
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  const widths = (sheet.widths ?? [])
    .map((w, i) =>
      Number.isFinite(w) && w > 0
        ? `<col min="${i + 1}" max="${i + 1}" width="${Math.min(255, Math.round(w * 100) / 100)}" customWidth="1"/>`
        : "",
    )
    .join("");
  return (
    `${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">${views}` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    (widths ? `<cols>${widths}</cols>` : "") +
    `<sheetData>${rows.join("")}</sheetData></worksheet>`
  );
}

const BAD_SHEET_NAME = /[:\\/?*[\]]/;

/** The workbook as .xlsx bytes. Throws on a bad or repeated sheet name, or too many rows. */
export function xlsxWorkbook(sheets: XlsxSheet[]): Uint8Array {
  if (sheets.length === 0) throw new Error("xlsx: a workbook needs a sheet");
  const seen = new Set<string>();
  for (const s of sheets) {
    const key = s.name.toLowerCase();
    if (!s.name || s.name.length > 31 || BAD_SHEET_NAME.test(s.name) || seen.has(key)) {
      throw new Error(`xlsx: bad sheet name ${JSON.stringify(s.name)}`);
    }
    seen.add(key);
    if (s.rows.length > XLSX_MAX_ROWS) throw new Error("xlsx: too many rows");
  }

  const styles = new Styles();
  const sheetParts = sheets.map((s) => sheetXml(s, styles));
  const encoder = new TextEncoder();
  const part = (name: string, xml: string) => ({ name, data: encoder.encode(xml) });

  const contentTypes =
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join("") +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    "</Types>";
  const rootRels =
    `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
    "</Relationships>";
  const workbook =
    `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>` +
    sheets
      .map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join("") +
    "</sheets></workbook>";
  const workbookRels =
    `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
    sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>` +
    "</Relationships>";

  return zipStored([
    part("[Content_Types].xml", contentTypes),
    part("_rels/.rels", rootRels),
    part("xl/workbook.xml", workbook),
    part("xl/_rels/workbook.xml.rels", workbookRels),
    part("xl/styles.xml", styles.xml()),
    ...sheetParts.map((xml, i) => part(`xl/worksheets/sheet${i + 1}.xml`, xml)),
  ]);
}

// Reading back ------------------------------------------------------------------------------

export interface ReadCell {
  value: string | number | null;
  style: Required<CellStyle>;
}
export interface ReadSheet {
  name: string;
  /** Row by row from A1; a missing cell is a null value with no style. */
  rows: ReadCell[][];
}

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * The sheets of a workbook xlsxWorkbook wrote (inline strings and numbers only), for
 * tests and the export checks. Not a general XLSX reader: shared strings, formulas and
 * dates are not read. Throws when a part is missing.
 */
export function readXlsx(bytes: Uint8Array): ReadSheet[] {
  const decoder = new TextDecoder();
  const parts = new Map(readZip(bytes).map((e) => [e.name, decoder.decode(e.data)]));
  const need = (name: string) => {
    const xml = parts.get(name);
    if (xml === undefined) throw new Error(`xlsx: no ${name}`);
    return xml;
  };
  const xfs = [
    ...(need("xl/styles.xml").match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "").matchAll(
      /<xf ([^>]*)\/>/g,
    ),
  ].map((m) => {
    const attr = (k: string) => m[1]?.match(new RegExp(`${k}="(\\d+)"`))?.[1];
    return {
      bold: attr("fontId") === "1",
      hours: attr("numFmtId") === "2",
      highlight: attr("fillId") === "2",
    };
  });
  const plain = { bold: false, hours: false, highlight: false };
  const names = [...need("xl/workbook.xml").matchAll(/<sheet name="([^"]*)"/g)].map((m) =>
    unescapeXml(m[1] ?? ""),
  );
  return names.map((name, i) => {
    const xml = need(`xl/worksheets/sheet${i + 1}.xml`);
    const rows: ReadCell[][] = [];
    for (const row of xml.matchAll(/<row r="(\d+)">([\s\S]*?)<\/row>/g)) {
      const cells: ReadCell[] = [];
      for (const c of (row[2] ?? "").matchAll(
        /<c r="([A-Z]+)\d+"( s="(\d+)")?( t="inlineStr")?(?:\/>|>([\s\S]*?)<\/c>)/g,
      )) {
        const col = columnIndex(c[1] ?? "A");
        while (cells.length < col) cells.push({ value: null, style: plain });
        const style = xfs[Number(c[3] ?? 0)] ?? plain;
        const body = c[5] ?? "";
        const value = c[4]
          ? unescapeXml(body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "")
          : body.match(/<v>([^<]*)<\/v>/)
            ? Number(body.match(/<v>([^<]*)<\/v>/)?.[1])
            : null;
        cells.push({ value, style });
      }
      rows[Number(row[1]) - 1] = cells;
    }
    return { name, rows: Array.from(rows, (r) => r ?? []) };
  });
}
