// W2c Task 16b (X-WO-1 part B; Task 9 P-3 "A") - ONE walkover score everywhere, through the real producers and the real
// readers. A stage's points rule can carry `forfeit.awardScore`; the table already credits the RULE's number
// (`applyPointsRule`). Until this task the HEADLINE of the same walkover read the DIVISION cfg's award (football's
// `awardScore.goals`), so a console and a public match page said "3 - 0" beside a table that credited 5-0.
//
// Every surface below is read from the DB the way production reads it: the console (`getFixtureState`,
// `listFixtureHeadlines`), the public match page (`getPublicFixture`: the stored summary and the match-centre header), the
// results list (the hub's `matches`, and the division read), the stage format line (the hub's `stageFormatLines`) and the
// standings credit (`getStandings`). The walkover is recorded through the console's own write (`scoreEvent`).
//
// Expected values: the rule's award is this file's declaration (the organiser's number); the DIVISION's number is read off
// the twin scene - the same stage with a forfeit row and NO award, which the engine folds the old way - so the right
// answer always differs from the wrong one's constant (a premise asserted per sport).
//
// Swept over the registry: the sports whose table the award reaches (the engine's `pointsRuleAwardReachesTable`) are the
// cases, and the table of scenes below must name exactly that set - a sport that gains the declaration without a row here
// fails, and a sweep that checked nothing fails.
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { pointsRuleAwardReachesTable } from "@seazn/engine/competition";
import { foldMatchWithStoppage } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair, makeEnvelope, onePlayEvent } from "@seazn/engine/testkit";
import { sql, withTenant } from "@/lib/db";
import { loadLineupPair } from "../lineups";
import { fixtureRow, post, tip } from "./helpers/w2b-rig";
import { getFixtureState, listFixtureHeadlines, loadFixturePadCfg } from "@/server/usecases/fixtures";
import { putStageRules } from "@/server/usecases/stage-rules";
import { startDivision } from "@/server/usecases/schedule";
import { getStandings } from "@/server/usecases/stages";
import { getPublicDivision, getPublicFixture } from "@/server/public-site/data";
import { loadCompetitionHub } from "@/server/public-site/competition-hub";
import { seedDecidersScene } from "@/server/public-site/__tests__/_stage-rules-scene";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

/** The sports the award reaches, each with the variant its scene plays: generic's `score` is the one with a score card, and
 *  ice hockey's `recreational` is expressible as a stage rule (the `iihf` variant scores overtime results separately, which a
 *  stage points rule cannot say yet, so no stage of it can hold an award at all). */
const SCENES = [
  { sport: "football", variant: "11-a-side" },
  { sport: "generic", variant: "score" },
  { sport: "hockey", variant: "fih-outdoor" },
  { sport: "icehockey", variant: "recreational" },
] as const;
type SceneSpec = (typeof SCENES)[number];

const moduleOf = (key: string): AnySportModule => builtinModules.find((m) => m.key === key) as AnySportModule;

/** The sport's own default walkover credit to the side that turned up (its no-offer fold's table figure). */
function defaultWinnerFigure(spec: SceneSpec): number {
  const m = moduleOf(spec.sport);
  const cfg = m.configSchema.parse(m.variants[spec.variant]);
  const folded = foldMatchWithStoppage(m as never, cfg as never, defaultLineupPair(m.positions), [makeEnvelope(1, { type: "core.forfeit", payload: { by: "A", reason: "walkover" } })]);
  return m.forfeitCredit(cfg, folded.state, "walkover", "away").perSide[0][m.awardScoreKeys!.for]!;
}

/** The organiser's award: never the sport's default (so the headline can tell the rule from the division), and the side
 *  that did not turn up is not nil (so the orientation can be told). */
const awardFor = (spec: SceneSpec): [number, number] => [defaultWinnerFigure(spec) + 4, 1];

const ruleFor = (award: readonly [number, number] | null) => ({
  base: { win: 3, draw: 1, loss: 0 },
  bonuses: [],
  forfeit: { winnerPoints: 3, loserPoints: 0, ...(award === null ? {} : { awardScore: [...award] as [number, number] }) },
});

/** `started`: the division is started (scoring opens only then, `division-phase.ts`); false keeps it before kickoff. */
async function scene(spec: SceneSpec, award: readonly [number, number] | null, started = true) {
  const m = moduleOf(spec.sport);
  const s = await seedDecidersScene({
    sportKey: spec.sport,
    variantKey: spec.variant,
    leaguePoints: ruleFor(award),
    entrantKind: (m.entrantModel?.defaultKind ?? "team") as "team" | "individual",
  });
  if (started) await startDivision(s.auth, s.divisionId);
  const rows = await sql<{ id: string; home: string; away: string }[]>`
    select id, home_entrant_id as home, away_entrant_id as away from fixtures where stage_id = ${s.leagueStageId} order by round_no, seq_in_round`;
  expect(rows.length, `${spec.sport}: premise - the Pool has fixtures`).toBeGreaterThanOrEqual(4);
  return { s, m, rows };
}
type Scene = Awaited<ReturnType<typeof scene>>;

/** The walkover through the console's write: the side `by` does not turn up. */
async function walkover(sc: Scene, fixtureId: string, by: "home" | "away", reason: "walkover" | "retired" | "disqualified" = "walkover") {
  const f = await fixtureRow(fixtureId);
  const entrant = by === "home" ? f.home_entrant_id : f.away_entrant_id;
  return post(sc.s.auth, fixtureId, "core.forfeit", { by: entrant, reason });
}

interface Reading {
  /** The console's stored summary: headline and the two side lines (home first). */
  console: { headline: string; lines: (string | null)[] };
  heads: string | undefined;
  /** The public match page: the stored summary, then the match-centre header's score lines. */
  page: { headline: string | undefined; lines: (string | null)[]; centre: (string | null)[] };
  /** The results list: the hub's match card and the division read's stored summary. */
  hub: (string | null)[];
  division: { headline: string | undefined; lines: (string | null)[] };
}

const linesOf = (summary: unknown): (string | null)[] =>
  ((summary as { perSide?: { line?: string }[] } | null)?.perSide ?? []).map((p) => p.line ?? null);

/** Every surface the person sees, for one fixture, read the way production reads it. */
async function read(sc: Scene, fixtureId: string): Promise<Reading> {
  const { s } = sc;
  const state = await getFixtureState(s.auth, fixtureId);
  const heads = await listFixtureHeadlines(s.auth, s.divisionId);
  const page = await getPublicFixture(s.orgSlug, s.compSlug, s.divSlug, fixtureId);
  expect(page, "premise: the seeded fixture is public").not.toBeNull();
  const hub = await loadCompetitionHub(s.orgSlug, s.compSlug, new Date(), { uncached: true });
  const card = hub!.matches.find((m) => m.fixtureId === fixtureId);
  expect(card, "premise: the hub lists the fixture").toBeDefined();
  const division = await getPublicDivision(s.orgSlug, s.compSlug, s.divSlug);
  const row = division!.fixtures.find((f) => f.id === fixtureId);
  expect(row, "premise: the division read lists the fixture").toBeDefined();
  const summary = state.summary as { headline: string } | null;
  return {
    console: { headline: summary?.headline ?? "", lines: linesOf(summary) },
    heads: heads[fixtureId],
    page: { headline: page!.fixture.summary?.headline, lines: linesOf(page!.fixture.summary), centre: [...page!.matchCentre.header.scoreLines] },
    hub: [...card!.header.scoreLines],
    division: { headline: row!.summary?.headline, lines: linesOf(row!.summary) },
  };
}

/** What every surface must say when the home side turns up and the away side does not (`winnerIsHome`) under `figures`. */
function expectEverySurface(label: string, got: Reading, figures: readonly [string, string], winnerIsHome: boolean) {
  const lines = winnerIsHome ? [figures[0], figures[1]] : [figures[1], figures[0]];
  const headline = `${lines[0]} — ${lines[1]}`;
  expect(got.console.lines, `${label}: console side lines`).toEqual(lines);
  expect(got.console.headline, `${label}: console headline`).toBe(headline);
  expect(got.heads, `${label}: bracket/console headline map`).toBe(headline);
  expect(got.page.lines, `${label}: public page summary lines`).toEqual(lines);
  expect(got.page.headline, `${label}: public page headline`).toBe(headline);
  expect(got.page.centre, `${label}: match-centre header lines`).toEqual(lines);
  expect(got.hub, `${label}: results list (hub card)`).toEqual(lines);
  expect(got.division.lines, `${label}: division read summary lines`).toEqual(lines);
  expect(got.division.headline, `${label}: division read headline`).toBe(headline);
}

const standingsOf = async (sc: Scene) =>
  (await getStandings(sc.s.auth, sc.s.leagueStageId)).rows as { entrantId: string; metrics?: Record<string, number> }[];

describe("the scene table names exactly the sports the award reaches (anti-vacuity)", () => {
  it("one row per reaching sport, the registry's own declaration", () => {
    const reaching = builtinModules.filter((m) => pointsRuleAwardReachesTable(m)).map((m) => m.key).sort();
    expect(SCENES.map((x) => x.sport).sort()).toEqual(reaching);
    expect(reaching.length).toBeGreaterThan(0);
    // A sport the award does not reach is not here, and has a walkover headline that no rule moves (engine-tested).
    expect(builtinModules.length).toBeGreaterThan(reaching.length);
  });
});

describe.skipIf(!HAS_DB)("an unplayed walkover under a stage award reads the RULE's number on every surface (X-WO-1 B)", () => {
  it("every reaching sport, both orientations: console, public page, results list, division read, standings credit - the rule's number; the twin without an award keeps the division's", async () => {
    let checked = 0;
    for (const spec of SCENES) {
      const award = awardFor(spec);
      const [w, l] = award;
      const rule = await scene(spec, award);
      const twin = await scene(spec, null);
      const keys = rule.m.awardScoreKeys!;

      // Home turns up, away does not.
      await walkover(rule, rule.rows[0]!.id, "away");
      await walkover(twin, twin.rows[0]!.id, "away");
      const got = await read(rule, rule.rows[0]!.id);
      const old = await read(twin, twin.rows[0]!.id);
      expectEverySurface(`${spec.sport} rule`, got, [String(w), String(l)], true);
      // The console's page load hands the forfeit dialog the same number the table will carry (before the walkover it
      // previews, after it the page no longer offers one): read on the SECOND fixture, untouched by any forfeit yet.
      expect((await loadFixturePadCfg(rule.s.auth, rule.rows[2]!.id)).forfeitAward, `${spec.sport}: the console load carries the rule's award`).toEqual(award);
      expect((await loadFixturePadCfg(twin.s.auth, twin.rows[2]!.id)).forfeitAward, `${spec.sport}: no rule award, none carried`).toBeUndefined();
      // Premise: the division's own reading is a different thing (the right answer is not the wrong one's constant).
      expect(old.console.lines, `${spec.sport}: premise - the twin's headline is not the rule's`).not.toEqual([String(w), String(l)]);
      // The positive pair: the same stage WITHOUT a rule award keeps the division's reading on every surface.
      expect(old.page.lines).toEqual(old.console.lines);
      expect(old.hub).toEqual(old.console.lines);
      expect(old.division.lines).toEqual(old.console.lines);

      // The standings credit is the rule's, for the winner and the offender (the table has always paid it).
      const f0 = await fixtureRow(rule.rows[0]!.id);
      const st = await standingsOf(rule);
      const home = st.find((r) => r.entrantId === f0.home_entrant_id)!;
      const away = st.find((r) => r.entrantId === f0.away_entrant_id)!;
      expect([home.metrics?.[keys.for], home.metrics?.[keys.against], home.metrics?.[keys.diff]], `${spec.sport}: winner's credit`).toEqual([w, l, w - l]);
      expect([away.metrics?.[keys.for], away.metrics?.[keys.against], away.metrics?.[keys.diff]], `${spec.sport}: offender's credit`).toEqual([l, w, l - w]);

      // Away turns up, home does not: the same figures, the other way round, on every surface (a different fixture).
      await walkover(rule, rule.rows[1]!.id, "home");
      expectEverySurface(`${spec.sport} rule, other orientation`, await read(rule, rule.rows[1]!.id), [String(w), String(l)], false);
      checked++;
    }
    expect(checked, `sports checked: ${checked}`).toBe(SCENES.length);
  }, 600_000);

  it("the stage format line says the rule's score again - with the rule's number, only where the walkover headline agrees", async () => {
    let checked = 0;
    for (const spec of SCENES) {
      const award = awardFor(spec);
      const rule = await scene(spec, award);
      const twin = await scene(spec, null);
      const lineOf = async (sc: Scene) => {
        const hub = await loadCompetitionHub(sc.s.orgSlug, sc.s.compSlug, new Date(), { uncached: true });
        return hub!.divisions.find((d) => d.slug === sc.s.divSlug)!.stageFormatLines!.find((x) => x.stageName === "Pool")!.line;
      };
      const withAward = await lineOf(rule);
      const without = await lineOf(twin);
      expect(withAward, `${spec.sport}: the Pool line carries the clause`).toContainEqual({ key: "format.points.forfeitScore", params: { winner: award[0], loser: award[1] } });
      expect(without.map((c) => c.key), `${spec.sport}: no award, no clause`).not.toContain("format.points.forfeitScore");
      checked++;
    }
    expect(checked).toBe(SCENES.length);
  }, 600_000);
});

describe.skipIf(!HAS_DB)("the sequence around an unplayed walkover (X-WO-1 B)", () => {
  it("a second walkover; a void then a re-decide the other way; a start-only disqualification is still nothing played - every one the rule's number, the standings the sum", async () => {
    let checked = 0;
    for (const spec of SCENES) {
      const award = awardFor(spec);
      const [w, l] = award;
      const figures: [string, string] = [String(w), String(l)];
      const rule = await scene(spec, award);
      const keys = rule.m.awardScoreKeys!;
      const [a, ...rest] = rule.rows;
      // A second walkover on entrants the first did not touch: the table pays the rule's number twice, each side once.
      const b = rest.find((r) => ![a!.home, a!.away].includes(r.home) && ![a!.home, a!.away].includes(r.away))!;
      expect(b, `${spec.sport}: premise - a fixture disjoint from the first`).toBeDefined();
      await walkover(rule, a!.id, "away");
      await walkover(rule, b.id, "away");
      expectEverySurface(`${spec.sport} first`, await read(rule, a!.id), figures, true);
      expectEverySurface(`${spec.sport} second`, await read(rule, b.id), figures, true);
      const st = await standingsOf(rule);
      for (const id of [a!.home, b.home]) expect(st.find((r) => r.entrantId === id)!.metrics?.[keys.diff], `${spec.sport}: a walkover winner's diff`).toBe(w - l);
      for (const id of [a!.away, b.away]) expect(st.find((r) => r.entrantId === id)!.metrics?.[keys.diff], `${spec.sport}: a walkover offender's diff`).toBe(l - w);

      // A void of the walkover takes the credit with it; the re-decide the other way restates the headline to the new winner.
      const c = rest.find((r) => r.id !== b.id)!;
      const first = await walkover(rule, c.id, "away");
      expectEverySurface(`${spec.sport} before the void`, await read(rule, c.id), figures, true);
      const [{ id: forfeitEventId }] = await sql<{ id: string }[]>`select id from score_events where fixture_id = ${c.id} and type = 'core.forfeit'`;
      expect(first.status, "premise: the walkover decided it").toBe("forfeited");
      await post(rule.s.auth, c.id, "core.void", { event_id: forfeitEventId });
      const voided = await read(rule, c.id);
      expect(voided.console.lines, `${spec.sport}: a voided walkover leaves no award on the console`).not.toContain(figures[0]);
      expect(voided.page.lines).not.toContain(figures[0]);
      expect(voided.hub).not.toContain(figures[0]);
      expect((await fixtureRow(c.id)).status, `${spec.sport}: the void reopened it`).not.toBe("forfeited");
      await walkover(rule, c.id, "home");
      expectEverySurface(`${spec.sport} re-decided`, await read(rule, c.id), figures, false);

      // A disqualification after a Start alone is nothing played (rulings 112, 115): the rule's number again. (The engine does
      // not admit a retirement before a point is played: `retired` needs play.)
      const d = rest.find((r) => ![a!.id, b.id, c.id].includes(r.id))!;
      await post(rule.s.auth, d.id, "core.start");
      await walkover(rule, d.id, "away", "disqualified");
      expectEverySurface(`${spec.sport} start-only disqualification`, await read(rule, d.id), figures, true);
      checked++;
    }
    expect(checked).toBe(SCENES.length);
  }, 900_000);

  it("P-3: a forfeit AFTER play keeps the sport's own credit and headline - the same ledger without a rule award reads identically on every surface", async () => {
    let checked = 0;
    let skipped = 0;
    for (const spec of SCENES) {
      const award = awardFor(spec);
      const rule = await scene(spec, award);
      const twin = await scene(spec, null);
      const play = async (sc: Scene) => {
        const id = sc.rows[0]!.id;
        const f = await fixtureRow(id);
        await post(sc.s.auth, id, "core.start");
        const lineups = await withTenant(sc.s.auth.orgId, (tx) => loadLineupPair(tx, id, f.home_entrant_id!, f.away_entrant_id!));
        const cfg = sc.m.configSchema.parse(sc.m.variants[spec.variant]);
        const e = onePlayEvent(sc.m, cfg, lineups, [makeEnvelope(1, { type: "core.start", payload: {} })]);
        if (e === null) return null;
        await post(sc.s.auth, id, e.type, e.payload);
        await walkover(sc, id, "away", "retired");
        return id;
      };
      const ruleId = await play(rule);
      const twinId = await play(twin);
      if (ruleId === null || twinId === null) {
        skipped++;
        continue;
      }
      expect(await tip(ruleId), `${spec.sport}: premise - play was recorded before the forfeit`).toBeGreaterThanOrEqual(3);
      const got = await read(rule, ruleId);
      const base = await read(twin, twinId);
      // Premise: the rule's award is not what play left (otherwise the pair proves nothing).
      expect(got.console.lines, `${spec.sport}: premise`).not.toEqual([String(award[0]), String(award[1])]);
      expect({ ...got, heads: undefined }, `${spec.sport}: a retirement after play is the sport's own credit, rule or not`).toEqual({ ...base, heads: undefined });
      expect(got.heads).toBe(base.heads);
      checked++;
    }
    // Every reaching sport has a play event in this rig (measured: 4 of 4); one that stopped drawing one must be named, not skipped.
    expect({ checked, skipped }, "sports with a play event in this rig").toEqual({ checked: SCENES.length, skipped: 0 });
  }, 900_000);

  it("a rule change after a walkover is refused (STAGE_FORMAT_LOCKED): the walkover is play, so the headline and the table cannot disagree afterwards", async () => {
    const spec = SCENES[0];
    const award = awardFor(spec);
    const rule = await scene(spec, award);
    const id = rule.rows[0]!.id;
    await walkover(rule, id, "away");
    const before = await read(rule, id);
    await expect(putStageRules(rule.s.auth, rule.s.leagueStageId, { points: ruleFor([award[0] + 1, award[1]]) })).rejects.toMatchObject({ code: "STAGE_FORMAT_LOCKED" });
    expect(await read(rule, id), "the refused save moved nothing").toEqual(before);
  }, 300_000);
});

describe.skipIf(!HAS_DB)("a rule change before kickoff moves what an unplayed match will resolve to (rules_version)", () => {
  it("a changed award bumps rules_version of every unfrozen match in the stage; the same award again bumps nothing; a points change that leaves the award alone bumps nothing", async () => {
    const spec = SCENES[0];
    const award = awardFor(spec);
    const rule = await scene(spec, award, false);
    const versions = async () =>
      (await sql<{ id: string; v: number }[]>`select id, rules_version as v from fixtures where stage_id = ${rule.s.leagueStageId} order by id`).map((r) => [r.id, r.v]);
    const before = await versions();
    // Same save again: nothing moved.
    await putStageRules(rule.s.auth, rule.s.leagueStageId, { points: ruleFor(award) });
    expect(await versions(), "an identical save").toEqual(before);
    // The base points change but the award does not: what a walkover credits is unchanged, so no pad is stale.
    await putStageRules(rule.s.auth, rule.s.leagueStageId, { points: { ...ruleFor(award), base: { win: 2, draw: 1, loss: 0 } } });
    expect(await versions(), "points moved, award did not").toEqual(before);
    // The award changes: every match with no frozen cfg now resolves to another walkover credit.
    await putStageRules(rule.s.auth, rule.s.leagueStageId, { points: ruleFor([award[0] + 1, award[1]]) });
    expect(await versions(), "the award moved").toEqual(before.map(([id, v]) => [id, (v as number) + 1]));
    // Removing the award is a change too.
    await putStageRules(rule.s.auth, rule.s.leagueStageId, { points: ruleFor(null) });
    expect(await versions(), "the award removed").toEqual(before.map(([id, v]) => [id, (v as number) + 2]));
    expect(before.length).toBeGreaterThan(0);
  }, 300_000);
});
