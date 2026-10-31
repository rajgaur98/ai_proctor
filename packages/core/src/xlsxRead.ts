// An XLSX reader for imports (#256), without a library: the first sheet of a workbook
// Excel, LibreOffice, Numbers or Google Sheets saved, as rows of text, the same table
// readCsv gives. xlsx.ts's readXlsx only reads back what our own writer made (stored
// entries, inline strings); this reads what spreadsheets write:
//   - ZIP entries stored or deflated (DecompressionStream "deflate-raw": browsers, Node
//     and Deno have it), each checked against its CRC;
//   - shared strings (rich text runs joined, phonetic hints left out) and inline strings;
//   - numbers as a spreadsheet shows them in General (at most 15 significant digits);
//   - date and time cells (built-in date formats, or custom formats with date or time
//     parts) from Excel serials: "2026-10-31", "09:30", "2026-10-31 09:30", in the
//     workbook's 1900 or 1904 date system;
//   - booleans as TRUE / FALSE, formula results as their cached value, errors as shown.
// Merged cells, hidden rows and other sheets are not read. A file over 50 MB unpacked is
// refused before anything is inflated.
import { CSV_IMPORT_MAX_ROWS, type CsvReadResult, type CsvRow, tableOf } from "./csvRead.ts";
import { crc32 } from "./zip.ts";

const MAX_UNPACKED = 50 * 1024 * 1024;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const LOCAL = 0x04034b50;

class XlsxError extends Error {}

interface Entry {
  name: string;
  method: number;
  crc: number;
  size: number;
  packed: number;
  offset: number;
}

function entries(bytes: Uint8Array): Map<string, Entry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 0xffff; i--) {
    if (view.getUint32(i, true) === END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new XlsxError("The file isn't an Excel workbook (.xlsx).");
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const out = new Map<string, Entry>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== CENTRAL) {
      throw new XlsxError("The workbook is damaged.");
    }
    const nameLength = view.getUint16(p + 28, true);
    const entry: Entry = {
      name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength)),
      method: view.getUint16(p + 10, true),
      crc: view.getUint32(p + 16, true),
      packed: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      offset: view.getUint32(p + 42, true),
    };
    total += entry.size;
    if (total > MAX_UNPACKED) throw new XlsxError("The workbook is too large to import.");
    out.set(entry.name, entry);
    p += 46 + nameLength + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unpack(bytes: Uint8Array, entry: Entry): Promise<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const o = entry.offset;
  if (o + 30 > bytes.length || view.getUint32(o, true) !== LOCAL) {
    throw new XlsxError("The workbook is damaged.");
  }
  const start = o + 30 + view.getUint16(o + 26, true) + view.getUint16(o + 28, true);
  const raw = bytes.subarray(start, start + entry.packed);
  let data: Uint8Array;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8) {
    try {
      data = await inflate(raw);
    } catch {
      throw new XlsxError("The workbook is damaged.");
    }
  } else throw new XlsxError("The workbook uses a compression this reader doesn't know.");
  if (data.length !== entry.size || crc32(data) !== entry.crc) {
    throw new XlsxError("The workbook is damaged.");
  }
  return new TextDecoder().decode(data);
}

/** XML character data: the five named entities and numeric ones. */
export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|quot|apos|amp);/g, (_, e: string) => {
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    if (e === "amp") return "&";
    const code = e.startsWith("#x") ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

function attrs(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) {
    // Namespace prefixes dropped, except a relationship id, which is always "r:id".
    const name = m[1] ?? "";
    const local = name.replace(/^\w+:/, "");
    out.set(local === "id" && name !== local ? "r:id" : local, unescapeXml(m[2] ?? ""));
  }
  return out;
}

// Elements with or without a namespace prefix (<x:row>, as some libraries write).
const tag = (name: string) => `(?:\\w+:)?${name}`;

/** The text of a shared or inline string: every <t>, outside phonetic hints (<rPh>). */
function stringText(xml: string): string {
  const plain = xml.replace(new RegExp(`<${tag("rPh")}\\b[\\s\\S]*?</${tag("rPh")}>`, "g"), "");
  let out = "";
  for (const m of plain.matchAll(
    new RegExp(`<${tag("t")}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag("t")}>`, "g"),
  )) {
    out += unescapeXml(m[1] ?? "");
  }
  return out;
}

type DateKind = "date" | "time" | "datetime";

// Built-in number formats that are dates or times (ECMA-376 18.8.30).
const BUILT_IN: Record<number, DateKind> = {
  14: "date",
  15: "date",
  16: "date",
  17: "date",
  18: "time",
  19: "time",
  20: "time",
  21: "time",
  22: "datetime",
  45: "time",
  46: "time",
  47: "time",
};

/** Whether a custom format code shows a date, a time or both (null: a number). */
export function formatKind(code: string): DateKind | null {
  const bare = code
    .split(";")[0]
    ?.replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[(?!h\]|hh\]|m\]|mm\]|s\]|ss\])[^\]]*\]/gi, "")
    .toLowerCase();
  if (!bare) return null;
  const date = /[yd]/.test(bare);
  const time = /[hs]/.test(bare) || /\[(h|hh|m|mm|s|ss)\]/.test(bare);
  // "m" alone is a month (with y or d) or minutes (with h or s); with neither, a month.
  if (date && time) return "datetime";
  if (date) return "date";
  if (time) return "time";
  return /m/.test(bare) ? "date" : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** An Excel serial as text: days since 1899-12-30 (or 1904-01-01), fraction of a day. */
export function serialText(serial: number, kind: DateKind, date1904 = false): string {
  const seconds = Math.round(serial * 86_400);
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const at = new Date(epoch + seconds * 1000);
  const day = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  const s = at.getUTCSeconds();
  const time = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}${s ? `:${pad(s)}` : ""}`;
  if (kind === "date") return day;
  if (kind === "time") return time;
  return `${day} ${time}`;
}

/** A number as General shows it: integers as they are, others to 15 significant digits. */
function numberText(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(15)));
}

/** 0-based column of a cell reference ("B12" -> 1), or null. */
function columnOf(ref: string | undefined): number | null {
  const letters = ref?.match(/^([A-Z]+)\d*$/i)?.[1]?.toUpperCase();
  if (!letters) return null;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Resolves a relationship target against the folder of the part that names it. */
function partPath(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

async function sheetRows(bytes: Uint8Array): Promise<CsvRow[]> {
  const zip = entries(bytes);
  const read = async (name: string) => {
    const e = zip.get(name);
    return e ? unpack(bytes, e) : null;
  };
  const workbook = await read("xl/workbook.xml");
  if (workbook === null) throw new XlsxError("The file isn't an Excel workbook (.xlsx).");
  const date1904 = /<(?:\w+:)?workbookPr\b[^>]*\bdate1904\s*=\s*"(1|true)"/.test(workbook);
  const first = workbook.match(new RegExp(`<${tag("sheet")}\\b([^>]*)/?>`));
  const rid = first ? attrs(first[1] ?? "").get("r:id") : undefined;
  if (!rid) throw new XlsxError("The workbook has no sheets.");
  const rels = (await read("xl/_rels/workbook.xml.rels")) ?? "";
  let target: string | undefined;
  for (const m of rels.matchAll(new RegExp(`<${tag("Relationship")}\\b([^>]*)/?>`, "g"))) {
    const a = attrs(m[1] ?? "");
    if (a.get("Id") === rid) target = a.get("Target");
  }
  const sheet = target ? await read(partPath("xl/workbook.xml", target)) : null;
  if (sheet === null) throw new XlsxError("The workbook's first sheet is missing.");

  const shared = [
    ...((await read("xl/sharedStrings.xml")) ?? "").matchAll(
      new RegExp(`<${tag("si")}\\b[^>]*>([\\s\\S]*?)</${tag("si")}>|<${tag("si")}\\b[^>]*/>`, "g"),
    ),
  ].map((m) => stringText(m[1] ?? ""));

  const styles = (await read("xl/styles.xml")) ?? "";
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(new RegExp(`<${tag("numFmt")}\\b([^>]*)/?>`, "g"))) {
    const a = attrs(m[1] ?? "");
    custom.set(Number(a.get("numFmtId")), a.get("formatCode") ?? "");
  }
  const xfBlock =
    styles.match(new RegExp(`<${tag("cellXfs")}\\b[^>]*>([\\s\\S]*?)</${tag("cellXfs")}>`))?.[1] ??
    "";
  const kinds = [...xfBlock.matchAll(new RegExp(`<${tag("xf")}\\b([^>]*?)/?>`, "g"))].map((m) => {
    const id = Number(attrs(m[1] ?? "").get("numFmtId") ?? 0);
    const code = custom.get(id);
    return code !== undefined ? formatKind(code) : (BUILT_IN[id] ?? null);
  });

  const rows: CsvRow[] = [];
  let rowNumber = 0;
  const rowRe = new RegExp(`<${tag("row")}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag("row")}>)`, "g");
  const cellRe = new RegExp(`<${tag("c")}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag("c")}>)`, "g");
  const valueRe = new RegExp(`<${tag("v")}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag("v")}>`);
  const inlineRe = new RegExp(`<${tag("is")}\\b[^>]*>([\\s\\S]*?)</${tag("is")}>`);
  for (const row of sheet.matchAll(rowRe)) {
    const r = Number(attrs(row[1] ?? "").get("r"));
    rowNumber = Number.isInteger(r) && r > rowNumber ? r : rowNumber + 1;
    const cells: string[] = [];
    let col = -1;
    for (const c of (row[2] ?? "").matchAll(cellRe)) {
      const a = attrs(c[1] ?? "");
      col = columnOf(a.get("r")) ?? col + 1;
      const body = c[2] ?? "";
      const v = body.match(valueRe)?.[1];
      const type = a.get("t") ?? "n";
      let text = "";
      if (type === "s") text = shared[Number(v)] ?? "";
      else if (type === "inlineStr") text = stringText(body.match(inlineRe)?.[1] ?? "");
      else if (v === undefined) text = "";
      else if (type === "b") text = v.trim() === "1" ? "TRUE" : "FALSE";
      else if (type === "str" || type === "e") text = unescapeXml(v);
      else if (type === "d")
        text = unescapeXml(v)
          .replace("T", " ")
          .replace(/(:\d\d)\.\d+$/, "$1");
      else {
        const kind = kinds[Number(a.get("s") ?? 0)] ?? null;
        const n = Number(v);
        text = kind && Number.isFinite(n) ? serialText(n, kind, date1904) : numberText(v.trim());
      }
      while (cells.length < col) cells.push("");
      cells[col] = text;
    }
    rows.push({ row: rowNumber, cells });
  }
  return rows;
}

/** The first sheet of an .xlsx file as a table, with readCsv's checks and messages. */
export async function readXlsxTable(
  bytes: Uint8Array,
  options: { maxRows?: number } = {},
): Promise<CsvReadResult> {
  try {
    const rows = await sheetRows(bytes);
    return tableOf(rows, options.maxRows ?? CSV_IMPORT_MAX_ROWS, ",");
  } catch (e) {
    if (e instanceof XlsxError) return { ok: false, error: e.message };
    return { ok: false, error: "The workbook couldn't be read." };
  }
}
