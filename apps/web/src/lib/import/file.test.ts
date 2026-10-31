import { xlsxWorkbook } from "@ai-proctor/core";
import { describe, expect, it } from "vitest";
import { ctx } from "./fixture.test-helper";
import { previewImport, previewRead, readImportFile } from "./preview";

describe("readImportFile", () => {
  it("reads .xlsx workbooks (by name or by content) and CSV text", async () => {
    const book = xlsxWorkbook([{ name: "S", rows: [["name"], ["Globex"]] }]);
    for (const name of ["clients.xlsx", "clients.download"]) {
      const read = await readImportFile(name, book);
      expect(read.ok && read.table.rows[0]?.cells).toEqual(["Globex"]);
      expect(previewRead("clients", read, ctx).rows[0]?.status).toBe("create");
    }
    const csv = await readImportFile("c.csv", new TextEncoder().encode("﻿name\nGlobex\n"));
    expect(csv.ok && csv.table.header).toEqual(["name"]);
  });

  it("refuses old and other spreadsheet formats in plain words", async () => {
    expect(await readImportFile("people.xls", new Uint8Array([0xd0, 0xcf]))).toEqual({
      ok: false,
      error: "This reads .xlsx and .csv files. Save the sheet as one of those.",
    });
  });
});

describe("people import limits", () => {
  it("invites at most 500 people in one file", () => {
    const rows = Array.from({ length: 501 }, (_, i) => `p${i}@acme.test,P ${i}`).join("\n");
    const p = previewImport("people", `email,name\n${rows}\n`, ctx);
    expect(p.counts.create).toBe(501);
    expect(p.fileErrors).toEqual([
      "The file invites 501 new people; one import can invite at most 500. Split it into smaller files.",
    ]);
    expect(p.payload).toBeNull();
  });
});
