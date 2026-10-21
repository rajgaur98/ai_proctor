// A minimal ZIP writer for the XLSX export (TS-20): STORED entries only (no
// compression), each with its CRC-32, so it needs no library and runs the same in the
// browser, Node and the Deno Edge runtime. Timestamps are fixed (1 Jan 1980), so the
// same input always gives the same bytes. No ZIP64: entries and the archive stay under
// 4 GiB and 65535 entries, far above any export.
//
// readZip reads such an archive back (and checks every CRC); tests and the export
// checks use it to look inside a file without a dependency.

export interface ZipEntry {
  /** Path inside the archive, forward slashes, ASCII. */
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3, as ZIP uses it): crc32("123456789") = 0xcbf43926. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const VERSION = 20; // 2.0
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

/** The archive: a local header and the bytes of each entry, then the central directory. */
export function zipStored(entries: ZipEntry[]): Uint8Array {
  if (entries.length > MAX_ENTRIES) throw new Error("zip: too many entries");
  const encoder = new TextEncoder();
  const names = entries.map((e) => encoder.encode(e.name));
  const crcs = entries.map((e) => crc32(e.data));
  let localSize = 0;
  let centralSize = 0;
  entries.forEach((e, i) => {
    localSize += 30 + (names[i] as Uint8Array).length + e.data.length;
    centralSize += 46 + (names[i] as Uint8Array).length;
  });
  if (localSize + centralSize > MAX_SIZE) throw new Error("zip: archive too large");

  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let p = 0;
  entries.forEach((e, i) => {
    const name = names[i] as Uint8Array;
    offsets.push(p);
    view.setUint32(p, LOCAL, true);
    view.setUint16(p + 4, VERSION, true);
    view.setUint16(p + 6, 0, true); // flags
    view.setUint16(p + 8, 0, true); // method: stored
    view.setUint16(p + 10, DOS_TIME, true);
    view.setUint16(p + 12, DOS_DATE, true);
    view.setUint32(p + 14, crcs[i] as number, true);
    view.setUint32(p + 18, e.data.length, true); // compressed size
    view.setUint32(p + 22, e.data.length, true); // uncompressed size
    view.setUint16(p + 26, name.length, true);
    view.setUint16(p + 28, 0, true); // extra field length
    out.set(name, p + 30);
    out.set(e.data, p + 30 + name.length);
    p += 30 + name.length + e.data.length;
  });
  const centralStart = p;
  entries.forEach((e, i) => {
    const name = names[i] as Uint8Array;
    view.setUint32(p, CENTRAL, true);
    view.setUint16(p + 4, VERSION, true); // made by
    view.setUint16(p + 6, VERSION, true); // needed
    view.setUint16(p + 8, 0, true);
    view.setUint16(p + 10, 0, true);
    view.setUint16(p + 12, DOS_TIME, true);
    view.setUint16(p + 14, DOS_DATE, true);
    view.setUint32(p + 16, crcs[i] as number, true);
    view.setUint32(p + 20, e.data.length, true);
    view.setUint32(p + 24, e.data.length, true);
    view.setUint16(p + 28, name.length, true);
    view.setUint16(p + 30, 0, true); // extra
    view.setUint16(p + 32, 0, true); // comment
    view.setUint16(p + 34, 0, true); // disk
    view.setUint16(p + 36, 0, true); // internal attributes
    view.setUint32(p + 38, 0, true); // external attributes
    view.setUint32(p + 42, offsets[i] as number, true);
    out.set(name, p + 46);
    p += 46 + name.length;
  });
  view.setUint32(p, END, true);
  view.setUint16(p + 4, 0, true);
  view.setUint16(p + 6, 0, true);
  view.setUint16(p + 8, entries.length, true);
  view.setUint16(p + 10, entries.length, true);
  view.setUint32(p + 12, p - centralStart, true);
  view.setUint32(p + 16, centralStart, true);
  view.setUint16(p + 20, 0, true); // comment length
  return out;
}

/**
 * The entries of a STORED archive, from its central directory. Throws when the file
 * isn't one: no end record, a compressed entry, a header that disagrees with the
 * directory, or a CRC that doesn't match the bytes.
 */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let end = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 0xffff; i--) {
    if (view.getUint32(i, true) === END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("zip: no end of central directory");
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== CENTRAL) throw new Error("zip: bad central directory");
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 20, true);
    const nameLength = view.getUint16(p + 28, true);
    const extra = view.getUint16(p + 30, true);
    const comment = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength));
    if (method !== 0) throw new Error(`zip: ${name} is compressed`);
    if (view.getUint32(offset, true) !== LOCAL) throw new Error(`zip: ${name} has no header`);
    const localName = view.getUint16(offset + 26, true);
    const localExtra = view.getUint16(offset + 28, true);
    if (view.getUint32(offset + 14, true) !== crc || view.getUint32(offset + 22, true) !== size) {
      throw new Error(`zip: ${name} header disagrees with the directory`);
    }
    const start = offset + 30 + localName + localExtra;
    const data = bytes.slice(start, start + size);
    if (crc32(data) !== crc) throw new Error(`zip: ${name} fails its CRC`);
    entries.push({ name, data });
    p += 46 + nameLength + extra + comment;
  }
  return entries;
}
