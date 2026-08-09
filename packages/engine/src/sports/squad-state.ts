// S3/W4b (#426) pass B — how a sport module ADOPTS the kernel-owned squad
// model. Nothing here re-derives squad membership, substitution counting or
// re-entry: `core/lineup.ts` owns all three and this file only decides where
// the snapshot it produces is allowed to land, plus the two doubles readers the
// racquet dossiers were waiting on.
//
// WHY AN ADOPTION LAYER EXISTS AT ALL. `FoldableModule.onLineup(state, squads)`
// is called once at `init` and once after every ACCEPTED change, and a module
// that simply assigned the snapshot every time would write the team sheet into
// the state of every fixture in the system — including the eleven frozen golden
// corpora, which compare `JSON.stringify(state)` per event and record no
// `core.lineup.*` event at all. Six of them would need a re-baseline to store a
// copy of a lineup the caller already holds and can rebuild with `initSquads`.
//
// So the rule is: PERSIST WHEN THE SNAPSHOT SAYS SOMETHING THE TEAM SHEET DOES
// NOT. Two ways it can:
//
//   1. a `core.lineup.*` event has been folded — somebody moved, and the sheet
//      is no longer the truth;
//   2. the sheet itself declares a fact the pre-wave lineup model had no home
//      for — `pairOrder` (the doubles order, #426's tennis and table-tennis
//      rows) or a non-`player` `role` (ruling 3's coach/staff).
//
// A declared POSITION is deliberately not in that second list. It is the one
// piece of sheet detail every corpus lineup already carries, so treating it as
// "new" would rebaseline six sports to record something `initSquads(lineups)`
// reproduces exactly.
import type { SideSquad, SquadState } from "../core/lineup.ts";

/** What a module State gains by adopting the model. Optional, and absent is the
 *  normal state of affairs — see the file header. */
export interface SquadCarrier {
  squads?: SquadState;
}

/**
 * Does this snapshot carry a team-sheet fact that nothing else in the fold
 * records? See the header for why positions are excluded.
 */
export function declaresSquadDetail(squads: SquadState): boolean {
  return [squads.home, squads.away].some((side) =>
    side.members.some((member) => member.pairOrder !== undefined || member.role !== "player"),
  );
}

export interface SquadAdopter<S extends SquadCarrier> {
  /** Call on the object `init` is about to return. */
  fresh<T extends S>(state: T): T;
  /** The body of the module's `onLineup`. */
  adopt<T extends S>(state: T, squads: SquadState): T;
}

/**
 * One adopter per module (built inside the kernel factory's closure).
 *
 * THE INIT HANDSHAKE, and why it is identity-based. `onLineup` cannot say
 * whether it is being called at `init` or after a change, and the difference is
 * load-bearing here: at `init` the snapshot must not be written. Inferring it
 * from the snapshot's SHAPE — "nobody has left, nothing is charged, so this
 * must be init" — is wrong for exactly one event, and it is an event both
 * hockey codes need: `core.lineup.position` moves a player who never left the
 * field and bumps no counter anywhere in `SquadState`, so a shape test reads
 * the result as pristine and the module goes on reporting the wrong keeper.
 * FIH's "field player with goalkeeping privileges" is that event.
 *
 * The kernel hands `onLineup` the very object `init` returned, and only at
 * `init` (`core/events.ts` — `state = module.init(...)` then immediately
 * `state = module.onLineup(state, squads)`). A `WeakSet` keyed on that object
 * therefore identifies the handshake exactly, and consumes it: every later call
 * persists, including one for the first event in the stream. It changes no
 * observable output — two folds of the same inputs produce the same states,
 * because each `init` mints a fresh object — and a state whose `onLineup` is
 * never reached (`testkit/helpers.buildWalk`, `conformance`, `simulation` all
 * call `init` directly) is simply collected.
 */
export function makeSquadAdopter<S extends SquadCarrier>(): SquadAdopter<S> {
  const awaitingHandshake = new WeakSet<object>();
  return {
    fresh(state) {
      awaitingHandshake.add(state);
      return state;
    },
    adopt(state, squads) {
      if (awaitingHandshake.delete(state) && !declaresSquadDetail(squads)) return state;
      return { ...state, squads };
    },
  };
}

// ---------------------------------------------------------------------------
// The doubles readers — `tennis/DOMAIN.md` and `setbased/DOMAIN.tabletennis.md`
// ---------------------------------------------------------------------------

/**
 * The pair as the team sheet named it, first-named first.
 *
 * Both dossier rows say the same thing: the fixed rotation (ITF for tennis,
 * ITTF 2.8.3 for table tennis) is derivable from the service history ONLY once
 * you know which partner was named first, and that is a declaration, not a
 * derivation. `orderNo` cannot carry it — a five-pair table-tennis tie has five
 * first-named players — which is why `LineupSlot.pairOrder` exists.
 *
 * Ties on `pairOrder` fall back to `orderNo` so the answer is total and stable;
 * a side that declared no order at all returns empty rather than guessing.
 */
export function pairOrderOf(side: SideSquad): readonly string[] {
  return side.members
    .filter((member) => member.role === "player" && member.pairOrder !== undefined)
    .map((member) => ({ id: member.personId, pair: member.pairOrder ?? 0, order: member.orderNo }))
    .sort((a, b) => (a.pair === b.pair ? a.order - b.order : a.pair - b.pair))
    .map((member) => member.id);
}

/**
 * Who is due to serve this side's `turn`-th service turn (0-based) — the
 * rotation check the two dossier rows were deferred for.
 *
 * `null`, never a throw and never a guess, when the side declared no pair
 * order: a singles fixture and an under-filled team sheet are both legitimate,
 * and a fabricated id would be worse than no answer. The caller compares it
 * with the `server` the ledger recorded.
 */
export function expectedPairServer(side: SideSquad, turn: number): string | null {
  const order = pairOrderOf(side);
  if (order.length === 0 || !Number.isInteger(turn) || turn < 0) return null;
  return order[turn % order.length] ?? null;
}

/** `expectedPairServer` against a State that may not have adopted a squad yet. */
export function expectedPairServerOf(
  squads: SquadState | undefined,
  side: "home" | "away",
  turn: number,
): string | null {
  return squads === undefined ? null : expectedPairServer(squads[side], turn);
}
