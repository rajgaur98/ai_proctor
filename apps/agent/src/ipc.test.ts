import type { AgentStatus } from "@ai-proctor/contracts";
import { describe, expect, it } from "vitest";
import { invoke, listen } from "./ipc";

const status: AgentStatus = {
  shift: "off_shift",
  signed_in: false,
  account_email: null,
  agent_version: "0.1.0",
  permissions: { screen: "granted", camera: "not_determined" },
  clocked_in_at: null,
  phase_started_at: null,
  pause_ends_at: null,
  pause_planned_min: null,
  worked_today_s: 0,
  pause_used_today_s: 0,
  pause_daily_cap_s: 3600,
  project: null,
  projects: [],
  last_checkin: null,
  missed_checkin: null,
};

// Every nullable and list field filled in, as the core sends it mid-shift.
const fullStatus: AgentStatus = {
  ...status,
  shift: "paused",
  signed_in: true,
  account_email: "lucas@acme.test",
  clocked_in_at: "2026-10-07T03:32:00Z",
  phase_started_at: "2026-10-07T08:00:00Z",
  pause_ends_at: "2026-10-07T08:15:00Z",
  pause_planned_min: 15,
  worked_today_s: 18720,
  pause_used_today_s: 900,
  project: { id: "p1", name: "Acme Redesign", client: "Acme" },
  projects: [
    { id: "p1", name: "Acme Redesign", client: "Acme" },
    { id: "p2", name: "Internal", client: null },
  ],
  last_checkin: { at: "2026-10-07T05:12:00Z", outcome: "pass" },
  missed_checkin: { id: "c1", at: "2026-10-07T08:33:00Z" },
};

describe("invoke", () => {
  it("returns a reply that matches the contract", async () => {
    const calls: unknown[] = [];
    const result = await invoke("get_status", {}, async (cmd, args) => {
      calls.push([cmd, args]);
      return status;
    });
    expect(result).toEqual(status);
    expect(calls).toEqual([["get_status", {}]]);
  });

  it("accepts a status with every new field filled in", async () => {
    const result = await invoke("get_status", {}, async () => fullStatus);
    expect(result).toEqual(fullStatus);
  });

  it("rejects a status that is missing a new field", async () => {
    const { projects: _projects, ...partial } = fullStatus;
    await expect(invoke("get_status", {}, async () => partial)).rejects.toThrow();
  });

  it("rejects a reply that drifted from the contract", async () => {
    await expect(
      invoke("get_status", {}, async () => ({ ...status, shift: "lunch" })),
    ).rejects.toThrow();
  });
});

describe("sign_in_start", () => {
  it("passes the email and validates the result", async () => {
    const calls: unknown[] = [];
    const result = await invoke(
      "sign_in_start",
      { email: "lucas@acme.test" },
      async (cmd, args) => {
        calls.push([cmd, args]);
        return { ok: false, error: "This email isn't invited yet." };
      },
    );
    expect(result).toEqual({ ok: false, error: "This email isn't invited yet." });
    expect(calls).toEqual([["sign_in_start", { email: "lucas@acme.test" }]]);
  });
});

describe("tray commands", () => {
  it("sends a pause with a private reason and reads the result", async () => {
    const calls: unknown[] = [];
    const result = await invoke(
      "pause_start",
      { minutes: 10, reason: "school run" },
      async (cmd, args) => {
        calls.push([cmd, args]);
        return { ok: false, error: "Pause allowance used up for today." };
      },
    );
    expect(result).toEqual({ ok: false, error: "Pause allowance used up for today." });
    expect(calls).toEqual([["pause_start", { minutes: 10, reason: "school run" }]]);
  });

  it("sends a miss reason", async () => {
    const args = { checkin_id: "c1", kind: "meeting", note: null } as const;
    const result = await invoke("set_miss_reason", args, async (_cmd, a) => {
      expect(a).toEqual(args);
      return { ok: true, error: null };
    });
    expect(result.ok).toBe(true);
  });
});

describe("card", () => {
  const challenge = {
    card_id: "0190f5b0-0000-7000-8000-000000000001",
    target: 7,
    options: [3, 7, 1],
    remaining_s: 90,
    wrong_clicks: 0,
    sound: false,
    project: null,
  };

  it("accepts a challenge and rejects one without three options", async () => {
    const received: unknown[] = [];
    await listen(
      "card_challenge",
      (payload) => received.push(payload),
      async (_event, handler) => {
        handler({ payload: challenge });
        expect(() => handler({ payload: { ...challenge, options: [7, 1] } })).toThrow();
        return () => {};
      },
    );
    expect(received).toEqual([challenge]);
  });

  it("reports a click and reads the verdict", async () => {
    const args = { card_id: challenge.card_id, value: 7, trusted: true };
    const result = await invoke("card_click", args, async (_cmd, a) => {
      expect(a).toEqual(args);
      return "pass";
    });
    expect(result).toBe("pass");
  });
});

describe("listen", () => {
  it("delivers validated payloads", async () => {
    const received: AgentStatus[] = [];
    await listen(
      "status_changed",
      (payload) => received.push(payload),
      async (_event, handler) => {
        handler({ payload: fullStatus });
        return () => {};
      },
    );
    expect(received).toEqual([fullStatus]);
  });
});
