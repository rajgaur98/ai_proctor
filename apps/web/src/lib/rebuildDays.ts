// #338: asks the rebuild-segments Edge Function to rebuild some days (LLD section 6), with a
// time limit and one session renewal on a 401. Pure (the caller passes the call and the
// renewal), so it's unit-tested without Supabase; lib/rebuildSegments.ts wires it up.
//
// Why a 401 renews rather than fails: the function answers 401 when the access token it got
// is refused, either by the gateway (expired) or by its own sign-in check (expired, or the
// session was ended). Both were seen locally: a browser left asleep past the token's hour
// sent its expired token on wake, before the client refreshed it; and a sign-out (scope
// global, which ends every session of that person) refused the calls still in flight.
// Renewing tells the two apart: a new token means the calls are tried once more, and no
// session to renew means the person signed out, so the refusal was deliberate and there is
// nothing to report (the app is on its way to the sign-in page).

/** How long the dashboard waits for a rebuild before showing what is stored. */
export const REBUILD_TIMEOUT_MS = 15_000;

/** One day's call: `status` is the HTTP status when the function answered, else null. */
export interface RebuildReply {
  error: unknown;
  status: number | null;
}

export interface RebuildDeps {
  invoke: (day: string, signal: AbortSignal) => Promise<RebuildReply>;
  /** Gets a new access token; false when there is no session to renew (signed out). */
  renewSession: () => Promise<boolean>;
  timeoutMs?: number;
}

/** A rebuild that failed or didn't finish in time; what is stored stays as it was. */
export class RebuildError extends Error {
  constructor(
    message: string,
    readonly timedOut: boolean,
  ) {
    super(message);
    this.name = "RebuildError";
  }
}

const detail = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";

/**
 * Rebuilds `days` in parallel. Resolves when every day is rebuilt (or the person turned out
 * to be signed out); rejects with a RebuildError when a day fails, or when the whole
 * rebuild, renewal included, takes longer than `timeoutMs` (the calls are then aborted).
 */
export async function rebuildDays(days: string[], deps: RebuildDeps): Promise<void> {
  if (days.length === 0) return;
  const timeoutMs = deps.timeoutMs ?? REBUILD_TIMEOUT_MS;
  const controller = new AbortController();
  const call = (list: string[]) =>
    Promise.all(list.map((day) => deps.invoke(day, controller.signal)));

  const work = (async () => {
    const replies = await call(days);
    const refused = days.filter((_, i) => replies[i]?.status === 401);
    let settled = replies.filter((r) => r.status !== 401);
    if (refused.length > 0) {
      if (!(await deps.renewSession())) return;
      settled = [...settled, ...(await call(refused))];
    }
    const failed = settled.find((r) => r.error);
    if (failed) throw new RebuildError(detail(failed.error), false);
  })();
  // Once the time is up nobody waits for `work`; its own failure mustn't surface.
  work.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    if ((await Promise.race([work, timeout])) === "timeout") {
      controller.abort();
      throw new RebuildError(`no answer in ${Math.round(timeoutMs / 1000)} s`, true);
    }
  } finally {
    clearTimeout(timer);
  }
}
