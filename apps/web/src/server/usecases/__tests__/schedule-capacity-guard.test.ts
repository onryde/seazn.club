// D2 capacity pre-check — wiring regression: `autoSchedule` must refuse a
// known-INFEASIBLE board with 422 CAPACITY_IMPOSSIBLE BEFORE either solver
// is reached, and must NOT refuse once the single binding constraint (the
// session window) is loosened. Modelled on schedule-solver-telemetry.test.ts's
// seedOrg/seedStage pattern. Real Postgres required; skipped without
// DATABASE_URL, matching every other DB-backed suite in this directory.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlacementError } from "@seazn/engine/scheduling/placement-client";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { autoSchedule, putScheduleSettings } from "../schedule";
import { seedCourts } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
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
  for (const feature of ["scheduling.constraints", "scheduling.board", "scheduling.multi_division"]) {
    await sql`
      insert into org_entitlement_overrides (org_id, feature_key, bool_value)
      values (${orgId}, ${feature}, true)
      on conflict (org_id, feature_key) do update set bool_value = true`;
  }
  return { orgId, via: "session", userId: null, role: "owner", keyId: null };
}

/** A 4-entrant league (round robin -> 6 fixtures), one bounded day, ONE
 *  court. `sessionWindows` is the single knob the two tests below differ
 *  on: a 1-hour window can fit exactly 1 of the 6 fixtures (impossible);
 *  the full day can fit all 6 (possible) — the "loosen the one binding
 *  constraint" pairing the acceptance criteria asks for. */
async function seedRoundRobin(
  auth: AuthCtx,
  sessionWindows: { from: string; to: string }[],
): Promise<{ stageId: string }> {
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Capacity Guard " + randomUUID().slice(0, 6),
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
  const [stage] = await createStages(auth, division.id, { seq: 1, kind: "league", name: "L", config: {} });
  const courts = await seedCourts(auth.orgId, 1);
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: "2026-08-01T09:00:00.000Z",
      endAt: "2026-08-01T23:59:00.000Z", // ONE calendar day, UTC
      matchMinutes: 60,
      gapMinutes: 0,
      courts,
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows,
    },
    tz: "UTC",
  });
  await generateStageFixtures(auth, stage.id);
  return { stageId: stage.id };
}

/** A spy on the ONE seam every solve leaves the process through.
 *
 *  `buildSchedule` reaches the placement service by `await
 *  import("./placement-client.ts")` — dynamic on purpose, so a spy on this
 *  module namespace is the call it makes (`build.ts` says as much where the
 *  import is written). The engine consumed here is the workspace source, so
 *  this namespace and the engine's own are the same module instance; the
 *  second test below is what PROVES that, by seeing a call through it.
 *
 *  Mocked rather than merely observed: unmocked, a call would dial
 *  `PLACEMENT_SERVICE_HOST` (unset locally, set in CI) and this file's second
 *  case would either wait out a gRPC deadline or hit a real service. */
async function spyOnPlacement() {
  const placement = await import("@seazn/engine/scheduling/placement-client");
  return vi
    .spyOn(placement, "solveBuild")
    .mockRejectedValue(new PlacementError("unavailable", "stubbed by schedule-capacity-guard.test.ts"));
}

describe.skipIf(!HAS_DB)("autoSchedule — D2 capacity guard wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a known-INFEASIBLE board (6 fixtures, 1-hour window fits 1) with 422 CAPACITY_IMPOSSIBLE, touching NEITHER solver", async () => {
    const auth = await seedOrg();
    const solveBuild = await spyOnPlacement();
    // 1-hour session window -> supply = floor(60/60) = 1 slot on the ONE
    // court. 4-entrant round robin = 6 fixtures. 1 << 6: arithmetically
    // impossible before any placement attempt.
    const { stageId } = await seedRoundRobin(auth, [
      { from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" },
    ]);
    await expect(autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" })).rejects.toMatchObject({
      status: 422,
      code: "CAPACITY_IMPOSSIBLE",
    });
    // THE "NEVER REACHED THE SOLVER" HALF, restored (C8 coverage loss 3).
    //
    // A `z3LoadCount()` assertion carried this until C8. It had stopped
    // carrying anything long before: C4 moved REFLOW onto `buildSchedule`,
    // after which that counter could not move on this path whatever the guard
    // did, and C6 recorded it as vacuous and due to die with the counter. The
    // 422 above proves the guard REFUSED; only this proves it refused BEFORE
    // spending a solve, which is the whole point of a pre-check. A guard that
    // ran after the solve, or one wired after the placement call, would
    // satisfy the rejection above and fail here.
    //
    // Zero-call assertions read vacuously on their own — a spy on a module
    // nothing imports is also never called — so the case below is this one's
    // control: same spy, same seam, and it must be called there.
    expect(solveBuild).not.toHaveBeenCalled();
  });

  it("loosening the single binding constraint (the session window, to the whole day) exits impossible", async () => {
    const auth = await seedOrg();
    const solveBuild = await spyOnPlacement();
    const { stageId } = await seedRoundRobin(auth, [
      { from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T21:00:00.000Z" }, // 12h -> supply=12 >= 6
    ]);
    const out = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" });
    expect(out).toBeDefined();
    // THE CONTROL for the zero-call assertion above: the same spy on the same
    // seam DOES see a call once the guard stops refusing. Without this pair,
    // a spy that had been wired to the wrong module — or to a module the
    // engine no longer calls — would report "never reached the solver" for
    // every board, impossible or not, and read as coverage.
    //
    // The stub REJECTS, so this run also takes the documented
    // `solver_unavailable` fallback to a greedy board rather than reaching a
    // real service; the assertion is that the call happened, never what came
    // back.
    expect(solveBuild).toHaveBeenCalled();
  });
});
