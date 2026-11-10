import "server-only";
import {
  isBlockingConflict,
  type Assignment,
  type OrderDependency,
  type RuleCode,
  type RuleFixture,
  type SchedulableFixture,
  type VerifyConfig,
} from "@seazn/engine/scheduling";
import { AI_VERIFY_POLICY, buildEngineConstraints } from "@/server/usecases/engine-constraints";
import type { AiSchedulePlan } from "../schedule-ai-prompt";
import { MS_PER_MIN, toMs } from "./helpers";
import type { AiPlanResult, SchedulePack } from "./types";

// A verifier conflict blocks when it makes the schedule physically impossible —
// a court double-booking, or a direct feed scheduled before its source ends.
// Same taxonomy as the drag-drop board (schedule.ts mapConflicts). Rest,
// blackout, session-window, person-overlap and indirect order land in warnings.
// Exported so the #350 joint runner classifies a joint conflict report with the
// SAME taxonomy — a cross-division court clash must block exactly as a
// within-division one does.
// #399 moved the answer itself into the engine, beside the reasons: the board's
// persistence gates need it too, and `schedule.ts` cannot import this module
// (the dependency runs the other way). Re-exported under the name every call
// site already uses.
export const isBlocking = isBlockingConflict;

/** Only the codes a `Conflict` can carry. The prompts also teach H1 and H7, and
 *  the joint J-series, but none of those map to a `ConflictReason` — passing one
 *  through would put a value nothing can render into the wire enum. */
const CITED_RULE = /\b(H[2-6]|H8)\b/;

/**
 * The rule an unschedulable row breaks (#399). The prompt asks the model to cite
 * the hard rule that stopped it, so when it did, that is the answer. When it did
 * not, the honest answer is `CAP`: demand exceeded capacity, no single rule was
 * violated, and the schedule simply cannot exist. A rule code invented for that
 * case would send the repair round after something that is not wrong.
 */
export function unschedulableRule(reason: string): RuleCode {
  return (CITED_RULE.exec(reason.toUpperCase())?.[0] as RuleCode | undefined) ?? "CAP";
}

/** Structural gate run before the engine verifier (01 §1 hard rule 1/7): every
 *  movable id appears exactly once, no foreign ids, no unknown courts, no pinned
 *  fixture nudged off its current slot. Returns a human note on the first
 *  violation, or null when the plan is well-formed. */
export function structuralCheck(plan: AiSchedulePlan, movableIds: Set<string>, pack: SchedulePack): string | null {
  const courts = new Set(pack.settings.courts);
  const pinned = new Map(pack.fixtures.movable.filter((f) => f.pinned).map((f) => [f.id, f]));
  // P9 (stage court tags): a fixture whose stage narrows the division-wide
  // set (`PackFixture.courts` present — see that field's own doc comment)
  // must land on one of ITS OWN candidate courts, not merely any
  // division-wide one — checked below, alongside the `courts.has(...)` check
  // this narrows.
  const narrowedCourts = new Map(
    pack.fixtures.movable
      .filter((f) => f.courts !== undefined)
      .map((f) => [f.id, new Set(f.courts!)] as const),
  );
  const seen = new Set<string>();
  const placed = new Set<string>();
  for (const a of plan.assignments) {
    if (!movableIds.has(a.fixture_id)) return `assignment references non-movable fixture ${a.fixture_id}`;
    if (seen.has(a.fixture_id)) return `fixture ${a.fixture_id} appears more than once`;
    seen.add(a.fixture_id);
    placed.add(a.fixture_id);
    if (!courts.has(a.court_label)) return `assignment uses a court not in settings.courts: ${a.court_label}`;
    const pin = pinned.get(a.fixture_id);
    // A pin's OWN current court is exempt from the narrow check: a pin forces
    // its assignment to echo `pin.current.court` exactly (the "must not
    // move" check just below), so if a stage's required_court_tags narrowed
    // the candidate set out from under an already-pinned fixture's current
    // court (a retroactive tag change), the narrow check would otherwise
    // reject the only court the pin check will ever accept — no valid plan
    // could exist for that fixture again. Same "an existing placement must
    // keep validating clean against a retroactive tag change" principle
    // court-candidates.ts's ruling 3 already protects on the verify path.
    const narrow = narrowedCourts.get(a.fixture_id);
    if (narrow && !narrow.has(a.court_label) && !(pin && pin.current.court === a.court_label)) {
      return `assignment uses a court not permitted for fixture ${a.fixture_id}'s stage: ${a.court_label}`;
    }
    if (pin && (pin.current.at === null || toMs(pin.current.at) !== toMs(a.scheduled_at) || pin.current.court !== a.court_label)) {
      return `pinned fixture ${a.fixture_id} must not move`;
    }
  }
  for (const u of plan.unschedulable) {
    if (!movableIds.has(u.fixture_id)) return `unschedulable references non-movable fixture ${u.fixture_id}`;
    if (seen.has(u.fixture_id)) return `fixture ${u.fixture_id} appears more than once`;
    seen.add(u.fixture_id);
    // A pinned (schedule-locked OR scope-locked, #pins-in-build Task 4) fixture
    // may never be dropped: marking it unschedulable silently loses a locked
    // slot, so reject before verification.
    if (pinned.has(u.fixture_id)) return `pinned fixture ${u.fixture_id} cannot be marked unschedulable`;
  }
  for (const id of movableIds) {
    if (!seen.has(id)) return `movable fixture ${id} is missing from the plan`;
  }
  // Every pinned movable fixture must land in assignments (at its exact current
  // slot, enforced in the assignments loop) — never absent, never diverted.
  for (const [id] of pinned) {
    if (movableIds.has(id) && !placed.has(id)) return `pinned fixture ${id} must stay at its current slot`;
  }
  return null;
}

/** Map the LLM proposal onto engine assignments (ISO → epoch ms). Entrants and
 *  people come from the pack so the verifier can catch overlaps.
 *
 *  `poolId`/`divisionId` come from the pack too (#446), from the same two pack
 *  fields `packRuleFixtures` below already reads. They are what makes a
 *  pool- or division-targeted `restByGroup` entry actually bind on this path.
 *
 *  `startWindows` too, since #458: `verifyConfig` below used to pin
 *  `startWindows: []`, so this path was blind to every start window whatever it
 *  targeted and `repair-domain` clipped the repair domain to that same empty
 *  config. It now goes through `buildEngineConstraints`, which converts them.
 *  Stamping the group identity here is what makes a pool-targeted one bind at
 *  all; `schedule-group-targeting.test.ts` asserts both halves end to end, so
 *  this comment and that test cannot drift apart silently.
 *
 *  Exported for the same reason its joint twin `toJointEngineAssignments` is:
 *  the verify seam is testable without a model round trip. */
export function toEngineAssignments(plan: AiSchedulePlan, pack: SchedulePack): Assignment[] {
  const fixtureById = new Map(pack.fixtures.movable.map((f) => [f.id, f]));
  const durMs = pack.settings.matchMinutes * MS_PER_MIN;
  return plan.assignments.map((a) => {
    const f = fixtureById.get(a.fixture_id);
    const entrants = f ? [f.home, f.away].filter((e): e is string => e !== null) : [];
    const startAt = toMs(a.scheduled_at);
    return {
      fixtureId: a.fixture_id,
      court: a.court_label,
      startAt,
      endAt: startAt + durMs,
      entrants,
      // #396: participants, not the shared-player map — a TBD slot carries
      // whoever can still advance into it, which is what every person rule
      // needs and what `pack.people` (pairs sharing an entrant) never had.
      people: pack.participants[a.fixture_id] ?? [],
      // #449: the pool UUID from `pack.poolIds`, NOT `f.pool` — that is the
      // display key the model reads, and stamping it here put this path in a
      // different namespace from the board path, `RuleFixture.poolId` and every
      // stored rule.
      ...(pack.poolIds[a.fixture_id] !== undefined
        ? { poolId: pack.poolIds[a.fixture_id]! }
        : {}),
      divisionId: pack.division.id,
      // C1 gap B: `stageId` unconditional (`pack.stageIds` is total over
      // `fixtures.movable`, same fact that makes it unconditional there),
      // `roundNo` gated on `pack.roundNos` (round-robin only, already
      // filtered at pack-build time — see its own doc comment). Without
      // these, every AI-plan assignment landed in one anonymous bucket with
      // no round data and `calendar.ts`'s round-order pair scan skipped it
      // outright — the AI planning path could not evaluate round order at
      // all.
      ...(pack.stageIds[a.fixture_id] !== undefined
        ? { stageId: pack.stageIds[a.fixture_id]! }
        : {}),
      ...(pack.roundNos[a.fixture_id] !== undefined
        ? { roundNo: pack.roundNos[a.fixture_id]!, ...pack.roundRules?.[a.fixture_id] }
        : {}),
    };
  });
}

/** Fixed court occupancy the proposal must dodge (other stages + siblings).
 *
 *  DELIBERATELY carries no `poolId`/`divisionId` (#446), unlike every other
 *  adapter in this file. A `PackObstacle` is a court booking — an out-of-run
 *  division's placement, another stage's decided fixture, an outside hire — and
 *  it has no entrants and no people, so no rest pair and no start-window bound
 *  can ever reach it (`startWindowFor` runs over `assignments` only; the rest
 *  loop needs a shared entrant or person). Stamping a FOREIGN division's id on
 *  a row this run may not move would be a rule match invented in the opposite
 *  direction — the pack does not even carry the pool that row sat in. */
export function toObstacleAssignments(pack: SchedulePack): Assignment[] {
  return pack.fixtures.obstacles.map((o, i) => ({
    fixtureId: `obstacle:${i}`,
    court: o.court,
    startAt: toMs(o.from),
    endAt: toMs(o.to),
    entrants: [],
    people: [],
  }));
}

/** The FULL movable set as `SchedulableFixture`s, for a `buildSchedule` call
 *  over this pack (#401, C5 z3 retirement stage B) — the metadata twin of
 *  `toEngineAssignments` just above, which builds the model's PROPOSED
 *  positions; this builds what a fixture IS regardless of where the model
 *  chose to put it. Every field mirrors `toEngineAssignments`'s own
 *  derivation exactly (poolId from `pack.poolIds`, divisionId from
 *  `pack.division.id`, stageId from `pack.stageIds`, roundNo from
 *  `pack.roundNos`, people from `pack.participants`), so the two can never
 *  disagree about which rule binds which fixture — the placer/verifier fork
 *  this codebase keeps naming as its recurring defect (#447).
 *
 *  Carries no `.locked` anchor even for a pinned fixture: the repair round
 *  always hands `solveBoard` a `frozen`/`board` pair covering every pinned
 *  id, so a second, redundant anchor mechanism here is not needed and not
 *  worth a second source of truth. */
export function toSchedulableFixtures(pack: SchedulePack): SchedulableFixture[] {
  return pack.fixtures.movable.map((f) => ({
    id: f.id,
    // X-SW-31: the round's rules travel with the round (`pack.roundRules`), on every fixture of the sequence.
    ...(pack.roundNos[f.id] !== undefined ? { roundNo: pack.roundNos[f.id]!, ...pack.roundRules?.[f.id] } : {}),
    ...(f.home !== null ? { home: f.home } : {}),
    ...(f.away !== null ? { away: f.away } : {}),
    people: pack.participants[f.id] ?? [],
    ...(pack.poolIds[f.id] !== undefined ? { poolId: pack.poolIds[f.id]! } : {}),
    divisionId: pack.division.id,
    ...(pack.stageIds[f.id] !== undefined ? { stageId: pack.stageIds[f.id]! } : {}),
    // #622 review: `PackFixture.courts` (present only when this fixture's own
    // division ∪ stage ∪ round tags narrow it below the pack-wide set — see
    // that field's own doc comment) was never copied here, so the CP-SAT
    // repair round this feeds (`solveBoard`, below) had no idea a round-scoped
    // tag existed and could relocate a tagged fixture onto any court.
    ...(f.courts !== undefined ? { allowedCourts: f.courts } : {}),
  }));
}

/** Exactly the fields `toRuleFixture` reads, and nothing else — the widened
 *  parameter that lets a `fixtures` row reach the one builder (#447).
 *
 *  Named after what it is rather than where it comes from: `PackFixture`
 *  satisfies it structurally, and `rowToRuleFixture` in `schedule.ts` builds one
 *  by renaming a DB row's columns. Keeping it this narrow is the point — a
 *  parameter that demanded the whole `PackFixture` would have forced the board
 *  to grow a RuleFixture literal of its own. */
export interface RuleFixtureSource {
  id: string;
  ext_key: string | null;
  pool: string | null;
  feeds: { winner_to: string | null };
}

/**
 * THE one place a `RuleFixture` is built — for the single-division pack here,
 * for both joint producers in `competition-schedule-ai.ts` (#443), and for the
 * board paths via `rowToRuleFixture` (#447).
 *
 * It is one function rather than three literals because of what #443 was: two
 * copies of a join drifted onto a shared wrong assumption, and the second copy
 * is exactly what made the first invisible. `winnerTo` and `id` must stay in ONE
 * namespace — `winnerTo` carries `fixtures.winner_to_fixture`, a uuid FK to
 * `fixtures.id`, and the engine now joins the feed edge on that id. `extKey`
 * carries `fixtures.ext_key`, nullable text, and is a different namespace with
 * no converter anywhere.
 *
 * A producer that put an ext key in `winnerTo` would type-check — `RuleFixture`
 * declares both `string | null` — and would fail SILENTLY, because a join that
 * resolves nothing reports nothing: `min_rest_minutes` would go on compiling and
 * displaying as enforced while binding nothing at all. One producer means one
 * thing to guard, and `schedule-ai-repair.test.ts` guards it.
 *
 * `divisionId` is a parameter because the packs source it differently: the
 * single-division pack takes it from the division it is a pack OF, the joint
 * pack from each fixture's own `division_id`.
 *
 * The parameter is `RuleFixtureSource`, not `PackFixture`, since #447: the board
 * paths (`schedule.ts`) hold the same five facts on a `fixtures` ROW under
 * different column names, and they need a `RuleFixture` too. Widening the
 * parameter to exactly the fields this function reads lets `rowToRuleFixture`
 * rename its columns and delegate here, so there is still ONE assignment of
 * `winnerTo` in the codebase and still one thing to guard — rather than a second
 * builder in a second module, which is precisely the shape #443 was.
 */
export function toRuleFixture(f: RuleFixtureSource, divisionId: string): RuleFixture {
  return {
    id: f.id,
    extKey: f.ext_key,
    divisionId,
    ...(f.pool !== null ? { poolId: f.pool } : {}),
    winnerTo: f.feeds.winner_to,
  };
}

/** The fixture metadata typed rules need and `Assignment` does not carry (#398).
 *  `winnerTo` is the ONLY definition of terminal — never a round number, which
 *  is a display label an elimination bracket numbers sparsely. */
export function packRuleFixtures(pack: SchedulePack): RuleFixture[] {
  // #449: the pool UUID, overriding the display key `PackFixture.pool` carries.
  // `scopeCoversFixture` reads `f?.poolId ?? a.poolId`, so a RuleFixture MASKS
  // its assignment's value — a key here would defeat the uuid stamped by
  // `toEngineAssignments` and put the whole AI path back in a second namespace.
  return pack.fixtures.movable.map((f) =>
    toRuleFixture({ ...f, pool: pack.poolIds[f.id] ?? null }, pack.division.id),
  );
}

/** Exported for the same reason the joint twin `verifyConfigFor` is: it is a
 *  pure derivation of the pack, and a test that asserts what the referee is
 *  handed must be able to build it the way the runner does. */
export function verifyConfig(pack: SchedulePack): VerifyConfig {
  return {
    // #398: the org zone plus ONE merged hard-rule stream. A rule compiled from
    // the instruction and a durable division rule are the same vocabulary and
    // the same enforcement, so the referee reads one list. No `restByDivision`
    // here — a single-division run has only one division's rest to be the
    // maximum of.
    tz: pack.tz,
    ...(pack.courtCalendars !== undefined && pack.courtCalendars.length > 0
      ? { courtCalendars: pack.courtCalendars }
      : {}),
    hard: [...pack.parsed.hard, ...(pack.settings.constraints?.hard ?? [])],
    ruleFixtures: packRuleFixtures(pack),
    // Both rest sources, plus the match length noBackToBack needs: the engine's
    // effectiveRestMinutes takes the strictest, exactly as the solver does.
    perEntrantMinRest: pack.settings.perEntrantMinRest,
    matchMinutes: pack.settings.matchMinutes,
    // #458: the ONE builder the board path and the joint path also go through.
    // This site used to pin `startWindows: []` — the pack carries them as ISO
    // strings for the model while the engine wants epoch ms, and rather than
    // convert, the copy here dropped them. So this referee was blind to EVERY
    // start window whatever it targeted, and `repair-domain` clipped the repair
    // domain to the same empty config. The builder converts them.
    //
    // `AI_VERIFY_POLICY` (`hard: false`): the durable rules already ride the
    // TOP-LEVEL `hard` field above, merged with the compiled instruction stream.
    // `effectiveHard` merges the two, so carrying them here as well would count
    // every durable rule twice.
    ...(pack.settings.constraints !== null
      ? { constraints: buildEngineConstraints(pack.settings.constraints, AI_VERIFY_POLICY) }
      : {}),
    gapMinutes: pack.settings.gapMinutes,
    blackouts: pack.settings.blackouts.map((b) => ({
      ...(b.court !== undefined ? { court: b.court } : {}),
      from: toMs(b.from),
      to: toMs(b.to),
    })),
    sessionWindows: pack.settings.sessionWindows.map((w) => ({ from: toMs(w.from), to: toMs(w.to) })),
    // #397: the resolved window, in the engine's epoch-ms unit. Warn-only —
    // `isBlocking` still covers court and direct order alone, and W4 (#399) is
    // what turns this into a delta-based block.
    window: windowBounds(pack.window),
  };
}

/**
 * The pack renders the window's end as the last whole SECOND of the final day
 * (`…T23:59:59`) — the form a model reads correctly. The engine compares an
 * ms-resolution `endAt` against it, so the bound it needs is the EXCLUSIVE
 * instant after that second: a 22:30 match of 90 minutes ends at exactly
 * 00:00:00.000 and occupies only days inside the window, but `endAt > to`
 * against 23:59:59.000 reports it against the very day it legally sits on.
 * Shared with the joint verifier so the two cannot drift.
 */
export function windowBounds(window: { start: string; end: string }): { from: number; to: number } {
  return { from: toMs(window.start), to: toMs(window.end) + 1000 };
}

/** feeds.after are direct winner/loser feeds (schedule.ts feedDependencies);
 *  an order violation on one blocks. Deps whose source isn't placed are ignored
 *  by validateAssignments. */
export function packFeedDependencies(pack: SchedulePack): OrderDependency[] {
  const deps: OrderDependency[] = [];
  for (const f of pack.fixtures.movable) {
    for (const dependsOn of f.feeds.after) {
      deps.push({ fixtureId: f.id, dependsOn, direct: true });
    }
  }
  return deps;
}

/** proposal vs each movable fixture's current slot (design §3 diff groups). */
export function computeDiff(plan: AiSchedulePlan, pack: SchedulePack): AiPlanResult["diff"] {
  const proposalById = new Map(plan.assignments.map((a) => [a.fixture_id, a]));
  const unsched = new Set(plan.unschedulable.map((u) => u.fixture_id));
  const diff: AiPlanResult["diff"] = { moved: [], placed: [], unscheduled: [], unchanged: [] };
  for (const f of pack.fixtures.movable) {
    const a = proposalById.get(f.id);
    if (a) {
      const hadSlot = f.current.at !== null && f.current.court !== null;
      if (!hadSlot) diff.placed.push(f.id);
      else if (toMs(f.current.at!) === toMs(a.scheduled_at) && f.current.court === a.court_label) diff.unchanged.push(f.id);
      else diff.moved.push(f.id);
    } else if (unsched.has(f.id)) {
      diff.unscheduled.push(f.id);
    }
  }
  return diff;
}
