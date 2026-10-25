// W2d Task 5 (spec §5.8, §2.3 anti-goal 3; ruling 70, D5; PS-5b). The drawing of lots is seeded, STORED and reused, and
// an empty table has no leader. Every expected order below comes from first principles: a stored draw's own order, or
// the engine's declared draw (`lotSeed(rngSeed, sorted ids)` fed to `shuffle`, spec 05 §4.4) called here independently
// of `rankStandings`. Where a wrong reading would land on the same order by chance, the test first asserts that it does
// not (TEST-STRATEGY rule 3: a case where the right answer differs from the wrong one's).
//
// Sequence (rule 1): the empty table → the first draw → a reload with the draw stored → a changed tied set (a withdrawal
// expunged, a later result) → every sport (the registry sweep at the end folds each module's own walkovers).
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf } from "../core/events.ts";
import { shuffle } from "../core/rng.ts";
import type { EntrantId, LineupPair, StandingsDelta } from "../core/types.ts";
import type { TiebreakerKey } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { lineupFromCatalog, makeEnvelope } from "../testkit/helpers.ts";
import { carryDeltas } from "./points.ts";
import { completeTableStage, type TableFixture, type TableStage } from "./stage.ts";
import { foldResults, type FixtureResult, type StandingsRow } from "./standings.ts";
import { lotSeed, membersKeyOf, rankStandings, type RankingResult, type StoredLotsDraw } from "./tiebreakers.ts";

/** A goals match on the 3/1/0 table, with the gf/ga/gd ledger `diff` and `for` read. */
function goals(home: EntrantId, away: EntrantId, hg: number, ag: number): FixtureResult {
  const side = (id: EntrantId, f: number, a: number): StandingsDelta => ({
    entrantId: id, played: 1, won: f > a ? 1 : 0, drawn: f === a ? 1 : 0, lost: f < a ? 1 : 0,
    points: f > a ? 3 : f === a ? 1 : 0, metrics: { gf: f, ga: a, gd: f - a },
  });
  return [side(home, hg, ag), side(away, ag, hg)];
}

/** The engine's declared draw for a tied set, computed here without `rankStandings`: spec 05 §4.4. */
function declaredDraw(rngSeed: number, members: readonly EntrantId[]): { seed: number; order: EntrantId[] } {
  const sorted = [...members].sort();
  const seed = lotSeed(rngSeed, sorted);
  return { seed, order: shuffle(seed, sorted) };
}

const ids = (r: RankingResult): EntrantId[] => r.rows.map((row) => row.entrantId);
const rowOf = (r: RankingResult, id: EntrantId): StandingsRow => r.rows.find((row) => row.entrantId === id) as StandingsRow;
/** A value shaped like Postgres' timestamptz text, not an ISO string: the engine must hand it on verbatim (PS-5b). */
const DRAWN_AT = "2026-10-24 09:15:02.123456+00";
const stored = (order: EntrantId[], drawnAt = DRAWN_AT): StoredLotsDraw => ({ order, drawnAt });
const GOALS_LOTS: TiebreakerKey[] = ["points", "diff", "for", "lots"];

/** A, B and C beat each other in a cycle, one goal each: 3 points, GD 0, GF 1 apiece. D has played nobody. */
const CYCLE = [goals("A", "B", 1, 0), goals("B", "C", 1, 0), goals("C", "A", 1, 0)];

describe("W2d T5 — the empty table (X-TB-6, anti-goal 3)", () => {
  it("X-TB-6 an empty table (0 counted fixtures): every row level, no leader, newLotsDraws empty (RBG:31-33)", () => {
    // Four entrants and nothing counted. Seed then id (spec §5.8 step 1): D (seed 1), B (seed 2), then the unseeded
    // A and C by id.
    const rows = foldResults(["C", "A", "D", "B"], []);
    const seeds = new Map([["D", 1], ["B", 2]]);
    const empty = rankStandings(rows, { cascade: GOALS_LOTS, rngSeed: 7, seeds, countedFixtures: 0 });
    expect(ids(empty)).toEqual(["D", "B", "A", "C"]);
    expect(empty.rows.map((row) => row.level)).toEqual([true, true, true, true]);
    expect(empty.lotsGroups).toEqual([]);
    expect(empty.newLotsDraws).toEqual([]);
    expect(empty.rows.some((row) => row.rankLocked === true)).toBe(false);
    // The ranks stay a total order (the table still lists the entrants), but no row stands apart from the others.
    expect(empty.rows.map((row) => row.rank)).toEqual([1, 2, 3, 4]);

    // Differential: a caller that does not say how many fixtures counted gets the pre-W2d reading, a drawing of lots
    // over all four. That draw is not the seed order, so the order above is the empty branch's and nothing else's.
    const legacy = rankStandings(rows, { cascade: GOALS_LOTS, rngSeed: 7, seeds });
    const drawn = declaredDraw(7, ["A", "B", "C", "D"]);
    expect(drawn.order).not.toEqual(["D", "B", "A", "C"]);
    expect(ids(legacy)).toEqual(drawn.order);
    expect(legacy.lotsGroups).toEqual([["A", "B", "C", "D"]]);
    expect(legacy.newLotsDraws).toHaveLength(1);
    expect(legacy.rows.some((row) => Object.hasOwn(row, "level"))).toBe(false);

    // The same with no `lots` in the cascade: level as well, still seed then id.
    const noLots = rankStandings(rows, { cascade: ["points", "diff"], seeds, countedFixtures: 0 });
    expect(ids(noLots)).toEqual(["D", "B", "A", "C"]);
    expect(noLots.rows.every((row) => row.level === true)).toBe(true);

    // Zero rows and zero fixtures: nothing at all (W2d T4 N1 stays as it was).
    expect(rankStandings([], { cascade: GOALS_LOTS, rngSeed: 7, countedFixtures: 0 })).toStrictEqual({ rows: [], lotsGroups: [], newLotsDraws: [] });
  });

  it("the first counted result ends the level table, even on rows a previous rank flagged level", () => {
    // Second call: rows carried over from the empty ranking keep their `level` flag; the first result must clear it.
    // A beat B 1-0, so A leads; C and D have not played and are drawn for third.
    const stale = foldResults(["A", "B", "C", "D"], [goals("A", "B", 1, 0)]).map((row) => ({ ...row, level: true }));
    const after = rankStandings(stale, { cascade: GOALS_LOTS, rngSeed: 7, countedFixtures: 1 });
    expect(ids(after).slice(0, 1)).toEqual(["A"]);
    expect(after.rows.filter((row) => Object.hasOwn(row, "level"))).toEqual([]);
    expect(after.lotsGroups).toEqual([["C", "D"]]);
  });

  it("X-TB-6 completeTableStage: a stage whose every fixture was voided draws nothing and ranks every row level", () => {
    // Each void kept its result (a voided fixture still names its pool's members), but nothing COUNTS.
    const stage: TableStage = { id: "s", kind: "league", entrants: ["X", "Y", "Z"], cascade: ["points", "lots"], rngSeed: 1, seeds: new Map([["Z", 1]]) };
    const voided: TableFixture[] = [goals("X", "Y", 1, 1), goals("Y", "Z", 1, 1), goals("Z", "X", 1, 1)].map((result, i) => ({ id: `f${i}`, status: "void", result }));
    const completed = completeTableStage(stage, voided);
    expect(completed.events).toEqual([{ type: "stage_completed", stageId: "s", finalRanks: ["Z", "X", "Y"] }]);
    expect(completed.newLotsDraws).toEqual([]);
    expect(completed.tables.overall?.map((row) => row.level)).toEqual([true, true, true]);

    // Positive pair: one of them counts (X–Y drawn), so X and Y are level on a counted table and are drawn.
    const one = completeTableStage(stage, voided.map((f, i) => (i === 0 ? { ...f, status: "decided" as const } : f)));
    expect(one.events.filter((e) => e.type === "rank_lock_required")).toEqual([{ type: "rank_lock_required", stageId: "s", group: ["X", "Y"] }]);
    expect(one.newLotsDraws.map((d) => d.membersKey)).toEqual(["X,Y"]);
    expect(one.tables.overall?.some((row) => Object.hasOwn(row, "level"))).toBe(false);
  });

  it("X-TB-6 after a void: a stored draw is not applied once every counted fixture is voided — level, seed then id, nothing new", () => {
    // Sequence: the cycle counts and its tie is drawn and stored (C, B, A); then all three results are voided. Spec
    // §5.8 step 1 comes first: an empty table orders seed then id (no seeds here, so A, B, C) and stores nothing, so
    // the stored draw is not the order. It differs from the seed order, so applying it would show.
    const lotsDraws = new Map([["A,B,C", stored(["C", "B", "A"])]]);
    expect(["C", "B", "A"]).not.toEqual(["A", "B", "C"]);
    const counted = rankStandings(foldResults(["A", "B", "C"], CYCLE), { cascade: GOALS_LOTS, rngSeed: 7, lotsDraws, countedFixtures: 3 });
    expect(ids(counted)).toEqual(["C", "B", "A"]);
    expect(counted.rows.map((row) => row.tieBreak?.drawnAt)).toEqual([DRAWN_AT, DRAWN_AT, DRAWN_AT]);

    const voided = rankStandings(foldResults(["A", "B", "C"], []), { cascade: GOALS_LOTS, rngSeed: 7, lotsDraws, countedFixtures: 0 });
    expect(ids(voided)).toEqual(["A", "B", "C"]);
    expect(voided.rows.map((row) => row.level)).toEqual([true, true, true]);
    expect(voided.rows.filter((row) => row.tieBreak?.drawnAt !== undefined || row.rankLocked === true)).toEqual([]);
    expect(voided.lotsGroups).toEqual([]);
    expect(voided.newLotsDraws).toEqual([]);

    // The same through completeTableStage: X, Y and Z drew each other 1-1, stored as Y, X, Z. Counted, that draw locks
    // the table; once every fixture is voided the stage is level in seed-then-id order (Z seeded 1, then X, Y) and
    // asks for no lock at all.
    const order = ["Y", "X", "Z"];
    const stage: TableStage = {
      id: "s", kind: "league", entrants: ["X", "Y", "Z"], cascade: ["points", "lots"], rngSeed: 1, seeds: new Map([["Z", 1]]),
      lotsDraws: new Map([["", new Map([["X,Y,Z", stored(order)]])]]),
    };
    expect(order).not.toEqual(["Z", "X", "Y"]);
    const draws = [goals("X", "Y", 1, 1), goals("Y", "Z", 1, 1), goals("Z", "X", 1, 1)];
    const played = completeTableStage(stage, draws.map((result, i) => ({ id: `f${i}`, status: "decided", result })));
    expect(played.events).toEqual([
      { type: "rank_lock_required", stageId: "s", group: ["X", "Y", "Z"] },
      { type: "rank_lock", stageId: "s", method: "lots", group: ["X", "Y", "Z"], order, drawnAt: DRAWN_AT },
      { type: "stage_completed", stageId: "s", finalRanks: order },
    ]);
    const allVoid = completeTableStage(stage, draws.map((result, i) => ({ id: `f${i}`, status: "void", result })));
    expect(allVoid.events).toEqual([{ type: "stage_completed", stageId: "s", finalRanks: ["Z", "X", "Y"] }]);
    expect(allVoid.newLotsDraws).toEqual([]);
    expect(allVoid.tables.overall?.map((row) => [row.level, row.tieBreak?.drawnAt])).toEqual([[true, undefined], [true, undefined], [true, undefined]]);
  });

  it("X-TB-6 completeTableStage: a carry that holds nothing (every opening 0 played, 0 points) counts no fixture, so the table stays level", () => {
    // A points-mode carry (Jul3/05 §3) from a source table where nothing counted: three zero openings. They carry no
    // counted fixture, so with the stage's own fixture voided the table is empty (spec §5.8 step 1): seed then id
    // (Z seeded 1, then X, Y), every row level, nothing drawn.
    const stage: TableStage = { id: "s", kind: "league", entrants: ["X", "Y", "Z"], cascade: ["points", "lots"], rngSeed: 1, seeds: new Map([["Z", 1]]) };
    const voidXY: TableFixture[] = [{ id: "v", status: "void", result: goals("X", "Y", 0, 0) }];
    const zero = carryDeltas(foldResults(["X", "Y", "Z"], []), "points");
    expect(zero).toHaveLength(3);
    const nothing = completeTableStage({ ...stage, openingDeltas: zero }, voidXY);
    expect(nothing.events).toEqual([{ type: "stage_completed", stageId: "s", finalRanks: ["Z", "X", "Y"] }]);
    expect(nothing.newLotsDraws).toEqual([]);
    expect(nothing.tables.overall?.map((row) => row.level)).toEqual([true, true, true]);

    // Positive pairs. A points-mode carry plays 0 by construction (points.ts carryDeltas), so 3 carried points alone
    // make a counted table: X leads, Y and Z are drawn.
    const xBeatY = carryDeltas(foldResults(["X", "Y", "Z"], [goals("X", "Y", 1, 0)]), "points");
    expect(xBeatY.map((d) => [d.played, d.points])).toEqual([[0, 3], [0, 0], [0, 0]]);
    const carriedPoints = completeTableStage({ ...stage, openingDeltas: xBeatY }, voidXY);
    expect(carriedPoints.tables.overall?.map((row) => row.entrantId)[0]).toBe("X");
    expect(carriedPoints.newLotsDraws.map((d) => d.membersKey)).toEqual(["Y,Z"]);
    expect(carriedPoints.tables.overall?.some((row) => Object.hasOwn(row, "level"))).toBe(false);
    // And a played carry worth 0 points (Y and Z each lost a carried match) is counted too: all three are level on 0
    // points on a counted table, so they are drawn and nobody is flagged level.
    const lost: StandingsDelta[] = ["Y", "Z"].map((id) => ({ entrantId: id, played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: {} }));
    const carriedPlays = completeTableStage({ ...stage, openingDeltas: lost }, voidXY);
    expect(carriedPlays.newLotsDraws.map((d) => d.membersKey)).toEqual(["X,Y,Z"]);
    expect(carriedPlays.tables.overall?.some((row) => Object.hasOwn(row, "level"))).toBe(false);
  });

  it("X-TB-6 completeTableStage counts a sit-out award and a carried opening as counted, so neither table is empty", () => {
    // A Swiss-style bye: the pool's only counted fixture is an award to X (3 points). Y and Z stay level at 0 and are
    // drawn; the table is not empty, so nothing is flagged level.
    const bye: StandingsDelta = { entrantId: "X", played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: {} };
    const stage: TableStage = { id: "s", kind: "league", entrants: ["X", "Y", "Z"], cascade: ["points", "lots"], rngSeed: 1 };
    const awarded = completeTableStage(stage, [{ id: "b", status: "decided", awardDelta: bye }, { id: "v", status: "void", result: goals("Y", "Z", 0, 0) }]);
    expect(awarded.tables.overall?.map((row) => row.entrantId)[0]).toBe("X");
    expect(awarded.newLotsDraws.map((d) => d.membersKey)).toEqual(["Y,Z"]);
    expect(awarded.tables.overall?.some((row) => Object.hasOwn(row, "level"))).toBe(false);

    // Carry-over (Jul3/05 §3): X and Y carried 3 points each, Z none; the stage's own fixture was voided. The carried
    // table is a counted one: X and Y are drawn, Z is last, nobody is level.
    const carried: StandingsDelta[] = ["X", "Y"].map((id) => ({ entrantId: id, played: 1, won: 1, drawn: 0, lost: 0, points: 3, metrics: {} }));
    const withOpenings = completeTableStage({ ...stage, openingDeltas: carried }, [{ id: "v", status: "void", result: goals("X", "Z", 0, 0) }]);
    expect(withOpenings.newLotsDraws.map((d) => d.membersKey)).toEqual(["X,Y"]);
    expect(withOpenings.tables.overall?.map((row) => row.entrantId)[2]).toBe("Z");
    expect(withOpenings.tables.overall?.some((row) => Object.hasOwn(row, "level"))).toBe(false);

    // Each source adds to the count, none offsets another: one result beside one award (Y–Z drawn, X's bye) and two
    // results beside two openings (X and Y carried 3, then each drew Z) are counted tables too. Each has a level pair
    // to draw: Y and Z on 1 point, then X and Y on 4.
    const resultAndAward = completeTableStage(stage, [{ id: "b", status: "decided", awardDelta: bye }, { id: "d", status: "decided", result: goals("Y", "Z", 0, 0) }]);
    expect(resultAndAward.newLotsDraws.map((d) => d.membersKey)).toEqual(["Y,Z"]);
    const resultsAndOpenings = completeTableStage({ ...stage, openingDeltas: carried }, [
      { id: "x", status: "decided", result: goals("X", "Z", 0, 0) },
      { id: "y", status: "decided", result: goals("Y", "Z", 0, 0) },
    ]);
    expect(resultsAndOpenings.newLotsDraws.map((d) => d.membersKey)).toEqual(["X,Y"]);
    expect(resultsAndOpenings.tables.overall?.some((row) => Object.hasOwn(row, "level"))).toBe(false);
  });
});

describe("W2d T5 — the stored, seeded drawing of lots (X-TB-4, ruling 70)", () => {
  it("membersKeyOf is the sorted ids joined with ','", () => {
    expect(membersKeyOf(["C", "A", "B"])).toBe("A,B,C");
    expect(membersKeyOf(["b2", "a10", "a9"])).toBe("a10,a9,b2");
    expect(membersKeyOf([])).toBe("");
  });

  it("X-TB-4 a residual class with no stored draw is drawn with the seeded shuffle and returned in newLotsDraws", () => {
    // The rows arrive as C, D, A, B: the members are the SORTED ids, whatever the table's own order.
    const rows = foldResults(["C", "D", "A", "B"], CYCLE);
    const drawn = declaredDraw(13, ["A", "B", "C"]);
    expect(drawn.order).not.toEqual(["A", "B", "C"]);
    expect(drawn.order).not.toEqual(["C", "A", "B"]);
    const ranked = rankStandings(rows, { cascade: GOALS_LOTS, rngSeed: 13, countedFixtures: 3 });
    expect(ids(ranked)).toEqual([...drawn.order, "D"]);
    expect(ranked.newLotsDraws).toStrictEqual([{ membersKey: "A,B,C", members: ["A", "B", "C"], drawnOrder: drawn.order, seed: drawn.seed }]);
    expect(ranked.lotsGroups).toEqual([["A", "B", "C"]]);
    for (const id of ["A", "B", "C"]) {
      const row = rowOf(ranked, id);
      expect(row.rankLocked, id).toBe(true);
      expect(row.tieBreak?.key, id).toBe("lots");
      // A new draw has no date yet: the DB assigns it when the row is stored (PS-5b).
      expect(Object.hasOwn(row.tieBreak ?? {}, "drawnAt"), id).toBe(false);
    }
  });

  it("X-TB-4 the same class with its stored draw uses it even when rngSeed changes (stored beats re-hash)", () => {
    const rows = foldResults(["C", "D", "A", "B"], CYCLE);
    const order = ["B", "A", "C"];
    for (const rngSeed of [13, 5]) expect(declaredDraw(rngSeed, order).order, `rngSeed ${rngSeed}`).not.toEqual(order);
    const lotsDraws = new Map([["A,B,C", stored(order)]]);
    let checked = 0;
    for (const rngSeed of [13, 5]) {
      const ranked = rankStandings(rows, { cascade: GOALS_LOTS, rngSeed, lotsDraws, countedFixtures: 3 });
      expect(ids(ranked), `rngSeed ${rngSeed}`).toEqual(["B", "A", "C", "D"]);
      expect(ranked.newLotsDraws).toEqual([]);
      expect(ranked.lotsGroups).toEqual([["A", "B", "C"]]);
      for (const id of order) {
        expect(rowOf(ranked, id).tieBreak?.drawnAt, id).toBe(DRAWN_AT);
        expect(rowOf(ranked, id).rankLocked, id).toBe(true);
      }
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("Review Focus 2: a changed tied set (one member withdrew) draws again; the old key is not applied to the new membership", () => {
    // A, B and C drew every match: 2 points, GD 0, GF 2 each. Their draw is stored.
    const all = [goals("A", "B", 1, 1), goals("A", "C", 1, 1), goals("B", "C", 1, 1)];
    const fresh = declaredDraw(13, ["A", "B"]);
    // The old order, read as if it applied to A and B, would put them the other way round.
    const old = ["A", "C", "B"];
    expect(old.filter((id) => id !== "C")).toEqual([...fresh.order].reverse());
    const before = rankStandings(foldResults(["A", "B", "C"], all), { cascade: GOALS_LOTS, rngSeed: 13, lotsDraws: new Map([["A,B,C", stored(old)]]), countedFixtures: 3 });
    expect(ids(before)).toEqual(old);
    expect(before.newLotsDraws).toEqual([]);

    // C withdrew and was expunged: its two fixtures are void, its row stays on 0 (played 0) and ranks last. A and B
    // are the tied set now, a different membership, so they are drawn afresh and the old row is history.
    const expunged = rankStandings(foldResults(["A", "B", "C"], [all[0] as FixtureResult]), {
      cascade: GOALS_LOTS, rngSeed: 13, lotsDraws: new Map([["A,B,C", stored(old)]]), countedFixtures: 1,
    });
    expect(ids(expunged)).toEqual([...fresh.order, "C"]);
    expect(expunged.newLotsDraws).toStrictEqual([{ membersKey: "A,B", members: ["A", "B"], drawnOrder: fresh.order, seed: fresh.seed }]);
    expect(Object.hasOwn(rowOf(expunged, "A").tieBreak ?? {}, "drawnAt")).toBe(false);

    // Both rows stored (the old one kept as history): the pair reads its own, nothing new is drawn.
    const both = new Map([["A,B,C", stored(old)], ["A,B", stored(fresh.order, "2026-10-25 10:00:00+00")]]);
    const reloaded = rankStandings(foldResults(["A", "B", "C"], [all[0] as FixtureResult]), { cascade: GOALS_LOTS, rngSeed: 13, lotsDraws: both, countedFixtures: 1 });
    expect(ids(reloaded)).toEqual([...fresh.order, "C"]);
    expect(reloaded.newLotsDraws).toEqual([]);
    expect(rowOf(reloaded, "A").tieBreak?.drawnAt).toBe("2026-10-25 10:00:00+00");

    // And the other way: a stored pair never serves the three-way tie that contains it.
    const three = declaredDraw(13, ["A", "B", "C"]);
    const onlyPair = rankStandings(foldResults(["A", "B", "C"], all), { cascade: GOALS_LOTS, rngSeed: 13, lotsDraws: new Map([["A,B", stored(fresh.order)]]), countedFixtures: 3 });
    expect(ids(onlyPair)).toEqual(three.order);
    expect(onlyPair.newLotsDraws.map((d) => d.membersKey)).toEqual(["A,B,C"]);
  });

  it("a second recompute with the returned draws stored yields an identical order and no new draws", () => {
    // Two tied classes: A and B (beat C and D 1-0, drew each other) on 4 points; C and D (lost 0-1, drew) on 1.
    const results = [goals("A", "C", 1, 0), goals("B", "D", 1, 0), goals("A", "B", 0, 0), goals("C", "D", 0, 0)];
    const top = declaredDraw(2, ["A", "B"]);
    const bottom = declaredDraw(2, ["C", "D"]);
    // On the reload the seed moves to 5, whose re-hash would order both classes differently.
    expect(declaredDraw(5, ["A", "B"]).order).not.toEqual(top.order);
    expect(declaredDraw(5, ["C", "D"]).order).not.toEqual(bottom.order);
    const first = rankStandings(foldResults(["A", "B", "C", "D"], results), { cascade: GOALS_LOTS, rngSeed: 2, countedFixtures: 4 });
    expect(ids(first)).toEqual([...top.order, ...bottom.order]);
    expect(first.newLotsDraws.map((d) => [d.membersKey, d.drawnOrder])).toEqual([["A,B", top.order], ["C,D", bottom.order]]);

    // The caller stores them; the DB stamps the date. Reload with the rows the other way round and another seed.
    const lotsDraws = new Map(first.newLotsDraws.map((d) => [d.membersKey, stored([...d.drawnOrder])] as const));
    const second = rankStandings(foldResults(["D", "C", "B", "A"], results), { cascade: GOALS_LOTS, rngSeed: 5, lotsDraws, countedFixtures: 4 });
    expect(ids(second)).toEqual(ids(first));
    expect(second.lotsGroups).toEqual(first.lotsGroups);
    expect(second.newLotsDraws).toEqual([]);
    expect(second.rows.map((row) => row.tieBreak?.drawnAt)).toEqual([DRAWN_AT, DRAWN_AT, DRAWN_AT, DRAWN_AT]);
    // A third call reads the same.
    expect(rankStandings(foldResults(["B", "D", "A", "C"], results), { cascade: GOALS_LOTS, rngSeed: 5, lotsDraws, countedFixtures: 4 })).toStrictEqual(second);
  });

  it("X-TB-4 completeTableStage's rank_lock carries `order` and `drawnAt` read from the stored draw in lotsDraws — the engine invents no date (PS-5b)", () => {
    const fixtures: TableFixture[] = [goals("X", "Y", 1, 1), goals("Y", "Z", 1, 1), goals("Z", "X", 1, 1)].map((result, i) => ({ id: `f${i}`, status: "decided", result }));
    const stage: TableStage = { id: "s", kind: "league", entrants: ["X", "Y", "Z"], cascade: ["points", "lots"], rngSeed: 1 };
    const fresh = declaredDraw(1, ["X", "Y", "Z"]);

    // No stored draw: the group still needs its lock, and the draw goes back to be stored. With no date to read there
    // is no rank_lock yet — the caller stores the draw, reads it back, and completes again (Task 9).
    const unstored = completeTableStage(stage, fixtures);
    expect(unstored.events).toEqual([
      { type: "rank_lock_required", stageId: "s", group: ["X", "Y", "Z"] },
      { type: "stage_completed", stageId: "s", finalRanks: fresh.order },
    ]);
    expect(unstored.newLotsDraws).toStrictEqual([{ pool: "", membersKey: "X,Y,Z", members: ["X", "Y", "Z"], drawnOrder: fresh.order, seed: fresh.seed }]);

    // Stored: the lock carries the stored order and the stored date, verbatim.
    const order = ["X", "Z", "Y"];
    expect(order).not.toEqual(fresh.order);
    const withStore = completeTableStage({ ...stage, lotsDraws: new Map([["", new Map([["X,Y,Z", stored(order)]])]]) }, fixtures);
    expect(withStore.events).toEqual([
      { type: "rank_lock_required", stageId: "s", group: ["X", "Y", "Z"] },
      { type: "rank_lock", stageId: "s", method: "lots", group: ["X", "Y", "Z"], order, drawnAt: DRAWN_AT },
      { type: "stage_completed", stageId: "s", finalRanks: order },
    ]);
    expect(withStore.newLotsDraws).toEqual([]);
    expect(withStore.tables.overall?.map((row) => row.tieBreak?.drawnAt)).toEqual([DRAWN_AT, DRAWN_AT, DRAWN_AT]);
  });

  it("completeTableStage reads each pool's own stored draws and tags each new draw with its pool", () => {
    // Pool P1: X, Y, Z drew everything; pool P2: U, V, W likewise. P2's draw is filed under P1, so P2 does not read
    // it: a stored draw belongs to the pool it was drawn in (stage_lots_draws is keyed by stage, pool and members).
    const draws = (a: EntrantId, b: EntrantId, c: EntrantId, pool: string): TableFixture[] =>
      [goals(a, b, 0, 0), goals(b, c, 0, 0), goals(c, a, 0, 0)].map((result, i) => ({ id: `${pool}-${i}`, poolId: pool, status: "decided", result }));
    const stage: TableStage = {
      id: "g", kind: "group", entrants: ["X", "Y", "Z", "U", "V", "W"], cascade: ["points", "lots"], rngSeed: 1,
      lotsDraws: new Map([["P1", new Map([["X,Y,Z", stored(["Z", "Y", "X"])], ["U,V,W", stored(["U", "W", "V"])]])]]),
    };
    const p2 = declaredDraw(1, ["U", "V", "W"]);
    expect(p2.order).not.toEqual(["U", "W", "V"]);
    const completed = completeTableStage(stage, [...draws("X", "Y", "Z", "P1"), ...draws("U", "V", "W", "P2")]);
    expect(completed.tables.pools.map((p) => [p.pool, p.rows.map((row) => row.entrantId)])).toEqual([["P1", ["Z", "Y", "X"]], ["P2", p2.order]]);
    expect(completed.events.filter((e) => e.type === "rank_lock")).toEqual([
      { type: "rank_lock", stageId: "g", method: "lots", group: ["X", "Y", "Z"], order: ["Z", "Y", "X"], drawnAt: DRAWN_AT },
    ]);
    expect(completed.events.filter((e) => e.type === "rank_lock_required").map((e) => (e.type === "rank_lock_required" ? e.group : []))).toEqual([["X", "Y", "Z"], ["U", "V", "W"]]);
    expect(completed.newLotsDraws).toStrictEqual([{ pool: "P2", membersKey: "U,V,W", members: ["U", "V", "W"], drawnOrder: p2.order, seed: p2.seed }]);
  });
});

describe("W2d T5 — the guards (assumptions are guards, rule 4)", () => {
  it("an entrant id holding the key separator is refused: two different tied sets would share one stored draw", () => {
    // {"a,b"} and {"a", "b"} would both key "a,b".
    expect(() => membersKeyOf(["a,b"])).toThrow(
      expect.objectContaining({ code: "CONFIG_INVALID", message: 'entrant id "a,b" holds ",", the lots members-key separator', data: { entrantId: "a,b" } }),
    );
    const rows = foldResults(["a,b", "c"], []);
    expect(() => rankStandings(rows, { cascade: ["points", "lots"], countedFixtures: 1 })).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("a stored draw that does not order exactly its members is refused by name, never applied", () => {
    const rows = foldResults(["A", "B", "C", "D"], CYCLE);
    let checked = 0;
    for (const order of [["A", "B"], ["A", "B", "D"], ["A", "A", "B"], ["A", "B", "C", "D"]]) {
      const lotsDraws = new Map([["A,B,C", stored(order)]]);
      expect(() => rankStandings(rows, { cascade: GOALS_LOTS, rngSeed: 13, lotsDraws, countedFixtures: 3 }), order.join()).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID", message: expect.stringMatching(/stored lots draw "A,B,C" orders \[/) }),
      );
      checked++;
    }
    expect(checked).toBe(4);
    // The refusal names the set and the order it was handed.
    expect(() => rankStandings(rows, { cascade: GOALS_LOTS, rngSeed: 13, lotsDraws: new Map([["A,B,C", stored(["A", "B", "D"])]]), countedFixtures: 3 })).toThrow(
      expect.objectContaining({ message: 'stored lots draw "A,B,C" orders [A,B,D], not exactly those entrants', data: { membersKey: "A,B,C", order: ["A", "B", "D"] } }),
    );
  });
});

describe("W2d T5 — every sport (rule 6)", () => {
  it("X-TB-4 every sport: the empty table, the first draw, a reload, a changed tied set — on each module's own walkover fold", () => {
    // Each module folds its own walkover (core.forfeit before the start, `by` the loser) into its own
    // standings delta pair. A cycle of three walkovers leaves A, B and C level on every ledger by symmetry: one award
    // won and one award conceded each. Then B also beats D, which lifts B alone: A and C are the tied set.
    const R = 2;
    let sports = 0;
    let steps = 0;
    forEachSport(({ module: m }) => {
      const cfg = (declaredCfgs(m as never)[0] as { cfg: unknown }).cfg;
      const beats = (winner: EntrantId, loser: EntrantId): FixtureResult => {
        const lineups: LineupPair = { home: lineupFromCatalog(m.positions, winner), away: lineupFromCatalog(m.positions, loser) };
        const folded = foldMatchWithStoppage(m as never, cfg as never, lineups, [makeEnvelope(1, { type: "core.forfeit", payload: { by: loser, reason: "walkover" } })]);
        const outcome = outcomeOf(m as never, folded as never);
        expect(outcome, m.key).not.toBeNull();
        return m.standingsDelta(outcome as never, cfg, { kind: "league" }, folded.state);
      };
      const cycle = [beats("A", "B"), beats("B", "C"), beats("C", "A")];
      // Guards for the two assumptions the expected orders rest on: the walkover pays its winner more than its loser,
      // and the cycle leaves A, B and C identical.
      expect((cycle[0] as FixtureResult)[0].points, m.key).toBeGreaterThan((cycle[0] as FixtureResult)[1].points);
      const folded = foldResults(["A", "B", "C", "D"], cycle);
      const bare = (row: StandingsRow) => ({ ...row, entrantId: "" });
      expect(bare(folded[1] as StandingsRow), m.key).toEqual(bare(folded[0] as StandingsRow));
      expect(bare(folded[2] as StandingsRow), m.key).toEqual(bare(folded[0] as StandingsRow));
      // No head-to-head key: C beat A in the cycle, which would split the later A–C tie before lots.
      const cascade: TiebreakerKey[] = ["points", "wins", "lots"];

      // The empty table: four rows, nothing counted, nothing drawn.
      // Differential: the drawing of lots over all four is not the seed-then-id order, so drawing here would show.
      expect(declaredDraw(R, ["A", "B", "C", "D"]).order, m.key).not.toEqual(["A", "B", "C", "D"]);
      const empty = rankStandings(foldResults(["A", "B", "C", "D"], []), { cascade, rngSeed: R, countedFixtures: 0 });
      expect(ids(empty), m.key).toEqual(["A", "B", "C", "D"]);
      expect(empty.rows.every((row) => row.level === true), m.key).toBe(true);
      expect(empty.newLotsDraws, m.key).toEqual([]);
      steps++;

      // The first draw.
      const abc = declaredDraw(R, ["A", "B", "C"]);
      const first = rankStandings(folded, { cascade, rngSeed: R, countedFixtures: 3 });
      expect(ids(first), m.key).toEqual([...abc.order, "D"]);
      expect(first.newLotsDraws, m.key).toStrictEqual([{ membersKey: "A,B,C", members: ["A", "B", "C"], drawnOrder: abc.order, seed: abc.seed }]);
      steps++;

      // The reload: stored, another seed, the same order and nothing new.
      const lotsDraws = new Map([["A,B,C", stored(abc.order)]]);
      // Differential: a re-hash under the new seed would draw another order, so only the stored draw lands on abc.
      // (R + 1 would not do: it happens to draw A, C, B again.)
      expect(declaredDraw(R + 2, ["A", "B", "C"]).order, m.key).not.toEqual(abc.order);
      const reload = rankStandings(foldResults(["D", "C", "B", "A"], cycle), { cascade, rngSeed: R + 2, lotsDraws, countedFixtures: 3 });
      expect(ids(reload), m.key).toEqual([...abc.order, "D"]);
      expect(reload.newLotsDraws, m.key).toEqual([]);
      steps++;

      // A later result changes the tied set: B beats D, so A and C are drawn afresh, the stored A,B,C left as it is.
      const ac = declaredDraw(R, ["A", "C"]);
      expect(ac.order, m.key).not.toEqual(abc.order.filter((id) => id !== "B"));
      const later = rankStandings(foldResults(["A", "B", "C", "D"], [...cycle, beats("B", "D")]), { cascade, rngSeed: R, lotsDraws, countedFixtures: 4 });
      expect(ids(later), m.key).toEqual(["B", ...ac.order, "D"]);
      expect(later.newLotsDraws.map((d) => [d.membersKey, d.drawnOrder]), m.key).toEqual([["A,C", ac.order]]);
      steps++;
      sports++;
    });
    expect(sports).toBe(builtinModules.length);
    expect(steps).toBe(builtinModules.length * 4);
  });
});
