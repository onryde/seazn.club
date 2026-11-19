import "server-only";
import { z } from "zod";
import {
  HistoryError,
  redo as engineRedo,
  undo as engineUndo,
  type FixtureSnapshot,
  type LedgerEvent,
} from "@seazn/engine/history";
import { EngineError } from "@seazn/engine/core";
import { readStageRoundByes, snapshotFixtures, writeStageRoundByes } from "../fixture-snapshot";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { SCHEDULE_LOCKED_CODE, SCHEDULE_LOCKED_MESSAGE } from "@/lib/schedule-lock";
import { fixtureHasResultSql, playedFixtureIds } from "../fixture-results-sql";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  afterGenerateCommit,
  clearSwissFixtureSeats,
  generateStageFixtures,
  generateStageFixturesTx,
  lockSwissBoardAppends,
  refoldStageTable,
  type GenerateWrite,
} from "../stages";
import { swissRefusal } from "../swiss-refusal";
import { afterScheduleWrite, divisionLockState } from "../schedule";
import { schedulePlayerStatsRefresh } from "../player-stats-refresh";
import { appendEvent, divisionMeta, loadLedger, toEngineError } from "./ledger";
import { barrierOfRefusedStep, invertedStepSeq, pairNextSeatedIds, pairRowClearedBy, pairRowRestoredBy, recordedPairingOverride, undoBarrierRefusal, undoRefusal } from "./barriers";
import { DELETE_SIDE_EVENTS, restoreFixtures, snapshotIdKey } from "./restore";
import { execute } from "./execute";

export interface HistoryStepOut {
  watermark: number;
  seq: number;
  applied: { type: string };
  regenerate_stage_id?: string;
}

const StepInput = z.object({ expected_seq: z.number().int().optional() });
export { StepInput as HistoryStepInput };

/** One undo/redo step's committed write (R10e): what it returns, its
 *  competition, and the fixtures its own statements changed. */
interface StepWrite {
  out: HistoryStepOut;
  competitionId: string;
  fixtureIds: string[];
  scoredFixtureRemoved: boolean;
  /** W3 T5: the stages an Undo of Pair next put back onto their shells, refolded after the commit. */
  unpairedStageIds: string[];
  /** Batch-1 I1: a Swiss Pair this step re-applied inside its own transaction, for the generate's post-commit work. */
  repaired?: { stageId: string; write: GenerateWrite };
  /** Any other regeneration this step asks for (a league's, a Swiss shells pass): run after the commit, as before. */
  regen?: string;
}

export async function stepWrite(
  auth: AuthCtx,
  divisionId: string,
  direction: "undo" | "redo",
  expectedSeq: number | undefined,
): Promise<StepWrite> {
  const write = await withTenant(auth.orgId, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    const meta = await divisionMeta(tx, divisionId);
    // optimistic token (Jul3/03 §8): a stale client gets 409 + refetch
    if (expectedSeq !== undefined && expectedSeq !== meta.seq) {
      throw new EngineError("SEQ_CONFLICT", "division changed since you loaded it", {
        actualSeq: meta.seq,
      });
    }
    // A freeze binds the REWIND as well as every forward edit, and
    // `restoreCheckpoint` is a LOOP OF THIS FUNCTION — so a freeze that stopped
    // the restore left the primitive it is built out of live, on two buttons a
    // few hundred pixels above the Restore it had just disabled. Same blast
    // radius, one layer down.
    //
    // Guarding it strands nobody, which is the objection this was exempted for.
    // `divisions.schedule_locked` has exactly ONE writer — `setDivisionLocks`,
    // which appends no ledger event — so there is no replay of the division
    // freeze and no rewind could ever have handed it back. The `schedule_locked`
    // undo DOES replay is `fixtures.schedule_locked`, the per-fixture pin: a
    // different column on a different table with the same name, and the whole
    // of the original exemption's reasoning.
    //
    // WHICH OTHER PATHS REFUSE: do not read a list here, and do not trust a
    // count — the sentence that used to sit in this comment named four
    // siblings, called the enumeration finished, and was false at three sites
    // (`clearPoolEntrants` and `deleteCheckpoint` below, `shiftDivisionSchedule`
    // in schedule-plus.ts) on the day it was written. The enumeration is now
    // the IMPORT GRAPH of `@/lib/schedule-lock`: every board-write refusal
    // throws `SCHEDULE_LOCKED_MESSAGE` with `SCHEDULE_LOCKED_CODE` at 422, so
    // `grep -rn SCHEDULE_LOCKED_MESSAGE apps/web/src` is the live answer and a
    // freeze refusal that does NOT import the constant is the bug. (The joint
    // apply, competition-schedule-apply.ts, shares the CODE but formats its own
    // sentence through `scheduleLockedMessageFor` because it must name which
    // division of a competition stopped the run. The AI-plan gates answer 409
    // with the same code.)
    //
    // AFTER the existence check in `divisionMeta` (a missing division still
    // 404s) and after the optimistic token, matching `applySchedule`, which
    // runs `assertFreshSeq` ahead of its own freeze check. BEFORE the ledger
    // read, so a frozen division refuses without engine work and without a
    // chance of appending.
    const lockState = await divisionLockState(tx, divisionId);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }
    const ledger = await loadLedger(tx, divisionId);
    const played = await playedFixtureIds(tx, divisionId);
    let result;
    try {
      result =
        direction === "undo"
          ? engineUndo(ledger, meta.edit_watermark, played)
          : engineRedo(ledger, meta.edit_watermark, played);
    } catch (err) {
      // W4 T12 (RB4-L13): a step the engine refuses for a result in its footprint still answers BY NAME when it crosses an
      // undo barrier. A late player placed in a case (2) seat leaves the withdrawal's voided walkover on the line, which
      // the results guard counts: the generic "a match this change touches has started or finished" answered first, and
      // never pointed to Withdraw.
      if (err instanceof HistoryError && err.code === "UNDO_BLOCKED_HAS_RESULTS") {
        const barrier = barrierOfRefusedStep(direction, ledger, meta.edit_watermark);
        if (barrier !== null) throw undoRefusal(barrier);
      }
      toEngineError(err);
    }
    // W3 T5 (design §10.8, X-SW-28). The undo barriers first, before any read or write: an organiser's late entry, a
    // round-count change or (W4 T5, K1) a seed confirm newer than the row this step inverts (Undo) or copies (Redo)
    // refuses the step by name.
    const targetSeq = invertedStepSeq(direction, result.event.payload);
    const barrier = undoBarrierRefusal(ledger, targetSeq);
    if (barrier !== null) throw undoRefusal(barrier);
    // Undo of Pair next (SW-M2 / #835, RB3-22). A Pair seats a Swiss round by UPDATING shells that already exist, so
    // its `fixtures_generated` names no `fixture_ids` and the engine's inverse deletes nothing: the seats are this
    // step's to clear, read from the Pair row the step takes away (`seated_fixture_ids`; `pairRowClearedBy`: the row an
    // Undo inverts, or the row a Redo-of-an-Undo had inverted). The round goes back onto its shells exactly as Unpair
    // puts it (`clearSwissFixtureSeats`: seats, outcome, the bye's frozen cfg; never a slot) — unless a row of it holds
    // a result, when the whole step refuses by name (the bye is no result: `systemByeSql`). A step that puts a Pair BACK
    // re-pairs in this transaction instead (batch-1 I1, below), so it re-pairs AND re-freezes the bye through
    // `swissGen`'s own seat, under the division lock, with the cfg that stands then.
    const unseated: string[] = [];
    const unpairedStageIds: string[] = [];
    const seatedIds =
      result.event.type === "fixtures_cleared" ? pairNextSeatedIds(pairRowClearedBy(ledger, direction, targetSeq)) : [];
    if (seatedIds.length > 0) {
      // Review m1: every seated board's append lock (`fixture:`), sorted, after this step's `division:` lock and
      // before the read below — a scorer's first event is either seen by it or waits and finds the seats gone.
      await lockSwissBoardAppends(tx, seatedIds);
      const [started] = await tx<{ id: string }[]>`
        select f.id from fixtures f where f.id in ${tx(seatedIds)} and ${fixtureHasResultSql(tx, "f")} limit 1`;
      if (started) throw swissRefusal("SWISS_UNDO_ROUND_STARTED", { fixtureId: started.id });
      // Only rows that still exist: a later reshape may have deleted a shell the Pair seated.
      const live = await tx<{ id: string; stage_id: string }[]>`
        select id, stage_id from fixtures where id in ${tx(seatedIds)} order by id`;
      const ids = live.map((f) => f.id);
      await clearSwissFixtureSeats(tx, ids);
      unseated.push(...ids);
      unpairedStageIds.push(...new Set(live.map((f) => f.stage_id)));
    }
    // A delete-side event records the rows it deletes AS THEY STAND NOW —
    // before the delete, so the appended event is self-contained. (A plain
    // Redo of a generation never reads them: it re-runs the generator. They
    // are re-inserted when a later undo walks back past this one — below.)
    //
    // ALWAYS a fresh read, never the snapshot the event inherited: an undo of
    // a restore (`fixtures_generated` / `pool_entrants_restored` carrying
    // rows) and a redo of a clear both hand back the payload of the event
    // they invert or copy, whose snapshot is from BEFORE the restore. It used
    // to be kept whenever present, so a change made outside the ledger since
    // the restore — any writer that appends no division event (a seed fill
    // was the real one until W4 T5 made `confirmSeedProposal` append its
    // `seed_confirmed` barrier, which no step now crosses) — was deleted here
    // and quietly reverted by the next restore.
    if (result.event.type === "fixtures_cleared") {
      const ids = (result.event.payload.fixture_ids as string[]) ?? [];
      if (ids.length > 0) result.event.payload.fixtures = await snapshotFixtures(tx, { ids });
      // W5 T2 fix round 3: the stage's byes as they stand now ride with the delete, as the rows do, so the step that walks back past
      // it puts both back (a redraw rewrites `config.round_byes`; the engine's inverse carries rows only).
      const clearedStage = result.event.payload.stage_id as string | undefined;
      if (ids.length > 0 && clearedStage !== undefined) result.event.payload.round_byes = await readStageRoundByes(tx, clearedStage);
    } else if (result.event.type === "pool_entrants_cleared") {
      const ids = ((result.event.payload.fixtures as FixtureSnapshot[]) ?? []).map((f) => f.id);
      result.event.payload.fixtures = await snapshotFixtures(tx, { ids });
    }
    // ...and a restore restores the rows as they were LAST deleted: the
    // snapshot of the newest delete-side event of the same rows, never merely
    // the one it inverts. The two differ whenever the step inverts an older
    // delete: Undo after a Redo inverts the ORIGINAL clear, not the redo's
    // copy (the engine's `redo` moves the watermark back onto the original);
    // walking back past a restore deletes the rows again (the Undo of that
    // restore, an `__undo_of` inverse) and then inverts the delete the
    // restore had undone. Either way the older snapshot predates a change
    // made while the rows were back, and the round trip reverted it.
    const restoring =
      result.event.type === "pool_entrants_restored" ||
      (result.event.type === "fixtures_generated" && result.event.payload.fixtures !== undefined);
    // The byes the newest delete of these rows recorded (`undefined` for a ledger row from before they were kept: left alone).
    let restoredByes: unknown[] | null | undefined;
    if (restoring) {
      const rows = snapshotIdKey(result.event.payload.fixtures);
      // Only a restore that names its rows, and only a DELETE of them: a
      // payload with no snapshot keys as `undefined`, and would otherwise
      // match any event that carries none.
      const newest =
        rows === undefined
          ? undefined
          : ledger.findLast((e) => DELETE_SIDE_EVENTS.has(e.type) && snapshotIdKey(e.payload.fixtures) === rows);
      if (newest !== undefined) {
        result.event.payload.fixtures = newest.payload.fixtures;
        const recorded = newest.payload.round_byes;
        if (recorded === null || Array.isArray(recorded)) restoredByes = recorded as unknown[] | null;
      }
    }
    // Batch-1 I1. A Swiss Pair this step re-applies — a Redo of it, or an Undo walking back through its own Undo (the
    // engine's inverse of a seat clear names no rows, `fixture_ids: []`) — is re-paired HERE, in this transaction, and
    // recorded on THIS step's row: `ledger: "step"` appends no fresh `fixtures_generated` and leaves the watermark to
    // the engine. As a fresh edit it nulled the watermark to the head, so the next Undos cleared the seats, did nothing,
    // then walked back through the Undo and re-paired — round and round, never past the Pair, and a Restore across it
    // ran 500 steps into "did not converge". The seats it re-pairs are stamped on the row (`seated_fixture_ids`), so an
    // Undo of this row clears them: the inverse the engine hands an Undo-of-an-Undo carries none of its own. Any other
    // regeneration (a league's, a Swiss shells pass) still runs after the commit, as before.
    const regenStageId =
      result.event.type === "fixtures_generated" && result.event.payload.fixtures === undefined
        ? ((result.event.payload.stage_id as string | undefined) ?? undefined)
        : undefined;
    let repaired: StepWrite["repaired"];
    const namesNoRows = ((result.event.payload.fixture_ids as unknown[] | undefined) ?? []).length === 0;
    if (regenStageId !== undefined && namesNoRows) {
      const [stage] = await tx<{ kind: string }[]>`select kind from stages where id = ${regenStageId}`;
      if (stage?.kind === "swiss") {
        // P1: the Pair this step puts back is re-paired with the round-1 override its own row recorded (Neighbours is
        // never stored on the stage); without it the round came back as the default fold.
        const pairing = recordedPairingOverride(pairRowRestoredBy(ledger, direction, targetSeq));
        const write = await generateStageFixturesTx(tx, auth, regenStageId, pairing === undefined ? {} : { pairing }, "step");
        result.event.payload = { ...result.event.payload, seated_fixture_ids: [], ...write.ledgerPayload };
        repaired = { stageId: regenStageId, write };
      }
    }
    const effects = { scoredFixtureRemoved: false };
    const fixtureIds = await execute(tx, divisionId, result.event, effects);
    fixtureIds.push(...unseated);
    if (repaired !== undefined) fixtureIds.push(...pairNextSeatedIds(result.event as LedgerEvent));
    const seq = await appendEvent(tx, divisionId, result.event, auth.userId);
    await tx`update divisions set seq = ${seq}, edit_watermark = ${result.newWatermark}
             where id = ${divisionId}`;
    const regen = repaired === undefined ? regenStageId : undefined;
    // A fixtures_generated with snapshots re-inserts directly — the undo of
    // an undone generation (Undo past a later edit, or a save-point restore).
    // It never routes through execute(); `restoreFixtures` is shared with
    // pool_entrants_restored there, so both inverses restore the same row.
    if (result.event.type === "fixtures_generated" && result.event.payload.fixtures !== undefined) {
      const snapshots = (result.event.payload.fixtures as FixtureSnapshot[]) ?? [];
      fixtureIds.push(...(await restoreFixtures(tx, divisionId, snapshots, result.event.type)));
      const restoredStage = result.event.payload.stage_id as string | undefined;
      if (restoredByes !== undefined && restoredStage !== undefined) await writeStageRoundByes(tx, restoredStage, restoredByes);
    }
    return {
      out: {
        watermark: result.newWatermark,
        seq,
        applied: { type: result.event.type },
        ...(regenStageId !== undefined ? { regenerate_stage_id: regenStageId } : {}),
      },
      competitionId: meta.competition_id,
      fixtureIds,
      scoredFixtureRemoved: effects.scoredFixtureRemoved,
      unpairedStageIds,
      ...(repaired !== undefined ? { repaired } : {}),
      ...(regen !== undefined ? { regen } : {}),
    };
  });
  // A Swiss Pair re-applied in the step's transaction gets the generate's own post-commit work (table refold,
  // revalidation); the step's publish names its seats. Any other regeneration still re-runs the generator after the
  // commit (it takes its own division lock and publishes its own write; this step's transaction changed no fixture
  // then — `fixtures_generated` has no executor statement).
  if (write.repaired !== undefined) {
    await afterGenerateCommit(auth, write.repaired.stageId, write.repaired.write);
  } else if (write.regen !== undefined) {
    await generateStageFixtures(auth, write.regen);
  }
  // A bye award (and its removal) never goes through appendEvent, so the stored table would keep the cleared bye's
  // points until the next scored match. Refold from the cleared rows, as Unpair does — `"drop"`: a stage left seating
  // nobody has no table, so the stored one goes and the page reads "No standings yet". Best-effort (review m3): the
  // Undo has committed, so a refold that throws is logged (`refoldStageTable`), never a 500 the organiser would retry
  // into undoing one step MORE.
  for (const stageId of write.unpairedStageIds) {
    await refoldStageTable(auth.orgId, { id: stageId, kind: "swiss" }, "drop");
  }
  return write;
}

/** R10e (review-r10d m1): a history write that changed fixtures drops the hub
 *  key and exactly those fixtures' public documents in one DEL, after its
 *  commit, then pushes (`afterScheduleWrite`, 50-fixture push cap). An undo is
 *  the move it reverses, so the hub and an open match centre must follow it
 *  at once, not at the next poll. A write that changed nothing sends nothing. */
export function publishHistoryWrite(
  auth: AuthCtx,
  divisionId: string,
  competitionId: string,
  fixtureIds: readonly string[],
  scoredFixtureRemoved: boolean,
): void {
  if (fixtureIds.length > 0) afterScheduleWrite(divisionId, competitionId, "schedule", fixtureIds);
  // A removed fixture's score events went with it, so the division's player
  // stats still count them until they are refolded (review m3).
  if (scoredFixtureRemoved) schedulePlayerStatsRefresh(auth.orgId, { divisionId });
}

async function step(
  auth: AuthCtx,
  divisionId: string,
  direction: "undo" | "redo",
  expectedSeq: number | undefined,
): Promise<HistoryStepOut> {
  const write = await stepWrite(auth, divisionId, direction, expectedSeq);
  publishHistoryWrite(auth, divisionId, write.competitionId, write.fixtureIds, write.scoredFixtureRemoved);
  return write.out;
}

export const undoDivision = (auth: AuthCtx, id: string, expectedSeq?: number) =>
  step(auth, id, "undo", expectedSeq);
export const redoDivision = (auth: AuthCtx, id: string, expectedSeq?: number) =>
  step(auth, id, "redo", expectedSeq);
