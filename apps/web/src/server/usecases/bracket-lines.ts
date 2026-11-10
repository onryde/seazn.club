// W4 app-A Task 8 (FX-G2, MB-004/005): the line SURGERIES a knockout's reconcile makes in place, in the caller's
// transaction — the only two shapes a first-round line moves between before Start:
//   - `reopenByeLine`: a bye becomes a match again, a newcomer seated in its empty seat (RB4-L4 picks which bye,
//     `chooseByeLine`), and the holder it had already carried into the next line taken back out, that seat waiting on
//     this line's winner again;
//   - `vacateLineToBye`: a departed entrant's seat empties, the line becomes a bye for the side that stays, and that side
//     is carried into the next line — its seat filled AND its "winner of match …" label cleared in the same statement.
//     Filling without the clear is what made main's Generate 500 ("would strand home_slot_label").
// Shared with Task 10 (a late entrant takes a bye the same way). Each guard is a named refusal: a surgery asked of a line
// that is not the shape it expects is a caller's bug, never a guess.
import { seedPositions } from "@seazn/engine/scheduling";
import type { Tx } from "@/lib/db";
import { BYE_SLOT_LABEL, byePhantomSide, isByeLine, type ByeLineRow } from "@/lib/bye-line";
import { byeAward } from "@/lib/fixture-bye";
import { chooseByeLine, type ByeLineCandidate, type Seat } from "@/lib/bracket-reconcile";
import { fixtureEvidenceSql } from "./fixture-results-sql";
import { appendEventInTx } from "@/server/engine-db/append-event";
// A value read at call time only (the withdrawal module's own source of "departed"): entrants.ts reaches this file
// through the late-entry admission, and nothing here runs at import.
import { DEPARTED_STATUSES } from "./entrants";

export { chooseByeLine };

/** A surgery refused: the line is missing or not the shape the surgery changes. */
export class ByeLineSurgeryError extends Error {
  constructor(
    readonly surgery: "reopenByeLine" | "vacateLineToBye" | "byeLineCandidates" | "reverseWithdrawnWalkover",
    readonly lineId: string,
    why: string,
  ) {
    super(`${surgery}(${lineId}): ${why}`);
    this.name = "ByeLineSurgeryError";
  }
}

interface LineRow extends ByeLineRow {
  id: string;
  stage_id: string;
  round_no: number;
  seq_in_round: number;
  winner_to_fixture: string | null;
  winner_to_slot: number | null;
  evidence: boolean;
}

/** The line, locked for the surgery, with whether anything was recorded against it. */
async function lockLine(tx: Tx, lineId: string): Promise<LineRow | undefined> {
  const [row] = await tx<LineRow[]>`
    select f.id, f.stage_id, f.round_no, f.seq_in_round, f.ext_key, f.status, f.outcome,
           f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
           f.winner_to_fixture, f.winner_to_slot, ${fixtureEvidenceSql(tx, "f")} as evidence
      from fixtures f where f.id = ${lineId} for update`;
  return row;
}

/** The seat a line's winner fills in the next line, or a named refusal (a line that feeds nothing has no next seat). */
function nextSeatOf(surgery: ByeLineSurgeryError["surgery"], row: LineRow): { next: string; slot: 1 | 2 } {
  if (row.winner_to_fixture === null || (row.winner_to_slot !== 1 && row.winner_to_slot !== 2)) {
    throw new ByeLineSurgeryError(surgery, row.id, "the line feeds no next line, so it can be no bye");
  }
  return { next: row.winner_to_fixture, slot: row.winner_to_slot };
}

/**
 * A bye line becomes a match: `newcomerId` takes its empty (phantom) seat, the award is reversed, and the holder is taken
 * back out of the next line's seat, which waits on this line's winner again (`slot.winner_match`, the label every
 * Generate gives a seat a real line feeds). Refused by name unless the line is a bye with one holder, an empty seat and
 * nothing recorded against it, and its holder sits in the seat it feeds.
 */
export async function reopenByeLine(tx: Tx, lineId: string, newcomerId: string): Promise<{ fixtureId: string; holderId: string; nextId: string }> {
  const row = await lockLine(tx, lineId);
  if (row === undefined) throw new ByeLineSurgeryError("reopenByeLine", lineId, "no such line");
  if (!isByeLine(row)) throw new ByeLineSurgeryError("reopenByeLine", lineId, "the line is not a bye");
  if (row.evidence) throw new ByeLineSurgeryError("reopenByeLine", lineId, "the line has something recorded against it");
  const phantom = byePhantomSide(row);
  if (phantom === null) throw new ByeLineSurgeryError("reopenByeLine", lineId, "the bye has no empty seat to fill");
  const holderId = phantom === "home" ? row.away_entrant_id : row.home_entrant_id;
  if (holderId === null) throw new ByeLineSurgeryError("reopenByeLine", lineId, "the bye has no holder");
  const { next, slot } = nextSeatOf("reopenByeLine", row);
  await tx`
    update fixtures set
      home_entrant_id = case when ${phantom} = 'home' then ${newcomerId}::uuid else home_entrant_id end,
      home_slot_label = case when ${phantom} = 'home' then null else home_slot_label end,
      away_entrant_id = case when ${phantom} = 'away' then ${newcomerId}::uuid else away_entrant_id end,
      away_slot_label = case when ${phantom} = 'away' then null else away_slot_label end,
      status = 'scheduled',
      outcome = null
    where id = ${lineId}`;
  const waiting = { key: "slot.winner_match", params: { round: row.round_no, seq: row.seq_in_round } };
  const taken = await tx`
    update fixtures set
      home_entrant_id = case when ${slot}::int = 1 then null else home_entrant_id end,
      home_slot_label = case when ${slot}::int = 1 then ${tx.json(waiting)} else home_slot_label end,
      away_entrant_id = case when ${slot}::int = 2 then null else away_entrant_id end,
      away_slot_label = case when ${slot}::int = 2 then ${tx.json(waiting)} else away_slot_label end
    where id = ${next} and (case when ${slot}::int = 1 then home_entrant_id else away_entrant_id end) = ${holderId}::uuid
    returning id`;
  if (taken.length !== 1) {
    throw new ByeLineSurgeryError("reopenByeLine", lineId, `the holder ${holderId} is not in the seat the line feeds`);
  }
  return { fixtureId: lineId, holderId, nextId: next };
}

/**
 * A match becomes a bye: `seat` empties (its entrant left, or was deleted), the side that stays is awarded the bye, the
 * line gives up any time and court (a bye is not played, X-SD-5), and the holder is carried into the next line — seated
 * and its label cleared in ONE statement. Refused by name unless the line is an unplayed match whose other seat is held
 * and whose next seat is still empty.
 */
export async function vacateLineToBye(tx: Tx, lineId: string, seat: Seat): Promise<{ fixtureId: string; holderId: string; nextId: string }> {
  const row = await lockLine(tx, lineId);
  if (row === undefined) throw new ByeLineSurgeryError("vacateLineToBye", lineId, "no such line");
  if (isByeLine(row)) throw new ByeLineSurgeryError("vacateLineToBye", lineId, "the line is already a bye");
  if (row.status !== "scheduled" || row.outcome != null || row.evidence) {
    throw new ByeLineSurgeryError("vacateLineToBye", lineId, `the line is ${row.status}, not an unplayed match`);
  }
  const holderId = seat === "home" ? row.away_entrant_id : row.home_entrant_id;
  if (holderId === null) throw new ByeLineSurgeryError("vacateLineToBye", lineId, "nobody stays on the line");
  const { next, slot } = nextSeatOf("vacateLineToBye", row);
  await tx`
    update fixtures set
      home_entrant_id = case when ${seat} = 'home' then null else home_entrant_id end,
      home_slot_label = case when ${seat} = 'home' then ${tx.json(BYE_SLOT_LABEL)} else home_slot_label end,
      away_entrant_id = case when ${seat} = 'away' then null else away_entrant_id end,
      away_slot_label = case when ${seat} = 'away' then ${tx.json(BYE_SLOT_LABEL)} else away_slot_label end,
      status = 'forfeited',
      outcome = ${tx.json(byeAward(holderId))},
      scheduled_at = null, court_id = null, venue_id = null, schedule_locked = false
    where id = ${lineId}`;
  const filled = await tx`
    update fixtures set
      home_entrant_id = case when ${slot}::int = 1 then ${holderId}::uuid else home_entrant_id end,
      home_slot_label = case when ${slot}::int = 1 then null else home_slot_label end,
      away_entrant_id = case when ${slot}::int = 2 then ${holderId}::uuid else away_entrant_id end,
      away_slot_label = case when ${slot}::int = 2 then null else away_slot_label end
    where id = ${next} and (case when ${slot}::int = 1 then home_entrant_id else away_entrant_id end) is null
    returning id`;
  if (filled.length !== 1) {
    throw new ByeLineSurgeryError("vacateLineToBye", lineId, "the seat the line feeds is already taken");
  }
  return { fixtureId: lineId, holderId, nextId: next };
}

/** A first-round line's position in the draw: its top fold slot (the engine's `seedPositions` for a bracket of
 *  `round1Lines * 2`) — the slot a bye's holder occupies. */
export function knockoutLineDrawPosition(round1Lines: number, seq: number): number {
  const size = round1Lines * 2;
  if (round1Lines < 1 || (size & (size - 1)) !== 0 || seq < 1 || seq > round1Lines) {
    throw new ByeLineSurgeryError("byeLineCandidates", `seq ${seq}`, `no line ${seq} in a first round of ${round1Lines}`);
  }
  const positions = seedPositions(size);
  return Math.min(positions[2 * (seq - 1)]!, positions[2 * (seq - 1) + 1]!);
}

/** The stage's first-round bye lines a newcomer could take (one seated holder), with their draw positions. */
export async function byeLineCandidates(tx: Tx, stageId: string): Promise<ByeLineCandidate[]> {
  const rows = await tx<(ByeLineRow & { id: string; seq_in_round: number })[]>`
    select id, seq_in_round, ext_key, status, outcome, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label
      from fixtures where stage_id = ${stageId} and round_no = 1 order by seq_in_round`;
  const out: ByeLineCandidate[] = [];
  for (const r of rows) {
    if (!isByeLine(r)) continue;
    const phantom = byePhantomSide(r);
    const holderId = phantom === "home" ? r.away_entrant_id : phantom === "away" ? r.home_entrant_id : null;
    if (holderId === null) continue;
    out.push({ lineId: r.id, holderId, drawPosition: knockoutLineDrawPosition(rows.length, r.seq_in_round) });
  }
  return out;
}

/**
 * W4 T10 (X-LE-5, case (2)): a late player takes a WITHDRAWN entrant's round-1 seat. When the withdrawal already walked
 * the line over (`core.forfeit{reason: "withdrew"}`, the cascade's), that walkover is reversed first through the scoring
 * ledger — a `core.void` appended in the caller's transaction (`appendEventInTx`), so the take-back of the seat it
 * advanced into the next line (and any loser edge) is `releaseFedSeats`' own, refused 409 NEXT_MATCH_STARTED when that
 * line has begun. Then `newcomerId` takes the departed entrant's seat, and the line is an unplayed match again.
 *
 * Refused by name unless the line is a round-1 match (never a bye: a withdrawn bye holder's seat would seat the
 * newcomer in round 2, X-LE-7), `seat` holds a departed entrant, the other seat holds someone, and nothing was played on
 * the line besides that walkover. The lock order is the append's (stage, then fixture), so the line row is locked only
 * after the void.
 */
export async function reverseWithdrawnWalkover(
  tx: Tx,
  orgId: string,
  lineId: string,
  newcomerId: string,
  seat: Seat,
  actorId: string | null,
): Promise<{ fixtureId: string; opponentId: string; nextId: string | null; reversed: boolean }> {
  const refuse = (why: string) => new ByeLineSurgeryError("reverseWithdrawnWalkover", lineId, why);
  const [row] = await tx<(LineRow & { departed: boolean })[]>`
    select f.id, f.stage_id, f.round_no, f.seq_in_round, f.ext_key, f.status, f.outcome,
           f.home_entrant_id, f.away_entrant_id, f.home_slot_label, f.away_slot_label,
           f.winner_to_fixture, f.winner_to_slot, false as evidence,
           coalesce((select e.status in ${tx([...DEPARTED_STATUSES])} from entrants e
                      where e.id = case when ${seat} = 'home' then f.home_entrant_id else f.away_entrant_id end), false) as departed
      from fixtures f where f.id = ${lineId}`;
  if (row === undefined) throw refuse("no such line");
  if (row.round_no !== 1) throw refuse(`the line is in round ${row.round_no}, and a late player joins round 1 only`);
  if (isByeLine(row)) throw refuse("the line is a bye");
  const withdrawnId = seat === "home" ? row.home_entrant_id : row.away_entrant_id;
  const opponentId = seat === "home" ? row.away_entrant_id : row.home_entrant_id;
  // T11 (K13): the seat may also be the newcomer's OWN — a reinstated entrant whose own walkover is reversed, the seat
  // they never left (no longer departed: they were reinstated).
  if (withdrawnId === null || (!row.departed && withdrawnId !== newcomerId)) throw refuse(`the ${seat} seat holds no departed entrant`);
  if (opponentId === null) throw refuse("nobody holds the other seat");
  // The line's live events: a void and the event it voids are both gone.
  const live = await tx<{ id: string; type: string; payload: { reason?: unknown; by?: unknown } }[]>`
    select e.id, e.type, e.payload from score_events e
     where e.fixture_id = ${lineId} and e.type <> 'core.void'
       and not exists (select 1 from score_events v where v.voids_event_id = e.id)`;
  const walkover = live.find((e) => e.type === "core.forfeit" && e.payload.reason === "withdrew" && e.payload.by === withdrawnId);
  if (live.length > (walkover ? 1 : 0)) throw refuse("the line was played");
  if (walkover) {
    const [{ seq }] = await tx<{ seq: number }[]>`
      select coalesce(max(seq), 0)::int as seq from score_events where fixture_id = ${lineId}`;
    await appendEventInTx(tx, orgId, lineId, seq, {
      type: "core.void",
      payload: { event_id: walkover.id },
      voids: walkover.id,
      recordedBy: actorId,
    });
  }
  const after = await lockLine(tx, lineId);
  if (after === undefined || after.status !== "scheduled" || after.outcome != null) {
    throw refuse(`the line is ${after?.status ?? "gone"} after the walkover's reversal, not an unplayed match`);
  }
  const swapped = await tx`
    update fixtures set
      home_entrant_id = case when ${seat} = 'home' then ${newcomerId}::uuid else home_entrant_id end,
      away_entrant_id = case when ${seat} = 'away' then ${newcomerId}::uuid else away_entrant_id end
    where id = ${lineId} and (case when ${seat} = 'home' then home_entrant_id else away_entrant_id end) = ${withdrawnId}::uuid
    returning id`;
  if (swapped.length !== 1) throw refuse(`the ${seat} seat no longer holds ${withdrawnId}`);
  return { fixtureId: lineId, opponentId, nextId: row.winner_to_fixture, reversed: walkover !== undefined };
}
