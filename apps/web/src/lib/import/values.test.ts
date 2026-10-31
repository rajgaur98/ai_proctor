import { describe, expect, it } from "vitest";
import {
  formatDays,
  nameKey,
  normalizeHeader,
  parseClockTime,
  parseCountry,
  parseDate,
  parseDays,
  parseEmail,
  parseEmailList,
  parseLocation,
  parseRole,
  parseTime,
  parseTimeZone,
  parseYesNo,
} from "./values";

const value = <T>(r: { ok: true; value: T } | { ok: false; message: string }) =>
  r.ok ? r.value : `ERROR ${r.message}`;

describe("headers and names", () => {
  it("ignores case, spaces and punctuation", () => {
    expect(normalizeHeader(" Manager E-mail ")).toBe("manageremail");
    expect(normalizeHeader("manager_email")).toBe("manageremail");
    expect(normalizeHeader("TIME ZONE")).toBe("timezone");
    expect(nameKey("  Customer   Support ")).toBe("customer support");
  });
});

describe("parseEmail / parseEmailList", () => {
  it("lower-cases and checks addresses", () => {
    expect(value(parseEmail(" Jane@Example.COM "))).toBe("jane@example.com");
    expect(value(parseEmail("jane@"))).toBe('ERROR "jane@" isn\'t an email address.');
  });

  it("splits on semicolons, commas, spaces and line breaks, without repeats", () => {
    expect(value(parseEmailList("a@x.test; B@x.test,c@x.test\nA@x.test"))).toEqual([
      "a@x.test",
      "b@x.test",
      "c@x.test",
    ]);
    expect(value(parseEmailList(""))).toEqual([]);
    expect(value(parseEmailList("a@x.test; nope; also"))).toBe(
      'ERROR "nope", "also" aren\'t email addresses.',
    );
  });
});

describe("parseYesNo / parseRole", () => {
  it("takes the usual words and a column's own", () => {
    expect(value(parseYesNo("Yes"))).toBe(true);
    expect(value(parseYesNo("0"))).toBe(false);
    expect(value(parseYesNo("Archived", { yes: ["archived"], no: ["active"] }))).toBe(true);
    expect(value(parseYesNo("maybe", { yes: ["archived"], no: ["active"] }))).toBe(
      'ERROR "maybe" should be yes, no, archived or active.',
    );
  });

  it("reads roles in any case", () => {
    expect(value(parseRole("Manager"))).toBe("manager");
    expect(value(parseRole("Administrator"))).toBe("admin");
    expect(value(parseRole("boss"))).toBe(
      'ERROR "boss" isn\'t a role. Use admin, manager or employee.',
    );
  });
});

describe("work location", () => {
  it("reads two-letter codes, USA, and country-state pairs", () => {
    expect(value(parseCountry("us"))).toBe("US");
    expect(value(parseCountry("USA"))).toBe("US");
    expect(value(parseCountry("India"))).toMatch(/^ERROR/);
    expect(value(parseLocation("US-NY"))).toEqual({ country: "US", state: "NY" });
    expect(value(parseLocation("us / ca"))).toEqual({ country: "US", state: "CA" });
    expect(value(parseLocation("IN"))).toEqual({ country: "IN", state: null });
    expect(value(parseLocation("New York"))).toMatch(/^ERROR/);
  });
});

describe("parseTimeZone", () => {
  it("fixes the case of known names and keeps other valid ones", () => {
    expect(value(parseTimeZone("america/new_york"))).toBe("America/New_York");
    expect(value(parseTimeZone("Asia/Kolkata"))).toBe("Asia/Kolkata");
    expect(value(parseTimeZone("UTC"))).toBe("UTC");
    expect(value(parseTimeZone("Mars/Base"))).toMatch(/^ERROR "Mars\/Base" isn't a time zone/);
  });
});

describe("parseTime", () => {
  it("reads 24-hour and am/pm times as HH:MM", () => {
    expect(value(parseTime("9"))).toBe("09:00");
    expect(value(parseTime("09:30"))).toBe("09:30");
    expect(value(parseTime("17:30:00"))).toBe("17:30");
    expect(value(parseTime("9:30am"))).toBe("09:30");
    expect(value(parseTime("5 PM"))).toBe("17:00");
    expect(value(parseTime("12am"))).toBe("00:00");
    expect(value(parseTime("12:15 p.m."))).toBe("12:15");
    expect(value(parseTime("0:00"))).toBe("00:00");
  });

  it("refuses what isn't a time", () => {
    for (const t of ["24:00", "9:60", "13pm", "0am", "noon", "9:00:30"]) {
      expect(parseTime(t).ok, t).toBe(false);
    }
  });
});

describe("parseDays", () => {
  it("reads names, numbers, ranges and words", () => {
    expect(value(parseDays("Mon-Fri"))).toEqual([1, 2, 3, 4, 5]);
    expect(value(parseDays("monday to friday"))).toEqual([1, 2, 3, 4, 5]);
    expect(value(parseDays("Mon, Wed; Fri"))).toEqual([1, 3, 5]);
    expect(value(parseDays("1-5"))).toEqual([1, 2, 3, 4, 5]);
    expect(value(parseDays("Fri – Mon"))).toEqual([1, 5, 6, 7]);
    expect(value(parseDays("Tue and Thu"))).toEqual([2, 4]);
    expect(value(parseDays("weekdays"))).toEqual([1, 2, 3, 4, 5]);
    expect(value(parseDays("weekends"))).toEqual([6, 7]);
    expect(value(parseDays("Every day"))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(value(parseDays("sun sat sun"))).toEqual([6, 7]);
  });

  it("refuses what isn't a day", () => {
    for (const t of ["", "Funday", "Mon-Fri-Sat", "8", "Mon-"]) {
      expect(parseDays(t).ok, t).toBe(false);
    }
  });

  it("formats days back with ranges", () => {
    expect(formatDays([1, 2, 3, 4, 5])).toBe("Mon-Fri");
    expect(formatDays([1, 2, 3, 4, 5, 7])).toBe("Mon-Fri, Sun");
    expect(formatDays([1, 3, 4])).toBe("Mon, Wed, Thu");
  });
});

describe("dates and clock times (time entries)", () => {
  it("reads dates in unambiguous forms", () => {
    for (const t of ["2026-10-28", "2026/10/28", "2026-10-28", "28 Oct 2026", "Oct 28, 2026"]) {
      expect(value(parseDate(t)), t).toBe("2026-10-28");
    }
    expect(value(parseDate("28-October-2026"))).toBe("2026-10-28");
    expect(value(parseDate("2028-02-29"))).toBe("2028-02-29");
  });

  it("refuses day-month numbers and dates that don't exist", () => {
    expect(value(parseDate("10/28/2026"))).toBe(
      'ERROR "10/28/2026" could be read day-first or month-first. Use a date like 2026-10-28.',
    );
    for (const t of ["", "2026-02-29", "2026-13-01", "28 Foo 2026", "yesterday"]) {
      expect(parseDate(t).ok, t).toBe(false);
    }
  });

  it("round-trips every day of a leap year and a common one", () => {
    for (const year of [2027, 2028]) {
      for (let at = Date.UTC(year, 0, 1); at < Date.UTC(year + 1, 0, 1); at += 86_400_000) {
        const iso = new Date(at).toISOString().slice(0, 10);
        expect(value(parseDate(iso))).toBe(iso);
      }
    }
  });

  it("reads clock times with seconds, and 24:00 as the end of the day", () => {
    expect(value(parseClockTime("9"))).toBe("09:00:00");
    expect(value(parseClockTime("9:30am"))).toBe("09:30:00");
    expect(value(parseClockTime("12am"))).toBe("00:00:00");
    expect(value(parseClockTime("17:30:15"))).toBe("17:30:15");
    expect(value(parseClockTime("24:00"))).toBe("24:00:00");
    for (const t of ["24:01", "25", "9:60", "13pm", "9:30:60", "noon"]) {
      expect(parseClockTime(t).ok, t).toBe(false);
    }
  });
});
