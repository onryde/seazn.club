// Every `{{plan:<feature>:<plan>}}` token the help content uses must have an INTEGER cell in the plan table, read the way the
// help page reads it (loadPricingMatrix, the same loader the pricing page uses). resolveHelpTokens THROWS for a missing or
// non-integer cell, so a token with no cell is an error page for a reader the first time the article is requested. The page is
// rendered on demand, never at build, so `next build` would not catch it; this test is what does.
//
// DB-backed: it runs where plan_entitlements exists (smoke-db in CI; a fresh `seazn-env` database locally). It lives under
// src/server so the smoke-db globs (`src/server src/lib`) pick it up with no ci.yml change.
// Sport: not applicable (plan table, not a sport rule).
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import type { MatrixData } from "@/lib/pricing-matrix";
import { loadPricingMatrix } from "@/lib/pricing-matrix-server";
import { allHelpArticles } from "@/server/help-content";
import { helpTokensIn, resolveHelpTokens } from "@/server/help-tokens";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** Faults for a list of tokens against a matrix: every token needs an integer cell. */
function tokenCellFaults(tokens: { token: string; feature: string; plan: string }[], matrix: MatrixData): string[] {
  const faults: string[] = [];
  for (const { token, feature, plan } of tokens) {
    const cell = matrix[feature]?.[plan];
    if (!cell) faults.push(`${token}: no plan_entitlements row for '${feature}' on '${plan}'`);
    else if (!Number.isInteger(cell.int_value)) faults.push(`${token}: '${feature}' on '${plan}' is not an integer (${String(cell.int_value)})`);
  }
  return faults;
}

describe("the token checker itself (no database)", () => {
  const matrix: MatrixData = {
    "registration.fee_percent": { community: { int_value: 5, bool_value: null }, pro: { int_value: null, bool_value: null } },
    "branding.custom_colour": { pro: { int_value: null, bool_value: true } },
  };
  const t = (feature: string, plan: string) => ({ token: `{{plan:${feature}:${plan}}}`, feature, plan });

  it("passes an integer cell and flags a missing plan, a missing feature, a null cell and a boolean cell", () => {
    expect(tokenCellFaults([t("registration.fee_percent", "community")], matrix)).toEqual([]);
    const faults = tokenCellFaults(
      [
        t("registration.fee_percent", "enterprise"),
        t("no.such.feature", "pro"),
        t("registration.fee_percent", "pro"),
        t("branding.custom_colour", "pro"),
      ],
      matrix,
    );
    expect(faults).toHaveLength(4);
  });

  it("an article with no token yields an empty list, not an error", () => {
    expect(helpTokensIn("Plain text, {{ not one }}, 5% typed.")).toEqual([]);
  });
});

describe.skipIf(!HAS_DB)("every plan token in the help content has an integer cell (DB-backed)", () => {
  it("reads one integer per token from loadPricingMatrix, and the same integer straight from plan_entitlements", async () => {
    const matrix = await loadPricingMatrix();
    // The loader fails soft to {} when the table is empty; an empty matrix would make every check below vacuous.
    expect(Object.keys(matrix).length, "anti-vacuity: the plan table has rows").toBeGreaterThan(0);

    const articles = allHelpArticles();
    const tokens = [...articles.values()].flatMap((a) => helpTokensIn(a.markdown).map((x) => ({ ...x, slug: a.slug })));
    const distinct = new Map(tokens.map((x) => [x.token, x]));
    const slugs = new Set(tokens.map((x) => x.slug));
    console.log(
      `help-token-cells: articles scanned=${articles.size}, with tokens=${slugs.size}, tokens=${tokens.length}, distinct=${distinct.size}`,
    );
    expect(articles.size, "anti-vacuity: articles scanned").toBeGreaterThan(0);
    // Registration's fee table is the first token user; zero tokens means the sweep lost it (or the content did).
    expect(tokens.length, "anti-vacuity: no help article uses a plan token").toBeGreaterThan(0);

    expect(tokenCellFaults([...distinct.values()], matrix)).toEqual([]);

    // The second authority: the same integer, asked of plan_entitlements directly.
    for (const { token, feature, plan } of distinct.values()) {
      const rows = await sql<{ int_value: number | null }[]>`
        select int_value from plan_entitlements where feature_key = ${feature} and plan_key = ${plan}`;
      expect(rows.length, `${token}: exactly one plan_entitlements row`).toBe(1);
      expect(resolveHelpTokens(token, matrix), token).toBe(String(rows[0]!.int_value));
    }
  });

  it("every article that carries a token renders through resolveHelpTokens without throwing", async () => {
    const matrix = await loadPricingMatrix();
    let rendered = 0;
    for (const a of allHelpArticles().values()) {
      if (helpTokensIn(a.markdown).length === 0) continue;
      expect(() => resolveHelpTokens(a.markdown, matrix), a.slug).not.toThrow();
      rendered++;
    }
    expect(rendered, "anti-vacuity: at least one article carries a token").toBeGreaterThan(0);
  });

  it("a token for a plan with no cell would be caught (the check can fail)", async () => {
    const matrix = await loadPricingMatrix();
    expect(tokenCellFaults([{ token: "{{plan:registration.fee_percent:no_such_plan}}", feature: "registration.fee_percent", plan: "no_such_plan" }], matrix)).toHaveLength(1);
    expect(() => resolveHelpTokens("{{plan:registration.fee_percent:no_such_plan}}", matrix)).toThrow(/no_such_plan/);
  });
});
