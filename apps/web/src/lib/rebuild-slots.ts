// W3 Task 1 (X-RB-1, design G3, #840, FX-G13): which slot a rebuilt fixture
// inherits. Pure and client-safe on purpose — the server's Rebuild applies it
// inside its one transaction, and the desk and later tasks (W3 T12's freed-slot
// report on a deleted round, W5's league rows) read the same rule rather than
// restating it.

import { isSwissByeShellExtKey } from "@/lib/swiss-shell";

/** Where a fixture sits on its stage's timetable, independent of who plays. */
export type SlotKey = { round_no: number; seq_in_round: number; pool_id: string | null };

/** What an organiser laid out on a fixture, and what a Rebuild carries over. */
export type CarriedSlot = {
  scheduled_at: string | null;
  court_id: string | null;
  venue_id: string | null;
  schedule_locked: boolean;
};

export interface CarrySlotsResult {
  /** New fixture id → the slot it inherits. Only positions whose old row held
   *  a slot are listed: a matched row whose old row held nothing has nothing to
   *  carry. */
  assign: Map<string, CarriedSlot>;
  /** Slots whose position no longer exists, so the time or court they held is
   *  no longer used by this stage. Reported, never silently dropped. */
  freed: CarriedSlot[];
  /** New fixture ids whose position did not exist before, so nothing could be
   *  carried onto them. */
  unscheduled: string[];
}

/** Anything an organiser set: a time, a court, a venue, or a pin. A row with
 *  none of the four holds no slot, so there is nothing to keep or to free. */
function holdsSlot(s: CarriedSlot): boolean {
  return s.scheduled_at !== null || s.court_id !== null || s.venue_id !== null || s.schedule_locked;
}

function positionOf(k: SlotKey): string {
  return `${k.pool_id ?? ""}|${k.round_no}|${k.seq_in_round}`;
}

/**
 * Carry the old rows' slots onto the new rows by POSITION —
 * `(pool_id, round_no, seq_in_round)`. A rebuild re-draws who plays whom, never
 * where the stage's n-th match of round r sits on the timetable, so a position
 * that survives keeps its slot whatever the regenerate put on it. Matching
 * never crosses pools: pool A's round-1 match 1 is not pool B's.
 *
 * A Swiss bye shell (`isSwissByeShellExtKey`) never gives or takes a slot
 * (RB3-23: a bye is never on a court). The board that held the position a bye
 * now occupies has its slot reported in `freed`; a new board at a position an
 * old bye held starts unscheduled; and an old bye's own slot is not reported
 * freed, because a bye's slot was never a real one (W3 T3 clears and forbids
 * them). A bye is never in `unscheduled` either — it needs no slot.
 *
 * Positions are unique per pool by construction (every generator numbers
 * `seq_in_round` per pool and round; `addFixture` takes the round's next seq).
 * Should two rows ever share one anyway, the first claims it: a second old
 * row's slot is reported freed and a second new row is unscheduled, so nothing
 * is dropped without being counted.
 */
export function carrySlots(
  before: ReadonlyArray<SlotKey & CarriedSlot & { ext_key: string | null }>,
  after: ReadonlyArray<SlotKey & { id: string; ext_key: string | null }>,
): CarrySlotsResult {
  const free = new Map<string, CarriedSlot>();
  const freed: CarriedSlot[] = [];
  const claimed = new Set<string>();
  for (const row of before) {
    if (isSwissByeShellExtKey(row.ext_key)) continue;
    const slot: CarriedSlot = {
      scheduled_at: row.scheduled_at,
      court_id: row.court_id,
      venue_id: row.venue_id,
      schedule_locked: row.schedule_locked,
    };
    const at = positionOf(row);
    if (claimed.has(at)) {
      if (holdsSlot(slot)) freed.push(slot);
      continue;
    }
    claimed.add(at);
    free.set(at, slot);
  }

  const assign = new Map<string, CarriedSlot>();
  const unscheduled: string[] = [];
  for (const row of after) {
    if (isSwissByeShellExtKey(row.ext_key)) continue;
    const at = positionOf(row);
    if (!free.has(at)) {
      unscheduled.push(row.id);
      continue;
    }
    const slot = free.get(at)!;
    free.delete(at);
    if (holdsSlot(slot)) assign.set(row.id, slot);
  }

  for (const slot of free.values()) if (holdsSlot(slot)) freed.push(slot);
  return { assign, freed, unscheduled };
}
