// P9 pass 2b — court-candidate wiring regression: `autoSchedule` must refuse
// an unwinnable candidate set with 422 NO_MATCHING_COURT BEFORE either solver
// is reached, for BOTH causes (tag filter matches nothing; no courts
// configured at all), and must proceed — solving over the NARROWED set, not
// the raw configured one — once a court actually matches. Modelled directly
// on schedule-capacity-guard.test.ts's seedOrg/seedRoundRobin/spyOnPlacement
// pattern. Real Postgres required; skipped without DATABASE_URL.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlacementError } from "@seazn/engine/scheduling/placement-client";
import { sql } from "@/lib/db";
import { log } from "@/server/logger";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision, patchDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { autoSchedule, putScheduleSettings } from "../schedule";
import { createVenue, createCourt } from "../venues";
import { NO_MATCHING_COURT_CODE } from "../court-candidates";

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

/** A 4-entrant league (round robin -> 6 fixtures), one bounded day, a FULL
 *  day session window so capacity is never the binding constraint here —
 *  only the court-candidate gate is under test. `courtIds` becomes
 *  `ScheduleConfig.courts` verbatim (V374 cutover: real court uuids only). */
async function seedRoundRobin(
  auth: AuthCtx,
  courtIds: string[],
): Promise<{ stageId: string; divisionId: string }> {
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Court Candidates " + randomUUID().slice(0, 6),
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
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: "2026-08-01T00:00:00.000Z",
      endAt: "2026-08-01T23:59:00.000Z",
      matchMinutes: 30,
      gapMinutes: 0,
      courts: courtIds,
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  await generateStageFixtures(auth, stage.id);
  return { stageId: stage.id, divisionId: division.id };
}

/** Same seam schedule-capacity-guard.test.ts spies on: `build.ts` reaches the
 *  placement service by `await import("./placement-client.ts")`, dynamic on
 *  purpose, so a spy on this module namespace is the call it makes. */
async function spyOnPlacement() {
  const placement = await import("@seazn/engine/scheduling/placement-client");
  return vi
    .spyOn(placement, "solveBuild")
    .mockRejectedValue(new PlacementError("unavailable", "stubbed by schedule-court-candidates.test.ts"));
}

describe.skipIf(!HAS_DB)("autoSchedule — NO_MATCHING_COURT wiring (P9 pass 2b)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses with 422 NO_MATCHING_COURT, by CODE, when NO courts are configured at all — never reaches the solver", async () => {
    const auth = await seedOrg();
    const solveBuild = await spyOnPlacement();
    const { stageId } = await seedRoundRobin(auth, []); // pass 1's .default([]) empty-config case
    let caught: unknown;
    try {
      await autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ status: 422, code: NO_MATCHING_COURT_CODE });
    expect(solveBuild).not.toHaveBeenCalled();
  });

  it("refuses with 422 NO_MATCHING_COURT, by CODE, when configured courts exist but NONE carry the division's required tag", async () => {
    const auth = await seedOrg();
    const solveBuild = await spyOnPlacement();
    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const untaggedCourt = await createCourt(auth, venue.id, { name: "Hard 1", sort: 0, tags: [] });
    const { stageId, divisionId } = await seedRoundRobin(auth, [untaggedCourt.id]);
    await patchDivision(auth, divisionId, { required_court_tags: ["clay"] });
    let caught: unknown;
    try {
      await autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ status: 422, code: NO_MATCHING_COURT_CODE });
    expect(solveBuild).not.toHaveBeenCalled();
  });

  it("proceeds — and narrows the SOLVE request to only the matching court — once a configured court carries the division's required tag", async () => {
    const auth = await seedOrg();
    const solveBuild = await spyOnPlacement();
    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const clayCourt = await createCourt(auth, venue.id, { name: "Clay 1", sort: 0, tags: ["clay"] });
    const hardCourt = await createCourt(auth, venue.id, { name: "Hard 1", sort: 1, tags: [] });
    const { stageId, divisionId } = await seedRoundRobin(auth, [clayCourt.id, hardCourt.id]);
    await patchDivision(auth, divisionId, { required_court_tags: ["clay"] });
    const out = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" });
    expect(out).toBeDefined();
    expect(solveBuild).toHaveBeenCalled();
    const [input] = solveBuild.mock.calls[0]!;
    // THE FEED: the build input's court list is the FILTERED candidate set,
    // not the raw configured [clayCourt, hardCourt] pair — hardCourt lacks
    // the required tag and must not reach the solver as an option.
    expect(input.courts).toEqual([clayCourt.id]);
  });

  it("a stage-level required tag ALSO narrows the candidate set (stages.required_court_tags, V367 — read path is this pass's job)", async () => {
    const auth = await seedOrg();
    const solveBuild = await spyOnPlacement();
    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const litCourt = await createCourt(auth, venue.id, { name: "Lit 1", sort: 0, tags: ["lit"] });
    const unlitCourt = await createCourt(auth, venue.id, { name: "Unlit 1", sort: 1, tags: [] });
    // Division requires nothing; ONLY the stage does — so this proves the
    // stage-side union component specifically, not just the division side
    // the earlier tests already cover.
    const { stageId } = await seedRoundRobin(auth, [litCourt.id, unlitCourt.id]);
    // No usecase writes stages.required_court_tags yet (P9 pass 2b wires
    // only the READ side) — set it directly, the same way a future PATCH
    // endpoint eventually will.
    await sql`update stages set required_court_tags = ${sql.array(["lit"])} where id = ${stageId}`;
    const out = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" });
    expect(out).toBeDefined();
    const [input] = solveBuild.mock.calls[0]!;
    expect(input.courts).toEqual([litCourt.id]);
  });
});

describe.skipIf(!HAS_DB)("validateSchedule — does NOT throw NO_MATCHING_COURT even with zero candidate courts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // `.courts` on the VerifyConfig-shaped object validateAssignments reads is
  // not itself consulted by validateAssignments's double-booking scan (a
  // pairwise scan over whatever `.court` values assignments/existing already
  // carry) — so the observable proof that validateScheduleIn resolves court
  // identity through resolveCandidateCourts, rather than leaving
  // settings.config.courts raw and unfiltered, is that the SAME
  // schedule_court_filtered log line fires here that fires on the build
  // side — resolveCandidateCourts is the ONE place that log call exists.
  it("logs schedule_court_filtered — proving validateSchedule resolves court identity through the SAME shared function build uses, not a second copy", async () => {
    const auth = await seedOrg();
    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: ["clay"] });
    const { divisionId } = await seedRoundRobin(auth, [court.id]);
    await patchDivision(auth, divisionId, { required_court_tags: ["clay"] });
    const spy = vi.spyOn(log, "info").mockImplementation(() => log);
    const { validateSchedule } = await import("../schedule");
    await validateSchedule(auth, divisionId);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "schedule_court_filtered", candidates: 1, requiredTags: ["clay"], divisionId }),
      "schedule_court_filtered",
    );
  });

  // Ruling 3 (candidate-courts.ts): archiving/retagging every court must not
  // retroactively invalidate an EXISTING board. validateScheduleIn resolves
  // court identity through the SAME resolveCandidateCourts function build
  // uses (never a second copy) but must never call guardNoMatchingCourt —
  // only a fresh SOLVE has nothing yet placed to protect.
  it("an existing board still returns a clean conflict report after every configured court is archived", async () => {
    const auth = await seedOrg();
    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
    const { divisionId } = await seedRoundRobin(auth, [court.id]);
    // Archive the only configured court directly (no usecase call needed —
    // this only has to exist on the courts table, not go through the API).
    await sql`update courts set archived_at = now() where id = ${court.id}`;
    const { validateSchedule } = await import("../schedule");
    const result = await validateSchedule(auth, divisionId);
    expect(result.conflicts).toBeDefined();
  });
});

// ===========================================================================
// P9 pass 2c: the verifier's own view of the placer/verifier fork this
// session's court-tags work introduced. `autoSchedule` only ever proposes a
// tag-matching court (the suite above); this suite proves a fixture that
// lands on a WRONG court by any OTHER path — the hand-drag this dispatch
// names — is no longer invisible to `/validate`.
// ===========================================================================
describe.skipIf(!HAS_DB)("validateSchedule — court_tag_mismatch (P9 pass 2c)", () => {
  it(
    "a hand-moved fixture on an untagged court reports court_tag_mismatch, keyed on court_id, " +
      "with a resolved court name in both the wire details and the legacy prose",
    async () => {
      const auth = await seedOrg();
      const venue = await createVenue(auth, { name: "Main", sort: 0 });
      const untaggedCourt = await createCourt(auth, venue.id, { name: "Hard 1", sort: 0, tags: [] });
      const { divisionId } = await seedRoundRobin(auth, [untaggedCourt.id]);
      await patchDivision(auth, divisionId, { required_court_tags: ["clay"] });
      // The hand-drag: PATCH a fixture directly onto the untagged court,
      // bypassing autoSchedule (and its tag filter) entirely — never through
      // the placer, so nothing upstream of validateScheduleIn could have
      // caught this.
      const [fixture] = await sql<{ id: string }[]>`
        select id from fixtures where division_id = ${divisionId} limit 1`;
      await sql`
        update fixtures set scheduled_at = '2026-08-01T10:00:00.000Z', court_id = ${untaggedCourt.id}
        where id = ${fixture!.id}`;
      const { validateSchedule } = await import("../schedule");
      const result = await validateSchedule(auth, divisionId);
      const mismatch = result.conflicts.find((c) => c.details?.kind === "court_tag_mismatch");
      expect(mismatch).toBeDefined();
      expect(mismatch!.fixture_id).toBe(fixture!.id);
      // Review finding #10: REPORTED, never BLOCKING — see the
      // "publishSchedule — court_tag_mismatch is non-blocking" suite below
      // for the publish-gate consequence this feeds (`isBlockingConflict`,
      // calendar.ts).
      expect(mismatch!.blocking).toBe(false);
      // Keyed on court_id: the wire `details.court` field carries the id...
      expect(mismatch!.details?.court).toBe(untaggedCourt.id);
      // ...and a caller gets the resolved NAME too, both structured and in
      // the deprecated prose — never a bare uuid in user-facing text.
      expect(mismatch!.details?.court_name).toBe("Hard 1");
      expect(mismatch!.detail).toContain("Hard 1");
      expect(mismatch!.detail).not.toContain(untaggedCourt.id);
    },
  );

  it("a fixture on a court whose tags DO satisfy the requirement reports no court_tag_mismatch", async () => {
    const auth = await seedOrg();
    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const clayCourt = await createCourt(auth, venue.id, { name: "Clay 1", sort: 0, tags: ["clay"] });
    const { divisionId } = await seedRoundRobin(auth, [clayCourt.id]);
    await patchDivision(auth, divisionId, { required_court_tags: ["clay"] });
    const [fixture] = await sql<{ id: string }[]>`
      select id from fixtures where division_id = ${divisionId} limit 1`;
    await sql`
      update fixtures set scheduled_at = '2026-08-01T10:00:00.000Z', court_id = ${clayCourt.id}
      where id = ${fixture!.id}`;
    const { validateSchedule } = await import("../schedule");
    const result = await validateSchedule(auth, divisionId);
    expect(result.conflicts.some((c) => c.details?.kind === "court_tag_mismatch")).toBe(false);
  });

  it(
    "a fixture on an ARCHIVED court whose tags satisfy the requirement reports no court_tag_mismatch " +
      "(ruling 3: archiving must not retroactively invalidate a board — proven end to end through " +
      "resolveTagQualifiedCourtIds against a real DB, not just the engine-level Set membership check)",
    async () => {
      const auth = await seedOrg();
      const venue = await createVenue(auth, { name: "Main", sort: 0 });
      const clayCourt = await createCourt(auth, venue.id, { name: "Clay 1", sort: 0, tags: ["clay"] });
      const { divisionId } = await seedRoundRobin(auth, [clayCourt.id]);
      await patchDivision(auth, divisionId, { required_court_tags: ["clay"] });
      const [fixture] = await sql<{ id: string }[]>`
        select id from fixtures where division_id = ${divisionId} limit 1`;
      await sql`
        update fixtures set scheduled_at = '2026-08-01T10:00:00.000Z', court_id = ${clayCourt.id}
        where id = ${fixture!.id}`;
      // Archive AFTER the fixture is already sitting on it — same "board
      // existed before the archive" shape as the suite above.
      await sql`update courts set archived_at = now() where id = ${clayCourt.id}`;
      const { validateSchedule } = await import("../schedule");
      const result = await validateSchedule(auth, divisionId);
      expect(result.conflicts.some((c) => c.details?.kind === "court_tag_mismatch")).toBe(false);
    },
  );
});

// ===========================================================================
// Review finding #10: `court_tag_mismatch` shares `reason: "court"` with a
// genuine court double-booking, and `isBlockingConflict` (calendar.ts) used
// to treat every `reason: "court"` conflict as blocking — so adding a
// `required_court_tags` value to a division whose board already exists, or a
// hand-drag through `moveFixture` (which performs no tag check of its own),
// hard-refused publish/start with no `acknowledge_warnings` override
// available: the organiser could not get unstuck. Fixed by carving
// `court_tag_mismatch` out of `isBlockingConflict` (ruling 3: retroactive
// invalidation must not happen). candidate-courts.test.ts proves the engine
// predicate directly; this suite proves the PUBLISH-GATE consequence end to
// end, through a real DB board.
// ===========================================================================
describe.skipIf(!HAS_DB)(
  "publishSchedule — court_tag_mismatch is non-blocking, court_double_booking still blocks (review finding #10)",
  () => {
    it(
      "a board carrying only a court_tag_mismatch never throws PUBLISH_BLOCKED — unacknowledged it is the " +
        "SOFT refusal (PUBLISH_UNACKNOWLEDGED), and acknowledged it publishes",
      async () => {
        const auth = await seedOrg();
        const venue = await createVenue(auth, { name: "Main", sort: 0 });
        const untaggedCourt = await createCourt(auth, venue.id, { name: "Hard 1", sort: 0, tags: [] });
        const { divisionId } = await seedRoundRobin(auth, [untaggedCourt.id]);
        await patchDivision(auth, divisionId, { required_court_tags: ["clay"] });
        // Hand-drag, same shape as the court_tag_mismatch suite above: PATCH a
        // fixture directly onto the untagged court, bypassing autoSchedule.
        const [fixture] = await sql<{ id: string }[]>`
          select id from fixtures where division_id = ${divisionId} limit 1`;
        await sql`
          update fixtures set scheduled_at = '2026-08-01T10:00:00.000Z', court_id = ${untaggedCourt.id}
          where id = ${fixture!.id}`;
        const { publishSchedule, PUBLISH_UNACKNOWLEDGED } = await import("../schedule");
        let caught: unknown;
        try {
          await publishSchedule(auth, divisionId);
        } catch (err) {
          caught = err;
        }
        // The SOFT refusal, never the hard one — pinning the exact code rules
        // out PUBLISH_BLOCKED (and any other failure) in one assertion.
        expect(caught).toMatchObject({ status: 422, code: PUBLISH_UNACKNOWLEDGED });
        // Acknowledged, it goes all the way through.
        const out = await publishSchedule(auth, divisionId, { acknowledge_warnings: true });
        expect(out.published).toBe(true);
      },
    );

    it(
      'a genuine court double-booking still throws PUBLISH_BLOCKED even when acknowledged — the narrowing is ' +
        'scoped to court_tag_mismatch alone, not every reason: "court" conflict',
      async () => {
        const auth = await seedOrg();
        const venue = await createVenue(auth, { name: "Main", sort: 0 });
        const court = await createCourt(auth, venue.id, { name: "Court 1", sort: 0, tags: [] });
        const { divisionId } = await seedRoundRobin(auth, [court.id]);
        // Round 1 of a 4-entrant round robin is exactly 2 fixtures sharing no
        // entrant, so forcing both onto the same court/time produces a court
        // double-booking WITHOUT also tripping person_overlap — the refusal
        // below can only be attributed to the court conflict.
        const fixtures = await sql<{ id: string }[]>`
          select id from fixtures where division_id = ${divisionId} and round_no = 1`;
        expect(fixtures.length).toBe(2);
        for (const f of fixtures) {
          await sql`
            update fixtures set scheduled_at = '2026-08-01T10:00:00.000Z', court_id = ${court.id}
            where id = ${f.id}`;
        }
        const { publishSchedule, PUBLISH_BLOCKED } = await import("../schedule");
        let caught: unknown;
        try {
          await publishSchedule(auth, divisionId, { acknowledge_warnings: true });
        } catch (err) {
          caught = err;
        }
        expect(caught).toMatchObject({ status: 422, code: PUBLISH_BLOCKED });
      },
    );
  },
);

// ===========================================================================
// Review finding #11: `validateScheduleIn` used to derive `requiredCourtTags`
// from `divisions.required_court_tags` ONLY, while `autoSchedule` unions in
// the STAGE's own tags too (`unionRequiredCourtTags(division, stage)`) — a
// stage-level `required_court_tags` constrained the placer but was invisible
// to the verifier, so the placer/verifier fork this pass claims to close was
// only half closed. Mirrors the autoSchedule stage-tag test above (line
// ~166): division requires nothing, only the stage does, so this proves the
// stage-side component specifically.
// ===========================================================================
describe.skipIf(!HAS_DB)(
  "validateSchedule — stage-level required_court_tags is now seen by validate, matching autoSchedule (review finding #11)",
  () => {
    it("a hand-moved fixture on a court missing a STAGE-ONLY required tag reports court_tag_mismatch", async () => {
      const auth = await seedOrg();
      const venue = await createVenue(auth, { name: "Main", sort: 0 });
      const unlitCourt = await createCourt(auth, venue.id, { name: "Unlit 1", sort: 0, tags: [] });
      const { stageId, divisionId } = await seedRoundRobin(auth, [unlitCourt.id]);
      // No usecase writes stages.required_court_tags yet (P9 pass 2b wires
      // only the READ side) — set it directly, same as the autoSchedule
      // stage-tag test above.
      await sql`update stages set required_court_tags = ${sql.array(["lit"])} where id = ${stageId}`;
      const [fixture] = await sql<{ id: string }[]>`
        select id from fixtures where division_id = ${divisionId} limit 1`;
      await sql`
        update fixtures set scheduled_at = '2026-08-01T10:00:00.000Z', court_id = ${unlitCourt.id}
        where id = ${fixture!.id}`;
      const { validateSchedule } = await import("../schedule");
      const result = await validateSchedule(auth, divisionId);
      const mismatch = result.conflicts.find((c) => c.details?.kind === "court_tag_mismatch");
      expect(mismatch).toBeDefined();
      expect(mismatch!.fixture_id).toBe(fixture!.id);
      expect(mismatch!.details?.court).toBe(unlitCourt.id);
    });
  },
);
