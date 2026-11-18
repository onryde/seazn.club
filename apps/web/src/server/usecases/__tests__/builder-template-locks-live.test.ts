// The builder's format locks come from the org's LIVE entitlements, not from a static flag.
//
// The reported defect: the builder's format list showed double elimination as Pro-only for a Community org, although
// `formats.double_elim` has been on for Community since V393. The page already derives the badge from
// `hasFeature(orgId, "formats.double_elim" | "formats.advanced")` -> `templateLocksFor` (d/new/page.tsx,
// d/[divSlug]/page.tsx); the static `FormatFamily.pro` flag is read only by the help pages. This test pins the live
// derivation END TO END against the real plan rows: seed an org on each plan, ask the same two questions the pages ask,
// feed the answers to the same builder, and read the locks.
//
// Never derived from the code under test: the expected locks are named per plan from the plan matrix's own rows
// (read back from `plan_entitlements` in the same test), so a plan-row change moves the expectation with it.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { hasFeature, invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { templateLocksFor } from "../format-gates";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** What the pages do: two live reads, then the builder. */
async function locksFor(orgId: string): Promise<Record<string, string>> {
  const [doubleElim, advanced] = await Promise.all([hasFeature(orgId, "formats.double_elim"), hasFeature(orgId, "formats.advanced")]);
  return templateLocksFor({ doubleElim, advanced });
}

async function planRow(plan: string, feature: string): Promise<boolean | null> {
  const [row] = await sql<{ bool_value: boolean | null }[]>`
    select bool_value from plan_entitlements where plan_key = ${plan} and feature_key = ${feature}`;
  return row?.bool_value ?? null;
}

describe.skipIf(!HAS_DB)("builder format locks follow the org's live entitlements", () => {
  it("Community: double elimination is UNLOCKED, americano/mexicano/ladder are locked (the plan rows say so)", async () => {
    // The expectation comes from the plan matrix itself, not from a typed-in belief about Community.
    expect(await planRow("community", "formats.double_elim"), "community plan row for formats.double_elim").toBe(true);
    expect(await planRow("community", "formats.advanced"), "community plan row for formats.advanced").not.toBe(true);

    const { auth } = await seedOrg("community");
    const locks = await locksFor(auth.orgId);
    expect(locks.double_elim, "double elimination is open to Community").toBeUndefined();
    expect(locks.group_playoffs).toBeUndefined();
    expect(locks.swiss_playoff).toBeUndefined();
    for (const key of ["americano", "mexicano", "ladder"]) expect(locks[key], `${key} needs formats.advanced`).toBe("formats.advanced");
    expect(Object.keys(locks).sort()).toEqual(["americano", "ladder", "mexicano"]);
  });

  it("Pro: nothing is locked (empty case of the lock map)", async () => {
    expect(await planRow("pro", "formats.advanced")).toBe(true);
    expect(await planRow("pro", "formats.double_elim")).toBe(true);
    const { auth } = await seedOrg("pro");
    expect(await locksFor(auth.orgId)).toEqual({});
  });

  it("a plan change moves the locks: Community -> Pro unlocks, Pro -> Community locks again (the sequence, not one read)", async () => {
    const { auth } = await seedOrg("community");
    expect(Object.keys(await locksFor(auth.orgId)).length).toBeGreaterThan(0);
    await setOrgPlan(auth.orgId, "pro");
    await invalidateOrgEntitlements(auth.orgId);
    expect(await locksFor(auth.orgId)).toEqual({});
    await setOrgPlan(auth.orgId, "community");
    await invalidateOrgEntitlements(auth.orgId);
    expect(Object.keys(await locksFor(auth.orgId)).sort()).toEqual(["americano", "ladder", "mexicano"]);
  });
});
