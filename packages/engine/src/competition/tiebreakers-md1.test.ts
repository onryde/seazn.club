// W2d Task 20 (MD-1, spec §14: W2d owns every survivor in competition/tiebreakers.ts): the tests that kill what
// Stryker left alive there. The mutants recorded as equivalent are in stryker-equivalent.json, each with its proof.
//
// Expected values are computed by hand from the rule each block cites — Buchholz, Cut-1 and Sonneborn-Berger as sums
// over a card (spec 04 §6.3), spec 05 §4.2 (direct encounter), spec 05 §4.3 (a ratio is compared by cross-multiplication;
// 0/0 is 0, "no data"), the ICC net run rate (runs for per over faced minus runs against per over bowled, spec 04 §5) —
// and from the engine's own declarations (`SwissGame`, `RATIO_LEDGERS`). Never from rankStandings or the Swiss readers
// under test. The virtual opponent of an unplayed game is NOT pinned to a number: the engine's formula DIFFERS from FIDE
// C.07 (rulebook-W3-swiss.md T2, SW-M1, W3-owned), so its tests are relational and hold under every candidate model.
//
// Every table here is hand-built; the one sport read is the whole registry, swept (R26).
import { describe, expect, it } from "vitest";
import type { StandingsDelta } from "../core/types.ts";
import { mulberry32 } from "../core/rng.ts";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { RATIO_LEDGERS } from "./display.ts";
import type { FixtureResult, StandingsRow } from "./standings.ts";
import { buchholz, buildSwissTable, directEncounter, rankStandings, type SwissTable } from "./tiebreakers.ts";

const row = (entrantId: string, points: number, metrics: Record<string, number> = {}): StandingsRow => ({
  entrantId, played: 0, won: 0, drawn: 0, lost: 0, points, metrics,
});
const ids = (rows: readonly StandingsRow[]): string[] => rows.map((r) => r.entrantId);
/** One side of a decided game, in half-points (win 2, draw 1, loss 0). */
const side = (entrantId: string, r: "w" | "d" | "l"): StandingsDelta => ({
  entrantId, played: 1, won: r === "w" ? 1 : 0, drawn: r === "d" ? 1 : 0, lost: r === "l" ? 1 : 0,
  points: r === "w" ? 2 : r === "d" ? 1 : 0, metrics: {},
});
const beat = (winner: string, loser: string): FixtureResult => [side(winner, "w"), side(loser, "l")];

// The engine's current virtual-opponent model DIFFERS from FIDE C.07 (rulebook-W3-swiss.md T2; SW-M1, W3 owns the fix),
// so no number here is asserted as the rule's: each test is a relation that holds under the engine's model, the
// superseded C.07 text (A6) and the current one (A4 16.4) alike.
describe("W2d T20 MD-1 — the virtual opponent of an unplayed game, however the card writes it (relational: the model DIFFERS from C.07, W3)", () => {
  // X: R1 beat Y; R2 a game X did not play; R3 beat Z — 3 rounds. Half-points: Y 3, Z 1; V, the R2 absentee, 8.
  const SCORE = { X: 6, Y: 3, Z: 1, V: 8 } as const;
  const withRound2 = (game: SwissTable[number]["games"][number]): SwissTable => [
    { entrant: "X", score: SCORE.X, games: [{ opponent: "Y", result: "win", scored: 2 }, game, { opponent: "Z", result: "win", scored: 2 }] },
    { entrant: "Y", score: SCORE.Y, games: [] },
    { entrant: "Z", score: SCORE.Z, games: [] },
    { entrant: "V", score: SCORE.V, games: [{ opponent: "X", result: "loss", scored: 0, unplayed: true }] },
  ];

  it("a FORFEIT against a real opponent (unplayed, opponent named) is not scored at the absentee's own score", () => {
    // V did not show in R2: the game is unplayed though V exists (SwissGame: "unplayed games (byes, forfeits, absences)
    // use a FIDE virtual opponent"). Reading V's real score gives Y + V + Z = 12; every candidate model differs from it
    // on this card (by the reviewer's arithmetic: the engine 8, C.07 A6 7, C.07 A4 16.4.1 10), so only "not 12" is asserted.
    const forfeit = buchholz(withRound2({ opponent: "V", result: "win", scored: 2, unplayed: true }), "X");
    expect(forfeit).not.toBe(SCORE.Y + SCORE.V + SCORE.Z);
  });

  it("a BYE written without the unplayed flag (opponent null: 'null for a bye') reads exactly as the flagged bye", () => {
    // A representation fact, true under every model: the card's two spellings of one bye are one bye.
    const flagged = buchholz(withRound2({ opponent: null, result: "win", scored: 2, unplayed: true }), "X");
    expect(buchholz(withRound2({ opponent: null, result: "win", scored: 2 }), "X")).toBe(flagged);
    // and neither reads the round as 0: on this card every candidate model scores the bye's virtual opponent above 0
    expect(flagged).toBeGreaterThan(SCORE.Y + SCORE.Z);
  });
});

describe("W2d T20 MD-1 — spec 05 §4.2 direct encounter: a drawn meeting is level", () => {
  it("two who drew their game are level both ways (0), not split by the half-points each scored", () => {
    const table: SwissTable = [
      { entrant: "A", score: 1, games: [{ opponent: "B", result: "draw", scored: 1 }] },
      { entrant: "B", score: 1, games: [{ opponent: "A", result: "draw", scored: 1 }] },
    ];
    expect(directEncounter(table, "A", "B")).toBe(0);
    expect(directEncounter(table, "B", "A")).toBe(0);
  });
});

// A 6-player Swiss, two rounds. R1: P beat X, Q beat Y, Z beat W. R2: Z beat P, X beat Q. Half-points: Z 4; P, X, Q 2;
// Y, W 0. By hand (C.07), in half-points:
//   Buchholz  P = X 2 + Z 4 = 6; X = P 2 + Q 2 = 4; Q = Y 0 + X 2 = 2; Z = W 0 + P 2 = 2; Y = Q 2; W = Z 4.
//   Cut-1     drops the lowest: P 4; X 2; Q 2; Z 2; Y 0 (its one game); W 0.
//   SB (×4)   2 × each beaten opponent's score: P beat X → 4; X beat Q → 4; Z beat W and P → 0 + 4; Q beat Y → 0; Y, W 0.
const SWISS_RESULTS: readonly FixtureResult[] = [beat("P", "X"), beat("Q", "Y"), beat("Z", "W"), beat("Z", "P"), beat("X", "Q")];
const SWISS_ENTRANTS = ["P", "Q", "W", "X", "Y", "Z"];
const SCORES: Readonly<Record<string, number>> = { P: 2, Q: 2, W: 0, X: 2, Y: 0, Z: 4 };

describe("W2d T20 MD-1 — a Swiss table's Buchholz Cut-1, and the columns it materialises", () => {
  const table = buildSwissTable(SWISS_ENTRANTS, SWISS_RESULTS);
  const rows = SWISS_ENTRANTS.map((id) => row(id, SCORES[id]!));

  it("premise: the ledger holds the scores the results give (the table the hand counts read)", () => {
    expect(Object.fromEntries(table.map((r) => [r.entrant, r.score]))).toEqual(SCORES);
  });

  it("buchholz_cut1 orders the 2-point class P (4) above X and Q (2 each), then Buchholz X (4) above Q (2) — in either input order", () => {
    const cascade = ["points", "buchholz_cut1", "buchholz", "sberger"] as const;
    for (const input of [rows, [...rows].reverse()]) {
      const ranked = rankStandings(input, { cascade: [...cascade], swiss: table }).rows;
      expect(ids(ranked)).toEqual(["Z", "P", "X", "Q", "W", "Y"]);
      expect(ranked.find((r) => r.entrantId === "P")?.tieBreak?.key).toBe("buchholz_cut1");
      expect(ranked.find((r) => r.entrantId === "X")?.tieBreak?.key).toBe("buchholz");
    }
  });

  it("the Swiss columns the cascade uses are written in display points: Buchholz and Cut-1 ÷ 2, Sonneborn-Berger ÷ 4", () => {
    const ranked = rankStandings(rows, { cascade: ["points", "buchholz", "buchholz_cut1", "sberger", "lots"], swiss: table }).rows;
    const shown = Object.fromEntries(ranked.map((r) => [r.entrantId, [r.metrics.buchholz, r.metrics.buchholz_cut1, r.metrics.sberger]]));
    expect(shown).toEqual({
      P: [3, 2, 1], X: [2, 1, 1], Q: [1, 1, 0], Z: [1, 1, 1], Y: [1, 0, 0], W: [2, 0, 0],
    });
    expect(ranked, "anti-vacuity: every row checked").toHaveLength(6);
    // the negative pair: a column the cascade does not use is not written
    const plain = rankStandings(rows, { cascade: ["points", "buchholz"], swiss: table }).rows;
    expect(plain, "anti-vacuity: every row of the negative pair checked").toHaveLength(SWISS_ENTRANTS.length);
    for (const r of plain) {
      expect(Object.keys(r.metrics).sort(), r.entrantId).toEqual(["buchholz"]);
    }
  });
});

describe("W2d T20 MD-1 — buildSwissTable: the card a result writes (SwissGame), and a bye on top of played games", () => {
  it("a loser's card reads 'loss', and a bye adds to the score the played games already hold (score = Σ scored)", () => {
    const award: StandingsDelta = { entrantId: "A", played: 1, won: 1, drawn: 0, lost: 0, points: 2, metrics: {} };
    expect(buildSwissTable(["A", "B"], [beat("A", "B")], [award])).toStrictEqual([
      {
        entrant: "A", score: 4,
        games: [
          { opponent: "B", result: "win", scored: 2 },
          { opponent: null, result: "win", scored: 2, unplayed: true },
        ],
      },
      { entrant: "B", score: 0, games: [{ opponent: "A", result: "loss", scored: 0 }] },
    ]);
  });
});

describe("W2d T20 MD-1 — ratio keys: spec 05 §4.3 (0/0 is 0, 'no data') and the ICC net run rate", () => {
  it("set_ratio: a row with sets 1-2 (0.5) ranks above a row with no sets at all (0/0 = 0)", () => {
    const [won, lost] = RATIO_LEDGERS.set_ratio;
    // Named so the residual order (seed, then id) would put the no-data row first: a level verdict reads A, B.
    // Both input orders: the sort hands the 0/0 row to the comparator as either side, so each side's 0/0 arm is reached.
    const a = row("A", 3);
    const b = row("B", 3, { [won]: 1, [lost]: 2 });
    for (const input of [[a, b], [b, a]]) {
      const ranked = rankStandings(input, { cascade: ["points", "set_ratio"] }).rows;
      expect(ids(ranked), ids(input).join(",")).toEqual(["B", "A"]);
      expect(ranked[0]?.tieBreak?.key).toBe("set_ratio");
    }
  });

  it("nrr: equal runs conceded per over, so the runs scored decide — 12.0 − 9.0 above 10.0 − 9.0 runs per over", () => {
    // A: 100 runs in 60 balls (10 overs), 90 conceded in 60 balls → NRR +1.0. B: 120 in 60 → +3.0.
    const nrr = (rf: number) => ({ runs_for: rf, balls_faced_eff: 60, runs_against: 90, balls_bowled_eff: 60 });
    const ranked = rankStandings([row("A", 2, nrr(100)), row("B", 2, nrr(120))], { cascade: ["points", "nrr"] }).rows;
    expect(ids(ranked)).toEqual(["B", "A"]);
    expect(ranked[0]?.tieBreak?.key).toBe("nrr");
  });

  it("nrr: a side yet to play (no runs, no balls: 0/0 = 0) ranks above a side that lost on net run rate, level on points (both input orders)", () => {
    // Round one, cascade points → wins → nrr (T20WC 16.10.4): A has not played; B lost, 90 off 60 balls against 120
    // off 60 → NRR 9.0 − 12.0 = −3.0, below A's 0 (spec 05 §4.3: 0/0 is 0, "no data").
    const a = row("A", 0);
    const b = row("B", 0, { runs_for: 90, balls_faced_eff: 60, runs_against: 120, balls_bowled_eff: 60 });
    for (const input of [[a, b], [b, a]]) {
      const ranked = rankStandings(input, { cascade: ["points", "wins", "nrr"] }).rows;
      expect(ids(ranked), ids(input).join(",")).toEqual(["A", "B"]);
      expect(ranked[0]?.tieBreak?.key).toBe("nrr");
    }
  });
});

describe("W2d T20 MD-1 — the guards behind the recorded equivalents (assumptions are guards)", () => {
  it("this runtime's sort asks the comparator only (later, earlier) and reads only whether the answer is negative — the premise of the V8-sort equivalents (counted, with a control)", () => {
    // stryker-equivalent.json records mutants that change only a comparator's NON-negative answers as the sort sees them:
    // sgn's negative arm and compareRatio's `lhs < rhs` arm (both under groupBySort's `-sgn(cmp)`), bySeedThenId's id
    // tail, and (unrecorded, its key shared) compareRecorded's `va === undefined` arm. They hold only while
    // Array.prototype.sort is V8's TimSort, which compares an element only against an EARLIER one and moves it only on a
    // negative answer. Another engine's sort (SpiderMonkey's insertion sort asks (earlier, later) and moves on > 0)
    // turns this red, and those rows must then be re-checked, never kept.
    const rng = mulberry32(0x5eed2020);
    const int = (n: number) => Math.floor(rng() * n);
    type El = { readonly k: number; readonly i: number };
    const orderOf = (els: readonly El[], cmp: (a: El, b: El) => number) => [...els].sort(cmp).map((e) => e.i).join(",");
    const byKey = (a: El, b: El) => a.k - b.k;
    let inputs = 0;
    let merged = 0; // inputs long enough that TimSort merges runs (and gallops), not only binary insertion
    let calls = 0;
    let askedEarlierFirst = 0;
    let signOnlyChecks = 0;
    let signOnlyDiffer = 0;
    let controlDiffer = 0;
    for (let trial = 0; trial < 3000; trial++) {
      const n = trial % 5 === 0 ? 64 + int(237) : 2 + int(40);
      const keys = Array.from({ length: n }, () => int(6));
      // every third input is built of presorted runs, so merges meet long runs and gallop
      if (trial % 3 === 0) {
        for (let from = 0; from < n; from += 8 + int(40)) {
          const run = keys.slice(from, from + 8 + int(40)).sort((x, y) => x - y);
          keys.splice(from, run.length, ...run);
        }
      }
      const els: El[] = keys.map((k, i) => ({ k, i }));
      inputs++;
      if (n >= 64) merged++;
      [...els].sort((a, b) => {
        calls++;
        if (a.i < b.i) askedEarlierFirst++;
        return byKey(a, b);
      });
      const want = orderOf(els, byKey);
      // a positive answer read as 0, and a 0 read as positive: neither moves anything
      for (const signOnly of [(a: El, b: El) => (byKey(a, b) < 0 ? -1 : 0), (a: El, b: El) => (byKey(a, b) < 0 ? -1 : 1)]) {
        signOnlyChecks++;
        if (orderOf(els, signOnly) !== want) signOnlyDiffer++;
      }
      // the control: a comparator that answers negative where the true one answers 0 DOES move elements
      if (orderOf(els, (a, b) => (byKey(a, b) <= 0 ? -1 : 1)) !== want) controlDiffer++;
    }
    expect(askedEarlierFirst, "the comparator is never asked (earlier, later)").toBe(0);
    expect(signOnlyDiffer, "only the negative answers move elements").toBe(0);
    expect(inputs, "anti-vacuity: inputs sorted").toBe(3000);
    expect(merged, "anti-vacuity: inputs long enough to merge runs").toBeGreaterThanOrEqual(500);
    expect(calls, "anti-vacuity: comparator calls checked").toBeGreaterThan(100_000);
    expect(signOnlyChecks).toBe(2 * inputs);
    expect(controlDiffer, "the control: a comparator wrong on a negative answer is seen").toBeGreaterThan(inputs / 2);
  });

  it("no sport declares a metric keyed 'undefined' — metricOf's `key === undefined` arm (stryker-equivalent.json, tiebreakers.ts:331) reads the same as row.metrics[undefined] only while none does (every sport, counted)", () => {
    let metrics = 0;
    const visited = forEachSport(({ module }) => {
      for (const metric of module.metrics) {
        metrics++;
        expect(metric.key, module.key).not.toBe("undefined");
      }
    });
    expect(visited).toBe(builtinModules.length);
    expect(metrics, "anti-vacuity: metrics checked").toBeGreaterThan(builtinModules.length);
  });
});
