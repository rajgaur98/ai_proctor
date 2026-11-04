import { describe, expect, it } from "vitest";
import { ctx as base } from "./fixture.test-helper";
import { previewImport } from "./preview";
import { importTemplate } from "./template";

const ctx = {
  ...base,
  holidays: [
    { day: "2026-12-25", name: "Christmas", country: null, state: null },
    { day: "2026-12-25", name: "Christmas Day", country: "US", state: null },
    { day: "2026-03-31", name: "Cesar Chavez Day", country: "US", state: "CA" },
  ],
};
const holidays = (csv: string) => previewImport("holidays", csv, ctx);
const errorsOf = (csv: string) =>
  holidays(csv).rows.flatMap((r) => r.errors.map((e) => `${r.row} ${e.field}: ${e.message}`));

describe("holidays import", () => {
  it("adds new holidays, renames changed ones and leaves identical ones alone", () => {
    const p = holidays(
      "Date,Holiday,Country,State\n" +
        "2026-07-04,Independence Day,US,\n" +
        "2026-12-25,Christmas Day,,\n" +
        "2026-12-25,Christmas Day,us,\n" +
        "Mar 31 2026,Cesar Chavez Day,US,CA\n" +
        "2027-03-31,Chavez Day,US,CA\n",
    );
    expect(p.rows.map((r) => [r.key, r.status])).toEqual([
      ["2026-07-04, US", "create"],
      ["2026-12-25, everyone", "update"],
      ["2026-12-25, US", "unchanged"],
      ["2026-03-31, US CA", "unchanged"],
      ["2027-03-31, US CA", "create"],
    ]);
    expect(p.rows[1]?.changes).toEqual(["renames it from Christmas to Christmas Day"]);
    expect(p.counts).toEqual({ create: 2, update: 1, unchanged: 2, error: 0 });
    expect(p.payload).toEqual({
      kind: "holidays",
      items: [
        {
          rows: [2],
          action: "create",
          day: "2026-07-04",
          name: "Independence Day",
          country: "US",
          state: null,
        },
        {
          rows: [3],
          action: "update",
          day: "2026-12-25",
          name: "Christmas Day",
          country: null,
          state: null,
        },
        {
          rows: [6],
          action: "create",
          day: "2027-03-31",
          name: "Chavez Day",
          country: "US",
          state: "CA",
        },
      ],
    });
  });

  it("reads the place from one location column, and from other header names", () => {
    const p = holidays(
      "Holiday date,Description,Work location\n" +
        "2026-07-04,Independence Day,US-NY\n" +
        "2026-08-15,Independence Day,in\n" +
        "2026-09-01,Everyone's day,\n",
    );
    expect(p.fileErrors).toEqual([]);
    expect(p.payload?.items).toMatchObject([
      { country: "US", state: "NY" },
      { country: "IN", state: null },
      { country: null, state: null },
    ]);
    // location, country and state may be combined when they agree.
    const q = holidays("date,name,location,country,state\n2026-07-04,July 4,US,US,NY\n");
    expect(q.payload?.items).toMatchObject([{ country: "US", state: "NY" }]);
  });

  it("explains missing, wrong and disagreeing values", () => {
    expect(
      errorsOf(
        "date,name,country,state,location\n" +
          ",Nameless date,,,\n" +
          "2026-13-45,Bad date,,,\n" +
          "01/02/2026,Ambiguous,,,\n" +
          "2026-05-01,,,,\n" +
          `2026-05-02,${"x".repeat(81)},,,\n` +
          "2026-05-03,Bad country,Germany,,\n" +
          "2026-05-04,Bad state,US,New York,\n" +
          "2026-05-05,State alone,,NY,\n" +
          "2026-05-06,Non-US state,DE,BY,\n" +
          "2026-05-07,Disagree,IN,,US-NY\n" +
          "2026-05-08,Disagree,,CA,US-NY\n" +
          "2026-05-09,Bad place,,,Atlantis\n",
      ),
    ).toEqual([
      "2 date: The date is missing.",
      '3 date: "2026-13-45" isn\'t a date. Use a date like 2026-10-28.',
      '4 date: "01/02/2026" could be read day-first or month-first. Use a date like 2026-10-28.',
      "5 name: The holiday name is missing.",
      "6 name: The holiday name is longer than 80 characters.",
      '7 country: "Germany" isn\'t a country code. Use two letters, like US or IN.',
      '8 state: "New York" isn\'t a state code. Use two letters, like NY.',
      "9 state: A state needs a country; only US holidays have one.",
      "10 state: Only US holidays have a state.",
      "11 country: The country (IN) and the location (US) disagree.",
      "12 state: The state (CA) and the location (NY) disagree.",
      `13 location: "Atlantis" isn't a work location. Use a country code, with the state for the US, like US-NY or IN.`,
    ]);
  });

  it("refuses a second row for the same date and place, naming the first", () => {
    const p = holidays(
      "date,name,country,state\n" +
        "2026-07-04,Independence Day,US,\n" +
        "2026-07-04,Fourth of July,USA,\n" +
        "2026-07-04,Everyone's,,\n" +
        "2026-07-04,Fourth of July,US,NY\n" +
        "2026-07-04,Again everyone,,\n",
    );
    expect(p.rows.map((r) => r.status)).toEqual(["create", "error", "create", "create", "error"]);
    expect(p.rows[1]?.errors).toEqual([
      { field: null, message: "A holiday for US on 2026-07-04 is also on row 2." },
    ]);
    expect(p.rows[4]?.errors[0]?.message).toBe(
      "A holiday for everyone on 2026-07-04 is also on row 4.",
    );
    expect(p.payload).toBeNull();
  });

  it("needs the date and name columns", () => {
    expect(holidays("date,country\n2026-07-04,US\n").fileErrors).toEqual([
      "The file needs the name column.",
    ]);
  });

  it("works without a calendar in the context", () => {
    const p = previewImport("holidays", "date,name\n2026-07-04,July 4\n", base);
    expect(p.counts.create).toBe(1);
  });

  it("is a file with nothing to change when every holiday is there", () => {
    const p = holidays("date,name,country\n2026-12-25,Christmas Day,US\n");
    expect(p.counts).toEqual({ create: 0, update: 0, unchanged: 1, error: 0 });
    expect(p.payload).toBeNull();
  });

  it("has a template that imports as it is", () => {
    expect(importTemplate("holidays")).toBe(
      "date,name,country,state\r\n2026-12-25,Christmas Day,US,\r\n",
    );
    const p = previewImport("holidays", importTemplate("holidays"), { ...ctx, holidays: [] });
    expect(p.rows.map((r) => [r.status, r.errors])).toEqual([["create", []]]);
  });
});
