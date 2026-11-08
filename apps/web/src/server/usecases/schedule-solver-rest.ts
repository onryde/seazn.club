/**
 * The AUTO pass and a declared rest, against the live placement solver (#452 flake). Two layers, owner-approved
 * together; `autoBuildSchedule` is the one entry both auto-pass call sites in `schedule.ts` use.
 *
 * LAYER 1 — the request carries every pool's rest. A rest reaches the solver ONLY as a `RuleGroup` (the wire has no
 * other field for it), and the engine builds those per DIVISION: `build.ts` `restByDivisionForWire` asks `restFloor`
 * with `{ divisionId }` alone, by design, and says why — a pool-keyed `restByGroup` entry "has nowhere to land" in a
 * division-keyed map. Finding S27 (docs/superpowers/specs/2026-09-03-scheduling-walkthrough-findings.md) recorded the
 * gap; smoke's `#452 pools/auto` check is its witness: `{ division: 30, strictPool: 90 }` went out as 30 for every
 * fixture, the solver honestly produced 30, and the verifier then measured the strict pool against 90.
 *
 * `RuleGroup` is a set of FIXTURE IDS, so it can carry a pool without a proto change. `withPoolRest` appends one group
 * per pool whose effective rest (`effectiveRestMinutes`, the #459 MAX rule — the SAME resolver the greedy placer and
 * the verifier ask, with the fixture's `poolId` AND `divisionId`) is ABOVE its division's, which the engine already
 * sends. A pool at or below its division's floor adds nothing, so a board with no raising pool entry sends a request
 * byte-identical to before. Groups are APPENDED: a pinned row names a group by array position, so every index the
 * engine already resolved stays put, and a pinned card of the pool gets the new group's index added to its own.
 *
 * Not max-collapsed into the division, for the reason the engine gives: raising a sibling pool's floor invents a rule
 * nobody configured and can turn a feasible board infeasible. A per-pool group binds the pool's own cards only.
 *
 * When the engine closes S27 itself (widening `buildRuleGroups`' division-keyed parameter), this layer becomes a
 * duplicate group with the same rest — harmless, and then deletable.
 *
 * LAYER 2 — the auto pass refuses a solver board that breaks a declared rest. `rest` is warn-only at the engine's
 * verifier gate (`isBlockingConflict` is court / person_overlap / window / direct order), which is right for an
 * organiser's own manual move, drag or apply and stays so — but it means a solver board that ignores a rest ships as
 * `ok`, which is exactly how CI's failing run read. In the AUTO pass only, such a board is treated as rejected and the
 * greedy fallback ships, under the engine's own `verifier_rejected` status (its meaning: the solver's board failed
 * the verifier, the greedy seed was returned instead). Only a breach the solver could see in its request, and that a
 * card it placed takes part in, counts: one between two cards the organiser pinned is not the solver's doing, and a
 * person rest against a sibling division's card was never on its wire. Both stay warnings and refuse nothing.
 */
import {
  buildSchedule,
  deltaConflicts,
  effectiveRestMinutes,
  validateAssignments,
  type Assignment,
  type BuildInput,
  type BuildResult,
  type Conflict,
  type PlacementSolver,
  type SchedulableFixture,
  type SolveBuildInput,
} from "@seazn/engine/scheduling";

type RestConfig = Parameters<typeof effectiveRestMinutes>[0];

/** One pool whose effective rest is above its division's: its fixtures, and the rest they are held to. */
interface PoolRest {
  minutes: number;
  members: ReadonlySet<string>;
}

/**
 * The pools of `fixtures` whose effective rest exceeds their division's. Keyed by `(divisionId, poolId)` rather than
 * the pool id alone, so a pool that somehow spanned two divisions would be two rules resolved against two floors
 * instead of one rule resolved against whichever division was seen first. Sorted by key: the groups go on the wire in
 * this order, and the same board must produce the same request twice (`build-determinism`).
 */
export function poolRestRules(fixtures: readonly SchedulableFixture[], config: RestConfig): PoolRest[] {
  const byKey = new Map<string, { poolId: string; divisionId: string | undefined; members: Set<string> }>();
  for (const f of fixtures) {
    if (f.poolId === undefined) continue;
    const key = JSON.stringify([f.divisionId ?? null, f.poolId]);
    const entry = byKey.get(key) ?? { poolId: f.poolId, divisionId: f.divisionId, members: new Set<string>() };
    entry.members.add(f.id);
    byKey.set(key, entry);
  }
  const rules: PoolRest[] = [];
  for (const [, { poolId, divisionId, members }] of [...byKey].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const pool = effectiveRestMinutes(config, { poolId, divisionId });
    const division = effectiveRestMinutes(config, { divisionId });
    if (pool > division) rules.push({ minutes: pool, members });
  }
  return rules;
}

/** `input` with one rule group appended per pool rule that names a card in the request, and every pinned row of such a
 *  pool counted against it. Returns `input` itself when nothing is added. */
export function withPoolRestGroups(input: SolveBuildInput, rules: readonly PoolRest[]): SolveBuildInput {
  const base = input.ruleGroups ?? [];
  const added = rules.flatMap((rule) => {
    const fixtureIds = input.fixtures.filter((f) => rule.members.has(f.fixtureId)).map((f) => f.fixtureId);
    // A pool with nothing left to place still ships its group, EMPTY, when one of its cards is a pinned row: the pin's
    // rest is the MAX over the groups it counts against, and it binds every free card that shares an entrant with it
    // (a later stage's fixture, say). The wire allows an empty group (`SolveBuildInput.ruleGroups`' own comment). A pool
    // with no card in the request at all binds nothing and is left off.
    const pinned = input.existing.some((row) => rule.members.has(row.fixtureId));
    return fixtureIds.length === 0 && !pinned ? [] : [{ rule, group: { fixtureIds, minRestMinutes: rule.minutes } }];
  });
  if (added.length === 0) return input;
  return {
    ...input,
    ruleGroups: [...base, ...added.map((a) => a.group)],
    existing: input.existing.map((row) => {
      const extra = added.flatMap((a, i) => (a.rule.members.has(row.fixtureId) ? [base.length + i] : []));
      return extra.length === 0 ? row : { ...row, ruleGroupIndices: [...(row.ruleGroupIndices ?? []), ...extra] };
    }),
  };
}

/** Layer 1 as a solver port: `solve`, handed each request with the pools' rest groups added. Nothing is awaited ahead
 *  of the call, so this adds no latency to an answer the engine can give without the solver (`solver_busy`, R17). */
export function withPoolRest(solve: PlacementSolver, fixtures: readonly SchedulableFixture[], config: RestConfig): PlacementSolver {
  const rules = poolRestRules(fixtures, config);
  if (rules.length === 0) return solve;
  return (input, ctx) => solve(withPoolRestGroups(input, rules), ctx);
}

const isRest = (c: Conflict): boolean => c.reason === "rest";

/** A solver that proves nothing and places nothing: the engine answers it with the greedy seed — the same board every
 *  one of its fallback exits returns — without a network call. */
const NO_VERDICT: PlacementSolver = async () => ({
  assignments: [],
  status: "UNKNOWN",
  tiersCompleted: 0,
  objectiveValues: [],
  elapsedMs: 0,
  wallExhausted: false,
});

/**
 * The rest breaches the SOLVER is answerable for on `board`: those it could see in the request it was sent, and that
 * a card it placed takes part in.
 *
 * WHAT IT COULD SEE (orchestrator ruling under the owner's product-owner delegation, #1143 review): the cards in its
 * request, as the wire carries them. Its own fixtures carry entrants AND people; the pinned and existing rows it is
 * handed carry entrants only (`PinnedRow` has no people field — `scheduler.proto`, `build.ts`'s `existing` map). So a
 * person-rest breach against a sibling division's card is one it was never told about: that stays the non-blocking
 * warning it always was, or every multi-division event with shared players would be downgraded to greedy.
 *
 * THE PAIR, NOT THE ROW. The verifier files a rest row under ONE card of the pair — `pairRestMinutesWith(a, other)`
 * starts from `a`'s own rest, so a pinned card in a 90-minute pool and a solver card with 30 minutes, 60 apart, is a
 * row on the PIN only. So this asks which rows the solver's cards ADD: the verifier's rest rows over the solver's view
 * (its cards plus the rows it was handed), less those over the handed rows alone. A breach between two of the
 * organiser's own pinned cards is on both sides and cancels; a breach the solver's card is half of is not.
 */
function solverRestBreaches(
  board: readonly Assignment[],
  input: BuildInput,
  placedBySolver: ReadonlySet<string>,
  handedRows: ReadonlySet<string>,
): Conflict[] {
  const cards = new Map<string, Assignment>();
  for (const a of [...(input.existing ?? []), ...board]) cards.set(a.fixtureId, a);
  const solverCards = [...cards.values()].filter((a) => placedBySolver.has(a.fixtureId));
  const handed = [...cards.values()]
    .filter((a) => !placedBySolver.has(a.fixtureId) && handedRows.has(a.fixtureId))
    .map((a) => ({ ...a, people: [] }));
  const restRows = (cardsSeen: readonly Assignment[]) =>
    validateAssignments(cardsSeen, input.config, [], input.dependencies ?? []).filter(isRest);
  return deltaConflicts(restRows(handed), restRows([...handed, ...solverCards]));
}

/**
 * The greedy fallback's input: `input` with every frozen card that is anchored only by `current` LOCKED to that slot.
 * The engine's fallback is the plain seed, which knows nothing of a `current`-only anchor and re-places such a card
 * (see `reflowExisting`'s doc comment); REFLOW then puts the card back on its real slot and keeps greedy's slots for
 * everything else, so the shipped board could carry the very rest breach, or a court clash, it was rejected for —
 * beside a card the organiser dragged. Locked, the seed places around the real slot instead.
 */
function anchoredForFallback(input: BuildInput): readonly SchedulableFixture[] {
  const frozen = new Set(input.frozen ?? []);
  const at = new Map((input.current ?? []).map((a) => [a.fixtureId, a] as const));
  return input.fixtures.map((f) => {
    const slot = f.locked === undefined && frozen.has(f.id) ? at.get(f.id) : undefined;
    return slot === undefined ? f : { ...f, locked: { court: slot.court, startAt: slot.startAt } };
  });
}

/**
 * Layer 2 over `buildSchedule`. Returns its result unchanged unless it shipped the SOLVER's board (`engine:
 * "optimized"`, the engine's only exit that does) carrying a rest breach the solver could see and took part in
 * ({@link solverRestBreaches}). Then the greedy board ships instead, as `verifier_rejected`, with the solver's own
 * `tiersCompleted` and `budgetExpired` — the shape the engine's own verifier-rejected exit has.
 *
 * "A card the solver placed" is read off the solver's own reply, and "a row it was handed" off its own request, never
 * re-derived from `frozen`/`locked`.
 *
 * The greedy board is rebuilt by asking the engine again with `NO_VERDICT`, never assembled here: the seed's
 * construction (pins, `current` anchoring, legalisation) belongs to the engine, and a second copy of it is the
 * placer/verifier fork this code exists to close. Only paid on the rejection path.
 */
export async function buildScheduleHonouringRest(input: BuildInput): Promise<BuildResult> {
  const placedBySolver = new Set<string>();
  const handedRows = new Set<string>();
  // Records what the solver was handed and what it placed. The call itself is made at once, unchanged — nothing is
  // awaited ahead of it.
  const solve: PlacementSolver = async (request, ctx) => {
    for (const row of request.existing) handedRows.add(row.fixtureId);
    const outcome = await input.solve(request, ctx);
    if (outcome.status === "OPTIMAL" || outcome.status === "FEASIBLE") {
      for (const a of outcome.assignments) placedBySolver.add(a.fixtureId);
    }
    return outcome;
  };
  const out = await buildSchedule({ ...input, solve });
  if (out.engine !== "optimized") return out;
  // Cheap gate first: a board the full verifier finds no rest row on has none the solver could see either.
  if (!out.conflicts.some(isRest)) return out;
  const breaches = solverRestBreaches(out.assignments, input, placedBySolver, handedRows);
  if (breaches.length === 0) return out;
  const fallback = await buildSchedule({ ...input, fixtures: anchoredForFallback(input), solve: NO_VERDICT });
  if (fallback.engine !== "greedy") {
    // A solver that placed nothing cannot have produced a solver board: the engine changed under this code.
    throw new Error(`buildScheduleHonouringRest: the no-verdict rebuild returned engine "${fallback.engine}", not the greedy seed`);
  }
  input.log.error(
    { rejected: breaches.map((c) => `${c.fixtureId}:${c.reason}`) },
    "autoSchedule: the placement solver's board breaks a declared rest — falling back to the greedy seed",
  );
  // The fallback's own exit labels (`not_searched`'s reason, an `infeasible` proof's pins) describe the no-verdict
  // rebuild, not this run, so they do not travel.
  const board: BuildResult = { ...fallback };
  delete board.notSearchedReason;
  delete board.contradictoryPins;
  return {
    ...board,
    status: "verifier_rejected",
    tiersCompleted: out.tiersCompleted,
    budgetExpired: out.budgetExpired,
    elapsedMs: out.elapsedMs + fallback.elapsedMs,
  };
}

/** Both layers: the auto pass's `buildSchedule`. */
export function autoBuildSchedule(input: BuildInput): Promise<BuildResult> {
  return buildScheduleHonouringRest({ ...input, solve: withPoolRest(input.solve, input.fixtures, input.config) });
}
