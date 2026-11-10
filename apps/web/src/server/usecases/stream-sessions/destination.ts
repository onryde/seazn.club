import "server-only";
// Where a session streams: destination row, decrypted key, target connection, replay link (see ./index.ts).
import { sql, type Tx } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { readPooledKey, readTargetSecret } from "@/server/relay/secret-columns";
import { setFixtureStreamUrl } from "../fixtures";

/** What `readSessionDestination` needs of a session: its org, its destination row and the broadcast it streams into. */
type DestinationRow = { org_id: string; target_id: string; youtube_broadcast_id: string | null };
export async function destinationRowOf(exec: Tx | typeof sql, sessionId: string): Promise<DestinationRow> {
  const [row] = await exec<DestinationRow[]>`
    select org_id, target_id, youtube_broadcast_id from fixture_stream_sessions where id = ${sessionId}`;
  if (!row) throw new Error(`stream session ${sessionId} not found`);
  return row;
}

/** YouTube Connect T11 (spec §5.2, §6.2): where a session's Cloudflare output goes, DECRYPTED for this request only. A session
 *  that names a broadcast streams to that broadcast's POOLED key (`readPooledKey`), never a key of the destination's own (an
 *  API-backed row has none); any other session to its pasted destination's key (`readTargetSecret`). Both reads are org-scoped,
 *  and the broadcast is read with a plain select and no lock: its callers (the add_output effect, which runs after `apply`'s
 *  commit, and the relay job's facts) hold no lock that the end step's broadcast → session order could cross (§6.3). A broadcast
 *  with no key cannot have been attached (`attachPrepared` matches the key), so it is refused by name, never guessed. */
export async function readSessionDestination(tx: Tx, row: DestinationRow): Promise<{ url: string; streamKey: string }> {
  if (row.youtube_broadcast_id === null) return readTargetSecret(tx, row.org_id, row.target_id);
  const [b] = await tx<{ key_id: string | null }[]>`
    select key_id from youtube_broadcasts where id = ${row.youtube_broadcast_id} and org_id = ${row.org_id}`;
  if (!b || b.key_id === null) throw new Error(`stream session: broadcast ${row.youtube_broadcast_id} has no pooled key to stream to`);
  return readPooledKey(tx, row.org_id, b.key_id);
}

/** The LOCKED destination row's source (the caller holds `lockStreamTarget`'s lock): its connection when it is API-backed, else
 *  null. What admission decides `api_backed` from (post-T3 amendment), so the session's flag and its target always agree. */
export async function targetConnectionId(tx: Tx, orgId: string, targetId: string): Promise<string | null> {
  const [t] = await tx<{ connection_id: string | null }[]>`
    select youtube_connection_id as connection_id from org_stream_targets where id = ${targetId} and org_id = ${orgId}`;
  return t?.connection_id ?? null;
}

/** Ruling F / design §12.6: on completed, when fixtures.stream_url is null and
 *  the destination is YouTube with a watch URL, write it through the ONE
 *  stream-link path. Never overwrites a club's own link. */
export async function fillReplayUrl(sessionId: string): Promise<void> {
  const [row] = await sql<{ fixture_id: string; org_id: string; created_by: string; kind: string; watch_url: string | null; stream_url: string | null }[]>`
    select s.fixture_id, s.org_id, s.created_by, t.kind, t.watch_url, f.stream_url
      from fixture_stream_sessions s
      join org_stream_targets t on t.id = s.target_id
      join fixtures f on f.id = s.fixture_id
     where s.id = ${sessionId}`;
  if (!row || row.stream_url !== null || row.kind !== "youtube" || !row.watch_url) return;
  const actor: AuthCtx = { orgId: row.org_id, via: "session", userId: row.created_by, role: "owner", keyId: null };
  await setFixtureStreamUrl(actor, row.fixture_id, row.watch_url);
}
