import type { Json } from "@ai-proctor/contracts";
import { describe, expect, it } from "vitest";
import { notificationNote, notificationTarget, notificationText } from "./notificationText";

const ME = "00000000-0000-4000-8000-0000000000c1";
const ERIN = "00000000-0000-4000-8000-0000000000c1";
const LUCAS = "00000000-0000-4000-8000-0000000000c2";

interface Case {
  kind: string;
  payload: Json;
  text: string;
  note: string | null;
  target: ReturnType<typeof notificationTarget>;
}

// Every kind the migrations write, with the payload shape each one writes.
const CASES: Case[] = [
  {
    kind: "timesheet.returned",
    payload: { timesheet_id: "t1", period_start: "2026-10-19", comment: "Add Thursday", by: "m" },
    text: "Your week of 19 Oct was returned to you",
    note: "Comment: Add Thursday",
    target: { page: "week", userId: ME, week: "2026-10-19" },
  },
  {
    kind: "timesheet.reopened",
    payload: { timesheet_id: "t1", period_start: "2026-10-12", reason: "Forgot Friday", by: "m" },
    text: "Your week of 12 Oct was reopened",
    note: "Reason: Forgot Friday",
    target: { page: "week", userId: ME, week: "2026-10-12" },
  },
  {
    kind: "timesheet.edited",
    payload: { timesheet_id: "t1", period_start: "2026-10-19", kind: "exclude", reason: "Idle" },
    text: "Your manager excluded time from your week of 19 Oct",
    note: "Reason: Idle",
    target: { page: "week", userId: ME, week: "2026-10-19" },
  },
  {
    kind: "timesheet.edited",
    payload: { period_start: "2026-10-19", kind: "include", reason: "Was working" },
    text: "Your manager put time back into your week of 19 Oct",
    note: "Reason: Was working",
    target: { page: "week", userId: ME, week: "2026-10-19" },
  },
  {
    kind: "timesheet.edited",
    payload: { period_start: "2026-10-19", kind: "project", reason: "Wrong client" },
    text: "Your manager changed the project on time in your week of 19 Oct",
    note: "Reason: Wrong client",
    target: { page: "week", userId: ME, week: "2026-10-19" },
  },
  {
    kind: "timesheet.edited",
    payload: { period_start: "2026-10-19", kind: "adjust", reason: "Phone call" },
    text: "Your manager adjusted time in your week of 19 Oct",
    note: "Reason: Phone call",
    target: { page: "week", userId: ME, week: "2026-10-19" },
  },
  {
    kind: "timesheet.reassigned",
    payload: { user_id: LUCAS, from: "m", timesheets: 2, manual_entries: 1 },
    text: "After a reassignment, you decide on 2 timesheets and 1 manual entry",
    note: null,
    target: { page: "timesheets" },
  },
  {
    kind: "timesheet.reassigned",
    payload: { user_id: LUCAS, from: null, timesheets: 1, manual_entries: 0 },
    text: "After a reassignment, you decide on 1 timesheet",
    note: null,
    target: { page: "timesheets" },
  },
  {
    kind: "delegation.assigned",
    payload: {
      delegation_id: "d1",
      manager_id: "m",
      starts_on: "2026-10-20",
      ends_on: "2026-10-27",
    },
    text: "You are a delegate approver, 20 Oct to 27 Oct",
    note: null,
    target: { page: "timesheets" },
  },
  {
    kind: "delegation.ended",
    payload: {
      delegation_id: "d1",
      manager_id: "m",
      starts_on: "2026-10-20",
      ends_on: "2026-10-27",
    },
    text: "Your delegation ended, 20 Oct to 27 Oct",
    note: null,
    target: { page: "timesheets" },
  },
  {
    kind: "delegation.ended",
    payload: {
      delegation_id: "d1",
      manager_id: "m",
      delegate_id: "g",
      starts_on: "2026-10-20",
      ends_on: "2026-10-27",
      reason: "deactivated",
      for: "delegate",
      name: "Max Manager",
    },
    text: "Max Manager was deactivated, so their delegation to you ended, 20 Oct to 27 Oct",
    note: null,
    target: { page: "timesheets" },
  },
  {
    kind: "delegation.ended",
    payload: {
      delegation_id: "d1",
      manager_id: "m",
      delegate_id: "g",
      starts_on: "2026-10-20",
      ends_on: "2026-10-27",
      reason: "demoted",
      for: "manager",
      name: "Mia Manager",
    },
    text: "Mia Manager was made an employee, so your delegation to them ended, 20 Oct to 27 Oct",
    note: null,
    target: { page: "timesheets" },
  },
  {
    kind: "timesheet.submit_reminder",
    payload: {
      timesheet_id: null,
      period_start: "2026-10-12",
      period_end: "2026-10-18",
      employee_id: ERIN,
      employee_name: "Erin Park",
    },
    text: "Submit your week of 12 Oct",
    note: null,
    target: { page: "week", userId: ERIN, week: "2026-10-12" },
  },
  {
    kind: "timesheet.approval_reminder",
    payload: {
      timesheet_id: "t1",
      period_start: "2026-10-12",
      employee_id: LUCAS,
      employee_name: "Lucas Martin",
      submitted_at: "2026-10-19T10:00:00Z",
    },
    text: "Lucas Martin's week of 12 Oct has waited 2 days for approval",
    note: null,
    target: { page: "week", userId: LUCAS, week: "2026-10-12" },
  },
  {
    kind: "timesheet.escalation",
    payload: {
      timesheet_id: "t1",
      period_start: "2026-10-12",
      employee_id: LUCAS,
      employee_name: "Lucas Martin",
      manager_id: "m",
      manager_name: "Max Manager",
    },
    text: "Lucas Martin's week of 12 Oct has waited 5 days for approval",
    note: "Manager: Max Manager",
    target: { page: "week", userId: LUCAS, week: "2026-10-12" },
  },
  {
    kind: "timesheet.late_data",
    payload: {
      timesheet_id: "t1",
      period_start: "2026-10-12",
      period_end: "2026-10-18",
      employee_id: LUCAS,
      employee_name: "Lucas Martin",
    },
    text: "Lucas Martin's week of 12 Oct has new data after approval",
    note: null,
    target: { page: "week", userId: LUCAS, week: "2026-10-12" },
  },
];

describe("notifications", () => {
  it.each(CASES)(
    "$kind says, notes and links as written",
    ({ kind, payload, text, note, target }) => {
      expect(notificationText(kind, payload)).toBe(text);
      expect(notificationNote(kind, payload)).toBe(note);
      expect(notificationTarget(kind, payload, ME)).toEqual(target);
    },
  );

  it("covers every kind the migrations write", () => {
    expect(new Set(CASES.map((c) => c.kind))).toEqual(
      new Set([
        "timesheet.returned",
        "timesheet.reopened",
        "timesheet.edited",
        "timesheet.reassigned",
        "delegation.assigned",
        "delegation.ended",
        "timesheet.submit_reminder",
        "timesheet.approval_reminder",
        "timesheet.escalation",
        "timesheet.late_data",
      ]),
    );
  });

  it("falls back when the payload is missing", () => {
    expect(notificationText("timesheet.returned", {})).toBe("Your week was returned to you");
    expect(notificationText("timesheet.edited", null)).toBe("Your manager edited your week");
    expect(notificationText("timesheet.approval_reminder", {})).toBe(
      "Someone's week has waited 2 days for approval",
    );
    expect(notificationText("timesheet.reassigned", {})).toBe(
      "After a reassignment, you have work to decide on",
    );
    expect(notificationText("delegation.assigned", null)).toBe("You are a delegate approver");
    expect(notificationText("timesheet.late_data", {})).toBe(
      "Someone's week has new data after approval",
    );
    expect(notificationText("delegation.ended", { reason: "demoted" })).toBe(
      "Someone was made an employee, so their delegation to you ended",
    );
    expect(notificationTarget("timesheet.returned", {}, ME)).toEqual({ page: "timesheets" });
  });

  it("has a generic line and no link for a kind it does not know", () => {
    expect(notificationText("billing.invoice", {})).toBe("New notification");
    expect(notificationNote("billing.invoice", {})).toBeNull();
    expect(notificationTarget("billing.invoice", {}, ME)).toBeNull();
  });
});
