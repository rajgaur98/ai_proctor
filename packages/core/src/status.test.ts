import { describe, expect, it } from "vitest";
import vectors from "../vectors/status.json" with { type: "json" };
import { computeStatus, presenceStatuses, type StatusInput } from "./status.ts";

describe("computeStatus", () => {
  for (const vector of vectors.vectors) {
    it(vector.name, () => {
      expect(computeStatus(vector.input as StatusInput)).toBe(vector.expected);
    });
  }

  it("covers every status in the vectors", () => {
    const covered = new Set(vectors.vectors.map((v) => v.expected));
    expect([...covered].sort()).toEqual([...presenceStatuses].sort());
  });
});
