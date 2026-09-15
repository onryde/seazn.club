/**
 * Task 9 — chess external-play UI regression:
 * - OTB (onlinePlay absent): public fixture page has no Play CTA; pad still loads.
 * - Online ready bridge: public page shows Play on Lichess CTA.
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
  await expect(page.getByTestId("external-play-cta")).toHaveCount(0);
  await expect(page.getByTestId("external-play-waiting")).toHaveCount(0);

  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(page.locator('[data-testid="score-pad"]')).toBeVisible({ timeout: 20_000 });
});

test("ready bridge: public fixture page shows Play on Lichess CTA", async ({ page }) => {
  test.setTimeout(120_000);
  const fx = await seedRosteredFixture(page.request, {
    label: `EP Ready ${TAG}`,
    sportKey: "boardgame",
    variantKey: "classical",
    entrantKind: "individual",
    home: [{ fullName: `EP Ready Home ${TAG}` }],
    away: [{ fullName: `EP Ready Away ${TAG}` }],
    emitCoreStart: false,
  });

  await seedFixtureExternalPlaySql(fx.fixtureId, {
    status: "ready",
    playUrl: "https://lichess.org/e2eReadyGame",
    externalChallengeId: "e2eReadyGame",
  });

  const pub = await sharedPath(page.request, fx.competitionId, fx.divisionId, fx.fixtureId);
  await page.goto(pub);
  const cta = page.getByTestId("external-play-cta");
  await expect(cta).toBeVisible({ timeout: 20_000 });
  await expect(cta).toHaveAttribute("href", "https://lichess.org/e2eReadyGame");
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
    lastError: "e2e-needs-organiser",
    externalChallengeId: "e2eNeedsOrg",
  });

  await page.goto(await divisionPath(page.request, fx.divisionId));
  await expect(page.getByTestId("external-play-needs-result-queue")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId(`external-play-queue-row-${fx.fixtureId}`)).toBeVisible();

  await page.getByTestId("external-play-resolve-draw").click();
  await expect(page.getByTestId(`external-play-queue-row-${fx.fixtureId}`)).toHaveCount(0, {
    timeout: 20_000,
  });

  const state = await apiJson<{ status: string }>(
    page.request,
    `/api/v1/fixtures/${fx.fixtureId}/state`,
  );
  expect(state.status).toBe(200);
  expect(state.data?.status).toBe("decided");
});
