import { describe, expect, it } from "vitest";
import { groupByTask, NO_TASK, type TaskSeconds, UNASSIGNED } from "./taskGroups";

const projects = [
  { id: "web", name: "Website revamp" },
  { id: "int", name: "Internal" },
];
// Every project's tasks in order: Website revamp has Design, then Build.
const ordered = [
  { id: "design", projectId: "web", name: "Design" },
  { id: "hire", projectId: "int", name: "Hiring" },
  { id: "build", projectId: "web", name: "Build" },
];

const row = (
  userId: string,
  projectId: string | null,
  taskId: string | null,
  workedS: number,
  flaggedS = 0,
): TaskSeconds => ({ userId, projectId, taskId, workedS, flaggedS });

describe("groupByTask", () => {
  const rows = [
    row("erin", "web", "build", 1800, 60),
    row("erin", "web", null, 900),
    row("lucas", "web", "design", 3600),
    row("erin", "web", "design", 1200.4),
    row("erin", null, null, 600, 300),
    row("lucas", "int", "hire", 300),
  ];
  const report = groupByTask(rows, projects, ordered);

  it("groups by project, by name, with Unassigned last", () => {
    expect(report.projects.map((p) => p.name)).toEqual(["Internal", "Website revamp", UNASSIGNED]);
  });

  it("lists a project's tasks in its order, then No task", () => {
    const web = report.projects.find((p) => p.projectId === "web");
    expect(web?.tasks.map((t) => [t.name, t.workedS, t.flaggedS, t.people])).toEqual([
      ["Design", 4800.4, 0, 2],
      ["Build", 1800, 60, 1],
      [NO_TASK, 900, 0, 1],
    ]);
  });

  it("adds up a project from its tasks' seconds and counts each person once", () => {
    const web = report.projects.find((p) => p.projectId === "web");
    expect(web).toMatchObject({ workedS: 7500.4, flaggedS: 60, people: 2 });
  });

  it("gives Unassigned time no task lines", () => {
    const none = report.projects.at(-1);
    expect(none).toMatchObject({ projectId: null, workedS: 600, flaggedS: 300, people: 1 });
    expect(none?.tasks).toEqual([]);
  });

  it("totals the raw seconds of every row, rounding nothing", () => {
    expect(report.total).toEqual({ workedS: 8400.4, flaggedS: 360, people: 2 });
  });

  it("still counts a project or task it has no name for", () => {
    const r = groupByTask([row("erin", "gone", "lost", 60)], projects, ordered);
    expect(r.projects[0]).toMatchObject({ name: "Unknown project", workedS: 60 });
    expect(r.projects[0]?.tasks[0]?.name).toBe("Unknown task");
  });

  it("is empty with no rows", () => {
    expect(groupByTask([], projects, ordered)).toEqual({
      projects: [],
      total: { workedS: 0, flaggedS: 0, people: 0 },
    });
  });
});
