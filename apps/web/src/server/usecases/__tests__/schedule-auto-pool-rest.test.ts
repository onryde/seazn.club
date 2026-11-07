// #452 flake — the AUTO pass and a POOL-keyed `restByGroup` entry, against the live placement solver.
//
// THE DEFECT, AS CI SAW IT. Smoke's `#452 pools/auto` check builds a `group` stage of two 3-entrant pools on two
// courts with `restByGroup = { division: 30, strictPool: 90, laxPool: 0 }` (the #459 MAX rule: strict resolves to 90,
// lax to the division's 30) and asks for an auto pass. On ~40% of runs it got `solver=ok` and a board with BOTH pools
// 30 minutes apart (CI job 128550246363): the CP-SAT board had been accepted while ignoring the strict pool's 90.
// The passing runs were luck — the solver's board was `verifier_rejected` for some other reason and the greedy seed,
// which does honour the pool rest, came back instead.
//
// TWO CAUSES, ONE FIX EACH (owner-approved, both layers):
//   1. The pool rest never reached the solver. The engine folds rest onto the wire per DIVISION only
//      (`build.ts` `restByDivisionForWire` asks `restFloor` with `{ divisionId }` alone — finding S27 in
//      docs/superpowers/specs/2026-09-03-scheduling-walkthrough-findings.md), so a pool entry above the division's
//      floor had nowhere to land. Layer 1 sends it as a rule group over the pool's fixtures.
//   2. Nothing refused a solver board that breaks a declared rest: `rest` is warn-only at the engine's verifier gate
//      (`isBlockingConflict`). Layer 2, in the AUTO pass only, treats such a board as `verifier_rejected` and ships
//      the greedy fallback. Manual moves, drag and apply keep the warning exactly as before.
//
// Every expected value below is the DECLARED config read through the #459 MAX rule ("a pool entry raises the
// division floor, never lowers it"): strict = max(90, 30) = 90, lax = max(0, 30) = 30. The two differ, so a wire
// that sent the division value everywhere, or the strict value everywhere, fails one half.
//
// Sport: rest resolution has no sport branch (`restFloor` reads config only), so one sport stands for all.
//
// Needs a database (`describe.skipIf(!HAS_DB)`): a SKIPPED count here is a FAILURE, not a pass.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as engine from "@seazn/engine/scheduling";
import type { SolveBuildInput, SolveBuildOutcome } from "@seazn/engine/scheduling";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { PutScheduleSettings } from "@/server/api-v1/schemas";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { autoSchedule, putScheduleSettings } from "../schedule";
import { buildScheduleHonouringRest, poolRestRules, withPoolRestGroups } from "../schedule-solver-rest";
import { seedCourts } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
/** Port 1 (tcpmux) is never bound: nothing in this file may reach a real service. */
const CLOSED_PORT_HOST = "127.0.0.1:1";
const MIN = 60_000;
const MATCH_MINUTES = 30;
const START_AT = "2026-11-12T09:00:00.000Z";

/** The smoke check's declared rests (scripts/smoke/suites/schedulingConstraints.ts, #452). */
const DIVISION_REST = 30;
const STRICT_POOL_REST = 90;
/** #459 MAX rule over the declared values: the strict pool's entry raises the floor, the lax pool's 0 cannot lower it. */
const STRICT_EXPECTED = Math.max(STRICT_POOL_REST, DIVISION_REST);
const LAX_EXPECTED = Math.max(0, DIVISION_REST);

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

interface PoolRig {
  auth: AuthCtx;
  stageId: string;
  divisionId: string;
  courts: string[];
  /** The strict pool's three fixtures, in round order. */
  strict: string[];
  /** The lax pool's three fixtures, in round order. */
  lax: string[];
}

/**
 * The #452 shape: a `group` stage, two pools of three, two courts. `poolEntries: false` is the empty case — the same
 * board with only the division's entry, so no pool rule exists to send.
 */
async function seedPools(poolEntries: boolean): Promise<PoolRig> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"PoolRest " + suffix}, ${"poolrest-" + suffix})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  for (const feature of ["scheduling.constraints", "scheduling.board", "scheduling.multi_division"]) {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${orgId}, ${feature}, true)
      on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "PoolRest " + suffix,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  await createEntrants(
    auth,
    division.id,
    Array.from({ length: 6 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `P${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "group",
    name: "Pools",
    config: { pools: { count: 2 } },
  });
  const courts = await seedCourts(orgId, 2);
  await generateStageFixtures(auth, stage!.id);
  const rows = await sql<{ id: string; pool_id: string | null }[]>`
    select id, pool_id from fixtures where stage_id = ${stage!.id} order by round_no, seq_in_round, id`;
  const poolIds = [...new Set(rows.map((r) => r.pool_id).filter((p): p is string => p !== null))].sort();
  // Premise, asserted rather than assumed: the shape #452 needs — six fixtures, every one in one of two pools.
  expect(rows.length, "premise: two 3-entrant pools generate six fixtures").toBe(6);
  expect(poolIds.length, "premise: exactly two pools").toBe(2);
  expect(rows.every((r) => r.pool_id !== null), "premise: every fixture carries its pool").toBe(true);
  const [strictPool, laxPool] = poolIds as [string, string];
  // Parsed by the route's own schema, as smoke's PUT is: every constraint the check leaves out gets its API default.
  await putScheduleSettings(auth, division.id, PutScheduleSettings.parse({
    config: {
      startAt: START_AT,
      matchMinutes: MATCH_MINUTES,
      gapMinutes: 0,
      courts,
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
      constraints: {
        restByGroup: poolEntries
          ? { [division.id]: DIVISION_REST, [strictPool]: STRICT_POOL_REST, [laxPool]: 0 }
          : { [division.id]: DIVISION_REST },
      },
    },
    tz: "UTC",
  }));
  return {
    auth,
    stageId: stage!.id,
    divisionId: division.id,
    courts,
    strict: rows.filter((r) => r.pool_id === strictPool).map((r) => r.id),
    lax: rows.filter((r) => r.pool_id === laxPool).map((r) => r.id),
  };
}

interface WireRuleGroup {
  fixtureIndices: number[];
  minRestMinutes?: number;
}
interface WireRequest {
  ruleGroups: WireRuleGroup[];
}

/**
 * Records the REAL wire request: the real adapter calls the real `solveBuild`, whose real `toRequest` builds the
 * message, handed here instead of to a gRPC channel. The answer is a status the client reads as ERROR, so the engine
 * ships greedy and the run completes.
 */
async function recordWire() {
  vi.stubEnv("PLACEMENT_SERVICE_HOST", CLOSED_PORT_HOST);
  const placement = await import("@seazn/scheduler/placement-client");
  const realSolveBuild = placement.solveBuild;
  const wire: WireRequest[] = [];
  const recordingCall = {
    solveBuild: (request: unknown, _meta: unknown, _opts: unknown, cb: (e: null, r: unknown) => void) => {
      wire.push(request as WireRequest);
      cb(null, { assignments: [], status: 0, tiersCompleted: 0, objectiveValues: [], elapsedMs: 0, wallExhausted: false, error: undefined });
      return undefined;
    },
  };
  const solveBuild = vi
    .spyOn(placement, "solveBuild")
    .mockImplementation(((input: Parameters<typeof realSolveBuild>[0], opts: Parameters<typeof realSolveBuild>[1]) =>
      realSolveBuild(input, opts, recordingCall as never)) as typeof placement.solveBuild);
  return { wire, solveBuild };
}

/** The rest the solver will hold fixture `id` to: the MAX `minRestMinutes` over every wire group covering it — the
 *  placement model's own reading of a fixture's rest (`model.py`: "the MAX over every covering group"). */
function wireRestOf(wire: WireRequest, input: SolveBuildInput, id: string): number {
  const index = input.fixtures.findIndex((f) => f.fixtureId === id);
  expect(index, `fixture ${id} is on the wire`).toBeGreaterThanOrEqual(0);
  return Math.max(
    0,
    ...wire.ruleGroups.filter((g) => g.fixtureIndices.includes(index)).map((g) => g.minRestMinutes ?? 0),
  );
}

/** The smoke check's own measure: the smallest gap between consecutive fixtures of one pool (every pair of a
 *  3-entrant pool shares an entrant, so the consecutive gap is the binding one). */
function minGapMinutes(assignments: readonly { fixture_id: string; scheduled_at: string }[], ids: readonly string[]): number {
  const times = assignments
    .filter((a) => ids.includes(a.fixture_id))
    .map((a) => Date.parse(a.scheduled_at))
    .sort((a, b) => a - b);
  expect(times.length, "anti-vacuity: every fixture of the pool is on the board").toBe(ids.length);
  let min = Infinity;
  for (let i = 1; i < times.length; i++) min = Math.min(min, (times[i]! - (times[i - 1]! + MATCH_MINUTES * MIN)) / MIN);
  return min;
}

/** A solver reply that PROVES the engine's own ladder (`TIER_NAMES`, in order), so the engine trusts it and ships it
 *  whenever it differs from the greedy seed — the exact path CI's failing run took. `plan` offsets are minutes from
 *  the lattice's first instant open on both courts, checked against the request's own slots so the board is legal. */
function provedReply(
  input: SolveBuildInput,
  plan: readonly ({ fixtureId: string; court: string } & ({ offsetMinutes: number } | { atMs: number }))[],
): SolveBuildOutcome {
  const starts = (court: string) => new Set(input.grid.slots.filter((s) => s.court === court).map((s) => s.startAtMs));
  const courts = [...new Set(plan.map((p) => p.court))];
  const shared = [...starts(courts[0]!)].filter((t) => courts.every((c) => starts(c).has(t))).sort((a, b) => a - b);
  const t0 = shared[0];
  expect(t0, "premise: the lattice has an instant open on every court the reply uses").toBeDefined();
  const assignments = plan.map((p) => {
    const startAtMs = "atMs" in p ? p.atMs : t0! + p.offsetMinutes * MIN;
    expect(starts(p.court).has(startAtMs), `premise: ${p.court} has a slot at ${new Date(startAtMs).toISOString()}`).toBe(true);
    return { fixtureId: p.fixtureId, court: p.court, startAtMs };
  });
  return {
    assignments,
    status: "OPTIMAL",
    tiersCompleted: engine.TIER_COUNT,
    objectiveValues: engine.TIER_NAMES.map((name) => ({ name, value: 0 })),
    elapsedMs: 1,
    wallExhausted: false,
  };
}

/** Replace the solver with `reply`, built from the request the engine actually sent. */
async function solverReplies(reply: (input: SolveBuildInput) => SolveBuildOutcome) {
  vi.stubEnv("PLACEMENT_SERVICE_HOST", CLOSED_PORT_HOST);
  const placement = await import("@seazn/scheduler/placement-client");
  return vi
    .spyOn(placement, "solveBuild")
    .mockImplementation((async (input: SolveBuildInput) => reply(input)) as unknown as typeof placement.solveBuild);
}

/** CI job 128550246363's board: both pools 30 minutes apart, one pool per court. */
const ciBoard = (rig: PoolRig) => (input: SolveBuildInput) =>
  provedReply(input, [
    ...rig.strict.map((fixtureId, i) => ({ fixtureId, court: rig.courts[0]!, offsetMinutes: i * 60 })),
    ...rig.lax.map((fixtureId, i) => ({ fixtureId, court: rig.courts[1]!, offsetMinutes: i * 60 })),
  ]);

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end({ timeout: 5 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const MODES = [
  ["BUILD", { only_unlocked: false, mode: "build" }],
  ["REFLOW", { only_unlocked: true, mode: "reflow" }],
] as const;

describe.skipIf(!HAS_DB)("layer 1: the solver request carries each pool's effective rest", () => {
  for (const [label, body] of MODES) {
    it(`${label}: the strict pool's fixtures go out at ${STRICT_EXPECTED} and the lax pool's at ${LAX_EXPECTED}`, async () => {
      const rig = await seedPools(true);
      const { wire, solveBuild } = await recordWire();

      await autoSchedule(rig.auth, rig.stageId, body);

      expect(wire.length, "the one solve went out through the real toRequest").toBe(1);
      const input = solveBuild.mock.calls[0]![0] as SolveBuildInput;
      let checked = 0;
      for (const id of rig.strict) {
        expect(wireRestOf(wire[0]!, input, id), `strict fixture ${id}`).toBe(STRICT_EXPECTED);
        checked++;
      }
      for (const id of rig.lax) {
        expect(wireRestOf(wire[0]!, input, id), `lax fixture ${id}`).toBe(LAX_EXPECTED);
        checked++;
      }
      expect(checked, "anti-vacuity: all six fixtures were checked").toBe(6);
    });
  }

  it("empty case: with no pool entry, nothing above the division's rest is sent", async () => {
    const rig = await seedPools(false);
    const { wire, solveBuild } = await recordWire();

    await autoSchedule(rig.auth, rig.stageId, { only_unlocked: true, mode: "reflow" });

    expect(wire.length).toBe(1);
    const input = solveBuild.mock.calls[0]![0] as SolveBuildInput;
    const ids = [...rig.strict, ...rig.lax];
    for (const id of ids) expect(wireRestOf(wire[0]!, input, id), `fixture ${id}`).toBe(DIVISION_REST);
    expect(ids.length, "anti-vacuity").toBe(6);
    expect(wire[0]!.ruleGroups.filter((g) => (g.minRestMinutes ?? 0) > DIVISION_REST)).toEqual([]);
    // And the request is the one the engine built alone: no group confined to a single pool was added, not even one
    // restating the division's value.
    const poolOf = (index: number) => (rig.strict.includes(input.fixtures[index]!.fixtureId) ? "strict" : "lax");
    expect(wire[0]!.ruleGroups.length, "anti-vacuity: the division's own group is on the wire").toBeGreaterThan(0);
    for (const g of wire[0]!.ruleGroups) expect(new Set(g.fixtureIndices.map(poolOf)).size).toBe(2);
  });

  it("second call: a REFLOW over a pool card already on the board counts that pinned card against the pool's rule", async () => {
    const rig = await seedPools(true);
    // The strict pool's first card is already placed — REFLOW freezes it, so it reaches the solver as a pinned row.
    await sql`
      update fixtures set scheduled_at = ${new Date(START_AT)}, court_id = ${rig.courts[0]!}
      where id = ${rig.strict[0]!}`;
    const { wire, solveBuild } = await recordWire();

    await autoSchedule(rig.auth, rig.stageId, { only_unlocked: true, mode: "reflow" });

    expect(wire.length).toBe(1);
    const input = solveBuild.mock.calls[0]![0] as SolveBuildInput;
    const pin = input.existing.find((e) => e.fixtureId === rig.strict[0]);
    expect(pin, "premise: the placed strict card is a pinned row, not a free fixture").toBeDefined();
    expect(input.fixtures.some((f) => f.fixtureId === rig.strict[0])).toBe(false);
    const groups = input.ruleGroups ?? [];
    const pinRest = Math.max(0, ...(pin!.ruleGroupIndices ?? []).map((i) => groups[i]?.minRestMinutes ?? 0));
    expect(pinRest, "the pin counts against a group holding the strict pool's rest").toBe(STRICT_EXPECTED);
    // The two strict cards still free are in that group; the lax pool's are not held to it.
    for (const id of rig.strict.slice(1)) expect(wireRestOf(wire[0]!, input, id), `strict ${id}`).toBe(STRICT_EXPECTED);
    for (const id of rig.lax) expect(wireRestOf(wire[0]!, input, id), `lax ${id}`).toBe(LAX_EXPECTED);
  });
});

describe.skipIf(!HAS_DB)("layer 2: the AUTO pass refuses a solver board that breaks a declared rest", () => {
  for (const [label, body] of MODES) {
    it(`${label}: CI's board (strict pool 30 apart) is rejected and the greedy fallback, which honours ${STRICT_EXPECTED}, ships`, async () => {
      const rig = await seedPools(true);
      await solverReplies(ciBoard(rig));

      const out = await autoSchedule(rig.auth, rig.stageId, body);

      expect(out.solver.status).toBe("verifier_rejected");
      expect(out.solver.engine).toBe("greedy");
      expect(out.assignments).toHaveLength(6);
      const strictGap = minGapMinutes(out.assignments, rig.strict);
      const laxGap = minGapMinutes(out.assignments, rig.lax);
      expect(strictGap).toBeGreaterThanOrEqual(STRICT_EXPECTED);
      // The smoke check's other half: the lax pool is held to the division's rest, NOT the strict pool's.
      expect(laxGap).toBeGreaterThanOrEqual(LAX_EXPECTED);
      expect(laxGap).toBeLessThan(STRICT_EXPECTED);
    });
  }

  it("the positive pair: a solver board that honours every declared rest is shipped, not refused", async () => {
    const rig = await seedPools(true);
    await solverReplies((input) =>
      provedReply(input, [
        ...rig.strict.map((fixtureId, i) => ({ fixtureId, court: rig.courts[0]!, offsetMinutes: i * (MATCH_MINUTES + STRICT_POOL_REST) })),
        ...rig.lax.map((fixtureId, i) => ({ fixtureId, court: rig.courts[1]!, offsetMinutes: i * (MATCH_MINUTES + DIVISION_REST) })),
      ]),
    );

    const out = await autoSchedule(rig.auth, rig.stageId, { only_unlocked: false, mode: "build" });

    // Anti-vacuity for the guard: this run really reached the arm that ships a solver board.
    expect(out.solver.engine).toBe("optimized");
    expect(out.solver.status).toBe("ok");
    expect(minGapMinutes(out.assignments, rig.strict)).toBe(STRICT_POOL_REST);
    expect(minGapMinutes(out.assignments, rig.lax)).toBe(DIVISION_REST);
  });

  it("a breach the organiser's own pinned cards already carry is not the solver's, and does not refuse its board", async () => {
    const rig = await seedPools(true);
    // Two strict cards already 30 minutes apart — below the pool's 90 — and frozen by REFLOW. Greedy cannot repair
    // them either, so the breach is on both boards and only a NEW one may count against the solver.
    await sql`update fixtures set scheduled_at = ${new Date(START_AT)}, court_id = ${rig.courts[0]!} where id = ${rig.strict[0]!}`;
    await sql`
      update fixtures set scheduled_at = ${new Date(Date.parse(START_AT) + 60 * MIN)}, court_id = ${rig.courts[0]!}
      where id = ${rig.strict[1]!}`;
    // The solver's own card is lawful: the strict pool's round 3 a full 90 after the pinned round 2 ends (and after
    // it, so round order holds); the lax pool 30 apart on the other court.
    const strictThird = Date.parse(START_AT) + (60 + MATCH_MINUTES + STRICT_POOL_REST) * MIN;
    await solverReplies((input) =>
      provedReply(input, [
        { fixtureId: rig.strict[2]!, court: rig.courts[0]!, atMs: strictThird },
        ...rig.lax.map((fixtureId, i) => ({ fixtureId, court: rig.courts[1]!, offsetMinutes: i * (MATCH_MINUTES + DIVISION_REST) })),
      ]),
    );

    const out = await autoSchedule(rig.auth, rig.stageId, { only_unlocked: true, mode: "reflow" });

    expect(out.solver.engine).toBe("optimized");
    expect(out.solver.status).toBe("ok");
    expect(Date.parse(out.assignments.find((a) => a.fixture_id === rig.strict[2])!.scheduled_at)).toBe(strictThird);
    // The pinned pair's breach is still reported — a warning, as before — but did not refuse the board. Without it
    // this case would never have asked the guard anything.
    expect(JSON.stringify(out.conflicts)).toContain("entrant_below_rest");
  });
});

// No database: the request rewrite on its own, and the guard against an engine that changed under layer 2.
describe("withPoolRestGroups / buildScheduleHonouringRest, in isolation", () => {
  const config = {
    perEntrantMinRest: 0,
    gapMinutes: 0,
    matchMinutes: MATCH_MINUTES,
    constraints: engine.SchedulingConstraints.parse({ restByGroup: { D: DIVISION_REST, P1: STRICT_POOL_REST, P2: 0 } }),
  };
  const fixtures = [
    { id: "s1", poolId: "P1", divisionId: "D" },
    { id: "s2", poolId: "P1", divisionId: "D" },
    { id: "s3", poolId: "P1", divisionId: "D" },
    { id: "l1", poolId: "P2", divisionId: "D" },
    { id: "n1", divisionId: "D" },
  ];
  const request = (free: string[], pinned: string[]): SolveBuildInput => ({
    courts: ["C1"],
    fixtures: free.map((fixtureId) => ({ fixtureId, entrantIds: [], divisionId: "D" })),
    grid: { slots: [], stepMinutes: 5 },
    existing: pinned.map((fixtureId) => ({ fixtureId, court: "C1", startAtMs: 0, ruleGroupIndices: [0] })),
    dependencies: [],
    ruleGroups: [{ fixtureIds: free, minRestMinutes: DIVISION_REST }],
    constraints: { matchMinutes: MATCH_MINUTES, gapMinutes: 0 },
    wallSeconds: 1,
  });

  it("only the pool raised above its division gets a rule, at the MAX of the two", () => {
    const rules = poolRestRules(fixtures, config);
    expect(rules.map((r) => [r.minutes, [...r.members].sort()])).toEqual([[STRICT_EXPECTED, ["s1", "s2", "s3"]]]);
  });

  it("appends the pool's group after the engine's, and counts the pool's pinned card against it", () => {
    const input = request(["s2", "s3", "l1", "n1"], ["s1", "x9"]);
    const out = withPoolRestGroups(input, poolRestRules(fixtures, config));
    expect(out.ruleGroups).toEqual([
      { fixtureIds: ["s2", "s3", "l1", "n1"], minRestMinutes: DIVISION_REST }, // the engine's, at its own position
      { fixtureIds: ["s2", "s3"], minRestMinutes: STRICT_EXPECTED },
    ]);
    expect(out.existing.map((e) => [e.fixtureId, e.ruleGroupIndices])).toEqual([
      ["s1", [0, 1]],
      ["x9", [0]],
    ]);
  });

  it("a pool with nothing left to place adds no group, and the request comes back untouched", () => {
    const input = request(["l1", "n1"], ["s1", "s2", "s3"]);
    expect(withPoolRestGroups(input, poolRestRules(fixtures, config))).toBe(input);
  });

  it("throws, rather than mislabel a board, if the no-verdict rebuild ever comes back as a solver board", async () => {
    // Stand-in engine: the FIRST call asks its solver (so layer 2 records what it placed) and ships a solver board with
    // a rest row on that card; the rebuild returns the same solver board, which a real engine cannot do.
    const solverBoard = {
      assignments: [],
      conflicts: [{ fixtureId: "s2", reason: "rest", details: { kind: "entrant_below_rest", entrantIds: ["e"] } }],
      engine: "optimized",
      status: "ok",
    } as unknown as engine.BuildResult;
    vi.spyOn(engine, "buildSchedule").mockImplementation((async (input: engine.BuildInput) => {
      await input.solve(request(["s2"], []), { requestId: "t" });
      return solverBoard;
    }) as typeof engine.buildSchedule);
    const solve = vi.fn(async () => provedReplyOf("s2"));

    await expect(
      buildScheduleHonouringRest({
        fixtures,
        config: { ...config, startAt: 0, courts: ["C1"] },
        solve,
        log: engine.silentLogger,
      }),
    ).rejects.toThrow(/no-verdict rebuild returned engine "optimized"/);
    expect(solve, "anti-vacuity: the guard was reached through a real first solve").toHaveBeenCalledTimes(1);
  });
});

function provedReplyOf(fixtureId: string): SolveBuildOutcome {
  return {
    assignments: [{ fixtureId, court: "C1", startAtMs: 0 }],
    status: "OPTIMAL",
    tiersCompleted: engine.TIER_COUNT,
    objectiveValues: engine.TIER_NAMES.map((name) => ({ name, value: 0 })),
    elapsedMs: 1,
    wallExhausted: false,
  };
}
