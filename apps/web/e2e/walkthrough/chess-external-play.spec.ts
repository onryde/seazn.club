/**
 * Task 9 — chess external-play UI regression:
 * - OTB (onlinePlay absent): the public fixture page has no watch panel and no
 *   Your board door; the pad still loads.
 * - A live online board (T16): the public page WATCHES the game here — the
 *   position from the ledger, view-only — and links to NO Lichess game
 *   (D3 deleted the lichess.org mode).
 * - needs_organiser: division queue visible and resolve settles the fixture.
 */
import { test, expect } from "@playwright/test";
import {
  apiJson,
  divisionPath,
  fixturePath,
  seedFixtureExternalPlaySql,
  seedRosteredFixture,
  TAG,
} from "../helpers";
import { publicFixturePath } from "../spectator-public-helpers";
import { seedGameSql, seedMatchRoom } from "../match-room-kit";

test.describe.configure({ mode: "parallel" });

async function sharedPath(
  request: import("@playwright/test").APIRequestContext,
  competitionId: string,
  divisionId: string,
  fixtureId: string,
): Promise<string> {
  const org = await apiJson<{ id: string; slug: string }[]>(request, "/api/orgs");
  const comp = await apiJson<{ org_id: string; slug: string }>(
    request,
    `/api/v1/competitions/${competitionId}`,
  );
  const div = await apiJson<{ slug: string }>(request, `/api/v1/divisions/${divisionId}`);
  expect(comp.status).toBe(200);
  expect(div.status).toBe(200);
  const orgSlug = org.data?.find((o) => o.id === comp.data!.org_id)?.slug;
  expect(orgSlug, "org slug for competition").toBeTruthy();
  return publicFixturePath(orgSlug!, comp.data!.slug, div.data!.slug, fixtureId);
}

test("OTB boardgame: no Play CTA on public page; console pad still mounts", async ({ page }) => {
  test.setTimeout(120_000);
  const homeName = `EP OTB Home ${TAG}`;
  const awayName = `EP OTB Away ${TAG}`;
  const fx = await seedRosteredFixture(page.request, {
    label: `EP OTB ${TAG}`,
    sportKey: "boardgame",
    variantKey: "classical",
    entrantKind: "individual",
    home: [{ fullName: homeName }],
    away: [{ fullName: awayName }],
    emitCoreStart: true,
  });

  const pub = await sharedPath(page.request, fx.competitionId, fx.divisionId, fx.fixtureId);
  await page.goto(pub);
  await expect(page.locator("main"), "the match centre rendered").toContainText(`EP OTB ${TAG}`, { timeout: 20_000 });
  // Over the board: nothing online to watch, no door to a room (the positive
  // pair is the next test, on an online division).
  await expect(page.getByTestId("watch-panel")).toHaveCount(0);
  await expect(page.getByTestId("your-board")).toHaveCount(0);

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(page.locator('[data-testid="score-pad"]')).toBeVisible({ timeout: 20_000 });
});

test("a live online board: the public page watches the game here and links to no Lichess game", async ({ page }) => {
  test.setTimeout(120_000);
  const room = await seedMatchRoom(page.request, { names: [`EP Live Home ${TAG}`, `EP Live Away ${TAG}`] });
  // Four legal plies, judged by chess.js in the kit; the FEN is the rules', not the page's.
  const { fen } = await seedGameSql(room, { moves: ["e2e4", "e7e5", "g1f3", "b8c6"] });

  const res = await page.goto(room.fixturePath);
  expect(res?.status(), "the public fixture page renders with a game on file").toBe(200);
  await expect(page.getByTestId("watch-panel")).toHaveAttribute("data-state", "live", { timeout: 20_000 });
  await expect(page.getByTestId("watch-board")).toBeAttached();
  await expect(page.getByTestId("room-board-surface")).toHaveAttribute("data-fen", fen);
  await expect(page.getByTestId("room-board-surface")).toHaveAttribute("data-view-only", "true");
  await expect(page.locator('a[href*="lichess.org"]')).toHaveCount(0);
});

test("needs_organiser queue: organiser can resolve from division page", async ({ page }) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `EP Queue ${TAG}`,
    sportKey: "boardgame",
    variantKey: "classical",
    entrantKind: "individual",
    home: [{ fullName: `EP Queue Home ${TAG}` }],
    away: [{ fullName: `EP Queue Away ${TAG}` }],
    emitCoreStart: false,
  });

  await seedFixtureExternalPlaySql(fx.fixtureId, {
    status: "needs_organiser",
    needsReason: "provider_error",
    lastError: "e2e-needs-organiser",
    challengeId: `e2eNeedsOrg-${TAG}`,
  });

  await page.goto(await divisionPath(page.request, fx.divisionId));
  await expect(page.getByTestId("external-play-needs-result-queue")).toBeVisible({
    timeout: 20_000,
  });
  const row = page.getByTestId(`external-play-queue-row-${fx.fixtureId}`);
  await expect(row).toBeVisible();
  // T16: the four outcomes sit behind the card's "Settle" toggle (canvas HoldQueue).
  await row.getByTestId("external-play-settle-toggle").click();
  await row.getByTestId("external-play-resolve-draw").click();
  await expect(page.getByTestId(`external-play-queue-row-${fx.fixtureId}`)).toHaveCount(0, {
    timeout: 20_000,
  });

  const state = await apiJson<{ status: string; outcome: { kind?: string } | null }>(
    page.request,
    `/api/v1/fixtures/${fx.fixtureId}/state`,
  );
  expect(state.status).toBe(200);
  expect(state.data?.status).toBe("decided");
  expect(state.data?.outcome).toMatchObject({ kind: "draw" });
});
