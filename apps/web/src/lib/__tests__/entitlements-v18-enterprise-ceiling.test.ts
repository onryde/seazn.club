// `featurePlan()`'s ENTERPRISE_FEATURES set (feature-copy.ts) hand-types
// which int-quota keys are "the ceiling on Pro" — api.write plus every int
// key whose Pro row resolves unlimited. A hand-typed list drifts silently:
// a later repricing that lifts (or lowers) a Pro cap changes which keys
// SHOULD read as enterprise-only without touching feature-copy.ts at all.
//
// This test is the guard against that drift. It derives the expected
// membership straight from the live `plan_entitlements` table — never a
// table typed into the test — per AGENTS.md's standing rule #19: derive the
// expected value from the engine/DB's own declarations, not a constant
// copied at write time.
//
// Resolver semantics this is written against (entitlements.ts, `getLimit`):
// for an int key, only `int_value` is read; `int_value = NULL` means
// unlimited. A "pure int" key — the kind `getLimit` is ever called on — has
// no `bool_value` on its row (a dual-value key like `import.bulk` carries
// both and is read through `hasFeature`, not `getLimit`, for its gate); this
// test uses that same `bool_value IS NULL` predicate to select the pure-int
// keys, matching `entitlement-admin.ts`'s own bool/int classification.
//
// Real Postgres required; skipped without DATABASE_URL (CI sets it).
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { featurePlan } from "@/lib/feature-copy";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)(
  "featurePlan's enterprise ceiling matches the live matrix (entitlements v18, V391)",
  () => {
    it("api.write is enterprise-only (never granted to a self-serve plan)", async () => {
      const [row] = await sql<{ bool_value: boolean | null }[]>`
        select bool_value from plan_entitlements
        where plan_key = 'pro' and feature_key = 'api.write'`;
      // Pro must NOT carry api.write — it is the one bool exception in
      // ENTERPRISE_FEATURES, asserted here so the int-only sweep below
      // doesn't accidentally read as the whole story.
      expect(row?.bool_value).not.toBe(true);
      expect(featurePlan("api.write")).toBe("enterprise");
    });

    it("derives the int ceiling set from the live matrix and matches featurePlan for every one", async () => {
      // Every PURE int-quota key's Pro row: bool_value IS NULL selects "this
      // row is read via int_value, not hasFeature" — the same distinction
      // entitlement-admin.ts's `groupForAdmin` draws (`sample.bool_value !==
      // null ? "bool" : "int"`). A dual-value key (bool_value AND int_value
      // both set, e.g. import.bulk/clubs.max) is excluded on purpose: its
      // gate is the bool half, so it can never be "the ceiling" in the sense
      // ENTERPRISE_FEATURES means.
      const rows = await sql<{ feature_key: string; int_value: number | null }[]>`
        select feature_key, int_value from plan_entitlements
        where plan_key = 'pro' and bool_value is null`;

      // Anti-vacuity floor: a query that silently matched nothing must not
      // pass this test by default.
      expect(rows.length).toBeGreaterThan(5);

      const ceilingKeys = rows.filter((r) => r.int_value === null).map((r) => r.feature_key);
      const nonCeilingKeys = rows.filter((r) => r.int_value !== null).map((r) => r.feature_key);

      // A case where the right answer differs from the wrong (hand-typed
      // constant's) answer on BOTH sides, so this test can actually witness
      // a regression rather than just re-confirm a list nobody would change.
      expect(ceilingKeys.length).toBeGreaterThan(0);
      expect(nonCeilingKeys.length).toBeGreaterThan(0);

      for (const key of ceilingKeys) {
        expect(featurePlan(key), `${key}: pro.int_value IS NULL, expected "enterprise"`).toBe(
          "enterprise",
        );
      }
      for (const key of nonCeilingKeys) {
        expect(featurePlan(key), `${key}: pro.int_value is finite, expected "pro"`).toBe("pro");
      }
    });

    it("matches the design doc's named ceiling set exactly (competitions.max_active, dashboard.public.max)", async () => {
      // Not a substitute for the derived sweep above — a named-set pin so a
      // reader sees at a glance which two keys are load-bearing today,
      // per the W2 brief and design §4.
      const rows = await sql<{ feature_key: string; int_value: number | null }[]>`
        select feature_key, int_value from plan_entitlements
        where plan_key = 'pro' and bool_value is null
          and feature_key in ('competitions.max_active', 'dashboard.public.max')`;
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(r.int_value).toBeNull();
    });
  },
);
