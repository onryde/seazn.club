import "server-only";
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { REASON_CODE } from "@/lib/schedule-board";
import { EngineError } from "@seazn/engine/core";
import {
  deltaConflicts,
  isBlockingConflict,
  validateAssignments,
  type Conflict,
  type ConflictDetail,
} from "@seazn/engine/scheduling";
import { legacyConflictDetail } from "@/server/api-v1/conflict-detail-legacy";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { ScheduleConflict } from "@/server/api-v1/schemas";
import {
  requiredCourtTagsByFixture,
  resolveCandidateCourts,
  resolveCourtCalendars,
  strandedCourtIdsForDivision,
  tagQualifiedCourtIdsByFixture,
} from "../court-candidates";
import type { Tx } from "./types";
import { divisionFixtures, courtNamesById, peopleByEntrant } from "./board";
import { loadSettings } from "./settings";
import { roundRobinStageIds } from "./rounds";
import {
  toAssignment,
  feedDependencies,
  siblingAssignments,
  toVerifyConfig,
} from "./engine-inputs";

// ---------------------------------------------------------------------------
// Conflict taxonomy (doc 12 §2) — engine reasons → API codes. REASON_CODE is
// the single shared table in lib/schedule-board (isomorphic), so the AI diff
// panel maps blocking-row reasons through the exact same map client-side.
// ---------------------------------------------------------------------------

/**
 * `blocking` means PHYSICALLY IMPOSSIBLE, on every path (#399) — a court booked
 * twice, a human on two courts at once, a slot outside the competition's days, a
 * fixture before its feeder is done resting. It is the engine's one answer
 * (`isBlockingConflict`), so the board's red badges and the AI pipeline's
 * verdicts cannot drift apart the way they had.
 *
 * It deliberately does NOT mean "this write was refused". That is the DELTA, and
 * it lives in `assertNoNewBlocking` below. Folding the two together made a
 * report of an impossible board come back entirely in amber, because nothing in
 * a read-only report is ever newly introduced.
 */
/** `ConflictDetail`'s camelCase fields, snake_cased for the wire — the same
 *  casing `ScheduleConflict` uses throughout (`fixture_id`,
 *  `shortfall_minutes`). A plain rename, nothing derived; conditional spreads
 *  throughout so an absent field stays ABSENT rather than a present `undefined`
 *  (`mapConflicts`' own established idiom, just below). */
function toWireConflictDetail(d: ConflictDetail): NonNullable<ScheduleConflict["details"]> {
  return {
    kind: d.kind,
    ...(d.entrantIds !== undefined ? { entrant_ids: d.entrantIds } : {}),
    ...(d.personIds !== undefined ? { person_ids: d.personIds } : {}),
    ...(d.otherFixtureId !== undefined ? { other_fixture_id: d.otherFixtureId } : {}),
    ...(d.court !== undefined ? { court: d.court } : {}),
    // P9 pass 3a: reads `courtName` already resolved onto `d` by
    // `mapConflicts` below — this function itself does no db lookup.
    ...(d.courtName !== undefined ? { court_name: d.courtName } : {}),
    ...(d.day !== undefined ? { day: d.day } : {}),
    ...(d.otherDay !== undefined ? { other_day: d.otherDay } : {}),
    ...(d.weekday !== undefined ? { weekday: d.weekday } : {}),
    ...(d.requiredWeekday !== undefined ? { required_weekday: d.requiredWeekday } : {}),
    ...(d.requiredDate !== undefined ? { required_date: d.requiredDate } : {}),
    ...(d.time !== undefined ? { time: d.time } : {}),
    ...(d.requiredTime !== undefined ? { required_time: d.requiredTime } : {}),
    ...(d.ruleType !== undefined ? { rule_type: d.ruleType } : {}),
    ...(d.roundNo !== undefined ? { round_no: d.roundNo } : {}),
    ...(d.otherRoundNo !== undefined ? { other_round_no: d.otherRoundNo } : {}),
    ...(d.minutes !== undefined ? { minutes: d.minutes } : {}),
    ...(d.requiredMinutes !== undefined ? { required_minutes: d.requiredMinutes } : {}),
    ...(d.count !== undefined ? { count: d.count } : {}),
    ...(d.requiredCount !== undefined ? { required_count: d.requiredCount } : {}),
  };
}

/**
 * `court` on a `ConflictDetail` (P9 pass 3a) is a real `courts.id` now —
 * `court_double_booking`, `locked_slot_clash`, and `court_tag_mismatch`
 * (P9 pass 2c) are the three kinds that set it (via `Assignment.court`,
 * `toAssignment`'s own comment). `courtNames` is required, not defaulted,
 * so a caller cannot forget to resolve it and
 * silently ship a bare uuid in `details.court_name` / the legacy prose —
 * every call site below fetches it once (cheap: `select id, name from
 * courts`, RLS-scoped) and threads it through.
 *
 * Resolves onto a CLONE of `details` — the engine's own `Conflict[]` is
 * never mutated — via the engine's `ConflictDetail.courtName` field (see
 * its own doc comment): `legacyConflictDetail` is a pure function that
 * takes no second argument, so this is the one place a resolved name can
 * reach it.
 */
/** Attach the derived, venue-qualified court name to a conflict's details.
 *  Exported (review wave 3) so the AI-plan and joint-apply paths resolve
 *  identically instead of shipping a raw uuid to the organiser. */
export function withCourtNames(details: ConflictDetail, courtNames: ReadonlyMap<string, string>): ConflictDetail {
  if (details.court === undefined) return details;
  const courtName = courtNames.get(details.court);
  return courtName !== undefined ? { ...details, courtName } : details;
}

export function mapConflicts(
  conflicts: readonly Conflict[],
  courtNames: ReadonlyMap<string, string>,
): ScheduleConflict[] {
  return conflicts.map((c) => {
    const details = c.details !== undefined ? withCourtNames(c.details, courtNames) : c.details;
    return {
      fixture_id: c.fixtureId,
      code: REASON_CODE[c.reason],
      // The rule the prompt teaches, carried through so the organiser's 409 and a
      // repair round cite the same token (#399).
      ...(c.rule !== undefined ? { rule: c.rule } : {}),
      ...(c.shortfallMinutes !== undefined ? { shortfall_minutes: c.shortfallMinutes } : {}),
      ...(c.measuredCount !== undefined ? { measured_count: c.measuredCount } : {}),
      blocking: isBlockingConflict(c),
      // Structured (additive) and the deprecated derived English (back-compat,
      // C3 2026-08-13 design amendment) — both from the SAME `details`, so they
      // can never disagree. Omitted together: a `Conflict` the engine built
      // without a `details` entry gets neither, same as it got no `detail`
      // before this wave.
      ...(details !== undefined
        ? { details: toWireConflictDetail(details), detail: legacyConflictDetail(details) }
        : {}),
    };
  });
}

/**
 * The write gate (#399). Refuses only what THIS change introduced or worsened,
 * measured by running the identical verifier pass over the board as it stands
 * and taking the difference on conflict identity.
 *
 * Delta rather than absolute, because boards published before this wave may
 * legitimately carry person overlaps — they were warnings all along. Under an
 * absolute rule the organiser's next edit to such a board would 409 and they
 * would be stuck, unable to fix the very thing that is wrong.
 */
export function assertNoNewBlocking(
  before: readonly Conflict[],
  after: readonly Conflict[],
  courtNames: ReadonlyMap<string, string>,
): void {
  const refused = deltaConflicts(before, after).filter(isBlockingConflict);
  if (refused.length > 0) {
    throw new EngineError("SCHEDULE_CONFLICT", "schedule change hits a blocking conflict", {
      conflicts: mapConflicts(refused, courtNames),
    });
  }
}

// ---------------------------------------------------------------------------
// Validate (full board report — doc 12 §4)
// ---------------------------------------------------------------------------

/**
 * The full-board report, inside a transaction the CALLER owns (#230 item 2).
 *
 * Extracted from `validateSchedule` so the publish gate can run the identical
 * pass inside its own transaction, after its advisory lock, rather than growing
 * a second validation implementation. The placer/verifier fork is the recurring
 * defect in this subsystem — it has been re-derived three times — and "publish
 * sees exactly what the panel sees" is only a fact while there is ONE body here.
 *
 * `competitionId` is a parameter rather than a re-read: both callers have
 * already selected the division row, and re-selecting it inside would make the
 * gate's view of the world one statement newer than the lock's.
 *
 * THE OFFICIALS SQL BUCKETS ON `settings.orgTz`, NOT `settings.displayTz`.
 * "Which calendar day is this fixture on" is day math, and day math runs on the
 * governing clock (#397; and `ScheduleSettingsOut` says of `displayTz` in as
 * many words: "DISPLAY ONLY. Never use it to decide which calendar day something
 * is on"). The two diverge exactly when a division carries the V305 venue
 * override — `displayTz` is division → org → UTC, `orgTz` is org → UTC — and a
 * blackout is an ORG-level record, one row per official per date, shared by
 * every division they work; bucketing it per-division made one date mean two
 * different days inside one competition. Concretely: org Europe/London,
 * division America/New_York, fixture 02:00Z on 10 Aug. The display lane files
 * it under the 9th, so a blackout on the 10th raises nothing and one on the 9th
 * raises a phantom. Pre-existing, but #230 item 2 promoted this warning from an
 * advisory badge to a PUBLISH-GATE input, so both directions now cost the
 * organiser something: a missed acknowledge step, or a spurious one.
 * Pinned by `schedule-officials-day-zone.test.ts`, on a fixture where the two
 * zones disagree — one where they agree passes under either spelling.
 */
export async function validateScheduleIn(
  tx: Tx,
  divisionId: string,
  competitionId: string,
): Promise<{ conflicts: ScheduleConflict[] }> {
  const settings = await loadSettings(tx, divisionId);
  const all = await divisionFixtures(tx, divisionId);
  const entrantIds = [
    ...new Set(all.flatMap((f) => [f.home_entrant_id, f.away_entrant_id])),
  ].filter((e): e is string => e !== null);
  const people = await peopleByEntrant(tx, entrantIds);
  // P9 pass 2b: court identity through the SAME resolveCandidateCourts the
  // build side calls — never a second, inlined tag-filter loop here. This
  // half stays DIVISION-scoped only: `settingsForEngine.config.courts` below
  // is dead weight for THIS path (`validateAssignments` has never read
  // `.courts` — the next comment), so there is nothing here for a stage's
  // own tags to usefully narrow. (Review finding #11: the OTHER half,
  // `courtTagQualifiedIds` below, DOES need the stage union — see that
  // comment.) And, deliberately, no guardNoMatchingCourt: this reports on a
  // board that may already EXIST, and an assignment sitting on a
  // since-archived or since-retagged court must keep validating clean
  // (ruling 3, candidate-courts.ts) — see court-candidates.ts's own doc
  // comment on guardNoMatchingCourt for why calling it here would be wrong,
  // not merely unnecessary.
  const [divisionForCourts] = await tx<{ required_court_tags: string[] }[]>`
    select required_court_tags from divisions where id = ${divisionId}`;
  const requiredCourtTags = divisionForCourts?.required_court_tags ?? [];
  const candidateCourtIds = await resolveCandidateCourts(
    tx,
    divisionId,
    settings.config.courts,
    requiredCourtTags,
  );
  const settingsForEngine = {
    ...settings,
    config: { ...settings.config, courts: [...candidateCourtIds.ids] },
  };
  // P9.5: the SAME loader the build path calls, so the lattice and this
  // verifier cannot be handed different opening hours — the placer/verifier
  // fork court-candidates.ts's header opens by warning about, now for the
  // court's calendar rather than its tags. Scoped to candidate ids for the
  // archived-court reason spelled out on the build side.
  const courtCalendars = await resolveCourtCalendars(tx, candidateCourtIds.ids);
  // P10 (A6/§1): this division's OWN assigned courts — never candidateCourtIds
  // here either, for the identical archived-court reason spelled out just
  // above: an archived court is already excluded from that set, so reusing it
  // would make the stranded-fixture conflict impossible to ever report.
  const strandedCourtIds = await strandedCourtIdsForDivision(
    tx,
    divisionId,
    [...new Set(all.map((f) => f.court_id).filter((c): c is string => c !== null))],
  );
  // P9 pass 2c: gives the VERIFIER a real consumer for the same constraint —
  // `candidateCourtIds` above (tag+archived filtered) becomes the new
  // `config.courts`, but `validateAssignments` has never read `.courts`
  // (this file's own false-premise history: candidate awareness on the
  // verify side was new plumbing, not a refactor). Deliberately a SEPARATE
  // resolution, not a reuse of `candidateCourtIds.ids`: that set already
  // excludes archived courts, and reusing it for the mismatch conflict would
  // retroactively red an assignment sitting on a since-archived court —
  // exactly what ruling 3 (candidate-courts.ts) forbids. See
  // `resolveTagQualifiedCourtIds`'s own doc comment for the archived-neutral
  // mechanics.
  //
  // Review finding #11 -> #622. This used to resolve against
  // `requiredCourtTags` alone (the DIVISION's tags), which made a
  // stage-level tag invisible to the verifier while `autoSchedule` honoured
  // it. #11 closed that with the closest safe approximation available at the
  // time: resolve once per STAGE and merge the QUALIFIED COURT SETS, so a
  // court qualifies board-wide if it satisfies ANY stage actually present.
  // Its own comment recorded why the required-tag LISTS could not simply be
  // flattened instead (`candidateCourts` reads a list as AND, so combining
  // two stages' tags demands a court carry tags from a stage a given fixture
  // has nothing to do with).
  //
  // #622 replaces the approximation with the exact answer, because a third
  // scope made the approximation's error reachable rather than merely
  // theoretical: with round-scoped tags, the union across stages ALSO unions
  // across rounds, so the championship court the final requires would satisfy
  // every quarter-final too and the conflict would never fire. The resolution
  // unit is the fixture, through the same shared pair `autoSchedule` and
  // `buildSchedulePack` use.
  //
  // `courtTagQualifiedIds` (the flat, division-wide list) is still sent
  // alongside as the fallback for any assignment whose fixture is not in the
  // map — an obstacle from another division, or a row for a fixture deleted
  // between the two reads. `validateAssignments` prefers the per-fixture
  // entry and falls back to the flat one; see its own doc comment.
  const fixtureTags = await requiredCourtTagsByFixture(tx, divisionId, requiredCourtTags);
  // #622 review (finding #9): the flat, division-wide fallback set used to be
  // its own separate `resolveTagQualifiedCourtIds` call — a third DB scan that,
  // for the overwhelmingly common case (no fixture's own stage/round narrows
  // beyond the division), re-resolved a tag union `tagQualifiedCourtIdsByFixture`
  // below already resolves and memoises for every fixture with no narrowing of
  // its own (`requiredCourtTagsByFixture`'s `unionRequiredCourtTags(divisionTags,
  // stageTags)` with an empty `stageTags` IS `requiredCourtTags`). A sentinel key
  // that cannot collide with a fixture uuid rides through the SAME memoised
  // resolver so the flat set costs nothing extra when a fixture already shares
  // its tag union, and still resolves independently on the rare board where
  // every fixture's own scope narrows past it.
  const FLAT_FALLBACK_KEY = "__division_flat__";
  const tagsForResolve = new Map(fixtureTags);
  tagsForResolve.set(FLAT_FALLBACK_KEY, requiredCourtTags);
  const qualifiedByFixtureAndFlat = await tagQualifiedCourtIdsByFixture(tx, tagsForResolve);
  const courtTagQualifiedIds = new Set<string>(qualifiedByFixtureAndFlat.get(FLAT_FALLBACK_KEY)!);
  const courtTagQualifiedIdsByFixture = new Map(qualifiedByFixtureAndFlat);
  courtTagQualifiedIdsByFixture.delete(FLAT_FALLBACK_KEY);
  // C1 follow-up (2026-08-12, task 3 / G1). This function backs BOTH
  // `validateSchedule` (the board's live conflict report) and, through
  // `assertPublishable`, `publishSchedule`/`startDivision` — the write gate.
  // Its own `toAssignment` call used to run with no `roundRobinStageIds` 4th
  // argument, so `roundNo` never reached the `Assignment`s handed to
  // `validateAssignments` below: round order was structurally invisible to
  // both the panel's badges and the publish/start gate, regardless of what
  // the board actually looked like — a round-robin division could publish or
  // start with a genuine round-order violation and nothing would show it.
  // Wired the same way `autoSchedule`/`applySchedule`/`reverifyBoards`
  // already are (`schedule/` folder's own reference wiring; `person-merge.ts`).
  const roundRobin = await roundRobinStageIds(tx, divisionId, settings);
  const assignments = all
    .filter((f) => f.scheduled_at !== null && f.court_id !== null)
    .map((f) => toAssignment(f, settings.config.matchMinutes, people, roundRobin));
  // P9 pass 3a — the same resolve every mapConflicts call needs.
  const courtNames = await courtNamesById(tx);
  const siblings = await siblingAssignments(
    tx,
    divisionId,
    competitionId,
    settings.config.matchMinutes,
  );
  const officialConflicts = await tx<{ fixture_id: string; code: string }[]>`
    -- declined: any assigned official said no
    select fo.fixture_id, 'warn.official_declined' as code
    from fixture_officials fo
    join fixtures f on f.id = fo.fixture_id
    where f.division_id = ${divisionId} and fo.response = 'declined'
    union
    -- unavailable: an accepted/pending official is blacked out on the
    -- fixture's calendar day, i.e. a schedule clash
    select fo.fixture_id, 'warn.official_unavailable' as code
    from fixture_officials fo
    join fixtures f on f.id = fo.fixture_id
    join officials o on o.id = fo.official_id
    join official_availability oa on oa.official_id = o.id
    where f.division_id = ${divisionId}
      and fo.response in ('accepted','pending')
      and f.scheduled_at is not null
      -- orgTz, NOT displayTz. See the long note above this function.
      -- (Backticks are banned in here: this is a tagged template.)
      and oa.date = (f.scheduled_at at time zone ${settings.orgTz})::date`;

  // A REPORT of the board as it stands. `blocking` here says "impossible", not
  // "refused" (#399) — the board paints those cards red, and it must keep
  // doing so for a court double-booking that is already on the timetable.
  // Nothing is written on this path, so no delta applies.
  return {
    conflicts: [
      ...mapConflicts(
        // #447: `toVerifyConfig`, so the board's own report shows the durable
        // typed rules the organiser stored — this is the surface the
        // constraints panel promises them on.
        validateAssignments(
          assignments,
          // P9 pass 2c: `courtTagQualifiedIds` is the one field
          // `toVerifyConfig` itself never sets (every OTHER caller of this
          // engine function omits it and keeps exactly today's behaviour —
          // calendar.ts's own comment on the field) — spread on at this ONE
          // call site rather than threaded through `toVerifyConfig`'s
          // parameter list, which would touch its other three callers
          // (autoSchedule, the AI planning path, every test in this
          // package) for a question only THIS path asks.
          {
            ...toVerifyConfig(
              settingsForEngine,
              all,
              0,
              siblings.ruleFixtures,
              courtCalendars,
              strandedCourtIds,
            ),
            courtTagQualifiedIds: [...courtTagQualifiedIds],
            // #622 — the per-fixture override. Both are sent: the map is the
            // exact answer for this division's own fixtures, the flat list is
            // what any OTHER row falls back to.
            courtTagQualifiedIdsByFixture,
          },
          siblings.assignments,
          feedDependencies(all),
        ),
        courtNames,
      ),
      ...officialConflicts.map((c) => ({ fixture_id: c.fixture_id, code: c.code as ScheduleConflict["code"], blocking: false })),
    ],
  };
}

export async function validateSchedule(
  auth: AuthCtx,
  divisionId: string,
): Promise<{ conflicts: ScheduleConflict[] }> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    return validateScheduleIn(tx, divisionId, division.competition_id);
  });
}
