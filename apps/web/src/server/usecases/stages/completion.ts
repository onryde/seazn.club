import "server-only";
// Guarded completion (and what it progresses into), standings reads, manual
// rank overrides.

import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import { knockoutRefusal } from "../knockout-refusal";
import { EngineError } from "@seazn/engine/core";
import type { ProgressionSpec } from "@seazn/engine/competition";
import { completeStageIfReady, recomputeStandings, type CompleteResult } from "@/server/engine-db";
import { completionEngineStatus, hasActiveAbandonSql } from "@/server/engine-db/recorded-abandon";
import { isByeLine, type ByeLineRow } from "@/lib/bye-line";
import type { AuthCtx } from "@/server/api-v1/auth";
import { log } from "@/server/logger";
import { afterScheduleWrite } from "../schedule";
import { SCHEDULE_LOCKED_CODE } from "@/lib/schedule-lock";
import { BRACKET_KINDS, type Tx } from "./types";
import { fireStageRevalidate } from "./helpers";
import { seedNextStage, type SeededStage } from "./carry-over";
import { generateStageFixturesUnpublished } from "./generate";
import { computeSeedProposal } from "./seed-proposal";
import { markDependentSeedProposalsStale } from "./seed-stale";
import { TABLE_CUT_DRIFT_KINDS } from "@/lib/table-cut-drift";
import { isFirstLossProgression, maybeProposePlate } from "../plate-field";
import { onlyPoolOf } from "../stage-table-snapshot";
import { RANK_OVERRIDE_TABLE_KINDS, planRankOverride } from "@/lib/rank-override";
import { readStagePins, readStageSeating } from "../rank-override";
import { inTheField } from "@/lib/entrant-field";
import { roundRobinRefusal } from "../roundrobin-refusal";
import { isRoundRobinRefusalCode } from "@/lib/roundrobin-refusals";

/**
 * W4 T6 (AN-2; the app half of engine row X-CH-7): the lines of a BRACKET stage still owed a result, in bracket order
 * (round, then position) — `[]` for any other kind, an unknown stage, or a bracket with nothing owed.
 *
 * Owed means pending as stage completion reads it (`completionEngineStatus`: scheduled or in play, a recorded abandon
 * held for the organiser's settle included; a cancelled line, a cascade void and a settled abandon are not). Two pending
 * shapes are NOT owed, because nobody can ever play them:
 *  - a bye line (`isByeLine`) — a seat padded out or left dead by a departure, e.g. a third-place line whose BOTH semi
 *    losers have left (withdrawal-w2b's R-1 consequence: the stage completes on its final);
 *  - a double-elimination reset (`conditional`) that the grand final did not trigger: owed only when the grand final's
 *    winner is not its home entrant, the winners' champion (champion.ts `bracketTitleOf`, the engine harness's rule).
 *    Until that grand final has a winner it is not owed either; the grand final itself is.
 * App PR B aliases the engine's same-named export against this one (controller ruling R15).
 */
export async function undecidedBracketFixtures(tx: Tx, stageId: string): Promise<string[]> {
  const [stage] = await tx<{ kind: string }[]>`select kind from stages where id = ${stageId}`;
  if (stage === undefined || !BRACKET_KINDS.has(stage.kind)) return [];
  const rows = await tx<
    (ByeLineRow & {
      id: string;
      round_no: number;
      is_final: boolean;
      third_place: boolean;
      conditional: boolean;
      has_active_abandon: boolean;
      expunged: boolean;
      no_result: boolean;
    })[]
  >`
    select f.id, f.round_no, f.ext_key, f.status, f.outcome, f.home_entrant_id, f.away_entrant_id,
           f.home_slot_label, f.away_slot_label, f.is_final, f.third_place, f.conditional,
           ${hasActiveAbandonSql(tx)} as has_active_abandon,
           ${hasActiveAbandonSql(tx, "f", { expunge: true })} as expunged,
           ${hasActiveAbandonSql(tx, "f", { noResult: true })} as no_result
      from fixtures f
     where f.stage_id = ${stageId}
     order by f.round_no, f.seq_in_round, f.id`;
  const status = (r: (typeof rows)[number]) => completionEngineStatus(stage.kind, r);
  const winnerOf = (r: (typeof rows)[number]): string | null =>
    status(r) === "decided" || status(r) === "walkover" ? ((r.outcome as { winner?: string } | null)?.winner ?? null) : null;
  // The grand final a reset follows: the latest earlier final, not itself conditional, not a bronze match.
  const resetOwed = (reset: (typeof rows)[number]): boolean => {
    const gf = rows
      .filter((r) => r.is_final && !r.conditional && !r.third_place && r.round_no < reset.round_no)
      .sort((a, b) => b.round_no - a.round_no)[0];
    const winner = gf === undefined ? null : winnerOf(gf);
    return gf !== undefined && winner !== null && winner !== gf.home_entrant_id;
  };
  return rows
    .filter((r) => {
      const s = status(r);
      if (s !== "scheduled" && s !== "in_play") return false;
      if (isByeLine(r)) return false;
      if (r.conditional && !resetOwed(r)) return false;
      return true;
    })
    .map((r) => r.id);
}

export interface CompleteStageResult extends CompleteResult {
  /** Set when completion resolved the next stage's progression (a
   *  `timing: "on_complete"` progression — the OLD `stages.qualification`
   *  auto-seed flow). */
  qualified?: SeededStage;
  /** Fixtures auto-generated for the seeded next stage. */
  next_stage_fixtures?: number;
  /** True when this was the last stage — the division is now completed. */
  division_completed?: boolean;
  /** D4a (P5) — set when completion computed a draft seed proposal for a
   *  `timing: "setup"` next stage's progression. Propose + confirm, never
   *  fully automatic (owner ruling): unlike `qualified` above, this never
   *  fills anything by itself. */
  seed_proposal?: { id: string; status: string } | null;
}

/**
 * Guarded progression (doc 08 §3): no-op unless the completion predicate
 * holds. On completion:
 *  - a `timing: "setup"` next stage (D4a/P5) gets a DRAFT seed proposal
 *    computed (never auto-filled — propose + confirm); its fixtures already
 *    exist as TBD placeholders, generated at division setup time.
 *  - a `timing: "on_complete"` next stage (the OLDER `.qualification`
 *    mechanism) keeps its existing auto-seed-then-generate behaviour,
 *    idempotent — an already-seeded stage is not re-seeded.
 *
 * `publish` (R10f; on by default since R10g): once the stage is complete,
 * the call publishes the hub key ONCE after everything it did, the next
 * stage's draw included, however it ends (the `finally` below). A caller that
 * publishes the whole write itself opts out with `{ publish: false }`, and
 * today only scoring's auto-advance does. On by default because a redundant
 * publish costs one hub refetch, while a missed one leaves every subscribed
 * hub stale with every test still green.
 */
export async function completeStage(
  auth: AuthCtx,
  stageId: string,
  opts: { publish?: boolean } = {},
): Promise<CompleteStageResult> {
  const current = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<{ division_id: string; seq: number; competition_id: string }[]>`
      select s.division_id, s.seq, d.competition_id
      from stages s join divisions d on d.id = s.division_id
      where s.id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    return stage;
  });
  // W4 T6 (AN-2): asked under the division lock, in the completion's own transaction, at exactly the point the engine
  // says a bracket is complete (every final settled) — so a final not yet settled keeps the soft `{completed: false}`
  // (controller ruling C4), and a bracket with a third-place line, or any other line, still owed a result is refused by
  // name instead of completing around it.
  let result = await completeStageIfReady(auth.orgId, stageId, {
    beforeBracketComplete: async (tx) => {
      const owed = await undecidedBracketFixtures(tx, stageId);
      if (owed.length > 0) throw knockoutRefusal("STAGE_HAS_UNDECIDED_FIXTURES", { fixture_ids: owed });
    },
  });
  if (result.already_complete === true) {
    // W5 T17 (X-BD-4 <- RB5-S4): a second Complete says so and does nothing more - no proposal computed or staled, no
    // draw, no division completion, no publish (nothing was written, so there is nothing for a hub to refetch).
    if (!(await nextStageOwesItsDraw(auth, current))) return alreadyCompleteAnswer(auth, current);
    // The one thing a repeat still owes (R10h, schedule-slot-writes-cache-keys.test.ts): a draw the division's FREEZE
    // refused at the first Complete. Falls through to the progression below, which draws it; the answer is what it was.
    result = { completed: result.completed, events: result.events };
  }
  if (!result.completed) return result;

  // R10g (review-r10f m2): from here the stage is complete (its completion
  // committed), and the hub shows stage and division status (its standings
  // tables order by stage status). So every way out of this call publishes
  // the hub key once, after all of it: a draw, a seed proposal, the division
  // completing, nothing drawn at all (the last stage, or a freeze refusing
  // the draw), or a later step throwing after the completion stood. The one
  // publish covers the draw too (its fixture ids are all new, so no fixture
  // key is owed), which is why the next stage is drawn unpublished. A refused
  // completion (not ready, or a 404 / engine error before the commit) has
  // already returned or thrown above, and sends nothing.
  try {
    return await progressCompletedStage(auth, stageId, current, result);
  } finally {
    if (opts.publish ?? true) {
      afterScheduleWrite(current.division_id, current.competition_id, "schedule", []);
    }
  }
}

/** W5 T17: the stage after `current` still has its draw to take - an `on_complete` progression with no fixtures. A first
 *  Complete that the division's schedule freeze refused the draw leaves exactly this (the completion committed, the
 *  generation was skipped), and a repeat after the freeze lifts is that draw's retry (R10h). A `setup` progression is never
 *  owed one: its proposals are the organiser's (Recompute is the explicit door), and its bracket is drawn on day one. */
async function nextStageOwesItsDraw(auth: AuthCtx, current: { division_id: string; seq: number }): Promise<boolean> {
  return withTenant(auth.orgId, async (tx) => {
    const [next] = await tx<{ id: string; progression: { timing?: string } | null }[]>`
      select id, progression from stages
      where division_id = ${current.division_id} and seq > ${current.seq}
      order by seq limit 1`;
    if (next === undefined || next.progression?.timing !== "on_complete") return false;
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${next.id}`;
    return n === 0;
  });
}

/** W5 T17: the answer of a Complete on a stage that is already complete and owes nothing: `completed: false` (this call
 *  completed nothing), `already_complete: true`, and the next stage's live DRAFT proposal when it has one (null for a
 *  confirmed or stale latest row, or none - the draft is the only one an organiser still has to act on). One read. */
async function alreadyCompleteAnswer(auth: AuthCtx, current: { division_id: string; seq: number }): Promise<CompleteStageResult> {
  const draft = await withTenant(auth.orgId, async (tx) => {
    const [next] = await tx<{ id: string }[]>`
      select id from stages where division_id = ${current.division_id} and seq > ${current.seq} order by seq limit 1`;
    if (next === undefined) return null;
    const [latest] = await tx<{ id: string; status: string }[]>`
      select id, status from stage_seed_proposals where stage_id = ${next.id} order by created_at desc, id desc limit 1`;
    return latest !== undefined && latest.status === "draft" ? { id: latest.id, status: latest.status } : null;
  });
  return { completed: false, already_complete: true, events: [], seed_proposal: draft };
}

/** What a complete stage does next (see `completeStage`): seed and draw the
 *  next stage, compute its seed proposal, or complete the division. It
 *  publishes nothing itself. */
async function progressCompletedStage(
  auth: AuthCtx,
  stageId: string,
  current: { division_id: string; seq: number },
  result: CompleteResult,
): Promise<CompleteStageResult> {
  const next = await withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ id: string; progression: Record<string, unknown> | null }[]>`
      select id, progression from stages
      where division_id = ${current.division_id} and seq > ${current.seq}
      order by seq limit 1`;
    return row ?? null;
  });
  const nextProgression = next?.progression as (ProgressionSpec & { timing: "setup" | "on_complete" }) | null | undefined;

  await fireStageRevalidate(auth.orgId, stageId);

  // W4 T8 (X-PL-5): a plate is proposed after round two, so by the time its source completes it has been proposed (or has completed
  // by name, X-PL-2). Asked again here and nothing more: a `computeSeedProposal` over a confirmed plate would 409 the completion
  // (`SEEDING_ALREADY_CONFIRMED`), and the stage's own completion is the last chance for a field that only became known now.
  // Then on to the division's completion below: a plate already complete leaves nothing open.
  const plateNext = nextProgression?.timing === "setup" && isFirstLossProgression(nextProgression);
  if (plateNext) {
    // The completion above has ALREADY committed: a failure of the plate's trigger is said aloud, never reported as a failed
    // completion (the sibling branch's F3 finding-4 rule). It is proposed again by the next decided result in the source or a
    // withdrawal (both call the trigger), or by the organiser's Recompute: POST /stages/{id}/seed-proposal on the plate reaches
    // `computeSeedProposal`, which draws a firstLosses plate's lines at its field's size (seed-proposal.ts, `firstLossPlate`).
    // (Whether the desk offers that button on a plate with no proposal is not read here: the route is.)
    try {
      await maybeProposePlate(auth, stageId);
    } catch (err) {
      log.warn({ event: "plate_trigger_failed_at_completion", stageId, nextStageId: next!.id, err: String(err) }, "plate_trigger_failed_at_completion");
    }
  }

  if (nextProgression?.timing === "setup" && !plateNext) {
    // Best-effort, same spirit as the on_complete path's generation step
    // below: completion stands even if the proposal compute trips (e.g. the
    // source stage this points at isn't THIS one and isn't ready yet).
    // Narrowed the same INTENT as the on_complete branch just below (A4,
    // round-4 review): this used to be a bare `catch { return result }`, no
    // narrowing, no logging, despite this comment already claiming
    // "best-effort, same spirit" — so a genuine progression-config bug (e.g.
    // A1's SEEDING_BESTNTH_UNEQUAL_POOLS, or QUALIFICATION_INVALID) reached
    // an organiser as "nothing happened": the stage completed, no
    // seed_proposal, no error anywhere.
    //
    // The exact TYPE this checks differs from the on_complete sibling below
    // on purpose, not by oversight: that branch's own completeness gate
    // (seedNextStage, this file) throws EngineError STAGE_NOT_READY
    // directly, but THIS path's completeness gate is computeSeedProposal ->
    // sourcesToTables (stage-seeding.ts), which throws HttpError 409
    // SEEDING_SOURCE_INCOMPLETE instead — confirmed by a real red test
    // (progression-multi-source.test.ts) that first tried mirroring the
    // sibling's EngineError check verbatim and broke the legitimate
    // "another named source isn't complete yet" case, which is exactly the
    // regression this fix must not introduce. By the time resolveProgression
    // runs in this path, sourcesToTables has already gated every source on
    // DB-status "complete", so an EngineError STAGE_NOT_READY reaching this
    // catch (e.g. rowAtRank's "not enough entrants ranked yet") is a genuine
    // misconfiguration, not a "wait for it" case, and must propagate — same
    // as QUALIFICATION_INVALID does.
    try {
      const proposal = await computeSeedProposal(auth, next!.id);
      return { ...result, seed_proposal: { id: proposal.id, status: proposal.status } };
    } catch (err) {
      // F3 ultrareview finding 4 — this stage's completion committed in its
      // OWN transaction, several statements ago. A bare re-throw therefore
      // reached the organiser as a plain failure for an action that actually
      // SUCCEEDED: the board still showed the stage as active (the client's
      // catch has nothing to refresh on an error), so the next click hit an
      // already-complete stage. Re-throwing is still right — A4 above added
      // it precisely so a genuine progression misconfiguration stops being
      // silent — but it has to say WHICH half failed. Wrapped in a code the
      // panel classifies into "completed, but the next stage's seeding
      // couldn't be prepared", so the organiser gets the real reason AND a
      // refreshed board.
      if (
        !(err instanceof HttpError && err.code === "SEEDING_SOURCE_INCOMPLETE") &&
        !(err instanceof HttpError && err.code === "STAGE_COMPLETED_SEEDING_FAILED")
      ) {
        log.warn(
          { event: "seed_proposal_compute_failed", stageId, nextStageId: next!.id, err: String(err) },
          "stage completed, but computing the next stage's seed proposal failed",
        );
        // B4 fix wave (12b m1): a round-robin refusal (RR_CUT_EXCEEDS_FIELD) rides inside the wrap by name with its own fields, so the
        // desk says that sentence in the reader's language instead of the server's English reason.
        const cause = err instanceof HttpError && err.code !== undefined && isRoundRobinRefusalCode(err.code) ? { ...err.extra, cause: err.code } : {};
        throw new HttpError(
          409,
          err instanceof Error ? err.message : String(err),
          "STAGE_COMPLETED_SEEDING_FAILED",
          { ...cause, stageId, nextStageId: next!.id },
        );
      }
      if (!(err instanceof HttpError && err.code === "SEEDING_SOURCE_INCOMPLETE")) throw err;
      log.warn(
        { event: "seed_proposal_compute_skipped", stageId, nextStageId: next!.id, err: String(err) },
        "seed proposal compute skipped: a named progression source is not ready yet",
      );
      return result;
    }
  }

  let qualified: SeededStage | null = null;
  if (nextProgression?.timing === "on_complete") {
    try {
      qualified = await seedNextStage(auth, stageId);
    } catch (err) {
      // Best-effort ONLY for "a named source isn't complete yet"
      // (STAGE_NOT_READY) — same spirit as the setup-timing branch above:
      // Decision 4's multi-source progressions can legitimately have OTHER
      // named sources still incomplete when THIS stage completes, and
      // completeStageIfReady already committed this stage's own completion
      // above, so a downstream seed attempt tripping on that must not read
      // back to the caller as "the completion failed" (F2 Task 6 review,
      // finding 1 — this call had NO catch at all, while the comment a few
      // lines below already, wrongly, claimed one existed). Every OTHER
      // EngineError still propagates — QUALIFICATION_INVALID in particular
      // is a genuine progression-config bug (an entrant qualifying through
      // two sources), and progression-multi-source.test.ts's "rejects an
      // entrant qualifying through two sources" case depends on that NOT
      // being swallowed here.
      if (!EngineError.is(err, "STAGE_NOT_READY")) throw err;
      qualified = null;
    }
  }
  if (!qualified) {
    // No stage follows: the division itself is done (doc 02 lifecycle
    // setup → active → completed). Idempotent — re-completing is a no-op.
    const divisionCompleted = await withTenant(auth.orgId, async (tx) => {
      const [stage] = await tx<{ division_id: string }[]>`
        select division_id from stages where id = ${stageId}`;
      if (!stage) return false;
      await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
      const [remaining] = await tx`
        select 1 from stages
        where division_id = ${stage.division_id} and status <> 'complete' limit 1`;
      if (remaining) return false;
      const [row] = await tx<{ id: string }[]>`
        update divisions set status = 'completed'
        where id = ${stage.division_id} and status <> 'completed'
        returning id`;
      if (!row) return false;
      const [{ seq: last }] = await tx<{ seq: number }[]>`
        select coalesce(max(seq), 0)::int as seq from division_events
        where division_id = ${stage.division_id}`;
      await tx`
        insert into division_events (division_id, seq, type, payload)
        values (${stage.division_id}, ${last + 1}, 'division_completed',
                ${tx.json({ lastStageId: stageId } as never)})`;
      await tx`update divisions set seq = ${last + 1} where id = ${stage.division_id}`;
      return true;
    });
    return divisionCompleted ? { ...result, division_completed: true } : result;
  }
  // Best-effort: completion stands even if generation trips (e.g. paywall, or
  // — since the freeze guard at the top of `generateStageFixtures` — a frozen
  // division refusing the write). The completion above has ALREADY committed;
  // undoing it because the next stage could not be drawn would be worse than
  // leaving that stage empty, and refusing the completion itself would make
  // the freeze bind a lifecycle TRANSITION, which is exactly the line
  // `startDivision` was built to hold (see schedule-start-gate.test.ts).
  //
  // WHY THIS STILL SWALLOWS EVERYTHING. Narrowing it to re-throw non-freeze
  // faults is not a free change: the paywall case this comment has always
  // named reaches here as a `PaymentRequiredError` (402), and an incomplete
  // multi-source progression reaches it as `STAGE_NOT_READY` — both are
  // legitimate, expected trips that must not fail a committed completion.
  // Deciding which of the remaining causes SHOULD fail it is a product call,
  // not a guard's to make, so the shape is deliberately unchanged.
  //
  // WHAT DID CHANGE: it no longer swallows SILENTLY. This was a bare
  // `catch { generated = undefined; }` that logged nothing at all, so a real
  // generator fault — a bad bracket, a DB error — was exactly as invisible as
  // a freeze refusal, and an organiser's next stage stayed empty with no
  // record anywhere of why. The freeze did not create that hole; it revealed
  // it. So the record NAMES the error, and flags the freeze case specifically
  // (`locked`) so the two can be told apart without parsing prose.
  //
  // WHO PUBLISHES THE DRAW (R10f, R10g): `completeStage` does, once, in its
  // `finally` after this returns, unless its caller opted out. So the draw
  // goes through the unpublished generate: publishing here as well would
  // cost the hub a second refetch. Scoring's auto-advance opts out
  // (`{ publish: false }`) because it runs inside a decided fixture's
  // post-commit hooks (`onDecided`). Reached from `scoreEvent`, that write's
  // `finally` already drops the same hub key and pushes the division once
  // the hooks are done. Reached from the batch importer (`event-import.ts`),
  // its `finally` DELs the hub key but sends no push, by design (a backfill
  // of finished results, not a live pad).
  let generated: number | undefined;
  try {
    generated = (await generateStageFixturesUnpublished(auth, qualified.stage_id)).created;
  } catch (err) {
    const code = err instanceof HttpError ? err.code : undefined;
    const locked = code === SCHEDULE_LOCKED_CODE;
    log.warn(
      {
        event: "next_stage_generate_skipped",
        stageId,
        nextStageId: qualified.stage_id,
        locked,
        code,
        status: err instanceof HttpError ? err.status : undefined,
        err: String(err),
      },
      locked
        ? "next stage not generated: the division schedule is locked"
        : "next stage not generated: the generator failed",
    );
    generated = undefined;
  }
  return { ...result, qualified, ...(generated !== undefined ? { next_stage_fixtures: generated } : {}) };
}

export interface StandingsOut {
  stage_id: string;
  pool_id: string | null;
  rows: unknown[];
  /** The stored snapshot's int8 watermark as postgres.js serves a bigint (a decimal string); 0 for a table folded on the
   *  read. The wire documents the same (`StandingsSnapshot`). */
  computed_through_seq: string | 0;
  updated_at: string | null;
}

/** Standings snapshot for a stage (recomputed on demand when absent). */
export async function getStandings(auth: AuthCtx, stageId: string, requestedPoolId?: string): Promise<StandingsOut> {
  let poolId = requestedPoolId;
  const snapshot = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx`select 1 from stages where id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    // W5 T3 (X-BD-7): asked for no pool, a stage with ONE pool answers that pool's table (a group of one is a league to a caller
    // that never heard of pools); a stage with none, or several, has no pool to default to and answers as before.
    if (poolId === undefined) poolId = (await onlyPoolOf(tx, stageId)) ?? undefined;
    const [snap] = await tx<StandingsOut[]>`
      select stage_id, pool_id, rows, computed_through_seq, updated_at
      from standings_snapshots
      where stage_id = ${stageId} and pool_id is not distinct from ${poolId ?? null}`;
    return snap ?? null;
  });
  if (snapshot) return snapshot;
  const rows = await recomputeStandings(auth.orgId, stageId, poolId);
  return {
    stage_id: stageId,
    pool_id: poolId ?? null,
    rows: rows as unknown[],
    computed_through_seq: 0,
    updated_at: null,
  };
}

// ---------------------------------------------------------------------------
// Manual rank override (Jul3/05 §4) — placement games decide final positions
// without faking points. Stored on stages.config.rank_overrides; the fold's
// rank pass pins them (applyRankLocks) on every recompute.
// ---------------------------------------------------------------------------

export async function overrideStandings(
  auth: AuthCtx,
  stageId: string,
  input: { rows: { entrant_id: string; rank: number; reason: string }[] },
): Promise<{ overridden: number }> {
  await requireFeature(auth.orgId, "tiebreakers.custom");
  const seen: { stage?: { division_id: string; competition_id: string; kind: string; status: string } } = {};
  const out = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<{ division_id: string; competition_id: string; kind: string; status: string; config: Record<string, unknown> }[]>`
      select s.division_id, d.competition_id, s.kind, s.status, s.config
        from stages s join divisions d on d.id = s.division_id where s.id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    seen.stage = stage;
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
    // W5 T13 (X-PO-4 <- RB5-P7, ruling 288): a stage with no table has no place to pin an entrant in.
    if (!RANK_OVERRIDE_TABLE_KINDS.has(stage.kind)) throw roundRobinRefusal("RR_RANK_OVERRIDE_NOT_TABLE", { kind: stage.kind });
    const ids = input.rows.map((r) => r.entrant_id);
    const known = await tx<{ id: string; status: string }[]>`
      select id, status from entrants where id in ${tx(ids)} and division_id = ${stage.division_id}`;
    if (known.length !== ids.length) {
      throw new HttpError(422, "override references an entrant outside this division");
    }
    // W5 T13 fix round 1 (X-PO-3): an OPEN table takes no pin for an entrant who has left it - a departure drops her pins, so one written
    // after it would sit there ranking her above the field. A finished table stands as it finished (RB5-L8) and keeps what it is given.
    if (stage.status !== "complete" && known.some((e) => !inTheField(e))) {
      throw new HttpError(422, "override references an entrant who is no longer in the field");
    }
    // W5 T13 (X-PO-3 <- RB5-P5, ST-G14): the body is checked PER POOL, against the pool's size, here - the engine would throw a rank above
    // it at the next recompute, after the write. A second override replaces only the pools it names.
    const seating = await readStageSeating(tx, stageId);
    const plan = planRankOverride(await readStagePins(tx, stageId), input.rows, seating);
    if (!plan.ok) {
      if (plan.reason === "unseated") throw new HttpError(422, "override references an entrant with no place in this stage's table");
      if (plan.reason === "undrawn_pools") throw roundRobinRefusal("RR_RANK_OVERRIDE_UNDRAWN_POOLS");
      throw roundRobinRefusal("RR_RANK_OVERRIDE_POOL", {
        reason: plan.reason,
        rank: plan.rank,
        pool_id: plan.pool_id,
        ...(plan.reason === "above_size" ? { size: plan.size } : {}),
      });
    }

    // Server-side merge (design §T2). `stage.config` was read BEFORE the
    // advisory lock above, so a writer that committed while this transaction
    // waited is already invisible to it; spreading that stale object back
    // reverts the other writer's key with no error.
    await tx`
      update stages set config = config || ${tx.json({ rank_overrides: plan.pins } as never)}
      where id = ${stageId}`;

    // audit (actor + reason, hash-chained per the 011 pattern)
    const [{ seq: last }] = await tx<{ seq: number }[]>`
      select coalesce(max(seq), 0)::int as seq from division_events
      where division_id = ${stage.division_id}`;
    await tx`
      insert into division_events (division_id, seq, type, payload, actor_id)
      values (${stage.division_id}, ${last + 1}, 'rank_overridden',
              ${tx.json({ stage_id: stageId, rows: input.rows } as never)}, ${auth.userId})`;
    await tx`update divisions set seq = ${last + 1} where id = ${stage.division_id}`;
    return { overridden: input.rows.length };
  });
  // pinned ranks land in the snapshots immediately
  await recomputeStandings(auth.orgId, stageId);
  // B4 fix wave (m3): and on the public pages - the division and competition tags a result write clears (the pool winners banner and
  // the table read the recomputed snapshots). Best-effort: the pin is written.
  // B5 fix wave G3 (m1): the Redis copies too - the hub document the hub poll reads (15 s) and the division's public documents the
  // standings API serves (`standings-v3`, 30 s), or the poll paints the old order back over the fresh page. `afterScheduleWrite` is
  // the one helper that DELs both and fires the same tags (no fixture moved: no fixture key, no fixture push).
  const pinned = seen.stage;
  if (pinned !== undefined) afterScheduleWrite(pinned.division_id, pinned.competition_id, "schedule", []);
  else await fireStageRevalidate(auth.orgId, stageId);
  // D4a (P5): a correction here invalidates any dependent `timing:"setup"`
  // stage's draft proposal — mark it stale and recompute a fresh one.
  //
  // W5 T11 (X-CUT-4 <- RB5-K6): pinning a place inside a COMPLETED league or group moves its cut like a corrected result does, so
  // a confirmed proposal goes stale too and its seats go back before the destination starts. Best-effort: the pin is written.
  const complete = seen.stage;
  if (complete !== undefined && complete.status === "complete" && TABLE_CUT_DRIFT_KINDS.has(complete.kind)) {
    try {
      const unfilled = await markDependentSeedProposalsStale(auth, stageId, { includeConfirmed: true });
      if (unfilled.length > 0) afterScheduleWrite(complete.division_id, complete.competition_id, "schedule", unfilled);
    } catch (err) {
      log.error({ err, stageId }, "overrideStandings: a pinned table's proposals did not update (the pin is written)");
    }
  } else {
    await markDependentSeedProposalsStale(auth, stageId);
  }
  return out;
}