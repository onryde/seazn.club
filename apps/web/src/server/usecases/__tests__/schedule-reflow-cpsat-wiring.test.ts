// C4 (z3 retirement, stage A) — the wiring switch, proven by direct call
// interception rather than an indirect signal (status/z3LoadCount can both
// be vacuously true on a board that happens not to need real solving either
// way, which is exactly what the sibling scenarios in
// `schedule-reflow-cpsat.test.ts` needed once measured — see its header).
//
// Kept in its OWN file, not folded into `schedule-reflow-cpsat.test.ts`:
// `vi.mock` is file-scoped, and this file's mock must never leak into the
// other file's real-solver-dependent assertions.
//
// Mirrors `schedule-reflow-lost.test.ts`'s exact idiom: spread the real
// module, wrap one function to observe it, call straight through to the
// real implementation so the rest of the run — greedy seed, the D2 guard,
// `settle`'s verifier pass — stays genuine.
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const calls = vi.hoisted(() => ({ buildSchedule: 0 }));

vi.mock("@seazn/engine/scheduling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seazn/engine/scheduling")>();
  return {
    ...actual,
    buildSchedule: async (input: Parameters<typeof actual.buildSchedule>[0]) => {
      calls.buildSchedule++;
      return actual.buildSchedule(input);
    },
  };
});

const { sql } = await import("@/lib/db");
const { createCompetition } = await import("../competitions");
const { createDivision } = await import("../divisions");
const { createEntrants } = await import("../entrants");
const { createStages, generateStageFixtures } = await import("../stages");
const { autoSchedule, putScheduleSettings } = await import("../schedule");
const { seedCourts } = await import("./_seed");
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
    name: "Wiring " + suffix,
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
  return { auth, stageId: stage.id };
}

describe.skipIf(!HAS_DB)("REFLOW calls buildSchedule (C4 wiring)", () => {
  it("routes a reflow invocation through the placement client, not z3's repair solver", async () => {
    const { auth, stageId } = await seedStage();

    await autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" });

    expect(calls.buildSchedule).toBeGreaterThan(0);
    // The "never repairSchedule" half of this assertion retired with the
    // function in C8: there is no z3 repair encoder left to call, so the fact
    // is now structural rather than tested. What still needs asserting — that
    // REFLOW reaches the placement service at all — is the line above.
  }, 120_000);
});
