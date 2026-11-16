import "server-only";
// W5 app PR A, Task 2 (X-CU-6; RB5-G7, RB5-L17; FX-G1 #879, FX-G21, #837): what a Generate does over a root league or group that
// already has its lines, and what deleting an entrant before Start does to the lines it sat in. The planner is the pure
// `lib/roundrobin-reconcile.ts`; this is its driver, run by `generateStageFixturesTx` under the division lock in the caller's
// transaction (generate-tx.ts `reconcileRoundRobinGenerate`).
//
// Main inserted by the engine's POSITIONAL id (`rr-r{round}-c{court}`), so a roster change added rows that repeated pairs already
// drawn and missed the pairs the newcomers owed, and kept doing it after Start. Now:
//   - after Start Generate never reshapes: an arrival is refused by name (RR_GENERATE_AFTER_START; the late-entry door is the way
//     in), anything else is the named no-op. A DEPARTURE is not an arrival: the withdrawal cascade has already walked its lines
//     over, so Generate has nothing to add;
//   - before Start the pairs are reconciled by (unordered pair, leg, pool): the same pairs → `noop`; pairs added or dropped in a
//     pool whose shape held → `patch` (insert the missing pairs, delete the dropped ones, in place); a pool whose parity
//     flipped, a group that re-snaked or a repeated key → `regenerate`, which the caller runs (Rebuild's own body, with the
//     slots carried by pair).
// The decision is made BEFORE the first write, so a regenerate never starts from a half-patched table.
import { randomUUID } from "node:crypto";
import type { Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import {
  planRoundRobinReconcile,
  roundRobinShape,
  rrExtKey,
  rrKey,
  rrLegOfExtKey,
  rrLinesOfRows,
  type RrLine,
  type RrStoredRow,
} from "@/lib/roundrobin-reconcile";
import { FIXTURE_DELETED_REASON } from "@/server/email-outbox/cancel";
import { cancelBoardInvites } from "../external-play/cancel-invites";
import { fixtureHasResultSql } from "../fixture-results-sql";
import { stageHasStarted } from "../fixture-started-sql";
import { roundRobinRefusal } from "../roundrobin-refusal";
import { poolCount, roundRobinStagePlan, type RoundBye } from "./generators";
import { appendFixturesGenerated, divisionHasStarted, recordFixturesCleared } from "./helpers";
import { stageAttachmentCounts } from "./roster-drift";
import type { ActiveEntrant, SealedSetupCounts, StageRow } from "./types";

/** What the driver did, or (`regenerate`) what the caller must do. `placed`/`vacated` are entrant ids. */
export type RoundRobinDecision =
  | { kind: "noop" }
  | { kind: "patched"; insertedIds: string[]; removedIds: string[]; placed: string[]; vacated: string[] }
  | { kind: "regenerate"; placed: string[]; vacated: string[] };

/** The stage's recorded byes (`config.round_byes`), or null when the stage has none recorded at all (drawn before W5). A
 *  malformed value reads as none recorded: the next draw rewrites it. */
export function readRoundByes(config: Record<string, unknown>): RoundBye[] | null {
  const raw = config.round_byes;
  if (!Array.isArray(raw)) return null;
  return raw.filter(
    (b): b is RoundBye =>
      typeof b === "object" && b !== null && typeof (b as RoundBye).entrant_id === "string" && Number.isInteger((b as RoundBye).round_no) && Number.isInteger((b as RoundBye).leg),
  );
}

/** FX-G21: write `config.round_byes` from the engine's schedule, wholesale, in the caller's transaction. */
export async function writeRoundByes(tx: Tx, stageId: string, byes: readonly RoundBye[]): Promise<void> {
  await tx`update stages set config = config || ${tx.json({ round_byes: byes } as never)} where id = ${stageId}`;
}

type StoredRow = RrStoredRow & { status: string };

export async function reconcileRoundRobinLines(
  tx: Tx,
  stage: StageRow,
  entrants: readonly ActiveEntrant[],
  poolIds: ReadonlyMap<string, string>,
  /** The sealed-table setup counts (streams, YouTube broadcasts), read on the privileged prelude by `generateStageFixtures`.
   *  Absent for a caller that cannot read them (history's Redo re-running the generator): the tenant-readable kinds still count. */
  sealed: SealedSetupCounts | undefined,
): Promise<RoundRobinDecision> {
  if (stage.kind !== "league" && stage.kind !== "group") {
    throw new Error(`reconcileRoundRobinLines: stage ${stage.id} is a ${stage.kind}, not a round robin`);
  }
  const rows = await tx<StoredRow[]>`
    select id, ext_key, pool_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, status
      from fixtures where stage_id = ${stage.id} order by round_no, seq_in_round`;
  // A first Generate is not a reconcile: the caller branches here only when lines exist, so this is a caller's bug.
  if (rows.length === 0) throw new Error(`reconcileRoundRobinLines: stage ${stage.id} has no lines — a first Generate is not a reconcile`);

  const active = new Set(entrants.map((e) => e.id));
  const seated = new Set(rows.flatMap((r) => [r.home_entrant_id, r.away_entrant_id]).filter((id): id is string => id !== null));
  const newcomers = [...active].filter((id) => !seated.has(id));
  const departed = [...seated].filter((id) => !active.has(id));
  const started = (await divisionHasStarted(tx, stage.division_id)) || (await stageHasStarted(tx, stage.id));

  if (started) {
    if (newcomers.length > 0) throw roundRobinRefusal("RR_GENERATE_AFTER_START");
    return { kind: "noop" }; // unchanged, or only departures the withdrawal cascade already walked over
  }

  // A group whose live field has fallen below what its pools need (2 per pool) cannot be snaked again: the redraw is the one Rebuild
  // refuses (`group_too_few_entrants`). Nobody arrived, so there is nothing to place and the draw stands (the withdrawal cascade has
  // already walked the departed's lines over); an arrival into such a field falls through to the redraw's own refusal by name.
  if (stage.kind === "group" && entrants.length < poolCount(stage.config) * 2 && newcomers.length === 0) return { kind: "noop" };

  // Task-2 review, ruling 1: a redraw deletes every line, and the delete cascades into the organiser's setup on them (every kind
  // `stageAttachmentCounts` counts). Slots are carried by pair; the rest is not, so it is refused by name before any write
  // (the counts Rebuild's confirm reads), pointing to Rebuild, whose dialog lists what it clears.
  const attachments = await stageAttachmentCounts(tx, stage.id, sealed ?? { streams: 0, youtubeBroadcasts: 0 });
  const hasSetup = Object.values(attachments).some((n) => n > 0);
  const regenerateDecision: RoundRobinDecision = { kind: "regenerate", placed: newcomers, vacated: departed };
  const regenerate = (): RoundRobinDecision => {
    if (hasSetup) throw roundRobinRefusal("RR_REGENERATE_WOULD_CLEAR_SETUP", { attachments });
    return regenerateDecision;
  };
  const stored = rrLinesOfRows(rows);
  // A seat whose entrant was deleted by the FK (a line this change's own delete would have dropped) has no key to reconcile.
  if (stored.some((l) => l === null)) return regenerate();
  const before = stored as RrLine[];

  const schedule = roundRobinStagePlan(stage.kind, stage.config, [...entrants], new Map(poolIds));
  const fresh: RrLine[] = schedule.gen.map((g) => {
    const leg = rrLegOfExtKey(g.extKey);
    if (leg === null || g.home === null || g.away === null) throw new Error(`reconcileRoundRobinLines: the generator wrote ${g.extKey} with no leg or a seat missing`);
    return { key: rrKey(g.home, g.away, leg, g.poolId ?? null), home: g.home, away: g.away, roundNo: g.roundNo, leg, pool: g.poolId ?? null };
  });

  // A pool's parity: its recorded byes say which shape it was drawn in (a delete leaves fewer members than the shape). A stage
  // drawn before W5 recorded none, and its lines are untouched by any delete, so its members' parity is the shape's.
  const recorded = readRoundByes(stage.config);
  const storedByePools = new Set<string | null>(recorded?.map((b) => b.pool) ?? []);
  if (recorded === null) {
    const members = new Map<string | null, Set<string>>();
    for (const l of before) members.set(l.pool, (members.get(l.pool) ?? new Set<string>()).add(l.home).add(l.away));
    for (const [pool, m] of members) if (m.size % 2 === 1) storedByePools.add(pool);
  }
  const freshByePools = new Set<string | null>(schedule.byes.map((b) => b.pool));
  const plan = planRoundRobinReconcile(before, fresh, roundRobinShape(before, fresh, { stored: storedByePools, fresh: freshByePools }));
  if (plan.kind === "noop") return { kind: "noop" };
  if (plan.kind === "regenerate") return regenerate();

  // The patch: drop the pairs that are gone, then put each missing pair in the round the planner chose, on the round's next free
  // court (`seq_in_round`), with the leg stored on its key.
  const removed = new Set(plan.remove);
  if (plan.remove.length > 0) {
    // Undoable (task-2 review, ruling 3): the lines are recorded before they go, so Undo puts them back; and a chess invite still
    // queued for a board that goes ends with it (Phase 3 G-1), like every other fixture delete.
    await recordFixturesCleared(tx, stage.division_id, stage.id, plan.remove);
    await cancelBoardInvites(tx, plan.remove, FIXTURE_DELETED_REASON);
    await tx`delete from fixtures where stage_id = ${stage.id} and id in ${tx(plan.remove)}`;
  }
  const nextSeq = new Map<string, number>();
  const slotOf = (pool: string | null, roundNo: number) => `${pool ?? ""}|${roundNo}`;
  for (const r of rows) {
    if (removed.has(r.id)) continue;
    const at = slotOf(r.pool_id, r.round_no);
    nextSeq.set(at, Math.max(nextSeq.get(at) ?? 0, r.seq_in_round));
  }
  const poolKeyOf = new Map([...poolIds].map(([key, id]) => [id, key]));
  const newRows = plan.insert.map((line) => {
    const at = slotOf(line.pool, line.roundNo);
    const seq = (nextSeq.get(at) ?? 0) + 1;
    nextSeq.set(at, seq);
    const poolKey = line.pool === null ? undefined : poolKeyOf.get(line.pool);
    if (line.pool !== null && poolKey === undefined) throw new Error(`reconcileRoundRobinLines: pool ${line.pool} is not one of stage ${stage.id}'s`);
    return {
      id: randomUUID(),
      stage_id: stage.id,
      division_id: stage.division_id,
      pool_id: line.pool,
      round_no: line.roundNo,
      seq_in_round: seq,
      home_entrant_id: line.home,
      away_entrant_id: line.away,
      home_slot_label: null,
      away_slot_label: null,
      ext_key: rrExtKey(poolKey === undefined ? "" : `p${poolKey}-`, line.roundNo, seq, line.leg),
      status: "scheduled",
      outcome: null,
      lane: null,
      is_final: false,
      third_place: false,
      conditional: false,
    };
  });
  if (newRows.length > 0) await tx`insert into fixtures ${tx(newRows)}`;
  const insertedIds = newRows.map((r) => r.id);
  // Undoable generation: the lines this pass created are what Undo removes. A pass that only dropped lines creates none, but
  // still moves seats under the division's history, so a Redo waiting on the old board is cleared (as a Generate that creates
  // clears it).
  if (insertedIds.length > 0) await appendFixturesGenerated(tx, stage.division_id, { stage_id: stage.id, fixture_ids: insertedIds });
  else await tx`update divisions set edit_watermark = null where id = ${stage.division_id}`;
  const beforeSeated = new Set(before.flatMap((l) => [l.home, l.away]));
  const placed = [...new Set(plan.insert.flatMap((l) => [l.home, l.away]).filter((id) => !beforeSeated.has(id)))];
  return { kind: "patched", insertedIds, removedIds: plan.remove, placed, vacated: departed };
}

/**
 * #837, ruling 288 (G7): deleting an entrant BEFORE Start takes its lines out of every root league and group of the division,
 * and its entries out of each such stage's `config.round_byes`, in the caller's transaction and division lock. The FK
 * (`fixtures.home_entrant_id ... on delete set null`) alone left a half-filled line beside neighbours still fully seated, which
 * no button could repair; the next Generate then reconciles the stage against the shrunk roster (a parity flip redraws it).
 *
 * Refused (409) while a line of the entrant carries a result or any recorded evidence (`fixtureHasResultSql`): a Match rule set
 * or a team sheet on a pre-Start line is organiser setup this write must not silently destroy — the delete is retried once the
 * match data is cleared. A fed stage (`config.qualified`, or a progression) is left to its own path.
 */
export async function dropEntrantFromRoundRobins(tx: Tx, divisionId: string, entrantId: string): Promise<{ dropped: number }> {
  const stages = await tx<{ id: string }[]>`
    select s.id from stages s
     where s.division_id = ${divisionId} and s.kind in ('league', 'group') and s.progression is null
       and not (s.config ? 'qualified')`;
  if (stages.length === 0) return { dropped: 0 };
  const stageIds = stages.map((s) => s.id);
  const [blocked] = await tx<{ id: string }[]>`
    select f.id from fixtures f
     where f.stage_id in ${tx(stageIds)} and (f.home_entrant_id = ${entrantId} or f.away_entrant_id = ${entrantId})
       and ${fixtureHasResultSql(tx)}
     limit 1`;
  if (blocked) {
    throw new HttpError(
      409,
      "this entrant's fixtures hold recorded match data — clear it before deleting the entrant",
      "ENTRANT_FIXTURES_HAVE_RESULTS",
    );
  }
  const lines = await tx<{ id: string }[]>`
    select id from fixtures
     where stage_id in ${tx(stageIds)} and (home_entrant_id = ${entrantId} or away_entrant_id = ${entrantId})`;
  // A chess invite still queued for a board that goes ends with it (Phase 3 G-1); before the delete, like every other one.
  await cancelBoardInvites(tx, lines.map((l) => l.id), FIXTURE_DELETED_REASON);
  const gone = lines.length === 0 ? [] : await tx<{ id: string }[]>`delete from fixtures where id in ${tx(lines.map((l) => l.id))} returning id`;
  // G7: the victim's bye entries go with it; everybody else's stay exactly as they were.
  await tx`
    update stages set config = jsonb_set(
      config, '{round_byes}',
      coalesce((select jsonb_agg(b) from jsonb_array_elements(config -> 'round_byes') b where b ->> 'entrant_id' <> ${entrantId}), '[]'::jsonb))
     where id in ${tx(stageIds)} and jsonb_typeof(config -> 'round_byes') = 'array'`;
  if (gone.length > 0) await tx`update divisions set edit_watermark = null where id = ${divisionId}`;
  return { dropped: gone.length };
}
