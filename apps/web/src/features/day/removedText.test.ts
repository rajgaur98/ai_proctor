import { describe, expect, it } from "vitest";
import { noneRemoved, partRemovedText, removedParts, removedText } from "./removedText";

const zone = "America/Los_Angeles";

describe("removedText", () => {
  it("is null when nothing was removed", () => {
    expect(removedText(noneRemoved, "Erin", zone)).toBeNull();
  });

  it("names one part", () => {
    expect(
      removedText({ ...noneRemoved, webcam: "2026-10-31T18:00:00Z" }, "Erin Employee", zone),
    ).toBe("Webcam removed by Erin Employee on 31 Oct");
  });

  it("joins several parts in a fixed order, with the day of the last removal", () => {
    expect(
      removedText(
        {
          webcam: "2026-10-30T18:00:00Z",
          screen: "2026-10-31T18:00:00Z",
          apps: null,
          domains: "2026-10-29T18:00:00Z",
        },
        "you",
        zone,
      ),
    ).toBe("Webcam, screen and browser domains removed by you on 31 Oct");
  });

  it("reads the day in the given zone", () => {
    expect(removedText({ ...noneRemoved, apps: "2026-11-01T03:00:00Z" }, "Erin", zone)).toBe(
      "Apps removed by Erin on 31 Oct",
    );
  });

  it("lists the removed parts", () => {
    expect(removedParts({ ...noneRemoved, screen: "x", apps: "y" })).toEqual(["screen", "apps"]);
  });

  it("words one slot", () => {
    expect(partRemovedText("Webcam frame", "2026-10-31T18:00:00Z", "Erin", zone)).toBe(
      "Webcam frame removed by Erin on 31 Oct",
    );
  });
});
