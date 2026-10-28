import "server-only";
// server/youtube/token-store.ts — the ONLY file that names `refresh_token_enc` (enc-boundary.test.ts holds every other
// file to it). A connected channel's refresh token acts AS the channel — it can create and end broadcasts there — so it
// is sealed under its own key, YOUTUBE_TOKEN_KEK (never RELAY_KEK, which opens every pooled stream key), and it is
// plaintext only in memory, for one request.
//
// Controller ruling R1: this file owns EVERY statement that writes or reads the token, including the connection's INSERT
// and the revoke. The reason is V479's two IMMEDIATE checks on `org_youtube_connections`:
//     (status = 'revoked') = (refresh_token_enc is null)      and      (status = 'revoked') = (revoked_at is not null)
// A CHECK cannot be deferred, so a revoke written as "null the token" and then "set the status" is refused by the
// database half-way. Each writer below therefore changes the token, the status and revoked_at in ONE statement, and no
// other file writes `status = 'revoked'` or the token. T8 (connect save), T17 (dead-grant purge) and T18 (disconnect) call
// these; none of them may write the columns itself. The revoke statement also nulls the channel's id and title and archives
// the connection's destination row under a fixed label (DP III.E.4: nothing identifying outlives an in-app revoke).
//
// Secrets: no function here puts a token, a sealed envelope or its bytes in a message, a log line or a thrown error. A
// missing or malformed YOUTUBE_TOKEN_KEK throws the KEK's own sentence (crypto.ts), which names the variable and never
// a value. Sealing happens BEFORE any write, so a missing KEK writes nothing.
import type { Tx, sql } from "@/lib/db";
import { YOUTUBE_DISCONNECTED_LABEL } from "@/lib/youtube";
import { assertKek, openWith, sealWith } from "@/server/relay/crypto";

/** Structurally the plan's `YoutubePrivacy` (lib/youtube.ts, T5). Declared here because that module does not exist yet;
 *  TypeScript's structural typing makes the two interchangeable, so T5 owes no change to these signatures. */
type ConnectionPrivacy = "unlisted" | "public" | "private";

/** Anything that can run a statement: a transaction, or the pooled client. */
type Exec = Tx | typeof sql;

/** A stored token that will not open under a VALID YOUTUBE_TOKEN_KEK — damaged, or sealed under another key. Typed so the
 *  caller can say "reconnect this channel" (a fresh token is sealed under the current key), distinct from the KEK fault
 *  (the deployment's, thrown as the KEK's own error, never this). `id` is the connection id or the pending-grant id: not
 *  a secret. Carries nothing else — no envelope, no bytes. */
export class YoutubeTokenUnreadableError extends Error {
  constructor(public readonly id: string) {
    super(`youtube token ${id}: the saved token will not open`);
    this.name = "YoutubeTokenUnreadableError";
  }
}

const seal = (token: string): Buffer => {
  // An empty token would seal fine and read back as a "token" nobody can use; revoked <=> no token, so a live row must hold a real one.
  if (typeof token !== "string" || token.length === 0) throw new Error("youtube refresh token is empty");
  return sealWith("YOUTUBE_TOKEN_KEK", token);
};

/** Open one envelope. A failure under a missing or malformed KEK is the KEK's own sentence (`assertKek` throws it — a
 *  damaged row read first would otherwise surface as "envelope too short" over the real cause); only an envelope that
 *  fails under a valid KEK is this row's `YoutubeTokenUnreadableError`. */
function open(enc: Uint8Array, id: string): string {
  try {
    return openWith("YOUTUBE_TOKEN_KEK", enc);
  } catch {
    assertKek("YOUTUBE_TOKEN_KEK");
    throw new YoutubeTokenUnreadableError(id);
  }
}

/** The connection row, born CONNECTED with its token sealed in the same INSERT (the connect callback's save, T8). The
 *  one-live-channel unique index (`org_youtube_connections_one_live_channel`) is NOT caught here: its 23505 propagates
 *  and the caller matches it by name. `last_health_at`, `last_error_code` and `revoked_at` start null. */
export async function insertConnectionWithToken(
  tx: Tx,
  a: {
    orgId: string; channelId: string; channelTitle: string; googleSub: string | null; grantedScope: string;
    defaultPrivacy: ConnectionPrivacy; madeForKids: boolean; consentBy: string; consentAt: Date; consentVersion: number;
    createdBy: string; refreshToken: string;
  },
): Promise<{ connectionId: string }> {
  const sealed = seal(a.refreshToken);
  const [row] = await tx<{ id: string }[]>`
    insert into org_youtube_connections (
      org_id, channel_id, channel_title, google_sub, refresh_token_enc, granted_scope, default_privacy, made_for_kids,
      consent_by, consent_at, consent_version, status, created_by
    ) values (
      ${a.orgId}, ${a.channelId}, ${a.channelTitle}, ${a.googleSub}, ${sealed}, ${a.grantedScope}, ${a.defaultPrivacy}, ${a.madeForKids},
      ${a.consentBy}, ${a.consentAt}, ${a.consentVersion}, 'connected', ${a.createdBy}
    )
    returning id`;
  return { connectionId: row!.id };
}

/** A RECONNECT: a fresh token for an existing, not-revoked connection of this org. Token, `status = 'connected'`,
 *  `status_since = now()` and `last_error_code = null` in ONE statement. False when there is no such row (another org's,
 *  a missing id, or a REVOKED one — a revoked connection is history and is never revived; the caller connects the channel
 *  afresh), and then nothing is written. */
export async function replaceConnectionToken(tx: Exec, orgId: string, connectionId: string, refreshToken: string): Promise<boolean> {
  const sealed = seal(refreshToken);
  const rows = await tx<{ id: string }[]>`
    update org_youtube_connections
       set refresh_token_enc = ${sealed}, status = 'connected', status_since = now(), last_error_code = null
     where id = ${connectionId} and org_id = ${orgId} and status <> 'revoked'
    returning id`;
  return rows.length === 1;
}

/** A DEAD GRANT seen in use (T10 F5; T14's end step and the health check take the same transition): a `connected` row moves
 *  to `reconnect_needed`, `status_since = now()`, `last_error_code` the refusal code — so the Streaming page offers Reconnect.
 *  The token is KEPT (only a revoke clears it, R1; a reconnect replaces it). False, and nothing written, for a row that is not
 *  `connected` — already reconnect_needed (its first time stands), revoked (history), another org's, or missing. */
export async function markReconnectNeeded(tx: Exec, orgId: string, connectionId: string): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    update org_youtube_connections
       set status = 'reconnect_needed', status_since = now(), last_error_code = 'youtube_reconnect_needed'
     where id = ${connectionId} and org_id = ${orgId} and status = 'connected'
    returning id`;
  return rows.length === 1;
}

/** What the destination row's label becomes when its connection is revoked: the channel's title is Authorized Data and must
 *  not outlive the revoke (DP III.E.4, spec §3.4). The label is the one copy this statement scrubs; the pending row's
 *  `channels` (expiry sweep) and broadcast titles (disconnect purge) are cleared elsewhere. */
const DISCONNECTED_LABEL = YOUTUBE_DISCONNECTED_LABEL;

/** Revoke: ONE statement that (1) clears the token and makes the row `revoked` with `revoked_at` — V479's checks refuse any
 *  other shape (R1); `status_since` moves with the status; `last_error_code` is kept (the cause a dead grant was revoked for
 *  is history) — (2) nulls the channel's id and title (Authorized Data: deleted within 7 days of an in-app revoke, so done
 *  here, inline; only a revoked row may lack them, V479 `live_has_channel`), and (3) ARCHIVES the connection's destination
 *  row(s) under a fixed, non-identifying label. The archive is what frees the channel's fingerprint (V427's partial unique
 *  index is on ACTIVE rows) so the same channel can be connected again, and what keeps Remove/Rename of a dead destination
 *  from answering "use Disconnect". `dest_fingerprint` stays: it is a keyed HMAC and history keys on it. An already-archived
 *  row keeps its own archive time. The CTEs are one statement, so a half-revoke cannot be observed.
 *
 *  False when the connection is already revoked (its first revoke's time, cause and archive stand — and nothing is touched,
 *  since the archive leg only follows a row that THIS call revoked), another org's, or missing. This clears OUR copy only;
 *  revoking the grant at Google is the caller's separate, outside-the-lock call (global-constraints: no row lock is held
 *  across a Google call). */
export async function revokeConnection(tx: Exec, orgId: string, connectionId: string): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    with revoked as (
      update org_youtube_connections
         set refresh_token_enc = null, status = 'revoked', status_since = now(), revoked_at = now(),
             channel_id = null, channel_title = null
       where id = ${connectionId} and org_id = ${orgId} and status <> 'revoked'
      returning id
    ), archived as (
      update org_stream_targets
         set archived_at = coalesce(archived_at, now()), label = ${DISCONNECTED_LABEL}
       where youtube_connection_id in (select id from revoked) and org_id = ${orgId}
      returning id
    )
    select id from revoked`;
  return rows.length === 1;
}

/** Seal the grant's token into its pending row, between the OAuth callback and the channel pick (a multi-channel grant).
 *  A pending row that is gone is a LOUD failure — a silent no-op would lose the only copy of a token Google will not
 *  show again. */
export async function sealPendingToken(tx: Exec, pendingId: string, refreshToken: string): Promise<void> {
  const sealed = seal(refreshToken);
  const rows = await tx<{ id: string }[]>`
    update youtube_connect_pending set refresh_token_enc = ${sealed} where id = ${pendingId} returning id`;
  if (rows.length !== 1) throw new Error(`youtube connect pending ${pendingId} not found`);
}

/** TAKE a pending grant's token: returned once, and consumed (the column is nulled), so a replayed callback or a second
 *  tab cannot mint a second connection from one grant. Null for another org's pending id, a missing id, a row never
 *  sealed, or a token already taken — and a null take consumes nothing. The row is locked for the read, so two concurrent
 *  takes see exactly one token. The token is OPENED before the column is cleared: a KEK fault or a damaged envelope throws
 *  with the token still in place (an unreadable grant is left for the expiry sweep). Run inside the save's transaction:
 *  if the save then fails, the rollback restores the token. */
export async function takePendingToken(tx: Tx, orgId: string, pendingId: string): Promise<string | null> {
  const [row] = await tx<{ refresh_token_enc: Uint8Array | null }[]>`
    select refresh_token_enc from youtube_connect_pending where id = ${pendingId} and org_id = ${orgId} for update`;
  if (!row || row.refresh_token_enc === null) return null;
  const token = open(row.refresh_token_enc, pendingId);
  await tx`update youtube_connect_pending set refresh_token_enc = null where id = ${pendingId}`;
  return token;
}

/** The connection's refresh token, in memory for this request only. Null for a missing row, another org's row, or a
 *  revoked one — ONE behaviour, so a foreign id is no oracle for "this connection exists". "Revoked" needs no predicate of
 *  its own: V479's `(status = 'revoked') = (refresh_token_enc is null)` makes a revoked row exactly the row with no token.
 *  A `reconnect_needed` row still holds its (dead) token and opens. A missing or malformed YOUTUBE_TOKEN_KEK throws the
 *  KEK's own sentence; an envelope that will not open under a valid key throws `YoutubeTokenUnreadableError`. */
export async function openToken(exec: Exec, orgId: string, connectionId: string): Promise<string | null> {
  const [row] = await exec<{ refresh_token_enc: Uint8Array | null }[]>`
    select refresh_token_enc from org_youtube_connections where id = ${connectionId} and org_id = ${orgId}`;
  if (!row || row.refresh_token_enc === null) return null;
  return open(row.refresh_token_enc, connectionId);
}
