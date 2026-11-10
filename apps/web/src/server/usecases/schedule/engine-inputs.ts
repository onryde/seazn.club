import "server-only";
import { isSwissByeShellExtKey } from "@/lib/swiss-shell";
import {
  dayKeyInTz,
  ymdAddDays,
  zonedTimeToUtc,
  type Assignment,
  type CourtCalendar,
  type OrderDependency,
  type RuleFixture,
  type SlotConfig,
  type VerifyConfig,
} from "@seazn/engine/scheduling";
import { ScheduleConfig } from "@/server/api-v1/schemas";
import { courtCalendarsForDivision, strandedCourtIdsForDivision } from "../court-candidates";
import { buildEngineConstraints } from "../engine-constraints";
import { toRuleFixture } from "../schedule-ai";
import type { Tx, ScheduleSettingsOut, FixtureLite, RoundSequenceStages } from "./types";
import { MS_PER_MIN, ms } from "./helpers";
import { OCCUPYING, FIXTURE_LITE_COLS, peopleByEntrant, peopleOf } from "./board";
import { roundFieldsOf } from "./rounds";

// ---------------------------------------------------------------------------
// Engine input assembly
// ---------------------------------------------------------------------------

/** A DB fixture row as the engine's `Assignment`.
 *
 *  `poolId`/`divisionId` are stamped (#446). They are not decoration: the
 *  verifier resolves a pool- or division-targeted `restByGroup` and
 *  `startWindows` entry off exactly these two fields
 *  (`effectiveRestMinutes`/`startWindowFor`), and the placer resolves the same
 *  rules off the twin fields on `SchedulableFixture` (built at :523 from the
 *  same row). Dropping them here is what made a pool rule bind for
 *  Auto-schedule and evaporate the moment an organiser dragged a card.
 *
 *  Optionality follows the `SchedulableFixture` builder exactly: `division_id`
 *  is NOT NULL so it is always stamped; `pool_id` is nullable and the key is
 *  omitted rather than set to `undefined`, because `Assignment.poolId` is an
 *  optional string and the verifier tests it with `!== undefined`.
 *
 *  `movable` (C1, 2026-08-12 round-order design) is `!f.schedule_locked` —
 *  the established "pinned" predicate this codebase already uses
 *  (`clearableFixtures`'s own `locked: f.schedule_locked`, the COURT-REMOVAL
 *  GUARD above). Always stamped, unconditionally: `Assignment.movable`
 *  defaults to `true` when absent, so this is a safe no-op for the
 *  round-order pair scan on its own, and it matches `divisionId`'s own
 *  always-present convention (`schedule_locked` is NOT NULL, same as
 *  `division_id`).
 *
 *  `roundNo` is gated on `roundRobinStageIds`, an OPTIONAL 4th parameter —
 *  not read unconditionally off `f.round_no` the way `movable` reads off
 *  `f.schedule_locked`, because `fixtures.round_no` is one shared column
 *  populated for EVERY stage kind (bracket rounds and stepladder legs reuse
 *  it for display), and forwarding it for a stage outside the round-sequence
 *  set (league, group, swiss — `ROUND_SEQUENCE_STAGE_KINDS`) would compare
 *  two independent round sequences as if they were one
 *  — the design doc's own motivating symptom. Omitted (not `undefined`)
 *  when the parameter itself is omitted: a caller that does not pass it
 *  keeps the pre-C1 behaviour, and round order is inert on that call. The
 *  board paths pass it (autoSchedule, applySchedule, moveFixture,
 *  validateScheduleIn, `competition-schedule-apply.ts`, `person-merge.ts`;
 *  `schedule-ai/` gates its pack's `roundNos` on the same set). Two calls
 *  do not, on purpose: `siblingAssignments` (other divisions' cards, in no
 *  round sequence of this one) and `schedule-ai/` folder's obstacle list (a court
 *  booking with no ids, which orders nothing).
 *
 *  A Swiss bye row never carries `roundNo`, even on a round-sequence stage
 *  (W3 T3b). A bye is not play — it takes no court and no time
 *  (`isSwissByeShellExtKey`, SWISS_BYE_NOT_PLACEABLE) — so it is no round's
 *  board. One that holds a slot anyway (a legacy row, a history Undo of a
 *  pre-T3 step) must not read as "round 2 starts before round 1" on the
 *  board, nor squeeze the solver as a pinned round-2 row.
 *
 *  `stageId` (C1 fix-loop, Finding 2) is stamped UNCONDITIONALLY, the same
 *  way `divisionId` is — `fixtures.stage_id` is `NOT NULL`, no gate needed.
 *  It rides along regardless of whether `roundNo` itself is forwarded on
 *  this call: `calendar.ts`'s round-order grouping key only reads it off
 *  rows that already carry a `roundNo`, so a `stageId` on a round-less
 *  Assignment is simply never consulted. `calendar.ts`'s own comment on the
 *  grouping key explains WHY it is needed at all — `poolId` alone cannot
 *  tell two round-sequence stages in one division apart when neither has
 *  a pool (two `league` stages, say), which is exactly the shape
 *  `roundRobinStageIds` itself already has to return a SET for. */
export function toAssignment(
  f: FixtureLite,
  matchMinutes: number,
  people: Map<string, string[]>,
  roundRobinStageIds?: RoundSequenceStages,
): Assignment {
  const start = ms(f.scheduled_at as string | Date);
  return {
    fixtureId: f.id,
    // P9 pass 3a: court_id, not the legacy court_label — `SlotConfig.courts`
    // has held real court uuids since pass 1 (`ScheduleConfig.courts:
    // z.array(CourtId)`), so an Assignment fed the OLD label could never
    // match a configured court string again; occupancy tracking and
    // double-booking detection would have gone silently blind the moment
    // this cutover's other half (the config side) landed. See
    // court-id-lattice-equivalence.test.ts — the lattice itself is a pure
    // representation swap either way.
    court: f.court_id ?? "",
    startAt: start,
    endAt: start + matchMinutes * MS_PER_MIN,
    entrants: [f.home_entrant_id, f.away_entrant_id].filter((e): e is string => e !== null),
    people: peopleOf(f, people),
    ...(f.pool_id !== null ? { poolId: f.pool_id } : {}),
    divisionId: f.division_id,
    stageId: f.stage_id,
    ...(isSwissByeShellExtKey(f.ext_key) ? {} : roundFieldsOf(roundRobinStageIds, f)),
    movable: !f.schedule_locked,
  };
}

// Direct-feed dependencies (doc 12 §2 warn.order): the source fixture's
// winner/loser feeds the target, so the target must not start earlier.
export function feedDependencies(fixtures: readonly FixtureLite[]): OrderDependency[] {
  const ids = new Set(fixtures.map((f) => f.id));
  const deps: OrderDependency[] = [];
  for (const f of fixtures) {
    for (const target of [f.winner_to_fixture, f.loser_to_fixture]) {
      if (target !== null && ids.has(target)) {
        deps.push({ fixtureId: target, dependsOn: f.id, direct: true });
      }
    }
  }
  return deps;
}

/** A sibling division's board, in the TWO shapes the engine needs it in (#462).
 *
 *  `assignments` is the court occupancy — what it has always been. `ruleFixtures`
 *  is the rule identity of those same rows, and it is not decoration: the day-cap
 *  tally counts only the `existing` entries it can NAME
 *  (`existing.filter((e) => fixtureById.has(e.fixtureId))`, where `fixtureById`
 *  comes from `config.ruleFixtures`), and every `terminal`/`ext_key` selector
 *  resolves through the same list. An `Assignment` cannot carry `extKey` or
 *  `winnerTo` — the fields are not on the type — so serving occupancy alone made
 *  a competition-scoped rule undercount by exactly the number of cross-division
 *  fixtures involved, in the direction that reports a breached board as clean.
 *
 *  Returned as a pair rather than as a second exported query on purpose: the two
 *  halves describe the same rows, and a caller that fetched one without the
 *  other is the defect. Both must reach `validateAssignments` — the occupancy as
 *  `existing`, the identity through `toVerifyConfig`'s `extraRuleFixtures`. */
export interface SiblingBoard {
  assignments: Assignment[];
  ruleFixtures: RuleFixture[];
}

// Sibling divisions' timetables (doc 06 §4.3): fixed court occupancy for the
// pass, and the source of cross-division person-overlap warnings. Durations
// use each sibling's own matchMinutes when it has settings.
export async function siblingAssignments(
  tx: Tx,
  divisionId: string,
  competitionId: string,
  fallbackMatchMinutes: number,
  /** Further divisions to leave out, on top of `divisionId` itself.
   *
   *  Added for the #350 joint pack: when several divisions of a competition are
   *  planned together the others are not "siblings" whose board is fixed — they
   *  are in the same run and their movable fixtures are being re-placed. Serving
   *  them here hands a division the rest of the run's own work as immovable
   *  obstacles, and since siblings carry NO division identity a caller cannot
   *  tell those entries from a genuinely-outside division's booking. Excluding
   *  them at the source is what makes "this obstacle is from outside the run" a
   *  fact instead of a slot-key guess. */
  excludeDivisionIds: readonly string[] = [],
): Promise<SiblingBoard> {
  const excluded = [...new Set([divisionId, ...excludeDivisionIds])];
  const rows = await tx<FixtureLite[]>`
    select ${tx(FIXTURE_LITE_COLS)} from fixtures
    where division_id in (select id from divisions
                          where competition_id = ${competitionId} and id not in ${tx(excluded)})
      and scheduled_at is not null and court_id is not null
      and status in ${tx(OCCUPYING)}`;
  if (rows.length === 0) return { assignments: [], ruleFixtures: [] };
  const settings = await tx<{ division_id: string; config: unknown }[]>`
    select division_id, config from schedule_settings
    where division_id in ${tx([...new Set(rows.map((r) => r.division_id))])}`;
  const minutes = new Map(
    settings.map((s) => [s.division_id, ScheduleConfig.parse(s.config).matchMinutes]),
  );
  const entrantIds = [
    ...new Set(rows.flatMap((r) => [r.home_entrant_id, r.away_entrant_id])),
  ].filter((e): e is string => e !== null);
  const people = await peopleByEntrant(tx, entrantIds);
  return {
    assignments: rows.map((r) =>
      toAssignment(r, minutes.get(r.division_id) ?? fallbackMatchMinutes, people),
    ),
    // Through the ONE builder (#447/#443), like every other RuleFixture in the
    // codebase — `winnerTo` and `extKey` are different namespaces that both type
    // as `string | null`, so a literal here would type-check and bind nothing.
    // `FIXTURE_LITE_COLS` already selects all five columns it reads.
    ruleFixtures: rows.map(rowToRuleFixture),
  };
}

export function toSlotConfig(settings: ScheduleSettingsOut, now: number): SlotConfig {
  const c = settings.config;
  const window = applyWindow(settings);
  const startAtMs = c.startAt ? ms(c.startAt) : now;
  const horizonMinutes =
    window !== undefined && Number.isFinite(window.to)
      ? Math.floor((window.to - startAtMs) / MS_PER_MIN) - c.matchMinutes
      : 0;
  return {
    startAt: startAtMs,
    // #399: the days the competition actually runs, so a card dragged outside
    // them is refused instead of badged. Delta-gated at the write, so a board
    // already sitting outside its dates stays editable.
    ...(window !== undefined ? { window } : {}),
    // The SOLVER has to respect the same bound, or the auto pass proposes a
    // board the apply gate then refuses: `slotFixtures` searches to
    // `startAt + horizonMinutes` and cannot emit a `window` conflict of its own,
    // so an over-subscribed division would come back with cards past its end
    // date and 409 on apply. Bounded here it reports `no_slot` (CAP), which is
    // the truth.
    //
    // `horizonMinutes` bounds the match START, so the match LENGTH comes off it
    // — a match starting exactly at the window's end would finish outside it —
    // and it floors rather than ceils, because a rounded-up minute is a minute
    // outside the window. A non-positive result means the end date is not after
    // the start date: a config error, and clamping it to zero would answer every
    // fixture with CAP as if the day were merely full. Left unbounded there, so
    // the auto pass behaves exactly as it did and the apply gate is what speaks.
    ...(window !== undefined && Number.isFinite(window.to) && horizonMinutes > 0
      ? { horizonMinutes }
      : {}),
    matchMinutes: c.matchMinutes,
    gapMinutes: c.gapMinutes,
    courts: [...c.courts],
    perEntrantMinRest: c.perEntrantMinRest,
    blackouts: c.blackouts.map((b) => ({
      ...(b.court !== undefined ? { court: b.court } : {}),
      from: ms(b.from),
      to: ms(b.to),
    })),
    sessionWindows: c.sessionWindows.map((w) => ({ from: ms(w.from), to: ms(w.to) })),
    // constraints v2 (Jul3/04 §3): ISO → epoch ms for the pure pass, through the
    // ONE builder (#458) the AI verify seams also go through, so this config and
    // the config a proposal is judged against cannot drift apart again.
    //
    // `hard: true` — the DURABLE typed rules (#398) ride `constraints.hard` on
    // this path, never the top-level `hard` field, because `effectiveHard`
    // MERGES the two and setting both would count every durable rule twice
    // (#447). The top-level field is where a run puts the stream it COMPILED
    // from an instruction, which is why the AI seams route them the other way.
    // Riding `toSlotConfig` rather than the wrapper below is deliberate too:
    // every existing caller gets them with no second place to remember.
    ...(c.constraints !== undefined
      ? {
          constraints: buildEngineConstraints(c.constraints, {
            fieldFairness: c.constraints.fieldFairness,
            parallelism: c.constraints.parallelism,
            crossPersonClash: c.constraints.crossPersonClash,
            hard: true,
          }),
        }
      : {}),
  };
}

/** A `fixtures` row as a `RuleFixture`, by renaming its columns onto the ONE
 *  builder (#447).
 *
 *  Deliberately not a second RuleFixture literal. `winnerTo` must carry
 *  `fixtures.winner_to_fixture` — a uuid FK to `fixtures.id` — and `extKey` must
 *  carry `fixtures.ext_key`, nullable text in a different namespace with no
 *  converter. `RuleFixture` types both `string | null`, so a producer that swaps
 *  them type-checks and then binds NOTHING, silently: that is #443, and #443 was
 *  invisible precisely because a second copy of the join existed. This function
 *  therefore does one thing — rename `pool_id`→`pool`, `winner_to_fixture`→
 *  `feeds.winner_to` — and hands the result to `toRuleFixture`, which stays the
 *  only assignment of `winnerTo` in the codebase. `schedule-ai-repair.test.ts`
 *  guards that count across all three modules. */
export function rowToRuleFixture(
  f: Pick<FixtureLite, "id" | "ext_key" | "pool_id" | "division_id" | "winner_to_fixture">,
): RuleFixture {
  return toRuleFixture(
    { id: f.id, ext_key: f.ext_key, pool: f.pool_id, feeds: { winner_to: f.winner_to_fixture } },
    f.division_id,
  );
}

/** Everything the VERIFIER reads, for the board paths (#447).
 *
 *  `toSlotConfig` answers the placer's question ("where may a card go?") and a
 *  `SlotConfig` is structurally assignable to a `VerifyConfig` with `tz`, `hard`,
 *  `ruleFixtures` and `restByDivision` all `undefined` — which is exactly why
 *  handing one straight to `validateAssignments` compiled clean for four call
 *  sites while dropping every typed rule on the floor.
 *
 *  Two of those fields are load-bearing here and both are traps:
 *
 *    tz            `validateInstructionRules` wraps its ENTIRE typed-rule block
 *                  in `if (tz !== undefined)`, on purpose: every rule in it
 *                  needs a day boundary or a wall-clock time, and bucketing one
 *                  in UTC would report a violation the organiser never expressed.
 *                  So carrying the rules WITHOUT the zone is a fix that binds
 *                  nothing. It is `orgTz`, never `tz` — the org zone governs
 *                  every temporal boundary (#397), and the division's display
 *                  override must not move a rule's calendar day.
 *    ruleFixtures  the feeder→dependent half of `min_rest_minutes` iterates it,
 *                  and every `terminal`/`ext_key` selector resolves through it.
 *                  Without it those rules compile, display as enforced, and bind
 *                  nothing — the same failure shape as #443.
 *
 *  No `restByDivision`: that is the JOINT verifier's field, for the one pass per
 *  division `verifyJoint` runs. These paths verify one division against a fixed
 *  sibling board, which is a different question.
 *
 *  Returns `SlotConfig & VerifyConfig` so the auto pass can hand ONE object to
 *  both the placer and the verifier. A second builder for the second consumer is
 *  how the placer and the verifier drift apart. */
export function toVerifyConfig(
  settings: ScheduleSettingsOut,
  /** The division's own fixture rows — `divisionFixtures`, not just the movable
   *  ones. A selector may name a fixture this run cannot move, and a day cap
   *  counts every fixture on the day. */
  fixtures: readonly FixtureLite[],
  now: number,
  /** Rule identity for rows that are NOT this division's (#462) — in practice
   *  `siblingAssignments(...).ruleFixtures`.
   *
   *  Every caller that puts sibling assignments on the board must pass this, and
   *  the reason is asymmetric: omitting it does not disable a rule, it makes the
   *  rule QUIETLY UNDERCOUNT. A competition-scoped day cap tallies only the
   *  `existing` rows named in `ruleFixtures`, so an unnamed sibling card is on
   *  the board for court purposes and absent for rule purposes — a board that
   *  breaches the cap reports clean. There is no signal anywhere; that is why
   *  `siblingAssignments` returns the two halves together rather than leaving
   *  this to a second call a caller can simply not make. */
  extraRuleFixtures: readonly RuleFixture[] = [],
  /** P9.5: the candidate courts' own opening hours (`resolveCourtCalendars`).
   *
   *  A PARAMETER, not a field read off `settings.config`, for the reason
   *  `toSlotConfig` above copies every field by hand: this config is assembled
   *  explicitly, so anything merely added to the wire config is silently
   *  dropped here — an inert seam that typechecks, renders as enforced and
   *  binds nothing (the #443 shape, and the `tz` trap two doc paragraphs up).
   *  Loading it needs a `tx` and an already-resolved candidate set, neither of
   *  which `settings` carries, so the call site passes it in.
   *
   *  Omitted means "this path does not consult court calendars" — NOT "no court
   *  has any". Both the placer and the verifier read it off ONE object here, so
   *  the two cannot be handed different court hours. */
  courtCalendars?: readonly CourtCalendar[],
  /** P10 (A6/§1): archived-or-absent court ids among this run's OWN assigned
   *  courts (`strandedCourtIdsForDivision`, court-candidates.ts's sibling of
   *  `resolveCourtCalendars`). Same reasoning as `courtCalendars` immediately
   *  above — a PARAMETER because this config is assembled explicitly, not
   *  spread from `settings.config` — and same VerifyConfig-only shape as
   *  `courtTagQualifiedIds`: absent on `SlotConfig`, so `BuildInput.config`'s
   *  own narrower type does not name it either. It still reaches every
   *  `validateAssignments` call inside `build.ts`, because `greedySeed`'s
   *  `verifyConfig: BuildConfig = { ...config }` copies whatever the caller's
   *  actual object carries, structurally, at runtime — regardless of what
   *  `BuildInput.config`'s own type declares. Pinned by `build.test.ts`'s
   *  "does not cry infeasible over a pin sitting on a court the server flagged
   *  stranded" (0a74dbae7). Omitted means "no court in this run's assigned set
   *  is stranded" — NOT "the server never checked". */
  strandedCourtIds?: readonly string[],
): SlotConfig & VerifyConfig {
  return {
    ...toSlotConfig(settings, now),
    tz: settings.orgTz,
    ruleFixtures: [...fixtures.map(rowToRuleFixture), ...extraRuleFixtures],
    ...(courtCalendars !== undefined && courtCalendars.length > 0 ? { courtCalendars } : {}),
    ...(strandedCourtIds !== undefined && strandedCourtIds.length > 0 ? { strandedCourtIds } : {}),
  };
}

/** P10 (§3): the ONE place a `VerifyConfig` gets both its court signals —
 *  calendars AND stranded status. Five sites used to assemble a `VerifyConfig`
 *  by hand; four passed `courtCalendars` and `person-merge.ts:382` passed
 *  neither. Hand-assembly at five sites is how a blind sixth is born, so this
 *  resolves both (in parallel — the two queries are independent reads over the
 *  same open `tx`) and hands the result to `toVerifyConfig` above.
 *
 *  `assignedCourtIds` is the caller's OWN "which courts are actually in use on
 *  this board" set — never re-derived here, because what counts as "assigned"
 *  differs by caller (the whole division's board vs. one fixture's move) and a
 *  second opinion on that question is exactly the placer/verifier fork this
 *  subsystem keeps re-diagnosing. */
export async function verifyConfigForDivision(
  tx: Tx,
  settings: ScheduleSettingsOut,
  fixtures: readonly FixtureLite[],
  now: number,
  extraRuleFixtures: readonly RuleFixture[],
  divisionId: string,
  assignedCourtIds: readonly string[],
): Promise<SlotConfig & VerifyConfig> {
  const [courtCalendars, strandedCourtIds] = await Promise.all([
    courtCalendarsForDivision(tx, divisionId, settings.config.courts),
    strandedCourtIdsForDivision(tx, divisionId, assignedCourtIds),
  ]);
  return toVerifyConfig(settings, fixtures, now, extraRuleFixtures, courtCalendars, strandedCourtIds);
}

/**
 * The competition's own dates as an engine window (#399).
 *
 * Deliberately NOT the AI pack's resolved window: that one WIDENS onto whatever
 * is already scheduled and onto the compiled instruction, so nothing already on
 * the board could ever fall outside it — a window that can never be broken
 * enforces nothing. It also defaults to seven days when no end date is set, and
 * caging a board inside an invented week is not something an apply gate may do.
 *
 * Each bound is independently optional: an organiser who set only a start date
 * gets a floor and no ceiling.
 */
export function applyWindow(
  settings: ScheduleSettingsOut,
): { from: number; to: number } | undefined {
  const { startAt, endAt } = settings.config;
  if (!startAt && !endAt) return undefined;
  // The ORG zone governs every temporal boundary (#397): a day is a wall-clock
  // day where the organisation lives, and a DST day is 23 or 25 hours long, so
  // the bounds are converted rather than arithmetic on 86_400_000.
  const tz = settings.orgTz;
  return {
    from: startAt ? zonedTimeToUtc(dayKeyInTz(ms(startAt), tz), "00:00", tz) : -Infinity,
    // EXCLUSIVE end-of-last-day, matching `windowBounds` in the AI path: a match
    // ending at exactly midnight sits entirely on days inside the window.
    to: endAt ? zonedTimeToUtc(ymdAddDays(dayKeyInTz(ms(endAt), tz), 1), "00:00", tz) : Infinity,
  };
}
