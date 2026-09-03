// createFromTemplate (D1a design doc, P4): catalog -> competition + divisions
// + stages in one transaction, through the same validation paths manual
// creation uses. Real Postgres required.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { builtinModules } from "@seazn/engine/sports";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
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

// P4 review finding 1 (2026-08-13): mocked so the "fires the activation
// funnel" tests below can assert on call shape/count without depending on
// POSTHOG_KEY being set in the test env (captureServer no-ops without it,
// same as production-unconfigured) — see lib/__tests__/posthog-server.test.ts
// for the module's own unconfigured-vs-configured contract.
vi.mock("@/lib/posthog-server", () => ({ captureServer: vi.fn().mockResolvedValue(undefined) }));

const HAS_DB = !!process.env.DATABASE_URL;

/** V391 (entitlements v18 §2) granted several formerly-Pro keys to Community,
 *  so a plan alone no longer withholds them. The gate sites are still live
 *  code; a DENY override is the one remaining lever that takes a key away, and
 *  it beats both the pass and the plan — so it is what proves a gate shuts. */
async function denyFeature(orgId: string, featureKey: string): Promise<void> {
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
    values (${orgId}, ${featureKey}, false, 'test')
    on conflict (org_id, feature_key) do update set bool_value = false`;
  await invalidateOrgEntitlements(orgId);
}

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
 * Seeds the REAL engine-registry configs for the sports the catalog uses
 * (tennis, boardgame, football, badminton, and P7's cricket for
 * t20-super8/league-playoff) — `on conflict do nothing`, so this is safe
 * whether or not `sync:sports` already ran on this DB. Mirrors
 * scripts/sync-sports.ts's own logic (same `builtinModules` source), scoped
 * to 5 sports instead of all 11 — the same reasoning `_seed.ts`'s
 * `seedFootballCatalog()` documents: a suite must not depend on ambient
 * catalog state, or it passes locally and 422s in CI (#404's exact failure
 * shape).
 */
async function seedTemplateSportCatalog(): Promise<void> {
  for (const key of ["tennis", "boardgame", "football", "badminton", "cricket"]) {
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

/** A minimal, valid single-stage division for synthetic templates that don't
 *  care about the division's own shape (quota-cap and funnel-event fixtures
 *  below) — same knockout stage shape as SLAM_STAGE_TEMPLATE's default. */
function makeDivision(sportKey: string, variantKey: string): CompetitionTemplate["divisions"][0] {
  return {
    i18nNameKey: "templates.slam128.div.main",
    sportKey,
    variantKey,
    entrantKind: "individual",
    entrantCount: 8,
    stages: [{ i18nNameKey: "templates.stage.mainDraw", kind: "knockout" }],
  };
}

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
    "regression: a synthetic %s stage on an org denied formats.double_elim is refused by CODE, leaving nothing behind",
    async (kind) => {
      await seedTemplateSportCatalog();
      const { auth } = await seedOrg("community");
      await denyFeature(auth.orgId, "formats.double_elim");
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

describe.skipIf(!HAS_DB)("createFromTemplate — activation funnel events (P4 review finding 1)", () => {
  beforeEach(() => {
    vi.mocked(captureServer).mockClear();
  });

  it("fires COMPETITION_CREATED once and DIVISION_CREATED once per division", async () => {
    await seedTemplateSportCatalog();
    const { auth } = await seedOrg("pro");
    const twoDivisions: CompetitionTemplate = {
      key: "test-funnel-two-divisions",
      version: 1,
      i18n: { nameKey: "templates.slam128.name", descriptionKey: "templates.slam128.desc" },
      divisions: [makeDivision("tennis", "grand-slam"), makeDivision("boardgame", "classical")],
    };
    const result = await instantiateTemplate(auth, twoDivisions, {
      name: `Funnel ${randomUUID().slice(0, 6)}`,
      ends_on: "2030-12-31",
    });

    const calls = vi.mocked(captureServer).mock.calls.map(([args]) => args);
    const competitionCalls = calls.filter((c) => c.event === EVENTS.COMPETITION_CREATED);
    expect(competitionCalls).toHaveLength(1);
    expect(competitionCalls[0]).toMatchObject({ properties: { visibility: "private" } });
    // A private template instantiation must NOT complete the
    // COMPETITION_MADE_PUBLIC milestone (see the dedicated public-visibility
    // test below for the positive case).
    expect(calls.filter((c) => c.event === EVENTS.COMPETITION_MADE_PUBLIC)).toHaveLength(0);

    const divisionCalls = calls.filter((c) => c.event === EVENTS.DIVISION_CREATED);
    expect(divisionCalls).toHaveLength(2);
    expect(divisionCalls.map((c) => c.properties?.sport_key).sort()).toEqual(
      ["boardgame", "tennis"].sort(),
    );
    for (const c of divisionCalls) {
      expect(c.properties?.competition_id).toBe(result.competitionId);
    }
  });

  it("a template instantiated directly public ALSO fires COMPETITION_MADE_PUBLIC exactly once (review follow-up, 2026-08-13)", async () => {
    await seedTemplateSportCatalog();
    const { auth } = await seedOrg("pro");
    const result = await createFromTemplate(auth, {
      template_key: "slam128",
      name: `PublicFunnel ${randomUUID().slice(0, 6)}`,
      ends_on: "2030-12-31",
      visibility: "public",
    });
    const calls = vi.mocked(captureServer).mock.calls.map(([args]) => args);
    expect(calls.filter((c) => c.event === EVENTS.COMPETITION_CREATED)).toHaveLength(1);
    const madePublic = calls.filter((c) => c.event === EVENTS.COMPETITION_MADE_PUBLIC);
    expect(madePublic).toHaveLength(1);
    expect(madePublic[0]).toMatchObject({ properties: { competition_id: result.competitionId } });
  });

  it("a refused (over-quota) instantiation fires neither event — nothing to count", async () => {
    await seedTemplateSportCatalog();
    const { auth } = await seedOrg("community");
    const overCap: CompetitionTemplate = {
      key: "test-funnel-over-cap",
      version: 1,
      i18n: { nameKey: "templates.slam128.name", descriptionKey: "templates.slam128.desc" },
      divisions: Array.from({ length: 5 }, () => makeDivision("tennis", "grand-slam")),
    };
    await expect(
      instantiateTemplate(auth, overCap, { name: "NoFunnel", ends_on: "2030-12-31" }),
    ).rejects.toMatchObject({ featureKey: "divisions.per_competition.max" });
    expect(captureServer).not.toHaveBeenCalled();
  });
});

describe.skipIf(!HAS_DB)("createFromTemplate — quota caps (P4 review finding 2)", () => {
  it("regression: a template with 5 divisions (over Community's divisions.per_competition.max=4) is refused by PaymentRequiredError, leaving nothing behind — no current catalog entry has this shape", async () => {
    await seedTemplateSportCatalog();
    const { auth } = await seedOrg("community");
    const before = await competitionCount(auth.orgId);
    const overDivisionCap: CompetitionTemplate = {
      key: "test-over-division-cap",
      version: 1,
      i18n: { nameKey: "templates.slam128.name", descriptionKey: "templates.slam128.desc" },
      divisions: Array.from({ length: 5 }, () => makeDivision("tennis", "grand-slam")),
    };
    await expect(
      instantiateTemplate(auth, overDivisionCap, { name: "OverDivisionCap", ends_on: "2030-12-31" }),
    ).rejects.toMatchObject({ status: 402, featureKey: "divisions.per_competition.max" });
    expect(await competitionCount(auth.orgId)).toBe(before);
  });

  it("regression: a division with 3 stages (over Community's stages.per_division.max=2) is refused by PaymentRequiredError, leaving nothing behind", async () => {
    await seedTemplateSportCatalog();
    const { auth } = await seedOrg("community");
    const before = await competitionCount(auth.orgId);
    const overStageCap = SLAM_STAGE_TEMPLATE({});
    overStageCap.divisions[0]!.stages = [
      { i18nNameKey: "templates.stage.mainDraw", kind: "knockout" },
      { i18nNameKey: "templates.stage.mainDraw", kind: "knockout" },
      { i18nNameKey: "templates.stage.mainDraw", kind: "knockout" },
    ];
    await expect(
      instantiateTemplate(auth, overStageCap, { name: "OverStageCap", ends_on: "2030-12-31" }),
    ).rejects.toMatchObject({ status: 402, featureKey: "stages.per_division.max" });
    expect(await competitionCount(auth.orgId)).toBe(before);
  });
});

describe.skipIf(!HAS_DB)(
  "createFromTemplate — validatePointsRule / shared advanced-formats gate (P4 review findings 3 and 5)",
  () => {
    it("a points rule using a margin bonus the sport's metrics can't support is refused 422 by validatePointsRule — the existing bonuses:[] test would not catch this", async () => {
      await seedTemplateSportCatalog();
      const { auth } = await seedOrg("pro");
      const before = await competitionCount(auth.orgId);
      const template = SLAM_STAGE_TEMPLATE({
        points: {
          base: { win: 3, draw: 1, loss: 0 },
          bonuses: [{ when: "win_margin_gte", param: 2, points: 1 }],
        },
      });
      await expect(
        instantiateTemplate(auth, template, { name: "BadPoints", ends_on: "2030-12-31" }),
      ).rejects.toMatchObject({
        status: 422,
        code: TEMPLATE_INSTANTIATION_FAILED_CODE,
        extra: { divisionIndex: 0, stageIndex: 0 },
      });
      expect(await competitionCount(auth.orgId)).toBe(before);
    });

    it("regression: a synthetic stage with config.placements set (the advanced-formats gate shared with stages.ts, not a hand-copy) on a community org is refused, leaving nothing behind", async () => {
      await seedTemplateSportCatalog();
      const { auth } = await seedOrg("community");
      const before = await competitionCount(auth.orgId);
      const template = SLAM_STAGE_TEMPLATE({
        kind: "group",
        config: { placements: [{ from: 1, to: 2 }] },
      });
      await expect(
        instantiateTemplate(auth, template, { name: "Placements gated", ends_on: "2030-12-31" }),
      ).rejects.toMatchObject({ featureKey: "formats.advanced" });
      expect(await competitionCount(auth.orgId)).toBe(before);
    });
  },
);

describe.skipIf(!HAS_DB)(
  "createFromTemplate — independent instantiated-shape pins (P4 review finding 4)",
  () => {
    // Hand-written literals, never read from the catalog/template object
    // under test. The "instantiates every catalog entry..." test above
    // asserts shape against `template.divisions[i].stages` — circular by
    // construction, since a catalog edit and its own assertion move
    // together. wc32 already has an independent pin (catalog.test.ts) and
    // slam128 a partial one (summary.test.ts); swiss11/americano-night/
    // box-league had NONE — a catalog edit reshaping any of these three
    // shipped green.
    //
    // P7/D1b: euro24/t20-super8/league-playoff added. Their progression
    // rules ARE now read and persisted by instantiateTemplate
    // (usecases/templates.ts, T3) — this pin only proves the catalog's
    // declared STAGE KINDS still reach the DB unchanged; seeding persistence
    // itself has its own dedicated coverage in the "seeding persistence
    // (P7/D1b T3)" describe block below. league-playoff needs "pro": its
    // page_playoff stage is gated by formats.double_elim (format-gates.ts).
    it.each([
      { key: "swiss11", plan: "community" as const, kinds: ["swiss"] },
      { key: "americano-night", plan: "pro" as const, kinds: ["americano"] }, // needs formats.advanced
      { key: "box-league", plan: "community" as const, kinds: ["group"] },
      { key: "euro24", plan: "community" as const, kinds: ["group", "knockout"] },
      { key: "t20-super8", plan: "pro" as const, kinds: ["group", "group", "knockout"] }, // 3 stages > community's stages.per_division.max (2)
      { key: "league-playoff", plan: "pro" as const, kinds: ["league", "page_playoff"] }, // needs formats.double_elim
    ])(
      "$key instantiates to exactly 1 division with the pinned stage kind(s) $kinds",
      async ({ key, plan, kinds }) => {
        await seedTemplateSportCatalog();
        const { auth } = await seedOrg(plan);
        const result = await createFromTemplate(auth, {
          template_key: key,
          name: `${key}-shape-${randomUUID().slice(0, 6)}`,
          ends_on: "2030-12-31",
          visibility: "private",
        });
        expect(result.divisions).toHaveLength(1);
        expect(result.divisions[0]!.stages).toHaveLength(kinds.length);
        const rows = await sql<{ kind: string }[]>`
          select s.kind from stages s
          join divisions d on d.id = s.division_id
          where d.competition_id = ${result.competitionId}
          order by s.seq`;
        expect(rows.map((r) => r.kind)).toEqual(kinds);
      },
    );
  },
);

describe.skipIf(!HAS_DB)("createFromTemplate — seeding persistence (P7/D1b T3)", () => {
  it("euro24's knockout progression is persisted onto the stage row — take, placement, and the map's descriptor-key grammar survive verbatim", async () => {
    await seedTemplateSportCatalog();
    const { auth } = await seedOrg("community");
    const result = await createFromTemplate(auth, {
      template_key: "euro24",
      name: `euro24-seeding-${randomUUID().slice(0, 6)}`,
      ends_on: "2030-12-31",
      visibility: "private",
    });
    const knockoutStageId = result.divisions[0]!.stages[1]!.id;
    const [row] = await sql<{ progression: unknown }[]>`
      select progression from stages where id = ${knockoutStageId}`;
    const catalogProgression = getTemplate("euro24")!.divisions[0]!.stages[1]!.progression!;
    // Assert against the catalog's OWN parsed values (not a re-typed
    // literal here) so this test can't drift out of sync with the catalog,
    // while still proving sources/placement/map — not just non-null —
    // reached the row.
    expect(row!.progression).toMatchObject({
      sources: catalogProgression.sources,
      placement: catalogProgression.placement,
    });
    // The map's descriptor-key grammar (progression.ts, P5/F2): `slot` a
    // stringified seed index, `source` a "best:N"/"rank:N"/"{pool}{rank}"
    // descriptor key — pinned literally so a future change that
    // normalises/re-keys it on the way in goes red here.
    expect((row!.progression as { map: unknown }).map).toEqual([
      { slot: "13", source: "best:1" },
      { slot: "14", source: "best:2" },
      { slot: "15", source: "best:3" },
      { slot: "16", source: "best:4" },
    ]);
  });

  it("t20-super8's TWO `timing:\"setup\"` stages (super8 + knockout) both persist, snake and rank_order placements alike", async () => {
    await seedTemplateSportCatalog();
    const { auth } = await seedOrg("pro"); // 3 stages > community's stages.per_division.max
    const result = await createFromTemplate(auth, {
      template_key: "t20-super8",
      name: `t20-seeding-${randomUUID().slice(0, 6)}`,
      ends_on: "2030-12-31",
      visibility: "private",
    });
    const [groupStage, super8Stage, knockoutStage] = result.divisions[0]!.stages;
    const rows = await sql<{ id: string; progression: { sources: { stage: string }[]; placement: string } | null }[]>`
      select id, progression from stages where id in ${sql([groupStage!.id, super8Stage!.id, knockoutStage!.id])}`;
    const byId = new Map(rows.map((r) => [r.id, r.progression]));
    expect(byId.get(groupStage!.id)).toBeNull();
    expect(byId.get(super8Stage!.id)).toMatchObject({
      sources: [{ stage: "previous" }],
      placement: "snake",
    });
    expect(byId.get(knockoutStage!.id)).toMatchObject({
      sources: [{ stage: "previous" }],
      placement: "rank_order",
    });
  });

  it("instantiation still generates ZERO fixture rows for a multi-stage progression template — pins the §2 no-fixtures-at-instantiation ruling", async () => {
    await seedTemplateSportCatalog();
    const { auth } = await seedOrg("pro");
    const result = await createFromTemplate(auth, {
      template_key: "t20-super8",
      name: `t20-fixtures-${randomUUID().slice(0, 6)}`,
      ends_on: "2030-12-31",
      visibility: "private",
    });
    const stageIds = result.divisions[0]!.stages.map((s) => s.id);
    for (const stage of result.divisions[0]!.stages) {
      expect(stage.fixtureCount).toBe(0);
    }
    // Not just the returned count — the fixtures TABLE itself must have no
    // rows for any of this division's stages, seeded or not.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from fixtures where stage_id in ${sql(stageIds)}`;
    expect(n).toBe(0);
  });

  it("regression: progression declared on a division's FIRST stage is a malformed template — refused 422, no orphan competition", async () => {
    await seedTemplateSportCatalog();
    const { auth } = await seedOrg("pro");
    const before = await competitionCount(auth.orgId);
    const template = SLAM_STAGE_TEMPLATE({
      progression: {
        sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 2 }] }],
        placement: "rank_order",
        timing: "setup",
      },
    });
    const name = `BadSeeding ${randomUUID().slice(0, 6)}`;
    await expect(
      instantiateTemplate(auth, template, { name, ends_on: "2030-12-31" }),
    ).rejects.toMatchObject({
      status: 422,
      code: TEMPLATE_INSTANTIATION_FAILED_CODE,
      extra: { divisionIndex: 0, stageIndex: 0 },
    });
    // Rollback, proven by re-querying rather than trusting the thrown
    // error: neither the count nor a same-named row survives.
    expect(await competitionCount(auth.orgId)).toBe(before);
    const [{ n: orphanCompetitions }] = await sql<{ n: number }[]>`
      select count(*)::int as n from competitions where org_id = ${auth.orgId} and name = ${name}`;
    expect(orphanCompetitions).toBe(0);
  });

  it("regression: progression's `take`/`map` mismatched against the source stage's REAL shape is refused 422, no orphan competition (reviewer follow-up on ac991ee5)", async () => {
    await seedTemplateSportCatalog();
    const { auth } = await seedOrg("pro");
    const before = await competitionCount(auth.orgId);
    // Source stage genuinely has 2 pools (A, B) — `topNPerGroup(n:1)`
    // against that REAL shape produces descriptor keys "A1"/"B1" only.
    // "C1" names a pool that doesn't exist: this can only be caught by
    // resolving the sibling stage's actual persisted shape, exactly what
    // stage-seeding.ts's validateStageProgression/sourceShapeOf do at save
    // time for a manually-built stage graph — instantiateTemplate must run
    // the SAME check, not merely persist the mismatch for a later 422 at
    // generate time (stages.ts's generateProgressionSetupFixtures).
    const template: CompetitionTemplate = {
      key: "test-shape-mismatch",
      version: 1,
      i18n: { nameKey: "templates.slam128.name", descriptionKey: "templates.slam128.desc" },
      divisions: [
        {
          i18nNameKey: "templates.slam128.div.main",
          sportKey: "tennis",
          variantKey: "grand-slam",
          entrantKind: "individual",
          entrantCount: 8,
          stages: [
            { i18nNameKey: "templates.stage.groupStage", kind: "group", groups: 2 },
            {
              i18nNameKey: "templates.stage.mainDraw",
              kind: "knockout",
              progression: {
                sources: [{ stage: "previous", take: [{ kind: "topNPerGroup", n: 1 }] }],
                placement: "seeded_map",
                map: [{ slot: "1", source: "C1" }],
                timing: "setup",
              },
            },
          ],
        },
      ],
    };
    const name = `ShapeMismatch ${randomUUID().slice(0, 6)}`;
    await expect(
      instantiateTemplate(auth, template, { name, ends_on: "2030-12-31" }),
    ).rejects.toMatchObject({
      status: 422,
      code: TEMPLATE_INSTANTIATION_FAILED_CODE,
      extra: { divisionIndex: 0, stageIndex: 1 },
    });
    expect(await competitionCount(auth.orgId)).toBe(before);
    const [{ n: orphanCompetitions }] = await sql<{ n: number }[]>`
      select count(*)::int as n from competitions where org_id = ${auth.orgId} and name = ${name}`;
    expect(orphanCompetitions).toBe(0);
  });
});
