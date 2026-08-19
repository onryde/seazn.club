// The auto pass must know which fixture feeds which.
//
// WHAT THE DEFECT WAS. `/stages/{id}/schedule/auto` used to be a single
// synchronous `slotFixtures` call, and greedy walks fixtures in ascending round
// order — so a dependent could not physically land before its feeder and the
// pass never needed to be told about feed edges. The solver wave replaced that
// placer with `buildSchedule` / `repairSchedule`, which place by search and have
// no such structural guarantee. Both accept `dependencies`, encode them as a
// hard term, and verify with them; `autoSchedule` passed NONE, and neither did
// the `validateAssignments` call in `reflowExisting`'s `settle`.
//
// The result was not a missing warning, it was a wrong board. On a cup bracket
// with a `feeder_to_dependent` rest rule the repair solver satisfied the rule by
// moving the FINAL 30 minutes BEFORE its own semi-finals — measured against the
// running production server, feeder end 09:30, final start 08:30, a gap of MINUS
// 60 minutes — and reported `conflicts: []`. `validateInstructionRules` skips a
// dependent placed before its feeder on purpose (that is an ordering violation,
// reported as `order`), and `order` was inert for want of the dependency list,
// so the two holes lined up and the board came back clean. The apply gate, which
// does pass `feedDependencies(all)`, then answered the auto pass's own proposal
// with a blocking 409.
//
// WHY BOTH TESTS (historical — see the C4 note on the first test below for
// what changed). The first pinned the SOLVER half — `repairSchedule` got the
// edges, so it saw an inverted card as a conflict and moved it. The second
// pins the VERIFIER half — `settle`'s `validateAssignments` gets them too, so
// an inversion nothing can move is shown rather than swallowed. A fix that
// wired only one of the two passes exactly one of these.
//
// NEITHER ASSERTS THE SOLVER'S CHOICE OF SLOT, and that is deliberate. The
// bracket that exposed this in smoke is repaired by moving the final anywhere at
// or past its feeders' finish, several placements do that, and which one z3
// returns varied between runs even before the fix — so a test keyed on an
// instant would be a flake and a test keyed on "was the rule reported?" would
// pass by luck about half the time. Both cases below start from an INVERTED
// incumbent and pin the invariant, so each is red for the missing wiring on
// every run rather than on some of them.
//
// C4 (2026-08-14, z3 retirement stage A) RETIRED THE FIRST TEST'S PREMISE,
// NOT JUST ITS MECHANISM. `reflowExisting` no longer calls `repairSchedule`
// at all, and the churn-minimization ruling it ships means an already-PLACED
// card is frozen for the run exactly like a LOCKED one — even when its
// current slot is illegal. "final" below is unlocked but already placed, so
// it is now frozen too, and REFLOW can no longer move it to fix the
// inversion (the owner-accepted trade-off: REFLOW can only place cards with
// no slot yet, never rearrange ones that already have one). The first test
// is rewritten, not deleted, to assert exactly that — it is the one place in
// this suite proving the freeze applies to an UNLOCKED-but-placed dependent,
// which the second test (everything locked) cannot distinguish from "locked
// is frozen".
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { createEntrants } from "../entrants";
import { createStages, generateStageFixtures } from "../stages";
import { autoSchedule, putScheduleSettings } from "../schedule";
import { patchFixture } from "../fixtures";
import { createVenue, createCourt } from "../venues";

const HAS_DB = !!process.env.DATABASE_URL;
const T0 = "2026-11-05T09:00:00.000Z";
const MIN = 60_000;
const MATCH_MINUTES = 30;
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * MIN).toISOString();

const DIVISION_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

interface Bracket {
  auth: AuthCtx;
  stageId: string;
  /** Both semis, each of which names `final` in `winner_to_fixture`. */
  feeders: string[];
  /** The one round-2 fixture both semis feed. */
  final: string;
  /** The third-place fixture — round 2, but fed by nothing, so it is the
   *  control: whatever the feed rules do, they must not touch it. */
  thirdPlace: string;
  /** P9 pass 3a — the 2 real courts.id values "C1"/"C2" used to be. */
  court1: string;
  court2: string;
}

/** 4 seeded entrants -> a knockout stage of 2 fed semis + final + third place,
 *  two courts, 30-minute matches, no gap and NO typed rules: both tests write
 *  their own board, and a rule firing alongside would turn the exact conflict
 *  set the second one asserts into a subset check. */
async function seed(): Promise<Bracket> {
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
    // #376: an end date is mandatory on every competition insert.
    ends_on: "2030-12-31",
    name: "Feed " + suffix,
    visibility: "private",
    branding: {},
  });
  const division = await createDivision(auth, competition.id, {
    name: "Cup",
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
    kind: "knockout",
    name: "Cup",
    config: { thirdPlace: true },
  });
  // P9 pass 3a: real courts.id values — ScheduleConfig.courts is CourtId[]
  // since pass 1, fixtures.court_id carries a composite FK since V367/368.
  const venue = await createVenue(auth, { name: "Main", sort: 0 });
  const court1 = await createCourt(auth, venue.id, { name: "C1", sort: 0, tags: [] });
  const court2 = await createCourt(auth, venue.id, { name: "C2", sort: 1, tags: [] });
  await putScheduleSettings(auth, division.id, {
    config: {
      startAt: T0,
      matchMinutes: MATCH_MINUTES,
      gapMinutes: 0,
      courts: [court1.id, court2.id],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
    },
    tz: "UTC",
  });
  await generateStageFixtures(auth, stage!.id);

  const rows = await sql<{ id: string; winner_to_fixture: string | null }[]>`
    select id, winner_to_fixture from fixtures where stage_id = ${stage!.id}`;
  expect(rows).toHaveLength(4);
  const feeders = rows.filter((r) => r.winner_to_fixture !== null);
  // Not an incidental assertion. The whole file is about the feed edge, and a
  // generator that stopped writing `winner_to_fixture` would leave every
  // assertion below vacuously satisfiable in the same direction.
  expect(feeders).toHaveLength(2);
  const targets = new Set(feeders.map((f) => f.winner_to_fixture as string));
  expect(targets.size).toBe(1);
  const final = [...targets][0]!;
  const thirdPlace = rows.find((r) => r.winner_to_fixture === null && r.id !== final)!.id;
  return {
    auth, stageId: stage!.id, feeders: feeders.map((f) => f.id), final, thirdPlace,
    court1: court1.id, court2: court2.id,
  };
}

describe.skipIf(!HAS_DB)("the auto pass honours feed order (#452)", () => {
  /**
   * REWRITTEN BY C4 (2026-08-14, z3 retirement stage A) — see the file
   * header for why. Before C4 this test proved REFLOW's solver half moved
   * "final" to fix the inversion, because "final" was the ONE unlocked
   * (hence movable) card. Under C4's churn-minimization ruling an
   * already-PLACED card is frozen for the run whether or not it is also
   * LOCKED, so "final" — placed, but never locked here — can no longer be
   * moved to fix anything. What this test proves now: that freeze applies
   * even when the frozen card's own position is illegal, and the
   * inversion is REPORTED rather than silently shipped OR silently
   * repaired out from under the organiser. Positions are asserted UNCHANGED
   * (the opposite of the pre-C4 assertion below), and a real `order`
   * conflict must ride along.
   */
  it("an already-placed but UNLOCKED dependent is frozen too — reported, not moved", async () => {
    const b = await seed();

    // Written straight to the table: direct `order` is blocking, so
    // `applySchedule` refuses to CREATE this board — and refusing to create one
    // is not the same as never having to read one. The final runs 09:00-09:30,
    // its semis 10:00-10:30, so it finishes 90 minutes before either feeder does.
    await sql`
      update fixtures set scheduled_at = ${at(0)}, court_id = ${b.court1} where id = ${b.final}`;
    await sql`
      update fixtures set scheduled_at = ${at(60)}, court_id = ${b.court1} where id = ${b.feeders[0]!}`;
    await sql`
      update fixtures set scheduled_at = ${at(60)}, court_id = ${b.court2} where id = ${b.feeders[1]!}`;
    // Parked well clear, after both semis, so it contributes nothing of its own.
    await sql`
      update fixtures set scheduled_at = ${at(240)}, court_id = ${b.court2}
      where id = ${b.thirdPlace}`;
    // ONLY the feeders are locked. "final" is deliberately left UNLOCKED —
    // the whole point is that it is frozen anyway, because it is already
    // PLACED (see the doc comment above).
    for (const id of b.feeders) await patchFixture(b.auth, id, { schedule_locked: true });

    // `only_unlocked: true` / REFLOW is the mode the wire derives from an empty
    // body.
    const out = await autoSchedule(b.auth, b.stageId, { only_unlocked: true, mode: "reflow" });
    expect(out.assignments).toHaveLength(4);

    const byId = new Map(out.assignments.map((a) => [a.fixture_id, a]));
    // Nothing moved — "final" included, even though it was never locked.
    expect(byId.get(b.final)!.scheduled_at).toBe(at(0));
    for (const feeder of b.feeders) {
      expect(byId.get(feeder)!.scheduled_at).toBe(at(60));
    }
    expect(byId.get(b.thirdPlace)!.scheduled_at).toBe(at(240));
    expect(out.solver.moved).toBe(0);

    // The inversion is REPORTED, not swallowed — this is the property that
    // makes "frozen, not moved" safe rather than a silent regression back
    // to the pre-#452 bug this file was originally written to close.
    const finalConflicts = out.conflicts.filter((c) => c.fixture_id === b.final);
    expect(finalConflicts.length).toBeGreaterThan(0);
    expect(finalConflicts.every((c) => c.code === "warn.order")).toBe(true);
    expect(finalConflicts.some((c) => c.blocking)).toBe(true);
  }, 120_000);

  it("REPORTS an inverted feed it cannot repair, instead of handing it back clean", async () => {
    // No `hard` rules here: the expected conflict set below is EXACT, and a
    // typed rule firing alongside would make it a subset assertion instead.
    const b = await seed();

    // Written straight to the table: `applySchedule` refuses to CREATE this
    // board (direct `order` is blocking), and refusing to create one is not the
    // same as never having to read one. The final runs 09:00-09:30, its semis
    // 10:00-10:30 — it finishes an hour and a half before either feeder ends.
    await sql`
      update fixtures set scheduled_at = ${at(0)}, court_id = ${b.court1} where id = ${b.final}`;
    await sql`
      update fixtures set scheduled_at = ${at(60)}, court_id = ${b.court1} where id = ${b.feeders[0]!}`;
    await sql`
      update fixtures set scheduled_at = ${at(60)}, court_id = ${b.court2} where id = ${b.feeders[1]!}`;
    // Parked well clear on the other court, and MOVABLE, so the repair solver
    // has a real proposal to work on and the run is not a degenerate empty
    // solve. It is fed by both semis' losers and sits after both, so it
    // contributes no row of its own.
    await sql`
      update fixtures set scheduled_at = ${at(240)}, court_id = ${b.court2}
      where id = ${b.thirdPlace}`;
    // Pinned, so the offending three cannot be moved and the inversion survives
    // to the report — no search, no flake.
    for (const id of [b.final, ...b.feeders]) {
      await patchFixture(b.auth, id, { schedule_locked: true });
    }

    const out = await autoSchedule(b.auth, b.stageId, { only_unlocked: true, mode: "reflow" });

    // Handed back unchanged...
    expect(
      out.assignments.find((a) => a.fixture_id === b.final)?.scheduled_at,
    ).toBe(at(0));

    // ...and this is the EXACT set. Whole objects rather than a count: a count
    // would survive these two turning into two entirely different rules, and
    // dropping `blocking` would survive the row going warn-only, which is the
    // difference between the organiser seeing red and seeing nothing.
    //
    // Sorted on `details.other_fixture_id` (not the old `detail` prose, C3
    // 2026-08-13; snake_case — `ScheduleConflict`'s house style, unlike the
    // engine's own camelCase `ConflictDetail`) and `detail` stripped before
    // the `toEqual`: it is still populated — same legacy English as before,
    // proven by the dedicated legacy-parity suite — but this test's job is
    // the WIRE SHAPE, and asserting its exact text here would be exactly the
    // prose-coupling this design amendment removes.
    const byOtherFixture = (
      x: { details?: { other_fixture_id?: string } },
      y: { details?: { other_fixture_id?: string } },
    ) => (x.details?.other_fixture_id ?? "").localeCompare(y.details?.other_fixture_id ?? "");
    const stripDetail = <T extends { detail?: string }>({ detail: _detail, ...rest }: T) => rest;
    const expected = [...b.feeders]
      .map((feeder) => ({
        fixture_id: b.final,
        code: "warn.order",
        rule: "H6",
        blocking: true,
        shortfall_minutes: 90,
        details: { kind: "order_before_feeder" as const, other_fixture_id: feeder },
      }))
      .sort(byOtherFixture);
    expect([...out.conflicts].sort(byOtherFixture).map(stripDetail)).toEqual(expected);
  }, 120_000);
});
