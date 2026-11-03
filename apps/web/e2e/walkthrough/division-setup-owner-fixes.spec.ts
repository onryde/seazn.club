import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, addEntrantsViaApi, apiJson, divisionPath, expectNoHorizontalScroll, stageCardOf } from "../helpers";
import { dismissCookieBanner } from "../scorepad-a11y-kit";
import { uiEn } from "../match-room-kit";
import { escapeRe } from "../helpers/stage-summary";

/**
 * UI5 (owner, demo of 2026-11-03): four fixes to the division page, WALKED by an organiser. The owner's rule (2026-11-01): every
 * event under test is tapped, the API only reaches a state, each walk runs to its terminal state and reads back what a person
 * sees. At the walkthrough project's 1280, on the shared Pro organisation, one competition per test.
 *
 *   1. The "Starting locks the setup" banner is gone from the Fixtures tab of a division being set up. The lock is still said
 *      where it always was: the Start dialog names it, and after Start the Entrants tab says the list is locked.
 *   2. "Entrant kinds" on the Entrants tab starts CLOSED, always - an empty division included (it used to open there). A tap
 *      opens it, and a reload folds it again.
 *   3. One person, one team per division. Ada is on Red: the add form's picker does not suggest her, a search shows her
 *      disabled and labelled "On Red", and a team with someone else saves. The server refuses the write the picker would not
 *      offer (409 PERSON_ON_OTHER_TEAM), and another division takes her.
 *
 * Every string asserted is read from the dictionary (`uiEn`), except the removed banner's own title, which no dictionary holds
 * any more (that is the point) and is spelled out once below. Budgets are derived from the navigations and taps (class 20).
 * One sport (generic) for item 1 on purpose: the banner was drawn the same way for every sport.
 */

const NAV_MS = 20_000;
const ACT_MS = 4_000;
const SEED_MS = 45_000;
const budget = (navs: number, acts: number): number => SEED_MS + navs * NAV_MS + acts * ACT_MS;

/** The removed banner's English title, as `tips.division.start-locks.title` said it until UI5. */
const REMOVED_BANNER_TITLE = "Starting locks the setup";

/** A not-started generic division with no stage: the Entrants tab's own state. */
async function seedDivision(request: APIRequestContext, label: string): Promise<{ competitionId: string; divisionId: string }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `UI5 ${label} ${TAG}`, visibility: "private" });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: label,
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  return { competitionId: comp.data!.id, divisionId: div.data!.id };
}

async function seedLeague(request: APIRequestContext, label: string, entrants: string[]): Promise<{ divisionId: string; stageId: string }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `UI5 ${label} ${TAG}`, visibility: "private" });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: label,
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  const ents = await addEntrantsViaApi(request, div.data!.id, entrants.map((n) => `${n} ${TAG}`));
  expect(ents.ids, "entrants").toHaveLength(entrants.length);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${div.data!.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" });
  expect(stage.status, `stage: ${JSON.stringify(stage.error)}`).toBeLessThan(300);
  const gen = await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
  expect(gen.status, `generate: ${JSON.stringify(gen.error)}`).toBeLessThan(300);
  return { divisionId: div.data!.id, stageId: stage.data!.id };
}

test.describe("UI5: the division page's owner fixes, walked", () => {
  test("1. no start-locks banner while setting up; Start still names the lock, and the Entrants tab says it after", async ({ page, request }) => {
    test.setTimeout(budget(3, 6));
    const { divisionId, stageId } = await seedLeague(request, "Banner", ["Ana", "Ben", "Cy", "Di"]);
    const base = await divisionPath(request, divisionId);

    // The state the banner used to show in: an organiser, the division set up (not started), a stage built, nothing played.
    await page.goto(`${base}?tab=fixtures`, { waitUntil: "load" });
    await dismissCookieBanner(page);
    await expect(stageCardOf(page, stageId), "the stage card is on the Fixtures tab (the loaded page)").toBeVisible({ timeout: NAV_MS });
    await expect(page.getByTestId("launch-start-division"), "premise: the division is not started").toBeVisible();
    await expect(page.getByText(REMOVED_BANNER_TITLE), "no start-locks banner").toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // The lock is still said where it belongs: the Start dialog names it, before anything is started.
    await page.getByTestId("launch-start-division").click();
    const dialog = page.getByTestId("start-confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("start-confirm-format-locks")).toHaveText(uiEn["launch.confirm.formatLocksNow"]!);
    await dialog.getByTestId("start-confirm-confirm").click();
    await expect(page.getByTestId("launch-start-division"), "started: no Start button").toHaveCount(0, { timeout: NAV_MS });

    // Terminal state: started. The Entrants tab says the list is locked, and the Fixtures tab still has no banner.
    await page.goto(`${base}?tab=entrants`, { waitUntil: "load" });
    await expect(page.getByTestId("entrants-roster-locked")).toHaveText(uiEn["entrants.locked.note"]!, { timeout: NAV_MS });
    await page.goto(`${base}?tab=fixtures`, { waitUntil: "load" });
    await expect(stageCardOf(page, stageId)).toBeVisible({ timeout: NAV_MS });
    await expect(page.getByText(REMOVED_BANNER_TITLE)).toHaveCount(0);
  });

  test("2. Entrant kinds starts closed on an empty division, opens on a tap, and is closed again after a reload", async ({ page, request }) => {
    test.setTimeout(budget(2, 3));
    const { divisionId } = await seedDivision(request, "Kinds");
    const base = await divisionPath(request, divisionId);
    const toggle = page.getByRole("button", { name: new RegExp(`^${escapeRe(uiEn["divset.entrants.kinds"]!)}`) });

    await page.goto(`${base}?tab=entrants`, { waitUntil: "load" });
    await dismissCookieBanner(page);
    await expect(toggle, "the kinds header is on the Entrants tab").toBeVisible({ timeout: NAV_MS });
    await expect(page.getByRole("heading", { name: uiEn["entrants.add.title"]! }), "premise: no entrant yet, the add form is there").toBeVisible();
    await expect(toggle, "an empty division: closed").toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("entrant-kinds"), "folded: no body").toHaveCount(0);
    await expectNoHorizontalScroll(page);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("entrant-kinds"), "opened by the tap").toBeVisible();

    // Terminal state: a reload starts closed again - nothing remembers it open.
    await page.goto(`${base}?tab=entrants`, { waitUntil: "load" });
    await expect(toggle).toBeVisible({ timeout: NAV_MS });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("entrant-kinds")).toHaveCount(0);
  });

  test("3. one person, one team per division: the picker shows Ada on Red and will not take her; the server refuses her too", async ({ page, request }) => {
    test.setTimeout(budget(2, 8));
    const { competitionId, divisionId } = await seedDivision(request, "Teams");
    const base = await divisionPath(request, divisionId);
    const personOf = async (name: string) => {
      const p = await apiJson<{ id: string }>(request, "/api/v1/persons", "POST", { full_name: `${name} ${TAG}` });
      expect(p.status, `person ${name}: ${JSON.stringify(p.error)}`).toBeLessThan(300);
      return { id: p.data!.id, name: `${name} ${TAG}` };
    };
    const ada = await personOf("Ada Onteam");
    const bo = await personOf("Bo Free");
    const red = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [
      { kind: "team", display_name: `Red ${TAG}`, members: [{ person_id: ada.id, is_captain: false, roles: [] }] },
    ]);
    expect(red.status, `Red: ${JSON.stringify(red.error)}`).toBeLessThan(300);

    await page.goto(`${base}?tab=entrants`, { waitUntil: "load" });
    await dismissCookieBanner(page);
    const search = page.getByPlaceholder(uiEn["entrants.add.searchPlayers"]!);
    await expect(search, "the add form's player search").toBeVisible({ timeout: NAV_MS });

    // Searched by name, Ada is found - disabled, and labelled with the team that holds her.
    await search.fill("Ada Onteam");
    const adaChip = page.locator(`[data-person="${ada.id}"]`);
    await expect(adaChip).toBeVisible();
    await expect(adaChip).toBeDisabled();
    await expect(adaChip).toContainText(uiEn["entrants.add.onOtherTeam"]!.replace("{team}", `Red ${TAG}`));
    await expectNoHorizontalScroll(page);

    // Bo, held by nobody, picks: the positive pair, in the same form.
    await search.fill("Bo Free");
    const boChip = page.locator(`[data-person="${bo.id}"]`);
    await boChip.click();
    await expect(boChip).toHaveAttribute("aria-pressed", "true");

    // The write the picker would not offer: the server refuses it by code, naming Ada and Red, and writes nothing.
    const refused = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", [
      { kind: "team", display_name: `Blue ${TAG}`, members: [{ person_id: ada.id, is_captain: false, roles: [] }] },
    ]);
    expect(refused.status).toBe(409);
    expect(refused.error?.code).toBe("PERSON_ON_OTHER_TEAM");
    expect((refused.error as { conflicts?: { person_id: string; entrant_name: string }[] }).conflicts).toEqual([
      expect.objectContaining({ person_id: ada.id, entrant_name: `Red ${TAG}` }),
    ]);
    // Another division of the same competition takes her.
    const other = await apiJson<{ id: string }>(request, `/api/v1/competitions/${competitionId}/divisions`, "POST", {
      name: "Teams B",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    const elsewhere = await apiJson(request, `/api/v1/divisions/${other.data!.id}/entrants`, "POST", [
      { kind: "team", display_name: `Red B ${TAG}`, members: [{ person_id: ada.id, is_captain: false, roles: [] }] },
    ]);
    expect(elsewhere.status, `another division: ${JSON.stringify(elsewhere.error)}`).toBeLessThan(300);

    // Terminal state, reloaded: still exactly one entrant here, and Ada still shows as Red's.
    await page.goto(`${base}?tab=entrants`, { waitUntil: "load" });
    await search.fill("Ada Onteam");
    await expect(page.locator(`[data-person="${ada.id}"]`)).toBeDisabled({ timeout: NAV_MS });
    const listed = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`);
    expect(listed.data?.length, "the refused Blue was never written").toBe(1);
  });
});
