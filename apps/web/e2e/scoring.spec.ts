import { test, expect, type Page } from "@playwright/test";
import {
  addEntrantsViaApi,
  apiJson,
  createStageAndGenerate,
  expectNoHorizontalScroll,
  seedScoredDivision,
  TAG,
  divisionPath,
  fixturePath,
} from "./helpers";

// Scoring discoverability + sport-shaped pads (organiser feedback: the score
// pad was hard to reach, and cricket should be over-by-over, not ball-by-ball).

/** The pad's own scoring surface, scoped so a page-wide text match can never
 *  satisfy an assertion the skin was supposed to. Mirrors scorepad-v2.spec.ts
 *  / scorepad-skins.spec.ts's own `pad()` exactly. */
function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}

test("every fixture row has a Score entry point", async ({ page, request }) => {
  const { divisionId } = await seedScoredDivision(request);
  await page.goto(await divisionPath(page.request, divisionId, "?tab=fixtures"));
  // decided fixtures show "View", live/scheduled show "Score"
  await expect(page.getByRole("link", { name: /^(Score|View)/ }).first()).toBeVisible({
    timeout: 20_000,
  });
});

test("forfeit dropdown closes when clicking outside", async ({ page, request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Badminton ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "MS", sport_key: "badminton", variant_key: "bwf", config: {}, eligibility: [] },
  );
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["Asha", "Bala"]);
  const { fixtureIds } = await createStageAndGenerate(request, divisionId, {
    kind: "knockout",
    name: "Final",
  });
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");

  await page.goto(await fixturePath(page.request, fixtureIds[0]));
  await page.getByRole("button", { name: /Forfeit/ }).click({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: /forfeits$/ }).first()).toBeVisible();

  // clicking anywhere outside the menu must dismiss it
  await page.getByRole("heading", { level: 1 }).click();
  await expect(page.getByRole("button", { name: /forfeits$/ })).toHaveCount(0);
});

test("badminton pad shows the current game number, not always game 1", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Badminton games ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "WS", sport_key: "badminton", variant_key: "bwf", config: {}, eligibility: [] },
  );
  const divisionId = div.data!.id;
  const { ids } = await addEntrantsViaApi(request, divisionId, ["Mina", "Rita"]);
  const { fixtureIds } = await createStageAndGenerate(request, divisionId, {
    kind: "knockout",
    name: "Final",
  });
  const fixtureId = fixtureIds[0]!;
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");

  // start + take game 1 to 21-0 via the ledger API
  await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  for (let seq = 1; seq <= 21; seq++) {
    await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
      expected_seq: seq,
      type: "badminton.rally",
      payload: { wonBy: ids[0] },
    });
  }

  await page.goto(await fixturePath(page.request, fixtureId));
  // S13/#422 W11 cutover — v1's literal "Game 2"/"1 game won" copy is gone;
  // the v2 racquet skin (racquet-skin.tsx's buildHeader) carries the same
  // fact as two numeric header fields instead. "Sets" already reading 1–0
  // is the "not always game 1" proof (a game is won and counted), and
  // "Points" having reset to 0–0 — rather than staying stuck on game 1's
  // final 21–0 — is the proof the pad has actually moved on to game 2 and
  // is not just re-displaying stale state.
  const header = page.locator('[data-role="racquet-header"]');
  await expect(header).toBeVisible({ timeout: 20_000 });
  const setsField = header.getByText("Sets", { exact: true }).locator("..");
  const pointsField = header.getByText("Points", { exact: true }).locator("..");
  await expect(setsField).toContainText("1–0", { timeout: 20_000 });
  await expect(pointsField).toContainText("0–0");
});

test("badminton: an entered game score lands in the header summary live (v3/09 §1a)", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Badminton header ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "MS", sport_key: "badminton", variant_key: "bwf", config: {}, eligibility: [] },
  );
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["Priya", "Sana"]);
  const { fixtureIds } = await createStageAndGenerate(request, divisionId, {
    kind: "knockout",
    name: "Final",
  });
  const fixtureId = fixtureIds[0]!;
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });

  await page.goto(await fixturePath(page.request, fixtureId));
  // S13/#422 W11 cutover — v1's "Game totals"/"Record game" form (entrant-
  // named field labels, a joined "1 — 0 · 21–15" summary string) is gone.
  // The v2 racquet skin's equivalent is the unconditional "Set score" action
  // (kernel.ts's `summaryAction`, `pad.badminton.action.setScore`), whose
  // two number fields derive plain "Home"/"Away" captions from their own
  // path (view-model.ts's `deriveFieldPathLabel` — the action ships no
  // labelKey for either). Same idiom scorepad-skins.spec.ts's racquet-skin
  // test already proved for volleyball's identical `summaryAction`. Under
  // load the fill can land before React hydrates — re-fill until it sticks.
  await page.getByRole("button", { name: "Set score", exact: true }).click({ timeout: 20_000 });
  const confirm = page.locator('[data-role="confirm"]');
  await expect(async () => {
    await page.getByLabel("Home", { exact: true }).fill("21");
    await page.getByLabel("Away", { exact: true }).fill("15");
    await expect(confirm).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await confirm.click();

  // "1 game won" lands in the header summary live (intake #28a) — the exact
  // 21–15 score is never re-rendered by this skin once the game closes (only
  // the running games-won tally persists on screen), so the entered score
  // reaching the server is proven directly off the real ledger instead. The
  // header can read "1–0" off an optimistic local update before the POST
  // this action fires has actually been committed server-side, so the
  // ledger read is polled too, not fetched once.
  const header = page.locator('[data-role="racquet-header"]');
  await expect(header.getByText("Sets", { exact: true }).locator("..")).toContainText("1–0", {
    timeout: 20_000,
  });
  const fetchEvents = () =>
    apiJson<{ type: string; payload: { home?: number; away?: number } }[]>(
      request,
      `/api/v1/fixtures/${fixtureId}/events?since_seq=0`,
    );
  await expect
    .poll(async () => (await fetchEvents()).data?.some((e) => e.type === "badminton.game.summary") ?? false, {
      timeout: 20_000,
    })
    .toBe(true);
  const events = await fetchEvents();
  const summary = (events.data ?? []).find((e) => e.type === "badminton.game.summary");
  expect(summary?.payload).toMatchObject({ home: 21, away: 15 });
});

test("cricket: undo mid-over keeps the scoring panel usable (v3/09 §2)", async ({
  page,
  request,
}) => {
  // Two "Innings total" round trips through the v3 More sheet each pay
  // queue.ts's HOLD_MS = 6000ms soft-commit before the ledger sees them.
  test.setTimeout(120_000);
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Cricket undo ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "T20", sport_key: "cricket", variant_key: "t20", config: {}, eligibility: [] },
  );
  const divisionId = div.data!.id;
  const entrants = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    [
      { kind: "team", display_name: "Kings", seed: 1 },
      { kind: "team", display_name: "Queens", seed: 2 },
    ],
  );
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    { seq: 1, kind: "knockout", name: "Final" },
  );
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${stage.data!.id}/generate`,
    "POST",
  );
  const fixtureId = gen.data!.fixtures[0]!.id;
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 0,
    type: "cricket.toss",
    payload: { wonBy: entrants.data![0]!.id, elected: "bat" },
  });
  await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 1,
    type: "core.start",
    payload: {},
  });
  await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 2,
    type: "cricket.innings.summary",
    payload: { runs: 12, wickets: 1, legalBalls: 6, partial: true },
  });

  await page.goto(await fixturePath(page.request, fixtureId));
  // S13/#422 W11 cutover, then R2's v2→v3 cutover for cricket specifically
  // (V3_SKINS): v1's joined "<side> — total <runs>/<wickets>" string and v2's
  // separate "Score"/"Wickets" header fields are both gone — the v3 chassis
  // scorebug (v3/scorebug.tsx) renders ONE `runs/wickets` string instead
  // (§2.1, D-11 — a score is drawn exactly once). This fixture seeds no
  // roster at all (no persons, no lineups — the original test's own "undo"
  // repro needs none), so the run/wide/wicket tiles would 422 on a real tap
  // (they carry striker/nonStriker/bowler resolved from an empty batting
  // order); the coarse "Innings total" admin action — `cricket.innings.
  // summary`, the very event type this test's own setup already posts via
  // the API — rides the v3 "More" sheet (cricket.tsx's OWNER HYBRID RULING)
  // and is the one scoring surface this fixture can drive at all, same as
  // it was the one v2 could drive too.
  const scorebug = pad(page).locator('[data-role="v3-scorebug"]');
  await expect(scorebug).toBeVisible({ timeout: 20_000 });
  await expect(scorebug).toContainText("12/1");

  // The intake #29 repro action: Undo last (voids the over) — chassis-level
  // fixture-console.tsx control, untouched by the v2→v3 pad swap.
  await page.getByRole("button", { name: /Undo last/ }).click();
  await expect(scorebug).toContainText("0/0", { timeout: 20_000 });

  // The panel stays usable — no blank screen, no dead-end: score again,
  // through the v3 "More" tile's own "Innings total" action.
  await pad(page).getByRole("button", { name: "More", exact: true }).click();
  const sheet = pad(page).locator('[data-role="v3-sheet"]');
  await sheet.getByRole("button", { name: "Innings total", exact: true }).click();
  const confirm = sheet.getByRole("button", { name: "Confirm", exact: true });
  await expect(async () => {
    await sheet.getByLabel("Runs", { exact: true }).fill("8");
    await sheet.getByLabel("Wickets", { exact: true }).fill("0");
    await sheet.getByLabel("Legal balls", { exact: true }).fill("6");
    await expect(confirm).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await sheet.getByLabel("Partial", { exact: true }).check();
  await confirm.click();
  // The scorebug reads the OPTIMISTIC fold (use-pad-pipeline.ts's
  // `commitPendingEnvelopes` runs synchronously inside `submitHeld`, before
  // the awaited durable enqueue) — it updates immediately, never gated on
  // queue.ts's HOLD_MS soft-commit window. Only the real ledger (polled via
  // the API further down) waits out that ~6s hold.
  await expect(scorebug).toContainText("8/0", { timeout: 20_000 });

  // fixture-console.tsx's "Undo last" targets its OWN `lastVoidable`, derived
  // from an `events` array that is seeded once from server props and only
  // ever refreshed by fixture-console's OWN send() calls (e.g. the undo
  // above) — never by the pad's independent submission just above, which
  // goes through a wholly separate client pipeline. Left alone, "Undo last"
  // would still be targeting the pre-reload state and silently no-op void
  // something else. A reload re-fetches fresh props so it targets the entry
  // just added — but the header above can read "8" from a local optimistic
  // update before that submission's own POST has actually committed, so the
  // reload must wait on the real ledger, not the screen, or it can reload
  // onto a snapshot from BEFORE the commit and never see "8" again.
  await expect
    .poll(
      async () => {
        const res = await apiJson<{ type: string; payload: { runs?: number } }[]>(
          request,
          `/api/v1/fixtures/${fixtureId}/events?since_seq=0`,
        );
        return (res.data ?? []).some((e) => e.type === "cricket.innings.summary" && e.payload.runs === 8);
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await page.reload();
  await expect(scorebug).toBeVisible({ timeout: 20_000 });
  await expect(scorebug).toContainText("8/0");

  // Undo storms past the start: the console never dead-ends. Two more undos
  // (the corrected over, then core.start) must land back on "Start match".
  await page.getByRole("button", { name: /Undo last/ }).click();
  await expect(scorebug).toContainText("0/0", { timeout: 20_000 });
  await page.getByRole("button", { name: /Undo last/ }).click();
  await expect(page.getByRole("button", { name: "Start match" })).toBeVisible({
    timeout: 20_000,
  });
});

test("cricket scores over-by-over: add an over grows the total, then close innings", async ({
  page,
  request,
}) => {
  // "Innings total" then "Close innings", each a held dispatch (queue.ts's
  // HOLD_MS = 6000ms soft-commit) the ledger polls below wait out.
  test.setTimeout(120_000);
  // a minimal cricket fixture
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Cricket ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "T20", sport_key: "cricket", variant_key: "t20", config: {}, eligibility: [] },
  );
  const divisionId = div.data!.id;
  const entrants = await apiJson<{ id: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
    "POST",
    [
      { kind: "team", display_name: "Lions", seed: 1 },
      { kind: "team", display_name: "Tigers", seed: 2 },
    ],
  );
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    { seq: 1, kind: "knockout", name: "Final" },
  );
  const gen = await apiJson<{ fixtures: { id: string }[] }>(
    request,
    `/api/v1/stages/${stage.data!.id}/generate`,
    "POST",
  );
  const fixtureId = gen.data!.fixtures[0]!.id;
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  // open the first innings via toss + start so the pad lands ready to score
  await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 0,
    type: "cricket.toss",
    payload: { wonBy: entrants.data![0]!.id, elected: "bat" },
  });
  await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 1,
    type: "core.start",
    payload: {},
  });

  await page.goto(await fixturePath(page.request, fixtureId));

  // S13/#422 W11 cutover, then R2's v2→v3 cutover for cricket: v1's
  // "Over-by-over"/"Ball-by-ball" mode switch and v2's own "runs this
  // over"/"wickets this over"/"add over" form are both gone. This fixture
  // seeds no roster (no persons, no lineups), so the run/wide/wicket tiles
  // would 422 (they resolve striker/nonStriker/bowler from an empty batting
  // order) — the coarse "Innings total" admin action (`cricket.innings.
  // summary`) rides the v3 "More" sheet (cricket.tsx's OWNER HYBRID RULING)
  // and is this fixture's one scoring surface, and is a closer v2/v3
  // analogue of "over-by-over" than ball-by-ball would be anyway: a single
  // aggregate entry per over, exactly this test's own name.
  const scorebug = pad(page).locator('[data-role="v3-scorebug"]');
  await expect(scorebug).toBeVisible({ timeout: 20_000 });
  await expect(scorebug).toContainText("0/0");

  // record one over: 12 runs, 1 wicket, 6 legal balls. Under load the fill
  // can land before React hydrates (DOM value set, state empty → button
  // stays disabled), so re-fill until the pad actually accepts the input.
  await pad(page).getByRole("button", { name: "More", exact: true }).click();
  const sheet = pad(page).locator('[data-role="v3-sheet"]');
  await sheet.getByRole("button", { name: "Innings total", exact: true }).click();
  const confirm = sheet.getByRole("button", { name: "Confirm", exact: true });
  await expect(async () => {
    await sheet.getByLabel("Runs", { exact: true }).fill("12");
    await sheet.getByLabel("Wickets", { exact: true }).fill("1");
    await sheet.getByLabel("Legal balls", { exact: true }).fill("6");
    await expect(confirm).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await sheet.getByLabel("Partial", { exact: true }).check();
  await confirm.click();

  // the innings total grows (progressive summary folded) — the scorebug
  // reads the optimistic fold, so this resolves well before the ~6s
  // soft-commit hold (see the "undo mid-over" test's own comment on why).
  await expect(scorebug).toContainText("12/1", { timeout: 20_000 });
  await expect(scorebug).toContainText("1.0");

  // close the innings. `cricket.innings.close` needs a `reason` — the v3
  // "Close innings" TILE (one of cricket.tsx's five phase-aware hybrid
  // tiles, not the generic More sheet) opens a guided sheet with exactly
  // one choice step; picking "Other" completes the wizard and dispatches —
  // no separate select/Confirm pair the way v2's generic ActionForm needed.
  await pad(page).getByRole("button", { name: "Close innings", exact: true }).click();
  await sheet.getByRole("button", { name: "Other", exact: true }).click();

  // Closing does not auto-open a fresh innings on this kernel: cricket.ts's
  // own `decideAfterClose`, single-innings branch, `count < 2` returns the
  // state UNCHANGED ("// innings break") — a second innings needs whatever
  // starts it explicitly. So the scorebug keeps showing innings #1's own
  // final tally rather than resetting to 0/0 (`currentInnings()`'s own
  // fallback, v3/skins/cricket.tsx, once nothing is open: the last, closed,
  // innings). The close itself is proven off the real ledger and the fold's
  // own state instead — the event landed with the chosen reason, and the
  // innings record it closed is actually marked closed.
  await expect
    .poll(
      async () => {
        const res = await apiJson<{ type: string; payload: { reason?: string } }[]>(
          request,
          `/api/v1/fixtures/${fixtureId}/events?since_seq=0`,
        );
        return (res.data ?? []).find((e) => e.type === "cricket.innings.close")?.payload.reason ?? null;
      },
      { timeout: 20_000 },
    )
    .toBe("other");
  const state = await apiJson<{ state: { innings: { closed: boolean }[] } }>(
    request,
    `/api/v1/fixtures/${fixtureId}/state`,
  );
  expect(state.data!.state.innings[0]?.closed).toBe(true);
});

// #451 — DLS reads a published resource table that is fixed at 6-ball overs and
// 10 wickets, so a division whose format is neither must have its inputs
// converted onto those scales before the lookup. `hundred` is the sharpest case
// on the overs axis: its overs are FIVE balls, so a 10-over revision is 50
// balls, not 60, and reading it as 60 inflates both resource percentages and
// publishes a target of 86 where the method says 84.
//
// The arithmetic is pinned through the API, not the DOM: `cricket.revise`
// also accepts a manual `target`, which stamps targetSource "manual" and
// skips the maths entirely — this sends `oversPerSide` alone and pins
// targetSource "dls", so a revise that quietly fell through to the manual
// branch cannot pass either check below. #467 was fixed by adding
// `ck-revised-target` to the v2 cricket skin, giving this arithmetic an
// ON-SCREEN proof too. R2's v2→v3 cutover for cricket (V3_SKINS) shipped no
// v3 equivalent of that surface for one PR — a real regression inside that
// same wave's own blast radius, not a deferred gap — closed by a follow-up
// task in the same wave (`buildScorebug`, v3/skins/cricket.tsx, now appends
// a target strip item; see this test's own DOM assertion further down).
test("cricket DLS scales a five-ball-over format onto the published table", async ({
  page,
  request,
}) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Cricket DLS ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "The Hundred",
      sport_key: "cricket",
      variant_key: "hundred",
      // The only override the rail needs: scoring.ts reads dls.enabled straight
      // off divisions.config to decide a revise is a DLS one.
      config: { dls: { enabled: true, edition: "standard" } },
      eligibility: [],
    },
  );
  const divisionId = div.data!.id;
  const { ids: entrantIds } = await addEntrantsViaApi(
    request,
    divisionId,
    ["Century Kings", "Century Queens"],
    "team",
  );
  const { fixtureIds } = await createStageAndGenerate(request, divisionId, {
    kind: "knockout",
    name: "Final",
  });
  const fixtureId = fixtureIds[0]!;
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");

  const send = async (seq: number, type: string, payload: unknown) => {
    const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
      expected_seq: seq,
      type,
      payload,
    });
    expect(res.status, `${type}: ${res.error?.code ?? ""} ${res.error?.message ?? ""}`).toBe(201);
  };
  await send(0, "cricket.toss", { wonBy: entrantIds[0]!, elected: "bat" });
  await send(1, "core.start", {});
  // The full first innings: 150/0 off the whole 100-ball quota.
  await send(2, "cricket.innings.summary", {
    runs: 150,
    wickets: 0,
    legalBalls: 100,
    partial: true,
  });
  // Rain cuts the chase to 10 overs — FIVE-ball overs, so 50 balls.
  await send(3, "cricket.revise", { oversPerSide: 10 });

  const state = await apiJson<{
    state: {
      r1: number | null;
      r2: number | null;
      revisedTarget: number | null;
      targetSource: string | null;
    };
  }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  const fold = state.data!.state;
  // R1 is the resource for a 100-ball innings, R2 for the 50 balls that remain
  // — read as 6-ball overs they come out 56.6 / 32.1 and the target with them.
  expect(fold.r1).toBeCloseTo(49.13333333333333, 9);
  expect(fold.r2).toBeCloseTo(27.366666666666667, 9);
  expect(fold.targetSource).toBe("dls");
  expect(fold.revisedTarget).toBe(84);

  // cricket-skin.tsx's `chaseValue` (the source of `ck-revised-target`,
  // #467) returns null unless `state.innings.length >= 2` — correct product
  // behaviour, since there is no target to chase before a chase exists.
  // The 100-ball quota that closed innings #1 above is ALSO its
  // `ballsLimit` (`legalBalls: 100` at seq 2 already equalled it), so it has
  // already auto-closed (`autoClose`, cricket.ts) — a `cricket.innings.close`
  // here would 422 with "no innings in progress". What is missing is
  // innings #2 itself: `createInnings` opens it lazily on the first scoring
  // event the fold sees with none open, which a genuine 0/0 chase-opening
  // summary supplies cheaply (no roster/lineup needed — `partial: true`
  // coarse fidelity, same shape the setup above already used twice).
  await send(4, "cricket.innings.summary", { runs: 0, wickets: 0, legalBalls: 0, partial: true });

  // Now genuinely chasing: the shortened match is scoreable, and the pad
  // opens on the chase for real (previously the fixture never reached a
  // second innings, so the checks below that read "0" were only ever
  // matching the closed first innings' "150" as a substring).
  await page.goto(await fixturePath(page.request, fixtureId));
  // S13/#422 W11 cutover, then R2's v2→v3 cutover for cricket: "— total" was
  // v1 CricketPad's own OverByOverForm sentence, and v2's own separate
  // "Score"/"Wickets" header fields are both gone — the v3 chassis scorebug
  // renders ONE `runs/wickets` string instead (§2.1, D-11).
  const scorebug = pad(page).locator('[data-role="v3-scorebug"]');
  await expect(scorebug).toBeVisible({ timeout: 20_000 });
  await expect(scorebug).toContainText("0/0");

  // #467 — the 84 asserted off the state API above must also be ON SCREEN,
  // inside the chase this test just opened above (`buildScorebug`,
  // v3/skins/cricket.tsx, appends no target strip item before one exists —
  // this DOM assertion could not fire a moment earlier). Before #467, the
  // revised target was verifiable only through /state, which is how #451 (a
  // DLS bug that awarded the match to the wrong side) survived: an
  // unrendered derivation is an unverified one. The pad must also say the
  // figure is DLS-derived rather than one the organiser typed — GAP CLOSED:
  // R2 gave the v3 cricket skin a target strip item (appended after
  // striker/non-striker/dots/bowler, `scorepad.skin.cricket.header.dlsPar`
  // caption when `cfg.dls.enabled && targetSource === "dls"`, same guard v2
  // used). scorebug.tsx (chassis, out of this task's scope) attaches no
  // PER-ITEM data-testid to a strip entry, only the container's own
  // `data-role="v3-scorebug"` — so this anchors on the container locator's
  // REAL rendered text via `toContainText`, exactly like the `"0/0"` check
  // above, not a raw `page.content()` substring search (the trap AGENTS.md
  // warns of — React serialising an omitted prop as the string
  // `"$undefined"` — applies to grepping raw HTML/RSC-payload source; a
  // Playwright locator query reads only the live DOM, so it cannot be
  // fooled by that sentinel). The joined "DLS par 84" (caption + value,
  // space-separated exactly as scorebug.tsx renders a labelled StripItem)
  // is the anchor: it can only be produced by the real caption sitting next
  // to the real value, not by either string appearing elsewhere on the pad.
  await expect(scorebug).toContainText("DLS par 84");

  // Every surface works at 375px with no horizontal page scroll (v3/02 §4).
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(scorebug).toBeVisible();
  await expectNoHorizontalScroll(page);
});
