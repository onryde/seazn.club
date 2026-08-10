import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  TAG,
  apiJson,
  addEntrantsViaApi,
  createStageAndGenerate,
  divisionPath,
  expectNoHorizontalScroll,
} from "./helpers";

/**
 * Date/time UX programme (#datetime-ux), Prompt 09 — the three e2e cases and
 * one 375px board case the programme owed, covering prompts 01-08 end to end
 * through the real HTTP routes and the real z3/greedy engines. No UI-only unit
 * test can see any of these: the engine selection (case a), the write-gate's
 * transaction (case b) and real layout at a real viewport (case c) all live
 * outside a `renderToStaticMarkup` / jsdom-less suite.
 *
 * Case (d), added in a later P09 follow-up: the minimum-rest floor note
 * (`RestFloorNote`, #459) — a CLIENT COMPONENT that conditionally renders
 * NOTHING at all (not a hidden/empty element, the whole node is absent).
 * That branch is exactly what a jsdom-less unit test cannot watch happen
 * against a real DOM, so it gets the same real-page treatment as (a)-(c).
 *
 * Screenshot debt for the programme's converted surfaces (division builder,
 * competition wizard, board settings tab, blackout editor) is captured
 * separately, once, as verification evidence under the scratchpad — see the
 * P09 report rather than this file; it is not a permanent screenshot suite
 * and does not belong committed with a session-scoped path.
 *
 * SELECTORS ARE IDS/ROLES, NEVER COPY (#465) — matches z3-auto-schedule.spec.ts.
 *
 * Each test seeds its own competition/division/stage; nothing here is shared
 * state, so the file needs no serial mode.
 */

async function seedDivision(
  request: APIRequestContext,
  label: string,
  entrants: string[] = ["Ash", "Brook", "Clay", "Dune"],
): Promise<{ competitionId: string; divisionId: string }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `DTX ${label} ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
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
  await addEntrantsViaApi(request, divisionId, entrants);
  return { competitionId: comp.data!.id, divisionId };
}

interface AutoResult {
  assignments: { fixture_id: string; scheduled_at: string; ends_at: string; court_label: string }[];
  solver: { engine: string; status: string };
}

// ---------------------------------------------------------------------------
// Case (a): a stored blackout actually constrains the auto-schedule board.
// ---------------------------------------------------------------------------
//
// Two traps make the obvious version of this test vacuous — both measured
// against this real division, not guessed:
//
//  1. `applyWindow` (usecases/schedule.ts) derives the solver's universe from
//     `startAt`'s DAY at local midnight on the ORG clock, not from `startAt`
//     itself. A window placed later in the day leaves the solver free to pack
//     the whole board into the untouched hours before it and dodge the window
//     entirely — measured (implementer memory: blackout-solver-test-vacuity):
//     startAt 10:00 + a window at 11:00-12:00 relocated a 6-fixture board to
//     00:00-02:30, nowhere near the window it was meant to prove. The fix is
//     placing the window AT the universe's own anchor (just after local
//     midnight) where nothing earlier exists to hide in.
//  2. The solver does not have to leave a hole shaped exactly like the
//     window — it may place fixtures before AND after it, or skip the whole
//     pre-window period and start clean afterwards, whichever costs less.
//     Measured for THIS config (below): greedy filled the one slot that fits
//     before the window (00:00-00:30) then resumed at 01:30, i.e. the mixed
//     shape — so "fixtures exist on both sides of the gap" happens to hold
//     here, but asserting it would be RED against an equally-correct solver
//     that instead skipped the pre-window slot entirely (a real, previously
//     measured outcome for a different config). The arrangement-independent
//     fact that always holds regardless of which correct shape comes back is
//     that avoiding an unavoidable 60-minute blackout the control's
//     zero-slack board sits directly on top of cannot be free: the guarded
//     board must finish later.
//
// A THIRD thing this file assumed and then measured wrong, worth recording
// so nobody re-introduces it: a non-empty `blackouts` does NOT reliably flip
// the engine from "greedy" to "z3". Measured: both the control and the
// guarded call below come back `engine: "greedy", status: "ok",
// elapsed_ms: 1` — greedy's own sequential placement is blackout-aware
// (it skips a blocked slot rather than requiring a whole re-solve), and z3
// is apparently an escalation for when that cheap pass can't produce a
// conflict-free board on its own, not something "any blackout" triggers.
// So this test does not assert an engine name on either run — only the
// observable contract: the window is respected, and respecting it costs
// time. That is a STRONGER test than pinning "z3" would have been, because
// it stays true whichever engine ends up handling it.
test.describe("blackout window constrains the board (case a)", () => {
  test("a stored blackout forces a later finish than the unguarded control, and nothing overlaps it", async ({
    request,
  }) => {
    // Measured at ~1-2s total for this config (greedy handles it without
    // reaching the solver at all — see header comment). The generous budget
    // is defensive: if a future change makes this case hard enough to need a
    // real z3 solve, the test should still have room to finish and fail for
    // an assertion reason rather than a timeout, not silently need raising.
    test.setTimeout(150_000);

    const { divisionId } = await seedDivision(request, "Blackout");
    const { stageId, fixtureIds } = await createStageAndGenerate(request, divisionId);
    expect(fixtureIds.length).toBe(6);

    // tz: "UTC" throughout, matching every sibling spec in this area
    // (schedule-board.spec.ts, z3-auto-schedule.spec.ts, ai-architect.spec.ts)
    // — pinning the org clock to UTC means "local midnight" IS UTC midnight,
    // so the instants below need no runner-zone conversion (#448 governs on
    // settings.orgTz, and this makes orgTz unambiguous).
    const DAY = Date.UTC(2026, 9, 19); // Mon 2026-10-19T00:00:00Z
    const MIN = 60_000;

    async function putCourtConfig(blackouts: { from: string; to: string }[]): Promise<void> {
      const res = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
        tz: "UTC",
        config: {
          startAt: new Date(DAY).toISOString(),
          matchMinutes: 30,
          gapMinutes: 0,
          courts: ["Court A"],
          perEntrantMinRest: 0,
          sessionWindows: [],
          blackouts,
        },
      });
      expect(res.status, "schedule-settings PUT must be accepted").toBe(200);
    }

    /** Re-posts on `solver_busy` (a live status under parallel workers sharing
     *  the build queue cap) rather than accepting it — accepting it would let
     *  this file pass against a solver that never ran, the one thing case (a)
     *  exists to rule out. Mirrors z3-auto-schedule.spec.ts's BUSY_RETRIES. */
    async function autoUntilSolved(): Promise<AutoResult> {
      const attempts = 4;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const res = await apiJson<AutoResult>(
          request,
          `/api/v1/stages/${stageId}/schedule/auto`,
          "POST",
          {},
        );
        expect(res.status).toBe(200);
        if (res.data!.solver.status !== "solver_busy") return res.data!;
        if (attempt < attempts) await new Promise((r) => setTimeout(r, 4_000));
      }
      throw new Error("schedule/auto answered solver_busy on every attempt — queue never drained");
    }

    // A run that could not produce a real board (infeasible/timeout/solver
    // unreachable) is not a control or a proof of anything — only "ok" and
    // "already_optimal" mean a working board actually came back.
    const REAL_SOLVE = ["ok", "already_optimal"];

    // ---- CONTROL: empty blackouts, packing all 6 back-to-back from startAt
    // with zero slack (confirmed: makespan_minutes 180 == 6 x 30, no idle).
    // That zero slack is what makes the guarded comparison below meaningful:
    // there is no existing gap for the blackout to fall into for free.
    await putCourtConfig([]);
    const control = await autoUntilSolved();
    expect(control.assignments.length).toBe(6);
    expect(REAL_SOLVE, `control solver.status was "${control.solver.status}"`).toContain(
      control.solver.status,
    );
    const controlFinish = Math.max(...control.assignments.map((a) => Date.parse(a.ends_at)));

    // ---- GUARDED: a 60-minute blackout starting 30 minutes after DAY — the
    // universe's own anchor, per applyWindow. There is nothing earlier in the
    // universe for the solver to hide the board in, which is what makes this
    // window unavoidable rather than merely present.
    const windowFrom = new Date(DAY + 30 * MIN).toISOString();
    const windowTo = new Date(DAY + 90 * MIN).toISOString();
    await putCourtConfig([{ from: windowFrom, to: windowTo }]);
    const guarded = await autoUntilSolved();
    expect(guarded.assignments.length).toBe(6);
    expect(REAL_SOLVE, `guarded solver.status was "${guarded.solver.status}"`).toContain(
      guarded.solver.status,
    );
    const guardedFinish = Math.max(...guarded.assignments.map((a) => Date.parse(a.ends_at)));

    // Assertion 1 (direct): no scheduled fixture's [start, end) interval may
    // touch [windowFrom, windowTo). Arrangement-independent — see header
    // comment trap #2: the solver may place fixtures before AND after the
    // window, or skip straight to after it, but no LEGAL placement may
    // overlap it either way. If blackout enforcement regressed to a no-op,
    // the guarded run would pack identically to the control and fixture #2
    // (00:30-01:00) would land squarely inside this window, so this
    // assertion catches that directly. Not hypothetical: the CONTROL run
    // above (blackouts: []) is exactly what "regressed to a no-op" looks
    // like, and its own fixtures #2 (00:30-01:00) and #3 (01:00-01:30) both
    // satisfy this file's own `overlaps` check against this same window —
    // i.e. this assertion has already been proven to catch it, using this
    // test's own data rather than a mutation.
    const wf = Date.parse(windowFrom);
    const wt = Date.parse(windowTo);
    for (const a of guarded.assignments) {
      const s = Date.parse(a.scheduled_at);
      const e = Date.parse(a.ends_at);
      const overlaps = s < wt && e > wf;
      expect(
        overlaps,
        `fixture ${a.fixture_id} at ${a.scheduled_at}-${a.ends_at} overlaps the blackout ${windowFrom}-${windowTo}`,
      ).toBe(false);
    }

    // Assertion 2 (the honest fallback the plan's naive version got wrong):
    // NOT "fixtures exist on both sides of the gap" — that is red against an
    // equally-correct solver that instead skips the whole pre-window period
    // (see header comment trap #2). What must ALWAYS hold, whichever legal
    // arrangement the solver picks, is that dodging a 60-minute hole the
    // control's zero-slack board sat directly on top of cannot be free: the
    // guarded board finishes later. Also proven non-vacuous by the control's
    // own data rather than by argument alone: controlFinish is 03:00 here,
    // and a "regressed to a no-op" guarded run would equal it exactly
    // (03:00 > 03:00 is false), so this assertion would correctly go red.
    expect(
      guardedFinish,
      `guarded board (ends ${new Date(guardedFinish).toISOString()}) must finish later than ` +
        `the control (ends ${new Date(controlFinish).toISOString()}) — if it does not, the ` +
        `blackout bound nothing`,
    ).toBeGreaterThan(controlFinish);
  });
});

// ---------------------------------------------------------------------------
// Case (b): removing a court with an unmovable fixture is refused, clearly.
// ---------------------------------------------------------------------------
//
// The guard itself (usecases/schedule.ts putScheduleSettings, "date/time UX
// P08") is already exhaustively unit-tested (usecases/__tests__/schedule.test.ts)
// for both refusal reasons and their combination. What only e2e can prove is
// the WIRING: the real PUT route, the real transaction, the real 409 and
// message reaching an HTTP caller unchanged. So this targets ONE reason
// (pinned — the simpler precondition to set up) plus the allowed case the
// brief calls out explicitly, rather than re-deriving the unit suite's full
// matrix.
//
// "Seed a pinned fixture via the real helper" does not exist as a named
// helper; the actual pattern is PATCH /api/v1/fixtures/{id} {schedule_locked}
// after placing it (schedule-board.spec.ts:249).
test.describe("court removal guard (case b)", () => {
  test("a pinned fixture blocks removing its court by name; unpinning it allows the same save", async ({
    request,
  }) => {
    const { divisionId } = await seedDivision(request, "CourtGuard");
    const { fixtureIds } = await createStageAndGenerate(request, divisionId);
    expect(fixtureIds.length).toBe(6);

    const putCourts = (courts: string[]) =>
      apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
        tz: "UTC",
        config: {
          startAt: new Date(Date.UTC(2026, 9, 19, 9, 0)).toISOString(),
          matchMinutes: 30,
          gapMinutes: 0,
          courts,
        },
      });

    const seeded = await putCourts(["Court 1", "Court 2"]);
    expect(seeded.status).toBe(200);

    const targetId = fixtureIds[0]!;
    const placed = await apiJson(request, `/api/v1/fixtures/${targetId}`, "PATCH", {
      scheduled_at: new Date(Date.UTC(2026, 9, 19, 9, 0)).toISOString(),
      court_label: "Court 2",
    });
    expect(placed.status).toBe(200);
    const pinned = await apiJson(request, `/api/v1/fixtures/${targetId}`, "PATCH", {
      schedule_locked: true,
    });
    expect(pinned.status).toBe(200);

    // ---- Refused: Court 2 still holds a pinned fixture. If the guard
    // regressed to a no-op, this PUT would come back 200 instead of 409.
    const refused = await putCourts(["Court 1"]);
    expect(refused.status).toBe(409);
    expect(refused.error?.message ?? "").toMatch(/Court 2/);
    expect(refused.error?.message ?? "").toMatch(/pinned/i);

    // Atomicity: a rejected save must not have written anything (the guard
    // runs before the upsert in putScheduleSettings).
    const afterRefusal = await apiJson<{ config: { courts: string[] } }>(
      request,
      `/api/v1/divisions/${divisionId}/schedule-settings`,
    );
    expect(afterRefusal.data!.config.courts).toEqual(["Court 1", "Court 2"]);

    // ---- Allowed: unpin it. The guard must stay narrower than "any fixture
    // on the court" — if it over-widened, THIS save would still 409.
    const unpinned = await apiJson(request, `/api/v1/fixtures/${targetId}`, "PATCH", {
      schedule_locked: false,
    });
    expect(unpinned.status).toBe(200);

    // The precondition the "still allow removal" claim depends on: scheduled
    // and unlocked, not decided (a decided fixture blocks for the OTHER
    // reason, out of scope here — covered at the unit level).
    const check = await apiJson<{ status: string; schedule_locked: boolean }>(
      request,
      `/api/v1/fixtures/${targetId}`,
    );
    expect(check.data!.status).toBe("scheduled");
    expect(check.data!.schedule_locked).toBe(false);

    const allowed = await putCourts(["Court 1"]);
    expect(allowed.status).toBe(200);
    const afterAllowed = await apiJson<{ config: { courts: string[] } }>(
      request,
      `/api/v1/divisions/${divisionId}/schedule-settings`,
    );
    expect(afterAllowed.data!.config.courts).toEqual(["Court 1"]);
  });
});

// ---------------------------------------------------------------------------
// Case (c): the board renders with no horizontal page scroll at 375px under
// the new gcd row-height segmentation.
// ---------------------------------------------------------------------------
//
// matchMinutes 45 / gapMinutes 5 -> gridStepMinutes = gcd(45, 5) = 5, which is
// under board-grid.tsx's own `compact` threshold (slotMinutes < 30). This is
// deliberately NOT a coarse 30/60-minute board — a coarse grid would pass this
// check regardless of whether the compact row-height styling (added prompt 05)
// works at all, which is exactly the case the "new segmentation" wording in
// the brief calls out.
//
// `expectNoHorizontalScroll` (helpers.ts) is what makes this assertion capable
// of failing at all: `globals.css` sets `overflow-x: clip` on `html, body`,
// which pins the naive `document.documentElement.scrollWidth` probe to the
// viewport width regardless of real overflow (#325) — proven live during this
// session by forcing `document.body.style.width = "3000px"` immediately before
// the call and observing the helper throw, then removing the override and
// observing green (runner-side mutation, no rebuild needed).
test.describe("board renders cleanly at 375px under the new segmentation (case c)", () => {
  test("no horizontal page scroll on a compact fine-step board, at 1280 and at 375", async ({
    page,
    request,
  }) => {
    const { divisionId } = await seedDivision(request, "BoardCompact");
    const { stageId } = await createStageAndGenerate(request, divisionId);

    const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
      tz: "UTC",
      config: {
        startAt: new Date(Date.UTC(2026, 9, 19, 9, 0)).toISOString(),
        matchMinutes: 45,
        gapMinutes: 5,
        courts: ["Court A", "Court B"],
      },
    });
    expect(settings.status).toBe(200);

    const auto = await apiJson<{
      assignments: { fixture_id: string; scheduled_at: string; court_label: string }[];
    }>(request, `/api/v1/stages/${stageId}/schedule/auto`, "POST", {});
    expect(auto.status).toBe(200);
    expect(auto.data!.assignments.length).toBe(6);
    const applied = await apiJson<{ applied: number }>(
      request,
      `/api/v1/stages/${stageId}/schedule/apply`,
      "POST",
      {
        assignments: auto.data!.assignments.map((a) => ({
          fixture_id: a.fixture_id,
          scheduled_at: a.scheduled_at,
          court_label: a.court_label,
        })),
        source: "auto",
      },
    );
    expect(applied.status).toBe(200);

    // No mobile PROJECT runs this spec — playwright.config scopes
    // mobile-se/mobile-14 to mobile.spec.ts alone — so both widths are set
    // explicitly here or 375 is never exercised for this surface at all.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(await divisionPath(page.request, divisionId, "/schedule?tab=board"));
    const board = page.getByRole("table", { name: /Schedule board/ });
    await expect(board).toBeVisible({ timeout: 20_000 });
    await expectNoHorizontalScroll(page);

    await page.setViewportSize({ width: 375, height: 812 });
    // Re-assert the landmark survived the resize before trusting the scroll
    // measurement — a page that failed to re-render would trivially report no
    // overflow.
    await expect(board).toBeVisible();
    // Anti-vacuity, proven live during this session rather than assumed:
    // forcing `document.body.style.width = "3000px"` immediately before this
    // call (runner-side, no rebuild) made expectNoHorizontalScroll reject on
    // THIS exact page — so a real regression here would be caught, not just
    // a hypothetical one.
    await expectNoHorizontalScroll(page);
  });
});

// ---------------------------------------------------------------------------
// Case (d): the minimum-rest FLOOR note (`RestFloorNote`, #459) names
// whichever of the four rest controls actually won, on the tab that is NOT
// that control — and stays silent on the tab that IS.
//
// `restFloor` (packages/engine/src/scheduling/rest-floor.ts) is already
// unit-tested and mutation-proven (engine 14/14, app 15/15); nothing here
// re-derives that logic. What only e2e can prove is the WIRING: a real PUT
// to /api/v1/divisions/{id}/schedule-settings, a real page load of the
// Settings tab (StandaloneScheduleSettings → SettingsPanel) and the
// Constraints tab (ConstraintsPanel), and the CLIENT COMPONENT actually
// rendering the winning source's note beside the LOSING field — never
// beside the winning one.
//
// CRITICAL (this repo's standing trap): assertions anchor on `="`, never on
// bare attribute presence. React serialises an omitted prop as the literal
// string "$undefined", so a probe that checks only the attribute NAME can
// match in both the "note shown" and "note hidden" states. Every positive
// assertion below therefore selects on the full `[data-rest-floor-source="…"]`
// VALUE. The negative assertion is the one place a value can't be anchored
// (there is no value — RestFloorNote returns null, so the whole `<span>` is
// absent, not merely attribute-less), so it instead asserts a page-wide
// COUNT of zero for the bare attribute selector; that is unambiguous because
// each tab mounts exactly one RestFloorNote instance, proven by the sibling
// positive assertions' own `toHaveCount(1)`.
//
// Tests 1 and 2 each double as the brief's negative case: the SAME stored
// config is read from BOTH tabs in one test, so the assertion that the note
// renders on the losing tab and the assertion that it is absent on the
// winning tab share one seed — a suite that only ever checked the positive
// half would pass against a note that always renders next to every field.
// ---------------------------------------------------------------------------
test.describe("minimum-rest floor note explains which control is winning (case d)", () => {
  test("Settings 10 / Constraints 30: Settings tab explains the Constraints rule (30); Constraints tab — the actual winner — shows nothing", async ({
    page,
    request,
  }) => {
    const { divisionId } = await seedDivision(request, "RestFloorA");
    const saved = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
      config: { perEntrantMinRest: 10, constraints: { restMin: 30 } },
    });
    expect(saved.status).toBe(200);

    await page.goto(await divisionPath(request, divisionId, "/schedule?tab=settings"));
    await expect(page.locator("#boardset-rest")).toBeVisible({ timeout: 20_000 });
    const settingsNote = page.locator('[data-rest-floor-source="restMin"]');
    await expect(settingsNote).toBeVisible();
    await expect(settingsNote).toContainText("30");
    // Exactly one note on the page — no duplicate / stray render.
    await expect(page.locator("[data-rest-floor-source]")).toHaveCount(1);

    await page.goto(await divisionPath(request, divisionId, "/schedule?tab=constraints"));
    await expect(page.locator("#rest-min")).toBeVisible({ timeout: 20_000 });
    // (d) Negative case: restMin (30) IS the winner here, so the note beside
    // IT must be entirely absent from the DOM — not present-with-blank-text.
    await expect(page.locator("[data-rest-floor-source]")).toHaveCount(0);
  });

  test("Settings 45 / Constraints 10: Constraints tab explains the Settings rule (45); Settings tab — the actual winner — shows nothing", async ({
    page,
    request,
  }) => {
    const { divisionId } = await seedDivision(request, "RestFloorB");
    const saved = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
      config: { perEntrantMinRest: 45, constraints: { restMin: 10 } },
    });
    expect(saved.status).toBe(200);

    await page.goto(await divisionPath(request, divisionId, "/schedule?tab=constraints"));
    await expect(page.locator("#rest-min")).toBeVisible({ timeout: 20_000 });
    const constraintsNote = page.locator('[data-rest-floor-source="perEntrantMinRest"]');
    await expect(constraintsNote).toBeVisible();
    await expect(constraintsNote).toContainText("45");
    await expect(page.locator("[data-rest-floor-source]")).toHaveCount(1);

    await page.goto(await divisionPath(request, divisionId, "/schedule?tab=settings"));
    await expect(page.locator("#boardset-rest")).toBeVisible({ timeout: 20_000 });
    // (d) Negative case, the other direction: perEntrantMinRest (45) IS the
    // winner here, so ITS tab shows nothing.
    await expect(page.locator("[data-rest-floor-source]")).toHaveCount(0);
  });

  test("'at least one break between a team's matches' (30+5=35) outranks both smaller numeric rests, silently, on BOTH tabs", async ({
    page,
    request,
  }) => {
    const { divisionId } = await seedDivision(request, "RestFloorC");
    // matchMinutes 30 + gapMinutes 5 -> noBackToBack resolves to 35, which
    // must beat BOTH numeric rests (20 and 15) without either tab's own
    // field knowing why — the rest-floor-note.tsx docstring's own point:
    // this control "routinely outranks both numbers without looking like a
    // rest setting at all". Neither field is the winner here, so — unlike
    // tests 1 and 2 — BOTH tabs show the note.
    const saved = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
      config: {
        matchMinutes: 30,
        gapMinutes: 5,
        perEntrantMinRest: 20,
        constraints: { restMin: 15, noBackToBack: true },
      },
    });
    expect(saved.status).toBe(200);

    await page.goto(await divisionPath(request, divisionId, "/schedule?tab=settings"));
    await expect(page.locator("#boardset-rest")).toBeVisible({ timeout: 20_000 });
    const settingsNote = page.locator('[data-rest-floor-source="noBackToBack"]');
    await expect(settingsNote).toBeVisible();
    await expect(settingsNote).toContainText("35");

    await page.goto(await divisionPath(request, divisionId, "/schedule?tab=constraints"));
    await expect(page.locator("#rest-min")).toBeVisible({ timeout: 20_000 });
    const constraintsNote = page.locator('[data-rest-floor-source="noBackToBack"]');
    await expect(constraintsNote).toBeVisible();
    await expect(constraintsNote).toContainText("35");
  });
});
