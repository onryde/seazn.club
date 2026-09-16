// Slug-chain resolution (PROMPT-30): live rows win, renamed slugs answer
// { renamedTo }, cross-parent lookups miss (existence never leaks), and
// fixtureByNo maps the human ordinal back to the row.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, patchCompetition } from "@/server/usecases/competitions";
import { createDivision, patchDivision } from "@/server/usecases/divisions";
import { recordSlugHistory } from "@/server/usecases/slugs";
import {
  orgBySlug,
  compBySlug,
  divBySlug,
  fixtureByNo,
  breadcrumbNames,
  sharedRenameTarget,
  invalidateSlugCache,
} from "@/server/slug-resolve";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedOrg(): Promise<{ auth: AuthCtx; orgSlug: string }> {
  const suffix = randomUUID().slice(0, 8);
  const orgSlug = `res-${suffix}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Res " + suffix}, ${orgSlug})
    returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
  return {
    auth: { orgId, via: "session", userId: null, role: "owner", keyId: null },
    orgSlug,
  };
}

describe.skipIf(!HAS_DB)("slug-resolve (PROMPT-30)", () => {
  it("resolves a live org/comp/div chain and misses across parents", async () => {
    const { auth, orgSlug } = await seedOrg();
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Chain Cup",
      visibility: "private",
      branding: {},
    });
    const div = await createDivision(auth, comp.id, {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });

    const org = await orgBySlug(orgSlug);
    expect(org && "id" in org && org.id).toBe(auth.orgId);
    const c = await compBySlug(auth.orgId, comp.slug);
    expect(c && "id" in c && c.id).toBe(comp.id);
    const d = await divBySlug(comp.id, div.slug);
    expect(d && "id" in d && d.id).toBe(div.id);

    // Same comp slug under a different org → miss.
    const other = await seedOrg();
    expect(await compBySlug(other.auth.orgId, comp.slug)).toBeNull();
    expect(await orgBySlug(`missing-${randomUUID().slice(0, 8)}`)).toBeNull();
  });

  it("answers renamedTo for a renamed competition slug", async () => {
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Before Cup",
      visibility: "private",
      branding: {},
    });
    await patchCompetition(auth, comp.id, { name: "After Cup" });
    const res = await compBySlug(auth.orgId, "before-cup");
    expect(res).toEqual({ renamedTo: "after-cup" });
  });

  it("maps fixture ordinals per division", async () => {
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Ordinal Cup",
      visibility: "private",
      branding: {},
    });
    const div = await createDivision(auth, comp.id, {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    const [{ id: stageId }] = await sql<{ id: string }[]>`
      insert into stages (division_id, org_id, seq, kind, name, config)
      values (${div.id}, ${auth.orgId}, 1, 'league', 'S1', '{}') returning id`;
    const fid = randomUUID();
    await sql`
      insert into fixtures ${sql([
        {
          id: fid,
          stage_id: stageId,
          division_id: div.id,
          round_no: 1,
          seq_in_round: 1,
          ext_key: `sr-${randomUUID().slice(0, 6)}`,
          status: "scheduled",
        },
      ])}`;
    expect(await fixtureByNo(div.id, 1)).toEqual({ id: fid });
    expect(await fixtureByNo(div.id, 99)).toBeNull();
    expect(await fixtureByNo(div.id, 1.5)).toBeNull();
  });

  it("breadcrumbNames maps slugs to display names", async () => {
    const { auth } = await seedOrg();
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Crumb Cup",
      visibility: "private",
      branding: {},
    });
    const div = await createDivision(auth, comp.id, {
      name: "U16 Boys",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    const names = await breadcrumbNames(auth.orgId);
    expect(names.comps[comp.slug]).toBe("Crumb Cup");
    expect(names.divs[`${comp.slug}/${div.slug}`]).toBe("U16 Boys");
  });
});

// The /present boards (K fix round, F2 + F3) hand `sharedRenameTarget` the WHOLE
// path and put their own `/present` back on the chrome path it returns, so the
// TAIL is the whole fix. The board tests
// (`(kiosk)/[orgSlug]/__tests__/present-rename.test.tsx`) can only pin the
// ARGUMENTS: their `sharedRenameTarget` is a mock that builds the tail out of
// the args it is handed, so on its own it proves the fixture. These cases run
// the real function against real rename rows, one per depth.
describe.skipIf(!HAS_DB)("sharedRenameTarget keeps the path tail at every depth", () => {
  /** A live org → competition → division chain. */
  async function seedChain(name: string) {
    const { auth, orgSlug } = await seedOrg();
    const comp = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name,
      visibility: "private",
      branding: {},
    });
    const div = await createDivision(auth, comp.id, {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    return { auth, orgSlug, comp, div };
  }

  it("a renamed ORG answers at org depth and keeps /{comp}/{div}", async () => {
    const { auth, orgSlug, comp, div } = await seedChain("Org Tail Cup");
    // No usecase renames an org — `PATCH /api/orgs/[id]` does it inline, and
    // these are that route's own two writes (the same `recordSlugHistory`
    // helper, then the same cache drop), so the row under test is the row
    // production writes rather than one shaped by this test.
    const newOrgSlug = `${orgSlug}-renamed`;
    await sql`update organizations set slug = ${newOrgSlug} where id = ${auth.orgId}`;
    await recordSlugHistory(sql, "org", null, orgSlug, auth.orgId);
    await invalidateSlugCache("org", null, orgSlug, newOrgSlug);

    expect(await sharedRenameTarget(orgSlug, comp.slug, div.slug)).toBe(
      `/shared/${newOrgSlug}/${comp.slug}/${div.slug}`,
    );
    expect(await sharedRenameTarget(orgSlug, comp.slug)).toBe(`/shared/${newOrgSlug}/${comp.slug}`);
    // The tail-less answer is not wrong, it is the only one a LAYOUT can ask
    // for — which is F2, and why the kiosk decision moved down to the page.
    expect(await sharedRenameTarget(orgSlug)).toBe(`/shared/${newOrgSlug}`);
  });

  it("a renamed COMPETITION answers at competition depth and keeps /{div}", async () => {
    const { auth, orgSlug, comp, div } = await seedChain("Before Tail Cup");
    const renamed = await patchCompetition(auth, comp.id, { name: "After Tail Cup" });
    expect(renamed.slug).not.toBe(comp.slug);

    expect(await sharedRenameTarget(orgSlug, comp.slug, div.slug)).toBe(
      `/shared/${orgSlug}/${renamed.slug}/${div.slug}`,
    );
    expect(await sharedRenameTarget(orgSlug, comp.slug)).toBe(`/shared/${orgSlug}/${renamed.slug}`);
  });

  it("a renamed DIVISION answers at division depth", async () => {
    const { auth, orgSlug, comp, div } = await seedChain("Div Tail Cup");
    const renamed = await patchDivision(auth, div.id, { name: "Open B" });
    expect(renamed.slug).not.toBe(div.slug);

    expect(await sharedRenameTarget(orgSlug, comp.slug, div.slug)).toBe(
      `/shared/${orgSlug}/${comp.slug}/${renamed.slug}`,
    );
    // A division rename says nothing about the path above it: the competition
    // board asks at its own depth and must be told there is nothing to do.
    expect(await sharedRenameTarget(orgSlug, comp.slug)).toBeNull();
  });

  it("answers null for a chain that is entirely live, at every depth", async () => {
    // The negative pair: without it every assertion above is satisfied by a
    // function that returns a path for anything it is handed.
    const { orgSlug, comp, div } = await seedChain("Live Tail Cup");
    expect(await sharedRenameTarget(orgSlug, comp.slug, div.slug)).toBeNull();
    expect(await sharedRenameTarget(orgSlug, comp.slug)).toBeNull();
    expect(await sharedRenameTarget(orgSlug)).toBeNull();
  });
});

afterAll(async () => {
  if (!HAS_DB) return; // DB-less unit job: connecting just to disconnect throws
  await sql.end();
});
