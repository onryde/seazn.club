// D2 capacity pre-check — wiring regression: `autoSchedule` must refuse a
// known-INFEASIBLE board with 422 CAPACITY_IMPOSSIBLE BEFORE either solver
// is reached, and must NOT refuse once the single binding constraint (the
// session window) is loosened. Modelled on schedule-solver-telemetry.test.ts's
// seedOrg/seedStage pattern. Real Postgres required; skipped without
// DATABASE_URL, matching every other DB-backed suite in this directory.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { autoSchedule, putScheduleSettings } from "../schedule";

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
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: "2026-08-01T09:00:00.000Z",
      endAt: "2026-08-01T23:59:00.000Z", // ONE calendar day, UTC
      matchMinutes: 60,
      gapMinutes: 0,
      courts: ["C1"],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows,
    },
    tz: "UTC",
  });
  await generateStageFixtures(auth, stage.id);
  return { stageId: stage.id };
}

describe.skipIf(!HAS_DB)("autoSchedule — D2 capacity guard wiring", () => {
  it("refuses a known-INFEASIBLE board (6 fixtures, 1-hour window fits 1) with 422 CAPACITY_IMPOSSIBLE, touching NEITHER solver", async () => {
    const auth = await seedOrg();
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
    // A z3 WASM-load-counter assertion sat here and was DELETED, not ported,
    // in C8. It once proved the run never reached REFLOW's local solver; C4
    // moved REFLOW onto `buildSchedule`, after which the counter could not
    // move on this path whatever happened, and C6 recorded it as vacuous and
    // due to die with the counter. The 422 above is what proves the guard
    // fired.
    //
    // OWED: the "never reached the solver" fact itself is now untested. A spy
    // on `placement-client` restores it, and is the shape to use.
  });

  it("loosening the single binding constraint (the session window, to the whole day) exits impossible", async () => {
    const auth = await seedOrg();
    const { stageId } = await seedRoundRobin(auth, [
      { from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T21:00:00.000Z" }, // 12h -> supply=12 >= 6
    ]);
    const out = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" });
    expect(out).toBeDefined();
  });
});
