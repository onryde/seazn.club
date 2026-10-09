import "server-only";
// Creation limits (design §3.3; measured fact M3, corrected 2026-10-09).
//
// What limits a create is lila's own two limiters. Source, not measurement —
// lichess-org/lila eab1e3ac2, read 2026-10-09:
//   - PER CHALLENGER (`challenge.create.user`, modules/web/src/main/
//     Limiters.scala): 25 credits a minute and 200 a day, and a create to a
//     human who does not follow the challenger costs 5 (app/controllers/
//     Challenge.scala, apiCreate) — so 5 a minute and 40 a day per White
//     token. White's token creates, so a round asks ONE create of each White:
//     a normal round never comes near it. It bites on retries for the same
//     player.
//   - PER IP (`challenge.create.ip`): 500 per 10 minutes, cost 1. Every create
//     leaves from our servers, so this is the real ceiling on how many boards
//     can start together.
// The v1 battery agrees: five creates landed and the sixth 429'd (M3). Round 0
// read that log as "four a second" and throttled every create globally; there
// is no such limit, and the spacing it bought was claim time spent waiting.
//
// HOW IT IS MODELLED. A sliding log of stamps per limit. lila's window opens at
// its first charge (modules/memo/src/main/RateLimit.scala: clearAt = first +
// duration) and refuses while count >= credits AND now <= clearAt. Here a
// create is stamped when its RESPONSE is back — never earlier than lila's
// charge — and the window edge is inclusive, so a window this module thinks
// has closed has closed at lila too: it can refuse a create lila would take,
// and never sends one lila would refuse. Every attempt is charged, whatever
// Lichess answered (lila skips a form error; this module cannot tell), and
// every create is charged 5 (lila charges 0 when Black follows White) — both
// on the safe side. The challenger is lowercased, because lila keys the bucket
// by UserId, the lowercased name (modules/core/src/main/userId.scala).
//
// A LIMIT NEVER MAKES THIS MODULE WAIT. A create the model refuses, and a
// Lichess 429, both come back at once as CreationRateLimited with `retryAt`.
// Nothing is slept on, because the caller holds a fixture claim
// (MINT_CLAIM_STALE_MS, 30s) that a one-minute wait would outlast. A 429 holds
// THAT challenger for CREATION_429_HOLD_MS — a full minute, the wait Lichess's
// API docs ask for ("waiting one minute before retrying will be sufficient")
// and lila's user window — and nobody else, because a round must not stop on
// one player's retries. A 429 that was really the 10-minute IP limit is held a
// minute and then met again: one request a minute per challenger, bounded.
//
// ONE REQUEST AT A TIME, with no spacing: Lichess's API docs, "Only make one
// request at a time". Etiquette, not a measured bound. Time WAITING in this
// queue still counts against the caller's claim — a create at the back of a
// 32-deep round queues behind 31 jobs — so checking the claim's age before
// the call is the CALLER's job.
//
// M4: moves are NOT rate-limited. Nothing but creation belongs here.
//
// SCOPE: these budgets are PER PROCESS. Production runs more than one web
// machine, so the per-IP budget is per machine unless they share it — and if
// several machines share one egress IP, together they can spend N × 500. A
// create from another machine, or by the player on lichess.org, is invisible
// here; that is what the 429 hold is for. Two creates for ONE fixture still
// cannot both be recorded: room.ts's claim-then-call gives one claimant per
// fixture, and fixture_external_play_challenge_idx is unique on challenge_id.
// If shared accounting is ever needed, the next step is a DB-backed counter in
// the shape of V428's ingest_polled_at claim. Not built; nothing has measured
// the need.

export type CreationWindow = { readonly max: number; readonly windowMs: number };

/** lila `challenge.create.user`: ("fast", 5 * 5, 1.minute), ("slow", 40 * 5,
 *  1.day), at a cost of 5 per create. */
export const CREATION_PER_CHALLENGER: readonly CreationWindow[] = Object.freeze([
  Object.freeze({ max: 5, windowMs: 60_000 }),
  Object.freeze({ max: 40, windowMs: 24 * 60 * 60_000 }),
]);

/** lila `challenge.create.ip`: 500 per 10 minutes, at a cost of 1. */
export const CREATION_PER_IP: readonly CreationWindow[] = Object.freeze([
  Object.freeze({ max: 500, windowMs: 10 * 60_000 }),
]);

/** How long a Lichess 429 holds that challenger. At least a minute: the wait
 *  Lichess's docs ask for, and lila's per-user window. */
export const CREATION_429_HOLD_MS = 60_000;

export type CreationLimitReason =
  | "challenger"   // this module refused: the challenger's lila budget is spent
  | "ip"           // this module refused: this process's per-IP budget is spent
  | "lichess_429"; // Lichess said 429, now or within the hold

/** Thrown by the JOB on a 429 — the queue is generic over T and cannot read a
 *  result value, so the call site, holding the typed BoardCall, does
 *  `if (made.code === "rate_limited") throw new CreationRateLimited()`.
 *  Thrown BY the queue, with `retryAt`, when a limit refuses or a 429 lands.
 *  Either way nothing was created: a 429 is lila refusing before it acts. */
export class CreationRateLimited extends Error {
  readonly reason: CreationLimitReason;
  /** Epoch ms (the queue's clock) before which this challenger's next create
   *  will be refused here. null only on the job's own throw. */
  readonly retryAt: number | null;
  constructor(opts: { reason?: CreationLimitReason; retryAt?: number | null; message?: string } = {}) {
    super(opts.message ?? "Lichess rate limited the create");
    this.name = "CreationRateLimited";
    this.reason = opts.reason ?? "lichess_429";
    this.retryAt = opts.retryAt ?? null;
  }
}

/** `key` dedupes (the fixture); `challenger` is the Lichess account whose
 *  token creates — White's username or id. */
export type CreationRequest = { key: string; challenger: string };

export type CreationQueueDeps = { now: () => number };

const realDeps: CreationQueueDeps = { now: () => Date.now() };
let deps: CreationQueueDeps = realDeps;

/** Serial tail. Every enqueue chains onto it, which is what makes the queue
 *  one-at-a-time without a lock. */
let tail: Promise<unknown> = Promise.resolve();
/** In-flight runs by key, so two tabs submitting the same fixture share one
 *  create instead of racing for the claim. */
const inFlight = new Map<string, Promise<unknown>>();
/** Stamps of every create this process sent, for the per-IP limit. */
let ipStamps: number[] = [];
/** Per lowercased challenger: stamps, and the end of any 429 hold. */
const challengers = new Map<string, { stamps: number[]; heldUntil: number }>();

const longest = (windows: readonly CreationWindow[]) =>
  Math.max(...windows.map((w) => w.windowMs));
const CHALLENGER_RETAIN_MS = longest(CREATION_PER_CHALLENGER);
const IP_RETAIN_MS = longest(CREATION_PER_IP);

/** TESTS ONLY — inject a virtual clock. Nothing here sleeps, so the clock is
 *  all a test needs to drive. */
export function __setCreationQueueDeps(d: Partial<CreationQueueDeps>): void {
  deps = { ...deps, ...d };
}

/** TESTS ONLY — how much this process is remembering, so pruning is
 *  observable. */
export function __creationQueueTracked(): { challengers: number; ipStamps: number } {
  return { challengers: challengers.size, ipStamps: ipStamps.length };
}

/** TESTS ONLY — drop the tail, the in-flight map and every budget. */
export function __resetCreationQueue(): void {
  deps = realDeps;
  tail = Promise.resolve();
  inFlight.clear();
  ipStamps = [];
  challengers.clear();
}

/** The first instant every window has room for one more create, or null if
 *  every window has room now. Inclusive edge: a stamp exactly `windowMs` ago
 *  still counts, as lila's `now <= clearAt` does. Stamps are appended in
 *  completion order, so they ascend while the clock does; a wall clock that
 *  steps BACK can make `retryAt` early by the step, and a 429 then holds. */
function retryAtFor(stamps: readonly number[], windows: readonly CreationWindow[], now: number): number | null {
  let retryAt: number | null = null;
  for (const w of windows) {
    const inWindow = stamps.filter((s) => s >= now - w.windowMs);
    if (inWindow.length < w.max) continue;
    // Room returns once all but max-1 of these have left the window.
    const leaving = inWindow[inWindow.length - w.max]!;
    const at = leaving + w.windowMs + 1;
    retryAt = retryAt === null ? at : Math.max(retryAt, at);
  }
  return retryAt;
}

/** Forget what no window can see any more, so a long-lived process does not
 *  keep every challenger it ever served. A held challenger is never dropped
 *  mid-hold: the 429 that held it left a stamp, and stamps outlive a hold (a
 *  day against a minute). */
function prune(now: number): void {
  ipStamps = ipStamps.filter((s) => s >= now - IP_RETAIN_MS);
  for (const [id, c] of challengers) {
    c.stamps = c.stamps.filter((s) => s >= now - CHALLENGER_RETAIN_MS);
    if (c.stamps.length === 0) challengers.delete(id);
  }
}

async function runLimited<T>(challenger: string, job: () => Promise<T>): Promise<T> {
  const now = deps.now();
  prune(now);
  let c = challengers.get(challenger);
  if (!c) {
    c = { stamps: [], heldUntil: Number.NEGATIVE_INFINITY };
    challengers.set(challenger, c);
  }
  const refusals: Array<{ reason: CreationLimitReason; retryAt: number }> = [];
  if (now < c.heldUntil) refusals.push({ reason: "lichess_429", retryAt: c.heldUntil });
  const challengerAt = retryAtFor(c.stamps, CREATION_PER_CHALLENGER, now);
  if (challengerAt !== null) refusals.push({ reason: "challenger", retryAt: challengerAt });
  const ipAt = retryAtFor(ipStamps, CREATION_PER_IP, now);
  if (ipAt !== null) refusals.push({ reason: "ip", retryAt: ipAt });
  if (refusals.length > 0) {
    // Nothing is sent. The binding refusal is the one that ends last.
    const binding = refusals.reduce((a, b) => (b.retryAt > a.retryAt ? b : a));
    throw new CreationRateLimited({
      ...binding,
      message: `create refused here (${binding.reason}) until ${binding.retryAt}`,
    });
  }

  const state = c;
  try {
    return await job();
  } catch (err) {
    if (err instanceof CreationRateLimited) {
      // A held challenger sends nothing until the hold ends, so a later 429
      // always lands after this one: a plain assignment only ever extends it.
      state.heldUntil = deps.now() + CREATION_429_HOLD_MS;
      throw new CreationRateLimited({
        reason: "lichess_429", retryAt: state.heldUntil, message: err.message,
      });
    }
    throw err;
  } finally {
    // Stamped at the response, never before: lila charged no later than this.
    const done = deps.now();
    state.stamps.push(done);
    ipStamps.push(done);
  }
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

/** Run one create, one at a time, inside lila's limits. Rejects with
 *  CreationRateLimited — at once, never after a wait — when a limit refuses or
 *  Lichess 429s; any other failure is the job's own, passed through, never
 *  retried (a bad username must not burn the budget the round needs). */
export function enqueueCreation<T>(req: CreationRequest, job: () => Promise<T>): Promise<T> {
  const challenger = req.challenger.trim().toLowerCase();
  if (challenger === "") {
    // One empty id would pool every such create into a single bucket and
    // refuse the round from its sixth board on.
    return Promise.reject(new Error("enqueueCreation needs the challenger's Lichess id"));
  }
  const existing = inFlight.get(req.key);
  if (existing) return existing as Promise<T>;

  const promise = chain(() => runLimited(challenger, job)).finally(() => {
    inFlight.delete(req.key);
  });
  inFlight.set(req.key, promise);
  return promise;
}
