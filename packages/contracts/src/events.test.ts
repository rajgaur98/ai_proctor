import { describe, expect, it } from "vitest";
import { AgentEvent, agentEventTypes } from "./events.ts";

const base = {
  id: "0192f0c4-7d2e-7b31-9a40-3f1c2b6d8e11",
  seq: 1842,
  at: "2026-10-07T09:40:12.481Z",
  mono_ms: 8412331,
};

describe("AgentEvent", () => {
  it("accepts the LLD's example check-in", () => {
    const event = {
      ...base,
      type: "checkin",
      payload: {
        scheduled_at: "2026-10-07T09:39:58Z",
        shown_at: "2026-10-07T09:40:00Z",
        responded_at: "2026-10-07T09:40:12Z",
        outcome: "pass",
        response_ms: 12481,
        wrong_clicks: 0,
        idle_s_at_show: 4,
        device_state: "active",
        object_keys: ["screen-1.webp", "webcam.webp"],
        project_id: null,
        flags: [],
      },
    };
    expect(AgentEvent.parse(event)).toEqual(event);
  });

  it("accepts a deferred check-in with its reason (CHK-03)", () => {
    const event = {
      ...base,
      type: "checkin",
      payload: {
        scheduled_at: "2026-10-07T09:39:58Z",
        shown_at: null,
        responded_at: null,
        outcome: "deferred",
        deferral_reason: "screen_share",
        response_ms: null,
        wrong_clicks: 0,
        idle_s_at_show: null,
        device_state: null,
        object_keys: [],
        project_id: null,
        flags: [],
      },
    };
    expect(AgentEvent.parse(event)).toEqual(event);
    for (const reason of ["call", "presenting"]) {
      const payload = { ...event.payload, deferral_reason: reason };
      expect(AgentEvent.safeParse({ ...event, payload }).success).toBe(true);
    }
    const unknown = { ...event.payload, deferral_reason: "lunch" };
    expect(AgentEvent.safeParse({ ...event, payload: unknown }).success).toBe(false);
  });

  it("covers every LLD event type", () => {
    expect(agentEventTypes).toEqual(
      expect.arrayContaining([
        "clock_in",
        "clock_out",
        "break_start",
        "break_end",
        "pause_start",
        "pause_end",
        "project_switch",
        "checkin",
        "idle_start",
        "idle_end",
        "lock",
        "unlock",
        "sleep",
        "wake",
        "call_start",
        "call_end",
        "app_session",
        "permission_change",
      ]),
    );
  });

  it("rejects a pause preset other than 5, 10 or 15 minutes (BRK-03)", () => {
    expect(() =>
      AgentEvent.parse({ ...base, type: "pause_start", payload: { planned_min: 7 } }),
    ).toThrow();
  });

  it("accepts an optional private pause reason of up to 200 characters (BRK-03)", () => {
    const pause = (payload: object) =>
      AgentEvent.safeParse({ ...base, type: "pause_start", payload }).success;
    expect(pause({ planned_min: 5 })).toBe(true);
    expect(pause({ planned_min: 5, reason: "Doctor call" })).toBe(true);
    expect(pause({ planned_min: 5, reason: "x".repeat(200) })).toBe(true);
    expect(pause({ planned_min: 5, reason: "x".repeat(201) })).toBe(false);
  });

  it("rejects unknown payload fields", () => {
    expect(() => AgentEvent.parse({ ...base, type: "lock", payload: { extra: 1 } })).toThrow();
  });

  it("rejects file names that are not plain .webp names", () => {
    expect(() =>
      AgentEvent.parse({
        ...base,
        type: "checkin",
        payload: {
          scheduled_at: base.at,
          outcome: "pass",
          wrong_clicks: 0,
          object_keys: ["../other-user/screen-1.webp"],
          flags: [],
        },
      }),
    ).toThrow();
  });
});
