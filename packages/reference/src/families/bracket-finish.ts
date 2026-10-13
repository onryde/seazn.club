// Reference family `bracket-finish` (format-matrix W2a, ruling 72: "a bracket match never ends level").
//
// Written FROM THE SIGNED RULE ROWS (packages/engine/rules/*.md) and spec 2026-10-08-format-matrix-w2a-design.md
// (§5.1, §5.4.2, §5.4.3, §5.6.4, §7) by a different agent than the engine fixer (R8). It reads no engine source: its
// one engine import is the StageKind TYPE (R7; scripts/reference-boundary.ts proves it).
//
// One bracket fixture, in the RULEBOOK's terms — what play produced, then what the organiser or scorer did — folded
// left to right into the status the fixture must have, who advances by which method, and which writes are refused.
// It never guesses (R6). The eight questions T15 raised where the rows were silent were answered by CONTROLLER rulings
// P2-1..P2-8 (2026-10-08 — controller rulings, not owner rulings): four are encoded below as answers (P2-4, P2-5, P2-6,
// and P2-7 together with spec §5.4.3 as amended), and the other four (P2-1, P2-2, P2-3, P2-8) — kernel behaviour W2a
// does not change — throw `OutOfScope`, named and never judged. The review of T15 added controller rulings T15-R1
// (a chess double forfeit is not a drawn game: X-BR-2 holds it, spec §5.2 as amended), T15-R2 (a level result carries
// its X-BR-1 kind), T15-R4 (finalize with nothing to settle is out of scope; a forfeit is not modelled by this family)
// and T15-R5 (an ambiguous family match is refused, in ../index.ts). An input the rows exclude throws `RuledOut`, naming
// the row.
//
// W2b (Task 15, lane P2 — spec 2026-10-08-format-matrix-w2b-design.md §5.3, §5.4, §7 and Appendix A) adds the forfeit:
// a `forfeit` action (one side, or both — the double walkover), a match under way (`in_progress`), the chess double
// forfeit as a play result (BG-DW-1 retires T15-R1's hold: it is a double walkover, no longer a held `no_result`),
// dead seats (X-WD-3, X-DW-2), whether the fixture feeds a next match (X-DW-3), the `forfeited` status and the forfeit
// methods. The guard order is the plan's: the server's pre-fold checks (organiser gate X-RS-3, strict schema D3 R1,
// cascade-only `withdrew` PF-2, the feed graph D19), then the kernel's (abandon guard D4, guarantee 4 with PF-1's
// withdrawal admission, phase guard D3 R2-R5).
import type { StageKind } from "@seazn/engine/core";

export type Side = "home" | "away";
export type Rung = "rapid" | "blitz" | "armageddon";
export type SettleMethod = "lot" | "higher_seed" | "organiser";

/** X-BR-1's level kinds: "`draw`, `tie` and `no_result` are never a decided result" (controller ruling T15-R2). */
export const LEVEL_KINDS = ["draw", "tie", "no_result"] as const;
export type LevelKind = (typeof LEVEL_KINDS)[number];

/** X-RS-1's closed list of forfeit reasons. */
export const FORFEIT_REASONS = ["walkover", "retired", "disqualified", "withdrew"] as const;
export type ForfeitReason = (typeof FORFEIT_REASONS)[number];

/** One bracket fixture, described in the RULEBOOK's terms — what was played and what the organiser or scorer did —
 *  never as engine events. A level result names its X-BR-1 kind. W2b: `in_progress` is a match under way with nothing
 *  decided — something played, so a forfeit there is a retirement (X-RS-1); `started` (ruling 112) is a match whose
 *  Start was pressed with nothing played yet — in play for a retirement or a disqualification (R4), still before play
 *  for a walkover; `double_walkover` is chess's double forfeit result (BG-DW-1), the one play result that is a double
 *  walkover. */
export type PlayResult = { kind: "win"; winner: Side } | { kind: "level"; as: LevelKind } | { kind: "none" } | { kind: "started" } | { kind: "in_progress" } | { kind: "double_walkover" };
export type Action =
  | { kind: "abandon" }
  | { kind: "settle"; winner: Side; method: SettleMethod; by: "organiser" | "scorer" | "device" }
  | { kind: "tiebreak"; rung: Rung; winner: Side }
  | { kind: "void-last" }
  | { kind: "finalize" }
  /** W2b: `offender` is the side at fault ("both": the double walkover, X-DW-1); `by` is who writes it — "cascade" is
   *  the withdrawal cascade, the one writer of `withdrew` (PF-2). */
  | { kind: "forfeit"; offender: Side | "both"; reason: ForfeitReason; by: "organiser" | "scorer" | "device" | "cascade" };
export interface BracketCase {
  stageKind: StageKind;
  sport: string;
  play: PlayResult;
  actions: readonly Action[];
  hasLoserLine: boolean;
  /** W2b (X-DW-3, plan D19): the fixture's winner feeds a next match. Absent: true. A final, a last rung and a
   *  third-place match have none — and no loser line either. */
  hasNextMatch?: boolean;
  /** W2b (X-WD-3, X-DW-2): seats no entrant will ever fill — a withdrawn entrant's, or one a double walkover fed. */
  deadSeats?: readonly Side[];
}

export type Status = "scheduled" | "in_play" | "decided" | "needs_decision" | "abandoned" | "finalized" | "forfeited";
/** How a win was made. `"play"` is the ORACLE's label for a win from play: a consumer maps the product's own play
 *  methods onto it. The others are spec §5.2's `tiebreak_<rung>`, §5.1's `settled_<method>` and W2b's forfeit reasons
 *  (X-RS-1), verbatim. */
export type WinMethod = "play" | `tiebreak_${Rung}` | `settled_${SettleMethod}` | ForfeitReason;
/** Spec §7's refusal codes, plus the codes the server already returns: FORBIDDEN to a scorer or a device (X-ST-2,
 *  X-RS-3), INVALID_EVENT for a bad forfeit payload (plan W2b-FP-1), ALREADY_DECIDED (guarantee 4). */
export type RefusalCode =
  | "LEVEL_RESULT_IN_BRACKET" | "SETTLE_NOT_APPLICABLE" | "TIEBREAK_NOT_APPLICABLE" | "FORBIDDEN"
  | "INVALID_EVENT" | "DOUBLE_WALKOVER_NO_NEXT_MATCH" | "ABANDONED_SETTLE_OR_VOID" | "ALREADY_DECIDED" | "FORFEIT_REASON_WRONG_PHASE";
export interface BracketExpect {
  status: Status; // in_play: a chess game awaiting its tie-break (ruling C12)
  advances: { winner: Side; loser: Side | null; method: WinMethod } | null;
  /** Which writes are refused, by rule. `index: -1` is the play itself, refused before any action. */
  refused: readonly { index: number; code: RefusalCode }[];
}

/** X-BR-1's scope, "a bracket kind": spec §5.4.1's BRACKET_KINDS — equally, every stage kind where X-DR-1 allows no
 *  draw (league, group, swiss and americano do). Typed here from the rows, never imported from the engine. */
export const BRACKET_STAGE_KINDS = ["knockout", "double_elim", "stepladder", "page_playoff", "ladder"] as const satisfies readonly StageKind[];

/** The sports with a KO row of their own, keyed by their rules file (= the registry key). Every other sport answers
 *  by the cross-sport rows alone. */
export const RULED_SPORTS = {
  boardgame: ["BG-KO-1", "BG-KO-2", "BG-KO-3"],
  carrom: ["CA-KO-1"],
  generic: ["GN-KO-1"],
  cricket: ["CK-KO-1"],
  icehockey: ["IH-KO-1"], // W2c: a stage preset (overtime and a shootout), no level-play answer of its own
} as const satisfies Record<string, readonly string[]>;
type RuledSport = keyof typeof RULED_SPORTS;
const CHESS: RuledSport = "boardgame"; // BG-KO-1, BG-KO-2
const CARROM: RuledSport = "carrom"; // CA-KO-1
const GENERIC: RuledSport = "generic"; // GN-KO-1

/** Named, counted by the sweeps, never judged by this family (controller rulings P2-1, P2-2, P2-3, P2-8 and T15-R4,
 *  2026-10-08 — controller rulings, not owner rulings). A consumer treats it like `RuledOut`: no exact check. */
export const OUT_OF_SCOPE = {
  "after-finalize": "an action after finalize: pre-W2a kernel behaviour (controller ruling P2-1)",
  "abandon-decided": "an abandon of a fixture that already has a winner (or, W2b, a double walkover): pre-W2a kernel behaviour (controller ruling P2-2)",
  "abandon-twice": "a second abandon while one is active: pre-W2a kernel behaviour (controller ruling P2-3)",
  "finalize-unplayed": "finalize of a bracket fixture with no outcome, no abandon and nothing pending: nothing to settle (controller ruling T15-R4)",
  "void-nothing": "a void with no standing action to undo: pre-W2a kernel behaviour (controller ruling P2-8)",
  "vacant-title": "a double walkover with no next match and no loser line, from two dead seats or a chess double forfeit: nobody can take the title (X-DW-3: a vacant title is W4)",
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
  "carrom-level": "CA-KO-1: a carrom bracket match always plays the ICF extra board, so its boards never end level (a draw or a tie)",
  "tiebreak-not-chess": "BG-KO-1: the tie-break is a drawn chess bracket game's; no other sport records one",
  "double-walkover-play-not-chess": "BG-DW-1: only chess records a double forfeit as a result; every other sport's double walkover is a two-sided forfeit",
  "dead-seat-played": "X-WD-3 / X-DW-2: a fixture with a dead seat is walked over to its opponent, never played",
  "ladder-dead-seat": "X-DW-2 + plan D19: a ladder wires no feed edge, so no ladder seat is fed and none is dead",
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
const TIEBREAK_METHOD: { readonly [R in Rung]: `tiebreak_${R}` } = {
  rapid: "tiebreak_rapid", // BG-KO-1 rapid
  blitz: "tiebreak_blitz", // BG-KO-1 blitz
  armageddon: "tiebreak_armageddon", // BG-KO-1 armageddon
};
/** Spec §5.1: settle folds to win{ method: "settled_<method>" }. */
const SETTLED_METHOD: { readonly [M in SettleMethod]: `settled_${M}` } = {
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
  /** W2b: the forfeit that stands — an accepted `forfeit` action, or a dead seat's walkover (the generator's, no action). */
  readonly forfeit: { readonly offender: Side | "both"; readonly reason: ForfeitReason } | null;
}

const other = (s: Side): Side => (s === "home" ? "away" : "home");

export function expectBracketFinish(c: BracketCase): BracketExpect {
  // ── Inputs the rows exclude ──
  if (!(BRACKET_STAGE_KINDS as readonly string[]).includes(c.stageKind)) throw new RuledOut("not-bracket", `${c.stageKind} is not a bracket kind`);
  if (c.play.kind === "level" && c.play.as !== "no_result" && c.sport === CARROM) throw new RuledOut("carrom-level", `a carrom ${c.play.as} in ${c.stageKind}`); // CA-KO-1: a no_result is no board score, so X-BR-2 holds it
  const chess = c.sport === CHESS;
  const strayTiebreak = chess ? -1 : c.actions.findIndex((a) => a.kind === "tiebreak");
  if (strayTiebreak !== -1) throw new RuledOut("tiebreak-not-chess", `a tie-break at action ${strayTiebreak} on ${c.sport}`); // BG-KO-1
  if (c.play.kind === "double_walkover" && !chess) throw new RuledOut("double-walkover-play-not-chess", `a ${c.sport} play result`); // BG-DW-1
  const dead = c.deadSeats ?? [];
  for (const side of ["home", "away"] as const) {
    if (dead.filter((d) => d === side).length > 1) throw new TypeError(`bracket-finish: deadSeats lists ${side} twice — it is a set of seats`);
  }
  if (dead.length > 0 && c.stageKind === "ladder") throw new RuledOut("ladder-dead-seat", `dead seat(s) ${dead.join(", ")}`); // D19
  if (dead.length > 0 && c.play.kind !== "none") throw new RuledOut("dead-seat-played", `a ${c.play.kind} with dead seat(s) ${dead.join(", ")}`); // X-WD-3
  /** X-DW-3 / plan D19: the fixture feeds no seat — no next match and no loser line — and is not a ladder challenge
   *  (a ladder wires no feed edge, so it is exempt). */
  const noNextMatch = c.hasNextMatch === false && !c.hasLoserLine && c.stageKind !== "ladder";

  /** X-BR-1: a fixture is decided only by a win — from play, a decider (the chess tie-break), settle or (W2b) a
   *  one-sided forfeit. */
  const win = (s: State): { winner: Side; method: WinMethod } | null => {
    if (s.settle !== null) return { winner: s.settle.winner, method: SETTLED_METHOD[s.settle.method] };
    if (s.tiebreak !== null) return { winner: s.tiebreak.winner, method: TIEBREAK_METHOD[s.tiebreak.rung] };
    if (s.forfeit !== null && s.forfeit.offender !== "both") return { winner: other(s.forfeit.offender), method: s.forfeit.reason }; // X-RS-1 reason
    if (s.play.kind === "win") return { winner: s.play.winner, method: "play" };
    return null;
  };
  /** X-BR-1 as amended (W2b-R2): "decided only by a win OR A DOUBLE WALKOVER" — both lose, nobody advances (X-DW-1). */
  const doubleWalkover = (s: State): boolean => s.play.kind === "double_walkover" || s.forfeit?.offender === "both";
  /** BG-KO-1 + ruling C12: a DRAWN chess bracket game — awaiting its tie-break while nothing has decided it (every
   *  reader asks `win(s)` first). A chess double forfeit is a double walkover, not a drawn game (BG-DW-1). */
  const drawnChess = (s: State): boolean => chess && s.play.kind === "level" && s.play.as === "draw";
  /** X-BR-2: every other play-produced level result, held while nothing has decided it (every reader asks `win(s)`
   *  first) — and while no forfeit has walked it over (X-WD-1). */
  const levelPlay = (s: State): boolean => s.play.kind === "level" && !drawnChess(s) && s.forfeit === null;
  /** X-ST-1: settle applies only to a level outcome, an abandon with no outcome, or a chess game awaiting its tie-break. */
  const settleApplies = (s: State): boolean => {
    if (win(s) !== null) return false; // X-ST-1 already decided, a second settle included ("after the first one the outcome is win", spec §5.1)
    if (levelPlay(s)) return true; // X-ST-1 level outcome
    if (s.abandoned) return true; // X-ST-1 abandon with no outcome
    if (drawnChess(s)) return true; // C12 tie-break-phase settle
    return false;
  };
  /** Spec §5.4.2's order (W2b §5.4 / plan D7): an active settle, an active abandon, a level result in a bracket kind,
   *  then a forfeit (keyed on the event) or a double walkover → forfeited. */
  const statusOf = (s: State): Status => {
    if (s.finalized) return "finalized";
    if (s.settle !== null) return "decided"; // §5.4.2 (1) settle outranks abandon
    if (s.abandoned) return "abandoned"; // §5.4.2 (2) abandon outranks a level result
    if (levelPlay(s)) return "needs_decision"; // X-BR-2 hold
    if (s.forfeit !== null || doubleWalkover(s)) return "forfeited"; // W2b §5.4 (4)
    if (win(s) !== null) return "decided";
    if (drawnChess(s)) return "in_play"; // C12 in_play
    if (s.play.kind === "in_progress" || s.play.kind === "started") return "in_play"; // W2b: under way, nothing decided; ruling 112: Start pressed
    return "scheduled";
  };
  /** Plan D3's phase, from the fixture as it stands: before play, during it, a chess game awaiting its tie-break, or
   *  over (R0: guarantee 4 answers). */
  const phaseOf = (s: State): "pre" | "play" | "tiebreak" | "over" => {
    if (win(s) !== null || doubleWalkover(s) || levelPlay(s)) return "over";
    if (drawnChess(s)) return "tiebreak";
    return s.play.kind === "in_progress" || s.play.kind === "started" ? "play" : "pre";
  };
  /** The refusal a forfeit write meets, in the plan's order — or null: accepted. */
  const forfeitRefusal = (s: State, a: Extract<Action, { kind: "forfeit" }>): RefusalCode | null => {
    if (a.by === "scorer" || a.by === "device") return "FORBIDDEN"; // X-RS-3 (through X-ST-2's predicate)
    if (a.offender === "both" && a.reason !== "walkover") return "INVALID_EVENT"; // D3 R1: the strict schema; X-DW-1
    if (a.reason === "withdrew" && a.by !== "cascade") return "INVALID_EVENT"; // PF-2: the withdrawal cascade alone
    if (a.offender === "both" && noNextMatch) return "DOUBLE_WALKOVER_NO_NEXT_MATCH"; // X-DW-3 / D19 (server, pre-fold)
    if (s.abandoned) return "ABANDONED_SETTLE_OR_VOID"; // X-AB-4 / D4: above guarantee 4
    const phase = phaseOf(s);
    if (phase === "over") {
      // guarantee 4, with PF-1's one admission: a withdrawal walks a held level result over (X-WD-1) — held, so no
      // settle has decided it ("ONLY when isLevelOutcome(outcome) and no settlement is active")
      const heldWithdrawal = levelPlay(s) && win(s) === null && a.reason === "withdrew" && a.offender !== "both";
      return heldWithdrawal ? null : "ALREADY_DECIDED";
    }
    // Ruling 112 (amends X-RS-1): a walkover is judged before play while nothing is played — a bare Start included.
    const walkoverPhase = s.play.kind === "started" ? "pre" : phase;
    if (a.reason === "walkover" && !(walkoverPhase === "pre" || (chess && (phase === "play" || phase === "tiebreak")))) return "FORFEIT_REASON_WRONG_PHASE"; // D3 R2; X-RS-1, BG-WO-2, BG-WO-3
    if (a.offender === "both" && phase === "tiebreak") return "FORFEIT_REASON_WRONG_PHASE"; // D3 R3: the classical game was played
    if ((a.reason === "retired" || a.reason === "disqualified") && phase === "pre") return "FORFEIT_REASON_WRONG_PHASE"; // D3 R4; X-RS-1
    // Ruling 113 (amends X-RS-1, X-RT-1): nobody retires from a match never played — a bare Start is still before play.
    // Ruling 118 (2026-10-12): in chess the Start is play (Seazn records no moves), so a chess retirement stands from it.
    if (a.reason === "retired" && walkoverPhase === "pre" && !chess) return "FORFEIT_REASON_WRONG_PHASE";
    return null; // D3 R5: withdrew in any phase but over
  };

  // ── Dead seats (X-WD-3, X-DW-2): the generator's walkover, standing before any action and undone by no void ──
  let rootForfeit: State["forfeit"] = null;
  if (dead.length === 2) {
    if (noNextMatch) throw new OutOfScope("vacant-title", "two dead seats"); // X-DW-3: a vacant title is W4
    rootForfeit = { offender: "both", reason: "walkover" }; // X-DW-2 / X-WD-4: both seats dead — a double walkover
  } else if (dead[0] !== undefined) {
    rootForfeit = { offender: dead[0], reason: "walkover" }; // X-WD-3: the arriving opponent advances by walkover
  }
  if (c.play.kind === "double_walkover" && noNextMatch) throw new OutOfScope("vacant-title", "a chess double forfeit"); // BG-DW-1 + X-DW-3

  const refused: { index: number; code: RefusalCode }[] = [];
  let s: State = { play: c.play, tiebreak: null, abandoned: false, settle: null, finalized: false, forfeit: rootForfeit };
  if (c.play.kind === "level" && c.play.as === "draw" && c.sport === GENERIC) {
    refused.push({ index: -1, code: "LEVEL_RESULT_IN_BRACKET" }); // GN-KO-1 refuses a draw (only a draw: ruling 79)
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
        if (win(s) !== null || doubleWalkover(s)) throw new OutOfScope("abandon-decided", at); // P2-2
        return accept({ ...s, abandoned: true });
      case "settle":
        if (a.by !== "organiser") return refuse("FORBIDDEN"); // X-ST-2 organiser only
        if (!settleApplies(s)) return refuse("SETTLE_NOT_APPLICABLE"); // X-ST-1 applies only to
        // Every method on every bracket sport (controller rulings P2-4, cricket included, and P2-5, a pending chess tie-break included).
        return accept({ ...s, settle: { winner: a.winner, method: a.method } });
      case "tiebreak":
        if (!drawnChess(s) || s.tiebreak !== null) return refuse("TIEBREAK_NOT_APPLICABLE"); // §7 outside the tie-break phase (BG-DW-1: a double forfeit has none)
        if (s.abandoned || s.settle !== null) return refuse("TIEBREAK_NOT_APPLICABLE"); // P2-6 after an abandon or a settle
        if (s.forfeit !== null) return refuse("TIEBREAK_NOT_APPLICABLE"); // BG-WO-3: a walkover ended the tie-break
        return accept({ ...s, tiebreak: { rung: a.rung, winner: a.winner } }); // BG-KO-2 the recorded winner
      case "void-last": {
        const before = undo.pop();
        if (before === undefined) throw new OutOfScope("void-nothing", at); // P2-8
        s = before;
        return;
      }
      case "finalize":
        if (win(s) !== null || doubleWalkover(s)) return accept({ ...s, finalized: true }); // X-BR-1 as amended
        if (settleApplies(s)) return refuse("LEVEL_RESULT_IN_BRACKET"); // §5.4.3 as amended (P2-7): finalize while settle applies
        throw new OutOfScope("finalize-unplayed", at); // T15-R4
      case "forfeit": {
        const code = forfeitRefusal(s, a);
        if (code !== null) return refuse(code);
        return accept({ ...s, forfeit: { offender: a.offender, reason: a.reason } });
      }
    }
  });

  // X-BR-1: somebody advances only from a win (an abandon is never taken over a win: it throws "abandon-decided"); a
  // double walkover advances nobody (X-DW-1).
  const w = win(s);
  // X-ST-1: a win seats the winner AND the loser, where the bracket has a line for the loser — except a forfeit's
  // loser, who is never seated on a loser edge (spec §5.3, X-DE-1, X-WD-5).
  const byForfeit = w !== null && (FORFEIT_REASONS as readonly string[]).includes(w.method);
  const advances = w === null ? null : { winner: w.winner, loser: c.hasLoserLine && !byForfeit ? other(w.winner) : null, method: w.method };
  return { status: statusOf(s), advances, refused };
}

export interface BracketFinishFamily {
  readonly id: "bracket-finish";
  readonly rulebook: string;
  /** The rule rows this family answers: rules-directory rows, covering every X-BR, X-ST, X-DR and KO row (its test
   *  proves none is stale and none is unanswered), then W2b's Appendix A rows (read from the spec until Task 14 writes
   *  them to the rules directory). */
  readonly rows: readonly string[];
  readonly stageKinds: readonly StageKind[];
  readonly sports: "any";
  /** One case — what a consumer calls after `requireFamily(kind, sport)`. Throws `RuledOut` / `OutOfScope`. */
  expect(c: BracketCase): BracketExpect;
  expectAll(cases: readonly BracketCase[]): BracketExpect[];
}

/** The family record `FAMILIES` holds (preflight C29). */
export const bracketFinish: BracketFinishFamily = Object.freeze({
  id: "bracket-finish",
  rulebook: "packages/engine/rules (cross-sport, boardgame, carrom, cricket, generic, icehockey); spec 2026-10-08-format-matrix-w2a-design.md; spec 2026-10-08-format-matrix-w2b-design.md Appendix A",
  rows: Object.freeze([
    "X-BR-1", "X-BR-2", "X-ST-1", "X-ST-2", "X-DR-1", "BG-KO-1", "BG-KO-2", "CA-KO-1", "GN-KO-1", "CK-KO-1",
    "X-RS-1", "X-RS-3", "X-DW-1", "X-DW-2", "X-DW-3", "X-AB-4", "X-WD-1", "X-WD-2", "X-WD-3", "X-WD-4", "X-WD-5", "X-DE-1", "BG-DW-1", "BG-WO-2", "BG-WO-3",
    "BG-KO-3", "IH-KO-1", // W2c: the two new KO rows, classified in bracket-finish.test.ts (neither answers a level PLAY result)
  ]),
  stageKinds: BRACKET_STAGE_KINDS,
  sports: "any",
  expect: (c: BracketCase): BracketExpect => expectBracketFinish(c),
  expectAll: (cases: readonly BracketCase[]): BracketExpect[] => cases.map((c) => expectBracketFinish(c)),
} as const);
