// W4 app-A Task 8 (FX-G2, MB-004/005; spec 2026-11-04 §6.5): the DRIVER of a root knockout's reconcile — what a Generate
// does when the bracket already has lines. Called from `generateStageFixturesTx` (stages/generate-tx.ts), in its transaction, under
// its division lock. The planner is lib/bracket-reconcile.ts; the surgeries are ./bracket-lines.ts.
//
//   - after Start: Generate never reshapes. An ARRIVAL since the draw (or a seat whose entrant was deleted) is refused by
//     name — KO_GENERATE_AFTER_START, the late-entry door is the way in. A DEPARTURE is not: a withdrawal after Start has
//     already been walked over by its own cascade (the bracket shows it), so Generate has nothing to add and answers the
//     named no-op, exactly as it does for an unchanged roster;
//   - before Start: the same lines and roster → `noop`; the same lines, a changed roster → vacate each departed entrant's
//     line to a bye, then seat each newcomer on RB4-L4's bye (`chooseByeLine`), in place; different lines (a power of two
//     crossed), or a change in place cannot express (a bye holder left, both sides of one line left) → `regenerate`, which
//     the caller runs (Rebuild's own body, `regenerateStageInTx`).
// Every refusal to act in place is decided BEFORE the first write, so a regenerate never starts from a half-surgered
// bracket (its slot carry reads the lines as they were).
import type { Tx } from "@/lib/db";
import { isByeLine, type ByeLineRow } from "@/lib/bye-line";
import type { BracketRoleRow } from "@/lib/bracket-role";
import { KNOCKOUT_IDENTITY, knockoutLines, planReconcile, type SeatRef } from "@/lib/bracket-reconcile";
import { byeLineCandidates, chooseByeLine, reopenByeLine, vacateLineToBye } from "./bracket-lines";
import { knockoutRefusal } from "./knockout-refusal";

/** The driver was asked to reconcile a stage with no lines. A first Generate is not a reconcile: the caller branches here
 *  only when lines exist, so this is a caller's bug, refused by name. */
export class BracketReconcileNoLinesError extends Error {
  constructor(readonly stageId: string) {
    super(`reconcileRootBracket: stage ${stageId} has no lines — a first Generate is not a reconcile`);
    this.name = "BracketReconcileNoLinesError";
  }
}

export interface ReconcileInput {
  stageId: string;
  /** The division has started, or a line of the stage has (`divisionHasStarted` / `stageHasStarted`). */
  started: boolean;
  /** The active field in DRAW order (`knockoutDrawOrder`): newcomers are placed in this order. */
  active: readonly { id: string; seed: number | null }[];
  /** The lines a fresh Generate of `active` would draw. */
  fresh: readonly BracketRoleRow[];
}

/** What the driver did, or (`regenerate`) what the caller must do. `placed`/`vacated` are entrant ids; `vacatedSeats`
 *  counts every seat emptied — a departed entrant's and a seat whose entrant was DELETED (its id is gone with it, so it is
 *  in no list), so the desk never says "up to date" after writing a bye (B2 fix round 1, I2); `touched` the lines a
 *  change in place wrote (for the publish). */
export type ReconcileDecision =
  | { kind: "noop" | "in_place"; placed: string[]; vacated: string[]; vacatedSeats: number; touched: string[] }
  | { kind: "regenerate"; placed: string[]; vacated: string[]; vacatedSeats: number };

type Line = BracketRoleRow & ByeLineRow & { id: string };

export async function reconcileRootBracket(tx: Tx, input: ReconcileInput): Promise<ReconcileDecision> {
  const existing = await tx<Line[]>`
    select id, pool_id, round_no, seq_in_round, ext_key, status, outcome,
           home_entrant_id, away_entrant_id, home_slot_label, away_slot_label
      from fixtures where stage_id = ${input.stageId} order by round_no, seq_in_round`;
  if (existing.length === 0) throw new BracketReconcileNoLinesError(input.stageId);

  // Who sits where: each entrant's FIRST-round seat (a bye holder is also carried into round 2 — not a second seat).
  // A seat no entrant holds on a line that is not a bye is an orphan (its entrant was deleted: the FK sets it null).
  const firstRound = existing.filter((l) => l.round_no === 1);
  const seated = new Map<string, SeatRef>();
  const orphans: SeatRef[] = [];
  let unreadable = false;
  for (const l of firstRound) {
    const bye = isByeLine(l);
    if (bye && l.home_entrant_id === null && l.away_entrant_id === null) unreadable = true; // a bye whose holder is gone
    for (const seat of ["home", "away"] as const) {
      const id = seat === "home" ? l.home_entrant_id : l.away_entrant_id;
      if (id === null) {
        if (!bye) orphans.push({ lineId: l.id, seat });
      } else if (seated.has(id)) {
        unreadable = true; // seated twice: no in-place change can be trusted
      } else {
        seated.set(id, { lineId: l.id, seat });
      }
    }
  }
  const active = new Set(input.active.map((e) => e.id));
  const newcomers = [...active].filter((id) => !seated.has(id));
  const departed = [...seated.keys()].filter((id) => !active.has(id));
  const noop = { kind: "noop" as const, placed: [], vacated: [], vacatedSeats: 0, touched: [] };

  if (input.started) {
    if (newcomers.length > 0 || orphans.length > 0 || unreadable) throw knockoutRefusal("KO_GENERATE_AFTER_START");
    return noop; // unchanged, or only departures the withdrawal cascade already walked over
  }

  const regenerate = { kind: "regenerate" as const, placed: newcomers, vacated: departed, vacatedSeats: departed.length + orphans.length };
  if (unreadable) return regenerate;
  const plan = planReconcile(
    knockoutLines(existing),
    knockoutLines(input.fresh),
    { existing: KNOCKOUT_IDENTITY, fresh: KNOCKOUT_IDENTITY },
    { active, seated },
  );
  if (plan.kind === "regenerate") return regenerate;
  const place = plan.kind === "in_place" ? plan.place : [];
  const vacates = [...(plan.kind === "in_place" ? plan.vacate : []), ...orphans];
  if (place.length === 0 && vacates.length === 0) return noop;

  // Decided before any write: each vacate is on a match whose other side stays, and the byes go round.
  const byId = new Map(existing.map((l) => [l.id, l]));
  const vacatedLines = new Set<string>();
  for (const v of vacates) {
    const line = byId.get(v.lineId);
    if (line === undefined) throw new Error(`reconcileRootBracket: the plan named line ${v.lineId}, which the stage does not hold`);
    if (isByeLine(line)) return regenerate; // a bye's holder left: nobody stays on the line
    if (vacatedLines.has(line.id)) return regenerate; // both sides of one line left
    vacatedLines.add(line.id);
  }
  const byes = firstRound.filter((l) => isByeLine(l)).length + vacatedLines.size;
  if (place.length > byes) return regenerate;

  const touched: string[] = [];
  for (const v of vacates) {
    const done = await vacateLineToBye(tx, v.lineId, v.seat);
    touched.push(done.fixtureId, done.nextId);
  }
  const seeds = new Map(input.active.map((e) => [e.id, e.seed]));
  for (const newcomer of place) {
    const lineId = chooseByeLine(await byeLineCandidates(tx, input.stageId), seeds);
    // Counted above: a bye is left for every newcomer. A null here is that count wrong — refused, never skipped.
    if (lineId === null) throw new Error(`reconcileRootBracket: no bye left for ${newcomer}, though ${byes} were counted for ${place.length}`);
    const done = await reopenByeLine(tx, lineId, newcomer);
    touched.push(done.fixtureId, done.nextId);
  }
  return { kind: "in_place", placed: place, vacated: departed, vacatedSeats: vacates.length, touched: [...new Set(touched)] };
}
