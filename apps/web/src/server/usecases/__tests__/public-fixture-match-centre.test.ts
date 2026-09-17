// Spectator surface W1, Task 9 — `publicFixture` (usecases/public.ts) gains
// `match_centre`, built by the shared `loadMatchCentre` loader
// (public-site/match-centre-load.ts). Real Postgres required (RLS, engine-db,
// score_events) — skipped without DATABASE_URL, same convention as every
// other DB-backed suite in this directory.
//
// `resolveModule`/`resolveLatestModule` are spied (real implementation
// wrapped, `join-route.test.ts`'s own convention) rather than mocked away —
// wiring assertions (mutant guard b: the division's OWN pinned module_version
// must reach the resolver, never `null`/latest) and real DB-backed behaviour
// coexist without diverging.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/engine-db/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/engine-db/registry")>();
  return {
    ...actual,
    resolveModule: vi.fn(actual.resolveModule),
    resolveLatestModule: vi.fn(actual.resolveLatestModule),
  };
});

import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { resolveModule, resolveLatestModule } from "@/server/engine-db/registry";
import { MatchCentreDoc } from "@/server/public-site/match-centre-schema";
import { seedOrg, GENERIC_CONFIG } from "./_seed";
import { makeCommunityRig } from "./_rig";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { scoreEvent } from "../scoring";
import { publicFixture } from "../public";

const HAS_DB = !!process.env.DATABASE_URL;
const resolveModuleSpy = vi.mocked(resolveModule);
const resolveLatestModuleSpy = vi.mocked(resolveLatestModule);

beforeEach(() => {
  resolveModuleSpy.mockClear();
  resolveLatestModuleSpy.mockClear();
});

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** A public generic-sport division with one fixture, two individual
 *  entrants and no events — the smallest rig that reaches `publicFixture`'s
 *  `match_centre` build without needing cricket's own scoring machinery. */
async function publicGenericFixture(): Promise<{ fixtureId: string; divisionId: string; moduleVersion: string }> {
  const { auth } = await seedOrg("pro");
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "MC Cup",
    visibility: "public", // required: public_fixtures_v filters on this
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: GENERIC_CONFIG,
  });
  await createEntrants(
    auth,
    division.id,
    ["A", "B"].map((name, i) => ({ kind: "individual" as const, display_name: name, seed: i + 1, members: [] })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  return { fixtureId: fixtures[0]!.id, divisionId: division.id, moduleVersion: division.module_version };
}

describe.skipIf(!HAS_DB)("publicFixture — match_centre (Task 9)", () => {
  it("carries a schema-valid match_centre document naming this exact fixture", async () => {
    const { fixtureId } = await publicGenericFixture();
    const res = (await publicFixture(fixtureId)) as { match_centre: unknown };
    expect((res.match_centre as { fixtureId: string }).fixtureId).toBe(fixtureId);
    const parsed = MatchCentreDoc.safeParse(res.match_centre);
    expect(parsed.success).toBe(true);
  });

  it("resolves the DIVISION'S OWN pinned module_version — never null/latest (mutation guard b)", async () => {
    const { fixtureId, moduleVersion } = await publicGenericFixture();
    await publicFixture(fixtureId);
    expect(resolveModuleSpy).toHaveBeenCalledWith("generic", moduleVersion);
    expect(resolveLatestModuleSpy).not.toHaveBeenCalled();
  });

  it("a seeded band-3 cricket match carries tabs [summary, scorecard, commentary, info]", async () => {
    const rig = await makeCommunityRig("cricket");
    // makeCommunityRig seeds a PRIVATE competition (its own doc comment);
    // publicFixture requires public/unlisted (public_fixtures_v's own
    // filter) — flip it directly, out of band, the same way
    // public-slot-labels.test.ts forces a raw-SQL fixture state it has no
    // usecase to reach.
    await sql`
      update competitions set visibility = 'public'
      where id = (select competition_id from divisions where id = (
        select division_id from fixtures where id = ${rig.fixtureId}))`;

    await scoreEvent(rig.auth, rig.fixtureId, { expected_seq: 0, type: "core.start", payload: {} });
    const striker = rig.personIdsBySide[0][0]!;
    const nonStriker = rig.personIdsBySide[0][1]!;
    const bowler = rig.personIdsBySide[1][0]!;
    // cricket.ball is band 3 ("detail") — cricket.ts:3220's own fidelity map.
    await scoreEvent(rig.auth, rig.fixtureId, {
      expected_seq: 1,
      type: "cricket.ball",
      payload: { over: 0, ballInOver: 1, striker, nonStriker, bowler, runs: { bat: 4 } },
    });

    const res = (await publicFixture(rig.fixtureId)) as { match_centre: { tabs: string[] } };
    expect(res.match_centre.tabs).toEqual(["summary", "scorecard", "commentary", "info"]);
  });

  it("a private competition's fixture still 404s — unchanged by this task", async () => {
    const { auth } = await seedOrg("pro");
    const competition = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Private Cup",
      visibility: "private",
      branding: {},
    });
    const division = await createDivision(auth, competition.id, {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
    });
    await createEntrants(
      auth,
      division.id,
      ["A", "B"].map((name, i) => ({ kind: "individual" as const, display_name: name, seed: i + 1, members: [] })),
    );
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "League", config: {} });
    const { fixtures } = await generateStageFixtures(auth, stage!.id);

    await expect(publicFixture(fixtures[0]!.id)).rejects.toThrow(HttpError);
    await expect(publicFixture(fixtures[0]!.id)).rejects.toMatchObject({ status: 404 });
  });

  // Task 16 gate regression. This loader ran `configSchema.parse(rawCfg)`,
  // which is STRICTER than the production read path: `fold.ts` gives
  // `resolveFixtureCfg`'s output to `foldMatch` unparsed and `module.init`
  // takes it raw, and `fixture-cfg.ts` states plainly that "`{}` is a
  // legitimate config for several modules". So a division row carrying `{}`
  // threw ZodError (`resultMode` invalid_value, `allowDraws` undefined) out
  // of `loadMatchCentre` — and because Task 9 calls it inside `publicFixture`,
  // the whole public fixture response 500'd, not merely its match centre.
  //
  // The config is set by SQL on purpose: `createDivision` writes a complete
  // config, so the shape under test is the LEGACY/partial row that already
  // exists in the database — the same shape `public-court-venue-names.test.ts`
  // inserts, which is the test that caught this. That one is named for venue
  // names and would not tell a later reader what it is really holding down.
  it("a division whose config is {} serves the page instead of throwing", async () => {
    const { fixtureId, divisionId } = await publicGenericFixture();
    await sql`update divisions set config = '{}'::jsonb where id = ${divisionId}`;

    const res = (await publicFixture(fixtureId)) as { match_centre: unknown };

    // The assertion is that it RESOLVES at all — but pin the doc too, so a
    // future "fix" that swallows the error into a null match_centre and still
    // returns a 200 cannot pass this test quietly.
    expect(res.match_centre).not.toBeNull();
    expect(MatchCentreDoc.safeParse(res.match_centre).success).toBe(true);
  });

  // T16b fix round 3. This document replaces the page's on every poll, and it
  // printed `divisions.variant_key` raw ("score") where the page's own loader
  // printed the catalog name — now both name a declared variant through
  // server/public-site/variant-label.ts, in the org's locale.
  it("names the division's format in the org's locale, through the variant map", async () => {
    const { fixtureId, divisionId } = await publicGenericFixture();
    await sql`
      update organizations set default_locale = 'es'
      where id = (select org_id from divisions where id = ${divisionId})`;

    const res = (await publicFixture(fixtureId)) as { match_centre: unknown };
    const meta = MatchCentreDoc.parse(res.match_centre).header.metaLine ?? "";
    expect(meta, "es `variant.generic.score`").toContain("Marcador");
    expect(meta).not.toMatch(/\bscore\b/i);
  });
});
