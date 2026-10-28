import "server-only";
// server/youtube/connections.ts — a connected YouTube channel as the product sees it (plan T8): the connect flow's SAVE, the
// Streaming page's projection of a connection, and its settings. Every statement that touches the refresh token goes through
// token-store.ts (controller ruling R1; enc-boundary.test.ts) — this file never names the sealed column.
//
// ONE transaction does a save: lock the pending grant, check it, take its token, write the connection and its destination row,
// delete the pending row. Nothing in it calls Google (global-constraints: no lock is held across a YouTube call); a refusal that
// needs a call at Google — revoking a grant — belongs to the CALLER, and the one refusal this file raises (the channel is live in
// another organisation) must NOT revoke: V479's one-live-channel is global, so the grant this connect brought is the same grant
// that organisation's live connection runs on, and revoking it would kill that connection.
import { sql, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { YOUTUBE_CONSENT_VERSION, YOUTUBE_PRIVACIES, type YoutubePrivacy } from "@/lib/youtube";
import type { AuthCtx } from "@/server/api-v1/auth";
import type {
  PickYoutubeChannel, YoutubeConnectionSaved, YoutubeConnectionSettings, YoutubeConnectionView, YoutubePendingChannels,
} from "@/server/api-v1/schemas";
import { fingerprintYoutubeChannel } from "@/server/relay/crypto";
import type { YouTubePort } from "./port";
import { insertConnectionWithToken, replaceConnectionToken, takePendingToken } from "./token-store";

/** The sentence a connect refused because the channel is live in another organisation says (spec §5.2). */
export const OTHER_ORG_MESSAGE = "This channel is connected to another organisation on Seazn";
/** The machine code on that refusal; the OAuth callback lands `other_org` on it and revokes nothing. */
export const YOUTUBE_OTHER_ORG = "YOUTUBE_OTHER_ORG";

/** The index a second live connection to one channel trips (V479). Matched by NAME, as secret-columns.ts matches its own. */
const ONE_LIVE_CHANNEL_INDEX = "org_youtube_connections_one_live_channel";
const isOneLiveChannelConflict = (err: unknown): boolean => {
  const pg = err as { code?: string; constraint_name?: string };
  return pg.code === "23505" && pg.constraint_name === ONE_LIVE_CHANNEL_INDEX;
};

/** A broadcast is OPEN while it is neither complete nor failed (spec §5.4). `ending` is open: the stream is still on its key. */
const OPEN_BROADCAST_STATES = ["created", "bound", "reserved", "live", "ending"] as const;

const notFound = () => new HttpError(404, "youtube connection not found");
const pendingNotFound = () => new HttpError(404, "connect request not found");
const pendingExpired = () =>
  new HttpError(410, "This connect request has expired; connect the channel again", "YOUTUBE_PENDING_EXPIRED");

interface PendingRow {
  id: string; org_id: string; user_id: string; connection_id: string | null; default_privacy: YoutubePrivacy; made_for_kids: boolean;
  consent_version: number; consent_at: Date; granted_scope: string | null; google_sub: string | null;
  channels: { id: string; title: string }[] | null; live: boolean;
}

/** The pending grant of THIS user — and, when `orgId` is given, of this org. `lock` holds the row for the rest of the transaction
 *  (a save). `live` is the database's own clock against `expires_at`, read in the same statement that locks the row, so a save
 *  judges the expiry inside the transaction that takes the token (takePendingToken does not look at it). Null: no such row,
 *  another user's, or another org's — one answer, so a foreign id is no oracle. */
async function readPending(exec: Tx | typeof sql, a: { pendingId: string; userId: string; orgId?: string }, lock: boolean): Promise<PendingRow | null> {
  const [row] = await exec<PendingRow[]>`
    select id, org_id, user_id, connection_id, default_privacy, made_for_kids, consent_version, consent_at, granted_scope, google_sub,
           channels, expires_at > now() as live
      from youtube_connect_pending
     where id = ${a.pendingId} and user_id = ${a.userId} and (${a.orgId ?? null}::uuid is null or org_id = ${a.orgId ?? null})
     ${lock ? exec`for update` : exec``}`;
  return row ?? null;
}

/** The org's live (not revoked) connection to this channel, with the consent it was given under. */
async function liveConnectionOf(tx: Tx, orgId: string, channelId: string): Promise<{ id: string; consent_version: number } | null> {
  const [row] = await tx<{ id: string; consent_version: number }[]>`
    select id, consent_version from org_youtube_connections
     where org_id = ${orgId} and channel_id = ${channelId} and status <> 'revoked'`;
  return row ?? null;
}

/** The connection's active destination row, inserted if a live connection somehow has none (a connection written before its
 *  destination, or by a path that did not write one: the destination is what the fixture panel's picker lists, so a channel
 *  without one is connected and invisible). `watch_url` stays NULL on purpose: fillReplayUrl would write a channel URL as a
 *  match's replay link; a replay comes from a broadcast, never from the destination. */
async function ensureDestination(tx: Tx, orgId: string, connectionId: string, channelId: string, title: string): Promise<string> {
  const [existing] = await tx<{ id: string }[]>`
    select id from org_stream_targets
     where org_id = ${orgId} and youtube_connection_id = ${connectionId} and archived_at is null
     order by created_at asc, id asc limit 1`;
  if (existing) return existing.id;
  const [row] = await tx<{ id: string }[]>`
    insert into org_stream_targets (org_id, kind, label, youtube_connection_id, dest_fingerprint)
    values (${orgId}, 'youtube', ${title}, ${connectionId}, ${fingerprintYoutubeChannel(channelId)})
    returning id`;
  return row!.id;
}

/** A RECONNECT of a live connection with this grant's token. Token, `connected`, `status_since` and a cleared error are one
 *  statement (token-store.ts, R1). Around it, in the same transaction: the connection learns whose Google account now holds its
 *  token (T18's "revoke unless another connection shares the sub" reads it) and which scope was granted; a consent given on
 *  NEWER wording than the connection carries is recorded on it (replaceConnectionToken does not touch consent); and every open
 *  broadcast's retry backoff is cleared, so the end step that was waiting for a working token tries again at once. */
async function reconnect(
  tx: Tx, p: PendingRow, connectionId: string, channel: { id: string; title: string }, token: string, consentVersionOnConnection: number,
): Promise<YoutubeConnectionSaved> {
  if (!(await replaceConnectionToken(tx, p.org_id, connectionId, token))) throw notFound();
  await tx`
    update org_youtube_connections set google_sub = coalesce(${p.google_sub}, google_sub), granted_scope = ${p.granted_scope ?? ""}
     where id = ${connectionId} and org_id = ${p.org_id}`;
  if (p.consent_version > consentVersionOnConnection) {
    await tx`
      update org_youtube_connections set consent_version = ${p.consent_version}, consent_at = ${p.consent_at}, consent_by = ${p.user_id}
       where id = ${connectionId} and org_id = ${p.org_id}`;
  }
  await tx`
    update youtube_broadcasts set next_attempt_at = null
     where connection_id = ${connectionId} and org_id = ${p.org_id} and next_attempt_at is not null
       and state in ${tx(OPEN_BROADCAST_STATES)}`;
  const targetId = await ensureDestination(tx, p.org_id, connectionId, channel.id, channel.title);
  await tx`delete from youtube_connect_pending where id = ${p.id}`;
  return { connectionId, targetId, existing: true };
}

/** Save the channel a grant was made for: the connection, its destination row (kind youtube, labelled with the channel's title,
 *  fingerprinted by the channel id, no stream key of its own), and the pending grant gone — in one transaction.
 *
 *  Refusals, all of which leave the pending grant (and the token sealed on it) exactly as they found it:
 *   - 404: no such pending grant, another user's, another org's (when `orgId` is given), or one that never had a token sealed;
 *   - 410 YOUTUBE_PENDING_EXPIRED: it expired (judged inside this transaction);
 *   - 422 YOUTUBE_CHANNEL_NOT_OFFERED: the channel is not one the grant listed (a pick for a channel the account does not have);
 *   - 422 YOUTUBE_DIFFERENT_CHANNEL: a reconnect for a channel other than its connection's;
 *   - 409 YOUTUBE_OTHER_ORG: the channel is live in another organisation. The new token is NOT revoked (see the header).
 *  The same org connecting the same channel again is the existing connection, its token replaced (a reconnect); the answer says
 *  so (`existing: true`) because the grant's own privacy and made-for-kids choices are NOT applied to it. */
export async function saveConnectionFromGrant(
  a: { pendingId: string; channelId: string; userId: string; orgId?: string },
  port: YouTubePort,
): Promise<YoutubeConnectionSaved> {
  // The callback hands over the port it holds; nothing in a save calls Google (see the header), so it is not used.
  void port;
  return sql.begin(async (tx) => {
    const p = await readPending(tx, a, true);
    if (!p) throw pendingNotFound();
    if (!p.live) throw pendingExpired();
    const channel = (p.channels ?? []).find((c) => c.id === a.channelId);
    if (!channel) {
      throw new HttpError(422, "That channel is not one of the channels this Google account offered", "YOUTUBE_CHANNEL_NOT_OFFERED");
    }
    const token = await takePendingToken(tx, p.org_id, p.id);
    if (token === null) throw pendingNotFound();

    if (p.connection_id) {
      const [conn] = await tx<{ channel_id: string | null; consent_version: number }[]>`
        select channel_id, consent_version from org_youtube_connections
         where id = ${p.connection_id} and org_id = ${p.org_id} and status <> 'revoked' for update`;
      if (!conn) throw notFound();
      if (conn.channel_id !== channel.id) {
        throw new HttpError(422, "That grant is for a different channel than this connection", "YOUTUBE_DIFFERENT_CHANNEL");
      }
      return reconnect(tx, p, p.connection_id, channel, token, conn.consent_version);
    }

    const mine = await liveConnectionOf(tx, p.org_id, channel.id);
    if (mine) return reconnect(tx, p, mine.id, channel, token, mine.consent_version);

    // A savepoint, so a lost race for the channel does not abort the transaction: the next statement can still ask who won.
    const created = await tx
      .savepoint((sp) =>
        insertConnectionWithToken(sp, {
          orgId: p.org_id, channelId: channel.id, channelTitle: channel.title, googleSub: p.google_sub, grantedScope: p.granted_scope ?? "",
          defaultPrivacy: p.default_privacy, madeForKids: p.made_for_kids, consentBy: p.user_id, consentAt: p.consent_at,
          consentVersion: p.consent_version, createdBy: a.userId, refreshToken: token,
        }),
      )
      .catch((err: unknown) => {
        if (isOneLiveChannelConflict(err)) return null;
        throw err;
      });
    if (!created) {
      // The channel is live. In THIS org (a concurrent connect of it won between the read above and the insert): it is a reconnect.
      // In another (V479's index is global): refused, and the throw rolls back the take, so the pending grant keeps its token.
      const winner = await liveConnectionOf(tx, p.org_id, channel.id);
      if (winner) return reconnect(tx, p, winner.id, channel, token, winner.consent_version);
      throw new HttpError(409, OTHER_ORG_MESSAGE, YOUTUBE_OTHER_ORG);
    }
    const targetId = await ensureDestination(tx, p.org_id, created.connectionId, channel.id, channel.title);
    await tx`delete from youtube_connect_pending where id = ${p.id}`;
    return { connectionId: created.connectionId, targetId, existing: false };
  });
}

/** The channel list of a pending grant, for the picker: the caller's own grant, in this org, unexpired. 404 for anything else
 *  (a foreign, missing or not-yet-granted one — one answer); 410 once it expired. */
export async function pendingChannels(auth: AuthCtx, orgId: string, pendingId: string): Promise<YoutubePendingChannels> {
  if (auth.orgId !== orgId) throw new HttpError(404, "organization not found");
  if (auth.userId === null) throw pendingNotFound();   // a key has no grant of its own
  const userId = auth.userId;
  const p = await readPending(sql, { pendingId, userId, orgId }, false);
  if (!p || p.channels === null) throw pendingNotFound();
  if (!p.live) throw pendingExpired();
  return { channels: p.channels.map((c) => ({ id: c.id, title: c.title })) };
}

/** POST /orgs/:id/youtube-connections — the pick: save the chosen channel of a multi-channel grant. The pending grant must be the
 *  caller's own and this org's (404 otherwise), so the org in the URL is the org the connection is made in. */
export async function pickYoutubeChannel(
  auth: AuthCtx, orgId: string, b: PickYoutubeChannel, port: YouTubePort,
): Promise<YoutubeConnectionSaved> {
  if (auth.orgId !== orgId) throw new HttpError(404, "organization not found");
  if (auth.userId === null) throw pendingNotFound();
  return saveConnectionFromGrant({ pendingId: b.pendingId, channelId: b.channelId, userId: auth.userId, orgId }, port);
}

// ---------------------------------------------------------------------------------------------------------------------------
// The Streaming page's projection

interface ConnectionViewRow {
  id: string; channel_title: string; default_privacy: YoutubePrivacy; made_for_kids: boolean; status: "connected" | "reconnect_needed";
  last_health_at: Date | null; last_error_code: string | null; consent_version: number; open_broadcasts: number; status_since: Date;
}

/** What the health check last learned about the channel's ability to stream, as the Streaming page says it. It fails CLOSED: `enabled`
 *  needs a check that came back clean (no code) and was made SINCE the token last changed (`status_since`; a reconnect clears the
 *  code, so a clean-looking row older than its token says nothing). `unknown` while no check has run, while the check predates the
 *  token, while the grant is dead (YouTube cannot be asked), and for any code this build does not map to a state. */
function liveStateOf(
  r: Pick<ConnectionViewRow, "status" | "last_health_at" | "last_error_code" | "status_since">,
): YoutubeConnectionView["liveState"] {
  if (r.status === "reconnect_needed" || r.last_health_at === null) return "unknown";
  if (r.last_health_at < r.status_since) return "unknown";
  if (r.last_error_code === null) return "enabled";
  if (r.last_error_code === "youtube_live_blocked") return "blocked";
  if (r.last_error_code === "youtube_live_not_enabled") return "not_enabled";
  return "unknown";
}

function toView(r: ConnectionViewRow): YoutubeConnectionView {
  return {
    connectionId: r.id, channelTitle: r.channel_title, privacy: r.default_privacy, madeForKids: r.made_for_kids, status: r.status,
    liveState: liveStateOf(r),
    // Read at call time (not captured), so a bump of the consent text is seen by the next read. Less than: a connection consented
    // under a LATER wording than this build's (a rollback) is not "outdated".
    termsOutdated: r.consent_version < YOUTUBE_CONSENT_VERSION,
    openBroadcasts: r.open_broadcasts,
  };
}

/** The org's live connections as the Streaming page shows them, by connection id. Org-scoped in SQL. Revoked connections are history
 *  and have no view. `only` narrows to one connection (a PATCH's reply). */
export async function connectionViews(orgId: string, only?: string): Promise<Map<string, YoutubeConnectionView>> {
  const rows = await sql<ConnectionViewRow[]>`
    select c.id, c.channel_title, c.default_privacy, c.made_for_kids, c.status, c.last_health_at, c.last_error_code, c.consent_version, c.status_since,
           (select count(*)::int from youtube_broadcasts b
             where b.connection_id = c.id and b.org_id = c.org_id and b.state in ${sql(OPEN_BROADCAST_STATES)}) as open_broadcasts
      from org_youtube_connections c
     where c.org_id = ${orgId} and c.status <> 'revoked' and (${only ?? null}::uuid is null or c.id = ${only ?? null})`;
  return new Map(rows.map((r) => [r.id, toView(r)]));
}

/** PATCH a connection's settings: its default visibility, made-for-kids, and the consent on the CURRENT wording ("Review updated
 *  terms"). One statement; a field not sent is not touched, and a consent already at the current wording is not re-stamped (a second
 *  press, or another editor's, does not replace who consented, or when). Answers with the connection as the Streaming page shows it.
 *  404 for a missing, revoked or another organisation's connection — one answer. */
export async function updateConnectionSettings(
  auth: AuthCtx, orgId: string, connectionId: string, b: Partial<YoutubeConnectionSettings>,
): Promise<YoutubeConnectionView> {
  if (auth.orgId !== orgId) throw new HttpError(404, "organization not found");
  // The wire schema refuses these first (400); a caller that bypasses it meets the same refusals here instead of a database check.
  if (b.privacy !== undefined && !(YOUTUBE_PRIVACIES as readonly string[]).includes(b.privacy)) {
    throw new HttpError(422, "privacy must be unlisted, public or private", "YOUTUBE_PRIVACY_INVALID");
  }
  if (b.consent !== undefined && b.consent !== true) throw new HttpError(422, "consent can only be given, not withdrawn here", "YOUTUBE_CONSENT_INVALID");
  // A consent names the person who gave it (consent_by is NOT NULL); a key has none to name.
  if (b.consent === true && auth.userId === null) throw new HttpError(403, "Consent must be given by a signed-in person");
  const consenting = b.consent === true;
  const rows = await sql<{ id: string }[]>`
    update org_youtube_connections
       set default_privacy = coalesce(${b.privacy ?? null}::text, default_privacy),
           made_for_kids = coalesce(${b.madeForKids ?? null}::boolean, made_for_kids),
           consent_version = case when ${consenting} and consent_version < ${YOUTUBE_CONSENT_VERSION} then ${YOUTUBE_CONSENT_VERSION}::int else consent_version end,
           consent_at = case when ${consenting} and consent_version < ${YOUTUBE_CONSENT_VERSION} then now() else consent_at end,
           consent_by = case when ${consenting} and consent_version < ${YOUTUBE_CONSENT_VERSION} then ${auth.userId}::uuid else consent_by end
     where id = ${connectionId} and org_id = ${orgId} and status <> 'revoked'
    returning id`;
  if (rows.length !== 1) throw notFound();
  const view = (await connectionViews(orgId, connectionId)).get(connectionId);
  if (!view) throw notFound();
  return view;
}
