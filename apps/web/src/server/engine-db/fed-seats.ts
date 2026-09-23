import "server-only";
import type { Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { msg } from "@/lib/messages";
import {
  NEXT_MATCH_STARTED_CODE,
  nextMatchLabel,
  nextMatchStartedMessage,
  type NextMatchRef,
  type RoundCodeRef,
} from "@/lib/next-match-started";
import { boardRoundCodes, type RoundCodeFixture } from "@/components/v2/board/round-codes";

// OWNER RULING 2026-09-23 — a write that takes back a knockout decision takes
// back the names that decision advanced.
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
// and BEFORE anything is written, so a refusal here rolls the whole write back:
// the void is never recorded. The staff re-snapshot hatch
// (usecases/admin-fixture-config.ts) is the one other writer that can change a
// stored outcome, and calls it the same way.
//
// The rules, each a clause of the ruling:
//
//  - ONLY WHEN WHO ADVANCES CHANGED. The stored decision's winner (for the
//    winner edge) or loser (for the loser edge) differs from the new fold's —
//    by `advancingSides`, the same reading `onDecided` fills from. That covers
//    a void that erases the decision (the new fold advances nobody) AND, since
//    fix round 1 (controller ruling 2026-09-23), a void that FLIPS the winner
//    without the fold ever passing through undecided (a cricket chase re-scored
//    by voiding a no-ball ends on the same ball with the other side ahead).
//  - SAME STAGE ONLY. A cross-stage edge (`wireCrossFeeds`) is out of scope and
//    keeps exactly its old behaviour: not refused, not emptied.
//  - ONLY A NAME THIS FIXTURE PUT THERE. The seat must hold one of this
//    fixture's two entrants; anyone else is left alone.
//  - NOT STARTED, or REFUSED. The next fixture must be `scheduled`, carry no
//    outcome and hold no live (non-voided) score event. Otherwise the write is
//    refused with 409 NEXT_MATCH_STARTED, naming that match, and the organiser
//    unwinds from the latest match backwards.
//  - EXCEPT A WALKOVER THE CASCADE AWARDED (fix round 1). A next fixture that
//    `resolveBracketSeats` settled on its own — `forfeited`, `{kind: "award"}`,
//    and no live score event, because nobody ever recorded anything on it —
//    has not started in any sense a person would recognise, and there is
//    nothing on it for the organiser to void. It is RESET instead: back to
//    `scheduled` with no outcome, the seat emptied and its label restored,
//    the bye on its dead side left exactly where it is. Re-deciding this line
//    then seats the new winner and the cascade awards the walkover again.
//    Because that walkover itself advanced its winner (`advanceSettledByes`),
//    the reset follows it one more edge, under the same rules — this is the
//    ONE place the un-fill reaches past the fixture one edge away. An award
//    WITH a live event behind it (a withdrawal's `core.forfeit`) is a recorded
//    decision and refuses like any other.
//
// Every seat is planned — and every refusal raised — before any is written, so
// a refusal deep in the chain cannot leave an earlier seat half-undone, though
// the enclosing transaction would roll that back anyway.

interface Node {
  id: string;
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
  status: string;
  outcome: unknown;
  live_events: number;
}

type Side = "winner" | "loser";

interface Step {
  target: string;
  slot: 1 | 2;
  occupant: string;
  label: { key: string; params: { round: number; seq: number } } | null;
  /** The target is a cascade walkover being put back to `scheduled`. */
  reset: boolean;
}

/** Who a decision sends onward — a winner from a `win` or an `award`, a loser
 *  only from a `win`. `onDecided` (usecases/scoring.ts) fills from exactly
 *  this, so the un-fill can never disagree with the fill about who advanced. */
export function advancingSides(outcome: unknown): { winner: string | undefined; loser: string | undefined } {
  const o = (outcome ?? {}) as { kind?: string; winner?: string; loser?: string };
  return {
    winner: o.kind === "win" || o.kind === "award" ? o.winner : undefined,
    loser: o.kind === "win" ? o.loser : undefined,
  };
}

/** Has the next match started, in the ruling's own three terms. Each is
 *  checked on its own because each can hold alone: a `core.note` leaves a
 *  fixture `scheduled` with a live event; a recorded walkover carries an
 *  outcome with a single `core.forfeit` behind it. */
function hasStarted(t: Node): boolean {
  return t.status !== "scheduled" || t.outcome !== null || t.live_events > 0;
}

/** A walkover the SYSTEM awarded, which nobody played: `awardSeededByes`
 *  writes exactly `forfeited` + `{kind: "award"}` and no event. */
function isCascadeWalkover(t: Node): boolean {
  return t.status === "forfeited" && (t.outcome as { kind?: string } | null)?.kind === "award" && t.live_events === 0;
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
function drawnLabel(src: Node, side: Side): Step["label"] {
  if (src.timing === "setup") return null;
  return {
    key: side === "loser" ? "slot.loser_match" : "slot.winner_match",
    params: { round: src.round_no, seq: src.seq_in_round },
  };
}

async function readNode(tx: Tx, id: string): Promise<Node | undefined> {
  const [n] = await tx<Node[]>`
    select f.id, f.stage_id, f.round_no, f.seq_in_round, f.home_entrant_id, f.away_entrant_id,
           f.winner_to_fixture, f.winner_to_slot, f.loser_to_fixture, f.loser_to_slot,
           s.progression ->> 'timing' as timing, f.status, f.outcome,
           (select count(*)::int from score_events e
            where e.fixture_id = f.id and e.type <> 'core.void'
              and not exists (select 1 from score_events v
                              where v.fixture_id = e.fixture_id and v.voids_event_id = e.id)) as live_events
    from fixtures f join stages s on s.id = f.stage_id
    where f.id = ${id}`;
  return n;
}

interface Edge {
  side: Side;
  target: string;
  slot: 1 | 2;
}

/** The feed edges a change to `src` can reach: its winner edge when the winner
 *  moved, its loser edge when the loser did, each only when it is wired. */
function movedEdges(src: Node, moved: Record<Side, boolean>): Edge[] {
  const edges: Edge[] = [];
  const wired = (side: Side, target: string | null, slot: number | null) => {
    if (moved[side] && target !== null && (slot === 1 || slot === 2)) edges.push({ side, target, slot });
  };
  wired("winner", src.winner_to_fixture, src.winner_to_slot);
  wired("loser", src.loser_to_fixture, src.loser_to_slot);
  return edges;
}

/** Every SAME-STAGE fixture the plan below could reach from `src`, read
 *  WITHOUT a lock, into `out` — so the locks can all be taken in one global
 *  order before any of them is judged. A cross-stage target is dropped here,
 *  before it is ever locked (review M3): it is never un-filled, so its lock
 *  would only make this void wait on, or deadlock with, a match in another
 *  stage. `stage_id` never changes on a fixture, so this unlocked read of it is
 *  final. The walk follows a cascade walkover the way the plan does. */
async function reachable(tx: Tx, src: Node, moved: Record<Side, boolean>, out: Map<string, Node>): Promise<void> {
  for (const edge of movedEdges(src, moved)) {
    const t = await readNode(tx, edge.target);
    if (!t || t.stage_id !== src.stage_id || out.has(t.id)) continue;
    out.set(t.id, t);
    if (isCascadeWalkover(t)) {
      const was = advancingSides(t.outcome);
      await reachable(tx, t, { winner: was.winner !== undefined, loser: was.loser !== undefined }, out);
    }
  }
}

/** The next match as the SCHEDULE BOARD names it (fix round 2, controller
 *  ruling 2026-09-23): the board's own `boardRoundCodes` over the rows of its
 *  stage — the columns the board reads — with a lookup that RECORDS the
 *  dictionary key it chose instead of rendering it. The code goes out as that
 *  key, so each reader renders it in their own language
 *  (lib/next-match-started.ts); a round the board does not code carries none,
 *  and reads "R2·1" there and here alike. Read only on the way to a refusal. */
async function boardRef(tx: Tx, t: Node): Promise<NextMatchRef> {
  const [stage] = await tx<{ id: string; kind: string }[]>`select id, kind from stages where id = ${t.stage_id}`;
  const rows = await tx<RoundCodeFixture[]>`
    select id, stage_id, round_no, seq_in_round, ext_key, lane, is_final, third_place, conditional
    from fixtures where stage_id = ${t.stage_id}`;
  const recordKey = (key: string, vars?: Record<string, string | number>) => JSON.stringify({ key, params: vars ?? {} });
  const code = boardRoundCodes(rows, stage ? [stage] : [], recordKey).get(t.id)?.code;
  const ref: NextMatchRef = { fixture_id: t.id, round: t.round_no, seq: t.seq_in_round };
  return code === undefined ? ref : { ...ref, code: JSON.parse(code) as RoundCodeRef };
}

/** The SAME lock every append to that fixture takes (append-event.ts), held
 *  to commit. Without it the next match's first event could commit between
 *  the "not started" check and the write after it, and a match in play would
 *  lose a player; with it, that event waits for this transaction and then
 *  finds the seat empty. */
async function lockFixture(tx: Tx, id: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + id}))`;
}

/** Plan the seats `src` must give back when its winner and/or loser `moved`,
 *  appending to `plan`; throws the refusal the moment one seat cannot be.
 *  Every node is read here UNDER its lock — `locked` holds the ids already
 *  locked in bracket order by `releaseFedSeats`. */
async function planRelease(
  tx: Tx,
  src: Node,
  moved: Record<Side, boolean>,
  plan: Step[],
  locked: Set<string>,
): Promise<void> {
  const mine = new Set([src.home_entrant_id, src.away_entrant_id].filter((id): id is string => id !== null));
  for (const edge of movedEdges(src, moved)) {
    if (!locked.has(edge.target)) {
      // Not reached by the unlocked walk: a cross-stage target (never locked,
      // never touched), or a walkover the cascade awarded in the moment
      // between that walk and the locks. Only the second is locked, late and
      // so out of order — a window a concurrent cascade must hit exactly.
      const peek = await readNode(tx, edge.target);
      if (!peek || peek.stage_id !== src.stage_id) continue;
      await lockFixture(tx, edge.target);
      locked.add(edge.target);
    }
    const t = await readNode(tx, edge.target);
    if (!t) continue;
    const occupant = edge.slot === 1 ? t.home_entrant_id : t.away_entrant_id;
    if (occupant === null || !mine.has(occupant)) continue;
    const reset = isCascadeWalkover(t);
    if (!reset && hasStarted(t)) {
      const ref = await boardRef(tx, t);
      throw new HttpError(409, nextMatchStartedMessage(nextMatchLabel(ref, msg)), NEXT_MATCH_STARTED_CODE, { next_match: ref });
    }
    plan.push({ target: t.id, slot: edge.slot, occupant, label: drawnLabel(src, edge.side), reset });
    if (reset) {
      // The walkover goes back to undecided, so whatever IT advanced moves too.
      const was = advancingSides(t.outcome);
      await planRelease(tx, t, { winner: was.winner !== undefined, loser: was.loser !== undefined }, plan, locked);
    }
  }
}

/**
 * Give back the seats `fixtureId`'s stored decision (`before`) had filled and
 * its new fold (`after`) no longer fills, or refuse.
 *
 * A no-op — not one query — unless there WAS a stored decision and who it
 * advances changed, so the hot append path pays nothing for an ordinary event.
 *
 * Returns the ids of the fixtures it actually changed — from each update's own
 * `returning id`, never re-derived — so a caller can publish exactly what
 * changed (the same contract `fillSlot`'s callers rely on).
 *
 * @throws HttpError 409 NEXT_MATCH_STARTED when a seat it would empty belongs
 *   to a match that has already started.
 */
export async function releaseFedSeats(
  tx: Tx,
  fixtureId: string,
  before: unknown,
  after: unknown,
): Promise<string[]> {
  if (before === null || before === undefined) return [];
  const was = advancingSides(before);
  const now = advancingSides(after);
  const moved = { winner: was.winner !== now.winner, loser: was.loser !== now.loser };
  if (!moved.winner && !moved.loser) return [];
  const src = await readNode(tx, fixtureId);
  if (!src) return [];

  // LOCK ORDER (review M1). This transaction already holds `src`'s own lock —
  // the append took it first. Taking the targets edge by edge (winner, then
  // loser) deadlocked a page playoff: pp-q1's void took the final, then queued
  // on pp-q2, while pp-q2's void held pp-q2 and queued on the final; a double
  // elimination's winners' final and losers' final do the same over the grand
  // final. So every target is found first without a lock, then locked in ONE
  // global order — ascending (round_no, id). Every generator numbers rounds so
  // a feed edge always points to a LATER round (bracket.ts: a double
  // elimination's losers' lane is numbered after the winners' lane), so that
  // order is also bracket order: a transaction never holds a later match's
  // lock while it asks for an earlier one's, including the source lock it
  // started with. That is what rules the cycle out.
  const reach = new Map<string, Node>();
  await reachable(tx, src, moved, reach);
  const order = [...reach.values()].sort((a, b) => a.round_no - b.round_no || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const t of order) await lockFixture(tx, t.id);

  const plan: Step[] = [];
  await planRelease(tx, src, moved, plan, new Set(reach.keys()));

  const released: string[] = [];
  for (const p of plan) {
    const json = p.label === null ? null : tx.json(p.label as never);
    const seatCol = p.slot === 1 ? tx`home_entrant_id` : tx`away_entrant_id`;
    const labelCol = p.slot === 1 ? tx`home_slot_label` : tx`away_slot_label`;
    // Guarded on the occupant the plan saw, so the write can only ever take
    // back the name it was judged on.
    const [row] = p.reset
      ? await tx<{ id: string }[]>`
          update fixtures set ${seatCol} = null, ${labelCol} = ${json}, status = 'scheduled', outcome = null
          where id = ${p.target} and ${seatCol} = ${p.occupant} returning id`
      : await tx<{ id: string }[]>`
          update fixtures set ${seatCol} = null, ${labelCol} = ${json}
          where id = ${p.target} and ${seatCol} = ${p.occupant} returning id`;
    if (row && !released.includes(row.id)) released.push(row.id);
  }
  return released;
}
