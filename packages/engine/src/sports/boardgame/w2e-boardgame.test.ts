// W2e Task 10 (A1e-1, RB2B-20) — BG-RS-1: a board-game result's method must agree with its winner.
//
// The classes are the Laws', never the engine's. FIDE Laws of Chess (2023), Arts 5.1, 5.2 and 9.2-9.6: a game is WON by
// checkmate (5.1.1), by the opponent's resignation (5.1.2), on time (6.9: the flag falls) and by the loss an arbiter
// awards for a second illegal move (7.5.5); it is DRAWN by stalemate (5.2.1), a dead position (5.2.2), agreement (5.2.3 /
// 9.1), threefold or fivefold repetition (9.2 / 9.6.1), the fifty- or seventy-five-move rule (9.3 / 9.6.2), and on time
// against insufficient mating material (6.9). An arbiter's ruling can go either way, so `adjudication` is the one method
// both classes hold. `forfeit` and `double_forfeit` are retired on write (W2b D15) and are not results of play.
//
// single-sport: the method/winner pairing exists only on the board-game module's `boardgame.result`; no other sport's
// result event carries a method beside a winner, and the module is cfg-independent (a declared-cfg sweep below reports
// its count rather than assuming it).
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import { declaredCfgs } from "../../testkit/declared-cfgs.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/index.ts";
import { boardgame, BoardgameMethod, type BoardgameCfg } from "./boardgame.ts";
import { DECISIVE_METHODS, DRAWN_METHODS } from "./index.ts";

/** Every write below is PAD-SHAPED: the whole stream is new (`strictFromSeq: 0`), the write path. */
const STRICT_ALL = { strictFromSeq: 0 } as const;

const lineups = defaultLineupPair(boardgame.positions); // entrants H / A
const cfg = boardgame.configSchema.parse({});

/** The Laws' class of each method a player can reach by play. The retired forfeit pair is not a result of play. */
const FIDE_CLASS: Readonly<Record<string, "decisive" | "drawn" | "either">> = {
  checkmate: "decisive", //     5.1.1
  resign: "decisive", //        5.1.2
  time: "decisive", //          6.9
  illegal_move: "decisive", //  7.5.5
  agreement: "drawn", //        5.2.3 / 9.1
  stalemate: "drawn", //        5.2.1
  insufficient: "drawn", //     6.9, flag against insufficient material
  repetition: "drawn", //       9.2 / 9.6.1
  fifty_move: "drawn", //       9.3 / 9.6.2
  dead_position: "drawn", //    5.2.2
  adjudication: "either", //    5.2: the arbiter's ruling
};
const RETIRED = ["forfeit", "double_forfeit"] as const;

type Spec = [type: string, payload?: unknown, voids?: string];
const ledger = (specs: readonly Spec[]): EventEnvelope[] =>
  specs.map(([type, payload, voids], i) => makeEnvelope(i, { type, payload: payload ?? {} }, voids));

const strictFold = (specs: readonly Spec[], config: BoardgameCfg = cfg) => foldMatch(boardgame, config, lineups, ledger(specs), STRICT_ALL);

function refusalOf(fn: () => unknown): EngineError | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof EngineError) return err;
    throw err;
  }
}

/** The three shapes a result can name a winner in: an entrant, an explicit null, and the key left out (read as null). */
const SHAPES: readonly { name: string; winner: "winner" | "null" | "absent"; payload: (method: string) => Record<string, unknown> }[] = [
  { name: "winner H", winner: "winner", payload: (method) => ({ winner: "H", method }) },
  { name: "winner null", winner: "null", payload: (method) => ({ winner: null, method }) },
  { name: "winner omitted", winner: "absent", payload: (method) => ({ method }) },
];

describe("BG-RS-1 the Laws' classes and the engine's lists", () => {
  it("BG-RS-1 the rulebook table covers every method of play the engine declares, and the engine's lists are its partition", () => {
    const declared = BoardgameMethod.options.filter((m) => !(RETIRED as readonly string[]).includes(m)).sort();
    expect(Object.keys(FIDE_CLASS).sort(), "a method was added to the engine without a rulebook class (or the reverse)").toEqual(declared);
    const decisive = Object.entries(FIDE_CLASS).filter(([, c]) => c !== "drawn").map(([m]) => m);
    const drawn = Object.entries(FIDE_CLASS).filter(([, c]) => c !== "decisive").map(([m]) => m);
    expect([...DECISIVE_METHODS].sort()).toEqual(decisive.sort());
    expect([...DRAWN_METHODS].sort()).toEqual(drawn.sort());
    // The anchors that make the partition meaningful: 5 decisive, 7 drawn, one in both.
    expect([DECISIVE_METHODS.length, DRAWN_METHODS.length]).toEqual([5, 7]);
    expect(DECISIVE_METHODS.filter((m) => (DRAWN_METHODS as readonly string[]).includes(m))).toEqual(["adjudication"]);
  });
});

describe("BG-RS-1 a result's method must agree with its winner (RB2B-20)", () => {
  it("BG-RS-1 every method × winner shape: a contradiction is refused RESULT_METHOD_CONTRADICTS_WINNER, everything else is accepted", () => {
    const methods = Object.keys(FIDE_CLASS);
    let checked = 0;
    let refused = 0;
    let accepted = 0;
    for (const method of methods) {
      const klass = FIDE_CLASS[method]!;
      for (const shape of SHAPES) {
        // Decisive needs a winner, drawn needs none, `adjudication` (either) is free in every shape.
        const contradicts = (klass === "decisive" && shape.winner !== "winner") || (klass === "drawn" && shape.winner === "winner");
        const err = refusalOf(() => strictFold([["core.start"], ["boardgame.result", shape.payload(method)]]));
        const label = `${method} / ${shape.name}`;
        if (contradicts) {
          expect(err, label).not.toBeNull();
          expect(err!.code, label).toBe("RESULT_METHOD_CONTRADICTS_WINNER");
          refused++;
        } else {
          expect(err, label).toBeNull();
          accepted++;
        }
        checked++;
      }
    }
    // 11 methods of play × 3 shapes. Per class: 4 decisive refused in 2 shapes, 6 drawn refused in 1, adjudication in none.
    expect(checked, "methods × shapes").toBe(methods.length * SHAPES.length);
    expect(checked).toBe(33);
    expect(refused).toBe(4 * 2 + 6 * 1);
    expect(accepted).toBe(33 - 14);
  });

  it("BG-RS-1 the old behaviour accepted both contradictions: a win by stalemate and a drawn checkmate", () => {
    // At BASE these folded to a `win` by stalemate and to a `draw` by checkmate (see the replay test below). Now both are
    // refused, with the refusal naming the method and the winner it was given.
    const win = refusalOf(() => strictFold([["core.start"], ["boardgame.result", { winner: "H", method: "stalemate" }]]));
    expect(win).toMatchObject({ code: "RESULT_METHOD_CONTRADICTS_WINNER", data: { method: "stalemate", winner: "H" } });
    const draw = refusalOf(() => strictFold([["core.start"], ["boardgame.result", { winner: null, method: "checkmate" }]]));
    expect(draw).toMatchObject({ code: "RESULT_METHOD_CONTRADICTS_WINNER", data: { method: "checkmate", winner: null } });
    // The sentence the scorer reads: one message for both directions.
    expect(win!.message).toBe(draw!.message);
    expect(win!.message).toBe("the method does not fit the result: a win needs checkmate, resignation, time, illegal move or adjudication, and a draw needs a drawing method");
  });

  it("BG-RS-1 an absent method is free in every winner shape, and the extras ride along", () => {
    for (const result of [{ winner: "H" }, { winner: "A", moves: 31 }, { winner: null }, { moves: 40 }, { winner: "H", winnerPerson: "H-p1" }]) {
      const state = strictFold([["core.start"], ["boardgame.result", result]]);
      expect(state.phase, JSON.stringify(result)).toBe("done");
    }
    // A contradiction is refused whatever else the payload carries.
    expect(refusalOf(() => strictFold([["core.start"], ["boardgame.result", { winner: "H", method: "agreement", moves: 40, winnerPerson: "H-p1" }]]))?.code).toBe(
      "RESULT_METHOD_CONTRADICTS_WINNER",
    );
  });

  it("BG-RS-1 sequence: refused every time, refused again after a void, and a coherent result after the void still folds", () => {
    const bad: Spec = ["boardgame.result", { winner: "A", method: "dead_position" }];
    const good: Spec = ["boardgame.result", { winner: "A", method: "resign" }];
    // Second call: the same refusal, nothing latched by the first.
    for (let call = 0; call < 2; call++) {
      expect(refusalOf(() => strictFold([["core.start"], bad]))?.code, `call ${call + 1}`).toBe("RESULT_METHOD_CONTRADICTS_WINNER");
    }
    // After a void: a coherent result is voided (the game reopens), then the contradiction is refused as a new write.
    const reopened: Spec[] = [["core.start"], good, ["core.void", {}, "e-1"]];
    expect(strictFold(reopened).phase).toBe("live");
    expect(refusalOf(() => strictFold([...reopened, bad]))?.code).toBe("RESULT_METHOD_CONTRADICTS_WINNER");
    expect(strictFold([...reopened, ["boardgame.result", { winner: null, method: "dead_position" }]]).outcome).toEqual({ kind: "draw" });
    // A refused write leaves the ledger as it was: the coherent result after it is the same fold as without it.
    expect(strictFold([["core.start"], good]).outcome).toEqual({ kind: "win", winner: "A", loser: "H", method: "resign" });
  });

  it("BG-RS-1 a decisive method folds to its win, and a drawn one to its draw, on every declared cfg", () => {
    const cfgs = declaredCfgs<BoardgameCfg>(boardgame);
    let checked = 0;
    for (const { name, cfg: c } of cfgs) {
      const win = strictFold([["core.start"], ["boardgame.result", { winner: "H", method: "time" }]], c);
      expect(win.outcome, name).toEqual({ kind: "win", winner: "H", loser: "A", method: "time" });
      const draw = strictFold([["core.start"], ["boardgame.result", { winner: null, method: "stalemate" }]], c);
      // A bracket game with tie-breaks goes to the tie-break instead of settling as a draw; both record the method.
      expect(["done", "tiebreak"], name).toContain(draw.phase);
      expect(draw.method, name).toBe("stalemate");
      if (draw.phase === "done") expect(draw.outcome, name).toEqual({ kind: "draw" });
      expect(refusalOf(() => strictFold([["core.start"], ["boardgame.result", { winner: "H", method: "stalemate" }]], c))?.code, name).toBe(
        "RESULT_METHOD_CONTRADICTS_WINNER",
      );
      checked++;
    }
    expect(checked, "declared cfgs checked").toBe(cfgs.length);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("BG-RS-1 replay stays lenient: a pre-W2e ledger keeps its recorded result", () => {
  it("BG-RS-1 replay folds a stored {winner, \"stalemate\"} and a stored {null, \"checkmate\"} to what they recorded", () => {
    // Recorded at BASE, when neither was refused. The read path passes no strictFromSeq.
    const stalemateWin: Spec[] = [["core.start"], ["boardgame.result", { winner: "H", method: "stalemate" }]];
    const checkmateDraw: Spec[] = [["core.start"], ["boardgame.result", { winner: null, method: "checkmate" }]];
    const read = (specs: readonly Spec[]) => foldMatch(boardgame, cfg, lineups, ledger(specs));
    expect(read(stalemateWin).outcome).toEqual({ kind: "win", winner: "H", loser: "A", method: "stalemate" });
    expect(read(checkmateDraw).outcome).toEqual({ kind: "draw" });
    expect(boardgame.summary(read(checkmateDraw)).detail).toMatchObject({ method: "checkmate" });
    // The refusal begins AT the new write: strict from that event refuses, strict from the next one folds.
    for (const specs of [stalemateWin, checkmateDraw]) {
      expect(refusalOf(() => foldMatch(boardgame, cfg, lineups, ledger(specs), { strictFromSeq: 1 }))?.code).toBe("RESULT_METHOD_CONTRADICTS_WINNER");
      expect(refusalOf(() => foldMatch(boardgame, cfg, lineups, ledger(specs), { strictFromSeq: 2 }))).toBeNull();
    }
    // A later void reopens the game; the recorded contradiction is then part of the voided past and a coherent result folds.
    const voided: Spec[] = [...stalemateWin, ["core.void", {}, "e-1"], ["boardgame.result", { winner: "H", method: "checkmate" }]];
    expect(foldMatch(boardgame, cfg, lineups, ledger(voided), { strictFromSeq: 3 }).outcome).toEqual({
      kind: "win",
      winner: "H",
      loser: "A",
      method: "checkmate",
    });
  });
});
