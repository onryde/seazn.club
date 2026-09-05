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

test("every fixture row carries its own action entry point", async ({ page, request }) => {
  // Re-aimed, max-effort review finding 5. This test asserted
  // `getByRole("link", { name: /^(Score|View)/ }).first()` PAGE-WIDE. Competition
  // Desk W2 retired both labels for this shape — `fixtureRowAction`'s SETTLED
  // branch labels a decided fixture "Result" — so it should have gone red, and
  // instead it went QUIET: `seedScoredDivision` seeds `visibility: "public"`, the
  // masthead therefore renders `aria-label="View this division's public page
  // (opens in a new tab)"`, and `.first()` resolved to THAT. A test named "every
  // fixture row has a Score entry point" would have stayed green with the run
  // sheet rendering no action control at all. Its sibling, `knockout.spec.ts`,
  // was re-pinned in the same diff and this one was missed — AGENTS.md class 16,
  // "sweep by behaviour, never by filename".
  //
  // Re-aimed to the run sheet's own rows, and pinned exactly (`/^Result/`, not a
  // widened `/^(Score|Result|View)/`) for the reason `knockout.spec.ts` gives:
  // the widened form survives a regression that sends every settled row back to
  // "Score".
  const { divisionId } = await seedScoredDivision(request);
  // The expected row count comes from the server's own list, not from a number
  // typed here — a change to what the seed generates moves this with it.
  const seeded = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/fixtures`);
  expect(seeded.status, `seeded fixture list failed: ${JSON.stringify(seeded.error)}`).toBe(200);
  const expected = seeded.data!.length;
  expect(expected).toBeGreaterThan(0);

  await page.goto(await divisionPath(page.request, divisionId, "?tab=fixtures"));
  const rows = page.getByTestId("run-sheet").locator("[data-fixture-no]");
  // The POSITIVE half, first: the sheet actually rendered every seeded fixture.
  // Without it, every assertion below is satisfied by a blank page or a 500 —
  // which is exactly how the version this replaces stayed green.
  await expect(rows).toHaveCount(expected, { timeout: 20_000 });
  // …and every one of those rows offers its ONE action. `seedScoredDivision`
  // decides every fixture and leaves it untimed (helpers.ts: scored callers get
  // no schedule events), so all of them land on `fixtureRowAction`'s SETTLED
  // branch and read "Result".
  await expect(rows.getByRole("link", { name: /^Result/ })).toHaveCount(expected);
});

/** The fixture's own event ledger — the authority on what a click actually
 *  recorded. Mirrors `scorepad-v3-cricket.spec.ts`'s helper of the same name. */
async function ledger(
  request: import("@playwright/test").APIRequestContext,
  fixtureId: string,
): Promise<{ id: string; seq: number; type: string; payload: Record<string, unknown> }[]> {
  const res = await apiJson<{ id: string; seq: number; type: string; payload: Record<string, unknown> }[]>(
    request,
    `/api/v1/fixtures/${fixtureId}/events?since_seq=0`,
  );
  expect(res.status, `ledger read failed: ${JSON.stringify(res.error)}`).toBe(200);
  return res.data ?? [];
}

/** A started division with one live knockout fixture between two named
 *  entrants — the same shape the forfeit-dropdown test below builds, lifted so
 *  the terminal-outcome tests do not each repeat it. */
async function seedLiveFixture(
  request: import("@playwright/test").APIRequestContext,
  label: string,
): Promise<{ fixtureId: string; home: string; away: string; homeId: string; awayId: string }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `${label} ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "MS", sport_key: "badminton", variant_key: "bwf", config: {} },
  );
  const divisionId = div.data!.id;
  const home = `Asha ${label} ${TAG}`;
  const away = `Bala ${label} ${TAG}`;
  const { ids } = await addEntrantsViaApi(request, divisionId, [home, away]);
  const { fixtureIds } = await createStageAndGenerate(request, divisionId, {
    kind: "knockout",
    name: "Final",
  });
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  return { fixtureId: fixtureIds[0], home, away, homeId: ids[0]!, awayId: ids[1]! };
}

// ---------------------------------------------------------------------------
// The two TERMINAL outcomes, end to end (2026-08-24).
//
// Both were effectively uncovered before this. The only forfeit test in the
// repo was the dropdown-dismissal one below — it opens the menu, checks an item
// is visible, and dismisses it, so it never forfeits anything and asserts
// nothing about the ledger. Abandon had no e2e at all; its single mention in
// `scorepad-v3-football.spec.ts` is a COMMENT about card colours.
//
// That gap matters more than an ordinary one: these two events END a fixture
// and set its outcome (`core.forfeit` -> an award to the other side,
// `core.abandon` -> `no_result`, pinned in the engine's own
// `core/events.test.ts`). The engine side is well covered; what nothing proved
// is that the button a person presses reaches the right event with the right
// payload.
// ---------------------------------------------------------------------------

test("Start match takes the fixture live and records core.start", async ({ page, request }) => {
  const { fixtureId } = await seedLiveFixture(request, "Start");
  await page.goto(await fixturePath(page.request, fixtureId));

  await expect(await ledger(request, fixtureId), "nothing is recorded before the first tap").toHaveLength(0);
  await page.getByRole("button", { name: "Start match", exact: true }).click({ timeout: 20_000 });

  await expect
    .poll(async () => (await ledger(request, fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toEqual(["core.start"]);
  // Started, so the control that starts it is gone — the fixture is live, not
  // merely holding an event.
  await expect(page.getByRole("button", { name: "Start match", exact: true })).toHaveCount(0);
});

test("forfeit records core.forfeit with the side and the reason, and ends the fixture", async ({
  page,
  request,
}) => {
  const { fixtureId, home, homeId } = await seedLiveFixture(request, "Forfeit");
  await page.goto(await fixturePath(page.request, fixtureId));

  await page.getByRole("button", { name: /Forfeit/ }).click({ timeout: 20_000 });
  // The NAMED side, not `.first()` — the payload's `by` is asserted against it
  // below, so a swapped-side bug in `ForfeitButton` has to fail here rather
  // than pass on a merely-truthy id.
  await page.getByRole("button", { name: `${home} forfeits`, exact: true }).click();

  // Not a native prompt — `TextPromptDialog` (fixture-console.tsx), which is
  // the whole reason `fixture-console-no-native-prompt.test.ts` exists.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.locator('input[name="reason"]').fill("no-show");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();

  await expect
    .poll(async () => (await ledger(request, fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.forfeit");
  const forfeit = (await ledger(request, fixtureId)).find((e) => e.type === "core.forfeit")!;
  expect(forfeit.payload.reason, "the reason the scorer typed must reach the ledger").toBe("no-show");
  expect(
    forfeit.payload.by,
    "the payload must name the side whose menu item was clicked — the engine awards the OTHER one",
  ).toBe(homeId);

  // `!decided` gates both controls (fixture-console.tsx), so a decided fixture
  // offers neither. This is the user-visible half of the same claim.
  await expect(page.getByRole("button", { name: /Forfeit/ })).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Abandon…", exact: true })).toHaveCount(0);
});

test("abandon records core.abandon with its reason and ends the fixture", async ({
  page,
  request,
}) => {
  const { fixtureId } = await seedLiveFixture(request, "Abandon");
  await page.goto(await fixturePath(page.request, fixtureId));

  await page.getByRole("button", { name: "Abandon…", exact: true }).click({ timeout: 20_000 });
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.locator('input[name="reason"]').fill("rain");
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();

  await expect
    .poll(async () => (await ledger(request, fixtureId)).map((e) => e.type), { timeout: 20_000 })
    .toContain("core.abandon");
  const abandon = (await ledger(request, fixtureId)).find((e) => e.type === "core.abandon")!;
  expect(abandon.payload.reason).toBe("rain");

  await expect(page.getByRole("button", { name: "Abandon…", exact: true })).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(page.getByRole("button", { name: /Forfeit/ })).toHaveCount(0);

  // `decided` gates THREE things, not the two the fix set out to close, and the
  // third reaches every sport: the scoring pad itself
  // (`scorePadV2 && scoring && !decided`, fixture-console.tsx). An ended
  // fixture must stop offering a way to record more into it.
  await expect(
    pad(page),
    "an abandoned fixture must not still offer the scoring pad",
  ).toHaveCount(0);
  // ...but the abandon stays REVERSIBLE. `decidedLock` is deliberately not
  // widened, so Void last entry is still reachable — over, but not sealed. This is
  // the half the fix's own commit message claimed and did not prove.
  await expect(
    page.getByRole("button", { name: /Void last entry/ }),
    "an abandon recorded by mistake must still be undoable",
  ).toBeVisible({ timeout: 20_000 });
});

// The negative control, and the reason these tests are not merely "the click
// worked": an EMPTY reason must close the dialog and write NOTHING.
// `TextPromptDialog`'s submit handler is `if (value) onSubmit(value); else
// onClose()`, and a test that only ever fills the box would pass just as
// happily against a version that submitted regardless.
test("abandon with an empty reason writes nothing — the fixture stays live", async ({
  page,
  request,
}) => {
  const { fixtureId } = await seedLiveFixture(request, "AbandonEmpty");
  await page.goto(await fixturePath(page.request, fixtureId));

  await page.getByRole("button", { name: "Abandon…", exact: true }).click({ timeout: 20_000 });
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();

  await expect(dialog).toHaveCount(0, { timeout: 10_000 });
  // Still offered, because nothing was decided.
  await expect(page.getByRole("button", { name: "Abandon…", exact: true })).toBeVisible();
  expect(
    (await ledger(request, fixtureId)).map((e) => e.type),
    "an empty reason must never reach the ledger",
  ).toEqual([]);
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
    { name: "MS", sport_key: "badminton", variant_key: "bwf", config: {} },
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
    { name: "WS", sport_key: "badminton", variant_key: "bwf", config: {} },
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
  // R5 cutover — badminton renders `v3/skins/badminton.tsx` now, so the v2
  // racquet header (`[data-role="racquet-header"]`, two numeric fields) is
  // gone. The v3 scorebug carries the SAME two facts in two places instead:
  // the strip's games tally, and the two halves' own point readouts. The
  // test's claim is unchanged — "Games" already reading 1–0 is the "not
  // always game 1" proof (a game is won and counted), and the halves having
  // reset to 0 rather than staying on game 1's final 21–0 is the proof the
  // pad has actually moved on and is not re-displaying stale state.
  //
  // The v3 scorebug states the CURRENT GAME NUMBER outright, which the v2
  // header never did — so this test can finally assert its own headline
  // directly instead of inferring it from two tallies. Both are kept: the
  // context line is the direct statement, the tallies are what would catch it
  // being cosmetic.
  const scorebug = pad(page).locator('[data-role="v3-scorebug"]');
  await expect(scorebug).toBeVisible({ timeout: 20_000 });
  await expect(scorebug, "the pad must name the game it is actually on").toContainText("Game 2", {
    timeout: 20_000,
  });
  await expect(scorebug.locator('[data-strip-item-id="games"]')).toContainText("1–0", { timeout: 20_000 });
  const halfScore = (side: "home" | "away") =>
    scorebug.locator(".grid > *").nth(side === "home" ? 0 : 1).locator(".app-display.font-bold");
  await expect(halfScore("home")).toHaveText("0", { timeout: 20_000 });
  await expect(halfScore("away")).toHaveText("0");
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
    { name: "MS", sport_key: "badminton", variant_key: "bwf", config: {} },
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
  // R5 cutover — the v2 racquet skin's generic "Set score" action form is
  // gone; badminton's v3 skin gives the same event a dedicated TILE opening a
  // GUIDED SHEET (two number steps, one per side, prefilled from the live
  // score), which is one wizard with a single `[data-role="confirm"]` rather
  // than a two-field form. The test's claim is unchanged: an entered game
  // score lands in the header summary live AND reaches the real ledger.
  const setScoreTile = pad(page).locator('[data-tile-id="setScore"]');
  await expect(setScoreTile, "a fresh game offers the Set score tile").toBeVisible({ timeout: 20_000 });
  await setScoreTile.click();
  const sheet = pad(page).locator('[data-role="v3-sheet"]');
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  // Each step is its own screen: answer, confirm, answer, confirm. Under load
  // a same-tick fill can land before React hydrates, so each is retried until
  // the value sticks — the same reason the pre-cutover version wrapped its own
  // fills.
  for (const value of ["21", "15"]) {
    const field = sheet.getByRole("spinbutton");
    await expect(async () => {
      await field.fill(value);
      await expect(field).toHaveValue(value, { timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await sheet.getByRole("button", { name: "Confirm", exact: true }).click();
  }

  // "1 game won" lands in the scorebug's own strip live (intake #28a) — the
  // exact 21–15 score is never re-rendered once the game closes (only the
  // running games-won tally persists on screen), so the entered score reaching
  // the server is proven directly off the real ledger instead. The strip can
  // read "1–0" off an optimistic local update before the POST this action
  // fires has actually been committed server-side, so the ledger read is
  // polled too, not fetched once.
  await expect(pad(page).locator('[data-strip-item-id="games"]')).toContainText("1–0", {
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
  // Two coarse-summary round trips through the v3 over tile each pay
  // queue.ts's HOLD_MS soft-commit before the ledger sees them.
  test.setTimeout(120_000);
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
    name: `Cricket undo ${TAG}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "T20", sport_key: "cricket", variant_key: "t20", config: {} },
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
  // order); the coarse summary action — `cricket.innings.summary`, the
  // very event type this test's own setup already posts via the API —
  // rides R2b's dedicated over tile (it moved off the "More" sheet; see
  // the entry-point comment further down)
  // and is the one scoring surface this fixture can drive at all, same as
  // it was the one v2 could drive too.
  const scorebug = pad(page).locator('[data-role="v3-scorebug"]');
  await expect(scorebug).toBeVisible({ timeout: 20_000 });
  await expect(scorebug).toContainText("12/1");

  // The intake #29 repro action: Undo last (voids the over) — chassis-level
  // fixture-console.tsx control, untouched by the v2→v3 pad swap.
  await page.getByRole("button", { name: /Void last entry/ }).click();
  await expect(scorebug).toContainText("0/0", { timeout: 20_000 });

  // The panel stays usable — no blank screen, no dead-end: score again.
  //
  // R2b MOVED this entry point. It used to be More → "Innings total" (the
  // generic action form). R2b gave `cricket.innings.summary` a dedicated
  // over tile with its own guided sheet, and `dedicatedEventTypes`
  // (v3/pad-host.tsx:141-151) collects every sheet's `event` and filters it
  // OUT of the More list — so "Innings total" is no longer offered there,
  // by design: one event type, one entry point, the same rule that made R2b
  // drop cricket's duplicate Retire tile. The over tile is the replacement,
  // and it needs no roster either, which is what this fixture requires.
  //
  // The sheet is a three-step wizard of PER-OVER deltas (owner's Q2
  // reversal, `_INDEX.md`), so against this post-undo 0/0 fold the numbers
  // are the same ones the old total-shaped form took. `partial: true` is
  // implied by the tile — there is no checkbox to tick.
  const sheet = pad(page).locator('[data-role="v3-sheet"]');
  const confirm = sheet.getByRole("button", { name: "Confirm", exact: true });
  await pad(page).locator('[data-tile-id="overSummary"]').click();
  for (const [label, value] of [
    ["Runs this over", "8"],
    ["Wickets this over", "0"],
    ["Balls this over", "6"],
  ] as const) {
    const field = sheet.getByRole("spinbutton", { name: label });
    // Under load a fill can land before React hydrates (DOM value set,
    // state empty), so re-fill until the pad actually accepts it — same
    // reason the old form-shaped block wrapped its fills this way.
    await expect(async () => {
      await field.fill(value);
      await expect(field).toHaveValue(value, { timeout: 1_000 });
      await expect(confirm).toBeEnabled({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await confirm.click();
  }
  await expect(sheet, "the wizard's own last step closes the sheet").not.toBeVisible({ timeout: 10_000 });
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
  await page.getByRole("button", { name: /Void last entry/ }).click();
  await expect(scorebug).toContainText("0/0", { timeout: 20_000 });
  await page.getByRole("button", { name: /Void last entry/ }).click();
  await expect(page.getByRole("button", { name: "Start match" })).toBeVisible({
    timeout: 20_000,
  });
});

test("cricket scores over-by-over: add an over grows the total, then close innings", async ({
  page,
  request,
}) => {
  // one over then "Close innings", each a held dispatch (queue.ts's
  // HOLD_MS soft-commit) the ledger polls below wait out.
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
    { name: "T20", sport_key: "cricket", variant_key: "t20", config: {} },
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
  // order) — the coarse summary action (`cricket.innings.summary`) rides
  // R2b's dedicated over tile (it moved off the "More" sheet)
  // and is this fixture's one scoring surface, and is a closer v2/v3
  // analogue of "over-by-over" than ball-by-ball would be anyway: a single
  // aggregate entry per over, exactly this test's own name.
  const scorebug = pad(page).locator('[data-role="v3-scorebug"]');
  await expect(scorebug).toBeVisible({ timeout: 20_000 });
  await expect(scorebug).toContainText("0/0");

  // record one over: 12 runs, 1 wicket, 6 legal balls — through R2b's
  // dedicated over tile, NOT More → "Innings total". R2b gave
  // `cricket.innings.summary` its own guided sheet, and
  // `dedicatedEventTypes` (v3/pad-host.tsx:141-151) filters every sheet's
  // event out of the More list, so the generic entry point is gone by
  // design. The tile is what this test's own name has always described.
  //
  // Three steps, each a PER-OVER delta (owner's Q2 reversal, `_INDEX.md`):
  // against this empty fold the numbers match the old total-shaped form's,
  // and the assertions below are unchanged. Under load a fill can land
  // before React hydrates (DOM value set, state empty → Confirm stays
  // disabled), so re-fill until the pad actually accepts the input.
  const sheet = pad(page).locator('[data-role="v3-sheet"]');
  const confirm = sheet.getByRole("button", { name: "Confirm", exact: true });
  await pad(page).locator('[data-tile-id="overSummary"]').click();
  for (const [label, value] of [
    ["Runs this over", "12"],
    ["Wickets this over", "1"],
    ["Balls this over", "6"],
  ] as const) {
    const field = sheet.getByRole("spinbutton", { name: label });
    await expect(async () => {
      await field.fill(value);
      await expect(field).toHaveValue(value, { timeout: 1_000 });
      await expect(confirm).toBeEnabled({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await confirm.click();
  }
  await expect(sheet, "the wizard's own last step closes the sheet").not.toBeVisible({ timeout: 10_000 });

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
