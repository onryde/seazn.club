// Break an ACTIVE stream code's sealed envelope, for tests that live OUTSIDE server/relay/**. enc-boundary.test.ts (claim 2)
// bars every file outside server/relay/** from naming a stream `*_enc` column — test files included — so a usecase test
// cannot spell `tok_enc` itself. One byte is not an envelope, so the next read of the code (`openStreamCodeTok`) fails to open
// it and the ensure ENDS that code as reissued and mints a fresh one: the path the nudge tests drive.
import { sql } from "@/lib/db";

export async function corruptActiveCodeEnvelope(where: { fixtureId: string } | { courtLinkId: string }): Promise<void> {
  const rows = "fixtureId" in where
    ? await sql`update fixture_stream_codes set tok_enc = decode('00', 'hex') where fixture_id = ${where.fixtureId} and ended_at is null returning id`
    : await sql`update fixture_stream_codes set tok_enc = decode('00', 'hex') where court_link_id = ${where.courtLinkId} and ended_at is null returning id`;
  if (rows.length !== 1) throw new Error(`corruptActiveCodeEnvelope: expected exactly one active code, corrupted ${rows.length}`);
}
