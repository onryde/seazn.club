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
import { decideKnockoutLateEntry, type KnockoutLateDecision, type LateLine } from "@/lib/knockout-late-entry";
import { isRootKnockoutStage } from "@/lib/open-entry-stages";
import { withTenant } from "@/lib/db";
import { knockoutLineDrawPosition, reopenByeLine, reverseWithdrawnWalkover } from "./bracket-lines";
import { DEPARTED_STATUSES } from "./entrants";
import { fixtureStartedSql, stageHasStarted } from "./fixture-started-sql";
import { knockoutRefusal } from "./knockout-refusal";
import { OCCUPYING, afterScheduleWrite } from "./schedule";
import { divisionHasStarted } from "./stages";
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
    };
  });
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
  if (decision.case === "bye") {
    const r = await reopenByeLine(tx, decision.lineId, entrantId);
    fixtureId = r.fixtureId;
    opponentId = r.holderId;
  } else {
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
    scheduled,
  };
}

/**
 * Admit `entrantId` (already inserted) into the division's drawn root knockout. Null when there is nothing to do: the
 * division has not started (before Start, Generate's reconcile places a newcomer — Task 8), or it has no root knockout.
 * An organiser's add is placed now, or refused by name (KO_LATE_ENTRY_NO_SLOT, rolling the caller's write back). Every
 * other source is an automatic arrival (Task 11).
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
  if (source !== "organiser") return null;
  const [{ org_id: orgId }] = await tx<{ org_id: string }[]>`select org_id from divisions where id = ${divisionId}`;
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
