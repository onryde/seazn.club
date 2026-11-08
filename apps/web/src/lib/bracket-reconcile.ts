// W4 app-A Task 8 (FX-G2, MB-004/005; spec 2026-11-04-format-matrix-w4-knockout-design.md §6.5): the PURE half of the
// shared position-keyed reconcile a Generate runs over a bracket that already has lines.
//
// Main's Generate inserted by `ext_key` alone: a seventh entrant in a bracket of eight inserted nothing and said "up to
// date"; a ninth seated the field twice and kept the old final beside a new one; and once a real line became a bye the
// bye-award bulk update threw "would strand home_slot_label" (a 500). The reconcile instead compares the lines a fresh
// Generate would draw with the lines that exist, by a LINE IDENTITY:
//   - the same set of identities and the same roster → nothing to do (`noop`, the desk's "up to date");
//   - the same set, the roster changed → place each newcomer in a bye and turn each departed entrant's line into a bye,
//     in place (`in_place`);
//   - a different set (the bracket crossed a power of two) → regenerate, in one transaction, slots carried by role.
// The identity is the only per-format part: a knockout's is its bracket ROLE (Task 4's key); W5 adds a round-robin
// identity (an unordered pair and its leg) without changing the planner.
//
// Client-safe and import-light, like lib/bracket-role.ts. The surgeries and the driver are the server's
// (server/usecases/bracket-lines.ts, server/usecases/bracket-reconcile.ts).
import { bracketRoleKey, finalRoundOf, type BracketRoleRow } from "@/lib/bracket-role";

/** What makes two lines "the same line" across a reconcile. */
export interface LineIdentity<L> {
  key(line: L): string;
}

export type Seat = "home" | "away";

/** One seat of one line. */
export interface SeatRef {
  lineId: string;
  seat: Seat;
}

export type ReconcilePlan =
  | { kind: "noop" }
  | { kind: "in_place"; place: string[]; vacate: SeatRef[] }
  | { kind: "regenerate" };

/** The roster a plan reads: who is active now, and where each seated entrant sits on the existing lines (an entrant's
 *  FIRST-round seat). */
export interface ReconcileRoster {
  active: ReadonlySet<string>;
  seated: ReadonlyMap<string, SeatRef>;
}

/** A knockout line stamped with its own side's final round, so its role key needs nothing else. */
export type KnockoutLine<R extends BracketRoleRow = BracketRoleRow> = R & { final_round: number };

/** Stamp each row with the final round of the side it belongs to (`finalRoundOf`, which refuses by name a side with no
 *  final). An empty side is empty — there is no final to read and nothing to key. */
export function knockoutLines<R extends BracketRoleRow>(rows: readonly R[]): KnockoutLine<R>[] {
  if (rows.length === 0) return [];
  const finalRound = finalRoundOf(rows);
  return rows.map((r) => ({ ...r, final_round: finalRound }));
}

/** A knockout line's identity: its bracket role (`bracketRoleKey`) against its own side's final — the final is the final
 *  at every size, so two brackets of the same size share every key and two of different sizes do not. */
export const KNOCKOUT_IDENTITY: LineIdentity<KnockoutLine> = {
  key: (line) => bracketRoleKey(line, line.final_round),
};

/** The set of keys, or null when a key repeats: a repeated key is no identity, and the planner never guesses which line
 *  is which. */
function keySet<L>(lines: readonly L[], identity: LineIdentity<L>): Set<string> | null {
  const keys = new Set<string>();
  for (const l of lines) {
    const k = identity.key(l);
    if (keys.has(k)) return null;
    keys.add(k);
  }
  return keys;
}

/**
 * The plan for a Generate over `existing` lines when a fresh Generate would draw `fresh`. Equal key sets and an equal
 * roster → `noop`; equal key sets and a changed roster → `in_place` (each active entrant no line seats to `place`, in the
 * roster's own order — the caller passes the draw's; each seated entrant no longer active to `vacate`); different key
 * sets, or a repeated key on either side → `regenerate`.
 */
export function planReconcile<L, G>(
  existing: readonly L[],
  fresh: readonly G[],
  ids: { existing: LineIdentity<L>; fresh: LineIdentity<G> },
  roster: ReconcileRoster,
): ReconcilePlan {
  const before = keySet(existing, ids.existing);
  const after = keySet(fresh, ids.fresh);
  if (before === null || after === null || before.size !== after.size) return { kind: "regenerate" };
  for (const k of before) if (!after.has(k)) return { kind: "regenerate" };
  const place = [...roster.active].filter((id) => !roster.seated.has(id));
  const vacate = [...roster.seated].filter(([id]) => !roster.active.has(id)).map(([, s]) => s);
  if (place.length === 0 && vacate.length === 0) return { kind: "noop" };
  return { kind: "in_place", place, vacate };
}

/** A bye line a newcomer could take: its holder, and the line's position in the draw (its top fold slot — the server
 *  reads it off the engine's fold, bracket-lines.ts). */
export interface ByeLineCandidate {
  lineId: string;
  holderId: string;
  drawPosition: number;
}

/**
 * RB4-L4 (rulebook-W4-knockout.md): the bye line a newcomer takes — the LOWEST-SEEDED holder's (an unseeded holder is
 * lower than every seeded one; among the seeded, the larger number), ties broken by the LATER draw position. Null when no
 * bye line is left. `seeds` holds every holder's current seed; a holder missing from it is a caller's bug, refused by
 * name rather than read as unseeded. Shared with Task 10's late entry.
 */
export function chooseByeLine(lines: readonly ByeLineCandidate[], seeds: ReadonlyMap<string, number | null>): string | null {
  let best: { line: ByeLineCandidate; lowness: number } | null = null;
  for (const line of lines) {
    if (!seeds.has(line.holderId)) {
      throw new Error(`chooseByeLine: no seed was given for the holder ${line.holderId} of line ${line.lineId}`);
    }
    const seed = seeds.get(line.holderId)!;
    const lowness = seed === null ? Number.POSITIVE_INFINITY : seed;
    if (
      best === null ||
      lowness > best.lowness ||
      (lowness === best.lowness && line.drawPosition > best.line.drawPosition)
    ) {
      best = { line, lowness };
    }
  }
  return best?.line.lineId ?? null;
}

/** The division statuses that mean it has started (`DIVISION_STARTED_STATUSES`, usecases/stages.ts; `ENTRANT_LIST_LOCKED_STATUSES`). */
const DIVISION_STARTED: readonly string[] = ["active", "completed"];

/**
 * W4 B2 fix round 1 (item 6, controller ruling): is Generate — worded "Update draw" — offered on this stage? A ROOT knockout
 * (no progression, no stored `qualified` field: the stage the reconcile serves, stages.ts `reconcileKnockoutGenerate`) that
 * already has lines, in a division that has not started, whose active roster no longer matches its seats (`rosterDrifted`: the
 * panel's `getStageRosterDrift` answer has a ghost or an unplaced entrant). Its first Generate made the stage `active`, so the
 * not-started rule alone hid Generate and the in-place reconcile could not be reached from the desk. Once the division has
 * started it is hidden: a departure is then the withdrawal cascade's, an arrival is refused (D8-1). An unknown division status
 * hides it too — the panel never offers a write on a guess.
 */
export function knockoutUpdateDrawOffered(args: {
  stage: { kind: string; progression: unknown; config: unknown };
  divisionStatus: string | undefined;
  fixtureCount: number;
  rosterDrifted: boolean;
}): boolean {
  const { stage } = args;
  if (stage.kind !== "knockout" || stage.progression != null) return false;
  const config = stage.config;
  if (typeof config === "object" && config !== null && Array.isArray((config as { qualified?: unknown }).qualified)) return false;
  if (args.divisionStatus === undefined || DIVISION_STARTED.includes(args.divisionStatus)) return false;
  return args.fixtureCount > 0 && args.rosterDrifted;
}
