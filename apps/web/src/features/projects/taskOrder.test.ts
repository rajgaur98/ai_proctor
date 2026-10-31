import { describe, expect, it } from "vitest";
import { moveId, withOrder } from "./taskOrder";

describe("moveId", () => {
  it("moves a task one place up or down", () => {
    expect(moveId(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveId(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveId(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"]);
  });

  it("can't move the first up, the last down or a task that isn't there", () => {
    expect(moveId(["a", "b", "c"], "a", -1)).toBeNull();
    expect(moveId(["a", "b", "c"], "c", 1)).toBeNull();
    expect(moveId(["a", "b", "c"], "x", 1)).toBeNull();
    expect(moveId([], "a", -1)).toBeNull();
  });

  it("leaves the list it was given alone", () => {
    const ids = ["a", "b"];
    moveId(ids, "b", -1);
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("withOrder", () => {
  const tasks = [
    { id: "p1", projectId: "x", name: "Design" },
    { id: "q1", projectId: "y", name: "Hiring" },
    { id: "p2", projectId: "x", name: "Build" },
    { id: "p3", projectId: "x", name: "Test" },
  ];

  it("puts one project's tasks in the new order and leaves the others where they were", () => {
    expect(withOrder(tasks, "x", ["p3", "p1", "p2"]).map((t) => t.id)).toEqual([
      "p3",
      "q1",
      "p1",
      "p2",
    ]);
  });

  it("keeps tasks the order leaves out, after the rest", () => {
    expect(withOrder(tasks, "x", ["p2"]).map((t) => t.id)).toEqual(["p2", "q1", "p1", "p3"]);
  });

  it("changes nothing for a project with no tasks", () => {
    expect(withOrder(tasks, "z", ["p1"])).toEqual(tasks);
  });
});
