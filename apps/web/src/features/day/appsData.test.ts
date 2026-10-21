import { describe, expect, it } from "vitest";
import { topAppRows } from "./appsData";

describe("topAppRows", () => {
  it("keeps the order and sizes bars against the longest app", () => {
    expect(
      topAppRows([
        { appName: "VS Code", seconds: 3600 },
        { appName: "Chrome", seconds: 1800 },
        { appName: "Slack", seconds: 1 },
      ]),
    ).toEqual([
      { appName: "VS Code", seconds: 3600, width: 100 },
      { appName: "Chrome", seconds: 1800, width: 50 },
      // A sliver stays visible.
      { appName: "Slack", seconds: 1, width: 2 },
    ]);
  });

  it("is empty without apps", () => {
    expect(topAppRows([])).toEqual([]);
  });
});
