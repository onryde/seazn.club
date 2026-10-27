import "server-only";
// server/youtube/connect-flow.ts — the database half of the OAuth connect round trip (plan T7). The routes under
// app/api/youtube/connect/ orchestrate; every statement they run against `youtube_connect_pending` or read to decide a
// refusal lives here, so the single-use rule and the "never revoke a grant a live connection uses" rule each have one home.
//
// Never named here: the sealed token column. token-store.ts is its only owner (enc-boundary.test.ts); the callback seals
// through `sealPendingToken` and the save takes through `takePendingToken`.
import { createHash, randomUUID } from "node:crypto";
import { sql, type Tx } from "@/lib/db";
import type { OrgRole } from "@/lib/types";
import type { YoutubePrivacy } from "@/lib/youtube";
import { hasValidKek, type KekName } from "@/server/relay/crypto";

/** How long a connect attempt lives: the cookies' Max-Age and the pending row's expiry are this one number. */
export const PENDING_LIFETIME_SECONDS = 600;

/** The keys the callback needs: YOUTUBE_TOKEN_KEK seals the refresh token, and RELAY_KEK seals the stream keys the
 *  connection will later pool. A grant made while either is unusable could not be kept, so the start refuses first. */
const CONNECT_KEKS: readonly KekName[] = ["YOUTUBE_TOKEN_KEK", "RELAY_KEK"];
/** The names (never values) of the keys that cannot seal right now: unset or malformed. Empty when the flow can proceed. */
export function unusableConnectKeys(): KekName[] {
  return CONNECT_KEKS.filter((k) => !hasValidKek(k));
}

const stateHash = (state: string): string => createHash("sha256").update(state).digest("hex");

/** The intent of one connect attempt, recorded BEFORE Google is asked (plan P10: never in a cookie or a URL). Keyed by
 *  sha256(state); expires `PENDING_LIFETIME_SECONDS` after the consent. */
export async function insertPending(a: {
  state: string; orgId: string; userId: string; connectionId: string | null; privacy: YoutubePrivacy; madeForKids: boolean;
  consentVersion: number; now: Date;
  /** When the consent was given, if not now: a reconnect that carries the connection's own consent forward (D7). */
  consentAt?: Date;
}): Promise<{ id: string }> {
  const expiresAt = new Date(a.now.getTime() + PENDING_LIFETIME_SECONDS * 1000);
  const [row] = await sql<{ id: string }[]>`
    insert into youtube_connect_pending (
      state_hash, org_id, user_id, connection_id, default_privacy, made_for_kids, consent_version, consent_at, expires_at
    ) values (
      ${stateHash(a.state)}, ${a.orgId}, ${a.userId}, ${a.connectionId}, ${a.privacy}, ${a.madeForKids}, ${a.consentVersion}, ${a.consentAt ?? a.now}, ${expiresAt}
    ) returning id`;
  return { id: row!.id };
}

export interface ClaimedPending { id: string; orgId: string; userId: string; connectionId: string | null }

/** SPEND the state: ONE statement finds the live, unexpired pending row of this state AND of this user, and re-keys it to a
 *  value no state can hash to. The first caller gets the row; a replay (back button, a second tab, a double tap) finds
 *  nothing — Review Focus 2. The row itself survives (a multi-channel grant keeps its sealed token on it until the pick), but
 *  the state that opened it is gone. Null: unknown, spent, expired, or another user's — and a null claim changes nothing. */
export async function claimPending(state: string, userId: string): Promise<ClaimedPending | null> {
  const [row] = await sql<{ id: string; org_id: string; user_id: string; connection_id: string | null }[]>`
    update youtube_connect_pending
       set state_hash = ${`spent:${randomUUID()}`}
     where state_hash = ${stateHash(state)} and user_id = ${userId} and expires_at > now()
    returning id, org_id, user_id, connection_id`;
  return row ? { id: row.id, orgId: row.org_id, userId: row.user_id, connectionId: row.connection_id } : null;
}

/** The pending grant is over: its row — and any token sealed on it — goes. */
export async function dropPending(id: string): Promise<void> {
  await sql`delete from youtube_connect_pending where id = ${id}`;
}

/** What the grant is, kept on the pending row for the pick and the save (T8). Non-secret columns only; the token is sealed
 *  separately, in the same transaction, by token-store's `sealPendingToken`. */
export async function storeGrant(
  tx: Tx,
  id: string,
  g: { grantedScope: string; googleSub: string | null; channels: { id: string; title: string }[] },
): Promise<void> {
  await tx`
    update youtube_connect_pending
       set granted_scope = ${g.grantedScope}, google_sub = ${g.googleSub}, channels = ${tx.json(g.channels)}
     where id = ${id}`;
}

/** The user's role in the org RIGHT NOW. A direct read, deliberately not `getOrgRole`: that is cached for 120 s, and the
 *  callback is the moment a role that was just taken away must not still count. */
export async function roleNow(orgId: string, userId: string): Promise<OrgRole | null> {
  const [row] = await sql<{ role: OrgRole }[]>`select role from org_members where org_id = ${orgId} and user_id = ${userId}`;
  return row?.role ?? null;
}

/** The live connection a reconnect is for: this org's, not revoked. Its channel is the only channel the new grant may be for;
 *  its consent record is what a reconnect may carry forward (D7: one consent per connection). Null for a missing, another
 *  org's or a revoked connection — one answer, so a foreign id is no oracle. */
export async function reconnectTarget(
  orgId: string, connectionId: string,
): Promise<{ channelId: string; consentVersion: number; consentAt: Date } | null> {
  const [row] = await sql<{ channel_id: string | null; consent_version: number; consent_at: Date }[]>`
    select channel_id, consent_version, consent_at from org_youtube_connections
     where id = ${connectionId} and org_id = ${orgId} and status <> 'revoked'`;
  return row?.channel_id ? { channelId: row.channel_id, consentVersion: row.consent_version, consentAt: row.consent_at } : null;
}

/** Does a live connection, in ANY org, already use this grant? Revoking a grant at Google ends every token of that Google
 *  account for this client, so a grant whose channel is connected somewhere (V479's one-live-channel is global), or whose
 *  Google account backs another live connection, must be left alone: revoking it would kill that connection. */
export async function grantInUse(channelIds: readonly string[], googleSub: string | null): Promise<boolean> {
  const rows = await sql<{ one: number }[]>`
    select 1 as one from org_youtube_connections
     where status <> 'revoked'
       and (channel_id = any(${channelIds as string[]}::text[]) or (${googleSub}::text is not null and google_sub = ${googleSub}))
     limit 1`;
  return rows.length > 0;
}
