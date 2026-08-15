// C4 (z3 retirement, stage A) — the `engine` tag on the wire.
//
// `reflowExisting` forwards `out.engine` from `buildSchedule` completely
// unconditionally (see the return statement at the bottom of
// `reflowExisting`, `schedule.ts`) — the same `BuildResult["engine"]` field
// BUILD/POLISH already populate, and `"optimized"` is reachable there only
// by genuinely beating the greedy seed (`build.ts`'s `incumbent` branch).
//
// NOT tested by driving a real solve to a genuine, non-tied win on a toy
// board: `schedule-solver-telemetry.test.ts` (search "THREE assertions have
// now been tried here and each was a RACE") already found that "does the
// solver strictly beat greedy on THIS SMALL BOARD" is nondeterministic
// across machine load and is not this task's question anyway — REFLOW does
// not change whether/when the solver wins, only whether its verdict survives
// the trip to the wire once it does. That is a WIRING question, answered the
// same way `schedule-reflow-cpsat-wiring.test.ts` answers "was the placement
// client called at all": call through to the real solver for legitimacy (a
// real board, real assignments, real conflicts/metrics), then force the one
// field under test — proving nothing between `buildSchedule`'s return and
// the HTTP response silently rewrites `engine` before it reaches the caller.
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@seazn/engine/scheduling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seazn/engine/scheduling")>();
  return {
    ...actual,
    buildSchedule: async (input: Parameters<typeof actual.buildSchedule>[0]) => {
      const real = await actual.buildSchedule(input);
      // Force the one field under test. Everything else — assignments,
      // conflicts, metrics — is the real solver's genuine output, so the
      // board this test verifies against is legitimately valid.
      return { ...real, engine: "optimized" as const, status: "ok" as const };
    },
  };
});

const { sql } = await import("@/lib/db");
const { createCompetition } = await import("../competitions");
const { createDivision } = await import("../divisions");
const { createEntrants } = await import("../entrants");
const { createStages, generateStageFixtures } = await import("../stages");
const { autoSchedule, putScheduleSettings } = await import("../schedule");
type AuthCtx = import("@/server/api-v1/auth").AuthCtx;

const HAS_DB = !!process.env.DATABASE_URL;
const T0 = "2026-08-01T09:00:00.000Z";
const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedStage(): Promise<{ auth: AuthCtx; stageId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${"Org " + suffix}, ${"org-" + suffix})
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
    name: "EngineTag " + suffix,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    eligibility: [],
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
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
  });
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: T0,
      matchMinutes: 30,
      gapMinutes: 0,
      courts: ["C1", "C2"],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  await generateStageFixtures(auth, stage.id);
  return { auth, stageId: stage.id };
}

describe.skipIf(!HAS_DB)("REFLOW forwards a genuine solver win as engine:\"optimized\" (C4)", () => {
  it("reports optimized on the wire when buildSchedule's own result says optimized", async () => {
    const { auth, stageId } = await seedStage();

    // Nothing placed yet — every schedulable fixture is free, so
    // `reflowExisting`'s fully-frozen fast path (which never calls
    // `buildSchedule` at all, and would make this test vacuous) does not
    // fire.
    const out = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" });

    expect(out.solver.engine).toBe("optimized");
    // Not a side effect of the mock alone: the board it rode in on must be
    // the real thing, or this would also pass with a mock that fabricates
    // an illegal board.
    expect(out.assignments.length).toBeGreaterThan(0);
  }, 120_000);
});
