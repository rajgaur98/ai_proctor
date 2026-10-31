import { readCsv } from "@ai-proctor/core";
import { describe, expect, it } from "vitest";
import { ctx as base } from "./fixture.test-helper";
import { previewImport } from "./preview";
import { timeEntriesScope } from "./timeEntries";
import type { ImportContext, TimeContext } from "./types";

// Erin is in Asia/Kolkata (+05:30), Eli in America/Chicago, Max in America/Los_Angeles.
// Erin can log to Acme Corp / Website, which has a task Design and an archived one.
const NOW = Date.parse("2026-11-01T12:00:00Z");
const time: TimeContext = { entries: [], clocked: [], locked: [], now: NOW };
const ctx: ImportContext = {
  ...base,
  tasks: [
    { project: "Website", client: "Acme Corp", name: "Design", archived: false },
    { project: "Website", client: "Acme Corp", name: "Old work", archived: true },
  ],
  time,
};

const entries = (csv: string, c: ImportContext = ctx) => previewImport("time_entries", csv, c);
const errorsOf = (csv: string, c: ImportContext = ctx) =>
  entries(csv, c).rows.flatMap((r) => r.errors.map((e) => `${r.row} ${e.field}: ${e.message}`));
const HEADER = "email,date,start,end,project,task,note,reason\n";

describe("time entries import", () => {
  it("turns each row into an entry in the person's time zone, to the second", () => {
    const p = entries(
      "Email,Start date,Start time,End time,Project,Task,Description,Reason,Duration\n" +
        "Erin@acme.test,2026-10-20,9:00,12:30:15,website,design,Wireframes,,3.5\n" +
        'eli@acme.test,"Oct 20, 2026",10pm,24:00,,,,Forgot to clock in,2\n',
    );
    expect(p.fileErrors).toEqual([]);
    expect(p.ignoredColumns).toEqual(["Duration"]);
    expect(p.rows.map((r) => [r.key, r.status, r.errors])).toEqual([
      ["erin@acme.test 2026-10-20 9:00-12:30:15", "create", []],
      ["eli@acme.test Oct 20, 2026 10pm-24:00", "create", []],
    ]);
    expect(p.payload).toEqual({
      kind: "time_entries",
      items: [
        {
          rows: [2],
          action: "create",
          email: "erin@acme.test",
          start_at: "2026-10-20T09:00:00+05:30",
          end_at: "2026-10-20T12:30:15+05:30",
          project: "Website",
          client: "Acme Corp",
          task: "Design",
          note: "Wireframes",
          reason: "Imported",
        },
        {
          rows: [3],
          action: "create",
          email: "eli@acme.test",
          start_at: "2026-10-20T22:00:00-05:00",
          end_at: "2026-10-21T00:00:00-05:00",
          project: null,
          client: null,
          task: null,
          note: null,
          reason: "Forgot to clock in",
        },
      ],
    });
  });

  it("re-importing matches on email, start and end: identical is unchanged, different an error", () => {
    const existing: TimeContext = {
      ...time,
      entries: [
        {
          email: "erin@acme.test",
          start_at: "2026-10-20T03:30:00+00:00",
          end_at: "2026-10-20T07:00:15+00:00",
          status: "rejected",
          project: "Website",
          client: "Acme Corp",
          task: "Design",
          note: "Wireframes",
          reason: "Imported",
        },
        {
          email: "erin@acme.test",
          start_at: "2026-10-21T03:30:00+00:00",
          end_at: "2026-10-21T04:30:00+00:00",
          status: "approved",
          project: null,
          client: null,
          task: null,
          note: null,
          reason: "Imported",
        },
      ],
    };
    const c = { ...ctx, time: existing };
    const p = entries(
      `${HEADER}erin@acme.test,2026-10-20,09:00,12:30:15,Website,Design,Wireframes,\n` +
        "erin@acme.test,2026-10-21,09:00,10:00,Website,,Other,\n",
      c,
    );
    expect(p.rows.map((r) => r.status)).toEqual(["unchanged", "error"]);
    expect(p.rows[1]?.errors.map((e) => e.message)).toEqual([
      "An entry for this time already exists with a different project and note. Imports don't change existing entries.",
    ]);
    expect(p.payload).toBeNull();

    // The identical row alone: nothing to send.
    const again = entries(
      `${HEADER}erin@acme.test,2026-10-20,09:00,12:30:15,Website,Design,Wireframes,\n`,
      c,
    );
    expect(again.counts).toEqual({ create: 0, update: 0, unchanged: 1, error: 0 });
    expect(again.payload).toBeNull();
  });

  it("explains rows that break a manual entry's rules", () => {
    expect(
      errorsOf(
        HEADER +
          ",2026-10-20,09:00,10:00,,,,\n" +
          "nobody@acme.test,2026-10-20,09:00,10:00,,,,\n" +
          "gone@acme.test,2026-10-20,09:00,10:00,,,,\n" +
          "erin@acme.test,10/20/2026,9,25:00,,,,\n" +
          "erin@acme.test,2026-02-30,,10,,,,\n" +
          "erin@acme.test,2026-10-20,10:00,09:00,,,,\n" +
          "erin@acme.test,2026-10-20,10:00,10:00,,,,\n" +
          "erin@acme.test,2026-11-01,17:00,18:00,,,,\n" +
          "eli@acme.test,2026-03-08,02:30,04:00,,,,\n" +
          "erin@acme.test,2026-10-22,09:00,10:00,Nowhere,,,\n" +
          "eli@acme.test,2026-10-22,09:00,10:00,Website,,,\n" +
          "erin@acme.test,2026-10-22,09:00,10:00,,Design,,\n" +
          "erin@acme.test,2026-10-22,09:00,10:00,Website,Testing,,\n" +
          "erin@acme.test,2026-10-22,09:00,10:00,Website,Old work,,\n" +
          `erin@acme.test,2026-10-22,09:00,10:00,,,${"x".repeat(2001)},${"y".repeat(501)}\n`,
      ),
    ).toEqual([
      "2 email: The email is missing.",
      "3 email: nobody@acme.test isn't in your organisation. Import people first.",
      "4 email: gone@acme.test is deactivated.",
      '5 date: "10/20/2026" could be read day-first or month-first. Use a date like 2026-10-28.',
      '5 end: "25:00" isn\'t a time. Use a time like 09:00 or 5:30pm.',
      '6 date: "2026-02-30" isn\'t a date. Use a date like 2026-10-28.',
      "6 start: The start time is missing.",
      "7 end: The end is before the start. Put time past midnight on a second row for the next day.",
      "8 end: The entry ends when it starts.",
      "9 end: This time hasn't happened yet.",
      "10 start: 02:30 doesn't exist on 2026-03-08 in America/Chicago: the clocks went forward.",
      '11 project: There\'s no project called "Nowhere". Import projects first.',
      "12 project: eli@acme.test can't log time to Acme Corp / Website. Add them to the project first.",
      "13 task: A task needs a project.",
      '14 task: Acme Corp / Website has no task called "Testing".',
      "15 task: The task Old work is archived.",
      "16 note: A note can be at most 2,000 characters.",
      "16 reason: A reason can be at most 500 characters.",
    ]);
  });

  it("refuses overlaps with existing time, locked weeks and other rows of the file", () => {
    const c: ImportContext = {
      ...ctx,
      time: {
        ...time,
        entries: [
          {
            email: "erin@acme.test",
            start_at: "2026-10-20T04:30:00Z", // 10:00-11:00 in Kolkata
            end_at: "2026-10-20T05:30:00Z",
            status: "pending",
            project: null,
            client: null,
            task: null,
            note: null,
            reason: "Asked",
          },
          {
            email: "erin@acme.test",
            start_at: "2026-10-20T06:30:00Z", // 12:00-13:00, rejected: doesn't count
            end_at: "2026-10-20T07:30:00Z",
            status: "rejected",
            project: null,
            client: null,
            task: null,
            note: null,
            reason: "Asked",
          },
        ],
        clocked: [
          // Max, open since 08:00 in Los Angeles on Oct 30 (runs to now).
          { email: "max@acme.test", start_at: "2026-10-30T15:00:00Z", end_at: null },
          {
            email: "eli@acme.test",
            start_at: "2026-10-20T14:00:00Z",
            end_at: "2026-10-20T17:00:00Z",
          },
        ],
        locked: [{ email: "eli@acme.test", period_start: "2026-10-12" }],
      },
    };
    expect(
      errorsOf(
        HEADER +
          "erin@acme.test,2026-10-20,10:30,11:30,,,,\n" +
          "erin@acme.test,2026-10-20,12:30,13:30,,,,\n" +
          "max@acme.test,2026-10-31,09:00,10:00,,,,\n" +
          "eli@acme.test,2026-10-20,08:00,09:30,,,,\n" +
          "eli@acme.test,2026-10-18,08:00,09:00,,,,\n" +
          "eli@acme.test,2026-10-19,08:00,09:00,,,,\n" +
          "eli@acme.test,2026-10-21,08:00,10:00,,,,\n" +
          "eli@acme.test,2026-10-21,09:00,11:00,,,,\n" +
          "eli@acme.test,2026-10-21,08:00,10:00,,,,\n" +
          "eli@acme.test,2026-10-21,10:00,11:00,,,,\n",
        c,
      ),
    ).toEqual([
      "2 null: Overlaps a pending entry, 2026-10-20 10:00-11:00.",
      "4 null: Overlaps clocked time since 2026-10-30 08:00 (still clocked in).",
      "5 null: Overlaps clocked time, 2026-10-20 09:00-12:00.",
      "6 null: The week of 2026-10-12 is approved, so its time is locked.",
      "9 null: Overlaps row 8.",
      "10 null: The same entry is also on row 8.",
      "11 null: Overlaps row 9.",
    ]);
  });

  it("finds a project by client / project when two clients have one of that name", () => {
    const c: ImportContext = {
      ...ctx,
      projects: [
        ...ctx.projects,
        { name: "Website", client: "Globex", billable: true, archived: false, members: [] },
        {
          name: "Website",
          client: null,
          billable: true,
          archived: false,
          members: ["eli@acme.test"],
        },
      ],
    };
    const p = entries(
      `${HEADER}erin@acme.test,2026-10-20,09:00,10:00,Website,,,\n` +
        "max@acme.test,2026-10-20,09:00,10:00,Website,,,\n" +
        "eli@acme.test,2026-10-20,09:00,10:00,Globex/Website,,,\n",
      c,
    );
    expect(p.rows.map((r) => r.errors.map((e) => e.message))).toEqual([
      [],
      [
        '3 projects are called "Website" (Acme Corp / Website, Globex / Website and Website). Write it as client / project.',
      ],
      ["eli@acme.test can't log time to Globex / Website. Add them to the project first."],
    ]);
  });

  it("knows the people and dates a file is about", () => {
    expect(
      timeEntriesScope(
        readCsv(
          `${HEADER}Erin@acme.test,2026-10-21,9,10,,,,\neli@acme.test,2026-10-02,9,10,,,,\n` +
            "erin@acme.test,bad,9,10,,,,\nnot-an-email,2025-01-01,9,10,,,,\n",
        ),
      ),
    ).toEqual({
      emails: ["eli@acme.test", "erin@acme.test"],
      from: "2026-10-02",
      to: "2026-10-21",
    });
    expect(timeEntriesScope(readCsv("email,date\nerin@acme.test,2026-10-21\n"))).toBeNull();
  });
});
