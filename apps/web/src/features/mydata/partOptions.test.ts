import { describe, expect, it } from "vitest";
import { noneRemoved } from "../day/removedText";
import { partOptions, pickedParts } from "./partOptions";

const pass = {
  outcome: "pass",
  objectKeys: ["screen-1.webp", "screen-2.webp", "webcam.webp"],
  removed: noneRemoved,
};

describe("partOptions", () => {
  it("offers every part of a passed check-in", () => {
    expect(partOptions(pass, false, "10:05").map((o) => [o.part, o.label])).toEqual([
      ["webcam", "Webcam frame"],
      ["screen", "Screen captures (2 displays)"],
      ["apps", "Apps"],
      ["domains", "Browser domains"],
    ]);
  });

  it("names the minute", () => {
    expect(partOptions(pass, false, "10:05")[2]?.detail).toContain("(10:05)");
  });

  it("offers nothing for anything but a pass", () => {
    expect(partOptions({ ...pass, outcome: "miss" }, false, "10:05")).toEqual([]);
  });

  it("leaves out what is already removed, and domains once the apps are gone", () => {
    expect(
      partOptions(
        { ...pass, removed: { ...noneRemoved, webcam: "x", apps: "y" } },
        false,
        "10:05",
      ).map((o) => o.part),
    ).toEqual(["screen"]);
  });

  it("leaves out images past retention and files that were never taken", () => {
    expect(partOptions(pass, true, "10:05").map((o) => o.part)).toEqual(["apps", "domains"]);
    expect(
      partOptions({ ...pass, objectKeys: ["screen-1.webp"] }, false, "10:05").map((o) => o.label),
    ).toEqual(["Screen capture", "Apps", "Browser domains"]);
  });
});

describe("pickedParts", () => {
  it("keeps a fixed order", () => {
    expect(pickedParts(new Set(["domains", "webcam"] as const))).toEqual(["webcam", "domains"]);
  });
});
