// W2 T19 — `POST /api/v1/officials/import` and the `import.bulk` row cap.
//
// The officials import shipped with NO entitlement check of any kind: no
// `requireFeature`, no `withinLimit`, no mention of `import.bulk`, while the
// sibling participants import (`usecases/imports.ts`) gates on exactly that
// key. The free 50-row-per-file cap was therefore unenforceable through this
// route — API-only, no UI, which is why it went unnoticed. A cap with a
// bypass is not a cap.
//
// Every expected number here is READ from `plan_entitlements`. The figure has
// already drifted once in this codebase (a comment and a customer-facing
// sentence both said 20 long after V319 raised it to 50), so a literal in
// this file would just be the next stale copy.
//
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { PaymentRequiredError } from "@/lib/errors";
import { bulkImportRowsReason } from "@/lib/feature-copy";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { importOfficials, listOfficials } from "../officials";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(plan: "community" | "pro" = "community"): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"OffCap " + suffix}, ${"offcap-" + suffix})
    returning id`;
  if (plan !== "community") await setOrgPlan(org!.id, plan);
  await invalidateOrgEntitlements(org!.id);
  return { orgId: org!.id, via: "session", userId: null, role: "owner", keyId: null };
}

/** The cap as the MATRIX states it — never typed into this file. */
async function planRowCap(planKey: string): Promise<number> {
  const [row] = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
     where plan_key = ${planKey} and feature_key = 'import.bulk'`;
  if (row?.int_value == null) {
    throw new Error(`no finite import.bulk cap for plan '${planKey}'`);
  }
  return row.int_value;
}

/** A CSV the officials parser accepts: Name, Roles, MaxPerDay. */
function officialsCsv(rows: number, tag: string): Buffer {
  const lines = ["Name,Roles,MaxPerDay"];
  for (let i = 0; i < rows; i++) lines.push(`Ref ${tag} ${i},referee,`);
  return Buffer.from(lines.join("\n"));
}

async function importCsv(auth: AuthCtx, rows: number, tag: string) {
  return importOfficials(auth, "officials.csv", "text/csv", officialsCsv(rows, tag));
}

describe.skipIf(!HAS_DB)("officials import honours the import.bulk row cap", () => {
  it("a Free org's file one row over the cap is refused 402, quoting the LIVE cap", async () => {
    const cap = await planRowCap("community");
    // Anti-vacuity: the right answer must differ from the figure the stale
    // copy hardcoded, or this test cannot witness the regression it exists for.
    expect(cap).not.toBe(20);

    const auth = await seedOrg("community");
    const tag = randomUUID().slice(0, 6);
    const err = await importCsv(auth, cap + 1, tag).then(
      () => null,
      (e: unknown) => e as PaymentRequiredError & { extra?: Record<string, unknown> },
    );

    expect(err, "a file one row over the cap must be refused").toBeInstanceOf(
      PaymentRequiredError,
    );
    expect(err!.status).toBe(402);
    expect(err!.featureKey).toBe("import.bulk");
    // The customer's sentence and the machine hint both carry the cap that
    // actually refused them — not a constant typed anywhere.
    expect(err!.extra?.limit).toBe(cap);
    expect(err!.extra?.reason).toBe(bulkImportRowsReason(cap));
    expect(String(err!.extra?.reason)).toContain(`over ${cap} rows`);

    // Refused BEFORE the transaction: nothing was written.
    expect(await listOfficials(auth)).toEqual([]);
  });

  it("a Free org's file exactly AT the cap is imported in full", async () => {
    const cap = await planRowCap("community");
    const auth = await seedOrg("community");
    const tag = randomUUID().slice(0, 6);
    const result = await importCsv(auth, cap, tag);
    expect(result).toEqual({ created: cap, skipped: 0 });
    expect((await listOfficials(auth)).length).toBe(cap);
  });

  it("a Pro org clears the Free cap — the gate reads the org's own plan", async () => {
    const free = await planRowCap("community");
    const pro = await planRowCap("pro");
    // Without this the next assertion could pass on a matrix where both plans
    // share one cap, proving nothing about whose plan was consulted.
    expect(pro).toBeGreaterThan(free);

    const auth = await seedOrg("pro");
    const tag = randomUUID().slice(0, 6);
    const result = await importCsv(auth, free + 1, tag);
    expect(result).toEqual({ created: free + 1, skipped: 0 });
  });
});
