import { describe, expect, it } from "vitest";
import { flagCheckinIds, flagText } from "./flagText";

describe("flagText", () => {
  it("describes injected clicks", () => {
    expect(flagText("injected_click", { clicks: 3, checkin_ids: [] })).toEqual({
      title: "Check-in clicks from another program",
      detail: "3 clicks on the card didn't come from a mouse or trackpad and were blocked.",
    });
    expect(flagText("injected_click", { clicks: 1 }).detail).toBe(
      "1 click on the card didn't come from a mouse or trackpad and was blocked.",
    );
  });

  it("describes fast responses with the fastest time", () => {
    expect(flagText("fast_response", { count: 2, min_response_ms: 250 }).detail).toBe(
      "2 check-ins were answered in under 0.3 s (fastest 250 ms).",
    );
    expect(flagText("fast_response", { count: 1, min_response_ms: 120 }).detail).toBe(
      "1 check-in was answered in under 0.3 s (fastest 120 ms).",
    );
  });

  it("describes even response times with the numbers behind them", () => {
    expect(flagText("low_variance", { passes: 6, mean_ms: 4000, cv: 0.0198 }).detail).toBe(
      "6 check-ins were answered in almost the same time: average 4.0 s, spread 2.0%.",
    );
  });

  it("describes synthetic clicks as let through", () => {
    expect(flagText("synthetic_click", { clicks: 2 })).toEqual({
      title: "Check-in clicks that looked automated",
      detail:
        "2 clicks on the card looked like they came from another program rather than a mouse or trackpad. The check-in counted as usual.",
    });
    expect(flagText("synthetic_click", { clicks: 1 }).detail).toMatch(
      /^1 click on the card looked like it/,
    );
  });

  it("names the virtual cameras", () => {
    expect(
      flagText("virtual_camera", { count: 2, cameras: ["ManyCam", "OBS Virtual Camera"] }).detail,
    ).toBe(
      "The webcam image came from ManyCam, OBS Virtual Camera at 2 check-ins. A virtual camera can show any video, not just the room.",
    );
    expect(flagText("virtual_camera", { count: 1, cameras: [] }).detail).toMatch(
      /^The webcam image came from a virtual camera at 1 check-in\./,
    );
  });

  it("describes duplicate frames, VMs and remote sessions", () => {
    expect(flagText("duplicate_frame", { count: 2, min_distance: 0 })).toEqual({
      title: "Webcam images look the same",
      detail: "2 webcam images were almost identical to an earlier check-in's. Compare the images.",
    });
    expect(flagText("virtual_machine", { count: 3 }).detail).toBe(
      "The app was running inside a virtual machine at 3 check-ins.",
    );
    expect(flagText("remote_session", { count: 1 }).detail).toBe(
      "The computer was being used or controlled remotely (such as Remote Desktop or Screen Sharing) at 1 check-in.",
    );
  });

  it("falls back when details are missing", () => {
    expect(flagText("fast_response", null).detail).toBe(
      "Some check-ins were answered in under 0.3 s.",
    );
    expect(flagText("low_variance", {}).detail).toBe(
      "Check-ins were answered in almost the same time.",
    );
    expect(flagText("injected_click", {}).detail).toContain("Some clicks");
  });

  it("never calls anyone a cheat", () => {
    for (const kind of [
      "injected_click",
      "fast_response",
      "low_variance",
      "synthetic_click",
      "virtual_camera",
      "duplicate_frame",
      "virtual_machine",
      "remote_session",
    ] as const) {
      const { title, detail } = flagText(kind, {});
      expect(`${title} ${detail}`).not.toMatch(/cheat|violation|fraud|fake/i);
    }
  });
});

describe("flagCheckinIds", () => {
  it("lists the check-ins a flag points at", () => {
    expect(flagCheckinIds({ checkin_ids: ["a", "b", 3] })).toEqual(["a", "b"]);
  });

  it("is empty when there are none", () => {
    expect(flagCheckinIds({ passes: 5 })).toEqual([]);
    expect(flagCheckinIds(null)).toEqual([]);
    expect(flagCheckinIds([])).toEqual([]);
  });
});
