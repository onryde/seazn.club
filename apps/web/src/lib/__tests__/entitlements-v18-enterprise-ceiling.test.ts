// `featurePlan()` answers ONE question: what is the CHEAPEST plan that
// unlocks this feature key? (`feature-copy.ts`.) The paywall UI turns that
// answer into either a priced "Go Pro" link or a "Contact us" mailto, so
// getting it wrong does not fail loudly — it quietly removes the customer's
// self-serve route out of a paywall.
//
// THIS TEST EXISTS BECAUSE ITS PREVIOUS VERSION PINNED THE BUG.
// The first cut derived "every int key whose Pro row is unlimited
// (`int_value IS NULL`) must read as enterprise" — which is backwards, and
// the design doc states it in the same backwards form. If Pro is already
// unlimited then Pro IS the cheapest plan that unlocks the key. Deriving an
// expectation from the database does not help when the DERIVATION RULE is
// wrong: the test agreed with the code, both were wrong together, and a
// Community organiser hitting the 3-competition cap was shown an
// `Enterprise ◆` badge with no price. Found by review, not by this file.
//
// The rule asserted here instead:
//   enterprise  ⟺  no self-serve plan grants it at all
// A finite Pro cap is still an unlock (Free 3 → Pro unlimited is exactly the
// upgrade the gate should sell), so every int key is "pro". Only a key that
// community AND pro both refuse, and enterprise grants, is "enterprise".
//
// Derived live from `plan_entitlements` per AGENTS.md #19, never a table
// typed in here — but note the lesson above: derivation is only as good as
// the rule being derived. Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { featurePlan } from "@/lib/feature-copy";

const HAS_DB = !!process.env.DATABASE_URL;

interface Row {
  feature_key: string;
  plan_key: string;
  bool_value: boolean | null;
  int_value: number | null;
}

describe.skipIf(!HAS_DB)("featurePlan names the cheapest unlocking plan (entitlements v18)", () => {
  it("every key a self-serve plan grants reads as pro, and only the rest read as enterprise", async () => {
    const rows = await sql<Row[]>`
      select feature_key, plan_key, bool_value, int_value from plan_entitlements
      where plan_key in ('community', 'pro', 'enterprise')`;

    // Anti-vacuity floor: a query that silently matched nothing, or a schema
    // change that renamed a column, must not pass this test by default.
    expect(rows.length).toBeGreaterThan(100);

    const byKey = new Map<string, Map<string, Row>>();
    for (const r of rows) {
      if (!byKey.has(r.feature_key)) byKey.set(r.feature_key, new Map());
      byKey.get(r.feature_key)!.set(r.plan_key, r);
    }

    // "Pro grants it" means: a bool Pro actually carries (=== true, matching
    // `hasFeature`'s strict check), or ANY int row — a finite Pro cap is
    // still the cheapest paid unlock relative to Free's smaller one.
    const proGrants = (k: string): boolean => {
      const pro = byKey.get(k)?.get("pro");
      if (!pro) return false;
      return pro.bool_value === true || pro.int_value !== null || pro.bool_value === null;
    };

    const expectedEnterprise: string[] = [];
    const expectedPro: string[] = [];
    for (const key of byKey.keys()) (proGrants(key) ? expectedPro : expectedEnterprise).push(key);

    // Both sides must be non-empty, or one branch of the ladder is never
    // exercised and a reorder/emptying mutant survives.
    expect(expectedEnterprise.length).toBeGreaterThan(0);
    expect(expectedPro.length).toBeGreaterThan(10);

    const wrong: string[] = [];
    for (const key of expectedPro) {
      if (featurePlan(key) !== "pro") wrong.push(`${key}: pro grants it, expected "pro"`);
    }
    for (const key of expectedEnterprise) {
      if (featurePlan(key) !== "enterprise") {
        wrong.push(`${key}: no self-serve plan grants it, expected "enterprise"`);
      }
    }
    expect(wrong, `featurePlan disagrees with the live matrix:\n  ${wrong.join("\n  ")}`).toEqual(
      [],
    );
  });

  it("a Pro cap that is UNLIMITED still reads as pro — the exact regression this file was rewritten for", async () => {
    // The case where the right answer differs from the wrong answer's
    // constant. Both keys resolve unlimited on Pro (int_value IS NULL), which
    // the retired rule read as "enterprise". A Community org hits both of
    // these on the ordinary create path, so they must offer a PRICE.
    const rows = await sql<Row[]>`
      select feature_key, plan_key, bool_value, int_value from plan_entitlements
      where plan_key = 'pro'
        and feature_key in ('competitions.max_active', 'dashboard.public.max')`;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.int_value, `${r.feature_key} is expected to be unlimited on Pro`).toBeNull();
      expect(featurePlan(r.feature_key), `${r.feature_key} must sell Pro, not Contact us`).toBe(
        "pro",
      );
    }
  });

  it("api.write is the enterprise key, and it is enterprise because NO self-serve plan carries it", async () => {
    const rows = await sql<Row[]>`
      select feature_key, plan_key, bool_value, int_value from plan_entitlements
      where feature_key = 'api.write'`;
    const by = new Map(rows.map((r) => [r.plan_key, r]));
    // The REASON, not just the answer: assert the premise that makes
    // "enterprise" correct, so if a later wave grants api.write to Pro this
    // test fails rather than silently continuing to send people to a mailto.
    expect(by.get("community")?.bool_value).not.toBe(true);
    expect(by.get("pro")?.bool_value).not.toBe(true);
    expect(by.get("enterprise")?.bool_value).toBe(true);
    expect(featurePlan("api.write")).toBe("enterprise");
  });

  it("an unknown key falls to pro, the deliberate default of a contains-ladder", () => {
    // The empty/unknown case stated explicitly: a contains-ladder answers
    // "no" to every rung for a key it has never heard of, and that default
    // must be the safe one — offer a price, never a dead-end mailto.
    expect(featurePlan("not.a.real.feature.key")).toBe("pro");
  });
});
