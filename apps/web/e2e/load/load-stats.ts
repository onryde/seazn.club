// T17B fix 2, D22 — the arithmetic behind e2e/load/chess-30-boards.load.ts's report. Pure, so the numbers a reader
// takes away (calls per vendor per five minutes, p50/p95) are checked by hand-counted cases in
// src/server/external-play/__tests__/load-stats.test.ts rather than trusted.

/** The limits the run is judged against. The RealtimeKit pair is video/budget.ts's (RTK_VENDOR_LIMIT_PER_WINDOW,
 *  RTK_CALLS_PER_WINDOW, RTK_BUDGET_WINDOW_MS), which a Playwright runner cannot import (`server-only`) - load-stats.test.ts
 *  pins the two against each other. Lichess: 500 challenge creates per ten minutes per IP (the coordinator's brief for
 *  D22). Database: the production connection budget (60). */
export const LOAD_LIMITS = {
  windowMs: 5 * 60_000,
  rtkVendor: 1_200,
  rtkCeiling: 900,
  /** The call budget's bucket (video/budget.ts RTK_BUDGET_BURST / RTK_BUDGET_REFILL_PER_S): capacity and tokens per second. */
  rtkBurst: 300,
  rtkRefillPerS: 2,
  lichessCreateWindowMs: 10 * 60_000,
  lichessCreatesPer10Min: 500,
  dbConnectionBudget: 60,
} as const;

/** The check-in screen's bounds as the load test models a player (room-snapshot.ts CAMERA_EVIDENCE_MAX_POLLS; room-shell.tsx
 *  SEAT_RETRIES is not exported, so only the first is pinned - load-stats.test.ts). */
export const CLIENT_SEAT = { maxPolls: 5, seatRetries: 3 } as const;

/** D21-fix-3: how an optional camera seated with no token (the budget was spent) asks again - use-room.ts
 *  CAMERA_RETRY_BASE_MS / CAMERA_RETRY_MAX_MS, the owner's "2/4/8/16 s, capped at about 30 s". The same copy-and-pin. */
export const CLIENT_CAMERA_RETRY = { baseMs: 2_000, maxMs: 30_000 } as const;
/** The wait before the `attempt`-th ask (0-based), typed from the ruling's schedule - not imported from the room. */
export function cameraRetryWaitMs(attempt: number): number {
  return Math.min(CLIENT_CAMERA_RETRY.baseMs * 2 ** Math.max(0, attempt), CLIENT_CAMERA_RETRY.maxMs);
}

/** Nearest-rank percentile: the smallest value with at least p% of the sample at or below it. Refuses an empty sample
 *  (a percentile of nothing would be a vacuous 0 in a report) and a p outside (0, 100]. */
export function percentile(sample: readonly number[], p: number): number {
  if (sample.length === 0) throw new Error("percentile: empty sample");
  if (!(p > 0 && p <= 100)) throw new RangeError(`percentile: p must be in (0, 100], got ${p}`);
  const sorted = [...sample].sort((a, b) => a - b);
  return sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1]!;
}

/** The most events in ANY closed window of `windowMs` (both ends count: events exactly one window apart share one) —
 *  the sliding-window bound the vendor's limit is, which a fixed-bucket count can under-read by up to half. `windows`
 *  is how many windows were looked at (one per event: the busiest window begins at an event), so a caller can refuse a
 *  report that checked nothing. */
export function slidingWindowMax(
  events: readonly number[],
  windowMs: number,
): { max: number; windows: number; startAt: number | null } {
  const ts = [...events].sort((a, b) => a - b);
  let max = 0;
  let startAt: number | null = null;
  let hi = 0;
  for (let lo = 0; lo < ts.length; lo += 1) {
    while (hi < ts.length && ts[hi]! <= ts[lo]! + windowMs) hi += 1;
    if (hi - lo > max) {
      max = hi - lo;
      startAt = ts[lo]!;
    }
  }
  return { max, windows: ts.length, startAt };
}

/** Replay recorded call times through a token bucket (video/budget.ts's shape: starts FULL, refills continuously, never
 *  above its capacity, one token a call, a call finding less than one is REFUSED and spends nothing). The answer to "how
 *  many of these calls would the platform's call budget have deferred". Open loop: a refused call is not retried here,
 *  while in the product it comes back later - so this counts the demand the bucket would have pushed back on, which is
 *  what a run against an unmetered fixture host can show. */
export function replayBucket(
  calls: readonly number[],
  bucket: { burst: number; refillPerS: number },
): { granted: number; refused: number; refusedAt: number[] } {
  if (!(bucket.burst >= 1)) throw new RangeError(`replayBucket: a bucket must hold at least one token, got ${bucket.burst}`);
  if (!(bucket.refillPerS >= 0)) throw new RangeError(`replayBucket: the refill rate cannot be negative, got ${bucket.refillPerS}`);
  const ts = [...calls].sort((a, b) => a - b);
  let tokens = bucket.burst;
  let last = ts[0] ?? 0;
  let granted = 0;
  const refusedAt: number[] = [];
  for (const t of ts) {
    tokens = Math.min(bucket.burst, tokens + (bucket.refillPerS * (t - last)) / 1_000);
    last = t;
    if (tokens >= 1) {
      tokens -= 1;
      granted += 1;
    } else {
      refusedAt.push(t);
    }
  }
  return { granted, refused: refusedAt.length, refusedAt };
}

/** Events per consecutive fixed window from `originMs`: window i is [origin + i*w, origin + (i+1)*w). The empty windows
 *  between are kept (a quiet window is a fact); an event before the origin is a caller bug. */
export function callsPerWindow(events: readonly number[], originMs: number, windowMs: number): number[] {
  const counts: number[] = [];
  for (const t of events) {
    if (t < originMs) throw new RangeError(`callsPerWindow: event ${t} is before the origin ${originMs}`);
    const i = Math.floor((t - originMs) / windowMs);
    while (counts.length <= i) counts.push(0);
    counts[i]! += 1;
  }
  return counts;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Order matters: the first rule that matches wins. An endpoint no rule names is left as it is, so a new one shows up
// in the report as its own (per-id) row rather than being folded into a wrong group.
const RULES: readonly [RegExp, string][] = [
  [/^\/api\/board\/game\/stream\/[^/]+$/, "/api/board/game/stream/:id"],
  [/^\/api\/board\/game\/[^/]+\/move\/[^/]+$/, "/api/board/game/:id/move/:uci"],
  [/^\/api\/board\/game\/[^/]+\/draw\/(yes|no)$/, "/api/board/game/:id/draw/$1"],
  [/^\/api\/board\/game\/[^/]+\/(resign|abort)$/, "/api/board/game/:id/$1"],
  [/^\/api\/challenge\/[^/]+\/(accept|cancel|decline)$/, "/api/challenge/:id/$1"],
  [/^\/api\/challenge\/[^/]+$/, "/api/challenge/:id"],
  [/^\/game\/export\/[^/]+$/, "/game/export/:id"],
  [/^\/accounts\/[^/]+\/realtime\/kit\/[^/]+\/(.*)$/, "/accounts/:acct/realtime/kit/:app/$1"],
];

/** A vendor path with its ids replaced, so calls group by endpoint and not by game or meeting. */
export function normalisePath(path: string): string {
  let out = path;
  for (const [re, to] of RULES) {
    if (re.test(out)) {
      out = out.replace(re, to);
      break;
    }
  }
  return out
    .replace(new RegExp(UUID, "gi"), ":id")
    // The RealtimeKit FIXTURE's ids (realtimekit-fixture-server.ts `next()`): mtg-0001-xxxx, prt-..., ses-...
    .replace(/\b(mtg|prt|ses)-[0-9a-z]{4}-[0-9a-z]+\b/g, ":id")
    .replace(/\/peer-report\/[^/]+$/, "/peer-report/:id");
}

/** Calls counted by `METHOD normalised-path`. */
export function groupCalls(calls: readonly { method: string; path: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of calls) {
    const key = `${c.method} ${normalisePath(c.path)}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
