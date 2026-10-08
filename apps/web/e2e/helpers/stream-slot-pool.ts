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
// has ONE limit, POOL_HOLD_LIMIT_MS, every member waits POOL_SLOT_WAIT_MS (twice the limit, the margin capture-phone
// chose: a waiter may sit behind one whole hold and the start of the next), and every member DECLARES its own longest
// hold from its own clocks — `takeStreamSlot` refuses a hold past the limit, naming the file, before it waits for
// anything. A spec that grows a longer hold therefore reds at its first slot instead of starving a sibling's wait.
//
// A hold, as the specs have always counted it, is the STREAMING part of a test's budget — go-live → stop cycles, the
// polls and the server-timed waits between them — not the seed or the page loads (each test's own timeout carries
// those). Waits and holds are derived from the constants that set their pace (AGENTS.md #20), never a flat literal.
import { FAKE_CONNECT_AFTER_MS_DEFAULT, FakeIngest } from "../../src/server/relay/fakes";
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

/** A whole go-live → stop cycle in the browser: the fake's connect, two polls and slack to see it live (LIVE_WAIT), then
 *  three polls-plus-slack (the Stop and the end landing). The stream walkthroughs' shared CYCLE_MS. */
export function cycleMs(fakeConnectMs: number): number {
  const liveWaitMs = fakeConnectMs + 2 * STREAM_POLL_MS + 5_000;
  const pollWaitMs = STREAM_POLL_MS + 5_000;
  return liveWaitMs + 3 * pollWaitMs;
}

/** How many cycles a member may hold a pool key. Six: the longest declared hold is stream-relay's B5 frame — four
 *  sessions, the output warning and six polls, which is under six cycles at any connect delay (a cycle is at least
 *  45 s, and the warning plus six polls is 90 s) — then capture-phone's W23 at five. */
export const POOL_HOLD_CYCLES = 6;

/** The pool's budget at a given connect delay: the cycle, the hold limit, and the wait every member owes a key. */
export function poolBudget(fakeConnectMs: number): { cycleMs: number; holdLimitMs: number; slotWaitMs: number } {
  const cycle = cycleMs(fakeConnectMs);
  const holdLimitMs = POOL_HOLD_CYCLES * cycle;
  return { cycleMs: cycle, holdLimitMs, slotWaitMs: 2 * holdLimitMs };
}

/** The connect delay the SERVER runs (CI sets FAKE_INGEST_CONNECT_AFTER_MS on the server and this process alike). A junk
 *  value falls back here: `new FakeIngest()` above has already refused it at import, naming the variable. */
const POOL_FAKE_CONNECT_MS = ((): number => {
  const raw = process.env.FAKE_INGEST_CONNECT_AFTER_MS;
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : FAKE_CONNECT_AFTER_MS_DEFAULT;
})();
const BUDGET = poolBudget(POOL_FAKE_CONNECT_MS);
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
