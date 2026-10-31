import { describe, expect, it } from "vitest";
import { ctx } from "./fixture.test-helper";
import { previewImport } from "./preview";

const shifts = (csv: string) => previewImport("shifts", csv, ctx);
const errorsOf = (csv: string) =>
  shifts(csv).rows.flatMap((r) => r.errors.map((e) => `${r.row} ${e.field}: ${e.message}`));

describe("shifts import", () => {
  it("groups rows per person; each person's shifts become exactly the file's", () => {
    const p = shifts(
      "Email,Days,Start time,End time,Time zone\n" +
        "eli@acme.test,Mon-Fri,9am,5:30pm,\n" +
        "eli@acme.test,Sat,22:00,02:00,\n" +
        "erin@acme.test,weekdays,09:00,17:30,\n" +
        "max@acme.test,Mon-Thu,8,16,utc\n",
    );
    expect(p.rows.map((r) => [r.key, r.status])).toEqual([
      ["eli@acme.test", "create"],
      ["eli@acme.test", "create"],
      ["erin@acme.test", "unchanged"],
      ["max@acme.test", "create"],
    ]);
    expect(p.payload).toEqual({
      kind: "shifts",
      items: [
        {
          rows: [2, 3],
          action: "create",
          email: "eli@acme.test",
          shifts: [
            { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:30", timezone: "America/Chicago" },
            { days: [6], start: "22:00", end: "02:00", timezone: "America/Chicago" },
          ],
        },
        {
          rows: [5],
          action: "create",
          email: "max@acme.test",
          shifts: [{ days: [1, 2, 3, 4], start: "08:00", end: "16:00", timezone: "UTC" }],
        },
      ],
    });
  });

  it("describes a replaced schedule", () => {
    const p = shifts("email,days,start,end\nerin@acme.test,Mon-Thu,10:00,18:00\n");
    expect(p.rows[0]?.status).toBe("update");
    expect(p.rows[0]?.changes).toEqual(["replaces Mon-Fri 09:00-17:30 with Mon-Thu 10:00-18:00"]);
  });

  it("explains bad rows, repeats and too many shifts", () => {
    const eight = Array.from({ length: 8 }, (_, i) => `max@acme.test,Mon,0${i}:00,0${i}:30\n`).join(
      "",
    );
    expect(
      errorsOf(
        "email,days,start,end,timezone\n" +
          "nobody@acme.test,Mon,9,17,\n" +
          "gone@acme.test,Mon,9,17,\n" +
          "eli@acme.test,Funday,25:00,,\n" +
          "eli@acme.test,Mon,9,9,\n" +
          "eli@acme.test,Tue,9,17,Nowhere/Zone\n" +
          "erin@acme.test,Mon,9,17,\n" +
          "erin@acme.test,mon,09:00,5pm,\n" +
          eight,
      ),
    ).toEqual([
      "2 email: nobody@acme.test isn't in your organisation. Import people first.",
      "3 email: gone@acme.test is deactivated.",
      '4 days: "Funday" isn\'t a set of days. Use names or ranges, like Mon-Fri or Mon, Wed, Fri.',
      '4 start: "25:00" isn\'t a time. Use a time like 09:00 or 5:30pm.',
      "4 end: The end time is missing.",
      "5 end: The shift ends when it starts.",
      '6 timezone: "Nowhere/Zone" isn\'t a time zone. Use a name like America/New_York or Asia/Kolkata.',
      "8 null: The same shift is also on row 7.",
      "16 null: max@acme.test has more than 7 shifts in this file.",
    ]);
  });

  it("holds back a person's other rows when one of theirs is wrong", () => {
    const p = shifts("email,days,start,end\neli@acme.test,Mon,9,17\neli@acme.test,Tue,9,\n");
    expect(p.rows.map((r) => r.status)).toEqual(["unchanged", "error"]);
    expect(p.payload).toBeNull();
  });
});
