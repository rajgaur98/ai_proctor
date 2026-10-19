import type { AgentStatus } from "@ai-proctor/contracts";
import { describe, expect, it } from "vitest";
import { invoke, listen } from "./ipc";

const status: AgentStatus = {
  shift: "off_shift",
  signed_in: false,
  account_email: null,
  agent_version: "0.1.0",
  permissions: { screen: "granted", camera: "not_determined" },
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
        handler({ payload: status });
        return () => {};
      },
    );
    expect(received).toEqual([status]);
  });
});
