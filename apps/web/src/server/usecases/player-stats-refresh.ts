import "server-only";
// Player stats refresh after a result (owner ruling 2026-09-16, option B).
//
// `player_stat_snapshots` feeds the hub's Stats tab and leader boards, the
// public player card and /me. Its only writer is `recomputePlayerStats`, which
// refolds the WHOLE division ledger: about 22 ms per 1,000 events, measured at
// 0.5–1.3 s for a 90-match T20 season (22,680 events). Measured before this
// change, a deciding tap on that division already took about 340 ms. Adding the
// fold to the scorer's request would have made it slower still, so a result
// only SCHEDULES the fold here, and it runs after the response
// (`deferred` -> Next `after()`).
//
// Which writes schedule one: a scoring write that leaves a fixture decided, and
// every undo (`scoring.ts` `refreshesPlayerStats`); an import that appended
// events; a history undo or a stage delete that removed a fixture carrying
// events (`history.ts`, `stages.ts`); a staff config re-snapshot
// (`admin-fixture-config.ts`); a stats read that finds the snapshot behind a
// result (see NOT DURABLE below). A person merge and unmerge refold inline in
// their own transaction, then schedule one per refolded division to clear the
// public copies of the old rows (`person-merge.ts`). Roster, lineup and division
// config edits schedule nothing; the next refresh folds them in, because the
// coverage check below hashes them, and a stats read queues one for them.
//
// Four properties, each with a test in `player-stats-refresh.test.ts`:
//
// 1. BOUNDED. One refresh transaction at a time per process, whatever the
//    number of divisions (review I3). Each fold pins a connection from the
//    pool (sized by `DB_POOL_MAX`, `lib/db.ts`: 5 by default, 20 in production
//    per `fly.toml` [env]) and runs synchronous JS for its whole length, so ten
//    finishes in ten divisions would otherwise hold ten of those connections at
//    once and stall the event loop for the scoring requests themselves. Refreshes wait in an in-memory
//    queue, and a second request for a division already waiting joins it.
//
// 2. COALESCED ACROSS PROCESSES. A refresh takes the division's stats lock with
//    `pg_try_advisory_xact_lock` and never waits inside a transaction. A busy
//    lock sends it back to the queue after a backoff, and the other divisions
//    go ahead meanwhile. Once it holds the lock it asks `playerStatsCoverage`
//    whether the snapshot already covers the database: the last fold recorded
//    each fixture's (event count, max seq) from its own events read and an md5
//    of its other inputs (V409), and both still match. Then there is nothing to
//    do. An undo also skips when the last fold never saw the event it voids.
//
// 3. NO LOST UPDATE, in both directions. The write's own rows committed before
//    it was scheduled. A fold that read before they landed recorded a ledger
//    without them, so this refresh folds again once it gets the lock; a fold
//    that read after recorded them, so it skips. The check reads the record
//    rather than trusting "someone was folding", so a fold run by a console
//    stats read or a person merge counts too. The ledger map is an identity, not
//    a count: a deleted scored fixture drops out of it, so deleting one and
//    recording as many events elsewhere no longer reads as covered.
//    A backoff that runs out makes ONE blocking attempt under `lock_timeout`.
//    If that times out too, the caches are cleared anyway (the holder may have
//    folded this very result) and a warning is logged.
//
// 4. VISIBLE. After the fold commits, the public caches are cleared again: the
//    ISR tags through `fireStatsRevalidate` (profiles chosen so Next does not
//    drop them inside `after()`), then the hub's Redis document, then the
//    division glob. The division then gets a second `state_changed` push, sent
//    once the hub DEL settles and NOT awaited, so a slow realtime endpoint
//    never holds the after-window (its fetch also times out,
//    `lib/realtime.ts`). Next flushes after-window tags only once EVERY
//    callback of the request has finished, so the tags land after the fold and
//    the DEL, alongside any other after-work of the same request, such as the
//    score's discovery tags, which wait for this refresh too.
//    Nothing is cleared twice for one fold: collapsed requests share one
//    clearing, and a refresh that finds the snapshot current skips it when this
//    process already cleared the caches for that fold. A division whose board
//    had no rows before and has none after clears nothing.
//
//    What an open hub sees depends on whether it is still listening. The hub
//    subscribes to divisions with a LIVE match, and keeps a division whose last
//    live match has just ended subscribed for `HUB_LIVE_LINGER_MS` more (32 s;
//    `use-live-competition.ts`, spectator W2 T17). While another match in the
//    division is live, the second push lands and the new leaders show about a
//    second after the fold (measured on a 90-match T20 division). When the
//    finish was the division's LAST live match, the linger starts once the hub
//    applies a document showing the match ended: the deciding push's refetch,
//    250 ms after that push. The second push leaves after the fold commits and
//    the hub DEL settles (bounded by `PUSH_AFTER_DELETE_BOUND_MS`, 1.5 s). The
//    fold committed 2.1 s and 3.5 s after the deciding tap (below), so that
//    push reaches the channel at most about 5 s into the 32 s linger and the
//    new leaders show as in the live case. The client half is driven, not
//    measured: through the hook's own test harness (fake timers, a mocked
//    channel), a push 5 s or 31 s after the deciding push is heard and
//    refetches the new document, and one at 33 s reaches no channel. No
//    browser run covers the whole sequence. A refresh that waits behind a long
//    queue (about 1 s per queued fold, e.g. read-queued refreshes after a
//    restart) can miss the linger; the new leaders then show at the next idle
//    poll, up to `HUB_IDLE_POLL_MS`, 60 s, the wait the owner accepted for
//    this case before the linger existed (2026-09-16). A reload shows them
//    once the fold has committed AND the after-window's tags have flushed; a
//    reload before that still reads the old rows. On a 90-match T20 division
//    under heavy machine load the fold committed 2.1 s and 3.5 s after the
//    deciding tap.
//
// A failure is logged (`log.warn`, with the division id) and goes no further:
// the result committed long before this ran.
//
// NOT DURABLE, SO READS RECONCILE (review m8, owner ruling 2026-09-17). The
// queue lives in process memory. A refresh still queued or backing off when the
// machine stops (a deploy, or Fly's `auto_stop_machines = "suspend"`, with its
// default 5 s kill timeout) is lost. The next read of that division's stats
// heals it: the public stats route and the hub's JSON route (which open hub
// pages poll) serve what they have and, at most once a minute per division and
// within a share of the DB pool, queue a refresh when the snapshot is behind a
// result (`reconcilePlayerStatsOnRead`; never from the ISR page or its cached
// loader, where `after()` does not run); the console leaderboard, the player card, the
// auto-post drafts and the digest fold when behind and queue one too, so the
// public copies of the old rows are cleared (`playerStatsWithoutWaiting`).
// A division nobody reads stays behind until its next scheduling write.
// The first public visit after this ships, to a division whose snapshot was
// never filled, shows no Stats tab: that visit's stats read, or the hub page's
// first poll, queues the refresh, and the tab appears once it lands. Accepted (owner ruling 2026-09-17); no warm-up job.
import { connectionOptions, sql, withTenant } from "@/lib/db";
import { cacheDel, sendAfterDeleteOrBound } from "@/lib/cache";
import { publicDivisionCacheKeys } from "@/server/public-site/division-doc-cache-keys";
import { deferred } from "@/lib/deferred";
import { publishDivisionUpdate } from "@/lib/realtime";
import { log } from "@/server/logger";
import { fireStatsRevalidate } from "@/server/public-site/revalidate";
import { lockPlayerStats, playerStatsCoverage, playerStatsOwed, recomputePlayerStats, tryLockPlayerStats } from "./player-stats";

export interface RefreshTiming {
  /** Waits between tries while another transaction holds the division's stats
   *  lock. The refresh is out of the queue while it waits. */
  backoffMs: readonly number[];
  /** The one blocking try after the backoff runs out. */
  lockTimeoutMs: number;
  /** Every statement of a refresh transaction (review n7). The queue runs one
   *  transaction at a time, and every stats read heals through it, so a query
   *  that never returned would leave every division's stats stale until the
   *  process restarts. A fold measures 0.5–1.3 s in total. */
  statementTimeoutMs: number;
}

/** About 30 s of backoff, then up to 10 s blocking. A 90-match T20 fold
 *  measures 0.5–1.3 s. */
export const REFRESH_TIMING: RefreshTiming = {
  backoffMs: [100, 200, 400, 800, 1_600, 3_200, 3_200, 3_200, 3_200, 3_200, 3_200, 3_200, 3_200, 3_200],
  lockTimeoutMs: 10_000,
  statementTimeoutMs: 30_000,
};

/** `unseen`: an undo of an event no fold had read, so nothing to change.
 *  `busy`: the lock never came free, not even in the blocking try. */
export type RefreshOutcome = "folded" | "covered" | "unseen" | "busy" | "failed";

type Target = { divisionId: string } | { fixtureId: string; voidSeq?: number };

/** One undo, as the fixture ledger position of the event it took back. */
interface Voided {
  fixtureId: string;
  seq: number;
}

/** Queue a refresh of the target's division to run after the response. Never
 *  throws, never waits. `voidSeq`: the target write was the `core.void` at
 *  that seq. */
export function schedulePlayerStatsRefresh(orgId: string, target: Target): void {
  deferred(async () => {
    try {
      if ("divisionId" in target) {
        await refreshDivisionPlayerStats(orgId, target.divisionId);
        return;
      }
      const resolved = await resolveFixtureTarget(orgId, target.fixtureId, target.voidSeq);
      if (resolved === null) return;
      await refreshDivisionPlayerStats(orgId, resolved.divisionId, { voided: resolved.voided });
    } catch (err) {
      log.warn({ err, target }, "player-stats: refresh could not start (the result stands)");
    }
  });
}

/** When each division's read-side check was last registered (ms). Doubles as
 *  the in-flight marker: a check whose `after()` never runs (a response that
 *  never closed) frees its division when the interval passes. */
const lastChecked = new Map<string, number>();
/** Divisions whose read-queued refresh failed or gave up: until when (ms), and
 *  how many times in a row. */
const quietUntil = new Map<string, { until: number; streak: number }>();
/** Read-side check policy (final review I2, m5, m6). */
export const RECONCILE_POLICY = {
  /** At most one check per division in this window. */
  minIntervalMs: 60_000,
  /** Share of the configured DB pool the checks may hold at once, in percent
   *  (`reconcileCheckCap`). */
  poolSharePercent: 20,
  /** Quiet after a refresh that failed or gave up on the lock, or a check that
   *  threw. `busy` quiets for the base step every time; a failure or a throw
   *  doubles it per repeat up to `quietMaxMs`, which stays within the few
   *  minutes of lag the owner accepted (final review round 2, I1). */
  quietBaseMs: 120_000,
  quietMaxMs: 10 * 60_000,
} as const;
let checksRunning = 0;

/** Checks running at once across the process (final review I2). Each check
 *  holds one pooled connection that scoring writes also need, so the checks get
 *  `poolSharePercent` of the pool, rounded down, never below 1. The production
 *  pool is set in `fly.toml` [env] (`DB_POOL_MAX = "20"`), so the cap there is 4;
 *  the default pool of 5, as run locally, gives 1. The size is read the way
 *  `lib/db.ts` reads it for the pool itself (`connectionOptions`), so resizing
 *  the pool moves the cap with it and no number here has to follow. */
export function reconcileCheckCap(env: Record<string, string | undefined> = process.env): number {
  const { max } = connectionOptions(env.DATABASE_URL ?? "", env);
  return Math.max(1, Math.floor((max * RECONCILE_POLICY.poolSharePercent) / 100));
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > CLEARED_FOR_CAP) map.delete(map.keys().next().value!);
}

/** A read of a division's stats, or of a competition hub's leader boards (owner
 *  ruling 2026-09-17, m8). The read serves what it has; after the response this
 *  checks whether the snapshot is behind a result (`playerStatsOwed`), and if so
 *  queues the division's refresh through the same queue. That is what heals a
 *  refresh lost to a restart: the queue lives in process memory. A division
 *  whose snapshot was never filled shows no Stats tab until that refresh lands,
 *  which is what the first visit after this ships sees (accepted, owner ruling
 *  2026-09-17; no warm-up job).
 *
 *  CALL IT ONLY WHERE `after()` IS REAL: a route handler or the usecase it
 *  calls, never inside `unstable_cache` or an ISR page render. A page
 *  regenerating in the background renders after its response has closed, so
 *  an `after()` registered there never runs (final review I1), and one
 *  registered inside a cache scope cannot clear the ISR tags (m7).
 *
 *  Costs the read a map lookup per division. The check is 3–4 queries in one
 *  transaction after the response (the division row, the fold record, the
 *  per-fixture ledger aggregate, and the inputs md5 when the ledger is not
 *  already owed): about 50 ms on a 105-fixture T20 division of 26k events,
 *  30 ms when the ledger already owes. Bounded (final review I2):
 *  - once per division per `minIntervalMs`, a burst of reads included; the
 *    same window frees a division whose registered check never ran;
 *  - `reconcileCheckCap()` checks at once across the process (a fifth of the
 *    DB pool: 4 of a 20-connection pool, 1 of 5); one that finds no
 *    slot is dropped and forgotten, so the next read of that division checks
 *    it. One call's divisions are checked one after another;
 *  - a refresh that gave up on the lock (`busy`) quiets the division for
 *    `quietBaseMs`, every time: another transaction is folding it. A refresh
 *    that failed, or a check that threw, quiets it doubling per repeat up to
 *    `quietMaxMs`, so a fold that keeps throwing or timing out is not rerun per
 *    read (m5, m6). A check that finds nothing owed ends the back-off, and so
 *    does a read-queued refresh that lands (final review round 2, I1);
 *  - read-queued refreshes share the per-process queue with result refreshes,
 *    so after a restart with many owed divisions a new result's stats can wait
 *    about a second per queued fold (final review round 2, n3, accepted).
 *  Matches in play do not count as behind: their events reach the snapshot at
 *  the next refresh by design, and treating them as behind would refold on
 *  every read of a live division.
 *
 *  `allowed` runs once after the response, before any check: the hub passes
 *  its `stats.player` gate there, so the read pays nothing for it. */
export function reconcilePlayerStatsOnRead(
  orgId: string,
  divisionIds: string | readonly string[],
  opts: { allowed?: () => Promise<boolean> } = {},
): void {
  const now = Date.now();
  const due: Array<{ divisionId: string; key: string }> = [];
  for (const divisionId of typeof divisionIds === "string" ? [divisionIds] : divisionIds) {
    const key = divisionId.toLowerCase();
    const last = lastChecked.get(key);
    if (last !== undefined && now - last < RECONCILE_POLICY.minIntervalMs) continue;
    const quiet = quietUntil.get(key);
    if (quiet !== undefined && now < quiet.until) continue;
    remember(lastChecked, key, now);
    due.push({ divisionId, key });
  }
  if (due.length === 0) return;
  deferred(async () => {
    try {
      if (opts.allowed !== undefined && !(await opts.allowed())) return;
    } catch (err) {
      log.warn({ err, orgId }, "player-stats: the read-side stats check failed (the read was served)");
      return;
    }
    const refreshes: Array<Promise<void>> = [];
    const cap = reconcileCheckCap();
    for (const { divisionId, key } of due) {
      if (checksRunning >= cap) {
        // No slot: forget this registration, so the next read checks it.
        if (lastChecked.get(key) === now) lastChecked.delete(key);
        continue;
      }
      checksRunning += 1;
      let owed: boolean;
      try {
        owed = await withTenant(orgId, (tx) => playerStatsOwed(tx, divisionId));
      } catch (err) {
        log.warn({ err, divisionId }, "player-stats: the read-side stats check failed (the read was served)");
        backOff(key);
        continue;
      } finally {
        checksRunning -= 1;
      }
      if (!owed) {
        quietUntil.delete(key);
        continue;
      }
      log.info({ divisionId }, "player-stats: a read found the snapshot behind a result; refresh queued");
      // Not awaited under the slot: the refresh waits in its own queue.
      refreshes.push(
        refreshDivisionPlayerStats(orgId, divisionId).then((outcome) => {
          if (outcome === "failed") backOff(key);
          else if (outcome === "busy") quietOnce(key);
          else quietUntil.delete(key);
        }),
      );
    }
    await Promise.all(refreshes);
  });
}

/** A failure or a throw: quiet for the next step, doubling per repeat. */
function backOff(key: string): void {
  const streak = (quietUntil.get(key)?.streak ?? 0) + 1;
  const ms = Math.min(RECONCILE_POLICY.quietBaseMs * 2 ** (streak - 1), RECONCILE_POLICY.quietMaxMs);
  remember(quietUntil, key, { until: Date.now() + ms, streak });
}

/** `busy`: quiet for the base step, leaving the failure streak as it was. */
function quietOnce(key: string): void {
  const streak = quietUntil.get(key)?.streak ?? 0;
  remember(quietUntil, key, { until: Date.now() + RECONCILE_POLICY.quietBaseMs, streak });
}

async function resolveFixtureTarget(
  orgId: string,
  fixtureId: string,
  voidSeq: number | undefined,
): Promise<{ divisionId: string; voided: Voided | null } | null> {
  return withTenant(orgId, async (tx) => {
    const [fixture] = await tx<{ division_id: string }[]>`
      select division_id from fixtures where id = ${fixtureId}`;
    if (!fixture) return null;
    if (voidSeq === undefined) return { divisionId: fixture.division_id, voided: null };
    const [target] = await tx<{ fixture_id: string; seq: number }[]>`
      select t.fixture_id, t.seq from score_events v
      join score_events t on t.id = v.voids_event_id
      where v.fixture_id = ${fixtureId} and v.seq = ${voidSeq}`;
    return { divisionId: fixture.division_id, voided: target ? { fixtureId: target.fixture_id, seq: target.seq } : null };
  });
}

interface RefreshResult {
  outcome: RefreshOutcome;
  /** The fold record the snapshot now reflects; null when unknown. */
  token: string | null;
  /** Board rows before and after; null when unknown. */
  rowsBefore: number | null;
  rowsAfter: number | null;
  /** Set by the first caller that clears the caches for this result, so the
   *  requests collapsed into it do not clear them again. */
  cleared: boolean;
}

/** One division's refresh: queue, fold if the snapshot is behind, then clear
 *  the public caches and push the division. Resolves once all of that is done.
 *  Exported for the tests, which run it the way `after()` would. */
export async function refreshDivisionPlayerStats(
  orgId: string,
  divisionId: string,
  opts: { voided?: Voided | null; timing?: RefreshTiming } = {},
): Promise<RefreshOutcome> {
  const result = await enqueue(orgId, divisionId, opts.voided ?? null, opts.timing ?? REFRESH_TIMING);
  // The clearing runs HERE, in the caller's own async context, never in the
  // queue's: `revalidateTag` registers on the after-window of the request whose
  // context it runs in, and the queue's context belongs to whichever request
  // happened to start draining it.
  if (shouldClear(divisionId, result)) await invalidateAfterRefresh(orgId, divisionId);
  return result.outcome;
}

/** Fold records this process has already cleared the public caches for, by
 *  division. Bounded: the oldest division is dropped past the cap. */
const clearedFor = new Map<string, string>();
const CLEARED_FOR_CAP = 1_000;
/** Divisions whose last clearing Next refused (final review m7): the next
 *  refresh clears them whatever it finds, even an empty board it did not
 *  change, since the public copies may still show the rows before. */
const clearRefused = new Map<string, true>();

function shouldClear(divisionId: string, result: RefreshResult): boolean {
  if (result.outcome === "failed" || result.cleared) return false;
  const key = divisionId.toLowerCase();
  if (!clearRefused.has(key)) {
    if (result.rowsBefore === 0 && result.rowsAfter === 0) return false;
    if (result.outcome !== "busy" && result.token !== null && clearedFor.get(key) === result.token) return false;
  }
  // Claimed before the first await, so a sibling resuming right after this one
  // sees it.
  clearRefused.delete(key);
  result.cleared = true;
  if (result.token !== null) {
    clearedFor.delete(key);
    clearedFor.set(key, result.token);
    if (clearedFor.size > CLEARED_FOR_CAP) clearedFor.delete(clearedFor.keys().next().value!);
  }
  return true;
}

// ---------------------------------------------------------------------------
// The per-process queue
// ---------------------------------------------------------------------------

interface Entry {
  orgId: string;
  divisionId: string;
  key: string;
  timing: RefreshTiming;
  attempt: number;
  /** Every trigger in this entry was an undo; null once any trigger was not. */
  voids: Voided[] | null;
  settle: Array<(result: RefreshResult) => void>;
}

/** Entries not running: in `ready`, or waiting out a backoff. At most one per
 *  division. */
const waiting = new Map<string, Entry>();
const ready: Entry[] = [];
let draining = false;

function enqueue(orgId: string, divisionId: string, voided: Voided | null, timing: RefreshTiming): Promise<RefreshResult> {
  const key = divisionId.toLowerCase();
  return new Promise<RefreshResult>((resolve) => {
    const existing = waiting.get(key);
    if (existing !== undefined) {
      // It has not read anything yet, so its fold will see this write too.
      existing.voids = existing.voids === null || voided === null ? null : [...existing.voids, voided];
      existing.settle.push(resolve);
      return;
    }
    const entry: Entry = {
      orgId,
      divisionId,
      key,
      timing,
      attempt: 0,
      voids: voided === null ? null : [voided],
      settle: [resolve],
    };
    waiting.set(key, entry);
    ready.push(entry);
    void drain();
  });
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (let entry = ready.shift(); entry !== undefined; entry = ready.shift()) {
      // From here a new request for this division starts a fresh entry: this
      // one's read may already be under way and miss it.
      if (waiting.get(entry.key) === entry) waiting.delete(entry.key);
      const result = await runEntry(entry);
      if (result === "requeued") continue;
      for (const settle of entry.settle) settle(result);
    }
  } finally {
    draining = false;
  }
}

async function runEntry(entry: Entry): Promise<RefreshResult | "requeued"> {
  try {
    const first = await attempt(entry, null);
    if (first !== null) return first;
    const wait = entry.timing.backoffMs[entry.attempt];
    if (wait !== undefined) {
      entry.attempt += 1;
      const newer = waiting.get(entry.key);
      if (newer !== undefined) {
        // A request arrived while this one tried; its entry has read nothing
        // yet, so it covers both.
        newer.voids = newer.voids === null || entry.voids === null ? null : [...newer.voids, ...entry.voids];
        newer.settle.push(...entry.settle);
        return "requeued";
      }
      waiting.set(entry.key, entry);
      setTimeout(() => {
        ready.push(entry);
        void drain();
      }, wait);
      return "requeued";
    }
    try {
      const last = await attempt(entry, entry.timing.lockTimeoutMs);
      if (last !== null) return last;
    } catch (err) {
      if ((err as { code?: string }).code !== "55P03") throw err;
    }
    log.warn(
      { divisionId: entry.divisionId },
      "player-stats: refresh gave up waiting for the division's stats lock; clearing the caches anyway (the result stands)",
    );
    return { outcome: "busy", token: null, rowsBefore: null, rowsAfter: null, cleared: false };
  } catch (err) {
    log.warn({ err, divisionId: entry.divisionId }, "player-stats: refresh failed (the result stands)");
    return { outcome: "failed", token: null, rowsBefore: null, rowsAfter: null, cleared: false };
  }
}

/** One transaction. `blockMs` null: try the lock and return null if it is
 *  held. A number: wait for it that long (55P03 on timeout). */
async function attempt(entry: Entry, blockMs: number | null): Promise<RefreshResult | null> {
  const { divisionId } = entry;
  return withTenant(entry.orgId, async (tx): Promise<RefreshResult | null> => {
    await tx`select set_config('statement_timeout', ${`${entry.timing.statementTimeoutMs}ms`}, true)`;
    if (blockMs === null) {
      if (!(await tryLockPlayerStats(tx, divisionId))) return null;
    } else {
      const [setting] = await tx<{ previous: string }[]>`select current_setting('lock_timeout') as previous`;
      await tx`select set_config('lock_timeout', ${`${blockMs}ms`}, true)`;
      await lockPlayerStats(tx, divisionId);
      await tx`select set_config('lock_timeout', ${setting!.previous}, true)`;
    }
    const coverage = await playerStatsCoverage(tx, divisionId);
    const same = { token: coverage.token, rowsBefore: coverage.rowCount, rowsAfter: coverage.rowCount, cleared: false };
    const ledger = coverage.ledger;
    // Skips even if something else moved since the fold (review n2): the next stats read's reconcile queues that refresh, a few minutes late, accepted (owner ruling 2026-09-17).
    if (
      entry.voids !== null &&
      ledger !== null &&
      entry.voids.every((v) => (ledger[v.fixtureId]?.[1] ?? 0) < v.seq)
    ) {
      return { outcome: "unseen", ...same };
    }
    if (coverage.covered) return { outcome: "covered", ...same };
    const [before] = await tx<{ n: number }[]>`
      select count(*)::int as n from player_stat_snapshots where division_id = ${divisionId}`;
    const { rows } = await recomputePlayerStats(tx, divisionId);
    const [record] = await tx<{ token: string }[]>`
      select folded_at::text || '/' || inputs_md5 as token from player_stat_folds where division_id = ${divisionId}`;
    return { outcome: "folded", token: record?.token ?? null, rowsBefore: before!.n, rowsAfter: rows.length, cleared: false };
  });
}

/** The fold has COMMITTED (or the snapshot already covered the ledger): drop
 *  every public copy built from the older rows, then tell open hubs. */
async function invalidateAfterRefresh(orgId: string, divisionId: string): Promise<void> {
  try {
    const [row] = await sql<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId} and org_id = ${orgId}`;
    if (!row) return;
    if (!fireStatsRevalidate(divisionId, row.competition_id)) {
      // Registered inside a cache scope, whose after() task runs in that scope
      // and cannot clear tags (final review m7). Owe the clearing to the next
      // refresh of this division, which would otherwise skip it (same fold
      // record, or an empty board).
      log.warn(
        { divisionId },
        "player-stats: the ISR tags could not be cleared from here (inside a cache scope); the next refresh clears them",
      );
      remember(clearRefused, divisionId.toLowerCase(), true);
    }
    // The hub, and the division's schedule, standings and entrants documents by
    // name in the same DEL (final review r2-m4: no keyspace SCAN).
    const keys = [`pub:v1:hub:${row.competition_id}`, ...publicDivisionCacheKeys(divisionId)];
    const deleted = cacheDel(...keys).catch((err: unknown) => {
      log.warn({ err, divisionId, keys }, "player-stats: a public Redis delete failed after the refresh");
    });
    // The push waits on the hub DEL (never longer than its bound), the same
    // rule as the score path: a refetch that beat the delete would read the
    // copy with the old leaders. This task waits for the DEL too, because Next
    // flushes the tags above only once it returns, and an expired tag rebuilt
    // from a hub document not yet deleted would cache the old leaders again.
    // It does NOT wait for the push (review m1).
    await new Promise<void>((resolve) => {
      sendAfterDeleteOrBound(deleted, () => {
        void publishDivisionUpdate(divisionId, "score");
        resolve();
      });
    });
  } catch (err) {
    log.warn({ err, divisionId }, "player-stats: public cache invalidation after the refresh failed");
  }
}
