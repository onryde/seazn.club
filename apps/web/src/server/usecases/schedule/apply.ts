import "server-only";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { SCHEDULE_LOCKED_CODE, SCHEDULE_LOCKED_MESSAGE } from "@/lib/schedule-lock";
import { playedFixtureIds } from "../fixture-results-sql";
import { requireFeature } from "@/lib/entitlements";
import {
  roundOrderConflicts,
  validateAssignments,
  type Assignment,
} from "@seazn/engine/scheduling";
import { appendDivisionEvent } from "@/server/engine-db";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { ApplyScheduleRequest, ScheduleConflict } from "@/server/api-v1/schemas";
import { assertNotFrozen, frozenCompetitionIds } from "../entitlement-freeze";
import { schedulingAiModel } from "../schedule-ai";
import type { FixtureLite } from "./types";
import { MS_PER_MIN, ms, iso } from "./helpers";
import { afterScheduleWrite } from "./after-write";
import {
  MOVABLE_STATUS,
  heldInPlace,
  scopeLocked,
  divisionLockState,
  divisionFixtures,
  courtNamesById,
  courtVenueIds,
  peopleByEntrant,
  peopleOf,
  assertFreshSeq,
} from "./board";
import { loadSettings } from "./settings";
import {
  roundRobinStageIds,
  roundFieldsOf,
  roundRobinSequenceKey,
  roundRobinSequenceSiblings,
} from "./rounds";
import {
  toAssignment,
  feedDependencies,
  siblingAssignments,
  verifyConfigForDivision,
} from "./engine-inputs";
import { mapConflicts, assertNoNewBlocking } from "./conflicts";

// ---------------------------------------------------------------------------
// Apply (transactional persist — doc 12 §4)
// ---------------------------------------------------------------------------

export interface ApplyScheduleOut {
  applied: number;
  /** Listed fixtures left where they are because they hold a result
   *  (`heldInPlace`). */
  skipped: number;
  conflicts: ScheduleConflict[];
  /** The division's seq after this call: advanced by the one ledger step an
   *  apply that moved something writes, unchanged when it moved nothing
   *  (review 4 of #857, Minor 1). A client adopts it rather than assuming +1. */
  seq: number;
}

export async function applySchedule(
  auth: AuthCtx,
  stageId: string,
  input: ApplyScheduleRequest,
): Promise<ApplyScheduleOut> {
  // Manual assignment sets and pin changes are board editing. The gate stays,
  // but since V353 (#382) `scheduling.board` is granted on EVERY plan — an
  // organiser who could ask the AI for a schedule could not then drag one
  // fixture of it, which was backwards. The key is kept rather than deleted:
  // it is still what an entitlement override or a future tier moves.
  if (input.source === "manual" || input.assignments.some((a) => a.schedule_locked !== undefined)) {
    await requireFeature(auth.orgId, "scheduling.board");
  }
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  const out = await withTenant(auth.orgId, async (tx) => {
    const [stage] = await tx<{ division_id: string; competition_id: string }[]>`
      select s.division_id, d.competition_id
      from stages s join divisions d on d.id = s.division_id
      where s.id = ${stageId}`;
    if (!stage) throw new HttpError(404, "stage not found");
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + stage.division_id}))`;
    await assertFreshSeq(tx, stage.division_id, input.expected_seq);
    assertNotFrozen(frozen, stage.competition_id);

    const settings = await loadSettings(tx, stage.division_id);
    const all = await divisionFixtures(tx, stage.division_id);
    // P9 pass 3a — resolved once, used by the conflict mapping below.
    const courtNames = await courtNamesById(tx);
    // #5 fix — resolved once, used to DERIVE venue_id from each assignment's
    // court_id below (never trusted from the client's own a.venue_id).
    const courtVenues = await courtVenueIds(tx);
    const lockState = await divisionLockState(tx, stage.division_id);
    if (lockState.frozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }
    // C1 (2026-08-12 round-order design). This IS the write gate — the one
    // place a disordered board actually gets refused rather than merely
    // proposed — so round order has to be judged here, not only on the
    // auto-schedule preview. See `toAssignment`'s own doc comment.
    const roundRobin = await roundRobinStageIds(tx, stage.division_id, settings);
    const byId = new Map(all.map((f) => [f.id, f]));
    // A `scheduled` row that holds a result is SKIPPED, not refused
    // (`heldInPlace`), the way a rain-delay shift skips it: neither the board
    // nor the solver's proposal can tell it from a movable one by its status.
    const played = await playedFixtureIds(tx, stage.division_id);
    const assignments = input.assignments.filter((a) => {
      const f = byId.get(a.fixture_id);
      return !(f && f.stage_id === stageId && heldInPlace(f, played));
    });
    const skipped = input.assignments.length - assignments.length;
    for (const a of assignments) {
      const f = byId.get(a.fixture_id);
      if (!f || f.stage_id !== stageId) {
        throw new HttpError(422, `fixture ${a.fixture_id} is not part of this stage`);
      }
      if (f.status !== MOVABLE_STATUS) {
        throw new HttpError(422, `fixture ${a.fixture_id} is ${f.status} — decided fixtures are immutable`);
      }
      if (scopeLocked(f, lockState.scopes)) {
        throw new HttpError(422, `fixture ${a.fixture_id} is inside a locked scope`);
      }
    }

    if (assignments.length === 0) {
      // Everything listed was skipped: nothing written, so no ledger step and
      // no seq bump — the seq the caller holds is still the current one.
      const [current] = await tx<{ seq: string | number }[]>`
        select seq from divisions where id = ${stage.division_id}`;
      return {
        divisionId: stage.division_id,
        competitionId: stage.competition_id,
        applied: 0,
        skipped,
        conflicts: [],
        seq: Number(current!.seq),
        fixtureIds: [],
      };
    }

    const entrantIds = [
      ...new Set(all.flatMap((f) => [f.home_entrant_id, f.away_entrant_id])),
    ].filter((e): e is string => e !== null);
    const people = await peopleByEntrant(tx, entrantIds);

    const proposed: Assignment[] = assignments.map((a) => {
      const f = byId.get(a.fixture_id) as FixtureLite;
      const start = ms(a.scheduled_at);
      return {
        fixtureId: a.fixture_id,
        court: a.court_id,
        startAt: start,
        endAt: start + settings.config.matchMinutes * MS_PER_MIN,
        entrants: [f.home_entrant_id, f.away_entrant_id].filter((e): e is string => e !== null),
        people: peopleOf(f, people),
        // #446: the proposed card's own group identity, so a pool- or
        // division-targeted rule is applied to the placement being judged and
        // not only to the board it lands on. Same shape as `toAssignment`.
        ...(f.pool_id !== null ? { poolId: f.pool_id } : {}),
        divisionId: f.division_id,
        // C1 fix-loop (Finding 2): unconditional, same as `divisionId` just
        // above — `divisionFixtures` (below) is DIVISION-WIDE, so `all`, and
        // therefore `proposed`/`currentSlots`/`untouched`, can carry more
        // than one round-sequence stage's fixtures in ONE call. This is
        // the actual WRITE gate (the comment above `roundRobin`'s own
        // assignment explains why it has to be judged HERE), so it is the
        // one place this omission would have mattered most: without it,
        // `calendar.ts`'s grouping key falls back to `(divisionId, poolId)`
        // and two unpooled round-sequence stages compare as one sequence again.
        stageId: f.stage_id,
        // C1 (2026-08-12 round-order design). Same shape as `toAssignment`
        // again — `f.round_no` is the fixture's own round, gated on stage
        // kind exactly as `toAssignment` gates it; `movable: true`
        // unconditionally, because every row here is a position THIS apply
        // is actively choosing, whatever lock state it ends up carrying
        // (`a.schedule_locked` below is the state AFTER this write, not a
        // fact about whether this apply itself may act on it).
        ...roundFieldsOf(roundRobin, f),
        movable: true,
      };
    });
    const listed = new Set(assignments.map((a) => a.fixture_id));
    // C1 fix-loop (G2/3rd instance, re-scoped by the round-order-widening
    // fix-loop below). This apply's own round-robin siblings — same
    // (division, stage, pool) sequence as any LISTED fixture, already placed,
    // not themselves listed. They are needed ONLY so `roundOrderConflicts`
    // (the round-order-only pass below) can pair a listed fixture against an
    // untouched one — its pairwise scan is scoped to the set it is handed,
    // by design. See `roundRobinSequenceSiblings`'s own comment for the full
    // mechanism; this generalizes it to N listed fixtures rather than
    // exactly one (`moveFixture`'s shape below).
    //
    // They deliberately do NOT move into `assignments`/out of `untouched` for
    // the CORE gate below (rest/court/person/window/feed-order) — that was
    // the original, too-blunt fix: pulling a sibling out of `existing` made
    // it FOCAL for every rule family the gate checks, not just round order,
    // silently changing what rest/court/person judged a pre-existing board
    // against. Those families see the siblings exactly as they always did —
    // as fixed CONTEXT via `board`/`existing` below — so their verdicts stay
    // byte-identical to the pre-round-order gate.
    const widenKeys = new Set(
      assignments
        .map((a) => byId.get(a.fixture_id) as FixtureLite)
        .filter((f) => roundRobin.has(f.stage_id))
        .map(roundRobinSequenceKey),
    );
    const roundRobinSiblings = roundRobinSequenceSiblings(all, widenKeys, listed);
    const siblingIds = new Set(roundRobinSiblings.map((f) => f.id));
    // ORIGINAL composition — `siblingIds` stays IN here, matching every rule
    // family's pre-round-order behaviour (and origin/main's, byte for byte).
    const untouched = all
      .filter((f) => !listed.has(f.id) && f.scheduled_at !== null && f.court_id !== null)
      .map((f) => toAssignment(f, settings.config.matchMinutes, people, roundRobin));
    // Round-order-only checked set: the siblings, same representation as
    // `untouched`'s rows, added to BOTH delta sides below so a pre-existing
    // round-order violation among them reads as pre-existing rather than
    // newly introduced by a move that never touched them.
    const widenedSiblings = roundRobinSiblings.map((f) =>
      toAssignment(f, settings.config.matchMinutes, people, roundRobin),
    );
    const siblings = await siblingAssignments(
      tx,
      stage.division_id,
      stage.competition_id,
      settings.config.matchMinutes,
    );

    // #447: the VERIFY config, so the durable typed rules an organiser stored
    // are the rules this gate judges by. Warn-only — see `assertNoNewBlocking`.
    // P9.5 review finding 4: the apply gate sees court opening hours too, so a
    // board applied onto a closed court is reported HERE rather than only by
    // the next /validate run — two surfaces, one answer. P10 (§3): routed
    // through the ONE builder so this site gets the stranded-court signal too
    // — hand-assembly at five sites is how person-merge.ts ended up with
    // neither signal at all.
    // Review fix (finding 2): `all` alone only ever names courts a STORED
    // fixture already occupies. `proposed`'s own court_ids — the ones THIS
    // apply is actively placing fixtures onto — must be unioned in too, or
    // applying onto an archived court nothing else currently uses reports
    // clean HERE and only surfaces on the next /validate, contradicting the
    // "this apply gate sees ... the stranded-court signal too" comment just
    // above: it did not, until now.
    const assignedCourtIds = [
      ...new Set(
        [...all.map((f) => f.court_id), ...proposed.map((a) => a.court)].filter(
          (c): c is string => c !== null,
        ),
      ),
    ];
    const slotConfig = await verifyConfigForDivision(
      tx,
      settings,
      all,
      0,
      siblings.ruleFixtures,
      stage.division_id,
      assignedCourtIds,
    );
    const deps = feedDependencies(all);
    const board = [...untouched, ...siblings.assignments];
    // The SAME fixtures where they sit right now (#399). Anything the verifier
    // already says about this board is history, not this apply's doing — an
    // organiser whose board carries a pre-existing person overlap must still be
    // able to edit it, which is the only way they can ever fix it.
    // A fixture with no slot yet contributes nothing, so every conflict its
    // placement causes reads as introduced. Correct: it is.
    const currentSlots = assignments
      .map((a) => byId.get(a.fixture_id) as FixtureLite)
      .filter((f) => f.scheduled_at !== null && f.court_id !== null)
      .map((f) => toAssignment(f, settings.config.matchMinutes, people, roundRobin));
    // CORE families (window/start_window/court/blackout/rest/person_overlap/
    // instruction rules/feed-order): `includeRoundOrder=false` — this call is
    // byte-identical in shape to the pre-round-order gate, so its verdict is
    // too. Round order is judged SEPARATELY, immediately below, over the
    // widened set — merging only its `"order"` conflicts back in keeps every
    // other family blind to the siblings, exactly as it always was.
    const baseline = [
      ...validateAssignments(currentSlots, slotConfig, board, deps, false),
      ...roundOrderConflicts(currentSlots.concat(widenedSiblings), slotConfig.tz),
    ];
    const found = [
      ...validateAssignments(proposed, slotConfig, board, deps, false),
      ...roundOrderConflicts(proposed.concat(widenedSiblings), slotConfig.tz),
    ];
    assertNoNewBlocking(baseline, found, courtNames);
    // Scoped to the fixtures THIS apply actually listed (#461's contract,
    // `moveFixture`'s own return does the same) — the widened siblings above
    // exist so the round-order GATE can see them, not so their own (possibly
    // pre-existing and entirely unrelated) conflicts leak into a response
    // about fixtures the caller never named.
    const conflicts = mapConflicts(found.filter((c) => !siblingIds.has(c.fixtureId)), courtNames);

    const moves: { fixture: string; from: unknown; to: unknown }[] = [];
    for (const a of assignments) {
      const f = byId.get(a.fixture_id) as FixtureLite;
      // P9 pass 3a: writers stop writing court_label/venue (owner ruling,
      // FULL cutover) — court_id/venue_id only.
      //
      // #5 fix (P9 review): venue_id is DERIVED from a.court_id server-side,
      // via courts.venue_id — never trusted from the client's own a.venue_id.
      // No caller (use-board-actions.ts/ai-apply.ts/move-panel.tsx) has ever
      // sent venue_id; the old `coalesce(a.venue_id, venue_id)` therefore
      // left every freshly-scheduled fixture's venue_id NULL and, after a
      // move to a court in a different venue, stuck on the OLD venue — every
      // player-facing venue string (ICS LOCATION, /me, /my-matches, the
      // public fixture page + its JSON-LD) derives from this column.
      // a.court_id is a required field here (ApplyScheduleRequest's
      // Assignment, never nullable), and courts.venue_id is NOT NULL, so
      // this always resolves for a real, same-org court; a bogus court_id is
      // already rejected by fixtures' composite (court_id, org_id) FK before
      // venue_id's own correctness could matter.
      await tx`
        update fixtures set
          scheduled_at = ${a.scheduled_at},
          court_id = ${a.court_id},
          venue_id = ${courtVenues.get(a.court_id) ?? null},
          schedule_source = ${input.source},
          schedule_locked = ${a.schedule_locked ?? f.schedule_locked}
        where id = ${a.fixture_id}`;
      // `court` here is a courts.id, not a label — see moveFixture's
      // identical note on `schedule_edited`'s ledger payload; history.ts's
      // `execute()` replays `schedule_applied`/`schedule_shifted` the same way.
      // `venue` rides along (review 3 of #857, m5): a fixture can stand in a
      // venue with NO court, and the Undo that takes it off the court has no
      // court to derive that venue from.
      moves.push({
        fixture: a.fixture_id,
        from: {
          at: f.scheduled_at !== null ? iso(ms(f.scheduled_at)) : null,
          court: f.court_id,
          venue: f.venue_id,
        },
        to: { at: a.scheduled_at, court: a.court_id, venue: courtVenues.get(a.court_id) ?? null },
      });
    }
    // One auditable ledger entry per apply (doc 12 §2 family: schedule_edited/…).
    const seq = await appendDivisionEvent(tx, stage.division_id, "schedule_applied", {
      stageId,
      source: input.source,
      moves,
      // Stamp the runtime model, not the client's constant: SCHEDULING_AI_MODEL
      // can override the model that actually ran, and the run ledger records the
      // truth — so trusting the client's `model` here would misrecord the audit.
      // The client field is still accepted (schema unchanged); it's just ignored.
      ...(input.ai
        ? { ai: { ...input.ai, instruction: input.ai.instruction.trim(), model: schedulingAiModel() } }
        : {}),
    });
    await tx`update divisions set seq = ${seq} where id = ${stage.division_id}`;
    return {
      divisionId: stage.division_id,
      competitionId: stage.competition_id,
      applied: assignments.length,
      skipped,
      conflicts,
      seq,
      // R10d n2: the fixtures this apply wrote, and only those.
      fixtureIds: assignments.map((a) => a.fixture_id),
    };
  });
  if (out.fixtureIds.length > 0) {
    afterScheduleWrite(out.divisionId, out.competitionId, "schedule", out.fixtureIds);
  }
  return { applied: out.applied, skipped: out.skipped, conflicts: out.conflicts, seq: out.seq };
}

/** GET /divisions/{id}/schedule/ai-last — recall the most recent AI-sourced
 *  schedule apply from the division ledger (v4/03 §10) plus the division's
 *  generation budget. `last` is the trimmed instruction + human summary +
 *  apply timestamp, or null when the division has never been AI-scheduled.
 *  `runs.used` counts the same 'schedule.ai_generated' rows the ai-plan
 *  orchestrator writes (failures never appear there); `runs.max` is always
 *  null now — v17 Phase 2 Task 5 (V322) retired the plan-graded per-division
 *  cap it used to resolve, replaced by the AI credit wallet, which meters
 *  spend rather than a per-division count (see `spendCredit` in
 *  schedule-ai/). Read-gated at route. */
export async function lastAiApply(
  auth: AuthCtx,
  divisionId: string,
): Promise<{
  last: { at: string; instruction: string; summary: string } | null;
  runs: { used: number; max: number | null };
}> {
  const { rows, used } = await withTenant(auth.orgId, async (tx) => {
    const rows = await tx<
      { created_at: Date; payload: { ai?: { instruction?: string; summary?: string } } }[]
    >`
      select created_at, payload from division_events
      where division_id = ${divisionId}
        and type = 'schedule_applied'
        and payload->>'source' = 'ai'
      order by seq desc limit 1`;
    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const [count] = await tx<{ n: number }[]>`
      select count(*)::int as n from competition_events
      where competition_id = ${division.competition_id}
        and type = 'schedule.ai_generated'
        and payload->>'division_id' = ${divisionId}`;
    return { rows, used: count?.n ?? 0 };
  });
  const ai = rows[0]?.payload.ai ?? {};
  return {
    last:
      rows.length === 0
        ? null
        : {
            at: iso(ms(rows[0]!.created_at)),
            instruction: ai.instruction ?? "",
            summary: ai.summary ?? "",
          },
    runs: { used, max: null },
  };
}
