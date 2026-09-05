// Every "Pro `key`" / "Pro Plus `key`" in a published summary is a PRICING
// CLAIM, read by customers deciding what to buy. Nothing checked them until
// this file: `openapi-published.test.ts` asserts subset, scope and examples,
// never whether a claim matches the entitlement matrix.
//
// It went wrong in both directions at once. Eleven summaries were false on
// 2026-09-05: `clubs.hierarchy` (4), `officials.marks` (3) and
// `officials.roles_multi` (1) were billed Pro-only while every plan grants
// them, and `officials.auto` (3) was billed Pro while only Pro Plus carried
// it — so a Pro subscriber followed the published doc to three endpoints and
// got 402. The same class was live in `content/help/directory/clubs-and-teams.md`
// at 9 of 12 cells. Hand-written plan claims with nothing checking them.
//
// The catalog is the authority, never a table typed in here: the assertions
// below read `plan_entitlements` at run time, so a re-valuation moves this
// test with it. That happened immediately — entitlements v18 (migration
// V393) granted `officials.auto` to `pro`, deleted the `pro_plus` plan
// outright, and made `tiebreakers.custom` free on `community` too. That red
// the Pro/Pro Plus claims here and forced three summaries to be rewritten
// (`officials/auto`, `officials/apply`, `officials/source` now say Pro; the
// standings-override summary drops its plan name entirely since the feature
// has none). The Pro Plus test below no longer compares against `pro_plus`
// at all — the plan has no rows to compare against — and instead asserts no
// published summary may use the wording again.
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { buildOpenApiDocument } from "../openapi";

const HAS_DB = !!process.env.DATABASE_URL;

/** Every `(Pro|Pro Plus) \`feature.key\`` claim in a published summary. */
function planClaims(
  doc: Record<string, unknown>,
): { where: string; plan: string; key: string }[] {
  const out: { where: string; plan: string; key: string }[] = [];
  for (const [path, methods] of Object.entries(
    doc.paths as Record<string, Record<string, { summary?: string }>>,
  )) {
    for (const [method, op] of Object.entries(methods)) {
      for (const m of (op.summary ?? "").matchAll(
        /(Pro Plus|Pro) `([a-z_.]+)`/g,
      )) {
        out.push({
          where: `${method.toUpperCase()} ${path}`,
          plan: m[1],
          key: m[2],
        });
      }
    }
  }
  return out;
}

/** Plans whose matrix grants `key` as a boolean feature. */
async function grantedOn(key: string): Promise<Set<string>> {
  const rows = await sql<{ plan_key: string }[]>`
    select plan_key from plan_entitlements
    where feature_key = ${key} and bool_value is true`;
  return new Set(rows.map((r) => r.plan_key));
}

describe.skipIf(!HAS_DB)(
  "published OpenAPI plan claims match the entitlement matrix",
  () => {
    const claims = planClaims(buildOpenApiDocument({ published: true }));

    // Without this the suite is vacuous: a regex that stops matching (a summary
    // reworded to "Pro-only", say) would leave zero claims and pass silently.
    it("finds plan claims to check at all", () => {
      expect(
        claims.length,
        "no `Pro \\`key\\`` claims parsed — the regex has drifted",
      ).toBeGreaterThan(5);
    });

    it("every claimed feature key exists in the matrix", async () => {
      for (const { where, key } of claims) {
        const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from plan_entitlements where feature_key = ${key}`;
        expect(
          row.n,
          `${where} cites \`${key}\`, which is in no plan's matrix`,
        ).toBeGreaterThan(0);
      }
    });

    it("a 'Pro' claim means community does NOT have it and pro DOES", async () => {
      for (const { where, plan, key } of claims) {
        if (plan !== "Pro") continue;
        const granted = await grantedOn(key);
        expect(
          granted.has("community"),
          `${where} bills \`${key}\` as Pro, but community grants it — the doc oversells the plan`,
        ).toBe(false);
        expect(
          granted.has("pro"),
          `${where} bills \`${key}\` as Pro, but pro does NOT grant it — a Pro subscriber following this doc gets 402`,
        ).toBe(true);
      }
    });

    // entitlements v18 deleted `pro_plus` outright — there are no rows for
    // it in `plans` or `plan_entitlements`, so no rule comparing against it
    // can ever pass. Rather than leave a loop that vacuously passes once the
    // last "Pro Plus" wording is gone (an empty claims list satisfies any
    // per-claim check silently), assert the retirement directly: a summary
    // is never allowed to say "Pro Plus" again, full stop.
    it("no published summary claims 'Pro Plus' — the plan was deleted", () => {
      const proPlusClaims = claims.filter((c) => c.plan === "Pro Plus");
      expect(
        proPlusClaims.map((c) => `${c.where} bills \`${c.key}\` as Pro Plus`),
        "`pro_plus` has no rows left in plan_entitlements — name the plan that actually grants it (or drop the plan name) instead of Pro Plus",
      ).toEqual([]);
    });
  },
);
