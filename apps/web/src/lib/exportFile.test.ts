import { readXlsx } from "@ai-proctor/core";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../features/people/csv";
import {
  activeFilters,
  type ExportTable,
  exportContents,
  exportFilename,
  exportHours,
  exportTime,
  slug,
} from "./exportFile";

const table: ExportTable = {
  sheet: "People",
  header: ["Name", "Note", "Hours"],
  rows: [
    ["Ada, Admin", 'says "hi"', 7.43],
    ["=HYPERLINK(1)", "two\nlines", null],
    ["Zoë", "-1 day", 0],
  ],
};

describe("exportFilename", () => {
  it("is <page>-all-<date> without filters", () => {
    expect(exportFilename("people", {}, "csv", "2026-10-31")).toBe("people-all-2026-10-31.csv");
    expect(exportFilename("people", { search: "  " }, "xlsx", "2026-10-31")).toBe(
      "people-all-2026-10-31.xlsx",
    );
  });

  it("puts the filters that are set in the name, in the page's order, made safe", () => {
    expect(
      exportFilename(
        "alerts",
        { kind: "Missed check-ins", employee: "Zoë O'Brien", from: "", status: "Unread" },
        "csv",
        "2026-10-31",
      ),
    ).toBe("alerts-missed-check-ins_zoe-o-brien_unread-2026-10-31.csv");
  });

  it("keeps the filter part short and never ends it with a separator", () => {
    const name = exportFilename("people", { search: "a b ".repeat(40) }, "csv", "2026-10-31");
    expect(name).toMatch(/^people-[a-z0-9_-]+-2026-10-31\.csv$/);
    expect(name.length).toBeLessThanOrEqual("people-".length + 60 + "-2026-10-31.csv".length);
    expect(name).not.toMatch(/[-_]-2026/);
  });

  it("has no path separators or other unsafe characters whatever the filters say", () => {
    const name = exportFilename("report", { team: "../../etc/passwd", to: "a\\b:c*?" }, "csv", "d");
    expect(name).toBe("report-etc-passwd_a-b-c-d.csv");
  });
});

describe("helpers", () => {
  it("slug keeps letters and digits", () => {
    expect(slug("Ops — North (EU) 2")).toBe("ops-north-eu-2");
    expect(slug("—")).toBe("");
  });

  it("activeFilters drops filters that aren't set", () => {
    expect(activeFilters({ a: "", b: "x", c: " " })).toEqual({ b: "x" });
  });

  it("exportHours is the timesheet export's decimal hours, as a number", () => {
    expect(exportHours(26760)).toBe(7.43);
    expect(exportHours(0)).toBe(0);
  });

  it("exportTime is ISO 8601 with the zone's offset, and empty for none", () => {
    expect(exportTime("2026-03-09T12:30:00Z", "America/New_York")).toBe(
      "2026-03-09T08:30:00-04:00",
    );
    expect(exportTime(null)).toBe("");
  });
});

describe("exportContents", () => {
  it("writes CSV with the header, quoting and formula guard of the #65 writer", () => {
    const { data, type } = exportContents("csv", table);
    expect(type).toBe("text/csv;charset=utf-8");
    expect(data).toBe(
      'Name,Note,Hours\r\n"Ada, Admin","says ""hi""",7.43\r\n' +
        '\'=HYPERLINK(1),"two\nlines",\r\n' +
        "Zoë,'-1 day,0\r\n",
    );
    expect(parseCsv(data as string)).toEqual([
      ["Name", "Note", "Hours"],
      ["Ada, Admin", 'says "hi"', "7.43"],
      ["'=HYPERLINK(1)", "two\nlines", ""],
      ["Zoë", "'-1 day", "0"],
    ]);
  });

  it("writes an XLSX sheet with the same rows, text as typed and numbers as numbers", () => {
    const { data, type } = exportContents("xlsx", table);
    expect(type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const sheets = readXlsx(data as Uint8Array);
    expect(sheets.map((s) => s.name)).toEqual(["People"]);
    expect(sheets[0]?.rows.map((row) => row.map((c) => c.value))).toEqual([
      ["Name", "Note", "Hours"],
      ["Ada, Admin", 'says "hi"', 7.43],
      // An empty cell isn't written.
      ["=HYPERLINK(1)", "two\nlines"],
      ["Zoë", "-1 day", 0],
    ]);
  });
});
