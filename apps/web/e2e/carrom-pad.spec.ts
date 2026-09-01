import { test, expect } from "@playwright/test";
import { TAG, apiJson, addEntrantsViaApi, createStageAndGenerate, expectNoHorizontalScroll } from "./helpers";
import { HOLD_MS } from "../src/components/v2/scorepad/queue";

// S13/#422 W11 cutover — re-anchored off v1's own CarromPad copy. R7/A3
// re-anchors AGAIN: carrom left the universal renderer for its own v3 skin
// (`v3/skins/carrom.tsx`, tapModel T), and this file used to drive that
// renderer's spec-driven default form — `data-attribution-path` pickers and
// a `data-role="confirm"` button neither exist on the v3 pad, which is
// exactly what would have made every assertion below time out unchanged.
//
// The regression this file protects, restated once more for what the fix
// actually is now: on v1, carrom was UNSCOREABLE over a device link at all.
// S13 fixed that; R7/A3 is a UI rewrite of the SAME scoring surface, not a
// new regression to guard — this test still proves a real device link can
// score a real carrom board, end to end, against whichever renderer is
// live today.
test("carrom fixture scores a queen-covered board over a real device link", async ({ page, request }) => {
  test.setTimeout(120_000);

  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Carrom ${TAG}`,
    ends_on: "2030-12-31",
    visibility: "public",
  });
  expect(comp.status, `create competition: ${JSON.stringify(comp.error)}`).toBe(201);

  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    { name: "Boards", sport_key: "carrom", variant_key: "icf", config: {} },
  );
  expect(div.status, `create division: ${JSON.stringify(div.error)}`).toBe(201);
  const divisionId = div.data!.id;

  const entrants = await addEntrantsViaApi(request, divisionId, ["Meena", "Ravi"]);
  expect(entrants.status, "add entrants").toBe(201);

  const { fixtureIds } = await createStageAndGenerate(request, divisionId, { kind: "league", name: "League" });
  expect(fixtureIds.length, "a 2-entrant league generates exactly one fixture").toBe(1);
  const fixtureId = fixtureIds[0]!;
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");

  // Read the real home entrant id back off the fixture rather than assuming
  // entrant-creation order — generation is free to assign home/away by seed,
  // not by POST order (the convention every other roster-aware spec in this
  // suite follows, e.g. helpers.ts's own `seedRosteredFixture`).
  const fx = await apiJson<{ home_entrant_id: string | null }>(request, `/api/v1/fixtures/${fixtureId}`);
  expect(fx.status, "read fixture").toBe(200);
  const homeId = fx.data!.home_entrant_id;
  if (!homeId) throw new Error(`fixture ${fixtureId} has no home entrant`);

  const minted = await apiJson<{ secret: string }>(
    request,
    `/api/v1/fixtures/${fixtureId}/device-links`,
    "POST",
    { label: `Carrom ${TAG}` },
  );
  expect(minted.status, `mint device link: ${JSON.stringify(minted.error)}`).toBe(201);

  // Phone viewport: the pad and its timeline must hold 390px without page-
  // level horizontal scroll (v3/02 gate) — the same width the v1 regression
  // this test replaces was originally measured at.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/score/${minted.data!.secret}`);

  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await expect
    .poll(
      async () => {
        const res = await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
        return (res.data ?? []).map((e) => e.type);
      },
      { timeout: 20_000 },
    )
    .toContain("core.start");

  // "Start match" is chrome OUTSIDE the pad (device-score-pad.tsx's own
  // `send`, a plain fetch never routed through the pad's own pipeline), and
  // the pad's fold was seeded once from the page's SSR snapshot taken BEFORE
  // this click. A same-tick tap on the still-"pre" fold 422s exactly like the
  // gap scorepad-skins.spec.ts's file header documents for the old harness.
  // A reload re-renders the page server-side with the now-current ledger
  // baked into a fresh `initialEvents` — the reliable way this suite
  // observes a settled phase transition (same technique as
  // scorepad-skins.spec.ts / scorepad-offline.spec.ts's own reload step).
  await page.reload();

  // v3's own pad root — the ONE test hook present on every route this pad
  // ever renders on, unlike `[data-testid="score-pad"]` (fixture-console.tsx
  // only, never the device-link page this spec actually visits).
  const pad = page.locator('[data-role="pad-v3"]');
  await expect(pad, "the v3 pad must mount on the device-link route").toBeVisible({ timeout: 20_000 });

  // "Board (queen covered)" is now a dedicated TILE (`v3/skins/carrom.tsx`,
  // `data-tile-id="boardQueen"`) that opens a guided SHEET — winner, then
  // queenTo (an INDEPENDENT side: Law 53(b)/(c) lets the queen be covered by
  // the side that did NOT win the board), then the coins field. Same side
  // for both answers here so the queen bonus is actually credited.
  const boardQueen = pad.locator('[data-tile-id="boardQueen"]');
  await expect(boardQueen, "the boardQueen tile must be reachable live").toBeVisible({ timeout: 20_000 });
  await boardQueen.click();

  const sheet = pad.locator('[data-role="v3-sheet"]');
  await expect(sheet, "the boardQueen tile must open the guided sheet").toBeVisible({ timeout: 10_000 });
  await sheet.locator('[data-choice-option-id="home"]').click(); // winner
  await expect(
    sheet.locator('[data-choice-option-id="home"]'),
    "the queenTo step must follow the winner step, offering the same two sides",
  ).toBeVisible({ timeout: 10_000 });
  await sheet.locator('[data-choice-option-id="home"]').click(); // queenTo

  const coinsField = sheet.getByLabel("Opponent's coins left", { exact: true });
  await expect(coinsField, "the coins step must render a numeric field").toBeVisible({ timeout: 10_000 });
  await coinsField.fill("4");
  await sheet.getByRole("button", { name: "Confirm", exact: true }).click();

  // The board reached the REAL ledger — coins 4 x pointsPerCoin(1) + queen 3
  // (queenCapAt 22, unreached) = 7 banked to Meena's side — the server's own
  // fold accepted it, not merely that a local promise resolved.
  await expect
    .poll(
      async () => {
        const res = await apiJson<{ type: string }[]>(request, `/api/v1/fixtures/${fixtureId}/events?since_seq=0`);
        return (res.data ?? []).filter((e) => e.type === "carrom.board.summary").length;
      },
      { timeout: 20_000 },
    )
    .toBe(1);
  const ledger = await apiJson<{ type: string; payload: Record<string, unknown> }[]>(
    request,
    `/api/v1/fixtures/${fixtureId}/events?since_seq=0`,
  );
  const board = ledger.data!.find((e) => e.type === "carrom.board.summary")!;
  expect(board.payload.winner, "winner must be the real entrant clicked, not a synthetic id").toBe(homeId);
  expect(board.payload.opponentCoinsLeft).toBe(4);
  expect(board.payload.queenTo, "queen covered by the same side that won the board").toBe(homeId);

  // And it is ON SCREEN, through the v3 ribbon strip — the pad's own
  // always-on history element (`[data-role="v3-ribbon"]`, pad-host.tsx).
  //
  // THIS is the assertion the wave's own defect class exists for: `padLabel`
  // (scoring-vocab.ts) prints the RAW dotted key verbatim when a ribbon key
  // is not registered in `PAD_LABEL_KEYS` — carrying real copy in all four
  // dictionaries is not enough on its own (boardgame shipped exactly that
  // gap once, past i18n parity, the generated key union, tsc, lint and
  // 13000+ unit tests, caught only by a screenshot). A raw key or an
  // unresolved template brace anywhere on this screen is the same defect,
  // caught live rather than assumed fixed by the unit suite.
  const ribbon = pad.locator('[data-role="v3-ribbon"]');
  await expect(ribbon, "a committed board must leave a ribbon line").toBeVisible({ timeout: HOLD_MS + 5_000 });
  await expect(ribbon, "the ribbon must show carrom's own sentence, not the generic fallback").toContainText(
    "Board recorded",
  );
  await expect(ribbon, "the ribbon must state the coins fragment in real words").toContainText("coin");
  const bodyText = await page.locator("body").innerText();
  expect(bodyText, "no raw pad.carrom.* key ever reaches the screen").not.toMatch(/pad\.carrom\.[a-zA-Z.]+/);
  expect(bodyText, "no unresolved i18n template brace reaches the screen").not.toMatch(/\{[a-zA-Z]+\}/);

  await expect(page.getByText(/unknown event/i)).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});
