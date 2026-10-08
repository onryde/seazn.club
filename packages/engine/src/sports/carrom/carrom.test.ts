// Carrom goldens + conformance — engine/sports/carrom.md, PROMPT-16.
// ICF law citations (Laws 49, 52–57) refer to the ICF "Laws of Carrom";
// carrom.md §1–7 carries the verified text.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, SETTLE_METHODS, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair, StageCtx } from "../../core/types.ts";
import {
  aggregatePlayerStats,
  playerStatsKeyCollisions,
  type PlayerStatsFoldCtx,
} from "../../stats/stats.ts";
import { conformanceSuite, defaultLineupPair, makeEnvelope } from "../../testkit/index.ts";
import { checkActionCoverage, padItemLabelKey, padSpecConformanceSuite } from "../../testkit/conformance-pad.ts";
import {
  carrom,
  CARROM_EVENT_SCHEMAS,
  CARROM_TIEBREAKERS,
  padSpec,
  type CarromState,
} from "./carrom.ts";

// W4a (#425) §3.3 — every fold below is PAD-SHAPED: it is building a stream
// event by event, which is the write path. `strictFromSeq: 0` marks the whole
// stream new and is therefore exactly the pre-seam behaviour. Only a real READ
// path (apps/web fold.ts) and the cfg-replay property pass no options.
const STRICT_ALL = { strictFromSeq: 0 } as const;

const lineups: LineupPair = defaultLineupPair(carrom.positions); // entrants H / A
const cfg = carrom.configSchema.parse({});
const league: StageCtx = { kind: "league" };

function stream(...specs: Array<[type: string, payload?: unknown]>): EventEnvelope[] {
  return specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
}
function fold(events: EventEnvelope[], config = cfg): CarromState {
  return foldMatch(carrom, config, lineups, events, STRICT_ALL);
}

// One board-summary spec: [winner, opponentCoinsLeft, queenTo].
type BoardSpec = [winner: string, coins: number, queenTo?: string | null];
function boards(...specs: BoardSpec[]): Array<[string, unknown]> {
  return specs.map(([winner, opponentCoinsLeft, queenTo]) => [
    "carrom.board.summary",
    { winner, opponentCoinsLeft, queenTo: queenTo ?? null },
  ]);
}

// ---------------------------------------------------------------------------
// Golden (a) — game won exactly at 25 via the queen bonus (Laws 52–54, 56a).
// ---------------------------------------------------------------------------
describe("carrom golden: game won exactly at 25 via queen bonus", () => {
  const state = fold(
    stream(["core.start"], ...boards(["H", 9], ["H", 9], ["H", 2], ["H", 2, "H"])),
  );

  it("banks 20 + 2 coins + queen 3 = 25 and closes the game", () => {
    const game = state.games[0]!;
    expect(game.score).toEqual({ home: 25, away: 0 });
    expect(game.winner).toBe("home");
    expect(game.boards[3]).toMatchObject({ points: 5, queenScored: true });
    expect(state.gamesWon).toEqual({ home: 1, away: 0 });
    expect(state.outcome).toBeNull(); // best-of-3: match still live
    expect(carrom.summary(state).headline).toBe("1 — 0");
  });
});

// ---------------------------------------------------------------------------
// Golden (b) — the queenCapAt boundary (Law 52(b)(i): 3 points up to and
// including 21; Law 54: no queen benefit once 22 is reached). The bonus is
// checked against the PRE-board score.
// ---------------------------------------------------------------------------
describe("carrom golden: queen cap boundary", () => {
  it("21 → queen still counts (21 + 1 coin + 3 = 25, game won)", () => {
    const state = fold(
      stream(["core.start"], ...boards(["H", 9], ["H", 9], ["H", 3], ["H", 1, "H"])),
    );
    const game = state.games[0]!;
    expect(game.score.home).toBe(25);
    expect(game.winner).toBe("home");
    expect(game.boards[3]).toMatchObject({ points: 4, queenScored: true });
  });

  it("22 → queen scores 0, coins only — the game continues", () => {
    const state = fold(
      stream(["core.start"], ...boards(["H", 9], ["H", 9], ["H", 4], ["H", 1, "H"])),
    );
    const game = state.games[0]!;
    expect(game.score.home).toBe(23); // 22 + 1 coin, no queen
    expect(game.winner).toBeNull();
    expect(game.boards[3]).toMatchObject({ points: 1, queenScored: false });
    expect(state.outcome).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Law 53(b)/(c) — a loser-covered queen scores for nobody under ICF; the
// queenFollowsBoard house rule credits the board winner instead.
// ---------------------------------------------------------------------------
describe("carrom: loser-covered queen (Law 53)", () => {
  const events = stream(["core.start"], ...boards(["H", 5, "A"]));

  it("ICF default: winner gets coins only", () => {
    const state = fold(events);
    expect(state.games[0]!.score.home).toBe(5);
    expect(state.games[0]!.boards[0]).toMatchObject({ points: 5, queenScored: false });
  });

  it("queenFollowsBoard: true credits the queen to the board winner", () => {
    const state = fold(events, carrom.configSchema.parse({ queenFollowsBoard: true }));
    expect(state.games[0]!.score.home).toBe(8);
    expect(state.games[0]!.boards[0]).toMatchObject({ points: 8, queenScored: true });
  });
});

// ---------------------------------------------------------------------------
// Golden (c) — 8-board game decided on points (Law 56a: leader after the
// eighth board wins).
// ---------------------------------------------------------------------------
describe("carrom golden: 8-board game decided on points", () => {
  const eight: BoardSpec[] = [
    ["H", 3], ["A", 2], ["H", 3], ["A", 2],
    ["H", 3], ["A", 2], ["H", 3], ["A", 2],
  ];
  const state = fold(stream(["core.start"], ...boards(...eight)));

  it("closes the game for the leader 12–8 after board 8", () => {
    const game = state.games[0]!;
    expect(game.boards).toHaveLength(8);
    expect(game.score).toEqual({ home: 12, away: 8 });
    expect(game.winner).toBe("home");
    expect(state.gamesWon).toEqual({ home: 1, away: 0 });
  });
});

// ---------------------------------------------------------------------------
// Golden (d) — best-of-3 with a tie-board. ICF (Law 56b): an extra sudden-
// death board; house rule 'draw': the game is drawn and a drawn match is
// possible.
// ---------------------------------------------------------------------------
describe("carrom golden: best-of-3 with a tie-board", () => {
  const tiedEight: BoardSpec[] = [
    ["H", 3], ["A", 3], ["H", 3], ["A", 3],
    ["H", 3], ["A", 3], ["H", 3], ["A", 3],
  ];

  it("ICF 'extra': 12–12 after 8 boards → a ninth board decides (Law 56b)", () => {
    const open = fold(stream(["core.start"], ...boards(...tiedEight)));
    expect(open.games[0]!.winner).toBeNull(); // still open past maxBoards
    const state = fold(stream(["core.start"], ...boards(...tiedEight, ["A", 2])));
    const game = state.games[0]!;
    expect(game.boards).toHaveLength(9);
    expect(game.winner).toBe("away");
    expect(game.score).toEqual({ home: 12, away: 14 });
  });

  it("'draw' policy: the game is drawn; 1-1 plus a drawn game → drawn match", () => {
    const drawCfg = carrom.configSchema.parse({ tieBoard: "draw" });
    const game2: BoardSpec[] = [["H", 9], ["H", 9], ["H", 9]]; // 27 ≥ 25
    const game3: BoardSpec[] = [["A", 9], ["A", 9], ["A", 9]];
    const state = fold(
      stream(["core.start"], ...boards(...tiedEight, ...game2, ...game3)),
      drawCfg,
    );
    expect(state.games[0]!.winner).toBe("draw");
    expect(state.gamesDrawn).toBe(1);
    expect(state.gamesWon).toEqual({ home: 1, away: 1 });
    expect(state.outcome).toEqual({ kind: "draw" });
    const [home, away] = carrom.standingsDelta(state.outcome!, drawCfg, league, state);
    expect([home.points, away.points]).toEqual([1, 1]);
    expect(home).toMatchObject({ drawn: 1, metrics: { sets_won: 1, sets_lost: 1 } });
  });
});

// ---------------------------------------------------------------------------
// Golden (e) — walkover: award outcome, completed games stand in the ledger.
// ---------------------------------------------------------------------------
describe("carrom golden: walkover", () => {
  const state = fold(
    stream(["core.start"], ...boards(["H", 5, "H"]), [
      "core.forfeit",
      { by: "A", reason: "no-show" },
    ]),
  );

  it("awards the match to the opponent", () => {
    // `method` is the forfeit's own `reason`, carried verbatim — the field
    // that lets a reader tell this walkover from a disqualification.
    expect(state.outcome).toEqual({ kind: "award", winner: "H", method: "no-show" });
  });

  it("pays win/loss points; the ledger keeps only what was played", () => {
    const [home, away] = carrom.standingsDelta(state.outcome!, cfg, league, state);
    expect(home).toMatchObject({ won: 1, points: 2 });
    expect(away).toMatchObject({ lost: 1, points: 0 });
    expect(home.metrics).toMatchObject({ boards_won: 1, points_won: 8, sets_won: 0 });
    expect(home.points + away.points).toBe(2); // inside declaredPointsSets
  });
});

// ---------------------------------------------------------------------------
// Abandonment — PROMPT-16 §4: no_result, completed games recorded.
// ---------------------------------------------------------------------------
describe("carrom: abandonment → no_result", () => {
  const game1: BoardSpec[] = [["H", 9], ["H", 9], ["H", 9]]; // H takes game 1
  const state = fold(
    stream(["core.start"], ...boards(...game1, ["A", 4]), [
      "core.abandon",
      { reason: "venue flooded" },
    ]),
  );

  it("records no_result with the completed game in the ledger", () => {
    expect(state.outcome).toEqual({ kind: "no_result" });
    expect(state.gamesWon).toEqual({ home: 1, away: 0 });
    const [home, away] = carrom.standingsDelta(state.outcome!, cfg, league, state);
    expect([home.points, away.points]).toEqual([1, 1]); // shared draw points
    expect(home.metrics).toMatchObject({ sets_won: 1, boards_won: 3, boards_lost: 1 });
    expect(away.metrics).toMatchObject({ sets_won: 0, boards_won: 1 });
  });
});

// ---------------------------------------------------------------------------
// Break alternation — Law 49(a): alternates each board; each game's first
// break alternates between the players; the toss sets game 1.
// ---------------------------------------------------------------------------
describe("carrom: break alternation (Law 49)", () => {
  it("toss winner breaks board 1; alternation runs across boards and games", () => {
    const game1: BoardSpec[] = [["A", 9], ["A", 9], ["A", 9]]; // A takes game 1
    const state = fold(
      stream(
        ["carrom.toss", { firstBreak: "A" }],
        ["core.start"],
        ...boards(...game1, ["H", 2]),
      ),
    );
    const breakers = state.games[0]!.boards.map((board) => board.breaker);
    expect(breakers).toEqual(["away", "home", "away"]); // game 1 alternates from A
    expect(state.games[1]!.boards[0]!.breaker).toBe("home"); // game 2 opens with H
  });

  it("rejects a toss after core.start or a second toss", () => {
    expect(() =>
      fold(stream(["core.start"], ["carrom.toss", { firstBreak: "A" }])),
    ).toThrow(EngineError);
    expect(() =>
      fold(
        stream(["carrom.toss", { firstBreak: "A" }], ["carrom.toss", { firstBreak: "H" }]),
      ),
    ).toThrow(EngineError);
  });
});

// ---------------------------------------------------------------------------
// Umpire adjustments + reserved strike fidelity.
// ---------------------------------------------------------------------------
describe("carrom: game.adjust and reserved strike events", () => {
  it("applies a penalty delta and can decide the game", () => {
    const state = fold(
      stream(["core.start"], ...boards(["H", 9], ["H", 9], ["H", 6]), [
        "carrom.game.adjust",
        { entrantId: "H", delta: 1, reason: "opponent foul" },
      ]),
    );
    expect(state.games[0]!.score.home).toBe(25);
    expect(state.games[0]!.winner).toBe("home");
  });

  it("rejects an adjustment below zero and a zero delta", () => {
    expect(() =>
      fold(
        stream(["core.start"], [
          "carrom.game.adjust",
          { entrantId: "H", delta: -1, reason: "foul" },
        ]),
      ),
    ).toThrow(EngineError);
    expect(() =>
      fold(
        stream(["core.start"], [
          "carrom.game.adjust",
          { entrantId: "H", delta: 0, reason: "foul" },
        ]),
      ),
    ).toThrow(EngineError);
  });

  it("rejects the reserved carrom.strike event", () => {
    expect(() =>
      fold(stream(["core.start"], ["carrom.strike", { striker: "H", pocketed: ["white"] }])),
    ).toThrow(/reserved/);
  });
});

// ---------------------------------------------------------------------------
// Validation edges.
// ---------------------------------------------------------------------------
describe("carrom: board validation", () => {
  it("rejects opponentCoinsLeft outside 0..9 and unknown entrants", () => {
    expect(() => fold(stream(["core.start"], ...boards(["H", 10])))).toThrow(EngineError);
    expect(() => fold(stream(["core.start"], ...boards(["X", 5])))).toThrow(EngineError);
    expect(() =>
      fold(stream(["core.start"], [
        "carrom.board.summary",
        { winner: "H", opponentCoinsLeft: 5, queenTo: "X" },
      ])),
    ).toThrow(EngineError);
  });

  it("declares the house-standard cascade (carrom.md §4)", () => {
    expect(carrom.defaultTiebreakers).toEqual(CARROM_TIEBREAKERS);
    expect(CARROM_TIEBREAKERS).toEqual([
      "points",
      "wins",
      "set_ratio",
      "board_ratio",
      "point_ratio",
      "h2h_points",
      "lots",
    ]);
  });
});

// ---------------------------------------------------------------------------
// W4 domain audit — person attribution. The ICF scoresheet books points to a
// SIDE, but Laws 49 (break rotation) and 53 (the queen is pocketed AND covered
// by a player) and 51/55 (a player commits the foul) are individual acts, and
// in doubles the entrant is a pair, so the side alone loses the actor.
// ---------------------------------------------------------------------------
describe("carrom: who struck (Laws 49, 51, 53)", () => {
  it("records the player who broke the board and the player who covered the queen", () => {
    const state = fold(
      stream(["core.start"], [
        "carrom.board.summary",
        { winner: "H", opponentCoinsLeft: 5, queenTo: "H", breaker: "H-p2", queenBy: "H-p1" },
      ]),
    );
    const board = state.games[0]!.boards[0]!;
    expect(board).toMatchObject({ breakerPerson: "H-p2", queenPerson: "H-p1", queenScored: true });
    const detail = carrom.summary(state).detail as {
      games: { boards: { breakerPerson?: string; queenPerson?: string }[] }[];
    };
    expect(detail.games[0]!.boards[0]).toMatchObject({
      breakerPerson: "H-p2",
      queenPerson: "H-p1",
    });
  });

  it("rejects a queen credited to a player when no side covered the queen", () => {
    expect(() =>
      fold(
        stream(["core.start"], [
          "carrom.board.summary",
          { winner: "H", opponentCoinsLeft: 5, queenTo: null, queenBy: "H-p1" },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("records the player an umpire adjustment concerns", () => {
    const state = fold(
      stream(["core.start"], [
        "carrom.game.adjust",
        { entrantId: "H", delta: 3, reason: "opponent foul", person: "A-p1" },
      ]),
    );
    expect(state.penalties).toEqual([{ person: "A-p1", side: "home", delta: 3 }]);
    expect(carrom.summary(state).detail).toMatchObject({
      penalties: [{ person: "A-p1", side: "home", delta: 3 }],
    });
  });

  it("folds person credit into a breaks/queens/penalties leaderboard", () => {
    const events = stream(
      ["core.start"],
      [
        "carrom.board.summary",
        { winner: "H", opponentCoinsLeft: 5, queenTo: "H", breaker: "H-p1", queenBy: "H-p1" },
      ],
      [
        "carrom.board.summary",
        { winner: "A", opponentCoinsLeft: 4, queenTo: null, breaker: "A-p1" },
      ],
      ["carrom.game.adjust", { entrantId: "A", delta: 1, reason: "foul", person: "H-p1" }],
    );
    expect(aggregatePlayerStats(events, carrom.playerStats!)).toEqual([
      { personId: "A-p1", stats: { breaks: 1 } },
      { personId: "H-p1", stats: { breaks: 1, queens: 1, penalties: 1 } },
    ]);
  });
});

// S8/#417 — boards_won (per-board winner, plain entrant fallback) and the
// folded matches/wins (per-match attendance + outcome, resolved from a full
// board/game/adjustment replay). See carrom.ts's `foldCarromStats` for the
// mechanism.
describe("carrom: boards_won + folded matches/wins, resolved from entrant attribution (S8/#417)", () => {
  function ctxFor(
    entrants: ReadonlyArray<{
      id: string;
      kind?: "team" | "individual" | "pair";
      persons: readonly string[];
    }>,
    config?: unknown,
  ): PlayerStatsFoldCtx {
    return {
      entrants: entrants.map((e) => ({ id: e.id, kind: e.kind ?? "individual" })),
      personsOf: (entrantId) => entrants.find((e) => e.id === entrantId)?.persons ?? [],
      ...(config === undefined ? {} : { cfg: config }),
    };
  }
  const twoPlayers = ctxFor([
    { id: "H", persons: ["H-p1"] },
    { id: "A", persons: ["A-p1"] },
  ]);
  // A single board clinches both the game AND the match — keeps every fixture
  // below short while still exercising the real decideGame/bankGame cascade
  // (via foldMatch), never a shortcut around it. queenCapAt must not exceed
  // gameTo (Cfg's own refine), so it has to come down with it.
  const quickCfg = carrom.configSchema.parse({ gameTo: 5, queenCapAt: 5, bestOf: 1 });

  it("headline regression: entrant ids only (no person fields) + individual ctx resolve correct boards_won rows", () => {
    const events = stream(
      ["core.start"],
      ["carrom.board.summary", { winner: "H", opponentCoinsLeft: 3, queenTo: null }],
    );
    // `matches` fires too — it only needs a ctx, not a cfg (unlike `wins`) —
    // so the ledger naming H at all is enough to credit BOTH sides' attendance.
    expect(aggregatePlayerStats(events, carrom.playerStats!, undefined, twoPlayers)).toEqual([
      { personId: "A-p1", stats: { matches: 1 } },
      { personId: "H-p1", stats: { boards_won: 1, matches: 1 } },
    ]);
  });

  it("a PAIR entrant credits BOTH partners with boards_won", () => {
    const events = stream(
      ["core.start"],
      ["carrom.board.summary", { winner: "H", opponentCoinsLeft: 3, queenTo: null }],
    );
    const ctx = ctxFor([
      { id: "H", kind: "pair", persons: ["H-p1", "H-p2"] },
      { id: "A", kind: "pair", persons: ["A-p1", "A-p2"] },
    ]);
    expect(aggregatePlayerStats(events, carrom.playerStats!, undefined, ctx)).toEqual([
      { personId: "A-p1", stats: { matches: 1 } },
      { personId: "A-p2", stats: { matches: 1 } },
      { personId: "H-p1", stats: { boards_won: 1, matches: 1 } },
      { personId: "H-p2", stats: { boards_won: 1, matches: 1 } },
    ]);
  });

  it("a team entrant credits no boards_won, even with a full roster (its opponent's own boards_won is unaffected)", () => {
    const events = stream(
      ["core.start"],
      ["carrom.board.summary", { winner: "H", opponentCoinsLeft: 3, queenTo: null }],
    );
    const ctx = ctxFor([
      { id: "H", kind: "team", persons: ["H-p1", "H-p2"] },
      { id: "A", persons: ["A-p1"] },
    ]);
    const rows = aggregatePlayerStats(events, carrom.playerStats!, undefined, ctx);
    expect(rows.find((r) => r.personId === "H-p1" || r.personId === "H-p2")).toBeUndefined();
    expect(rows.find((r) => r.personId === "A-p1")?.stats.boards_won).toBeUndefined();
  });

  it("a decisive match credits the winner's roster wins:1, and the loser's roster wins:0 (explicit, not omitted)", () => {
    const ctx = ctxFor(
      [
        { id: "H", persons: ["H-p1"] },
        { id: "A", persons: ["A-p1"] },
      ],
      quickCfg,
    );
    const events = stream(
      ["core.start"],
      ["carrom.board.summary", { winner: "H", opponentCoinsLeft: 5, queenTo: null }],
    );
    expect(aggregatePlayerStats(events, carrom.playerStats!, undefined, ctx)).toEqual([
      { personId: "A-p1", stats: { matches: 1, wins: 0 } },
      { personId: "H-p1", stats: { boards_won: 1, matches: 1, wins: 1 } },
    ]);
  });

  it("a whitewash — the loser never individually named in any payload — still credits the loser's roster via ctx.entrants", () => {
    // A never appears anywhere in this payload (not `winner`, not `queenTo`):
    // the only evidence the match happened at all is H's board win.
    const ctx = ctxFor(
      [
        { id: "H", persons: ["H-p1"] },
        { id: "A", persons: ["A-p1"] },
      ],
      quickCfg,
    );
    const events = stream(
      ["core.start"],
      ["carrom.board.summary", { winner: "H", opponentCoinsLeft: 5, queenTo: null }],
    );
    const rows = aggregatePlayerStats(events, carrom.playerStats!, undefined, ctx);
    expect(rows.find((r) => r.personId === "A-p1")?.stats).toEqual({ matches: 1, wins: 0 });
  });

  it("a drawn game (tieBoard: draw) credits wins:0 to both sides — never a fabricated winner", () => {
    const drawCfg = carrom.configSchema.parse({ gameTo: 100, maxBoards: 1, bestOf: 1, tieBoard: "draw" });
    const ctx = ctxFor(
      [
        { id: "H", persons: ["H-p1"] },
        { id: "A", persons: ["A-p1"] },
      ],
      drawCfg,
    );
    // opponentCoinsLeft: 0 keeps the score 0-0, so `maxBoards` is reached with
    // no leader and `tieBoard: "draw"` closes the game (and hence the match,
    // bestOf: 1) as a draw rather than an extra sudden-death board.
    const events = stream(
      ["core.start"],
      ["carrom.board.summary", { winner: "H", opponentCoinsLeft: 0, queenTo: null }],
    );
    const rows = aggregatePlayerStats(events, carrom.playerStats!, undefined, ctx);
    expect(rows.find((r) => r.personId === "H-p1")?.stats.wins).toBe(0);
    expect(rows.find((r) => r.personId === "A-p1")?.stats.wins).toBe(0);
  });

  it("X-ST-1 (ruling D-C3): a SETTLED drawn match credits the settle's winner the win — never wins:0 for both", () => {
    const drawCfg = carrom.configSchema.parse({ gameTo: 100, maxBoards: 1, bestOf: 1, tieBoard: "draw" });
    const ctx = ctxFor(
      [
        { id: "H", persons: ["H-p1"] },
        { id: "A", persons: ["A-p1"] },
      ],
      drawCfg,
    );
    const drawn: Array<[type: string, payload?: unknown]> = [
      ["core.start"],
      ["carrom.board.summary", { winner: "H", opponentCoinsLeft: 0, queenTo: null }],
    ];
    // Positive pair first: unsettled, the drawn match credits nobody a win.
    const level = aggregatePlayerStats(stream(...drawn), carrom.playerStats!, undefined, ctx);
    expect([level.find((r) => r.personId === "H-p1")?.stats.wins, level.find((r) => r.personId === "A-p1")?.stats.wins]).toEqual([0, 0]);
    // Settled for the AWAY side (not home by default), whichever settle method closed it.
    for (const method of SETTLE_METHODS) {
      const rows = aggregatePlayerStats(stream(...drawn, ["core.settle", { winner: "A", method }]), carrom.playerStats!, undefined, ctx);
      expect([rows.find((r) => r.personId === "H-p1")?.stats.wins, rows.find((r) => r.personId === "A-p1")?.stats.wins], method).toEqual([0, 1]);
      expect(rows.find((r) => r.personId === "A-p1")?.stats.matches, method).toBe(1);
    }
  });

  it("a team entrant is credited no matches or wins either, in a mixed team/individual fixture", () => {
    const ctx = ctxFor(
      [
        { id: "H", kind: "team", persons: ["H-p1", "H-p2"] },
        { id: "A", persons: ["A-p1"] },
      ],
      quickCfg,
    );
    const events = stream(
      ["core.start"],
      ["carrom.board.summary", { winner: "H", opponentCoinsLeft: 5, queenTo: null }],
    );
    const rows = aggregatePlayerStats(events, carrom.playerStats!, undefined, ctx);
    expect(rows.find((r) => r.personId === "H-p1" || r.personId === "H-p2")).toBeUndefined();
    expect(rows.find((r) => r.personId === "A-p1")?.stats).toEqual({ matches: 1, wins: 0 });
  });

  it("a void over the decisive board un-counts matches, wins and boards_won", () => {
    const ctx = ctxFor(
      [
        { id: "H", persons: ["H-p1"] },
        { id: "A", persons: ["A-p1"] },
      ],
      quickCfg,
    );
    const decisive = stream(
      ["core.start"],
      ["carrom.board.summary", { winner: "H", opponentCoinsLeft: 5, queenTo: null }],
    );
    const clean = aggregatePlayerStats(decisive, carrom.playerStats!, undefined, ctx);
    expect(clean).toEqual([
      { personId: "A-p1", stats: { matches: 1, wins: 0 } },
      { personId: "H-p1", stats: { boards_won: 1, matches: 1, wins: 1 } },
    ]);
    const voided = [
      ...decisive,
      makeEnvelope(decisive.length, { type: "core.void", payload: {} }, decisive[1]!.id),
    ];
    expect(aggregatePlayerStats(voided, carrom.playerStats!, undefined, ctx)).toEqual([]);
  });

  it("is deterministic: the same stream + ctx folds twice to deeply equal rows", () => {
    const ctx = ctxFor(
      [
        { id: "H", persons: ["H-p1"] },
        { id: "A", persons: ["A-p1"] },
      ],
      quickCfg,
    );
    const events = stream(
      ["core.start"],
      ["carrom.board.summary", { winner: "H", opponentCoinsLeft: 5, queenTo: null }],
    );
    const once = aggregatePlayerStats(events, carrom.playerStats!, undefined, ctx);
    const twice = aggregatePlayerStats(events, carrom.playerStats!, undefined, ctx);
    expect(twice).toEqual(once);
  });

  it("declares no colliding keys between folded and metrics", () => {
    expect(playerStatsKeyCollisions(carrom.playerStats!)).toEqual([]);
  });

  it("ctx omitted stays inert: pre-existing metrics are byte-identical and no new key ever appears", () => {
    const events = stream(
      ["core.start"],
      [
        "carrom.board.summary",
        { winner: "H", opponentCoinsLeft: 5, queenTo: "H", breaker: "H-p1", queenBy: "H-p1" },
      ],
      ["carrom.board.summary", { winner: "A", opponentCoinsLeft: 4, queenTo: null, breaker: "A-p1" }],
      ["carrom.game.adjust", { entrantId: "A", delta: 1, reason: "foul", person: "H-p1" }],
    );
    expect(aggregatePlayerStats(events, carrom.playerStats!)).toEqual([
      { personId: "A-p1", stats: { breaks: 1 } },
      { personId: "H-p1", stats: { breaks: 1, queens: 1, penalties: 1 } },
    ]);
  });
});

describe("carrom: event union stays unambiguous", () => {
  it("parses each of the three branches as itself", () => {
    const toss = { firstBreak: "H" };
    const board = { winner: "H", opponentCoinsLeft: 5, queenTo: null, breaker: "H-p1" };
    const adjust = { entrantId: "H", delta: -1, reason: "foul", person: "H-p1" };
    // W4 review — the adjust branch was WIDENED with `offendingEntrantId`, and
    // z.union takes the first branch that parses, so the fully attributed shape
    // has to round-trip too: zod strips a key a narrower branch never declared,
    // silently, and only an equality round-trip can see it.
    const attributed = { ...adjust, offendingEntrantId: "A" };
    for (const payload of [toss, board, adjust, attributed]) {
      expect(carrom.eventSchema.parse(payload)).toEqual(payload);
    }
    // …and the widened branch must not have started swallowing its siblings.
    expect(carrom.eventSchema.parse(toss)).toEqual(toss);
    expect(carrom.eventSchema.safeParse({ entrantId: "H", offendingEntrantId: "A" }).success).toBe(
      false,
    );
  });

  it("takes an offending side without moving the score", () => {
    // The offender is a DISCIPLINE fact; the delta is the score fact. Naming
    // the first must not change the second.
    const events = (extra: Record<string, unknown>): Array<[string, unknown]> => [
      ["carrom.game.adjust", { entrantId: "H", delta: 2, reason: "Law 55 penalty", ...extra }],
    ];
    const plain = fold(stream(["core.start"], ...events({})));
    const named = fold(stream(["core.start"], ...events({ offendingEntrantId: "A" })));
    expect(named.games[0]!.score).toEqual(plain.games[0]!.score);
    expect(named.penalties).toBeUndefined();
  });

  it("folds a canonical payload of each branch to that branch's effect", () => {
    const state = fold(
      stream(
        ["carrom.toss", { firstBreak: "A" }],
        ["core.start"],
        ["carrom.board.summary", { winner: "H", opponentCoinsLeft: 5, queenTo: null, breaker: "H-p1" }],
        ["carrom.game.adjust", { entrantId: "H", delta: 2, reason: "due points", person: "A-p1" }],
      ),
    );
    expect(state.firstBreak).toBe("away");
    expect(state.games[0]!.score).toEqual({ home: 7, away: 0 });
    expect(state.games[0]!.boards).toHaveLength(1);
    expect(state.penalties).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// S6/#416 (W5) — the padSpec field/attribution DSL has no primitive that can
// emit a literal `null` (a `side` attribution item always resolves to a real
// entrant id), so a required-nullable `queenTo` made a "no queen covered"
// board-summary action unbuildable — a common case: 25% of generated boards.
// Widened to ALSO tolerate omission, treated identically to explicit `null`.
// ---------------------------------------------------------------------------
describe("carrom: an omitted queenTo settles exactly like an explicit null (S6 padSpec representability)", () => {
  it("records a board with no `queenTo` key at all, matching explicit queenTo: null", () => {
    const omitted = fold(
      stream(["core.start"], ["carrom.board.summary", { winner: "H", opponentCoinsLeft: 5 }]),
    );
    const explicit = fold(
      stream(["core.start"], ["carrom.board.summary", { winner: "H", opponentCoinsLeft: 5, queenTo: null }]),
    );
    expect(omitted).toEqual(explicit);
    expect(omitted.games[0]!.boards[0]).toMatchObject({ queenTo: null, queenScored: false });
  });

  it("still rejects a queenBy credited to a player when queenTo is omitted (same refusal as explicit null)", () => {
    expect(() =>
      fold(
        stream(["core.start"], [
          "carrom.board.summary",
          { winner: "H", opponentCoinsLeft: 5, queenBy: "H-p1" },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });
});

// ---------------------------------------------------------------------------
// Conformance — spec 04 §9 (PROMPT-03 kit) at the ICF default and under the
// tie-board 'draw' house rule (drawn matches reachable).
// ---------------------------------------------------------------------------
conformanceSuite(carrom);
conformanceSuite(carrom, { cfg: { tieBoard: "draw" }, label: "tie-board draw" });
conformanceSuite(carrom, {
  cfg: { gameTo: 29, queenPoints: 5, queenCapAt: 24 },
  label: "club-29",
});

// ---------------------------------------------------------------------------
// S6/#416 (W5) — padSpec conformance.
// ---------------------------------------------------------------------------

padSpecConformanceSuite(carrom, { cfg: {}, lineups, label: "icf default" });
padSpecConformanceSuite(carrom, {
  cfg: { gameTo: 29, queenPoints: 5, queenCapAt: 24 },
  lineups,
  label: "club-29",
});

describe("carrom padSpec — action coverage", () => {
  it("every registered event type is reachable from some action (no cfg-mutual-exclusivity in this module)", () => {
    const specs = [padSpec(carrom.configSchema.parse({}))];
    expect(checkActionCoverage(specs, CARROM_EVENT_SCHEMAS)).toEqual([]);
  });
});

// S7/#427 — "carrom: per-board player pickers", the dossier's own owed line.
// `boardQueen` asks for FOUR ids in a row (two sides, two persons); without
// copy a scorer cannot tell the breaker from the player who covered the queen,
// and they are frequently different people.
describe("carrom padSpec — per-board player pickers carry label keys (S7/#427)", () => {
  const spec = padSpec(carrom.configSchema.parse({}));

  it("labels breaker on both board actions and queenBy on the queen one", () => {
    expect(padItemLabelKey(spec, "carrom.board.summary", "breaker")).toMatchObject({
      key: "pad.carrom.action.board.field.breaker",
      where: "attribution",
    });
    expect(padItemLabelKey(spec, "carrom.board.summary", "queenBy")).toMatchObject({
      key: "pad.carrom.action.boardQueen.field.queenBy",
      where: "attribution",
    });
  });

  it("the queen-covered action labels its OWN breaker picker, scoped to that action", () => {
    // Two actions share the type `carrom.board.summary`; keys are scoped by
    // ACTION so the queen board can word its breaker differently if it ever
    // needs to — and so `checkLabelKeysUnique` stays a real check.
    const keys = spec.panels
      .flatMap((panel) => panel.actions)
      .filter((action) => action.type === "carrom.board.summary")
      .map((action) => action.attribution.find((item) => item.path === "breaker")?.labelKey?.key);
    expect(keys).toEqual([
      "pad.carrom.action.board.field.breaker",
      "pad.carrom.action.boardQueen.field.breaker",
    ]);
  });
});

describe("carrom padSpec — no core.* actions (match lifecycle is universal renderer chrome)", () => {
  it("declares zero actions outside its own eventSchemas registry", () => {
    const spec = padSpec(cfg);
    for (const panel of spec.panels) {
      for (const action of panel.actions) {
        expect(action.type in CARROM_EVENT_SCHEMAS, action.type).toBe(true);
      }
    }
  });
});

describe("carrom padSpec — variant reshaping: club-29 vs icf produce different bounds from the same module", () => {
  it("the umpire-adjustment delta bound tracks cfg.gameTo, not a hardcoded preset number", () => {
    const icfSpec = padSpec(carrom.configSchema.parse({}));
    const clubSpec = padSpec(carrom.configSchema.parse({ gameTo: 29, queenPoints: 5, queenCapAt: 24 }));
    const creditField = (spec: ReturnType<typeof padSpec>) =>
      spec.panels
        .flatMap((p) => p.actions)
        .find((a) => a.labelKey.key === "pad.carrom.action.adjustCredit")!
        .fields.find((f) => f.path === "delta");
    const icfDelta = creditField(icfSpec);
    const clubDelta = creditField(clubSpec);
    expect(icfDelta?.kind).toBe("number");
    expect(clubDelta?.kind).toBe("number");
    if (icfDelta?.kind === "number" && clubDelta?.kind === "number") {
      expect(icfDelta.max).toBe(25); // cfg.gameTo (icf default)
      expect(clubDelta.max).toBe(29); // cfg.gameTo (club-29)
    }
  });
});
