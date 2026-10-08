// The STREAM-SLOT POOL — the one derivation of the deployment's stream capacity and of the Postgres advisory-lock keys
// every stream walkthrough takes before it opens a session (Capture QR v2 PR-2 B8: it was restated in six specs).
//
// WHY A POOL. Admission refuses a start once the ingest's storage headroom, after every ACTIVE session's max-duration
// reservation, is below one more reservation (server/relay/domain/session.ts `admit`: headroom < maxDurationMinutes →
// storage_exhausted). Reservations are counted across the WHOLE server, so parallel workers going live at once are
// refused as a storage fault ("Recording storage is full"), not a product one. The capacity is DERIVED from the fake
// ingest's own storage limit and the config's max duration, and handed out as session-level advisory locks held for the
// test: keys [BASE, BASE + CAPACITY). The first CAPACITY − 1 are the POOL, shared by stream-relay, directory,
// capture-phone, capture-auto and capture-panel-pr2; the last is stream-credits.spec.ts's own (controller allocation
// 2026-09-29), and `takeStreamSlot` cannot reach it. Every test stops its streams in teardown BEFORE it lets its key go,
// so a red case never keeps a reservation.
//
// THE HOLD LIMIT, AND THE ONE WAIT. A member waits for a key while another member holds it, so a wait shorter than some
// member's hold is a red that has nothing to do with the code. Before this file, each spec sized its own wait from the
// holds it happened to know about: stream-relay and directory waited 3 cycles (165 s in CI) while capture-phone's W23
// holds 5 (275 s), stream-relay's own B5 frame about 310 s and capture-panel-pr2's health walk about 170 s. Now the pool
// has ONE limit, POOL_HOLD_LIMIT_MS, every member waits POOL_SLOT_WAIT_MS — the true worst case, ONE whole hold at the
// limit plus one cycle of slack (final review m-4: twice the limit, with CI's one retry, outlasted e2e-parallel's job
// timeout, so a leaked lease killed the job with no report; e2e-ci-wiring pins wait × (retries + 1) under that timeout)
// — and every member DECLARES its own longest hold from its own clocks: `takeStreamSlot` refuses a hold past the limit,
// naming the file, before it waits for anything. A spec that grows a longer hold therefore reds at its first slot
// instead of starving a sibling's wait.
//
// THE CLOCKS AND THE ENV (final review m-3). The fake ingest's connect delay and the server tunables are read from this
// process's env by ONE parse, `readWholeEnv`, which applies the SERVER's own rule for each name. Over it, a spec either
// DEMANDS a value (`envGuard`, the guard e2e-ci-wiring reads to know what CI must set) or takes it with the default
// (`tunedEnv`; `FAKE_CONNECT_MS` is that, read once — a junk delay is already refused at import by `new FakeIngest()`
// below, naming the variable). The waits every stream walkthrough derives from the delay (`POLL_WAIT_MS`, `liveWaitMs`,
// `cycleMs`) live here too, so no spec restates them; e2e-ci-wiring refuses a hand read or a restated wait elsewhere.
//
// A hold, as the specs have always counted it, is the STREAMING part of a test's budget — go-live → stop cycles, the
// polls and the server-timed waits between them — not the seed or the page loads (each test's own timeout carries
// those). Waits and holds are derived from the constants that set their pace (AGENTS.md #20), never a flat literal.
import { FAKE_CONNECT_AFTER_MS_DEFAULT, FakeIngest, connectAfterMsFromEnv } from "../../src/server/relay/fakes";
import { MAX_DURATION_MINUTES } from "../../src/server/relay/config";
import { STREAM_POLL_MS } from "../../src/lib/stream-session-view";

/** The first advisory-lock key of the deployment's stream capacity. */
export const SLOT_LOCK_BASE = 7_301_130_000;
/** How many sessions the fake ingest's storage admits at once: its limit over one max-duration reservation. */
export const STREAM_CAPACITY = Math.floor(new FakeIngest().storage.totalStorageMinutesLimit / MAX_DURATION_MINUTES);
/** The pool: every capacity key but the last. */
export const POOL_SLOTS = STREAM_CAPACITY - 1;
/** stream-credits.spec.ts's key — the one the pool leaves. capture-phone's W22 takes it only for the instant of its tick. */
export const CREDITS_SLOT_KEY = SLOT_LOCK_BASE + POOL_SLOTS;

// ---------------------------------------------------------------------------------------------------------------------
// The env: ONE parse, three policies (final review m-3)
// ---------------------------------------------------------------------------------------------------------------------

/** The fake ingest's connect delay: not a `tunable()`, parsed by fakes.ts's own constructor read. */
const FAKE_CONNECT_ENV = "FAKE_INGEST_CONNECT_AFTER_MS";
/** What this process's env says of one whole-number server setting, parsed EXACTLY as the server parses that name — the
 *  fake ingest's delay by fakes.ts's own `connectAfterMsFromEnv` (untrimmed; 0 legal, "connect immediately"), every other
 *  name by `tunable()`'s rule (config.ts: trimmed; empty is unset; a positive whole number). Never throws: the caller's
 *  policy decides what a junk value means. */
export type WholeEnvRead = { state: "unset" } | { state: "junk"; raw: string; problem: string } | { state: "ok"; raw: string; value: number };
export function readWholeEnv(name: string): WholeEnvRead {
  if (name === FAKE_CONNECT_ENV) {
    const raw = process.env[name];
    if (raw === undefined) return { state: "unset" };
    try {
      return { state: "ok", raw, value: connectAfterMsFromEnv() };
    } catch (err) {
      return { state: "junk", raw, problem: (err as Error).message };
    }
  }
  const raw = process.env[name]?.trim();
  if (!raw) return { state: "unset" };
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) return { state: "junk", raw, problem: `${name}=${JSON.stringify(raw)} is not a positive whole number` };
  return { state: "ok", raw, value: Number(raw) };
}

/** The DEMANDING policy (capture-phone, capture-auto): a spec's `wholeEnv`, recording every gap in that spec's own
 *  ENV_PROBLEMS for its beforeEach to name at once (a module-level throw would abort the whole leg). Null when the value
 *  is missing or junk. `below`: the default it must be shortened from; `atLeast`: the floor the file's own arithmetic
 *  needs. e2e-ci-wiring reads the guard by its call shape, `wholeEnv("NAME", { … })`, so a spec keeps that name. */
export function envGuard(problems: string[]): (name: string, opts?: { below?: number; atLeast?: number }) => number | null {
  return (name, opts = {}) => {
    const read = readWholeEnv(name);
    if (read.state === "unset") {
      problems.push(`${name} is not set`);
      return null;
    }
    if (read.state === "junk") {
      problems.push(read.problem);
      return null;
    }
    if (opts.below !== undefined && read.value >= opts.below) {
      problems.push(`${name}=${read.raw} is not shortened (the default is ${opts.below}); the walkthrough budgets assume a tuned server`);
    }
    if (opts.atLeast !== undefined && read.value < opts.atLeast) {
      problems.push(`${name}=${read.raw} is below ${opts.atLeast}, the least this file's "not yet" beats can sit inside`);
    }
    return read.value;
  };
}
/** The LENIENT policy: the value, else the fallback — for a spec whose sibling guard already demands the name. */
export function tunedEnv(name: string, fallback: number): number {
  const read = readWholeEnv(name);
  return read.state === "ok" ? read.value : fallback;
}

// ---------------------------------------------------------------------------------------------------------------------
// The clocks every stream walkthrough derives its waits from (AGENTS.md #20)
// ---------------------------------------------------------------------------------------------------------------------

/** One organiser poll plus slack — a state the next read must already show. */
export const POLL_WAIT_MS = STREAM_POLL_MS + 5_000;
/** From go-live until the panel shows live: the fake's connect, then two polls (the one in flight and the one that sees
 *  it), plus slack. */
export function liveWaitMs(fakeConnectMs: number): number {
  return fakeConnectMs + 2 * STREAM_POLL_MS + 5_000;
}
/** A whole go-live → stop cycle in the browser: live (`liveWaitMs`), then three polls-plus-slack (the Stop and the end
 *  landing). The stream walkthroughs' shared CYCLE_MS. */
export function cycleMs(fakeConnectMs: number): number {
  return liveWaitMs(fakeConnectMs) + 3 * POLL_WAIT_MS;
}

/** How many cycles a member may hold a pool key. Six: the longest declared hold is stream-relay's B5 frame — four
 *  sessions, the output warning and six polls, which is under six cycles at any connect delay (a cycle is at least
 *  45 s, and the warning plus six polls is 90 s) — then capture-phone's W23 at five. */
export const POOL_HOLD_CYCLES = 6;

/** The slack a waiter is owed past one whole hold at the limit, in cycles: the holder's own teardown (its Stop and the end
 *  landing) and the waiter's next try. */
export const POOL_WAIT_SLACK_CYCLES = 1;
/** The pool's budget at a given connect delay: the cycle, the hold limit, and the wait every member owes a key — the
 *  true worst case for one waiter, ONE whole hold at the limit plus the slack (final review m-4: never twice the limit). */
export function poolBudget(fakeConnectMs: number): { cycleMs: number; holdLimitMs: number; slotWaitMs: number } {
  const cycle = cycleMs(fakeConnectMs);
  const holdLimitMs = POOL_HOLD_CYCLES * cycle;
  return { cycleMs: cycle, holdLimitMs, slotWaitMs: holdLimitMs + POOL_WAIT_SLACK_CYCLES * cycle };
}

/** The connect delay the SERVER runs (CI sets FAKE_INGEST_CONNECT_AFTER_MS on the server and this process alike): the
 *  default when unset; a junk value never reaches here — `new FakeIngest()` above refused it at import. */
export const FAKE_CONNECT_MS = tunedEnv(FAKE_CONNECT_ENV, FAKE_CONNECT_AFTER_MS_DEFAULT);
const BUDGET = poolBudget(FAKE_CONNECT_MS);
/** The most any member may hold a pool key (POOL_HOLD_CYCLES cycles). */
export const POOL_HOLD_LIMIT_MS = BUDGET.holdLimitMs;
/** How long every member waits for a pool key — and capture-phone's W22 for the whole pool. */
export const POOL_SLOT_WAIT_MS = BUDGET.slotWaitMs;

/** A member's declaration: its file, and the longest any of its tests holds a key, from that file's own clocks. */
export interface PoolHolder {
  readonly file: string;
  readonly holdMs: number;
}

/** The guard: why a member's declared hold cannot share this pool, or null when it can. */
export function poolHoldProblem(holder: PoolHolder): string | null {
  if (!Number.isFinite(holder.holdMs) || holder.holdMs <= 0) {
    return `${holder.file} declares no stream-slot hold (${holder.holdMs} ms) — a member states the longest it holds a key`;
  }
  if (holder.holdMs > POOL_HOLD_LIMIT_MS) {
    return `${holder.file} holds a stream slot up to ${holder.holdMs} ms, past the pool's ${POOL_HOLD_LIMIT_MS} ms limit (${POOL_HOLD_CYCLES} cycles) that every member's ${POOL_SLOT_WAIT_MS} ms wait is sized from`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The lease. ONE per worker: a worker runs one test at a time, and every member's teardown calls releaseStreamSlot() in
// a `finally`, once its streams are terminal. A session-level advisory lock is released with its connection.
// ---------------------------------------------------------------------------------------------------------------------

let lease: (() => Promise<void>) | null = null;

async function leaseConnection(): Promise<import("postgres").Sql> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for the stream-slot lease");
  const { default: postgres } = await import("postgres");
  return postgres(dbUrl, {
    ssl: process.env.DATABASE_SSL === "disable" ? false : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl) ? false : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
    idle_timeout: 0,
  });
}

async function tryKey(sql: import("postgres").Sql, key: number): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`select pg_try_advisory_lock(${key}::bigint) as ok`;
  return row?.ok === true;
}

/** Whether this worker holds a key (a pool key, the whole pool, or the credits key). */
export function holdsStreamSlot(): boolean {
  return lease !== null;
}

/** Take ONE pool key before the test's first go-live; held until releaseStreamSlot(). A second call in the same test
 *  reuses the lease it already holds (W22's whole pool included: its go-live's own call takes nothing more). The
 *  holder's declared hold is judged FIRST, before any wait or connection. */
export async function takeStreamSlot(holder: PoolHolder): Promise<void> {
  const problem = poolHoldProblem(holder);
  if (problem) throw new Error(problem);
  if (lease) return;
  if (POOL_SLOTS < 1) throw new Error(`the fake's capacity (${STREAM_CAPACITY}) leaves the pool no slot`);
  const sql = await leaseConnection();
  const deadline = Date.now() + POOL_SLOT_WAIT_MS;
  for (;;) {
    for (let i = 0; i < POOL_SLOTS; i++) {
      if (await tryKey(sql, SLOT_LOCK_BASE + i)) {
        lease = () => sql.end();
        return;
      }
    }
    if (Date.now() > deadline) {
      await sql.end();
      throw new Error(`${holder.file}: none of the pool's ${POOL_SLOTS} stream slot(s) free after ${POOL_SLOT_WAIT_MS} ms`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** How often W22 asks for the whole pool. Each ask takes nothing it cannot keep, so it can ask often; a sibling polls a
 *  free key every 500 ms, and the whole pool is only ever free between two of their asks. */
const WHOLE_POOL_POLL_MS = 100;

/**
 * capture-phone.spec.ts W22's exclusion (B9 review m-3; re-review n-2). The cron tick is GLOBAL — it ticks every open
 * session on the server — and every session any member opens is opened under one of the capacity keys. Holding EVERY
 * key therefore means no other test has a session open: the tick can reach W22's own and nothing else.
 *
 * Taken so that WAITING for it holds nothing: the pool, before W22's go-live, all or nothing — each round asks for every
 * pool key in key order and, short of the whole set, gives back what it got, so a sibling waiting on the pool never waits
 * on W22's wait, only on its run. The credits key only at the tick (`credits()`), and released right after it, so
 * stream-credits waits for it at most the few seconds of a tick. capture-phone.spec.ts states the bound in full.
 */
export async function takeWholePool(
  holder: PoolHolder,
  opts: { creditsKeyWaitMs: number },
): Promise<{ pool: number; waitedMs: number; credits: () => Promise<{ release: () => Promise<void> }> }> {
  const problem = poolHoldProblem(holder);
  if (problem) throw new Error(problem);
  if (lease) throw new Error("wholePool: this test already holds a key — take the pool BEFORE any streamSlot()");
  const sql = await leaseConnection();
  const pool = Array.from({ length: POOL_SLOTS }, (_, i) => SLOT_LOCK_BASE + i);
  const from = Date.now();
  for (;;) {
    const got: number[] = [];
    for (const k of pool) {
      if (!(await tryKey(sql, k))) break;
      got.push(k);
    }
    if (got.length === pool.length) break;
    for (const k of got) await sql`select pg_advisory_unlock(${k}::bigint)`;
    if (Date.now() - from > POOL_SLOT_WAIT_MS) {
      await sql.end();
      throw new Error(`W22's exclusion: the ${pool.length} pool key(s) were never free together in ${POOL_SLOT_WAIT_MS} ms`);
    }
    await new Promise((r) => setTimeout(r, WHOLE_POOL_POLL_MS));
  }
  // The lease: every key on this connection goes with it, at teardown, once the session is terminal.
  lease = () => sql.end();
  const waitedMs = Date.now() - from;
  const credits = async (): Promise<{ release: () => Promise<void> }> => {
    const deadline = Date.now() + opts.creditsKeyWaitMs;
    for (;;) {
      if (await tryKey(sql, CREDITS_SLOT_KEY)) {
        return {
          release: async () => {
            await sql`select pg_advisory_unlock(${CREDITS_SLOT_KEY}::bigint)`;
          },
        };
      }
      if (Date.now() > deadline) throw new Error(`W22's exclusion: stream-credits' key still held after ${opts.creditsKeyWaitMs} ms`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  return { pool: pool.length, waitedMs, credits };
}

/** stream-credits.spec.ts's ONE key (CREDITS_SLOT_KEY), held until releaseStreamSlot(). That file holds at most one. */
export async function takeCreditsSlot(waitMs: number): Promise<void> {
  if (!(STREAM_CAPACITY >= 1)) throw new Error(`the fake ingest holds ${STREAM_CAPACITY} stream(s) — none for stream-credits`);
  if (lease) throw new Error("stream-credits holds at most ONE stream slot, and it is already held");
  const sql = await leaseConnection();
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await tryKey(sql, CREDITS_SLOT_KEY)) {
      lease = () => sql.end();
      return;
    }
    if (Date.now() > deadline) {
      await sql.end();
      throw new Error(`stream slot ${CREDITS_SLOT_KEY} not free after ${waitMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** A SECOND holder asks for `key` on its own connection: true when it got it (and it is given back as that connection
 *  closes), false when someone holds it. The witness that a held slot refuses a second holder. */
export async function slotKeyFreeElsewhere(key: number): Promise<boolean> {
  const sql = await leaseConnection();
  try {
    return await tryKey(sql, key);
  } finally {
    await sql.end();
  }
}

/** Teardown's last act: let the worker's key (or keys) go. Safe with none held. */
export async function releaseStreamSlot(): Promise<void> {
  const release = lease;
  lease = null;
  await release?.();
}
