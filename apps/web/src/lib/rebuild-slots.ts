// W3 Task 1 (X-RB-1, design G3, #840, FX-G13): which slot a rebuilt fixture
// inherits. Pure and client-safe on purpose — the server's Rebuild applies it
// inside its one transaction, the pre-Start Swiss reshape (W3 T2) chooses its
// doomed boards with the same order, and the desk and later tasks (W3 T12's
// freed-slot report on a deleted round, W5's league rows) read the same rule
// rather than restating it.

import { isSwissBoardExtKey, isSwissByeShellExtKey } from "@/lib/swiss-shell";

/** Where a fixture sits on its stage's timetable, independent of who plays. */
export type SlotKey = { round_no: number; seq_in_round: number; pool_id: string | null };

/** What an organiser laid out on a fixture, and what a Rebuild carries over. */
export type CarriedSlot = {
  scheduled_at: string | null;
  court_id: string | null;
  venue_id: string | null;
  schedule_locked: boolean;
};

/** The four fields that make up a slot, in whatever shape a caller reads them
 *  (postgres.js parses `timestamptz` into a Date). */
export type SlotFields = {
  scheduled_at: Date | string | null;
  court_id: string | null;
  venue_id: string | null;
  schedule_locked: boolean;
};

/**
 * THE "holds a slot" predicate (W3 fix round 1, controller ruling: one
 * authority): an organiser set a time, a court, a venue, or a pin. A row with
 * none of the four holds no slot, so there is nothing to keep, to free, or to
 * protect from a shrink. Rebuild's carry and the pre-Start Swiss reshape both
 * read it, through `carrySlots` and `chooseDoomedBoards`.
 */
export function holdsSlot(s: SlotFields): boolean {
  return s.scheduled_at !== null || s.court_id !== null || s.venue_id !== null || s.schedule_locked;
}

/** A Swiss board a shrinking round may delete. */
export type DoomCandidate = SlotFields & { id: string; ext_key: string | null; seq_in_round: number };

/**
 * W3 T2 (SW-L8, X-RB-1; spec §4 "Before Start" inherits G3): which of a
 * round's BOARD shells a shrinking round loses, and where the rest sit. The
 * surplus is chosen so an organiser's layout survives: a board that holds no
 * slot (`holdsSlot`) goes first, then one that is not `schedule_locked`, then
 * the highest `seq_in_round` (the old rule, now the last tie-break). Survivors
 * keep their identity and `ext_key`, in their prior seq order, re-packed to
 * `seq_in_round` 1..keep.
 *
 * Read by the pre-Start reshape (`reconcileSwissRoundShells`, which deletes the
 * doomed rows) and by Rebuild (`carrySlots`, which hands the survivors' slots
 * to the regenerated boards and frees the doomed ones'), so the two never
 * disagree on which board's slot a shrink keeps.
 *
 * Board rows only: a bye shell is never a board, and is refused by name.
 */
export function chooseDoomedBoards<T extends DoomCandidate>(
  rows: readonly T[],
  keep: number,
): { survivors: T[]; doomed: T[] } {
  if (!Number.isInteger(keep) || keep < 0) {
    throw new RangeError(`chooseDoomedBoards: keep must be a whole number >= 0, got ${keep}`);
  }
  const bye = rows.find((r) => isSwissByeShellExtKey(r.ext_key));
  if (bye) throw new RangeError(`chooseDoomedBoards: ${bye.ext_key} is a bye shell, not a board`);
  const inOrder = [...rows].sort((a, b) => a.seq_in_round - b.seq_in_round);
  const doomOrder = [...inOrder].sort(
    (a, b) =>
      Number(holdsSlot(a)) - Number(holdsSlot(b)) ||
      Number(a.schedule_locked) - Number(b.schedule_locked) ||
      b.seq_in_round - a.seq_in_round,
  );
  const doomedIds = new Set(doomOrder.slice(0, Math.max(0, inOrder.length - keep)).map((r) => r.id));
  return {
    survivors: inOrder.filter((r) => !doomedIds.has(r.id)).map((r, i) => ({ ...r, seq_in_round: i + 1 }) as T),
    doomed: inOrder.filter((r) => doomedIds.has(r.id)),
  };
}

export interface CarrySlotsResult {
  /** New fixture id → the slot it inherits. Only positions whose old row held
   *  a slot are listed: a matched row whose old row held nothing has nothing to
   *  carry. */
  assign: Map<string, CarriedSlot>;
  /** Slots (a time, a court, a venue or a pin — `holdsSlot`) that no rebuilt
   *  fixture inherits, because their position is gone or a shrinking Swiss
   *  round doomed their board. Reported, never silently dropped. */
  freed: CarriedSlot[];
  /** New fixture ids at a position that did not exist before, so nothing could
   *  be carried onto them — counted only when the stage had a layout at all
   *  (some old row held a slot). On a stage nobody laid out, every fixture was
   *  unscheduled before and after, so the rebuild left nothing unscheduled. */
  unscheduled: string[];
}

/** The counts the Rebuild answer reports (`RebuildResult.slots`). */
export function carriedSlotCounts(r: CarrySlotsResult): { kept: number; freed: number; unscheduled: number } {
  return { kept: r.assign.size, freed: r.freed.length, unscheduled: r.unscheduled.length };
}

function positionOf(k: SlotKey): string {
  return `${k.pool_id ?? ""}|${k.round_no}|${k.seq_in_round}`;
}

/** A row `carrySlots` reads. `bye` says the row is a bye line (`isByeLine`, lib/bye-line.ts — W4 T4): a caller that
 *  holds the whole row passes it. Absent, it is read off the Swiss bye shell's `ext_key` alone — the bye-line predicate
 *  of a Swiss stage, whose only bye is that shell; the round-count admin reads nothing more. */
type CarryRow = SlotKey & { ext_key: string | null; bye?: boolean };
export type CarryBeforeRow = CarryRow & CarriedSlot;
export type CarryAfterRow = CarryRow & { id: string };

/** W4 T4 (K3): how each side's rows are matched. Default: the position, `(pool, round, seq)`. A knockout passes its
 *  bracket ROLE (`bracketRoleKey`, lib/bracket-role.ts), each side against its own final, because a knockout's round
 *  numbers count from the first round and move when the bracket changes size. */
export interface CarryKeys<B, A> {
  before: (row: B) => string;
  after: (row: A) => string;
}

const isByeRow = (r: CarryRow): boolean => r.bye ?? isSwissByeShellExtKey(r.ext_key);

const roundOf = (k: Pick<SlotKey, "pool_id" | "round_no">) => `${k.pool_id ?? ""}|${k.round_no}`;

/**
 * Carry the old rows' slots onto the new rows by POSITION —
 * `(pool_id, round_no, seq_in_round)`. A rebuild re-draws who plays whom, never
 * where the stage's n-th match of round r sits on the timetable, so a position
 * that survives keeps its slot whatever the regenerate put on it. Matching
 * never crosses pools: pool A's round-1 match 1 is not pool B's.
 *
 * A Swiss round is the one exception to "the same seq" (W3 fix round 1,
 * controller ruling): when a round's boards shrink, which old boards keep a
 * slot is chosen by `chooseDoomedBoards` — the same order the pre-Start
 * reshape deletes by — so a pinned b4 hands its slot to the new b3 while a
 * bare b3 is the one that goes. The survivors' re-packed seqs are the
 * positions matched against the regenerated boards.
 *
 * A bye line (the row's `bye`; absent, a Swiss bye shell by `ext_key`) never
 * gives or takes a slot (RB3-23, X-SD-5: a bye is never on a court). A new line
 * at a position an old bye held starts unscheduled; an old bye's own slot is
 * not reported freed, because a bye's slot was never a real one (W3 T3 and
 * W4 T3 clear and forbid them). A bye is never in `unscheduled` either — it
 * needs no slot. A line that BECOMES a bye frees the slot its position held.
 *
 * A knockout matches by bracket role instead of position (`keys`, W4 T4, K3):
 * the final keeps the final's slot whatever size the bracket is rebuilt to.
 *
 * Positions are unique per pool by construction (every generator numbers
 * `seq_in_round` per pool and round; `addFixture` takes the round's next seq).
 * Should two rows ever share one anyway, the first claims it: a second old
 * row's slot is reported freed and a second new row is unscheduled, so nothing
 * is dropped without being counted.
 */
export function carrySlots<B extends CarryBeforeRow, A extends CarryAfterRow>(
  before: readonly B[],
  after: readonly A[],
  keys?: CarryKeys<B, A>,
): CarrySlotsResult {
  const keyBefore: (row: B) => string = keys?.before ?? positionOf;
  const keyAfter: (row: A) => string = keys?.after ?? positionOf;
  // Swiss rounds: how many boards each regenerated round has, and which old
  // boards keep a slot there. An old row is named by its index in `before`.
  const newBoards = new Map<string, number>();
  for (const row of after) {
    if (isSwissBoardExtKey(row.ext_key)) newBoards.set(roundOf(row), (newBoards.get(roundOf(row)) ?? 0) + 1);
  }
  const oldBoards = new Map<string, (CarriedSlot & { ext_key: string | null; seq_in_round: number; id: string })[]>();
  before.forEach((row, i) => {
    if (!isSwissBoardExtKey(row.ext_key)) return;
    const list = oldBoards.get(roundOf(row)) ?? [];
    list.push({ ...row, id: String(i) });
    oldBoards.set(roundOf(row), list);
  });
  /** Old row index → its seq once the round is re-packed, or null when doomed. */
  const placed = new Map<number, number | null>();
  for (const [round, boards] of oldBoards) {
    const { survivors, doomed } = chooseDoomedBoards(boards, newBoards.get(round) ?? 0);
    for (const s of survivors) placed.set(Number(s.id), s.seq_in_round);
    for (const d of doomed) placed.set(Number(d.id), null);
  }

  const free = new Map<string, CarriedSlot>();
  const freed: CarriedSlot[] = [];
  const claimed = new Set<string>();
  let laidOut = false;
  before.forEach((row, i) => {
    if (isByeRow(row)) return;
    const slot: CarriedSlot = {
      scheduled_at: row.scheduled_at,
      court_id: row.court_id,
      venue_id: row.venue_id,
      schedule_locked: row.schedule_locked,
    };
    if (holdsSlot(slot)) laidOut = true;
    const seq = placed.has(i) ? placed.get(i)! : row.seq_in_round;
    if (seq === null) {
      if (holdsSlot(slot)) freed.push(slot);
      return;
    }
    const at = keyBefore({ ...row, seq_in_round: seq });
    if (claimed.has(at)) {
      if (holdsSlot(slot)) freed.push(slot);
      return;
    }
    claimed.add(at);
    free.set(at, slot);
  });

  const assign = new Map<string, CarriedSlot>();
  const unscheduled: string[] = [];
  for (const row of after) {
    if (isByeRow(row)) continue;
    const at = keyAfter(row);
    if (!free.has(at)) {
      if (laidOut) unscheduled.push(row.id);
      continue;
    }
    const slot = free.get(at)!;
    free.delete(at);
    if (holdsSlot(slot)) assign.set(row.id, slot);
  }

  for (const slot of free.values()) if (holdsSlot(slot)) freed.push(slot);
  return { assign, freed, unscheduled };
}
