// Engine-split 1a-4 Step 1 (Review Focus 1) — the app hands the engine its solver and its logger.
//
// WHAT THIS PROTECTS. `buildSchedule` no longer knows how a question reaches the placement service: it asks the
// `solve` it is handed, and writes to the `log` it is handed (spec §5.1, D11, D25). So a call site that forgets
// either one is no longer a type error it can hide from — but a call site that hands over the WRONG one (a stub, a
// silent logger, a solver that throws) still typechecks, and the organiser then gets a greedy board forever with no
// log line anywhere. The outcome the organiser sees when placement is DOWN is also the outcome they see when the
// seam is broken, so a test that stops at "greedy board" cannot tell the two apart.
//
// WHY A CALL-THROUGH SPY ON A CLOSED PORT. The host is a port nothing listens on, and the spy on `solveBuild` has NO
// mock implementation: the real adapter calls the real client, which really dials, and really fails. That is the only
// way to prove, in one run, that (a) the app's `solve` is `placementSolver` (the spy saw the call), (b) the failure
// that produced the greedy board was the REAL client's (the spy's own result is a rejected `PlacementError`), and
// (c) the secret reached the client by the adapter, not by the engine, which no longer reads the environment.
//
// BOTH call sites. `autoSchedule`'s BUILD/POLISH arm and its REFLOW arm (`reflowExisting`) each construct their own
// `buildSchedule` input, so each owes its own case; a mutation of one call site is killed by one case only.
//
// Needs a database (`describe.skipIf(!HAS_DB)`): a SKIPPED count here is a FAILURE, not a pass.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PlacementError, schedulerLog } from "@seazn/scheduler";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { autoSchedule, putScheduleSettings } from "../schedule";
import { solveBoard } from "../schedule-ai-solver";
import type { Assignment, BuildInput, SchedulableFixture } from "@seazn/engine/scheduling";
import { seedCourts } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;
const T0 = "2026-08-01T09:00:00.000Z";
/** Port 1 (tcpmux) is never bound on a dev box or a CI runner: the dial is refused at once. */
const CLOSED_PORT_HOST = "127.0.0.1:1";
const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

/** A 4-entrant league on two courts: fixtures to place, and nothing already on the board. */
async function seedStage(): Promise<{ auth: AuthCtx; stageId: string; fixtureCount: number }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Port " + suffix}, ${"port-" + suffix})
    returning id`;
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(DIVISION_CONFIG)}, true)
    on conflict do nothing`;
  for (const feature of ["scheduling.constraints", "scheduling.board"]) {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${orgId}, ${feature}, true)
      on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  const auth: AuthCtx = { orgId, via: "session", userId: null, role: "owner", keyId: null };
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Port " + suffix,
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
    Array.from({ length: 4 }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
  const courts = await seedCourts(orgId, 2);
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: T0,
      matchMinutes: 30,
      gapMinutes: 0,
      courts,
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  await generateStageFixtures(auth, stage.id);
  // Counted from the table the usecase reads, not typed in: the board must carry EVERY generated fixture.
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from fixtures where stage_id = ${stage.id}`;
  return { auth, stageId: stage.id, fixtureCount: n };
}

/** The ONE seam every solve leaves the process through, observed and NOT replaced: no mock implementation. */
async function callThroughSpy() {
  const placement = await import("@seazn/scheduler/placement-client");
  return vi.spyOn(placement, "solveBuild");
}

afterAll(async () => {
  if (!HAS_DB) return;
  await sql.end({ timeout: 5 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.skipIf(!HAS_DB)("autoSchedule hands the engine its solver and logger (placement down => greedy, never a 500)", () => {
  for (const [label, body] of [
    ["BUILD", { only_unlocked: false, mode: "build" }],
    ["REFLOW", { only_unlocked: true, mode: "reflow" }],
  ] as const) {
    it(`${label}: the real adapter dials the closed host, the real client fails, and the organiser gets a complete greedy board`, async () => {
      vi.stubEnv("PLACEMENT_SERVICE_HOST", CLOSED_PORT_HOST);
      vi.stubEnv("PLACEMENT_SERVICE_SECRET", "wiring-secret-1a4");
      const solveBuild = await callThroughSpy();
      const warn = vi.spyOn(schedulerLog, "warn");
      const { auth, stageId, fixtureCount } = await seedStage();
      expect(fixtureCount).toBeGreaterThan(0); // anti-vacuity: a board of zero fixtures is "complete" by accident

      const out = await autoSchedule(auth, stageId, body);

      // (a) the app's `solve` reached the real client, exactly once.
      expect(solveBuild).toHaveBeenCalledTimes(1);
      // (b) and it was the REAL client that failed: the spy passes the call through, so its result is the client's own
      // rejection. A stub that threw anything else, or resolved, cannot satisfy this.
      const settled = solveBuild.mock.results[0]!;
      expect(settled.type).toBe("return");
      await expect(settled.value).rejects.toBeInstanceOf(PlacementError);
      await expect(settled.value).rejects.toMatchObject({ failure: "unavailable" });
      // (c) the secret travelled adapter -> client; the engine no longer reads it. `requestId` is the engine's own.
      expect(solveBuild.mock.calls[0]![1]).toEqual({
        secret: "wiring-secret-1a4",
        requestId: expect.stringMatching(new RegExp(`^build-${fixtureCount}f2c-\\d+$`)) as string,
      });
      // The organiser's view: a status, not a 500, and a board with every fixture on it.
      expect(out.solver.status).toBe("solver_unavailable");
      expect(out.solver.engine).toBe("greedy");
      expect(out.assignments).toHaveLength(fixtureCount);
      // The engine's refusal line went to the logger the app handed it (`schedulerLog`), not a silent one.
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ failure: "unavailable" }),
        expect.stringContaining("placement service unavailable"),
      );
    });
  }

  it("an unset PLACEMENT_SERVICE_SECRET reaches the client as the empty string, not a leftover or a default", async () => {
    // The pair of the secret assertion above: a hard-coded secret would pass that one and fail this one.
    vi.stubEnv("PLACEMENT_SERVICE_HOST", CLOSED_PORT_HOST);
    vi.stubEnv("PLACEMENT_SERVICE_SECRET", undefined);
    const solveBuild = await callThroughSpy();
    const { auth, stageId } = await seedStage();

    await autoSchedule(auth, stageId, { only_unlocked: false, mode: "build" });

    expect(solveBuild).toHaveBeenCalledTimes(1);
    expect(solveBuild.mock.calls[0]![1]).toMatchObject({ secret: "" });
  });
});

// The THIRD call site: the AI repair round's `solveBoard` -> `repairDecomposedCpsat`. It needs no database, so it runs
// everywhere (this describe is not gated), and it is the only thing that pins `schedule-ai-solver.ts`: the existing
// `schedule-ai-solver.test.ts` replaces `repairDecomposedCpsat` with a mock, and `schedule-ai-repair-cpsat-wiring.test.ts`
// counts calls to it, so neither would notice a driver handed a stub solver or a silent logger.
describe("solveBoard (the AI repair round) hands the decomposed driver its solver and logger", () => {
  const MIN = 60_000;
  const START = Date.parse("2026-08-01T14:00:00Z");
  const fixtures: SchedulableFixture[] = [
    { id: "F1", home: "E1", away: "E2" },
    { id: "F2", home: "E3", away: "E4" },
  ];
  /** Two fixtures on ONE court at ONE time: a blocking overlap, so F1 (the unfrozen one) really is a violator. */
  const clash = (fixtureId: string): Assignment => ({
    fixtureId,
    court: "Court 1",
    startAt: START,
    endAt: START + 30 * MIN,
    entrants: [],
    people: [],
  });
  const config: BuildInput["config"] = {
    startAt: Date.parse("2026-08-01T09:00:00Z"),
    matchMinutes: 30,
    gapMinutes: 0,
    perEntrantMinRest: 0,
    courts: ["Court 1", "Court 2"],
    blackouts: [],
    sessionWindows: [],
  };

  it("the real adapter dials the closed host, the real client fails, and the failure is logged through schedulerLog", async () => {
    vi.stubEnv("PLACEMENT_SERVICE_HOST", CLOSED_PORT_HOST);
    vi.stubEnv("PLACEMENT_SERVICE_SECRET", "wiring-secret-1a4");
    const solveBuild = await callThroughSpy();
    const warn = vi.spyOn(schedulerLog, "warn");

    const out = await solveBoard({
      fixtures,
      board: [clash("F1"), clash("F2")],
      frozen: new Set(["F2"]),
      existing: [],
      dependencies: [],
      config,
    });

    // Anti-vacuity: the round really attempted a solve. `solver_ran: false` would be a no-attempt exit, which can
    // never reach the adapter and would make every assertion below describe a path that was not taken.
    expect(out.telemetry.solver_ran).toBe(true);
    expect(solveBuild.mock.calls.length).toBeGreaterThan(0);
    const settled = solveBuild.mock.results[0]!;
    expect(settled.type).toBe("return");
    await expect(settled.value).rejects.toBeInstanceOf(PlacementError);
    expect(solveBuild.mock.calls[0]![1]).toMatchObject({ secret: "wiring-secret-1a4" });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ failure: "unavailable" }),
      expect.stringContaining("placement service unavailable"),
    );
  });
});
