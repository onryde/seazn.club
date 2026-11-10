import "server-only";
// v4 AI Schedule Architect — Phase A context pack (design/v4/01-llm-contract.md §2,
// design/v4/03 §2). buildSchedulePack assembles ONE deterministic, JSON-serialisable
// pack — settings, entrants, shared-person map, movable fixtures, obstacles, a greedy
// solver draft, and officials availability — that later tasks hand to the LLM. This
// module never calls the model; it only builds the pack and the draft.
//
// Determinism is binding (a golden snapshot asserts two builds are byte-identical):
// every array is sorted, fixtures order by (round_no, seq_in_round, ext_key), officials
// by (display_name, id), and every timestamp is an ISO-8601 string carrying the division
// timezone offset. DB reads reuse the schedule/ / officials.ts loaders — no SQL is
// re-derived here.
import { withTenant } from "@/lib/db";
// P9 pass 4d: the court-name disambiguation rule, lifted to a client-safe
// module (see the doc comment at this file's own re-export below) — imported
// (not a bare `export … from`) because buildSchedulePack calls it directly.
import { buildCourtDirectory, type PackCourtInfo } from "@/lib/court-directory";
import { HttpError } from "@/lib/errors";
import {
  computeParticipants,
  dayKeyInTz,
  isEpochSentinel,
  makeClock,
  slotFixtures,
  stripByes,
  ymdAddDays,
  zonedTimeToUtc,
  type Assignment,
  type ParticipantFixture,
  type SchedulableFixture,
} from "@seazn/engine/scheduling";
import { resolvePersonScopes } from "@/server/usecases/engine-constraints";
import {
  expandDailyBreaks,
  resolveParsed,
  type RawParsed,
  type ResolvedParse,
} from "@/server/usecases/schedule-ai-parse";
// P9 pass 3b: the SAME candidate filter autoSchedule/validateScheduleIn go
// through (court-candidates.ts's own header explains why a second, inlined
// tag-filter loop here would be this subsystem's recurring bug) — the AI
// draft placer must never be able to choose an archived or tag-mismatched
// court just because a second copy of the filter was missing.
// P9 (stage court tags) -> #622 (round-scoped court tags): the per-FIXTURE
// pair too. buildSchedulePack used to resolve only the DIVISION's
// candidateCourtIds — the same gap review finding #11 closed in
// validateScheduleIn (schedule/conflicts.ts) — so a stage's own required_court_tags was
// invisible to the model; #622 added a round-role scope that a per-stage
// resolve cannot express at all. See buildSchedulePack's
// fixtureCandidateCourts.
import {
  candidateCourtsByFixture,
  requiredCourtTagsByFixture,
  resolveCandidateCourts,
  resolveCourtCalendars,
} from "@/server/usecases/court-candidates";
import type { AuthCtx } from "@/server/api-v1/auth";
import { playedFixtureIds } from "../fixture-results-sql";
import {
  isMovable,
  divisionFixtures,
  divisionLockState,
  feedDependencies,
  loadSettings,
  lockedFixtureIds,
  peopleByEntrant,
  roundFieldsOf,
  roundRobinStageIds,
  roundRulesOf,
  siblingAssignments,
  toAssignment,
  toSlotConfig,
  type FixtureLite,
  type RoundFields,
  type RoundSequenceStages,
  type ScheduleSettingsOut,
} from "../schedule";
import {
  loadOfficialBlackouts,
  loadOfficialsWithEntrants,
  listOfficialBusyElsewhere,
} from "../officials";
import { cmp, MS_PER_MIN, zonedIso } from "./helpers";
import { personKeyResolver } from "./identity";
import type {
  PackDraftAssignment,
  PackEntrant,
  PackFixture,
  PackObstacle,
  PackOfficial,
  PackPerson,
  PackSettings,
  SchedulePack,
} from "./types";

/** Label stamped on a sibling division's placements. `siblingAssignments`
 *  (schedule/engine-inputs.ts) returns bare engine assignments carrying no division
 *  metadata, so every other division in the competition flattens to this one
 *  string — deliberately, since a rival's roster must never leak into the pack.
 *
 *  Exported because that makes it the ONLY marker separating "another
 *  division's board" from "this division's own fixed fixtures" in
 *  `fixtures.obstacles`, and the #350 joint builder keys its sibling removal on
 *  it. A copied literal there would diverge silently. */
export const OTHER_DIVISION_LABEL = "Other division";

/** P9 pass 3d: what the model gets to know about a court beyond its id —
 *  `label` is what it must echo back (the SAME string `toModelPayload` puts
 *  in `settings.courts`); `venue`/`tags` are shown alongside it (courtDetails)
 *  so the model can reason about which court suits a fixture, something it
 *  had no way to do while `settings.courts` carried opaque uuids.
 *
 *  P9 pass 4d: `buildCourtDirectory`/`PackCourtInfo` themselves moved to
 *  `@/lib/court-directory` (CLIENT-SAFE — this file imports "server-only",
 *  imported at this file's top) so the schedule board could reuse the exact
 *  same "Name (Venue)" rule for its column headers/swap button/captions
 *  instead of a second implementation. Re-exported here so every
 *  pre-existing import from "./schedule-ai" (competition-schedule-ai/,
 *  both golden-pack tests, schedule-ai-court-directory.test.ts) keeps
 *  working unchanged. See the lib module for the disambiguation rule's own
 *  doc comment. */
export { buildCourtDirectory, type PackCourtInfo };

/** No configured `endAt`: the window runs a week from its start. Seven is the
 *  programme's unit — the design freezes a 7-day badminton golden schedule and
 *  the "read the end as the following week" assumption on top of it (#397). */
export const DEFAULT_WINDOW_DAYS = 7;

/** `ScheduleConfig` has no daily-hours field, so the pack advertises this as the
 *  fallback shape of a day for a division with no explicit `sessionWindows`.
 *  Advisory in W2 — it anchors the greedy draft and tells the model what a
 *  normal day looks like; the typed rules that enforce it land in W3/W4. */
export const DEFAULT_SESSION_HOURS = { start: "08:00", end: "22:00" } as const;

export interface BuildPackOptions {
  mode: "generate" | "refine" | "repair";
  instruction: string;
  /** The instant this run is happening, epoch ms. REQUIRED and always injected
   *  (#397): the pack builder reads no clock, so two builds at the same `now`
   *  are byte-identical and the golden pack tests stay reproducible. The only
   *  `Date.now()` on this path is at the runner entry. */
  now: number;
  /** Stage-1 output (#398), or null when there was no instruction, the compile
   *  failed, or the caller is a test or a replay. The BUILDER resolves it:
   *  symbolic dates need the clock and the feasibility bump needs the fixture
   *  count, and both live here rather than at the call site. */
  raw?: RawParsed | null;
  /** W5 (#400): a resolution the caller already has and the organiser has
   *  already SEEN — the stored `ai_parse_previews.resolved` of a confirmed
   *  preview. Wins over `raw` outright. `resolveParsed` reads the org clock, so
   *  re-deriving it here minutes after the preview can land a symbolic
   *  "tomorrow" on a different date and quietly run the architect under rules
   *  nobody approved. Absent on every other path, which resolves `raw` as
   *  before. */
  resolved?: ResolvedParse | null;
  /** True when a compile was ATTEMPTED and produced nothing. Distinct from
   *  `raw: null`, which also covers "no instruction was given" — and the
   *  difference is the whole point: without it an organiser's unreadable brief
   *  is discarded in silence. `parseInstruction` never throws, so a transport
   *  failure, a refusal and a twice-missed schema all arrive here identically. */
  parseFailed?: boolean;
  scope?: { from?: string; courts?: string[]; pool_ids?: string[] };
  prior?: {
    instruction: string;
    assignments: { fixture_id: string; scheduled_at: string; court_label: string }[];
  };
  /** Extra court occupancy handed to the greedy draft solver, on top of this
   *  division's own fixed fixtures and its siblings' persisted board.
   *
   *  Added for the #350 joint pack (competition-schedule-ai/): several
   *  divisions of one competition are drafted in sequence, and each must see
   *  the slots the divisions before it have just taken. `siblingAssignments`
   *  only covers what is already PERSISTED, so without this the joint draft
   *  double-books every shared court label — anchoring the model on an illegal
   *  board and spending the run's FIXED token budget on repair rounds.
   *
   *  Optional and additive: it only widens `existing`, and `generate` is the
   *  only mode that solves a draft, so no current caller is affected. */
  extraExisting?: Assignment[];
  /** Divisions of the same competition to leave OUT of the sibling sweep, on
   *  top of this one — see `siblingAssignments` (schedule/engine-inputs.ts). #350: the
   *  rest of a joint run is not fixed court occupancy, it is being re-planned in
   *  the same pass, and sibling obstacles carry no division identity, so
   *  anything surviving the sweep must be provably from outside the run.
   *  Defaults to none, so no current caller is affected. */
  excludeDivisionIds?: string[];
}

/** Movable fixtures respect a repair `scope`: a fixture stays movable if it is
 *  unscheduled (needs a home) or matches every provided predicate. Anything
 *  out of scope keeps its court and becomes an obstacle.
 *
 *  P9 pass 3b: matches on `court_id`, the fixture's REAL court identity —
 *  `court_label` is frozen, read-only legacy (FixtureLite's own doc comment)
 *  and null on every fixture scheduled since the cutover, so matching on it
 *  silently excluded every real placement from ever being "in scope". */
function inScope(f: FixtureLite, scope: BuildPackOptions["scope"]): boolean {
  if (!scope) return true;
  if (scope.courts && !(f.court_id === null || scope.courts.includes(f.court_id))) {
    return false;
  }
  if (scope.pool_ids && !(f.pool_id !== null && scope.pool_ids.includes(f.pool_id))) {
    return false;
  }
  if (scope.from) {
    const from = new Date(scope.from).getTime();
    if (!(f.scheduled_at === null || new Date(f.scheduled_at).getTime() >= from)) return false;
  }
  return true;
}

/** The fields the pack's ONE fixture order reads. `PackFixture` satisfies it;
 *  a `FixtureLite` gets there through {@link boardOrderOf}. */
interface BoardOrdered {
  round: number;
  seq: number;
  ext_key: string | null;
  id: string;
}

const boardOrderOf = (f: FixtureLite): BoardOrdered => ({
  round: f.round_no,
  seq: f.seq_in_round,
  ext_key: f.ext_key,
  id: f.id,
});

/**
 * THE fixture order for the whole pack — `participants` keys, `fixtures.movable`,
 * every `feeds.after` list, and (via `byFixtureOrder`, then `byAssignment`'s own
 * court tie-break) `draft`'s same-instant ordering, alike.
 *
 * It must stay a SINGLE comparator. `participants` serialises before `fixtures`,
 * so its key order is what assigns every fixture-id placeholder in the golden
 * pack; two comparators that merely happen to agree on today's board (they
 * diverge as soon as `ext_key` order contradicts `id` order) would renumber the
 * snapshot the first time a board pulled them apart.
 */
function byBoardOrder(a: BoardOrdered, b: BoardOrdered): number {
  return (
    a.round - b.round ||
    a.seq - b.seq ||
    cmp(a.ext_key ?? "", b.ext_key ?? "") ||
    cmp(a.id, b.id)
  );
}

/**
 * Build the deterministic Phase A context pack for a division.
 *
 * @returns the pack plus the set of fixture ids the LLM may place — later tasks
 *   reject any assignment id outside `movableIds`.
 *   422 AI_PLAN_TOO_LARGE (>500 movable), 422 AI_PLAN_EMPTY_SCOPE (repair scope
 *   matched nothing), 400 (scope names a court that is not in settings.courts).
 */
export async function buildSchedulePack(
  auth: AuthCtx,
  divisionId: string,
  opts: BuildPackOptions,
): Promise<{
  pack: SchedulePack;
  movableIds: Set<string>;
  /** P9 pass 3d: id -> display info for every court in the org — passed to
   *  `toModelPayload`/`runAiPlan` so the model is shown a name (with its
   *  venue and tags) instead of the raw id `pack` itself carries throughout.
   *  See `buildCourtDirectory`. */
  courtDirectory: Record<string, PackCourtInfo>;
}> {
  // Cross-org "booked elsewhere" straddles tenants by design — it runs on the
  // superuser connection, so it is gathered outside the tenant transaction.
  const busyElsewhere = await listOfficialBusyElsewhere(auth);

  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<
      {
        id: string;
        name: string;
        sport_key: string;
        competition_id: string;
        required_court_tags: string[];
      }[]
    >`
      select id, name, sport_key, competition_id, required_court_tags
      from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const settings = await loadSettings(tx, divisionId);
    const config = settings.config;
    // ONE clock (#397, design §2.1). `settings.displayTz` stays available as the
    // division's DISPLAY zone — it is what `pack.division.tz` carries — but
    // every instant below is rendered in, and every calendar question answered
    // in, the ORGANISATION zone.
    const tz = settings.displayTz;
    const orgTz = settings.orgTz;
    const clock = makeClock(opts.now, orgTz);
    const courts = [...config.courts];
    const matchMinutes = config.matchMinutes;

    // A scope may only reference courts the division actually has configured
    // — deliberately the FULL configured list, not the filtered candidate set
    // just below: a repair scope may still need to reference a fixture
    // already sitting on a since-archived or since-retagged court (ruling 3,
    // candidate-courts.ts — an existing placement must keep validating clean).
    //
    // #8 fix: `courts.includes(c)` alone rejected the exact scope the "a
    // court was removed, repair the board" nudge sends — the client's
    // `goneCourts` (use-disruption-signals.ts) is built from court ids that
    // are NOT in configuredCourts BY CONSTRUCTION (a court dropped from
    // config entirely, not merely archived/retagged — that case already
    // passes via `courts.includes` above, since config.courts keeps
    // whatever was configured when the board was built regardless of later
    // archival). So the nudge the product itself offers always 400'd. Accept
    // a scope court that EITHER is still configured OR is a court this
    // division's fixtures actually reference (past or present placement) —
    // still rejects a court with no relationship to this division at all (a
    // typo, a foreign-org id, or a court this division never used).
    if (opts.scope?.courts) {
      const referencedCourtIds = new Set(
        (
          await tx<{ court_id: string }[]>`
            select distinct court_id from fixtures
            where division_id = ${divisionId} and court_id is not null`
        ).map((r) => r.court_id),
      );
      for (const c of opts.scope.courts) {
        if (!courts.includes(c) && !referencedCourtIds.has(c)) {
          throw new HttpError(400, `unknown scope court "${c}"`);
        }
      }
    }

    // P9 pass 3b: the candidate court set for this AI draft — the division's
    // configured courts, filtered to non-archived courts carrying every
    // required tag, through the ONE engine filter `autoSchedule`/
    // `validateScheduleIn` also go through (schedule/conflicts.ts's own reference
    // wiring). No stage component: this pack spans the whole division's
    // movable set, the same reasoning `validateScheduleIn` documents for its
    // own call. Everything the model is SHOWN and everything the draft
    // placer may CHOOSE reads this filtered set from here on — `courts`
    // above stays the raw configured list, used only for the scope-validation
    // check just above.
    const candidateCourtIds = await resolveCandidateCourts(
      tx,
      divisionId,
      courts,
      division.required_court_tags,
    );

    // P9.5: the candidate courts' own calendars, so the pack's verifier can
    // check the model's draft against real opening hours. Same loader the
    // build and validate paths use — never a second read of court_hours.
    const packCourtCalendars = await resolveCourtCalendars(tx, candidateCourtIds.ids);

    // P9 (stage court tags) -> #622 (round-scoped tags). `candidateCourtIds`
    // above is DIVISION-wide only, so a stage's own `required_court_tags` was
    // invisible to the model while the deterministic placer honoured it. P9
    // closed that per STAGE; #622 added a third scope (a round ROLE inside one
    // stage), which a per-stage resolve cannot express at all — QF, SF and the
    // final share one `stages` row.
    //
    // Resolved PER FIXTURE now, through the SAME shared
    // `requiredCourtTagsByFixture`/`candidateCourtsByFixture` pair
    // `autoSchedule` and `validateScheduleIn` resolve through, so the three
    // paths cannot disagree about a fixture's candidate set. The reason the
    // required-tag lists must never simply be flattened into one resolve is
    // unchanged and now doubly true: `unionRequiredCourtTags`/
    // `candidateCourts` read a required-tag list as AND, so a court
    // disqualified by the FINAL's tags would wrongly disqualify a
    // quarter-final too.
    //
    // The memoisation that used to live here (one resolve per DISTINCT tag
    // union, because most stages share the empty union) moved into
    // `candidateCourtsByFixture` itself — same behaviour, one copy.
    const fixtureRequiredTags = await requiredCourtTagsByFixture(
      tx,
      divisionId,
      division.required_court_tags,
    );
    const fixtureCandidateCourts = await candidateCourtsByFixture(
      tx,
      divisionId,
      courts,
      fixtureRequiredTags,
    );

    // P9 pass 3d: id -> {label, venue, tags} for every court in the org, not
    // just this division's candidate set — an obstacle, a pin or a stored
    // blackout can reference ANY org court (ruling 3, candidate-courts.ts: an
    // existing placement on a since-archived or since-retagged court must
    // still resolve to a name, not silently fall back to its raw id). Whole
    // org, unfiltered: same no-pre-filter reasoning `orgCourtMetas` states
    // for `resolveCandidateCourts`'s own read, and org court counts are small
    // enough that this is never a hot-path concern.
    const courtDirRows = await tx<
      { id: string; name: string; venue_name: string; tags: string[] }[]
    >`
      select c.id, c.name, v.name as venue_name, c.tags
      from courts c
      join venues v on v.id = c.venue_id`;
    const courtDirectory = buildCourtDirectory(courtDirRows);

    const all = await divisionFixtures(tx, divisionId);
    // Not a fixture that holds a result (`isMovable`): it stays in `all`, so
    // it is fixed occupancy below like any decided one.
    const played = await playedFixtureIds(tx, divisionId);
    const candidates = all.filter((f) => isMovable(f, played));
    // Scope only narrows a repair round; generate/refine re-plan the whole set.
    const movable = opts.mode === "repair" ? candidates.filter((f) => inScope(f, opts.scope)) : candidates;

    if (opts.mode === "repair" && movable.length === 0) {
      throw new HttpError(422, "AI_PLAN_EMPTY_SCOPE", "AI_PLAN_EMPTY_SCOPE");
    }
    if (movable.length > 500) {
      throw new HttpError(422, "AI_PLAN_TOO_LARGE", "AI_PLAN_TOO_LARGE");
    }
    const movableSet = new Set(movable.map((f) => f.id));
    // #pins-in-build Task 2/4: the canonical lock predicate, not a third (and
    // fourth) hand-maintained copy of "is this fixture locked". Both
    // `packMovable`'s `pinned` field below (feeds `structuralCheck`'s pinned
    // Map and `toEngineAssignments`'s pinnedIds — what the AI plan's own
    // structural/diff guards refuse to let move) and the "generate" draft's
    // `locked` anchor further down used to test `f.schedule_locked` alone, so
    // a division-scope-locked fixture (no `schedule_locked` of its own)
    // was invisible to both. Computed ONCE here, ahead of every mode branch,
    // and reused by both call sites so they cannot drift onto two different
    // ideas of "locked" again. `ignoreLocks` is always false: the AI draft
    // pack has no equivalent of `AutoScheduleRequest.ignore_locks` to thread
    // through.
    const { scopes: lockScopes } = await divisionLockState(tx, divisionId);
    const lockedIds = lockedFixtureIds(movable, lockScopes, false);

    // C1 gap B: hoisted from inside the "generate" mode branch, where it used
    // to be computed only for the greedy draft's own `schedulable` builder.
    // `packMovable`'s `stageIds`/`roundNos` (below, feeding `toEngineAssignments`
    // — the AI-plan verify seam) need this set in EVERY mode, not just
    // generate: a refine/repair plan is verified through the same seam. `f.
    // round_no` is display numbering shared by every stage kind (bracket
    // rounds, swiss rounds, stepladder legs all reuse the column — F1's
    // roundRole()/roundRoleLabel() names every one of them by position,
    // never derived from this column alone), so `roundRobin.has(f.stage_id)`
    // is the gate that keeps a bracket's or a stepladder's round_no from being
    // read as round order — the design doc's own motivating symptom. The set is
    // the round-sequence stages (league, group, swiss — W3 T3b). Computed
    // ONCE here, ahead of every mode branch, same reasoning as `lockedIds`
    // just above.
    const roundRobin = await roundRobinStageIds(tx, divisionId, settings);

    // People map (entrant → person ids) for the engine draft and the pack's
    // shared-player list.
    const fixtureEntrantIds = [...new Set(all.flatMap((f) => [f.home_entrant_id, f.away_entrant_id]))]
      .filter((e): e is string => e !== null);
    const people = await peopleByEntrant(tx, fixtureEntrantIds);

    // #396 identity inputs, resolved before anything reads a person id. Person
    // ids are per-seed UUIDs and the pack's determinism test maps UUIDs to
    // FIRST-SEEN placeholders, so a UUID-ordered array breaks it: order on the
    // person's name, with the id only as a last-resort tie-break.
    const personIdsInPlay = [...new Set([...people.values()].flat())];
    const personNameById = new Map<string, string>();
    if (personIdsInPlay.length > 0) {
      const nameRows = await tx<{ id: string; full_name: string }[]>`
        select id, full_name from persons where id in ${tx(personIdsInPlay)}`;
      for (const r of nameRows) personNameById.set(r.id, r.full_name);
    }
    // A synthetic `name:<normalised>` key has no row in `personNameById`, so it
    // would otherwise sort under the empty name and drift as soon as a real
    // person shares that bucket. Sort it on the normalised name it carries.
    //
    // ACCEPTED RESIDUAL: the `|${p}` tail is a raw person UUID, so a tie on
    // `full_name` falls through to a per-seed random value. The same-name guard
    // (`personKeyResolver`) already collapses same-named persons to ONE key
    // before this runs, so the only ties left are two persons whose names are
    // blank or whitespace — which the guard deliberately skips rather than fuse
    // every unnamed person in the org into one player. Two blank-named people
    // can therefore order differently across reseeds; that is a strictly better
    // trade than the alternative, and the redaction determinism test tolerates
    // it because such a board has no stable domain key to offer.
    const personSortKey = (p: string): string =>
      p.startsWith("name:") ? `${p.slice(5)}|${p}` : `${personNameById.get(p) ?? ""}|${p}`;

    const identity = personKeyResolver(personNameById);
    // Map every entrant's roster through the guard BEFORE the recursion, so a
    // collapsed pair is one key everywhere it appears — in the leaf sets, in the
    // advancer unions above them, in the placer and in the verifier alike. The
    // obstacle assignments below read it too: a collapsed person's already-fixed
    // court time must still clash with the movable fixture they could stand in,
    // which it would not if one side carried a raw id and the other the key.
    const guardedPeople = new Map<string, string[]>(
      [...people].map(([entrantId, ids]) => [entrantId, [...new Set(ids.map(identity.keyOf))]]),
    );

    // #450: the stored RULES go through the same resolver instance, for exactly
    // the same reason the rosters above do. `scopeCoversFixture` compares
    // `scope.personKey` raw against a fixture's `people`, which are guarded keys
    // from this point on — so a rule authored against a real person UUID (the
    // only person identifier the console offers) stopped binding the moment the
    // guard collapsed that person, silently and while still displaying as
    // enforced.
    //
    // ONE place, deliberately: `guardedSettings` feeds the DRAFT placer via
    // `toSlotConfig` below, and `guardedHard` feeds the pack's own
    // `settings.constraints.hard`, which is what `verifyConfig` hands the
    // referee. Mapping at only one of the two would fork the placer from the
    // verifier — the recurring bug in this area — so both read the same array.
    //
    // `pack.parsed.hard` is deliberately NOT mapped: `schedule-ai-parse.ts`
    // narrows the model's scope vocabulary to competition/division, so a
    // compiled rule cannot carry a person scope at all. A map there would be a
    // second producer guarding nothing.
    const guardedHard = resolvePersonScopes(config.constraints?.hard ?? [], identity.keyOf);
    // P9 pass 3b: `config.courts` overridden to the FILTERED candidate set
    // unconditionally (never the raw configured list) — this is the ONE
    // config the draft placer's `toSlotConfig` call below reads, so an
    // archived or tag-mismatched court must never reach it. Mirrors
    // `autoSchedule`'s own `settingsForEngine` (schedule/auto.ts) exactly.
    const guardedSettings: ScheduleSettingsOut = {
      ...settings,
      config: {
        ...config,
        courts: [...candidateCourtIds.ids],
        ...(config.constraints !== undefined
          ? { constraints: { ...config.constraints, hard: guardedHard } }
          : {}),
      },
    };

    // Pool id → key ('A', 'B', …) across this division's stages.
    const poolRows = await tx<{ id: string; key: string }[]>`
      select p.id, p.key from pools p
      join stages s on s.id = p.stage_id
      where s.division_id = ${divisionId}`;
    const poolKey = new Map(poolRows.map((p) => [p.id, p.key]));

    // Obstacles: this division's fixed court time (decided fixtures + anything
    // scoped out of a repair) plus sibling divisions' timetables.
    // P9 pass 3b: `court_id`, not the legacy `court_label` — the latter is
    // null on every fixture scheduled since the cutover, which silently
    // dropped every real placement from the obstacle set the greedy draft and
    // the model are both shown.
    const obstacleFixtures = all.filter(
      (f) => !movableSet.has(f.id) && f.scheduled_at !== null && f.court_id !== null,
    );
    const obstacleAssignments = obstacleFixtures.map((f) => toAssignment(f, matchMinutes, guardedPeople));
    // `.assignments` only (#462): this list becomes `pack.fixtures.obstacles`,
    // which is a COURT BOOKING shape carrying no ids at all — the pack cannot
    // express a sibling's rule identity, and the AI verify seam builds its
    // `ruleFixtures` from `pack.fixtures.movable` instead. The board paths in
    // `schedule/` are the ones that both hold siblings AND build the config
    // from rows, and they are the ones changed.
    const siblingsRaw = (
      await siblingAssignments(
        tx,
        divisionId,
        division.competition_id,
        matchMinutes,
        opts.excludeDivisionIds ?? [],
      )
    ).assignments;
    // BOTH the raw person id and its guarded key, deliberately — the same shape
    // `buildCompetitionPack` uses for `fixedOccupancy`, and for the same reason.
    // `siblingAssignments` reads `peopleByEntrant` directly, so it emits raw
    // uuids, while the movable fixtures this list is compared against carry
    // guarded keys. The moment the same-name guard collapses a person, the raw
    // id on this side stops matching the key on that side and a constraint that
    // fired BEFORE #396 disappears. Emitting both can only ever add.
    //
    // WHAT THIS DOES NOT ACHIEVE, honestly: `identity.keyOf` is built from THIS
    // division's person map, so a person who exists only in a sibling division
    // is never in a collapse bucket here and keeps their raw id. A human
    // entered under two `persons` rows where one row appears solely in the
    // sibling division therefore still does not collapse — the joint pack
    // (`buildCompetitionPack`, which resolves identity over the whole run) is
    // the path that sees that case. This restores the pre-#396 raw↔raw parity
    // and nothing more; the wider case is a filed follow-up.
    const siblings: Assignment[] = siblingsRaw.map((a) => ({
      ...a,
      people: [...new Set(a.people.flatMap((p) => [p, identity.keyOf(p)]))],
    }));

    // feeds.after: the fixtures that must finish before each one starts. Built
    // HERE — above the draft — because the participant recursion below needs it
    // and the greedy placer needs the participants.
    const afterMap = new Map<string, string[]>();
    for (const d of feedDependencies(all)) {
      (afterMap.get(d.fixtureId) ?? afterMap.set(d.fixtureId, []).get(d.fixtureId)!).push(d.dependsOn);
    }

    // A feeder list ordered on the FEEDER's stable domain key. It used to sort
    // on the raw feeder UUID, which no test could catch (the double-seed board
    // is a round-robin, where every `after` is empty) — a bracket board would
    // have shipped a reseed-unstable array inside the golden pack.
    const liteById = new Map(all.map((f) => [f.id, f]));
    const byFixtureOrder = (x: string, y: string): number => {
      const a = liteById.get(x);
      const b = liteById.get(y);
      if (a === undefined || b === undefined) return cmp(x, y);
      return byBoardOrder(boardOrderOf(a), boardOrderOf(b));
    };

    // Determinism (defect fix, P9): `draft`'s own same-instant tie-break used
    // to be `cmp(court_label)`. Pre-cutover, `court_label` was a stable,
    // organiser-authored string ("Court 1", "Court 2"); since V374,
    // `PackDraftAssignment.court_label` carries the real court UUID in every
    // mode (see the three `draft = …` branches below: the solver's own
    // `a.court`, a prior proposal's `court_label`, or `f.court_id` directly)
    // — a fresh per-seed random value, so two cards sharing an instant on
    // different courts sorted in coin-flip order across reseeds. Reusing
    // `byFixtureOrder` on each entry's OWN `fixture_id` ties on board
    // position instead — the SAME domain key `feeds.after` above already
    // trusts, and neither the (per-seed) court id nor the (organiser-
    // editable) court name, either of which would just swap one instability
    // for another. Local, not module-level, because it closes over
    // `byFixtureOrder`/`liteById`.
    //
    // Widened to the draft's row shape (#397): an unplaced draft row carries a
    // null time. Null sorts as "" — ahead of every placed card, as one stable
    // block — so the ordering stays total and the pack stays
    // byte-reproducible.
    const byAssignment = (a: PackDraftAssignment, b: PackDraftAssignment): number => {
      return (
        cmp(a.scheduled_at ?? "", b.scheduled_at ?? "") ||
        byFixtureOrder(a.fixture_id, b.fixture_id) ||
        cmp(a.fixture_id, b.fixture_id)
      );
    };

    // #396: who could stand in each fixture, advancers behind a null slot
    // included. Computed ONCE, above the draft, so the greedy placer, the pack
    // and the verifier all read the same map.
    //
    // The SAME comparator `packMovable` uses (`byBoardOrder`), so `participants`
    // key order is the pack's own fixture order and survives a reseed of the
    // same board.
    const participantView: ParticipantFixture[] = [...movable]
      .sort((a, b) => byBoardOrder(boardOrderOf(a), boardOrderOf(b)))
      .map((f) => ({
        id: f.id,
        ext_key: f.ext_key,
        home: f.home_entrant_id,
        away: f.away_entrant_id,
        feeds: { after: [...(afterMap.get(f.id) ?? [])].sort(byFixtureOrder) },
      }));
    const stripped = stripByes(participantView);
    // ONE source of truth for `feeds.after`: the pack must not name a feeder the
    // model cannot see, and the verifier must not be handed a dependency the
    // placer ignored.
    const afterByFixture = new Map(stripped.fixtures.map((f) => [f.id, [...f.feeds.after]]));
    const participants = computeParticipants(stripped.fixtures, guardedPeople, {
      sortKey: personSortKey,
    });
    // `stripByes` names a stripped feeder by its raw id (it holds no fixture
    // outside the view). Substitute each feeder's ext_key — the stable domain
    // key the plan asks these strings to carry. A feeder with no ext_key keeps
    // its FULL uuid (never a fragment: the determinism test's redaction only
    // matches whole uuids).
    const extKeyById = new Map(all.map((f) => [f.id, f.ext_key]));
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    // …and order the list on the BOARD, never on the rendered text.
    // `fixtures.ext_key` is nullable, so a dependent or feeder without one keeps
    // a raw UUID inside its message and a text sort would order two assumptions
    // on a per-seed random value — exactly what `redact()`'s first-seen
    // placeholders turn into a double-seed determinism failure. The sort key is
    // the dependent's (round_no, seq_in_round) then the feeder's, which is
    // stable across reseeds of the same logical board.
    //
    // KEYED ON THE (dependent, feeder) PAIR, never on the feeder alone. In
    // double elimination one match legitimately feeds BOTH the winners' and the
    // losers' bracket, so two dependents strip the SAME feeder; a feeder-keyed
    // entry is then overwritten by whichever dependent is written last and the
    // two assumptions come out with identical ranks. They fall through to
    // `cmp(text)` — and a dependent with a null `ext_key` still carries its raw
    // UUID in that text, so the order becomes per-seed and the double-seed
    // determinism test breaks.
    const OUT_OF_BOARD = Number.MAX_SAFE_INTEGER;
    type AssumptionRank = readonly [number, number, number, number];
    const OUT_OF_BOARD_RANK: AssumptionRank = [
      OUT_OF_BOARD,
      OUT_OF_BOARD,
      OUT_OF_BOARD,
      OUT_OF_BOARD,
    ];
    // `stripByes` renders the dependent by its stable label (`ext_key ?? id`)
    // and the feeder by its raw id, so those two tokens are what identifies a
    // message — the pair key is built from the same two.
    const labelOf = (id: string): string => extKeyById.get(id) ?? id;
    const assumptionRank: { label: string; feederId: string; rank: AssumptionRank }[] = [];
    for (const f of participantView) {
      const dep = liteById.get(f.id);
      for (const feederId of f.feeds.after) {
        if (movableSet.has(feederId)) continue; // kept, so it raises no assumption
        const feeder = liteById.get(feederId);
        assumptionRank.push({
          label: labelOf(f.id),
          feederId,
          rank: [
            dep?.round_no ?? OUT_OF_BOARD,
            dep?.seq_in_round ?? OUT_OF_BOARD,
            feeder?.round_no ?? OUT_OF_BOARD,
            feeder?.seq_in_round ?? OUT_OF_BOARD,
          ],
        });
      }
    }
    // Read off the RAW string, before the ext_key substitution rewrites it: the
    // stripped feeder appears there as its uuid. The LONGEST matching dependent
    // label wins, so an ext_key that happens to be a substring of another
    // ("final" inside "semi-final") cannot claim the wrong message.
    const rankOf = (raw: string): AssumptionRank => {
      let best: AssumptionRank | undefined;
      let bestLabel = -1;
      for (const e of assumptionRank) {
        if (e.label.length <= bestLabel) continue;
        if (!raw.includes(e.feederId) || !raw.includes(e.label)) continue;
        best = e.rank;
        bestLabel = e.label.length;
      }
      return best ?? OUT_OF_BOARD_RANK;
    };
    const assumptions = [
      ...stripped.assumptions
        .map((a) => ({ rank: rankOf(a), text: a.replace(UUID_RE, (u) => extKeyById.get(u) ?? u) }))
        .sort(
          (x, y) =>
            x.rank[0] - y.rank[0] ||
            x.rank[1] - y.rank[1] ||
            x.rank[2] - y.rank[2] ||
            x.rank[3] - y.rank[3] ||
            cmp(x.text, y.text),
        )
        .map((x) => x.text),
      // Already ordered by normalised name inside the resolver.
      ...identity.assumptions,
    ];

    // The window (#397), in the org zone. Every boundary is a wall-clock day
    // boundary converted with zonedTimeToUtc — NOT startMs + 86_400_000,
    // because a DST day is 23 or 25 hours long.
    const dayStart = (ymd: string): number => zonedTimeToUtc(ymd, "00:00", orgTz);
    const dayEnd = (ymd: string): number =>
      zonedTimeToUtc(ymdAddDays(ymd, 1), "00:00", orgTz) - 1000;

    const baseStartMs = config.startAt
      ? new Date(config.startAt).getTime()
      : dayStart(clock.today);
    const baseEndYmd = config.endAt
      ? dayKeyInTz(new Date(config.endAt).getTime(), orgTz)
      : ymdAddDays(dayKeyInTz(baseStartMs, orgTz), DEFAULT_WINDOW_DAYS - 1);

    // Widen — never narrow — to cover what the organiser has already stated
    // explicitly (sessionWindows are absolute instants they set by hand) or
    // already scheduled. A repair round that reported every card it was handed
    // would teach the organiser to ignore the reason. Epoch sentinels are
    // excluded, or the window swallows 1970 and the bug this wave exists to
    // kill becomes invisible again.
    const occupiedMs = movable
      .filter((f) => f.scheduled_at !== null)
      .map((f) => new Date(f.scheduled_at as string | Date).getTime())
      .filter((t) => !isEpochSentinel(t));
    // A sessionWindow anchored at the epoch is the same input by another door,
    // and widening onto it hides the defect just as thoroughly — a window that
    // opens in 1970 can never be broken. Filtered on the pair so a half-epoch
    // window cannot contribute one usable end and one sentinel.
    const sessionMs = config.sessionWindows
      .map((w) => ({ from: new Date(w.from).getTime(), to: new Date(w.to).getTime() }))
      .filter((w) => !isEpochSentinel(w.from) && !isEpochSentinel(w.to));
    const windowStartMs = Math.min(baseStartMs, ...sessionMs.map((w) => w.from), ...occupiedMs);
    const windowEndMs = Math.max(
      dayEnd(baseEndYmd),
      ...sessionMs.map((w) => w.to),
      ...occupiedMs.map((t) => t + matchMinutes * MS_PER_MIN),
    );
    // #398: the compiled instruction resolves LAST and wins outright. Widening
    // onto already-scheduled dates is right for an inferred window, but it would
    // silently defeat "run all the matches from tomorrow till Friday" — the one
    // window the organiser stated in words. Rendering stays here so there is a
    // single writer of the pack's window strings.
    const resolved =
      opts.resolved ??
      // `courts` lets resolveParsed verify a court-scoped break against the
      // NAMES the model was actually shown — the FILTERED candidate set
      // (P9 pass 3b), never the raw configured list: an instruction naming a
      // court that resolveCandidateCourts already excluded must defer that
      // break rather than compile a rule against a court `settings.courts`
      // does not carry. P9 pass 3d: name -> id, so a break resolveParsed
      // accepts resolves straight to the court's real id.
      resolveParsed(opts.raw ?? null, clock, orgTz, {
        fixtureCount: movable.length,
        courts: new Map(
          candidateCourtIds.ids.map((id) => [courtDirectory.get(id)?.label ?? id, id] as const),
        ),
        parseFailed: opts.parseFailed === true,
      });
    const window =
      resolved.windowMs !== null
        ? {
            start: zonedIso(dayStart(dayKeyInTz(resolved.windowMs.from, orgTz)), orgTz),
            end: zonedIso(dayEnd(dayKeyInTz(resolved.windowMs.to, orgTz)), orgTz),
          }
        : {
            start: zonedIso(dayStart(dayKeyInTz(windowStartMs, orgTz)), orgTz),
            end: zonedIso(dayEnd(dayKeyInTz(windowEndMs, orgTz)), orgTz),
          };
    assumptions.push(...resolved.assumptions);
    // The greedy draft anchors on the window the pack actually ships. Anchored
    // on the inferred start instead, "from tomorrow till Friday" hands the model
    // a draft that sits OUTSIDE `pack.window` — every card arrives pre-flagged,
    // and the model is asked to repair a board we drew wrong.
    const draftAnchorMs = resolved.windowMs?.from ?? windowStartMs;

    // Draft: generate → greedy slotFixtures; refine → the prior proposal
    // verbatim; repair → the movable set's current persisted slots.
    let draft: PackDraftAssignment[];
    if (opts.mode === "generate") {
      // Determinism (defect fix): the greedy solver breaks intra-round ties on
      // SchedulableFixture.id — which is a per-seed random fixture UUID — so an
      // identical logical board produced a different draft (and golden pack) on
      // every reseed. Order the movable set on STABLE domain keys (round_no,
      // seq_in_round, ext_key, then entrant NAMES — never the UUID) and hand the
      // solver a domain-ranked id in place of the UUID, mapping its result back
      // to real fixture ids afterwards. The engine stays untouched.
      const movableEntrantIds = [
        ...new Set(movable.flatMap((f) => [f.home_entrant_id, f.away_entrant_id])),
      ].filter((e): e is string => e !== null);
      const nameByEntrant = new Map<string, string>();
      if (movableEntrantIds.length > 0) {
        const nameRows = await tx<{ id: string; display_name: string }[]>`
          select id, display_name from entrants where id in ${tx(movableEntrantIds)}`;
        for (const r of nameRows) nameByEntrant.set(r.id, r.display_name);
      }
      const nameOf = (e: string | null): string => (e !== null ? nameByEntrant.get(e) ?? "" : "");
      // INVARIANT: this comparator must remain a total order on
      // (round_no, seq_in_round, ext_key, home name, away name) with NO UUID
      // fallback — reintroducing id-based tie-breaks re-breaks cross-reseed
      // determinism (see the double-seed test).
      const orderedMovable = [...movable].sort(
        (a, b) =>
          a.round_no - b.round_no ||
          a.seq_in_round - b.seq_in_round ||
          cmp(a.ext_key ?? "", b.ext_key ?? "") ||
          cmp(nameOf(a.home_entrant_id), nameOf(b.home_entrant_id)) ||
          cmp(nameOf(a.away_entrant_id), nameOf(b.away_entrant_id)),
      );
      const rankById = new Map(orderedMovable.map((f, i) => [f.id, String(i).padStart(6, "0")]));
      const realIdByRank = new Map(orderedMovable.map((f, i) => [String(i).padStart(6, "0"), f.id]));

      // `lockedIds` and `roundRobin` computed once, above every mode branch —
      // see the comments at their declarations. (`roundRobin` used to be
      // computed here, generate-only; C1 gap B hoisted it so `packMovable`'s
      // `stageIds`/`roundNos` below can share it in every mode.)
      const schedulable: SchedulableFixture[] = movable.map((f) => ({
        // Domain-ranked stand-in for the UUID so the solver's tie-break is stable.
        id: rankById.get(f.id)!,
        ...roundFieldsOf(roundRobin, f),
        ...(f.pool_id !== null ? { poolId: f.pool_id } : {}),
        divisionId: f.division_id,
        // stageId unconditional, same as divisionId — `fixtures.stage_id` is
        // NOT NULL. Needed for `validateAssignments`' round-order grouping
        // key (`divisionId`, `stageId`, `poolId`) wherever this board is
        // re-verified after the placer runs.
        stageId: f.stage_id,
        ...(f.home_entrant_id !== null ? { home: f.home_entrant_id } : {}),
        ...(f.away_entrant_id !== null ? { away: f.away_entrant_id } : {}),
        // #396: participants, not named entrants — a TBD slot carries whoever
        // can still advance into it, and the placer must respect that or it
        // hands the referee a board the referee will reject.
        people: participants[f.id] ?? [],
        // Pinned/scope-locked cards stay put — feed them to the solver as-is.
        // P9 pass 3b: `court_id`, the fixture's real identity — `court_label`
        // is frozen legacy and null on anything scheduled since the cutover,
        // which would have handed the greedy placer a `locked.court: undefined`
        // for every real pinned fixture.
        ...(lockedIds.has(f.id)
          ? { locked: { court: f.court_id as string, startAt: new Date(f.scheduled_at as string | Date).getTime() } }
          : {}),
      }));
      const result = slotFixtures({
        fixtures: schedulable,
        // Was `0` — the epoch. `toSlotConfig` uses this only when the division
        // has no configured startAt, and with 0 the model was handed
        // 1970-01-01 as the draft time for every fixture (#397). The honest
        // fallback is the first session hour of the window's first day, in the
        // org zone.
        // `toSlotConfig`, not `toVerifyConfig`: this is the DRAFT placer, and it
        // runs before any instruction has been compiled, so the only `hard`
        // rules that exist here are the durable ones `toSlotConfig` already
        // forwards (#447). The asymmetry is deliberate rather than the one that
        // caused #447 — but it is the same shape, so if a compiled rule ever
        // becomes available at draft time this must move to `toVerifyConfig`.
        // `guardedSettings`, not `settings` (#450): every fixture handed to the
        // placer below carries GUARDED person keys, so a person-scoped durable
        // rule still holding a raw uuid would bind nothing here while the
        // verifier — reading the same rules off the pack — binds it. That fork
        // is the whole failure mode this area keeps producing.
        config: toSlotConfig(
          guardedSettings,
          zonedTimeToUtc(dayKeyInTz(draftAnchorMs, orgTz), DEFAULT_SESSION_HOURS.start, orgTz),
        ),
        // extraExisting is the #350 joint pack's already-drafted divisions;
        // empty for every single-division caller.
        existing: [...obstacleAssignments, ...siblings, ...(opts.extraExisting ?? [])],
      });
      draft = result.assignments.map((a) => ({
        fixture_id: realIdByRank.get(a.fixtureId) ?? a.fixtureId,
        scheduled_at: zonedIso(a.startAt, orgTz),
        court_label: a.court,
      }));
    } else if (opts.mode === "refine") {
      draft = (opts.prior?.assignments ?? [])
        .filter((a) => movableSet.has(a.fixture_id))
        .map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: zonedIso(a.scheduled_at, orgTz),
          court_label: a.court_label,
        }));
    } else {
      // "repair": the movable set's current persisted slots. P9 pass 3b:
      // `court_id`, not the legacy `court_label` — matching on the frozen
      // column silently dropped every fixture scheduled since the cutover
      // from the repair draft, which the model then saw as unplaced.
      draft = movable
        .filter((f) => f.scheduled_at !== null && f.court_id !== null)
        .map((f) => ({
          fixture_id: f.id,
          scheduled_at: zonedIso(f.scheduled_at as string | Date, orgTz),
          court_label: f.court_id as string,
        }));
    }
    // Sentinel kill (#397). A time that predates 1971 is not a fixture time — it
    // is a division that was drafted at the epoch, or a row written before this
    // fix. Null is an honest "unplaced"; 1970-01-01 is a lie, and the model
    // anchors on it. Tested on the instant rather than the rendered string on
    // purpose: west of UTC the epoch renders as 1969-12-31.
    draft = draft.map((d) =>
      d.scheduled_at !== null && isEpochSentinel(new Date(d.scheduled_at).getTime())
        ? { ...d, scheduled_at: null }
        : d,
    );
    draft.sort(byAssignment);

    // #449: pool UUID per movable fixture, for `pack.poolIds`. `PackFixture.pool`
    // below stays the display KEY the model reads; this is the namespace the
    // engine, the DB and every stored rule use.
    const poolIdByFixture = new Map(
      movable.flatMap((f) => (f.pool_id !== null ? [[f.id, f.pool_id] as const] : [])),
    );

    // P9 (stage court tags) -> #622: `PackFixture.courts` input, per FIXTURE.
    // Populated ONLY for a fixture whose own resolved set is a STRICT subset
    // of `candidateCourtIds.ids` — the overwhelming common case (no stage and
    // no round carries required tags of its own, so every fixture resolves to
    // the exact same set as the division) takes no entry at all, which is what
    // keeps `schedule-ai-pack.test.ts`'s byte-identical golden snapshot
    // untouched: nothing in that fixture data carries extra required tags.
    const candidateCourtIdSet = new Set(candidateCourtIds.ids);
    const narrowedCourtsByFixture = new Map<string, string[]>();
    for (const [fixtureId, ids] of fixtureCandidateCourts) {
      if (ids.length >= candidateCourtIdSet.size) continue;
      if (!ids.every((id) => candidateCourtIdSet.has(id))) continue;
      narrowedCourtsByFixture.set(fixtureId, [...ids]);
    }

    const packMovable: PackFixture[] = movable
      .map((f) => ({
        id: f.id,
        ext_key: f.ext_key,
        round: f.round_no,
        seq: f.seq_in_round,
        pool: f.pool_id !== null ? poolKey.get(f.pool_id) ?? null : null,
        home: f.home_entrant_id,
        away: f.away_entrant_id,
        feeds: {
          winner_to: f.winner_to_fixture,
          // Bye/finished feeders already stripped, ordered on the feeder's
          // domain key — see `afterByFixture` above.
          after: [...(afterByFixture.get(f.id) ?? [])],
        },
        current: {
          at:
            f.scheduled_at !== null &&
            !isEpochSentinel(new Date(f.scheduled_at as string | Date).getTime())
              ? zonedIso(f.scheduled_at, orgTz)
              : null,
          // P9 pass 3b: `court_id` — `court_label` is frozen legacy and null
          // on anything scheduled since the cutover, which read as "not on a
          // court yet" for every real placement (structuralCheck's pin check
          // and computeDiff both read this field).
          court: f.court_id,
        },
        pinned: lockedIds.has(f.id),
        // P9 (stage court tags) -> #622: present only when this fixture's own
        // division ∪ stage ∪ round tags genuinely narrow the division-wide
        // set — see `PackFixture.courts`'s own doc comment and
        // `narrowedCourtsByFixture` just above.
        ...(narrowedCourtsByFixture.has(f.id)
          ? { courts: narrowedCourtsByFixture.get(f.id)! }
          : {}),
      }))
      // Same comparator as `participantView` above — see `byBoardOrder`.
      .sort(byBoardOrder);

    // P9: the obstacle order must not key on `court`. Before the cutover that
    // field was the court NAME, so sorting on it was stable across runs and
    // meaningful to read. It is a court UUID now — freshly minted per seed —
    // so an id sort is a fresh PERMUTATION every time the same board is built.
    // Nothing type-checks that away and nothing in the pack looks wrong; the
    // only symptom is that a pack stops reproducing itself (the demo capture
    // fixtures and `seeds.test.ts`'s reseed-determinism check both caught it).
    // Sort on the court's position in `settings.courts` instead — the order
    // the organiser sees and the order `courtDetails` is emitted in — with
    // courts outside that set (archived or since-retagged, which obstacles may
    // legitimately sit on) after it, ordered by label so they are stable too.
    const courtOrderIndex = new Map(candidateCourtIds.ids.map((id, i) => [id, i] as const));
    const courtOrderKey = (id: string): string => {
      const i = courtOrderIndex.get(id);
      return i === undefined
        ? `1:${courtDirectory.get(id)?.label ?? id}`
        : `0:${String(i).padStart(6, "0")}`;
    };

    const packObstacles: PackObstacle[] = [
      ...obstacleFixtures.map((f) => {
        const start = new Date(f.scheduled_at as string | Date).getTime();
        return {
          // P9 pass 3b: `court_id` — `obstacleFixtures` is now filtered on
          // `court_id !== null` above, so `court_label` (still legacy, still
          // possibly null on the same row) is no longer the field that cast
          // is sound against.
          court: f.court_id as string,
          from: zonedIso(start, orgTz),
          to: zonedIso(start + matchMinutes * MS_PER_MIN, orgTz),
          label: `${division.name} · R${f.round_no}`,
        };
      }),
      // Siblings carry no display metadata through siblingAssignments — soft
      // context, so a generic label is enough (never leaks a rival's roster).
      ...siblings.map((a) => ({
        court: a.court,
        from: zonedIso(a.startAt, orgTz),
        to: zonedIso(a.endAt, orgTz),
        label: OTHER_DIVISION_LABEL,
      })),
    ].sort((a, b) => cmp(courtOrderKey(a.court), courtOrderKey(b.court))
      || cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.label, b.label));

    // Entrants + each one's pool, derived from the division's fixtures.
    const entrantPool = new Map<string, string>();
    for (const f of all) {
      if (f.pool_id === null) continue;
      const key = poolKey.get(f.pool_id);
      if (key === undefined) continue;
      for (const e of [f.home_entrant_id, f.away_entrant_id]) {
        if (e !== null && !entrantPool.has(e)) entrantPool.set(e, key);
      }
    }
    const entrantRows = await tx<{ id: string; display_name: string; seed: number | null }[]>`
      select id, display_name, seed from entrants
      where division_id = ${divisionId} and status not in ('withdrawn', 'disqualified')`;
    const packEntrants: PackEntrant[] = entrantRows
      .map((e) => ({ id: e.id, name: e.display_name, pool: entrantPool.get(e.id) ?? null, seed: e.seed }))
      .sort(
        (a, b) =>
          (a.seed ?? Number.MAX_SAFE_INTEGER) - (b.seed ?? Number.MAX_SAFE_INTEGER) ||
          cmp(a.name, b.name) ||
          cmp(a.id, b.id),
      );

    // Entrant-id arrays nested inside people/officials must order on a STABLE
    // domain key — the entrant NAME, never the per-seed UUID — so the pack is
    // byte-identical across reseeds of the same logical board. (Officials may
    // link entrants outside this division; those names are backfilled below.)
    const entrantNameById = new Map(entrantRows.map((e) => [e.id, e.display_name]));
    const byEntrantName = (a: string, b: string): number =>
      cmp(entrantNameById.get(a) ?? "", entrantNameById.get(b) ?? "") || cmp(a, b);
    const entrantNameKey = (ids: readonly string[]): string =>
      ids.map((e) => entrantNameById.get(e) ?? e).join("|");

    // Shared-player map: persons rostered into two or more of this division's
    // entrants — the only ones that create a cross-entrant clash.
    const divEntrantIds = entrantRows.map((e) => e.id);
    const personEntrants = new Map<string, Set<string>>();
    if (divEntrantIds.length > 0) {
      const memberRows = await tx<{ person_id: string; entrant_id: string }[]>`
        select person_id, entrant_id from entrant_members where entrant_id in ${tx(divEntrantIds)}`;
      for (const r of memberRows) {
        (personEntrants.get(r.person_id) ?? personEntrants.set(r.person_id, new Set()).get(r.person_id)!).add(
          r.entrant_id,
        );
      }
    }
    const packPeople: PackPerson[] = [...personEntrants.entries()]
      .filter(([, ents]) => ents.size >= 2)
      .map(([person_id, ents]) => ({ person_id, entrant_ids: [...ents].sort(byEntrantName) }))
      // Order people by their (name-sorted) entrant set, not the random
      // person UUID; person_id is only a last-resort tie-break.
      .sort(
        (a, b) => cmp(entrantNameKey(a.entrant_ids), entrantNameKey(b.entrant_ids)) || cmp(a.person_id, b.person_id),
      );

    // Officials availability (soft context): roster + role_keys + max_per_day
    // + blackout dates + cross-org busy windows + linked entrant ids.
    const officialRows = await loadOfficialsWithEntrants(tx);
    // Backfill names for any official-linked entrants outside this division so
    // their entrant_ids still order by name rather than UUID.
    const unknownEntrantIds = [...new Set(officialRows.flatMap((o) => o.entrant_ids))].filter(
      (e) => !entrantNameById.has(e),
    );
    if (unknownEntrantIds.length > 0) {
      const extraNames = await tx<{ id: string; display_name: string }[]>`
        select id, display_name from entrants where id in ${tx(unknownEntrantIds)}`;
      for (const r of extraNames) entrantNameById.set(r.id, r.display_name);
    }
    const blackoutByOfficial = new Map<string, string[]>();
    for (const r of await loadOfficialBlackouts(tx)) {
      (blackoutByOfficial.get(r.official_id) ?? blackoutByOfficial.set(r.official_id, []).get(r.official_id)!).push(
        r.date,
      );
    }
    const busyByOfficial = new Map<string, string[]>();
    for (const r of busyElsewhere) {
      (busyByOfficial.get(r.official_id) ?? busyByOfficial.set(r.official_id, []).get(r.official_id)!).push(
        zonedIso(r.scheduled_at, orgTz),
      );
    }
    const packOfficials: PackOfficial[] = officialRows
      .map((o) => ({
        id: o.id,
        name: o.display_name,
        role_keys: [...o.role_keys],
        max_per_day: o.max_per_day,
        blackout_dates: [...(blackoutByOfficial.get(o.id) ?? [])].sort(cmp),
        busy_elsewhere: [...(busyByOfficial.get(o.id) ?? [])].sort(cmp),
        entrant_ids: [...new Set(o.entrant_ids)].sort(byEntrantName),
      }))
      .sort((a, b) => cmp(a.name, b.name) || cmp(a.id, b.id));

    const settingsOut: PackSettings = {
      matchMinutes,
      gapMinutes: config.gapMinutes,
      perEntrantMinRest: config.perEntrantMinRest,
      // P9 pass 3b: the FILTERED candidate set, never the raw configured
      // list — the model must only ever be shown, and therefore can only
      // ever propose, a court that is actually a legal placement today
      // (non-archived, carrying every required tag). Same set the draft
      // placer's `guardedSettings` and `resolveParsed` above were given, so
      // the pack cannot show the model a court its own placer disagrees with.
      courts: [...candidateCourtIds.ids],
      sessionWindows: config.sessionWindows
        .map((w) => ({ from: zonedIso(w.from, orgTz), to: zonedIso(w.to, orgTz) }))
        .sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to)),
      // A mid-day break stated in the instruction ("lunch 12PM to 1PM") is a
      // BLACKOUT, which the engine has always modelled — it was only the parser
      // that had no word for it, which is why the model used to compile it as a
      // whole-day not_before/not_after pair and confine the run to the lunch
      // hour. resolveParsed keeps it symbolic because it cannot know the run's
      // days; the expansion belongs here, where the window is settled.
      blackouts: [
        ...config.blackouts,
        ...expandDailyBreaks(
          resolved.dailyBreaks,
          dayKeyInTz(resolved.windowMs?.from ?? windowStartMs, orgTz),
          dayKeyInTz(resolved.windowMs?.to ?? windowEndMs, orgTz),
          orgTz,
        ),
      ]
        .map((b) => ({
          ...(b.court !== undefined ? { court: b.court } : {}),
          from: zonedIso(b.from, orgTz),
          to: zonedIso(b.to, orgTz),
        }))
        .sort((a, b) => cmp(a.court ?? "", b.court ?? "") || cmp(a.from, b.from) || cmp(a.to, b.to)),
      constraints: config.constraints
        ? {
            ...(config.constraints.restMin !== undefined ? { restMin: config.constraints.restMin } : {}),
            ...(config.constraints.restByGroup !== undefined
              ? { restByGroup: config.constraints.restByGroup }
              : {}),
            noBackToBack: config.constraints.noBackToBack,
            startWindows: config.constraints.startWindows.map((w) => ({
              target: w.target,
              ...(w.notBefore !== undefined ? { notBefore: zonedIso(w.notBefore, orgTz) } : {}),
              ...(w.notAfter !== undefined ? { notAfter: zonedIso(w.notAfter, orgTz) } : {}),
            })),
            fieldFairness: config.constraints.fieldFairness,
            parallelism: config.constraints.parallelism,
            crossPersonClash: config.constraints.crossPersonClash,
            // OMITTED when empty, never `[]`. Absence already means "no durable
            // rules", and emitting an empty array on every pack would change the
            // shape of every instruction-free run for no information.
            // #450: the person-scope-resolved copy, so the referee compares a
            // rule against rows in the same namespace. Same array the draft
            // placer above was given.
            ...(guardedHard.length ? { hard: guardedHard } : {}),
          }
        : null,
    };

    const pack: SchedulePack = {
      mode: opts.mode,
      // Omitted when the org declares no calendars, so an existing pack is
      // byte-identical and the AI golden snapshots do not move.
      ...(packCourtCalendars.length > 0 ? { courtCalendars: packCourtCalendars } : {}),
      division: {
        id: division.id,
        name: division.name,
        sport: division.sport_key,
        tz,
      },
      tz: orgTz,
      clock,
      window,
      sessionHours: { ...DEFAULT_SESSION_HOURS },
      parsed: { hard: resolved.hard, soft: resolved.soft, unparsed: resolved.unparsed },
      settings: settingsOut,
      entrants: packEntrants,
      people: packPeople,
      participants,
      // #449: the pool UUID for engine use, alongside the display key on
      // `PackFixture.pool`. Built from `packMovable` so the key order follows the
      // pack's own board order rather than a per-seed row order, exactly as
      // `participants` does — the byte-identical test compares `JSON.stringify`,
      // where insertion order is load-bearing.
      poolIds: Object.fromEntries(
        packMovable.flatMap((f) => {
          const id = poolIdByFixture.get(f.id);
          return id !== undefined ? [[f.id, id] as const] : [];
        }),
      ),
      // C1 gap B: the AI-plan verification twins of `poolIds` just above.
      // `stageIds` is unconditional — `fixtures.stage_id` is NOT NULL, the
      // same fact that makes `schedulable`'s own `stageId: f.stage_id` above
      // unconditional. `roundNos` is gated on the SAME `roundRobin` set that
      // gates `schedulable`'s `roundNo` above (hoisted so every mode shares
      // one query) — see `SchedulePack.roundNos`'s own doc comment for why an
      // ungated forward would recreate the cross-sequence collision this
      // feature exists to prevent. Both built from `packMovable`, in that
      // array's board order, for the same byte-identical-pack reason
      // `poolIds` is.
      stageIds: Object.fromEntries(
        packMovable.map((f) => [f.id, liteById.get(f.id)!.stage_id] as const),
      ),
      roundNos: Object.fromEntries(
        packMovable.flatMap((f) => {
          const src = liteById.get(f.id)!;
          return roundRobin.has(src.stage_id) ? [[f.id, src.round_no] as const] : [];
        }),
      ),
      ...packRoundRules(packMovable, liteById, roundRobin),
      assumptions,
      fixtures: { movable: packMovable, obstacles: packObstacles },
      draft,
      instruction: opts.instruction,
      prior: opts.prior
        ? {
            instruction: opts.prior.instruction,
            assignments: opts.prior.assignments
              .map((a) => ({
                fixture_id: a.fixture_id,
                scheduled_at: zonedIso(a.scheduled_at, orgTz),
                court_label: a.court_label,
              }))
              .sort(byAssignment),
          }
        : null,
      officials: packOfficials,
    };

    return { pack, movableIds: movableSet, courtDirectory: Object.fromEntries(courtDirectory) };
  });
}

/** `SchedulePack.roundRules` for a set of movable fixtures: each one's stage rules, only for those that have any
 *  (so the key is absent, not empty, on a pack with no Swiss stage). */
function packRoundRules(
  packMovable: readonly { id: string }[],
  liteById: ReadonlyMap<string, { stage_id: string }>,
  roundRobin: RoundSequenceStages,
): { roundRules?: Record<string, RoundFields> } {
  const entries = packMovable.flatMap((f) => {
    const rules = roundRulesOf(roundRobin, liteById.get(f.id)!.stage_id);
    return Object.keys(rules).length > 0 ? [[f.id, rules] as const] : [];
  });
  return entries.length > 0 ? { roundRules: Object.fromEntries(entries) } : {};
}
