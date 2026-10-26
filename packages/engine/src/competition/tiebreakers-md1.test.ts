// W2d Task 20 (MD-1, spec §14: W2d owns every survivor in competition/tiebreakers.ts): the tests that kill what
// Stryker left alive there. The mutants recorded as equivalent are in stryker-equivalent.json, each with its proof.
//
// Expected values are computed by hand from the rule each block cites — FIDE Handbook C.07 (Buchholz, Cut-1,
// Sonneborn-Berger, the virtual opponent of an unplayed game), spec 05 §4.2 (direct encounter), spec 05 §4.3 (a ratio
// is compared by cross-multiplication; 0/0 is 0, "no data"), the ICC net run rate (runs for per over faced minus runs
// against per over bowled, spec 04 §5) — and from the engine's own declarations (`SwissGame`, `RATIO_LEDGERS`). Never
// from rankStandings or the Swiss readers under test.
//
// Every table here is hand-built; the one sport read is the whole registry, swept (R26).
import { describe, expect, it } from "vitest";
import type { StandingsDelta } from "../core/types.ts";
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

describe("W2d T20 MD-1 — FIDE C.07 virtual opponent: every unplayed game, however written", () => {
  // X: R1 beat Y; R2 a game X did not play; R3 beat Z — 3 rounds. C.07: the unplayed game is scored against a virtual
  // opponent holding X's score before that round (2 half-points) plus ½ point for each round from it to the end (R2,
  // R3: 2 half-points) = 4. Y holds 3, Z 1: Buchholz(X) = 3 + 4 + 1 = 8.
  const withRound2 = (game: SwissTable[number]["games"][number]): SwissTable => [
    { entrant: "X", score: 6, games: [{ opponent: "Y", result: "win", scored: 2 }, game, { opponent: "Z", result: "win", scored: 2 }] },
    { entrant: "Y", score: 3, games: [] },
    { entrant: "Z", score: 1, games: [] },
    { entrant: "V", score: 0, games: [{ opponent: "X", result: "loss", scored: 0, unplayed: true }] },
  ];

  it("a FORFEIT against a real opponent (unplayed, opponent named) is scored against the virtual opponent, not the absentee's score", () => {
    // V did not show in R2: the game is unplayed though V exists (SwissGame: "unplayed games (byes, forfeits,
    // absences) use a FIDE virtual opponent"). V's real score (0) would make it 3 + 0 + 1 = 4.
    expect(buchholz(withRound2({ opponent: "V", result: "win", scored: 2, unplayed: true }), "X")).toBe(8);
  });

  it("a BYE written without the unplayed flag (opponent null: 'null for a bye') is still the virtual opponent", () => {
    expect(buchholz(withRound2({ opponent: null, result: "win", scored: 2 }), "X")).toBe(8);
    // the positive pair: the flagged bye, as buildSwissTable writes it
    expect(buchholz(withRound2({ opponent: null, result: "win", scored: 2, unplayed: true }), "X")).toBe(8);
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
