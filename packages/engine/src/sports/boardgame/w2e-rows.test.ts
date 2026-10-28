// W2e Task 17 (A2) - the proving tests for boardgame.md's BG-AB-3 (checklist P7): an abandoned board game is left undecided and flagged for
// replay. Every describe/it title carries the row id as a whole token (packages/engine/test/rules-reference.ts reads them).
//
// Expected values come from the row's own text: undecided (no outcome, no winner, nothing paid to either side) and flagged for replay
// (`replayFlagged`, shown as `detail.abandoned`). BG-RS-1 (the result-method check) is Task 10's and is not touched here.
//
// Every fold is PAD-SHAPED (`strictFromSeq: 0`): the write path.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, foldMatchWithStoppage, outcomeOf, type EventEnvelope } from "../../core/events.ts";
import type { LineupPair } from "../../core/types.ts";
import { declaredCfgs } from "../../testkit/declared-cfgs.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { boardgame, type BoardgameCfg, type BoardgameState } from "./boardgame.ts";

const STRICT = { strictFromSeq: 0 } as const;
const lineups: LineupPair = defaultLineupPair(boardgame.positions);
const H = lineups.home.entrantId;

const cfgOf = (raw: unknown = {}): BoardgameCfg => boardgame.configSchema.parse(raw);
/** The knockout overlay: a drawn game goes to the tie-break (BG-KO-1). */
const bracketCfg = (): BoardgameCfg => cfgOf({ ...boardgame.bracketDeciders(cfgOf()) });

type Spec = [type: string, payload?: unknown, voids?: string];
const stream = (...specs: Spec[]): EventEnvelope[] =>
  specs.map(([type, payload, voids], i) => makeEnvelope(i, { type, payload: payload ?? {} }, voids));
const fold = (cfg: BoardgameCfg, ...specs: Spec[]): BoardgameState => foldMatch(boardgame, cfg, lineups, stream(...specs), STRICT);
/** The effective result: the state and the outcome the read side would show. */
const effective = (cfg: BoardgameCfg, ...specs: Spec[]) => {
  const folded = foldMatchWithStoppage(boardgame, cfg, lineups, stream(...specs), STRICT);
  return { state: folded.state, outcome: outcomeOf(boardgame, folded) };
};

const start: Spec = ["core.start"];
const abandon: Spec = ["core.abandon", { reason: "power cut" }];
const result = (winner: string | null, method: string): Spec => ["boardgame.result", { winner, method }];

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof EngineError) return error.code;
    throw error;
  }
}

describe("BG-AB-3 an abandoned board game is left undecided and flagged for replay: it pays no result to either side", () => {
  it("BG-AB-3 an abandon mid-game leaves no outcome and no winner, and flags the game for replay", () => {
    const { state, outcome } = effective(cfgOf(), start, abandon);
    expect(outcome).toBeNull();
    expect(state.outcome).toBeNull();
    expect(state.phase).toBe("abandoned");
    expect(state.replayFlagged).toBe(true);
    // Nobody is credited a result or a method.
    expect(state.method).toBeNull();
    const summary = boardgame.summary(state);
    expect(summary.headline).toBe("vs");
    expect(summary.perSide.map((side) => side.line)).toEqual(["", ""]);
    expect(summary.detail).toMatchObject({ abandoned: true });
  });

  it("BG-AB-3 the positive pair: a game that is played out is not flagged, and carries no abandoned detail", () => {
    const { state, outcome } = effective(cfgOf(), start, result(H, "resign"));
    expect(outcome).toMatchObject({ kind: "win", winner: H });
    expect(state.replayFlagged).toBe(false);
    expect(boardgame.summary(state).detail).not.toHaveProperty("abandoned");
    // And a game still running is not flagged either.
    expect(fold(cfgOf(), start).replayFlagged).toBe(false);
  });

  it("BG-AB-3 an abandon before the first move, and one while a tie-break is pending, are flagged the same way", () => {
    const pre = effective(cfgOf(), abandon);
    expect([pre.outcome, pre.state.phase, pre.state.replayFlagged]).toEqual([null, "abandoned", true]);
    // A drawn knockout game waits in the tie-break; abandoning there leaves it undecided too.
    const waiting = fold(bracketCfg(), start, result(null, "agreement"));
    expect(waiting.phase).toBe("tiebreak");
    const tieBreak = effective(bracketCfg(), start, result(null, "agreement"), abandon);
    expect([tieBreak.outcome, tieBreak.state.phase, tieBreak.state.replayFlagged]).toEqual([null, "abandoned", true]);
  });

  it("BG-AB-3 holds under every declared configuration and the knockout overlay", () => {
    const cfgs = [...declaredCfgs<BoardgameCfg>(boardgame).map((c) => ({ name: c.name, cfg: c.cfg })), { name: "bracket overlay", cfg: bracketCfg() }];
    let checked = 0;
    for (const { name, cfg } of cfgs) {
      const { state, outcome } = effective(cfg, start, abandon);
      expect(outcome, name).toBeNull();
      expect(state.replayFlagged, name).toBe(true);
      checked++;
    }
    expect(checked).toBe(cfgs.length);
    expect(checked).toBeGreaterThan(1);
  });

  it("BG-AB-3 an abandon is refused once the game is decided, finalized or already abandoned", () => {
    // [the game, the ledger, the refusal]. A decided game is refused by the kernel (ALREADY_DECIDED) before the module sees the event; a
    // game already abandoned is the module's own WRONG_PHASE: a second abandon does not unflag or re-flag anything.
    const over: Array<[string, Spec[], string]> = [
      ["decided", [start, result(H, "resign")], "ALREADY_DECIDED"],
      ["finalized", [start, result(H, "resign"), ["core.finalize"]], "ALREADY_DECIDED"],
      ["abandoned", [start, abandon], "WRONG_PHASE"],
    ];
    let checked = 0;
    for (const [label, specs, code] of over) {
      expect(codeOf(() => fold(cfgOf(), ...specs)), `${label} folds before the second abandon`).toBeNull();
      expect(codeOf(() => fold(cfgOf(), ...specs, ["core.abandon", { reason: "again" }])), label).toBe(code);
      checked++;
    }
    expect(checked).toBe(over.length);
  });

  it("BG-AB-3 the module's own guard refuses an abandon in a decided, finalized or abandoned phase, and flags it in the others", () => {
    // Folding never reaches the module for a decided match (the kernel refuses first), so the guard is driven through `apply` directly: the
    // assumption "the kernel always guards first" is a guard here, not a comment.
    const abandonEvent = makeEnvelope(9, { type: "core.abandon", payload: { reason: "power cut" } }) as never;
    const states: Array<[string, BoardgameState]> = [
      ["done", fold(cfgOf(), start, result(H, "resign"))],
      ["final", fold(cfgOf(), start, result(H, "resign"), ["core.finalize"])],
      ["abandoned", fold(cfgOf(), start, abandon)],
    ];
    for (const [phase, state] of states) {
      expect(state.phase, phase).toBe(phase);
      expect(codeOf(() => boardgame.apply(state, abandonEvent)), phase).toBe("WRONG_PHASE");
    }
    // The positive pair: pre, live and tie-break phases take it.
    const open: Array<[string, BoardgameState]> = [
      ["pre", fold(cfgOf())],
      ["live", fold(cfgOf(), start)],
      ["tiebreak", fold(bracketCfg(), start, result(null, "agreement"))],
    ];
    for (const [phase, state] of open) {
      expect(state.phase, phase).toBe(phase);
      const after = boardgame.apply(state, abandonEvent);
      expect([after.phase, after.replayFlagged, after.outcome], phase).toEqual(["abandoned", true, null]);
    }
    expect(states.length + open.length).toBe(6);
  });

  it("BG-AB-3 voiding the abandon takes the flag off and play resumes to a result", () => {
    // seq 0 start, seq 1 abandon, seq 2 voids seq 1.
    const resumed = effective(cfgOf(), start, abandon, ["core.void", {}, "e-1"]);
    expect(resumed.state.replayFlagged).toBe(false);
    expect(resumed.state.phase).toBe("live");
    expect(resumed.outcome).toBeNull();
    const played = effective(cfgOf(), start, abandon, ["core.void", {}, "e-1"], result(H, "resign"));
    expect(played.outcome).toMatchObject({ kind: "win", winner: H });
    expect(played.state.replayFlagged).toBe(false);
  });
});
