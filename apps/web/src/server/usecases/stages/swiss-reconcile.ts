import "server-only";
// Swiss round-shell reconcile: the reshape counters and the pass that re-aligns
// unpaired round shells to the current field.

import { randomUUID } from "node:crypto";
import { EngineError } from "@seazn/engine/core";
import { isSwissBoardSeated, isSwissByeShellExtKey, mintSwissBoardExtKeys, swissBoardsForField, swissRoundHasPlayedResult } from "@/lib/swiss-shell";
import { fixtureEvidenceSql } from "../fixture-results-sql";
import { chooseDoomedBoards } from "@/lib/rebuild-slots";
import { firstOwnFormat, ownFormatLoss } from "../fixture-override-guards";
import type { Tx, SwissExistingFixture, SwissReshape } from "./types";

/**
 * What a tripped reconcile guard means for the round that tripped it.
 *
 * `"refuse"` — throw `STAGE_NOT_READY`. Right for the round being PAIRED: the
 * organiser pressed Pair next on it, so a round that cannot be reshaped is the
 * answer to what they asked, and it has to be said out loud.
 *
 * `"skip"` — leave the round exactly as found and carry on. Right for every
 * OTHER round the eager pre-Start pass sweeps up. Those rounds were never
 * asked about; before the eager pass existed no guard could fire on them at
 * all. Throwing there would abort the whole Generate and take the target
 * round's pairing down with it — turning a Generate that works today into a
 * hard refusal over a round nobody touched. That is the same promise
 * `reconcileSwissRoundShells`' early return already makes for the paired
 * round: evidence blocks a RESHAPE, never a Pair that needs none.
 *
 * The cost of `"skip"` is honest and bounded: such a round stays sized for the
 * old field until something clears whatever blocks it. Stale beats refusing to
 * run the tournament, and the round is left untouched rather than half-written
 * — every guard is read before the first write.
 */
type SwissReconcileBlockedPolicy = "refuse" | "skip";

export const NO_SWISS_RESHAPE: SwissReshape = {
  matches_added: 0,
  matches_removed: 0,
  byes_added: 0,
  byes_removed: 0,
};

/** True when a reshape moved nothing — the common Pair, which must stay silent. */
export function isEmptySwissReshape(r: SwissReshape): boolean {
  return (
    r.matches_added === 0 && r.matches_removed === 0 && r.byes_added === 0 && r.byes_removed === 0
  );
}

export function addSwissReshape(a: SwissReshape, b: SwissReshape): SwissReshape {
  return {
    matches_added: a.matches_added + b.matches_added,
    matches_removed: a.matches_removed + b.matches_removed,
    byes_added: a.byes_added + b.byes_added,
    byes_removed: a.byes_removed + b.byes_removed,
  };
}

/** One round's reconcile: the round as it now stands, and what moved. */
interface SwissRoundReconcile {
  shells: SwissExistingFixture[];
  delta: SwissReshape;
}

/**
 * Bring round `target`'s shells into line with the CURRENT active field, and
 * return the round as it now stands (2026-09-20 hardening, Task 1.0).
 *
 * WHY this exists. After Start the only roster change left is a withdrawal
 * (`enrollEntrants` refuses additions on an `active` division), and a
 * withdrawal is a status flip, not a delete — the row survives as `withdrawn`
 * and drops straight out of this path's `status in ('registered','confirmed')`
 * field. The shells, however, were minted once for the field as it was at the
 * first Generate and were never revisited, so the seating loop below walked
 * pre-minted shells against a newly-sized `round.pairings` and threw
 * `"swiss shell count mismatch for pairing"` / `"swiss bye shell missing for
 * pairing"`. A parity change is the NORMAL consequence of a withdrawal, so a
 * player not showing for round 3 ended the tournament.
 *
 * RECONCILE, never delete-and-recreate (owner ruling 2026-09-20, option (a),
 * refined). Scheduling a shell AHEAD of Pair is a shipped, tested feature —
 * `apps/web/e2e/swiss-shell.spec.ts` pins a TBD shell's `scheduled_at` and
 * asserts it survives Pair and re-Pair. Recreating the round would change
 * fixture ids and discard `scheduled_at` / `court_id`, silently losing an
 * organiser's advance layout. So only the DELTA moves: the surplus boards are
 * the ones holding the least (`chooseDoomedBoards`, lib/rebuild-slots.ts: a
 * board with no slot first, then an unlocked one, then the highest seq — W3
 * T2, SW-L8), survivors are re-packed to seq 1..n, only the shortfall is
 * minted (`mintSwissBoardExtKeys`), and the bye shell is added or removed
 * exactly as parity requires. Surviving rows keep their ids and their slots. `swissBoardsForField` is the one authority for
 * the shape — shared with `planSwissShells`, so the mint and the reconcile can
 * never drift onto different arithmetic.
 *
 * ONE ROUND per call. Which rounds get a call is the CALLER's decision and
 * turns on whether the division has started — see `swissGen`, and
 * `divisionHasStarted` for the predicate. Before Start that is every unseated
 * round; after Start it is only the round being paired. Either way this
 * function reshapes exactly the round it was handed, under the same guards.
 *
 * GUARDS. The advisory lock is already held — `generateStageFixturesTx` (the
 * one caller, through `swissGen`) takes `pg_advisory_xact_lock` before it reads
 * either the entrant list or `existing`, in Generate's transaction or inside
 * Rebuild's one transaction — so everything below is read UNDER the lock,
 * which is this file's stated convention. Three arms on the round, none covering for another: the round
 * must be wholly unseated, must show no played status or award, and must carry
 * no recorded match data under the CANONICAL `fixtureEvidenceSql` (not a
 * subset — a subset guard on a destructive path is how C1 happened). A
 * fourth (W2c Task 14) reads only the rows the delete would drop: none may
 * carry its own format (`FIXTURE_HAS_OWN_FORMAT`). The
 * evidence test is monotonic on purpose: `fixtures.status` moves BACKWARDS
 * when a `core.start` is voided, so status may only ADD refusals.
 *
 * Refusals reuse `STAGE_NOT_READY`, the code this function's siblings already
 * raise, so no new organiser-facing string is introduced here.
 *
 * `onBlocked` decides what a tripped guard MEANS, and it is the caller's call
 * because it depends on whose round this is — see `SwissReconcileBlockedPolicy`.
 */
export async function reconcileSwissRoundShells(
  tx: Tx,
  stageId: string,
  divisionId: string,
  target: number,
  existing: readonly SwissExistingFixture[],
  fieldSize: number,
  onBlocked: SwissReconcileBlockedPolicy,
): Promise<SwissRoundReconcile> {
  const bySeq = (a: SwissExistingFixture, b: SwissExistingFixture) =>
    a.seq_in_round - b.seq_in_round;
  const isByeShell = (f: SwissExistingFixture) => isSwissByeShellExtKey(f.ext_key);

  const round = existing.filter((f) => f.round_no === target).sort(bySeq);
  const boardRows = round.filter((f) => !isByeShell(f));
  const byeRow = round.find(isByeShell);

  const { boards, bye } = swissBoardsForField(fieldSize);
  // The overwhelmingly common case: the field has not moved, so nothing is
  // written and every row keeps its id, its schedule and its court.
  if (boardRows.length === boards && (byeRow !== undefined) === bye) {
    return { shells: round, delta: NO_SWISS_RESHAPE };
  }

  // All three guards below are reached only once the round NEEDS reshaping —
  // the early return above is what keeps a correct-shaped round Pairing even
  // where evidence exists. Each arm either refuses or skips per `onBlocked`;
  // nothing has been written yet at any of them, so a skip leaves the round
  // exactly as it was found.
  if (round.some((f) => isSwissBoardSeated(f))) {
    if (onBlocked === "skip") return { shells: round, delta: NO_SWISS_RESHAPE };
    throw new EngineError("STAGE_NOT_READY", "swiss round is already partly seated — reconcile refused", {
      stageId,
      round: target,
    });
  }
  if (swissRoundHasPlayedResult(round, target)) {
    if (onBlocked === "skip") return { shells: round, delta: NO_SWISS_RESHAPE };
    throw new EngineError("STAGE_NOT_READY", "swiss round has played results — reconcile refused", {
      stageId,
      round: target,
    });
  }
  const ids = round.map((f) => f.id);
  if (ids.length > 0) {
    const [blocked] = await tx<{ id: string }[]>`
      select f.id from fixtures f
      where f.id in ${tx(ids)} and (${fixtureEvidenceSql(tx)})
      limit 1`;
    if (blocked) {
      if (onBlocked === "skip") return { shells: round, delta: NO_SWISS_RESHAPE };
      throw new EngineError("STAGE_NOT_READY", "swiss round has recorded match data — reconcile refused", {
        stageId,
        round: target,
        fixtureId: blocked.id,
      });
    }
  }

  // Deletes first. W3 T2 (SW-L8): the surplus is the boards that hold the
  // least — an unscheduled board before a pinned one (`chooseDoomedBoards`) —
  // never simply the highest seq, which deleted an organiser's advance layout
  // while a bare board survived.
  const chosen = chooseDoomedBoards(boardRows, boards);
  const survivors = chosen.survivors;
  const doomed = [...chosen.doomed, ...(byeRow && !bye ? [byeRow] : [])];
  if (doomed.length > 0) {
    // W2c Task 14 (fix round 1) — a fourth arm, read before the first write
    // like the three above: a doomed shell carrying its own format
    // (`fixtures.rules_override`) would take it with the delete. The round
    // being paired refuses by name (`FIXTURE_HAS_OWN_FORMAT`, the guard every
    // other delete of unplayed fixtures takes); a round the eager pass only
    // sweeps up is left exactly as found, as for any other tripped guard.
    const own = await firstOwnFormat(tx, tx`id in ${tx(doomed.map((f) => f.id))}`);
    if (own) {
      if (onBlocked === "skip") return { shells: round, delta: NO_SWISS_RESHAPE };
      throw ownFormatLoss(own);
    }
    await tx`delete from fixtures where id in ${tx(doomed.map((f) => f.id))}`;
  }

  // Re-pack: a survivor keeps its id, its slot and its ext_key, and moves to
  // its place in 1..survivors.length — one update per row that moved, before
  // the mint below takes the seats after them.
  const priorSeq = new Map(boardRows.map((f) => [f.id, f.seq_in_round]));
  for (const row of survivors) {
    if (priorSeq.get(row.id) !== row.seq_in_round) {
      await tx`update fixtures set seq_in_round = ${row.seq_in_round} where id = ${row.id}`;
    }
  }

  const kept: SwissExistingFixture[] = [...survivors];
  if (bye && byeRow) {
    // A surviving bye belongs at `boards + 1`. That seat is free either way:
    // the delete above vacated it when the field shrank, and it sits beyond
    // every existing row when the field grew.
    if (byeRow.seq_in_round !== boards + 1) {
      await tx`update fixtures set seq_in_round = ${boards + 1} where id = ${byeRow.id}`;
    }
    kept.push({ ...byeRow, seq_in_round: boards + 1 });
  }

  // `org_id` and `fixture_no` are assigned by BEFORE INSERT triggers, exactly
  // as they are for the shell mint in generateStageFixturesTx.
  const shell = (extKey: string, seqInRound: number) => ({
    id: randomUUID(),
    stage_id: stageId,
    division_id: divisionId,
    round_no: target,
    seq_in_round: seqInRound,
    home_entrant_id: null,
    away_entrant_id: null,
    ext_key: extKey,
    status: "scheduled",
    outcome: null,
  });
  const minted = [] as ReturnType<typeof shell>[];
  // A minted board takes the next index past the highest the round has ever
  // shown (`mintSwissBoardExtKeys`): after a shrink kept b4 over b3, b3 is
  // never reissued beside it, so every key stays unique and stable.
  const keys = mintSwissBoardExtKeys(target, round.map((f) => f.ext_key), Math.max(0, boards - survivors.length));
  for (const [i, key] of keys.entries()) minted.push(shell(key, survivors.length + i + 1));
  if (bye && !byeRow) minted.push(shell(`sw-r${target}-bye`, boards + 1));
  if (minted.length > 0) await tx`insert into fixtures ${tx(minted)}`;

  for (const row of minted) {
    kept.push({
      id: row.id,
      ext_key: row.ext_key,
      round_no: row.round_no,
      seq_in_round: row.seq_in_round,
      status: row.status,
      home_entrant_id: null,
      away_entrant_id: null,
      outcome: null,
      scheduled_at: null,
      court_id: null,
      venue_id: null,
      schedule_locked: false,
    });
  }
  return {
    shells: kept.sort(bySeq),
    delta: {
      matches_added: minted.filter((r) => !isSwissByeShellExtKey(r.ext_key)).length,
      matches_removed: doomed.filter((f) => !isByeShell(f)).length,
      byes_added: minted.filter((r) => isSwissByeShellExtKey(r.ext_key)).length,
      byes_removed: doomed.filter(isByeShell).length,
    },
  };
}