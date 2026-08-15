// W6 (#401), C5 (z3 retirement stage B) — the repair solver inside the JOINT
// runner, now a `buildSchedule` call instead of z3's `repairDecomposed`.
//
// The property this file exists for is in the first test: the clash is between
// two divisions that each hold exactly ONE fixture, so every per-division board
// is clean on its own and only a solve over the WHOLE board can see it. A
// per-division solver would report nothing to fix and hand a double-booked court
// to the organiser.
//
// `buildSchedule` is mocked at the `@seazn/engine/scheduling` boundary for the
// same reason `schedule-ai-repair.test.ts` mocks it: determinism, and
// `schedule-ai-solver.test.ts` already covers `solveBoard`'s own CP-SAT
// behavior unit-level. This file's job is the JOINT runner's behavior around
// that call — the cross-division visibility, the court-ownership guard, the
// adoption gate — which is orthogonal to which solver is under the hood.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildSchedule } = vi.hoisted(() => ({ buildSchedule: vi.fn() }));
vi.mock("@seazn/engine/scheduling", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@seazn/engine/scheduling")>()),
  buildSchedule,
}));

const parse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { parse };
    constructor() {}
  },
}));

import { jointSolverConfig, runCompetitionAiPlan } from "../competition-schedule-ai";
import type { CompetitionPack } from "../competition-schedule-ai";
import { boardMetrics, type Assignment, type BuildResult } from "@seazn/engine/scheduling";

const D1 = "d1111111-1111-4111-8111-111111111111"; // "Alpha" — Court 1 only
const D2 = "d2222222-2222-4222-8222-222222222222"; // "Beta"  — Court 1 and 2
const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";
const F3 = "33333333-3333-4333-8333-333333333333";
const E = (n: number) =>
  `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;

const at = (hhmm: string): string => `2026-08-01T${hhmm}:00+01:00`;
const T = (iso: string) => new Date(iso).getTime();

/** The pack from `competition-schedule-run.test.ts`: Alpha owns Court 1 alone,
 *  Beta owns both, so "which courts may the solver use" is a live question and
 *  not a formality. */
function makePack(): CompetitionPack {
  const base = {
    matchMinutes: 30,
    gapMinutes: 0,
    perEntrantMinRest: 0,
    sessionWindows: [],
    blackouts: [],
    constraints: null,
  };
  return {
    mode: "generate",
    competition: { id: "c1", name: "Summer Open" },
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
    divisions: [
      {
        id: D1,
        name: "Alpha",
        sport: "generic",
        tz: "Europe/London",
        settings: { ...base, courts: ["Court 1"] },
        movableIds: [F1],
        draftPlaced: 1,
      },
      {
        id: D2,
        name: "Beta",
        sport: "generic",
        tz: "Europe/London",
        settings: { ...base, courts: ["Court 1", "Court 2"] },
        movableIds: [F2],
        draftPlaced: 1,
      },
    ],
    courts: ["Court 1", "Court 2"],
    divergentCourts: ["Court 2"],
    entrants: [],
    people: [],
    participants: { [F1]: [], [F2]: [] },
    // #449: no pooled fixtures in this pack, so no pool uuids to carry.
    poolIds: {},
    // C1 gap B: no round-robin fixtures in this pack, so nothing to gate.
    stageIds: {},
    roundNos: {},
    assumptions: [],
    fixtures: {
      movable: [
        {
          id: F1,
          division_id: D1,
          ext_key: "a1",
          round: 1,
          seq: 0,
          pool: null,
          home: E(1),
          away: E(2),
          feeds: { winner_to: null, after: [] },
          current: { at: null, court: null },
          pinned: false,
        },
        {
          id: F2,
          division_id: D2,
          ext_key: "b1",
          round: 1,
          seq: 0,
          pool: null,
          home: E(3),
          away: E(4),
          feeds: { winner_to: null, after: [] },
          current: { at: null, court: null },
          pinned: false,
        },
      ],
      obstacles: [],
    },
    draft: [],
    instruction: "Finish by 6pm.",
    prior: null,
  };
}

/** `makePack()` extended with a THIRD fixture (F3, also Beta) that never
 *  touches the F1/F2 clash — Court 2, same instant, different entrants.
 *  Exists only for the REGRESSION test below: `makePack()`'s 2-fixture board
 *  can never express a non-violator (every scenario in this file makes BOTH
 *  fixtures violators), so proving a repair round leaves a non-violator
 *  byte-identical needs a board that actually has one. */
function makeThreeFixturePack(): CompetitionPack {
  const base = makePack();
  return {
    ...base,
    divisions: base.divisions.map((d) =>
      d.id === D2 ? { ...d, movableIds: [...d.movableIds, F3], draftPlaced: 2 } : d,
    ),
    participants: { ...base.participants, [F3]: [] },
    fixtures: {
      ...base.fixtures,
      movable: [
        ...base.fixtures.movable,
        {
          id: F3,
          division_id: D2,
          ext_key: "b2",
          round: 1,
          seq: 1,
          pool: null,
          home: E(5),
          away: E(6),
          feeds: { winner_to: null, after: [] },
          current: { at: null, court: null },
          pinned: false,
        },
      ],
    },
  };
}

const pack = makePack();
const movableIds = new Set([F1, F2]);
const courtsOf: Record<string, string[]> = { [D1]: ["Court 1"], [D2]: ["Court 1", "Court 2"] };

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

const cleanPlan = plan([assign(F1, at("09:00"), "Court 1"), assign(F2, at("09:00"), "Court 2")]);
/** Both divisions on Court 1 at the same instant. Each division's own board is
 *  clean; only the joint pass reports it. */
const crossClashPlan = plan([assign(F1, at("09:00"), "Court 1"), assign(F2, at("09:00"), "Court 1")]);
/** `crossClashPlan` plus F3 (Beta, Court 2, same instant, different
 *  entrants) — clean on every axis, the non-violator the REGRESSION test
 *  below needs. */
const crossClashPlanWithF3 = plan([
  assign(F1, at("09:00"), "Court 1"),
  assign(F2, at("09:00"), "Court 1"),
  assign(F3, at("09:00"), "Court 2"),
]);

const planResponse = (p: unknown, usage: unknown = { input_tokens: 1000, output_tokens: 500 }) => ({
  parsed_output: p,
  stop_reason: "end_turn",
  usage,
  content: [],
});

/** A `buildSchedule` result over `assignments`, with real metrics — hand-
 *  enumerating `BoardMetrics`'s fields would be a second, driftable copy of
 *  the shape. */
const buildResult = (assignments: Assignment[], overrides: Partial<BuildResult> = {}): BuildResult => ({
  assignments,
  conflicts: [],
  metrics: boardMetrics(assignments, pack.courts, assignments.length),
  engine: "optimized",
  status: "ok",
  tiersCompleted: 0,
  budgetExpired: false,
  elapsedMs: 5,
  moved: 0,
  lost: 0,
  rlimitSpent: 0,
  lnsWindowRlimits: [],
  ...overrides,
});

beforeEach(() => {
  parse.mockReset();
  buildSchedule.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.AI_PROVIDER;
  delete process.env.SCHEDULING_AI_MODEL;
  delete process.env.SCHEDULING_AI_LADDER;
  delete process.env.SCHEDULING_REPAIR_SOLVER;
  delete process.env.SCHEDULING_REPAIR_BUDGET_MS;
});

describe("solver repair in runCompetitionAiPlan (#401, C5)", () => {
  it("solves the whole board at once, so a cross-division clash no per-division pass can see is fixed for free", async () => {
    parse.mockResolvedValueOnce(planResponse(crossClashPlan));
    // Both F1/F2 are violators (the two sides of the cross-division clash) —
    // this 2-fixture pack has no non-violator to freeze. F1 stays on Alpha's
    // only court; F2 moves to Court 2, which Beta legitimately owns.
    buildSchedule.mockResolvedValueOnce(
      buildResult([
        { fixtureId: F1, court: "Court 1", startAt: T("2026-08-01T08:00:00Z"), endAt: T("2026-08-01T08:30:00Z"), entrants: [], people: [] },
        { fixtureId: F2, court: "Court 2", startAt: T("2026-08-01T08:00:00Z"), endAt: T("2026-08-01T08:30:00Z"), entrants: [], people: [] },
      ]),
    );

    const out = await runCompetitionAiPlan(pack, movableIds);

    expect(out.blocking).toEqual([]);
    expect(out.repair.engine).toBe("optimized");
    expect(out.repair.moved).toBe(1);
    expect(out.repair.status).toBe("repaired");
    expect(out.usage.repair_rounds).toBe(0);
    // One SDK call. The queue is 1:1 with architect calls across four other
    // suites; an extra call here is how those go red.
    expect(parse).toHaveBeenCalledTimes(1);

    // Nothing to freeze — every fixture in this pack is a violator.
    const sent = buildSchedule.mock.calls[0]![0] as { frozen?: string[] };
    expect(sent.frozen).toEqual([]);
  });

  it("never places a fixture on a court its own division does not own", async () => {
    // Alpha owns Court 1 alone. Nothing in the joint VERIFIER enforces that —
    // court ownership is a structural rule — so a solver handed the union of
    // courts would be free to park Alpha on Court 2 and be graded clean.
    parse.mockResolvedValueOnce(planResponse(crossClashPlan));
    buildSchedule.mockResolvedValueOnce(
      buildResult([
        { fixtureId: F1, court: "Court 1", startAt: T("2026-08-01T08:00:00Z"), endAt: T("2026-08-01T08:30:00Z"), entrants: [], people: [] },
        { fixtureId: F2, court: "Court 2", startAt: T("2026-08-01T08:00:00Z"), endAt: T("2026-08-01T08:30:00Z"), entrants: [], people: [] },
      ]),
    );

    const out = await runCompetitionAiPlan(pack, movableIds);

    expect(out.repair.engine).toBe("optimized");
    for (const p of out.proposal) {
      expect(courtsOf[p.division_id]).toContain(p.court_label);
    }
  });

  it("stamps engine 'none' when the joint board verifies clean", async () => {
    parse.mockResolvedValueOnce(planResponse(cleanPlan));

    const out = await runCompetitionAiPlan(pack, movableIds);

    expect(out.repair).toEqual({ engine: "none", solver_ran: false });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(buildSchedule).not.toHaveBeenCalled();
  });

  it("falls back to the LLM repair round when the solver is switched off, and says so", async () => {
    process.env.SCHEDULING_REPAIR_SOLVER = "off";
    parse
      .mockResolvedValueOnce(planResponse(crossClashPlan))
      .mockResolvedValueOnce(planResponse(cleanPlan));

    const out = await runCompetitionAiPlan(pack, movableIds);

    expect(out.blocking).toEqual([]);
    expect(out.repair.engine).toBe("llm");
    expect(out.repair.solver_ran).toBe(false);
    expect(out.repair.fallback).toBe("disabled");
    expect(out.usage.repair_rounds).toBe(1);
    expect(buildSchedule).not.toHaveBeenCalled();
  });

  it("falls back and hands the LLM the fixtures it could not resolve when the solver makes no progress", async () => {
    parse
      .mockResolvedValueOnce(planResponse(crossClashPlan))
      .mockResolvedValueOnce(planResponse(cleanPlan));
    buildSchedule.mockResolvedValueOnce(
      buildResult([], { status: "not_searched", notSearchedReason: "out_of_time", budgetExpired: true }),
    );

    const out = await runCompetitionAiPlan(pack, movableIds);

    expect(out.repair.engine).toBe("llm");
    expect(out.repair.solver_ran).toBe(true);
    expect(out.repair.timed_out).toBe(true);
    expect(out.repair.fallback).toBe("budget");
    expect(out.repair.unresolved).toBeGreaterThan(0);
    expect(out.usage.repair_rounds).toBe(1);

    const repairTurn = JSON.parse(
      (parse.mock.calls[1]![0] as { messages: { role: string; content: string }[] }).messages.at(-1)!
        .content,
    ) as { focus_fixture_ids?: string[]; verifier_conflicts: unknown[] };
    expect(repairTurn.focus_fixture_ids).toEqual(expect.arrayContaining([F1, F2]));

    // C3 (2026-08-13 design amendment) — same ruling and same shape as
    // schedule-ai-repair.test.ts's identical pin on the single-division path:
    // byte-identical to pre-C3, `detail` never `details`, field set closed.
    // UNCHANGED by C5 — this is the C3 contract, not the solver's.
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

    // Review finding 4 — same ruling and same shape as
    // schedule-ai-repair.test.ts's identical pin on the single-division
    // path: the field SET above is not the field ORDER. Pre-C3 (git show
    // d0cd9a25) every push site wrote `{ fixtureId, reason, detail,
    // [direct], [shortfallMinutes] }`, and `withRule` always appended
    // `rule` last — a plain `{ ...rest, detail: ... }` keeps the same set
    // while moving `detail` to the very end instead. Checked as "each
    // present key's canonical index is non-decreasing" since which
    // optional fields ride along varies per conflict.
    const PRE_C3_KEY_ORDER = ["fixtureId", "reason", "detail", "direct", "shortfallMinutes", "rule"];
    for (const c of conflicts) {
      const indices = Object.keys(c).map((k) => PRE_C3_KEY_ORDER.indexOf(k));
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
    }
    // `rule` is always populated (RULE_BY_REASON is exhaustive) — an order
    // check with nothing to order proves nothing.
    expect(conflicts.some((c) => "rule" in c && "detail" in c)).toBe(true);
  });

  it("REGRESSION: a repair round never disturbs a fixture outside the conflict it was asked to fix", async () => {
    // The joint mirror of schedule-ai-repair.test.ts's identical regression —
    // C5's own coverage gap, precedent from C4 (z3 retirement stage A). Needs
    // `makeThreeFixturePack`: `makePack()`'s 2-fixture board makes BOTH
    // fixtures violators in every scenario in this file, so it cannot express
    // a non-violator to freeze.
    const pack3 = makeThreeFixturePack();
    const movableIds3 = new Set([F1, F2, F3]);
    parse.mockResolvedValueOnce(planResponse(crossClashPlanWithF3));
    buildSchedule.mockResolvedValueOnce(
      buildResult([
        { fixtureId: F1, court: "Court 1", startAt: T("2026-08-01T08:00:00Z"), endAt: T("2026-08-01T08:30:00Z"), entrants: [], people: [] },
        // Clear of F3's frozen slot (Court 2, 08:00Z) — a same-slot mock here
        // would create a NEW clash the adoption gate correctly refuses,
        // triggering another repair round instead of testing reconciliation.
        { fixtureId: F2, court: "Court 1", startAt: T("2026-08-01T18:00:00Z"), endAt: T("2026-08-01T18:30:00Z"), entrants: [], people: [] },
        // F3 "moved" by the mock, standing in for a solver that did not
        // honour the freeze — must not survive reconciliation.
        { fixtureId: F3, court: "Court 1", startAt: T("2026-08-02T20:00:00Z"), endAt: T("2026-08-02T20:30:00Z"), entrants: [], people: [] },
      ]),
    );

    const out = await runCompetitionAiPlan(pack3, movableIds3);

    expect(out.blocking).toEqual([]);
    const byId = new Map(out.proposal.map((p) => [p.fixture_id, p]));
    // Byte-identical to the model's ORIGINAL crossClashPlanWithF3 values —
    // never the mock's "moved" slot.
    expect(byId.get(F3)).toMatchObject({ scheduled_at: at("09:00"), court_label: "Court 2" });
    // The conflict itself is resolved, not silently dropped: F1 no longer
    // shares Court 1/09:00 with F2.
    expect(
      byId.get(F1)!.scheduled_at !== byId.get(F2)!.scheduled_at ||
        byId.get(F1)!.court_label !== byId.get(F2)!.court_label,
    ).toBe(true);
    // buildSchedule was asked to move ONLY the violators (F1/F2) — F3 must be
    // named in `frozen`, never left free.
    const sent = buildSchedule.mock.calls[0]![0] as { frozen?: string[] };
    expect(sent.frozen).toEqual([F3]);
  });
});

// The JOINT half of the #443 namespace guard. `schedule-ai-repair.test.ts`
// covers the single-division producer; these two cover the competition path,
// where the same mistake would be even quieter — a joint run spans divisions, so
// a feed edge that resolves to nothing takes the whole competition's feeder-rest
// enforcement with it while still displaying as a compiled rule.
//
// TRIPWIRES, not bug reproductions: both pass against correct code today.
// UNAFFECTED by C5 — `jointSolverConfig` itself was not touched (its own
// `matchMinutes`/`courts` were already exactly what a `buildSchedule` call
// needs; only the repair-round CALL SITE changed, not this builder).
describe("joint RuleFixture producers stay in the fixture-id namespace (#443)", () => {
  /** `makePack`'s ids are uuids and its ext keys are "a1"/"b1", so the two
   *  namespaces are disjoint and "resolves to an id" cannot pass by coincidence.
   *  F1 (Alpha) feeds F2 (Beta) — deliberately CROSS-DIVISION, which is the edge
   *  the engine only began enforcing once the division guard came off. */
  const feedPack = (): CompetitionPack => {
    const p = makePack();
    return {
      ...p,
      fixtures: {
        ...p.fixtures,
        movable: p.fixtures.movable.map((f) =>
          f.id === F1 ? { ...f, feeds: { ...f.feeds, winner_to: F2 } } : f,
        ),
      },
    };
  };

  it("jointSolverConfig emits winnerTo as a fixture id, never an ext_key", () => {
    const rf = jointSolverConfig(feedPack()).ruleFixtures ?? [];
    const ids = new Set(rf.map((f) => f.id));
    const extKeys = new Set(rf.map((f) => f.extKey).filter((k): k is string => k !== null));
    // Guard the guard: if the fixture ever made ids and ext keys equal, every
    // assertion below would pass in both states.
    expect([...ids].some((id) => extKeys.has(id))).toBe(false);

    const feeds = rf.filter((f) => f.winnerTo !== null);
    expect(feeds).toHaveLength(1);
    expect(ids.has(feeds[0]!.winnerTo!)).toBe(true);
    expect(extKeys.has(feeds[0]!.winnerTo!)).toBe(false);
    // And the edge is the one that was wired, attributed to the FEEDER's own
    // division — not the dependent's.
    expect(feeds[0]!.id).toBe(F1);
    expect(feeds[0]!.winnerTo).toBe(F2);
    expect(feeds[0]!.divisionId).toBe(D1);
  });

  it("every RuleFixture in all three usecases comes from the ONE shared builder", () => {
    // This is what makes the guard above cover `verifyJoint` too, which needs a
    // whole plan to call and is not worth building one for. #443 was two copies
    // of a join drifting onto a shared wrong assumption; the durable fix is that
    // there is only ever one copy. `winnerTo:` is the field only a RuleFixture
    // literal carries, so counting it counts the producers.
    //
    // `schedule.ts` joined the list in #447: the board paths need RuleFixtures
    // too, and they hold the same five facts on a `fixtures` ROW under different
    // column names. That is a signature problem, not a data one, so
    // `rowToRuleFixture` renames its columns and delegates rather than writing a
    // fourth literal — which is why the count below stays at one.
    const read = (rel: string): string =>
      readFileSync(new URL(rel, import.meta.url), "utf8");
    const single = read("../schedule-ai.ts");
    const joint = read("../competition-schedule-ai.ts");
    const board = read("../schedule.ts");
    const producers = (s: string): number => (s.match(/winnerTo:/g) ?? []).length;

    expect(/export function toRuleFixture\(/.test(single)).toBe(true);
    expect(producers(single)).toBe(1); // the builder itself
    expect(producers(joint)).toBe(0); // both joint sites delegate to it
    expect(producers(board)).toBe(0); // and so does the board's row adapter
    // Anchored on the RETURN, not on a bare `toRuleFixture(`: the loose form is
    // a substring of `export function rowToRuleFixture(`, so it would pass even
    // if the delegation had been replaced by a literal. The real teeth are the
    // zero above; this pins that the delegate is what produces the value.
    expect(/return toRuleFixture\(/.test(board)).toBe(true);
  });
});
