// Reference family `bracket-finish` (format-matrix W2a, ruling 72: "a bracket match never ends level").
//
// Written FROM THE SIGNED RULE ROWS (packages/engine/rules/*.md) and spec 2026-10-08-format-matrix-w2a-design.md
// (§5.1, §5.4.2, §5.4.3, §5.6.4, §7) by a different agent than the engine fixer (R8). It reads no engine source: its
// one engine import is the StageKind TYPE (R7; scripts/reference-boundary.ts proves it).
//
// One bracket fixture, in the RULEBOOK's terms — what play produced, then what the organiser or scorer did — folded
// left to right into the status the fixture must have, who advances by which method, and which writes are refused.
// It never guesses (R6). The eight questions T15 raised where the rows were silent were answered by CONTROLLER rulings
// P2-1..P2-8 (2026-10-08 — controller rulings, not owner rulings): three are encoded below as answers (P2-4, P2-5, P2-6,
// and P2-7 together with spec §5.4.3 as amended), and the rest — kernel behaviour W2a does not change — throw
// `OutOfScope`, named and never judged. An input the rows exclude throws `RuledOut`, naming the row.
import type { StageKind } from "@seazn/engine/core";

export type Side = "home" | "away";
export type Rung = "rapid" | "blitz" | "armageddon";
export type SettleMethod = "lot" | "higher_seed" | "organiser";

/** One bracket fixture, described in the RULEBOOK's terms — what was played and what the organiser or scorer did —
 *  never as engine events. */
export type PlayResult = { kind: "win"; winner: Side } | { kind: "level" } | { kind: "none" };
export type Action =
  | { kind: "abandon" }
  | { kind: "settle"; winner: Side; method: SettleMethod; by: "organiser" | "scorer" | "device" }
  | { kind: "tiebreak"; rung: Rung; winner: Side }
  | { kind: "void-last" }
  | { kind: "finalize" };
export interface BracketCase { stageKind: StageKind; sport: string; play: PlayResult; actions: readonly Action[]; hasLoserLine: boolean }

export type Status = "scheduled" | "in_play" | "decided" | "needs_decision" | "abandoned" | "finalized";
/** Spec §7's refusal codes, plus the code the server already returns to a scorer or a device (X-ST-2). */
export type RefusalCode = "LEVEL_RESULT_IN_BRACKET" | "SETTLE_NOT_APPLICABLE" | "TIEBREAK_NOT_APPLICABLE" | "FORBIDDEN";
export interface BracketExpect {
  status: Status; // in_play: a chess game awaiting its tie-break (ruling C12)
  advances: { winner: Side; loser: Side | null; method: string } | null;
  /** Which writes are refused, by rule. `index: -1` is the play itself, refused before any action. */
  refused: readonly { index: number; code: RefusalCode }[];
}

/** X-BR-1's scope, "a bracket kind": spec §5.4.1's BRACKET_KINDS — equally, every stage kind where X-DR-1 allows no
 *  draw (league, group, swiss and americano do). Typed here from the rows, never imported from the engine. */
export const BRACKET_STAGE_KINDS = ["knockout", "double_elim", "stepladder", "page_playoff", "ladder"] as const satisfies readonly StageKind[];

/** The sports with a KO row of their own, keyed by their rules file (= the registry key). Every other sport answers
 *  by the cross-sport rows alone. */
export const RULED_SPORTS = {
  boardgame: ["BG-KO-1", "BG-KO-2"],
  carrom: ["CA-KO-1"],
  generic: ["GN-KO-1"],
  cricket: ["CK-KO-1"],
} as const satisfies Record<string, readonly string[]>;
type RuledSport = keyof typeof RULED_SPORTS;
const CHESS: RuledSport = "boardgame"; // BG-KO-1, BG-KO-2
const CARROM: RuledSport = "carrom"; // CA-KO-1
const GENERIC: RuledSport = "generic"; // GN-KO-1

/** Kernel behaviour W2a does not change: named, counted by the sweeps, never judged by this family (controller rulings
 *  P2-1, P2-2, P2-3, P2-7 and P2-8, 2026-10-08 — controller rulings, not owner rulings). */
export const OUT_OF_SCOPE = {
  "after-finalize": "an action after finalize: pre-W2a kernel behaviour (controller ruling P2-1)",
  "abandon-decided": "an abandon of a fixture that already has a winner: pre-W2a kernel behaviour (controller ruling P2-2)",
  "abandon-twice": "a second abandon while one is active: pre-W2a kernel behaviour (controller ruling P2-3)",
  "finalize-unplayed": "finalize of a bracket fixture with no outcome, no abandon and nothing pending: nothing to settle (controller ruling P2-7)",
  "void-nothing": "a void with no standing action to undo: pre-W2a kernel behaviour (controller ruling P2-8)",
} as const;
export type OutOfScopeReason = keyof typeof OUT_OF_SCOPE;

export class OutOfScope extends Error {
  readonly reason: OutOfScopeReason;
  constructor(reason: OutOfScopeReason, at: string) {
    super(`bracket-finish: out of scope (${reason}) at ${at}: ${OUT_OF_SCOPE[reason]}`);
    this.name = "OutOfScope";
    this.reason = reason;
  }
}

/** Inputs the rows exclude, each naming its row. */
export const RULED_OUT = {
  "not-bracket": "X-BR-1 / X-DR-1: the family answers bracket kinds only; draws are allowed in league, group, swiss and americano",
  "carrom-level": "CA-KO-1: a carrom bracket match always plays the ICF extra board, so it never ends level",
  "tiebreak-not-chess": "BG-KO-1: the tie-break is a drawn chess bracket game's; no other sport records one",
} as const;
export type RuledOutReason = keyof typeof RULED_OUT;

export class RuledOut extends Error {
  readonly reason: RuledOutReason;
  constructor(reason: RuledOutReason, detail: string) {
    super(`bracket-finish: ${detail} (${RULED_OUT[reason]})`);
    this.name = "RuledOut";
    this.reason = reason;
  }
}

/** Spec §5.2: the tie-break folds to win{ method: "tiebreak_<rung>" }, one method per rung. */
const TIEBREAK_METHOD: Readonly<Record<Rung, string>> = {
  rapid: "tiebreak_rapid", // BG-KO-1 rapid
  blitz: "tiebreak_blitz", // BG-KO-1 blitz
  armageddon: "tiebreak_armageddon", // BG-KO-1 armageddon
};
/** Spec §5.1: settle folds to win{ method: "settled_<method>" }. */
const SETTLED_METHOD: Readonly<Record<SettleMethod, string>> = {
  lot: "settled_lot", // X-ST-1 lot
  higher_seed: "settled_higher_seed", // X-ST-1 higher seed
  organiser: "settled_organiser", // X-ST-1 organiser
};

interface State {
  /** As written: a refused generic draw (GN-KO-1) writes nothing, so it is held as "none". */
  readonly play: PlayResult;
  readonly tiebreak: { readonly rung: Rung; readonly winner: Side } | null;
  readonly abandoned: boolean;
  readonly settle: { readonly winner: Side; readonly method: SettleMethod } | null;
  readonly finalized: boolean;
}

const other = (s: Side): Side => (s === "home" ? "away" : "home");

export function expectBracketFinish(c: BracketCase): BracketExpect {
  // ── Inputs the rows exclude ──
  if (!(BRACKET_STAGE_KINDS as readonly string[]).includes(c.stageKind)) throw new RuledOut("not-bracket", `${c.stageKind} is not a bracket kind`);
  if (c.play.kind === "level" && c.sport === CARROM) throw new RuledOut("carrom-level", `a level carrom result in ${c.stageKind}`); // CA-KO-1
  const chess = c.sport === CHESS;
  const strayTiebreak = chess ? -1 : c.actions.findIndex((a) => a.kind === "tiebreak");
  if (strayTiebreak !== -1) throw new RuledOut("tiebreak-not-chess", `a tie-break at action ${strayTiebreak} on ${c.sport}`); // BG-KO-1

  /** X-BR-1: a fixture is decided only by a win — from play, a decider (the chess tie-break) or settle. */
  const win = (s: State): { winner: Side; method: string } | null => {
    if (s.settle !== null) return { winner: s.settle.winner, method: SETTLED_METHOD[s.settle.method] };
    if (s.tiebreak !== null) return { winner: s.tiebreak.winner, method: TIEBREAK_METHOD[s.tiebreak.rung] };
    if (s.play.kind === "win") return { winner: s.play.winner, method: "play" };
    return null;
  };
  /** X-BR-2: a play-produced level result (a drawn chess game goes to its tie-break instead — BG-KO-1). Held while
   *  nothing has decided it: every reader asks `win(s)` first. */
  const levelPlay = (s: State): boolean => s.play.kind === "level" && !chess;
  /** BG-KO-1 + ruling C12: a drawn chess bracket game — awaiting its tie-break while nothing has decided it (every
   *  reader asks `win(s)` first). */
  const drawnChess = (s: State): boolean => s.play.kind === "level" && chess;
  /** X-ST-1: settle applies only to a level outcome, an abandon with no outcome, or a chess game awaiting its tie-break. */
  const settleApplies = (s: State): boolean => {
    if (win(s) !== null) return false; // X-ST-1 already decided, a second settle included ("after the first one the outcome is win", spec §5.1)
    if (levelPlay(s)) return true; // X-ST-1 level outcome
    if (s.abandoned) return true; // X-ST-1 abandon with no outcome
    if (drawnChess(s)) return true; // C12 tie-break-phase settle
    return false;
  };
  /** Spec §5.4.2's order: an active settle, then an active abandon, then a level result in a bracket kind. */
  const statusOf = (s: State): Status => {
    if (s.finalized) return "finalized";
    if (s.settle !== null) return "decided"; // §5.4.2 (1) settle outranks abandon
    if (s.abandoned) return "abandoned"; // §5.4.2 (2) abandon outranks a level result
    if (levelPlay(s)) return "needs_decision"; // X-BR-2 hold
    if (win(s) !== null) return "decided";
    if (drawnChess(s)) return "in_play"; // C12 in_play
    return "scheduled";
  };

  const refused: { index: number; code: RefusalCode }[] = [];
  let s: State = { play: c.play, tiebreak: null, abandoned: false, settle: null, finalized: false };
  if (c.play.kind === "level" && c.sport === GENERIC) {
    refused.push({ index: -1, code: "LEVEL_RESULT_IN_BRACKET" }); // GN-KO-1 refuses a draw
    s = { ...s, play: { kind: "none" } };
  }
  /** The state before each standing action, so a void restores exactly what preceded it (spec §5.1). */
  const undo: State[] = [];
  const accept = (next: State): void => {
    undo.push(s);
    s = next;
  };

  c.actions.forEach((a, index) => {
    const at = `action ${index} (${a.kind})`;
    const refuse = (code: RefusalCode): void => {
      refused.push({ index, code });
    };
    if (s.finalized) throw new OutOfScope("after-finalize", at); // P2-1
    switch (a.kind) {
      case "abandon":
        if (s.abandoned) throw new OutOfScope("abandon-twice", at); // P2-3
        if (win(s) !== null) throw new OutOfScope("abandon-decided", at); // P2-2
        return accept({ ...s, abandoned: true });
      case "settle":
        if (a.by !== "organiser") return refuse("FORBIDDEN"); // X-ST-2 organiser only
        if (!settleApplies(s)) return refuse("SETTLE_NOT_APPLICABLE"); // X-ST-1 applies only to
        // Every method on every bracket sport (controller rulings P2-4, cricket included, and P2-5, a pending chess tie-break included).
        return accept({ ...s, settle: { winner: a.winner, method: a.method } });
      case "tiebreak":
        if (s.play.kind !== "level" || s.tiebreak !== null) return refuse("TIEBREAK_NOT_APPLICABLE"); // §7 outside the tie-break phase
        if (s.abandoned || s.settle !== null) return refuse("TIEBREAK_NOT_APPLICABLE"); // P2-6 after an abandon or a settle
        return accept({ ...s, tiebreak: { rung: a.rung, winner: a.winner } }); // BG-KO-2 the recorded winner
      case "void-last": {
        const before = undo.pop();
        if (before === undefined) throw new OutOfScope("void-nothing", at); // P2-8
        s = before;
        return;
      }
      case "finalize":
        if (win(s) !== null) return accept({ ...s, finalized: true });
        if (settleApplies(s)) return refuse("LEVEL_RESULT_IN_BRACKET"); // §5.4.3 as amended (P2-7): finalize while settle applies
        throw new OutOfScope("finalize-unplayed", at); // P2-7
    }
  });

  // X-BR-1: somebody advances only from a win (an abandon is never taken over a win: it throws "abandon-decided").
  const w = win(s);
  // X-ST-1: a win seats the winner AND the loser, where the bracket has a line for the loser.
  const advances = w === null ? null : { winner: w.winner, loser: c.hasLoserLine ? other(w.winner) : null, method: w.method };
  return { status: statusOf(s), advances, refused };
}

export interface BracketFinishFamily {
  readonly id: "bracket-finish";
  readonly rulebook: string;
  /** The rule rows this family answers — every row of packages/engine/rules (its test proves none is stale or missing). */
  readonly rows: readonly string[];
  readonly stageKinds: readonly StageKind[];
  readonly sports: "any";
  expectAll(cases: readonly BracketCase[]): BracketExpect[];
}

/** The family record `FAMILIES` holds (preflight C29). */
export const bracketFinish: BracketFinishFamily = Object.freeze({
  id: "bracket-finish",
  rulebook: "packages/engine/rules (cross-sport, boardgame, carrom, cricket, generic); spec 2026-10-08-format-matrix-w2a-design.md",
  rows: Object.freeze(["X-BR-1", "X-BR-2", "X-ST-1", "X-ST-2", "X-DR-1", "BG-KO-1", "BG-KO-2", "CA-KO-1", "GN-KO-1", "CK-KO-1"]),
  stageKinds: BRACKET_STAGE_KINDS,
  sports: "any",
  expectAll: (cases: readonly BracketCase[]): BracketExpect[] => cases.map((c) => expectBracketFinish(c)),
} as const);
