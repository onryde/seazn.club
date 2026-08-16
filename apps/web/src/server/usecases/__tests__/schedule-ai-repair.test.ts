// W6 (#401), C5 (z3 retirement stage B), C9 (decomposed repair on CP-SAT) —
// the repair solver inside `runAiPlan`, now `repairDecomposedCpsat` instead
// of a single `buildSchedule` call (C5) or z3's `repairDecomposed` (pre-C5).
//
// The point of every test here is that the solver replaces an LLM repair round
// rather than joining it. The SDK mock is a QUEUE that is 1:1 with architect
// calls (#399/#400): a solver path that made one extra call would desynchronise
// it and take ~32 tests down across four other suites, so "the queue was not
// touched" is asserted directly rather than assumed.
//
// `repairDecomposedCpsat` is mocked at the `@seazn/engine/scheduling`
// boundary for determinism, at the SAME seam `schedule-ai-solver.ts` itself
// calls through (C9 moved the actual solve one layer down from
// `buildSchedule`, mocking that directly — the C5 shape this file used to
// use — is now inert: `solveBoard` no longer imports it, and the barrel mock
// cannot intercept the decomposed driver's own RELATIVE import of it inside
// packages/engine). `schedule-ai-solver.test.ts` already covers
// `solveBoard`'s own behavior (the caller-frozen narrowing, telemetry
// derivation) unit-level. This file's job is the RUNNER's behavior around
// that call — repair-round bookkeeping, the adoption gate, the LLM hand-off —
// which is orthogonal to which solver is under the hood.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { repairDecomposedCpsat } = vi.hoisted(() => ({ repairDecomposedCpsat: vi.fn() }));
vi.mock("@seazn/engine/scheduling", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@seazn/engine/scheduling")>()),
  repairDecomposedCpsat,
}));

const parse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { parse };
    constructor() {}
  },
}));

import { packRuleFixtures, runAiPlan } from "../schedule-ai";
import type { SchedulePack } from "../schedule-ai";
import type { Assignment, DecomposedRepairResult, RepairComponentReport } from "@seazn/engine/scheduling";

const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";
const F3 = "33333333-3333-4333-8333-333333333333";
const F4 = "44444444-4444-4444-8444-444444444444";
const E = (n: number) =>
  `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;

/** The same 4-fixture / 2-court pack `schedule-ai-run.test.ts` uses, so a plan
 *  that is clean there is clean here. One 09:00-18:00 session window on
 *  2026-08-01 gives the solver 18 legal half-hour slots per court to move into. */
function makePack(overrides: Partial<SchedulePack> = {}): SchedulePack {
  return {
    mode: "generate",
    division: { id: "d1", name: "Open", sport: "generic", tz: "Europe/London" },
    tz: "Europe/London",
    clock: {
      now: "2026-08-06T23:30:00.000Z",
      today: "2026-08-07",
      tomorrow: "2026-08-08",
      nextWeekday: {
        SUN: "2026-08-09", MON: "2026-08-10", TUE: "2026-08-11", WED: "2026-08-12",
        THU: "2026-08-13", FRI: "2026-08-14", SAT: "2026-08-08",
      },
    },
    window: { start: "2026-08-01T00:00:00+01:00", end: "2026-08-13T23:59:59+01:00" },
    sessionHours: { start: "08:00", end: "22:00" },
    parsed: { hard: [], soft: [], unparsed: [] },
    settings: {
      matchMinutes: 30,
      gapMinutes: 0,
      perEntrantMinRest: 0,
      courts: ["Court 1", "Court 2"],
      sessionWindows: [{ from: "2026-08-01T09:00:00+01:00", to: "2026-08-01T18:00:00+01:00" }],
      blackouts: [],
      constraints: {
        restMin: 20,
        noBackToBack: false,
        startWindows: [],
        fieldFairness: "balance",
        parallelism: "mixed",
        crossPersonClash: "hard",
      },
    },
    entrants: [],
    people: [],
    participants: Object.fromEntries([F1, F2, F3, F4].map((id) => [id, [] as string[]])),
    // #449: no pooled fixtures in this pack, so no pool uuids to carry.
    poolIds: {},
    // C1 gap B: no round-robin fixtures in this pack, so nothing to gate.
    stageIds: {},
    roundNos: {},
    assumptions: [],
    fixtures: {
      movable: [F1, F2, F3, F4].map((id, i) => ({
        id,
        ext_key: `f${i + 1}`,
        round: 1,
        seq: i,
        pool: null,
        home: E(2 * i + 1),
        away: E(2 * i + 2),
        feeds: { winner_to: null, after: [] },
        current: { at: null, court: null },
        pinned: false,
      })),
      obstacles: [],
    },
    draft: [],
    instruction: "Finish by 6pm.",
    prior: null,
    officials: [],
    ...overrides,
  };
}

const pack = makePack();
const movableIds = new Set([F1, F2, F3, F4]);

const assign = (fixture_id: string, scheduled_at: string, court_label: string) => ({
  fixture_id,
  scheduled_at,
  court_label,
});
const plan = (assignments: ReturnType<typeof assign>[]) => ({
  assignments,
  unschedulable: [],
  explanations: [],
  summary: "ok",
});

/** F1 and F2 double-booked on Court 1 at 14:00 — exactly one blocking court
 *  clash. F3/F4 are on Court 2, uninvolved: under C5's "pin what stands, re-
 *  solve the violators" ruling they are NON-violators and stay frozen. */
const clashingPlan = plan([
  assign(F1, "2026-08-01T14:00:00+01:00", "Court 1"),
  assign(F2, "2026-08-01T14:00:00+01:00", "Court 1"),
  assign(F3, "2026-08-01T14:00:00+01:00", "Court 2"),
  assign(F4, "2026-08-01T14:30:00+01:00", "Court 2"),
]);
const cleanPlan = plan([
  assign(F1, "2026-08-01T09:00:00+01:00", "Court 1"),
  assign(F2, "2026-08-01T09:00:00+01:00", "Court 2"),
  assign(F3, "2026-08-01T09:30:00+01:00", "Court 1"),
  assign(F4, "2026-08-01T09:30:00+01:00", "Court 2"),
]);

const planResponse = (p: unknown, usage: unknown = { input_tokens: 1000, output_tokens: 500 }) => ({
  parsed_output: p,
  stop_reason: "end_turn",
  usage,
  content: [],
});

/** A `repairDecomposedCpsat` result. `moved`/`unresolvedFixtureIds` are the
 *  fields `solveBoard` actually reads (see `schedule-ai-solver.ts`) — the
 *  rest exist for shape completeness only. */
const decomposedResult = (
  assignments: Assignment[],
  overrides: Partial<DecomposedRepairResult> = {},
): DecomposedRepairResult => {
  const componentIds = assignments.map((a) => a.fixtureId);
  const defaultComponent: RepairComponentReport = {
    index: 0,
    size: componentIds.length,
    frozen: 0,
    fixtureIds: componentIds,
    outcome: "repaired",
    k: 0,
    moved: [],
    checks: 0,
    elapsedMs: 5,
    relaxed: [],
  };
  return {
    status: "repaired",
    assignments,
    moved: [],
    k: 0,
    elapsedMs: 5,
    checks: 0,
    relaxed: [],
    components: [defaultComponent],
    unresolvedFixtureIds: [],
    minimality: { verdict: "upper_bound", k: 0, lowerBound: 0, witnesses: [], caveats: [] },
    mode: "components",
    residual: [],
    ...overrides,
  };
};

const T = (iso: string) => new Date(iso).getTime();

beforeEach(() => {
  parse.mockReset();
  repairDecomposedCpsat.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.AI_PROVIDER;
  delete process.env.SCHEDULING_REPAIR_SOLVER;
  delete process.env.SCHEDULING_REPAIR_BUDGET_MS;
});

afterEach(() => {
  delete process.env.SCHEDULING_REPAIR_SOLVER;
  delete process.env.SCHEDULING_REPAIR_BUDGET_MS;
});

describe("solver repair in runAiPlan (#401, C5)", () => {
  it("repairs a clashing board without spending an LLM repair round, a token or an SDK call", async () => {
    // ONE queued response. A solver path that asked the model anything would
    // fall off the end of the queue and fail here rather than somewhere else.
    parse.mockResolvedValueOnce(planResponse(clashingPlan));
    // F1 and F2 are BOTH violators (the two sides of the court clash); F3/F4
    // are frozen (not violators). The decomposed driver's own contract
    // guarantees a caller-frozen id's row is unconditionally the caller's
    // own (`repair-decompose-cpsat.ts`) — the mock still lists all four rows,
    // matching `repairDecomposedCpsat`'s real return shape (covers the whole
    // proposal), with F3/F4 unchanged from `clashingPlan` and F1 the only one
    // reported `moved`.
    repairDecomposedCpsat.mockResolvedValueOnce(
      decomposedResult(
        [
          { fixtureId: F1, court: "Court 2", startAt: T("2026-08-01T18:00:00Z"), endAt: T("2026-08-01T18:30:00Z"), entrants: [], people: [] },
          { fixtureId: F2, court: "Court 1", startAt: T("2026-08-01T13:00:00Z"), endAt: T("2026-08-01T13:30:00Z"), entrants: [], people: [] },
          { fixtureId: F3, court: "Court 2", startAt: T("2026-08-01T13:00:00Z"), endAt: T("2026-08-01T13:30:00Z"), entrants: [], people: [] },
          { fixtureId: F4, court: "Court 2", startAt: T("2026-08-01T13:30:00Z"), endAt: T("2026-08-01T14:00:00Z"), entrants: [], people: [] },
        ],
        { moved: [F1], unresolvedFixtureIds: [] },
      ),
    );

    const out = await runAiPlan(pack, movableIds);

    expect(out.blocking).toEqual([]);
    expect(out.repair.engine).toBe("optimized");
    expect(out.repair.solver_ran).toBe(true);
    expect(out.repair.status).toBe("repaired");
    expect(out.repair.moved).toBe(1);
    expect(out.repair.fallback).toBeUndefined();
    // The LLM was never asked again, and the solver spent nothing.
    expect(out.usage.repair_rounds).toBe(0);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(out.usage.input_tokens).toBe(1000);
    expect(out.usage.output_tokens).toBe(500);

    // Exactly one fixture moved, and every other slot is the model's own.
    const changed = out.proposal.filter((p) => {
      const before = clashingPlan.assignments.find((a) => a.fixture_id === p.fixture_id)!;
      return before.scheduled_at !== p.scheduled_at || before.court_label !== p.court_label;
    });
    expect(changed).toHaveLength(1);
    expect(changed[0]!.fixture_id).toBe(F1);

    // The decomposed driver was asked to move ONLY the violators — F3/F4
    // (never F1/F2, the clash's own two sides) must be named in
    // `callerFrozen`.
    const sent = repairDecomposedCpsat.mock.calls[0]![0] as { callerFrozen?: Set<string> };
    expect(sent.callerFrozen).toEqual(new Set([F3, F4]));
  });

  it("keeps a fixture outside the clash byte-identical, seconds included", async () => {
    // The adapter boundary, pinned in both directions.
    //
    // `AiSchedulePlan.scheduled_at` is an RFC-3339 string the model writes and
    // nothing on the way to `toEngineAssignments` truncates, so an engine
    // `Assignment.startAt` is routinely NOT on a minute. F3/F4 sit outside the
    // F1/F2 clash entirely (different court, no overlap) and are therefore
    // NON-violators under C5's "pin what stands" ruling — frozen, and
    // never a `buildSchedule` decision variable inside the decomposed
    // driver, structurally, not merely reconciled after. A solver run at
    // all is the proof
    // the clash was real; F3/F4 surviving to the millisecond is the proof
    // freezing genuinely bypasses the solver for them.
    parse.mockResolvedValueOnce(
      planResponse(
        plan([
          assign(F1, "2026-08-01T14:00:00+01:00", "Court 1"),
          assign(F2, "2026-08-01T14:29:40+01:00", "Court 1"), // sub-minute clash with F1
          assign(F3, "2026-08-01T14:00:20+01:00", "Court 2"),
          assign(F4, "2026-08-01T14:30:20+01:00", "Court 2"),
        ]),
      ),
    );
    // F1 and F2 are both violators; both need an entry (see the identical
    // note on the previous test) — F1 stays, F2 relocates. F3/F4 keep their
    // exact sub-minute instants — the decomposed driver's real contract
    // guarantees a caller-frozen row is untouched, so the mock must be too,
    // or this test would only be proving its own fixture back to itself.
    repairDecomposedCpsat.mockResolvedValueOnce(
      decomposedResult(
        [
          { fixtureId: F1, court: "Court 1", startAt: T("2026-08-01T13:00:00Z"), endAt: T("2026-08-01T13:30:00Z"), entrants: [], people: [] },
          { fixtureId: F2, court: "Court 2", startAt: T("2026-08-01T18:00:00Z"), endAt: T("2026-08-01T18:30:00Z"), entrants: [], people: [] },
          { fixtureId: F3, court: "Court 2", startAt: T("2026-08-01T13:00:20Z"), endAt: T("2026-08-01T13:30:20Z"), entrants: [], people: [] },
          { fixtureId: F4, court: "Court 2", startAt: T("2026-08-01T13:30:20Z"), endAt: T("2026-08-01T14:00:20Z"), entrants: [], people: [] },
        ],
        { moved: [F2] },
      ),
    );

    const out = await runAiPlan(pack, movableIds);

    expect(out.blocking).toEqual([]);
    expect(out.repair.engine).toBe("optimized");
    expect(out.repair.status).toBe("repaired");
    expect(parse).toHaveBeenCalledTimes(1);

    // F3/F4 keep their instant to the millisecond, seconds included —
    // compared as an INSTANT, not as a string, since the offset the model
    // wrote is not the offset we serialise.
    const byId = new Map(out.proposal.map((p) => [p.fixture_id, p]));
    for (const id of [F3, F4]) {
      const emitted = new Date(byId.get(id)!.scheduled_at).getTime();
      expect(emitted % 60_000).toBe(20_000);
    }
  });

  it("stamps engine 'none' and never runs the solver when the first plan verifies clean", async () => {
    parse.mockResolvedValueOnce(planResponse(cleanPlan));

    const out = await runAiPlan(pack, movableIds);

    expect(out.blocking).toEqual([]);
    expect(out.repair).toEqual({ engine: "none", solver_ran: false });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(repairDecomposedCpsat).not.toHaveBeenCalled();
  });

  it("falls back to the LLM round when the solver is switched off, and says so", async () => {
    process.env.SCHEDULING_REPAIR_SOLVER = "off";
    parse
      .mockResolvedValueOnce(planResponse(clashingPlan))
      .mockResolvedValueOnce(planResponse(cleanPlan));

    const out = await runAiPlan(pack, movableIds);

    expect(out.blocking).toEqual([]);
    expect(out.repair.engine).toBe("llm");
    expect(out.repair.solver_ran).toBe(false);
    expect(out.repair.fallback).toBe("disabled");
    expect(out.usage.repair_rounds).toBe(1);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(repairDecomposedCpsat).not.toHaveBeenCalled();
  });

  it("falls back to the LLM round when the solver makes no progress, and hands it only the unresolved fixtures", async () => {
    parse
      .mockResolvedValueOnce(planResponse(clashingPlan))
      .mockResolvedValueOnce(planResponse(cleanPlan));
    // The component never got to search — the shape a starved budget
    // produces: `skipReason: "budget_exhausted"` is what `solveBoard` reads
    // to derive `fallback: "budget"`/`timed_out: true`.
    repairDecomposedCpsat.mockResolvedValueOnce(
      decomposedResult(
        [
          { fixtureId: F1, court: "Court 1", startAt: T("2026-08-01T13:00:00Z"), endAt: T("2026-08-01T13:30:00Z"), entrants: [], people: [] },
          { fixtureId: F2, court: "Court 1", startAt: T("2026-08-01T13:00:00Z"), endAt: T("2026-08-01T13:30:00Z"), entrants: [], people: [] },
          { fixtureId: F3, court: "Court 2", startAt: T("2026-08-01T13:00:00Z"), endAt: T("2026-08-01T13:30:00Z"), entrants: [], people: [] },
          { fixtureId: F4, court: "Court 2", startAt: T("2026-08-01T13:30:00Z"), endAt: T("2026-08-01T14:00:00Z"), entrants: [], people: [] },
        ],
        {
          status: "unrepaired",
          moved: [],
          unresolvedFixtureIds: [F1, F2],
          components: [
            {
              index: 0,
              size: 2,
              frozen: 2,
              fixtureIds: [F1, F2],
              outcome: "skipped",
              skipReason: "budget_exhausted",
              k: 0,
              moved: [],
              checks: 0,
              elapsedMs: 5,
              relaxed: [],
            },
          ],
        },
      ),
    );

    const out = await runAiPlan(pack, movableIds);

    expect(out.blocking).toEqual([]);
    expect(out.repair.engine).toBe("llm");
    expect(out.repair.solver_ran).toBe(true);
    expect(out.repair.timed_out).toBe(true);
    expect(out.repair.fallback).toBe("budget");
    expect(out.repair.unresolved).toBeGreaterThan(0);
    expect(out.usage.repair_rounds).toBe(1);

    // The repair turn names the fixtures the solver could not resolve instead of
    // leaving the model to work that out from the whole board.
    const repairTurn = JSON.parse(
      (parse.mock.calls[1]![0] as { messages: { role: string; content: string }[] }).messages.at(-1)!
        .content,
    ) as { focus_fixture_ids?: string[]; verifier_conflicts: unknown[] };
    expect(repairTurn.focus_fixture_ids).toEqual(expect.arrayContaining([F1, F2]));

    // C3 (2026-08-13 design amendment) — "the prose reaches the model, not
    // just the screen": the model's own copy of a conflict must stay
    // byte-identical to pre-C3, `detail` (derived legacy prose) and never the
    // structured `details` the engine now emits, or this request's token
    // weight silently widens out from under AI-credit accounting. Pinned on
    // the FIELD SET, not just presence, so a future edit cannot widen it by
    // adding a key nobody meant to send. UNCHANGED by C5 — this is the C3
    // contract, not the solver's.
    const conflicts = repairTurn.verifier_conflicts as Record<string, unknown>[];
    expect(conflicts.length).toBeGreaterThan(0);
    const ALLOWED_VERIFIER_CONFLICT_KEYS = new Set([
      "fixtureId",
      "reason",
      "detail",
      "direct",
      "rule",
      "shortfallMinutes",
    ]);
    for (const c of conflicts) {
      expect(Object.keys(c).every((k) => ALLOWED_VERIFIER_CONFLICT_KEYS.has(k))).toBe(true);
      expect(c).not.toHaveProperty("details");
    }
    expect(conflicts.some((c) => typeof c.detail === "string" && c.detail.length > 0)).toBe(true);

    // Review finding 4: the field SET pinned above is not the field ORDER —
    // a plain `{ ...rest, detail: ... }` keeps the same set while moving
    // `detail` to the very end (after `rule`), which is NOT what the model
    // read pre-C3 (git show d0cd9a25: every push site wrote `{ fixtureId,
    // reason, detail, [direct], [shortfallMinutes] }`, and `withRule`
    // always appended `rule` last). Same character count, same token
    // weight, different BYTES — pin the order too, or this drifts silently
    // again. Checked as "each present key's canonical index is
    // non-decreasing" rather than a fixed array, since which optional
    // fields (`direct`/`shortfallMinutes`) ride along varies per conflict.
    const PRE_C3_KEY_ORDER = ["fixtureId", "reason", "detail", "direct", "shortfallMinutes", "rule"];
    for (const c of conflicts) {
      const indices = Object.keys(c).map((k) => PRE_C3_KEY_ORDER.indexOf(k));
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
    }
    // `rule` is always populated (RULE_BY_REASON is exhaustive over every
    // ConflictReason), so at least one real conflict here exercises the
    // "detail before rule" case this whole finding is about — an order
    // check with nothing to order proves nothing.
    expect(conflicts.some((c) => "rule" in c && "detail" in c)).toBe(true);
  });

  it("REGRESSION: a repair round never disturbs a fixture outside the conflict it was asked to fix", async () => {
    // C5's own coverage gap, precedent from C4 (z3 retirement stage A): a
    // naive "call buildSchedule with every non-pinned fixture freely
    // movable" swap would let the solver reshuffle F3/F4 for no reason
    // either was ever told about, fighting the LLM conversation and
    // undermining "repair" as a targeted fix.
    //
    // C9 moved WHERE this is guaranteed: a caller-frozen fixture is now
    // structurally never a `buildSchedule` decision variable inside
    // `repairDecomposedCpsat` (mutation-checked directly in
    // `repair-decompose-cpsat.test.ts`, "discards the WHOLE component when a
    // caller-frozen member comes back moved") — `solveBoard` no longer runs
    // its own reconciliation on top of the driver's result, it trusts that
    // guarantee. So this test now proves what's still true AT THIS LAYER:
    // `runAiPlan` computes `callerFrozen` correctly (F3/F4, never F1/F2) and
    // passes the driver's own (correctly-frozen) answer straight through,
    // undisturbed, to the model-facing proposal.
    parse.mockResolvedValueOnce(planResponse(clashingPlan));
    repairDecomposedCpsat.mockResolvedValueOnce(
      decomposedResult(
        [
          { fixtureId: F1, court: "Court 2", startAt: T("2026-08-01T18:00:00Z"), endAt: T("2026-08-01T18:30:00Z"), entrants: [], people: [] },
          { fixtureId: F2, court: "Court 1", startAt: T("2026-08-01T13:00:00Z"), endAt: T("2026-08-01T13:30:00Z"), entrants: [], people: [] },
          // F3/F4 exactly where `clashingPlan` put them — the shape the real
          // driver always produces for a caller-frozen id.
          { fixtureId: F3, court: "Court 2", startAt: T("2026-08-01T13:00:00Z"), endAt: T("2026-08-01T13:30:00Z"), entrants: [], people: [] },
          { fixtureId: F4, court: "Court 2", startAt: T("2026-08-01T13:30:00Z"), endAt: T("2026-08-01T14:00:00Z"), entrants: [], people: [] },
        ],
        { moved: [F1] },
      ),
    );

    const out = await runAiPlan(pack, movableIds);

    expect(out.blocking).toEqual([]);
    const sent = repairDecomposedCpsat.mock.calls[0]![0] as { callerFrozen?: Set<string> };
    expect(sent.callerFrozen).toEqual(new Set([F3, F4]));
    const byId = new Map(out.proposal.map((p) => [p.fixture_id, p]));
    // Byte-identical to the model's ORIGINAL clashingPlan values for both
    // non-violators — never the mock's "moved" slot.
    expect(byId.get(F3)).toMatchObject({ scheduled_at: "2026-08-01T14:00:00+01:00", court_label: "Court 2" });
    expect(byId.get(F4)).toMatchObject({ scheduled_at: "2026-08-01T14:30:00+01:00", court_label: "Court 2" });
    // The conflict itself is resolved, not silently dropped: F1 no longer
    // shares Court 1/14:00 with F2.
    expect(byId.get(F1)!.scheduled_at !== byId.get(F2)!.scheduled_at || byId.get(F1)!.court_label !== byId.get(F2)!.court_label).toBe(true);
  });
});

// A TRIPWIRE, not a bug reproduction — the producer is already correct and this
// passes today. It exists because the engine's feed-edge join now reads
// `winnerTo` as a FIXTURE ID (#443), and the way that rule dies is silent: a
// join that resolves nothing reports nothing, so `min_rest_minutes` would go on
// compiling and displaying as enforced while binding nothing at all. Nothing in
// the engine can catch a producer that starts emitting an ext_key here, because
// `RuleFixture` types both fields as `string | null`.
//
// SCOPE: this covers `packRuleFixtures` — the single-division path — by calling
// it. It does NOT reach the two joint producers on its own; they are covered in
// `competition-schedule-ai-repair.test.ts`, which also pins that all three go
// through the one shared `toRuleFixture` builder.
//
// `makePack` is the right board for it: its ids are uuids and its ext keys are
// "f1".."f4", so the two namespaces are disjoint and "resolves to an id" cannot
// pass by coincidence.
describe("packRuleFixtures namespace tripwire (#443)", () => {
  it("emits winnerTo in the FIXTURE-ID namespace, never the ext_key one", () => {
    const base = makePack();
    const movable = base.fixtures.movable.map((f, i) =>
      i === 0 ? { ...f, feeds: { ...f.feeds, winner_to: F2 } } : f,
    );
    const withFeed: SchedulePack = { ...base, fixtures: { ...base.fixtures, movable } };

    const rf = packRuleFixtures(withFeed);
    const ids = new Set(rf.map((f) => f.id));
    const extKeys = new Set(rf.map((f) => f.extKey).filter((k): k is string => k !== null));
    // Guard the guard: if the fixture ever made ids and ext keys equal, every
    // assertion below would pass in both states.
    expect([...ids].some((id) => extKeys.has(id))).toBe(false);

    const feeds = rf.filter((f) => f.winnerTo !== null);
    expect(feeds).toHaveLength(1);
    expect(ids.has(feeds[0]!.winnerTo!)).toBe(true);
    expect(extKeys.has(feeds[0]!.winnerTo!)).toBe(false);
  });
});
