// #622 — ROUND-SCOPED required court tags, end to end against a real DB.
//
// The issue this file pins: before #622 a required court tag could only be
// authored at the DIVISION (D5/P8) or the STAGE (V367) scope, and a knockout
// stage is ONE `stages` row carrying its quarter-finals, its semi-finals and
// its final together. So "only the final needs the championship court" was
// simply not expressible: a stage-level tag applies to every fixture in the
// stage, which would have demanded the single championship court host all
// seven matches of an 8-entrant bracket — a board the placer would either
// serialise into one court or refuse outright with NO_MATCHING_COURT.
//
// The fix has three halves, and each is tested here rather than by proxy:
//   * the WRITE path (`stage-court-tags.ts`) — a rule keyed by ROLE
//     (`roundRoleKey()`, V375) and never by `fixtures.round_no`, so a draw
//     resize that renumbers every round keeps addressing what the organiser
//     meant;
//   * the RESOLUTION (`court-candidates.ts`'s `requiredCourtTagsByFixture`) —
//     the unit of resolution is now the FIXTURE, because a stage's fixtures no
//     longer agree about their own candidate set;
//   * the two CONSUMERS — the placer (`autoSchedule`, per-fixture
//     `allowedCourts`) and the verifier (`validateSchedule`, per-fixture
//     `courtTagQualifiedIdsByFixture`), which must never fork.
//
// Real Postgres required; skipped without DATABASE_URL, exactly like the
// neighbouring `schedule-court-candidates.test.ts` this file is modelled on.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlacementError } from "@seazn/engine/scheduling/placement-client";
import { sql, withTenant } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { autoSchedule, putScheduleSettings, validateSchedule } from "../schedule";
import { createVenue, createCourt } from "../venues";
import { NO_MATCHING_COURT_CODE, requiredCourtTagsByFixture } from "../court-candidates";
import { getStageCourtTags, putStageCourtTags } from "../stage-court-tags";

const HAS_DB = !!process.env.DATABASE_URL;

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

/** Verbatim in spirit from schedule-court-candidates.test.ts — a bare org
 *  with the `generic`/`score` catalogue rows and the scheduling entitlements
 *  the auto-schedule path gates on. */
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

interface Seeded {
  stageId: string;
  divisionId: string;
}

/** A division of `entrants` players with ONE stage of `kind`, a full-day
 *  session window (so capacity is never the binding constraint — only the
 *  court-tag rules are under test here), and its fixtures already generated.
 *  `courtIds` becomes `ScheduleConfig.courts` verbatim. */
async function seedStage(
  auth: AuthCtx,
  kind: "knockout" | "league",
  entrants: number,
  courtIds: string[],
): Promise<Seeded> {
  const competition = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: "Round Court Tags " + randomUUID().slice(0, 6),
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
    Array.from({ length: entrants }, (_, i) => ({
      kind: "individual" as const,
      display_name: `E${i + 1}`,
      seed: i + 1,
      members: [],
    })),
  );
  const [stage] = await createStages(auth, division.id, { seq: 1, kind, name: kind, config: {} });
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
  await generateStageFixtures(auth, stage!.id);
  return { stageId: stage!.id, divisionId: division.id };
}

interface FixtureRow {
  id: string;
  round_no: number;
  seq_in_round: number;
}

async function stageFixtures(stageId: string): Promise<FixtureRow[]> {
  return sql<FixtureRow[]>`
    select id, round_no, seq_in_round from fixtures
    where stage_id = ${stageId} order by round_no, seq_in_round`;
}

/** Same seam schedule-court-candidates.test.ts spies on: `build.ts` reaches
 *  the placement service by a dynamic `await import("./placement-client.ts")`,
 *  so rejecting `solveBuild` here forces the DETERMINISTIC GREEDY path — the
 *  one whose court choice this file can assert on without a live solver. */
async function spyOnPlacement() {
  const placement = await import("@seazn/engine/scheduling/placement-client");
  return vi
    .spyOn(placement, "solveBuild")
    .mockRejectedValue(new PlacementError("unavailable", "stubbed by stage-round-court-tags.test.ts"));
}

// ===========================================================================
// 1-3: the WRITE path. `stages.required_court_tags` shipped in V367 as a
// read-only column with no writer at all; `stage_round_court_tags` (V375) is
// new. Everything below fails outright without #622 — the module under test
// did not exist.
// ===========================================================================
describe.skipIf(!HAS_DB)("putStageCourtTags / getStageCourtTags — the write path (#622)", () => {
  it("round-trips stage-wide tags and round rules, sorted by role key, with tags normalised", async () => {
    const auth = await seedOrg();
    const { stageId } = await seedStage(auth, "knockout", 8, []);

    // `normalizeTags` (venues.ts) is trim + lowercase + dedupe + drop-empties,
    // preserving FIRST-SEEN order — so `[" Show Court ", "SHOW COURT"]`
    // collapses to exactly `["show court"]`. Asserted rather than assumed:
    // the stored value is half of a primary key's payload and a second
    // normalisation rule here would silently store a tag no court matches.
    const written = await putStageCourtTags(auth, stageId, {
      required_court_tags: [" Show Court ", "SHOW COURT", ""],
      // Deliberately NOT in sorted order on the way in — the response and the
      // GET must both come back ordered by `round_role`, so the console can
      // diff two reads without sorting them itself.
      rounds: [
        { round_role: "semi_final", required_court_tags: ["  Lit  "] },
        { round_role: "final", required_court_tags: ["Championship", "championship"] },
      ],
    });
    expect(written.required_court_tags).toEqual(["show court"]);
    expect(written.rounds).toEqual([
      { round_role: "final", required_court_tags: ["championship"] },
      { round_role: "semi_final", required_court_tags: ["lit"] },
    ]);

    // The GET is a separate query path (`getStageCourtTags`) and must agree
    // with the PUT's own echo — the two reading the table differently is how
    // a console shows a rule that is not the one in force.
    const read = await getStageCourtTags(auth, stageId);
    expect(read.stage_id).toBe(stageId);
    expect(read.required_court_tags).toEqual(["show court"]);
    expect(read.rounds).toEqual(written.rounds);
  });

  it("`rounds` is a WHOLE-LIST REPLACE — an omitted role is deleted — but omitting the key entirely leaves the rules untouched", async () => {
    // The distinction this pins is the reason `rounds` is optional rather
    // than defaulted: an empty tag list is a legitimate "no requirement" ROW,
    // so a merge semantic would leave the console no way to DELETE a rule at
    // all. Meanwhile a PUT that only means to change the stage-wide tags must
    // not silently wipe every round rule as a side effect.
    const auth = await seedOrg();
    const { stageId } = await seedStage(auth, "knockout", 8, []);
    await putStageCourtTags(auth, stageId, {
      rounds: [
        { round_role: "final", required_court_tags: ["championship"] },
        { round_role: "semi_final", required_court_tags: ["lit"] },
      ],
    });

    // Second PUT omits `semi_final` -> that row is GONE, not merged forward.
    const replaced = await putStageCourtTags(auth, stageId, {
      rounds: [{ round_role: "final", required_court_tags: ["championship"] }],
    });
    expect(replaced.rounds).toEqual([{ round_role: "final", required_court_tags: ["championship"] }]);

    // Third PUT omits `rounds` ALTOGETHER -> the surviving rule is untouched
    // while the stage-wide list changes.
    const stageOnly = await putStageCourtTags(auth, stageId, { required_court_tags: ["indoor"] });
    expect(stageOnly.required_court_tags).toEqual(["indoor"]);
    expect(stageOnly.rounds).toEqual([{ round_role: "final", required_court_tags: ["championship"] }]);
    const read = await getStageCourtTags(auth, stageId);
    expect(read.rounds).toEqual([{ round_role: "final", required_court_tags: ["championship"] }]);
  });

  it("refuses an unknown role key with 422 UNKNOWN_ROUND_ROLE, and a repeated role with 422 DUPLICATE_ROUND_ROLE", async () => {
    // Both are refused rather than stored because `round_role` is part of the
    // table's primary key: a typo is not a value that merely fails to match
    // today — it is a row that can never match any fixture, silently, forever,
    // while the console shows the organiser a rule they believe is in force.
    const auth = await seedOrg();
    const { stageId } = await seedStage(auth, "knockout", 8, []);

    let unknown: unknown;
    try {
      await putStageCourtTags(auth, stageId, {
        rounds: [{ round_role: "grand_finale", required_court_tags: ["championship"] }],
      });
    } catch (err) {
      unknown = err;
    }
    expect(unknown).toMatchObject({ status: 422, code: "UNKNOWN_ROUND_ROLE" });

    let duplicate: unknown;
    try {
      await putStageCourtTags(auth, stageId, {
        rounds: [
          { round_role: "final", required_court_tags: ["championship"] },
          { round_role: "final", required_court_tags: ["lit"] },
        ],
      });
    } catch (err) {
      duplicate = err;
    }
    expect(duplicate).toMatchObject({ status: 422, code: "DUPLICATE_ROUND_ROLE" });

    // Neither refusal may have written anything — the validation runs BEFORE
    // the transaction opens, and a partially-applied whole-list replace would
    // be worse than either error.
    const read = await getStageCourtTags(auth, stageId);
    expect(read.rounds).toEqual([]);
  });

  it("reports available_round_roles for a generated 8-entrant knockout in bracket order", async () => {
    // The picker vocabulary. Derived through the SAME namer the RESOLUTION
    // path uses (`roundRoleFor` -> `roundRoleKey`) over the same fixture list,
    // so a role the console offers is always a role a fixture will actually
    // resolve to — a second derivation is how an offered key becomes a rule
    // that silently applies to nothing. Order is bracket order (fixtures read
    // `order by round_no, seq_in_round`), not alphabetical.
    const auth = await seedOrg();
    const { stageId } = await seedStage(auth, "knockout", 8, []);
    const read = await getStageCourtTags(auth, stageId);
    expect(read.available_round_roles).toEqual(["quarter_final", "semi_final", "final"]);
  });
});

// ===========================================================================
// 5: THE MOTIVATING CASE. This is the assertion the whole issue is about.
// ===========================================================================
describe.skipIf(!HAS_DB)("requiredCourtTagsByFixture — a round rule narrows ONE round of a stage (#622)", () => {
  it("resolves ONLY the final's fixture to ['championship'] while the QFs and SFs of the same stage resolve to []", async () => {
    // Division: no tags. Stage: no tags. ONLY the `final` role carries one.
    // Pre-#622 there was no scope that could express this — the narrowest
    // available was the stage, and a stage tag applies to all seven fixtures
    // of an 8-entrant bracket, forcing every quarter-final onto the single
    // championship court. That is why the per-FIXTURE resolution below is not
    // an optimisation but the only correct answer.
    const auth = await seedOrg();
    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const championship = await createCourt(auth, venue.id, {
      name: "Centre",
      sort: 0,
      tags: ["championship"],
    });
    const outer1 = await createCourt(auth, venue.id, { name: "Outer 1", sort: 1, tags: [] });
    const outer2 = await createCourt(auth, venue.id, { name: "Outer 2", sort: 2, tags: [] });
    const { stageId, divisionId } = await seedStage(auth, "knockout", 8, [
      championship.id,
      outer1.id,
      outer2.id,
    ]);
    await putStageCourtTags(auth, stageId, {
      rounds: [{ round_role: "final", required_court_tags: ["championship"] }],
    });

    const fixtures = await stageFixtures(stageId);
    // 8 entrants -> 4 QFs (round 1), 2 SFs (round 2), 1 final (round 3).
    expect(fixtures.length).toBe(7);
    const finalFixture = fixtures.at(-1)!;
    const earlier = fixtures.slice(0, -1);

    // Resolved inside a tenant transaction, the same way every production
    // caller reaches it (`autoSchedule`'s phase 1, `validateScheduleIn`) —
    // `requiredCourtTagsByFixture` takes the CALLER's open `tx` rather than
    // opening its own, precisely so it can never nest a `withTenant`.
    const tags = await withTenant(auth.orgId, (tx) =>
      requiredCourtTagsByFixture(tx, divisionId, []),
    );

    expect(tags.get(finalFixture.id)).toEqual(["championship"]);
    for (const f of earlier) {
      // `[]` — present in the map, with no requirement — never `undefined`
      // and never the final's list. A fixture missing from the map means "not
      // in this division", a different fact.
      expect(tags.get(f.id)).toEqual([]);
    }
  });
});

// ===========================================================================
// 6: the PLACER consumer.
// ===========================================================================
describe.skipIf(!HAS_DB)("autoSchedule — honours a round-scoped tag per fixture (#622)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // WHY THE BRACKET CASE IS ASSERTED OVER AN ALREADY-PLACED BOARD, and not
  // over an empty one. The greedy seed is the path this file forces (the
  // placement service is stubbed to fail), and greedy is ROUND-BLIND for a
  // bracket stage on purpose: `autoSchedule` stamps `roundNo` only for
  // `league`/`group` stages (`roundRobinStageIds`), because for a bracket the
  // column is a display label rather than an ordering. So greedy places an
  // 8-entrant bracket in fixture-ID order, routinely puts the final before its
  // own semi-finals, and `greedySeed`'s legalisation pass then DROPS it for a
  // blocking `order_before_feeder` — measured against this exact seed, with no
  // round rule at all, the final never survives. An empty-board assertion on
  // "the final is on the championship court" is therefore not testing #622: it
  // passes only when the narrowing happens to delay the final past its feeders,
  // which depends on the random UUID order of seven fixtures. It was flaky
  // roughly one run in three.
  //
  // LOCKING the six earlier fixtures removes greedy's ordering from the
  // question entirely — they are committed at their own slots before the free
  // cards are considered (`slotFixtures` step 1), so the final is the only card
  // greedy chooses a slot for, and the narrowing is the ONLY thing deciding
  // where it lands. A lock, not merely a placement: REFLOW freezes an
  // already-placed card for the SOLVER and reconciles it afterwards, but
  // `greedySeed` re-places anything without `locked` from scratch, so a bare
  // `scheduled_at` would leave the ordering exactly as unstable as before.
  it("makes the final WAIT for the championship court instead of taking the free untagged court beside it", async () => {
    // `allowedCourts` is stamped PER FIXTURE by autoSchedule now; the stage's
    // `config.courts` deliberately stays the full stage-wide set, because a
    // lattice narrowed to the intersection would delete the very slots the
    // un-narrowed rounds need.
    //
    // The board below is built so the two answers are far apart. Outer 2 is
    // EMPTY all day, so an un-narrowed final is placed on it at the very start
    // of the window (and, being before its own semi-finals, is then dropped as
    // a feed-order breach); a narrowed final can only go on the championship
    // court, which is occupied until 01:30. Both the court and the time below
    // therefore fail without #622.
    const auth = await seedOrg();
    const solveBuild = await spyOnPlacement();
    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const championship = await createCourt(auth, venue.id, {
      name: "Centre",
      sort: 0,
      tags: ["championship"],
    });
    const outer1 = await createCourt(auth, venue.id, { name: "Outer 1", sort: 1, tags: [] });
    const outer2 = await createCourt(auth, venue.id, { name: "Outer 2", sort: 2, tags: [] });
    const { stageId } = await seedStage(auth, "knockout", 8, [
      championship.id,
      outer1.id,
      outer2.id,
    ]);
    await putStageCourtTags(auth, stageId, {
      rounds: [{ round_role: "final", required_court_tags: ["championship"] }],
    });

    const fixtures = await stageFixtures(stageId);
    // 8 entrants -> 4 QFs (round 1), 2 SFs (round 2), 1 final (round 3).
    expect(fixtures.length).toBe(7);
    const finalId = fixtures.at(-1)!.id;
    // The organiser's own LOCKED board, in feed order: each semi-final sits
    // after both of the quarter-finals that feed it, so nothing here is a
    // breach the verifier could confuse with the one under test. Two courts
    // busy until 01:30, Outer 2 untouched.
    const board: [FixtureRow, string, string][] = [
      [fixtures[0]!, championship.id, "2026-08-01T00:00:00.000Z"],
      [fixtures[1]!, championship.id, "2026-08-01T00:30:00.000Z"],
      [fixtures[2]!, outer1.id, "2026-08-01T00:00:00.000Z"],
      [fixtures[3]!, outer1.id, "2026-08-01T00:30:00.000Z"],
      [fixtures[4]!, championship.id, "2026-08-01T01:00:00.000Z"],
      [fixtures[5]!, outer1.id, "2026-08-01T01:00:00.000Z"],
    ];
    for (const [fixture, court, at] of board) {
      await sql`
        update fixtures
        set scheduled_at = ${at}, court_id = ${court}, schedule_locked = true
        where id = ${fixture.id}`;
    }

    const out = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" });
    // The real placement service is stubbed to fail, so this is the
    // deterministic greedy path — the same forcing schedule-court-candidates
    // .test.ts uses, and the reason the court choice below is assertable.
    expect(solveBuild).toHaveBeenCalled();

    const byFixture = new Map(out.assignments.map((a) => [a.fixture_id, a] as const));
    expect(byFixture.get(finalId)?.court_id).toBe(championship.id);
    // The time, not just the court: 01:30 is the first instant the championship
    // court is free, and Outer 2 was free from 00:00 the whole time. This is
    // what "narrowed" means for the placer — it waited.
    expect(byFixture.get(finalId)?.scheduled_at).toBe("2026-08-01T01:30:00.000Z");
    // The rest of the bracket is NOT narrowed: `config.courts` stayed the
    // stage-wide set, so every earlier round comes back exactly where the
    // organiser had it, three of them on an untagged court — which is precisely
    // what a STAGE-wide championship tag could not have done, and the failure
    // mode #622 exists to avoid.
    for (const [fixture, court, at] of board) {
      expect(byFixture.get(fixture.id)?.court_id).toBe(court);
      expect(byFixture.get(fixture.id)?.scheduled_at).toBe(at);
    }
  });

  it("sends BOTH of a league round's fixtures to the tagged court while the other rounds keep the whole set", async () => {
    // The same placer property over a board the pass builds from nothing — a
    // league stage has no feed edges and stamps `roundNo`, so greedy's order is
    // round-major and every fixture is placed, which is what makes a
    // from-scratch assertion deterministic here and not in the bracket above.
    //
    // TWO fixtures share the one tagged court here, which is what the round
    // scope has to survive: un-narrowed, the placer sends the pair out in
    // parallel at the same instant, one per court, so exactly one of them lands
    // on the untagged court beside it.
    const auth = await seedOrg();
    const solveBuild = await spyOnPlacement();
    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const showCourt = await createCourt(auth, venue.id, {
      name: "Show",
      sort: 0,
      tags: ["show court"],
    });
    const side = await createCourt(auth, venue.id, { name: "Side", sort: 1, tags: [] });
    // 4 entrants -> a 3-round round robin of 6 fixtures, 2 per round.
    const { stageId } = await seedStage(auth, "league", 4, [showCourt.id, side.id]);
    await putStageCourtTags(auth, stageId, {
      rounds: [{ round_role: "plain_round_2", required_court_tags: ["show court"] }],
    });

    const out = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" });
    expect(solveBuild).toHaveBeenCalled();

    const fixtures = await stageFixtures(stageId);
    expect(fixtures.length).toBe(6);
    const byFixture = new Map(out.assignments.map((a) => [a.fixture_id, a.court_id] as const));
    // Nothing was dropped: a narrowing that made a round unplaceable would show
    // up here first, and an assertion about the courts of a half-empty board
    // would be reading the wrong failure.
    expect(byFixture.size).toBe(6);
    const roundTwo = fixtures.filter((f) => f.round_no === 2);
    expect(roundTwo.length).toBe(2);
    // BOTH of them, on the one tagged court — so they are necessarily
    // serialised onto it rather than one spilling onto the untagged court
    // beside it, which is what the un-narrowed placer does with them.
    expect(roundTwo.map((f) => byFixture.get(f.id))).toEqual([showCourt.id, showCourt.id]);
    // …and the rounds with no rule of their own still have both courts.
    expect(
      fixtures.filter((f) => f.round_no !== 2).some((f) => byFixture.get(f.id) === side.id),
    ).toBe(true);
  });

  it("refuses with 422 NO_MATCHING_COURT when a round tag matches no court — never places that round unconstrained", async () => {
    // The wire, greedy, and CP-SAT all read `allowedCourts: []` as
    // UNCONSTRAINED. Stamping that for a round whose tags match no court
    // would place the round on any stage-wide court and only warn later.
    // Stage-level empty already 422s; round-level empty must too.
    const auth = await seedOrg();
    const solveBuild = await spyOnPlacement();
    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const side = await createCourt(auth, venue.id, { name: "Side", sort: 0, tags: [] });
    const { stageId } = await seedStage(auth, "league", 4, [side.id]);
    await putStageCourtTags(auth, stageId, {
      rounds: [{ round_role: "plain_round_2", required_court_tags: ["championship"] }],
    });

    let caught: unknown;
    try {
      await autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ status: 422, code: NO_MATCHING_COURT_CODE });
    expect(solveBuild).not.toHaveBeenCalled();
  });

  it("does not refuse when the only empty-candidate fixtures are locked — a pin outranks the tag", async () => {
    const auth = await seedOrg();
    const solveBuild = await spyOnPlacement();
    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const side = await createCourt(auth, venue.id, { name: "Side", sort: 0, tags: [] });
    const { stageId } = await seedStage(auth, "league", 4, [side.id]);
    await putStageCourtTags(auth, stageId, {
      rounds: [{ round_role: "plain_round_2", required_court_tags: ["championship"] }],
    });
    const fixtures = await stageFixtures(stageId);
    const roundTwo = fixtures.filter((f) => f.round_no === 2);
    expect(roundTwo.length).toBe(2);
    for (const [i, f] of roundTwo.entries()) {
      await sql`
        update fixtures
        set scheduled_at = ${`2026-08-01T0${i}:00:00.000Z`},
            court_id = ${side.id},
            schedule_locked = true
        where id = ${f.id}`;
    }

    const out = await autoSchedule(auth, stageId, { only_unlocked: true, mode: "reflow" });
    expect(out).toBeDefined();
    expect(solveBuild).toHaveBeenCalled();
  });
});

// ===========================================================================
// 7: the VERIFIER consumer.
// ===========================================================================
describe.skipIf(!HAS_DB)("validateSchedule — court_tag_mismatch is now per fixture, not per stage (#622)", () => {
  it("reports a mismatch for a final on a non-championship court and NOTHING for a semi-final on that same court", async () => {
    // THE PAIR THAT COULD NOT BE DISTINGUISHED. Before #622 `validateScheduleIn`
    // resolved one required-tag list per SCOPE and unioned the resulting
    // qualified-court sets across stages (its own comment recorded this as the
    // closest safe approximation available at the time) — so a final and a
    // semi-final, sharing one `stages` row, necessarily shared one verdict.
    // Either both were legal on Outer 1 (missing the final's breach) or
    // neither was (reporting a phantom conflict against the semi-final).
    // Per-fixture `courtTagQualifiedIdsByFixture` is what makes the two
    // assertions below able to disagree at all.
    const auth = await seedOrg();
    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const championship = await createCourt(auth, venue.id, {
      name: "Centre",
      sort: 0,
      tags: ["championship"],
    });
    const outer = await createCourt(auth, venue.id, { name: "Outer 1", sort: 1, tags: [] });
    const { stageId, divisionId } = await seedStage(auth, "knockout", 8, [
      championship.id,
      outer.id,
    ]);
    await putStageCourtTags(auth, stageId, {
      rounds: [{ round_role: "final", required_court_tags: ["championship"] }],
    });

    const fixtures = await stageFixtures(stageId);
    const finalFixture = fixtures.at(-1)!;
    const semiFixture = fixtures.find((f) => f.round_no === 2)!;
    // The hand-drag: both placed directly onto the untagged Outer 1,
    // bypassing autoSchedule (and its per-fixture narrowing) entirely, at
    // non-overlapping times so no court double-booking can be mistaken for
    // the tag conflict under test.
    await sql`
      update fixtures set scheduled_at = '2026-08-01T10:00:00.000Z', court_id = ${outer.id}
      where id = ${semiFixture.id}`;
    await sql`
      update fixtures set scheduled_at = '2026-08-01T14:00:00.000Z', court_id = ${outer.id}
      where id = ${finalFixture.id}`;

    const result = await validateSchedule(auth, divisionId);
    const mismatches = result.conflicts.filter((c) => c.details?.kind === "court_tag_mismatch");
    expect(mismatches.map((c) => c.fixture_id)).toEqual([finalFixture.id]);
    expect(mismatches[0]!.details?.court).toBe(outer.id);
  });
});

// ===========================================================================
// 8: the issue's SECOND open question — how round-scoped tags interact with
// round-robin-kind stages.
// ===========================================================================
describe.skipIf(!HAS_DB)("requiredCourtTagsByFixture — plain_round_N narrows one round of a league (#622)", () => {
  it("applies a plain_round_2 rule to round 2's fixtures only", async () => {
    // The answer #622 settles: a round-robin round is expressed in the SAME
    // role vocabulary as a bracket position rather than needing a second,
    // parallel keying scheme — `roundRole()` returns `{kind:"plain_round", n}`
    // for every non-bracket stage kind, so `plain_round_2` is a real,
    // addressable role. Made the ordinal a role, instead of making the role an
    // ordinal.
    //
    // `n` is the fixture's 1-based rank within its own LANE's sorted round
    // list, not the raw `round_no`, so this stays correct for a sparse or
    // non-1-based numbering too.
    const auth = await seedOrg();
    const venue = await createVenue(auth, { name: "Main", sort: 0 });
    const showCourt = await createCourt(auth, venue.id, {
      name: "Show",
      sort: 0,
      tags: ["show court"],
    });
    const other = await createCourt(auth, venue.id, { name: "Side", sort: 1, tags: [] });
    // 4 entrants -> a 3-round round robin of 6 fixtures, 2 per round.
    const { stageId, divisionId } = await seedStage(auth, "league", 4, [showCourt.id, other.id]);
    await putStageCourtTags(auth, stageId, {
      rounds: [{ round_role: "plain_round_2", required_court_tags: ["show court"] }],
    });

    const fixtures = await stageFixtures(stageId);
    expect(fixtures.length).toBe(6);
    const tags = await withTenant(auth.orgId, (tx) =>
      requiredCourtTagsByFixture(tx, divisionId, []),
    );
    for (const f of fixtures) {
      expect(tags.get(f.id)).toEqual(f.round_no === 2 ? ["show court"] : []);
    }
  });
});
