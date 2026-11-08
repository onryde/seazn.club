// W4 app-A Task 10 (rules X-LE-3…X-LE-8; spec 2026-11-04-format-matrix-w4-knockout-design.md §4.1, ruling 263): where a
// late player goes in a drawn ROOT knockout — the pure decision. The server reads the round-1 lines
// (`usecases/knockout-late-entry.ts`), this answers, and the server applies it.
//
// In order, the first that applies:
//   (1) the BYE of the lowest-seeded holder (RB4-L4, `chooseByeLine`: unseeded below every seed, ties to the LATER draw
//       position), among the byes whose holder has not started round 2 (X-LE-3, X-LE-9) — never in a stepladder or a
//       page playoff, whose "byes" are rungs (X-LE-8, `caseTwoOnly`);
//   (2) a WITHDRAWN entrant's round-1 seat, its line not played, whose walkover winner has not started round 2 — the
//       walkover is then reversed (X-LE-5). The earliest such line in draw order (`seq`) when there are several;
//   (3) refused: "Round 1 complete; no slot left", with Rebuild offered when nothing in the stage has started (X-LE-6).
// Never round 2 or later (X-LE-7): only round-1 lines are read, and a withdrawn BYE HOLDER's line is never case (2) — its
// bye already carried the holder into round 2, so taking that seat would seat the newcomer there.
//
// Pure and client-safe.
import { chooseByeLine, type ByeLineCandidate } from "@/lib/bracket-reconcile";

/** One round-1 line, as the decision reads it. */
export interface LateLine {
  id: string;
  /** The line's position in round 1 (`seq_in_round`). */
  seq: number;
  /** Its position in the draw (bracket-lines.ts `knockoutLineDrawPosition`): RB4-L4's tie-break. */
  drawPos: number;
  home: string | null;
  away: string | null;
  status: string;
  /** Why the line is decided without play: a bye (`isByeLine`), a withdrawal's walkover (`withdrew`; a disqualification
   *  writes the same walkover, rulebook §12), or null (open, or decided by play). */
  reason: "bye" | "withdrew" | "disqualified" | null;
  /** A bye line's holder's seed (null: unseeded); null on any other line. */
  holderSeed: number | null;
  /** The line its winner feeds has started (X-LE-9: a score event, live, decided or called — `fixtureStartedSql`). */
  nextStarted: boolean;
  /** The seat whose entrant has departed (withdrawn or disqualified), when exactly one has; else null. */
  withdrawnSeat: "home" | "away" | null;
  /** Anything was played on the line besides a withdrawal's walkover (a start, a point, a played result). */
  played: boolean;
  /** The line's LOSER feeds another line (a third-place match). B2 carry m7: Start's bye award killed that seat (a bye
   *  names no loser), and a reopened bye does not revive it, so such a bye is never case (1). Reachable only as a bracket
   *  of four with third place that lost a player before Start. */
  loserFed: boolean;
}

export type KnockoutLateDecision =
  | { case: "bye"; lineId: string }
  | { case: "withdrawn_slot"; lineId: string; seat: "home" | "away"; reverse: boolean }
  | { case: "refused"; canRebuild: boolean };

export interface KnockoutLateInput {
  lines: readonly LateLine[];
  /** Anything in the stage has started (`stageHasStarted`): Rebuild is offered only when nothing has. */
  stageStarted: boolean;
  /** A stepladder or a page playoff: case (2) only (X-LE-8). */
  caseTwoOnly: boolean;
}

/** A bye line's holder: its one seated side. */
function holderOf(line: LateLine): string | null {
  if (line.home !== null && line.away === null) return line.home;
  if (line.away !== null && line.home === null) return line.away;
  return null;
}

/** Case (1)'s candidates: a bye with a holder still in the field who has not started round 2. */
function openByes(lines: readonly LateLine[]): (ByeLineCandidate & { seed: number | null })[] {
  const out: (ByeLineCandidate & { seed: number | null })[] = [];
  for (const l of lines) {
    if (l.reason !== "bye" || l.withdrawnSeat !== null || l.nextStarted || l.loserFed) continue;
    const holderId = holderOf(l);
    if (holderId === null) continue;
    out.push({ lineId: l.id, holderId, drawPosition: l.drawPos, seed: l.holderSeed });
  }
  return out;
}

/** Case (2)'s line: a withdrawn seat on a match nothing was played on (walked over by the withdrawal, or not yet), its
 *  winner not started round 2. Each condition is the ONE guard for its rule (a second covering it would be a guard no
 *  reachable state could kill): a withdrawn bye holder's line is out by `reason === "bye"` alone (X-LE-7); a line played
 *  before its player left is out by `played`; a walkover winner already in round 2 by `nextStarted` (X-LE-9). */
function withdrawnSlot(lines: readonly LateLine[]): { line: LateLine; seat: "home" | "away"; reverse: boolean } | null {
  const eligible = lines
    .filter((l) => l.withdrawnSeat !== null && l.reason !== "bye" && !l.played && !l.nextStarted)
    .sort((a, b) => a.seq - b.seq);
  const line = eligible[0];
  if (line === undefined) return null;
  // A withdrawal's walkover (or a disqualification's, the same walkover) is reversed; a seat not yet walked over is not.
  return { line, seat: line.withdrawnSeat!, reverse: line.reason !== null };
}

export function decideKnockoutLateEntry(input: KnockoutLateInput): KnockoutLateDecision {
  if (!input.caseTwoOnly) {
    const byes = openByes(input.lines);
    const lineId = chooseByeLine(byes, new Map(byes.map((b) => [b.holderId, b.seed])));
    if (lineId !== null) return { case: "bye", lineId };
  }
  const slot = withdrawnSlot(input.lines);
  if (slot !== null) return { case: "withdrawn_slot", lineId: slot.line.id, seat: slot.seat, reverse: slot.reverse };
  return { case: "refused", canRebuild: !input.stageStarted };
}
