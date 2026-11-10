import "server-only";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { SCHEDULE_LOCKED_CODE, SCHEDULE_LOCKED_MESSAGE } from "@/lib/schedule-lock";
import { byeLineSql } from "@/server/engine-db/system-bye-sql";
import { PUBLISH_BLOCKED, PUBLISH_UNACKNOWLEDGED } from "@/lib/schedule-board";
import { appendDivisionEvent } from "@/server/engine-db";
import { captureServer } from "@/lib/posthog-server";
import { competitionLifecycleEvent } from "../competitions";
import type { AuthCtx } from "@/server/api-v1/auth";
import type {
  PublishScheduleRequest,
  ScheduleConflict,
  StartDivisionRequest,
} from "@/server/api-v1/schemas";
import { fireStageRevalidate } from "../stages/helpers";
import { assertNotFrozen, frozenCompetitionIds } from "../entitlement-freeze";
import {
  generateStageFixturesTx,
  generateStageFixturesUnpublished,
  refuseFormatTooSmall,
  refuseSwissRoundsAboveMaxAtStart,
} from "../stages";
import type { Tx } from "./types";
import { MS_PER_MIN, ms, iso, roundToMinute } from "./helpers";
import { afterScheduleWrite } from "./after-write";
import { divisionLockState } from "./board";
import { loadSettings } from "./settings";
import { validateScheduleIn } from "./conflicts";

// ---------------------------------------------------------------------------
// Publish & start (doc 12 §1 state machine)
// ---------------------------------------------------------------------------

export interface PublishScheduleOut {
  division_id: string;
  status: string;
  published: boolean;
}

// The two refusal codes now live in `lib/schedule-board` (isomorphic) so the
// board's confirm dialog can branch on them without importing this module.
// Re-exported unchanged: every server-side importer still reads them here.
export { PUBLISH_BLOCKED, PUBLISH_UNACKNOWLEDGED };

/**
 * Publish refused because the division is already live (owner ruling
 * 2026-09-22 — the reasoning is on the guard itself, in `publishSchedule`).
 *
 * CODED, unlike the `completed` refusal beside it, and deliberately so. That
 * one is uncoded history; this one is a NEW way for a caller to be refused on
 * a public endpoint, and it is the only refusal on this path that names an
 * ordinary, expected state rather than a broken board. A batch publisher has
 * to tell "already live, nothing to do" apart from "this board is broken", and
 * the only alternative is matching on the English message. Not in
 * `lib/schedule-board` with the other two: those live there because the board's
 * confirm dialog branches on them, and the board never sees this one — it
 * hides Publish for a live division (`schedule-board.tsx`).
 */
export const PUBLISH_ALREADY_LIVE = "DIVISION_ALREADY_LIVE";

/**
 * THE GATE, in one place, for the two actions that put a timetable in front of
 * players: publish, and start (which publishes on the way through).
 *
 * Deliberately not two copies of four lines. The publish gate and the start
 * gate must refuse the same boards with the same codes and the same payload —
 * that is what lets ONE confirm dialog in the console serve both buttons — and
 * a second copy is exactly how the placer and the verifier in this subsystem
 * drifted apart three times.
 *
 * It rejects CONFLICTS, never INCOMPLETENESS. `validateAssignments` reports
 * only on rows it is given as `assignments`, and `validateScheduleIn` builds
 * those from fixtures carrying BOTH a `scheduled_at` and a `court_id` — so
 * an empty or half-slotted board yields no assignments and therefore nothing to
 * report. Dozens of suites (and organisers) start divisions in exactly that
 * state; a gate that refused them would be the wrong gate.
 */
function assertPublishable(
  conflicts: readonly ScheduleConflict[],
  acknowledged: boolean,
): void {
  // Blocking is tested FIRST and independently of the flag. Folding the two
  // tests together — or testing the flag first — turns `acknowledge_warnings`
  // into an override for a physically impossible board.
  if (conflicts.some((c) => c.blocking)) {
    throw new HttpError(
      422,
      "this schedule cannot be published: the board has conflicts that must be fixed first",
      PUBLISH_BLOCKED,
      { conflicts },
    );
  }
  if (conflicts.length > 0 && !acknowledged) {
    throw new HttpError(
      422,
      "this schedule has warnings — confirm to publish it anyway",
      PUBLISH_UNACKNOWLEDGED,
      { conflicts },
    );
  }
}

/**
 * Record a publish on the division ledger. Returns the new seq.
 *
 * The report rides the event, so the ledger answers "what did this board look
 * like when it was published" — the question a dispute asks, and the one a count
 * of fixtures could never answer. Greenfield: older events carry
 * `fixturesScheduled` alone and no backfill is owed.
 *
 * Shared by `publishSchedule` and `startDivision` so a publish that happened on
 * the way into `active` is indistinguishable, in the ledger and in
 * `history-panel.tsx`, from one the organiser pressed Publish for.
 */
async function appendPublishedEvent(
  tx: Tx,
  divisionId: string,
  conflicts: readonly ScheduleConflict[],
  acknowledged: boolean,
  reason: string | undefined,
): Promise<number> {
  const [{ n }] = await tx<{ n: number }[]>`
    select count(*)::int as n from fixtures
    where division_id = ${divisionId} and scheduled_at is not null`;
  return appendDivisionEvent(tx, divisionId, "schedule_published", {
    fixturesScheduled: n,
    conflicts,
    acknowledged,
    // Omitted rather than set to `undefined` — the payload is jsonb.
    ...(reason !== undefined ? { reason } : {}),
  });
}

/**
 * Publish the timetable (doc 12 §1.B step 4) — now behind a final validation
 * gate (#230 item 2).
 *
 * The board's conflicts panel is client-side and advisory, so before this gate
 * existed the only thing standing between a broken board and the public schedule
 * was whether the organiser happened to look at the panel recently. A settings
 * change, a new blackout, an entrant withdrawal or a cross-division edit moving
 * a shared court could all invalidate a board between the last look and the
 * publish, and publish counted fixtures with a `scheduled_at` and wrote.
 *
 * Three properties make this a gate rather than a second opinion:
 *
 *  - it runs `validateScheduleIn`, the SAME body the panel's `validateSchedule`
 *    runs. Not a publish-specific check: two validators is how the placer and
 *    the verifier drifted apart, three times.
 *  - it runs INSIDE this transaction and AFTER the advisory lock above, so no
 *    concurrent edit can land between the check and the event.
 *  - it is ABSOLUTE, not delta-based. `applySchedule`'s gate refuses only what a
 *    change introduced, so a dirty board stays editable; publish is the moment
 *    the board goes public, and "it was already broken" is not a reason to
 *    publish it broken.
 */
export async function publishSchedule(
  auth: AuthCtx,
  divisionId: string,
  input: PublishScheduleRequest = {},
): Promise<PublishScheduleOut> {
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  const out = await withTenant(auth.orgId, async (tx) => {
    // THE LOCK FIRST, and the row read UNDER it. Reading the division before
    // taking its lock was a TOCTOU: a division someone pressed Start on in that
    // gap was judged as the `setup`/`scheduled` row it used to be, so the status
    // update below was skipped (it was already past `setup`) while
    // `appendPublishedEvent` ran anyway — a SECOND `schedule_published` row on
    // a division that was already live, reported to the caller as a publish.
    // Nothing needs the row before the lock: `frozen` is org-keyed and resolved
    // above the transaction, and the 404 is no worse for being one statement
    // later. `startDivision` has always re-read inside its own lock; this
    // matches it. Isolation is READ COMMITTED (`withTenant` sets none), so this
    // statement's snapshot includes whatever committed while we waited.
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    const [division] = await tx<{ status: string; competition_id: string }[]>`
      select status, competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    assertNotFrozen(frozen, division.competition_id);
    if (division.status === "completed") {
      throw new HttpError(422, "a completed division cannot publish a schedule");
    }
    // Owner ruling 2026-09-22: a live division cannot publish, refused exactly
    // as a completed one is. Not derivable from the code — the board already
    // hides Publish once a division is active (`schedule-board.tsx`), and past
    // `setup` the public view stops redacting the timetable, so a later change
    // is live the moment it is saved and needs no republish. Publishing a live
    // division therefore achieves nothing but a misleading ledger row. This IS
    // an API behaviour change on a public endpoint, and it is intended:
    // `POST /divisions/{id}/publish-schedule` now 422s on `active` where it
    // used to answer `published: true` and write that row. `scheduled` is
    // untouched — republishing a timetable that has not started is the normal
    // path, not the race.
    if (division.status === "active") {
      throw new HttpError(
        422,
        "a division that has already started cannot publish a schedule",
        PUBLISH_ALREADY_LIVE,
      );
    }

    // THE GATE. After the lock, before anything is written.
    const { conflicts } = await validateScheduleIn(tx, divisionId, division.competition_id);
    const acknowledged = input.acknowledge_warnings === true;
    assertPublishable(conflicts, acknowledged);

    const status = division.status === "setup" ? "scheduled" : division.status;
    if (status !== division.status) {
      await tx`update divisions set status = ${status} where id = ${divisionId}`;
    }
    const seq = await appendPublishedEvent(tx, divisionId, conflicts, acknowledged, input.reason);
    await tx`update divisions set seq = ${seq} where id = ${divisionId}`;
    // R10d n2: a publish moves no single fixture, so every public fixture
    // document of the division drops with the hub key.
    const fixtures = await tx<{ id: string }[]>`select id from fixtures where division_id = ${divisionId}`;
    return { competitionId: division.competition_id, status, fixtureIds: fixtures.map((f) => f.id) };
  });
  afterScheduleWrite(divisionId, out.competitionId, "publish", out.fixtureIds);
  return { division_id: divisionId, status: out.status, published: true };
}

export interface StartDivisionOut {
  division_id: string;
  status: string;
  started: boolean;
  generated: number;
}

/**
 * The "start tournament" action (doc 12 §1 — both modes end here). Quick-start
 * from setup generates the first stage's fixtures when none exist and, when
 * `roundMinutes` is configured, slots rolling times (round r at startAt +
 * (r−1)·roundMinutes). Scoring opens only after this (division_started).
 *
 * **Starting the tournament publishes the schedule** (#230 item 2 follow-up).
 * Not a second gate — the same one: `assertPublishable` over
 * `validateScheduleIn`, the same two codes, the same `acknowledge_warnings`
 * contract, so the console's confirm dialog serves Publish and Start with one
 * code path. Without this, the publish gate was a door beside an open window:
 * an organiser refused at Publish could press Start, `scoring.ts` opens scoring
 * on `active`, and the same broken timetable went live with nothing in the
 * ledger to say a publish had ever happened.
 *
 * Two orderings inside are load-bearing:
 *
 *  - the check runs AFTER the quick-start rolling-times write, in the same
 *    transaction. Before it, the board being judged does not exist yet — and a
 *    refusal rolls those times back with it, so a rejected start never leaves a
 *    half-slotted board behind.
 *  - `schedule_published` is appended BEFORE the status moves to `active`, and
 *    only when the division was still `setup`. `scheduled → active` is a start,
 *    not a second publish.
 */
export async function startDivision(
  auth: AuthCtx,
  divisionId: string,
  input: StartDivisionRequest = {},
): Promise<StartDivisionOut> {
  // Resolved BEFORE the transaction: the lookup queries the POOLED `sql` proxy
  // (`getLimit`), and `withTenant` pins a pooled connection for its whole
  // callback — see entitlement-freeze.ts. The set is keyed on the ORG, so it
  // needs no id the transaction has not read yet, and `assertNotFrozen` is pure.
  const frozen = await frozenCompetitionIds(auth.orgId);
  const pre = await withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ status: string; competition_id: string }[]>`
      select status, competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    assertNotFrozen(frozen, division.competition_id);
    if (division.status === "completed") throw new HttpError(422, "division is completed");
    // W4 B2 fix round 1 (G1): `roster_drift` — a ROOT knockout (no progression, no fed `qualified` list) whose first round no
    // longer matches the field: an active entrant in no first-round seat, a seated one no longer active, a match with an
    // empty seat (its entrant was deleted), or a bye with nobody on it (its holder was deleted). Only then does Start
    // reconcile: a bracket whose roster is unchanged is never redrawn here, whatever else changed since it was drawn.
    const [firstStage] = await tx<{ id: string; n: number; roster_drift: boolean }[]>`
      select s.id, (select count(*)::int from fixtures f where f.stage_id = s.id) as n,
             (s.kind = 'knockout' and s.progression is null
               and jsonb_typeof(s.config->'qualified') is distinct from 'array'
               and (exists (select 1 from entrants e
                             where e.division_id = s.division_id and e.status in ('registered', 'confirmed')
                               and not exists (select 1 from fixtures f
                                                where f.stage_id = s.id and f.round_no = 1
                                                  and e.id in (f.home_entrant_id, f.away_entrant_id)))
                 or exists (select 1 from fixtures f join entrants e on e.id in (f.home_entrant_id, f.away_entrant_id)
                             where f.stage_id = s.id and f.round_no = 1 and e.status not in ('registered', 'confirmed'))
                 or exists (select 1 from fixtures f
                             where f.stage_id = s.id and f.round_no = 1
                               and ((f.status = 'scheduled' and (f.home_entrant_id is null or f.away_entrant_id is null))
                                    or (f.home_entrant_id is null and f.away_entrant_id is null))))) as roster_drift
      from stages s where s.division_id = ${divisionId}
      order by s.seq limit 1`;
    if (!firstStage) throw new HttpError(422, "division has no stages to start");
    // W3 T11 (X-SW-16): a Swiss above its field's hard maximum is refused here, before Start's first write (the
    // quick-start Generate below runs in its own transaction). A withdrawal racing past this read is caught by the Pair's
    // own judgement (`swissGen`), which every Generate runs. An active division's Start is a no-op, never refused.
    if (division.status !== "active") await refuseSwissRoundsAboveMaxAtStart(tx, divisionId);
    // W4 T15 (X-PL-1, X-QM-5): a format this field cannot play is refused here, not after a whole qualifying stage is played.
    if (division.status !== "active") await refuseFormatTooSmall(tx, divisionId);
    // Read here, ACTED ON below — see the two guards further down. The freeze
    // does not bind the start TRANSITION (that is deliberate: the design's own
    // customer story is freeze-then-publish, and `schedule-board.tsx` gates its
    // publish/start block on status while the freeze toggle fifteen lines above
    // reads `single.schedule_locked` — same component, same variable in scope,
    // different condition). It binds the two SCHEDULE WRITES this function can
    // make on the way through.
    return { ...division, firstStage, scheduleFrozen: (await divisionLockState(tx, divisionId)).frozen };
  });
  if (pre.status === "active") {
    return { division_id: divisionId, status: "active", started: false, generated: 0 };
  }

  // Quick-start: generate outside the status transaction (the generator takes
  // its own division lock).
  let generated = 0;
  if (pre.firstStage.n === 0) {
    // A start that GENERATES a stage's fixtures is creating the timetable, not
    // merely opening scoring on one — the widest schedule write in this
    // function. Refused on a frozen board, and refused HERE rather than at the
    // top of the function, so a start that generates nothing is untouched: the
    // freeze binds edits, and starting an already-built frozen board is the
    // intended path (see the pre-flight read above).
    if (pre.scheduleFrozen) {
      throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
    }
    // R10e: unpublished — this start publishes ONE write below, naming every
    // fixture of the division, the generated ones included.
    const outcome = await generateStageFixturesUnpublished(auth, pre.firstStage.id);
    generated = outcome.created;
  } else if (pre.firstStage.roster_drift && !pre.scheduleFrozen) {
    // W4 B2 fix round 1 (G1): a pre-Start withdrawal is a status flip only (withdrawal.ts) and an arrival seats nobody,
    // so a root knockout drawn before them still names a withdrawn player on a match, or leaves a newcomer out. Start is
    // the last moment before play: when the first round no longer matches the field (`roster_drift`, read above) it runs
    // the reconcile Generate does (stages/generate-tx.ts `reconcileKnockoutGenerate`) — IN PLACE ONLY (fix round 2, item 2): a
    // newcomer into a bye, a departed entrant's match to a bye. A change that needs the bracket drawn again is refused by
    // name, KO_START_NEEDS_UPDATE_DRAW, and the start with it, before any write: the redraw is Update draw's, whose notice
    // says what moved. So Start deletes no fixture, and its one publish below names every fixture there is. A frozen
    // board is handled by the frozen branch below.
    const outcome = await generateStageFixturesUnpublished(auth, pre.firstStage.id, { inPlaceOnly: true });
    generated = outcome.created;
  }
  // W4 app B, Task 20 (C27; PO ruling, logged): a FROZEN board with a drifted root knockout - the reconcile runs INSIDE the status
  // transaction below (review I1), so a Start refused anywhere after it leaves no waiting mark and no seat change behind.
  const frozenDrift = pre.firstStage.n > 0 && pre.firstStage.roster_drift && pre.scheduleFrozen;

  const out = await withTenant(auth.orgId, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"division:" + divisionId}))`;
    const [division] = await tx<{ status: string; competition_id: string }[]>`
      select status, competition_id from divisions where id = ${divisionId}`;
    // R10d n2: a start moves no single fixture (it may generate the first stage
    // and write rolling times across it), so every public fixture document of
    // the division drops with the hub key. Read under the lock, after generation.
    const fixtureIds = (
      await tx<{ id: string }[]>`select id from fixtures where division_id = ${divisionId}`
    ).map((f) => f.id);
    if (!division || division.status === "active") {
      return { started: false, fixtureIds, competitionPromoted: false };
    }

    // Placing a newcomer is a schedule write the freeze binds, so Start MARKS them waiting instead (`entrants.knockout_waiting_stage_id`,
    // as the late-entry path marks an arrival - the desk counts them and the organiser's tap places them once the board is open) and
    // never refuses on their account. A departed entrant is reconciled as on any board (in place; a redraw-needing change is refused by
    // name, KO_START_NEEDS_UPDATE_DRAW_FROZEN). Runs on `generateStageFixturesTx`, NOT `generateStageFixturesUnpublished`: that entry's
    // pre-flight refuses a frozen division wholesale.
    if (frozenDrift) {
      await generateStageFixturesTx(tx, auth, pre.firstStage.id, { inPlaceOnly: true, waitNewcomers: true });
    }

    // Rolling quick-start times (doc 12 §1.A) — only for a straight
    // setup→active start; a published timetable is left untouched.
    const settings = await loadSettings(tx, divisionId);
    if (division.status === "setup" && settings.config.roundMinutes) {
      const startAt = settings.config.startAt
        ? ms(settings.config.startAt)
        : roundToMinute(Date.now());
      const step = settings.config.roundMinutes * MS_PER_MIN;
      // A bye line takes no rolling time: a bye is not played — a Swiss bye shell (W3 T3, X-SW-29) and a bracket's
      // bye, which a plain knockout bakes `forfeited` at generation (W4 T3, K2, X-SD-5), alike (`byeLineSql`).
      const rounds = await tx<{ round_no: number }[]>`
        select distinct round_no from fixtures
        where stage_id = ${pre.firstStage.id} and scheduled_at is null and not ${byeLineSql(tx, "fixtures")}
        order by round_no`;
      // The sweep below writes `scheduled_at` across the first stage, which is
      // a schedule edit whatever door it came through — so a frozen board
      // refuses it. Gated on `rounds.length`, not on reaching this branch: a
      // frozen division whose fixtures are already slotted has NOTHING for
      // this loop to write, and refusing it would break freeze-then-start for
      // no gain. Re-read inside THIS transaction rather than trusting the
      // pre-flight value, because this is where the write happens.
      if (rounds.length > 0 && (await divisionLockState(tx, divisionId)).frozen) {
        throw new HttpError(422, SCHEDULE_LOCKED_MESSAGE, SCHEDULE_LOCKED_CODE);
      }
      for (const [i, r] of rounds.entries()) {
        await tx`
          update fixtures set scheduled_at = ${iso(startAt + i * step)}, schedule_source = 'auto'
          where stage_id = ${pre.firstStage.id} and round_no = ${r.round_no}
            and scheduled_at is null and not ${byeLineSql(tx, "fixtures")}`;
      }
    }

    // THE GATE — the publish gate, reached by the other door. After the lock and
    // after the rolling-times write above, so it judges the board this call is
    // actually about to open scoring on.
    const { conflicts } = await validateScheduleIn(tx, divisionId, division.competition_id);
    const acknowledged = input.acknowledge_warnings === true;
    assertPublishable(conflicts, acknowledged);

    // Published on the way through, from `setup` only: this is the moment the
    // timetable goes in front of players, and the event is the only record
    // anywhere that it did (`history-panel.tsx` renders it).
    if (division.status === "setup") {
      await appendPublishedEvent(tx, divisionId, conflicts, acknowledged, input.reason);
    }

    await tx`update divisions set status = 'active' where id = ${divisionId}`;
    const seq = await appendDivisionEvent(tx, divisionId, "division_started", {
      from: division.status,
    });
    await tx`update divisions set seq = ${seq} where id = ${divisionId}`;

    // Owner ruling 2026-09-20: play has started, so the parent competition is
    // `live` — the column is not maintained by the competition PATCH alone.
    //
    // Upward-only and NARROW, and the narrowness is the point. `draft` is left
    // alone: PUBLIC_DASHBOARD_STATUSES is ["published", "live"], so promoting
    // a draft would PUBLISH a competition nobody published — a visibility
    // change as a side effect of starting a division. `completed`/`archived`
    // are left alone in the other direction: restarting a division inside a
    // wrapped-up competition must not reopen it.
    //
    // The guard is the `where`, not a read-then-write in JS, so a concurrent
    // PATCH cannot lose a race with it — the house idiom (stages/ folder's
    // `update divisions set status = 'active' where id = … and status =
    // 'completed'` reopen, and fillSlot's `… and home_entrant_id is null
    // returning id`). `returning` reports whether THIS call made the
    // transition, so the analytics event below fires on the transition only
    // and never on the state.
    const [promoted] = await tx<{ id: string }[]>`
      update competitions set status = 'live'
      where id = ${division.competition_id} and status = 'published'
      returning id`;
    return { started: true, fixtureIds, competitionPromoted: !!promoted };
  });
  afterScheduleWrite(divisionId, pre.competition_id, "start", out.fixtureIds);
  // Review m2: the unfrozen branch's Generate revalidates the stage; so does the frozen one, once its write has committed.
  if (frozenDrift && out.started) await fireStageRevalidate(auth.orgId, pre.firstStage.id);
  // Outside the transaction, mirroring the competition PATCH's own lifecycle
  // block (competitions.ts) — analytics never rolls back the write it rides
  // on. Routed through `competitionLifecycleEvent` rather than naming the
  // event here so the two callers cannot drift: a status change without its
  // event would leave the column looking maintained while the signal stayed
  // missing.
  if (out.competitionPromoted) {
    const lifecycleEvent = competitionLifecycleEvent("live");
    if (lifecycleEvent) {
      await captureServer({
        event: lifecycleEvent,
        distinctId: auth.userId ?? `org:${auth.orgId}`,
        orgId: auth.orgId,
        properties: { competition_id: pre.competition_id },
      });
    }
  }
  return { division_id: divisionId, status: "active", started: out.started, generated };
}
