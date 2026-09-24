import "server-only";
// #350 Multi-division joint AI scheduling — Phase C, the ATOMIC APPLY.
//
// THE ONE THING THIS MODULE EXISTS FOR: one transaction writes every selected
// division's board, or none of it (spec §8).
//
// Nothing else in this product spans divisions. `applySchedule`
// (schedule.ts:478) takes ONE division advisory lock, asserts ONE division's
// seq and bumps ONE division's seq, and the board applies a multi-stage plan by
// calling that endpoint in a loop — so a stale token, a frozen division or a
// blocking conflict discovered on the fifth call leaves the first four
// committed and the organiser holding half a schedule with no undo that spans
// the rest. A joint plan is solved as one board; it has to land as one board.
//
// Three consequences of "one transaction" that are easy to get subtly wrong:
//
//   * LOCK ORDER IS A DEADLOCK GUARD. Holding N advisory locks means two
//     concurrent joint applies over overlapping division sets deadlock unless
//     both acquire in the same order. `lockOrder` sorts on the division UUID,
//     and that is the ONE place in #350 where sorting on a UUID is correct: it
//     is an input discipline over lock acquisition, not an output ordering.
//     Every array this module RETURNS still sorts on domain keys.
//
//   * THE SEQ ASSERTION SITS IN THE WRITE LOOP, not in a pre-pass. Moving it
//     earlier would be harmless in production — the locks are already held, so
//     no seq can move underneath us — but it would make the rollback
//     acceptance test pass for the wrong reason: an implementation that checks
//     every precondition before writing anything looks atomic without being
//     atomic. Interleaved, the only thing that can keep the first division's
//     rows unchanged after the second division's token is rejected is the
//     transaction itself.
//
//   * EXACTLY ONE `schedule.applied_multi` ROW PER TRANSACTION.
//     `lastCompetitionAiApply` orders by (created_at desc, id desc);
//     competition_events.id is a random uuid and `now()` is transaction-start
//     time, so two rows written in one transaction tie on created_at and the
//     tie-break becomes a coin flip rather than "latest". One writer, always.
//
// VERIFICATION IS THE JOINT ONE, not N single-division ones. A cross-division
// court clash is invisible to a per-division pass — the other division's
// fixtures are not on its board — so a loop of `applySchedule` calls will
// happily double-book a court and report success. This module runs the
// `verifyJoint` shape (one `validateAssignments` pass per division, with that
// division's OWN config, over the MERGED board) and reuses `verifyConfigFor`
// verbatim so plan time and apply time cannot disagree about what is legal
// (ruling R11).
//
// It is NOT a call to `verifyJoint` itself, and the reason is data, not taste:
// `verifyJoint` reads a `CompetitionPack`, whose obstacles carry no entrants
// and no people, and building one here would mean re-running the greedy draft
// solver inside an advisory-locked transaction (its own `withTenant` would take
// a second connection and block for ever on the locks this one holds). The
// board this module assembles is richer than a pack's — every untouched and
// sibling fixture arrives through `toAssignment` with its people attached,
// exactly as `applySchedule` builds them — so apply-time verification sees
// strictly more than plan-time did.
//
// For a COMPLETE apply — every movable fixture the plan covered is listed — the
// extra that richer board can find is rest and person-overlap. A PARTIAL apply
// is a different case and the claim must not be
// stretched over it: the board's `excludedFixtureIds` path (`ai-apply.ts:201`)
// leaves the excluded fixtures at their OLD slots, where `untouched` turns them
// into court occupancy that was not occupancy at plan time — so a partial apply
// CAN be refused with a `court` conflict against a fixture the plan intended to
// move. That behaviour is right (it really would be a double-booking); it was
// the "can never be refused" phrasing that was too broad.
//
// R13: warnings come back in full. Blackout, session-window, start-window and
// rest violations do not block, fire no repair round, and the prompt tells the
// model it will not be asked to repair them. Nothing here filters, dedupes away
// or collapses them beyond the exact-duplicate collapse `verifyJoint` does.
//
// BLOCKING IS DELTA-BASED (#399). `isBlocking` — now `isBlockingConflict`, one
// definition in the engine shared with the board — says what is physically
// impossible: a court booked twice, a human on two courts at once, a slot
// outside the competition's days, a fixture placed before its feeder is done.
// This module then refuses only what THIS apply introduced or worsened, by
// verifying the pre-apply board with the identical passes and taking the
// difference on conflict identity.
//
// The delta is not a softening; it is what makes the promotion survivable.
// Boards published before #399 may hold person overlaps, because those were
// warnings all along. Under an absolute rule the organiser's next joint apply
// over such a competition would 409 with nothing they could do about it — the
// board is already dirty, and every edit is refused for the dirt. The
// per-division `crossPersonClash: "hard"` branch is gone with it: a person
// double-booking is refused for every division now, so the opt-in no longer
// decides what may be WRITTEN (it still steers the solver).
//
// This module charges NOTHING — the plan run was already priced and paid for at
// `aiPlanForCompetition`. It is still GATED, on `scheduling.multi_division` and
// nothing else. The request carries full client-supplied assignments, so this
// endpoint needs no prior plan run and no AI at all: it is a multi-division bulk
// write in its own right, and `scheduling.multi_division` is the paywall for
// exactly that capability. `scheduling.ai` is deliberately NOT required —
// applying is not an AI action, and the plan endpoint already charged for the AI.
import type postgres from "postgres";
import { withTenant } from "@/lib/db";
import { requireFeature } from "@/lib/entitlements";
import { HttpError } from "@/lib/errors";
import { SCHEDULE_LOCKED_CODE, scheduleLockedMessageFor } from "@/lib/schedule-lock";
import { EngineError } from "@seazn/engine/core";
import { appendDivisionEvent } from "@/server/engine-db";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { AiApplyMeta, ScheduleConfig } from "@/server/api-v1/schemas";
import { withLegacyDetail } from "@/server/api-v1/conflict-detail-legacy";
import type { ConflictDetail } from "@seazn/engine/scheduling";
import {
  conflictKey,
  deltaConflicts,
  roundOrderConflicts,
  validateAssignments,
  type Assignment,
  type Conflict,
} from "@seazn/engine/scheduling";
import {
  MOVABLE_STATUS,
  heldInPlace,
  afterScheduleWrite,
  applyWindow,
  assertFreshSeq,
  divisionFixtures,
  courtNamesById,
  courtVenueIds,
  divisionLockState,
  withCourtNames,
  feedDependencies,
  loadSettings,
  peopleByEntrant,
  roundRobinSequenceKey,
  roundRobinSequenceSiblings,
  roundRobinStageIds,
  scopeLocked,
  siblingAssignments,
  toAssignment,
  type FixtureLite,
  type LockedScope,
  type ScheduleSettingsOut,
} from "./schedule";
import { isBlocking, schedulingAiModel, type PackSettings } from "./schedule-ai";
import {
  COMPETITION_MOVABLE_CAP,
  JOINT_APPLY_EVENT,
  verifyConfigFor,
  type CompetitionPackDivision,
} from "./competition-schedule-ai";
import { assertCompetitionNotFrozen } from "./entitlement-freeze";
import { playedFixtureIds } from "./fixture-results-sql";

type Tx = postgres.TransactionSql;

const MS_PER_MIN = 60_000;
const ms = (v: string | Date): number => new Date(v).getTime();
const iso = (t: number): string => new Date(t).toISOString();
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** A conflict's canonical detail alone, with the `fixtureId|reason|` prefix
 *  `conflictKey` (calendar.ts) leads with stripped off — NOT
 *  `canonConflictDetail` itself: it is not part of the engine's public
 *  barrel (only the `ConflictDetail`/`ConflictDetailKind` TYPES are
 *  re-exported, from calendar.ts), so this reuses `conflictKey`'s own
 *  computation rather than re-deriving canon locally, which would risk
 *  drifting from the engine's own field-order rules (review finding 6).
 *  Exact by construction: `conflictKey(c) === \`${c.fixtureId}|${c.reason}|\`
 *  + <canon>`, so slicing off that literal prefix recovers <canon> exactly,
 *  never an approximation. */
const conflictDetailSuffix = (c: Conflict): string =>
  conflictKey(c).slice(`${c.fixtureId}|${c.reason}|`.length);

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export interface CompetitionApplyDivision {
  division_id: string;
  /** Required, unlike the single-division apply's optional token. A joint write
   *  that skipped the check on one division would let a stale board silently
   *  overwrite a concurrent edit there while every other division was guarded. */
  expected_seq: number;
  /** P9 pass 3b: `court_id` (a real `courts.id`), not the legacy `court_label`
   *  — mirrors `ApplyCompetitionScheduleRequest`'s wire shape (schemas.ts) and
   *  `applySchedule`'s (schedule.ts) already-converted single-division twin.
   *  `venue_id` optional, same coalesce-over-unchanged semantics as there. */
  assignments: {
    fixture_id: string;
    scheduled_at: string;
    court_id: string;
    venue_id?: string | null;
  }[];
}

export interface CompetitionApplyInput {
  divisions: CompetitionApplyDivision[];
  /** "ai" only. The board's manual editor stays on the per-stage endpoint: a
   *  hand edit is one division by construction, so it has nothing to gain from
   *  N advisory locks and a cross-division verifier pass. */
  source: "ai";
  /** Audit provenance (v4/03 §10), stamped into every division's ledger row AND
   *  the one competition-level row. */
  ai?: AiApplyMeta;
}

export interface CompetitionApplyOut {
  applied: number;
  /** Each listed division's seq after this call, in domain order: advanced by
   *  the one `schedule_applied` step a division gets when something of it
   *  moved, unchanged when nothing did (review 4 of #857, Minor 1). */
  divisions: { division_id: string; seq: number }[];
  /** Listed fixtures left where they are because they hold a result
   *  (`heldInPlace`, schedule.ts), across every division. */
  skipped: number;
  /**
   * The ENGINE verifier's `Conflict`, verbatim — the same camelCase shape the
   * joint ai-plan response carries, NOT the snake_case `ScheduleConflict` the
   * per-stage apply returns.
   *
   * Deliberate: the board renders an applied joint plan's residual warnings
   * next to the ones the plan itself came back with, and `mapConflicts` cannot
   * classify a joint report anyway — it takes ONE `crossPersonClash` for a
   * whole call, while a joint call spans divisions that may disagree on it.
   *
   * `isBlocking` is the taxonomy BOTH ends use, unmodified (`blockingKeys`
   * below, :711, is built from `isBlocking(c)` alone — no per-division
   * branch). Per #399 the emitting division's own `crossPersonClash` no
   * longer adds anything on top of it: `person_overlap` is unconditionally
   * blocking in `isBlockingConflict` regardless of that setting, which now
   * only steers the AI solver's own choices. An earlier version of this
   * comment described a per-division "floor plus crossPersonClash" split
   * that #399 retired.
   */
  conflicts: Conflict[];
}

// ---------------------------------------------------------------------------
// Lock ordering — the deadlock guard, kept pure so it is testable on its own.
// ---------------------------------------------------------------------------

/** The order N division advisory locks must be acquired in. Sorted (and
 *  de-duplicated: a division named twice must not be locked twice). */
export function lockOrder(divisionIds: readonly string[]): string[] {
  return [...new Set(divisionIds)].sort();
}

/** Take `pg_advisory_xact_lock` on every division, in {@link lockOrder} order.
 *  Returns the order used. Held until the transaction ends, which is what makes
 *  everything read below stable for the whole apply. */
export async function lockDivisions(tx: Tx, divisionIds: readonly string[]): Promise<string[]> {
  const order = lockOrder(divisionIds);
  for (const id of order) {
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + id}))`;
  }
  return order;
}

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

/** A division's stored `ScheduleConfig` in the pack's `PackSettings` shape, so
 *  {@link verifyConfigFor} — the SAME config builder plan time used — can read
 *  it (ruling R11: plan time and apply time must not disagree).
 *
 *  The pack renders times as zoned ISO and this does not; that is not a
 *  difference. `verifyConfigFor` only `Date.parse`es them, and a zoned
 *  rendering of an instant parses back to that same instant. Nothing here may
 *  start reading these as strings without revisiting that. */
function packSettingsOf(config: ScheduleConfig): PackSettings {
  return {
    matchMinutes: config.matchMinutes,
    gapMinutes: config.gapMinutes,
    perEntrantMinRest: config.perEntrantMinRest,
    courts: [...config.courts],
    sessionWindows: config.sessionWindows.map((w) => ({ from: w.from, to: w.to })),
    blackouts: config.blackouts.map((b) => ({
      ...(b.court !== undefined ? { court: b.court } : {}),
      from: b.from,
      to: b.to,
    })),
    constraints: config.constraints
      ? {
          ...(config.constraints.restMin !== undefined ? { restMin: config.constraints.restMin } : {}),
          ...(config.constraints.restByGroup !== undefined
            ? { restByGroup: config.constraints.restByGroup }
            : {}),
          noBackToBack: config.constraints.noBackToBack,
          startWindows: config.constraints.startWindows.map((w) => ({
            target: w.target,
            ...(w.notBefore !== undefined ? { notBefore: w.notBefore } : {}),
            ...(w.notAfter !== undefined ? { notAfter: w.notAfter } : {}),
          })),
          fieldFairness: config.constraints.fieldFairness,
          parallelism: config.constraints.parallelism,
          crossPersonClash: config.constraints.crossPersonClash,
        }
      : null,
  };
}

interface LoadedDivision {
  id: string;
  name: string;
  slug: string;
  sport: string;
  settings: ScheduleSettingsOut;
  fixtures: FixtureLite[];
  byId: Map<string, FixtureLite>;
  scopes: LockedScope[];
  input: CompetitionApplyDivision;
}

/** The subset of a pack division `verifyConfigFor` reads, built from the DB. */
const packDivisionOf = (d: LoadedDivision): CompetitionPackDivision => ({
  id: d.id,
  name: d.name,
  sport: d.sport,
  tz: d.settings.displayTz,
  settings: packSettingsOf(d.settings.config),
  movableIds: d.input.assignments.map((a) => a.fixture_id),
  draftPlaced: d.input.assignments.length,
});

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Persist a joint AI plan across several divisions of one competition, atomically.
 *
 * @throws HttpError 400 (no divisions / a division named twice), 404 (unknown
 *   competition, or a division that is not in it), 409 SCHEDULE_APPLY_TOO_LARGE,
 *   422 (a frozen division, a fixture that is not in the division it was offered
 *   under, a decided fixture, a fixture inside a locked scope, a fixture named
 *   twice), EngineError SEQ_CONFLICT (409) and SCHEDULE_CONFLICT (409, carrying
 *   the blocking conflicts), PaymentRequiredError (402 — no
 *   `scheduling.multi_division`, or a competition frozen by
 *   `competitions.max_active`).
 */
export async function applyCompetitionSchedule(
  auth: AuthCtx,
  competitionId: string,
  input: CompetitionApplyInput,
): Promise<CompetitionApplyOut> {
  // The capability gate, ahead of every read, every lock and every write — see
  // the module header on why this endpoint needs one of its own and why it is
  // this key rather than `scheduling.ai`.
  //
  // Competition-scoped since V353 (#382): an Event Pass now lifts this key, and
  // a pass covers ONE competition — the one being written.
  await requireFeature(auth.orgId, "scheduling.multi_division", competitionId);

  if (input.divisions.length === 0) {
    throw new HttpError(400, "no divisions to apply", "SCHEDULE_APPLY_NO_DIVISIONS");
  }
  const requestedIds = input.divisions.map((d) => d.division_id);
  if (new Set(requestedIds).size !== requestedIds.length) {
    throw new HttpError(400, "a division is listed more than once", "SCHEDULE_APPLY_DUPLICATE_DIVISION");
  }
  // The same 500 the PLAN path caps a whole run at. Without it the schema's
  // per-division max of 500 across 20 divisions would admit 10 000 single-row
  // updates in one transaction holding 20 advisory locks — a door 20x wider than
  // anything a plan can produce. Checked on the request alone, before any read.
  const total = input.divisions.reduce((n, d) => n + d.assignments.length, 0);
  if (total > COMPETITION_MOVABLE_CAP) {
    throw new HttpError(
      409,
      "too many fixtures in one apply — apply per division",
      "SCHEDULE_APPLY_TOO_LARGE",
    );
  }
  // Every fixture belongs to exactly one division and moves exactly once. Two
  // entries for one fixture would be written twice and verified as two bookings
  // of the same match — the joint mirror of `jointStructuralCheck`'s rule.
  const seenFixture = new Set<string>();
  for (const d of input.divisions) {
    for (const a of d.assignments) {
      if (seenFixture.has(a.fixture_id)) {
        throw new HttpError(422, `fixture ${a.fixture_id} appears more than once`);
      }
      seenFixture.add(a.fixture_id);
    }
  }

  // Stamped once and shared by every event this apply writes. The client's
  // `model` is deliberately overwritten with the runtime one (schedule.ts:587):
  // SCHEDULING_AI_MODEL can override the model that actually ran, and the run
  // ledger records the truth, so trusting the request would misrecord the audit.
  const ai =
    input.ai !== undefined
      ? { ...input.ai, instruction: input.ai.instruction.trim(), model: schedulingAiModel() }
      : undefined;

  // OUTSIDE the transaction: the freeze lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. An unknown competition is never a
  // member of the frozen set, so the entity's own 404 still fires first.
  await assertCompetitionNotFrozen(auth.orgId, competitionId);

  const out = await withTenant(auth.orgId, async (tx) => {
    // The divisions, in sorted order, so two joint applies over overlapping
    // sets serialise instead of deadlocking. Locks FIRST, before anything that
    // is read is acted on.
    //
    // There is no COMPETITION-scoped key here any more (#386). This apply used
    // to take `joint:<competitionId>` under a 5s `lock_timeout` so it could not
    // interleave with a joint RESTORE rewinding the same competition. The
    // restore no longer takes that key — it detects a superseding apply by
    // re-reading the newest apply event before each division instead
    // (competition-schedule-restore.ts) — so this key could only ever have
    // collided with another APPLY, which the division locks below already
    // serialise inside one transaction. A lock that excludes nothing is worse
    // than no lock: the code above it gets written as though it cannot happen.
    await lockDivisions(tx, requestedIds);

    const [competition] = await tx<{ id: string }[]>`
      select id from competitions where id = ${competitionId}`;
    if (!competition) throw new HttpError(404, "competition not found");

    const rows = await tx<{ id: string; name: string; slug: string; sport_key: string }[]>`
      select id, name, slug, sport_key from divisions
      where competition_id = ${competitionId} and id in ${tx(requestedIds)}`;
    const rowById = new Map(rows.map((r) => [r.id, r]));
    // In REQUEST order, so the error a caller gets back is a function of the
    // request alone and never of row order out of Postgres.
    for (const id of requestedIds) {
      if (!rowById.has(id)) throw new HttpError(404, `division not in competition: ${id}`);
    }

    const loaded: LoadedDivision[] = [];
    let skipped = 0;
    for (const d of input.divisions) {
      const row = rowById.get(d.division_id)!;
      const lockState = await divisionLockState(tx, d.division_id);
      // A frozen division aborts EVERYTHING, not just its own slice.
      //
      // This is the one refusal that cannot use `SCHEDULE_LOCKED_MESSAGE`
      // verbatim: the caller named a COMPETITION, so "the division schedule is
      // locked" would not tell them WHICH of the divisions they submitted
      // stopped the run. It shares the CODE with every sibling and gets its
      // sentence from `scheduleLockedMessageFor` beside the constant, so the
      // two still move together and neither is retyped at a call site.
      if (lockState.frozen) {
        throw new HttpError(422, scheduleLockedMessageFor(row.name), SCHEDULE_LOCKED_CODE);
      }
      const settings = await loadSettings(tx, d.division_id);
      const fixtures = await divisionFixtures(tx, d.division_id);
      const byId = new Map(fixtures.map((f) => [f.id, f]));
      // A `scheduled` row that holds a result is SKIPPED here, before
      // anything reads the assignments, exactly as the per-stage apply
      // skips it (`heldInPlace`).
      const played = await playedFixtureIds(tx, d.division_id);
      const assignments = d.assignments.filter((a) => {
        const f = byId.get(a.fixture_id);
        return !(f && heldInPlace(f, played));
      });
      skipped += d.assignments.length - assignments.length;
      loaded.push({
        id: d.division_id,
        name: row.name,
        slug: row.slug,
        sport: row.sport_key,
        settings,
        fixtures,
        byId,
        scopes: lockState.scopes,
        input: { ...d, assignments },
      });
    }

    // Every assignment must name a MOVABLE fixture of the division it was
    // offered under. Ruling R14: the runner's equivalent throws 500
    // AI_PLAN_INVALID_ASSIGNMENT because only a server bug can reach it there,
    // but here the ids come off the wire, so an unknown one is a request defect
    // and must be a 4xx.
    for (const d of loaded) {
      for (const a of d.input.assignments) {
        const f = d.byId.get(a.fixture_id);
        if (!f) {
          throw new HttpError(
            422,
            `fixture ${a.fixture_id} is not part of division "${d.name}"`,
            "SCHEDULE_APPLY_UNKNOWN_FIXTURE",
          );
        }
        if (f.status !== MOVABLE_STATUS) {
          throw new HttpError(
            422,
            `fixture ${a.fixture_id} is ${f.status} — decided fixtures are immutable`,
          );
        }
        if (scopeLocked(f, d.scopes)) {
          throw new HttpError(422, `fixture ${a.fixture_id} is inside a locked scope`);
        }
      }
    }

    // Emitted order for everything below: division NAME then SLUG, the same
    // domain order the joint pack sorts divisions by. `createDivision` enforces
    // a unique slug but not a unique name, so the slug is a real tie-break, not
    // decoration. Never the UUID — that is reserved for lock acquisition.
    const order = [...loaded].sort((a, b) => cmp(a.name, b.name) || cmp(a.slug, b.slug));

    // C1 follow-up (2026-08-12, task 2 item 1). ONE call PER DIVISION, not one
    // call over the whole run: `roundRobinStageIds` answers "which stages of
    // THIS division are round-robin-generated", and a joint apply spans
    // multiple, independent divisions — passing a single division id here
    // would silently answer the question for one division and apply that
    // answer to every other one in the run, which is exactly the
    // "compared as one sequence" defect C1's own design exists to prevent,
    // just at the DIVISION granularity instead of the stage/pool one.
    // Resolved once, up front, and looked up per fixture below (mirrors
    // `applySchedule`'s single-division `roundRobin` binding — see
    // `schedule.ts`, the reference implementation for this wiring).
    const roundRobinByDivision = new Map<string, ReadonlySet<string>>(
      await Promise.all(
        order.map(async (d) => [d.id, await roundRobinStageIds(tx, d.id)] as const),
      ),
    );

    // ---- the merged board -------------------------------------------------
    const people = await peopleByEntrant(
      tx,
      [
        ...new Set(
          order.flatMap((d) => d.fixtures.flatMap((f) => [f.home_entrant_id, f.away_entrant_id])),
        ),
      ].filter((e): e is string => e !== null),
    );
    const peopleOf = (f: FixtureLite): string[] => [
      ...(f.home_entrant_id !== null ? people.get(f.home_entrant_id) ?? [] : []),
      ...(f.away_entrant_id !== null ? people.get(f.away_entrant_id) ?? [] : []),
    ];

    const proposed: Assignment[] = order.flatMap((d) =>
      d.input.assignments.map((a) => {
        const f = d.byId.get(a.fixture_id)!;
        const startAt = ms(a.scheduled_at);
        return {
          fixtureId: a.fixture_id,
          court: a.court_id,
          startAt,
          endAt: startAt + d.settings.config.matchMinutes * MS_PER_MIN,
          entrants: [f.home_entrant_id, f.away_entrant_id].filter((e): e is string => e !== null),
          people: peopleOf(f),
          // What `verifyJoint` partitions on, and what makes a division-keyed
          // `constraints.restByGroup` govern that division's own fixtures.
          divisionId: d.id,
          // …and the POOL-keyed half of the same field (#446). `restByGroup` and
          // `startWindows` both target a pool or a division; only the division
          // half was ever stamped, so a pool-targeted rule bound in the placer
          // and evaporated here.
          ...(f.pool_id !== null ? { poolId: f.pool_id } : {}),
          // C1 follow-up (task 2 item 1). stageId unconditional, same as
          // divisionId — `fixtures.stage_id` is NOT NULL. roundNo gated on
          // `roundRobinByDivision`, same reasoning as `toAssignment`'s own
          // gate: `fixtures.round_no` is one shared column populated for
          // every stage kind, and forwarding it for a non-round-robin stage
          // would compare two independent round sequences as if they were
          // one — same defect this whole field exists to prevent, one level
          // up.
          stageId: f.stage_id,
          ...(roundRobinByDivision.get(d.id)?.has(f.stage_id) ? { roundNo: f.round_no } : {}),
        };
      }),
    );
    // Fixtures of the run's own divisions that this apply is NOT moving: fixed
    // occupancy, carrying their entrants and people, exactly as the
    // single-division apply treats them.
    // P9 pass 3b: `court_id`, not the legacy `court_label` — the latter is
    // null on every fixture scheduled since the cutover, which silently
    // dropped every real placement from the "already occupying a court" set.
    const untouched: Assignment[] = order.flatMap((d) =>
      d.fixtures
        .filter((f) => !seenFixture.has(f.id) && f.scheduled_at !== null && f.court_id !== null)
        .map((f) => toAssignment(f, d.settings.config.matchMinutes, people, roundRobinByDivision.get(d.id))),
    );
    // Divisions of this competition that are NOT in the run. One call: passing
    // every run division as `excludeDivisionIds` leaves exactly the outsiders,
    // and each of them is measured with its own matchMinutes.
    // `.assignments` only, deliberately (#462). This pass judges each division
    // through `verifyConfigFor`, whose `ruleFixtures` come from the joint PACK —
    // a different producer from `toVerifyConfig`, and widening it to outside
    // divisions is a separate question about what a joint run may be held to.
    // The single-division board paths are the ones #462 names, and they are the
    // ones changed. Left as an explicit projection so a reader sees a decision
    // rather than an omission.
    const siblings = (
      await siblingAssignments(
        tx,
        order[0]!.id,
        competitionId,
        order[0]!.settings.config.matchMinutes,
        order.map((d) => d.id),
      )
    ).assignments;
    // Feeds are within-division in practice, but the engine resolves a
    // dependency against the whole board, so it is built over the whole board.
    const deps = feedDependencies(order.flatMap((d) => d.fixtures));

    // C1 gap A. The org zone alone — see `verifyConfigFor`'s 4th parameter for
    // the full argument for why this is safe under #399 (never widens what
    // the two calls below check to `hard`/`ruleFixtures`/`restByDivision`).
    // ONE value for the whole run, from `order[0]!` exactly like
    // `siblingAssignments` above: #397/design §2.1 requires every division of
    // one competition to agree on which calendar day a fixture is on, and
    // `settings.orgTz` (never `.displayTz`) is the field that ruling governs —
    // a division's own display override must not move it.
    const orgTz = order[0]!.settings.orgTz;

    // The listed fixtures WHERE THEY SIT NOW — the merged board before this
    // apply touches it (#399). Built exactly like `proposed` so the two passes
    // are comparable key for key; a fixture with no slot yet contributes
    // nothing, so its first placement's conflicts read as introduced.
    const current: Assignment[] = order.flatMap((d) =>
      d.input.assignments
        .map((a) => d.byId.get(a.fixture_id)!)
        // P9 pass 3b: `court_id`, the fixture's real pre-apply identity.
        .filter((f) => f.scheduled_at !== null && f.court_id !== null)
        // `toAssignment` stamps `divisionId` from the fixture's own
        // `division_id` (#446), so this pass does NOT re-write it from `d.id`.
        // The two agree — `d.byId` only holds that division's fixtures — and
        // one field with one source is the whole point of the fix this file
        // is part of. Same reasoning extends to `roundRobinByDivision.get(d.id)`
        // (task 2 item 1): the fixture's own `stage_id` decides whether its
        // round is round-robin-generated, never `d.id` alone.
        .map((f) => toAssignment(f, d.settings.config.matchMinutes, people, roundRobinByDivision.get(d.id))),
    );

    // The venue-qualified court NAMES this run's conflicts resolve through, so
    // a 409 never quotes a bare uuid at the organiser. Defined BEFORE the
    // refusal path below, not beside the write further down — it is used by
    // both, and a const declared after its first use is a dead-zone throw at
    // runtime that no type check catches.
    const jointCourtNames = await courtNamesById(tx);
    const withJointCourtNames = <C extends { details?: ConflictDetail }>(c: C): C =>
      c.details !== undefined ? { ...c, details: withCourtNames(c.details, jointCourtNames) } : c;

    // ---- one pass per division, over the merged board ---------------------
    const seenConflict = new Set<string>();
    const blockingKeys = new Set<string>();
    const found: Conflict[] = [];
    const before: Conflict[] = [];
    // C1 final-review (4th instance of the delta-gate partial-apply
    // round-order blind spot — `schedule.ts`'s `roundRobinSequenceSiblings`
    // carries the full mechanism; `applySchedule`'s partial path and
    // `moveFixture` are the reference implementations this generalizes from
    // one division to N independent ones). Accumulated across the whole loop
    // so the RETURNED `conflicts` can be filtered once, after every
    // division's own pass has run — see its use below the write gate.
    const allSiblingIds = new Set<string>();
    for (const d of order) {
      const mine = proposed.filter((a) => a.divisionId === d.id);
      if (mine.length === 0) continue;
      const others = proposed.filter((a) => a.divisionId !== d.id);
      // This apply's own round-robin siblings for division `d` — same
      // (division, stage, pool) sequence as one of `d`'s LISTED fixtures,
      // already placed, not itself listed. `mine` only holds fixtures THIS
      // apply explicitly named for `d`; an unlisted same-sequence sibling
      // sits in `untouched`, out of `roundOrderConflicts`' pair scan (scoped
      // to the set it's handed, by design). Pulled into round order's OWN
      // checked set on BOTH delta sides below, symmetrically, or a
      // pre-existing violation among the siblings reads as newly introduced
      // and blocks a partial apply that never touched them — the property
      // the "stays editable over a PRE-EXISTING round-order violation" test
      // (competition-schedule-apply.test.ts) exists to pin.
      //
      // C1 fix-loop (round-order-widening fix-loop): they deliberately do NOT
      // move into `mine`/`current-for-d` or out of `untouched` for the CORE
      // gate below (rest/court/person/window/feed-order) — that was the
      // original, too-blunt fix, pulling a sibling out of context and making
      // it FOCAL for every rule family a division's pass checks, not just
      // round order. `untouched` stays UNMODIFIED for every division's pass,
      // this one included — round order is judged separately, below.
      const listedIds = new Set(d.input.assignments.map((a) => a.fixture_id));
      const widenKeys = new Set(
        d.input.assignments
          .map((a) => d.byId.get(a.fixture_id)!)
          .filter((f) => roundRobinByDivision.get(d.id)?.has(f.stage_id))
          .map(roundRobinSequenceKey),
      );
      const roundRobinSiblings = roundRobinSequenceSiblings(d.fixtures, widenKeys, listedIds);
      const siblingIds = new Set(roundRobinSiblings.map((f) => f.id));
      for (const id of siblingIds) allSiblingIds.add(id);
      // Same representation on both delta sides — these fixtures move in
      // NEITHER pass, so their own conflicts land identically in `before`
      // and this division's found-pass, and the (before, found) delta below
      // the write gate correctly reads them as pre-existing.
      const widenedSiblings = roundRobinSiblings.map((f) =>
        toAssignment(f, d.settings.config.matchMinutes, people, roundRobinByDivision.get(d.id)),
      );
      const currentForD = current.filter((a) => a.divisionId === d.id);
      // `untouched` UNMODIFIED (ORIGINAL composition, byte-identical to
      // origin/main) — every division's pass, including `d`'s own, sees every
      // OTHER division's untouched fixtures AND `d`'s own, exactly as it did
      // before round order existed.
      const config = verifyConfigFor(packDivisionOf(d), applyWindow(d.settings), undefined, orgTz);
      // The identical pass over the pre-apply board. Same division, same config,
      // same "everyone else" — so a conflict that survives this comparison is
      // one this apply is responsible for. CORE families via
      // `includeRoundOrder=false` (byte-identical in shape to the
      // pre-round-order gate); round order separately, over the widened set.
      before.push(
        ...validateAssignments(
          currentForD,
          config,
          [...current.filter((a) => a.divisionId !== d.id), ...untouched, ...siblings],
          deps,
          false,
        ),
        ...roundOrderConflicts([...currentForD, ...widenedSiblings], orgTz),
      );
      // #399 retired this pass's per-division `crossPersonClash` branch. A human
      // on two courts at once is impossible whoever put them there, so
      // `isBlockingConflict` now covers `person_overlap` for every division —
      // an org that had opted into "hard" loses nothing, and one that had not
      // gains the refusal. The setting still steers the SOLVER; it no longer
      // decides what may be written. What replaces it is the delta below, which
      // is the thing that actually needed deciding: a board that ALREADY holds
      // an overlap has to stay editable.
      for (const c of [
        ...validateAssignments(mine, config, [...others, ...untouched, ...siblings], deps, false),
        ...roundOrderConflicts([...mine, ...widenedSiblings], orgTz),
      ]) {
        // Keyed on (fixtureId, reason, detail) like `verifyJoint`: the engine
        // resolves feed order against the whole board, so a within-division
        // order violation is re-reported verbatim by every other division's
        // pass. The two SIDES of a court clash differ on fixtureId and both
        // survive — either fixture can be the one that moves.
        const key = conflictKey(c);
        // Decided BEFORE the dedupe `continue`, so the verdict is a property of
        // the conflict rather than of which pass happened to reach it first —
        // the same key genuinely can arrive from more than one pass (see the
        // dependency loop noted above).
        if (isBlocking(c)) blockingKeys.add(key);
        if (seenConflict.has(key)) {
          // Same identity from another division's pass — but `shortfallMinutes`
          // is a property of the PASS, not of the key: each division resolves
          // its own rest, so the same feed edge can be measured at two sizes.
          // Keeping the first would let a worsened breach compare a small
          // after-value against a large before-value and slip the gate.
          const seen = found.find((f) => conflictKey(f) === key);
          if (
            seen !== undefined &&
            c.shortfallMinutes !== undefined &&
            c.shortfallMinutes > (seen.shortfallMinutes ?? 0)
          ) {
            seen.shortfallMinutes = c.shortfallMinutes;
          }
          continue;
        }
        seenConflict.add(key);
        found.push({ ...c });
      }
    }
    const conflicts = sortConflicts(found, order);
    // Only what this apply INTRODUCED OR WORSENED may refuse it (#399). The
    // delta runs over the deduped, sorted list rather than the raw per-pass
    // stream, because `before` is deduped by the same identity — a conflict
    // re-reported by three divisions' passes must not read as three new ones.
    // `before` goes in RAW, not deduped. `conflicts` is already collapsed to one
    // instance per identity, so extra copies on the before side only add budget
    // for a key that genuinely existed — and they carry the WORST
    // `shortfallMinutes` of that key with them, which is what stops a measured
    // breach that actually improved from reading as introduced.
    const introduced = new Set(deltaConflicts(before, conflicts).map(conflictKey));
    const blocking = conflicts.filter(
      (c) => blockingKeys.has(conflictKey(c)) && introduced.has(conflictKey(c)),
    );
    if (blocking.length > 0) {
      // Same EngineError the single-division apply raises, so the /api/v1 kernel
      // answers 409 with the conflict list attached and the board renders the
      // offending cards identically.
      throw new EngineError("SCHEDULE_CONFLICT", "schedule change hits a blocking conflict", {
        // `withLegacyDetail` restores the deprecated `detail` string the
        // engine stopped producing (C3, 2026-08-13 design amendment) — this
        // list rides on the 409's `extra.conflicts` verbatim (http.ts), same
        // "carries `Conflict` verbatim" contract `AiPlanConflict` documents.
        // Review wave 3: resolve the court NAME first. This list is the 409
        // an organiser reads, and `withLegacyDetail` renders
        // `details.courtName ?? details.court` — so unresolved it named a raw
        // court uuid. Same resolver every other server path in this cutover
        // uses; `courtNamesById` is exported from `./schedule`.
        conflicts: blocking.map((c) => withLegacyDetail(withJointCourtNames(c))),
      });
    }

    // ---- write ------------------------------------------------------------
    // Resolved ONCE for the whole joint apply: the venue is derived from the
    // court, never accepted from the client (see `courtVenueIds`' own note).
    const courtVenues = await courtVenueIds(tx);
    let applied = 0;
    const seqs: { division_id: string; seq: number }[] = [];
    for (const d of order) {
      // Interleaved with the writes on purpose — see the module header. A
      // pre-pass here would make the rollback test pass without atomicity.
      await assertFreshSeq(tx, d.id, d.input.expected_seq);
      if (d.input.assignments.length === 0) {
        // Every fixture listed for it holds a result and was skipped: nothing
        // written, so no ledger step and no seq bump — as `applySchedule`.
        const [current] = await tx<{ seq: string | number }[]>`
          select seq from divisions where id = ${d.id}`;
        seqs.push({ division_id: d.id, seq: Number(current!.seq) });
        continue;
      }
      const moves: { fixture: string; from: unknown; to: unknown }[] = [];
      for (const a of d.input.assignments) {
        const f = d.byId.get(a.fixture_id)!;
        // P9 pass 3a ruling, applied here in pass 3b: writers stop writing
        // court_label/venue (owner ruling, FULL cutover) — court_id/venue_id
        // only. Mirrors `applySchedule`'s (schedule.ts) identical write.
        //
        // Review wave 2: `venue_id` is DERIVED from the court, exactly as
        // `applySchedule` now does. It used to be
        // `coalesce(${a.venue_id ?? null}, venue_id)`, and no client sends
        // `venue_id` (`jointApplyDivisions` emits fixture_id/scheduled_at/
        // court_id only) — so a joint apply that moved a fixture from one
        // venue's court to another's LEFT the old venue in place, and every
        // player-facing venue string (ICS LOCATION, /me, /my-matches, the
        // public fixture page and its JSON-LD) then named the wrong one. The
        // single-division path was fixed first and this twin was missed,
        // which is the same second-call-site shape this cutover kept hitting.
        await tx`
          update fixtures set
            scheduled_at = ${a.scheduled_at},
            court_id = ${a.court_id},
            venue_id = ${a.court_id !== null ? (courtVenues.get(a.court_id) ?? null) : null},
            schedule_source = ${input.source}
          where id = ${a.fixture_id}`;
        // `court` here is a courts.id, not a label — see `applySchedule`'s
        // identical note on its own `moves` ledger payload.
        // `venue` rides along, as in `applySchedule` (review 3 of #857, m5).
        moves.push({
          fixture: a.fixture_id,
          from: {
            at: f.scheduled_at !== null ? iso(ms(f.scheduled_at)) : null,
            court: f.court_id,
            venue: f.venue_id,
          },
          to: {
            at: a.scheduled_at,
            court: a.court_id,
            venue: a.court_id !== null ? (courtVenues.get(a.court_id) ?? null) : null,
          },
        });
      }
      // The same `schedule_applied` row the per-stage apply writes, so the
      // division's own ledger and its /divisions/{id}/schedule/ai-last recall
      // both see a joint apply exactly as they see a single-division one. No
      // `stageId`: a joint apply spans every stage the division has.
      const seq = await appendDivisionEvent(tx, d.id, "schedule_applied", {
        source: input.source,
        moves,
        // `order` is already the (name, slug) domain order — re-sorting these on
        // the UUID would be the one thing this module's header says a UUID sort
        // is NOT for. Lock acquisition is the sole exception, and this is output.
        joint: { competition_id: competitionId, division_ids: order.map((x) => x.id) },
        ...(ai !== undefined ? { ai } : {}),
      });
      await tx`update divisions set seq = ${seq} where id = ${d.id}`;
      seqs.push({ division_id: d.id, seq });
      applied += d.input.assignments.length;
    }

    // EXACTLY ONE competition-level row — see the module header on why a second
    // one would make `ai-last`'s "latest" a coin flip. `payload.ai` is nested to
    // match the division event field for field, which is the shape
    // `lastCompetitionAiApply` reads.
    await tx`
      insert into competition_events (competition_id, org_id, type, payload, actor_id)
      values (${competitionId}, ${auth.orgId}, ${JOINT_APPLY_EVENT},
              ${tx.json({
                source: input.source,
                // Domain order, like every other array this module emits.
                division_ids: order.map((d) => d.id),
                applied,
                ...(ai !== undefined ? { ai } : {}),
              } as never)}, ${auth.userId})`;

    return {
      applied,
      skipped,
      divisions: seqs,
      // #461's contract (schedule.ts's `applySchedule`/`moveFixture`),
      // generalized to N divisions: a widened sibling exists so the GATE
      // above can see it, not so its own — possibly pre-existing and
      // entirely unrelated — conflicts leak into a response about a fixture
      // no division in this run actually listed. A conflict that DID block
      // the apply is never filtered — the throw above fires from the
      // unfiltered `conflicts`/`blockingKeys` pair, before this line is ever
      // reached.
      // `withLegacyDetail` restores the deprecated `detail` string the engine
      // stopped producing (C3, 2026-08-13 design amendment) — `CompetitionApplyOut`
      // carries `Conflict` verbatim otherwise, same as `AiPlanConflict`.
      conflicts: conflicts
        .filter((c) => !allSiblingIds.has(c.fixtureId))
        .map((c) => withLegacyDetail(withJointCourtNames(c))),
      // R10d n2: each written division, with the fixtures its input assigned.
      written: order
        .filter((d) => d.input.assignments.length > 0)
        .map((d) => ({ divisionId: d.id, fixtureIds: d.input.assignments.map((a) => a.fixture_id) })),
    };
  });

  // Cache invalidation + realtime, once per written division, AFTER the commit.
  for (const { divisionId, fixtureIds } of out.written) {
    afterScheduleWrite(divisionId, competitionId, "schedule", fixtureIds);
  }
  return { applied: out.applied, skipped: out.skipped, divisions: out.divisions, conflicts: out.conflicts };
}

/** Conflicts in reading order: division (domain order), then playing order
 *  within it. Never the fixture UUID except as a last-resort tie-break — the
 *  determinism contract (schedule-ai.ts:1-12). Exported for a direct,
 *  pure-function regression test (C3 review finding 6) — no other module
 *  imports it. */
export function sortConflicts(conflicts: readonly Conflict[], order: readonly LoadedDivision[]): Conflict[] {
  const rank = new Map<string, [number, number, number, string]>();
  order.forEach((d, i) => {
    for (const f of d.fixtures) rank.set(f.id, [i, f.round_no, f.seq_in_round, f.ext_key ?? ""]);
  });
  const UNRANKED: [number, number, number, string] = [Number.MAX_SAFE_INTEGER, 0, 0, ""];
  return [...conflicts].sort((a, b) => {
    const ra = rank.get(a.fixtureId) ?? UNRANKED;
    const rb = rank.get(b.fixtureId) ?? UNRANKED;
    return (
      ra[0] - rb[0] ||
      ra[1] - rb[1] ||
      ra[2] - rb[2] ||
      cmp(ra[3], rb[3]) ||
      cmp(a.reason, b.reason) ||
      // The two conflicts' canonical detail SUFFIX (review finding 6) — NOT
      // `conflictKey` whole, which a prior version of this comment claimed
      // "reduces to" the same thing. It does not: `conflictKey` LEADS with
      // `fixtureId`, so comparing it whole sorts primarily by fixtureId and
      // never reaches the detail at all when the two fixtures differ,
      // silently changing this order from pre-C3 (which compared the raw
      // `detail` string — no fixtureId prefix) and making the
      // `cmp(a.fixtureId, b.fixtureId)` tie-break below unreachable (once
      // the suffix comparison is 0, the fixtureId prefix that produced it
      // must already be equal too).
      cmp(conflictDetailSuffix(a), conflictDetailSuffix(b)) ||
      cmp(a.fixtureId, b.fixtureId)
    );
  });
}
