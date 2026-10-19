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
