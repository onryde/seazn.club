// Decomposed repair on CP-SAT (C9) — the driver half.
//
// Two kinds of test here, same split as `repair-decompose.test.ts`'s "the
// graph" vs "the driver": logic tests mock `buildSchedule` (fast,
// deterministic — proves the driver's OWN behaviour: which components it
// solves, when it commits, when it discards, how it reports), and a small set
// of real-service tests (gated by `PLACEMENT_SERVICE_HOST`, matching
// `placement-integration.test.ts`'s own gate) prove the real fix against the
// real CP-SAT solver — a mock can be made to say anything, and the straddle
// this driver closes is specifically about what the REAL wire does with a
// dependency edge.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Assignment, SchedulableFixture, VerifyConfig } from "./calendar.ts";
import { isBlockingConflict, validateAssignments } from "./calendar.ts";
import type { BuildInput, BuildResult } from "./build.ts";

// `vi.doMock` + per-test `vi.resetModules()` + a fresh dynamic import, NOT a
// hoisted top-level `vi.mock` — this engine suite runs `isolate: false`
// (vitest.config.ts), which shares the module cache across every file in a
// worker. A hoisted `vi.mock("./build.ts", ...)` is only reliably applied to
// THIS file's own static imports; measured directly (full engine run,
// `--coverage`): 8/13 tests here failed when run alongside other files that
// import `./build.ts` for real, while this same file was 13/13 green run
// alone. Matches this repo's own recorded fix for the identical class of bug
// (`build.test.ts:734-740`, `build-lns-wiring.test.ts:140-151` — "not the
// machine, not the wall — FILE ORDER"): `vi.doMock` + `vi.resetModules()` +
// a fresh `await import(...)` per test, unmocked again in `afterEach`, so the
// mock's lifetime is this test only and can neither leak in from, nor leak
// out to, a neighbouring file sharing the worker.
// Explicitly typed to `buildSchedule`'s own real signature (matching how
// `vi.spyOn(realModule, "solveBuild")` types itself elsewhere in this repo,
// e.g. `build.test.ts`'s `async (input) => {...}` implementations) — an
// untyped `vi.fn()` left `mockImplementationOnce`'s expected parameter type
// resolving to a plain void-returning function, which
// `@typescript-eslint/no-misused-promises` correctly flagged everywhere an
// async implementation was supplied below.
let buildSchedule: ReturnType<typeof vi.fn<(input: BuildInput) => Promise<BuildResult>>>;
type RepairModule = typeof import("./repair-decompose-cpsat.ts");
let repairDecomposedCpsat: RepairModule["repairDecomposedCpsat"];

beforeEach(async () => {
  buildSchedule = vi.fn<(input: BuildInput) => Promise<BuildResult>>();
  vi.resetModules();
  vi.doMock("./build.ts", async () => {
    const actual = await vi.importActual<typeof import("./build.ts")>("./build.ts");
    return { ...actual, buildSchedule };
  });
  ({ repairDecomposedCpsat } = await import("./repair-decompose-cpsat.ts"));
});

afterEach(() => {
  vi.doUnmock("./build.ts");
  vi.resetModules();
});

const MIN = 60_000;
const T0 = Date.parse("2026-09-07T09:00:00Z");

const at = (
  id: string,
  court: string,
  offsetMin: number,
  entrants: string[],
  durationMin = 40,
): Assignment => ({
  fixtureId: id,
  court,
  startAt: T0 + offsetMin * MIN,
  endAt: T0 + (offsetMin + durationMin) * MIN,
  entrants,
  people: entrants.map((e) => `p-${e}`),
});

const fx = (id: string, home: string, away: string): SchedulableFixture => ({ id, home, away });

type TestConfig = VerifyConfig & { courts: string[]; startAt: number; matchMinutes: number };
const cfg = (over: Partial<VerifyConfig> = {}): TestConfig => ({
  matchMinutes: 40,
  gapMinutes: 5,
  perEntrantMinRest: 45,
  blackouts: [],
  sessionWindows: [],
  tz: "UTC",
  courts: ["C1", "C2"],
  startAt: T0 - 60 * MIN,
  ...over,
});

const buildResult = (assignments: Assignment[], overrides: Partial<BuildResult> = {}): BuildResult => ({
  assignments,
  conflicts: [],
  metrics: {
    daysUsed: 1,
    daySpanMinutes: 0,
    dayStartOffsetMinutes: 0,
    makespanMinutes: 0,
    worstIdleGapMinutes: 0,
    courtImbalanceMinutes: 0,
    placed: assignments.length,
    total: assignments.length,
  },
  engine: "optimized",
  status: "ok",
  tiersCompleted: 6,
  budgetExpired: false,
  elapsedMs: 5,
  moved: 0,
  lost: 0,
  rlimitSpent: 0,
  lnsWindowRlimits: [],
  ...overrides,
});

describe("repairDecomposedCpsat — driver logic (buildSchedule mocked)", () => {
  it("answers a clean board without ever calling buildSchedule", async () => {
    const proposal = [at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C2", 600, ["e3", "e4"])];
    const r = await repairDecomposedCpsat({
      fixtures: [fx("f1", "e1", "e2"), fx("f2", "e3", "e4")],
      proposal,
      callerFrozen: new Set(),
      config: cfg(),
    });
    expect(r.status).toBe("clean");
    expect(r.k).toBe(0);
    expect(r.minimality.verdict).toBe("proved");
    expect(buildSchedule).not.toHaveBeenCalled();
  });

  it("never touches a component that is entirely caller-frozen and genuinely clean", async () => {
    // A board that is NOT globally clean (v1/v2 clash, both violators — the
    // whole-proposal fast path must not fire), alongside a wholly-separate,
    // wholly-frozen, genuinely non-conflicting pair the driver must leave
    // untouched.
    const proposal = [
      at("v1", "C1", 0, ["e1", "e2"]),
      at("v2", "C1", 0, ["e3", "e4"]),
      at("f1", "C2", 600, ["e5", "e6"]),
      at("f2", "C1", 900, ["e7", "e8"]),
    ];
    buildSchedule.mockResolvedValueOnce(
      buildResult([at("v1", "C1", 0, ["e1", "e2"]), at("v2", "C2", 0, ["e3", "e4"])]),
    );
    const r = await repairDecomposedCpsat({
      fixtures: [fx("v1", "e1", "e2"), fx("v2", "e3", "e4"), fx("f1", "e5", "e6"), fx("f2", "e7", "e8")],
      proposal,
      callerFrozen: new Set(["f1", "f2"]),
      config: cfg(),
    });
    expect(buildSchedule).toHaveBeenCalledTimes(1);
    expect(r.components).toHaveLength(3);
    const frozenReports = r.components.filter((c) => c.fixtureIds.includes("f1") || c.fixtureIds.includes("f2"));
    expect(frozenReports.every((c) => c.outcome === "clean")).toBe(true);
    expect(r.unresolvedFixtureIds).toEqual([]);
    expect(r.status).toBe("repaired");
  });

  it("reports (never throws on) a pre-existing contradiction between two caller-frozen fixtures it may not touch", async () => {
    // f1/f2 clash on court, but BOTH are caller-frozen (e.g. both pinned by
    // the organiser already) — "pin what stands" means this driver must not
    // move either to fix it. Mirrors `solveBoard`'s own "every violator is
    // also pinned" fast path: a pre-existing board defect, not this round's
    // to fix, and NOT an "impossible event" the anytime check should throw
    // on just because nothing here is allowed to touch it.
    const proposal = [at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C1", 0, ["e3", "e4"])];
    const r = await repairDecomposedCpsat({
      fixtures: [fx("f1", "e1", "e2"), fx("f2", "e3", "e4")],
      proposal,
      callerFrozen: new Set(["f1", "f2"]),
      config: cfg(),
    });
    expect(buildSchedule).not.toHaveBeenCalled();
    expect(r.components).toHaveLength(1);
    expect(r.components[0]!.outcome).toBe("infeasible");
    expect(r.status).toBe("unrepaired");
    expect(r.unresolvedFixtureIds).toEqual(["f1", "f2"]);
    // The board comes back exactly as it went in — never silently altered.
    expect(r.assignments).toEqual(proposal);
  });

  it("solves a dirty component and commits the result once it verifies", async () => {
    const proposal = [at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C1", 0, ["e3", "e4"])];
    buildSchedule.mockResolvedValueOnce(
      buildResult([at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C2", 0, ["e3", "e4"])]),
    );
    const r = await repairDecomposedCpsat({
      fixtures: [fx("f1", "e1", "e2"), fx("f2", "e3", "e4")],
      proposal,
      callerFrozen: new Set(),
      config: cfg(),
    });
    expect(buildSchedule).toHaveBeenCalledTimes(1);
    expect(r.status).toBe("repaired");
    expect(r.moved).toEqual(["f2"]);
    expect(validateAssignments(r.assignments, cfg())).toEqual([]);
  });

  it("a caller-frozen feeder is passed to buildSchedule as a fixed `existing` row, never a `fixtures` entry", async () => {
    // f1 is the caller-frozen feeder, f2 the free dependent, swept into the
    // SAME component by the dependency edge (`repairComponents` unions on
    // it) — but f1 is never a `buildSchedule` decision variable: structurally
    // incapable of drifting, matching C5's own monolithic call. Only f2 is
    // ever in `fixtures`.
    const proposal = [at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C1", 40, ["e5", "e6"], 40)];
    buildSchedule.mockResolvedValueOnce(buildResult([at("f2", "C1", 40, ["e5", "e6"], 40)]));
    await repairDecomposedCpsat({
      fixtures: [fx("f1", "e1", "e2"), fx("f2", "e5", "e6")],
      proposal,
      callerFrozen: new Set(["f1"]),
      dependencies: [{ fixtureId: "f2", dependsOn: "f1", direct: true }],
      config: cfg(),
    });
    expect(buildSchedule).toHaveBeenCalledTimes(1);
    const call = buildSchedule.mock.calls[0]![0];
    expect((call.fixtures as SchedulableFixture[]).map((f) => f.id)).toEqual(["f2"]);
    expect(call.frozen).toBeUndefined();
    expect((call.existing as Assignment[]).map((a) => a.fixtureId)).toContain("f1");
  });

  it("nudges a violator forward, and ONLY the violator, when its sole residual conflict is order-vs-a-frozen-feeder in the same component", async () => {
    // The central claim: buildSchedule's own wire drops the f2->f1 edge
    // (f1 is `existing`, never `fixtures`), so a mocked "solve" that ignores
    // the dependency and leaves f2 exactly where it was is a faithful stand-in
    // for what the real wire does. This driver must recognise the shape and
    // nudge f2 forward on its own, using the real verifier, never touching f1.
    const proposal = [at("f1", "C1", 0, ["e1", "e2"], 40), at("f2", "C2", 0, ["e5", "e6"], 40)];
    buildSchedule.mockResolvedValueOnce(buildResult([at("f2", "C2", 0, ["e5", "e6"], 40)]));
    const r = await repairDecomposedCpsat({
      fixtures: [fx("f1", "e1", "e2"), fx("f2", "e5", "e6")],
      proposal,
      callerFrozen: new Set(["f1"]),
      dependencies: [{ fixtureId: "f2", dependsOn: "f1", direct: true }],
      config: cfg(),
    });
    expect(r.status).toBe("repaired");
    const f1After = r.assignments.find((a) => a.fixtureId === "f1")!;
    const f2After = r.assignments.find((a) => a.fixtureId === "f2")!;
    // f1 never moved.
    expect(f1After.startAt).toBe(proposal[0]!.startAt);
    expect(f1After.court).toBe("C1");
    // f2 now starts at or after f1's end.
    expect(f2After.startAt).toBeGreaterThanOrEqual(f1After.endAt);
    expect(r.moved).toEqual(["f2"]);
    expect(validateAssignments(r.assignments, cfg(), [], [{ fixtureId: "f2", dependsOn: "f1", direct: true }])).toEqual([]);
  });

  it("does NOT nudge when a residual conflict is not a clean order-vs-frozen-feeder shape", async () => {
    // f2 and f3 are both violators clashing with EACH OTHER on court — a
    // shape the nudge must never touch (it is not "order against a frozen
    // feeder"), so this stays unresolved rather than guessing.
    const proposal = [
      at("f1", "C1", 0, ["e1", "e2"], 40),
      at("f2", "C2", 40, ["e5", "e6"], 40),
      at("f3", "C2", 40, ["e7", "e8"], 40),
    ];
    buildSchedule.mockResolvedValueOnce(
      buildResult([at("f2", "C2", 40, ["e5", "e6"], 40), at("f3", "C2", 40, ["e7", "e8"], 40)]),
    );
    const r = await repairDecomposedCpsat({
      fixtures: [fx("f1", "e1", "e2"), fx("f2", "e5", "e6"), fx("f3", "e7", "e8")],
      proposal,
      callerFrozen: new Set(["f1"]),
      dependencies: [
        { fixtureId: "f2", dependsOn: "f1", direct: true },
        { fixtureId: "f3", dependsOn: "f1", direct: true },
      ],
      config: cfg(),
    });
    expect(r.status).toBe("unrepaired");
    expect(r.assignments).toEqual(proposal);
  });

  it("discards the WHOLE component when a caller-frozen member comes back moved, rather than forcing it back", async () => {
    const proposal = [at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C1", 40, ["e5", "e6"], 40)];
    // buildSchedule reports f1 (frozen) moved to a different court — this
    // driver must not adopt f2's placement either, since it was chosen
    // relative to a board buildSchedule did not actually keep.
    buildSchedule.mockResolvedValueOnce(
      buildResult([at("f1", "C2", 0, ["e1", "e2"]), at("f2", "C1", 40, ["e5", "e6"], 40)]),
    );
    const r = await repairDecomposedCpsat({
      fixtures: [fx("f1", "e1", "e2"), fx("f2", "e5", "e6")],
      proposal,
      callerFrozen: new Set(["f1"]),
      dependencies: [{ fixtureId: "f2", dependsOn: "f1", direct: true }],
      config: cfg(),
    });
    expect(r.status).toBe("unrepaired");
    expect(r.moved).toEqual([]);
    // f1's reported position is untouched — the guarantee held even though
    // the mocked solve tried to move it.
    const f1After = r.assignments.find((a) => a.fixtureId === "f1")!;
    expect(f1After.court).toBe("C1");
  });

  it("discards a component whose candidate does not verify locally, even when buildSchedule reports success", async () => {
    // buildSchedule claims `status: "ok"` but hands back a board that still
    // collides on court — the fallback-exit reconciliation lesson (C4/C5):
    // never trust `out.status` over the real verifier.
    const proposal = [at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C1", 0, ["e3", "e4"])];
    buildSchedule.mockResolvedValueOnce(
      buildResult([at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C1", 0, ["e3", "e4"])], { status: "ok" }),
    );
    const r = await repairDecomposedCpsat({
      fixtures: [fx("f1", "e1", "e2"), fx("f2", "e3", "e4")],
      proposal,
      callerFrozen: new Set(),
      config: cfg(),
    });
    expect(r.status).toBe("unrepaired");
    expect(r.components[0]!.outcome).not.toBe("repaired");
    // The pre-solve board is what ships — never the unverified candidate.
    expect(r.assignments).toEqual(proposal);
  });

  it("declines a component larger than the limit, and says so in telemetry, without calling buildSchedule", async () => {
    const proposal = [at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C1", 0, ["e3", "e4"])];
    const r = await repairDecomposedCpsat({
      fixtures: [fx("f1", "e1", "e2"), fx("f2", "e3", "e4")],
      proposal,
      callerFrozen: new Set(),
      config: cfg(),
      componentLimit: 1,
    });
    expect(buildSchedule).not.toHaveBeenCalled();
    expect(r.status).toBe("unrepaired");
    expect(r.components[0]!.outcome).toBe("skipped");
    expect(r.components[0]!.skipReason).toBe("over_component_limit");
  });

  it("skips remaining components once the whole-call budget is exhausted, and still returns a verified partial board", async () => {
    const proposal = [
      at("g0a", "C1", 0, ["e00", "e01"]),
      at("g0b", "C1", 0, ["e02", "e03"]),
      at("g1a", "C1", 600, ["e10", "e11"]),
      at("g1b", "C1", 600, ["e12", "e13"]),
    ];
    buildSchedule.mockImplementationOnce(async () => {
      // Burn wall time so the SECOND component's budget check sees none left.
      await new Promise((r) => setTimeout(r, 30));
      return buildResult([at("g0a", "C1", 0, ["e00", "e01"]), at("g0b", "C2", 0, ["e02", "e03"])]);
    });
    const r = await repairDecomposedCpsat({
      fixtures: [
        fx("g0a", "e00", "e01"),
        fx("g0b", "e02", "e03"),
        fx("g1a", "e10", "e11"),
        fx("g1b", "e12", "e13"),
      ],
      proposal,
      callerFrozen: new Set(),
      config: cfg(),
      budgetMs: 5,
    });
    expect(buildSchedule).toHaveBeenCalledTimes(1);
    expect(r.status).toBe("partial");
    expect(r.components.map((c) => c.outcome)).toEqual(["repaired", "skipped"]);
    expect(r.components[1]!.skipReason).toBe("budget_exhausted");
    // ANYTIME: the partial board still verifies clean for what it resolved —
    // the unresolved component's own clash is expected residue, not a defect.
    const stillDirty = validateAssignments(r.assignments, cfg()).filter(isBlockingConflict);
    expect(stillDirty.every((c) => c.fixtureId === "g1a" || c.fixtureId === "g1b")).toBe(true);
  });

  it("proves minimality only when the found k meets the independent lower bound, mutation-checked", async () => {
    const proposal = [at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C1", 0, ["e3", "e4"])];
    buildSchedule.mockResolvedValueOnce(
      buildResult([at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C2", 0, ["e3", "e4"])]),
    );
    const r = await repairDecomposedCpsat({
      fixtures: [fx("f1", "e1", "e2"), fx("f2", "e3", "e4")],
      proposal,
      callerFrozen: new Set(),
      config: cfg(),
    });
    // One court clash, one movable fixture actually moved: k=1 meets the
    // lower bound (a single disjoint conflict needs at least one move).
    expect(r.minimality.lowerBound).toBe(1);
    expect(r.k).toBe(1);
    expect(r.minimality.verdict).toBe("proved");

    // MUTATION: force buildSchedule to move BOTH fixtures instead of the one
    // that was necessary — both land somewhere DIFFERENT from their original
    // proposal slot, so k rises to 2, above the lower bound of 1, and the
    // verdict must fall back to upper_bound.
    buildSchedule.mockReset();
    buildSchedule.mockResolvedValueOnce(
      buildResult([at("f1", "C2", 0, ["e1", "e2"]), at("f2", "C2", 80, ["e3", "e4"])]),
    );
    const mutated = await repairDecomposedCpsat({
      fixtures: [fx("f1", "e1", "e2"), fx("f2", "e3", "e4")],
      proposal,
      callerFrozen: new Set(),
      config: cfg(),
    });
    expect(mutated.k).toBe(2);
    expect(mutated.minimality.verdict).toBe("upper_bound");
  });

  it("declines to decompose when the day-cap guard fires, solving the whole board in one call (reused dayCapGuard, unchanged)", async () => {
    const proposal = [at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C1", 0, ["e3", "e4"])];
    buildSchedule.mockResolvedValueOnce(
      buildResult([at("f1", "C1", 0, ["e1", "e2"]), at("f2", "C2", 0, ["e3", "e4"])]),
    );
    const r = await repairDecomposedCpsat({
      fixtures: [fx("f1", "e1", "e2"), fx("f2", "e3", "e4")],
      proposal,
      callerFrozen: new Set(),
      config: cfg({
        hard: [{ type: "max_fixtures_per_day", count: 1, scope: { kind: "competition" } }],
        ruleFixtures: [],
      }),
    });
    expect(r.mode).toBe("whole_board");
    expect(r.modeReason).toBe("day_cap_unindexed_fixtures");
    expect(r.components).toHaveLength(1);
  });
});
