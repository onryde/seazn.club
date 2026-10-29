import "server-only";
// server/youtube/prepare.ts — YouTube Connect T10: Go live's PREPARE step (spec §6.2 with plan P2, P3, P4, P7; rulings R2, R3,
// T10-R1; the post-T3 key-reuse amendment). Admission (T11) calls it for an API-backed destination after its own checks pass and
// before the session insert; `attachPrepared` then runs inside admission's transaction, and `abandonPrepared` undoes a prepare
// whose admission was refused.
//
//   1. The connection, reached from the destination row (`org_stream_targets.youtube_connection_id`). Not `connected` →
//      youtube_reconnect_needed, before any port call. For an AUTOMATIC start alone, a channel whose not-enabled / restricted refusal is
//      on record and still fresh (YOUTUBE_LIVE_STATE_FRESH_MINUTES) → that same refusal, before any port call (B4 fix round 1, I-2: an
//      automatic start retries every minute, and each retry would cost a YouTube call and a failed row). A human's tap — the
//      organiser's Go live, the phone operator's Start — always asks YouTube (fix round 2, F2): the club may have enabled live at YouTube
//      a minute ago, and a person is owed YouTube's current answer, not a replayed one. An access token from the sealed refresh token (in
//      memory only). A `youtube_reconnect_needed` from ANY port call (a dead grant) moves the connection to reconnect_needed first (F5).
//   2. A short transaction: the fixture's OPEN broadcast (`created|bound|live|reserved`; `ending` is never selected, so a claimed
//      row is never reused), locked `for update` (no skip). A reservation not yet lapsed is another Go live mid-admission →
//      the existing `active_session` 409. Otherwise its end rule decides (end-rule.ts, read through THIS transaction under the
//      row lock): not due (null, or later than now) → reserve it for 2 minutes and reuse it; due → claim it `ending` (P7) and
//      make a new one. An `EndRuleInvariantError` claims it too, and is reported — Go live is never refused for it (T10-R1).
//   3. A short transaction holding the connection row: pick a free key (lowest slot), insert the broadcast row `created`
//      (P4: the row exists before YouTube is asked). No free key and fewer than 10 live → the row is keyless, a liveStream is
//      inserted OUTSIDE the transaction and pooled at the lowest free slot in another; a lost slot deletes that liveStream and
//      retries the pick once (P3). Ten live and none free → youtube_channel_busy, no row written. A 23505 on the fixture's
//      one-open index (a concurrent admission's row) → step 2 again: reuse it (R3).
//   4. Outside every transaction: insert the broadcast, write its id, bind it, mark the row `bound`. Any port refusal deletes
//      at YouTube what was made, fails the row with the code, and refuses with that code. A bind answered `liveStreamNotFound`
//      (the key's liveStream deleted at YouTube) also retires that key, so the next Go live grows a fresh one (F2). A refusal that
//      is a fact about the CHANNEL (not enabled for live, restricted) is recorded on the connection, and a bind that succeeds clears
//      it (connections.ts `recordLiveState`), so the Streaming page, the panel and step 1 all read it.
//
// LOCKS (global-constraints): no row or advisory lock is held across a port call — each transaction above commits before the
// next YouTube call (the prepare tests probe every call with `for update nowait`).
//
// SECRETS: the refresh token and the access token live in local variables only; a refusal carries a CODE and the connection id,
// never a token, a key or a Google body (port.ts's YouTubeError is already code-only). The pooled key is sealed by its one
// owner, secret-columns.ts; this file never names a sealed column.
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { toLocale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import { routes } from "@/lib/routes";
import { captureError } from "@/lib/sentry";
import { siteOrigin } from "@/lib/site-origin";
import {
  YOUTUBE_MAX_LIVE_KEYS_PER_CHANNEL, isYoutubeLiveStateRefusal, isYoutubeRefusalCode, type YoutubePrivacy, type YoutubeRefusalCode,
} from "@/lib/youtube";
import type { StartCause } from "@/server/relay/domain/session";
import { insertPooledKey } from "@/server/relay/secret-columns";
import { freshLiveRefusal, recordLiveState } from "./connections";
import { EndRuleInvariantError, broadcastEndDueAt, readEndFacts, type EndFacts } from "./end-rule";
import { YouTubeError, isDeadGrantRefusal, isLiveBlockedRefusal, type YouTubePort } from "./port";
import { broadcastDescription, broadcastTitle } from "./title";
import { YoutubeTokenUnreadableError, markReconnectNeeded, openToken } from "./token-store";

export type Prepared = { broadcastId: string; reused: boolean; keyId: string };

/** The port, or a thunk for it. A caller that serves pasted destinations too passes the thunk, so the port (the process's driver,
 *  which throws on a misspelt YOUTUBE_DRIVER) is resolved only once the destination is known to be an API row (T11 fix round 1, m3). */
export type PortSource = YouTubePort | (() => YouTubePort);

/** Spec §6.2 "~2 min" (plan P6): how long a reused broadcast is held for the admission that reserved it. */
export const YOUTUBE_RESERVATION_MINUTES = 2;
/** "10 active streams allowed per channel" (support.google.com/youtube/answer/2474026, spec §3.1): lib/youtube.ts owns the number
 *  (the panel's refusal copy names it too); V479's slot check (1..10) is the database's floor under the same number. */
const MAX_LIVE_KEYS_PER_CHANNEL = YOUTUBE_MAX_LIVE_KEYS_PER_CHANNEL;
/** A pooled liveStream's title: liveStreams snippet.title is 1–128 characters. Not shown to viewers. */
const STREAM_TITLE = "Seazn stream key";

/** The fixture's open states (V479 `youtube_broadcasts_one_open_per_fixture`). `ending` is not one: a claimed row is gone. */
const OPEN_ON_FIXTURE = ["created", "bound", "reserved", "live"] as const;
/** The key's open states (V479 `youtube_broadcasts_one_open_per_key`): `ending` still holds its key. */
const OPEN_ON_KEY = ["created", "bound", "reserved", "live", "ending"] as const;
const ONE_OPEN_PER_FIXTURE = "youtube_broadcasts_one_open_per_fixture";
const ONE_LIVE_SLOT = "youtube_stream_keys_one_live_slot";

const MINUTE_MS = 60_000;
const plusMinutes = (d: Date, n: number): Date => new Date(d.getTime() + n * MINUTE_MS);

const STATUS_OF: Record<YoutubeRefusalCode, number> = {
  youtube_reconnect_needed: 409,
  youtube_live_not_enabled: 409,
  youtube_live_blocked: 409,
  youtube_limit_reached: 429,
  youtube_channel_busy: 409,
  youtube_unavailable: 503,
};

/** A refused Go live on a YouTube destination: the code (the organiser's panel renders the copy, T12) and the connection, so
 *  the panel can link its fix. The message is the operator's line; it names the code and nothing else. */
export function youtubeRefusal(code: YoutubeRefusalCode, connectionId: string): HttpError {
  return new HttpError(STATUS_OF[code], `YouTube refused Go live: ${code}`, code, { connectionId });
}

/** The existing one-session-per-fixture refusal (stream-sessions.ts `refuse`'s `active_session` shape): another Go live holds
 *  this fixture's broadcast, and no session exists yet to name. */
const activeSession = (): HttpError =>
  new HttpError(409, "a session is already running for this fixture", "active_session", { sessionId: null });

/** The refusal code a failure carries: a port error's code (a missing resource is `youtube_unavailable` — no refusal of its
 *  own), or one of this file's own refusals. Null for anything else (a database fault, a KEK fault). */
function refusalCodeOf(err: unknown): YoutubeRefusalCode | null {
  if (isLiveBlockedRefusal(err)) return "youtube_live_blocked";   // "not authorized to <live>" is the channel's, not a dead grant (T17 carry g)
  if (err instanceof YouTubeError) return err.code === "youtube_not_found" ? "youtube_unavailable" : err.code;
  if (err instanceof HttpError && isYoutubeRefusalCode(err.code)) return err.code;
  return null;
}

/** A port call. Whatever it throws becomes a YouTubeError: a driver maps Google's answers already, and anything else it lets
 *  through (it should not) is YouTube not answering. The original is dropped, never wrapped: it may hold what a refusal must not. */
async function viaPort<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof YouTubeError) throw err;
    throw new YouTubeError("youtube_unavailable");
  }
}

const isUniqueOn = (err: unknown, constraint: string): boolean => {
  const pg = err as { code?: string; constraint_name?: string };
  return pg.code === "23505" && pg.constraint_name === constraint;
};

interface Ctx {
  orgId: string; fixtureId: string; connectionId: string; privacy: YoutubePrivacy; madeForKids: boolean; now: Date;
  port: YouTubePort; at: string;
}

/** null when targetId is a pasted row. Throws HttpError with a YoutubeRefusalCode (409; youtube_limit_reached 429;
 *  youtube_unavailable 503), extra { connectionId } only — or the EXISTING active_session 409 while another admission holds an
 *  unlapsed reservation (or a session is live on the fixture's broadcast on another channel). 404 for a destination or a fixture
 *  that is not this org's, before any port call. Never holds a lock across a port call. */
export async function prepareYoutubeBroadcast(
  a: { orgId: string; fixtureId: string; targetId: string; now: Date; startCause: StartCause }, portOf: PortSource,
): Promise<Prepared | null> {
  const [target] = await sql<{
    connection_id: string | null; status: string | null; privacy: YoutubePrivacy | null; made_for_kids: boolean | null;
    last_health_at: Date | null; last_error_code: string | null; status_since: Date | null;
  }[]>`
    select t.youtube_connection_id as connection_id, c.status, c.default_privacy as privacy, c.made_for_kids,
           c.last_health_at, c.last_error_code, c.status_since
      from org_stream_targets t
      left join org_youtube_connections c on c.id = t.youtube_connection_id and c.org_id = t.org_id
     where t.id = ${a.targetId} and t.org_id = ${a.orgId} and t.archived_at is null`;
  if (!target) throw new HttpError(404, "stream target not found");
  if (target.connection_id === null) return null;
  const connectionId = target.connection_id;
  const [fixture] = await sql<{ id: string }[]>`
    select f.id from fixtures f
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
     where f.id = ${a.fixtureId} and c.org_id = ${a.orgId}`;
  if (!fixture) throw new HttpError(404, "fixture not found");
  if (target.status !== "connected" || target.privacy === null || target.made_for_kids === null) {
    throw youtubeRefusal("youtube_reconnect_needed", connectionId);
  }
  // B4 fix round 1, I-2: the channel was refused for its live state a moment ago — say so again without asking YouTube. Writes nothing:
  // a refusal that renewed its own stamp would never let the window lapse. Fix round 2, F2: for the AUTOMATIC start only — its retries are
  // what the record spares; an organiser's or an operator's tap asks YouTube every time, and a success clears the record (`noteLiveState`).
  const recorded = a.startCause === "automatic" ? freshLiveRefusal(target, a.now) : null;
  if (recorded !== null) throw youtubeRefusal(recorded, connectionId);

  const port = typeof portOf === "function" ? portOf() : portOf;
  const at = await accessTokenFor(a.orgId, connectionId, port);
  const ctx: Ctx = {
    orgId: a.orgId, fixtureId: a.fixtureId, connectionId, privacy: target.privacy, madeForKids: target.made_for_kids, now: a.now,
    port, at,
  };
  const reused = await reuseOrClaim(ctx);
  if (reused) return reused;
  return createNew(ctx, true);
}

/** Step 1's token: the sealed refresh token opened (in memory only) and exchanged. A connection with no token, or one whose
 *  token will not open, needs reconnecting; a KEK fault is the deployment's and stays loud. */
async function accessTokenFor(orgId: string, connectionId: string, port: YouTubePort): Promise<string> {
  const refresh = await openToken(sql, orgId, connectionId).catch((err: unknown) => {
    if (err instanceof YoutubeTokenUnreadableError) throw youtubeRefusal("youtube_reconnect_needed", connectionId);
    throw err;
  });
  if (refresh === null) throw youtubeRefusal("youtube_reconnect_needed", connectionId);
  try {
    return await viaPort(() => port.accessToken(refresh));
  } catch (err) {
    await markIfGrantDead(err, orgId, connectionId);
    throw youtubeRefusal(refusalCodeOf(err) ?? "youtube_unavailable", connectionId);
  }
}

/** A port call YouTube refused `youtube_reconnect_needed` because the grant is dead (refresh `invalid_grant`, a 401, a scope the
 *  grant lacks) is the club's to fix by reconnecting: the connection moves to reconnect_needed (F5, spec §6.2 D6), so the Streaming
 *  page shows Reconnect and the next Go live refuses before calling YouTube. NOT `insufficientLivePermissions` ("not authorized to
 *  <live>"): that is a fact about the channel, not the grant, so it moves nothing here and refuses `youtube_live_blocked` (port.ts
 *  `isDeadGrantRefusal` / `isLiveBlockedRefusal`). Only the port's own error moves it:
 *  a refresh token this server cannot decrypt is ours to fix, not the club's, so it refuses without moving the status.
 *  Best effort: the refusal stands either way. */
async function markIfGrantDead(err: unknown, orgId: string, connectionId: string): Promise<void> {
  if (!isDeadGrantRefusal(err)) return;   // not the live-permission refusal: that one leaves the connection connected (T17 carry g)
  try {
    await markReconnectNeeded(sql, orgId, connectionId);
  } catch (e) {
    captureError(e, { orgId, route: "youtube.prepare.mark_reconnect", extra: { connectionId } });
  }
}

interface OpenRow { id: string; state: string; reserved_until: Date | null; key_id: string | null; connection_id: string }

/** Step 2, in one short transaction. Answers the reused broadcast, or null when there is none to reuse (none open, or the open
 *  one was just claimed `ending`). Throws the refusals that leave the row exactly as it was. */
async function reuseOrClaim(ctx: Ctx): Promise<Prepared | null> {
  return sql.begin(async (tx) => {
    const [row] = await tx<OpenRow[]>`
      select id, state, reserved_until, key_id, connection_id from youtube_broadcasts
       where fixture_id = ${ctx.fixtureId} and org_id = ${ctx.orgId} and state in ${tx(OPEN_ON_FIXTURE)}
       for update`;
    if (!row) return null;
    // The same comparison as the end rule's (end-rule.ts): a reservation is unlapsed while reserved_until > now.
    if (row.state === "reserved" && row.reserved_until !== null && row.reserved_until.getTime() > ctx.now.getTime()) {
      throw activeSession();
    }

    let facts: EndFacts | null = null;
    let due: Date | null = null;
    let broken = false;
    try {
      facts = await readEndFacts(tx, row.id);
      due = broadcastEndDueAt(facts, ctx.now);
    } catch (err) {
      if (!(err instanceof EndRuleInvariantError)) throw err;
      // T10-R1: the facts break an assumption the end rule rests on. The broadcast is not reusable — it is claimed below, and a
      // new one is made — and the break is reported. Go live is never refused for it.
      captureError(err, { orgId: ctx.orgId, route: "youtube.prepare.end_rule", extra: { broadcastId: row.id, fixtureId: ctx.fixtureId } });
      broken = true;
    }

    const sameChannel = row.connection_id === ctx.connectionId;
    // R2: null means never due (a session active on it, or none ever) — reuse; so does a due time still ahead.
    const notDue = !broken && (due === null || due.getTime() > ctx.now.getTime());
    if (notDue && sameChannel) {
      // A row a concurrent admission has only just inserted and not yet keyed cannot be reused yet: R3's accepted cost, one
      // retry tap ("two Go lives on one fixture in the same second").
      if (row.key_id === null) throw youtubeRefusal("youtube_unavailable", ctx.connectionId);
      await tx`
        update youtube_broadcasts set state = 'reserved', reserved_until = ${plusMinutes(ctx.now, YOUTUBE_RESERVATION_MINUTES)}
         where id = ${row.id}`;
      return { broadcastId: row.id, reused: true, keyId: row.key_id };
    }
    // The open broadcast is on ANOTHER of the org's channels (the destination was switched): it cannot carry this stream. With a
    // camera live on it, nothing is claimed — the fixture already has a running session.
    if (!sameChannel && facts?.activeSessionOnBroadcast) throw activeSession();
    // P7: due and unclaimed (or unusable here) — claim it for the end step, which finalizes it; the fixture index then admits
    // a new broadcast.
    await tx`
      update youtube_broadcasts set state = 'ending', claimed_at = ${ctx.now}, reserved_until = null
       where id = ${row.id}`;
    return null;
  });
}

interface FixtureWords {
  home: string | null; away: string | null; division: string; competition: string; default_locale: string;
  org_slug: string; comp_slug: string; div_slug: string;
}

/** The title and description, in the org's default locale (spec §6.5, R4). */
async function textsFor(ctx: Ctx): Promise<{ title: string; description: string }> {
  const [f] = await sql<FixtureWords[]>`
    select he.display_name as home, ae.display_name as away, d.name as division, c.name as competition, o.default_locale,
           o.slug as org_slug, c.slug as comp_slug, d.slug as div_slug
      from fixtures f
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
      join organizations o on o.id = c.org_id
      left join entrants he on he.id = f.home_entrant_id
      left join entrants ae on ae.id = f.away_entrant_id
     where f.id = ${ctx.fixtureId} and c.org_id = ${ctx.orgId}`;
  if (!f) throw new HttpError(404, "fixture not found");
  const locale = toLocale(f.default_locale);
  return {
    title: broadcastTitle({
      home: f.home, away: f.away, division: f.division, competition: f.competition,
      vs: msgFor(locale, "schedule.vs"), tbd: msgFor(locale, "schedule.tbd"),
    }),
    description: broadcastDescription({
      line: msgFor(locale, "streaming.youtube.broadcast.descriptionLine"),
      matchUrl: `${siteOrigin()}${routes.sharedFixture(f.org_slug, f.comp_slug, f.div_slug, ctx.fixtureId)}`,
    }),
  };
}

/** Hold the connection row for the rest of the transaction: every pick and every pool insert of a channel runs under it, so
 *  "free" and "lowest free slot" are read and acted on by one admission at a time. A connection no longer connected cannot
 *  create anything. */
async function lockConnection(tx: Tx, ctx: Ctx): Promise<void> {
  const [c] = await tx<{ id: string }[]>`
    select id from org_youtube_connections where id = ${ctx.connectionId} and org_id = ${ctx.orgId} and status = 'connected'
       for update`;
  if (!c) throw youtubeRefusal("youtube_reconnect_needed", ctx.connectionId);
}

/** The lowest-slot key of this connection that is FREE: not retired, no open broadcast on it (`ending` included), and — the
 *  post-T3 amendment — no session that used it may still be publishing to it: a Cloudflare output recorded and not released
 *  (the one publisher to the key, in BOTH modes), or — defence in depth (fix round 1, F1) — a composed runner not yet torn
 *  down (any state but `none` and `destroyed`). The runner never holds the key itself, so its gone-CONFIRMATION (relay-sweep's
 *  daily pass) is not awaited: waiting on it held every composed key until the next day, and the channel's 11th composed match
 *  of the day refused. Either live publisher would make a reuse put two publishers on one key. */
async function freeKey(tx: Tx, ctx: Ctx): Promise<string | null> {
  const [k] = await tx<{ id: string }[]>`
    select k.id from youtube_stream_keys k
     where k.connection_id = ${ctx.connectionId} and k.org_id = ${ctx.orgId} and k.retired_at is null
       and not exists (select 1 from youtube_broadcasts b where b.key_id = k.id and b.state in ${tx(OPEN_ON_KEY)})
       and not exists (
         select 1 from youtube_broadcasts b
           join fixture_stream_sessions s on s.youtube_broadcast_id = b.id
          where b.key_id = k.id
            and ((s.output_uid is not null and s.output_released_at is null)
                 or (s.mode = 'composed' and s.runner_state not in ('none', 'destroyed'))))
     order by k.slot
     limit 1`;
  return k?.id ?? null;
}

async function liveKeyCount(tx: Tx, ctx: Ctx): Promise<number> {
  const [{ n }] = await tx<{ n: number }[]>`
    select count(*)::int as n from youtube_stream_keys
     where connection_id = ${ctx.connectionId} and org_id = ${ctx.orgId} and retired_at is null`;
  return n;
}

type Pick = { kind: "busy" } | { kind: "fixture_taken" } | { kind: "row"; rowId: string; keyId: string | null };

/** Step 3's transaction: under the connection lock, a free key (or room for one), and the broadcast row `created`. */
async function pickAndInsert(ctx: Ctx, title: string): Promise<Pick> {
  return sql.begin(async (tx): Promise<Pick> => {
    await lockConnection(tx, ctx);
    const keyId = await freeKey(tx, ctx);
    if (keyId === null && !((await liveKeyCount(tx, ctx)) < MAX_LIVE_KEYS_PER_CHANNEL)) return { kind: "busy" };
    // The row is stamped with ctx.madeForKids - the very value `createNew` hands insertBroadcast to send YouTube (one source: it was read
    // once with the connection in prepareYoutubeBroadcast and is passed through, never re-read). A later PATCH of the connection moves
    // no existing row; the public match page decides link-vs-player from this stamp (V481).
    // A savepoint, so a concurrent admission's row on this fixture (the one-open index) does not abort the transaction.
    const rowId = await tx
      .savepoint(async (sp) => {
        const [r] = await sp<{ id: string }[]>`
          insert into youtube_broadcasts (org_id, connection_id, fixture_id, key_id, title, privacy, made_for_kids, state)
          values (${ctx.orgId}, ${ctx.connectionId}, ${ctx.fixtureId}, ${keyId}, ${title}, ${ctx.privacy}, ${ctx.madeForKids}, 'created')
          returning id`;
        return r!.id;
      })
      .catch((err: unknown) => {
        if (isUniqueOn(err, ONE_OPEN_PER_FIXTURE)) return null;
        throw err;
      });
    if (rowId === null) return { kind: "fixture_taken" };
    return { kind: "row", rowId, keyId };
  });
}

/** Steps 3–4 for a new broadcast. `reread`: a 23505 on the fixture's one-open index takes step 2 again (R3), once. */
async function createNew(ctx: Ctx, reread: boolean): Promise<Prepared> {
  const { title, description } = await textsFor(ctx);   // the row's title is NOT NULL: computed before the transaction
  const pick = await pickAndInsert(ctx, title);
  if (pick.kind === "busy") throw youtubeRefusal("youtube_channel_busy", ctx.connectionId);
  if (pick.kind === "fixture_taken") {
    // A concurrent admission inserted this fixture's row first: re-read and reuse it (R3).
    if (!reread) throw youtubeRefusal("youtube_unavailable", ctx.connectionId);
    const reused = await reuseOrClaim(ctx);
    if (reused) return reused;
    return createNew(ctx, false);
  }

  const rowId = pick.rowId;
  let ytId: string | null = null;
  let keyId: string | null = pick.keyId;
  try {
    keyId ??= await growPool(ctx, rowId);
    const [key] = await sql<{ live_stream_id: string }[]>`
      select live_stream_id from youtube_stream_keys where id = ${keyId} and org_id = ${ctx.orgId}`;
    if (!key) throw new Error(`youtube stream key ${keyId} not found`);
    // scheduledStartTime "must be in the future" (liveBroadcasts.insert): the clock at the call, never a stale `now`.
    const scheduledStart = new Date(Math.max(ctx.now.getTime(), Date.now()));
    const inserted = await viaPort(() => ctx.port.insertBroadcast(ctx.at, {
      title, description, scheduledStart, privacy: ctx.privacy, madeForKids: ctx.madeForKids,
    }));
    ytId = inserted.broadcastId;
    await sql`update youtube_broadcasts set yt_broadcast_id = ${ytId} where id = ${rowId}`;
    await viaPort(() => ctx.port.bind(ctx.at, inserted.broadcastId, key.live_stream_id));
    // A row another admission reserved meanwhile (R3) stays reserved: it is bound at YouTube either way.
    await sql`update youtube_broadcasts set state = 'bound' where id = ${rowId} and state = 'created'`;
    await noteLiveState(ctx, null);
    return { broadcastId: rowId, reused: false, keyId };
  } catch (err) {
    const code = refusalCodeOf(err);
    await failRow(ctx, rowId, ytId, code ?? "youtube_unavailable");
    if (keyId !== null && isStreamGone(err)) await retireKey(ctx, keyId);
    await markIfGrantDead(err, ctx.orgId, ctx.connectionId);
    if (isYoutubeLiveStateRefusal(code)) await noteLiveState(ctx, code);
    if (code !== null) throw youtubeRefusal(code, ctx.connectionId);
    throw err;
  }
}

/** What this Go live learned about the CHANNEL's ability to stream, written where the Streaming page reads it (connections.ts
 *  `recordLiveState`): the code when YouTube refused for the channel's live state (not enabled, restricted), `null` when a bind
 *  succeeded. Best effort, like `markIfGrantDead`: the outcome stands either way, and an unwritten record only means the page reads
 *  `unknown` and the next Go live asks YouTube. */
async function noteLiveState(ctx: Ctx, code: Parameters<typeof recordLiveState>[3]): Promise<void> {
  try {
    await recordLiveState(sql, ctx.orgId, ctx.connectionId, code);
  } catch (err) {
    captureError(err, { orgId: ctx.orgId, route: "youtube.prepare.live_state", extra: { connectionId: ctx.connectionId } });
  }
}

/** YouTube no longer has the pooled key's liveStream (the club deleted it in Studio): bind's `liveStreamNotFound`. */
const isStreamGone = (err: unknown): boolean =>
  err instanceof YouTubeError && err.code === "youtube_not_found" && err.reason === "liveStreamNotFound";

/** A key whose liveStream is gone at YouTube leaves the pool for good (fix round 1, F2): left in, it is the lowest free slot
 *  for every later pick and each one fails the same way. Retired, its slot is free again (V479's slot index is partial on
 *  `retired_at is null`) and the next Go live grows a fresh liveStream into it. Best effort, like failRow: the refusal stands. */
async function retireKey(ctx: Ctx, keyId: string): Promise<void> {
  try {
    await sql`
      update youtube_stream_keys set retired_at = now()
       where id = ${keyId} and org_id = ${ctx.orgId} and connection_id = ${ctx.connectionId} and retired_at is null`;
  } catch (err) {
    captureError(err, { orgId: ctx.orgId, route: "youtube.prepare.retire_key", extra: { connectionId: ctx.connectionId } });
  }
}

/** A keyless row's key: a new liveStream, pooled at the lowest free slot. A lost slot (another admission pooled the last one
 *  first) deletes this liveStream and retries the pick once (P3). */
async function growPool(ctx: Ctx, rowId: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const stream = await viaPort(() => ctx.port.insertStream(ctx.at, { title: STREAM_TITLE }));
    let pooled: string | null;
    try {
      pooled = await sql.begin(async (tx) => {
        await lockConnection(tx, ctx);
        const [free] = await tx<{ slot: number }[]>`
          select s::int as slot from generate_series(1, ${MAX_LIVE_KEYS_PER_CHANNEL}::int) s
           where not exists (select 1 from youtube_stream_keys k
                              where k.connection_id = ${ctx.connectionId} and k.retired_at is null and k.slot = s)
           order by s limit 1`;
        if (!free) return null;
        const key = await tx
          .savepoint((sp) => insertPooledKey(sp, {
            orgId: ctx.orgId, connectionId: ctx.connectionId, slot: free.slot, liveStreamId: stream.streamId, ingest: stream.ingest,
          }))
          .catch((err: unknown) => {
            if (isUniqueOn(err, ONE_LIVE_SLOT)) return null;
            throw err;
          });
        if (!key) return null;
        await tx`update youtube_broadcasts set key_id = ${key.keyId} where id = ${rowId}`;
        return key.keyId;
      });
    } catch (err) {
      await deleteStream(ctx, stream.streamId);   // made at YouTube, never pooled: it would be an orphan
      throw err;
    }
    if (pooled !== null) return pooled;

    await deleteStream(ctx, stream.streamId);
    if (attempt >= 2) throw youtubeRefusal("youtube_unavailable", ctx.connectionId);
    const again = await sql.begin(async (tx): Promise<string | "busy" | "grow"> => {
      await lockConnection(tx, ctx);
      const keyId = await freeKey(tx, ctx);
      if (keyId !== null) {
        await tx`update youtube_broadcasts set key_id = ${keyId} where id = ${rowId}`;
        return keyId;
      }
      return (await liveKeyCount(tx, ctx)) < MAX_LIVE_KEYS_PER_CHANNEL ? "grow" : "busy";
    });
    if (again === "busy") throw youtubeRefusal("youtube_channel_busy", ctx.connectionId);
    if (again !== "grow") return again;
  }
}

/** Best effort: a liveStream this prepare made and could not keep. A failure is reported, never thrown over the real outcome. */
async function deleteStream(ctx: Ctx, streamId: string): Promise<void> {
  try {
    await viaPort(() => ctx.port.deleteStream(ctx.at, streamId));
  } catch (err) {
    captureError(err, { orgId: ctx.orgId, route: "youtube.prepare.delete_stream", extra: { connectionId: ctx.connectionId } });
  }
}

/** A refused new broadcast: the row `failed` with the code (from any state a prepare or a reuse left it in), then what YouTube
 *  got deleted. The row goes first, so nothing reuses a broadcast that is about to vanish. Both are best effort. */
async function failRow(ctx: Ctx, rowId: string, ytId: string | null, code: YoutubeRefusalCode): Promise<void> {
  try {
    await sql`
      update youtube_broadcasts set state = 'failed', last_error_code = ${code}, reserved_until = null
       where id = ${rowId} and state in ('created', 'bound', 'reserved')`;
  } catch (err) {
    captureError(err, { orgId: ctx.orgId, route: "youtube.prepare.fail_row", extra: { broadcastId: rowId } });
  }
  if (ytId === null) return;
  try {
    await viaPort(() => ctx.port.deleteBroadcast(ctx.at, ytId));
  } catch (err) {
    captureError(err, { orgId: ctx.orgId, route: "youtube.prepare.delete_broadcast", extra: { broadcastId: rowId } });
  }
}

/** A refused admission: created-new → deleteBroadcast at YouTube + row 'failed' code 'admission_refused', only while the row is
 *  still 'created'/'bound' (a row another admission reserved meanwhile is left to it) — or 'live' with NO session (T11 fix round
 *  1, I-1: the admission committed, then provisioning deleted the session, and the FK nulled `last_session_id`; a new broadcast
 *  nobody streams into would otherwise stay "upcoming" and hold its key for good; one whose session still exists has
 *  `last_session_id` set and is left to that session); reused → reservation released (state back to 'live' when last_session_id
 *  is set, else 'bound' — or 'created' for a row YouTube has no broadcast for yet). Never throws (reports). */
export async function abandonPrepared(p: Prepared, port: YouTubePort): Promise<void> {
  try {
    if (p.reused) {
      await sql`
        update youtube_broadcasts
           set state = case when last_session_id is not null then 'live' when yt_broadcast_id is null then 'created' else 'bound' end,
               reserved_until = null
         where id = ${p.broadcastId} and state = 'reserved'`;
      return;
    }
    const [row] = await sql<{ org_id: string; connection_id: string; yt_broadcast_id: string | null }[]>`
      update youtube_broadcasts set state = 'failed', last_error_code = 'admission_refused'
       where id = ${p.broadcastId} and (state in ('created', 'bound') or (state = 'live' and last_session_id is null))
      returning org_id, connection_id, yt_broadcast_id`;
    if (!row || row.yt_broadcast_id === null) return;
    const ytId = row.yt_broadcast_id;
    const refresh = await openToken(sql, row.org_id, row.connection_id);
    if (refresh === null) throw new Error(`youtube connection ${row.connection_id} has no token to delete broadcast ${p.broadcastId}`);
    const at = await viaPort(() => port.accessToken(refresh));
    await viaPort(() => port.deleteBroadcast(at, ytId));
  } catch (err) {
    captureError(err, { route: "youtube.abandon", extra: { broadcastId: p.broadcastId, reused: p.reused } });
  }
}

/** Inside admission's transaction, after the session insert: reserved|bound → live, reserved_until null, last_session_id =
 *  sessionId. 0 rows updated (the reservation lapsed and the end step claimed it), or a row whose key is not this Prepared's or
 *  whose yt_broadcast_id is still null (two Go lives on one fixture in the same second; rare) → HttpError(503,
 *  "youtube_unavailable") (R3). */
export async function attachPrepared(tx: Tx, p: Prepared, sessionId: string): Promise<void> {
  const rows = await tx<{ id: string }[]>`
    update youtube_broadcasts set state = 'live', reserved_until = null, last_session_id = ${sessionId}
     where id = ${p.broadcastId} and state in ('reserved', 'bound') and key_id = ${p.keyId} and yt_broadcast_id is not null
    returning id`;
  if (rows.length === 1) return;
  const [b] = await tx<{ connection_id: string }[]>`select connection_id from youtube_broadcasts where id = ${p.broadcastId}`;
  throw new HttpError(503, "YouTube refused Go live: youtube_unavailable", "youtube_unavailable", { connectionId: b?.connection_id ?? null });
}
