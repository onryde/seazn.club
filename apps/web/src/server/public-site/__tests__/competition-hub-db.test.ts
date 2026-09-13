// Spectator surface W2, Task 4 — the competition hub against real Postgres.
//
// The DB half. `competition-hub.test.ts` beside this file doubles every reader
// and proves the document ASSEMBLY on every run; only a real database can
// prove the things those doubles stand in for: that the visibility gate
// actually refuses a private competition, that the division/stage/fixture/
// standings reads compose into a document that parses, and — ruling B — that a
// division with fixtures and a standings snapshot but ZERO
// `player_stat_snapshots` rows degrades to no boards and no Stats tab with no
// error and no empty shell. That is the COMMON case in production, not an
// edge: the snapshot table is a recompute-on-read cache whose only writer runs
// from the two stats endpoints, a person merge and a doubly-conditional
// auto-posts path.
//
// Real Postgres required; skipped without DATABASE_URL, same convention as
// `consent.test.ts`, whose seeding shape this reuses verbatim rather than
// inventing a second one.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// `unstable_cache` is a Next server-runtime API with no incrementalCache
// outside a real request — passthrough, never a memoising double: caching a
// division read across the granted and denied cases is exactly the failure
// mode two of these tests exist to catch.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { sql } from "@/lib/db";
import { invalidateOrgEntitlements } from "@/lib/entitlements";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { createStages, generateStageFixtures } from "@/server/usecases/stages";
import { CompetitionHubDoc } from "../competition-hub-schema";
import { loadCompetitionHub } from "../competition-hub";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

interface Scene {
  orgId: string;
  orgSlug: string;
  compSlug: string;
  privateSlug: string;
  divisionSlug: string;
  stageId: string;
  fixtureIds: string[];
  /** The separate knockout competition (see `seed`). */
  koCompSlug: string;
  koStageId: string;
}

let scene: Scene;

async function seed(): Promise<Scene> {
  const suffix = randomUUID().slice(0, 8);
  const orgSlug = `hub-org-${suffix}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Hub Org " + suffix}, ${orgSlug})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  // Two competitions exceed nothing on their own, but the community quota
  // silently DOWNGRADES an over-cap public competition to private, which would
  // make the visibility test pass for the wrong reason. Lift it, the way
  // consent.test.ts does for the same reason.
  await sql`
    insert into org_entitlement_overrides (org_id, feature_key, int_value, reason)
    values (${orgId}, 'competitions.max_active', null, 'test')`;

  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };

  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Hub Cup " + suffix,
    visibility: "public",
    branding: {},
  });
  const hidden = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Hidden Cup " + suffix,
    visibility: "private",
    branding: {},
  });

  const division = await createDivision(auth, competition.id, {
    name: "Open",
    slug: "open",
    sport_key: "generic",
    variant_key: "score",
    config: DIVISION_CONFIG,
  });
  await createEntrants(auth, division.id, [
    { kind: "team", display_name: "Blue Blazers", seed: 1, members: [] },
    { kind: "team", display_name: "Red Rockets", seed: 2, members: [] },
    { kind: "team", display_name: "Green Giants", seed: 3, members: [] },
  ]);
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "League",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);

  // A standings snapshot WITHOUT any scoring: the hub must publish a table
  // from the persisted snapshot, and nothing in this file scores a fixture, so
  // no `player_stat_snapshots` row can exist. `org_id` is filled by the
  // `set_org_from_parent('stages','stage_id')` trigger (V225).
  const entrants = await sql<{ id: string }[]>`
    select id from entrants where division_id = ${division.id} order by seed`;
  await sql`
    insert into standings_snapshots (stage_id, pool_id, rows, computed_through_seq)
    values (${stage!.id}, null, ${sql.json(
      entrants.map((e, i) => ({
        entrantId: e.id,
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        points: 0,
        metrics: {},
        rank: i + 1,
      })),
    )}, 0)`;

  // A THIRD, public competition holding one knockout division — kept apart
  // from the league scene above so none of its assertions (every match in one
  // division, exactly three teams, a tab list with no Knockout) moves. Four
  // entrants and a bronze match: two semis, then the final and the third-place
  // match, generated by the real engine and persisted with the real
  // lane/is_final/third_place columns `public_fixtures_v` exposes.
  const cupCompetition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Knockout Cup " + suffix,
    visibility: "public",
    branding: {},
  });
  const cupDivision = await createDivision(auth, cupCompetition.id, {
    name: "Cup",
    slug: "cup",
    sport_key: "generic",
    variant_key: "score",
    config: DIVISION_CONFIG,
  });
  await createEntrants(
    auth,
    cupDivision.id,
    ["North", "South", "East", "West"].map((name, i) => ({
      kind: "team" as const,
      display_name: name,
      seed: i + 1,
      members: [],
    })),
  );
  const [koStage] = await createStages(auth, cupDivision.id, {
    seq: 1,
    kind: "knockout",
    name: "Cup",
    config: { thirdPlace: true },
  });
  await generateStageFixtures(auth, koStage!.id);

  return {
    orgId,
    orgSlug,
    compSlug: competition.slug,
    privateSlug: hidden.slug,
    divisionSlug: division.slug,
    stageId: stage!.id,
    fixtureIds: fixtures.map((f) => f.id),
    koCompSlug: cupCompetition.slug,
    koStageId: koStage!.id,
  };
}

/** Write (or clear) an explicit `stats.player` answer for the seeded org. The
 *  key is free on every plan since W3-A, so an override is the ONLY refusal
 *  left on it — and the only way to exercise the denied arm honestly. */
async function setStatsPlayer(orgId: string, value: boolean | null): Promise<void> {
  if (value === null) {
    await sql`delete from org_entitlement_overrides
              where org_id = ${orgId} and feature_key = 'stats.player'`;
  } else {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${orgId}, 'stats.player', ${value}, 'test')
      on conflict (org_id, feature_key) do update set bool_value = excluded.bool_value`;
  }
  // The resolver caches for 300 s; an override written mid-file is invisible
  // without this, which would make the denied arm pass on a stale grant.
  await invalidateOrgEntitlements(orgId);
}

beforeAll(async () => {
  if (!HAS_DB) return;
  scene = await seed();
}, 60_000);

afterAll(async () => {
  if (!HAS_DB) return;
  // The same teardown `consent.test.ts` uses — the pooled client is a global
  // singleton, so it is cleared as well as ended.
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("loadCompetitionHub — against real Postgres", () => {
  it("a seeded competition produces a document that parses against the schema", async () => {
    const doc = (await loadCompetitionHub(scene.orgSlug, scene.compSlug))!;
    const parsed = CompetitionHubDoc.safeParse(doc);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
    expect(doc.competitionSlug).toBe(scene.compSlug);
    expect(doc.orgSlug).toBe(scene.orgSlug);
  });

  it("every generated fixture reaches the hub, each with a real division and href", async () => {
    const doc = (await loadCompetitionHub(scene.orgSlug, scene.compSlug))!;
    expect(doc.matches.map((m) => m.fixtureId).sort()).toEqual([...scene.fixtureIds].sort());
    for (const match of doc.matches) {
      expect(match.divisionSlug).toBe(scene.divisionSlug);
      expect(match.href).toBe(
        `/shared/${scene.orgSlug}/${scene.compSlug}/${scene.divisionSlug}/fixtures/${match.fixtureId}`,
      );
      // Names come from the masked entrant read, never a raw column, and are
      // never blank.
      for (const side of match.header.sides) expect(side.name).not.toBe("");
      expect(match.header.live).toBe(match.bucket === "live");
    }
  });

  it("the persisted standings snapshot becomes a table, with the entrants' names", async () => {
    const doc = (await loadCompetitionHub(scene.orgSlug, scene.compSlug))!;
    expect(doc.tables).toHaveLength(1);
    expect(doc.tables[0]!.caption).toBe("League");
    expect(doc.tables[0]!.rows.map((r) => r.name).sort()).toEqual([
      "Blue Blazers",
      "Green Giants",
      "Red Rockets",
    ]);
    expect(doc.tables[0]!.fullHref).toBe(
      `/shared/${scene.orgSlug}/${scene.compSlug}/${scene.divisionSlug}?tab=standings`,
    );
  });

  it("EMPTY LEADER BOARDS: fixtures and a table, but no snapshot rows → no boards, no Stats tab, no error", async () => {
    // Ruling B, proven where it matters: `stats.player` is GRANTED, so the
    // real `readLeaderRows` runs its real query against a division that has
    // simply never had its stats recomputed. Nothing throws, the document
    // parses, and the Stats tab is absent by DERIVATION rather than by a
    // special case.
    await setStatsPlayer(scene.orgId, true);
    const snapshots = await sql<{ n: number }[]>`
      select count(*)::int as n from player_stat_snapshots ps
      join divisions d on d.id = ps.division_id
      where d.competition_id = (select id from competitions
                                where slug = ${scene.compSlug} and org_id = ${scene.orgId})`;
    expect(snapshots[0]!.n).toBe(0);

    const doc = (await loadCompetitionHub(scene.orgSlug, scene.compSlug))!;
    expect(doc.leaders).toEqual([]);
    expect(doc.tabs).not.toContain("stats");
    expect(doc.tabs).toEqual(["overview", "matches", "table", "teams", "info"]);
    // A missing tab, not a degraded document.
    expect(doc.matches.length).toBeGreaterThan(0);
    expect(doc.tables).toHaveLength(1);
    expect(doc.teams).toHaveLength(3);
    expect(CompetitionHubDoc.safeParse(doc).success).toBe(true);
  });

  it("an org_entitlement_overrides DENY on stats.player also yields no boards", async () => {
    // The other arm of ruling A. `publicDivisionStats` 404s on this deny; the
    // hub must not publish what the org's own signed-in read is refused.
    await setStatsPlayer(scene.orgId, false);
    const doc = (await loadCompetitionHub(scene.orgSlug, scene.compSlug))!;
    expect(doc.leaders).toEqual([]);
    expect(doc.tabs).not.toContain("stats");
    // The rest of the hub is untouched by the deny.
    expect(doc.matches.length).toBeGreaterThan(0);
    expect(doc.tables).toHaveLength(1);
    await setStatsPlayer(scene.orgId, true);
  });

  it("a real KNOCKOUT stage is read back into `knockouts` — rounds, labels and the Draw verdict off persisted rows", async () => {
    // The doubles in `competition-hub.test.ts` hand the builder `lane`,
    // `is_final` and `third_place` directly; only this proves the division read
    // actually SELECTS them (data.ts warns every explicit select must list them
    // by hand or they arrive `undefined`), because the round order below is
    // decided by exactly those columns.
    const rows = await sql<
      { id: string; round_no: number; seq_in_round: number; is_final: boolean; third_place: boolean }[]
    >`
      select id, round_no, seq_in_round, is_final, third_place from fixtures
      where stage_id = ${scene.koStageId} order by round_no, seq_in_round`;
    expect(rows).toHaveLength(4); // 2 semis, then the final and the bronze match
    const first = Math.min(...rows.map((r) => r.round_no));
    const last = Math.max(...rows.map((r) => r.round_no));
    const roundIds = (n: number) => rows.filter((r) => r.round_no === n && !r.third_place).map((r) => r.id);
    const bronzeIds = rows.filter((r) => r.third_place).map((r) => r.id);
    expect(bronzeIds).toHaveLength(1);
    expect(rows.filter((r) => r.is_final).map((r) => r.id)).toEqual(roundIds(last));

    const doc = (await loadCompetitionHub(scene.orgSlug, scene.koCompSlug))!;
    expect(CompetitionHubDoc.safeParse(doc).error?.issues ?? []).toEqual([]);
    // A bracket publishes no table; the Knockout tab stands where Table would.
    expect(doc.tables).toEqual([]);
    expect(doc.tabs).toEqual(["overview", "matches", "knockout", "teams", "info"]);
    expect(doc.knockouts).toHaveLength(1);
    const view = doc.knockouts[0]!;
    expect(view).toMatchObject({
      id: `cup-${scene.koStageId}`,
      divisionSlug: "cup",
      stageId: scene.koStageId,
      stageName: "Cup",
      kind: "knockout",
      drawable: true,
      championFixtureId: null,
    });
    expect(view.rounds.map((r) => r.key)).toEqual([`main-${first}`, "third-place", `main-${last}`]);
    expect(view.rounds.map((r) => r.fixtureIds)).toEqual([roundIds(first), bronzeIds, roundIds(last)]);
    const carried = new Map(doc.matches.map((m) => [m.fixtureId, m.roundLabel]));
    for (const round of view.rounds) expect(round.label).toBe(carried.get(round.fixtureIds[0]!));
  });

  it("a PRIVATE competition → null (the page 404s it)", async () => {
    expect(await loadCompetitionHub(scene.orgSlug, scene.privateSlug)).toBeNull();
  });

  it("an org or competition that does not exist → null", async () => {
    expect(await loadCompetitionHub(scene.orgSlug, "no-such-competition")).toBeNull();
    expect(await loadCompetitionHub("no-such-org", scene.compSlug)).toBeNull();
  });
});
