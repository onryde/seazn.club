// v17 Phase-2 final-review IMPORTANT 2: createOrgForUser used to insert the
// org + its (group-of-one) subscription row and stop there — the new wallet
// sat empty until the daily billing-grant cron (grantMonthlyForAllWallets)
// next ran, up to 24h later. A brand-new Community org would 402
// ({featureKey: "ai.credits"}) on its very first AI Schedule/Officials
// attempt, worse than the old free per-division cap it replaced. Fix:
// createOrgForUser now grants the org's current-period monthly credits
// (community = 10) synchronously, right after the org/subscription/member
// rows commit. grantMonthly's own `(wallet_id, period)` idempotency key means
// the daily cron catching the same wallet later in the same calendar month is
// a no-op, not a double grant.
//
// Real Postgres required; skipped without DATABASE_URL. Run against the
// fresh v17 schema: DATABASE_URL=$(cat /tmp/v17_base_url) DB_SCHEMA=seazn_club_v17.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

// createOrgForUser calls invalidateUserOrgs; no Redis needed for this test,
// and getLimit's/grantMonthly's entitlement reads must hit the DB directly,
// not a stale cache (same setup as org-create-concurrency.test.ts).
import { vi } from "vitest";
vi.mock("@/lib/cache", () => ({
  cacheEnabled: () => false,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDelPattern: async () => {},
  incrWindow: async () => 1,
}));

import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { balance, grantMonthlyForAllWallets, walletIdFor } from "@/lib/credits";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

/** Community's `ai.credits.monthly`, READ from the live matrix — the bootstrap
 *  grant is whatever the matrix says, and a typed number (V320 10 -> V392 5)
 *  turns this suite red for the wrong reason on every re-tune. */
async function communityRate(): Promise<number> {
  const [row] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
     where plan_key = 'community' and feature_key = 'ai.credits.monthly'`;
  expect(row?.int_value, "community must carry an ai.credits.monthly row").toBeTypeOf("number");
  return row!.int_value!;
}

async function makeUser(): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`bootstrap-${uniq()}@test.local`}, 'Bootstrap Owner', true) returning id`;
  return id;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("createOrgForUser — AI credit wallet bootstrap grant", () => {
  it("a freshly-created Community org has its monthly credits immediately (no 402 on first AI attempt)", async () => {
    const userId = await makeUser();
    const org = await createOrgForUser(userId, "Fresh Org");

    const walletId = await walletIdFor(org.id);
    expect(await balance(walletId)).toBe(await communityRate());
  });

  it("the daily cron run in the same calendar month is a no-op for the bootstrap-granted wallet", async () => {
    const userId = await makeUser();
    const org = await createOrgForUser(userId, "Fresh Org Two");
    const walletId = await walletIdFor(org.id);
    const flat = await communityRate();
    expect(await balance(walletId)).toBe(flat);

    await grantMonthlyForAllWallets();

    // Same idempotency key (`monthly:${walletId}:${period}`) as the bootstrap
    // call, so the balance stays at one month's allowance, never doubled.
    //
    // Since #390 it stays put for a BETTER reason than it used to. The cron no
    // longer opens this wallet at all: the sweep's `not exists` anti-join sees
    // the bootstrap grant's key for this period and never selects the row, so
    // there is no per-wallet resolve, no advisory lock and no transaction to
    // discover the no-op inside. The outcome asserted here is unchanged —
    // that is the point — but the work behind it is gone.
    expect(await balance(walletId)).toBe(flat);
  });
});
