// A pass whose credit grant FAILS still busts the entitlement cache (Task 14b re-review N3).
//
// `recordPassPurchase` commits the `competition_passes` row BEFORE it grants anything (the AI credits, then — since
// addendum P — the match credits). The winning arm used to invalidate the org's cached entitlements only AFTER both
// grants, so a grant that threw left the pass recorded while the cache still answered "no pass" until Stripe's retry
// reached the replay arm's unconditional invalidate. The pass must take effect the moment it is recorded, whatever the
// grants do after it.
//
// Real Postgres for the pass row; the two seams are doubled at the function: the org's cache bust (a spy) and the
// match-credit grant (made to throw). Skipped without DATABASE_URL.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const seams = vi.hoisted(() => ({
  invalidate: vi.fn<(orgId: string) => Promise<void>>(async () => undefined),
  streamGrant: vi.fn<(args: { orgId: string; passKey: string; anchor: string }) => Promise<number>>(),
}));
vi.mock("@/lib/entitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/entitlements")>()),
  invalidateOrgEntitlements: (orgId: string) => seams.invalidate(orgId),
}));
vi.mock("@/server/usecases/stream-credits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/usecases/stream-credits")>()),
  grantPassStreamCredits: (args: { orgId: string; passKey: string; anchor: string }) => seams.streamGrant(args),
}));

import { sql } from "@/lib/db";
import { recordPassPurchase } from "@/lib/billing";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function seedPassBuyer(): Promise<{ orgId: string; compId: string }> {
  const suffix = uniq();
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Inval Org " + suffix}, ${"inval-org-" + suffix}) returning id`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug) values (${orgId}, ${"Inval Cup " + suffix}, ${"inval-cup-" + suffix}) returning id`;
  return { orgId, compId };
}

beforeEach(() => {
  seams.invalidate.mockClear();
  seams.streamGrant.mockReset();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("N3: the winning arm busts the cache even when a grant throws", () => {
  it("a THROWING match-credit grant still invalidates the org's entitlements — the pass row is already recorded", async () => {
    const { orgId, compId } = await seedPassBuyer();
    seams.streamGrant.mockRejectedValue(new Error("stream grant down"));

    await expect(
      recordPassPurchase({ orgId, competitionId: compId, passKey: "event_pass", paymentIntent: "pi_inval_" + uniq() }),
    ).rejects.toThrow("stream grant down");

    const [pass] = await sql`select 1 from competition_passes where competition_id = ${compId}`;
    expect(pass, "premise: the pass was recorded before the grant threw").toBeDefined();
    expect(seams.streamGrant, "premise: the throwing grant was reached").toHaveBeenCalledTimes(1);
    expect(seams.invalidate.mock.calls).toEqual([[orgId]]);
  });

  it("the positive pair: a grant that succeeds invalidates exactly once too", async () => {
    const { orgId, compId } = await seedPassBuyer();
    seams.streamGrant.mockResolvedValue(1);

    const res = await recordPassPurchase({ orgId, competitionId: compId, passKey: "event_pass", paymentIntent: "pi_inval_" + uniq() });
    expect(res.recorded).toBe(true);
    expect(seams.streamGrant).toHaveBeenCalledTimes(1);
    expect(seams.invalidate.mock.calls).toEqual([[orgId]]);
  });
});
