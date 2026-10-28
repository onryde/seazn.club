// W2e Task 17 (A2) - the proving tests for carrom.md's W2e rows: CA-VR-1 (the club-29 variant), CA-DG-1 (drawn games) and CA-RO-1
// (record-only toss and break). Every describe/it title carries its row id as a whole token (packages/engine/test/rules-reference.ts
// reads them).
//
// Expected values come from the rows' own text and the ICF Laws they cite, written into each test as literals - never from the code under
// test. CA-VR-1: game to 29, queen worth 5, no queen bonus once the winner's pre-board score has reached 24 (mastersofgames.com
// "Rules of Carrom": "if the winner's score has reached 24 or more points, then 5 bonus points are NOT added for covering the Queen").
// CA-DG-1: the default plays on with extra boards (ICF Law 56b); the tieBoard "draw" house rule closes a level game as a drawn game.
//
// CA-DG-1 and CA-RO-1 are `deviation` rows: CA-DG-1 because the house rule departs from ICF Law 56b; CA-RO-1 because the toss and the
// break are record-only. The tests that pin them are titled "house rule" / "record-only".
//
// Every fold is PAD-SHAPED (`strictFromSeq: 0`): the write path.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair } from "../../core/types.ts";
import { declaredCfgs } from "../../testkit/declared-cfgs.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { carrom, type CarromCfg, type CarromState } from "./carrom.ts";

const STRICT = { strictFromSeq: 0 } as const;
const lineups: LineupPair = defaultLineupPair(carrom.positions);
const H = lineups.home.entrantId;
const A = lineups.away.entrantId;

const cfgOf = (raw: unknown = {}): CarromCfg => carrom.configSchema.parse(raw);

type Spec = [type: string, payload?: unknown];
const stream = (...specs: Spec[]): EventEnvelope[] => specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
const fold = (cfg: CarromCfg, ...specs: Spec[]): CarromState => foldMatch(carrom, cfg, lineups, stream(...specs), STRICT);
const start: Spec = ["core.start"];

/** One board: the winner and the coins the opponent is left with (the winner's coin points), plus the queen coverer. */
const board = (winner: string, coins: number, queenTo: string | null = null, extra: Record<string, unknown> = {}): Spec => [
  "carrom.board.summary",
  { winner, opponentCoinsLeft: coins, queenTo, ...extra },
];

/** Coin-only boards that bank exactly `points` for `side` (nine coins a board at most), none of them a queen board. */
function reach(side: string, points: number): Spec[] {
  const out: Spec[] = [];
  let left = points;
  while (left > 0) {
    const coins = Math.min(9, left);
    out.push(board(side, coins));
    left -= coins;
  }
  return out;
}

/** The code of the EngineError a fold throws, or null when it folds. */
function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof EngineError) return error.code;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// CA-VR-1 (P8) - the club-29 variant: 29 points, queen 5, queen bonus lost at 24
// ---------------------------------------------------------------------------------------------------------------------

describe("CA-VR-1 the club-29 variant plays each game to 29 with the queen worth 5, and the queen bonus is lost once the winner has reached 24", () => {
  const club = cfgOf(carrom.variants["club-29"]);
  const icf = cfgOf(carrom.variants.icf);

  it("CA-VR-1 declares game to 29, queen 5 and cap 24, and changes nothing else from the ICF default", () => {
    expect(carrom.variants["club-29"]).toEqual({ gameTo: 29, queenPoints: 5, queenCapAt: 24 });
    expect(club.gameTo).toBe(29);
    expect(club.queenPoints).toBe(5);
    expect(club.queenCapAt).toBe(24);
    // Everything the variant does not name is the ICF default (Laws 52 to 57).
    expect({ ...club, gameTo: icf.gameTo, queenPoints: icf.queenPoints, queenCapAt: icf.queenCapAt }).toEqual(icf);
    // The contrast that gives the three numbers a meaning: the ICF default is 25, 3 and 22.
    expect([icf.gameTo, icf.queenPoints, icf.queenCapAt]).toEqual([25, 3, 22]);
  });

  it("CA-VR-1 a game is still open at 27 and 28 and closes at exactly 29, where the ICF default closes at 25", () => {
    // Three boards of nine coins are 27: the ICF default closed the game at 25, club-29 plays on.
    const at27 = fold(club, start, ...reach(H, 27));
    expect(at27.games[0]?.score).toEqual({ home: 27, away: 0 });
    expect(at27.games[0]?.winner).toBeNull();
    const at28 = fold(club, start, ...reach(H, 28));
    expect(at28.games[0]?.score).toEqual({ home: 28, away: 0 });
    expect(at28.games[0]?.winner).toBeNull();
    const at29 = fold(club, start, ...reach(H, 29));
    expect(at29.games[0]?.winner).toBe("home");
    expect(at29.gamesWon).toEqual({ home: 1, away: 0 });
    // The same boards close the ICF game at 25: the variant is what moved the target.
    expect(fold(icf, start, ...reach(H, 27)).games[0]?.winner).toBe("home");
    expect(fold(icf, start, ...reach(H, 25)).games[0]?.winner).toBe("home");
    expect(fold(icf, start, ...reach(H, 24)).games[0]?.winner).toBeNull();
  });

  it("CA-VR-1 the queen is worth 5 on top of the coins, where the ICF default pays 3", () => {
    const clubBoard = fold(club, start, board(H, 2, H)).games[0]?.boards[0];
    expect(clubBoard).toMatchObject({ points: 2 + 5, queenScored: true });
    const icfBoard = fold(icf, start, board(H, 2, H)).games[0]?.boards[0];
    expect(icfBoard).toMatchObject({ points: 2 + 3, queenScored: true });
  });

  it("CA-VR-1 the queen bonus is paid while the winner's score before the board is below 24 and lost from 24 on", () => {
    // [score before the board, queen bonus paid]. The row: lost once the winner has reached 24.
    const cases: Array<[number, boolean]> = [[0, true], [12, true], [22, true], [23, true], [24, false], [25, false], [26, false]];
    let checked = 0;
    let paid = 0;
    for (const [before, bonus] of cases) {
      const state = fold(club, start, ...reach(H, before), board(H, 1, H));
      const last = state.games[0]?.boards.at(-1);
      expect(last?.queenScored, `queen at ${before}`).toBe(bonus);
      expect(last?.points, `board points at ${before}`).toBe(bonus ? 1 + 5 : 1);
      checked++;
      if (bonus) paid++;
    }
    expect(checked).toBe(cases.length);
    expect(paid).toBeGreaterThan(0);
    expect(paid).toBeLessThan(cases.length);
    // 23 + 1 coin + queen 5 is 29: the paid bonus is what wins the game; at 24 the same board banks 1 and the game is open.
    expect(fold(club, start, ...reach(H, 23), board(H, 1, H)).games[0]?.winner).toBe("home");
    expect(fold(club, start, ...reach(H, 24), board(H, 1, H)).games[0]?.winner).toBeNull();
  });

  it("CA-VR-1 the cap is the winner's own score, per game and per side", () => {
    // The away side takes the queen at nought while home is already past the cap: the cap is not the leader's.
    const away = fold(club, start, ...reach(H, 26), board(A, 1, A));
    expect(away.games[0]?.boards.at(-1)).toMatchObject({ winner: "away", queenScored: true, points: 1 + 5 });
    // A new game starts at nought again: the queen counts in game 2 after home closed game 1 on 29.
    const second = fold(club, start, ...reach(H, 29), board(H, 1, H));
    expect(second.games[0]?.winner).toBe("home");
    expect(second.games[1]?.boards[0]).toMatchObject({ queenScored: true, points: 1 + 5 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// CA-DG-1 (P9) - a drawn game under the tieBoard "draw" house rule
// ---------------------------------------------------------------------------------------------------------------------

describe("CA-DG-1 under the tieBoard draw house rule a game level after its last board is drawn, and a match is decided by games won", () => {
  const drawCfg = (extra: Record<string, unknown> = {}): CarromCfg => cfgOf({ tieBoard: "draw", ...extra });
  const icf = cfgOf();

  /** A game level after its eight boards: four boards each, three coins a board (12 to 12). */
  const level = (): Spec[] => Array.from({ length: 8 }, (_, i) => board(i % 2 === 0 ? H : A, 3));
  /** A game `side` wins outright: three boards of nine coins (27 at the ICF target of 25). */
  const won = (side: string): Spec[] => [board(side, 9), board(side, 9), board(side, 9)];

  it("CA-DG-1 house rule: a game level after maxBoards closes drawn, where ICF Law 56b plays an extra board", () => {
    expect(drawCfg().maxBoards).toBe(8);
    const drawn = fold(drawCfg(), start, ...level());
    expect(drawn.games[0]?.score).toEqual({ home: 12, away: 12 });
    expect(drawn.games[0]?.winner).toBe("draw");
    expect(drawn.gamesDrawn).toBe(1);
    // A drawn game counts for neither side.
    expect(drawn.gamesWon).toEqual({ home: 0, away: 0 });
    // The match goes on to a second game.
    expect(drawn.games.length).toBe(2);
    expect(drawn.outcome).toBeNull();
    // The default (extra) leaves the same game open: the 8 boards are level and play continues.
    const extra = fold(icf, start, ...level());
    expect(extra.games[0]?.winner).toBeNull();
    expect(extra.gamesDrawn).toBe(0);
    expect(extra.games.length).toBe(1);
    // ...and a ninth board decides it (Law 56b).
    const decided = fold(icf, start, ...level(), board(H, 1));
    expect(decided.games[0]?.winner).toBe("home");
  });

  it("CA-DG-1 house rule: a leader after maxBoards still wins the game, and a game is not drawn before its last board", () => {
    // Law 56a: the leader after the last board wins - the draw is only for a level game.
    const lead: Spec[] = [board(H, 4), ...Array.from({ length: 7 }, (_, i) => board(i % 2 === 0 ? A : H, 3))];
    const led = fold(drawCfg(), start, ...lead);
    expect(led.games[0]?.score.home).toBeGreaterThan(led.games[0]?.score.away ?? 0);
    expect(led.games[0]?.winner).toBe("home");
    expect(led.gamesDrawn).toBe(0);
    // Seven level boards are not yet a drawn game.
    const seven = fold(drawCfg(), start, ...level().slice(0, 7));
    expect(seven.games[0]?.winner).toBeNull();
    expect(seven.gamesDrawn).toBe(0);
  });

  it("CA-DG-1 a match is decided by games won: a drawn game is no win for either side", () => {
    // [description, the games in order, the match: winner entrant or "draw", games won, games drawn]
    type Game = "draw" | "H" | "A";
    const cases: Array<[Game[], string | "draw", { home: number; away: number }, number]> = [
      [["draw", "H", "H"], H, { home: 2, away: 0 }, 1],
      [["H", "draw", "H"], H, { home: 2, away: 0 }, 1],
      [["draw", "H", "A"], "draw", { home: 1, away: 1 }, 1],
      [["draw", "draw", "H"], H, { home: 1, away: 0 }, 2],
      [["draw", "draw", "A"], A, { home: 0, away: 1 }, 2],
      [["draw", "draw", "draw"], "draw", { home: 0, away: 0 }, 3],
    ];
    let checked = 0;
    for (const [games, expected, gamesWon, gamesDrawn] of cases) {
      const specs: Spec[] = games.flatMap((g) => (g === "draw" ? level() : won(g === "H" ? H : A)));
      const state = fold(drawCfg(), start, ...specs);
      const outcome = carrom.outcome(state);
      const label = games.join(",");
      if (expected === "draw") expect(outcome, label).toEqual({ kind: "draw" });
      else expect(outcome, label).toMatchObject({ kind: "win", winner: expected, method: "regulation" });
      expect(state.gamesWon, label).toEqual(gamesWon);
      expect(state.gamesDrawn, label).toBe(gamesDrawn);
      checked++;
    }
    expect(checked).toBe(cases.length);
  });

  it("CA-DG-1 a drawn game uses up one of the bestOf games and does not decide the match early", () => {
    // After a drawn game and a home win the match is NOT decided (two game wins are needed, or all three games played).
    const afterTwo = fold(drawCfg(), start, ...level(), ...won(H));
    expect(afterTwo.outcome).toBeNull();
    expect(afterTwo.games.length).toBe(3);
    // bestOf 1: the one game is drawn, and the match is drawn.
    const single = fold(drawCfg({ bestOf: 1 }), start, ...level());
    expect(carrom.outcome(single)).toEqual({ kind: "draw" });
    // bestOf 5: the match is decided by comparison once all five games are played.
    const five = fold(drawCfg({ bestOf: 5 }), start, ...level(), ...won(H), ...won(A), ...level());
    expect(five.outcome).toBeNull();
    const fifth = fold(drawCfg({ bestOf: 5 }), start, ...level(), ...won(H), ...won(A), ...level(), ...won(H));
    expect(carrom.outcome(fifth)).toMatchObject({ kind: "win", winner: H });
    expect(fifth.gamesWon).toEqual({ home: 2, away: 1 });
  });

  it("CA-DG-1 only the draw option makes a table match drawable, and standings pay the drawn match the draw points", () => {
    expect(carrom.supportsDraws(drawCfg(), "league")).toBe(true);
    expect(carrom.supportsDraws(icf, "league")).toBe(false);
    const state = fold(drawCfg(), start, ...level(), ...won(H), ...won(A));
    const outcome = carrom.outcome(state);
    expect(outcome).toEqual({ kind: "draw" });
    const [home, away] = carrom.standingsDelta(outcome as never, drawCfg(), { kind: "league" }, state);
    // The cfg's own competition points for a draw (ICF match points: win 2, draw 1, loss 0).
    expect([home.drawn, away.drawn, home.points, away.points]).toEqual([1, 1, 1, 1]);
    // The drawn game is nobody's game win in the ledger either.
    expect(home.metrics).toMatchObject({ sets_won: 1, sets_lost: 1 });
    expect(away.metrics).toMatchObject({ sets_won: 1, sets_lost: 1 });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// CA-RO-1 (M19) - record-only: the toss and the first break
// ---------------------------------------------------------------------------------------------------------------------

describe("CA-RO-1 record-only: the toss and the first break are recorded and move no score and no result", () => {
  // One full match played the same way under every toss: home wins game 1 on 27, away wins game 2 on 27, home wins game 3.
  const played: Spec[] = [
    start,
    board(H, 9, null, { breaker: "H-p1" }),
    board(H, 9, null, { breaker: "H-p2" }),
    board(H, 9),
    board(A, 9),
    board(A, 9),
    board(A, 9),
    board(H, 9),
    board(H, 9),
    board(H, 9),
  ];

  const tossed = (firstBreak: string | null): CarromState => fold(cfgOf(), ...(firstBreak === null ? [] : [["carrom.toss", { firstBreak }] as Spec]), ...played);

  it("CA-RO-1 record-only: the toss winner's first break is recorded, and the break alternates from it", () => {
    const home = tossed(H);
    const away = tossed(A);
    expect(home.firstBreak).toBe("home");
    expect(away.firstBreak).toBe("away");
    expect(home.games[0]?.boards.map((b) => b.breaker)).toEqual(["home", "away", "home"]);
    expect(away.games[0]?.boards.map((b) => b.breaker)).toEqual(["away", "home", "away"]);
    // The breaker person a scorer names rides on the board as a record.
    expect(home.games[0]?.boards[0]?.breakerPerson).toBe("H-p1");
    expect(home.games[0]?.boards[1]?.breakerPerson).toBe("H-p2");
    expect(home.games[0]?.boards[2]?.breakerPerson).toBeUndefined();
    // No toss: home breaks first (the engine's default), which is still only a record.
    expect(tossed(null).firstBreak).toBe("home");
  });

  it("CA-RO-1 record-only: the same boards give the same scores, games, outcome and summary whoever won the toss", () => {
    const control = tossed(null);
    expect(carrom.outcome(control)).toMatchObject({ kind: "win", winner: H });
    const scoresOf = (state: CarromState) => state.games.map((g) => ({ score: g.score, winner: g.winner, points: g.boards.map((b) => b.points) }));
    let checked = 0;
    for (const firstBreak of [H, A]) {
      const state = tossed(firstBreak);
      expect(scoresOf(state), firstBreak).toEqual(scoresOf(control));
      expect(state.gamesWon, firstBreak).toEqual(control.gamesWon);
      expect(carrom.outcome(state), firstBreak).toEqual(carrom.outcome(control));
      expect(carrom.summary(state).headline, firstBreak).toBe(carrom.summary(control).headline);
      const delta = carrom.standingsDelta(carrom.outcome(state) as never, cfgOf(), { kind: "league" }, state);
      const controlDelta = carrom.standingsDelta(carrom.outcome(control) as never, cfgOf(), { kind: "league" }, control);
      expect(delta, firstBreak).toEqual(controlDelta);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("CA-RO-1 record-only: the toss is taken once and before the start, and is refused otherwise", () => {
    expect(codeOf(() => fold(cfgOf(), start, ["carrom.toss", { firstBreak: H }]))).toBe("WRONG_PHASE");
    expect(codeOf(() => fold(cfgOf(), ["carrom.toss", { firstBreak: H }], ["carrom.toss", { firstBreak: A }]))).toBe("INVALID_EVENT");
    // The positive pair: one toss before the start folds.
    expect(codeOf(() => fold(cfgOf(), ["carrom.toss", { firstBreak: H }], start))).toBeNull();
  });

  it("CA-RO-1 record-only: the variants sweep - the toss moves no score under any declared config", () => {
    const cfgs = declaredCfgs<CarromCfg>(carrom);
    let checked = 0;
    for (const { name, cfg } of cfgs) {
      // Four boards of nine coins are 36: past every declared game target, so home wins game 1 under each config.
      const boards = Array.from({ length: 4 }, () => board(H, 9));
      const withToss = fold(cfg, ["carrom.toss", { firstBreak: A }], start, ...boards);
      const without = fold(cfg, start, ...boards);
      expect(withToss.games.map((g) => g.score), name).toEqual(without.games.map((g) => g.score));
      expect(withToss.gamesWon, name).toEqual(without.gamesWon);
      checked++;
    }
    expect(checked).toBe(cfgs.length);
    expect(checked).toBeGreaterThan(1);
  });
});
