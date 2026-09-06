// The retirement guards that outlived their original test files.
//
// `pro-plus-matrix.test.ts` (V290) and `v17-phase1-matrix.test.ts` (V319) were
// deleted by entitlements v18 (W2 T7): every value they pinned is a V393 value
// now, and `entitlements-v18-matrix.test.ts` pins the whole live matrix
// cell-for-cell against the design doc's own §2 markdown — including a literal
// "expected NO ROW" for every "–" cell on every plan, which is what used to
// make the "org-wide caps must not be pass-lifted" case worth its own test.
//
// What that pin does NOT cover is this file's subject: keys and plans retired
// by EARLIER waves, which §2 does not mention at all because they were already
// gone when it was written. A key §2 never names cannot be pinned by parsing
// §2. Those are live regression guards — "a thing we removed stays removed" —
// so they are preserved here rather than deleted along with their old homes.
//
// Deliberately absence-only. Anything with a live value belongs in the §2 pin.
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { ALL_PLAN_KEYS } from "@/lib/currency";

const HAS_DB = !!process.env.DATABASE_URL;

/**
 * Feature keys deleted by an earlier wave, each with the migration that took
 * it. A hand-written list is unavoidable: a retired key is by definition
 * absent from every runtime source of truth, so there is nothing to derive it
 * from. It is safe to hand-write only because the assertion is one-directional
 * — it can fail when a key comes back, never when a new one is retired.
 */
const RETIRED_FEATURE_KEYS: readonly { key: string; retiredBy: string }[] = [
  { key: "public_pages", retiredBy: "V319 (#246) — dead key, nothing read it" },
  { key: "eligibility.enforced", retiredBy: "V319 (#246) — dead key, nothing read it" },
  { key: "officials.assignment", retiredBy: "V290 (D5) — superseded by officials.auto" },
  {
    key: "scheduling.ai.runs_per_division.max",
    retiredBy: "V322 (v17 Phase 2 Task 5) — the AI credit wallet meters spend now, not a plan-graded per-division count",
  },
];

/**
 * Plan keys deleted by an earlier wave. `pro_plus` is NOT here: it is v18's
 * own retirement, and `entitlements-v18-matrix.test.ts` owns it.
 */
const RETIRED_PLAN_KEYS: readonly { key: string; retiredBy: string }[] = [
  { key: "business", retiredBy: "V290 — folded into pro_plus, itself retired by V393" },
  { key: "pro_plus", retiredBy: "V393 (entitlements v18) — replaced by enterprise" },
];

describe.skipIf(!HAS_DB)("retired entitlement keys and plans stay retired", () => {
  // ANTI-VACUITY. Every assertion below is an absence, and an empty table
  // satisfies all of them. A truncated `plan_entitlements` — the exact shape a
  // half-applied migration leaves — would otherwise turn this whole file green
  // while the matrix was gone.
  it("is running against a populated matrix (anti-vacuity floor)", async () => {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from plan_entitlements`;
    expect(row!.n, "plan_entitlements is empty — every absence assertion below would pass vacuously").toBeGreaterThan(100);
    const [live] = await sql<{ n: number }[]>`
      select count(*)::int as n from plan_entitlements where feature_key = 'registration.fee_percent'`;
    expect(live!.n, "a known-live key is missing — the matrix is not seeded").toBeGreaterThan(0);
  });

  it.each(RETIRED_FEATURE_KEYS)("$key has no plan_entitlements row on any plan — $retiredBy", async ({ key }) => {
    const rows = await sql<{ plan_key: string }[]>`
      select plan_key from plan_entitlements where feature_key = ${key}`;
    expect(rows, `${key} came back on: ${rows.map((r) => r.plan_key).join(", ")}`).toEqual([]);
  });

  it.each(RETIRED_PLAN_KEYS)("$key is gone from plans AND from plan_entitlements — $retiredBy", async ({ key }) => {
    const [plan] = await sql<{ n: number }[]>`select count(*)::int as n from plans where key = ${key}`;
    const [ents] = await sql<{ n: number }[]>`
      select count(*)::int as n from plan_entitlements where plan_key = ${key}`;
    expect(plan!.n, `the ${key} plan row is back`).toBe(0);
    // The FK on plan_entitlements would normally make this redundant. It is
    // asserted anyway because the two deletes are separate statements in V393
    // and a partial run is the failure this guard exists to name.
    expect(ents!.n, `${key} entitlement rows are back`).toBe(0);
  });

  // The complement of the two lists above: the plans that DO exist. Derived
  // from `ALL_PLAN_KEYS` rather than typed here, so adding a plan to the code
  // without seeding it (or seeding one the code does not know) is a failure
  // rather than a silent divergence. This is what catches a retired plan
  // coming back under a name nobody thought to add to RETIRED_PLAN_KEYS.
  it("the live plans table is exactly the plan keys the code knows about", async () => {
    const rows = await sql<{ key: string }[]>`select key from plans`;
    expect(rows.length, "no plans rows at all").toBeGreaterThan(0);
    expect([...rows.map((r) => r.key)].sort()).toEqual([...ALL_PLAN_KEYS].sort());
  });
});
