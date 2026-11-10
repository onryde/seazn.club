import "server-only";
// W4 app B, Task 12 (X-CH-4, X-CH-6; Q4): "Declare joint winners" on an unplayed final - and its Undo.
//
// Storage (plan's call): the engine's MatchOutcome kinds are closed, so a joint title is no outcome. It is a fixture column
// (V499 `fixtures.joint_winners_at`): the final is stored `status = 'decided'`, `outcome = null`, `joint_winners_at = now()`.
// What it held before (`prior`: its status and outcome) is kept in a division-ledger row `joint_winners_declared`, which the
// Undo reads back (the newest row of the fixture). The row moves the division's token and never the watermark
// (`appendUndoBarrierRow`'s pattern): it is no history step.
//
// Both writers run under the division's advisory lock, then the stage-seats lock, then the fixture's own append lock - the
// house order (fed-seats.ts) - so a scorer's first event either commits before and is seen, or waits and is refused by name
// (`FINAL_JOINT_WINNERS_DECLARED`, append-event.ts: `decided` is not in `LOCKED_FIXTURE_STATUSES`, so the append door asks). Organiser-only: the routes take the `write` door of the fixture (a `manage` key).
import { withTenant, type Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { log } from "@/server/logger";
import { jointWinnersOffered } from "@/lib/joint-winners";
import { assertStageNotSeeded, departedOf, lockDivisionConfigShared, lockStageSeats, reopenCompletedStage } from "@/server/engine-db/fed-seats";
import type { AuthCtx } from "@/server/api-v1/auth";
import { knockoutRefusal } from "./knockout-refusal";
import { afterScheduleWrite } from "./schedule";
import { completeStage } from "./stages";
import { invalidatePublicCache } from "./scoring";

const LEDGER_DECLARED = "joint_winners_declared";
const LEDGER_UNDONE = "joint_winners_undone";
/** A status that already carries a result: a declaration over it would hide one. */
const DECIDED_STATUSES: ReadonlySet<string> = new Set(["decided", "finalized", "forfeited"]);

interface FinalRow {
  id: string;
  stage_id: string;
  division_id: string;
  competition_id: string;
  stage_kind: string;
  stage_status: string;
  status: string;
  outcome: unknown;
  is_final: boolean;
  third_place: boolean;
  conditional: boolean;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  joint_winners_at: Date | null;
}

async function readFinal(tx: Tx, fixtureId: string): Promise<FinalRow> {
  const [f] = await tx<FinalRow[]>`
    select f.id, f.stage_id, f.division_id, d.competition_id, s.kind as stage_kind, s.status as stage_status,
           f.status, f.outcome, f.is_final, f.third_place, f.conditional, f.home_entrant_id, f.away_entrant_id, f.joint_winners_at
      from fixtures f join stages s on s.id = f.stage_id join divisions d on d.id = f.division_id
     where f.id = ${fixtureId}`;
  if (!f) throw new HttpError(404, "fixture not found");
  return f;
}

/** The locks, in the house order, then the fixture read UNDER them. */
async function lockedFinal(tx: Tx, fixtureId: string): Promise<FinalRow> {
  const first = await readFinal(tx, fixtureId);
  await tx`select pg_advisory_xact_lock(hashtext(${"division:" + first.division_id}))`;
  await lockStageSeats(tx, first.stage_id);
  await tx`select pg_advisory_xact_lock(hashtext(${"fixture:" + fixtureId}))`;
  await lockDivisionConfigShared(tx, first.stage_id);
  return readFinal(tx, fixtureId);
}

/** A division-ledger row that moves the division's token and never the watermark (a barrier's pattern, not a history step). */
async function appendLedgerRow(tx: Tx, divisionId: string, type: string, payload: Record<string, unknown>, actorId: string | null): Promise<void> {
  const [{ seq: last }] = await tx<{ seq: number }[]>`select coalesce(max(seq), 0)::int as seq from division_events where division_id = ${divisionId}`;
  await tx`
    insert into division_events (division_id, seq, type, payload, actor_id)
    values (${divisionId}, ${last + 1}, ${type}, ${tx.json(payload as never)}, ${actorId})`;
  await tx`update divisions set seq = ${last + 1} where id = ${divisionId}`;
}

export interface DeclareJointWinnersResult {
  fixture_id: string;
  /** Whether the declaration also completed the stage (it does whenever every other line is settled). */
  stage_completed: boolean;
}

export async function declareJointWinners(auth: AuthCtx, fixtureId: string): Promise<DeclareJointWinnersResult> {
  const { f } = await withTenant(auth.orgId, async (tx) => {
    const f = await lockedFinal(tx, fixtureId);
    if (f.joint_winners_at !== null) throw knockoutRefusal("JOINT_WINNERS_FINAL_DECIDED");
    // Is it a final that can take one at all? Asked BEFORE the result, so a decided semi-final answers "not a final", not
    // "this final already has a result". (A double-elimination grand final is refused by the shared predicate below, which
    // owns that rule alone - C32, parked.)
    if (!f.is_final || f.third_place || f.conditional || f.home_entrant_id === null || f.away_entrant_id === null) {
      throw knockoutRefusal("JOINT_WINNERS_NOT_A_FINAL");
    }
    // A result already stands: never hidden by this declaration.
    if (DECIDED_STATUSES.has(f.status)) throw knockoutRefusal("JOINT_WINNERS_FINAL_DECIDED");
    if (
      !jointWinnersOffered({
        is_final: f.is_final,
        third_place: f.third_place,
        conditional: f.conditional,
        stage_kind: f.stage_kind,
        status: f.status,
        home_entrant_id: f.home_entrant_id,
        away_entrant_id: f.away_entrant_id,
        joint_winners_at: null,
      })
    ) {
      throw knockoutRefusal("JOINT_WINNERS_NOT_A_FINAL");
    }
    // Both finalists out is a VACANT title (X-CH-3): it takes no joint ruling over two departed entrants.
    if ((await departedOf(tx, [f.home_entrant_id, f.away_entrant_id])).size === 2) throw knockoutRefusal("JOINT_WINNERS_FINALISTS_OUT");
    const [row] = await tx<{ id: string }[]>`
      update fixtures set status = 'decided', outcome = null, joint_winners_at = now()
       where id = ${f.id} and status = ${f.status} and joint_winners_at is null returning id`;
    if (!row) throw new Error(`declareJointWinners: fixture ${f.id} moved under its lock`);
    await appendLedgerRow(tx, f.division_id, LEDGER_DECLARED, { fixture_id: f.id, prior: { status: f.status, outcome: f.outcome } }, auth.userId);
    return { f };
  });
  // Complete the stage it settles. The organiser's Complete (progression included) is the one writer; a bracket still owed a
  // result elsewhere (a third-place match) is its named refusal - the declaration stands, the stage waits.
  // The declaration has COMMITTED: whatever the completion answers, the cache is published and the declaration is reported
  // (a completion failure is logged and reads `stage_completed: false`, the organiser's Complete is still there).
  let stageCompleted = false;
  try {
    stageCompleted = (await completeStage(auth, f.stage_id)).completed;
  } catch (err) {
    if (!(err instanceof HttpError && err.code === "STAGE_HAS_UNDECIDED_FIXTURES")) {
      log.error({ err, fixtureId: f.id, stageId: f.stage_id }, "declareJointWinners: the stage completion failed after the declaration committed");
    }
  }
  await publish(auth, f);
  return { fixture_id: f.id, stage_completed: stageCompleted };
}

export async function undoJointWinners(auth: AuthCtx, fixtureId: string): Promise<{ fixture_id: string; status: string }> {
  const { f, status } = await withTenant(auth.orgId, async (tx) => {
    const f = await lockedFinal(tx, fixtureId);
    if (f.joint_winners_at === null) throw knockoutRefusal("JOINT_WINNERS_NOT_DECLARED");
    // A finalist who left AFTER the declaration (the joint title stands over a withdrawal): restoring the open final would seat
    // a departed finalist with no walkover written. Refused by name until they are reinstated.
    if ((await departedOf(tx, [f.home_entrant_id!, f.away_entrant_id!])).size > 0) throw knockoutRefusal("JOINT_WINNERS_UNDO_FINALIST_OUT");
    // The newest declaration of THIS fixture (declare -> undo -> declare writes a second row).
    const [row] = await tx<{ payload: { prior?: { status?: string; outcome?: unknown } } }[]>`
      select payload from division_events
       where division_id = ${f.division_id} and type = ${LEDGER_DECLARED} and payload->>'fixture_id' = ${f.id}
       order by seq desc limit 1`;
    const prior = row?.payload.prior;
    if (typeof prior?.status !== "string") {
      throw new Error(`undoJointWinners: fixture ${f.id} carries joint_winners_at but no ${LEDGER_DECLARED} row names its prior state`);
    }
    // The stage completed on the declaration: its ranks may have seeded another stage; otherwise it re-opens.
    if (f.stage_status === "complete") await assertStageNotSeeded(tx, f.stage_id);
    await tx`
      update fixtures set status = ${prior.status}, outcome = ${prior.outcome === null || prior.outcome === undefined ? null : tx.json(prior.outcome as never)},
             joint_winners_at = null
       where id = ${f.id} and joint_winners_at is not null`;
    if (f.stage_status === "complete") await reopenCompletedStage(tx, f.stage_id, f.division_id);
    await appendLedgerRow(tx, f.division_id, LEDGER_UNDONE, { fixture_id: f.id }, auth.userId);
    return { f, status: prior.status };
  });
  await publish(auth, f);
  return { fixture_id: f.id, status };
}

/** After the commit: the public cache reads the final, the stage and the division again. Best-effort past the commit. */
async function publish(auth: AuthCtx, f: FinalRow): Promise<void> {
  await invalidatePublicCache(auth.orgId, f.id, false, undefined, [f.id]).catch(() => undefined);
  afterScheduleWrite(f.division_id, f.competition_id, "schedule", [f.id]);
}
