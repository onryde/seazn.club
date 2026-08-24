// P9.5 (D5b.5) — the end-to-end proof that P8's calendar editor stopped being
// inert. `court_hours`/`court_exceptions` (V367) shipped with a working editor
// and were read by exactly ONE file — `venues.ts`, the CRUD behind that editor.
// No scheduling path consumed them, so the scheduler would happily place at
// 00:00 on a court that does not open until 15:00.
//
// A unit test on `usableWindows` cannot catch a regression here: the failure
// mode is a seam, not a formula. `toSlotConfig` assembles the engine config by
// copying fields BY HAND, so a `courtCalendars` that never gets threaded
// through typechecks, reads as enforced and binds nothing — the exact shape of
// #443 and of the `tz` trap in `toVerifyConfig`'s own doc comment. This suite
// drives the real usecase against a real database for that reason.
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
import { createVenue, createCourt, putCourtCalendar } from "../venues";

const HAS_DB = !!process.env.DATABASE_URL;

// 2026-08-01 is a SATURDAY; V367's `court_hours.weekday` is 0=Sunday.
const SATURDAY = 6;
const DAY = "2026-08-01";

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

/** One court, open 15:00–20:00 on the Saturday the schedule runs, and a
 *  4-entrant league (6 fixtures) bounded to that single day. */
async function seedOneCourtOpenFrom3pm(auth: AuthCtx): Promise<{ stageId: string; courtId: string }> {
  // Every field spelled out: these usecases take ALREADY-PARSED input, so a
  // zod `.default()` never runs and an omitted key reaches the driver as
  // `undefined` — which postgres rejects outright (UNDEFINED_VALUE), not as null.
  const venue = await createVenue(auth, {
    name: "V " + randomUUID().slice(0, 6),
    address: null,
    sort: 0,
  });
  const court = await createCourt(auth, venue.id, { name: "Centre", tags: [], sort: 1 });
  await putCourtCalendar(auth, court.id, {
    hours: [{ weekday: SATURDAY, open_min: 15 * 60, close_min: 20 * 60 }],
    exceptions: [],
  });
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Court Hours " + randomUUID().slice(0, 6),
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
      startAt: `${DAY}T00:00:00.000Z`,
      endAt: `${DAY}T23:59:00.000Z`,
      matchMinutes: 30,
      gapMinutes: 0,
      courts: [court.id],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  await generateStageFixtures(auth, stage.id);
  return { stageId: stage.id, courtId: court.id };
}

/** `build.ts` reaches the placement service by a dynamic import, so a spy on
 *  the module namespace is the call it makes. Forcing the failure drives the
 *  GREEDY path, which is a different placer from the solver lattice and must
 *  reach the same answer — that is the whole point of this session. */
async function failPlacement() {
  const placement = await import("@seazn/engine/scheduling/placement-client");
  return vi
    .spyOn(placement, "solveBuild")
    .mockRejectedValue(new PlacementError("unavailable", "stubbed by schedule-court-hours.test.ts"));
}

const OPENS = Date.parse(`${DAY}T15:00:00.000Z`);
const CLOSES = Date.parse(`${DAY}T20:00:00.000Z`);

// `autoSchedule` PROPOSES; it does not persist. Asserting against
// `fixtures.scheduled_at` therefore reads an empty column and passes or fails
// for a reason that has nothing to do with court hours — the proposal itself is
// the artefact under test.

describe.skipIf(!HAS_DB)("autoSchedule honours a court's opening hours (P9.5)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("places nothing before the court opens, on the GREEDY path", async () => {
    const auth = await seedOrg();
    const { stageId } = await seedOneCourtOpenFrom3pm(auth);
    await failPlacement();

    const out = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" });

    // All six league fixtures fit in 15:00-20:00 at 30 minutes on one court, so
    // a correct placer places every one of them. A count of zero would mean the
    // court read as unusable all day, which is the opposite failure and must
    // not pass as "nothing outside hours".
    expect(out.assignments).toHaveLength(6);
    for (const a of out.assignments) {
      expect(Date.parse(a.scheduled_at)).toBeGreaterThanOrEqual(OPENS);
      expect(Date.parse(a.ends_at)).toBeLessThanOrEqual(CLOSES);
    }
  });

  it("reports no outside_court_hours conflict on the board it just produced", async () => {
    // The parity half. A placer that ignores court hours while the verifier
    // enforces them produces exactly this: a board the build proposes and its
    // own /validate immediately complains about.
    const auth = await seedOrg();
    const { stageId } = await seedOneCourtOpenFrom3pm(auth);
    await failPlacement();

    const out = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" });

    // Shape-agnostic on purpose: the wire spells this `detail` in one place and
    // `details` in another, and an assertion that reaches for the wrong key
    // passes whether or not the conflict is there — vacuous for the one reason
    // this test exists to rule out.
    const serialised = JSON.stringify(out.conflicts ?? []);
    expect(serialised).not.toContain("outside_court_hours");
  });
});
