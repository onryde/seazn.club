import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  TAG,
  apiJson,
  activeOrg,
  addEntrantsViaApi,
  createStageAndGenerate,
  setFixtureStatusSql,
  setStageStatusSql,
} from "./helpers";

async function seed(request: APIRequestContext) {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Desk ${TAG} ${Math.random().toString(36).slice(2, 6)}`, visibility: "public", ends_on: "2030-12-31",
  });
  const div = await apiJson<{ id: string; slug: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Premier", sport_key: "football", variant_key: "11-a-side",
  });
  await addEntrantsViaApi(request, div.data!.id, ["Riverside FC", "Valley CC", "Lakeside FC", "Harbour CC"], "team");
  const { stageId, fixtureIds } = await createStageAndGenerate(request, div.data!.id);
  await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  return { compId: comp.data!.id, compSlug: comp.data!.slug, divSlug: div.data!.slug, stageId, fixtureIds };
}

test.describe("competition desk", () => {
  test("unscheduled league: Needs you names the gap and the ledger row is scheduled, not live", async ({ page, request }) => {
    const org = await activeOrg(page);
    const rig = await seed(request);
    await page.goto(`/o/${org.slug}/c/${rig.compSlug}`);
    const needs = page.getByTestId("desk-needs-you");
    await expect(needs.locator('[data-attention="unscheduled"]')).toHaveCount(1);
    await expect(needs).toContainText(`Premier · ${rig.fixtureIds.length} fixtures unscheduled`);
    const row = page.getByTestId("desk-ledger-row").first();
    await expect(row).toHaveAttribute("data-phase", "scheduled");
    await expect(row).not.toContainText("Nothing scheduled yet");
    await expect(page.getByText("Live", { exact: true })).toHaveCount(0);
    await needs.getByRole("link", { name: "Open schedule board" }).click();
    await expect(page).toHaveURL(new RegExp(`/d/${rig.divSlug}/schedule$`));
  });

  test("in play with no events: No scorer leads and the competition pill counts it", async ({ page, request }) => {
    const org = await activeOrg(page);
    const rig = await seed(request);
    await setFixtureStatusSql(rig.fixtureIds[0]!, "in_play");
    await page.goto(`/o/${org.slug}/c/${rig.compSlug}`);
    const first = page.getByTestId("desk-needs-you").locator("[data-attention]").first();
    await expect(first).toHaveAttribute("data-attention", "no_scorer");
    // The division ledger row renders its PhasePill twice (mobile card +
    // desktop row, one hidden by CSS per width, per division-ledger.tsx) — a
    // bare `.first()` resolves the mobile-hidden copy at this project's
    // desktop viewport and reads as a failure. `:visible` picks whichever
    // copy actually renders here, the same fix registration-hub.spec.ts's
    // `statusLocator` uses for the identical dual-DOM shape.
    await expect(page.locator('[data-pill="no_scorer"]:visible').first()).toBeVisible();
    await expect(page.locator('[data-phase="in_play"]').first()).toContainText("1 in play");
  });

  test("all decided: finished, no Needs you section at all", async ({ page, request }) => {
    const org = await activeOrg(page);
    const rig = await seed(request);
    await setStageStatusSql(rig.stageId, "complete");
    for (const id of rig.fixtureIds) await setFixtureStatusSql(id, "decided");
    await page.goto(`/o/${org.slug}/c/${rig.compSlug}`);
    await expect(page.getByTestId("desk-ledger-row").first()).toHaveAttribute("data-phase", "finished");
    await expect(page.getByTestId("desk-needs-you")).toHaveCount(0);
  });
});
