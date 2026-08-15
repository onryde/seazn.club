// C5 (z3 retirement, stage B) — the wiring switch, proven by direct call
// interception rather than an indirect signal, mirroring C4's
// `schedule-reflow-cpsat-wiring.test.ts` exactly (same header rationale: a
// status/outcome check can be vacuously true on a board that happens not to
// need real solving either way).
//
// Real Postgres is required (skipped without DATABASE_URL); the placement
// service is whatever `PLACEMENT_SERVICE_HOST` points at (or unreachable,
// which falls back to greedy inside `buildSchedule` itself — irrelevant
// here, since the whole point is which FUNCTION is called, not which board
// it returns).
//
// Both AI runners share ONE solver seam (`schedule-ai-solver.ts`'s
// `solveBoard`), so proving the wiring for `runAiPlan` also proves it for
// `runCompetitionAiPlan` structurally — this file still exercises BOTH
// end to end, against a real DB pack for each, because the two callers
// build that pack (and the violator/frozen split) independently and a
// mistake in either one's own call site would not show up in the other's
// test.
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const calls = vi.hoisted(() => ({ buildSchedule: 0, repairDecomposed: 0 }));

vi.mock("@seazn/engine/scheduling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seazn/engine/scheduling")>();
  return {
    ...actual,
    buildSchedule: async (input: Parameters<typeof actual.buildSchedule>[0]) => {
      calls.buildSchedule++;
      return actual.buildSchedule(input);
    },
    repairDecomposed: async (input: Parameters<typeof actual.repairDecomposed>[0]) => {
      calls.repairDecomposed++;
      return actual.repairDecomposed(input);
    },
  };
});

const parse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class Anthropic {
    messages = { parse };
    constructor() {}
  },
}));

const { sql } = await import("@/lib/db");
const { createCompetition } = await import("../competitions");
const { createDivision } = await import("../divisions");
const { createEntrants } = await import("../entrants");
const { createStages, generateStageFixtures } = await import("../stages");
const { buildSchedulePack, runAiPlan } = await import("../schedule-ai");
const { buildCompetitionPack, runCompetitionAiPlan } = await import("../competition-schedule-ai");
type AuthCtx = import("@/server/api-v1/auth").AuthCtx;

const HAS_DB = !!process.env.DATABASE_URL;
const T0 = "2026-08-01T09:00:00.000Z";
const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};
const SETTINGS_CONFIG = {
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["C1", "C2"],
  perEntrantMinRest: 0,
  blackouts: [],
  sessionWindows: [],
};

async function seedOrg(): Promise<AuthCtx> {
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
  for (const feature of ["scheduling.constraints", "scheduling.board", "ai.schedule"]) {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${orgId}, ${feature}, true)
      on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

async function seedDivision(
  auth: AuthCtx,
  courts: string[] = ["C1", "C2"],
): Promise<{ competitionId: string; divisionId: string; fixtureIds: string[] }> {
  const suffix = randomUUID().slice(0, 6);
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "C5 Wiring " + suffix,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Open " + suffix,
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
  await sql`
    insert into schedule_settings (division_id, config, tz, updated_at)
    values (${division.id}, ${sql.json({ ...SETTINGS_CONFIG, courts })}, 'UTC', now())
    on conflict (division_id) do update set config = excluded.config, tz = excluded.tz`;
  const [stage] = await createStages(auth, division.id, {
    seq: 1,
    kind: "league",
    name: "L",
    config: {},
  });
  const { fixtures } = await generateStageFixtures(auth, stage!.id);
  return { competitionId: competition.id, divisionId: division.id, fixtureIds: fixtures.map((f) => f.id) };
}

function planResponse(p: unknown, usage: unknown = { input_tokens: 1000, output_tokens: 500 }) {
  return { parsed_output: p, stop_reason: "end_turn", usage, content: [] };
}

/** Two fixtures double-booked on the same court/instant; the rest legal and
 *  spread out — a genuine BLOCKING conflict that only a real repair round
 *  (LLM or solver) can clear, never a status/count that could pass by luck
 *  on an already-clean board. */
function clashingPlan(fixtureIds: string[]): unknown {
  const BASE = Date.parse(T0) + 5 * 3_600_000; // 14:00Z, inside the window
  return {
    assignments: fixtureIds.map((id, i) => ({
      fixture_id: id,
      scheduled_at: new Date(i < 2 ? BASE : BASE + i * 3_600_000).toISOString(),
      court_label: "C1",
    })),
    unschedulable: [],
    explanations: [],
    summary: "ok",
  };
}

describe.skipIf(!HAS_DB)("AI repair round calls buildSchedule, never repairDecomposed (C5 wiring)", () => {
  it("single-division: runAiPlan's repair round routes through the placement client, not z3's repair solver", async () => {
    parse.mockReset();
    calls.buildSchedule = 0;
    calls.repairDecomposed = 0;
    process.env.ANTHROPIC_API_KEY = "test-key";
    delete process.env.SCHEDULING_REPAIR_SOLVER;

    const auth = await seedOrg();
    const { divisionId, fixtureIds } = await seedDivision(auth);
    parse.mockResolvedValueOnce(planResponse(clashingPlan(fixtureIds)));

    const { pack, movableIds } = await buildSchedulePack(auth, divisionId, {
      mode: "generate",
      instruction: "plan it",
      now: Date.now(),
    });
    const out = await runAiPlan(pack, movableIds);

    expect(calls.buildSchedule).toBeGreaterThan(0);
    expect(calls.repairDecomposed).toBe(0);
    // The clash was genuinely a live conflict, not a no-op: some engine
    // actually ran a repair round (solver or, if it declined, the LLM —
    // either way `repair.engine` is never "none" on a board that started
    // blocking).
    expect(out.repair.engine).not.toBe("none");
  }, 120_000);

  it("joint: runCompetitionAiPlan's repair round routes through the placement client, not z3's repair solver", async () => {
    parse.mockReset();
    calls.buildSchedule = 0;
    calls.repairDecomposed = 0;
    process.env.ANTHROPIC_API_KEY = "test-key";
    delete process.env.SCHEDULING_REPAIR_SOLVER;

    const auth = await seedOrg();
    const a = await seedDivision(auth, ["C1"]);
    const b = await seedDivision(auth, ["C1", "C2"]);
    // Same competition for both divisions, so the joint pack can span them —
    // seedDivision makes its own competition per call, so re-point b's
    // division at a's competition directly.
    await sql`update divisions set competition_id = ${a.competitionId} where id = ${b.divisionId}`;
    const fixtureIds = [...a.fixtureIds, ...b.fixtureIds];
    parse.mockResolvedValueOnce(planResponse(clashingPlan(fixtureIds)));

    const { pack, movableIds } = await buildCompetitionPack(auth, a.competitionId, [a.divisionId, b.divisionId], {
      mode: "generate",
      instruction: "plan it",
      now: Date.now(),
    });
    const out = await runCompetitionAiPlan(pack, movableIds);

    expect(calls.buildSchedule).toBeGreaterThan(0);
    expect(calls.repairDecomposed).toBe(0);
    expect(out.repair.engine).not.toBe("none");
  }, 120_000);
});
