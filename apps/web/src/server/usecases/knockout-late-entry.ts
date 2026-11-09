import "server-only";
// W4 app-A Tasks 9–11 (rules X-LE-1…X-LE-13; spec 2026-11-04-format-matrix-w4-knockout-design.md §4.1; rulings 263,
// 271): late entry into a drawn ROOT knockout.
//
// T9: which stage a late player joins — the division's root knockout (`isRootKnockoutStage`, lib/open-entry-stages.ts:
// the ONE predicate the Start lock, this admission and the desk's client mirror all read). A knockout fed by an earlier
// stage (league_ko, groups_ko, swiss_knockout, ko_plate's plate, qualifying_main's main draw) never takes one (X-LE-2).
//
// T10: "Add late player" (an organiser's add, `source: "organiser"`) places the newcomer at once — case (1) the
// lowest-seeded holder's bye, case (2) a withdrawn entrant's seat with its walkover reversed, else (3) a named refusal
// that rolls the add back (lib/knockout-late-entry.ts decides; this file reads and applies). The placed line takes the
// round's next free slot or stays unscheduled (the desk's `unscheduled` flag, X-LE-12), and a `knockout_late_entry`
// ledger row makes it an undo barrier (X-LE-13).
import type postgres from "postgres";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { KnockoutLateEntryResult } from "@/server/api-v1/schemas";
import { isByeLine, type ByeLineRow } from "@/lib/bye-line";
import {
  KO_LATE_ENTRY_PLAYED_ON,
  decideKnockoutLateEntry,
  decideWaitingEntrant,
  type KnockoutLateDecision,
  type LateLine,
} from "@/lib/knockout-late-entry";
import { isRootKnockoutStage } from "@/lib/open-entry-stages";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { knockoutLineDrawPosition, reopenByeLine, reverseWithdrawnWalkover } from "./bracket-lines";
import { DEPARTED_STATUSES } from "./entrants";
import { fixtureStartedSql, stageHasStarted } from "./fixture-started-sql";
import { knockoutRefusal } from "./knockout-refusal";
import { OCCUPYING, afterScheduleWrite } from "./schedule";
import { divisionHasStarted, lockSwissBoardAppends } from "./stages";
import { appendUndoBarrierRow, nextFreeRoundSlot, placeBoard, type LateEntrySource } from "./swiss-late-entry";

type Tx = postgres.TransactionSql;

export interface KnockoutEntryStage {
  id: string;
  seq: number;
  status: string;
  kind: string;
  name: string;
  progression: unknown;
  config: Record<string, unknown>;
}

/** The division's stages in `seq` order — the whole list, since a root knockout is the division's ENTRY stage (its
 *  lowest `seq`), which no per-stage read can answer. */
async function divisionStages(tx: Tx, divisionId: string): Promise<KnockoutEntryStage[]> {
  return tx<KnockoutEntryStage[]>`
    select id, seq, status, kind, name, progression, config from stages
    where division_id = ${divisionId} order by seq`;
}

/** The division's root knockout — the stage a late player joins — or null (none: another format, or a fed bracket). */
export async function rootKnockoutStage(tx: Tx, divisionId: string): Promise<KnockoutEntryStage | null> {
  const stages = await divisionStages(tx, divisionId);
  return stages.find((s) => isRootKnockoutStage(s, stages)) ?? null;
}

/** Whether the division holds a knockout a late player can join — the Start lock's exemption (`createEntrants`), the
 *  neighbour of `hasRootSwissStage`. */
export async function hasRootKnockoutStage(tx: Tx, divisionId: string): Promise<boolean> {
  return (await rootKnockoutStage(tx, divisionId)) !== null;
}

/** X-LE-8: a stepladder's or a page playoff's "byes" are rungs — case (2) only. */
const CASE_TWO_ONLY_KINDS: readonly string[] = ["stepladder", "page_playoff"];

interface RoundOneRow extends ByeLineRow {
  id: string;
  seq_in_round: number;
  winner_to_fixture: string | null;
  loser_to_fixture: string | null;
  home_departed: boolean;
  away_departed: boolean;
  home_seed: number | null;
  away_seed: number | null;
  next_started: boolean;
  played: boolean;
}

/** A withdrawal's walkover's loser, off a line's outcome (`withdrew` award), else null. */
function walkoverLoserOf(outcome: unknown): string | null {
  const o = outcome as { kind?: unknown; reason?: unknown; loser?: unknown } | null;
  return o?.kind === "award" && o.reason === "withdrew" && typeof o.loser === "string" ? o.loser : null;
}

/** The stage's round-1 lines as the decision reads them (`LateLine`). */
async function roundOneLines(tx: Tx, stage: KnockoutEntryStage): Promise<LateLine[]> {
  const departed = [...DEPARTED_STATUSES];
  const rows = await tx<RoundOneRow[]>`
    select f.id, f.seq_in_round, f.ext_key, f.status, f.outcome, f.home_entrant_id, f.away_entrant_id,
           f.home_slot_label, f.away_slot_label, f.winner_to_fixture, f.loser_to_fixture,
           coalesce(he.status in ${tx(departed)}, false) as home_departed,
           coalesce(ae.status in ${tx(departed)}, false) as away_departed,
           he.seed as home_seed, ae.seed as away_seed,
           exists (select 1 from fixtures n where n.id = f.winner_to_fixture and ${fixtureStartedSql(tx, "n")}) as next_started,
           exists (select 1 from score_events e
                    where e.fixture_id = f.id and e.type <> 'core.void'
                      and not exists (select 1 from score_events v where v.voids_event_id = e.id)
                      and not (e.type = 'core.forfeit' and e.payload->>'reason' = 'withdrew')) as played
      from fixtures f
      left join entrants he on he.id = f.home_entrant_id
      left join entrants ae on ae.id = f.away_entrant_id
     where f.stage_id = ${stage.id} and f.round_no = 1
     order by f.seq_in_round`;
  const ladder = CASE_TWO_ONLY_KINDS.includes(stage.kind);
  return rows.map((r) => {
    const bye = isByeLine(r);
    const outcome = r.outcome as { kind?: unknown; reason?: unknown } | null;
    const reason: LateLine["reason"] = bye
      ? "bye"
      : outcome?.kind === "award" && outcome.reason === "withdrew"
        ? "withdrew"
        : null;
    const withdrawnSeat: LateLine["withdrawnSeat"] =
      r.home_departed && !r.away_departed ? "home" : r.away_departed && !r.home_departed ? "away" : null;
    return {
      id: r.id,
      seq: r.seq_in_round,
      // A ladder's rungs are no power-of-two draw; case (1) never reads its draw position (X-LE-8).
      drawPos: ladder ? r.seq_in_round : knockoutLineDrawPosition(rows.length, r.seq_in_round),
      home: r.home_entrant_id,
      away: r.away_entrant_id,
      status: r.status,
      reason,
      holderSeed: bye ? (r.home_entrant_id !== null ? r.home_seed : r.away_seed) : null,
      nextStarted: r.next_started,
      withdrawnSeat,
      played: r.played,
      loserFed: r.loser_to_fixture !== null,
      walkoverLoser: walkoverLoserOf(r.outcome),
    };
  });
}

/**
 * B3 fix round 1 (review #2): the append lock of every round-1 line and every line one feeds — the SAME `fixture:<id>`
 * key each score append takes (append-event.ts), sorted, held to commit (`lockSwissBoardAppends`, the W3 T5 m1
 * precedent) — taken by a PLACING path after its `division:` lock and BEFORE it reads `next_started`/`played`
 * (`roundOneLines`). Scoring serialises on the fixture, never the division, so without it a scorer starting round 2
 * could commit between that read and the surgery: a reopened bye then took its holder out of a round-2 match in play.
 * With it the scorer either commits first (and the read sees round 2 started — X-LE-9 closes that bye) or waits and
 * finds the line already reshaped. The one lock order (`division:` → `fixture:`, append-event.ts) holds: the surgery's
 * own void and seat writes re-enter locks already held. An automatic arrival's marking places nothing, so it takes
 * none and waits on no scorer.
 *
 * B3 fix round 2: the `fixture:` keys go in BRACKET order — every round-1 line, then the lines they feed — the global
 * order of every bracket writer (fed-seats.ts `bracketOrder`, ascending (round_no, id)). One id-sorted pass over both
 * rounds could hold a round-2 line while queued on a round-1 line whose void, holding that line's lock as every append
 * does, then asked for the round-2 line to take its seat back: 40P01. Each call sorts by id within its own round.
 */
async function lockRoundOneAppends(tx: Tx, stage: KnockoutEntryStage): Promise<void> {
  const rows = await tx<{ id: string; next: string | null }[]>`
    select id, winner_to_fixture as next from fixtures where stage_id = ${stage.id} and round_no = 1`;
  await lockSwissBoardAppends(tx, rows.map((r) => r.id));
  await lockSwissBoardAppends(tx, rows.flatMap((r) => (r.next === null ? [] : [r.next])));
}

/** Whether `entrantId` sits in any line of `stageId` — a reinstated entrant the withdrawal left seated, or a player in. */
async function holdsSeatIn(tx: Tx, stageId: string, entrantId: string): Promise<boolean> {
  const [seat] = await tx`
    select 1 from fixtures where stage_id = ${stageId} and ${entrantId} in (home_entrant_id, away_entrant_id) limit 1`;
  return seat !== undefined;
}

/** The decision for `stage` as it stands (under the caller's `division:` lock). */
export async function decideForStage(tx: Tx, stage: KnockoutEntryStage): Promise<KnockoutLateDecision> {
  return decideKnockoutLateEntry({
    lines: await roundOneLines(tx, stage),
    stageStarted: await stageHasStarted(tx, stage.id),
    caseTwoOnly: CASE_TWO_ONLY_KINDS.includes(stage.kind),
  });
}

/** X-LE-12: the placed line keeps a time it still holds — one not yet gone, at a court no other live match holds —
 *  else takes round 1's next free slot (`nextFreeRoundSlot`), else stays unscheduled for the organiser to place (the
 *  desk's `unscheduled` attention flags it). True when it ends with a slot. */
async function scheduleLine(tx: Tx, divisionId: string, stageId: string, lineId: string, now: Date): Promise<boolean> {
  const [line] = await tx<{ scheduled_at: Date | null; court_id: string | null }[]>`
    select scheduled_at, court_id from fixtures where id = ${lineId}`;
  if (line!.scheduled_at !== null && line!.court_id !== null) {
    const [clash] = await tx`
      select 1 from fixtures
       where id <> ${lineId} and court_id = ${line!.court_id} and scheduled_at = ${line!.scheduled_at}
         and status in ${tx(OCCUPYING)}
       limit 1`;
    if (clash === undefined && line!.scheduled_at.getTime() >= now.getTime()) return true;
    await tx`update fixtures set scheduled_at = null, court_id = null, venue_id = null where id = ${lineId}`;
  }
  const rows = await tx<Parameters<typeof nextFreeRoundSlot>[3][number][]>`
    select round_no, scheduled_at, ext_key, status, outcome, home_entrant_id, away_entrant_id, home_slot_label, away_slot_label
      from fixtures where stage_id = ${stageId} and id <> ${lineId}`;
  const slot = await nextFreeRoundSlot(tx, divisionId, 1, rows, { from: now });
  if (slot === null) return false;
  await placeBoard(tx, lineId, slot);
  return true;
}

export interface KnockoutLateContext {
  orgId: string;
  divisionId: string;
  actorId: string | null;
  source: LateEntrySource;
  now?: Date;
}

/**
 * Apply a placing decision under the caller's `division:` lock: case (1) reopens the bye (`reopenByeLine`), case (2)
 * reverses the withdrawal's walkover and seats the newcomer (`reverseWithdrawnWalkover`); the line is scheduled
 * (`scheduleLine`) and one `knockout_late_entry` barrier row is written. A refusal is never applied: it throws
 * KO_LATE_ENTRY_NO_SLOT (`details.can_rebuild`).
 */
export async function applyKnockoutLateDecision(
  tx: Tx,
  ctx: KnockoutLateContext,
  stage: KnockoutEntryStage,
  entrantId: string,
  decision: KnockoutLateDecision,
): Promise<KnockoutLateEntryResult> {
  if (decision.case === "refused") {
    throw knockoutRefusal("KO_LATE_ENTRY_NO_SLOT", { can_rebuild: decision.canRebuild, stage_id: stage.id });
  }
  let fixtureId: string;
  let opponentId: string;
  let withdrawnId: string | undefined;
  if (decision.case === "bye") {
    const r = await reopenByeLine(tx, decision.lineId, entrantId);
    fixtureId = r.fixtureId;
    opponentId = r.holderId;
  } else {
    // T19: whose seat this is, read before the surgery swaps it (the notice names them; a reinstated player's own seat
    // names themself). The surgery re-checks the same seat under its own guard.
    const [seat] = await tx<{ home_entrant_id: string | null; away_entrant_id: string | null }[]>`
      select home_entrant_id, away_entrant_id from fixtures where id = ${decision.lineId}`;
    withdrawnId = (decision.seat === "home" ? seat?.home_entrant_id : seat?.away_entrant_id) ?? undefined;
    const r = await reverseWithdrawnWalkover(tx, ctx.orgId, decision.lineId, entrantId, decision.seat, ctx.actorId);
    fixtureId = r.fixtureId;
    opponentId = r.opponentId;
  }
  const scheduled = await scheduleLine(tx, ctx.divisionId, stage.id, fixtureId, ctx.now ?? new Date());
  await appendUndoBarrierRow(
    tx,
    ctx.divisionId,
    "knockout_late_entry",
    { stage_id: stage.id, entrant_id: entrantId, case: decision.case, fixture_id: fixtureId, opponent_id: opponentId, source: ctx.source },
    ctx.actorId,
  );
  return {
    format: "knockout",
    entrant_id: entrantId,
    stage_id: stage.id,
    case: decision.case,
    fixture_id: fixtureId,
    opponent_id: opponentId,
    ...(withdrawnId !== undefined ? { withdrawn_id: withdrawnId } : {}),
    scheduled,
  };
}

/**
 * T11 (X-LE-10, ruling 271): an AUTOMATIC arrival — a confirmed or paid registration, a waitlist promotion, an import, a
 * Reinstate — is never placed by the app and never refused (a payment that has moved cannot be un-taken by a 409). It
 * WAITS: `knockout_waiting_stage_id` names the stage, the desk counts it (`late_players_waiting`), and the organiser's
 * one tap (`placeWaitingKnockoutEntrant`) runs the cases. Null — nothing marked — when the stage is complete (no round 1
 * left to join). B3 fix round 1 (review #1): an entrant who already HOLDS a seat in the stage (a reinstatement — the
 * withdrawal left them seated) is marked only when the tap could act on it: their own round-1 line is a withdrawal's
 * walkover against them that is still reversible (`decideWaitingEntrant`, the tap's own decision). A round-1 loser by
 * play, a winner walked over in round 2, a player still on an undecided line: none of these is a late player, and a
 * flag the tap can only refuse would sit on the desk for good. The write is idempotent: a webhook retry is one flag.
 */
async function markWaiting(tx: Tx, stage: KnockoutEntryStage, entrantId: string): Promise<KnockoutLateEntryResult | null> {
  const seated = await holdsSeatIn(tx, stage.id, entrantId);
  // T19 (K13; B3 re-review): a seat holder the tap cannot give the seat back to — their place has been played on — is
  // never marked, and the answer SAYS so (`refused`, KO_LATE_ENTRY_PLAYED_ON), so a Reinstate does not read as a
  // return to the bracket. A newcomer arriving into a finished bracket stays null: nothing of theirs was played on.
  const playedOn: KnockoutLateEntryResult = {
    format: "knockout",
    entrant_id: entrantId,
    stage_id: stage.id,
    case: "refused",
    reason: KO_LATE_ENTRY_PLAYED_ON,
  };
  if (stage.status === "complete") return seated ? playedOn : null;
  if (seated) {
    const decision = decideWaitingEntrant({
      lines: await roundOneLines(tx, stage),
      stageStarted: true, // read by a refusal's Rebuild offer only, and a refusal marks nothing
      caseTwoOnly: CASE_TWO_ONLY_KINDS.includes(stage.kind),
      entrantId,
      holdsSeat: true,
    });
    if (decision.case !== "withdrawn_slot") return playedOn;
  }
  await tx`update entrants set knockout_waiting_stage_id = ${stage.id} where id = ${entrantId}`;
  return { format: "knockout", entrant_id: entrantId, stage_id: stage.id, case: "waiting" };
}

/**
 * Admit `entrantId` (already inserted, or just reinstated) into the division's drawn root knockout. Null when there is
 * nothing to do: the division has not started (before Start, Generate's reconcile places a newcomer — Task 8), or it has
 * no root knockout. An organiser's add is placed now, or refused by name (KO_LATE_ENTRY_NO_SLOT, rolling the caller's
 * write back). Every other source is an automatic arrival, which waits (`markWaiting`, T11).
 */
export async function admitKnockoutLateEntrant(
  tx: Tx,
  auth: AuthCtx | null,
  divisionId: string,
  entrantId: string,
  source: LateEntrySource,
): Promise<KnockoutLateEntryResult | null> {
  // Read BEFORE the lock, as the Swiss admission does (its review m7): most arrivals land in a division with no drawn
  // root knockout and must not queue on its lock. Started is one-way, so a "started" read here stays true under it.
  if (!(await hasRootKnockoutStage(tx, divisionId)) || !(await divisionHasStarted(tx, divisionId))) return null;
  await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
  const stage = await rootKnockoutStage(tx, divisionId);
  if (stage === null) return null;
  if (source !== "organiser") return markWaiting(tx, stage, entrantId);
  const [{ org_id: orgId }] = await tx<{ org_id: string }[]>`select org_id from divisions where id = ${divisionId}`;
  await lockRoundOneAppends(tx, stage);
  const decision = await decideForStage(tx, stage);
  return applyKnockoutLateDecision(tx, { orgId, divisionId, actorId: auth?.userId ?? null, source }, stage, entrantId, decision);
}

/** After the arriving write COMMITS: the placed lines (and the next line a reopened bye or a reversed walkover took a
 *  seat back from) are told, as a schedule write is. Best-effort past the commit. */
export async function afterKnockoutLateEntry(
  orgId: string,
  divisionId: string,
  competitionId: string,
  results: readonly ({ format: string; fixture_id?: string } | null | undefined)[],
): Promise<void> {
  const lines = results.flatMap((r) => (r?.format === "knockout" && r.fixture_id !== undefined ? [r.fixture_id] : []));
  if (lines.length === 0) return;
  const touched = await withTenant(orgId, async (tx) => {
    const rows = await tx<{ id: string; next: string | null }[]>`
      select id, winner_to_fixture as next from fixtures where id = any(${lines})`;
    return [...new Set(rows.flatMap((r) => (r.next === null ? [r.id] : [r.id, r.next])))];
  });
  afterScheduleWrite(divisionId, competitionId, "schedule", touched);
}

/**
 * T11 (X-LE-10, K7, K13): the organiser's one tap on an entrant WAITING to join `stageId` — `POST
 * /stages/{id}/late-entrants/{entrantId}/place`. Under the `division:` lock (two taps on one bye: the second decides after
 * the first has applied, never onto the same line), it runs `decideWaitingEntrant` — a newcomer gets the cases "Add late
 * player" runs; a reinstated entrant only their own walkover back — and applies a placing decision as Add late player does
 * (`applyKnockoutLateDecision`: the line, its slot, a `knockout_late_entry` barrier row with `source: "organiser"`), then
 * clears the marker. A refusal is an ANSWER, not an error (200): `refused`, or `rebuild_offered` when nothing in the stage
 * has started, with `reason: KO_LATE_ENTRY_NO_SLOT` — and the entrant keeps waiting.
 *
 * Refused by name: KO_LATE_ENTRY_FED_STAGE when `stageId` is a knockout the root fills and the entrant waits on that root
 * (the sentence names it); KO_LATE_ENTRY_NOT_WAITING when the entrant does not wait on this stage (never marked, placed
 * already, swept up by a Rebuild, withdrawn since, or another division's).
 */
export async function placeWaitingKnockoutEntrant(auth: AuthCtx, stageId: string, entrantId: string): Promise<KnockoutLateEntryResult> {
  const { result, divisionId, competitionId } = await withTenant(auth.orgId, async (tx) => {
    const [st] = await tx<{ division_id: string; competition_id: string }[]>`
      select s.division_id, d.competition_id from stages s join divisions d on d.id = s.division_id where s.id = ${stageId}`;
    if (st === undefined) throw new HttpError(404, "stage not found");
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + st.division_id}))`;
    const root = await rootKnockoutStage(tx, st.division_id);
    const [e] = await tx<{ status: string; waiting: string | null }[]>`
      select status, knockout_waiting_stage_id as waiting from entrants where id = ${entrantId} and division_id = ${st.division_id}`;
    if (root !== null && root.id !== stageId && e !== undefined && e.waiting === root.id) {
      throw knockoutRefusal("KO_LATE_ENTRY_FED_STAGE", { stage: root.name });
    }
    if (root === null || root.id !== stageId || e === undefined || e.waiting !== stageId || DEPARTED_STATUSES.has(e.status)) {
      throw knockoutRefusal("KO_LATE_ENTRY_NOT_WAITING");
    }
    await lockRoundOneAppends(tx, root);
    const decision = decideWaitingEntrant({
      lines: await roundOneLines(tx, root),
      stageStarted: await stageHasStarted(tx, root.id),
      caseTwoOnly: CASE_TWO_ONLY_KINDS.includes(root.kind),
      entrantId,
      holdsSeat: await holdsSeatIn(tx, stageId, entrantId),
    });
    const base = { divisionId: st.division_id, competitionId: st.competition_id };
    if (decision.case === "refused") {
      const refused: KnockoutLateEntryResult = {
        format: "knockout",
        entrant_id: entrantId,
        stage_id: stageId,
        case: decision.canRebuild ? "rebuild_offered" : "refused",
        reason: "KO_LATE_ENTRY_NO_SLOT",
      };
      return { result: refused, ...base };
    }
    const placed = await applyKnockoutLateDecision(
      tx,
      { orgId: auth.orgId, divisionId: st.division_id, actorId: auth.userId, source: "organiser" },
      root,
      entrantId,
      decision,
    );
    await tx`update entrants set knockout_waiting_stage_id = null where id = ${entrantId}`;
    return { result: placed, ...base };
  });
  await afterKnockoutLateEntry(auth.orgId, divisionId, competitionId, [result]);
  return result;
}
