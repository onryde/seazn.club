import "server-only";
import type { Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import {
  NEXT_MATCH_STARTED_CODE,
  nextMatchStartedMessage,
  type NextMatchRef,
} from "@/lib/next-match-started";

// OWNER RULING 2026-09-23 — a void that ERASES a knockout decision takes back
// the name that decision advanced.
//
// A decided fixture seats its winner (and, on a `loser_to` edge, its loser) in
// the fixture it feeds, through `fillSlot` (usecases/stages.ts), which only
// ever writes a NULL seat. Nothing emptied one: a void that erased the result
// left the old winner standing in the next round, and re-scoring the match the
// other way ran a fill that touched no row. This is the missing inverse. The
// forward half needs no new code — once the seat is empty again, the ordinary
// fill on the next decision seats whoever wins.
//
// Called INSIDE the append's own transaction (append-event.ts), after the fold
// has shown the decision is gone and BEFORE anything is written, so a refusal
// here rolls the whole write back: the void is never recorded. The staff
// re-snapshot hatch (usecases/admin-fixture-config.ts) is the one other writer
// that can erase an outcome, and calls it the same way.
//
// The rules, each a clause of the ruling:
//
//  - SAME STAGE ONLY. A cross-stage edge (`wireCrossFeeds`) is out of scope and
//    keeps exactly its old behaviour: not refused, not emptied.
//  - ONLY A NAME THIS FIXTURE PUT THERE. The seat must hold one of this
//    fixture's two entrants; anyone else is left alone.
//  - NOT STARTED, or REFUSED. The next fixture must be `scheduled`, carry no
//    outcome and hold no live (non-voided) score event. Otherwise the void is
//    refused with 409 NEXT_MATCH_STARTED, naming that match, and the organiser
//    unwinds from the latest match backwards. There is deliberately no chain
//    logic: this never reaches past the fixture one edge away.
//
// Every seat is checked before any is emptied, so a refusal on the loser edge
// cannot leave the winner edge half-undone — though the enclosing transaction
// would roll that back anyway.

interface Source {
  stage_id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
  loser_to_fixture: string | null;
  loser_to_slot: number | null;
  timing: string | null;
}

interface Target {
  id: string;
  stage_id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome: unknown;
  live_events: number;
}

type Side = "winner" | "loser";

/** Has the next match started, in the ruling's own three terms. Each is
 *  checked on its own because each can hold alone: a `core.note` leaves a
 *  fixture `scheduled` with a live event; a system-settled walkover carries an
 *  outcome with no events at all. */
function hasStarted(t: Target): boolean {
  return t.status !== "scheduled" || t.outcome !== null || t.live_events > 0;
}

/** The label a fed seat carried BEFORE anything filled it — the same value
 *  the generator wrote, never a new shape.
 *
 *  The plain generator (`generateStageFixtures`' `matchSlotLabel`) stamps
 *  `slot.winner_match` / `slot.loser_match` with the FEEDER's `{round, seq}`.
 *  A `timing: "setup"` progression (`generateProgressionSetupFixtures`) leaves
 *  a sibling-fed seat NULL on purpose, because `fixtureAwaitsSeedDraw`
 *  (lib/division-phase.ts) reads a label beside an empty seat as "this seat
 *  still owes the draw" — stamping one there would put a drawn bracket back
 *  on the desk as "Needs draw". Every renderer names a NULL seat from the feed
 *  edges instead (`feedLabels`), so both read "Winner of R1·2" again. */
function drawnLabel(src: Source, side: Side): { key: string; params: { round: number; seq: number } } | null {
  if (src.timing === "setup") return null;
  return {
    key: side === "loser" ? "slot.loser_match" : "slot.winner_match",
    params: { round: src.round_no, seq: src.seq_in_round },
  };
}

/**
 * Empty the seats `fixtureId`'s erased decision had filled, or refuse.
 *
 * Returns the ids of the fixtures it actually emptied a seat in — from each
 * update's own `returning id`, never re-derived — so a caller can publish
 * exactly what changed (the same contract `fillSlot`'s callers rely on).
 *
 * @throws HttpError 409 NEXT_MATCH_STARTED when a seat it would empty belongs
 *   to a match that has already started.
 */
export async function releaseFedSeats(tx: Tx, fixtureId: string): Promise<string[]> {
  const [src] = await tx<Source[]>`
    select f.stage_id, f.round_no, f.seq_in_round, f.home_entrant_id, f.away_entrant_id,
           f.winner_to_fixture, f.winner_to_slot, f.loser_to_fixture, f.loser_to_slot,
           s.progression ->> 'timing' as timing
    from fixtures f join stages s on s.id = f.stage_id
    where f.id = ${fixtureId}`;
  if (!src) return [];
  const mine = new Set([src.home_entrant_id, src.away_entrant_id].filter((id): id is string => id !== null));

  const edges: { side: Side; target: string | null; slot: number | null }[] = [
    { side: "winner", target: src.winner_to_fixture, slot: src.winner_to_slot },
    { side: "loser", target: src.loser_to_fixture, slot: src.loser_to_slot },
  ];
  const plan: { side: Side; target: string; slot: 1 | 2; occupant: string }[] = [];
  for (const edge of edges) {
    if (edge.target === null || (edge.slot !== 1 && edge.slot !== 2)) continue;
    // The SAME lock every append to that fixture takes (append-event.ts), held
    // to commit. Without it the next match's first event could commit between
    // the check below and the write after it: the check reads "not started",
    // the event lands, and a match in play loses a player. With it, that event
    // waits for this transaction and then finds the seat empty.
    await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + edge.target}))`;
    const [t] = await tx<Target[]>`
      select f.id, f.stage_id, f.round_no, f.seq_in_round, f.home_entrant_id, f.away_entrant_id,
             f.status, f.outcome,
             (select count(*)::int from score_events e
              where e.fixture_id = f.id and e.type <> 'core.void'
                and not exists (select 1 from score_events v
                                where v.fixture_id = e.fixture_id and v.voids_event_id = e.id)) as live_events
      from fixtures f where f.id = ${edge.target}`;
    if (!t || t.stage_id !== src.stage_id) continue;
    const occupant = edge.slot === 1 ? t.home_entrant_id : t.away_entrant_id;
    if (occupant === null || !mine.has(occupant)) continue;
    if (hasStarted(t)) {
      const ref: NextMatchRef = { fixture_id: t.id, round: t.round_no, seq: t.seq_in_round };
      throw new HttpError(409, nextMatchStartedMessage(ref), NEXT_MATCH_STARTED_CODE, { next_match: ref });
    }
    plan.push({ side: edge.side, target: t.id, slot: edge.slot, occupant });
  }

  const released: string[] = [];
  for (const p of plan) {
    const label = drawnLabel(src, p.side);
    const json = label === null ? null : tx.json(label as never);
    // Guarded on the occupant this check saw, so the write can only ever take
    // back the name it was judged on.
    const [row] =
      p.slot === 1
        ? await tx<{ id: string }[]>`
            update fixtures set home_entrant_id = null, home_slot_label = ${json}
            where id = ${p.target} and home_entrant_id = ${p.occupant} returning id`
        : await tx<{ id: string }[]>`
            update fixtures set away_entrant_id = null, away_slot_label = ${json}
            where id = ${p.target} and away_entrant_id = ${p.occupant} returning id`;
    if (row && !released.includes(row.id)) released.push(row.id);
  }
  return released;
}
