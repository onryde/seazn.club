// The builder's format locks come from the org's LIVE entitlements, not from a static flag.
//
// The reported defect: the builder's format list showed double elimination as Pro-only for a Community org, although
// `formats.double_elim` has been on for Community since V393. The page already derives the badge from
// `templateLocksForOrg(orgId, competitionId)` (format-gates.ts: `hasFeature` x2 -> `templateLocksFor`), the ONE function
// both builder pages call (d/new/page.tsx, d/[divSlug]/page.tsx). This test drives that very function against the real
// plan rows, and pins by source scan that both pages call it and ask `hasFeature("formats.*")` nowhere themselves.
//
// Never derived from the code under test: the expected locks are named per plan from the plan matrix's own rows
// (read back from `plan_entitlements` in the same test), so a plan-row change moves the expectation with it.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { readFileSync } from "node:fs";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { setOrgPlan } from "@/lib/__tests__/_billing-group";
import { createCompetition } from "../competitions";
import { templateLocksForOrg } from "../format-gates";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

/** What both builder pages call, with a real competition of the org (the Event Pass arm is competition-scoped). */
async function locksFor(auth: Awaited<ReturnType<typeof seedOrg>>["auth"]): Promise<Record<string, string>> {
  const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Locks " + Math.random().toString(36).slice(2, 8), visibility: "private", branding: {} });
  return templateLocksForOrg(auth.orgId, comp.id);
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
    const locks = await locksFor(auth);
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
    expect(await locksFor(auth)).toEqual({});
  });

  it("a plan change moves the locks: Community -> Pro unlocks, Pro -> Community locks again (the sequence, not one read)", async () => {
    const { auth } = await seedOrg("community");
    expect(Object.keys(await locksFor(auth)).length).toBeGreaterThan(0);
    await setOrgPlan(auth.orgId, "pro");
    await invalidateOrgEntitlements(auth.orgId);
    expect(await locksFor(auth)).toEqual({});
    await setOrgPlan(auth.orgId, "community");
    await invalidateOrgEntitlements(auth.orgId);
    expect(Object.keys(await locksFor(auth)).sort()).toEqual(["americano", "ladder", "mexicano"]);
  });
});

describe("both builder pages take their locks from templateLocksForOrg, not from a flag or their own copy of the question", () => {
  const PAGES = ["src/app/o/[orgSlug]/c/[compSlug]/d/new/page.tsx", "src/app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx"];
  const code = (path: string) =>
    readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/(^|\s)\/\/.*$/, ""))
      .join("\n");
  it("each page calls templateLocksForOrg and asks no formats.* hasFeature itself", () => {
    let checked = 0;
    for (const page of PAGES) {
      const src = code(page);
      checked++;
      expect(src, `${page} calls templateLocksForOrg`).toMatch(/templateLocksForOrg\(auth\.orgId,/);
      expect(src, `${page} passes the result on as templateLocks`).toMatch(/templateLocks\b/);
      expect(src, `${page} must not ask formats.double_elim / formats.advanced itself`).not.toMatch(/formats\.(double_elim|advanced)/);
      expect(src, `${page} must not read the static gallery pro flag`).not.toMatch(/\.pro\b\s*[?:)]/);
    }
    expect(checked, "anti-vacuity: both pages scanned").toBe(PAGES.length);
  });
});
