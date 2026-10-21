import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { crc32, readZip, zipStored } from "./zip.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("crc32", () => {
  it("matches the standard check values", () => {
    expect(crc32(bytes(""))).toBe(0);
    expect(crc32(bytes("123456789"))).toBe(0xcbf43926);
    expect(crc32(bytes("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });
});

describe("zipStored", () => {
  const entries = [
    { name: "a.txt", data: bytes("hello") },
    { name: "dir/b.xml", data: bytes("<x/>") },
    { name: "empty", data: new Uint8Array() },
  ];

  it("writes a local header per entry, then the directory and its end record", () => {
    const zip = zipStored(entries);
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0); // stored
    expect(view.getUint32(14, true)).toBe(crc32(bytes("hello")));
    expect(view.getUint32(18, true)).toBe(5);
    expect(new TextDecoder().decode(zip.subarray(30, 35))).toBe("a.txt");
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 8, true)).toBe(3);
    expect(view.getUint16(end + 10, true)).toBe(3);
    const centralStart = view.getUint32(end + 16, true);
    expect(view.getUint32(centralStart, true)).toBe(0x02014b50);
    expect(centralStart + view.getUint32(end + 12, true)).toBe(end);
  });

  it("reads back what it wrote, and always writes the same bytes", () => {
    const zip = zipStored(entries);
    expect(readZip(zip).map((e) => [e.name, new TextDecoder().decode(e.data)])).toEqual([
      ["a.txt", "hello"],
      ["dir/b.xml", "<x/>"],
      ["empty", ""],
    ]);
    expect(zipStored(entries)).toEqual(zip);
  });

  it("round-trips any entries", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            name: fc.stringMatching(/^[a-z0-9_./-]{1,20}$/),
            data: fc.uint8Array({ maxLength: 300 }),
          }),
          { selector: (e) => e.name, maxLength: 8 },
        ),
        (list) => {
          const back = readZip(zipStored(list));
          expect(back.map((e) => e.name)).toEqual(list.map((e) => e.name));
          expect(back.map((e) => e.data)).toEqual(list.map((e) => e.data));
        },
      ),
    );
  });

  it("readZip refuses a changed byte and a file that isn't a zip", () => {
    const tampered = zipStored(entries);
    tampered[30 + "a.txt".length] = "j".charCodeAt(0); // "hello" -> "jello"
    expect(() => readZip(tampered)).toThrow(/CRC/);
    expect(() => readZip(bytes("not a zip at all, just text"))).toThrow(/end of central/);
  });
});
