import "server-only";
// W5 app-A Task 4 (X-CU-9; RB5-L1, L2, L12; design 2026-11-05 §4.1): which stage a late player can join in a started
// league or group stage — the Start lock's half: the division's ROOT table stages.
// W5 app-A Task 5 (X-CU-4, X-CU-7, X-CU-11, X-CU-12, X-CU-13; RB5-L3..L9, L13..L16, RB5-E9): the admission beside it. An
// organiser's "Add late player" on a started league or group stage takes one of four answers, in the order RB5-L15 states:
//   - the stage is complete: refused by name (RR_LATE_ENTRY_STAGE_COMPLETE, RB5-L8), rolling the whole add back — the entrant
//     row is never created;
//   - nothing owed: refused by name (RR_LATE_ENTRY_NOTHING_TO_ADD, RB5-E9), never an empty success;
//   - nothing in the stage has started: `rebuild_offered` (RB5-L7) — the catch-up set is written unless the add asked to rebuild
//     (`prefer_rebuild`, which redraws the stage with the newcomer in it, Rebuild's own body);
//   - otherwise `catch_up` (RB5-L3): the newcomer's fixtures, each in a future bye holder's round or an appended catch-up round.
// Every new line is UNSCHEDULED (RB5-L13: no time, no court; the desk counts it) and carries a catch-up key (`rr-by-` / `rr-cu-`),
// and every placing add writes one `roundrobin_late_entry` ledger row, an undo barrier (RB5-L14: Undo refuses and points to
// Withdraw). The decision is the pure `lib/roundrobin-late-entry.ts`; this file reads the stage, asks it, and writes the answer.
// W5 app-A Task 6 (X-CU-8; RB5-L10): an AUTOMATIC arrival (registration, waitlist promotion, import, Reinstate) is never placed and
// never refused — it waits under `entrants.table_waiting_stage_id` (`markTableWaiting`), and the organiser's one tap
// (`placeWaitingTableEntrant`) runs the same placing core as "Add late player" (`placeInRootTable`) under the division lock.
//
// The predicate is `isRootTableStage` (lib/open-entry-stages.ts): the ONE rule the Start lock, the admission and the desk's client
// mirror all read, so they cannot disagree. Only the division's ENTRY stage is root: a group stage fed by an earlier one (a
// two-tier format's second tier, which carries no progression on stg) and a bracket behind a table take nobody late (X-LE-2).
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { KnockoutLateEntryResult, TableLateEntryResult } from "@/server/api-v1/schemas";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { isRootTableStage, tableLateEntryOffered } from "@/lib/open-entry-stages";
import { isRrExtKey, rrLinesOfRows, type RrStoredRow } from "@/lib/roundrobin-reconcile";
import {
  choosePool,
  decideRoundRobinLateEntry,
  rrCatchUpExtKey,
  type ByeSlot,
  type CatchUpFixture,
  type ExistingLine,
  type RoundRobinLateDecision,
} from "@/lib/roundrobin-late-entry";
import { DEPARTED_STATUSES } from "./entrants";
import { fixtureStartedSql, stageHasStarted } from "./fixture-started-sql";
import { placeWaitingKnockoutEntrant } from "./knockout-late-entry";
import { roundRobinRefusal } from "./roundrobin-refusal";
import { afterScheduleWrite } from "./schedule/after-write";
import {
  afterGenerateCommit,
  divisionHasStarted,
  lockSwissBoardAppends,
  refoldStageTable,
  refuseFormatTooSmall,
  regenerateStageInTx,
  type GenerateWrite,
} from "./stages";
import { readRoundByes } from "./stages/roundrobin-reconcile";
import { appendUndoBarrierRow, type LateEntrySource } from "./swiss-late-entry";

type Tx = postgres.TransactionSql;

export interface TableEntryStage {
  id: string;
  seq: number;
  status: string;
  kind: string;
  progression: unknown;
  config: Record<string, unknown>;
}

/** The division's whole stage list in `seq` order: a root table is the division's ENTRY stage (its lowest `seq`), which no
 *  per-stage read can answer (the same reason `knockout-late-entry.ts` reads the whole list). */
async function divisionStages(tx: Tx, divisionId: string): Promise<TableEntryStage[]> {
  return tx<TableEntryStage[]>`
    select id, seq, status, kind, progression, config from stages
    where division_id = ${divisionId} order by seq`;
}

/** The division's root table stages: its entry stage when that is a league or group drawing from the live roster (at most
 *  one). The kind test lives in the predicate (`TABLE_STAGE_KINDS`), not a second literal here. */
export async function rootTableStages(tx: Tx, divisionId: string): Promise<TableEntryStage[]> {
  const stages = await divisionStages(tx, divisionId);
  return stages.filter((s) => isRootTableStage(s, stages));
}

/** Whether the division holds a league or group stage a late player can join — the Start lock's exemption
 *  (`createEntrants`), the neighbour of `hasRootSwissStage` and `hasRootKnockoutStage`. */
export async function hasRootTableStage(tx: Tx, divisionId: string): Promise<boolean> {
  return (await rootTableStages(tx, divisionId)).length > 0;
}

interface StageFixture extends RrStoredRow {
  status: string;
}

/** The stage's legs, as the generator clamps them (`roundRobinStagePlan`: 1..8). */
function legsOf(config: Record<string, unknown>): number {
  const raw = typeof config.legs === "number" ? Math.trunc(config.legs) : 1;
  return Math.min(Math.max(raw, 1), 8);
}

/** The rounds of `poolId` (null: the league / a pool-less group) holding a started fixture (`fixtureStartedSql`, the K4 predicate,
 *  RB5-L11). A bye in such a round is never consumed (RB5-L4). */
async function startedRounds(tx: Tx, stageId: string, poolId: string | null): Promise<Set<number>> {
  const rows = await tx<{ round_no: number }[]>`
    select distinct f.round_no from fixtures f
     where f.stage_id = ${stageId} and f.pool_id is not distinct from ${poolId} and ${fixtureStartedSql(tx, "f")}`;
  return new Set(rows.map((r) => r.round_no));
}

/** Where a late entrant joins: the pool (its id and key, both null for a league) and the catch-up rule's whole input. */
export interface TablePlace {
  poolId: string | null;
  poolKey: string | null;
  input: Parameters<typeof decideRoundRobinLateEntry>[0];
}

/**
 * Read everything the decision needs, under the caller's `division:` lock and the stage's append locks. The pool: `poolKey` when
 * given (refused by name when it is no pool of the stage's table, RB5-L9), else the only one, else `choosePool` (the smallest;
 * ties by the seed snake). The members: entrants still in the field seated on the pool's table lines, in listed (seed) order —
 * `generateStageFixturesTx`'s own order (seed, then entry) — so a departed entrant is owed nothing. Add match rows are FIXED
 * seats: never a line, never moved, but a bye holder an Add match row already seats in that round keeps the bye unconsumed.
 */
export async function readTableLatePlace(tx: Tx, stage: TableEntryStage, entrantId: string, poolKey: string | undefined): Promise<TablePlace> {
  const all = await tx<StageFixture[]>`
    select id, ext_key, pool_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status
      from fixtures where stage_id = ${stage.id} order by round_no, seq_in_round`;
  const table = all.filter((r) => isRrExtKey(r.ext_key));
  const fixed = all.filter((r) => !isRrExtKey(r.ext_key));
  const pools = await tx<{ id: string; key: string }[]>`select id, key from pools where stage_id = ${stage.id}`;
  const keyOf = new Map(pools.map((p) => [p.id, p.key]));
  const linePools = [...new Set(table.map((r) => r.pool_id))];
  const active = await tx<{ id: string }[]>`
    select id from entrants
     where division_id = (select division_id from stages where id = ${stage.id})
       and status in ('registered', 'confirmed') and id <> ${entrantId}
     order by seed nulls last, created_at, id`;
  const membersOf = (poolId: string | null): string[] => {
    const seated = new Set(table.filter((r) => r.pool_id === poolId).flatMap((r) => [r.home_entrant_id, r.away_entrant_id]));
    return active.map((e) => e.id).filter((id) => seated.has(id));
  };

  let poolId: string | null;
  if (poolKey !== undefined) {
    const hit = linePools.find((p) => p !== null && keyOf.get(p) === poolKey);
    if (hit === undefined) throw roundRobinRefusal("RR_LATE_ENTRY_UNKNOWN_POOL", { pool: poolKey });
    poolId = hit;
  } else if (linePools.length <= 1) {
    poolId = linePools[0] ?? null;
  } else {
    const byKey = new Map<string, string[]>();
    for (const p of linePools) {
      const key = p === null ? undefined : keyOf.get(p);
      // A table whose lines stand in several pools has a pool row for each (generate-tx writes them together): a pool line with
      // no key is a stage no generator wrote.
      if (key === undefined) throw new Error(`readTableLatePlace: stage ${stage.id} has a pooled line with no pool row (${String(p)})`);
      byKey.set(key, membersOf(p));
    }
    const chosen = choosePool(byKey);
    poolId = linePools.find((p) => p !== null && keyOf.get(p) === chosen)!;
  }

  const inPool = table.filter((r) => r.pool_id === poolId);
  const lines: ExistingLine[] = rrLinesOfRows(inPool).flatMap((l) => (l === null ? [] : [{ home: l.home, away: l.away, roundNo: l.roundNo, leg: l.leg }]));
  const started = await startedRounds(tx, stage.id, poolId);
  const fixedSeats = new Set(
    fixed.filter((r) => r.pool_id === poolId || r.pool_id === null).flatMap((r) => [`${r.round_no}|${r.home_entrant_id}`, `${r.round_no}|${r.away_entrant_id}`]),
  );
  const byes: ByeSlot[] = (readRoundByes(stage.config) ?? [])
    .filter((b) => b.pool === poolId && !fixedSeats.has(`${b.round_no}|${b.entrant_id}`))
    .map((b) => ({ entrantId: b.entrant_id, roundNo: b.round_no, leg: b.leg, started: started.has(b.round_no) }));
  const lastRoundNo = all.reduce((m, r) => Math.max(m, r.round_no), 0);
  return {
    poolId,
    poolKey: poolId === null ? null : (keyOf.get(poolId) ?? null),
    input: {
      stageComplete: stage.status === "complete",
      stageStarted: await stageHasStarted(tx, stage.id),
      members: membersOf(poolId),
      newcomer: entrantId,
      legs: legsOf(stage.config),
      lines,
      byes,
      lastRoundNo,
    },
  };
}

/** A placing decision: what `applyTableLateDecision` writes. */
export type TablePlacingDecision = Extract<RoundRobinLateDecision, { case: "catch_up" | "rebuild_offered" }>;

export interface TableLateContext {
  divisionId: string;
  actorId: string | null;
  source: LateEntrySource;
  poolId: string | null;
  poolKey: string | null;
}

/**
 * Write a placing decision under the caller's `division:` lock: every owed fixture as a new UNSCHEDULED line (no time, no court,
 * RB5-L13) keyed `rr-by-` / `rr-cu-` with its leg, each consumed bye taken out of `config.round_byes`, and one
 * `roundrobin_late_entry` barrier row. Review Focus 3: a bye slot's round can START between the decision and this write (a Match
 * Day call); `started` is read again here for every `bye_slot` round, and a started one is DEMOTED to an appended catch-up round
 * after every round the stage then holds — a finished round is never changed (RB5-L4).
 */
export async function applyTableLateDecision(
  tx: Tx,
  stage: TableEntryStage,
  entrantId: string,
  decision: TablePlacingDecision,
  ctx: TableLateContext,
): Promise<TableLateEntryResult> {
  const planned: CatchUpFixture[] = decision.case === "catch_up" ? decision.fixtures : decision.catchUp;
  const started = await startedRounds(tx, stage.id, ctx.poolId);
  const [{ last }] = await tx<{ last: number }[]>`select coalesce(max(round_no), 0)::int as last from fixtures where stage_id = ${stage.id}`;
  let next = Math.max(last, ...planned.map((f) => f.placement.roundNo));
  const demoted: CatchUpFixture[] = [];
  const kept: CatchUpFixture[] = [];
  for (const f of planned) {
    if (f.placement.kind === "bye_slot" && started.has(f.placement.roundNo)) {
      demoted.push({ ...f, placement: { kind: "catch_up_round", roundNo: ++next } });
    } else kept.push(f);
  }
  const fixtures = [...kept, ...demoted].sort((x, y) => x.placement.roundNo - y.placement.roundNo);
  const consumed = decision.consumedByes.filter((b) => !started.has(b.roundNo));

  const seqRows = await tx<{ round_no: number; seq: number }[]>`
    select round_no, max(seq_in_round)::int as seq from fixtures
     where stage_id = ${stage.id} and pool_id is not distinct from ${ctx.poolId} group by round_no`;
  const nextSeq = new Map(seqRows.map((r) => [r.round_no, r.seq]));
  const prefix = ctx.poolKey === null ? "" : `p${ctx.poolKey}-`;
  const rows = fixtures.map((f) => {
    const seq = (nextSeq.get(f.placement.roundNo) ?? 0) + 1;
    nextSeq.set(f.placement.roundNo, seq);
    return {
      id: randomUUID(),
      stage_id: stage.id,
      division_id: ctx.divisionId,
      pool_id: ctx.poolId,
      round_no: f.placement.roundNo,
      seq_in_round: seq,
      home_entrant_id: f.home,
      away_entrant_id: f.away,
      home_slot_label: null,
      away_slot_label: null,
      ext_key: rrCatchUpExtKey(prefix, f.placement.kind, f.placement.roundNo, seq, f.leg),
      // RB5-L13: unscheduled — the desk's catch-up count is the flag, and it clears as each line is given a slot.
      scheduled_at: null,
      court_id: null,
      status: "scheduled",
      outcome: null,
      lane: null,
      is_final: false,
      third_place: false,
      conditional: false,
    };
  });
  await tx`insert into fixtures ${tx(rows)}`;
  if (consumed.length > 0) {
    const gone = consumed.map((b) => `${b.roundNo}|${b.leg}|${b.entrantId}`);
    await tx`
      update stages set config = jsonb_set(
        config, '{round_byes}',
        coalesce((select jsonb_agg(b) from jsonb_array_elements(config -> 'round_byes') b
                   where not ((b ->> 'pool') is not distinct from ${ctx.poolId}
                              and (b ->> 'round_no') || '|' || (b ->> 'leg') || '|' || (b ->> 'entrant_id') = any(${gone}))), '[]'::jsonb))
       where id = ${stage.id} and jsonb_typeof(config -> 'round_byes') = 'array'`;
  }
  const joinedRound = await joinedRoundOf(tx, stage.id);
  await appendUndoBarrierRow(
    tx,
    ctx.divisionId,
    "roundrobin_late_entry",
    {
      source: ctx.source,
      case: decision.case,
      stage_id: stage.id,
      entrant_id: entrantId,
      fixture_ids: rows.map((r) => r.id),
      pool_key: ctx.poolKey,
      joined_round: joinedRound,
    },
    ctx.actorId,
  );
  return {
    format: stage.kind === "group" ? "group" : "league",
    entrant_id: entrantId,
    stage_id: stage.id,
    case: decision.case,
    source: "organiser",
    ...(ctx.poolKey === null ? {} : { pool_key: ctx.poolKey }),
    fixtures: rows.map((r, i) => ({ fixture_id: r.id, round_no: r.round_no, placement: fixtures[i]!.placement.kind, scheduled: false })),
    appended_rounds: fixtures.filter((f) => f.placement.kind === "catch_up_round").length,
  };
}

/** RB5-L5's "Joined round N" (Task 5b reads it from the ledger row): the round after the last one any line of the stage has
 *  started in — the round the table was on when the newcomer arrived; 1 when nothing has started. */
async function joinedRoundOf(tx: Tx, stageId: string): Promise<number> {
  const [{ last }] = await tx<{ last: number }[]>`
    select coalesce(max(f.round_no), 0)::int as last from fixtures f where f.stage_id = ${stageId} and ${fixtureStartedSql(tx, "f")}`;
  return last + 1;
}

/** What a table admission did, for the caller's after-commit (`afterTableLateEntry`): the wire answer, plus Rebuild's write when
 *  the add redrew the stage. */
export interface TableAdmission {
  result: TableLateEntryResult;
  rebuild?: { generated: GenerateWrite; removedIds: string[] };
}

/**
 * The placing core, shared by the organiser's add (`admitTableLateEntrant`) and the tap on a waiting arrival
 * (`placeWaitingTableEntrant`) — ONE copy of the cases. The caller holds the `division:` lock and passes `stage` taken FROM
 * `stages` (the predicates compare stages by identity). Null when the table is not drawn yet (`tableLateEntryOffered`: a later
 * Generate draws the newcomer in). A refusal throws (RR_LATE_ENTRY_STAGE_COMPLETE, RR_LATE_ENTRY_NOTHING_TO_ADD,
 * RR_LATE_ENTRY_UNKNOWN_POOL) and rolls the caller's whole write back.
 */
async function placeInRootTable(
  tx: Tx,
  auth: AuthCtx | null,
  divisionId: string,
  stages: TableEntryStage[],
  stage: TableEntryStage,
  entrantId: string,
  source: LateEntrySource,
  opts: { poolKey?: string; preferRebuild?: boolean },
): Promise<TableAdmission | null> {
  if (stage.status === "complete") throw roundRobinRefusal("RR_LATE_ENTRY_STAGE_COMPLETE");
  if (!(await tableDrawnAndOffered(tx, divisionId, stages, stage))) return null;

  // The append lock of every line of the stage (`fixture:<id>`, the key each score append takes), before `started` is read: a
  // scorer starting a bye-slot round either commits first (and the read sees it) or waits on the finished write.
  const ids = await tx<{ id: string }[]>`select id from fixtures where stage_id = ${stage.id}`;
  await lockSwissBoardAppends(tx, ids.map((r) => r.id));
  const place = await readTableLatePlace(tx, stage, entrantId, opts.poolKey);
  const decision = decideRoundRobinLateEntry(place.input);
  if (decision.case === "refused") throw roundRobinRefusal(decision.code);
  const ctx: TableLateContext = { divisionId, actorId: auth?.userId ?? null, source, poolId: place.poolId, poolKey: place.poolKey };

  if (decision.case === "rebuild_offered" && opts.preferRebuild === true) {
    if (auth === null) throw new Error("placeInRootTable: a rebuild is an organiser's own write and needs their auth");
    // RB5-L7: nothing has started, and the organiser asked for the clean path — Rebuild's own body (one transaction, slots carried,
    // a group re-snaked), with the newcomer already on the roster it draws from.
    await refuseFormatTooSmall(tx, divisionId);
    const regen = await regenerateStageInTx(tx, auth, stage.id, { division_id: divisionId, kind: stage.kind });
    // W5 T6: the redraw seated every active entrant, a waiting arrival included — nobody waits on this stage any more.
    await clearTableWaitingMarks(tx, stage.id);
    const mine = await tx<{ id: string; round_no: number }[]>`
      select id, round_no from fixtures where stage_id = ${stage.id} and ${entrantId} in (home_entrant_id, away_entrant_id) order by round_no`;
    await appendUndoBarrierRow(
      tx,
      divisionId,
      "roundrobin_late_entry",
      { source, case: "rebuilt", stage_id: stage.id, entrant_id: entrantId, fixture_ids: mine.map((m) => m.id), pool_key: null, joined_round: 1 },
      ctx.actorId,
    );
    return {
      result: { format: stage.kind === "group" ? "group" : "league", entrant_id: entrantId, stage_id: stage.id, case: "rebuild_offered", source: "organiser", reason: "rebuilt" },
      rebuild: { generated: regen.generated, removedIds: regen.removedIds },
    };
  }
  return { result: await applyTableLateDecision(tx, stage, entrantId, decision, ctx) };
}

/** Whether the root table is drawn and takes a late player (`tableLateEntryOffered`, the ONE rule the Start lock and the desk read). */
async function tableDrawnAndOffered(tx: Tx, divisionId: string, stages: TableEntryStage[], stage: TableEntryStage): Promise<boolean> {
  const [division] = await tx<{ status: string }[]>`select status from divisions where id = ${divisionId}`;
  const [line] = await tx`select 1 from fixtures where stage_id = ${stage.id} limit 1`;
  return tableLateEntryOffered({ stage, division: stages, divisionStatus: division!.status, generated: line !== undefined });
}

/** Rebuild (and an add that redraws, `prefer_rebuild`) seats every active entrant: no marker on the stage survives it. The
 *  storage table's cleanup path for `table_waiting_stage_id` (G7); `rebuildStageFixtures` runs the same statement. */
async function clearTableWaitingMarks(tx: Tx, stageId: string): Promise<void> {
  await tx`update entrants set table_waiting_stage_id = null where table_waiting_stage_id = ${stageId}`;
}

/**
 * W5 T6 (X-CU-8, RB5-L10; the W4 `markWaiting` precedent): an AUTOMATIC arrival — a confirmed or paid registration (every
 * confirm / approve / waive / webhook door goes through `materialise`), a waitlist promotion, an import, a Reinstate — is never
 * placed by the app and never refused (a payment that has moved cannot be un-taken by a 409). It WAITS:
 * `table_waiting_stage_id` names the stage, the desk counts it (`late_players_waiting`, `table: true`), and the organiser's one
 * tap (`placeWaitingTableEntrant`) runs the cases.
 *
 * - The stage is COMPLETE: nothing is marked (a finished table takes no one, RB5-L8 — V526's own ruling) and the arrival still
 *   commits; the answer SAYS so (`refused`, RR_LATE_ENTRY_STAGE_COMPLETE), never a throw.
 * - The table is not drawn: null (a later Generate draws them in).
 * - The entrant already holds a fixture of ANY kind in the stage (a Reinstate whose lines still exist): null — they never wait.
 *   "Seatless" is V526's backfill predicate (no fixture at all), so the column's two writers agree on who waits.
 * - Otherwise the marker is written. Idempotent: the same value on a retry (a webhook redelivery never reaches here twice anyway:
 *   `materialise` returns early once the registration holds its entrant), so one arrival is one flag.
 */
async function markTableWaiting(
  tx: Tx,
  divisionId: string,
  stages: TableEntryStage[],
  stage: TableEntryStage,
  entrantId: string,
): Promise<TableAdmission | null> {
  const base = { format: stage.kind === "group" ? ("group" as const) : ("league" as const), entrant_id: entrantId, stage_id: stage.id, source: "automatic" as const };
  if (stage.status === "complete") return { result: { ...base, case: "refused", reason: "RR_LATE_ENTRY_STAGE_COMPLETE" } };
  if (!(await tableDrawnAndOffered(tx, divisionId, stages, stage))) return null;
  const [seat] = await tx`select 1 from fixtures where stage_id = ${stage.id} and ${entrantId} in (home_entrant_id, away_entrant_id) limit 1`;
  if (seat !== undefined) return null;
  await tx`update entrants set table_waiting_stage_id = ${stage.id} where id = ${entrantId}`;
  return { result: { ...base, case: "waiting" } };
}

/**
 * Admit `entrantId` (already inserted, or just reinstated) into the division's running root league or group. Null when there is
 * nothing to do: the division has not started (before Start, Generate's reconcile places a newcomer), it has no root table, or
 * the table is not drawn yet. An organiser's add is placed now (`placeInRootTable`); every other source is an automatic arrival,
 * which waits (`markTableWaiting`, T6) and is never refused.
 */
export async function admitTableLateEntrant(
  tx: Tx,
  auth: AuthCtx | null,
  divisionId: string,
  entrantId: string,
  source: LateEntrySource,
  opts: { poolKey?: string; preferRebuild?: boolean } = {},
): Promise<TableAdmission | null> {
  // Read BEFORE the lock, as the Swiss and knockout admissions do: most arrivals land in a division with no root table.
  if (!(await hasRootTableStage(tx, divisionId)) || !(await divisionHasStarted(tx, divisionId))) return null;
  await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
  const stages = await divisionStages(tx, divisionId);
  // The stage object is taken FROM the list the predicates read: they compare stages by identity (`divisionEntryStage`).
  const stage = stages.find((s) => isRootTableStage(s, stages));
  if (stage === undefined) return null;
  if (source !== "organiser") return markTableWaiting(tx, divisionId, stages, stage, entrantId);
  return placeInRootTable(tx, auth, divisionId, stages, stage, entrantId, source, opts);
}

/**
 * W5 T6 (X-CU-8; Review Focus 2): the organiser's one tap on an entrant WAITING to join `stageId` — `POST
 * /stages/{id}/late-entrants/{entrantId}/place` (the route dispatches here for a league or group, `placeWaitingLateEntrant`).
 * Under the `division:` lock — taken BEFORE the marker is read, so two taps on one player are one placement: the second reads
 * the marker the first cleared and is answered RR_LATE_ENTRY_ALREADY_PLACED — it runs Task 5's placing core
 * (`placeInRootTable`, source `organiser`: the catch-up lines, unscheduled; the `roundrobin_late_entry` ledger row with its
 * `fixture_ids`, which the Joined marker reads), then clears the marker. `poolKey` names a group's pool (else the smallest).
 *
 * Refused by name: RR_LATE_ENTRY_ALREADY_PLACED when the entrant (still in the field) already holds a line of this stage;
 * RR_LATE_ENTRY_NOT_WAITING when they do not wait on this stage (never marked, withdrawn since, swept up by a Rebuild, another
 * division's); the placing core's own refusals roll back and leave them waiting. 404 for an unknown stage.
 */
export async function placeWaitingTableEntrant(auth: AuthCtx, stageId: string, entrantId: string, poolKey?: string): Promise<TableLateEntryResult> {
  const { admission, divisionId, competitionId } = await withTenant(auth.orgId, async (tx) => {
    const [st] = await tx<{ division_id: string; competition_id: string }[]>`
      select s.division_id, d.competition_id from stages s join divisions d on d.id = s.division_id where s.id = ${stageId}`;
    if (st === undefined) throw new HttpError(404, "stage not found");
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + st.division_id}))`;
    const stages = await divisionStages(tx, st.division_id);
    const stage = stages.find((s) => s.id === stageId && isRootTableStage(s, stages));
    const [e] = await tx<{ status: string; waiting: string | null }[]>`
      select status, table_waiting_stage_id as waiting from entrants where id = ${entrantId} and division_id = ${st.division_id}`;
    const inField = e !== undefined && !DEPARTED_STATUSES.has(e.status);
    if (stage === undefined || !inField || e.waiting !== stageId) {
      const [seat] = inField
        ? await tx`select 1 from fixtures where stage_id = ${stageId} and ${entrantId} in (home_entrant_id, away_entrant_id) limit 1`
        : [];
      throw roundRobinRefusal(seat !== undefined ? "RR_LATE_ENTRY_ALREADY_PLACED" : "RR_LATE_ENTRY_NOT_WAITING");
    }
    const placed = await placeInRootTable(tx, auth, st.division_id, stages, stage, entrantId, "organiser", poolKey === undefined ? {} : { poolKey });
    // A marker names a drawn table (`markTableWaiting` writes it only then, and Rebuild clears it): an undrawn one here is a
    // marker no writer should have left, answered by name rather than placed against nothing.
    if (placed === null) throw roundRobinRefusal("RR_LATE_ENTRY_NOT_WAITING");
    await tx`update entrants set table_waiting_stage_id = null where id = ${entrantId}`;
    return { admission: placed, divisionId: st.division_id, competitionId: st.competition_id };
  });
  await afterTableLateEntry(auth, divisionId, competitionId, [admission]);
  return admission.result;
}

/** The route's dispatch (`POST /stages/{id}/late-entrants/{entrantId}/place`): a league or group stage takes the table tap, every
 *  other stage the knockout one (W4 T11), whose own refusals answer a stage it does not own. */
export async function placeWaitingLateEntrant(
  auth: AuthCtx,
  stageId: string,
  entrantId: string,
  poolKey?: string,
): Promise<TableLateEntryResult | KnockoutLateEntryResult> {
  const [st] = await withTenant(auth.orgId, (tx) => tx<{ kind: string }[]>`select kind from stages where id = ${stageId}`);
  if (st === undefined) throw new HttpError(404, "stage not found");
  return st.kind === "league" || st.kind === "group"
    ? placeWaitingTableEntrant(auth, stageId, entrantId, poolKey)
    : placeWaitingKnockoutEntrant(auth, stageId, entrantId);
}

/** After the adding write COMMITS: the new lines are told as a schedule write is, and the table refolds so the newcomer stands in
 *  it at once; a rebuild publishes as Rebuild does (`rebuildStageFixtures`). Best-effort past the commit. */
export async function afterTableLateEntry(
  auth: AuthCtx,
  divisionId: string,
  competitionId: string,
  admissions: readonly TableAdmission[],
): Promise<void> {
  for (const a of admissions) {
    if (a.rebuild !== undefined) {
      try {
        await afterGenerateCommit(auth, a.result.stage_id, a.rebuild.generated);
      } finally {
        afterScheduleWrite(divisionId, competitionId, "schedule", a.rebuild.removedIds);
      }
      continue;
    }
    afterScheduleWrite(divisionId, competitionId, "schedule", (a.result.fixtures ?? []).map((f) => f.fixture_id));
    await refoldStageTable(auth.orgId, { id: a.result.stage_id, kind: a.result.format }, "skip");
  }
}
