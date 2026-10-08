// Task 5 (design 2026-09-17 §T4) — the pad surfaces resolve their config
// through `resolveFixtureCfg` instead of reading raw `division.config`.
//
// This is a regression suite for a defect that exists TODAY, before per-stage
// rules: `f/[no]/page.tsx` and `score/[token]/page.tsx` both render whatever
// the division config currently says, so a division edited after a match was
// scored already shows a format the fold never used. The stage overlay is the
// second half — with per-stage rules the override would be invisible on the
// very screen the organiser uses to score.
//
// Why these assertions name `config_snapshot` out loud: `hasFrozenCfg` treats
// `undefined` as absence (fixture-cfg.ts:62-64, trap documented at :53-57), so
// a query that joins the stage but forgets the snapshot column serves LIVE
// config for every scored fixture and raises nothing anywhere. The mutant for
// this suite is exactly that: drop `f.config_snapshot` from the select.
//
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { appendEvent, resolveModule } from "@/server/engine-db";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { loadFixturePadCfg } from "../fixtures";
import { putStageRules } from "../stage-rules";

import { setOrgPlan } from "@/lib/__tests__/_billing-group";
const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<AuthCtx> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Pc " + suffix}, ${"pc-" + suffix})
    returning id`;
  await setOrgPlan(orgId);
  await invalidateOrgEntitlements(orgId);
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

async function seedDivision(
  auth: AuthCtx,
  sportKey: string,
  variantKey: string,
  config: Record<string, unknown>,
  entrantKind: "individual" | "team",
): Promise<string> {
  const comp = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Pc Cup " + randomUUID().slice(0, 6),
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, comp.id, {
    name: "Open",
    slug: "open-" + randomUUID().slice(0, 6),
    sport_key: sportKey,
    variant_key: variantKey,
    config,
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: 2 }, (_, i) => ({
      kind: entrantKind,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  return division.id;
}

async function seedStage(
  auth: AuthCtx,
  divisionId: string,
  seq: number,
  config: Record<string, unknown> = {},
): Promise<string> {
  const [stage] = await createStages(auth, divisionId, {
    seq,
    kind: "league",
    name: "S" + seq,
    config,
    progression: null,
  });
  return stage!.id;
}

async function firstFixtureOf(stageId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select id from fixtures where stage_id = ${stageId} order by fixture_no limit 1`;
  return row!.id;
}

/** The drift this suite exists for, applied the only way that is possible
 *  after a fixture has been scored: the division-wide FORMAT_LOCKED guard
 *  (divisions.ts) refuses a `bestOf` edit through the usecase once play has
 *  started, but the rows it protects can still diverge — a pre-lock edit, an
 *  import, an /admin repair. What matters here is that the fixture's FROZEN
 *  config and the division's LIVE config disagree. */
async function driftDivisionConfig(divisionId: string, config: Record<string, unknown>): Promise<void> {
  await sql`update divisions set config = ${sql.json(config as never)} where id = ${divisionId}`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("loadFixturePadCfg (design §T4)", () => {
  it("serves a scored fixture's FROZEN config, never the live division config", async () => {
    const auth = await seedOrg();
    // Best-of-1 at scoring time. The value is asserted against the module's own
    // parse of the config that was live then, not a constant typed in here, so
    // a schema change moves the expectation with it.
    const divisionId = await seedDivision(auth, "tennis", "tour", { bestOf: 1 }, "individual");
    const stageId = await seedStage(auth, divisionId, 1);
    await generateStageFixtures(auth, stageId);
    const fixtureId = await firstFixtureOf(stageId);

    // The first append freezes `config_snapshot` (append-event.ts, lastSeq 0).
    await appendEvent(auth.orgId, fixtureId, 0, { type: "core.start", payload: {} });
    const [frozen] = await sql<{ config_snapshot: Record<string, unknown> | null }[]>`
      select config_snapshot from fixtures where id = ${fixtureId}`;
    expect(frozen!.config_snapshot).not.toBeNull(); // else the test is vacuous

    // …and only NOW does the division move. A pad reading raw division config
    // renders 5; the fold used 1, and the pad must agree with the fold.
    await driftDivisionConfig(divisionId, { bestOf: 5 });

    // W2a: the loader returns `{ cfg, stageKind }` (the pad needs the kind too).
    const cfg = (await loadFixturePadCfg(auth, fixtureId)).cfg as Record<string, unknown>;
    expect(cfg.bestOf).toBe(frozen!.config_snapshot!.bestOf);
    expect(cfg.bestOf).toBe(1);
  }, 30_000);

  it("serves the STAGE's rules override for a fixture that has not started", async () => {
    const auth = await seedOrg();
    const divisionId = await seedDivision(auth, "tennis", "tour", { bestOf: 5 }, "individual");
    const stageId = await seedStage(auth, divisionId, 1);
    const siblingId = await seedStage(auth, divisionId, 2);
    await generateStageFixtures(auth, stageId);
    await generateStageFixtures(auth, siblingId);

    // Best-of-3 in this stage only — the whole point of the feature.
    await putStageRules(auth, stageId, { rules: { bestOf: 3 } });

    const overridden = (await loadFixturePadCfg(
      auth,
      await firstFixtureOf(stageId),
    )).cfg as Record<string, unknown>;
    expect(overridden.bestOf).toBe(3);

    // The sibling stage still inherits: three distinct values (1/3/5 across
    // this suite) so no assertion can be satisfied by the wrong constant.
    const inherited = (await loadFixturePadCfg(
      auth,
      await firstFixtureOf(siblingId),
    )).cfg as Record<string, unknown>;
    expect(inherited.bestOf).toBe(5);
  }, 30_000);

  it("still applies a stage that carries only a decider key", async () => {
    const auth = await seedOrg();
    // `shootout` is a boolean in football's own schema, default false — the
    // expectation is derived from that declaration, not asserted as a literal
    // the test invented.
    const divisionId = await seedDivision(auth, "football", "11-a-side", {}, "team");
    const [div] = await sql<{ sport_key: string; module_version: string; config: unknown }[]>`
      select sport_key, module_version, config from divisions where id = ${divisionId}`;
    const parsed = resolveModule(div!.sport_key, div!.module_version).configSchema.parse(
      div!.config,
    ) as Record<string, unknown>;
    expect(parsed.shootout).toBe(false); // the division default the stage must beat

    const stageId = await seedStage(auth, divisionId, 1, { shootout: true });
    await generateStageFixtures(auth, stageId);

    const cfg = (await loadFixturePadCfg(auth, await firstFixtureOf(stageId))).cfg as Record<
      string,
      unknown
    >;
    expect(cfg.shootout).toBe(true);
  }, 30_000);

  it("404s for a fixture in another org", async () => {
    const owner = await seedOrg();
    const stranger = await seedOrg();
    const divisionId = await seedDivision(owner, "tennis", "tour", { bestOf: 3 }, "individual");
    const stageId = await seedStage(owner, divisionId, 1);
    await generateStageFixtures(owner, stageId);
    const fixtureId = await firstFixtureOf(stageId);
    await expect(loadFixturePadCfg(stranger, fixtureId)).rejects.toMatchObject({ status: 404 });
  }, 30_000);
});
