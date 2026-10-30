import "server-only";
// server/youtube/disconnect.ts — YouTube Connect T18: the organiser's DISCONNECT of a connected channel (spec §6.8, §9.2; plan T18 with
// the controller's overrides O2 and O-T17a/b/c; the Google API Services User Data Policy, DP III.E.4: revoke, and delete what Seazn
// stored FROM YouTube, at once).
//
// ONE TRANSACTION decides and changes everything of ours; the YouTube calls come AFTER it commits, with the token held in memory only:
//   1. LOCK the connection `for update` (org-scoped; a missing, another org's or an already revoked one is one 404, so a foreign id is
//      no oracle), then its broadcast rows `for update` (the connection-then-broadcast order T8's reconnect and the purge use).
//   2. GUARD (the §9.3 mutation target). A broadcast in `reserved`, `bound` or `live` whose end is NOT yet due (end-rule.ts: null while a
//      session is active, a reservation is unlapsed or nothing has streamed yet; later than now inside the grace after a Stop) is a match
//      using the channel: 409 YOUTUBE_IN_USE and nothing is written. A broadcast whose facts BREAK the rule's invariant (end-rule.ts
//      refuses to answer from them) is 409 YOUTUBE_END_UNKNOWN, reported with ids only - never a raw 500. R9: an `ending` row (claimed, or left by a dead grant), a due row
//      and a `created` one do not block - they are purged. A row that is stuck `bound` with nothing streaming (an orphan) blocks until
//      the end step's 10-minute orphan sweep removes it (ledger: accepted).
//   3. Read what must be undone AT YOUTUBE (the open broadcasts' ids, the live pooled keys' stream ids) and the refresh token into memory.
//      A token that will not open (a damaged envelope) never makes a channel undeletable: it is simply not usable.
//   4. `revokeConnection` FIRST (token-store's ONE statement: token null, `revoked`, `revoked_at`, channel scrubbed, the destination row
//      archived under the fixed label - NOT archived a second time here), then `purgeConnectionData` (T17's: broadcast rows and the
//      stream links that pointed at their videos, the pooled keys, the archived row's watch link, the Google account id, any pending
//      grant). The purge refuses a connection that is not revoked, which is why the order is not free.
//   5. Commit, then expire the public pages of the divisions whose fixtures lost a link (a revalidation inside the open transaction
//      would race the commit - O-T17a).
//
// THEN, with NO lock held (global-constraints), best effort, each step in its own try, within a wall-clock budget:
//   - an access token from the in-memory refresh token (a dead grant ends here: nothing can be asked of YouTube, and that is not a report);
//   - each open broadcast: `live`/`testing` -> complete, `created`/`ready` -> delete (a video is never left live with no picture); one
//     already complete, revoked or absent needs nothing;
//   - each live pooled key's stream -> deleteStream; one that fails (anything but not-found, which the driver already resolves: e.g.
//     YouTube's 403 `liveStreamDeletionNotAllowed` while a broadcast still holds the key, or a timeout) is tried ONCE more, after the
//     open broadcast that held it reads finished (`broadcastLife`: complete, revoked or absent - a few reads, a short wait between);
//   - the channel's OWN streams are read (`listStreams`: ids and titles, never a key; the budget is asked before every page, and a
//     listing it cuts short is unread - keysLeft null - never a partial list) and every one Seazn named (pooled-key-title.ts) on
//     THIS channel is deleted - a key no row of ours records (an orphan: made at YouTube, lost before it was pooled) included. A stream
//     Seazn did not name is never touched (stg 2026-10-30: Disconnect said "deleted" while Studio still listed a Seazn key);
//   - the Google revoke - AFTER the above (revoking kills the access tokens they use) - unless another NON-revoked connection reports the
//     same non-null Google account (T6-R2 as amended: V479's one-live-channel index is GLOBAL, so a shared CHANNEL cannot happen; a
//     shared ACCOUNT can - one person administering two clubs - and revoking its grant would drop that club's connection). The skip is
//     recorded on the revoked row as the code `revoke_skipped_shared_grant`. "Shared" is decided INSIDE the transaction, under the
//     account's advisory lock (`accountIsShared`): two clubs on one account leaving at the same moment cannot both read the other as
//     still running on it, so exactly one of them makes the revoke.
// A YouTube failure never undoes or blocks the purge (it is already committed): the answer says what did not happen
// (`revokeOutcome`: `not_confirmed`; `keysLeft`: the Seazn keys still on the channel, or null when the channel could not be read - no
// usable token, a dead grant, the listing refused, the budget spent before it), and the report carries a CODE or a class name, never a body.
//
// SECRETS. The token lives in one local variable. A port refusal is a code (port.ts); anything else is reported as a fresh error naming
// only its class (its message may hold a token). No token, key, ingest URL or Google body reaches a log line, a report, an error or a row.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { captureError } from "@/lib/sentry";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { YoutubeDisconnected } from "@/server/api-v1/schemas";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { accountIsShared, purgeConnectionData } from "./daily";
import { EndRuleInvariantError, broadcastEndDueAt, readEndFacts } from "./end-rule";
import { OPEN_STATES } from "./end-step";
import { isPooledKeyTitle } from "./pooled-key-title";
import { LIST_BUDGET_SPENT, YouTubeError, isDeadGrantRefusal, type YouTubePort } from "./port";
import { YoutubeTokenUnreadableError, openToken, revokeConnection } from "./token-store";

/** The machine code of the refusal while a match is using the channel (the Streaming page maps it to its own sentence). */
export const YOUTUBE_IN_USE = "YOUTUBE_IN_USE";
/** What the refusal says in English API prose; the page never renders it (it maps the code). */
export const YOUTUBE_IN_USE_MESSAGE = "A match is using this channel";
/** The machine code of the refusal when the end rule cannot say whether a match is still using the channel (a broken fact it refuses to
 *  answer from: end-rule.ts `EndRuleInvariantError`). Nothing was written; the break is reported. */
export const YOUTUBE_END_UNKNOWN = "YOUTUBE_END_UNKNOWN";
/** What it says in English API prose; the page maps the code to its own sentence. */
export const YOUTUBE_END_UNKNOWN_MESSAGE = "Seazn could not tell whether a match is using this channel";
/** The code recorded on the revoked connection when the Google revoke was skipped because another connection runs on the same account. */
export const REVOKE_SKIPPED_SHARED_GRANT = "revoke_skipped_shared_grant";

/** The states whose end can be NOT yet due. `ending` is a claimed row (the end step or a dead grant has it: R9), `created` has no stream
 *  yet, and `complete` / `failed` are finished. */
const BLOCKING_STATES = ["reserved", "bound", "live"] as const;

/** How long the YouTube clean-up may keep starting calls. A call is bounded by the driver's own timeout (port.ts), so a clean-up that
 *  YouTube answers slowly would otherwise outlast the request; past this the rest is left (reported) and the Google revoke is still made. */
export const YOUTUBE_DISCONNECT_BUDGET_MS = 30_000;

/** Before a refused key delete is tried again, the broadcast that held the key is read at most this many times, waiting this long between
 *  two reads, until YouTube says it is finished: a complete broadcast lets its stream go. Each read is one call under the budget. */
export const KEY_RETRY_LIFE_READS = 3;
export const KEY_RETRY_WAIT_MS = 2_000;

const notFound = () => new HttpError(404, "youtube connection not found");

type Ctx = { orgId: string; connectionId: string };

/** A port call. A refusal is a code (port.ts) and its absence is the whole report: `{ ok: false }`. Anything else a driver throws is
 *  YouTube not answering - reported as a FRESH error that names only the original's class (its message may hold a token). A dead grant
 *  is an expected state, not a report. */
async function attempt<T>(call: () => Promise<T>, c: Ctx, step: string): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await call() };
  } catch (err) {
    if (err instanceof YouTubeError) {
      // a listing cut short by OUR budget is not YouTube refusing: the caller counts it in the one budget report instead
      if (!isDeadGrantRefusal(err) && err.reason !== LIST_BUDGET_SPENT) {
        captureError(new Error(`youtube disconnect: ${step} was refused (${err.code})`), { orgId: c.orgId, route: "youtube.disconnect.port", extra: { connectionId: c.connectionId, step } });
      }
    } else {
      const kind = (err instanceof Error ? err.name : typeof err).replace(/[^A-Za-z]/g, "").slice(0, 64);
      captureError(new Error(`youtube disconnect: ${step} raised a non-port error (${kind})`), {
        orgId: c.orgId, route: "youtube.disconnect.port", extra: { connectionId: c.connectionId, step },
      });
    }
    return { ok: false };
  }
}

/** A broadcast YouTube is done with: its stream (the key) can be deleted. */
const FINISHED_LIVES = new Set(["complete", "revoked", "absent"]);

/** A pooled key as the clean-up needs it: its stream at YouTube, and the open broadcasts (video ids) bound to it. */
type PooledKey = { streamId: string; heldBy: string[] };

/** Wind one open broadcast down at YouTube: a live one is completed, one that never went live is deleted. */
async function windDown(port: YouTubePort, at: string, ytId: string, c: Ctx): Promise<void> {
  const life = await attempt(() => port.broadcastLife(at, ytId), c, "broadcastLife");
  if (!life.ok) return;
  switch (life.value.life) {
    case "live":
    case "testing":
      await attempt(() => port.complete(at, ytId), c, "complete");
      return;
    case "created":
    case "ready":
      await attempt(() => port.deleteBroadcast(at, ytId), c, "deleteBroadcast");
      return;
    case "complete":
    case "revoked":
    case "absent":
      return;   // finished, removed by YouTube, or never there: nothing to ask
  }
}

/** Wait until every broadcast that held a key reads finished at YouTube - or the reads, the budget or YouTube run out. Best effort: the
 *  delete is retried either way (YouTube decides; the answer counts what it refused). */
async function waitUntilFinished(port: YouTubePort, at: string, ytIds: string[], c: Ctx, room: () => boolean, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (const ytId of ytIds) {
    for (let read = 1; read <= KEY_RETRY_LIFE_READS && room(); read++) {
      const life = await attempt(() => port.broadcastLife(at, ytId), c, "broadcastLife");
      if (!life.ok || FINISHED_LIVES.has(life.value.life)) break;
      if (read < KEY_RETRY_LIFE_READS) await sleep(KEY_RETRY_WAIT_MS);
    }
  }
}

/** The clean-up of the channel's keys, with a usable access token. Every pooled key is deleted, a failed one retried once; then the channel's
 *  own streams are read and every Seazn-named one on THIS channel deleted. `left` is the Seazn keys the listing still shows that could not be
 *  deleted (a failed pooled key counts whatever its title: it is ours), or null when the listing could not be read. */
async function deleteKeys(
  port: YouTubePort, at: string, keys: PooledKey[], channelId: string | null, c: Ctx, room: () => boolean, sleep: (ms: number) => Promise<void>,
): Promise<{ deleted: number; left: number | null; skipped: number }> {
  const deleted = new Set<string>();
  const failed: PooledKey[] = [];
  let skipped = 0;
  for (const k of keys) {
    if (!room()) { skipped++; continue; }
    if ((await attempt(() => port.deleteStream(at, k.streamId), c, "deleteStream")).ok) deleted.add(k.streamId);
    else failed.push(k);
  }
  const refused = new Set<string>();
  for (const k of failed) {
    if (!room()) { skipped++; refused.add(k.streamId); continue; }
    await waitUntilFinished(port, at, k.heldBy, c, room, sleep);
    if (!room()) { skipped++; refused.add(k.streamId); continue; }
    if ((await attempt(() => port.deleteStream(at, k.streamId), c, "deleteStream.retry")).ok) deleted.add(k.streamId);
    else refused.add(k.streamId);
  }

  if (!room()) return { deleted: deleted.size, left: null, skipped: skipped + 1 };
  // `room` is asked before EVERY page: a listing the budget cut short is unread (null), never a partial list deleted from as the whole
  const listed = await attempt(() => port.listStreams(at, { room }), c, "listStreams");
  if (!listed.ok) return { deleted: deleted.size, left: null, skipped: room() ? skipped : skipped + 1 };
  let left = 0;
  for (const s of listed.value) {
    if (deleted.has(s.id)) continue;                        // gone already (a listing that lags the delete)
    if (refused.has(s.id)) { left++; continue; }            // a pooled key YouTube refused twice: still there, never a third try
    // Only a Seazn name, on the channel being disconnected: a club's own key, or another channel's, is never touched.
    if (!isPooledKeyTitle(s.title) || channelId === null || s.channelId !== channelId) continue;
    if (!room()) { skipped++; left++; continue; }
    if ((await attempt(() => port.deleteStream(at, s.id), c, "deleteStream.sweep")).ok) deleted.add(s.id);
    else left++;
  }
  return { deleted: deleted.size, left, skipped };
}

/** Test-only seam (daily.ts's `DailyHooks` precedent): runs in the window between reading "is the account shared?" and the write that
 *  acts on it, the only place a concurrent disconnect of the same account can land. Production passes none. */
export interface DisconnectHooks { afterSharedRead?: () => Promise<void> }

/** Disconnect a channel: revoke it, purge what Seazn stored from YouTube, archive its destination. 404 for a connection that is missing,
 *  already revoked or another organisation's; 409 YOUTUBE_IN_USE while a match is using it (nothing changed). `opts` are test seams
 *  (the end rule's clock, the clean-up's wall clock and the wait between two reads of a broadcast's life). */
export async function disconnectYoutube(
  auth: AuthCtx, orgId: string, connectionId: string, port: YouTubePort,
  opts: { now?: () => Date; wallClock?: () => number; sleep?: (ms: number) => Promise<void>; hooks?: DisconnectHooks } = {},
): Promise<YoutubeDisconnected> {
  if (auth.orgId !== orgId) throw new HttpError(404, "organization not found");

  const done = await sql.begin(async (tx) => {
    const [c] = await tx<{ status: string; google_sub: string | null; channel_id: string | null }[]>`
      select status, google_sub, channel_id from org_youtube_connections where id = ${connectionId} and org_id = ${orgId} for update`;
    if (!c || c.status === "revoked") throw notFound();

    const broadcasts = await tx<{ id: string; state: string; yt_broadcast_id: string | null; key_id: string | null }[]>`
      select id, state, yt_broadcast_id, key_id from youtube_broadcasts where connection_id = ${connectionId} and org_id = ${orgId} order by id for update`;
    const now = (opts.now ?? (() => new Date()))();
    for (const b of broadcasts) {
      if (!(BLOCKING_STATES as readonly string[]).includes(b.state)) continue;
      let due: Date | null;
      try {
        due = broadcastEndDueAt(await readEndFacts(tx, b.id), now);
      } catch (err) {
        // Only the end rule's own refusal is named; anything else is a real failure and propagates.
        if (!(err instanceof EndRuleInvariantError)) throw err;
        // The facts break an assumption the rule rests on (a Stopped session with no ended_at; a finished fixture with no finished_at),
        // so "is a match using this channel?" has no answer. Refused by NAME, never a raw 500, and reported with ids only.
        captureError(err, { orgId, route: "youtube.disconnect.end_rule", extra: { connectionId, broadcastId: b.id } });
        throw new HttpError(409, YOUTUBE_END_UNKNOWN_MESSAGE, YOUTUBE_END_UNKNOWN);
      }
      if (due === null || due.getTime() > now.getTime()) throw new HttpError(409, YOUTUBE_IN_USE_MESSAGE, YOUTUBE_IN_USE);
    }

    const open = broadcasts.filter((b) => (OPEN_STATES as readonly string[]).includes(b.state) && b.yt_broadcast_id !== null);
    const toEnd = open.map((b) => b.yt_broadcast_id as string);
    const keys: PooledKey[] = (await tx<{ id: string; live_stream_id: string }[]>`
      select id, live_stream_id from youtube_stream_keys
       where connection_id = ${connectionId} and org_id = ${orgId} and retired_at is null order by slot`)
      .map((k) => ({ streamId: k.live_stream_id, heldBy: open.filter((b) => b.key_id === k.id).map((b) => b.yt_broadcast_id as string) }));

    let token: string | null = null;
    try {
      token = await openToken(tx, orgId, connectionId);
    } catch (err) {
      // A damaged envelope is this row's fault, never a reason the club cannot disconnect; a missing KEK is the deployment's and propagates.
      if (!(err instanceof YoutubeTokenUnreadableError)) throw err;
    }

    // The account's grant is shared when another NON-revoked connection (any org) reports the same non-null Google account.
    const shared = await accountIsShared(tx, connectionId, c.google_sub);
    await opts.hooks?.afterSharedRead?.();

    if (!(await revokeConnection(tx, orgId, connectionId))) throw notFound();
    if (shared) {
      await tx`update org_youtube_connections set last_error_code = ${REVOKE_SKIPPED_SHARED_GRANT} where id = ${connectionId} and org_id = ${orgId}`;
    }
    const purged = await purgeConnectionData(tx, connectionId);
    return { token, shared, toEnd, keys, channelId: c.channel_id, purged };
  });

  // Committed: the public pages that listed a replay link or a part of this channel's are stale now.
  for (const d of done.purged.divisions) fireDivisionRevalidate(d.divisionId, d.competitionId);

  const c: Ctx = { orgId, connectionId };
  let revoked = false;
  let keysDeleted = 0;
  // Null until the channel's own streams were read: without a usable token, a live grant, a listing YouTube answered and the budget to
  // ask, nobody can say no Seazn key is left - and the organiser is told so rather than told everything went.
  let keysLeft: number | null = null;
  const token = done.token;
  if (token !== null) {
    const wallClock = opts.wallClock ?? Date.now;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const started = wallClock();
    const room = () => wallClock() - started < YOUTUBE_DISCONNECT_BUDGET_MS;
    const at = await attempt(() => port.accessToken(token), c, "accessToken");
    if (at.ok) {
      let skipped = 0;
      for (const ytId of done.toEnd) {
        if (!room()) { skipped++; continue; }
        await windDown(port, at.value, ytId, c);
      }
      const keys = await deleteKeys(port, at.value, done.keys, done.channelId, c, room, sleep);
      keysDeleted = keys.deleted;
      keysLeft = keys.left;
      skipped += keys.skipped;
      if (skipped > 0) {
        captureError(new Error(`youtube disconnect: the clean-up budget ran out with ${skipped} step(s) left`), {
          orgId, route: "youtube.disconnect.budget", extra: { connectionId, skipped },
        });
      }
    }
    // The revoke is the policy's step (DP III.E.4), so it is made past the budget and whether or not the clean-up could run (a dead
    // grant's revoke resolves, Google's `invalid_token` being the state asked for) - but never for a grant another club runs on.
    if (!done.shared) revoked = (await attempt(() => port.revoke(token), c, "revoke")).ok;
  }

  // Three outcomes, never two: a grant left alone ON PURPOSE (another club runs on the account) is not a failure the organiser must fix
  // at Google, and one that was tried and failed, or never tried for want of a usable token, is.
  const revokeOutcome: YoutubeDisconnected["revokeOutcome"] = done.shared ? "skipped_shared_account" : revoked ? "revoked" : "not_confirmed";
  return { revokeOutcome, keysDeleted, keysLeft, purged: { broadcasts: done.purged.broadcasts, streamUrlsCleared: done.purged.streamUrlsCleared } };
}
