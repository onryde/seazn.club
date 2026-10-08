// Board-game goldens + conformance — spec 04 §6, PROMPT-07.
import { describe, expect, it } from "vitest";
import { foldMatch, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import { DRAW_KINDS, StageKind, type LineupPair, type StageCtx } from "../../core/types.ts";
import {
  aggregatePlayerStats,
  playerStatsKeyCollisions,
  type PlayerStatsFoldCtx,
} from "../../stats/stats.ts";
import { conformanceSuite, defaultLineupPair, makeEnvelope } from "../../testkit/index.ts";
import { checkActionCoverage, padSpecConformanceSuite } from "../../testkit/conformance-pad.ts";
import {
  boardgame,
  BOARDGAME_EVENT_SCHEMAS,
  BOARDGAME_TIEBREAKERS,
  padSpec,
  type BoardgameState,
} from "./boardgame.ts";

// W4a (#425) §3.3 — every fold below is PAD-SHAPED: it is building a stream
// event by event, which is the write path. `strictFromSeq: 0` marks the whole
// stream new and is therefore exactly the pre-seam behaviour. Only a real READ
// path (apps/web fold.ts) and the cfg-replay property pass no options.
const STRICT_ALL = { strictFromSeq: 0 } as const;

const lineups: LineupPair = defaultLineupPair(boardgame.positions); // entrants H / A
const cfg = boardgame.configSchema.parse({});
const league: StageCtx = { kind: "league" };

function stream(...specs: Array<[type: string, payload?: unknown]>): EventEnvelope[] {
  return specs.map(([type, payload], i) => makeEnvelope(i, { type, payload: payload ?? {} }));
}
function fold(events: EventEnvelope[], config = cfg): BoardgameState {
  return foldMatch(boardgame, config, lineups, events, STRICT_ALL);
}
const asEv = (event: EventEnvelope) => event as EventEnvelope<CoreEv>;

describe("boardgame golden: decisive game (White wins)", () => {
  const state = fold(stream(["core.start"], ["boardgame.result", { winner: "H", method: "checkmate" }]));

  it("decides for the winner and displays points, not half-points", () => {
    expect(state.outcome).toEqual({ kind: "win", winner: "H", loser: "A", method: "checkmate" });
    expect(boardgame.summary(state).headline).toBe("1 — 0");
    expect(boardgame.summary(state).detail).toMatchObject({ method: "checkmate", colorOfHome: "W" });
  });

  it("pays win/loss as integer half-points with colour + win metrics", () => {
    const [home, away] = boardgame.standingsDelta(state.outcome!, cfg, league, state);
    expect(home).toMatchObject({ won: 1, points: 2, metrics: { wins: 1, white: 1, black: 0 } });
    expect(away).toMatchObject({ lost: 1, points: 0, metrics: { wins: 0, white: 0, black: 1 } });
    // Half-point integers only — never a 0.5 float (PROMPT-07 acceptance).
    expect(Number.isInteger(home.points)).toBe(true);
    expect(Number.isInteger(away.points)).toBe(true);
  });
});

describe("boardgame golden: draw (½-½)", () => {
  const state = fold(stream(["core.start"], ["boardgame.result", { winner: null, method: "agreement" }]));

  it("splits a half-point (stored as 1) to each side", () => {
    expect(state.outcome).toEqual({ kind: "draw" });
    expect(boardgame.summary(state).headline).toBe("½ — ½");
    const [home, away] = boardgame.standingsDelta(state.outcome!, cfg, league, state);
    expect([home.points, away.points]).toEqual([1, 1]);
    expect(home).toMatchObject({ drawn: 1, metrics: { wins: 0, white: 1, black: 0 } });
    expect(away).toMatchObject({ drawn: 1, metrics: { wins: 0, white: 0, black: 1 } });
    expect(home.points + away.points).toBe(2);
  });
});

describe("boardgame golden: forfeit + double forfeit", () => {
  it("scores a forfeit like a win but excludes it from colour history", () => {
    const state = fold(stream(["core.start"], ["core.forfeit", { by: "A", reason: "no-show" }]));
    expect(state.outcome).toMatchObject({ kind: "win", winner: "H", method: "forfeit" });
    const [home, away] = boardgame.standingsDelta(state.outcome!, cfg, league, state);
    expect(home).toMatchObject({ won: 1, points: 2, metrics: { wins: 1, white: 0, black: 0 } });
    expect(away.metrics).toMatchObject({ white: 0, black: 0 }); // colour excluded
  });

  it("maps a double forfeit to a 0-0 no-result", () => {
    const state = fold(
      stream(["core.start"], ["boardgame.result", { winner: null, method: "double_forfeit" }]),
    );
    expect(state.outcome).toEqual({ kind: "no_result" });
    const [home, away] = boardgame.standingsDelta(state.outcome!, cfg, league, state);
    expect([home.points, away.points]).toEqual([0, 0]);
    expect(home.points + away.points).toBe(0); // inside declaredPointsSets
  });
});

// C2 (2026-09-20 review). `boardgame` was the ONLY one of the eight modules
// with no `case "award"` in `standingsDelta`, so an award fell to
// `default: invalid(...)` and threw INVALID_EVENT.
//
// The award does NOT come from this kernel — boardgame's own `core.forfeit`
// folds to `{kind:"win", method:"forfeit"}` (see the forfeit golden above),
// which is exactly why the case was never needed and never noticed missing.
// It is synthesised by the COMPETITION layer for a fixture nobody played: a
// Swiss odd-field sit-out, or a knockout seeded bye with one seat null
// (apps/web `engine-db/competition.ts` awardByeDelta). Two live consequences
// before this case existed: chess Swiss "Pair next" committed the bye write
// and then 500'd on the unguarded recomputeStandings, and ANY existing
// boardgame knockout with a seeded bye broke recomputeStandings,
// rankedStageStandings and completeStageIfReady for its division.
describe("boardgame: a competition-layer award (bye / walkover)", () => {
  // `init` with no events, exactly as awardByeDelta builds it.
  const fresh = boardgame.init(cfg, lineups);

  it("ranks the advancing side exactly as a win, at cfg's own win score", () => {
    const [home, away] = boardgame.standingsDelta({ kind: "award", winner: "H" }, cfg, league, fresh);
    expect(home).toMatchObject({
      entrantId: "H",
      played: 1,
      won: 1,
      drawn: 0,
      lost: 0,
      points: cfg.scoring.win,
    });
    expect(away).toMatchObject({ entrantId: "A", won: 0, lost: 1, points: cfg.scoring.loss });
  });

  it("keeps [home, away] lineup order when the AWAY seat is the one advancing", () => {
    const [home, away] = boardgame.standingsDelta({ kind: "award", winner: "A" }, cfg, league, fresh);
    expect(home.entrantId).toBe("H");
    expect(away.entrantId).toBe("A");
    expect(away.points).toBe(cfg.scoring.win);
    expect(home.points).toBe(cfg.scoring.loss);
  });

  it("stays inside declaredPointsSets, so the conformance kit still holds", () => {
    const [home, away] = boardgame.standingsDelta({ kind: "award", winner: "H" }, cfg, league, fresh);
    expect(boardgame.declaredPointsSets(cfg)).toContain(home.points + away.points);
  });

  it("takes its score from cfg, not a constant", () => {
    // The default win score is 2, so a test that only ever asserted `2` could
    // not tell a cfg read from a hard-coded half-point pair. This scheme
    // differs from the default on purpose.
    const custom = boardgame.configSchema.parse({ scoring: { win: 3, draw: 1, loss: 0 } });
    expect(custom.scoring.win).not.toBe(cfg.scoring.win);
    const state = boardgame.init(custom, lineups);
    const [home] = boardgame.standingsDelta({ kind: "award", winner: "H" }, custom, league, state);
    expect(home.points).toBe(custom.scoring.win);
  });

  it("is excluded from colour history, exactly as a forfeit is", () => {
    // Nobody sat at a board, so crediting the bye recipient a game as White
    // would put a game they never played into the `white`/`black` ledger.
    // `colorOf` already excludes a forfeit for that reason; an award is the
    // same class of non-game.
    const [home, away] = boardgame.standingsDelta({ kind: "award", winner: "H" }, cfg, league, fresh);
    expect(fresh.colorOfHome).toBe("W"); // colours ARE on — the exclusion is deliberate, not vacuous
    expect(home.metrics).toMatchObject({ wins: 1, white: 0, black: 0 });
    expect(away.metrics).toMatchObject({ wins: 0, white: 0, black: 0 });
  });
});

describe("boardgame contract declarations", () => {
  it("X-DR-1: draws only in DRAW_KINDS — a drawn bracket game goes to the tie-break (BG-KO-1)", () => {
    let checked = 0;
    for (const stage of StageKind.options) {
      expect(boardgame.supportsDraws(cfg, stage), stage).toBe(DRAW_KINDS.has(stage));
      checked++;
    }
    expect(checked).toBe(StageKind.options.length);
  });

  it("declares the FIDE cascade and {2, 0} point totals", () => {
    expect(boardgame.defaultTiebreakers).toEqual(BOARDGAME_TIEBREAKERS);
    expect(boardgame.defaultTiebreakers.slice(0, 4)).toEqual([
      "points",
      "buchholz_cut1",
      "buchholz",
      "sberger",
    ]);
    expect([...boardgame.declaredPointsSets(cfg)].sort((a, b) => a - b)).toEqual([0, 2]);
  });

  it("disables colour metadata when colours are off (go / generic 1-v-1)", () => {
    const noColor = boardgame.configSchema.parse({ colors: false });
    const state = fold(
      stream(["core.start"], ["boardgame.result", { winner: "H", method: "resign" }]),
      noColor,
    );
    expect(state.colorOfHome).toBeNull();
    const [home] = boardgame.standingsDelta(state.outcome!, noColor, league, state);
    expect(home.metrics).toMatchObject({ white: 0, black: 0 });
  });

  it("rejects a result before kickoff and finalize while undecided", () => {
    expect(() =>
      boardgame.apply(
        boardgame.init(cfg, lineups),
        makeEnvelope(0, { type: "boardgame.result", payload: { winner: "H" } }) as EventEnvelope<never>,
      ),
    ).toThrowError(expect.objectContaining({ code: "WRONG_PHASE" }));
    const live = fold(stream(["core.start"]));
    expect(() =>
      boardgame.apply(live, asEv(makeEnvelope(9, { type: "core.finalize", payload: {} }))),
    ).toThrowError(expect.objectContaining({ code: "WRONG_PHASE" }));
  });
});

// ---------------------------------------------------------------------------
// W4 domain audit — FIDE Laws of Chess (2023) Articles 5, 7, 8, 9.
// ---------------------------------------------------------------------------

describe("boardgame: how the game ended (FIDE Art. 5 + 9)", () => {
  // Art. 9.2/9.3/9.6 — the drawing methods a scoresheet distinguishes.
  const drawn = ["repetition", "fifty_move", "dead_position"] as const;
  for (const method of drawn) {
    it(`records a draw by ${method}`, () => {
      const state = fold(stream(["core.start"], ["boardgame.result", { winner: null, method }]));
      expect(state.method).toBe(method);
      expect(state.outcome).toEqual({ kind: "draw" });
      expect(boardgame.summary(state).detail).toMatchObject({ method });
    });
  }

  // Art. 7.5.5 — the loss an arbiter records for a repeated illegal move.
  it("records a loss by illegal move", () => {
    const state = fold(
      stream(["core.start"], ["boardgame.result", { winner: "H", method: "illegal_move" }]),
    );
    expect(state.outcome).toMatchObject({ kind: "win", winner: "H", method: "illegal_move" });
  });
});

describe("boardgame: the arbiter's pairing card", () => {
  const pairing = ["boardgame.pairing", { white: "A", homePerson: "H-p1", awayPerson: "A-p1", board: 3 }] as const;

  it("assigns White to the entrant the pairing names, not always the home side", () => {
    const state = fold(
      stream(["core.start"], [...pairing], ["boardgame.result", { winner: "H", method: "resign" }]),
    );
    expect(state.colorOfHome).toBe("B");
    const [home, away] = boardgame.standingsDelta(state.outcome!, cfg, league, state);
    expect(home.metrics).toMatchObject({ white: 0, black: 1 });
    expect(away.metrics).toMatchObject({ white: 1, black: 0 });
  });

  it("records who sat at the board and which board it was", () => {
    const state = fold(stream(["core.start"], [...pairing]));
    expect(state.players).toEqual({ home: "H-p1", away: "A-p1" });
    expect(state.board).toBe(3);
    expect(boardgame.summary(state).detail).toMatchObject({
      players: { home: "H-p1", away: "A-p1" },
      board: 3,
    });
  });

  it("rejects a colour assignment when the division plays without colours", () => {
    const noColor = boardgame.configSchema.parse({ colors: false });
    expect(() =>
      fold(stream(["core.start"], ["boardgame.pairing", { white: "A" }]), noColor),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
    // …but the players may still be recorded.
    const state = fold(
      stream(["core.start"], ["boardgame.pairing", { homePerson: "H-p1" }]),
      noColor,
    );
    expect(state.players).toEqual({ home: "H-p1" });
    expect(state.colorOfHome).toBeNull();
  });

  // W4 review item 6 — the house pattern for "which side did this" is `by` +
  // `person`, and the pairing card uses `homePerson`/`awayPerson` instead.
  // Deliberate, and this is the reason: the card is ONE arbiter record of a
  // MEETING, and `white` and `board` are properties of the pairing, not of a
  // side. Splitting it into two `by`+`person` events would either orphan those
  // two facts or duplicate them onto both halves — and two copies of "who had
  // White" can disagree, which is a contradiction the current shape cannot
  // express. See DOMAIN.md.
  it("holds both seats, the colour and the board number in ONE atomic record", () => {
    const state = fold(stream(["core.start"], [...pairing]));
    expect(state.players).toEqual({ home: "H-p1", away: "A-p1" });
    expect(state.colorOfHome).toBe("B"); // `white: "A"` — a fact about the PAIR
    expect(state.board).toBe(3);
  });

  it("has no per-side pairing branch — `by` + `person` is not accepted here", () => {
    // If this ever starts parsing, the atomic card has grown a second, partial
    // form and the two can disagree about White.
    expect(() =>
      fold(stream(["core.start"], ["boardgame.pairing", { by: "H", person: "H-p1" }])),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("rejects an empty pairing card and one after the game is over", () => {
    expect(() => fold(stream(["core.start"], ["boardgame.pairing", {}]))).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
    const decided = fold(stream(["core.start"], ["boardgame.result", { winner: "H" }]));
    expect(() =>
      boardgame.apply(
        decided,
        makeEnvelope(9, { type: "boardgame.pairing", payload: { board: 1 } }) as EventEnvelope<never>,
      ),
    ).toThrowError(expect.objectContaining({ code: "WRONG_PHASE" }));
  });
});

describe("boardgame: game length and the winning player", () => {
  it("records the move count the scoresheet finished on (Art. 8.1)", () => {
    const state = fold(
      stream(["core.start"], ["boardgame.result", { winner: "H", method: "checkmate", moves: 41 }]),
    );
    expect(state.moves).toBe(41);
    expect(boardgame.summary(state).detail).toMatchObject({ moves: 41 });
  });

  it("credits the player who won the board in a team match", () => {
    const state = fold(
      stream(["core.start"], ["boardgame.result", { winner: "H", winnerPerson: "H-p1" }]),
    );
    expect(state.winnerPerson).toBe("H-p1");
    expect(boardgame.summary(state).detail).toMatchObject({ winnerPerson: "H-p1" });
  });

  it("rejects a winning player on a drawn game", () => {
    expect(() =>
      fold(stream(["core.start"], ["boardgame.result", { winner: null, winnerPerson: "H-p1" }])),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });

  it("folds person credit into a games/wins leaderboard", () => {
    const events = stream(
      ["core.start"],
      ["boardgame.pairing", { homePerson: "H-p1", awayPerson: "A-p1" }],
      ["boardgame.result", { winner: "H", method: "checkmate", winnerPerson: "H-p1" }],
    );
    expect(aggregatePlayerStats(events, boardgame.playerStats!)).toEqual([
      { personId: "A-p1", stats: { games: 1 } },
      { personId: "H-p1", stats: { games: 1, wins: 1 } },
    ]);
  });
});

// S8/#417 — folded win/draw/loss + white/black, resolved from entrant
// attribution when the payload names no person. Mirrors
// `../tennis/../nested/playerstats.test.ts`'s conventions (ctx helper shape,
// void/determinism/collision checks) — this is the same kernel API, just
// declared directly on the module instead of a shared kernel default.
describe("boardgame: folded win/draw/loss + white/black, resolved from entrant attribution (S8/#417)", () => {
  function ctxFor(
    entrants: ReadonlyArray<{
      id: string;
      kind?: "team" | "individual" | "pair";
      persons: readonly string[];
    }>,
  ): PlayerStatsFoldCtx {
    return {
      entrants: entrants.map((e) => ({ id: e.id, kind: e.kind ?? "individual" })),
      personsOf: (entrantId) => entrants.find((e) => e.id === entrantId)?.persons ?? [],
    };
  }
  const twoPlayers = ctxFor([
    { id: "H", persons: ["H-p1"] },
    { id: "A", persons: ["A-p1"] },
  ]);

  it("headline regression: entrant ids only (no person fields) + individual ctx resolve correct win/loss rows", () => {
    const events = stream(["core.start"], ["boardgame.result", { winner: "H", method: "checkmate" }]);
    expect(aggregatePlayerStats(events, boardgame.playerStats!, undefined, twoPlayers)).toEqual([
      { personId: "A-p1", stats: { losses: 1 } },
      { personId: "H-p1", stats: { wins: 1 } },
    ]);
  });

  it("a draw (winnerPerson is unbuildable on a drawn game) credits both sides via the roster", () => {
    const events = stream(["core.start"], ["boardgame.result", { winner: null, method: "agreement" }]);
    expect(aggregatePlayerStats(events, boardgame.playerStats!, undefined, twoPlayers)).toEqual([
      { personId: "A-p1", stats: { draws: 1 } },
      { personId: "H-p1", stats: { draws: 1 } },
    ]);
  });

  it("CONFLICTING attribution: an explicit winnerPerson wins over the `winner` entrant fallback, and the entrant's own roster person gets no row at all", () => {
    const events = stream(
      ["core.start"],
      ["boardgame.result", { winner: "H", method: "checkmate", winnerPerson: "P1" }],
    );
    // ctx says H's roster person is P2 — disagreeing with the explicit P1.
    const ctx = ctxFor([
      { id: "H", persons: ["P2"] },
      { id: "A", persons: ["A-p1"] },
    ]);
    const rows = aggregatePlayerStats(events, boardgame.playerStats!, undefined, ctx);
    expect(rows).toEqual([
      { personId: "A-p1", stats: { losses: 1 } },
      { personId: "P1", stats: { wins: 1 } },
    ]);
    expect(rows.find((r) => r.personId === "P2")).toBeUndefined();
  });

  it("a team entrant credits no rows through the entrant path, even with a full roster", () => {
    const events = stream(["core.start"], ["boardgame.result", { winner: "H", method: "checkmate" }]);
    const ctx = ctxFor([
      { id: "H", kind: "team", persons: ["H-p1", "H-p2"] },
      { id: "A", persons: ["A-p1"] },
    ]);
    expect(aggregatePlayerStats(events, boardgame.playerStats!, undefined, ctx)).toEqual([
      { personId: "A-p1", stats: { losses: 1 } },
    ]);
  });

  // S8/#417 W6 fix 5 — the "checkmate" fixture above never actually exercises
  // `foldBoardgameStats`'s OWN `creditEach` guard for the team-kind side: "H"
  // wins, so H's only attempted credit is "wins" — a plain METRIC guarded by
  // `resolveMetricPersons`'s separate, unrelated check, not `creditEach`/
  // `personsForEntrant` at all. A draw is what actually calls
  // `creditEach(entrant, "draws")` for EVERY entrant, including a team-kind
  // one — the only fixture that proves THIS fold's guard, not a different one
  // that happens to produce the same-looking empty row for H.
  it("a team entrant is credited nothing through the FOLDED path either — a draw calls creditEach on both sides, including the team one", () => {
    const events = stream(["core.start"], ["boardgame.result", { winner: null, method: "agreement" }]);
    const ctx = ctxFor([
      { id: "H", kind: "team", persons: ["H-p1", "H-p2"] },
      { id: "A", persons: ["A-p1"] },
    ]);
    expect(aggregatePlayerStats(events, boardgame.playerStats!, undefined, ctx)).toEqual([
      { personId: "A-p1", stats: { draws: 1 } },
    ]);
  });

  it("white/black splits, derived from the pairing card's `white` entrant — not a new payload field", () => {
    const events = stream(
      ["core.start"],
      ["boardgame.pairing", { white: "H" }],
      ["boardgame.result", { winner: "H", method: "checkmate" }],
    );
    expect(aggregatePlayerStats(events, boardgame.playerStats!, undefined, twoPlayers)).toEqual([
      { personId: "A-p1", stats: { black: 1, losses: 1 } },
      { personId: "H-p1", stats: { white: 1, wins: 1 } },
    ]);
  });

  it("the same person plays both colours across two separate fixtures", () => {
    const ctx = ctxFor([
      { id: "H", persons: ["shared-p1"] },
      { id: "A", persons: ["A-p1"] },
    ]);
    const fixtureOne = aggregatePlayerStats(
      stream(["core.start"], ["boardgame.pairing", { white: "H" }]),
      boardgame.playerStats!,
      undefined,
      ctx,
    );
    const fixtureTwo = aggregatePlayerStats(
      stream(["core.start"], ["boardgame.pairing", { white: "A" }]),
      boardgame.playerStats!,
      undefined,
      ctx,
    );
    expect(fixtureOne).toEqual([
      { personId: "A-p1", stats: { black: 1 } },
      { personId: "shared-p1", stats: { white: 1 } },
    ]);
    expect(fixtureTwo).toEqual([
      { personId: "A-p1", stats: { white: 1 } },
      { personId: "shared-p1", stats: { black: 1 } },
    ]);
  });

  it("a single forfeit behaves as an ordinary decisive result for wins/losses", () => {
    const events = stream(["core.start"], ["boardgame.result", { winner: "H", method: "forfeit" }]);
    expect(aggregatePlayerStats(events, boardgame.playerStats!, undefined, twoPlayers)).toEqual([
      { personId: "A-p1", stats: { losses: 1 } },
      { personId: "H-p1", stats: { wins: 1 } },
    ]);
  });

  // Decision (owner asked for one, explicitly): a double forfeit is a
  // no_result (chess.md §7) — nobody's win, draw or loss, so neither
  // "wins", "draws" nor "losses" is written for anyone. It STILL counts as
  // a game played: "games" is fed unconditionally by the pairing card (who
  // sat down), independent of how the game ended, exactly like it already
  // was before this wave — a pairing card records attendance, not outcome.
  it("double forfeit: the pairing card still counts as a game played, but nobody earns a win, draw or loss", () => {
    const events = stream(
      ["core.start"],
      ["boardgame.pairing", { homePerson: "H-p1", awayPerson: "A-p1" }],
      ["boardgame.result", { winner: null, method: "double_forfeit" }],
    );
    const rows = aggregatePlayerStats(events, boardgame.playerStats!, undefined, twoPlayers);
    expect(rows).toEqual([
      { personId: "A-p1", stats: { games: 1 } },
      { personId: "H-p1", stats: { games: 1 } },
    ]);
  });

  it("a void over the result un-counts it in the folded path", () => {
    const decisive = stream(["core.start"], ["boardgame.result", { winner: "H", method: "checkmate" }]);
    // Prove the clean stream credits something FIRST — otherwise voiding it
    // down to `[]` would be true whether or not voiding actually did anything.
    const clean = aggregatePlayerStats(decisive, boardgame.playerStats!, undefined, twoPlayers);
    expect(clean).toEqual([
      { personId: "A-p1", stats: { losses: 1 } },
      { personId: "H-p1", stats: { wins: 1 } },
    ]);
    const voided = [
      ...decisive,
      makeEnvelope(decisive.length, { type: "core.void", payload: {} }, decisive[1]!.id),
    ];
    expect(aggregatePlayerStats(voided, boardgame.playerStats!, undefined, twoPlayers)).toEqual([]);
  });

  it("is deterministic: the same stream + ctx folds twice to deeply equal rows", () => {
    const events = stream(
      ["core.start"],
      ["boardgame.pairing", { white: "H" }],
      ["boardgame.result", { winner: "H", method: "checkmate" }],
    );
    const once = aggregatePlayerStats(events, boardgame.playerStats!, undefined, twoPlayers);
    const twice = aggregatePlayerStats(events, boardgame.playerStats!, undefined, twoPlayers);
    expect(twice).toEqual(once);
  });

  it("declares no colliding keys between folded and metrics", () => {
    expect(playerStatsKeyCollisions(boardgame.playerStats!)).toEqual([]);
  });

  it("ctx omitted stays inert: pre-existing metrics are byte-identical and no folded key ever appears", () => {
    const events = stream(
      ["core.start"],
      ["boardgame.pairing", { homePerson: "H-p1", awayPerson: "A-p1" }],
      ["boardgame.result", { winner: "H", method: "checkmate", winnerPerson: "H-p1" }],
    );
    expect(aggregatePlayerStats(events, boardgame.playerStats!)).toEqual([
      { personId: "A-p1", stats: { games: 1 } },
      { personId: "H-p1", stats: { games: 1, wins: 1 } },
    ]);
  });
});

describe("boardgame: event union stays unambiguous", () => {
  it("parses each branch as itself and rejects an empty payload", () => {
    expect(boardgame.eventSchema.parse({ winner: null, method: "agreement" })).toEqual({
      winner: null,
      method: "agreement",
    });
    expect(boardgame.eventSchema.parse({ white: "A" })).toEqual({ white: "A" });
    expect(boardgame.eventSchema.safeParse({}).success).toBe(false);
  });

  it("folds a pairing payload as a pairing and a result payload as a result", () => {
    const paired = fold(stream(["core.start"], ["boardgame.pairing", { white: "A" }]));
    expect(paired.phase).toBe("live");
    expect(paired.outcome).toBeNull();
    const decided = fold(stream(["core.start"], ["boardgame.result", { winner: null }]));
    expect(decided.outcome).toEqual({ kind: "draw" });
    expect(decided.colorOfHome).toBe("W");
  });
});

// W4a §5.5 — the time control is metadata, but INCREMENT and DELAY are two
// different clocks and a pad that conflates them counts down wrongly:
// increment BANKS unused time, delay does not. They are independent knobs, so
// each of the four combinations has to survive a parse.
describe("boardgame: increment and delay are independent clock facts", () => {
  const clockOf = (clock: unknown) => boardgame.configSchema.parse({ clock }).clock;

  it("round-trips a delay, and does not silently drop it", () => {
    // z.object STRIPS unknown keys, so an unmodelled `delay` parses "fine" and
    // vanishes — the assertion has to be on the round-tripped value.
    expect(clockOf({ base: 900, increment: 10, delay: 5 })).toEqual({
      base: 900,
      increment: 10,
      delay: 5,
    });
  });

  it("accepts a delay-only control (US delay: nothing is banked)", () => {
    const clock = clockOf({ base: 300, delay: 3 });
    expect(clock).toEqual({ base: 300, delay: 3 });
    expect(clock?.increment).toBeUndefined();
  });

  // Green in both states — `{base, increment}` parsed before the widening too.
  // Kept as the symmetry guard opposite the delay-only case above.
  it("accepts an increment-only control (Fischer: unused time is banked)", () => {
    const clock = clockOf({ base: 180, increment: 2 });
    expect(clock).toEqual({ base: 180, increment: 2 });
    expect(clock?.delay).toBeUndefined();
  });

  it("accepts a control with neither (sudden death)", () => {
    expect(clockOf({ base: 5400 })).toEqual({ base: 5400 });
  });

  it("refuses a negative or fractional delay", () => {
    // `increment` is supplied so the ONLY thing that can reject these is the
    // delay itself — otherwise a stripped `delay` plus a missing `increment`
    // fails the parse and the test passes without modelling anything.
    const bad = (delay: number) =>
      boardgame.configSchema.safeParse({ clock: { base: 300, increment: 0, delay } }).success;
    expect(bad(-1)).toBe(false);
    expect(bad(1.5)).toBe(false);
  });

  // The additive proof at cfg level (§8): cfg is serialised into the frozen
  // golden state strings, so a DEFAULT on any clock field would re-baseline
  // all eleven goldens. This passed before the change and must keep passing.
  it("leaves a cfg with no clock byte-identical", () => {
    const parsed = boardgame.configSchema.parse({});
    expect(Object.keys(parsed).sort()).toEqual(["byeScore", "colors", "scoring", "variant"]);
    expect(JSON.stringify(parsed)).toBe(
      JSON.stringify({
        scoring: { win: 2, draw: 1, loss: 0 },
        colors: true,
        byeScore: 2,
        variant: "classical",
      }),
    );
  });
});

// S6/#416 (W5) — the padSpec field/attribution DSL has no primitive that can
// emit a literal `null` (a `side` attribution item always resolves to a real
// entrant id; there is no "constant" PadField kind), so a required-nullable
// `winner` made a draw/no-result action unbuildable through it. Widened
// `winner` to ALSO tolerate omission, treated identically to explicit `null`.
describe("boardgame: an omitted winner settles exactly like an explicit null (S6 padSpec representability)", () => {
  it("records a draw with no `winner` key at all, matching explicit winner: null", () => {
    const omitted = fold(stream(["core.start"], ["boardgame.result", { method: "agreement" }]));
    const explicit = fold(stream(["core.start"], ["boardgame.result", { winner: null, method: "agreement" }]));
    expect(omitted.outcome).toEqual({ kind: "draw" });
    expect(omitted).toEqual(explicit);
  });

  it("records a no-result double forfeit with no `winner` key at all", () => {
    const omitted = fold(stream(["core.start"], ["boardgame.result", { method: "double_forfeit" }]));
    expect(omitted.outcome).toEqual({ kind: "no_result" });
  });

  it("still rejects a completely empty payload (disambiguation from boardgame.pairing survives)", () => {
    expect(() => fold(stream(["core.start"], ["boardgame.result", {}]))).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
  });
});

// PROMPT-07 acceptance — conformance green.
conformanceSuite(boardgame);

// ---------------------------------------------------------------------------
// S6/#416 (W5) — padSpec conformance.
// ---------------------------------------------------------------------------

padSpecConformanceSuite(boardgame, { cfg: {}, lineups, label: "default (colours on)" });
padSpecConformanceSuite(boardgame, { cfg: { colors: false }, lineups, label: "colours off" });

describe("boardgame padSpec — action coverage", () => {
  it("every registered event type is reachable from some action (single cfg — no cfg-mutual-exclusivity in this module)", () => {
    const specs = [padSpec(boardgame.configSchema.parse({})), padSpec(boardgame.configSchema.parse({ colors: false }))];
    expect(checkActionCoverage(specs, BOARDGAME_EVENT_SCHEMAS)).toEqual([]);
  });
});

describe("boardgame padSpec — cfg-only inclusion: pairing drops the `white` attribution when colours are off", () => {
  it("offers a side attribution for `white` when colours are on", () => {
    const spec = padSpec(boardgame.configSchema.parse({}));
    const pairing = spec.panels.flatMap((p) => p.actions).find((a) => a.type === "boardgame.pairing")!;
    expect(pairing.attribution.some((item) => item.kind === "side" && item.path === "white")).toBe(true);
  });

  it("omits it entirely when colours are off — the fold refuses `white` on every cfg it would render for", () => {
    const spec = padSpec(boardgame.configSchema.parse({ colors: false }));
    const pairing = spec.panels.flatMap((p) => p.actions).find((a) => a.type === "boardgame.pairing")!;
    expect(pairing.attribution.some((item) => item.kind === "side" && item.path === "white")).toBe(false);
  });
});

describe("boardgame padSpec — no core.* actions (match lifecycle is universal renderer chrome, not per-module data)", () => {
  it("declares zero actions outside its own eventSchemas registry — every action.type is a real key", () => {
    const spec = padSpec(cfg);
    for (const panel of spec.panels) {
      for (const action of panel.actions) {
        expect(action.type in BOARDGAME_EVENT_SCHEMAS, action.type).toBe(true);
      }
    }
  });

  it("single forfeit rides boardgame.result's own method enum, not core.forfeit", () => {
    const spec = padSpec(cfg);
    const decisive = spec.panels.flatMap((p) => p.actions).find((a) => a.labelKey.key === "pad.boardgame.action.result")!;
    const method = decisive.fields.find((f) => f.path === "method");
    expect(method?.kind).toBe("enum");
    if (method?.kind === "enum") expect(method.values).toContain("forfeit");
    const drawn = spec.panels.flatMap((p) => p.actions).find((a) => a.labelKey.key === "pad.boardgame.action.draw")!;
    const drawnMethod = drawn.fields.find((f) => f.path === "method");
    if (drawnMethod?.kind === "enum") expect(drawnMethod.values).toContain("double_forfeit");
  });
});
