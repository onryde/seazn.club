import "server-only";
// Global creation throttle (design §3.3, measured fact M3).
//
// M3, 2026-10-09: four `POST /api/challenge/<user>` in ~1s, then every
// subsequent create returned {"error":"Too many requests. Try again later."}.
// A 64-player round wants 32 games at once, so creation goes through one
// serial queue with a minimum spacing and a backoff ladder.
//
// M4: moves are NOT rate-limited (8 back-to-back posts, all 200). Nothing but
// creation belongs here — putting a move behind this queue would add latency
// to every tap for no measured reason.
//
// SCOPE: this queue is PER PROCESS. With N web machines the aggregate rate is
// N × (1 / CREATION_MIN_SPACING_MS), which is accepted:
//   - two creates for ONE fixture cannot both be recorded, by a stronger
//     mechanism than rate limiting (room.ts's claim-then-call gives one
//     claimant per fixture, and fixture_external_play_challenge_idx is unique
//     on challenge_id), so a cross-instance collision costs a 429, not a
//     second recorded game;
//   - 350 ms is ~2.9 creates/s against M3's measured ~4/s ceiling, so two
//     instances creating flat out sit near the limit rather than past it.
// What this queue does NOT guarantee: that a create lands inside the claim it
// was made under. The backoff ladder sums to 7s, inside MINT_CLAIM_STALE_MS
// (30s), but time spent WAITING here counts against the same claim — a create
// at the back of a 32-deep round waits ~11s before its first attempt, and each
// 429 re-queues it behind whatever arrived meanwhile — so a sustained 429
// storm can outlast the claim. room.ts's ready commit is conditional on
// `mint_claimed_at` still being this caller's value, so a takeover cannot be
// stomped in our table; but the taken-over create may still land at Lichess,
// unrecorded. Checking the claim's age before the call is the CALLER's job.
// If sustained 429s ever show up: the next step is a DB-backed lease keyed on
// (stage_id, round_no), in the shape of V428's ingest_polled_at claim — NOT a
// bigger backoff. Deliberately not built; nothing has measured the need.

/** ~2.9 creates/s against M3's measured ~4/s. A 32-game round opens in ~11s. */
export const CREATION_MIN_SPACING_MS = 350;

/** Strictly increasing, and summing to 7s — inside MINT_CLAIM_STALE_MS (30s).
 *  Queue WAIT is not part of this sum; see SCOPE above. */
export const CREATION_BACKOFF_MS = [1000, 2000, 4000] as const;

/** Thrown by the JOB to ask for a backoff and a retry. The queue is generic
 *  over T and cannot inspect a result value for a 429, so the knowledge lives
 *  at the call site, which has the typed BoardCall in hand:
 *  `if (out.code === "rate_limited") throw new CreationRateLimited(out.raw)`. */
export class CreationRateLimited extends Error {
  constructor(message = "Lichess rate limited the create") {
    super(message);
    this.name = "CreationRateLimited";
  }
}

export type CreationQueueDeps = { now: () => number; sleep: (ms: number) => Promise<void> };

const realDeps: CreationQueueDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
let deps: CreationQueueDeps = realDeps;

/** Serial tail. Every enqueue chains onto it, which is what makes the queue
 *  one-at-a-time without a lock. */
let tail: Promise<unknown> = Promise.resolve();
let lastRunAt = Number.NEGATIVE_INFINITY;
/** In-flight runs by key, so two tabs submitting the same fixture share one
 *  create instead of racing for the claim. */
const inFlight = new Map<string, Promise<unknown>>();

/** TESTS ONLY — inject a virtual clock so spacing and backoff are asserted
 *  exactly, with nothing actually sleeping. */
export function __setCreationQueueDeps(d: Partial<CreationQueueDeps>): void {
  deps = { ...deps, ...d };
}

/** TESTS ONLY — drop the tail, the spacing memory and the in-flight map. */
export function __resetCreationQueue(): void {
  deps = realDeps;
  tail = Promise.resolve();
  lastRunAt = Number.NEGATIVE_INFINITY;
  inFlight.clear();
}

async function runSpaced<T>(job: () => Promise<T>): Promise<T> {
  const since = deps.now() - lastRunAt;
  if (since < CREATION_MIN_SPACING_MS) {
    await deps.sleep(CREATION_MIN_SPACING_MS - since);
  }
  lastRunAt = deps.now();
  return job();
}

/** One slot on the serial tail. Rejections are swallowed from the TAIL (so one
 *  failed create does not stall the queue) while still reaching the caller. */
function chain<T>(run: () => Promise<T>): Promise<T> {
  const slot = tail.then(run, run);
  tail = slot.then(
    () => undefined,
    () => undefined,
  );
  return slot;
}

export function enqueueCreation<T>(key: string, job: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const attempt = async (n: number): Promise<T> => {
    try {
      return await chain(() => runSpaced(job));
    } catch (err) {
      // Only a 429 is retried. A bad username, or a provider error, must not
      // be hammered — it would burn the rate budget the rest of the round
      // needs.
      if (!(err instanceof CreationRateLimited) || n >= CREATION_BACKOFF_MS.length) throw err;
      await deps.sleep(CREATION_BACKOFF_MS[n]!);
      // Re-queued, not held at the head: a 32-game round must not stop dead
      // on one unlucky pairing.
      return attempt(n + 1);
    }
  };

  const promise = attempt(0).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}
