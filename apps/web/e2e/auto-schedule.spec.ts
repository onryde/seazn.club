import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  TAG,
  apiJson,
  addEntrantsViaApi,
  createStageAndGenerate,
  divisionPath,
  seedVenueWithCourts,
} from "./helpers";

// T15 — the three solver actions on the schedule board, driven through the
// UI against the real engine. (Named `z3-auto-schedule.spec.ts` until the z3
// retirement's stage C; the actions are the same three, the solver behind them
// is CP-SAT.)
//
// WHY THIS EXISTS AND WHAT ONLY IT CAN SEE. `schedule-board.spec.ts` already
// exercises `/schedule/auto` over HTTP, so the endpoint is covered. What nothing
// else covers is the loop an organiser actually performs: the button posts, the
// proposal comes back, `useBoardActions` APPLIES it, and the result strip
// reports what the solver did. Three things can only fail here —
//
//   1. the solver not being reachable from a production-shaped server — z3's
//      WASM shipped as a silent prod no-op that way once, with every unit test
//      green, and an unset `PLACEMENT_SERVICE_HOST` fails the same shape;
//   2. a button wired to the wrong solver — all three render identically and
//      differ only in the body they send;
//   3. the strip reporting a run that did not happen, or not reporting one that
//      did. `lastRun` is client state set between the auto POST and the apply
//      POST; nothing server-side has an opinion about it.
//
// SELECTORS ARE IDS, NEVER COPY (#465). `board.polish` renders "Improve
// times", not "Polish", and every label here is translated, so a text selector
// stops meaning the same thing in any locale but English. (`board.autoSchedule`
// interpolated the division name until the toolbar redesign moved the stage out
// of the label and into its own selector; ids were already the contract.) Text
// is asserted in exactly one place below, deliberately, where the assertion IS
// about the copy.
//
// Each test seeds its own competition/division/stage, so the file needs no
// serial mode and no shared fixture: the result strip is per-page client state,
// which means every strip assertion has to live in the same test as the click
// that produced it anyway.

/** A Wednesday well inside the seeded competition's window. */
const START = new Date(Date.UTC(2026, 8, 21, 9, 0)).toISOString();
/** 30-minute matches, no turnaround — the grid every board below sits on. */
const SLOT_MIN = 30;
const slotAt = (n: number) =>
  new Date(Date.parse(START) + n * SLOT_MIN * 60_000).toISOString();

/**
 * The two statuses a working build/reflow can return.
 *
 * `z3_unavailable`, `verifier_rejected` and `solver_busy` are deliberately NOT
 * accepted. All three are graceful degradations the product is right to render,
 * and all three mean the solver did not do the thing this spec exists to prove —
 * a run that quietly fell back to the greedy pass would otherwise pass every
 * assertion here. This list is the whole of the file's teeth; it does not grow.
 */
const SOLVED = ["ok", "already_optimal"];

/**
 * `solver_busy` is a LIVE status, and this file stays honest about it by
 * RETRYING rather than by accepting it.
 *
 * The comment here used to say `buildSchedule` waits on the z3 lock. That has
 * not been true since the queue cap landed: it now answers `solver_busy`
 * immediately — with a greedy board, without taking the lock — once two builds
 * are already in flight. That is reachable in this suite exactly as it stands.
 * The project is `fullyParallel` at four workers, the Auto-schedule and
 * Improve-times tests are both on the build path, and under `test:e2e:all` the
 * two mobile projects each fire one more.
 *
 * Adding `solver_busy` to `SOLVED` would be the cheap fix and the wrong one: the
 * file would then pass against a solver that never ran, which is the single
 * thing it exists to catch. The refusal is transient by construction — the cap
 * clears the moment the runs ahead of it finish, and the strip's own copy for
 * this status is "Try again for a better board" — so a bounded re-click is the
 * honest response. What is asserted at the end is unchanged: a real solve.
 */
const BUSY_RETRIES = 3;
const BUSY_BACKOFF_MS = 4_000;

interface FixtureRow {
  id: string;
  scheduled_at: string | null;
  court_id: string | null;
  schedule_locked?: boolean;
}
const getFixture = async (request: APIRequestContext, id: string): Promise<FixtureRow> =>
  (await apiJson<FixtureRow>(request, `/api/v1/fixtures/${id}`)).data!;

/** `${scheduled_at}@${court_id}` — the whole slot as one comparable value, so
 *  a card that kept its time but changed court still reads as moved. */
const slotKey = (f: FixtureRow) => `${f.scheduled_at ?? "-"}@${f.court_id ?? "-"}`;

/** A private competition + a 4-entrant round-robin division (6 fixtures) on a
 *  two-court, 30-minute grid. Own everything: nothing here is shared state. */
async function seedBoard(
  request: APIRequestContext,
  label: string,
): Promise<{
  divisionId: string;
  stageId: string;
  fixtureIds: string[];
  courts: { id: string; name: string }[];
}> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    // #376 — mandatory, and far enough out that nothing here renders a
    // finished/locked competition state.
    ends_on: "2030-12-31",
    name: `Z3 ${label} ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: label,
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["Ash", "Brook", "Clay", "Dune"]);
  const { stageId, fixtureIds } = await createStageAndGenerate(request, divisionId);
  // A 4-entrant round robin is 6 matches over 3 rounds of 2 — so a 2-court grid
  // has an exact 3-slot optimum, which is what makes the polish test's
  // improvement forced rather than merely likely.
  expect(fixtureIds.length).toBe(6);

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
        // 0, not a rest floor: a rest shortfall is a WARN, and a board carrying
        // warnings would let "the solver produced nothing useful" and "the
        // solver produced a legal board" look the same in the strip's tone.
        perEntrantMinRest: 0,
        blackouts: [],
        sessionWindows: [],
      },
    },
  );
  expect(settings.status).toBe(200);
  return { divisionId, stageId, fixtureIds, courts };
}

/**
 * Click one solver action and wait for the WHOLE run to land.
 *
 * Two waits, and both are load-bearing. The strip appears as soon as the auto
 * POST returns — BEFORE the apply POST that persists anything — so a test that
 * read the database at that point would be racing the write. `autoRun` clears
 * `busy` in its `finally`, i.e. after apply and after `router.refresh()`, so the
 * button becoming enabled again is the only signal that the round trip is
 * complete. Neither wait asserts on copy.
 *
 * A `solver_busy` answer is RE-CLICKED rather than accepted — see `BUSY_RETRIES`
 * for why that is the version of this that keeps the file's teeth. The status is
 * read only after the button is enabled again, so a locator that momentarily
 * matched the previous attempt's strip cannot be the one that answers: `autoRun`
 * clears `lastRun` before it posts, and a locator resolves at read time.
 */
/** Every solver action confirms before it runs (2026-09-17) — this maps each
 *  button's testid to its confirm dialog's, same ids the Cancel/Continue
 *  pair below drives by hand for the locked-fixture case. */
const CONFIRM_TESTID: Record<string, string> = {
  "schedule-auto": "schedule-rebuild",
  "schedule-reflow": "schedule-reflow-confirm",
  "schedule-polish": "schedule-polish-confirm",
};

async function runSolver(page: Page, divisionId: string, testid: string): Promise<Locator> {
  await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=board"));
  const button = page.getByTestId(testid);
  await expect(button).toBeVisible({ timeout: 30_000 });
  const strip = page.getByTestId("schedule-result-strip");
  const confirmButton = page.getByTestId(`${CONFIRM_TESTID[testid]}-confirm`);

  for (let attempt = 1; attempt <= BUSY_RETRIES; attempt++) {
    await button.click();
    await confirmButton.click();
    await expect(strip).toBeVisible({ timeout: 45_000 });
    await expect(button).toBeEnabled({ timeout: 45_000 });
    if ((await strip.getAttribute("data-status")) !== "solver_busy") return strip;
    // Somebody else's build holds the queue. Give it room to drain rather than
    // hammering the cap this test is itself contributing to.
    if (attempt < BUSY_RETRIES) await page.waitForTimeout(BUSY_BACKOFF_MS);
  }
  throw new Error(
    `${testid} answered solver_busy on all ${BUSY_RETRIES} attempts — the solver queue never ` +
      `drained. That is contention rather than a wiring fault, and the greedy board it handed ` +
      `back is a valid board, but this spec exists to prove a REAL solve and will not accept one.`,
  );
}

/**
 * The strip's own report, asserted on VALUES rather than on presence.
 *
 * A bare "the attribute is there" probe is vacuous on this surface: React
 * serialises an omitted prop as the string `"$undefined"`, so an attribute that
 * lost its source still reads as present. Every read below is compared against
 * an explicit expected value or membership list, which `"$undefined"` and `null`
 * both fail.
 */
async function expectSolvedStrip(strip: Locator, opts: { tone: string }): Promise<void> {
  const status = await strip.getAttribute("data-status");
  expect(SOLVED, `solver reported data-status="${status}"`).toContain(status);
  await expect(strip).toHaveAttribute("data-tone", opts.tone);
}

test("Auto-schedule places an empty board and the strip reports the run", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedBoard(request, "Build");
  // Nothing is scheduled yet — this is the fresh-board case the button is for.
  const before = await Promise.all(fixtureIds.map((id) => getFixture(request, id)));
  expect(before.every((f) => f.scheduled_at === null)).toBe(true);

  const strip = await runSolver(page, divisionId, "schedule-auto");

  // COVER 1 — a complete board, and the strip agrees it is complete. `plain`
  // rather than `flag`: the tone flips to amber the moment anything is dropped,
  // so asserting the exact value pins "nothing was left behind" as well.
  await expectSolvedStrip(strip, { tone: "plain" });
  const after = await Promise.all(fixtureIds.map((id) => getFixture(request, id)));
  expect(after.filter((f) => f.scheduled_at !== null)).toHaveLength(6);
  expect(after.every((f) => f.court_id !== null)).toBe(true);
  // Two courts exist and a 6-match round robin cannot fit on one inside this
  // grid without doubling the makespan — a board that used a single court is a
  // solver that ignored its own configuration.
  expect(new Set(after.map((f) => f.court_id)).size).toBe(2);

  // COVER 2 — the strip carries THIS run's telemetry, not a placeholder.
  const headline = page.getByTestId("schedule-result-headline");
  await expect(headline).toBeVisible();
  expect(((await headline.textContent()) ?? "").trim().length).toBeGreaterThan(0);

  // The one deliberate copy assertion in this file. `board.result.provenance`
  // renders "<engine> · <elapsed> · <churn>", and the engine name is the only
  // thing on screen that says which solver produced the board — "Quick pass"
  // is the greedy fallback and "Solver" is the placement service, deliberately
  // neutral copy rather than naming a solver at the organiser.
  //
  // Two engine values behind two labels since C7 retired the z3-era ones. The
  // alternation carried a third, "Solver, then refined", for a value nothing
  // could render any more: a dead branch, and one this regex would have kept
  // accepting silently. What this assertion makes visible is optimised vs
  // greedy; asserting the cutover specifically is `placement-cutover.spec.ts`'s
  // job, against `data-engine` itself rather than this rendered string.
  await expect(page.getByTestId("schedule-result-provenance")).toHaveText(
    /^(Quick pass|Solver) · /,
  );

  // COVER 5 — `schedule-result-lost` on a board that dropped nothing.
  //
  // DEVIATION FROM THE BRIEF, and it is a fact about the component rather than a
  // choice: the line is rendered under `lost > 0` (result-strip.tsx), and its
  // dictionary entries are "One match lost the slot it had." / "{count} matches
  // lost the slots they had." — there is no zero form to read. Asserting it
  // "reads zero" is not implementable without changing the component, which is
  // out of scope here. The absence is therefore asserted directly, and anchored
  // on the strip being present so it cannot be satisfied by the page having gone
  // away: the strip is here, it reports a solved board, and it is saying nothing
  // about lost slots. A future non-zero still shows up as this assertion failing.
  await expect(strip).toBeVisible();
  await expect(page.getByTestId("schedule-result-lost")).toHaveCount(0);
});

test("Re-flow places the unscheduled cards and leaves a pinned one alone", async ({
  page,
  request,
}) => {
  const { divisionId, stageId, fixtureIds } = await seedBoard(request, "Reflow");

  // Build a full board over the API first — the UI click under test is the
  // RE-FLOW, so the starting board must not come from one.
  const auto = await apiJson<{
    assignments: { fixture_id: string; scheduled_at: string; court_id: string }[];
  }>(request, `/api/v1/stages/${stageId}/schedule/auto`, "POST", { only_unlocked: false });
  expect(auto.status).toBe(200);
  const applied = await apiJson<{ applied: number }>(
    request,
    `/api/v1/stages/${stageId}/schedule/apply`,
    "POST",
    { assignments: auto.data!.assignments, source: "auto" },
  );
  expect(applied.data!.applied).toBe(6);

  const pinnedId = fixtureIds[0]!;
  expect((await apiJson(request, `/api/v1/fixtures/${pinnedId}`, "PATCH", {
    schedule_locked: true,
  })).status).toBe(200);
  const pinnedBefore = await getFixture(request, pinnedId);
  expect(pinnedBefore.scheduled_at).not.toBeNull();

  // Empty every UNLOCKED slot. This is what makes the test non-vacuous: a
  // re-flow that did nothing at all leaves five cards with no time, which is
  // visible, whereas over an already-legal board the repair solver is entitled
  // to return `clean` and move nothing — and "the pinned card stayed" would then
  // pass on a button that was never wired up.
  const cleared = await apiJson(request, "/api/v1/schedule/clear", "POST", {
    division_id: divisionId,
    scope: { excludeLocked: true },
    confirm: true,
  });
  expect(cleared.status).toBe(200);
  const others = fixtureIds.filter((id) => id !== pinnedId);
  const emptied = await Promise.all(others.map((id) => getFixture(request, id)));
  expect(emptied.every((f) => f.scheduled_at === null)).toBe(true);

  const strip = await runSolver(page, divisionId, "schedule-reflow");
  await expectSolvedStrip(strip, { tone: "plain" });

  // The pinned card kept its EXACT slot — time and court both, since a card
  // moved across courts at the same minute is still a card the organiser was
  // told the wrong thing about.
  const pinnedAfter = await getFixture(request, pinnedId);
  expect(slotKey(pinnedAfter)).toBe(slotKey(pinnedBefore));
  expect(pinnedAfter.schedule_locked).toBe(true);

  // …and the other half: the run demonstrably did something.
  const refilled = await Promise.all(others.map((id) => getFixture(request, id)));
  expect(refilled.filter((f) => f.scheduled_at !== null).length).toBeGreaterThanOrEqual(1);
  expect(refilled.every((f) => f.scheduled_at !== null && f.court_id !== null)).toBe(true);
});

test("Improve times compacts the board without moving a locked card", async ({ page, request }) => {
  const { divisionId, stageId, fixtureIds, courts } = await seedBoard(request, "Polish");

  // A deliberately POOR but entirely LEGAL board: all six matches strung down
  // Court A in consecutive 30-minute slots, Court B untouched. Polish runs the
  // tier solver over a board that is already valid, so the board has to be
  // improvable or the test proves nothing — here the makespan is 3 hours where
  // the two-court optimum is 90 minutes, and the court spread is the whole
  // board, so the very first tier has somewhere to go. `perEntrantMinRest: 0`
  // is what keeps back-to-back matches for one entrant legal.
  const board = fixtureIds.map((id, i) => ({
    fixture_id: id,
    scheduled_at: slotAt(i),
    court_id: courts[0]!.id,
  }));
  const applied = await apiJson<{ applied: number }>(
    request,
    `/api/v1/stages/${stageId}/schedule/apply`,
    "POST",
    { assignments: board, source: "manual" },
  );
  expect(applied.status).toBe(200);
  expect(applied.data!.applied).toBe(6);

  // Lock the FIRST slot. At 09:00 on the board's own start it constrains
  // neither the makespan floor nor the court balance, so a solver that honours
  // it can still reach the optimum — an unmoved locked card here is a freeze
  // being respected, not a solver that had no room to move anything.
  const lockedId = fixtureIds[0]!;
  expect((await apiJson(request, `/api/v1/fixtures/${lockedId}`, "PATCH", {
    schedule_locked: true,
  })).status).toBe(200);

  const before = new Map<string, string>();
  for (const id of fixtureIds) before.set(id, slotKey(await getFixture(request, id)));

  const strip = await runSolver(page, divisionId, "schedule-polish");
  await expectSolvedStrip(strip, { tone: "plain" });

  const lockedAfter = await getFixture(request, lockedId);
  expect(slotKey(lockedAfter)).toBe(before.get(lockedId));
  expect(lockedAfter.schedule_locked).toBe(true);

  // The second half, without which "the locked card stayed" is satisfied by a
  // button that does nothing: at least one unlocked card must have taken a
  // different slot.
  const moved: string[] = [];
  for (const id of fixtureIds) {
    if (id === lockedId) continue;
    if (slotKey(await getFixture(request, id)) !== before.get(id)) moved.push(id);
  }
  expect(moved.length, "polish left every unlocked card exactly where it was").toBeGreaterThanOrEqual(1);
});

/**
 * #pins-ui — the pre-run confirm gate on BUILD. Server-side, a lock is now
 * honoured on every mode (#pins-in-build); this is the client half: the
 * organiser has to be TOLD before a rebuild that their pins will hold, with a
 * way to back out, rather than discovering it after the fact in the result
 * strip. REFLOW and POLISH already honoured a lock before that change and get
 * no dialog — only BUILD's behaviour is new enough here to need one.
 */
test.describe("Auto-schedule confirm gate (#pins-ui)", () => {
  /** Build a full 6-fixture board over the API, then lock one already-placed
   *  fixture — the click under test is a SECOND Auto-schedule, over a board
   *  that already has a pin on it. */
  async function seedLockedBoard(request: APIRequestContext, label: string) {
    const { divisionId, stageId, fixtureIds } = await seedBoard(request, label);
    const auto = await apiJson<{
      assignments: { fixture_id: string; scheduled_at: string; court_id: string }[];
    }>(request, `/api/v1/stages/${stageId}/schedule/auto`, "POST", { only_unlocked: false });
    expect(auto.status).toBe(200);
    const applied = await apiJson<{ applied: number }>(
      request,
      `/api/v1/stages/${stageId}/schedule/apply`,
      "POST",
      { assignments: auto.data!.assignments, source: "auto" },
    );
    expect(applied.data!.applied).toBe(6);

    const lockedId = fixtureIds[0]!;
    expect(
      (await apiJson(request, `/api/v1/fixtures/${lockedId}`, "PATCH", { schedule_locked: true }))
        .status,
    ).toBe(200);
    const lockedBefore = await getFixture(request, lockedId);
    expect(lockedBefore.scheduled_at).not.toBeNull();
    return { divisionId, fixtureIds, lockedId, lockedBefore };
  }

  test("Cancel leaves the dialog gone and the board completely untouched", async ({
    page,
    request,
  }) => {
    const { divisionId, fixtureIds, lockedId } = await seedLockedBoard(request, "GateCancel");
    const before = new Map<string, string>();
    for (const id of fixtureIds) before.set(id, slotKey(await getFixture(request, id)));

    await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=board"));
    const autoButton = page.getByTestId("schedule-auto");
    await expect(autoButton).toBeVisible({ timeout: 30_000 });

    await autoButton.click();
    const dialog = page.getByTestId("schedule-rebuild");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    // The count in the dialog body names exactly the one locked fixture —
    // wrong copy here would say "2 locked matches" on a board with one pin.
    await expect(dialog).toContainText("1 locked match stays exactly where it is");

    await page.getByTestId("schedule-rebuild-cancel").click();
    await expect(dialog).toBeHidden();
    // No run fired at all: no strip, and nothing on the server moved.
    await expect(page.getByTestId("schedule-result-strip")).toHaveCount(0);
    for (const id of fixtureIds) {
      expect(slotKey(await getFixture(request, id))).toBe(before.get(id));
    }
    expect((await getFixture(request, lockedId)).schedule_locked).toBe(true);
  });

  test("lock -> Auto-schedule -> dialog -> Continue -> the locked fixture is unmoved", async ({
    page,
    request,
  }) => {
    const { divisionId, lockedId, lockedBefore } = await seedLockedBoard(request, "GateContinue");

    await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=board"));
    const autoButton = page.getByTestId("schedule-auto");
    await expect(autoButton).toBeVisible({ timeout: 30_000 });

    // THE DIALOG — clicking Auto-schedule over a board with a locked fixture
    // must NOT run immediately.
    await autoButton.click();
    const dialog = page.getByTestId("schedule-rebuild");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    // Proof the click did not already fire the run: no strip yet, button still
    // reads as the un-clicked state (re-enabled — it was never disabled).
    await expect(page.getByTestId("schedule-result-strip")).toHaveCount(0);
    await expect(autoButton).toBeEnabled();

    await page.getByTestId("schedule-rebuild-confirm").click();

    const strip = page.getByTestId("schedule-result-strip");
    await expect(strip).toBeVisible({ timeout: 45_000 });
    await expect(autoButton).toBeEnabled({ timeout: 45_000 });
    const status = await strip.getAttribute("data-status");
    expect(SOLVED, `solver reported data-status="${status}"`).toContain(status);
    // The strip says at least one fixture was kept locked — the report half
    // of #pins-ui, on the very run the dialog just gated.
    await expect(page.getByTestId("schedule-result-locked-kept")).toBeVisible();

    // …and the fixture itself kept its EXACT slot, time and court both.
    const lockedAfter = await getFixture(request, lockedId);
    expect(slotKey(lockedAfter)).toBe(slotKey(lockedBefore));
    expect(lockedAfter.schedule_locked).toBe(true);
  });
});

/**
 * The toolbar's shape on a MULTI-STAGE division (toolbar redesign, direction A).
 *
 * Every test above seeds one stage, so all of them would keep passing if the
 * toolbar went back to rendering a solver triplet per stage — and that is
 * precisely the regression this describes. Two things can only fail here:
 *
 *   1. the row growing with the format again. A second `schedule-auto` in the
 *      DOM is not merely untidy: `runSolver` above and every `getByTestId`
 *      elsewhere resolve under Playwright's strict mode, so the duplicate turns
 *      those clicks into strict-mode violations rather than clicks.
 *   2. the selector rendering correctly while the actions stay aimed at stage
 *      one. That is invisible to any render assertion — the wrong stage
 *      rebuilds, reports `ok`, and looks like a successful run.
 *
 * The aim is proved by CONSEQUENCE, not by a request body: the league's
 * fixtures are read back after a build that was aimed at the playoff stage, and
 * they have to still be unscheduled.
 */
test("the toolbar renders one action set, aimed at the picked stage", async ({ page, request }) => {
  const { divisionId, fixtureIds } = await seedBoard(request, "two-stage");

  // A second stage over the same entrants. `createStageAndGenerate` hard-codes
  // seq 1, so this one is posted directly.
  const second = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    { seq: 2, kind: "league", name: "Playoffs" },
  );
  expect(second.status, "second stage created").toBeLessThan(300);
  const secondGen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${second.data!.id}/generate`,
    "POST",
  );
  expect(secondGen.status, "second stage generated").toBeLessThan(300);

  await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=board"));

  // ONE of each action, whatever the stage count.
  for (const id of ["schedule-auto", "schedule-reflow", "schedule-polish"]) {
    await expect(page.getByTestId(id), `${id} is rendered once`).toHaveCount(1);
  }
  // …and one caption for the group, carried as a hover title, not one per
  // button per stage.
  await expect(page.getByTestId("schedule-action-bar")).toHaveCount(1);
  await expect(page.getByTestId("schedule-action-bar")).toHaveAttribute(
    "title",
    "Rebuild → fix clashes → tighten times. Locked cards stay put.",
  );

  const options = page.getByTestId("schedule-stage");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toHaveAttribute("aria-pressed", "true");

  await options.nth(1).click();
  await expect(options.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(options.nth(0)).toHaveAttribute("aria-pressed", "false");

  const autoButton = page.getByTestId("schedule-auto");
  await autoButton.click();
  await page.getByTestId("schedule-rebuild-confirm").click();
  const strip = page.getByTestId("schedule-result-strip");
  await expect(strip).toBeVisible({ timeout: 45_000 });
  await expect(autoButton).toBeEnabled({ timeout: 45_000 });

  // The league stage was never asked to run, so its six fixtures are exactly
  // where the seed left them: unscheduled. A toolbar that ignored the selector
  // would have placed all six.
  for (const id of fixtureIds) {
    const f = await getFixture(request, id);
    expect(f.scheduled_at, `league fixture ${id} must be untouched`).toBeNull();
  }
});

/**
 * The 409 envelope the AI console reads its fixture list out of.
 *
 * `board.ai.error.blocked` names the matches a refused apply clashed with, and
 * the only source for those names is `error.conflicts` inside the refusal
 * itself (`api-v1/http.ts` forwards `SCHEDULE_CONFLICT`'s payload). That is a
 * wire contract between two layers with no shared type: a server that stopped
 * sending the array, or renamed a field inside it, would leave the dock
 * rendering its sentence over an empty list, and every unit test on both sides
 * would still pass.
 *
 * TWO APPLIES, not one carrying both cards. The delta gate compares the board
 * BEFORE against the board AFTER, so a clash contained entirely within a single
 * apply is a different case from one that lands on top of what is already
 * there — and the second is exactly what a per-stage AI apply does once its
 * first stage has been written.
 */
test("a refused apply names the fixtures it clashed with, in the 409 envelope", async ({ request }) => {
  const { stageId, fixtureIds, courts } = await seedBoard(request, "refusal");
  const when = slotAt(0);
  const courtId = courts[0]!.id;

  const first = await apiJson(request, `/api/v1/stages/${stageId}/schedule/apply`, "POST", {
    assignments: [{ fixture_id: fixtureIds[0]!, scheduled_at: when, court_id: courtId }],
    source: "manual",
  });
  expect(first.status, "the first card lands cleanly").toBe(200);

  // …now put a second card exactly on top of it. `apiJson` keeps only
  // code/message from the envelope, so this one is read raw: the payload IS
  // the assertion.
  const res = await request.fetch(`/api/v1/stages/${stageId}/schedule/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    data: {
      assignments: [{ fixture_id: fixtureIds[1]!, scheduled_at: when, court_id: courtId }],
      source: "manual",
    },
  });
  expect(res.status()).toBe(409);
  const body = (await res.json()) as {
    error?: { code?: string; conflicts?: { fixture_id?: string; code?: string; blocking?: boolean }[] };
  };
  expect(body.error?.code).toBe("SCHEDULE_CONFLICT");
  const conflicts = body.error?.conflicts ?? [];
  expect(conflicts.length, "the refusal carries its blocking rows").toBeGreaterThan(0);
  // The three fields the console reads: the id that names the card, the code
  // that says what kind of clash it is, and `blocking` — which is what keeps
  // warnings out of a list that claims to explain a refusal.
  const court = conflicts.find((c) => c.code === "conflict.court");
  expect(court, `no conflict.court row in ${JSON.stringify(conflicts)}`).toBeTruthy();
  expect(court!.blocking).toBe(true);
  expect([fixtureIds[0], fixtureIds[1]]).toContain(court!.fixture_id);

  // And nothing was written — which is what lets the console say "nothing
  // changed" for a refusal on the first stage it tries.
  const second = await getFixture(request, fixtureIds[1]!);
  expect(second.scheduled_at).not.toBe(when);
});
