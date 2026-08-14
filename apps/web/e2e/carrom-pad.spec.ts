import { test, expect } from "@playwright/test";
import { TAG, apiJson, addEntrantsViaApi, createStageAndGenerate, expectNoHorizontalScroll } from "./helpers";

// S13/#422 W11 cutover — re-anchored off v1's own CarromPad copy ("Board won
// by", "Opponent coins left" as a component's own label, "Record board", a
// "Games" table), none of which the universal renderer produces. carrom has
// no bespoke v2 skin — skins/registry.ts's own comment: it "stays on the
// universal renderer DELIBERATELY" — so this drives the spec-driven default
// PadRenderer (carrom.ts's own `padSpec`) rather than a hand-crafted pad.
//
// The regression this protects, restated for what the fix actually is now:
// on v1, carrom was UNSCOREABLE over a device link at all — device-score-
// pad.tsx had no carrom branch, so every submit fell through to the generic
// pad and 422'd with `unknown event type "generic.result"` (organiser
// report 2026-07-10). S13 deleted that whole v1 dispatcher; its replacement
// (device-score-pad.tsx's own comment) is explicit that "this dispatcher
// never had a carrom branch at all, so carrom is scoreable over a device
// link for the first time as of this cutover" — this test proves exactly
// that claim against a real device link and a real ledger, not merely that
// a route renders.
test("carrom fixture scores a board over a real device link", async ({ page, request }) => {
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

  // carrom's padSpec (carrom.ts) declares no "Start match"/"Board won by"
  // copy of its own — "Board (no queen)" / "Board (queen covered)" are its
  // own action labels, and the universal renderer's default phase tab is
  // already "live" (pad-renderer.tsx), so both are visible with no extra tab
  // tap once the match is live.
  const boardQueen = page.getByRole("button", { name: "Board (queen covered)", exact: true });
  await expect(boardQueen).toBeVisible({ timeout: 20_000 });
  await boardQueen.click();

  // `opponentCoinsLeft` has no declared labelKey, so the renderer captions it
  // from its own path (view-model.ts's `deriveFieldPathLabel`:
  // "opponentCoinsLeft" -> "Opponent coins left") — coincidentally close to
  // v1 CarromPad's own form copy, but produced by a different mechanism this
  // time, not a moved assertion.
  await page.getByLabel("Opponent coins left", { exact: true }).fill("4");
  // Two independent side pickers on this one form share the SAME "Home"/
  // "Away" button vocabulary (attribution-picker.tsx's fixed copy) — scoped
  // by each item's own `data-attribution-path` (winner vs queenTo, the
  // component's existing hook, not a testid added for this test) so each
  // click lands on its own picker rather than tripping Playwright's
  // strict-mode ambiguity.
  await page.locator('[data-attribution-path="winner"]').getByRole("button", { name: "Home", exact: true }).click();
  await page.locator('[data-attribution-path="queenTo"]').getByRole("button", { name: "Home", exact: true }).click();
  await page.locator('[data-role="confirm"]').click();

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

  // And it is ON SCREEN, in the pad's own always-rendered activity feed
  // (pad-renderer.tsx renders <Timeline> unconditionally — there is no
  // per-sport skin here to draw a bespoke scoreboard instead). "Board
  // summary" is event-copy.ts's own badge for this event type; no "Board won
  // by" copy exists anywhere in v2.
  const timeline = page.locator('[data-role="timeline"]');
  await expect(timeline).toBeVisible();
  await expect(timeline).toContainText("Board summary");
  await expect(timeline).toContainText("opponentCoinsLeft: 4");
  await expect(page.getByText(/unknown event/i)).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});
