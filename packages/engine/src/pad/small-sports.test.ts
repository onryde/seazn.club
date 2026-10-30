// Pad wave P4.1 - carromPadRules, boardgamePadRules, genericPadRules: the facts the v3 carrom, chess and generic skins used to copy,
// declared once in the sport modules and read by the pad.
//
// Three kinds of check, because a declaration that padSpec AND the record both read agrees with itself by construction:
//   1. IDENTITY - the record's value IS the module's declaration (toBe), and equals the padSpec field the pad renders, for every cfg.
//   2. BEHAVIOUR - the REAL strict fold (the scorer's path) is put to each bound: what it refuses and what it takes. Three of the
//      bounds turned out to be the PAD's, not the fold's (the board number, the final score, one tally press: the schema takes any
//      positive or non-negative integer), and the tests below say so by feeding the fold the value one past the bound.
//   3. RULEBOOK - the values typed here come from the rule rows (packages/engine/rules/{carrom,boardgame,generic}.md), never from
//      the constant under test, so a changed constant reds even though padSpec, the record and the skin would all follow it.
// Every sweep reports how many items it compared and fails on zero.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../core/events.ts";
import type { ModuleEvent, PadSpec } from "../sport/module.ts";
import {
  ARMAGEDDON_RESULTS,
  BOARDGAME_EVENT_SCHEMAS,
  BOARDGAME_FIDELITY,
  BOARD_MAX,
  BoardgameArmageddon,
  BoardgameRungTiebreak,
  CHESS_SCORE,
  TIEBREAK_RUNGS,
  TIEBREAK_SCORES,
  boardgame,
  type BoardgameCfg,
} from "../sports/boardgame/boardgame.ts";
import {
  ADJUST_REASONS,
  CARROM_EVENT_SCHEMAS,
  CARROM_FIDELITY,
  CarromBoardSummary,
  OPPONENT_COINS_MAX,
  carrom,
  type CarromCfg,
} from "../sports/carrom/carrom.ts";
import {
  GENERIC_EVENT_SCHEMAS,
  GENERIC_FIDELITY,
  MAX_PLAUSIBLE_SCORE,
  MAX_TALLY_STEP,
  generic,
  type GenericCfg,
} from "../sports/generic/generic.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";
import { boardgamePadRules, carromPadRules, genericPadRules, padEnumValues, padNumberBound } from "./index.ts";

const STRICT_ALL = { strictFromSeq: 0 } as const;
const envelopes = (events: readonly ModuleEvent[]): EventEnvelope[] => events.map((event, i) => makeEnvelope(i, event));
const start: ModuleEvent = { type: "core.start", payload: {} };

/** A sweep reports what it compared; the same count is asserted non-zero beside each report. */
function report(line: string): void {
  // eslint-disable-next-line no-console -- the sweep reports what it checked; the same counts are asserted beside it
  console.info(`[pad/small-sports] ${line}`);
}

/** The refusal (code and message) the strict fold gives `run`, or null when it takes it. Anything but an EngineError rethrows. */
function refusal(run: () => unknown): { code: string; message: string } | null {
  try {
    run();
    return null;
  } catch (error) {
    if (!(error instanceof EngineError)) throw error;
    return { code: error.code, message: error.message };
  }
}

const specOf = (module: { padSpec?: (cfg: never) => PadSpec }, cfg: unknown): PadSpec => {
  if (module.padSpec === undefined) throw new Error("premise: the module declares a padSpec");
  return module.padSpec(cfg as never);
};

// ---------------------------------------------------------------------------------------------------------------------------
// carrom
// ---------------------------------------------------------------------------------------------------------------------------

const carromLineups = defaultLineupPair(carrom.positions);
const CH = carromLineups.home.entrantId;
const carromFold = (cfg: CarromCfg, events: readonly ModuleEvent[]) => foldMatch(carrom, cfg, carromLineups, envelopes(events), STRICT_ALL);
const carromBoard = (coins: number): ModuleEvent => ({ type: "carrom.board.summary", payload: { winner: CH, opponentCoinsLeft: coins } });
const carromAdjust = (entrantId: string, delta: number, reason = "foul"): ModuleEvent => ({
  type: "carrom.game.adjust",
  payload: { entrantId, delta, reason },
});
const CREDIT = "pad.carrom.action.adjustCredit";
const DEDUCT = "pad.carrom.action.adjustDeduct";
const carromCfgs = (): { name: string; cfg: CarromCfg }[] => declaredCfgs<CarromCfg>(carrom);

describe("carromPadRules", () => {
  it("is a frozen record, and its eventBands is the very fidelity map every cfg's padSpec carries, one band per registered event type (counted)", () => {
    expect(Object.isFrozen(carromPadRules)).toBe(true);
    expect(carromPadRules.eventBands).toBe(CARROM_FIDELITY);
    expect(Object.isFrozen(carromPadRules.eventBands)).toBe(true);
    let cfgs = 0;
    for (const { name, cfg } of carromCfgs()) {
      expect(specOf(carrom, cfg).fidelity, name).toBe(carromPadRules.eventBands);
      cfgs++;
    }
    expect(Object.keys(carromPadRules.eventBands).sort()).toEqual(Object.keys(CARROM_EVENT_SCHEMAS).sort());
    expect(Object.keys(CARROM_EVENT_SCHEMAS).sort()).toEqual(Object.keys(carrom.eventSchemas ?? {}).sort());
    report(`carrom fidelity maps compared: ${cfgs}`);
    expect(cfgs).toBeGreaterThanOrEqual(2);
  });

  it("CA-AD-2: adjustReasons is the module's ADJUST_REASONS, the enum of BOTH adjust actions for every cfg, and the three the row names (counted)", () => {
    expect(carromPadRules.adjustReasons).toBe(ADJUST_REASONS);
    // the rule row: coins due, a foul, anything else - typed from the row, not from the constant
    expect([...carromPadRules.adjustReasons]).toEqual(["due_coins", "foul", "other"]);
    let compared = 0;
    for (const { name, cfg } of carromCfgs()) {
      const spec = specOf(carrom, cfg);
      for (const action of [CREDIT, DEDUCT]) {
        expect(padEnumValues(spec, "carrom.game.adjust", "reason", { action }), `${name} ${action}`).toEqual([...carromPadRules.adjustReasons]);
        compared++;
      }
    }
    report(`carrom adjust-reason enums compared: ${compared}`);
    expect(compared).toBeGreaterThanOrEqual(2 * 2);
  });

  it("CA-AD-2: the list is the pad's vocabulary, not the fold's - the schema keeps the reason free text, so the fold takes a reason outside it", () => {
    let folded = 0;
    for (const reason of [...carromPadRules.adjustReasons, "spilled coin"]) {
      const state = carromFold(carromCfgs()[0]!.cfg, [start, carromAdjust(CH, 2, reason)]);
      expect(state.phase, reason).toBe("live");
      folded++;
    }
    expect(folded).toBe(carromPadRules.adjustReasons.length + 1);
    expect(refusal(() => carromFold(carromCfgs()[0]!.cfg, [start, carromAdjust(CH, 2, "")]))?.code, "an empty reason is still refused").toBe("INVALID_EVENT");
  });

  it("CA-CN-1: opponentCoinsMax is the schema's max AND both board actions' padSpec max, for every cfg, and it is the nine coins a side the Laws play (counted)", () => {
    expect(carromPadRules.opponentCoinsMax).toBe(OPPONENT_COINS_MAX);
    expect(carromPadRules.opponentCoinsMax).toBe(CarromBoardSummary.shape.opponentCoinsLeft.maxValue);
    // ICF Laws of Carrom 52(b)(ii), 53(a): nine coins a side, so the winner's opponent can have at most nine left on the board
    expect(carromPadRules.opponentCoinsMax).toBe(9);
    let compared = 0;
    for (const { name, cfg } of carromCfgs()) {
      const spec = specOf(carrom, cfg);
      for (const action of ["pad.carrom.action.board", "pad.carrom.action.boardQueen"]) {
        expect(padNumberBound(spec, "carrom.board.summary", "opponentCoinsLeft", { action }), `${name} ${action}`).toEqual({ min: 0, max: carromPadRules.opponentCoinsMax });
        compared++;
      }
    }
    report(`carrom coin bounds compared: ${compared}`);
    expect(compared).toBeGreaterThanOrEqual(2 * 2);
  });

  it("CA-CN-1: the strict fold takes a board with the most coins left and refuses one more, or a negative count (the bound is the fold's own)", () => {
    const { cfg } = carromCfgs()[0]!;
    const max = carromPadRules.opponentCoinsMax;
    expect(carromFold(cfg, [start, carromBoard(max)]).phase).toBe("live");
    expect(carromFold(cfg, [start, carromBoard(0)]).phase).toBe("live");
    expect(refusal(() => carromFold(cfg, [start, carromBoard(max + 1)]))?.code).toBe("INVALID_EVENT");
    expect(refusal(() => carromFold(cfg, [start, carromBoard(-1)]))?.code).toBe("INVALID_EVENT");
  });

  it("CA-FM-1: bestOf and gameTo are the cfg's, read through carrom's own schema: the ICF defaults 3 and 25, club-29's 29, and an invalid cfg throws (counted)", () => {
    // ICF Laws of Carrom 56(a), 57 (the CA-FM-1 row): a game to 25, the best of three games; CA-VR-1: club-29 plays to 29
    expect(carromPadRules.bestOf({})).toBe(3);
    expect(carromPadRules.gameTo({})).toBe(25);
    expect(carromPadRules.gameTo(carrom.variants["club-29"])).toBe(29);
    expect(carromPadRules.bestOf(carrom.variants["club-29"])).toBe(3);
    expect(carromPadRules.bestOf({ bestOf: 5 })).toBe(5);
    expect(carromPadRules.gameTo({ gameTo: 29 }), "a partial cfg reads the schema default for the rest").toBe(29);
    let compared = 0;
    for (const { name, cfg } of carromCfgs()) {
      expect(carromPadRules.bestOf(cfg), name).toBe(cfg.bestOf);
      expect(carromPadRules.gameTo(cfg), name).toBe(cfg.gameTo);
      compared += 2;
    }
    // the schema's own refusals, not a fallback typed in the record: an even bestOf has no decider, queenCapAt may not exceed gameTo
    expect(() => carromPadRules.bestOf({ bestOf: 4 })).toThrow(/odd/);
    expect(() => carromPadRules.gameTo({ gameTo: 10 })).toThrow(/queenCapAt/);
    expect(() => carromPadRules.gameTo(null)).toThrow();
    expect(() => carromPadRules.bestOf(undefined)).toThrow();
    report(`carrom cfg reads compared: ${compared}`);
    expect(compared).toBeGreaterThanOrEqual(2 * 2);
  });

  it("CA-AD-1: the adjust bound the pad offers is the gameTo the strict fold enforces, at both gameTo values (credit offered to gameTo, one more refused ADJUST_OUT_OF_RANGE) (counted)", () => {
    const gameTos = new Set<number>();
    let checked = 0;
    for (const { name, cfg } of carromCfgs()) {
      const gameTo = carromPadRules.gameTo(cfg);
      const spec = specOf(carrom, cfg);
      expect(padNumberBound(spec, "carrom.game.adjust", "delta", { action: CREDIT }), name).toEqual({ min: 1, max: gameTo });
      expect(padNumberBound(spec, "carrom.game.adjust", "delta", { action: DEDUCT }), name).toEqual({ min: -gameTo, max: -1 });
      // the fold: a credit of gameTo points is taken, one more is out of range; a deduction judges the range BEFORE the below-zero rule
      expect(refusal(() => carromFold(cfg, [start, carromAdjust(CH, gameTo)])), `${name} credit gameTo`).toBeNull();
      expect(refusal(() => carromFold(cfg, [start, carromAdjust(CH, gameTo + 1)]))?.code, `${name} credit gameTo+1`).toBe("ADJUST_OUT_OF_RANGE");
      expect(refusal(() => carromFold(cfg, [start, carromAdjust(CH, -(gameTo + 1))]))?.code, `${name} deduct gameTo+1`).toBe("ADJUST_OUT_OF_RANGE");
      // at exactly gameTo a deduction is inside the range: the refusal is the below-zero rule's, not the range's
      expect(refusal(() => carromFold(cfg, [start, carromAdjust(CH, -gameTo)]))?.code, `${name} deduct gameTo`).toBe("INVALID_EVENT");
      gameTos.add(gameTo);
      checked++;
    }
    report(`carrom adjust bounds checked: ${checked} cfgs, gameTo values ${[...gameTos].sort().join("/")}`);
    expect([...gameTos].sort((a, b) => a - b)).toEqual([25, 29]);
    expect(checked).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// boardgame
// ---------------------------------------------------------------------------------------------------------------------------

const boardLineups = defaultLineupPair(boardgame.positions);
const BH = boardLineups.home.entrantId;
const BA = boardLineups.away.entrantId;
const boardFold = (cfg: BoardgameCfg, events: readonly ModuleEvent[]) => foldMatch(boardgame, cfg, boardLineups, envelopes(events), STRICT_ALL);
const boardgameCfgs = (): { name: string; cfg: BoardgameCfg }[] => declaredCfgs<BoardgameCfg>(boardgame);
/** A bracket cfg, which sends a drawn game to its tie-break (BG-KO-1), with the rungs the stage lists. */
const koCfg = (rungs?: readonly string[]): BoardgameCfg =>
  boardgame.configSchema.parse({ ...boardgame.bracketDeciders(boardgame.configSchema.parse({})), ...(rungs === undefined ? {} : { tiebreakRungs: rungs }) });
const drawnGame: ModuleEvent[] = [start, { type: "boardgame.result", payload: { winner: null, method: "agreement" } }];
const tiebreak = (payload: unknown): ModuleEvent => ({ type: "boardgame.tiebreak", payload });

describe("boardgamePadRules", () => {
  it("is a frozen record, and its eventBands is the very fidelity map every cfg's padSpec carries, one band per registered event type (counted)", () => {
    expect(Object.isFrozen(boardgamePadRules)).toBe(true);
    expect(boardgamePadRules.eventBands).toBe(BOARDGAME_FIDELITY);
    expect(Object.isFrozen(boardgamePadRules.eventBands)).toBe(true);
    let cfgs = 0;
    for (const { name, cfg } of [...boardgameCfgs(), { name: "a bracket with a tie-break", cfg: koCfg() }]) {
      expect(specOf(boardgame, cfg).fidelity, name).toBe(boardgamePadRules.eventBands);
      cfgs++;
    }
    expect(Object.keys(boardgamePadRules.eventBands).sort()).toEqual(Object.keys(BOARDGAME_EVENT_SCHEMAS).sort());
    expect(Object.keys(BOARDGAME_EVENT_SCHEMAS).sort()).toEqual(Object.keys(boardgame.eventSchemas ?? {}).sort());
    report(`boardgame fidelity maps compared: ${cfgs}`);
    expect(cfgs).toBeGreaterThanOrEqual(3);
  });

  it("BG-PA-1: boardMax is the module's BOARD_MAX, the padSpec bound of the pairing card's board field for every cfg, and 200 as the row states it (counted)", () => {
    expect(boardgamePadRules.boardMax).toBe(BOARD_MAX);
    // the row: the pad bounds a board number at 200 (a generous plausibility bound, not a chess rule) - typed from the row
    expect(boardgamePadRules.boardMax).toBe(200);
    let compared = 0;
    for (const { name, cfg } of [...boardgameCfgs(), { name: "a bracket with a tie-break", cfg: koCfg() }]) {
      expect(padNumberBound(specOf(boardgame, cfg), "boardgame.pairing", "board"), name).toEqual({ min: 1, max: boardgamePadRules.boardMax });
      compared++;
    }
    report(`boardgame board bounds compared: ${compared}`);
    expect(compared).toBeGreaterThanOrEqual(3);
  });

  it("BG-PA-1: the bound is the PAD's - the strict fold takes the board number at the bound and one past it, and refuses 0 (a positive integer is the schema's)", () => {
    const { cfg } = boardgameCfgs()[0]!;
    const board = (n: number): ModuleEvent => ({ type: "boardgame.pairing", payload: { board: n } });
    const max = boardgamePadRules.boardMax;
    expect(boardFold(cfg, [start, board(1)]).board).toBe(1);
    expect(boardFold(cfg, [start, board(max)]).board).toBe(max);
    expect(boardFold(cfg, [start, board(max + 1)]).board, "the fold has no ceiling of its own").toBe(max + 1);
    expect(refusal(() => boardFold(cfg, [start, board(0)]))?.code).toBe("INVALID_EVENT");
  });

  it("BG-KO-4: tiebreakScores is the module's TIEBREAK_SCORES - no score, the narrow 1½–½ and the clean 2–0 as the row names them", () => {
    expect(boardgamePadRules.tiebreakScores).toBe(TIEBREAK_SCORES);
    expect(Object.isFrozen(TIEBREAK_SCORES)).toBe(true);
    // the row: a two-game mini-match is won 2–0 or 1½–½ (from the winner's side), or the score is not recorded - typed from the row
    expect(new Set(boardgamePadRules.tiebreakScores)).toEqual(new Set([null, "1½–½", "2–0"]));
    expect(boardgamePadRules.tiebreakScores).toHaveLength(3);
  });

  it("BG-KO-4: every score offered is one the strict fold takes on a rapid and a blitz tie-break and stores; the schema is wider than the offer (3–1 is taken, 2-0 is not) (counted)", () => {
    let folded = 0;
    for (const rung of BoardgameRungTiebreak.shape.rung.options) {
      for (const score of boardgamePadRules.tiebreakScores) {
        const payload = score === null ? { rung, winner: BH } : { rung, winner: BH, score };
        const state = boardFold(koCfg(), [...drawnGame, tiebreak(payload)]);
        expect(state.phase, `${rung} ${String(score)}`).toBe("done");
        expect(state.tiebreak, `${rung} ${String(score)}`).toEqual(score === null ? { rung } : { rung, score });
        if (score !== null) expect(CHESS_SCORE.test(score), score).toBe(true);
        folded++;
      }
    }
    expect(folded).toBe(2 * boardgamePadRules.tiebreakScores.length);
    expect(boardFold(koCfg(), [...drawnGame, tiebreak({ rung: "rapid", winner: BH, score: "3–1" })]).tiebreak).toEqual({ rung: "rapid", score: "3–1" });
    expect(refusal(() => boardFold(koCfg(), [...drawnGame, tiebreak({ rung: "rapid", winner: BH, score: "2-0" })]))?.code, "a hyphen is not an en dash").toBe("INVALID_EVENT");
    report(`boardgame tie-break scores folded: ${folded}`);
    expect(folded).toBeGreaterThan(0);
  });

  it("BG-KO-2: armageddonRung is the one rung whose payload records Black and the result; the timed rungs record a winner - the rungs partition (counted)", () => {
    expect(boardgamePadRules.armageddonRung).toBe(BoardgameArmageddon.shape.rung.value);
    expect(boardgamePadRules.armageddonRung).toBe("armageddon");
    const timed = BoardgameRungTiebreak.shape.rung.options;
    // the engine's own three rungs are exactly the timed ones plus the Armageddon, with nothing in both
    expect([...timed, boardgamePadRules.armageddonRung].sort()).toEqual([...TIEBREAK_RUNGS].sort());
    expect(timed).not.toContain(boardgamePadRules.armageddonRung);
    expect(Object.keys(BoardgameArmageddon.shape).filter((key) => key !== "rung").sort()).toEqual(["black", "result"]);
    expect(Object.keys(BoardgameRungTiebreak.shape).filter((key) => key !== "rung").sort()).toEqual(["score", "winner"]);
  });

  it("BG-KO-2: the strict fold takes the Armageddon's Black-and-result payload and refuses a winner on it, and takes a timed rung's winner and refuses Black and a result on it (counted)", () => {
    const cfg = koCfg();
    let checked = 0;
    const armageddon = boardgamePadRules.armageddonRung;
    for (const result of ARMAGEDDON_RESULTS) {
      expect(boardFold(cfg, [...drawnGame, tiebreak({ rung: armageddon, black: BA, result })]).phase, result).toBe("done");
      checked++;
    }
    // naming a winner is no way to record an Armageddon: with no Black it is refused by name (TIEBREAK_COLOUR_REQUIRED), and with Black
    // and a result the winner is one key too many for the strict branch
    expect(refusal(() => boardFold(cfg, [...drawnGame, tiebreak({ rung: armageddon, winner: BH })]))?.code, "an Armageddon names no winner").toBe("TIEBREAK_COLOUR_REQUIRED");
    expect(refusal(() => boardFold(cfg, [...drawnGame, tiebreak({ rung: armageddon, black: BA, result: "black", winner: BH })]))?.code).toBe("INVALID_EVENT");
    checked += 2;
    for (const rung of BoardgameRungTiebreak.shape.rung.options) {
      expect(boardFold(cfg, [...drawnGame, tiebreak({ rung, winner: BH })]).phase, rung).toBe("done");
      expect(refusal(() => boardFold(cfg, [...drawnGame, tiebreak({ rung, black: BA, result: "black" })]))?.code, `${rung} with Black and a result`).toBe("INVALID_EVENT");
      checked += 2;
    }
    report(`boardgame tie-break payload shapes checked: ${checked}`);
    expect(checked).toBe(ARMAGEDDON_RESULTS.length + 2 + 2 * BoardgameRungTiebreak.shape.rung.options.length);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// generic
// ---------------------------------------------------------------------------------------------------------------------------

const genericLineups = defaultLineupPair(generic.positions);
const GH = genericLineups.home.entrantId;
const genericFold = (cfg: GenericCfg, events: readonly ModuleEvent[]) => foldMatch(generic, cfg, genericLineups, envelopes(events), STRICT_ALL);
const genericCfgs = (): { name: string; cfg: GenericCfg }[] => declaredCfgs<GenericCfg>(generic);
const scoreCfgs = (): { name: string; cfg: GenericCfg }[] => genericCfgs().filter(({ cfg }) => cfg.resultMode === "score");
const ADD = "pad.generic.action.addPoints";
const CORRECT = "pad.generic.action.correctPoints";
const press = (points: number): ModuleEvent => ({ type: "generic.score", payload: { by: GH, points } });
const finalScore = (p1Score: number, p2Score: number): ModuleEvent => ({ type: "generic.result", payload: { p1Score, p2Score } });

describe("genericPadRules", () => {
  it("is a frozen record, and its eventBands is the very fidelity map every cfg's padSpec carries, one band per registered event type (counted)", () => {
    expect(Object.isFrozen(genericPadRules)).toBe(true);
    expect(genericPadRules.eventBands).toBe(GENERIC_FIDELITY);
    expect(Object.isFrozen(genericPadRules.eventBands)).toBe(true);
    let cfgs = 0;
    for (const { name, cfg } of genericCfgs()) {
      expect(specOf(generic, cfg).fidelity, name).toBe(genericPadRules.eventBands);
      cfgs++;
    }
    expect(Object.keys(genericPadRules.eventBands).sort()).toEqual(Object.keys(GENERIC_EVENT_SCHEMAS).sort());
    expect(Object.keys(GENERIC_EVENT_SCHEMAS).sort()).toEqual(Object.keys(generic.eventSchemas ?? {}).sort());
    report(`generic fidelity maps compared: ${cfgs}`);
    expect(cfgs).toBeGreaterThanOrEqual(2);
  });

  it("GN-SC-1: maxPlausibleScore is the module's MAX_PLAUSIBLE_SCORE, the padSpec bound of both final-score fields of every score-mode cfg, and 500 as the row states it (counted)", () => {
    expect(genericPadRules.maxPlausibleScore).toBe(MAX_PLAUSIBLE_SCORE);
    // the row: the pad bounds a typed final score at 500 (a generous plausibility bound for a sport the product does not model)
    expect(genericPadRules.maxPlausibleScore).toBe(500);
    let compared = 0;
    for (const { name, cfg } of scoreCfgs()) {
      for (const path of ["p1Score", "p2Score"]) {
        expect(padNumberBound(specOf(generic, cfg), "generic.result", path), `${name} ${path}`).toEqual({ min: 0, max: genericPadRules.maxPlausibleScore });
        compared++;
      }
    }
    report(`generic score bounds compared: ${compared}`);
    expect(scoreCfgs().length).toBeGreaterThan(0);
    expect(compared).toBe(2 * scoreCfgs().length);
  });

  it("GN-SC-1: the bound is the PAD's - the strict fold takes a final score at the bound and one past it, and refuses a negative one", () => {
    const { cfg } = scoreCfgs()[0]!;
    const max = genericPadRules.maxPlausibleScore;
    expect(genericFold(cfg, [start, finalScore(max, 3)]).score).toEqual({ home: max, away: 3 });
    expect(genericFold(cfg, [start, finalScore(max + 1, 3)]).score, "the fold has no ceiling of its own").toEqual({ home: max + 1, away: 3 });
    expect(refusal(() => genericFold(cfg, [start, finalScore(-1, 3)]))?.code).toBe("INVALID_EVENT");
  });

  it("GN-SC-2: maxTallyStep is the module's MAX_TALLY_STEP, the padSpec bound of one press (add 1..step, correct -step..-1) for every cfg, and 50 as the row states it (counted)", () => {
    expect(genericPadRules.maxTallyStep).toBe(MAX_TALLY_STEP);
    // the row: one tally press moves the tally by at most 50 on the pad - typed from the row
    expect(genericPadRules.maxTallyStep).toBe(50);
    let compared = 0;
    for (const { name, cfg } of genericCfgs()) {
      const spec = specOf(generic, cfg);
      expect(padNumberBound(spec, "generic.score", "points", { action: ADD }), `${name} add`).toEqual({ min: 1, max: genericPadRules.maxTallyStep });
      expect(padNumberBound(spec, "generic.score", "points", { action: CORRECT }), `${name} correct`).toEqual({ min: -genericPadRules.maxTallyStep, max: -1 });
      compared += 2;
    }
    report(`generic tally bounds compared: ${compared}`);
    expect(compared).toBe(2 * genericCfgs().length);
    expect(compared).toBeGreaterThanOrEqual(2 * 2);
  });

  it("GN-SC-2: the bound is the PAD's - the strict fold takes a press of the step and one more, refuses 0, and refuses a correction below zero (the sequence)", () => {
    const { cfg } = scoreCfgs()[0]!;
    const step = genericPadRules.maxTallyStep;
    expect(genericFold(cfg, [start, press(step)]).running).toEqual({ home: step, away: 0 });
    expect(genericFold(cfg, [start, press(step + 1)]).running, "the fold has no ceiling of its own").toEqual({ home: step + 1, away: 0 });
    expect(refusal(() => genericFold(cfg, [start, press(0)]))?.code).toBe("INVALID_EVENT");
    // a second call, and a correction: the tally comes back down, and cannot go under zero
    expect(genericFold(cfg, [start, press(step), press(-step)]).running).toEqual({ home: 0, away: 0 });
    expect(refusal(() => genericFold(cfg, [start, press(step), press(-(step + 1))]))?.code).toBe("INVALID_EVENT");
  });
});

describe("the three records together", () => {
  it("each is a frozen record keyed to a registered sport with a padSpec, and each owns at least one event band (counted)", () => {
    const records = [
      ["carrom", carromPadRules, carrom],
      ["boardgame", boardgamePadRules, boardgame],
      ["generic", genericPadRules, generic],
    ] as const;
    let checked = 0;
    for (const [key, rules, module] of records) {
      expect(module.key, key).toBe(key);
      expect(module.padSpec, key).toBeDefined();
      expect(Object.isFrozen(rules), key).toBe(true);
      expect(Object.keys(rules.eventBands).length, key).toBeGreaterThan(0);
      for (const type of Object.keys(rules.eventBands)) {
        expect(Object.keys(module.eventSchemas ?? {}), `${key} ${type}`).toContain(type);
        checked++;
      }
    }
    report(`event bands checked against the registered event types: ${checked}`);
    expect(checked).toBe(3 + 3 + 2);
  });
});
