import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { type ManualRequestForm, manualRequest } from "./manualRequest";

const zone = "America/Los_Angeles";
const now = DateTime.fromISO("2026-03-12T12:00:00", { zone });
const form = (over: Partial<ManualRequestForm>): ManualRequestForm => ({
  day: "2026-03-09",
  start: "13:00",
  end: "15:00",
  projectId: "",
  taskId: "",
  reason: "Whiteboard session",
  note: "",
  ...over,
});
const PROJECT = "00000000-0000-4000-8000-0000000000f1";
const TASK = "00000000-0000-4000-8000-00000000a264";

describe("manualRequest", () => {
  it("reads the times on the day, in the employee's zone", () => {
    const r = manualRequest(form({}), zone, now);
    expect(r).toEqual({
      request: {
        start_at: "2026-03-09T13:00:00.000-07:00",
        end_at: "2026-03-09T15:00:00.000-07:00",
        project_id: null,
        task_id: null,
        reason: "Whiteboard session",
        note: null,
      },
    });
  });

  it("keeps the task only with a project", () => {
    const withProject = manualRequest(form({ projectId: PROJECT, taskId: TASK }), zone, now);
    expect("request" in withProject && withProject.request.task_id).toBe(TASK);
    const without = manualRequest(form({ taskId: TASK }), zone, now);
    expect("request" in without && without.request.task_id).toBeNull();
  });

  it("needs a start and an end", () => {
    expect(manualRequest(form({ start: "" }), zone, now)).toEqual({
      problem: "Choose a day, a start and an end.",
    });
    expect(manualRequest(form({ end: "" }), zone, now)).toEqual({
      problem: "Choose a day, a start and an end.",
    });
  });

  it("refuses an end in the future", () => {
    expect(
      manualRequest(form({ day: "2026-03-12", start: "11:00", end: "13:00" }), zone, now),
    ).toEqual({ problem: "The entry can't end in the future." });
  });

  it("refuses an end before the start, and a missing reason", () => {
    expect(manualRequest(form({ start: "15:00", end: "13:00" }), zone, now)).toEqual({
      problem: "The end must be after the start",
    });
    expect(manualRequest(form({ reason: "  " }), zone, now)).toEqual({ problem: "Give a reason" });
  });
});
