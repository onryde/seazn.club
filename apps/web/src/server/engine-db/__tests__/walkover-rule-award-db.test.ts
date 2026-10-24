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
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import { pointsRuleAwardReachesTable } from "@seazn/engine/competition";
import { foldMatchWithStoppage, summaryOf } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { defaultLineupPair, makeEnvelope, onePlayEvent } from "@seazn/engine/testkit";
import { sql, withTenant } from "@/lib/db";
import { loadLineupPair } from "../lineups";
import { fixtureRow, post, tip } from "./helpers/w2b-rig";
import { getFixtureState, listFixtureHeadlines, loadFixturePadCfg } from "@/server/usecases/fixtures";
import { putStageRules } from "@/server/usecases/stage-rules";
import { startDivision } from "@/server/usecases/schedule";
import { withdrawEntrantCascade } from "@/server/usecases/withdrawal";
import { createStages, generateStageFixtures, getStandings } from "@/server/usecases/stages";
import { createCompetition } from "@/server/usecases/competitions";
import { createDivision } from "@/server/usecases/divisions";
import { createEntrants } from "@/server/usecases/entrants";
import { seedOrg } from "@/server/usecases/__tests__/_seed";
import { getPublicDivision, getPublicFixture } from "@/server/public-site/data";
import { readPlayerMatchLines, scoreLineFor } from "@/server/public-site/public-player-matches";
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

/** The division's OWN reading of the same forfeit (home turned up): the side lines of the engine's no-offer fold, and the
 *  winner's credit on the sport's score key - the figures a stage with no rule award must keep on every surface and in the
 *  table. Read from the engine, never typed here. */
function divisionReadingFor(spec: SceneSpec, reason: "walkover" | "withdrew" = "walkover"): { lines: string[]; winnerFor: number } {
  const m = moduleOf(spec.sport);
  const cfg = m.configSchema.parse(m.variants[spec.variant]);
  const folded = foldMatchWithStoppage(m as never, cfg as never, defaultLineupPair(m.positions), [makeEnvelope(1, { type: "core.forfeit", payload: { by: "A", reason } })]);
  return {
    lines: summaryOf(m as never, folded as never).perSide.map((p) => p.line),
    winnerFor: m.forfeitCredit(cfg, folded.state, reason, "away").perSide[0][m.awardScoreKeys!.for]!,
  };
}
const divisionLinesFor = (spec: SceneSpec): string[] => divisionReadingFor(spec).lines;

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

/** The first fixture played to a score (a Start and one real sport event, the module's own generator draws it) and then retired
 *  by the away side: ruling 112, so a match played - the one case the stage rule's award leaves to the sport's own credit.
 *  Null when the sport draws no play event under this variant. */
async function playThenRetire(sc: Scene, spec: SceneSpec): Promise<string | null> {
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
}

/** The headline the ENGINE reads for a walkover (the sport's own, or under the rule's `award`), side order home-first: with
 *  `offender` "A" (the away side did not turn up) it is the WINNER's own-side-first reading, with "H" the OFFENDER's. */
function engineHeadline(spec: SceneSpec, offender: "A" | "H", award: readonly [number, number] | null): string {
  const m = moduleOf(spec.sport);
  const cfg = m.configSchema.parse(m.variants[spec.variant]);
  const folded = foldMatchWithStoppage(
    m as never,
    cfg as never,
    defaultLineupPair(m.positions),
    [makeEnvelope(1, { type: "core.forfeit", payload: { by: offender, reason: "walkover" } })],
    award === null ? undefined : { forfeitAward: award },
  );
  return (summaryOf(m as never, folded as never) as { headline: string }).headline;
}

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
      // The positive pair: the same stage WITHOUT a rule award keeps the division's OWN reading on every surface - the
      // engine's no-offer fold of this walkover, pinned to a figure rather than only to the other surfaces.
      expect(old.console.lines, `${spec.sport}: the twin keeps the division's own figure`).toEqual(divisionLinesFor(spec));
      expect(divisionLinesFor(spec), `${spec.sport}: the division's reading is two non-empty lines`).toSatisfy((l: string[]) => l.length === 2 && l.every((x) => x !== ""));
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
      const ruleId = await playThenRetire(rule, spec);
      const twinId = await playThenRetire(twin, spec);
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

describe.skipIf(!HAS_DB)("a withdrawal cascade through a TABLE stage under a rule award (X-WO-1 B)", () => {
  /** A four-entrant league (Pool): the withdrawer's other two games are decided first - walkovers her opponents do not turn
   *  up for - so the table policy AWARDS her pending line (played >= half) instead of expunging it (engine `withdrawTableEntrant`).
   *  `departedSeat` is the seat she holds on the pending line. */
  async function withdrawn(spec: SceneSpec, award: readonly [number, number] | null, departedSeat: "home" | "away") {
    const sc = await scene(spec, award);
    const line = sc.rows[0]!;
    const departed = departedSeat === "home" ? line.home : line.away;
    const hers = sc.rows.filter((r) => r.id !== line.id && (r.home === departed || r.away === departed));
    expect(hers, `${spec.sport}: rig - the withdrawer has two other games`).toHaveLength(2);
    for (const r of hers) await walkover(sc, r.id, r.home === departed ? "away" : "home");
    const out = await withdrawEntrantCascade(sc.s.auth, departed);
    // (The scene's Cup walks her seat over too: the count is the Pool line's and the Cup's, so the Pool line is read directly.)
    expect([out.policy, out.voided], `${spec.sport}: rig - the table policy AWARDS (played >= half), it does not expunge`).toEqual(["walkover", 0]);
    const after = await fixtureRow(line.id);
    expect([after.status, (after.outcome as { kind?: string; reason?: string } | null)?.kind], `${spec.sport}: rig - the line is an award, not a void`).toEqual(["forfeited", "award"]);
    const ledger = await sql<{ type: string; payload: unknown }[]>`select type, payload from score_events where fixture_id = ${line.id} order by seq`;
    expect(ledger, `${spec.sport}: rig - the cascade wrote the withdrawal as the console writes a forfeit`).toEqual([
      { type: "core.forfeit", payload: { by: departed, reason: "withdrew" } },
    ]);
    const opponent = departedSeat === "home" ? line.away : line.home;
    return { sc, line, departed, opponent };
  }

  it("every reaching sport, both seats: the withdrawn line reads the rule's number on every surface and the table credits it; the twin without an award keeps the division's", async () => {
    let checked = 0;
    for (const spec of SCENES) {
      const award = awardFor(spec);
      const [w, l] = award;
      const division = divisionReadingFor(spec, "withdrew");
      // Premise: the division's own figure is not the rule's, so the right answer is not the wrong one's constant.
      expect(division.lines, `${spec.sport}: premise - the division's reading is not the rule's`).not.toEqual([String(w), String(l)]);
      expect(division.lines, `${spec.sport}: premise - nor the other orientation`).not.toEqual([String(l), String(w)]);
      for (const seat of ["home", "away"] as const) {
        const { sc, line, departed, opponent } = await withdrawn(spec, award, seat);
        const keys = sc.m.awardScoreKeys!;
        // The seat she does not hold turned up: the home side wins when she held the away seat.
        expectEverySurface(`${spec.sport} withdrawn ${seat}`, await read(sc, line.id), [String(w), String(l)], seat === "away");
        // The table: her two walkover wins (the rule's number each) plus the withdrawn line, which the opponent wins under it.
        const st = await standingsOf(sc);
        const her = st.find((r) => r.entrantId === departed)!;
        const him = st.find((r) => r.entrantId === opponent)!;
        expect([her.metrics?.[keys.for], her.metrics?.[keys.against]], `${spec.sport}/${seat}: the withdrawer: two wins and one withdrawal under the rule`).toEqual([2 * w + l, 2 * l + w]);
        expect([him.metrics?.[keys.for], him.metrics?.[keys.against], him.metrics?.[keys.diff]], `${spec.sport}/${seat}: the opponent's credit for the withdrawn line`).toEqual([w, l, w - l]);
        checked++;
      }
      // The positive pair: the same cascade with NO award keeps the division's own reading, on the headline and in the table.
      // (She holds the away seat, so the home side turned up: the orientation `divisionReadingFor` reads.)
      const { sc: twin, line, opponent } = await withdrawn(spec, null, "away");
      const got = await read(twin, line.id);
      expect(got.console.lines, `${spec.sport}: the twin keeps the division's figure on the console`).toEqual(division.lines);
      expect(got.page.lines).toEqual(division.lines);
      expect(got.hub).toEqual(division.lines);
      expect(got.division.lines).toEqual(division.lines);
      const him = (await standingsOf(twin)).find((r) => r.entrantId === opponent)!;
      expect(him.metrics?.[twin.m.awardScoreKeys!.for], `${spec.sport}: the twin's table keeps the division's credit`).toBe(division.winnerFor);
      checked++;
    }
    expect(checked, "scenes checked (2 seats + the twin, per sport)").toBe(SCENES.length * 3);
  }, 900_000);
});

describe.skipIf(!HAS_DB)("the player profile's own-side score line under a rule award (X-WO-1 B)", () => {
  /** A roster player on each of `entrantIds` (the person appears for the entrant's side of every fixture it plays). */
  async function rosterPlayers(sc: Scene, entrantIds: readonly string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const entrantId of entrantIds) {
      const [{ id }] = await sql<{ id: string }[]>`
        insert into persons (org_id, full_name) values (${sc.s.orgId}, ${"Profile Player " + randomUUID().slice(0, 6)}) returning id`;
      await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${entrantId}, ${id}, ${sc.s.orgId})`;
      ids.push(id);
    }
    return ids;
  }
  const profileOf = async (sc: Scene, personId: string) => {
    const [{ competition_id: competitionId }] = await sql<{ competition_id: string }[]>`select competition_id from divisions where id = ${sc.s.divisionId}`;
    return readPlayerMatchLines(sql, { personId, competitionId, orgSlug: sc.s.orgSlug, compSlug: sc.s.compSlug, locale: "en" });
  };

  it("scoreLineFor over the STORED rows of an unplayed walkover: home reads the headline, away reads it mirrored - the winner's own figure first, both orientations; the twin keeps the division's", async () => {
    let checked = 0;
    for (const spec of SCENES) {
      const award = awardFor(spec);
      const m = moduleOf(spec.sport);
      const rule = await scene(spec, award);
      const twin = await scene(spec, null);
      for (const [name, sc, offered] of [["rule", rule, award], ["twin", twin, null]] as const) {
        const winnerLine = engineHeadline(spec, "A", offered);
        const offenderLine = engineHeadline(spec, "H", offered);
        expect(winnerLine, `${spec.sport}/${name}: premise - the two orientations read differently`).not.toBe(offenderLine);
        // Home turns up on the first fixture (away does not), away turns up on the second (home does not).
        for (const [row, absent] of [[sc.rows[0]!, "away"], [sc.rows[1]!, "home"]] as const) {
          await walkover(sc, row.id, absent);
          const [stored] = await sql<{ summary: { headline: string }; state: unknown; outcome: unknown }[]>`
            select ms.summary, ms.state, f.outcome from fixtures f join match_states ms on ms.fixture_id = f.id where f.id = ${row.id}`;
          expect(stored, `${spec.sport}/${name}: the walkover stored a match state`).toBeDefined();
          const winnerEntrant = absent === "away" ? row.home : row.away;
          for (const entrant of [row.home, row.away]) {
            const line = scoreLineFor(stored!, entrant, row.home, m);
            expect(line, `${spec.sport}/${name}/${absent} absent: ${entrant === winnerEntrant ? "the winner" : "the offender"}'s own-side line`).toBe(entrant === winnerEntrant ? winnerLine : offenderLine);
            checked++;
          }
        }
      }
      // The rule moved the winner's reading (the right answer is not the division's constant).
      expect(engineHeadline(spec, "A", award), `${spec.sport}: premise - the rule's winner line is not the division's`).not.toBe(engineHeadline(spec, "A", null));
    }
    expect(checked, "sport x scene x fixture x seat readings").toBe(SCENES.length * 2 * 2 * 2);
  }, 900_000);

  it("through the loader: an unplayed walkover is no appearance (X-PS-1), so the profile never shows the award; a retirement AFTER play is one - both seats, the sport's own credit under the rule, the away line the home line mirrored", async () => {
    let checked = 0;
    for (const spec of SCENES) {
      const award = awardFor(spec);
      const lineByScene: Record<string, string[]> = {};
      for (const [name, offered] of [["rule", award], ["twin", null]] as const) {
        const sc = await scene(spec, offered);
        const first = sc.rows[0]!;
        const [home, away] = await rosterPlayers(sc, [first.home, first.away]);
        // Two walkovers on fixtures of each side's OTHER games: nothing played, so the person was not in a match.
        const homesOther = sc.rows.find((r) => r.id !== first.id && (r.home === first.home || r.away === first.home))!;
        const awaysOther = sc.rows.find((r) => r.id !== first.id && (r.home === first.away || r.away === first.away))!;
        await walkover(sc, homesOther.id, homesOther.home === first.home ? "away" : "home");
        await walkover(sc, awaysOther.id, awaysOther.home === first.away ? "away" : "home");
        // The first fixture: played, then retired by the away side.
        const playedId = await playThenRetire(sc, spec);
        expect(playedId, `${spec.sport}/${name}: the sport draws a play event`).toBe(first.id);
        const [homeLines, awayLines] = [await profileOf(sc, home!), await profileOf(sc, away!)];
        expect(homeLines.map((l) => l.fixtureId), `${spec.sport}/${name}: the home player's profile holds the played match only - no walkover`).toEqual([first.id]);
        expect(awayLines.map((l) => l.fixtureId), `${spec.sport}/${name}: the away player's profile holds the played match only - no walkover`).toEqual([first.id]);
        const stored = await read(sc, first.id);
        // Home reads the stored headline; away reads it mirrored (its own side first).
        expect(homeLines[0]!.line, `${spec.sport}/${name}: the home seat reads the headline`).toBe(stored.console.headline);
        const mirrored = stored.console.lines.slice().reverse();
        expect(awayLines[0]!.line, `${spec.sport}/${name}: the away seat reads it mirrored`).toBe(`${mirrored[0]} — ${mirrored[1]}`);
        expect(stored.console.lines[0], `${spec.sport}/${name}: premise - the two seats read differently`).not.toBe(stored.console.lines[1]);
        lineByScene[name] = [homeLines[0]!.line, awayLines[0]!.line];
        checked++;
      }
      // The positive pair: a match played then retired reads the same under the rule and without one (P-3 "A").
      expect(lineByScene.rule, `${spec.sport}: the rule's award never reaches a played match's profile line`).toEqual(lineByScene.twin);
    }
    expect(checked, "sport x scene").toBe(SCENES.length * 2);
  }, 900_000);
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

describe.skipIf(!HAS_DB)("a Swiss bye is not a walkover: the stage rule's award leaves it alone (X-WO-1 B)", () => {
  /** An odd Swiss field (3 entrants, 2 rounds) under a points rule that does / does not award a walkover score. Round one pairs
   *  two entrants and gives the third a bye - an event-less award in a TABLE stage, the one place a rule and an award meet. */
  async function swiss(spec: SceneSpec, award: [number, number] | null) {
    const { auth } = await seedOrg("pro");
    const suffix = randomUUID().slice(0, 6);
    const comp = await createCompetition(auth, { ends_on: "2030-12-31", name: "Bye " + suffix, visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, { name: "Open", slug: "open-" + suffix, sport_key: spec.sport, variant_key: spec.variant, config: {} });
    const kind = spec.sport === "generic" ? ("individual" as const) : ("team" as const);
    await createEntrants(auth, division.id, ["Ada", "Bo", "Cy"].map((name, i) => ({ kind, display_name: name, seed: i + 1, members: [] })));
    const [stage] = await createStages(auth, division.id, { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 2 }, progression: null });
    await putStageRules(auth, stage!.id, { points: ruleFor(award) });
    await startDivision(auth, division.id);
    await generateStageFixtures(auth, stage!.id);
    const rows = await sql<{ id: string; ext_key: string | null; status: string; outcome: Record<string, unknown> | null; home_entrant_id: string | null; away_entrant_id: string | null }[]>`
      select id, ext_key, status, outcome, home_entrant_id, away_entrant_id from fixtures where stage_id = ${stage!.id} and ext_key like '%-bye' and outcome is not null`;
    const bye = rows[0];
    expect(rows, `${spec.sport}: rig - exactly one seated bye in round one`).toHaveLength(1);
    const states = await sql<{ summary: unknown; state: unknown }[]>`select summary, state from match_states where fixture_id = ${bye!.id}`;
    const standings = (await getStandings(auth, stage!.id)).rows as { entrantId: string; played: number; won: number; points: number }[];
    return { bye: bye!, states, standings, auth };
  }
  const shape = (r: Awaited<ReturnType<typeof swiss>>) => ({
    status: r.bye.status,
    outcomeKind: r.bye.outcome?.kind,
    states: r.states,
    // The ids differ between the two scenes (the bye winner's row is compared without its entrant id); the bye holds no stored
    // match state in either, which is why no fold - and so no offered award - ever reaches it.
    byeRow: ((row) => (row === undefined ? undefined : { ...row, entrantId: undefined }))(r.standings.find((x) => x.entrantId === r.bye.home_entrant_id)),
    totals: r.standings.map((x) => [x.played, x.won, x.points]).sort(),
  });

  it("football and generic: the bye fixture, its stored state and the standings credit are the same with and without a walkover award", async () => {
    let checked = 0;
    for (const spec of SCENES.filter((x) => x.sport === "football" || x.sport === "generic")) {
      const withRule = await swiss(spec, awardFor(spec));
      const without = await swiss(spec, null);
      expect(shape(withRule), `${spec.sport}: a bye reads no award`).toEqual(shape(without));
      // The bye is still a credited win (the standings carry it) - so the equality above compares a real credit, not two blanks.
      expect(shape(withRule).byeRow, `${spec.sport}: the bye is credited`).toMatchObject({ played: 1, won: 1 });
      expect(withRule.states, `${spec.sport}: a bye has no stored match state to fold`).toEqual([]);
      checked++;
    }
    expect(checked, "sports checked").toBe(2);
  }, 300_000);
});
