import "server-only";
// W5 Task 11 (X-CUT-4 <- RB5-K6, signed OWNER S5; FX-G16's table half): the reads behind a correction inside a completed LEAGUE or
// GROUP source - the knockout's reads (knockout-cut-drift.ts) for the third kind of source. Before the destination starts the
// confirmed proposal goes stale and its seats go back (stages/seed-stale.ts `correctTableDependent`); after, the bracket stands and
// the desk warns (`getTableCutDrift`).
//
// Both ask the same thing of a proposal's slate: is the cut it names still the cut?
//   - BEFORE the start (`tableSlateStands`): today's cut as a RE-PROPOSAL would offer it - the proposal's own machinery
//     (`sourcesToTables`, `departedLoseBestNth`, `resolveStoredProgression`: a departed entrant leaves the cut and the next eligible
//     entrant takes her place, RB5-K1/K2, pinned by Task 9) - against the people AND the seed order the slate names: a bracket
//     seeds by rank, so a re-ordered cut re-seeds for nothing while nothing has started. A slate DRAWN across pools (W5 B I-6) is
//     judged on what the draw does not decide: the same people, each pool's in the same order. A departing entrant the slate names
//     is a difference outright: the cascade asks BEFORE it settles her lines, when her status is not yet written. Which slate
//     (W5 B m-1): a confirmed row keeps the slate as PROPOSED (`qualifiers`, the lot's answer to a tie) and the seats as HELD
//     (`seated`, after the organiser's tie picks and edits). A departure asks who holds a seat; a correction asks whether the cut
//     moved, and stands if today's cut is either one.
//   - AFTER the start (`getTableCutDrift`): the table as its RESULTS make it - a departed entrant keeps the place she earned
//     (`withoutDepartureBackfill`), and she is left out of both sides, so a withdrawal is no correction (RB4-V3: her seat is a
//     walkover, not a backfill) and only a moved RESULT is named. People alone, the Swiss reading: the same four are the same four.
//
// A completed league or group stays as it finished when someone leaves it later (RB5-L8, Task 8 C1): nothing here re-ranks it.
import { resolveStoredProgression } from "./stored-progression";
import type { AuthCtx } from "@/server/api-v1/auth";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { tableCutDrift, TABLE_CUT_DRIFT_KINDS, type TableCutDrift } from "@/lib/table-cut-drift";
import { log } from "@/server/logger";
import { stageHasStarted } from "./fixture-started-sql";
import { onSource, type BracketDependent, type Slate } from "./knockout-cut-drift";
import { departedLoseBestNth, sourcesToTables } from "./stage-seeding";
import { departedEntrantIds, setupDependentsOf } from "./stages";
import type { Tx } from "./stages/types";

export type { TableCutDrift };

/** Today's cut of `dependent` from `sourceStageId`, in seed order: as a re-proposal would offer it (departed entrants leave, the next
 *  eligible take their places), or - `asResultsMake` - as the results alone make it (a departed entrant keeps her place). Only the
 *  entrants this source puts through: another source's qualifiers are not this cut's to move. */
export async function tableCutToday(
  tx: Tx,
  dependent: BracketDependent,
  sourceStageId: string,
  opts: { asResultsMake?: boolean; alsoDeparted?: string } = {},
): Promise<string[]> {
  return (await tableSeatsToday(tx, dependent, sourceStageId, opts)).map((q) => q.entrantId);
}

/** `tableCutToday` with each entrant's SEED (a seat a departed qualifier holds is a seed nobody else takes) and source POOL. */
async function tableSeatsToday(
  tx: Tx,
  dependent: BracketDependent,
  sourceStageId: string,
  opts: { asResultsMake?: boolean; alsoDeparted?: string } = {},
): Promise<{ seed: number; entrantId: string; pool?: string }[]> {
  const asResultsMake = opts.asResultsMake === true;
  const also = new Set(opts.alsoDeparted === undefined ? [] : [opts.alsoDeparted]);
  const { shapes, tables, resolved } = await sourcesToTables(tx, dependent, dependent.progression.sources, {
    withoutDepartureBackfill: asResultsMake,
    alsoDeparted: also,
  });
  const read = asResultsMake
    ? tables
    : departedLoseBestNth(tables, resolved, new Set([...(await departedEntrantIds(tx, dependent.division_id)), ...also]));
  const today = resolveStoredProgression(dependent.progression, shapes, read, dependent.kind as never, resolved.map((r) => r.kind));
  return [...today.qualifiers]
    .filter((q) => resolved[q.sourceIndex]?.id === sourceStageId)
    .sort((a, b) => a.seed - b.seed)
    .map((q) => ({ seed: q.seed, entrantId: q.entrantId, ...(q.pool !== undefined ? { pool: q.pool } : {}) }));
}

/** W5 B final review I-6: does a DRAWN slate (in seat order) name the cut `today` names (in fold order)? The same people, and each
 *  pool's people in the same order - the places the cut was made of. Who sits where ACROSS the pools is the draw's: it shuffles the
 *  entrants level across pools with the stored seed and moves later tiers apart, so a correction that changes only who is level
 *  across the pools (or the void-then-re-enter of a level winner's result, judged at every event) moves no place. Each entrant's
 *  pool is read from today's cut; someone the slate names that today's does not is a difference outright. */
function samePoolOrders(today: readonly { entrantId: string; pool?: string }[], slate: readonly { entrantId: string }[]): boolean {
  const poolOf = new Map(today.map((q) => [q.entrantId, q.pool ?? ""] as const));
  if (today.length !== slate.length || slate.some((q) => !poolOf.has(q.entrantId))) return false;
  const byPool = (ids: readonly string[]) => {
    const out = new Map<string, string[]>();
    for (const id of ids) out.set(poolOf.get(id)!, [...(out.get(poolOf.get(id)!) ?? []), id]);
    return out;
  };
  const was = byPool(slate.map((q) => q.entrantId));
  return [...byPool(today.map((q) => q.entrantId))].every(([pool, ids]) => (was.get(pool) ?? []).join() === ids.join());
}

/**
 * Does `slate`'s part of the cut still stand, before the destination starts? EMPTY CASE FIRST: a slate that names nobody from this
 * source has nothing a correction could take away, and stands. `departing` is an entrant the withdrawal cascade is about to settle
 * (her status is not written yet), judged against the seats as HELD (`seated`, W5 B m-1: a tie picked against the lot seats
 * someone the proposed slate does not name): not named, nothing about her moves the cut (the table is not re-read); named, she is a
 * difference outright - unless nobody is left to take her place (the cut is EXHAUSTED: today's eligible cut is SHORTER than the
 * slate), in which case the proposal stands and her seat is the cascade's walkover (RB4-E7, R6). A correction or a Reinstate has no
 * `departing`: the cut as it reads today is compared with the slate, an exhausted one included. A source another source is not ready for cannot be judged: it
 * stands.
 */
export async function tableSlateStands(
  tx: Tx,
  dependent: BracketDependent,
  slate: Slate & { crossPoolDraw?: unknown; seated?: Slate["qualifiers"] },
  sourceStageId: string,
  departing?: string,
): Promise<boolean> {
  // W5 B final review m-1: who the confirm SEATED (a row confirmed before `seated` existed seated its slate as proposed).
  const held: Slate = { qualifiers: slate.seated ?? slate.qualifiers };
  const named = onSource(departing !== undefined ? held : slate, sourceStageId);
  if (named.length === 0) return true;
  if (departing !== undefined && !named.includes(departing)) return true;
  try {
    const seats = await tableSeatsToday(tx, dependent, sourceStageId, { alsoDeparted: departing });
    const out = await departedEntrantIds(tx, dependent.division_id);
    if (departing !== undefined) out.add(departing);
    // EXHAUSTED (RB4-E7, R6 "else walkover"): a DEPARTURE with fewer ELIGIBLE entrants left than the slate has seats - nobody to
    // take her place (a cut that runs out keeps her at her earned seat, so `seats` still names her; it is the eligible ones that
    // run out). Re-proposing would offer a short cut (a page playoff with a bye, breaking RB4-S2), so the confirmed proposal
    // stands and the seat is the cascade's walkover. ONLY for a departure: a correction (or a Reinstate) that re-orders an
    // exhausted cut changes the seeding, which drives the bracket (RB5-K6), and follows the comparison below.
    if (departing !== undefined && seats.filter((q) => !out.has(q.entrantId)).length < named.length) return true;
    // Someone is left to backfill, or nobody departed: the cut as it reads today against the slate, seat by seat. A departed
    // entrant's seat is compared on neither side (RB4-V3: it is a walkover, no correction), so what is checked is who holds each
    // OTHER seat - a dead seat that stays where it was earned moves nobody, and one a correction shifts moves everybody below it.
    const todaySeats = seats.filter((q) => !out.has(q.entrantId));
    const isToday = (s: Slate) => {
      const slateSeats = s.qualifiers.filter((q) => q.source.stageId === sourceStageId && !out.has(q.entrantId)).sort((a, b) => a.rank - b.rank);
      // W5 B final review I-6: a slate drawn across pools (`crossPoolDraw`) holds the DRAWN seeds (`drawAcrossPools` re-numbers
      // them), and today's cut is the undrawn fold, so seat for seat any draw that is not the identity "moved" - every 3-pool
      // knockout, where the fold's seed 3 v 6 is C1 v C2. Judged instead on the places it was drawn from (`samePoolOrders`).
      if (slate.crossPoolDraw !== undefined) return samePoolOrders(todaySeats, slateSeats);
      return todaySeats.length === slateSeats.length && todaySeats.every((q, i) => q.seed === slateSeats[i]!.rank && q.entrantId === slateSeats[i]!.entrantId);
    };
    // m-1: a departure against the seats as held - the slate as proposed would let the PICK's seat go to a walkover (today's cut
    // without her is the lot's, so it matches). A correction or a Reinstate stands on either: today's cut is the slate the
    // organiser answered (a pick against the lot is no drift), or it is exactly who sits (the lot's entrant left and the pick is
    // now the cut outright - reading the proposed slate alone would empty the bracket at the next correction instead).
    if (departing !== undefined) return isToday(held);
    return isToday(slate) || (slate.seated !== undefined && isToday(held));
  } catch (err) {
    if (err instanceof HttpError && err.code === "SEEDING_SOURCE_INCOMPLETE") return true;
    throw err;
  }
}

/**
 * Who a correction moved across a completed league's or group's cut after the destination started, or null (no warning). Null for:
 * a stage that is not a complete league or group, one nothing draws from at setup, a destination that has not started (the
 * correction re-proposes it instead: `stageHasStarted`, the reading the un-fill refuses on, so no start falls between the two), and
 * a cut that today's results still make. 404 for an unknown stage or another organisation's (RLS).
 *
 * A departed entrant is left out of both sides: her seat stands as a walkover (RB4-V3), which is no correction, and the next
 * eligible entrant is nobody's to name because no seat is hers to take. A started destination with no confirmed proposal on record is
 * a breach of "seats come from a confirm": logged and read as no warning, as the knockout read does (it runs on every render of the
 * division's Fixtures tab). A display read: takes no lock, writes nothing.
 */
export async function getTableCutDrift(auth: AuthCtx, sourceStageId: string): Promise<TableCutDrift | null> {
  return withTenant(auth.orgId, async (tx) => {
    const [source] = await tx<{ id: string; division_id: string; kind: string; status: string }[]>`
      select id, division_id, kind, status from stages where id = ${sourceStageId}`;
    if (!source) throw new HttpError(404, "stage not found");
    if (!TABLE_CUT_DRIFT_KINDS.has(source.kind) || source.status !== "complete") return null;
    for (const dependent of await setupDependentsOf(tx, source.id, source.division_id)) {
      if (!(await stageHasStarted(tx, dependent.id))) continue;
      const [confirmed] = await tx<{ computed: Slate }[]>`
        select computed from stage_seed_proposals where stage_id = ${dependent.id} and status = 'confirmed'
        order by confirmed_at desc nulls last, id limit 1`;
      if (!confirmed) {
        log.error({ event: "table_cut_drift_no_confirmed_cut", stageId: dependent.id, source: source.id }, "table_cut_drift_no_confirmed_cut");
        continue;
      }
      const departed = await departedEntrantIds(tx, source.division_id);
      const frozen = onSource(confirmed.computed, source.id).filter((id) => !departed.has(id));
      let today: string[];
      try {
        today = (await tableCutToday(tx, dependent, source.id, { asResultsMake: true })).filter((id) => !departed.has(id));
      } catch (err) {
        // A sibling source of the same destination that is not ready cannot be judged here: no warning until it is.
        if (err instanceof HttpError && err.code === "SEEDING_SOURCE_INCOMPLETE") continue;
        throw err;
      }
      const drift = tableCutDrift(frozen, today, true);
      if (drift !== null) return drift;
    }
    return null;
  });
}
