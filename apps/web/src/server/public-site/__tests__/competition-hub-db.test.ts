// Spectator surface W2, Task 4 — the competition hub against real Postgres.
//
// The DB half. `competition-hub.test.ts` beside this file doubles every reader
// and proves the document ASSEMBLY on every run; only a real database can
// prove the things those doubles stand in for: that the visibility gate
// actually refuses a private competition, that the division/stage/fixture/
// standings reads compose into a document that parses, and — ruling B — that a
// division with fixtures and a standings snapshot but ZERO
// `player_stat_snapshots` rows degrades to no boards and no Stats tab with no
// error and no empty shell. Every division is in that state until its first
// finished match: the snapshot is refreshed after each result
// (`usecases/player-stats-refresh.ts`), and a fixture seeded here without
// scoring through that path never schedules one.
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
import { getPublicDivision } from "../data";
import { divisionChampion } from "../champion";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { boardgame } from "@seazn/engine/sports/boardgame";
import enPublic from "@/dictionaries/en/public.json";
import { scoreEvent } from "@/server/usecases/scoring";
import { getFixtureState } from "@/server/usecases/fixtures";
import { KnockoutTab } from "@/components/public-site/matches-hub/knockout-tab";

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
  // no `player_stat_snapshots` row can exist. The generate above wrote it — the
  // stage's LEVEL table (W2d concern 2, spec §5.7) — so no row is seeded by hand.
  const [{ n: stored }] = await sql<{ n: number }[]>`
    select count(*)::int as n from standings_snapshots where stage_id = ${stage!.id} and pool_id is null`;
  if (stored !== 1) throw new Error(`rig: the generate wrote ${stored} table(s) for the league, not 1`);

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

  it("a knockout FINAL stored decided with a winner crowns from real rows — the view names that final, and divisionChampion the same entrant", async () => {
    // What the builder suite's doubles cannot witness: `bracketChampion` reading
    // a STORED row's status, outcome and is_final back through
    // `public_fixtures_v` (which does not redact `outcome`). Written the way this
    // repo's DB tests record a result (`placement-snapshots.test.ts`), with the
    // bronze match left unplayed so the final alone must decide, and put back in
    // `finally` so the read-back case above keeps its unplayed bracket.
    const [final] = await sql<
      { id: string; status: string; outcome: unknown; home_entrant_id: string | null; away_entrant_id: string | null }[]
    >`
      select id, status, outcome, home_entrant_id, away_entrant_id from fixtures
      where stage_id = ${scene.koStageId} and is_final`;
    expect(final).toBeDefined();
    expect(final!.status).toBe("scheduled");
    expect(final!.outcome).toBeNull();
    const [north, south] = await sql<{ id: string }[]>`
      select e.id from entrants e
      join divisions d on d.id = e.division_id
      join competitions c on c.id = d.competition_id
      where c.org_id = ${scene.orgId} and c.slug = ${scene.koCompSlug} and d.slug = 'cup'
      order by e.seed`;

    try {
      await sql`
        update fixtures
        set status = 'decided', home_entrant_id = ${north!.id}, away_entrant_id = ${south!.id},
            outcome = ${sql.json({ kind: "win", winner: south!.id, loser: north!.id })}
        where id = ${final!.id}`;

      const doc = (await loadCompetitionHub(scene.orgSlug, scene.koCompSlug))!;
      expect(CompetitionHubDoc.safeParse(doc).error?.issues ?? []).toEqual([]);
      expect(doc.knockouts[0]!.championFixtureId).toBe(final!.id);
      const match = doc.matches.find((m) => m.fixtureId === final!.id)!;
      expect(match.header.sides[match.winnerIndex!]!.entrantId).toBe(south!.id);

      // A bracket-only division publishes no table, so the Table crown is not
      // reachable from this document. The division page's crown is: the same
      // `divisionChampion` call the page makes, over the same real division read.
      const detail = (await getPublicDivision(scene.orgSlug, scene.koCompSlug, "cup"))!;
      expect(divisionChampion(detail.stages, detail.fixtures, detail.standings)).toBe(south!.id);
    } finally {
      await sql`
        update fixtures
        set status = 'scheduled', home_entrant_id = ${final!.home_entrant_id},
            away_entrant_id = ${final!.away_entrant_id}, outcome = null
        where id = ${final!.id}`;
    }
  });

  it("W2b Task 13 (X-RS-2, X-AB-2): a stored walkover and a stored abandon reach the hub card as their tag and sentence", async () => {
    // The producer end of the results card's chip, through the real division read (`readFixtures`' abandon_reason
    // column) — the builder's unit test (forfeit-tag-surfaces.test.tsx) hands it rows by hand. Rows are written the way
    // the knockout case above writes them, and put back in `finally`.
    const [wo, ab] = scene.fixtureIds;
    const before = await sql<{ id: string; status: string; outcome: unknown; home_entrant_id: string; away_entrant_id: string }[]>`
      select id, status, outcome, home_entrant_id, away_entrant_id from fixtures where id in (${wo!}, ${ab!})`;
    const row = (id: string) => before.find((r) => r.id === id)!;
    const name = async (id: string) => (await sql<{ display_name: string }[]>`select display_name from entrants where id = ${id}`)[0]!.display_name;
    try {
      await sql`update fixtures set status = 'forfeited',
                  outcome = ${sql.json({ kind: "award", winner: row(wo!).home_entrant_id, loser: row(wo!).away_entrant_id, reason: "walkover" })}
                where id = ${wo!}`;
      await sql`update fixtures set status = 'decided',
                  outcome = ${sql.json({ kind: "win", winner: row(ab!).home_entrant_id, loser: row(ab!).away_entrant_id, method: "abandoned" })}
                where id = ${ab!}`;
      await sql`insert into score_events (id, fixture_id, seq, type, payload, recorded_at)
                values (${randomUUID()}, ${ab!}, 1, 'core.start', ${sql.json({})}, now()),
                       (${randomUUID()}, ${ab!}, 2, 'core.abandon', ${sql.json({ reason: "floodlights" })}, now())`;
      const doc = (await loadCompetitionHub(scene.orgSlug, scene.compSlug))!;
      expect(CompetitionHubDoc.safeParse(doc).error?.issues ?? []).toEqual([]);
      const card = (id: string) => doc.matches.find((m) => m.fixtureId === id)!;
      // Loop R M-10: a walkover stored with no ledger at all was not played (the engine's reader on an empty ledger).
      expect(card(wo!).forfeit).toEqual({
        kind: "walkover", tag: "w/o", sentence: `${await name(row(wo!).away_entrant_id)} didn't turn up — walkover`, played: false,
      });
      // An abandon's tag carries no `played`: the banner's walkover line is a forfeit's question.
      expect(card(ab!).forfeit && "played" in card(ab!).forfeit!).toBe(false);
      expect(card(ab!).forfeit?.kind).toBe("abandoned");
      expect(card(ab!).forfeit?.tag).toBe("Aband.");
      expect(card(ab!).forfeit?.sentence).toMatch(/^Abandoned \(floodlights\)/);
      // The positive pair: every other card carries none.
      const others = doc.matches.filter((m) => m.fixtureId !== wo && m.fixtureId !== ab);
      expect(others.length).toBeGreaterThan(0);
      expect(others.filter((m) => m.forfeit != null).map((m) => m.fixtureId)).toEqual([]);
    } finally {
      await sql`delete from score_events where fixture_id = ${ab!}`;
      for (const r of before) {
        await sql`update fixtures set status = ${r.status}, outcome = ${r.outcome === null ? null : sql.json(r.outcome as never)} where id = ${r.id}`;
      }
    }
  });

  // Loop R M-10 — the champion banner's walkover line reads whether the final was PLAYED, the producer's
  // `forfeit.played` (the engine's one "played" reader over the final's real ledger, `fixturesStatsReading`), never the
  // forfeit's kind. Written through the real scoring path (`scoreEvent`: the kernel's phase guard admits each forfeit
  // and stores its award), read back through the real hub and rendered by the real tab. Two sports, chosen for the one
  // declaration that changes the answer (ruling 118: chess's Start is play): generic and boardgame.
  it("M-10: a final forfeited after a bare Start reads as a walkover, after real play as 'Beat X' — and in chess the Start is play (ruling 118)", async () => {
    const auth: AuthCtx = { orgId: scene.orgId, via: "session", userId: null, role: "owner", keyId: null };
    await sql`
      insert into sports (key, name, module_version, position_catalog)
      values ('boardgame', 'Board game', ${boardgame.version}, ${sql.json(boardgame.positions as never)})
      on conflict (key) do nothing`;
    await sql`
      insert into sport_variants (sport_key, key, name, config, is_system)
      values ('boardgame', 'classical', 'Classical', ${sql.json(boardgame.variants.classical as never)}, true)
      on conflict do nothing`;
    const finalOf = async (sport: "generic" | "boardgame") => {
      const comp = await createCompetition(auth, {
        ends_on: "2030-12-31", name: `Final ${sport} ${randomUUID().slice(0, 6)}`, visibility: "public", branding: {},
      });
      const division = await createDivision(auth, comp.id, {
        name: "Final", slug: "final",
        ...(sport === "generic"
          ? { sport_key: "generic", variant_key: "score", config: DIVISION_CONFIG }
          : { sport_key: "boardgame", variant_key: "classical", config: {} }),
      });
      await createEntrants(auth, division.id, ["Ada", "Bea"].map((display_name, i) => ({
        kind: sport === "generic" ? ("team" as const) : ("individual" as const), display_name, seed: i + 1, members: [],
      })));
      const [stage] = await createStages(auth, division.id, { seq: 1, kind: "knockout", name: "Cup", config: {} });
      await generateStageFixtures(auth, stage!.id);
      // Scoring opens at the division's start (doc 12 §1); the start action's own side effects are not under test.
      await sql`update divisions set status = 'active' where id = ${division.id}`;
      const [final] = await sql<{ id: string; home_entrant_id: string; away_entrant_id: string }[]>`
        select id, home_entrant_id, away_entrant_id from fixtures where stage_id = ${stage!.id} and is_final`;
      expect(final?.home_entrant_id && final.away_entrant_id, `${sport}: a two-entrant final is seated`).toBeTruthy();
      return { compSlug: comp.slug, ...final! };
    };
    const record = async (fixtureId: string, type: string, payload: Record<string, unknown>) => {
      const { last_seq } = await getFixtureState(auth, fixtureId);
      await scoreEvent(auth, fixtureId, { expected_seq: last_seq, type, payload });
    };
    const read = async (compSlug: string, finalId: string) => {
      const doc = (await loadCompetitionHub(scene.orgSlug, compSlug))!;
      expect(CompetitionHubDoc.safeParse(doc).error?.issues ?? []).toEqual([]);
      expect(doc.knockouts[0]?.championFixtureId, "the final crowns").toBe(finalId);
      const card = doc.matches.find((m) => m.fixtureId === finalId)!;
      const h = renderToStaticMarkup(createElement(KnockoutTab, { doc, dict: enPublic, locale: "en", now: Date.parse(doc.generatedAt) }));
      return { card, banner: h, round: card.roundLabel ?? "" };
    };
    const line = (key: "knockout.championLine" | "knockout.championLineWalkover", name: string, round: string) =>
      `>${enPublic[key].replace("{name}", name).replace("{round}", round)}`;

    // generic, a bare Start then a disqualification: nothing played (ruling 115) — the walkover line, no tag.
    const bare = await finalOf("generic");
    await record(bare.id, "core.start", {});
    await record(bare.id, "core.forfeit", { by: bare.away_entrant_id, reason: "disqualified" });
    const a = await read(bare.compSlug, bare.id);
    expect(a.card.forfeit).toMatchObject({ kind: "disqualified", tag: enPublic["forfeit.tag.disqualified"], played: false });
    expect(a.banner).toContain(line("knockout.championLineWalkover", "Bea", a.round));
    expect(a.banner).not.toContain("mh-knockout-champion-forfeit");

    // generic, a point played first: the same disqualification, played — "Beat Bea", with its tag beside.
    const played = await finalOf("generic");
    await record(played.id, "core.start", {});
    await record(played.id, "generic.score", { by: played.home_entrant_id, points: 1 });
    await record(played.id, "core.forfeit", { by: played.away_entrant_id, reason: "disqualified" });
    const b = await read(played.compSlug, played.id);
    expect(b.card.forfeit).toMatchObject({ kind: "disqualified", played: true });
    expect(b.banner).toContain(line("knockout.championLine", "Bea", b.round));
    expect(b.banner).toContain("mh-knockout-champion-forfeit");

    // boardgame, a bare Start then a disqualification: chess's Start IS play (ruling 118) — "Beat Bea".
    const chess = await finalOf("boardgame");
    await record(chess.id, "core.start", {});
    await record(chess.id, "core.forfeit", { by: chess.away_entrant_id, reason: "disqualified" });
    const c = await read(chess.compSlug, chess.id);
    expect(c.card.forfeit).toMatchObject({ kind: "disqualified", played: true });
    expect(c.banner).toContain(line("knockout.championLine", "Bea", c.round));
  }, 60_000);

  it("a PRIVATE competition → null (the page 404s it)", async () => {
    expect(await loadCompetitionHub(scene.orgSlug, scene.privateSlug)).toBeNull();
  });

  it("an org or competition that does not exist → null", async () => {
    expect(await loadCompetitionHub(scene.orgSlug, "no-such-competition")).toBeNull();
    expect(await loadCompetitionHub("no-such-org", scene.compSlug)).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("loadCompetitionHub — squads, bans and division prose off real rows", () => {
  it("members arrive masked in the view's order; the ban marks the banned PERSON, not their same-named twin; a youth division never links; prose and team calendars ride along", async () => {
    // Its OWN competition, so no assertion above (three teams, one division,
    // no Knockout) moves.
    const auth: AuthCtx = { orgId: scene.orgId, via: "session", userId: null, role: "owner", keyId: null };
    const competition = await createCompetition(auth, {
      ends_on: "2030-12-31",
      name: "Squad Cup " + randomUUID().slice(0, 8),
      visibility: "public",
      branding: {},
    });
    const open = await createDivision(auth, competition.id, {
      name: "Open",
      slug: "open",
      sport_key: "generic",
      variant_key: "score",
      config: DIVISION_CONFIG,
    });
    const youth = await createDivision(auth, competition.id, {
      name: "Under 12",
      slug: "u12",
      sport_key: "generic",
      variant_key: "score",
      config: DIVISION_CONFIG,
    });
    await sql`update divisions set description = 'Bring **boots**.' where id = ${open.id}`;
    await sql`update divisions set youth = true where id = ${youth.id}`;
    await createEntrants(auth, open.id, [
      { kind: "team", display_name: "Alpha", seed: 1, members: [] },
      { kind: "team", display_name: "Bravo", seed: 2, members: [] },
    ]);
    await createEntrants(auth, youth.id, [{ kind: "team", display_name: "Cubs", seed: 1, members: [] }]);
    const entrantId = async (divisionId: string, name: string) =>
      (await sql<{ id: string }[]>`
        select id from entrants where division_id = ${divisionId} and display_name = ${name}`)[0]!.id;
    const alpha = await entrantId(open.id, "Alpha");
    const bravo = await entrantId(open.id, "Bravo");
    const cubs = await entrantId(youth.id, "Cubs");
    const person = async (fullName: string, consent: Record<string, boolean>) =>
      (await sql<{ id: string }[]>`
        insert into persons (org_id, full_name, consent)
        values (${scene.orgId}, ${fullName}, ${sql.json(consent)}) returning id`)[0]!.id;
    const samA = await person("Sam Carter", { public_name: true });
    const olly = await person("Olly Brown", { public_name: false });
    const zed = await person("Zed Adams", { public_name: true });
    const samB = await person("Sam Carter", { public_name: true });
    const kit = await person("Kit Young", { public_name: true });
    const join = (entrant: string, personId: string, squad: number | null, position: string | null) => sql`
      insert into entrant_members (entrant_id, person_id, org_id, squad_number, default_position_key)
      values (${entrant}, ${personId}, ${scene.orgId}, ${squad}, ${position})`;
    // Inserted out of order: the view sorts `squad_number nulls last, full_name`.
    await join(alpha, zed, null, null);
    await join(alpha, samA, 7, "GK");
    await join(alpha, olly, 3, null);
    await join(bravo, samB, 9, null);
    await join(cubs, kit, 1, null);
    // Player pages are an entitlement the view checks itself
    // (`org_has_feature('dashboard.player_profiles')`), so grant it explicitly.
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value, reason)
      values (${scene.orgId}, 'dashboard.player_profiles', true, 'test')
      on conflict (org_id, feature_key) do update set bool_value = excluded.bool_value`;
    await invalidateOrgEntitlements(scene.orgId);
    // An ACTIVE ban on Alpha's Sam Carter only — Bravo's Sam Carter is a
    // different person with the same name.
    await sql`
      insert into suspensions
        (org_id, division_id, person_id, entrant_id, status, source, reason, matches_total, decided_at)
      values (${scene.orgId}, ${open.id}, ${samA}, ${alpha}, 'active', 'manual', 'test', 2, now())`;

    const doc = (await loadCompetitionHub(scene.orgSlug, competition.slug))!;
    expect(CompetitionHubDoc.safeParse(doc).error?.issues ?? []).toEqual([]);
    const base = `/shared/${scene.orgSlug}/${competition.slug}`;
    const team = (id: string) => doc.teams.find((t) => t.entrantId === id)!;

    expect(team(alpha).members).toEqual([
      // Opted out: masked, no id, no link.
      { personId: null, name: "Olly B.", squadNumber: 3, position: null, playerHref: null, suspendedRemaining: null },
      {
        personId: samA,
        name: "Sam Carter",
        squadNumber: 7,
        position: "GK",
        playerHref: `${base}/players/${samA}`,
        suspendedRemaining: 2,
      },
      {
        personId: zed,
        name: "Zed Adams",
        squadNumber: null,
        position: null,
        playerHref: `${base}/players/${zed}`,
        suspendedRemaining: null,
      },
    ]);
    expect(team(bravo).members).toEqual([
      {
        personId: samB,
        name: "Sam Carter",
        squadNumber: 9,
        position: null,
        playerHref: `${base}/players/${samB}`,
        suspendedRemaining: null,
      },
    ]);
    // Consented, so the VIEW publishes the id — but a youth division masks the
    // name, and a masked name never links.
    expect(team(cubs).members).toEqual([
      { personId: null, name: "Kit Y.", squadNumber: 1, position: null, playerHref: null, suspendedRemaining: null },
    ]);
    expect(team(alpha).calendarHref).toBe(`${base}/open/calendar.ics?entrant=${alpha}`);

    const division = (slug: string) => doc.divisions.find((d) => d.slug === slug)!;
    expect(division("open").description).toBe("<p>Bring <strong>boots</strong>.</p>");
    expect(division("open").suspensions).toEqual([
      { personId: samA, name: "Sam Carter", entrantId: alpha, entrantName: "Alpha", remaining: 2 },
    ]);
    expect(division("u12").description).toBeNull();
    expect(division("u12").suspensions).toEqual([]);
  }, 60_000);
});
