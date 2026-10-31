import { describe, expect, it } from "vitest";
import { noneRemoved } from "../day/removedText";
import { CAPTURES_HEADER, capturesTable } from "./capturesExport";
import type { CaptureView } from "./helpers";
import type { MyCheckin } from "./queries";

function checkin(extra: Partial<MyCheckin>): MyCheckin {
  return {
    id: "c1",
    scheduledAt: "2026-10-19T09:00:00Z",
    shownAt: "2026-10-19T09:00:05Z",
    respondedAt: "2026-10-19T09:00:07Z",
    outcome: "pass",
    deferralReason: null,
    idleSAtShow: null,
    deviceState: "active",
    missedReason: null,
    missedReasonKind: null,
    objectKeys: ["screen-1.webp", "webcam.webp"],
    projectId: "p1",
    facePresent: true,
    removed: noneRemoved,
    ...extra,
  };
}

function view(extra: Partial<CaptureView>): CaptureView {
  return {
    viewedAt: "2026-10-19T12:00:00Z",
    viewerId: "m1",
    viewerName: "Max Manager",
    viewerRole: "manager",
    checkinId: "c1",
    checkinAt: "2026-10-19T09:00:00Z",
    ...extra,
  };
}

const now = Date.parse("2026-10-20T00:00:00Z");
const project = (id: string | null) => (id === "p1" ? "Website" : "No project");

describe("capturesTable", () => {
  it("lists each check-in's captures as metadata with who viewed them", () => {
    const table = capturesTable(
      [checkin({}), checkin({ id: "c2", outcome: "deferred", objectKeys: [], projectId: null })],
      (id) => (id === "c1" ? "Code" : null),
      project,
      [
        view({}),
        view({
          viewedAt: "2026-10-19T15:00:00Z",
          viewerId: "a1",
          viewerName: "Ada Admin",
          viewerRole: "owner",
        }),
        view({ viewedAt: "2026-10-19T16:00:00Z" }),
        view({ checkinId: "other" }),
      ],
      30,
      now,
      "UTC",
    );
    expect(table.header).toEqual(CAPTURES_HEADER);
    expect(table.rows).toEqual([
      [
        "2026-10-19T09:00:05Z",
        "Passed",
        1,
        "Yes",
        "",
        "",
        "No",
        "Code",
        "Website",
        "Max Manager (manager); Ada Admin (admin)",
        3,
        "2026-10-19T16:00:00Z",
      ],
      ["2026-10-19T09:00:05Z", "Deferred", 0, "No", "", "", "", "", "No project", "", 0, ""],
    ]);
  });

  it("leaves out a removed app and says when retention deleted the images", () => {
    const [row] = capturesTable(
      [
        checkin({
          scheduledAt: "2026-09-01T09:00:00Z",
          removed: { ...noneRemoved, apps: "2026-09-02T00:00:00Z" },
        }),
      ],
      () => "Code",
      project,
      [],
      30,
      now,
      "UTC",
    ).rows;
    expect(row?.[CAPTURES_HEADER.indexOf("Images deleted (retention)")]).toBe("Yes");
    expect(row?.[CAPTURES_HEADER.indexOf("App")]).toBe("");
    expect(row?.[CAPTURES_HEADER.indexOf("Removed parts")]).toBe("Apps");
  });
});
