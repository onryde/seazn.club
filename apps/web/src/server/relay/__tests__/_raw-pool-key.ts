// A raw pooled-key row, for tests that live OUTSIDE server/relay/**. enc-boundary.test.ts (claim 2) bars every file
// outside server/relay/** from naming a stream `*_enc` column — test files included — so a schema test elsewhere
// (server/youtube/__tests__/migration.test.ts) cannot spell `pool_rtmp_enc` itself. The real writer is T2's
// `insertPooledKey` in secret-columns.ts, which seals under RELAY_KEK; this one stores FAKE bytes that are never
// opened, which is all a constraint test needs.
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";

export async function insertRawPoolKey(a: { orgId: string; connectionId: string; slot: number; liveStreamId: string }): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into youtube_stream_keys (org_id, connection_id, slot, live_stream_id, pool_rtmp_enc)
    values (${a.orgId}, ${a.connectionId}, ${a.slot}, ${a.liveStreamId}, ${Buffer.from(`not-a-real-envelope-${randomUUID()}`)})
    returning id`;
  return row!.id;
}
