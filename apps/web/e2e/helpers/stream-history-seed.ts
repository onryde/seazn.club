// A realistic match-credit ledger for the Settings → Credits → Streaming screenshots and walkthrough, written by raw SQL
// because the writers it imitates are not reachable from a browser test (going live to spend a credit is
// stream-relay.spec.ts's journey; a Stripe claw-back is not reproducible at all).
//
// Dependency-free on purpose (types only): `src/server/usecases/__tests__/stream-history-e2e-seed.test.ts` runs THIS code
// against a real database and reads the result back through the real history reader, so the kinds this file claims to seed
// are the kinds the screen is actually shown — a seed that quietly landed on "Other change" would otherwise photograph the
// wrong thing.
//
// Everything is dated BEFORE the current UTC month, so it never touches "N of M free used this month" — the page's own
// read grants this month's credits, and that one extra row is the caller's to count (`ownRows`).
import type { Sql } from "postgres";

/** What the seed wrote, in the newest-first order the reader lists it, for the caller to assert the screen against. */
export interface StreamHistorySeed {
  /** Ledger rows written. The page's first read adds one more (this month's free grant). */
  rows: number;
  /** The history kind of each CURATED row, newest first (the bulk purchases are all `packPurchase`, listed after). */
  curatedKinds: readonly string[];
  /** The bulk older purchases, one credit each — enough to fill past one page. */
  bulk: number;
  /** The org's balance after the last row. */
  balance: number;
  /** Fixture-linked rows: the match both curated sessions were on. */
  fixtureId: string;
}

/** The curated rows, OLDEST first: a month's free grant, a bought pack, a free match streamed, the platform handing that
 *  credit back because the camera never connected, a bought credit spent, last month's free credits expiring, and a pack
 *  refunded on the card. */
const CURATED_KINDS_NEWEST_FIRST = ["packRefund", "expired", "streamUsed", "refundNoCamera", "streamUsed", "packPurchase", "monthlyGrant"] as const;

export async function seedStreamHistory(
  sql: Sql,
  a: { orgId: string; ownerId: string; fixtureId: string; bulk?: number },
): Promise<StreamHistorySeed> {
  const bulk = a.bulk ?? 30;
  const [target] = await sql<{ id: string }[]>`
    insert into org_stream_targets (org_id, kind, label, rtmp_enc)
    values (${a.orgId}, 'youtube', 'e2e history seed', ${Buffer.from("not-a-real-envelope")}) returning id`;
  const session = async (): Promise<string> => {
    const [s] = await sql<{ id: string }[]>`
      insert into fixture_stream_sessions (fixture_id, org_id, mode, state, target_id, created_by, sport_key, competition_id, division_id, entitlement_via_override)
      select f.id, ${a.orgId}, 'passthrough', 'completed', ${target!.id}, ${a.ownerId}, d.sport_key, d.competition_id, f.division_id, true
        from fixtures f join divisions d on d.id = f.division_id where f.id = ${a.fixtureId}
      returning id`;
    if (!s) throw new Error(`seedStreamHistory: no fixture ${a.fixtureId}`);
    return s.id;
  };
  const freeMatch = await session();
  const boughtMatch = await session();

  // The start of the current UTC month, as a timestamptz: every row below is dated relative to it, so none is "this month".
  const [{ monthStart }] = await sql<{ monthStart: Date }[]>`select date_trunc('month', now() at time zone 'utc') at time zone 'utc' as "monthStart"`;

  // Bulk first (oldest): `bulk` single-credit purchases a day apart, three months back, the running balance climbing 1..bulk.
  if (bulk > 0) {
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, created_at)
      select ${a.orgId}, 1, 'purchase', 'pack', g + 1, ${monthStart}::timestamptz - interval '90 days' + g * interval '1 hour'
        from generate_series(0, ${bulk - 1}) g`;
  }

  let balance = bulk;
  const row = async (
    daysBack: number,
    delta: number,
    reason: string,
    bucket: "monthly" | "pack",
    extra: { sessionId?: string; key?: string } = {},
  ): Promise<void> => {
    balance += delta;
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, session_id, idempotency_key, created_at)
      values (${a.orgId}, ${delta}, ${reason}, ${bucket}, ${balance}, ${extra.sessionId ?? null}, ${extra.key ?? null},
              ${monthStart}::timestamptz - ${daysBack} * interval '1 day')`;
  };
  await row(25, 2, "grant", "monthly");                                  // monthlyGrant
  await row(24, 5, "purchase", "pack");                                  // packPurchase
  await row(20, -1, "consume", "monthly", { sessionId: freeMatch });     // streamUsed (a free credit)
  await row(19.9, 1, "refund", "monthly", { sessionId: freeMatch });     // refundNoCamera (handed back)
  await row(12, -1, "consume", "pack", { sessionId: boughtMatch });      // streamUsed (a bought credit)
  await row(2, -2, "expire", "monthly");                                 // expired
  await row(1, -5, "revoke", "pack", { key: `stream_pack_refund:e2e-${a.orgId}` }); // packRefund

  return { rows: bulk + CURATED_KINDS_NEWEST_FIRST.length, curatedKinds: CURATED_KINDS_NEWEST_FIRST, bulk, balance, fixtureId: a.fixtureId };
}
