// `streaming.overlay` and `streaming.relay` (R1, then Task 14b's V426, owner-approved 2026-09-29: "even community can
// do livestreaming by default"): granted by EVERY plan, still hidden from /pricing by being absent from
// ENTITLEMENT_DOMAINS, and switched OFF for one org by an override row — which is now the ONLY way a streaming gate
// appears.
//
// Two halves on purpose. The catalogue half is a pure unit — it is the thing a
// later "tidy the domains list" edit would break silently. The resolver half is
// DB-backed, because "true for a fresh org, false after an override" is a claim
// about the real resolver's precedence (entitlements.ts: override first),
// not about a constant.
//
// Every expectation is DERIVED from the live matrix (the `plans` table and V426's rows), never a plan list typed here:
// a tier added later is covered the day it lands, and a count of zero is a failure, not a pass.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";
import { ENTITLEMENT_DOMAINS } from "@/lib/entitlement-domains";
import { seedOrg } from "@/server/usecases/__tests__/_rig";

const HAS_DB = !!process.env.DATABASE_URL;
const KEY = "streaming.overlay";
const STREAM_KEYS = ["streaming.overlay", "streaming.relay"] as const;
/** V426: the numeric plan entitlement that sizes each plan's free match credits per month. */
const MONTHLY = "streaming.credits.monthly";

async function setOverride(orgId: string, key: string, value: boolean): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
    values (${orgId}, ${key}, ${value}, ${"unit: stream overlay " + randomUUID().slice(0, 6)})
    on conflict (org_id, feature_key) do update set bool_value = ${value}, expires_at = null`;
  await invalidateOrgEntitlements(orgId);
}

describe("streaming.overlay is unadvertised", () => {
  it("is in NO ENTITLEMENT_DOMAINS section — that omission is what keeps it off /pricing (Task 14b: /pricing is an owner question, out of scope)", () => {
    const listed = ENTITLEMENT_DOMAINS.flatMap((d) => d.features);
    for (const key of [...STREAM_KEYS, MONTHLY]) expect(listed, key).not.toContain(key);
  });

  it("the domains list is otherwise untouched by this wave", () => {
    // A positive pair for the negative above: if a future edit deleted the
    // whole list, the assertion above would pass vacuously.
    expect(ENTITLEMENT_DOMAINS.length).toBeGreaterThanOrEqual(5);
    expect(ENTITLEMENT_DOMAINS.flatMap((d) => d.features)).toContain("embeds.enabled");
  });
});

describe.skipIf(!HAS_DB)("streaming on every plan (V426)", () => {
  it.each(STREAM_KEYS)("carries a catalogue row for EVERY plan for %s, and every one is TRUE", async (key) => {
    const rows = await sql<{ plan_key: string; bool_value: boolean | null }[]>`
      select plan_key, bool_value from plan_entitlements where feature_key = ${key}`;
    const plans = await sql<{ key: string }[]>`select key from plans`;
    // Anti-vacuity: zero plans would make every "is true" below pass on nothing.
    expect(plans.length, "the plans table is empty — nothing was checked").toBeGreaterThan(0);
    expect(rows.map((r) => r.plan_key).sort(), "one row per plan, no plan missing").toEqual(plans.map((p) => p.key).sort());
    let checked = 0;
    for (const row of rows) {
      expect(row.bool_value, `${key} on ${row.plan_key}`).toBe(true);
      checked++;
    }
    expect(checked).toBe(plans.length);
  });

  it(`carries ${MONTHLY} for EVERY plan as a numeric row (bool null, int ≥ 1) — the ai.credits.monthly storage shape — and the ladder the owner approved rises with the tier`, async () => {
    const rows = await sql<{ plan_key: string; bool_value: boolean | null; int_value: number | null }[]>`
      select plan_key, bool_value, int_value from plan_entitlements where feature_key = ${MONTHLY}`;
    const plans = await sql<{ key: string }[]>`select key from plans`;
    expect(plans.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.plan_key).sort(), "one row per plan: a plan without one would grant nothing, silently").toEqual(
      plans.map((p) => p.key).sort(),
    );
    const by = new Map(rows.map((r) => [r.plan_key, r]));
    let checked = 0;
    for (const row of rows) {
      expect(row.bool_value, `${row.plan_key}: a numeric key, like ai.credits.monthly`).toBeNull();
      expect(row.int_value, `${row.plan_key}: every plan streams by default, so every plan grants at least one`).toBeGreaterThanOrEqual(1);
      checked++;
    }
    expect(checked).toBe(plans.length);
    // The L pass never grants fewer than the M pass. The pass VALUES are pinned as literals where the pass grant is
    // tested (billing-pass-stream-credits.test.ts); the subscription plans' values are pinned in the next test.
    const n = (k: string) => by.get(k)!.int_value!;
    expect(n("event_pass_l")).toBeGreaterThan(n("event_pass"));
  });

  // I-3 (lane-close review): the owner's monthly numbers, as LITERALS. Every other suite reads the expected grant from
  // these same V426 rows (stream-credits-monthly.test.ts through `streamMonthlyRate`), so a typo in the migration — pro
  // at 50 — would move the code and every one of those expectations together and leave them all green. This is money
  // the owner ruled (2026-09-29: community 1, pro 5, enterprise 20), and for a ruled number the literal IS the rulebook.
  it(`the owner's ${MONTHLY} for the three subscription plans: community 1, pro 5, enterprise 20 — literals, never read back from the rows under test`, async () => {
    const OWNER_RULED = { community: 1, pro: 5, enterprise: 20 } as const;
    const rows = await sql<{ plan_key: string; int_value: number | null }[]>`
      select plan_key, int_value from plan_entitlements
       where feature_key = ${MONTHLY} and plan_key in ${sql(Object.keys(OWNER_RULED))}`;
    const got = Object.fromEntries(rows.map((r) => [r.plan_key, r.int_value]));
    // Anti-vacuity: a plan whose row is missing would drop out of `got` and fail the equality below, but say so first.
    expect(rows.length, "one V426 row per owner-ruled plan").toBe(Object.keys(OWNER_RULED).length);
    expect(got).toEqual(OWNER_RULED);
  });

  it("is TRUE for a fresh (community) org with no override, and an override row switches it OFF — the only way a gate appears now", async () => {
    const { auth } = await seedOrg();
    for (const key of STREAM_KEYS) expect(await hasFeature(auth.orgId, key), `${key}: the plan grants it`).toBe(true);

    // The sibling negative: a staff override set to false wins over the plan's true, per key.
    await setOverride(auth.orgId, KEY, false);
    expect(await hasFeature(auth.orgId, KEY), "the resolver ranks the override first").toBe(false);
    expect(await hasFeature(auth.orgId, "streaming.relay"), "an overlay override leaves the relay on the plan").toBe(true);
    await setOverride(auth.orgId, "streaming.relay", false);
    expect(await hasFeature(auth.orgId, "streaming.relay")).toBe(false);

    // And back: deleting the override hands the org back to its plan, so the flip is real in both directions.
    await sql`delete from org_entitlement_overrides where org_id = ${auth.orgId} and feature_key in ${sql([...STREAM_KEYS])}`;
    await invalidateOrgEntitlements(auth.orgId);
    for (const key of STREAM_KEYS) expect(await hasFeature(auth.orgId, key), `${key} after the override is gone`).toBe(true);
  });

  it("an override does not leak into another org", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    await setOverride(a.auth.orgId, KEY, false);
    expect(await hasFeature(a.auth.orgId, KEY), "the override switched A off").toBe(false);
    expect(await hasFeature(b.auth.orgId, KEY), "B is still on its plan").toBe(true);
  });
});
