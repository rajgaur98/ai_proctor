// How the report shows its numbers. Everything is added up from raw values; only these
// strings are rounded (TS-05/06).

/** "63%" from a fraction; "—" when there is nothing to divide (no check-ins shown). */
export function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

/** "850 ms" under a second, "3.2 s" up to a minute, then "1 min 05 s"; "—" for none. */
export function formatResponse(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 59.95) return `${seconds.toFixed(1)} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)} min ${String(whole % 60).padStart(2, "0")} s`;
}
