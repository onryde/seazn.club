import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { TAG, apiJson, addEntrantsViaApi, divisionPath } from "./helpers";

// Task 11 (placement cutover) — proves the ONE thing `z3-auto-schedule.spec.ts`
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
// then court imbalance, lexicographic). Every one of `z3-auto-schedule.spec.ts`'s
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
// `z3-auto-schedule.spec.ts`. `data-engine` is the ONE thing this file exists
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
 *  `z3-auto-schedule.spec.ts`'s `SOLVED`, duplicated rather than imported: that
 *  file is Prompt 10's, not shared module surface, and its own comment says
 *  this list is deliberately closed and does not grow. */
const SOLVED = ["ok", "already_optimal"];

/** `solver_busy` is a live, ordinary status under `PLACEMENT_MAX_WORKERS=1` —
 *  not a fault, and not accepted here either: accepting it would let this file
 *  pass against a solve that never ran, the one thing it exists to catch. Same
 *  bounded retry as `z3-auto-schedule.spec.ts`'s `runSolver`. */
const BUSY_RETRIES = 3;
const BUSY_BACKOFF_MS = 4_000;

interface FixtureRow {
  id: string;
  scheduled_at: string | null;
  court_label: string | null;
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
        courts: ["Court A", "Court B"],
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
 * Mirrors `z3-auto-schedule.spec.ts`'s `runSolver`, one action instead of
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
  // membership, matching `z3-auto-schedule.spec.ts`'s own discipline: a bare
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
  expect(after.every((f) => f.court_label !== null)).toBe(true);
  expect(new Set(after.map((f) => f.court_label)).size).toBe(2);
});
