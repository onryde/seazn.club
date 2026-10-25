// W2d Task 4 (spec §5.6, §2.3 anti-goal 2; P9, P20; B2-B5; OC3). The new tie-break keys, the head-to-head block
// modifiers and the end of the silent skip. Every expected order below is typed from the federation text its title
// cites, with the arithmetic written beside the fixtures; none is read back from `rankStandings`. Where a rule is only
// interesting because a wrong reading would answer differently, the wrong reading is ranked too and asserted to differ
// (TEST-STRATEGY rule 5: a differential case for every ordering).
//
// The fixtures are delta pairs shaped like each sport's ledger (sets_won/sets_lost, points_won/points_lost, gf/ga/gd,
// goals_pc/goals_stroke, won_ot/won_so). HK-TB-2 and the X-DW-4 sweep fold real modules instead: the first proves the
// field-goal ledger names are the ones the hockey kernel writes, the second that every sport's double walkover feeds
// none of the new keys.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { foldMatchWithStoppage, outcomeOf } from "../core/events.ts";
import type { EntrantId, LineupPair, StandingsDelta } from "../core/types.ts";
import type { TiebreakerKey } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
// single-sport: HK-TB-2's field goal is FIH hockey's own ledger (gf, goals_pc, goals_stroke), proved on its kernel.
import { hockey } from "../sports/hockey/hockey.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { lineupFromCatalog, makeEnvelope } from "../testkit/helpers.ts";
import { completeTableStage, type TableFixture } from "./stage.ts";
import { foldResults, type FixtureResult, type StandingsRow } from "./standings.ts";
import { buildSwissTable, directEncounter, rankStandings, type RankContext, type RankingResult, type SwissGame, type SwissTable } from "./tiebreakers.ts";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

interface Side { id: EntrantId; won?: number; drawn?: number; lost?: number; points: number; metrics?: Record<string, number> }
const side = (s: Side): StandingsDelta => ({
  entrantId: s.id, played: 1, won: s.won ?? 0, drawn: s.drawn ?? 0, lost: s.lost ?? 0, points: s.points, metrics: s.metrics ?? {},
});

/** A set-sport match: `hs`-`as` in sets (games, in BWF's word), `hp`-`ap` in rally points, `pts` the table points
 *  each side is paid (typed per test from that federation's rule). The winner is whoever took more sets. */
function sets(home: EntrantId, away: EntrantId, [hs, as]: [number, number], [hp, ap]: [number, number], pts: [number, number]): FixtureResult {
  const hw = hs > as ? 1 : 0;
  return [
    side({ id: home, won: hw, lost: 1 - hw, points: pts[0], metrics: { sets_won: hs, sets_lost: as, points_won: hp, points_lost: ap } }),
    side({ id: away, won: 1 - hw, lost: hw, points: pts[1], metrics: { sets_won: as, sets_lost: hs, points_won: ap, points_lost: hp } }),
  ];
}
/** BWF: no table points in the text; the product's flat 2/0 (RBS:150). */
const bwf = (h: EntrantId, a: EntrantId, s: [number, number], p: [number, number]) => sets(h, a, s, p, s[0] > s[1] ? [2, 0] : [0, 2]);
/** ITTF 3.7.5.1: win 2, played loss 1, an UNPLAYED loss 0 (D6). */
const ittf = (h: EntrantId, a: EntrantId, s: [number, number], p: [number, number], unplayedLoss = false) =>
  sets(h, a, s, p, s[0] > s[1] ? [2, unplayedLoss ? 0 : 1] : [unplayedLoss ? 0 : 1, 2]);
/** FIVB V3: 3-0 / 3-1 pay 3:0, 3-2 pays 2:1 (RBS:291-296). */
const fivb = (h: EntrantId, a: EntrantId, s: [number, number], p: [number, number]) => {
  const split = Math.min(s[0], s[1]) === 2;
  const [w, l]: [number, number] = split ? [2, 1] : [3, 0];
  return sets(h, a, s, p, s[0] > s[1] ? [w, l] : [l, w]);
};

/** A goals match paid `pts` (typed per test): W/D/L from the score, gf/ga/gd ledger. */
function goals(home: EntrantId, away: EntrantId, hg: number, ag: number, pts: [number, number]): FixtureResult {
  const [hw, d, aw] = [hg > ag ? 1 : 0, hg === ag ? 1 : 0, ag > hg ? 1 : 0];
  return [
    side({ id: home, won: hw, drawn: d, lost: aw, points: pts[0], metrics: { gf: hg, ga: ag, gd: hg - ag } }),
    side({ id: away, won: aw, drawn: d, lost: hw, points: pts[1], metrics: { gf: ag, ga: hg, gd: ag - hg } }),
  ];
}
/** FIFA: win 3, draw 1, loss 0. */
const fb = (h: EntrantId, a: EntrantId, hg: number, ag: number) => goals(h, a, hg, ag, hg > ag ? [3, 0] : hg < ag ? [0, 3] : [1, 1]);
/** IIHF regulation result: win 3, loss 0. */
const ih = (h: EntrantId, a: EntrantId, hg: number, ag: number) => goals(h, a, hg, ag, hg > ag ? [3, 0] : [0, 3]);

/** A tennis match, ATP round robin: sets and games ledgers, paid 2/0 (`tennis.ts:25`). */
function tn(home: EntrantId, away: EntrantId, [hs, as]: [number, number], [hg, ag]: [number, number]): FixtureResult {
  const hw = hs > as ? 1 : 0;
  return [
    side({ id: home, won: hw, lost: 1 - hw, points: 2 * hw, metrics: { sets_won: hs, sets_lost: as, games_won: hg, games_lost: ag } }),
    side({ id: away, won: 1 - hw, lost: hw, points: 2 * (1 - hw), metrics: { sets_won: as, sets_lost: hs, games_won: ag, games_lost: hg } }),
  ];
}

/** A chess game in a round robin that pays the 3/1/0 "football scoring" preset (RB2B-18). */
function chess(home: EntrantId, away: EntrantId, r: "1-0" | "½-½" | "0-1"): FixtureResult {
  if (r === "½-½") return [side({ id: home, drawn: 1, points: 1 }), side({ id: away, drawn: 1, points: 1 })];
  const hw = r === "1-0" ? 1 : 0;
  return [side({ id: home, won: hw, lost: 1 - hw, points: 3 * hw }), side({ id: away, won: 1 - hw, lost: hw, points: 3 * (1 - hw) })];
}
/** FIDE game points 1 / ½ / 0, in the engine's half-points (2 / 1 / 0), whatever the table paid (B5). */
const gamePointOf = (d: StandingsDelta): number => (d.won === 1 ? 2 : d.drawn === 1 ? 1 : 0);
const GAME_POINTS = (r: FixtureResult): readonly [number, number] => [gamePointOf(r[0]), gamePointOf(r[1])];

function row(id: EntrantId, o: { played: number; won: number; drawn?: number; lost: number; points: number; metrics?: Record<string, number> }): StandingsRow {
  return { entrantId: id, played: o.played, won: o.won, drawn: o.drawn ?? 0, lost: o.lost, points: o.points, metrics: o.metrics ?? {} };
}

const ids = (r: RankingResult): EntrantId[] => r.rows.map((x) => x.entrantId);
const rowOf = (r: RankingResult, id: EntrantId): StandingsRow => {
  const found = r.rows.find((x) => x.entrantId === id);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found;
};
function rankAll(results: readonly FixtureResult[], cascade: readonly TiebreakerKey[], extra: Partial<RankContext> = {}): RankingResult {
  const entrants = [...new Set(results.flatMap(([h, a]) => [h.entrantId, a.entrantId]))].sort();
  return rankStandings(foldResults(entrants, results), { cascade, results, rngSeed: 1, ...extra });
}

// The orders the tests run, as SPEC §5.10 signs them.
const BWF: TiebreakerKey[] = ["wins", "h2h_two", "set_diff", "h2h_two", "point_diff", "h2h_two", "lots"];
const ITTF: TiebreakerKey[] = ["points", "h2h_points", "h2h_set_ratio", "h2h_point_ratio", "h2h_exclusion", "lots"];
const ITTF_WITHOUT_EXCLUSION: TiebreakerKey[] = ["points", "h2h_points", "h2h_set_ratio", "h2h_point_ratio", "lots"];
const FIFA2026: TiebreakerKey[] = ["points", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "fair_play", "lots"];
const UEFA: TiebreakerKey[] = ["points", "h2h_points", "h2h_diff", "h2h_for", "h2h_reapply", "diff", "for", "fair_play", "lots"];
const IIHF: TiebreakerKey[] = ["points", "h2h_points", "h2h_diff", "h2h_for", "h2h_reapply", "diff", "for", "seed", "lots"];
const IIHF_WITHOUT_REAPPLY: TiebreakerKey[] = ["points", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "seed", "lots"];
const ATP: TiebreakerKey[] = ["wins", "matches_played", "h2h_two", "set_ratio", "h2h_two", "game_ratio", "h2h_two", "seed", "lots"];
const FIH: TiebreakerKey[] = ["points", "wins", "diff", "for", "h2h_points", "h2h_wins", "h2h_diff", "h2h_for", "field_goals", "lots"];
const FIVB: TiebreakerKey[] = ["wins", "points", "set_ratio", "point_ratio", "h2h_points", "lots"];
const FIDE_RR: TiebreakerKey[] = ["points", "direct", "wins", "sberger", "lots"];

/** Every TiebreakerKey, checked against the union both ways at compile time (engine tsc includes tests). */
const ALL_KEYS = [
  "points", "wins", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "nrr", "set_ratio", "game_ratio", "board_ratio",
  "point_ratio", "buchholz", "buchholz_cut1", "sberger", "direct", "fair_play", "seed", "lots", "set_diff", "point_diff",
  "h2h_two", "h2h_wins", "h2h_set_ratio", "h2h_point_ratio", "h2h_reapply", "h2h_exclusion", "matches_played", "field_goals",
] as const;
type _AllKeysAreKeys = (typeof ALL_KEYS)[number] extends TiebreakerKey ? true : never;
type _AllKeysAreAll = Exclude<TiebreakerKey, (typeof ALL_KEYS)[number]> extends never ? true : never;
const ALL_KEYS_ARE_KEYS: _AllKeysAreKeys = true;
const ALL_KEYS_ARE_ALL: _AllKeysAreAll = true;
const MODIFIERS: readonly TiebreakerKey[] = ["h2h_reapply", "h2h_exclusion"];

describe("W2d T4 — the new tie-break keys (spec §5.6)", () => {
  it("BD-TB-1 BWF 16.2.3: three level on wins are split by games DIFFERENCE where games RATIO would disagree (RBS:151-156)", () => {
    // An eight-player group (seven matches each, best of three games); the rows are the table's own ledger.
    // W 6-1, then X, Y, Z all 5-2 (BWF 16.2.1: level on matches won), V 4-3. Games won-lost:
    //   X 12-5 → difference +7, ratio 2.40 · Y 10-4 → +6, ratio 2.50 · Z 11-6 → +5, ratio 1.83.
    // BWF 16.2.3 ranks three or more level on wins by games DIFFERENCE: X, Y, Z. A games RATIO would put Y above X.
    const rows = [
      row("V", { played: 7, won: 4, lost: 3, points: 8, metrics: { sets_won: 9, sets_lost: 8 } }),
      row("W", { played: 7, won: 6, lost: 1, points: 12, metrics: { sets_won: 13, sets_lost: 4 } }),
      row("X", { played: 7, won: 5, lost: 2, points: 10, metrics: { sets_won: 12, sets_lost: 5 } }),
      row("Y", { played: 7, won: 5, lost: 2, points: 10, metrics: { sets_won: 10, sets_lost: 4 } }),
      row("Z", { played: 7, won: 5, lost: 2, points: 10, metrics: { sets_won: 11, sets_lost: 6 } }),
    ];
    const ranked = rankStandings(rows, { cascade: BWF, results: [], rngSeed: 1 });
    expect(ids(ranked)).toEqual(["W", "X", "Y", "Z", "V"]);
    for (const id of ["X", "Y", "Z"]) expect(rowOf(ranked, id).tieBreak?.key, id).toBe("set_diff");
    // The disagreement is real: the ratio reading of the same rows puts Y first.
    expect(ids(rankStandings(rows, { cascade: ["wins", "set_ratio", "lots"], rngSeed: 1 }))).toEqual(["W", "Y", "X", "Z", "V"]);
  });

  it("BD-TB-1 BWF 16.2.4: points DIFFERENCE where points RATIO would disagree; a row with no points ledger sorts last", () => {
    // Six players level on matches won (2) and games difference (5-3, +2), so BWF 16.2.4 "points difference" decides:
    //   H 40 won, no lost recorded → +40 (one recorded half reads the other as 0, as the ratio does)
    //   X 210-200 → +10 (ratio 1.050) · Y 100-92 → +8 (ratio 1.087) · Z 150-150 → 0
    //   L 5 lost, no won recorded → −5 (the other half again) · V 90-100 → −10
    //   U records no rally points at all → no difference, below every recorded one (#429), even V's −10.
    // Difference: H, X, Y, Z, L, V, U. A points RATIO would put Y (1.087) above X (1.050).
    const level = { played: 3, won: 2, lost: 1, points: 4 };
    const rows = [
      row("U", { ...level, metrics: { sets_won: 5, sets_lost: 3 } }),
      row("V", { ...level, metrics: { sets_won: 5, sets_lost: 3, points_won: 90, points_lost: 100 } }),
      row("X", { ...level, metrics: { sets_won: 5, sets_lost: 3, points_won: 210, points_lost: 200 } }),
      row("Y", { ...level, metrics: { sets_won: 5, sets_lost: 3, points_won: 100, points_lost: 92 } }),
      row("Z", { ...level, metrics: { sets_won: 5, sets_lost: 3, points_won: 150, points_lost: 150 } }),
      row("H", { ...level, metrics: { sets_won: 5, sets_lost: 3, points_won: 40 } }),
      row("L", { ...level, metrics: { sets_won: 5, sets_lost: 3, points_lost: 5 } }),
    ];
    const ranked = rankStandings(rows, { cascade: BWF, results: [], rngSeed: 1 });
    expect(ids(ranked)).toEqual(["H", "X", "Y", "Z", "L", "V", "U"]);
    for (const r of ranked.rows) expect(r.tieBreak?.key, r.entrantId).toBe("point_diff");
    expect(ranked.lotsGroups).toEqual([]);
    // (L 0/5 and U 0/0 both read ratio 0, so the ratio reading leaves those two to the draw.)
    expect(ids(rankStandings(rows, { cascade: ["wins", "point_ratio", "lots"], rngSeed: 1 })).slice(0, 5)).toEqual(["H", "Y", "X", "Z", "V"]);
    // The same "absent sorts last" on games: a row with no sets ledger sits below a −3 games difference.
    const games = [row("A", { ...level, metrics: { sets_won: 1, sets_lost: 4 } }), row("B", level)];
    expect(ids(rankStandings(games, { cascade: ["wins", "set_diff", "lots"], rngSeed: 1 }))).toEqual(["A", "B"]);
  });

  it("BD-TB-1 OC3 h2h_two after set_diff splits the remaining two by their meeting; on a class of 3 it does not split", () => {
    // A five-player group, best of three, 2/0 table. Matches won: E 3 · A, B, C 2 each · D 1.
    // Among A, B, C: A beat B and C, B beat C (a mini-table A 4, B 2, C 0 that BWF never builds for three).
    // Games: C 6-4 (+2) · A 5-6 (−1) · B 5-6 (−1). Points: A 199-215 (−16) · B 210-209 (+1).
    // BWF: wins → {A,B,C} is three, so 16.2.2 does not apply → games difference (16.2.3): C, then {A,B} level →
    // "if that leaves two equal, their match" (16.2.3.1): A beat B. Order E, C, A, B, D.
    const results = [
      bwf("A", "B", [2, 1], [57, 58]),
      bwf("A", "C", [2, 1], [60, 55]),
      bwf("D", "A", [2, 0], [42, 30]),
      bwf("E", "A", [2, 1], [60, 52]),
      bwf("B", "C", [2, 1], [58, 56]),
      bwf("B", "D", [2, 1], [59, 54]),
      bwf("E", "B", [2, 0], [42, 35]),
      bwf("C", "D", [2, 0], [42, 30]),
      bwf("C", "E", [2, 0], [42, 30]),
      bwf("E", "D", [2, 0], [42, 35]),
    ];
    const ranked = rankAll(results, BWF);
    expect(ids(ranked)).toEqual(["E", "C", "A", "B", "D"]);
    expect(rowOf(ranked, "C").tieBreak?.key).toBe("set_diff");
    expect([rowOf(ranked, "A").tieBreak?.key, rowOf(ranked, "B").tieBreak?.key]).toEqual(["h2h_two", "h2h_two"]);
    // Without the h2h_two after set_diff, points difference would have put B (+1) above A (−16).
    expect(ids(rankAll(results, ["wins", "set_diff", "point_diff", "lots"]))).toEqual(["E", "C", "B", "A", "D"]);
    // On the class of three, h2h_two splits nothing and says why; the mini-table (A 4, B 2, C 0) is never read.
    const onlyTwo = rankAll(results, ["wins", "h2h_two", "lots"]);
    expect(onlyTwo.lotsGroups).toEqual([["A", "B", "C"]]);
    for (const id of ["A", "B", "C"]) expect(rowOf(onlyTwo, id).tieBreak?.note, id).toBe("h2h_two_not_applicable");
  });

  it("TT-TB-1 ITTF 3.7.5.3 exclusion: restarting on the remaining two reverses the 3-way ratio order (RBS:228)", () => {
    // (1) W, X, Y, Z; best of five; 2 / played loss 1 / unplayed loss 0. Z beat X by WALKOVER (credited 3-0, 11-0 each
    // game, ITTF 2.3.7), so X's loss is unplayed and pays 0. Match points: W 5, X 4, Y 4, Z 4.
    // Among X, Y, Z (3.7.5.2): X 2+0 = 2, Y 1+2 = 3, Z 1+2 = 3 → X is placed last; Y and Z are still equal.
    // 3.7.5.3 excludes X's matches and restarts on Y–Z alone: Y beat Z → Y above Z. The three-way GAMES ratio would
    // have said the opposite: Y 3-5 (0.60), Z 5-3 (1.67).
    const walkover = [
      ittf("X", "Y", [3, 0], [33, 24]),
      ittf("Y", "Z", [3, 2], [52, 50]),
      ittf("Z", "X", [3, 0], [33, 0], true),
      ittf("X", "W", [3, 1], [44, 38]),
      ittf("W", "Y", [3, 1], [44, 40]),
      ittf("W", "Z", [3, 1], [44, 41]),
    ];
    const excluded = rankAll(walkover, ITTF);
    expect(ids(excluded)).toEqual(["W", "Y", "Z", "X"]);
    expect([rowOf(excluded, "Y").tieBreak?.key, rowOf(excluded, "Z").tieBreak?.key]).toEqual(["h2h_points", "h2h_points"]);
    expect(ids(rankAll(walkover, ITTF_WITHOUT_EXCLUSION))).toEqual(["W", "Z", "Y", "X"]);

    // (2) The restart begins at match points again, not at the step that split. X, Y, Z in a cycle, every match 3-1,
    // each beat W. Among them: match points 3 each, games 4-4 each, rally points X 78-74, Y 74-76, Z 74-76 → X placed
    // first on points ratio; Y, Z still equal. Restart on Y–Z from match points: Y beat Z (3-1) → Y. Their own match's
    // points ratio would say Z (38-36).
    const cycle = [
      ittf("X", "Y", [3, 1], [38, 38]),
      ittf("Y", "Z", [3, 1], [36, 38]),
      ittf("Z", "X", [3, 1], [36, 40]),
      ittf("X", "W", [3, 0], [33, 20]),
      ittf("Y", "W", [3, 0], [33, 20]),
      ittf("Z", "W", [3, 0], [33, 20]),
    ];
    const restarted = rankAll(cycle, ITTF);
    expect(ids(restarted)).toEqual(["X", "Y", "Z", "W"]);
    expect(restarted.lotsGroups).toEqual([]);
    expect(rowOf(restarted, "X").tieBreak?.key).toBe("h2h_point_ratio");
    expect(rankAll(cycle, ITTF_WITHOUT_EXCLUSION).lotsGroups).toEqual([["Y", "Z"]]);
  });

  it("FB-TB-2 UEFA re-application: a 4-way h2h tie reduced to 2 is re-applied among the 2 only (RBG:108-110)", () => {
    // A, B, C, D all 6 points. Their mini-league: A 6, B 6, C 3, D 3, each pair level on h2h GD and goals.
    // UEFA 20.01(d) re-applies the h2h criteria to the pair alone: A beat B, C beat D → A, B, C, D.
    // FIFA (no re-application) falls through to overall GD: B 0 > A −2, C +2 > D 0 → B, A, C, D.
    const results = [
      fb("A", "B", 1, 0), fb("A", "C", 1, 0), fb("D", "A", 1, 0), fb("B", "C", 1, 0), fb("B", "D", 1, 0), fb("C", "D", 1, 0),
      fb("Ja", "A", 3, 0), fb("Jb", "B", 1, 0), fb("C", "Jc", 3, 0), fb("D", "Jd", 1, 0),
    ];
    const uefa = rankAll(results, UEFA);
    expect(ids(uefa).slice(0, 4)).toEqual(["A", "B", "C", "D"]);
    expect([rowOf(uefa, "A").tieBreak?.key, rowOf(uefa, "C").tieBreak?.key]).toEqual(["h2h_points", "h2h_points"]);
    expect(ids(rankAll(results, FIFA2026)).slice(0, 4)).toEqual(["B", "A", "C", "D"]);
  });

  it("IH-TB-1 IIHF re-application down to 2 (RBG:345-346); re-application with no progress terminates", () => {
    // A, B, C 6 points each (regulation wins, 3/0), D 0. Among the three: A beat B 3-1, B beat C 3-0, C beat A 2-1 →
    // h2h points 3 each; h2h GD A +1, B +1, C −2 → C placed third; A, B level on h2h GD and h2h goals (4 each).
    // IIHF re-applies to the two: A beat B → A, B, C. Without re-application overall GD decides: B +6 > A +2.
    const reduced = [ih("A", "B", 3, 1), ih("B", "C", 3, 0), ih("C", "A", 2, 1), ih("A", "D", 1, 0), ih("B", "D", 5, 0), ih("C", "D", 1, 0)];
    expect(ids(rankAll(reduced, IIHF))).toEqual(["A", "B", "C", "D"]);
    expect(ids(rankAll(reduced, IIHF_WITHOUT_REAPPLY))).toEqual(["B", "A", "C", "D"]);
    // No progress: a perfect 2-1 cycle leaves the three level on every h2h criterion, so the block cannot split it and
    // re-application has nothing smaller to re-run on; the class falls through to overall GD: B +3, C +2, A +1.
    const cycle = [ih("A", "B", 2, 1), ih("B", "C", 2, 1), ih("C", "A", 2, 1), ih("A", "D", 1, 0), ih("B", "D", 3, 0), ih("C", "D", 2, 0)];
    const stuck = rankAll(cycle, IIHF);
    expect(ids(stuck)).toEqual(["B", "C", "A", "D"]);
    for (const id of ["A", "B", "C"]) expect(rowOf(stuck, id).tieBreak?.key, id).toBe("diff");
  });

  it("TN-TB-1 ATP C.3-2 matches_played: a 2-1 record ranks above 2-0", () => {
    // Q beat P and R, then withdrew before Q–S (its played results stand). P: lost to Q, beat R and S → 2-1. Q: 2-0.
    // ATP 4.01 C.3-1 ties them on wins; C.3-2 "most matches played": P (3) above Q (2), although Q beat P.
    const results = [
      tn("Q", "P", [2, 1], [16, 15]),
      tn("Q", "R", [2, 0], [12, 5]),
      tn("P", "R", [2, 0], [12, 6]),
      tn("P", "S", [2, 1], [15, 13]),
      tn("R", "S", [2, 0], [12, 8]),
    ];
    const ranked = rankAll(results, ATP);
    expect(ids(ranked)).toEqual(["P", "Q", "R", "S"]);
    expect(rowOf(ranked, "P").tieBreak?.key).toBe("matches_played");
    // Their meeting (the next step) would have put Q first.
    expect(ids(rankAll(results, ["wins", "h2h_two", "lots"]))).toEqual(["Q", "P", "R", "S"]);
  });

  it("HK-TB-1 FIH: more wins above better GD (RBG:236); wins counts regulation wins only under winsCount 'regulation' (B2)", () => {
    // Five teams on 6 points (FIH 3/1/0 with draws). The table's own ledger, as the points rule books it (spec §5.7):
    //   A 2 regulation wins, GD +1 · B 2 wins, ONE in overtime (`won_ot`), GD +3 · C 1 win 3 draws, GD +4
    //   D 1 win, 2 draws, one of them settled by a shoot-out (B2: a draw for both, the bonus to D, `won_so`), GD +2
    //   E 1 win 3 draws, GD +1.
    // FIH (regulation wins only): A 2, B/C/D/E 1 → A; then GD: C +4, B +3, D +2, E +1 → A, C, B, D, E.
    // Every win counted: A 2, B 2 → GD: B, A; then C, D, E → B, A, C, D, E.
    const rows = [
      row("A", { played: 3, won: 2, lost: 1, points: 6, metrics: { gf: 4, ga: 3, gd: 1 } }),
      row("B", { played: 3, won: 2, lost: 1, points: 6, metrics: { gf: 6, ga: 3, gd: 3, won_ot: 1 } }),
      row("C", { played: 4, won: 1, drawn: 3, lost: 0, points: 6, metrics: { gf: 8, ga: 4, gd: 4 } }),
      row("D", { played: 3, won: 1, drawn: 2, lost: 0, points: 6, metrics: { gf: 5, ga: 3, gd: 2, won_so: 1 } }),
      row("E", { played: 4, won: 1, drawn: 3, lost: 0, points: 6, metrics: { gf: 4, ga: 3, gd: 1 } }),
    ];
    const regulation = rankStandings(rows, { cascade: FIH, results: [], winsCount: "regulation", rngSeed: 1 });
    expect(ids(regulation)).toEqual(["A", "C", "B", "D", "E"]);
    expect(rowOf(regulation, "A").tieBreak?.key).toBe("wins");
    const all = rankStandings(rows, { cascade: FIH, results: [], winsCount: "all", rngSeed: 1 });
    expect(ids(all)).toEqual(["B", "A", "C", "D", "E"]);
    // RBG:236 on its own: A (2 wins, GD +1) above C (1 win, GD +4) whichever wins count.
    for (const r of [regulation, all]) expect(ids(r).indexOf("A")).toBeLessThan(ids(r).indexOf("C"));
    // Absent = every win (the sport declares nothing).
    expect(ids(rankStandings(rows, { cascade: FIH, results: [], rngSeed: 1 }))).toEqual(ids(all));
  });

  it("HK-TB-2 field_goals = gf − goals_pc − goals_stroke; an own goal counts; a corner and a stroke do not (B3)", () => {
    // The FIH kernel's own ledger: A v B 2-2. A scores a field goal and is credited B's own goal; B scores from a penalty
    // corner and a penalty stroke. Field goals (FIH GTR App. 3, B3): A 2, B 0 → A above B, every earlier FIH key level.
    const declared = declaredCfgs(hockey as never)[0];
    if (declared === undefined) throw new Error("hockey declares no cfg");
    const cfg = declared.cfg as never;
    const lineups: LineupPair = { home: lineupFromCatalog(hockey.positions, "A"), away: lineupFromCatalog(hockey.positions, "B") };
    const events = [
      { type: "core.start", payload: {} },
      { type: "hockey.goal", payload: { by: "A", kind: "fg" } },
      { type: "hockey.goal", payload: { by: "B", kind: "og" } },
      { type: "hockey.goal", payload: { by: "B", kind: "pc" } },
      { type: "hockey.goal", payload: { by: "B", kind: "stroke" } },
      ...["Q2", "Q3", "Q4", "FT"].map((to) => ({ type: "hockey.period.advance", payload: { to } })),
    ].map((e, i) => makeEnvelope(i + 1, e));
    const folded = foldMatchWithStoppage(hockey, cfg, lineups, events);
    const outcome = outcomeOf(hockey, folded);
    expect(outcome?.kind).toBe("draw");
    if (outcome === null) throw new Error("the stream decided nothing");
    const pair = hockey.standingsDelta(outcome, cfg, { kind: "league" }, folded.state) as FixtureResult;
    // The seam: these are the ledger keys the comparator reads, as the kernel writes them.
    const [a, b] = foldResults(["A", "B"], [pair]);
    expect([a?.metrics["gf"], a?.metrics["goals_pc"], a?.metrics["goals_stroke"]]).toEqual([2, 0, 0]);
    expect([b?.metrics["gf"], b?.metrics["goals_pc"], b?.metrics["goals_stroke"]]).toEqual([2, 1, 1]);
    const ranked = rankAll([pair], FIH);
    expect(ids(ranked)).toEqual(["A", "B"]);
    expect(rowOf(ranked, "A").tieBreak?.key).toBe("field_goals");
    // A ledger that ALSO counts own goals by kind still counts them as field goals: E 3 goals, 2 of them own goals
    // credited to it → 3; F 3 goals, 1 from a corner → 2; S 4 goals, 3 of them strokes → 1 (the most goals, the fewest
    // field goals). Missing keys read 0: G (2 goals, no kinds) → 2; H none → 0.
    const rows = [
      row("F", { played: 1, won: 0, drawn: 1, lost: 0, points: 1, metrics: { gf: 3, goals_pc: 1 } }),
      row("S", { played: 1, won: 0, drawn: 1, lost: 0, points: 1, metrics: { gf: 4, goals_stroke: 3 } }),
      row("E", { played: 1, won: 0, drawn: 1, lost: 0, points: 1, metrics: { gf: 3, goals_og: 2 } }),
      row("H", { played: 1, won: 0, drawn: 1, lost: 0, points: 1 }),
    ];
    expect(ids(rankStandings(rows, { cascade: ["points", "field_goals", "lots"], rngSeed: 1 }))).toEqual(["E", "F", "S", "H"]);
    const g = row("G", { played: 1, won: 0, drawn: 1, lost: 0, points: 1, metrics: { gf: 2 } });
    const withG = rankStandings([...rows, g], { cascade: ["points", "field_goals", "seed"], seeds: new Map([["G", 1], ["F", 2]]), rngSeed: 1 });
    // G (2) ties F (2): the seed, not field goals, separates them.
    expect(ids(withG)).toEqual(["E", "G", "F", "S", "H"]);
    expect(rowOf(withG, "G").tieBreak?.key).toBe("seed");
  });

  it("VB-TB-2 a double round robin h2h aggregates both legs where the last match alone would order them the other way (B4)", () => {
    // A, B, C play each other twice. All three: 2 wins, 6 points (FIVB 3-0 → 3:0, 3-2 → 2:1), games 8-8. Rally
    // points A 354-350, B 354-350, C 350-358 → C third on point ratio; A, B level on every overall key.
    // Head-to-head over BOTH legs (B4): A 3-0 (3:0) and B 3-2 (2:1) → A 4, B 2 → A above B. The last match alone
    // (B 3-2) would put B above A (RBS:295's wording; the product's deviation, VB-TB-2).
    const leg1 = fivb("A", "B", [3, 0], [75, 60]);
    const results = [
      leg1,
      fivb("A", "C", [3, 2], [112, 105]),
      fivb("B", "C", [3, 0], [75, 60]),
      fivb("B", "A", [3, 2], [110, 105]),
      fivb("C", "A", [3, 0], [75, 62]),
      fivb("C", "B", [3, 2], [110, 109]),
    ];
    const ranked = rankAll(results, FIVB);
    expect(ids(ranked)).toEqual(["A", "B", "C"]);
    expect(rowOf(ranked, "A").tieBreak?.key).toBe("h2h_points");
    const rows = foldResults(["A", "B", "C"], results);
    const lastLegOnly = rankStandings(rows, { cascade: FIVB, results: results.filter((r) => r !== leg1), rngSeed: 1 });
    expect(ids(lastLegOnly)).toEqual(["B", "A", "C"]);
  });

  it("BG-TB-1 BG-TB-3 round robin: SB from GAME points decides where SB from 3/1/0 table points would not (B5, FIDE C.07)", () => {
    // Six players, one round robin, the 3/1/0 preset. Table points: C 13, B 11, D 6, A 5, E 5, F 1.
    // A and E: drew each other (direct level), 1 win each. Game points: A 2, B 4, C 4½, D 2, E 2, F ½.
    // Sonneborn-Berger on GAME points (FIDE C.07): A = D 2 + ½·E 2 + ½·F ½ = 3¼ · E = F ½ + ½·A 2 + ½·B 4 = 3½ → E.
    // On the 3/1/0 TABLE points it would be A = 6 + ½·5 + ½·1 = 9, E = 1 + ½·5 + ½·11 = 9: level, a drawing of lots.
    const results = [
      chess("A", "B", "0-1"), chess("A", "C", "0-1"), chess("A", "D", "1-0"), chess("A", "E", "½-½"), chess("A", "F", "½-½"),
      chess("B", "C", "½-½"), chess("B", "D", "1-0"), chess("B", "E", "½-½"), chess("B", "F", "1-0"),
      chess("C", "D", "1-0"), chess("C", "E", "1-0"), chess("C", "F", "1-0"),
      chess("D", "E", "1-0"), chess("D", "F", "1-0"), chess("E", "F", "1-0"),
    ];
    const ranked = rankAll(results, FIDE_RR, { gamePoints: GAME_POINTS });
    expect(ids(ranked)).toEqual(["C", "B", "D", "E", "A", "F"]);
    expect(rowOf(ranked, "E").tieBreak?.key).toBe("sberger");
    expect(ranked.lotsGroups).toEqual([]);
    expect([rowOf(ranked, "E").metrics["sberger"], rowOf(ranked, "A").metrics["sberger"]]).toEqual([3.5, 3.25]);
    expect(rankAll(results, FIDE_RR).lotsGroups).toEqual([["A", "E"]]);

    // Direct encounter reads game points too (B5). P, Q, R, S on 7 table points; among them P beat R and S and lost to
    // Q; Q drew R and S; R beat S. Game points among them: P 2, Q 2, R 1½, S ½ → P and Q level. Table points among
    // them would split P (6) from Q (5).
    const direct = [
      chess("P", "R", "1-0"), chess("P", "S", "1-0"), chess("Q", "P", "1-0"), chess("Q", "R", "½-½"), chess("Q", "S", "½-½"), chess("R", "S", "1-0"),
      chess("P", "T", "½-½"), chess("U", "P", "1-0"), chess("Q", "T", "½-½"), chess("Q", "U", "½-½"),
      chess("T", "R", "1-0"), chess("R", "U", "1-0"), chess("S", "T", "1-0"), chess("S", "U", "1-0"), chess("T", "U", "1-0"),
    ];
    const byGame = rankAll(direct, ["points", "direct", "lots"], { gamePoints: GAME_POINTS });
    expect(byGame.lotsGroups).toEqual([["P", "Q"]]);
    expect(ids(byGame).slice(3)).toEqual(["R", "S", "U"]);
    expect(ids(rankAll(direct, ["points", "direct", "lots"]))).toEqual(["T", "P", "Q", "R", "S", "U"]);
  });

  it("h2h_wins, h2h_set_ratio, h2h_point_ratio read the mini-table only, never overall rows", () => {
    // h2h_wins: X (1 win 3 draws) and Y (2 wins 1 loss) on 6 points; X beat Y. Overall wins say Y; the mini-table X.
    const winsCase = [fb("X", "Y", 1, 0), fb("X", "Z1", 0, 0), fb("X", "Z2", 1, 1), fb("X", "Z3", 2, 2), fb("Y", "Z1", 2, 0), fb("Y", "Z2", 1, 0)];
    // h2h_set_ratio: X and Y 1 win each; X beat Y 3-2. Overall sets X 3-5, Y 5-3; between them X 3-2.
    const setCase = [fivb("X", "Y", [3, 2], [110, 100]), fivb("Z1", "X", [3, 0], [75, 50]), fivb("Y", "Z2", [3, 0], [75, 50]), fivb("Z1", "Z2", [3, 0], [75, 50])];
    // h2h_point_ratio: Y beat X 3-2 but X scored more in it (110-105). Overall rally points X 210-213, Y 217-210.
    const pointCase = [fivb("Y", "X", [3, 2], [105, 110]), fivb("X", "Z2", [3, 2], [100, 108]), fivb("Z1", "Y", [3, 2], [100, 112]), fivb("Z1", "Z2", [3, 0], [75, 50])];
    const cases: [FixtureResult[], TiebreakerKey, TiebreakerKey, TiebreakerKey][] = [
      [winsCase, "points", "h2h_wins", "wins"],
      [setCase, "wins", "h2h_set_ratio", "set_ratio"],
      [pointCase, "wins", "h2h_point_ratio", "point_ratio"],
    ];
    let checked = 0;
    for (const [results, first, h2hKey, overallKey] of cases) {
      const mini = rankAll(results, [first, h2hKey, "lots"]);
      const order = ids(mini).filter((id) => id === "X" || id === "Y");
      expect(order, h2hKey).toEqual(["X", "Y"]);
      expect([rowOf(mini, "X").tieBreak?.key, rowOf(mini, "Y").tieBreak?.key], h2hKey).toEqual([h2hKey, h2hKey]);
      // The same table read OVERALL puts Y first, so the key cannot pass by reading overall rows.
      expect(ids(rankAll(results, [first, overallKey, "lots"])).filter((id) => id === "X" || id === "Y"), overallKey).toEqual(["Y", "X"]);
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("anti-goal 2: a cascade key with no comparator throws CONFIG_INVALID (was a silent skip, tiebreakers.ts:529-537)", () => {
    expect([ALL_KEYS_ARE_KEYS, ALL_KEYS_ARE_ALL]).toEqual([true, true]);
    const results = [fb("A", "B", 1, 1), fb("A", "C", 2, 0), fb("B", "C", 2, 0)];
    const refused = (cascade: readonly string[]): EngineError => {
      try {
        rankAll(results, cascade as TiebreakerKey[]);
      } catch (e) {
        if (e instanceof EngineError) return e;
        throw e;
      }
      throw new Error(`${cascade.join(",")} was not refused`);
    };
    // A preset NAME stored where a key belongs — refused, and the error names the key and its position.
    const unknown = refused(["points", "fifa2026", "lots"]);
    expect([unknown.code, unknown.data]).toEqual(["CONFIG_INVALID", { key: "fifa2026", index: 1 }]);
    // The message a person reads counts positions from 1: the second key is "position 2".
    expect(unknown.message).toBe('tie-break key "fifa2026" at position 2 has no comparator');
    // Refused whatever the data: a table the first key already orders (A 6, B 3, C 0) still refuses a broken order, so
    // the refusal cannot hide behind a season with no ties.
    const ordered = [fb("A", "B", 1, 0), fb("A", "C", 1, 0), fb("B", "C", 1, 0)];
    expect(() => rankAll(ordered, ["points", "fifa2026"] as unknown as TiebreakerKey[])).toThrow(EngineError);
    expect(ids(rankAll(ordered, ["points", "lots"]))).toEqual(["A", "B", "C"]);
    // A modifier with no head-to-head block directly before it, and a second modifier on one block.
    const stray = refused(["points", "h2h_reapply", "lots"]);
    expect(stray.data).toEqual({ key: "h2h_reapply", index: 1 });
    expect(stray.message).toBe('tie-break key "h2h_reapply" at position 2 must directly follow a head-to-head block, at most one per block');
    expect(refused(["points", "h2h_points", "h2h_reapply", "h2h_exclusion"]).data).toEqual({ key: "h2h_exclusion", index: 3 });
    // A stored order is data: a key that names an Object.prototype member is no comparator either.
    expect(refused(["points", "constructor"]).data).toEqual({ key: "constructor", index: 1 });
    // The positive pair: every key the union declares ranks (a modifier after a block, as it must stand).
    let checked = 0;
    for (const key of ALL_KEYS) {
      const cascade: TiebreakerKey[] = MODIFIERS.includes(key) ? ["points", "h2h_points", key, "lots"] : ["points", key, "lots"];
      expect(() => rankAll(results, cascade), key).not.toThrow();
      checked++;
    }
    expect(checked).toBe(ALL_KEYS.length);
  });

  it("edge: one entrant; all level down to the last key; 2-, 3- and 4-way ties; h2h_two on two who never met; exclusion after the first split; a stage with pools", () => {
    // One entrant: rank 1, nothing to explain.
    const one = rankStandings([row("A", { played: 0, won: 0, lost: 0, points: 0 })], { cascade: BWF, rngSeed: 1 });
    expect(one.rows.map((r) => [r.entrantId, r.rank, r.tieBreak])).toEqual([["A", 1, undefined]]);
    expect(one.lotsGroups).toEqual([]);
    // All level to the last key: three identical rows, no meetings → one drawing of lots for all three. h2h_two never
    // applied (a class of three), and the residual says so.
    const level = ["A", "B", "C"].map((id) => row(id, { played: 2, won: 1, lost: 1, points: 2, metrics: { sets_won: 3, sets_lost: 3, points_won: 60, points_lost: 60 } }));
    const drawn = rankStandings(level, { cascade: BWF, results: [], rngSeed: 1 });
    expect(drawn.lotsGroups).toEqual([["A", "B", "C"]]);
    for (const r of drawn.rows) expect([r.tieBreak?.key, r.tieBreak?.note, r.tieUnbroken], r.entrantId).toEqual(["lots", "h2h_two_not_applicable", true]);
    // 2-way, twice (BWF 16.2.2, the winner of their match): Y beat X, X beat Z and W, Z beat Y, Y beat W, W beat Z.
    // X and Y on 2 wins → Y (beat X); Z and W on 1 → W (beat Z). Y, X, W, Z.
    const two = rankAll([
      bwf("Y", "X", [2, 1], [60, 58]), bwf("X", "Z", [2, 0], [42, 30]), bwf("X", "W", [2, 0], [42, 30]),
      bwf("Z", "Y", [2, 1], [58, 55]), bwf("Y", "W", [2, 0], [42, 30]), bwf("W", "Z", [2, 1], [55, 50]),
    ], BWF);
    expect(ids(two)).toEqual(["Y", "X", "W", "Z"]);
    for (const r of two.rows) expect(r.tieBreak?.key, r.entrantId).toBe("h2h_two");
    // 4-way: P, Q, R, S all 3 wins; games difference P +4, Q +4, R +1, S +1; Q beat P, S beat R → Q, P, S, R.
    const four = ["P", "Q", "R", "S"].map((id, i) => row(id, { played: 5, won: 3, lost: 2, points: 6, metrics: { sets_won: [10, 10, 8, 8][i] as number, sets_lost: [6, 6, 7, 7][i] as number } }));
    const fourRanked = rankStandings(four, { cascade: BWF, results: [bwf("Q", "P", [2, 1], [60, 58]), bwf("S", "R", [2, 0], [42, 30])], rngSeed: 1 });
    expect(ids(fourRanked)).toEqual(["Q", "P", "S", "R"]);
    for (const r of fourRanked.rows) expect([r.tieBreak?.key, r.tieBreak?.note], r.entrantId).toEqual(["h2h_two", undefined]);
    // h2h_two on two who never met: no split, the note, then the drawing of lots; the positive pair (they met) shows no
    // note.
    const neverMet = [row("X", { played: 2, won: 1, lost: 1, points: 2 }), row("Y", { played: 2, won: 1, lost: 1, points: 2 })];
    const nm = rankStandings(neverMet, { cascade: ["wins", "h2h_two", "lots"], results: [], rngSeed: 1 });
    expect(nm.lotsGroups).toEqual([["X", "Y"]]);
    for (const r of nm.rows) expect(r.tieBreak?.note, r.entrantId).toBe("h2h_two_not_applicable");
    const met = rankStandings(neverMet, { cascade: ["wins", "h2h_two", "lots"], results: [bwf("Y", "X", [2, 0], [42, 30])], rngSeed: 1 });
    expect(ids(met)).toEqual(["Y", "X"]);
    for (const r of met.rows) expect([r.tieBreak?.key, r.tieBreak?.note], r.entrantId).toEqual(["h2h_two", undefined]);
    // Two who met and are LEVEL between them (a double round robin, a win each): no split, the note.
    const levelPair = rankStandings(neverMet, { cascade: ["wins", "h2h_two", "lots"], results: [bwf("Y", "X", [2, 0], [42, 30]), bwf("X", "Y", [2, 1], [55, 50])], rngSeed: 1 });
    expect(levelPair.lotsGroups).toEqual([["X", "Y"]]);
    for (const r of levelPair.rows) expect(r.tieBreak?.note, r.entrantId).toBe("h2h_two_not_applicable");
    // h2h_two as the FIRST key is the primary order, like any first key: it orders, and explains nothing.
    const head = rankStandings(neverMet, { cascade: ["h2h_two", "lots"], results: [bwf("Y", "X", [2, 0], [42, 30])], rngSeed: 1 });
    expect(head.rows.map((r) => [r.entrantId, r.tieBreak])).toEqual([["Y", undefined], ["X", undefined]]);
    // A note answers the LAST step that left the class whole: three level on wins (h2h_two: not two), then games
    // difference splits A off, and B–C go to lots WITHOUT the note — h2h_two never looked at that pair.
    const later = rankStandings(
      [["A", 3, 1], ["B", 2, 2], ["C", 2, 2]].map(([id, w, l]) => row(id as string, { played: 2, won: 1, lost: 1, points: 2, metrics: { sets_won: w as number, sets_lost: l as number } })),
      { cascade: ["wins", "h2h_two", "set_diff", "lots"], results: [], rngSeed: 1 },
    );
    expect(later.lotsGroups).toEqual([["B", "C"]]);
    expect(later.rows.map((r) => [r.entrantId, r.tieBreak?.key, r.tieBreak?.note])).toEqual(
      expect.arrayContaining([["A", "set_diff", undefined], ["B", "lots", undefined], ["C", "lots", undefined]]),
    );
    // Exclusion after the first split: P, Q, R, S on 7 points; among them P 5, Q 5, R 4, S 4 → {P,Q} and {R,S}. Each
    // pair restarts on its own match: Q beat P, R beat S → Q, P, R, S. Without exclusion the four-way games ratio
    // decides each pair: P 8-3 over Q 6-7, S 5-6 over R 5-8 → P, Q, S, R.
    const split = [
      ittf("P", "R", [3, 0], [33, 20]), ittf("P", "S", [3, 0], [33, 20]), ittf("Q", "P", [3, 2], [50, 48]),
      ittf("Q", "R", [3, 2], [50, 48]), ittf("S", "Q", [3, 0], [33, 20]), ittf("R", "S", [3, 2], [50, 48]),
      ittf("W1", "P", [3, 0], [33, 20]), ittf("W1", "Q", [3, 0], [33, 20]), ittf("R", "W1", [3, 0], [33, 20]), ittf("S", "W1", [3, 0], [33, 20]),
      ittf("W2", "P", [3, 0], [33, 20]), ittf("W2", "Q", [3, 0], [33, 20]), ittf("W2", "R", [3, 0], [33, 20]), ittf("W2", "S", [3, 0], [33, 20]),
      ittf("W1", "W2", [3, 0], [33, 20]),
    ];
    const ex = rankAll(split, ITTF);
    expect(ids(ex).slice(2)).toEqual(["Q", "P", "R", "S"]);
    expect(ids(rankAll(split, ITTF_WITHOUT_EXCLUSION)).slice(2)).toEqual(["P", "Q", "S", "R"]);
    // A stage with pools: each pool ranks on its own fixtures only. Pool 1: A and B 1 win each and have not met
    // (their match is still scheduled) → games difference: A +2, B +1. C and D 0 wins, not met: D −1 above C −2.
    // Pool 2: a cycle of 2-1 wins (games 3-3 each). Rally points: E 60-50 and 55-55 (+10), F 50-60 and 55-50 (−5),
    // G 50-55 and 55-55 (−5) → E on points difference, then F–G by their match: F beat G.
    const fx = (id: string, poolId: string, result?: FixtureResult): TableFixture & { result?: FixtureResult } =>
      result === undefined ? { id, poolId, status: "scheduled" } : { id, poolId, status: "decided", result };
    const stage = completeTableStage(
      { id: "s", kind: "group", entrants: ["A", "B", "C", "D", "E", "F", "G"], cascade: BWF, rngSeed: 1 },
      [
        fx("1", "1", bwf("A", "C", [2, 0], [42, 30])), fx("2", "1", bwf("B", "D", [2, 1], [55, 50])), fx("3", "1"),
        fx("4", "2", bwf("E", "F", [2, 1], [60, 50])), fx("5", "2", bwf("F", "G", [2, 1], [55, 50])), fx("6", "2", bwf("G", "E", [2, 1], [55, 55])),
      ],
    );
    const pool = (name: string): readonly StandingsRow[] => stage.tables.pools.find((p) => p.pool === name)?.rows ?? [];
    expect(pool("1").map((r) => r.entrantId)).toEqual(["A", "B", "D", "C"]);
    expect(pool("1").map((r) => r.tieBreak?.key)).toEqual(["set_diff", "set_diff", "set_diff", "set_diff"]);
    expect(pool("2").map((r) => r.entrantId)).toEqual(["E", "F", "G"]);
    expect(pool("2").map((r) => r.tieBreak?.key)).toEqual(["point_diff", "h2h_two", "h2h_two"]);
  });

  it("edge: a double walkover is out of every ratio (X-DW-4); a void then the table again; a second rank call is identical", () => {
    // X-DW-4, every sport: the module's own double walkover feeds no ledger the new keys read, and adding it to a table
    // moves none of their verdicts.
    const NEW_LEDGERS = ["sets_won", "sets_lost", "points_won", "points_lost", "gf", "goals_pc", "goals_stroke", "won_ot"];
    const NEW_KEYS: TiebreakerKey[][] = [["set_diff"], ["point_diff"], ["field_goals"], ["h2h_set_ratio"], ["h2h_point_ratio"], ["h2h_wins"], ["matches_played"], ["h2h_two"]];
    const base: FixtureResult[] = [
      [side({ id: "X", won: 1, points: 3, metrics: { sets_won: 3, sets_lost: 1, points_won: 80, points_lost: 70, gf: 3, goals_pc: 1, goals_stroke: 0 } }),
        side({ id: "Y", lost: 1, points: 0, metrics: { sets_won: 1, sets_lost: 3, points_won: 70, points_lost: 80, gf: 1, goals_pc: 0, goals_stroke: 0 } })],
      [side({ id: "Y", won: 1, points: 3, metrics: { sets_won: 3, sets_lost: 2, points_won: 95, points_lost: 90, gf: 2, goals_pc: 1, goals_stroke: 1 } }),
        side({ id: "X", lost: 1, points: 0, metrics: { sets_won: 2, sets_lost: 3, points_won: 90, points_lost: 95, gf: 1, goals_pc: 0, goals_stroke: 0 } })],
    ];
    const DOUBLE_WALKOVER = [{ type: "core.forfeit", payload: { by: "both", reason: "walkover" } }];
    let sports = 0;
    let ledgers = 0;
    let verdicts = 0;
    let split = 0;
    forEachSport(({ module: m }) => {
      const cfg = (declaredCfgs(m as never)[0] as { cfg: unknown }).cfg;
      const lineups: LineupPair = { home: lineupFromCatalog(m.positions, "X"), away: lineupFromCatalog(m.positions, "Y") };
      const envelopes = DOUBLE_WALKOVER.map((e, i) => makeEnvelope(i + 1, e as never));
      const folded = foldMatchWithStoppage(m as never, cfg as never, lineups, envelopes);
      const outcome = outcomeOf(m as never, folded as never);
      expect(outcome, m.key).toEqual({ kind: "double_walkover" });
      if (outcome === null) return;
      const dw = m.standingsDelta(outcome, cfg, { kind: "league" }, folded.state) as FixtureResult;
      for (const d of dw) {
        for (const ledger of NEW_LEDGERS) {
          expect(d.metrics[ledger] ?? 0, `${m.key} ${d.entrantId} ${ledger}`).toBe(0);
          ledgers++;
        }
      }
      for (const keys of NEW_KEYS) {
        const cascade: TiebreakerKey[] = ["points", ...keys, "seed"];
        const before = rankAll(base, cascade);
        const after = rankAll([...base, dw], cascade);
        const verdict = (r: RankingResult) => r.rows.map((x) => [x.entrantId, x.tieBreak?.key]);
        expect(verdict(after), `${m.key} ${keys.join()}`).toEqual(verdict(before));
        verdicts++;
        if (before.rows.some((x) => x.tieBreak?.key === keys[0])) split++;
      }
      sports++;
    });
    expect(sports).toBe(builtinModules.length);
    expect(ledgers).toBe(builtinModules.length * 2 * NEW_LEDGERS.length);
    expect(verdicts).toBe(builtinModules.length * NEW_KEYS.length);
    // Five of the eight keys order X above Y on this base (set_diff +1, point_diff +5, field_goals 3 v 1, and the two
    // h2h ratios over their two meetings), so the comparison above witnessed a live verdict, not only level rows.
    expect(split).toBe(builtinModules.length * 5);

    // A void, then the table again (the stage path: a void fixture leaves the fold AND the head-to-head source).
    // IH-TB-1's table: A, B, C on 6 points, re-applied to A over B. Voiding B 5-0 D takes B to 3 points: A and C remain
    // on 6, and their own match decides (C beat A 2-1) → C, A, B, D. Restoring it restores A, B, C, D.
    const games = [ih("A", "B", 3, 1), ih("B", "C", 3, 0), ih("C", "A", 2, 1), ih("A", "D", 1, 0), ih("B", "D", 5, 0), ih("C", "D", 1, 0)];
    const stageAt = (voided: number | null) =>
      completeTableStage(
        { id: "s", kind: "league", entrants: ["A", "B", "C", "D"], cascade: IIHF, rngSeed: 1 },
        games.map((result, i) => ({ id: `f${i}`, status: i === voided ? ("void" as const) : ("decided" as const), result })),
      ).events.find((e) => e.type === "stage_completed");
    expect(stageAt(null)).toEqual({ type: "stage_completed", stageId: "s", finalRanks: ["A", "B", "C", "D"] });
    expect(stageAt(4)).toEqual({ type: "stage_completed", stageId: "s", finalRanks: ["C", "A", "B", "D"] });
    expect(stageAt(null)).toEqual({ type: "stage_completed", stageId: "s", finalRanks: ["A", "B", "C", "D"] });

    // A second rank call is identical, and neither call writes to its input (frozen: a write would throw).
    const frozen = foldResults(["A", "B", "C", "D"], games).map((r) => Object.freeze({ ...r, metrics: Object.freeze({ ...r.metrics }) }));
    const ctx: RankContext = { cascade: IIHF, results: games, rngSeed: 1 };
    const first = rankStandings(frozen, ctx);
    const second = rankStandings(frozen, ctx);
    expect(second).toStrictEqual(first);
    expect(ids(first)).toEqual(["A", "B", "C", "D"]);
  });
});

// ---------------------------------------------------------------------------
// The refinement driver's own guards (W2d T4 fix round 1: the changed-lines Stryker leg found each one unwitnessed)
// ---------------------------------------------------------------------------

/** Rank with the fixtures COUNTED: every mini-table, direct encounter and SB ledger reads them through
 *  `resultsAmong`, one `filter` call per read (the termination property's counter). The rows are folded first, from
 *  the plain array, so only the rank call's own reads are counted. */
function rankCounted(results: readonly FixtureResult[], cascade: readonly TiebreakerKey[]): { ranked: RankingResult; reads: number } {
  const entrants = [...new Set(results.flatMap(([h, a]) => [h.entrantId, a.entrantId]))].sort();
  const rows = foldResults(entrants, results);
  let reads = 0;
  const counted = new Proxy(results, {
    get(target, prop, receiver) {
      if (prop === "filter") reads++;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  const ranked = rankStandings(rows, { cascade, results: counted, rngSeed: 1 });
  return { ranked, reads };
}

/** ITTF, five players, where 3.7.5.3 has to exclude at every depth. E beat everyone. A gave E a walkover and C gave
 *  B one (credited 3-0, 11-0 each game, ITTF 2.3.7; the unplayed loss pays 0, D6). Match points: E 8; A, B, C, D 5.
 *  Among A, B, C, D (3.7.5.2): A 2+2+1 = 5, B 1+2+1 = 4, C 2+0+2 = 4, D 1+1+2 = 4 → A first.
 *  Exclude A's matches; restart on B, C, D: B 2+1 = 3, C 0+2 = 2, D 1+2 = 3 → C last.
 *  Exclude C's matches; restart on B–D: D beat B → D above B. ITTF: E, A, D, B, C. */
const DEEP_EXCLUSION: readonly FixtureResult[] = [
  ittf("E", "A", [3, 0], [33, 0], true),
  ittf("E", "B", [3, 1], [44, 30]),
  ittf("E", "C", [3, 1], [44, 30]),
  ittf("E", "D", [3, 1], [44, 30]),
  ittf("A", "B", [3, 0], [33, 20]),
  ittf("A", "D", [3, 0], [33, 20]),
  ittf("C", "A", [3, 0], [33, 20]),
  ittf("B", "C", [3, 0], [33, 0], true),
  ittf("C", "D", [3, 1], [44, 30]),
  ittf("D", "B", [3, 2], [52, 50]),
];

/** A tie-break trace with its `with` list sorted, every other field as written (a key holding undefined stays). */
function trace(r: RankingResult, id: EntrantId): unknown {
  const t = rowOf(r, id).tieBreak;
  return t === undefined ? undefined : { ...t, with: [...t.with].sort() };
}

/** A Swiss card in half-points (win 2, draw 1, loss 0), the score summed from it. */
const game = (opponent: EntrantId, result: "win" | "draw" | "loss", unplayed = false): SwissGame => ({
  opponent, result, scored: result === "win" ? 2 : result === "draw" ? 1 : 0, ...(unplayed ? { unplayed: true } : {}),
});
const card = (entrant: EntrantId, games: SwissGame[]) => ({ entrant, score: games.reduce((sum, g) => sum + g.scored, 0), games });
const swissRows = (table: SwissTable): StandingsRow[] =>
  table.map((c) =>
    row(c.entrant, {
      played: c.games.length,
      won: c.games.filter((g) => g.result === "win").length,
      drawn: c.games.filter((g) => g.result === "draw").length,
      lost: c.games.filter((g) => g.result === "loss").length,
      points: c.score,
    }),
  );

describe("W2d T4 — the refinement driver's guards", () => {
  it("TT-TB-1 ITTF 3.7.5.3 excludes at every depth: four level, then three, then the last two's own match", () => {
    const deep = rankAll(DEEP_EXCLUSION, ITTF);
    expect(ids(deep)).toEqual(["E", "A", "D", "B", "C"]);
    expect(deep.lotsGroups).toEqual([]);
    // Each placement is traced to the match points of the group it was placed in, among that group's members only.
    expect(trace(deep, "A")).toStrictEqual({ key: "h2h_points", with: ["B", "C", "D"] });
    expect(trace(deep, "C")).toStrictEqual({ key: "h2h_points", with: ["B", "D"] });
    expect(trace(deep, "D")).toStrictEqual({ key: "h2h_points", with: ["B"] });
    expect(trace(deep, "B")).toStrictEqual({ key: "h2h_points", with: ["D"] });
    // Differentials. Restarting only once (B, C, D read on in one pass) puts B above D on games among the three:
    // B 5-3 (1.67), D 4-5 (0.80). No exclusion at all orders B, C, D on games among the four: C 6-4, B 5-6, D 4-8.
    expect(ids(rankAll(DEEP_EXCLUSION, ITTF_WITHOUT_EXCLUSION))).toEqual(["E", "A", "C", "B", "D"]);
  });

  it("a head-to-head step builds one mini-table per tied class of two or more, never for an entrant already alone", () => {
    // The termination bound's unit (tiebreakers.ts h2hBlock): the classes a block visits form a laminar family of sets
    // of size ≥ 2, so a class of n is read at most n − 1 times. The bound is TIGHT on the 3.7.5.3 table: {A, B, C, D},
    // then {B, C, D}, then {B, D} — three reads; E (placed by points) and every placed singleton are read never.
    const deep = rankCounted(DEEP_EXCLUSION, ITTF);
    expect(ids(deep.ranked)).toEqual(["E", "A", "D", "B", "C"]);
    expect(deep.reads).toBe(3);
    // Re-application: IH-TB-1's table. {A, B, C} (D placed by points), then the pair {A, B} it reduced to — two reads.
    const reduced = [ih("A", "B", 3, 1), ih("B", "C", 3, 0), ih("C", "A", 2, 1), ih("A", "D", 1, 0), ih("B", "D", 5, 0), ih("C", "D", 1, 0)];
    const reapplied = rankCounted(reduced, IIHF);
    expect(ids(reapplied.ranked)).toEqual(["A", "B", "C", "D"]);
    expect(reapplied.reads).toBe(2);
    // The empty case: a table the first key already orders reads the fixtures not at all.
    const ordered = rankCounted([ih("A", "B", 1, 0), ih("A", "C", 1, 0), ih("B", "C", 1, 0)], IIHF);
    expect(ids(ordered.ranked)).toEqual(["A", "B", "C"]);
    expect(ordered.reads).toBe(0);
  });

  it("h2hScope 'overall' (Jul3/05 §5): a tie of three or more skips the mini-table for the overall keys; a tie of two still meets head-to-head", () => {
    // A, B, C on 6 points, a cycle among them: A beat B 3-0, B beat C 1-0, C beat A 1-0; each beat D.
    // Mini-table GD: A +2, C 0, B −2 → A, C, B. Overall GD (D: A 1-0, B 6-0, C 2-0): B +4, A +3, C +2 → B, A, C.
    const three = [fb("A", "B", 3, 0), fb("B", "C", 1, 0), fb("C", "A", 1, 0), fb("A", "D", 1, 0), fb("B", "D", 6, 0), fb("C", "D", 2, 0)];
    expect(ids(rankAll(three, FIFA2026))).toEqual(["A", "C", "B", "D"]);
    expect(ids(rankAll(three, FIFA2026, { h2hScope: "mini_table" }))).toEqual(["A", "C", "B", "D"]);
    const overall = rankAll(three, FIFA2026, { h2hScope: "overall" });
    expect(ids(overall)).toEqual(["B", "A", "C", "D"]);
    for (const id of ["A", "B", "C"]) expect(rowOf(overall, id).tieBreak?.key, id).toBe("diff");
    // Two level, twice: P and Q on 6, R and S on 3. P beat Q, but Q has the better GD (+9 v +1); S beat R, but R has
    // the better GD (−1 v −9). Under "overall" each pair still meets head-to-head: P, Q, S, R.
    const two = [fb("P", "Q", 1, 0), fb("R", "P", 1, 0), fb("P", "S", 1, 0), fb("Q", "R", 1, 0), fb("Q", "S", 9, 0), fb("S", "R", 1, 0)];
    const pairs = rankAll(two, FIFA2026, { h2hScope: "overall" });
    expect(ids(pairs)).toEqual(["P", "Q", "S", "R"]);
    expect([rowOf(pairs, "P").tieBreak?.key, rowOf(pairs, "S").tieBreak?.key]).toEqual(["h2h_points", "h2h_points"]);
    // The differential: the overall keys alone order both pairs the other way.
    expect(ids(rankAll(two, ["points", "diff", "lots"]))).toEqual(["Q", "P", "R", "S"]);
  });

  it("a step that splits nothing keeps the earlier step's 'could not split' note for the draw; a draw with no note carries no note key", () => {
    // A, B, C drew every match 1-1: level on points, on every head-to-head key, on GD and goals, and on direct
    // encounter (2 each). h2h_two cannot split three (OC3) and says so; each later step splits nothing, so nothing
    // answered the note and it reaches the draw.
    const level = [fb("A", "B", 1, 1), fb("B", "C", 1, 1), fb("A", "C", 1, 1)];
    const others = (id: EntrantId): EntrantId[] => ["A", "B", "C"].filter((x) => x !== id);
    let checked = 0;
    for (const after of ["h2h_points", "diff", "direct"] as const) {
      const ranked = rankAll(level, ["points", "h2h_two", after, "lots"]);
      expect(ranked.lotsGroups, after).toEqual([["A", "B", "C"]]);
      for (const id of ["A", "B", "C"]) {
        expect(trace(ranked, id), `${after} ${id}`).toStrictEqual({ key: "lots", with: others(id), note: "h2h_two_not_applicable" });
        checked++;
      }
    }
    expect(checked).toBe(9);
    // With no conditional step before the draw, the trace has no note at all — not a `note` key holding undefined.
    const plain = rankAll(level, ["points", "diff", "lots"]);
    for (const id of ["A", "B", "C"]) expect(trace(plain, id), id).toStrictEqual({ key: "lots", with: others(id) });
  });

  // A and B on 4 half-points each, B the higher seed. R1 A–B, C–D drawn; R2 C beat A, B beat D; R3 A–D, B beat C.
  const swissSeeds = new Map([["B", 1], ["A", 2]]);
  const swissDirect: TiebreakerKey[] = ["points", "direct", "seed", "lots"];

  it("direct at rank time: a played Swiss meeting splits the tied pair and is explained (FIDE C.07 art. 6)", () => {
    const [seeds, cascade] = [swissSeeds, swissDirect];
    // A beat B over the board, and beat D by FORFEIT. Direct encounter among the two: A 1-0 → A above B (the seed
    // alone would say B).
    const played: SwissTable = [
      card("A", [game("B", "win"), game("C", "loss"), game("D", "win", true)]),
      card("B", [game("A", "loss"), game("D", "win"), game("C", "win")]),
      card("C", [game("D", "draw"), game("A", "win"), game("B", "loss")]),
      card("D", [game("C", "draw"), game("B", "loss"), game("A", "loss", true)]),
    ];
    expect(played.map((c) => c.score)).toEqual([4, 4, 3, 1]);
    expect(directEncounter(played, "A", "B")).toBe(1);
    const met = rankStandings(swissRows(played), { cascade, swiss: played, seeds, rngSeed: 1 });
    expect(ids(met)).toEqual(["A", "B", "C", "D"]);
    expect([trace(met, "A"), trace(met, "B")]).toStrictEqual([{ key: "direct", with: ["B"] }, { key: "direct", with: ["A"] }]);
    expect(ids(rankStandings(swissRows(played), { cascade: ["points", "seed", "lots"], swiss: played, seeds, rngSeed: 1 }))).toEqual(["B", "A", "C", "D"]);
  });

  it("direct at rank time on a forfeited Swiss meeting matches the engine's directEncounter (parity pin; no FIDE C.07 digest covers forfeits)", () => {
    // NOT a rulebook value: the rulebook digests do not say whether a forfeit counts in direct encounter, so this pins
    // only that the rank-time step and the exported pairwise reader agree (both skip `unplayed`). A FIDE ruling is
    // owed; if it says a forfeit counts, both readers and this expected order change together.
    const [seeds, cascade] = [swissSeeds, swissDirect];
    // The same scores, but A beat B by FORFEIT and D over the board. directEncounter reads the unplayed game as no
    // meeting, so the pair is level on direct and the seed decides: B above A.
    const forfeited: SwissTable = [
      card("A", [game("B", "win", true), game("C", "loss"), game("D", "win")]),
      card("B", [game("A", "loss", true), game("D", "win"), game("C", "win")]),
      card("C", [game("D", "draw"), game("A", "win"), game("B", "loss")]),
      card("D", [game("C", "draw"), game("B", "loss"), game("A", "loss")]),
    ];
    expect(forfeited.map((c) => c.score)).toEqual([4, 4, 3, 1]);
    expect(directEncounter(forfeited, "A", "B")).toBe(0);
    const unmet = rankStandings(swissRows(forfeited), { cascade, swiss: forfeited, seeds, rngSeed: 1 });
    expect(ids(unmet)).toEqual(["B", "A", "C", "D"]);
    expect([trace(unmet, "B"), trace(unmet, "A")]).toStrictEqual([{ key: "seed", with: ["A"] }, { key: "seed", with: ["B"] }]);
  });

  it("the empty table: no entrants is no tie and no draw — lotsGroups [] for zero rows, whatever the cascade", () => {
    // First principles: a drawing of lots separates entrants level on every key, so it needs at least two entrants.
    // Zero rows have no tie to draw; an empty group in lotsGroups would ask an organiser to lock nobody.
    let checked = 0;
    for (const cascade of [["points", "lots"], ["points", "diff", "lots"], ["points", "direct", "lots"], BWF, ITTF, UEFA, ATP, FIDE_RR] as TiebreakerKey[][]) {
      expect(rankStandings([], { cascade, rngSeed: 1 }), cascade.join(",")).toStrictEqual({ rows: [], lotsGroups: [], newLotsDraws: [] });
      checked++;
    }
    expect(checked).toBe(8);
  });

  it("a stage with an empty pool emits no rank_lock_required for it (stage.ts emits one per lotsGroups entry)", () => {
    // A group stage: pool A drew its one match (a real tie, so one lock naming both); pool B has only an unplayed
    // fixture, so no member yet and nobody to draw.
    const grouped = completeTableStage(
      { id: "g", kind: "group", entrants: ["A1", "A2", "B1", "B2"], cascade: ["points", "lots"], rngSeed: 1 },
      [{ id: "a", poolId: "A", status: "decided", result: fb("A1", "A2", 1, 1) }, { id: "b", poolId: "B", status: "scheduled" }],
    );
    expect(grouped.events.filter((e) => e.type === "rank_lock_required")).toEqual([{ type: "rank_lock_required", stageId: "g", group: ["A1", "A2"] }]);
    expect(grouped.tables.pools.map((p) => [p.pool, p.rows.length])).toEqual([["A", 2], ["B", 0]]);
    // A league stage with no entrants completes with an empty order and nothing to lock.
    const league = completeTableStage({ id: "s", kind: "league", entrants: [], cascade: ["points", "lots"], rngSeed: 1 }, []);
    expect(league.events).toEqual([{ type: "stage_completed", stageId: "s", finalRanks: [] }]);
  });

  it("the round-robin SB column is written only when the cascade ranks on sberger (B5's ledger is built for it alone)", () => {
    // A beat B, B beat C, A–C drawn, on the 3/1/0 table. FIDE game points: A 1½, B 1, C ½. SB (C.07 9.1): A = B's 1 +
    // ½ × C's ½ = 1¼; B = C's ½; C = ½ × A's 1½ = ¾.
    const games = [chess("A", "B", "1-0"), chess("B", "C", "1-0"), chess("C", "A", "½-½")];
    const withSb = rankAll(games, ["points", "sberger", "lots"], { gamePoints: GAME_POINTS });
    expect(withSb.rows.map((r) => [r.entrantId, r.metrics["sberger"]])).toEqual([["A", 1.25], ["B", 0.5], ["C", 0.75]]);
    let checked = 0;
    for (const cascade of [["points", "wins", "lots"], ["points", "direct", "lots"]] as TiebreakerKey[][]) {
      const without = rankAll(games, cascade, { gamePoints: GAME_POINTS });
      for (const r of without.rows) {
        expect(Object.hasOwn(r.metrics, "sberger"), `${cascade.join(",")} ${r.entrantId}`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBe(6);
    // On a Swiss stage the assembled ledger is SB's source (and its column's), so no pool ledger is built from the
    // results: ranking on sberger with a Swiss ledger reads the results not at all.
    let reads = 0;
    const counted = new Proxy(games, {
      get(target, prop, receiver) {
        if (prop === "filter") reads++;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const swiss = buildSwissTable(["A", "B", "C"], games);
    const onSwiss = rankStandings(foldResults(["A", "B", "C"], games), { cascade: ["points", "sberger", "lots"], swiss, results: counted, rngSeed: 1 });
    expect(ids(onSwiss)).toEqual(["A", "B", "C"]);
    expect(reads).toBe(0);
  });
});
