import "server-only";
import { HttpError } from "@/lib/errors";
import { AiSchedulePlan } from "../schedule-ai-prompt";
import type { SchedulableFixture } from "@seazn/engine/scheduling";
import type { Assignment, OrderDependency } from "@seazn/engine/scheduling";
import { MS_PER_MIN, ms } from "./helpers";
import type { CompetitionPack } from "./types";

/** Raised when a plan/proposal names a fixture this pack does not contain, or a
 *  fixture whose division is not in the run. That is a CALLER bug, never
 *  something a model can cause on the runner path (`jointStructuralCheck` gates
 *  it first), so it fails loudly instead of being defaulted away — see
 *  {@link toJointEngineAssignments}. A caller working from client-supplied
 *  assignments (the Task 6 apply path) must validate ids against the pack before
 *  reaching here, and translate this into its own 4xx. */
export const JOINT_ASSIGNMENT_UNKNOWN = "AI_PLAN_INVALID_ASSIGNMENT";

/** Map the LLM proposal onto engine assignments. Three things differ from the
 *  single-division `toEngineAssignments` (schedule-ai.ts:878):
 *
 *  * `endAt` uses EACH fixture's own division's matchMinutes. A shared duration
 *    is the single easiest way to make this whole module wrong — a 30-minute
 *    reading of a 90-minute division's fixtures reports a clean board.
 *  * `divisionId` is stamped, because it is what `verifyJoint` partitions on.
 *    It has one further effect, deliberate: `effectiveRestMinutes` consults
 *    `constraints.restByGroup[divisionId]`, which the single-division path
 *    never reaches (it leaves divisionId unset). Since each division's pass runs
 *    with that division's own constraints, a restByGroup entry keyed by a
 *    division now governs that division's own fixtures — which is what the field
 *    means.
 *
 *    This bullet used to end "`poolId` is deliberately still NOT stamped,
 *    matching the single-division path exactly." That symmetry was real and the
 *    conclusion was wrong: the single-division path was not a baseline, it was
 *    the same bug (#446). `poolId` is stamped now, on both paths, and the pack
 *    has carried it all along as `PackFixture.pool`.
 *  * An unresolvable assignment THROWS rather than defaulting.
 *
 *  That last one is the important one, and it is why there is no `?? 0` here.
 *  An assignment whose fixture is unknown, or whose division is not in the run,
 *  has no duration and no division. Defaulting it produces something far worse
 *  than an error: a zero-length assignment carrying no `divisionId` matches NO
 *  division's `mine` filter in `verifyJoint`, so it is verified by nobody while
 *  still being injected into every other pass's `existing` as a phantom
 *  zero-duration court booking. A wrong answer that looks like a right one.
 *
 *  The runner cannot reach this — `jointStructuralCheck` rejects foreign ids
 *  before verification — but `verifyJoint` is a pure exported function and the
 *  apply path is expected to reuse this shape over client-supplied assignments,
 *  where no such gate exists. */
export function toJointEngineAssignments(plan: AiSchedulePlan, pack: CompetitionPack): Assignment[] {
  const fixtureById = new Map(pack.fixtures.movable.map((f) => [f.id, f]));
  const minutesByDivision = new Map(pack.divisions.map((d) => [d.id, d.settings.matchMinutes]));
  return plan.assignments.map((a) => {
    const f = fixtureById.get(a.fixture_id);
    if (f === undefined) {
      throw new HttpError(
        500,
        `assignment names a fixture outside the pack: ${a.fixture_id}`,
        JOINT_ASSIGNMENT_UNKNOWN,
      );
    }
    const minutes = minutesByDivision.get(f.division_id);
    if (minutes === undefined) {
      throw new HttpError(
        500,
        `fixture ${a.fixture_id} belongs to a division that is not in this run: ${f.division_id}`,
        JOINT_ASSIGNMENT_UNKNOWN,
      );
    }
    const entrants = [f.home, f.away].filter((e): e is string => e !== null);
    const startAt = ms(a.scheduled_at);
    return {
      fixtureId: a.fixture_id,
      court: a.court_label,
      startAt,
      endAt: startAt + minutes * MS_PER_MIN,
      entrants,
      // #396: participants, not the shared-player map — a TBD bracket slot
      // carries whoever can still advance into it, which is what every person
      // rule needs and what `pack.people` (persons in 2+ entrants) never had.
      // No fallback to a named-entrant derivation on purpose: one would make
      // this read green on a pack that never computed the map.
      people: pack.participants[a.fixture_id] ?? [],
      divisionId: f.division_id,
      // #449: the pool UUID from `pack.poolIds`, NOT `f.pool` — that is the
      // display key the model reads, and it is not even unique across the
      // divisions this pack spans.
      ...(pack.poolIds[a.fixture_id] !== undefined
        ? { poolId: pack.poolIds[a.fixture_id]! }
        : {}),
      // C1 gap B: `stageId` unconditional (`pack.stageIds` is total over
      // `fixtures.movable`), `roundNo` gated on `pack.roundNos` (round-robin
      // only — already filtered per-division at pack-build time, see its
      // own doc comment). Same reasoning as the single-division
      // `toEngineAssignments` (schedule-ai.ts) — without these, no joint
      // AI-plan assignment ever entered `calendar.ts`'s round-order
      // `bySequence` grouping, so the joint planning path could not
      // evaluate round order at all.
      ...(pack.stageIds[a.fixture_id] !== undefined
        ? { stageId: pack.stageIds[a.fixture_id]! }
        : {}),
      ...(pack.roundNos[a.fixture_id] !== undefined
        ? { roundNo: pack.roundNos[a.fixture_id]!, ...pack.roundRules?.[a.fixture_id] }
        : {}),
    };
  });
}

/** Fixed court occupancy the proposal must dodge, as engine assignments.
 *
 *  The synthetic ids are division-scoped (`obstacle:${divisionIndex}:${i}`,
 *  with `x` standing for an obstacle from outside the run) rather than the
 *  per-division `obstacle:${i}` of schedule-ai.ts:904. That id is only unique
 *  within ONE division's list, and a duplicate id on the joint board is not
 *  inert: `validateAssignments` builds a `byId` map over `existing` +
 *  `assignments` for feed-order resolution, where a collision silently drops an
 *  entry.
 *
 *  Carries no `poolId`/`divisionId` DELIBERATELY (#446), even though
 *  `o.division_id` is right here and used for the id key. These rows are
 *  occupancy: no entrants, no people, never in `ruleFixtures`. Every read of
 *  `Assignment.divisionId`/`poolId` is unreachable for them —
 *  `startWindowFor` runs over `assignments` only, the rest pair needs a shared
 *  entrant or person, and `validateInstructionRules` counts `existing` only
 *  where a `RuleFixture` exists, whose own ids win in `scopeCoversFixture`.
 *  So stamping would be inert today and, the day some rule does start reading
 *  `existing`, would silently apply a division rule to a booking from OUTSIDE
 *  the run (`o.division_id === null` — the `"x"` key below) or to a row this run
 *  is not permitted to move. Occupancy carries no group identity, on purpose. */
export function toJointObstacleAssignments(pack: CompetitionPack): Assignment[] {
  const indexByDivision = new Map(pack.divisions.map((d, i) => [d.id, String(i)]));
  const counters = new Map<string, number>();
  return pack.fixtures.obstacles.map((o) => {
    const key = o.division_id === null ? "x" : indexByDivision.get(o.division_id) ?? o.division_id;
    const n = counters.get(key) ?? 0;
    counters.set(key, n + 1);
    return {
      fixtureId: `obstacle:${key}:${n}`,
      court: o.court,
      startAt: ms(o.from),
      endAt: ms(o.to),
      entrants: [],
      people: [],
    };
  });
}

/** The FULL movable set as `SchedulableFixture`s, for a `buildSchedule` call
 *  over this pack (#401, C5 z3 retirement stage B) — the joint twin of
 *  `schedule-ai.ts`'s `toSchedulableFixtures`, and the metadata twin of
 *  `toJointEngineAssignments` just above (which builds the model's PROPOSED
 *  positions; this builds what a fixture IS regardless of where the model put
 *  it). Every field mirrors `toJointEngineAssignments`'s own derivation
 *  exactly (poolId from `pack.poolIds`, divisionId from the fixture's OWN
 *  `division_id`, stageId from `pack.stageIds`, roundNo from
 *  `pack.roundNos`, people from `pack.participants`), so the two can never
 *  disagree about which rule binds which fixture (#447).
 *
 *  Carries no `.locked` anchor even for a pinned fixture, for the same reason
 *  the single-division twin does not: the repair round always hands
 *  `solveBoard` a `frozen`/`board` pair covering every pinned id. */
export function toJointSchedulableFixtures(pack: CompetitionPack): SchedulableFixture[] {
  return pack.fixtures.movable.map((f) => ({
    id: f.id,
    ...(pack.roundNos[f.id] !== undefined ? { roundNo: pack.roundNos[f.id]!, ...pack.roundRules?.[f.id] } : {}),
    ...(f.home !== null ? { home: f.home } : {}),
    ...(f.away !== null ? { away: f.away } : {}),
    people: pack.participants[f.id] ?? [],
    ...(pack.poolIds[f.id] !== undefined ? { poolId: pack.poolIds[f.id]! } : {}),
    divisionId: f.division_id,
    ...(pack.stageIds[f.id] !== undefined ? { stageId: pack.stageIds[f.id]! } : {}),
  }));
}

/** Direct winner/loser feeds across the whole union — the joint mirror of
 *  `packFeedDependencies` (schedule-ai.ts:957). Feeds are within-division in
 *  practice, but the dependency list is resolved against the whole board by the
 *  engine, so it is built over the whole board here too. */
export function jointFeedDependencies(pack: CompetitionPack): OrderDependency[] {
  const deps: OrderDependency[] = [];
  for (const f of pack.fixtures.movable) {
    for (const dependsOn of f.feeds.after) {
      deps.push({ fixtureId: f.id, dependsOn, direct: true });
    }
  }
  return deps;
}
