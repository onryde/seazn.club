// Carrom — mutation-survivor kills for carrom.ts (config/event schemas, refusal messages, summary detail keys,
// decided-by-comparison matches, declared metrics, and the discipline projection). Law citations refer to the ICF
// "Laws of Carrom" as carried in DOMAIN.md / carrom.md.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair, StageCtx } from "../../core/types.ts";
import { aggregatePlayerStats, type PlayerStatsFoldCtx } from "../../stats/stats.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/index.ts";
import {
  carrom,
  CarromGameAdjust,
  CarromStrike,
  padSpec,
  type CarromState,
} from "./carrom.ts";

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
type BoardSpec = [winner: string, coins: number];
function boards(...specs: BoardSpec[]): Array<[string, unknown]> {
  return specs.map(([winner, opponentCoinsLeft]) => [
    "carrom.board.summary",
    { winner, opponentCoinsLeft, queenTo: null },
  ]);
}
// Runs `fn` and returns the EngineError it throws (fails the test if it does not throw one).
function refusal(fn: () => unknown): EngineError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EngineError);
    return error as EngineError;
  }
  throw new Error("expected an EngineError, nothing was thrown");
}

const game1H: BoardSpec[] = [["H", 9], ["H", 9], ["H", 9]]; // 27 >= 25: H takes the game
const game1A: BoardSpec[] = [["A", 9], ["A", 9], ["A", 9]];
const tiedEight: BoardSpec[] = [
  ["H", 3], ["A", 3], ["H", 3], ["A", 3],
  ["H", 3], ["A", 3], ["H", 3], ["A", 3],
]; // 12-12 after maxBoards (8)

describe("carrom config refinements (Law 56/57)", () => {
  it("bestOf must be odd: an even count is refused with the decider message, an odd one passes", () => {
    const bad = carrom.configSchema.safeParse({ bestOf: 2 });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((issue) => issue.message)).toContain("bestOf must be odd (a decider must exist)");
    expect(carrom.configSchema.safeParse({ bestOf: 3 }).success).toBe(true);
    expect(carrom.configSchema.safeParse({ bestOf: 5 }).success).toBe(true);
  });

  it("queenCapAt may not exceed gameTo: refused with its message, equal passes", () => {
    const bad = carrom.configSchema.safeParse({ gameTo: 25, queenCapAt: 26 });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((issue) => issue.message)).toContain("queenCapAt must not exceed gameTo");
    expect(carrom.configSchema.safeParse({ gameTo: 25, queenCapAt: 25 }).success).toBe(true);
  });
});

describe("carrom event schemas", () => {
  it("an adjustment of delta 0 is refused with its message; a non-zero delta passes", () => {
    const base = { entrantId: "H", reason: "foul" };
    const zero = CarromGameAdjust.safeParse({ ...base, delta: 0 });
    expect(zero.success).toBe(false);
    expect(zero.error?.issues.map((issue) => issue.message)).toContain("delta must be non-zero");
    expect(CarromGameAdjust.safeParse({ ...base, delta: -1 }).success).toBe(true);
    expect(CarromGameAdjust.safeParse({ ...base, delta: 2 }).success).toBe(true);
  });

  it("the reserved CarromStrike names only white, black and queen coins (Law 52)", () => {
    expect(CarromStrike.safeParse({ striker: "H", pocketed: ["white", "black", "queen"] }).success).toBe(true);
    expect(CarromStrike.safeParse({ striker: "H", pocketed: ["red"] }).success).toBe(false);
    expect(CarromStrike.safeParse({ striker: "H", pocketed: [""] }).success).toBe(false);
  });
});

describe("carrom refusals carry their message and data", () => {
  it("an unknown entrant names itself", () => {
    const error = refusal(() => fold(stream(["core.start"], ["carrom.board.summary", { winner: "Z", opponentCoinsLeft: 3 }])));
    expect(error.code).toBe("INVALID_EVENT");
    expect(error.message).toBe('unknown entrant "Z"');
    expect(error.data).toEqual({ entrantId: "Z" });
  });

  it("an invalid payload names the event type and lists the issues", () => {
    const error = refusal(() => fold(stream(["core.start"], ["carrom.board.summary", { winner: "H" }])));
    expect(error.code).toBe("INVALID_EVENT");
    expect(error.message).toBe("invalid carrom.board.summary payload");
    const issues = (error.data as { issues: unknown[] }).issues;
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.length).toBeGreaterThan(0);
  });

  it("a toss after core.start and a second toss are refused with their reasons", () => {
    const late = refusal(() => fold(stream(["core.start"], ["carrom.toss", { firstBreak: "A" }])));
    expect(late.code).toBe("WRONG_PHASE");
    expect(late.message).toBe("toss must precede core.start");
    const twice = refusal(() => fold(stream(["carrom.toss", { firstBreak: "A" }], ["carrom.toss", { firstBreak: "H" }])));
    expect(twice.code).toBe("INVALID_EVENT");
    expect(twice.message).toBe("toss already recorded");
  });

  it("core.start twice and finalizing an undecided fixture are refused with their reasons", () => {
    const twice = refusal(() => fold(stream(["core.start"], ["core.start"])));
    expect(twice.code).toBe("WRONG_PHASE");
    expect(twice.message).toBe("already started");
    const early = refusal(() => fold(stream(["core.start"], ["core.finalize"])));
    expect(early.code).toBe("WRONG_PHASE");
    expect(early.message).toBe("cannot finalize an undecided fixture");
  });

  it("an event type the module does not know is refused by name", () => {
    const state = carrom.init(cfg, lineups);
    const ev = makeEnvelope(0, { type: "carrom.bogus", payload: {} });
    const error = refusal(() => carrom.apply(state, ev as never, {} as never));
    expect(error.code).toBe("INVALID_EVENT");
    expect(error.message).toBe('unknown event type "carrom.bogus"');
  });

  it("an outcome carrom cannot rank is refused by kind", () => {
    const state = fold(stream(["core.start"]));
    const error = refusal(() => carrom.standingsDelta({ kind: "bogus" } as never, cfg, league, state));
    expect(error.code).toBe("INVALID_EVENT");
    expect(error.message).toBe('carrom module cannot rank outcome "bogus"');
  });
});

describe("carrom match decided by comparing games once bestOf are played (Law 57)", () => {
  const drawCfg = carrom.configSchema.parse({ tieBoard: "draw", bestOf: 3 });

  it("1 game won + 2 drawn games: the home win decides the match", () => {
    // 1-0 in games with two drawn: neither side reached 2, all 3 played, home leads.
    const state = fold(stream(["core.start"], ...boards(...game1H, ...tiedEight, ...tiedEight)), drawCfg);
    expect(state.gamesWon).toEqual({ home: 1, away: 0 });
    expect(state.gamesDrawn).toBe(2);
    expect(state.outcome).toEqual({ kind: "win", winner: "H", loser: "A", method: "regulation" });
  });

  it("the mirror: the away win decides the match", () => {
    const state = fold(stream(["core.start"], ...boards(...game1A, ...tiedEight, ...tiedEight)), drawCfg);
    expect(state.gamesWon).toEqual({ home: 0, away: 1 });
    expect(state.outcome).toEqual({ kind: "win", winner: "A", loser: "H", method: "regulation" });
  });
});

describe("carrom position of a decided match", () => {
  it("a match won 2-0 reports Game 2, not a phantom Game 3 (the last position that happened)", () => {
    const state = fold(stream(["core.start"], ...boards(...game1H, ...game1H)));
    expect(state.outcome).not.toBeNull();
    const segments = carrom.position!(state).segments;
    expect(segments[0]).toMatchObject({ key: "game", value: "2" });
    expect(segments[1]).toMatchObject({ key: "board", value: "3" });
  });
});

describe("carrom summary detail", () => {
  it("the break alternates by game: game 2 opens with the away side (Law 49)", () => {
    const state = fold(stream(["core.start"], ...boards(...game1H)));
    expect(state.games).toHaveLength(2);
    expect(carrom.summary(state).detail).toMatchObject({ firstBreak: "H", breaker: "A" });
  });

  it("no breaker before play starts, and none once the match is decided mid-game", () => {
    const pre = carrom.summary(carrom.init(cfg, lineups));
    expect(Object.hasOwn(pre.detail as object, "breaker")).toBe(false);
    const forfeited = fold(stream(["core.start"], ...boards(["H", 3]), ["core.forfeit", { by: "A", reason: "retired" }]));
    expect(forfeited.games[0]!.winner).toBeNull(); // a game is still open on the state
    expect(Object.hasOwn(carrom.summary(forfeited).detail as object, "breaker")).toBe(false);
  });

  it("optional keys appear only when there is something to say", () => {
    const plain = carrom.summary(fold(stream(["core.start"], ...boards(["H", 3])))).detail as {
      games: Array<{ boards: object[] }>;
    };
    const plainBoard = plain.games[0]!.boards[0]!;
    expect(Object.hasOwn(plainBoard, "breakerPerson")).toBe(false);
    expect(Object.hasOwn(plainBoard, "queenPerson")).toBe(false);
    expect(Object.hasOwn(plain, "penalties")).toBe(false);
    expect(Object.hasOwn(plain, "abandoned")).toBe(false);

    const rich = carrom.summary(
      fold(
        stream(
          ["core.start"],
          ["carrom.board.summary", { winner: "H", opponentCoinsLeft: 3, queenTo: "H", breaker: "p1", queenBy: "p2" }],
          ["carrom.game.adjust", { entrantId: "H", delta: -1, reason: "foul", person: "p3" }],
        ),
      ),
    ).detail as { games: Array<{ boards: Array<Record<string, unknown>> }>; penalties?: unknown };
    expect(rich.games[0]!.boards[0]).toMatchObject({ breakerPerson: "p1", queenPerson: "p2" });
    expect(rich.penalties).toEqual([{ person: "p3", side: "home", delta: -1 }]);
  });
});

describe("carrom variants and declarations", () => {
  it("the variants are the ICF default (no overrides) and the documented club-29 rules", () => {
    expect(carrom.variants.icf).toEqual({});
    expect(carrom.variants["club-29"]).toEqual({ gameTo: 29, queenPoints: 5, queenCapAt: 24 });
  });

  it("game columns display; board and point ledgers are ledger-only operands (carrom.md §4)", () => {
    const keys = carrom.metrics.map((metric) => metric.key);
    expect(keys).toEqual(["sets_won", "sets_lost", "boards_won", "boards_lost", "points_won", "points_lost"]);
    const hidden = carrom.metrics.filter((metric) => metric.display === false).map((metric) => metric.key);
    expect(hidden).toEqual(["boards_won", "boards_lost", "points_won", "points_lost"]);
    expect(carrom.metrics.find((metric) => metric.key === "sets_won")).toMatchObject({ label: "Games won", direction: "desc" });
    expect(carrom.metrics.find((metric) => metric.key === "sets_lost")).toMatchObject({ label: "Games lost", direction: "asc" });
  });

  it("declaredPointsSets is {win+loss, 2*draw}, told apart by loss > 0 and draw != 1", () => {
    const custom = carrom.configSchema.parse({ points: { win: 3, loss: 1, draw: 1 } });
    // win+loss = 4 (a win/walkover pays 3 + 1 to the loser); a drawn match pays 1 + 1 = 2.
    expect([...carrom.declaredPointsSets(custom)].sort()).toEqual([2, 4]);
    expect([...carrom.declaredPointsSets(cfg)]).toEqual([2]); // default 2+0 and 2*1 coincide
  });

  it("player stat metrics are labelled for the stats table", () => {
    const stats = carrom.playerStats!;
    expect(stats.metrics.map((metric) => [metric.key, metric.label])).toEqual([
      ["breaks", "Breaks"],
      ["queens", "Queens"],
      ["penalties", "Penalties"],
      ["boards_won", "Boards won"],
    ]);
    expect(stats.folded!.keys).toEqual([
      { key: "matches", label: "Matches" },
      { key: "wins", label: "Wins" },
    ]);
  });
});

describe("carrom discipline projection (extractCards)", () => {
  const extract = (...specs: Array<[type: string, payload?: unknown]>) => carrom.discipline!.extractCards(stream(...specs));

  it("only carrom.game.adjust rows become cards, even when another event's payload has the same shape", () => {
    const shape = { entrantId: "H", delta: -1, reason: "foul" };
    const cards = extract(["core.note", shape], ["carrom.game.adjust", shape]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ eventId: "e-1", entrantSide: "H" });
  });

  it("an adjustment that does not parse is skipped, not a crash", () => {
    const cards = extract(["carrom.game.adjust", { entrantId: "H", delta: 0, reason: "x" }], [
      "carrom.game.adjust",
      { entrantId: "H", delta: -1, reason: "foul" },
    ]);
    expect(cards.map((card) => card.eventId)).toEqual(["e-1"]);
  });

  it("a card carries no personId key when the umpire named nobody", () => {
    const cards = extract(["carrom.game.adjust", { entrantId: "H", delta: -1, reason: "foul" }]);
    expect(Object.hasOwn(cards[0]!, "personId")).toBe(false);
  });

  it("a credit resolves the other side only when the ledger names exactly two entrants", () => {
    const credit = { entrantId: "H", delta: 2, reason: "foul by A", person: "p9" };
    // Exactly two named (H and A): the credit to H means A offended, and the person is filed under A.
    const two = extract(["carrom.game.adjust", { entrantId: "A", delta: -1, reason: "x" }], ["carrom.game.adjust", credit]);
    expect(two[1]).toMatchObject({ entrantSide: "A", personId: "p9" });
    // A third entrant id in the ledger makes "the other one" ambiguous: report the scored side, drop the person.
    const three = extract(
      ["carrom.game.adjust", { entrantId: "A", delta: -1, reason: "x" }],
      ["carrom.game.adjust", { entrantId: "X", delta: -1, reason: "x" }],
      ["carrom.game.adjust", credit],
    );
    expect(three[2]).toMatchObject({ entrantSide: "H" });
    expect(Object.hasOwn(three[2]!, "personId")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Board and adjustment application (Laws 52-55)
// ---------------------------------------------------------------------------
describe("carrom board and adjustment application", () => {
  it("a board summary or adjustment before core.start is refused naming the phase", () => {
    const board = refusal(() => fold(stream(["carrom.board.summary", { winner: "H", opponentCoinsLeft: 3 }])));
    expect(board.code).toBe("WRONG_PHASE");
    expect(board.message).toBe('board summary not allowed in phase "pre"');
    const adjust = refusal(() => fold(stream(["carrom.game.adjust", { entrantId: "H", delta: 1, reason: "foul" }])));
    expect(adjust.code).toBe("WRONG_PHASE");
    expect(adjust.message).toBe('adjustment not allowed in phase "pre"');
  });

  it("queenBy without a covering side is refused with the person named", () => {
    const error = refusal(() =>
      fold(stream(["core.start"], ["carrom.board.summary", { winner: "H", opponentCoinsLeft: 3, queenBy: "p1" }])),
    );
    expect(error.code).toBe("INVALID_EVENT");
    expect(error.message).toBe("queenBy requires a side that covered the queen");
    expect(error.data).toEqual({ queenBy: "p1" });
  });

  it("coins are worth pointsPerCoin each (Law 52(b)(ii)): 3 coins at 2 points = 6", () => {
    const two = carrom.configSchema.parse({ pointsPerCoin: 2 });
    const state = fold(stream(["core.start"], ...boards(["H", 3])), two);
    expect(state.games[0]!.boards[0]).toMatchObject({ points: 6 });
    expect(state.games[0]!.score).toEqual({ home: 6, away: 0 });
  });

  it("queenFollowsBoard credits no queen when nobody covered her (Law 53)", () => {
    const house = carrom.configSchema.parse({ queenFollowsBoard: true });
    const state = fold(stream(["core.start"], ...boards(["H", 2])), house);
    expect(state.games[0]!.boards[0]).toMatchObject({ points: 2, queenScored: false });
    // The positive pair: with a covering side the house rule does credit the board winner.
    const covered = fold(stream(["core.start"], ["carrom.board.summary", { winner: "H", opponentCoinsLeft: 2, queenTo: "A" }]), house);
    expect(covered.games[0]!.boards[0]).toMatchObject({ points: 5, queenScored: true });
  });

  it("a board without person fields stores none, and an adjustment without a person stores no penalties key", () => {
    const plain = fold(stream(["core.start"], ...boards(["H", 3]), ["carrom.game.adjust", { entrantId: "H", delta: -1, reason: "foul" }]));
    const board = plain.games[0]!.boards[0]!;
    expect(Object.hasOwn(board, "breakerPerson")).toBe(false);
    expect(Object.hasOwn(board, "queenPerson")).toBe(false);
    expect(Object.hasOwn(plain, "penalties")).toBe(false);
    const named = fold(stream(["core.start"], ["carrom.board.summary", { winner: "H", opponentCoinsLeft: 3, queenTo: "H", breaker: "b", queenBy: "q" }]));
    expect(named.games[0]!.boards[0]).toMatchObject({ breakerPerson: "b", queenPerson: "q" });
  });

  it("a strict fold refuses an adjustment below zero, with the would-be score as data; a replay clamps to 0", () => {
    const events = stream(["core.start"], ...boards(["H", 3]), ["carrom.game.adjust", { entrantId: "A", delta: -1, reason: "foul" }]);
    const error = refusal(() => fold(events));
    expect(error.code).toBe("INVALID_EVENT");
    expect(error.message).toBe("adjustment would take the game score below zero");
    expect(error.data).toEqual({ score: -1 });
    const replay = foldMatch(carrom, cfg, lineups, events);
    expect(replay.games[0]!.score.away).toBe(0);
  });
});

describe("carrom forfeit and abandon are refused once the match is over", () => {
  const live = fold(stream(["core.start"]));
  const forfeit = makeEnvelope(0, { type: "core.forfeit", payload: { by: "A", reason: "retired" } });
  const abandon = makeEnvelope(0, { type: "core.abandon", payload: {} });
  const apply = (state: CarromState, ev: EventEnvelope) => carrom.apply(state, ev as never, {} as never);

  it("each of done, final and abandoned refuses both, naming the reason", () => {
    let checked = 0;
    for (const phase of ["done", "final", "abandoned"] as const) {
      for (const ev of [forfeit, abandon]) {
        const error = refusal(() => apply({ ...live, phase }, ev));
        expect(error.code).toBe("WRONG_PHASE");
        expect(error.message).toBe("match already over");
        checked += 1;
      }
    }
    expect(checked).toBe(6);
  });

  it("the positive pair: a live match accepts a retirement and an abandon", () => {
    expect(apply(live, forfeit).phase).toBe("done");
    expect(apply(live, abandon).phase).toBe("abandoned");
  });
});

// ---------------------------------------------------------------------------
// Discipline: which events name an entrant (entrantIdsIn)
// ---------------------------------------------------------------------------
describe("carrom discipline resolves 'the other side' from every field that names an entrant", () => {
  const credit: [string, unknown] = ["carrom.game.adjust", { entrantId: "H", delta: 2, reason: "foul by the other side" }];
  const sideAfter = (...naming: Array<[string, unknown]>) =>
    carrom.discipline!.extractCards(stream(credit, ...naming))[0]!.entrantSide;

  it("with nothing naming a second entrant the credit stays on the scored side", () => {
    expect(sideAfter()).toBe("H");
  });

  it("the toss, a board's winner, a board's queenTo, an offendingEntrantId and a forfeit each name the opponent", () => {
    expect(sideAfter(["carrom.toss", { firstBreak: "A" }])).toBe("A");
    expect(sideAfter(["carrom.board.summary", { winner: "A", opponentCoinsLeft: 3 }])).toBe("A");
    expect(sideAfter(["carrom.board.summary", { winner: "H", opponentCoinsLeft: 3, queenTo: "A" }])).toBe("A");
    expect(sideAfter(["carrom.game.adjust", { entrantId: "H", delta: -1, reason: "x", offendingEntrantId: "A" }])).toBe("A");
    expect(sideAfter(["core.forfeit", { by: "A", reason: "retired" }])).toBe("A");
  });

  it("an empty id names nobody", () => {
    expect(carrom.discipline!.extractCards(stream(["core.forfeit", { by: "", reason: "retired" }], credit))[0]!.entrantSide).toBe("H");
  });

  it("null and missing payloads are skipped, not a crash", () => {
    let checked = 0;
    for (const type of ["carrom.toss", "carrom.board.summary", "carrom.game.adjust", "core.forfeit"]) {
      for (const payload of [null, undefined]) {
        const ledger = [makeEnvelope(0, { type, payload }), makeEnvelope(1, { type: credit[0], payload: credit[1] })];
        const cards = carrom.discipline!.extractCards(ledger);
        expect(cards).toHaveLength(1);
        expect(cards[0]!.entrantSide).toBe("H");
        checked += 1;
      }
    }
    expect(checked).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// The pad spec as shipped: i18n keys, English fallbacks, fields and attribution
// ---------------------------------------------------------------------------
describe("carrom padSpec declarations", () => {
  const spec = padSpec(cfg);
  const lk = (key: string, label: string) => ({ key, label });
  const action = (panel: number, i: number) => spec.panels[panel]!.actions[i]!;

  it("three panels, in order, each with its phase, layout and labelKey", () => {
    expect(spec.panels).toHaveLength(3);
    expect(spec.panels.map((p) => [p.labelKey, p.phase, p.layout])).toEqual([
      [lk("pad.carrom.panel.pre", "Pre-match"), "pre", "primary"],
      [lk("pad.carrom.panel.board", "Board"), "live", "primary"],
      [lk("pad.carrom.panel.adjust", "Umpire adjustment"), "live", "drawer"],
    ]);
    expect(spec.panels.map((p) => p.actions.length)).toEqual([1, 2, 2]);
  });

  it("the toss and board actions", () => {
    expect(action(0, 0)).toMatchObject({ type: "carrom.toss", labelKey: lk("pad.carrom.action.toss", "Toss"), fields: [], attribution: [{ kind: "side", path: "firstBreak" }] });
    expect(action(1, 0)).toMatchObject({
      type: "carrom.board.summary",
      labelKey: lk("pad.carrom.action.board", "Board (no queen)"),
      fields: [{ kind: "number", path: "opponentCoinsLeft", min: 0, max: 9 }],
      attribution: [
        { kind: "side", path: "winner" },
        { kind: "person", path: "breaker", labelKey: lk("pad.carrom.action.board.field.breaker", "Breaker") },
      ],
    });
    expect(action(1, 1)).toMatchObject({
      type: "carrom.board.summary",
      labelKey: lk("pad.carrom.action.boardQueen", "Board (queen covered)"),
      fields: [{ kind: "number", path: "opponentCoinsLeft", min: 0, max: 9 }],
      attribution: [
        { kind: "side", path: "winner" },
        { kind: "side", path: "queenTo" },
        { kind: "person", path: "breaker", labelKey: lk("pad.carrom.action.boardQueen.field.breaker", "Breaker") },
        { kind: "person", path: "queenBy", labelKey: lk("pad.carrom.action.boardQueen.field.queenBy", "Queen covered by") },
      ],
    });
  });

  it("the two umpire adjustments split at zero and are bounded by gameTo", () => {
    const attribution = [
      { kind: "side", path: "entrantId" },
      { kind: "person", path: "person" },
      { kind: "side", path: "offendingEntrantId" },
    ];
    expect(action(2, 0)).toMatchObject({
      type: "carrom.game.adjust",
      labelKey: lk("pad.carrom.action.adjustCredit", "Adjustment — credit"),
      fields: [{ kind: "number", path: "delta", min: 1, max: cfg.gameTo }, { kind: "enum", path: "reason", values: ["due_coins", "foul", "other"] }],
      attribution,
    });
    expect(action(2, 1)).toMatchObject({
      type: "carrom.game.adjust",
      labelKey: lk("pad.carrom.action.adjustDeduct", "Adjustment — deduction"),
      fields: [{ kind: "number", path: "delta", min: -cfg.gameTo, max: -1 }, { kind: "enum", path: "reason", values: ["due_coins", "foul", "other"] }],
      attribution,
    });
  });
});

// ---------------------------------------------------------------------------
// playerStats.folded: matches / wins resolved from the entrant roster
// ---------------------------------------------------------------------------
describe("carrom folded player stats need exactly two entrants", () => {
  const quick = { gameTo: 5, queenCapAt: 5, bestOf: 1 };
  const ctxOf = (ids: string[]): PlayerStatsFoldCtx => ({
    entrants: ids.map((id) => ({ id, kind: "individual" as const })),
    personsOf: (id) => [`${id}-p`],
    cfg: quick,
  });
  const clinch = stream(["core.start"], ...boards(["H", 5])); // 5 coins at 1 point ends a gameTo-5, best-of-1 match
  const rows = (ids: string[]) => aggregatePlayerStats(clinch, carrom.playerStats!, undefined, ctxOf(ids));

  it("two entrants: the decided match credits wins 1 / 0 (the positive pair)", () => {
    expect(rows(["H", "A"])).toEqual([
      { personId: "A-p", stats: { matches: 1, wins: 0 } },
      { personId: "H-p", stats: { boards_won: 1, matches: 1, wins: 1 } },
    ]);
  });

  it("three entrants: attendance for all, no wins for anybody", () => {
    expect(rows(["H", "A", "X"])).toEqual([
      { personId: "A-p", stats: { matches: 1 } },
      { personId: "H-p", stats: { boards_won: 1, matches: 1 } },
      { personId: "X-p", stats: { matches: 1 } },
    ]);
  });

  it("one entrant: the fold does not throw and credits attendance only", () => {
    expect(rows(["H"])).toEqual([{ personId: "H-p", stats: { boards_won: 1, matches: 1 } }]);
  });
});
