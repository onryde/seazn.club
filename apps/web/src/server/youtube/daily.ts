import "server-only";
// server/youtube/daily.ts — YouTube Connect T17: the DAILY YouTube pass on the relay-sweep cron (spec §6.6 "Daily", §6.8; plan T17 with the
// post-T2 amendment; controller overrides O2 carries a-h, O3, O4). The minute-by-minute work (ending broadcasts) is end-step.ts's; this is
// the once-a-day work that keeps stored YouTube data honest (Google API Services User Data Policy, DP III.E.4) and settles what the end
// step can never settle. Legs, in this order, each in its own try so a fault in one never skips the rest:
//   1. PENDING GRANTS  — an expired `youtube_connect_pending` row (a sealed token, the picker's channel titles; a cancelled pick leaves
//      one behind) is deleted (T8 ruling, carry e).
//   2. PER CONNECTED CHANNEL, one access token for both halves:
//      HEALTH  — `listMyChannels` (rename → the connection's channel_title AND its destination row's label; the channel gone from the
//      grant → reconnect_needed) and `liveEnabled` (→ last_error_code youtube_live_not_enabled / youtube_live_blocked, or null), stamped
//      with the DATABASE's clock (carry f: `liveStateOf` compares last_health_at with status_since, which the database wrote).
//      A dead grant (`invalid_grant`, or a reconnect refusal that is not the live-permission one - see carry g below) → reconnect_needed,
//      status_since now: the 30-day purge clock starts.
//      REFRESH — the `complete` rows whose video was last confirmed more than 25 days ago, in batches of 50 (Google's per-call id cap):
//      still there → refreshed_at = the pass's now; gone → the row is deleted and fixtures.stream_url is cleared WHEN IT POINTS AT THAT
//      VIDEO (a club's own link is never touched).
//   2b. LAPSED VIDEOS — THE CEILING HAS NO CARVE-OUT (PO ruling, B6 round 2): a `complete` row of ANY non-revoked connection that has gone the
//      30-day ceiling without a confirmation is deleted (and the link that pointed at it cleared, the public page expired after the commit).
//      For a dead grant the refresh above cannot run at all; for a connected channel it did not complete (the token will not open, YouTube
//      refuses, the budget never reached it). The delete reads no token and spends no budget. The dead grant's own purge (4) comes later.
//   2c. RETIRED KEYS — a pooled key whose liveStream is gone at YouTube (retired by Go live) keeps a sealed ingest key for nothing: it is
//      deleted, the finished broadcasts that named it forgetting it first. An open broadcast on it keeps it until it finishes.
//   2d. IDLE KEYS — the pooled keys of ANY non-revoked connection that nothing has used for the whole ceiling are deleted (`deleteIdleKeys`):
//      the row at once, with no token and no budget; the liveStream at YouTube afterwards, best effort, only where a token opens.
//   3. STUCK BROADCASTS (carries a, b) — see `settleStuck`.
//   4. DEAD GRANTS — reconnect_needed for 30 days → revokeConnection (token-store's ONE statement, R1/B1-R1) + `purgeConnectionData`, then,
//      after the commit and best effort, the grant is revoked AT GOOGLE (DP III.E.4: the access goes too; not every flip is a dead token). That
//      revoke is the one Google call outside the connection slice, and has its OWN allowance (`YOUTUBE_DAILY_REVOKE_BUDGET_MS`): a purge that
//      needs a revoke starts only while the allowance has time left, and is otherwise left WHOLE for the next pass (counted `deferred`) -
//      the token is cleared with the purge, so a purge cannot be done now and its revoke later. A purge with nothing to revoke (a token that
//      will not open, an account another connection runs on) calls nobody and is never held back.
//   5. STRANDED ROWS (carry c) — a revoked connection that still holds rows, keys, a sub, an archived watch link or a pending grant (the
//      end step skips revoked connections, so an open broadcast on one never settles; a disconnect whose purge transaction failed leaves
//      the same) is purged.
//   6. FAILED ROWS (carry d) — a `failed` broadcast row is deleted 30 days after it failed. The plan names no retention for a failed row;
//      it holds a title and (usually) a video id, i.e. YouTube data, so DP III.E.4's 30 days applies.
//
// THE BUDGET. The pass shares the Worker's 60 s with the relay sweep that follows it, and a connection is three or four Google calls: every
// call of the connection leg (health, refresh) and the idle keys' stream deletes starts only while `YOUTUBE_DAILY_BUDGET_MS` has time left
// (`gated`). A connection the slice cut is counted `deferred` (not `failed`: the Worker's alert is unchanged). One cut BEFORE its first call
// has not been stamped, so it is the least recently checked and the first one tomorrow. One cut AFTER its health check (during its refresh)
// IS stamped (`last_health_at`), so it queues behind the connections not yet checked and its refresh waits for its own next turn; the lapsed
// leg (2b) is what keeps the rows it leaves from outliving the ceiling. The dead grants' Google revokes take their own, smaller allowance (4). The database-only deletes (the lapsed videos, the idle and retired key rows, the retention, a purge with nothing to
// revoke) call nobody, spend neither, and always run: the 30-day ceiling is not the budget's to defer.
//
// DECISIONS the brief left open (also in the T17 report):
//  - g (insufficientLivePermissions). YouTube's "the request is not authorized to <live>" is a fact about the CHANNEL's live permission,
//    which a reconnect of the same account may not cure. It is live_blocked EVERYWHERE (controller ruling, fix round 1): the connection
//    STAYS `connected`, last_error_code = youtube_live_blocked, and no purge clock starts - in this health check, in Go live's prepare
//    and in the end step, which ask the one predicate in port.ts (`isLiveBlockedRefusal`). Any other reconnect refusal flips as before.
//  - a/b (stuck rows). A row is STUCK when it has failed for a full day AT the backoff cap (31 failures, derived below from end-step's own
//    constants), or sits `ending` longer than that schedule takes to run (a claim deferred on every firing never counts an attempt). It is
//    reported (captureError, codes and ids only) and counted `failed` (the Worker's degraded line), and finalized `failed` / `end_stuck`
//    so its key frees, UNLESS a session on it is active (a key is never freed under a stream). A row on a `reconnect_needed` connection is
//    not stuck: it waits for the club (a reconnect clears the backoff and the end succeeds) and for the 30-day purge.
//  - c (stranded). A revoked connection's rows are PURGED, not finalized: the connection is gone, and DP III.E.4 asks for the data to go.
//
// purgeConnectionData is SHARED with T18's disconnect: it takes a transaction, refuses a connection that is not revoked, is idempotent, and
// returns counts (plus the divisions whose public pages must be expired once the transaction commits — it cannot do that itself).
//
// SECRETS. A token, a stream key and a Google body never reach a log line, a report or a row: a port refusal is a CODE (port.ts), the sealed
// token is opened in memory for one pass, and what is reported carries ids and codes only. The file names no sealed column.
import { sql, type Tx } from "@/lib/db";
import { captureError } from "@/lib/sentry";
import { YOUTUBE_LIVE_STATE_OF_REFUSAL, youtubeVideoId, type YoutubeLiveStateRefusal } from "@/lib/youtube";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { ACTIVE_STATES } from "@/server/relay/domain/session";
import { recordLiveState } from "./connections";
import { BudgetSpent, CLAIM_LEASE_MINUTES, OPEN_STATES, YOUTUBE_END_BACKOFF_CAP_MINUTES, endBackoffMinutes } from "./end-step";
import { YouTubeError, isDeadGrantRefusal, isLiveBlockedRefusal, type YouTubePort } from "./port";
import { YoutubeTokenUnreadableError, markReconnectNeeded, openToken, revokeConnection } from "./token-store";

/** `checked` connections health-checked; `reconnectNeeded` connections this pass found dead; `refreshed` / `removed` broadcast rows
 *  confirmed / deleted (removed: a video gone from YouTube, a complete row of a dead grant past the ceiling, or a failed row past its
 *  retention); `keysRemoved` pooled stream keys deleted (retired ones, and ones idle past the ceiling); `purged` connections whose data was
 *  purged; `failed` what did not work and is retried tomorrow, plus every stuck broadcast (the Worker alerts on this one); `deferred`
 *  connections a wall-clock budget cut short (not started, or left between two of their YouTube calls) and dead grants whose purge waits
 *  for the revoke allowance - not a failure: a later pass reaches them (a connection never started is the first one tomorrow; one cut
 *  after its health check queues behind the ones not yet checked). */
export type YoutubeDailyResult = {
  checked: number; reconnectNeeded: number; refreshed: number; removed: number; keysRemoved: number; purged: number; failed: number; deferred: number;
};

/** A stored video link is re-confirmed after this long (spec §6.6 "~25 days"; DP III.E.4 allows 30, so a failed day has slack). */
export const YOUTUBE_REFRESH_AFTER_DAYS = 25;
/** THE CEILING (Google API Services User Data Policy III.E.4): what Seazn stores from YouTube is refreshed or deleted within this many
 *  days. Every other 30 here is this one fact, so a change to it moves them together. */
export const YOUTUBE_DATA_CEILING_DAYS = 30;
/** A grant that has been dead this long has its YouTube data purged (DP III.E.4, spec §6.8). */
export const YOUTUBE_DEAD_GRANT_PURGE_DAYS = YOUTUBE_DATA_CEILING_DAYS;
/** A `failed` broadcast row is deleted this long after it failed (DP III.E.4; the plan names no other figure). */
export const YOUTUBE_FAILED_ROW_RETENTION_DAYS = YOUTUBE_DATA_CEILING_DAYS;

/** The pass's own wall-clock slice for its health, refresh and idle-stream YouTube calls. The pass runs on the relay-sweep firing, inside
 *  the cron Worker's 60 s job timeout (apps/cron-worker call.ts), ahead of the relay sweep, which has no budget of its own: a connection
 *  costs three or four Google calls of up to `YOUTUBE_CALL_BOUND_MS` each, so a long list of channels could use the whole minute. A call
 *  starts only while the slice has time left, so the pass overruns it by at most the one call in flight. */
export const YOUTUBE_DAILY_BUDGET_MS = 15_000;
/** The dead grants' own allowance for their Google revokes (DP III.E.4: a purged connection's access must go too). A revoke is a call that
 *  cannot wait for a slice with room - the purge clears the token it needs - so it is bounded separately: a purge that needs one starts
 *  only while this has time left (counted from the first such purge), else it waits for tomorrow, whole. It overruns by at most the one
 *  call in flight. The pass in all, YouTube calls only: `YOUTUBE_DAILY_BUDGET_MS` + `YOUTUBE_DAILY_REVOKE_BUDGET_MS` + two calls in flight
 *  (`YOUTUBE_CALL_BOUND_MS` each) = 40 s, two thirds of the Worker's minute - the relay sweep keeps the rest (the database work is not
 *  counted: it is fast, and the policy's deletes are not the clock's to cut). */
export const YOUTUBE_DAILY_REVOKE_BUDGET_MS = 5_000;

/** videos.list takes at most 50 ids per call (Google). */
const VIDEOS_PER_CALL = 50;
/** Our code on a row the daily pass finalized because it could never settle. Matches V479's `[a-z_:]{1,64}`. */
const CODE_STUCK = "end_stuck";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const daysBefore = (at: Date, days: number): Date => new Date(at.getTime() - days * DAY_MS);

// ─── the stuck-row bound, DERIVED from the end step's backoff (carry a) ──────────────────────────────────────────────────────────────
/** The most failures a schedule may take to reach its cap. Real schedules are exponential (7 for 1, 2, 4 ... 60); a bound keeps a schedule
 *  that never gets there from hanging the module load (a `while` that never ends), and turns it into a loud, named error. */
const MAX_FAILURES_TO_REACH_CAP = 32;

/** The stuck-row bound, derived from a backoff schedule. A row that fails every time waits `backoffMinutes(1)`, `backoffMinutes(2)` ...
 *  until it sits at `capMinutes`; it is stuck after `attempts` failures - the failures to reach the cap, plus `daysAtCap` days of them at it -
 *  and `minutes` is how long such a row takes to get there (the waits between its first failure and its last). Throws, naming this bound,
 *  when the schedule never reaches the cap within `MAX_FAILURES_TO_REACH_CAP` failures or the cap is not a positive whole number of minutes. */
export function deriveStuckBounds(
  o: { capMinutes: number; backoffMinutes: (failures: number) => number; daysAtCap: number },
): { attempts: number; minutes: number } {
  if (!Number.isInteger(o.capMinutes) || o.capMinutes < 1) {
    throw new Error(`the stuck-broadcast bound cannot be derived: the backoff cap must be a positive whole number of minutes, got ${o.capMinutes}`);
  }
  let toCap = 0;
  for (let n = 1; n <= MAX_FAILURES_TO_REACH_CAP; n++) {
    if (o.backoffMinutes(n) >= o.capMinutes) {
      toCap = n;
      break;
    }
  }
  if (toCap === 0) {
    throw new Error(`the stuck-broadcast bound cannot be derived: the end step's backoff does not reach its ${o.capMinutes}-minute cap within ${MAX_FAILURES_TO_REACH_CAP} failures`);
  }
  const attempts = toCap + Math.ceil((o.daysAtCap * 24 * 60) / o.capMinutes);
  let minutes = 0;
  for (let k = 1; k < attempts; k++) minutes += o.backoffMinutes(k);
  return { attempts, minutes };
}

/** A row that has failed for a full day AT the cap is stuck: long enough that no outage YouTube has is the cause, short enough that a key
 *  does not stay held for a week. */
const STUCK_DAYS_AT_CAP = 1;
const STUCK_BOUNDS = deriveStuckBounds({ capMinutes: YOUTUBE_END_BACKOFF_CAP_MINUTES, backoffMinutes: endBackoffMinutes, daysAtCap: STUCK_DAYS_AT_CAP });
/** The failure count at which a row is stuck: the failures to reach the cap, plus a day of them at it (31 with P6's 1, 2 ... 60). */
export const YOUTUBE_END_STUCK_AFTER_ATTEMPTS = STUCK_BOUNDS.attempts;
/** How long a row that fails every time it is tried takes to get there. An `ending` row claimed longer ago than this is stuck by age
 *  (1503 minutes with P6). */
export const YOUTUBE_END_STUCK_AFTER_MINUTES = STUCK_BOUNDS.minutes;

/** Which refusal each non-enabled live state is recorded as: the INVERSE of the shared table connections.ts `liveStateOf` reads, so the
 *  writer here and the reader cannot disagree. */
const REFUSAL_OF_LIVE_STATE = Object.fromEntries(
  Object.entries(YOUTUBE_LIVE_STATE_OF_REFUSAL).map(([code, state]) => [state, code]),
) as Record<"not_enabled" | "blocked", YoutubeLiveStateRefusal>;

const zero = (): YoutubeDailyResult => ({ checked: 0, reconnectNeeded: 0, refreshed: 0, removed: 0, keysRemoved: 0, purged: 0, failed: 0, deferred: 0 });

/** Test-only seams (end-step.ts's `EndStepHooks.afterClaim` precedent): each runs in the window between a READ and the WRITE that acts on
 *  it, the only place a concurrent writer can land, which only a hook can make deterministic. Production passes none. */
export type DailyHooks = {
  /** After the connected channels were listed, before the first token is opened. */
  afterConnectionsListed?: () => Promise<void>;
  /** After the connections holding stale `complete` rows they can no longer refresh were listed, before the first is locked. */
  afterLapsedListed?: () => Promise<void>;
  /** After the stuck broadcasts were listed, before the first is finalized. */
  afterStuckListed?: () => Promise<void>;
  /** After the connections holding a pooled key past the ceiling were listed, before one connection's idle keys are looked at. */
  beforeIdleKeys?: () => Promise<void>;
  /** After the dead grants were listed, before the first purge. */
  afterDeadGrantsListed?: () => Promise<void>;
  /** After the purge / removal read the fixtures' links, before it clears one. */
  afterLinksRead?: () => Promise<void>;
};

type Division = { divisionId: string; competitionId: string };
export type PurgeResult = { broadcasts: number; streamUrlsCleared: number; divisions: Division[] };

/** The public match pages of these divisions list the parts and the replay link: expire them (once the data has COMMITTED). */
const expirePages = (divisions: readonly Division[]): void => {
  for (const d of divisions) fireDivisionRevalidate(d.divisionId, d.competitionId);
};

interface StoredBroadcast { id: string; fixture_id: string; yt_broadcast_id: string | null }

/** The divisions of these fixtures, for the pages to expire. */
async function divisionsOf(tx: Tx, orgId: string, fixtureIds: readonly string[]): Promise<Division[]> {
  if (fixtureIds.length === 0) return [];
  const rows = await tx<{ division_id: string; competition_id: string }[]>`
    select distinct f.division_id, d.competition_id
      from fixtures f join divisions d on d.id = f.division_id
     where f.id = any(${[...fixtureIds]}::uuid[]) and f.org_id = ${orgId}`;
  return rows.map((r) => ({ divisionId: r.division_id, competitionId: r.competition_id }));
}

/** Clear `fixtures.stream_url` on the fixtures of these broadcasts WHEN IT POINTS AT ONE OF THEIR VIDEOS (compared by video, so `youtu.be/<id>`
 *  and `watch?v=<id>` are one video, as lib/youtube's `linkIsOneOfParts` compares). A club's own link to anything else is not touched, and the
 *  clear is conditional on the value just read, so a link saved meanwhile is not lost. Returns how many links it cleared. */
async function clearStreamUrlsPointingAt(tx: Tx, orgId: string, rows: readonly StoredBroadcast[], hooks: DailyHooks): Promise<number> {
  const videos = new Set(rows.flatMap((r) => (r.yt_broadcast_id === null ? [] : [r.yt_broadcast_id])));
  const fixtureIds = [...new Set(rows.map((r) => r.fixture_id))];
  if (videos.size === 0 || fixtureIds.length === 0) return 0;
  const linked = await tx<{ id: string; stream_url: string }[]>`
    select id, stream_url from fixtures where id = any(${fixtureIds}::uuid[]) and org_id = ${orgId} and stream_url is not null`;
  await hooks.afterLinksRead?.();
  let cleared = 0;
  for (const f of linked) {
    const video = youtubeVideoId(f.stream_url);
    if (video === null || !videos.has(video)) continue;   // a club's own link
    const done = await tx<{ id: string }[]>`update fixtures set stream_url = null where id = ${f.id} and stream_url = ${f.stream_url} returning id`;
    cleared += done.length;
  }
  return cleared;
}

/** Delete these broadcast rows and clear the links that pointed at their videos, in the caller's transaction. */
async function deleteBroadcasts(
  tx: Tx, orgId: string, rows: readonly StoredBroadcast[], hooks: DailyHooks,
): Promise<{ deleted: number; cleared: number; divisions: Division[] }> {
  if (rows.length === 0) return { deleted: 0, cleared: 0, divisions: [] };
  const cleared = await clearStreamUrlsPointingAt(tx, orgId, rows, hooks);
  const gone = await tx<{ fixture_id: string }[]>`
    delete from youtube_broadcasts where id = any(${rows.map((r) => r.id)}::uuid[]) and org_id = ${orgId} returning fixture_id`;
  return { deleted: gone.length, cleared, divisions: await divisionsOf(tx, orgId, [...new Set(gone.map((g) => g.fixture_id))]) };
}

// ─── the shared purge ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Purge everything Seazn stored FROM YouTube for a REVOKED connection (DP III.E.4), inside the caller's transaction: its broadcast rows
 *  (titles, video ids), the `fixtures.stream_url` values that pointed at its videos (a club's own link is kept), its pooled stream keys (the
 *  sealed ingest keys are YouTube API data), the watch link on its archived destination, the connection's Google account id, and any
 *  pending reconnect grant for it. Shared by the dead-grant purge here and T18's disconnect.
 *
 *  - The connection must be REVOKED (token-store's `revokeConnection`, which the caller runs first): purging a live connection's data would
 *    break it, so a connection in any other status throws and nothing changes. A connection that does not exist is a no-op (nothing of it
 *    can remain: every table cascades from the org).
 *  - IDEMPOTENT: a second call finds nothing and returns zeros.
 *  - LOCK ORDER. A transaction that locks a connection AND its rows takes the connection FIRST: this one, Go live's pick and a disconnect
 *    (`for update`), the refresh and the key deletes (`for share`) - so they queue on the connection instead of meeting half-way through
 *    a set of row locks. A writer that does NOT hold the connection must not WAIT on a row a connection holder may want: the end step
 *    claims its broadcast row `for update skip locked`, the failed-row retention (leg 6) takes its rows `skip locked`, and the stuck
 *    finalizer updates one row at a time (one lock cannot be half of a cycle). A reconnect's SAVE is the one writer that comes the other
 *    way round: it locks its pending grant FIRST and the connection second. So the pending grants below are deleted `skip locked`: a
 *    grant a save holds is left alone (that save then finds the connection revoked and refuses, rolling its take back), instead of this
 *    transaction waiting for a row whose holder is waiting for the connection this one holds - a deadlock. A grant left behind is the
 *    stranded leg's, on the next pass.
 *  - It writes nothing outside the transaction, and cannot expire the public pages itself (a revalidation inside an open transaction
 *    would race the commit): the caller expires `result.divisions` after the commit. */
export async function purgeConnectionData(tx: Tx, connectionId: string, hooks: DailyHooks = {}): Promise<PurgeResult> {
  const [c] = await tx<{ org_id: string; status: string }[]>`
    select org_id, status from org_youtube_connections where id = ${connectionId} for update`;
  if (!c) return { broadcasts: 0, streamUrlsCleared: 0, divisions: [] };
  if (c.status !== "revoked") throw new Error(`purgeConnectionData: connection ${connectionId} is not revoked - revoke it first`);
  const orgId = c.org_id;
  const rows = await tx<StoredBroadcast[]>`
    select id, fixture_id, yt_broadcast_id from youtube_broadcasts where connection_id = ${connectionId} and org_id = ${orgId} for update`;
  const gone = await deleteBroadcasts(tx, orgId, rows, hooks);   // before the keys: a broadcast row references its key
  await tx`delete from youtube_stream_keys where connection_id = ${connectionId} and org_id = ${orgId}`;
  await tx`update org_stream_targets set watch_url = null where youtube_connection_id = ${connectionId} and org_id = ${orgId} and watch_url is not null`;
  await tx`update org_youtube_connections set google_sub = null where id = ${connectionId} and org_id = ${orgId} and google_sub is not null`;
  await tx`
    delete from youtube_connect_pending
     where id in (select id from youtube_connect_pending where connection_id = ${connectionId} and org_id = ${orgId} for update skip locked)`;
  return { broadcasts: gone.deleted, streamUrlsCleared: gone.cleared, divisions: gone.divisions };
}

/** Whether another NON-revoked connection (any organisation) reports the same non-null Google account as this one. Revoking a grant at
 *  Google kills EVERY token of that account, so a connection whose account another still runs on must not revoke it (T6-R2 as amended:
 *  V479's one-live-channel index is global, so a shared CHANNEL cannot happen, but one person can administer two clubs). Shared by the
 *  dead-grant purge here and T18's disconnect; read in the transaction that revokes the connection.
 *  It first takes the ACCOUNT's advisory lock (transaction-scoped, so it frees at commit): two clubs on one account that leave at the same
 *  moment would each read the other as still running on it (neither has committed) and neither would revoke, leaving the grant alive at
 *  Google after both are gone (B6 batch review M4). With the lock the second reads after the first committed. Lock order: the caller holds
 *  its connection `for update` already; this lock comes after it, and nothing that holds this lock waits on another connection's row. */
export async function accountIsShared(tx: Tx, connectionId: string, googleSub: string | null): Promise<boolean> {
  if (googleSub === null) return false;
  await tx`select pg_advisory_xact_lock(hashtextextended('yt-sub:' || ${googleSub}::text, 0))`;
  const [r] = await tx<{ shared: boolean }[]>`
    select exists (select 1 from org_youtube_connections o
                    where o.id <> ${connectionId} and o.status <> 'revoked' and o.google_sub = ${googleSub}) as shared`;
  return r!.shared;
}

// ─── port calls ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Conn { id: string; org_id: string; channel_id: string; channel_title: string }
interface Pass {
  port: YouTubePort; now: Date; orgIds: string[] | undefined; out: YoutubeDailyResult; hooks: DailyHooks;
  /** Whether a dead grant's Google revoke may start now (`YOUTUBE_DAILY_REVOKE_BUDGET_MS`): the one rule for starting each of them. */
  revokeRoom: () => boolean;
}

/** A port call. Whatever it throws becomes a YouTubeError: a driver maps Google's answers already, and anything else is YouTube not
 *  answering. The original is dropped, never wrapped (it may hold what must not be kept) - and REPORTED, as a fresh error that names only
 *  its class, the connection and the step: a driver bug that fails every day must not be silent. */
async function viaPort<T>(call: () => Promise<T>, c: Pick<Conn, "id" | "org_id">, step: string): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof YouTubeError || err instanceof BudgetSpent) throw err;
    const kind = (err instanceof Error ? err.name : typeof err).replace(/[^A-Za-z]/g, "").slice(0, 64);
    captureError(new Error(`youtube daily: a port call raised a non-port error (${kind})`), {
      orgId: c.org_id, route: "youtube.daily.port", extra: { connectionId: c.id, step },
    });
    throw new YouTubeError("youtube_unavailable");
  }
}

/** The port with EVERY call gated on the slice: a call starts only while `room()` says there is time, else it throws `BudgetSpent` without
 *  calling (end-step.ts's gate, for the daily pass's calls). A Proxy over the port rather than a list of wrapped methods, so a method added
 *  to `YouTubePort` is gated from the day it exists instead of silently skipping the slice (B6 round 2 C4). The one exception is `revoke`:
 *  the Google revoke of a purged grant is the policy's step, and `purgeDeadGrant` bounds it by its own allowance before it commits the
 *  purge. Every call runs on the ORIGINAL port (`this`), a refusal is thrown at the call (callers make it inside `viaPort`, which catches it
 *  whether it is thrown or rejected), and a member that is not a method (`mode`) passes through. */
export function gated(port: YouTubePort, room: () => boolean): YouTubePort {
  return new Proxy(port, {
    get(target, prop) {
      const member: unknown = Reflect.get(target, prop, target);
      if (typeof member !== "function") return member;
      const call = member as (...a: unknown[]) => unknown;
      if (prop === "revoke") return (...a: unknown[]) => call.call(target, ...a);
      return (...a: unknown[]) => {
        if (!room()) throw new BudgetSpent();
        return call.call(target, ...a);
      };
    },
  });
}

/** The connection's grant is dead: reconnect_needed, status_since now (token-store's writer; false when it already was). */
async function flip(c: Conn, out: YoutubeDailyResult): Promise<void> {
  if (await markReconnectNeeded(sql, c.org_id, c.id)) out.reconnectNeeded++;
}

/** A step failed with something that is not a dead grant: it is retried tomorrow. A port refusal is an expected state (counted, not
 *  reported); anything else is ours to look at (reported, ids only). */
function failedStep(err: unknown, c: Conn, out: YoutubeDailyResult, step: string): void {
  out.failed++;
  if (!(err instanceof YouTubeError)) captureError(err, { orgId: c.org_id, route: `youtube.daily.${step}`, extra: { connectionId: c.id } });
}

/** The connection row, held `for share` for the rest of the transaction: Go live's pick, a disconnect and a purge hold it `for update`, so
 *  the work below (the refresh's row writes, the key deletes) queues behind them, and they behind it, instead of meeting them half-way
 *  through a set of row locks - the order every writer of this connection's rows takes is the connection first, then its rows.
 *  False when the connection is gone or revoked (its rows are the purge's). */
async function lockConnectionShared(tx: Tx, orgId: string, connectionId: string): Promise<boolean> {
  const [c] = await tx<{ status: string }[]>`
    select status from org_youtube_connections where id = ${connectionId} and org_id = ${orgId} for share`;
  return !!c && c.status !== "revoked";
}

// ─── leg 2: health and refresh, per connected channel ─────────────────────────────────────────────────────────────────────────────────

/** The channel's title changed at YouTube: the connection's channel_title AND its (active) destination row's label follow, in one
 *  transaction so the two cannot disagree. An API destination is never renamed by a person (P9), so the label simply tracks the title.
 *  An empty title from Google is not a title: the old one stays. */
async function followTitle(c: Conn, title: string): Promise<void> {
  if (title.trim() === "" || title === c.channel_title) return;
  await sql.begin(async (tx) => {
    const moved = await tx<{ id: string }[]>`
      update org_youtube_connections set channel_title = ${title}
       where id = ${c.id} and org_id = ${c.org_id} and status = 'connected' returning id`;
    if (moved.length === 1) {
      await tx`update org_stream_targets set label = ${title}
                where youtube_connection_id = ${c.id} and org_id = ${c.org_id} and archived_at is null`;
    }
  });
}

/** Health: the channel is still the grant's, its title follows, and live streaming is (not) enabled. Returns false when the connection
 *  was found dead (it is `reconnect_needed` now and has nothing more to do this pass). */
async function checkHealth(p: Pass, at: string, c: Conn): Promise<boolean> {
  try {
    const channels = await viaPort(() => p.port.listMyChannels(at), c, "channels");
    const mine = channels.find((ch) => ch.id === c.channel_id);
    if (!mine) {
      await flip(c, p.out);   // the channel is no longer among the grant's: there is nothing to stream to, and a reconnect re-asks
      return false;
    }
    await followTitle(c, mine.title);
    let code: YoutubeLiveStateRefusal | null;
    try {
      const live = await viaPort(() => p.port.liveEnabled(at), c, "live");
      code = live === "enabled" ? null : REFUSAL_OF_LIVE_STATE[live];
    } catch (err) {
      // Decision g (controller ruling): "not authorized to <live>" is the channel's live permission, not a dead grant - blocked, no
      // purge clock. Go live's prepare and the end step ask the same predicate (port.ts), so the three cannot disagree.
      if (isLiveBlockedRefusal(err)) code = "youtube_live_blocked";
      else throw err;
    }
    await recordLiveState(sql, c.org_id, c.id, code);   // last_health_at = the database's now(), the clock status_since is on (carry f)
    return true;
  } catch (err) {
    if (err instanceof BudgetSpent) throw err;   // the connection is cut here (checkConnection counts it deferred)
    if (isDeadGrantRefusal(err)) {
      await flip(c, p.out);
      return false;
    }
    failedStep(err, c, p.out, "health");
    return true;
  }
}

/** Refresh (DP III.E.4): every `complete` row of this connection whose video was last confirmed over 25 days ago is asked about, 50 ids to a
 *  call UNDER THIS CONNECTION'S TOKEN (a video of another channel is "absent" to the wrong token). Present → refreshed_at = the pass's now;
 *  gone → the row is deleted and a link that pointed at it cleared. A batch YouTube cannot answer keeps its rows stale for tomorrow. */
async function refreshVideos(p: Pass, at: string, c: Conn): Promise<void> {
  let stale: (StoredBroadcast & { yt_broadcast_id: string })[];
  try {
    stale = await sql<(StoredBroadcast & { yt_broadcast_id: string })[]>`
      select id, fixture_id, yt_broadcast_id from youtube_broadcasts
       where connection_id = ${c.id} and org_id = ${c.org_id} and state = 'complete' and yt_broadcast_id is not null
         and refreshed_at < ${daysBefore(p.now, YOUTUBE_REFRESH_AFTER_DAYS)}
       order by refreshed_at, id`;
  } catch (err) {
    failedStep(err, c, p.out, "refresh");
    return;
  }
  for (let i = 0; i < stale.length; i += VIDEOS_PER_CALL) {
    const batch = stale.slice(i, i + VIDEOS_PER_CALL);
    try {
      const present = await viaPort(() => p.port.existingVideos(at, batch.map((r) => r.yt_broadcast_id)), c, "videos");
      const here = batch.filter((r) => present.has(r.yt_broadcast_id));
      const gone = batch.filter((r) => !present.has(r.yt_broadcast_id));
      const removed = await sql.begin(async (tx) => {
        // The connection first, `for share`: a disconnect locks it `for update` and then ALL the connection's rows in id order, while this
        // transaction updates the rows YouTube still has and only then deletes the ones it lost - two writers meeting in the middle of a
        // set of row locks. Holding the connection makes them queue instead.
        if (!(await lockConnectionShared(tx, c.org_id, c.id))) return null;
        if (here.length > 0) {
          await tx`update youtube_broadcasts set refreshed_at = ${p.now} where id = any(${here.map((r) => r.id)}::uuid[]) and org_id = ${c.org_id}`;
        }
        return deleteBroadcasts(tx, c.org_id, gone, p.hooks);
      });
      if (removed === null) return;   // disconnected meanwhile: its rows are purged, nothing is left to confirm
      p.out.refreshed += here.length;
      p.out.removed += removed.deleted;
      expirePages(removed.divisions);
    } catch (err) {
      if (err instanceof BudgetSpent) throw err;   // the rest of the batches wait for tomorrow
      if (isDeadGrantRefusal(err)) {
        await flip(c, p.out);   // the token died between the health check and this call
        return;
      }
      failedStep(err, c, p.out, "refresh");
    }
  }
}

async function checkConnection(p: Pass, c: Conn): Promise<void> {
  let refresh: string | null;
  try {
    refresh = await openToken(sql, c.org_id, c.id);
  } catch (err) {
    failedStep(err, c, p.out, "token");   // a damaged token, or a deployment without its key: reported with the connection id only
    return;
  }
  if (refresh === null) return;   // revoked since the list was read
  let at: string;
  try {
    at = await viaPort(() => p.port.accessToken(refresh), c, "token");
  } catch (err) {
    if (err instanceof BudgetSpent) {   // no slice left to start this connection: tomorrow's pass reaches it first
      p.out.deferred++;
      return;
    }
    p.out.checked++;
    if (isDeadGrantRefusal(err)) await flip(c, p.out);   // invalid_grant: the grant is dead
    else failedStep(err, c, p.out, "token");
    return;
  }
  p.out.checked++;
  try {
    if (await checkHealth(p, at, c)) await refreshVideos(p, at, c);
  } catch (err) {
    if (!(err instanceof BudgetSpent)) throw err;
    p.out.deferred++;   // the slice ran out between two of its calls: its health is stamped, so what is left (the rest of the refresh) waits for its next turn
  }
}

// ─── leg 2b: videos the pass can no longer refresh ───────────────────────────────────────────────────────────────────────────────────

/** The ceiling's backstop for a `complete` row (DP III.E.4; PO ruling, no carve-outs): once it has gone `YOUTUBE_DATA_CEILING_DAYS`
 *  without a confirmation it is deleted - and the link that pointed at its video cleared - whatever the state of its connection, so long
 *  as it is not revoked (a revoked one is the purge's). A DEAD grant cannot be refreshed (YouTube cannot be asked) and its purge only comes
 *  `YOUTUBE_DEAD_GRANT_PURGE_DAYS` after it died: a row last confirmed on the day the grant died would otherwise sit until ~day 55 (25 + 30).
 *  A CONNECTED channel whose refresh did not complete (a token that will not open, a refusal from YouTube, a budget that never reached it)
 *  would otherwise keep the row for ever. Reads no token and calls nobody. Under the connection's lock, re-checked: a connection revoked
 *  after the list is the purge's (the stranded leg takes what is left); a reconnect that lands after it changes nothing, the row being past
 *  the ceiling either way. The public pages that listed the part are expired after the commit. */
async function deleteLapsedVideos(p: Pass, c: { id: string; org_id: string }): Promise<void> {
  const cutoff = daysBefore(p.now, YOUTUBE_DATA_CEILING_DAYS);
  const gone = await sql.begin(async (tx) => {
    const [row] = await tx<{ status: string }[]>`
      select status from org_youtube_connections where id = ${c.id} and org_id = ${c.org_id} for update`;
    if (!row || row.status === "revoked") return null;
    const rows = await tx<StoredBroadcast[]>`
      select id, fixture_id, yt_broadcast_id from youtube_broadcasts
       where connection_id = ${c.id} and org_id = ${c.org_id} and state = 'complete' and refreshed_at < ${cutoff}
       order by id for update`;
    return deleteBroadcasts(tx, c.org_id, rows, p.hooks);
  });
  if (gone === null) return;
  p.out.removed += gone.deleted;
  expirePages(gone.divisions);
}

// ─── leg 2c: pooled stream keys ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Delete these pooled keys' rows (the sealed ingest URL and key are YouTube API data: DP III.E.4), in the caller's transaction. A finished
 *  broadcast (`complete` / `failed`) forgets the key first - its FK names the key with no action, and a finished broadcast never streams
 *  again - while a key an OPEN broadcast still names is left (`ending` holds its key until the end step is done). Returns the YouTube
 *  liveStream ids of the rows it deleted. */
async function deleteKeyRows(tx: Tx, orgId: string, connectionId: string, keyIds: readonly string[]): Promise<string[]> {
  if (keyIds.length === 0) return [];
  await tx`
    update youtube_broadcasts set key_id = null
     where key_id = any(${[...keyIds]}::uuid[]) and org_id = ${orgId} and state in ('complete', 'failed')`;
  const gone = await tx<{ live_stream_id: string }[]>`
    delete from youtube_stream_keys k
     where k.id = any(${[...keyIds]}::uuid[]) and k.org_id = ${orgId} and k.connection_id = ${connectionId}
       and not exists (select 1 from youtube_broadcasts b where b.key_id = k.id)
    returning k.live_stream_id`;
  return gone.map((g) => g.live_stream_id);
}

/** A RETIRED key (its liveStream is gone at YouTube: prepare.ts `retireKey`) is of no use to anyone and still holds a sealed ingest key:
 *  it is deleted on the next pass - unless an open broadcast still names it, when it waits for that broadcast to finish. */
async function deleteRetiredKeys(p: Pass, c: { id: string; org_id: string }): Promise<void> {
  const gone = await sql.begin(async (tx) => {
    if (!(await lockConnectionShared(tx, c.org_id, c.id))) return [];
    const keys = await tx<{ id: string }[]>`
      select id from youtube_stream_keys where connection_id = ${c.id} and org_id = ${c.org_id} and retired_at is not null order by id`;
    return deleteKeyRows(tx, c.org_id, c.id, keys.map((k) => k.id));
  });
  p.out.keysRemoved += gone.length;
}

/** An IDLE key (PO ruling, B6 batch review I1c; round 2: no carve-outs): nothing refreshes a live pooled key's stored ingest key, so one
 *  that nothing has used for the whole ceiling goes too - the key itself is older than the ceiling, no broadcast of it is open, and none
 *  was made in the last ceiling's worth of days. "No broadcast of it is open" is `deleteKeyRows`' own guard (a key an open broadcast names
 *  is never deleted, however old that broadcast), so the query below does not say it a second time. Its finished broadcasts forget it; the
 *  pool simply regrows on the next Go live (one `liveStreams.insert`).
 *  For EVERY non-revoked connection (a revoked one is the purge's), and the ROW's delete reads no token and spends no budget: a dead grant
 *  and a connected channel whose token will not open are under the ceiling like any other.
 *  Judged INSIDE the transaction that holds the connection `for share`: Go live's pick takes it `for update`, so a key it is choosing
 *  right now is either already named by a fresh broadcast (not idle) or picked after this commit (and finds one fewer key). Afterwards,
 *  BEST EFFORT and outside every transaction, the liveStream is deleted at YouTube - only where a token opens and the slice has room: a
 *  dead grant or a damaged token is silent (nothing to ask with), a refusal of the delete is reported by its code only. The row is gone
 *  either way; an unused liveStream left in the club's Studio costs nothing but a slot there. */
async function deleteIdleKeys(p: Pass, c: { id: string; org_id: string }): Promise<void> {
  const idleSince = daysBefore(p.now, YOUTUBE_DATA_CEILING_DAYS);
  await p.hooks.beforeIdleKeys?.();
  const streams = await sql.begin(async (tx) => {
    if (!(await lockConnectionShared(tx, c.org_id, c.id))) return [];
    const idle = await tx<{ id: string }[]>`
      select k.id from youtube_stream_keys k
       where k.connection_id = ${c.id} and k.org_id = ${c.org_id} and k.retired_at is null and k.created_at < ${idleSince}
         and not exists (select 1 from youtube_broadcasts b where b.key_id = k.id and b.created_at >= ${idleSince})
       order by k.id`;
    return deleteKeyRows(tx, c.org_id, c.id, idle.map((k) => k.id));
  });
  p.out.keysRemoved += streams.length;
  if (streams.length > 0) await deleteStreamsAtYouTube(p, c, streams);
}

/** The YouTube half of an idle key's delete: best effort, silent when there is nothing to ask with (no token that opens, a grant Google
 *  refuses, a slice with no room: the gated port throws `BudgetSpent` before calling). One access token for the connection's streams. */
async function deleteStreamsAtYouTube(p: Pass, c: { id: string; org_id: string }, streams: readonly string[]): Promise<void> {
  let at: string;
  try {
    const refresh = await openToken(sql, c.org_id, c.id);
    if (refresh === null) return;
    at = await viaPort(() => p.port.accessToken(refresh), c, "idle_token");
  } catch (err) {
    // A damaged token is the connection leg's to report, a dead grant is expected, a slice spent is silent; anything else is ours.
    if (!(err instanceof YoutubeTokenUnreadableError) && !(err instanceof YouTubeError) && !(err instanceof BudgetSpent)) {
      captureError(err, { orgId: c.org_id, route: "youtube.daily.idle_token", extra: { connectionId: c.id } });
    }
    return;
  }
  for (const streamId of streams) {
    try {
      await viaPort(() => p.port.deleteStream(at, streamId), c, "idle_stream");
    } catch (err) {
      // A slice spent (`BudgetSpent`, not a YouTubeError) is silent here, and the gate refuses the streams after it too. A stream already
      // gone resolves (port.ts), so a refusal is a real one: reported by its CODE (never a body, id or key).
      if (err instanceof YouTubeError) {
        captureError(new Error(`youtube daily: deleting an idle stream was refused (${err.code})`), {
          orgId: c.org_id, route: "youtube.daily.idle_stream", extra: { connectionId: c.id },
        });
      }
    }
  }
}

// ─── leg 3: stuck broadcasts ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Carries a and b. A broadcast the end step can never settle holds its pooled key (and the fixture's one open slot) for good, and nothing
 *  would tell anyone: a port refusal is not reported by the step. Stuck = `YOUTUBE_END_STUCK_AFTER_ATTEMPTS` failures, or `ending` for longer
 *  than `YOUTUBE_END_STUCK_AFTER_MINUTES` (a claim deferred on every firing counts no attempt), on a CONNECTED connection (see the header).
 *  Each is reported (ids and codes only), counted `failed`, and finalized `failed` / `end_stuck` so its key frees - unless a session on it
 *  is active, when the key is in use and the row is only reported. Its `stream_url` rules are unchanged: a failed row writes no link. */
async function settleStuck(p: Pass): Promise<void> {
  const byAge = new Date(p.now.getTime() - YOUTUBE_END_STUCK_AFTER_MINUTES * MINUTE_MS);
  const stuck = await sql<{ id: string; org_id: string; connection_id: string; state: string; attempts: number; last_error_code: string | null }[]>`
    select b.id, b.org_id, b.connection_id, b.state, b.attempts, b.last_error_code
      from youtube_broadcasts b
      join org_youtube_connections c on c.id = b.connection_id and c.org_id = b.org_id
     where b.state in ${sql([...OPEN_STATES])} and c.status = 'connected'
       and (b.attempts >= ${YOUTUBE_END_STUCK_AFTER_ATTEMPTS} or (b.state = 'ending' and b.claimed_at < ${byAge}))
       ${p.orgIds ? sql`and b.org_id in ${sql(p.orgIds)}` : sql``}
     order by b.created_at, b.id`;
  await p.hooks.afterStuckListed?.();
  for (const b of stuck) {
    p.out.failed++;
    captureError(new Error("youtube daily: a broadcast cannot be ended"), {
      orgId: b.org_id, route: "youtube.daily.stuck_broadcast",
      extra: { broadcastId: b.id, connectionId: b.connection_id, state: b.state, attempts: b.attempts, lastErrorCode: b.last_error_code },
    });
    try {
      // Not under a claim in flight: the end step leases a row it is calling YouTube for (next_attempt_at = claim + CLAIM_LEASE_MINUTES),
      // and finalizing under that call would let a `complete` that is about to succeed be overwritten by `failed`. The window is only
      // the lease's own length - a row failing for good sits in the hourly backoff, far beyond it, and must stay finalizable. It is
      // read on the DATABASE's clock, here at the finalize, never on `p.now`: a lease is written at claim time, which can be long after
      // the pass began (`p.now` is its start instant), and a window anchored on the start would call a lease taken since then "far
      // beyond" it and finalize under the call (the same reason last_health_at is stamped by the database).
      await sql`
        update youtube_broadcasts b
           set state = 'failed', last_error_code = ${CODE_STUCK}, completed_at = ${p.now}, reserved_until = null, next_attempt_at = null
         where b.id = ${b.id} and b.org_id = ${b.org_id} and b.state in ${sql([...OPEN_STATES])}
           and (b.next_attempt_at is null or b.next_attempt_at <= now()
                or b.next_attempt_at > now() + (${CLAIM_LEASE_MINUTES}::float8 * interval '1 minute'))
           and not exists (select 1 from fixture_stream_sessions s
                            where s.youtube_broadcast_id = b.id and s.state in ${sql([...ACTIVE_STATES])})`;
    } catch (err) {
      captureError(err, { orgId: b.org_id, route: "youtube.daily.stuck_finalize", extra: { broadcastId: b.id } });
    }
  }
}

// ─── legs 4 and 5: purge ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One dead connection, in ONE transaction: re-check it under its lock (a reconnect since the list was read moves status_since and wins),
 *  read what the Google revoke will need, revoke it through token-store (token cleared, status revoked, channel scrubbed, destination
 *  archived - one statement), then purge.
 *
 *  AFTER the commit, best effort, the grant is revoked AT GOOGLE with the in-memory token (DP III.E.4: a purged connection's access must go
 *  too). Not every flip is a dead grant - a channel missing from the grant's list, or a 401 on a call that is not the live one, leave a
 *  token Google still honours - and a token that is dead answers `invalid_token`, which `revoke` resolves. Skipped for a grant another
 *  connection's account shares (see `accountIsShared`), and when the token cannot be opened (damaged, or no key: reported, ids only - the
 *  purge itself never waits on a token). A refusal is reported by its code; the purge stands.
 *
 *  The revoke is made outside the connection slice, and inside its OWN allowance (`YOUTUBE_DAILY_REVOKE_BUDGET_MS`), decided in the
 *  transaction, before anything is written: a purge that needs a revoke when the allowance has no room commits nothing and returns
 *  `"deferred"` - the connection stays `reconnect_needed`, whole, with its token, and the next pass (oldest dead first) takes it. A purge
 *  with nothing to revoke is not held back. */
async function purgeDeadGrant(p: Pass, c: { id: string; org_id: string }): Promise<void> {
  const cutoff = daysBefore(p.now, YOUTUBE_DEAD_GRANT_PURGE_DAYS);
  const purged = await sql.begin(async (tx) => {
    const [row] = await tx<{ status: string; status_since: Date; google_sub: string | null }[]>`
      select status, status_since, google_sub from org_youtube_connections where id = ${c.id} and org_id = ${c.org_id} for update`;
    if (!row || row.status !== "reconnect_needed" || row.status_since.getTime() >= cutoff.getTime()) return null;
    let token: string | null = null;
    try {
      token = await openToken(tx, c.org_id, c.id);
    } catch (err) {
      if (!(err instanceof YoutubeTokenUnreadableError)) captureError(err, { orgId: c.org_id, route: "youtube.daily.purge_token", extra: { connectionId: c.id } });
    }
    const shared = await accountIsShared(tx, c.id, row.google_sub);
    if (token !== null && !shared && !p.revokeRoom()) return "deferred" as const;   // nothing written yet: the next pass takes it whole
    if (!(await revokeConnection(tx, c.org_id, c.id))) return null;
    return { data: await purgeConnectionData(tx, c.id, p.hooks), token, shared };
  });
  if (purged === null) return;
  if (purged === "deferred") {
    p.out.deferred++;
    return;
  }
  p.out.purged++;
  expirePages(purged.data.divisions);
  if (purged.token !== null && !purged.shared) await revokeAtGoogle(p, c, purged.token);
}

/** The Google revoke of a purged dead grant: best effort, its refusal reported by CODE only (a token, an id and a body never are). */
async function revokeAtGoogle(p: Pass, c: { id: string; org_id: string }, token: string): Promise<void> {
  try {
    await viaPort(() => p.port.revoke(token), c, "revoke");
  } catch (err) {
    if (err instanceof YouTubeError) {
      captureError(new Error(`youtube daily: the Google revoke of a purged grant was refused (${err.code})`), {
        orgId: c.org_id, route: "youtube.daily.revoke", extra: { connectionId: c.id },
      });
    }
  }
}

/** A revoked connection that still holds anything the purge removes, purged now (carry c). Idempotent: a clean one is never listed. */
async function purgeStranded(p: Pass, c: { id: string; org_id: string }): Promise<void> {
  const purged = await sql.begin((tx) => purgeConnectionData(tx, c.id, p.hooks));
  p.out.purged++;
  expirePages(purged.divisions);
}

/** Run one leg: a fault in it is counted and reported (ours: ids only), and never skips the legs after it. */
async function leg(p: Pass, name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    p.out.failed++;
    captureError(err, { route: `youtube.daily.${name}` });
  }
}

/** Run `each` for every row of `rows`, a fault on one counted and reported without stopping the others. */
async function eachOf<T extends { id: string; org_id: string }>(p: Pass, name: string, rows: readonly T[], each: (r: T) => Promise<void>): Promise<void> {
  for (const r of rows) {
    try {
      await each(r);
    } catch (err) {
      p.out.failed++;
      captureError(err, { orgId: r.org_id, route: `youtube.daily.${name}`, extra: { connectionId: r.id } });
    }
  }
}

/** The daily YouTube pass. `orgIds` (test-only) scopes every leg to those organisations; an empty list is refused - `org_id in ()` read as
 *  "no filter" would health-check, refresh and PURGE every organisation. `budgetMs` (default `YOUTUBE_DAILY_BUDGET_MS`) bounds the YouTube
 *  calls of the connection leg, `revokeBudgetMs` (default `YOUTUBE_DAILY_REVOKE_BUDGET_MS`) the dead grants' Google revokes, and
 *  `wallClock` (test-only: scripts the clock) is what both read. Never throws for a fault in one connection or one leg. */
export async function youtubeDaily(
  port: YouTubePort, now: Date,
  o: { orgIds?: readonly string[]; hooks?: DailyHooks; budgetMs?: number; revokeBudgetMs?: number; wallClock?: () => number } = {},
): Promise<YoutubeDailyResult> {
  const orgIds = o.orgIds === undefined ? undefined : [...o.orgIds];
  if (orgIds !== undefined && orgIds.length === 0) {
    throw new Error("youtube daily: orgIds is empty - omit it to cover every organisation, or name at least one");
  }
  const hooks = o.hooks ?? {};
  const wallClock = o.wallClock ?? Date.now;
  const started = wallClock();
  const budgetMs = o.budgetMs ?? YOUTUBE_DAILY_BUDGET_MS;
  /** Time left in the slice: the ONE rule for starting each of the connection leg's YouTube calls. */
  const room = () => wallClock() - started < budgetMs;
  /** Time left in the revoke allowance, counted from the first purge that needs a revoke (the database work before it is not the allowance's). */
  const revokeBudgetMs = o.revokeBudgetMs ?? YOUTUBE_DAILY_REVOKE_BUDGET_MS;
  let revokeStarted: number | null = null;
  const revokeRoom = () => {
    revokeStarted ??= wallClock();
    return wallClock() - revokeStarted < revokeBudgetMs;
  };
  const p: Pass = { port: gated(port, room), now, orgIds, out: zero(), hooks, revokeRoom };
  const inOrgs = (column: string) => (orgIds ? sql`and ${sql(column)} in ${sql(orgIds)}` : sql``);

  // 1. Expired pending grants: the sealed token and the picker's channel titles go with them.
  await leg(p, "pending", async () => {
    await sql`delete from youtube_connect_pending where expires_at < ${now} ${inOrgs("org_id")}`;
  });

  // 2. Health and refresh, per connected channel (the least-recently checked first, so a pass cut short by its budget - the gated port
  //    refuses to start a call past it, the connection it cut is counted `deferred` - reaches the ones it never started tomorrow).
  await leg(p, "connections", async () => {
    const connected = await sql<Conn[]>`
      select id, org_id, channel_id, channel_title from org_youtube_connections
       where status = 'connected' ${inOrgs("org_id")}
       order by last_health_at nulls first, id`;
    await hooks.afterConnectionsListed?.();
    await eachOf(p, "connection", connected, (c) => checkConnection(p, c));
  });

  // 2b. `complete` rows past the ceiling of ANY non-revoked connection: the refresh above could not reach or confirm them, and the
  //     dead-grant purge below comes too late for a dead grant's. Reads no token, spends no budget.
  await leg(p, "lapsed", async () => {
    const lapsed = await sql<{ id: string; org_id: string }[]>`
      select distinct c.id, c.org_id from org_youtube_connections c
        join youtube_broadcasts b on b.connection_id = c.id and b.org_id = c.org_id
       where c.status <> 'revoked' and b.state = 'complete' and b.refreshed_at < ${daysBefore(now, YOUTUBE_DATA_CEILING_DAYS)} ${inOrgs("c.org_id")}
       order by c.id`;
    await hooks.afterLapsedListed?.();
    await eachOf(p, "lapsed_videos", lapsed, (c) => deleteLapsedVideos(p, c));
  });

  // 2c. Retired pooled keys.
  await leg(p, "retired_keys", async () => {
    const holders = await sql<{ id: string; org_id: string }[]>`
      select distinct k.connection_id as id, k.org_id from youtube_stream_keys k
       where k.retired_at is not null ${inOrgs("k.org_id")}
       order by 1`;
    await eachOf(p, "retired_keys_delete", holders, (c) => deleteRetiredKeys(p, c));
  });

  // 2d. Idle pooled keys of ANY non-revoked connection: the row at once, the liveStream at YouTube best effort.
  await leg(p, "idle_keys", async () => {
    const holders = await sql<{ id: string; org_id: string }[]>`
      select distinct k.connection_id as id, k.org_id from youtube_stream_keys k
        join org_youtube_connections c on c.id = k.connection_id and c.org_id = k.org_id
       where c.status <> 'revoked' and k.retired_at is null and k.created_at < ${daysBefore(now, YOUTUBE_DATA_CEILING_DAYS)} ${inOrgs("k.org_id")}
       order by 1`;
    await eachOf(p, "idle_keys_delete", holders, (c) => deleteIdleKeys(p, c));
  });

  // 3. Stuck broadcasts.
  await leg(p, "stuck", () => settleStuck(p));

  // 4. Dead grants, 30 days.
  await leg(p, "dead_grants", async () => {
    const dead = await sql<{ id: string; org_id: string }[]>`
      select id, org_id from org_youtube_connections
       where status = 'reconnect_needed' and status_since < ${daysBefore(now, YOUTUBE_DEAD_GRANT_PURGE_DAYS)} ${inOrgs("org_id")}
       order by status_since, id`;
    await hooks.afterDeadGrantsListed?.();
    await eachOf(p, "purge", dead, (c) => purgeDeadGrant(p, c));
  });

  // 5. Revoked connections that still hold something.
  await leg(p, "stranded", async () => {
    const left = await sql<{ id: string; org_id: string }[]>`
      select c.id, c.org_id from org_youtube_connections c
       where c.status = 'revoked' ${inOrgs("c.org_id")}
         and (exists (select 1 from youtube_broadcasts b where b.connection_id = c.id)
           or exists (select 1 from youtube_stream_keys k where k.connection_id = c.id)
           or c.google_sub is not null
           or exists (select 1 from org_stream_targets t where t.youtube_connection_id = c.id and t.watch_url is not null)
           or exists (select 1 from youtube_connect_pending g where g.connection_id = c.id))
       order by c.id`;
    await eachOf(p, "stranded_purge", left, (c) => purgeStranded(p, c));
  });

  // 6. Failed broadcast rows past their retention. This statement holds no connection lock, so it takes its rows `skip locked`: a
  //    disconnect's purge locks its connection and then ALL the connection's rows in id order, and a delete that waited for one of them
  //    while holding another could deadlock with it. A row left behind is the purge's (or tomorrow's).
  await leg(p, "failed_rows", async () => {
    const old = await sql<{ id: string }[]>`
      delete from youtube_broadcasts
       where id in (select id from youtube_broadcasts
                     where state = 'failed' and coalesce(completed_at, created_at) < ${daysBefore(now, YOUTUBE_FAILED_ROW_RETENTION_DAYS)} ${inOrgs("org_id")}
                       for update skip locked)
      returning id`;
    p.out.removed += old.length;
  });

  return p.out;
}
