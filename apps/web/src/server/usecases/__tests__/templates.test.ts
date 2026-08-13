// createFromTemplate (D1a design doc, P4): catalog -> competition + divisions
// + stages in one transaction, through the same validation paths manual
// creation uses. Real Postgres required.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { TEMPLATE_CATALOG, getTemplate } from "@/server/templates/catalog";
import type { CompetitionTemplate } from "@/server/templates/schema";
import {
  createFromTemplate,
  instantiateTemplate,
  TEMPLATE_UNKNOWN_KEY_CODE,
  TEMPLATE_VERSION_RETIRED_CODE,
  TEMPLATE_INSTANTIATION_FAILED_CODE,
} from "../templates";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(plan: "community" | "pro" = "pro"): Promise<{ auth: AuthCtx }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Tmpl " + suffix}, ${"tmpl-" + suffix})
    returning id`;
  if (plan !== "community") await setOrgPlan(orgId, plan);
  await invalidateOrgEntitlements(orgId);
  return { auth: { orgId, via: "session", userId: null, role: "owner", keyId: null } };
}

/**
 * Seeds the REAL engine-registry configs for the sports the P4 catalog uses
 * (tennis, boardgame, football, badminton) — `on conflict do nothing`, so
 * this is safe whether or not `sync:sports` already ran on this DB. Mirrors
 * scripts/sync-sports.ts's own logic (same `builtinModules` source), scoped
 * to 4 sports instead of all 11 — the same reasoning `_seed.ts`'s
 * `seedFootballCatalog()` documents: a suite must not depend on ambient
 * catalog state, or it passes locally and 422s in CI (#404's exact failure
 * shape).
 */
async function seedTemplateSportCatalog(): Promise<void> {
  for (const key of ["tennis", "boardgame", "football", "badminton"]) {
    const mod = builtinModules.find((m) => m.key === key);
    if (!mod) throw new Error(`engine no longer ships sport '${key}'`);
    await sql`
      insert into sports (key, name, module_version, position_catalog)
      values (${mod.key}, ${mod.key}, ${mod.version}, ${sql.json(mod.positions as never)})
      on conflict (key) do nothing`;
    for (const [variantKey, config] of Object.entries(mod.variants)) {
      await sql`
        insert into sport_variants (sport_key, key, name, config, is_system)
        values (${mod.key}, ${variantKey}, ${variantKey}, ${sql.json((config ?? {}) as never)}, true)
        on conflict do nothing`;
    }
  }
}

async function competitionCount(orgId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    select count(*)::int as n from competitions where org_id = ${orgId}`;
  return n;
}

const SLAM_STAGE_TEMPLATE = (
  overrides: Partial<CompetitionTemplate["divisions"][0]["stages"][0]>,
): CompetitionTemplate => ({
  key: "test-synthetic",
  version: 1,
  i18n: { nameKey: "templates.slam128.name", descriptionKey: "templates.slam128.desc" },
  divisions: [
    {
      i18nNameKey: "templates.slam128.div.main",
      sportKey: "tennis",
      variantKey: "grand-slam",
      entrantKind: "individual",
      entrantCount: 8,
      stages: [{ i18nNameKey: "templates.stage.mainDraw", kind: "knockout", ...overrides }],
    },
  ],
});

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("createFromTemplate (D1a, P4)", () => {
  it("instantiates every catalog entry against a test org — structure, cfg snapshots, provenance", async () => {
    await seedTemplateSportCatalog();
    const { auth } = await seedOrg("pro"); // americano-night needs formats.advanced
    for (const template of TEMPLATE_CATALOG) {
      const result = await createFromTemplate(auth, {
        template_key: template.key,
        name: `${template.key} ${randomUUID().slice(0, 6)}`,
        ends_on: "2030-12-31",
        visibility: "private",
      });
      expect(result.templateKey).toBe(template.key);
      expect(result.templateVersion).toBe(template.version);
      expect(result.divisions).toHaveLength(template.divisions.length);
      for (const [i, div] of result.divisions.entries()) {
        expect(div.stages).toHaveLength(template.divisions[i]!.stages.length);
        for (const stage of div.stages) expect(stage.fixtureCount).toBe(0);
      }
      const [row] = await sql<{ template_key: string; template_version: number; slug: string }[]>`
        select template_key, template_version, slug from competitions where id = ${result.competitionId}`;
      expect(row).toMatchObject({ template_key: template.key, template_version: template.version });
      // The wizard navigates straight to the created competition page (same
      // pattern the blank-form wizard already uses) — needs the slug, not
      // just the id, back on the response.
      expect(result.slug).toBe(row!.slug);
    }
  });

  it("wc32's group stage snapshots config.pools.count from its `groups` sugar; swiss11's config.rounds passes through", async () => {
    await seedTemplateSportCatalog();
    const { auth } = await seedOrg("pro");
    const wc32 = await createFromTemplate(auth, {
      template_key: "wc32",
      name: `wc32 ${randomUUID().slice(0, 6)}`,
      ends_on: "2030-12-31",
      visibility: "private",
    });
    const groupStageId = wc32.divisions[0]!.stages[0]!.id;
    const [groupStage] = await sql<{ config: { pools?: { count?: number } } }[]>`
      select config from stages where id = ${groupStageId}`;
    expect(groupStage!.config.pools?.count).toBe(8);

    const swiss = await createFromTemplate(auth, {
      template_key: "swiss11",
      name: `swiss11 ${randomUUID().slice(0, 6)}`,
      ends_on: "2030-12-31",
      visibility: "private",
    });
    const swissStageId = swiss.divisions[0]!.stages[0]!.id;
    const [swissStage] = await sql<{ config: { rounds?: number } }[]>`
      select config from stages where id = ${swissStageId}`;
    expect(swissStage!.config.rounds).toBe(11);
  });

  it("a stage's PointsRule is written into stages.config.points verbatim", async () => {
    await seedTemplateSportCatalog();
    const { auth } = await seedOrg("pro");
    const template = SLAM_STAGE_TEMPLATE({
      points: { base: { win: 3, draw: 1, loss: 0 }, bonuses: [] },
    });
    const result = await instantiateTemplate(auth, template, {
      name: `Points ${randomUUID().slice(0, 6)}`,
      ends_on: "2030-12-31",
    });
    const [stage] = await sql<{ config: { points?: { base?: { win?: number } } } }[]>`
      select config from stages where id = ${result.divisions[0]!.stages[0]!.id}`;
    expect(stage!.config.points?.base?.win).toBe(3);
  });

  it("unknown template key is refused 404 TEMPLATE_UNKNOWN_KEY", async () => {
    const { auth } = await seedOrg("pro");
    await expect(
      createFromTemplate(auth, {
        template_key: "does-not-exist",
        name: "X",
        ends_on: "2030-12-31",
        visibility: "private",
      }),
    ).rejects.toMatchObject({ status: 404, code: TEMPLATE_UNKNOWN_KEY_CODE });
  });

  it("a stale template_version is refused 409 TEMPLATE_VERSION_RETIRED, naming the live version", async () => {
    const { auth } = await seedOrg("pro");
    const template = getTemplate("slam128")!;
    await expect(
      createFromTemplate(auth, {
        template_key: "slam128",
        template_version: template.version + 1,
        name: "X",
        ends_on: "2030-12-31",
        visibility: "private",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: TEMPLATE_VERSION_RETIRED_CODE,
      extra: { live_version: template.version },
    });
  });

  it.each(["double_elim", "page_playoff"] as const)(
    "regression: a synthetic %s stage on an org without formats.double_elim is refused by CODE, leaving nothing behind",
    async (kind) => {
      await seedTemplateSportCatalog();
      const { auth } = await seedOrg("community");
      const before = await competitionCount(auth.orgId);
      await expect(
        instantiateTemplate(auth, SLAM_STAGE_TEMPLATE({ kind }), {
          name: "Gated",
          ends_on: "2030-12-31",
        }),
      ).rejects.toMatchObject({ featureKey: "formats.double_elim" });
      expect(await competitionCount(auth.orgId)).toBe(before);
    },
  );

  it("regression: the REAL americano-night template on an org without formats.advanced is refused by CODE, leaving nothing behind", async () => {
    await seedTemplateSportCatalog();
    const { auth } = await seedOrg("community");
    const before = await competitionCount(auth.orgId);
    await expect(
      createFromTemplate(auth, {
        template_key: "americano-night",
        name: "Night",
        ends_on: "2030-12-31",
        visibility: "private",
      }),
    ).rejects.toMatchObject({ featureKey: "formats.advanced" });
    expect(await competitionCount(auth.orgId)).toBe(before);
  });

  it("a mid-instantiation failure rolls back the whole transaction — no orphan competition or division", async () => {
    await seedTemplateSportCatalog();
    const { auth } = await seedOrg("pro");
    const broken: CompetitionTemplate = {
      key: "test-broken",
      version: 1,
      i18n: { nameKey: "templates.slam128.name", descriptionKey: "templates.slam128.desc" },
      divisions: [
        {
          i18nNameKey: "templates.slam128.div.main",
          sportKey: "tennis",
          variantKey: "grand-slam",
          entrantKind: "individual",
          entrantCount: 8,
          stages: [{ i18nNameKey: "templates.stage.mainDraw", kind: "knockout" }],
        },
        {
          i18nNameKey: "templates.slam128.div.main",
          sportKey: "tennis",
          variantKey: "does-not-exist",
          entrantKind: "individual",
          entrantCount: 8,
          stages: [{ i18nNameKey: "templates.stage.mainDraw", kind: "knockout" }],
        },
      ],
    };
    const before = await competitionCount(auth.orgId);
    const name = `Broken ${randomUUID().slice(0, 6)}`;
    await expect(
      instantiateTemplate(auth, broken, { name, ends_on: "2030-12-31" }),
    ).rejects.toMatchObject({
      status: 422,
      code: TEMPLATE_INSTANTIATION_FAILED_CODE,
      extra: { divisionIndex: 1 },
    });
    expect(await competitionCount(auth.orgId)).toBe(before);
    const [{ n: orphanCompetitions }] = await sql<{ n: number }[]>`
      select count(*)::int as n from competitions where org_id = ${auth.orgId} and name = ${name}`;
    expect(orphanCompetitions).toBe(0);
    const [{ n: orphanDivisions }] = await sql<{ n: number }[]>`
      select count(*)::int as n from divisions d
      join competitions c on c.id = d.competition_id
      where c.org_id = ${auth.orgId} and c.name = ${name}`;
    expect(orphanDivisions).toBe(0);
  });
});
