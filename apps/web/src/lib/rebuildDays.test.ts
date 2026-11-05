import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RebuildReply, rebuildDays } from "./rebuildDays";

const ok: RebuildReply = { error: null, status: 200 };
const refused: RebuildReply = { error: new Error("non-2xx"), status: 401 };
const broken: RebuildReply = { error: new Error("Edge Function returned a non-2xx"), status: 500 };

/** An invoke that answers each day from `answers` (a list per day, used in turn). */
function invoker(answers: Record<string, RebuildReply[]>) {
  const calls: string[] = [];
  const invoke = vi.fn(async (day: string) => {
    calls.push(day);
    const next = answers[day]?.shift();
    if (!next) throw new Error(`no answer left for ${day}`);
    return next;
  });
  return { invoke, calls };
}

describe("rebuildDays", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("calls once per day and resolves when all are rebuilt", async () => {
    const { invoke, calls } = invoker({ a: [ok], b: [ok] });
    const renewSession = vi.fn(async () => true);
    await rebuildDays(["a", "b"], { invoke, renewSession });
    expect(calls).toEqual(["a", "b"]);
    expect(renewSession).not.toHaveBeenCalled();
  });

  it("does nothing for no days", async () => {
    const { invoke } = invoker({});
    await rebuildDays([], { invoke, renewSession: async () => true });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects with the failure when a day fails", async () => {
    const { invoke } = invoker({ a: [ok], b: [broken] });
    await expect(
      rebuildDays(["a", "b"], { invoke, renewSession: async () => true }),
    ).rejects.toMatchObject({
      name: "RebuildError",
      timedOut: false,
      message: "Edge Function returned a non-2xx",
    });
  });

  it("gives up after the time limit, aborting the calls", async () => {
    let signal: AbortSignal | undefined;
    const invoke = vi.fn(
      (_day: string, s: AbortSignal) =>
        new Promise<RebuildReply>((resolve) => {
          signal = s;
          s.addEventListener("abort", () => resolve({ error: new Error("aborted"), status: null }));
        }),
    );
    const done = rebuildDays(["a"], { invoke, renewSession: async () => true, timeoutMs: 15_000 });
    const result = expect(done).rejects.toMatchObject({
      timedOut: true,
      message: "no answer in 15 s",
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(signal?.aborted).toBe(true);
  });

  it("renews the session after a 401 and tries the refused days once more", async () => {
    const { invoke, calls } = invoker({ a: [ok], b: [refused, ok], c: [refused, ok] });
    const renewSession = vi.fn(async () => true);
    await rebuildDays(["a", "b", "c"], { invoke, renewSession });
    expect(renewSession).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["a", "b", "c", "b", "c"]);
  });

  it("treats a 401 with no session to renew as signed out, not a failure", async () => {
    const { invoke, calls } = invoker({ a: [refused], b: [refused] });
    await rebuildDays(["a", "b"], { invoke, renewSession: async () => false });
    expect(calls).toEqual(["a", "b"]);
  });

  it("fails when the renewed token is refused too", async () => {
    const { invoke } = invoker({ a: [refused, refused] });
    await expect(
      rebuildDays(["a"], { invoke, renewSession: async () => true }),
    ).rejects.toMatchObject({
      timedOut: false,
    });
  });

  it("counts the renewal against the time limit", async () => {
    const { invoke } = invoker({ a: [refused] });
    const renewSession = () => new Promise<boolean>(() => undefined);
    const done = rebuildDays(["a"], { invoke, renewSession, timeoutMs: 1000 });
    const result = expect(done).rejects.toMatchObject({ timedOut: true });
    await vi.advanceTimersByTimeAsync(1000);
    await result;
  });
});
