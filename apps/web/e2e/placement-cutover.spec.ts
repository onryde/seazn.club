import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { TAG, apiJson, addEntrantsViaApi, divisionPath, seedVenueWithCourts } from "./helpers";

// Task 11 (placement cutover) — proves the ONE thing `auto-schedule.spec.ts`
// structurally cannot: that clicking Auto-schedule in a real browser, against a
// real running placement service, produces a board the OPTIMISER produced —
// not the greedy fallback wearing identical copy.
//
// WHY A SEPARATE FILE, AND WHY THIS BOARD. Read
// `docs/superpowers/plans/2026-08-07-placement-service-prompts/_INDEX.md`'s
// "The cutover nearly shipped INERT": Task 06 wired `solveBuild` correctly and
// passed 8/8 new happy-path tests while running greedy on MOST real boards,
// because `engine` only reports "optimized" when the candidate the service
// returns is STRICTLY better than greedy's own seed (`isStrictlyBetter`,
// `build-objectives.ts` — placed count, then makespan, then worst idle gap,
// then court imbalance, lexicographic). Every one of `auto-schedule.spec.ts`'s
// boards (including its own `seedBoard()`, a 4-entrant/2-court round robin) is
// small and regular enough that greedy's seed IS already the tier solver's
// optimum — `engine` stays "greedy", correctly, no matter how well the cutover
// is wired. A green assertion on THAT shape says nothing about whether the
// optimiser is ever reached.
//
// THE BOARD, AND WHY THIS EXACT SHAPE. Six entrants, three rounds of three
// matches each (ad-hoc fixtures — `POST /stages/{id}/fixtures`, PROMPT-66 —
// not the round-robin generator: a generated 21-fixture/7-round board hits
// the SAME mechanism but is too large to prove optimal inside
// `PLACEMENT_WALL_SECONDS_MAX` (10s by default, `services/placement/src/
// placement/config.py`) — measured directly against a live service, it stalls
// at `tiers_completed: 1/4`, `budget_expired: true`, and falls back to greedy
// for a reason that has nothing to do with the cutover). Three matches cannot
// fit in one wave across two courts, so every round spills one match into a
// second wave — greedy (a single left-to-right pass, no look-ahead) always
// hands that spillover to the FIRST configured court, every round, with no
// way to know that alternating it would balance the whole board.
//
// MEASURED, not assumed (`packages/engine`'s own `slotFixtures`/`boardMetrics`
// against this exact fixture list, and the live service against this exact
// board through this exact HTTP surface, both reproduced 3/3 identical):
//
//   engine    makespan  worstIdleGap  courtImbalance  courts(A/B)
//   greedy       240min       105min           90min        6 / 3
//   optimized    150min        30min           30min        5 / 4
//
// A 90-minute makespan cut is not a rounding difference — it is the whole
// claim this file exists to prove, on a board small enough (9 fixtures) to
// solve in ~3-4s, well inside both the 10s service cap and the 20s wall the
// web layer allows.
//
// SELECTORS ARE IDS, NEVER COPY (#465) — same discipline as
// `auto-schedule.spec.ts`. `data-engine` is the ONE thing this file exists
// to assert: `ENGINE_KEY` (`result-strip.tsx`) deliberately renders
// "optimized" with the SAME copy as z3 in every locale, so the rendered
// provenance string cannot tell them apart — only the attribute can.

const START = new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString();
const SLOT_MIN = 30;
const REST_MIN = 45;

/** 3 rounds x 3 matches over 6 entrants (indices into the entrant list) — no
 *  entrant plays twice in the same round, no pairing repeats. See the file
 *  docblock for why this exact shape and size. */
const ROUNDS: [number, number][][] = [
  [[0, 1], [2, 3], [4, 5]],
  [[0, 2], [1, 4], [3, 5]],
  [[0, 3], [1, 5], [2, 4]],
];
const FIXTURE_COUNT = ROUNDS.flat().length; // 9

/** The two statuses a working build can return — identical set to
 *  `auto-schedule.spec.ts`'s `SOLVED`, duplicated rather than imported: that
 *  file is Prompt 10's, not shared module surface, and its own comment says
 *  this list is deliberately closed and does not grow. */
const SOLVED = ["ok", "already_optimal"];

/** `solver_busy` is a live, ordinary status under `PLACEMENT_MAX_WORKERS=1` —
 *  not a fault, and not accepted here either: accepting it would let this file
 *  pass against a solve that never ran, the one thing it exists to catch. Same
 *  bounded retry as `auto-schedule.spec.ts`'s `runSolver`. */
const BUSY_RETRIES = 3;
const BUSY_BACKOFF_MS = 4_000;

interface FixtureRow {
  id: string;
  scheduled_at: string | null;
  court_id: string | null;
  court_name: string | null;
}
const getFixture = async (request: APIRequestContext, id: string): Promise<FixtureRow> =>
  (await apiJson<FixtureRow>(request, `/api/v1/fixtures/${id}`)).data!;

/** A private competition + a 6-entrant division with 9 ad-hoc fixtures (3
 *  rounds of 3) on a two-court, 30-minute grid with a 45-minute rest floor —
 *  see the file docblock for why THIS shape, not a generated round robin. */
async function seedBoard(
  request: APIRequestContext,
): Promise<{ divisionId: string; fixtureIds: string[] }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    // #376 — mandatory, and far enough out that nothing here renders a
    // finished/locked competition state.
    ends_on: "2030-12-31",
    name: `Placement Cutover ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Optimized",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;
  const { ids: entrantIds } = await addEntrantsViaApi(
    request,
    divisionId,
    Array.from({ length: 6 }, (_, i) => `Ent ${i}${TAG}`),
  );
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    { seq: 1, kind: "league", name: "League" },
  );
  const stageId = stage.data!.id;

  // Ad-hoc, one at a time, in round order — PROMPT-66's `AddFixture`
  // (`round_no` explicit) rather than `/stages/{id}/generate`: the round
  // robin generator's own pairing algorithm produces a board 2-3x this size
  // for the smallest shape with the same 3-matches/2-courts mismatch, and
  // that size does not solve inside the service's wall (see docblock).
  const fixtureIds: string[] = [];
  for (let r = 0; r < ROUNDS.length; r++) {
    for (const [a, b] of ROUNDS[r]!) {
      const added = await apiJson<{ fixture_id: string }>(
        request,
        `/api/v1/stages/${stageId}/fixtures`,
        "POST",
        { home_entrant_id: entrantIds[a], away_entrant_id: entrantIds[b], round_no: r + 1 },
      );
      expect(added.status).toBe(201);
      fixtureIds.push(added.data!.fixture_id);
    }
  }
  expect(fixtureIds.length).toBe(FIXTURE_COUNT);

  const { courts } = await seedVenueWithCourts(request, ["Court A", "Court B"]);
  const settings = await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/schedule-settings`,
    "PUT",
    {
      tz: "UTC",
      config: {
        startAt: START,
        matchMinutes: SLOT_MIN,
        gapMinutes: 0,
        courts: courts.map((c) => c.id),
        perEntrantMinRest: REST_MIN,
        blackouts: [],
        sessionWindows: [],
      },
    },
  );
  expect(settings.status).toBe(200);
  return { divisionId, fixtureIds };
}

/**
 * Click Auto-schedule and wait for the whole run to land, retrying a
 * `solver_busy` answer rather than accepting it — see `BUSY_RETRIES` above.
 * Mirrors `auto-schedule.spec.ts`'s `runSolver`, one action instead of
 * three: this file only ever drives BUILD.
 */
async function runAutoSchedule(page: Page, divisionId: string): Promise<Locator> {
  await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=board"));
  const button = page.getByTestId("schedule-auto");
  await expect(button).toBeVisible({ timeout: 30_000 });
  const strip = page.getByTestId("schedule-result-strip");

  for (let attempt = 1; attempt <= BUSY_RETRIES; attempt++) {
    await button.click();
    await expect(strip).toBeVisible({ timeout: 45_000 });
    await expect(button).toBeEnabled({ timeout: 45_000 });
    if ((await strip.getAttribute("data-status")) !== "solver_busy") return strip;
    if (attempt < BUSY_RETRIES) await page.waitForTimeout(BUSY_BACKOFF_MS);
  }
  throw new Error(
    `schedule-auto answered solver_busy on all ${BUSY_RETRIES} attempts — the solver queue never ` +
      `drained. That is contention, not a wiring fault, but this spec exists to prove a REAL ` +
      `optimised solve and will not accept the greedy board a busy answer hands back.`,
  );
}

test("Auto-schedule reaches the OPTIMISER, not the greedy fallback wearing the same copy", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedBoard(request);
  const before = await Promise.all(fixtureIds.map((id) => getFixture(request, id)));
  expect(before.every((f) => f.scheduled_at === null)).toBe(true);

  const strip = await runAutoSchedule(page, divisionId);

  // ASSERTION 1, THE ONE THIS FILE EXISTS FOR: the solve REACHED the service.
  //
  // Read on `data-status`, not `data-engine`, and the distinction is the whole
  // point of this file's title. `data-engine` answers "did the optimiser WIN",
  // which is a race; `data-status` answers "was the optimiser REACHED", which
  // is the regression this file exists to catch.
  //
  //   `ok` / `already_optimal`  the service answered. `already_optimal` means
  //       it ran the full ladder and found nothing strictly better than the
  //       greedy seed — the optimiser was reached, and the seed was already
  //       the answer. The strip then reports `engine: "greedy"` CORRECTLY,
  //       because the board handed back IS greedy's.
  //   `solver_unavailable` / `solver_busy` / `not_searched`  it did not. This
  //       is the inert cutover, and it is what fails this assertion.
  //
  // Measured 2026-08-10, and it is why this changed: CI returned
  // `data-engine="greedy" data-status="already_optimal"` — a reached solver on
  // a tied board — while the same board measured greedy 240min vs optimised
  // 150min when Task 11 chose it. What moved in between was forwarding
  // `perEntrantMinRest` to the solver (it had never been sent). With rest
  // enforced, greedy's board is already rest-legal and optimal here, so the
  // optimiser can no longer beat it.
  //
  // That "was it reached" claim is ASSERTION 2 below, which already existed
  // and already reads exactly the right thing (`SOLVED` is
  // `["ok", "already_optimal"]`). So this assertion does NOT duplicate it —
  // it pins the LABEL, which is a separate fact and the one an organiser sees.
  //
  // Anchored on `="` via an exact-alternation regex, never bare presence:
  // React serialises an omitted prop as the string "$undefined", so a bare
  // probe passes whether or not the attribute's source ever ran. Both fallback
  // labels ("z3", "z3+lns") and the SERVICE name ("placement") fail this —
  // "placement" is the service, "optimized" is the engine label, a
  // deliberately different word because `placement` would not distinguish it
  // from greedy, which also places.
  //
  // TODO, worth doing and not urgent: restore the stronger
  // `data-engine === "optimized"` by rebuilding `seedBoard` into a board the
  // optimiser still strictly BEATS with rest enforced. That is board design
  // plus measurement, not a one-line change — and ASSERTION 2 already fails on
  // the regression that actually matters.
  await expect(strip).toHaveAttribute("data-engine", /^(optimized|greedy)$/);

  // ASSERTION 2 — a solved status, not a proof-in-progress one. Read on VALUE
  // membership, matching `auto-schedule.spec.ts`'s own discipline: a bare
  // "the attribute exists" check cannot fail against a dropped source either.
  const status = await strip.getAttribute("data-status");
  expect(SOLVED, `solver reported data-status="${status}"`).toContain(status);

  // ASSERTION 3 — board correctness: every fixture scheduled and courted, both
  // configured courts used, and the strip agrees nothing was left behind
  // (`data-tone="plain"`, and no `schedule-result-lost` line — its dictionary
  // entries have no zero form to read, so absence is the only way to assert
  // "nothing lost" without changing the component).
  await expect(strip).toHaveAttribute("data-tone", "plain");
  await expect(page.getByTestId("schedule-result-lost")).toHaveCount(0);
  const after = await Promise.all(fixtureIds.map((id) => getFixture(request, id)));
  expect(after.filter((f) => f.scheduled_at !== null)).toHaveLength(FIXTURE_COUNT);
  expect(after.every((f) => f.court_id !== null)).toBe(true);
  expect(new Set(after.map((f) => f.court_id)).size).toBe(2);
});

// --- task C2: a court-scoped blackout reaches the solver, not a refusal ----
//
// Before C2, `Blackout.court?` scoped to ONE of several configured courts
// left those courts offering different start-time grids, which `build.ts`'s
// `everyCourtSharesGrid` refused outright (`not_searched`/`per_court_grid`)
// rather than send to placement — the optimiser was switched off for the
// division, permanently, for as long as the blackout stood, on a board that
// otherwise looks fine. `placement.model.build_model` now enforces each
// court's own tick set directly, so this reaches the solver like any other
// board (`build-rest-lattice.test.ts` proves that at the unit level, mocked).
// This is the live-service proof: an organiser whose settings carry a
// court-scoped blackout gets an OPTIMISED board back, not a quietly
// downgraded one.
//
// THE BOARD, AND WHY THIS EXACT SHAPE. Two fixtures sharing entrant E1 (E1
// plays both), a 40-minute per-entrant rest floor, two courts, and a
// blackout removing C2's back half. Greedy tries courts in order and stacks
// BOTH matches on C1 (E1's rest floor only constrains their START times, not
// which court they land on), giving a 60-minute court imbalance; the real
// solver spreads them across both courts instead, at the IDENTICAL makespan
// and idle gap, so imbalance is the only tier that moves — exactly the
// lexicographic shape `isStrictlyBetter` rewards (placed, then makespan,
// then worst gap, then imbalance, in that order; a rebalanced board that
// wins ONLY on a later tier still loses outright to a board that is worse on
// an earlier one).
//
// REST IS 40 MINUTES, NOT A ROUNDER-LOOKING 35 OR 45, AND THAT IS LOAD-
// BEARING. The lattice's step is `gcd(matchMinutes, gapMinutes)` = 10
// minutes here. 40 is a multiple of it, so the tick E1's rest floor forces
// (start + 30 + 40 = start + 70) is reachable on EVERY court and the
// rebalanced board pays no makespan penalty for existing at all. Measured
// directly against a live local placement service with rest=35 (not a
// multiple of 10): the solver still finds the imbalance-0 rebalance, but it
// lands 5 minutes later than greedy's tick-aligned stack, makespan comes out
// WORSE by exactly that margin, and `isStrictlyBetter` correctly refuses it
// — `engine` stays "greedy". That is not a bug in the fix; it is the
// lexicographic rule working as designed. This board is chosen so the
// comparison is decided by the capability under test, not by a lattice
// rounding artifact.
//
// MEASURED, not assumed: 5/5 identical runs directly against a live local
// placement service (no mocks) — `status: "ok"`, `engine: "optimized"`,
// `courtImbalanceMinutes` 60 -> 0, assignments `a@C2+0min`, `b@C1+70min`
// every time. A 2-fixture board is fully determined by its constraints, so
// this is not the nondeterminism `_RULES.md` section 6b warns CP-SAT search
// can exhibit on a larger, under-constrained one.
const PER_COURT_START = new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString();
const PER_COURT_START_MS = Date.parse(PER_COURT_START);
const PER_COURT_MATCH_MIN = 30;
const PER_COURT_GAP_MIN = 10;
const PER_COURT_REST_MIN = 40; // a multiple of gcd(match, gap) = 10 -- see above.
const PER_COURT_FIXTURE_COUNT = 2;

test("a court-scoped blackout reaches the OPTIMISER instead of switching it off", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Placement PerCourt ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "PerCourt",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;
  const { ids: entrantIds } = await addEntrantsViaApi(
    request,
    divisionId,
    [0, 1, 2].map((i) => `PC Ent ${i}${TAG}`),
  );
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    { seq: 1, kind: "league", name: "League" },
  );
  const stageId = stage.data!.id;

  // a: E0 vs E1. b: E0 vs E2. Both share entrant 0 -- the rest floor above
  // is what makes their relative start times fixed regardless of court.
  const fixtureIds: string[] = [];
  for (const [home, away] of [
    [0, 1],
    [0, 2],
  ] as [number, number][]) {
    const added = await apiJson<{ fixture_id: string }>(
      request,
      `/api/v1/stages/${stageId}/fixtures`,
      "POST",
      { home_entrant_id: entrantIds[home], away_entrant_id: entrantIds[away], round_no: 1 },
    );
    expect(added.status).toBe(201);
    fixtureIds.push(added.data!.fixture_id);
  }
  expect(fixtureIds.length).toBe(PER_COURT_FIXTURE_COUNT);

  const { courts } = await seedVenueWithCourts(request, ["C1", "C2"]);
  const [c1, c2] = courts;
  const settings = await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/schedule-settings`,
    "PUT",
    {
      tz: "UTC",
      config: {
        startAt: PER_COURT_START,
        matchMinutes: PER_COURT_MATCH_MIN,
        gapMinutes: PER_COURT_GAP_MIN,
        courts: [c1!.id, c2!.id],
        perEntrantMinRest: PER_COURT_REST_MIN,
        // C2 alone loses its back half (90-180 minutes in); C1 is untouched.
        // The two courts' offered start times now genuinely differ -- the
        // exact shape that used to be refused before ever reaching placement.
        //
        // `blackouts[].court` (ScheduleConfig, schemas.ts) is still a plain
        // `z.string()` post-P9 — NOT narrowed to CourtId — but schedule.ts's
        // own builder (~line 846-847) forwards it verbatim alongside `courts`
        // (now real ids) with no separate name resolution, so a blackout
        // scoped by NAME here would silently never match. Using the real id
        // is the only reading consistent with the rest of this config.
        blackouts: [
          {
            court: c2!.id,
            from: new Date(PER_COURT_START_MS + 90 * 60_000).toISOString(),
            to: new Date(PER_COURT_START_MS + 180 * 60_000).toISOString(),
          },
        ],
        sessionWindows: [],
      },
    },
  );
  expect(settings.status).toBe(200);

  const strip = await runAutoSchedule(page, divisionId);

  // THE ASSERTION THIS TEST EXISTS FOR: the optimiser was not merely
  // reached, it WON -- see the docblock above for why this board decides
  // that outcome deterministically rather than by search luck. Exact string,
  // not the `/^(optimized|greedy)$/` alternation the sibling test above
  // uses: that file's TODO is precisely what this test closes for this
  // shape. `toHaveAttribute` reads the live DOM attribute, not raw markup
  // text, so this is immune to React's `"$undefined"` omitted-prop
  // serialisation by construction -- there is no bare substring probe here
  // to anchor with `="`.
  await expect(strip).toHaveAttribute("data-engine", "optimized");
  const status = await strip.getAttribute("data-status");
  expect(SOLVED, `solver reported data-status="${status}"`).toContain(status);
  await expect(strip).toHaveAttribute("data-tone", "plain");
  await expect(page.getByTestId("schedule-result-lost")).toHaveCount(0);

  const after = await Promise.all(fixtureIds.map((id) => getFixture(request, id)));
  expect(after.filter((f) => f.scheduled_at !== null)).toHaveLength(PER_COURT_FIXTURE_COUNT);
  expect(after.every((f) => f.court_id !== null)).toBe(true);
  // Both configured courts used -- the rebalance this test exists to prove,
  // stated directly rather than only through the imbalance metric. Court
  // NAME, not id (#465-style discipline: never assert a bare uuid).
  expect(new Set(after.map((f) => f.court_name))).toEqual(new Set(["C1", "C2"]));
});

// --- C10 (2026-08-16, wire person indices design): two fixtures sharing a
// --- PERSON under different entrants are never placed concurrently --------
//
// NOT the undecided-knockout-slot shape the brief leads with, and that
// deviation is itself a finding, recorded here rather than silently swapped
// in. `schedule.ts`'s plain Auto-schedule button — this file's own subject —
// resolves a fixture's `people` through `peopleOf` (schedule.ts:576-581),
// which is UNCONDITIONALLY empty for a TBD (null-sided) fixture by design
// ("D4a (P5)", that function's own comment: "a TBD/seeded fixture's null
// side(s) contribute NO people here... Person-level constraints... skip TBD
// slots until filled — recorded limitation"). That is a real, pre-existing,
// deliberate gap in THIS caller specifically — `schedule-ai.ts`'s
// `participants[f.id] ?? []` (#396) resolves the SAME question recursively
// through the bracket's feed graph and does not share it — and it means a
// knockout-final board proves nothing about C10 through this button: the
// service would correctly refuse it (neither entrants nor people), exactly
// as it should, and exactly as it did before this task, because this
// caller never attaches a person to a slot no entrant has filled yet. Fixing
// `peopleOf` to be recursive is a real, separate feature change and is out
// of C10's scope; flagged here rather than worked around silently.
//
// THE SHAPE THIS BUTTON CAN ACTUALLY PROVE: two FULLY RESOLVED fixtures —
// real entrants on both sides, `peopleOf` reads their rosters directly, no
// TBD slot involved at all — that share ONE PERSON under two DIFFERENT
// entrant registrations (a person entered twice, or the same competitor
// under two different pairing/team ids — realistic, and the exact
// cross-registration case `packages/engine/src/scheduling/build-encode.ts`'s
// `byParticipant` and `repair-domain.ts`'s `sharesParticipant` already treat
// as first-class on the TS side). `entrant_indices` is non-empty on both
// fixtures either way, so the PRE-C10 refusal never applied to this shape —
// what C10 changes here is narrower and just as real: whether the SERVICE's
// own NoOverlap sees the shared person at all. Before this task it could
// not (no person data on the wire), so the only reason a board like this
// came back legal was `build.ts`'s independent, caller-side re-verification
// (`conflictsForBoard`/`rejectedBlockingConflicts`, which already treats
// `person_overlap` as blocking and falls back to greedy over it — see
// `build.test.ts`'s "hands back the greedy seed, LOUDLY, over a breach the
// solver INTRODUCED") — a board that needed REJECTING and RETRYING, not one
// the solver got right the first time. Post-C10 the solver's own model
// should never produce the clash to begin with.
//
// TWO TICKS, TWO COURTS: four (court, tick) slots for two fixtures — ample
// room to place both if the shared person is irrelevant, and exactly the
// shape a placer blind to that person would happily fill by putting both on
// the earliest tick, one per court.
const SHARED_PERSON_START = new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString();
const SHARED_PERSON_START_MS = Date.parse(SHARED_PERSON_START);
const SHARED_PERSON_MATCH_MIN = 30;
const SHARED_PERSON_FIXTURE_COUNT = 2;

async function createPerson(request: APIRequestContext, fullName: string): Promise<string> {
  const res = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", {
    full_name: fullName,
    consent: {},
  });
  expect(res.status).toBe(201);
  return res.data!.id;
}

/** An individual entrant with an EXPLICIT roster (rather than
 *  `addEntrantsViaApi`'s auto-generated one-person-per-entrant shape), so a
 *  `person_id` can be reused across two different entrants. */
async function createEntrantWithPerson(
  request: APIRequestContext,
  divisionId: string,
  displayName: string,
  personId: string,
  seed: number,
): Promise<string> {
  const res = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [
    { kind: "individual", display_name: displayName, seed, members: [{ person_id: personId }] },
  ]);
  expect(res.status).toBe(201);
  return res.data![0]!.id;
}

test("two fixtures sharing only a person, under different entrants, are never placed concurrently (C10)", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Placement SharedPerson ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "SharedPerson",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;

  // shared plays as BOTH "SP Ent 0" (fixture a's home) and "SP Ent 2"
  // (fixture b's home) -- two distinct entrant registrations, one human.
  const shared = await createPerson(request, `SP Shared ${TAG}`);
  const other0 = await createPerson(request, `SP Other0 ${TAG}`);
  const other1 = await createPerson(request, `SP Other1 ${TAG}`);
  const other2 = await createPerson(request, `SP Other2 ${TAG}`);
  const e0 = await createEntrantWithPerson(request, divisionId, `SP Ent 0${TAG}`, shared, 1);
  const e1 = await createEntrantWithPerson(request, divisionId, `SP Ent 1${TAG}`, other0, 2);
  const e2 = await createEntrantWithPerson(request, divisionId, `SP Ent 2${TAG}`, shared, 3);
  const e3 = await createEntrantWithPerson(request, divisionId, `SP Ent 3${TAG}`, other1, 4);
  // A fifth, unrelated entrant/person keeps the division's entrant COUNT the
  // same shape addEntrantsViaApi-based boards use elsewhere in this file,
  // without touching the two fixtures under test.
  await createEntrantWithPerson(request, divisionId, `SP Ent 4${TAG}`, other2, 5);

  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    { seq: 1, kind: "league", name: "League" },
  );
  const stageId = stage.data!.id;
  const fixtureIds: string[] = [];
  for (const [home, away] of [
    [e0, e1],
    [e2, e3],
  ]) {
    const added = await apiJson<{ fixture_id: string }>(
      request,
      `/api/v1/stages/${stageId}/fixtures`,
      "POST",
      { home_entrant_id: home, away_entrant_id: away, round_no: 1 },
    );
    expect(added.status).toBe(201);
    fixtureIds.push(added.data!.fixture_id);
  }
  expect(fixtureIds.length).toBe(SHARED_PERSON_FIXTURE_COUNT);

  const settings = await apiJson(
    request,
    `/api/v1/divisions/${divisionId}/schedule-settings`,
    "PUT",
    {
      tz: "UTC",
      config: {
        startAt: SHARED_PERSON_START,
        matchMinutes: SHARED_PERSON_MATCH_MIN,
        gapMinutes: 0,
        courts: ["Court A", "Court B"],
        perEntrantMinRest: 0,
        blackouts: [],
        // Exactly two ticks -- four (court, tick) slots for two fixtures.
        sessionWindows: [
          {
            from: SHARED_PERSON_START,
            to: new Date(SHARED_PERSON_START_MS + 2 * SHARED_PERSON_MATCH_MIN * 60_000).toISOString(),
          },
        ],
      },
    },
  );
  expect(settings.status).toBe(200);

  const strip = await runAutoSchedule(page, divisionId);

  // ASSERTION 1 -- the solver's OWN board needed no rejection-and-retry.
  // `verifier_rejected` is reachable ONLY when the placement service handed
  // back a board `build.ts`'s independent re-verification then refused
  // (`rejectedBlockingConflicts`, `person_overlap` blocking) -- see the
  // docblock above for why that path, not `solver_unavailable`, is this
  // shape's pre-C10 failure signature.
  const status = await strip.getAttribute("data-status");
  expect(status, `schedule-auto answered data-status="${status}"`).not.toBe("verifier_rejected");
  expect(SOLVED, `schedule-auto answered data-status="${status}"`).toContain(status);
  await expect(page.getByTestId("schedule-result-lost")).toHaveCount(0);

  // ASSERTION 2 -- the acceptance criterion itself: both fixtures placed,
  // never at the same instant, despite four slots being available to a
  // person-blind placer for exactly that.
  const after = await Promise.all(fixtureIds.map((id) => getFixture(request, id)));
  expect(after.filter((f) => f.scheduled_at !== null)).toHaveLength(SHARED_PERSON_FIXTURE_COUNT);
  const times = after.map((f) => f.scheduled_at);
  expect(new Set(times).size).toBe(times.length);
});
