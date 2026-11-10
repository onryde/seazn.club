import "server-only";
// Swiss board seat writes: the online-game and append locks, clearing and
// unseating seats, and un-pairing a round.

import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { EngineError } from "@seazn/engine/core";
import { recomputeStandings } from "@/server/engine-db";
import { ROUND_VOIDED_REASON } from "@/server/email-outbox/cancel";
import { cancelBoardInvites } from "../external-play/cancel-invites";
import { latestSwissRoundWithAnySeat, swissRoundHasPlayedResult } from "@/lib/swiss-shell";
import { ONLINE_GAME_EXISTS_CODE } from "@/lib/open-round";
import type { AuthCtx } from "@/server/api-v1/auth";
import { endCallsOn } from "../match-day-call";
import { afterScheduleWrite, divisionLockState } from "../schedule";
import { SCHEDULE_LOCKED_CODE, SCHEDULE_LOCKED_MESSAGE } from "@/lib/schedule-lock";
import { fixtureEvidenceSql } from "../fixture-results-sql";
import { STAGE_COLS, type Tx, type StageRow, type SwissExistingFixture } from "./types";
import { fireStageRevalidate } from "./helpers";

// `fixtureEvidenceSql` / `fixtureHasResultSql`: ./fixture-results-sql.ts.

/**
 * THE clear-onto-shells write — the one place a seated swiss row is put back
 * to a shell, shared by Unpair and by the pre-Start entrant delete below
 * (2026-09-22), and by Undo of Pair next (W3 T5, X-SW-28: history.ts
 * `stepWrite`, exported for it). Extracted rather than restated so the paths
 * cannot drift into leaving different residue behind. Every caller refuses a
 * round with a result first, under the division lock it already holds.
 *
 * What it deliberately does NOT touch is `scheduled_at` and `court_id`. A
 * shell scheduled ahead of Pair is a shipped feature (`e2e/swiss-shell.spec.ts`
 * pins it), and an organiser's advance court layout must survive both a
 * deliberate Unpair and a player leaving. That is also why the row is UPDATED
 * rather than deleted and re-minted: the fixture id survives with it.
 */
/**
 * The boards a write is about to clear or delete, locked in the ONE order
 * every such write takes — the caller's division advisory lock first, then
 * the fixture rows FOR UPDATE, then their bridge rows FOR UPDATE — and
 * refused 409 ONLINE_GAME_EXISTS when a game stands behind any of them —
 * LIVE or mid-create (final review M-10, brief ruling): a recorded game no
 * read has seen end on a bridge our side has not closed, or T9's
 * `create_sent_at` marker (a create whose outcome is unknown: a game MAY
 * exist). A game that is over (`game_over_at`: one Lichess aborted, say) or a
 * bridge our side closed (`finished`) blocks nothing, and its row goes with
 * the seats. Nothing is written before the refusal, and the caller's
 * transaction rolls back on it. A live game is settled in the arbiter panel
 * (T16), which decides it, so the round stays paired by its own result
 * guards. Pre-review ruling + review M8, 2026-10-10.
 *
 * Why each lock:
 *   - the fixtures FOR UPDATE: a bridge row T9 mints now (guard.ts
 *     `ensureBridgeRow`, a seat-conditional insert under a SHARE lock on the
 *     fixture) waits for this transaction, then finds the seats gone — or
 *     the fixture deleted — and writes nothing;
 *   - every bridge row FOR UPDATE, before the check: a claim or marker
 *     racing this either committed first (and the check below refuses it) or
 *     waits behind this transaction and then updates nothing.
 */
export async function lockBoardsRefusingOnlineGames(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx`select id from fixtures where id in ${tx(ids)} order by id for update`;
  await tx`
    select fixture_id from fixture_external_play
     where fixture_id in ${tx(ids)} order by fixture_id for update`;
  const [game] = await tx<{ fixture_id: string }[]>`
    select fixture_id from fixture_external_play
     where fixture_id in ${tx(ids)}
       and (create_sent_at is not null
            or (challenge_id is not null and game_over_at is null and status <> 'finished'))
     limit 1`;
  if (game) {
    throw new HttpError(
      409,
      "An online game exists on a board this would clear, so it cannot be cleared. Settle that board in the arbiter panel.",
      ONLINE_GAME_EXISTS_CODE,
    );
  }
}

/**
 * W3 T5 fix round 1 (review m1): the append lock of every board a Swiss clear is about to judge — the SAME
 * `fixture:<id>` advisory lock every score append takes (append-event.ts) — in sorted id order, held to commit. Taken
 * AFTER the caller's `division:` lock and BEFORE its "nothing recorded" read: the one lock order (`division:` →
 * stage-seats → `fixture:`, append-event.ts). Scoring serialises on the fixture, never the division, and is not gated
 * on the division's phase, so without it a first event committing between that read and the clear left its events on
 * a seatless shell. With it a scorer in flight either commits first (and the read refuses the clear) or waits and then
 * finds the seats gone (WRONG_PHASE). Sorted, so two clears over overlapping boards take them in one order. Every
 * caller of `clearSwissFixtureSeats` takes it: the pre-Start entrant delete, Unpair and Undo of Pair next.
 */
export async function lockSwissBoardAppends(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  // FMT5 fix round 1 (review m3): ONE round-trip for the lot, in the same sorted order - the keys go in as one sorted array
  // and are locked row by row in its order (`with ordinality`, ordered by it), each the `fixture:<id>` key an append takes.
  // A key already held by a scorer parks the statement there, with every key before it held, as the loop did.
  const keys = [...new Set(ids)].sort().map((id) => "fixture:" + id);
  await tx`
    select count(*)::int from (
      select pg_advisory_xact_lock(hashtext(k.key)) from unnest(${keys}::text[]) with ordinality as k(key, n) order by k.n
    ) locked`;
}

export async function clearSwissFixtureSeats(tx: Tx, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  // Online play (T19, controller rulings Q1 + pre-review 2026-10-10). A
  // board's bridge row records who was INVITED to it, per seat; those seats
  // are about to go, so the row goes with them — a game-less one, or one whose
  // game is over or closed (M-10) — and the re-paired board is invited afresh
  // when the organiser opens the round again. A board a live or mid-create
  // game stands behind refuses the whole clear (lockBoardsRefusingOnlineGames),
  // so past it every row here is one to go.
  await lockBoardsRefusingOnlineGames(tx, ids);
  // Ruling 257 (a live Match Day call is a started board): an emptied board cannot be called, and a call left on it would
  // keep its round "started" — the rounds lock, Finish and the next Pair would all treat it as under way. So the clear ENDS
  // the calls of the boards it empties, the way Undo call does, before the status below is rewritten (a call's liveness reads
  // it). The slot goes back to what it held before the call (the plan, ruling B).
  const restored = await endCallsOn(tx, ids);
  // The void (spec §7, plan T6): the round's invites that are still queued name boards whose seats are about to go, so they end
  // `round_voided` in THIS transaction (an Unpair that is refused above ends nothing). Only after the refusal, and before the bridge
  // rows they are judged by are deleted. A row already `sending` is left to finish; a seat that was never invited has no row.
  await cancelBoardInvites(tx, ids, ROUND_VOIDED_REASON);
  await tx`delete from fixture_external_play where fixture_id in ${tx(ids)}`;
  // W3 T3 (SW-M7): a seated bye froze its cfg at award, so its snapshot goes with its seat — the round's next Pair
  // freezes afresh, under the format that stands then. Only a system bye can reach here holding one: every caller refuses
  // a round with any other evidence first (`fixtureEvidenceSql`, which exempts a system bye's snapshot alone; history's
  // Undo reads it through `fixtureHasResultSql`).
  await tx`
    update fixtures set
      home_entrant_id = null,
      away_entrant_id = null,
      status = 'scheduled',
      outcome = null,
      home_slot_label = null,
      away_slot_label = null,
      config_snapshot = null,
      config_snapshot_at = null
    where id in ${tx(ids)}`;
  // The boards whose slot a call-end put back (`endCallsOn`): their cached public documents need naming after commit.
  return restored;
}

/**
 * Put every swiss round that SEATS `entrantId` back onto its shells, so the
 * caller can then delete the entrant without leaving a half-filled board
 * (2026-09-22 — reported live from production).
 *
 * THE DEFECT. `deleteEntrant` guards only on `division.status !== 'setup'` and
 * runs a bare `delete from entrants`. It never touches `fixtures`; the FK does,
 * `home_entrant_id ... on delete set null` (V214__fixtures.sql:12). Its header
 * comment assumed "none of those rows can exist yet" — and that assumption is
 * the bug, because swiss shells AND swiss pairings both exist before Start
 * while the division is still `setup`. The survivor was a board with ONE null
 * slot beside neighbours that were still fully seated, and that round refused
 * every control the page offers: `reconcileSwissRoundShells` refuses a partly
 * seated round, and Unpair required a wholly seated one so it did not render.
 *
 * WHY UNSEAT THE WHOLE ROUND rather than patch the single board. "Wholly
 * unseated" is the state `reconcileSwissRoundShells` already knows how to
 * resize, so the next Generate reshapes the round for the new field and
 * re-pairs it through the ordinary path — no second mechanism, and no partial
 * round left for the pairer to reason about. Clearing only the damaged board
 * would leave its neighbours holding a pairing computed for a field that no
 * longer exists.
 *
 * SWISS ONLY, and only rounds this entrant actually sat in. Other stage kinds
 * regenerate through `rebuildStageFixtures` and are not this function's
 * business; an entrant seated nowhere costs one query and no writes.
 *
 * GUARDS. This is a destructive write on live rows, so it carries the same two
 * arms the sibling paths do, and NEITHER covers for the other:
 * `swissRoundHasPlayedResult` (status/outcome, evaluated on the round as it
 * stands BEFORE the delete — which matters, because a live bye is exempt only
 * while its seat is still filled) and the canonical `fixtureEvidenceSql`. A
 * round that trips either REFUSES THE DELETE rather than skipping: leaving the
 * entrant in place preserves the recorded data and reproduces no stranding,
 * whereas skipping would delete the player and leave exactly the wreck this
 * function exists to prevent. Refusals reuse `STAGE_NOT_READY` and this file's
 * existing sentences, so no organiser-facing string is introduced.
 */
export async function unseatSwissRoundsSeatingEntrant(
  tx: Tx,
  entrantId: string,
): Promise<number> {
  const rounds = await tx<{ stage_id: string; round_no: number }[]>`
    select distinct f.stage_id, f.round_no
    from fixtures f
    join stages s on s.id = f.stage_id
    where s.kind = 'swiss'
      and (f.home_entrant_id = ${entrantId} or f.away_entrant_id = ${entrantId})
    order by f.stage_id, f.round_no`;
  let cleared = 0;
  for (const { stage_id, round_no } of rounds) {
    const inRound = await tx<SwissExistingFixture[]>`
      select id, ext_key, round_no, seq_in_round, status, home_entrant_id, away_entrant_id, outcome,
             scheduled_at, court_id, venue_id, schedule_locked
      from fixtures where stage_id = ${stage_id} and round_no = ${round_no}`;
    if (swissRoundHasPlayedResult(inRound, round_no)) {
      throw new EngineError(
        "STAGE_NOT_READY",
        "swiss round has played results — delete refused",
        { stageId: stage_id, round: round_no, entrantId },
      );
    }
    const ids = inRound.map((f) => f.id);
    // Review m1 (W3 T5 fix round 1): the boards' append locks before the evidence read below, so a first event in
    // flight is either seen by it or finds the seats gone.
    await lockSwissBoardAppends(tx, ids);
    const [blocked] = await tx<{ id: string }[]>`
      select f.id from fixtures f
      where f.id in ${tx(ids)} and (${fixtureEvidenceSql(tx)})
      limit 1`;
    if (blocked) {
      throw new EngineError(
        "STAGE_NOT_READY",
        "swiss round has recorded match data — delete refused",
        { stageId: stage_id, round: round_no, entrantId, fixtureId: blocked.id },
      );
    }
    await clearSwissFixtureSeats(tx, ids);
    cleared += ids.length;
  }
  return cleared;
}

/** Clear the latest seated Swiss round back onto its shells (2026-09-18). */
export async function unpairSwissRound(
  auth: AuthCtx,
  stageId: string,
): Promise<{ cleared: number; round: number }> {
  const write = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<StageRow[]>`
      select ${tx(STAGE_COLS)} from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    if (stage.kind !== "swiss") {
      throw new HttpError(422, "unpair only exists on swiss stages");
    }
    const lockState = await divisionLockState(tx, stage.division_id);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;

    const existing = await tx<SwissExistingFixture[]>`
      select id, ext_key, round_no, seq_in_round, status, home_entrant_id, away_entrant_id, outcome,
             scheduled_at, court_id, venue_id, schedule_locked
      from fixtures where stage_id = ${stageId}`;

    // PARTLY seated counts (2026-09-22). This used to ask for a WHOLLY seated
    // round, which is precisely why an organiser whose pre-Start delete left
    // one null slot had no way out: the reconcile refused the round and the
    // only control that could have cleared it answered "no seated swiss round
    // to unpair" — and did not even render, since `canUnpairSwiss` in
    // `stages-panel.tsx` reads the SAME predicate. The two must agree or the
    // page shows a button that 500s.
    //
    // Widening the TARGET is not widening the permission: the two guards below
    // are untouched and still decide whether this round may be cleared.
    const round = latestSwissRoundWithAnySeat(existing);
    if (round === null) {
      throw new EngineError("STAGE_NOT_READY", "no seated swiss round to unpair", { stageId });
    }
    if (swissRoundHasPlayedResult(existing, round)) {
      throw new EngineError(
        "STAGE_NOT_READY",
        "swiss round has played results — unpair refused",
        { stageId, round },
      );
    }

    const inRound = existing.filter((f) => f.round_no === round);

    // C1 (2026-09-20 review). This check runs over EVERY row in the round —
    // it used to run over a "non-bye" subset computed by a predicate that
    // called any award outcome a bye, so a played board carrying a real
    // forfeit or retirement was excluded from the one guard that could still
    // have caught it after the status guard above had also been fooled.
    // Nothing is exempt here: a genuine bye never goes through appendEvent,
    // so it has no events and no state, and the exemption belongs in the
    // STATUS test above where `forfeited` would otherwise block every
    // odd-field round. Its frozen cfg (W3 T3: the bye freezes at award) is
    // the one thing it holds, and `fixtureEvidenceSql` exempts it by name
    // (`systemByeSql`), so this guard reads the bye exactly as before.
    const ids = inRound.map((f) => f.id);
    // Review m1 (W3 T5 fix round 1): the boards' append locks before the evidence read below, so a first event in
    // flight is either seen by it or finds the seats gone.
    await lockSwissBoardAppends(tx, ids);
    const [blocked] = await tx<{ id: string }[]>`
      select f.id from fixtures f
      where f.id in ${tx(ids)} and (${fixtureEvidenceSql(tx)})
      limit 1`;
    if (blocked) {
      throw new EngineError(
        "STAGE_NOT_READY",
        "swiss round has recorded match data — unpair refused",
        { stageId, round, fixtureId: blocked.id },
      );
    }

    const restored = await clearSwissFixtureSeats(tx, ids);

    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${stage.division_id}`;
    return {
      cleared: ids.length,
      round,
      divisionId: stage.division_id,
      competitionId: division!.competition_id,
      restored,
    };
  });

  // Bye awards (and their removal) never go through appendEvent, so the
  // standings snapshot would otherwise keep the unpaired bye's points until
  // the next scored match — Dan after Unpair R3. Fold from the cleared rows.
  // `"drop"` (W2d concern 2, review m5): unpairing round 1 leaves the shells
  // seating nobody — a fold with no row, so the stored table goes too and the
  // page reads as it did after the mint ("No standings yet"), not a header-only
  // table.
  await recomputeStandings(auth.orgId, stageId, undefined, { emptyFold: "drop" });

  await fireStageRevalidate(auth.orgId, stageId);
  // Ruling 257: a call ended on an emptied board put the board back on its pre-call court and time - name those, so the
  // public fixture document (`pub:v1:fixture:{id}`) does not serve the called slot for its 30s TTL.
  afterScheduleWrite(write.divisionId, write.competitionId, "schedule", write.restored);
  return { cleared: write.cleared, round: write.round };
}