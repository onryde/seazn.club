import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { apiJson, TAG, divisionPath, expectNoHorizontalScroll } from "./helpers";
import { waitForHydration } from "./directory-kit";

// W5 B4 review I-3: the results grid is drawn in the browser the first time its disclosure opens (`ResultsGridDisclosure`,
// results-grid.tsx; stress S4 took the n x n table out of every page load). Its open -> draw seam had no browser witness - the
// unit suite runs in node and calls the handler by hand - and a tap BEFORE hydration opened the <details> natively while React
// was not yet listening for `toggle` (not an event React replays): a natively open, empty disclosure, until closed and opened
// again. On the pages S4 targets (megabytes of HTML) that window is long on a phone.
//
// What this drives, on both pages that mount the grid (the spectator's `/live/...` and the organiser's `/o/.../d/...`) and both
// round-robin kinds that draw one (a Swiss and a league): closed, no table; opened by a click and by the keyboard, one row per
// entrant. And the tap before hydration, made deterministic by HOLDING the page's scripts until the tap has landed (the disclosure
// carries no React keys at that moment - asserted, so the case cannot quietly become a tap after hydration). That case runs on the
// ORGANISER page: it renders `?tab=standings` on the server, so the disclosure is tappable before React; the spectator page renders
// its first tab on the server and switches to Standings only once hydrated (public-site/tabs.tsx, for ISR), so the grid is hidden
// there until React is in. A ladder draws no grid at all (no standings snapshot; b4-report S4). Expected row counts are the fields
// this spec seeds, never a count the page reports. Desktop project (a spec outside e2e/mobile/); the held-script case runs at 320,
// the width the window matters at.
const GENERIC_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

async function seededDivision(request: APIRequestContext, label: string, n: number) {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `${label} ${TAG}`, visibility: "public" });
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", { name: label, sport_key: "generic", variant_key: "score", config: GENERIC_CONFIG });
  expect(div.status, JSON.stringify(div.error)).toBe(201);
  const divisionId = div.data!.id;
  const ents = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${divisionId}/entrants`, "POST", Array.from({ length: n }, (_, i) => ({ kind: "individual", display_name: `${label} P${i + 1}`, seed: i + 1 })));
  expect(ents.status, JSON.stringify(ents.error)).toBe(201);
  return { divisionId, entrants: ents.data! };
}

/** A started Swiss with round 1 paired: `n` seeded entrants, its grid `n` rows. */
async function swiss(request: APIRequestContext, n: number) {
  const { divisionId } = await seededDivision(request, "Grid Swiss", n);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "swiss", name: "Swiss", config: { rounds: 3 } });
  expect(stage.status, JSON.stringify(stage.error)).toBe(201);
  expect((await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST")).status).toBe(200);
  const paired = await apiJson(request, `/api/v1/stages/${stage.data!.id}/generate`, "POST");
  expect(paired.status, JSON.stringify(paired.error)).toBe(200);
  return divisionId;
}

/** A started league: `n` seeded entrants, its grid `n` rows. */
async function league(request: APIRequestContext, n: number) {
  const { divisionId } = await seededDivision(request, "Grid League", n);
  const stage = await apiJson<{ id: string }>(request, `/api/v1/divisions/${divisionId}/stages`, "POST", { seq: 1, kind: "league", name: "League", config: { legs: 1 } });
  expect(stage.status, JSON.stringify(stage.error)).toBe(201);
  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, JSON.stringify(started.error)).toBe(200);
  return divisionId;
}

/** The spectator's page for a division: `/live/{org}/{comp}/{div}`, from the organiser's `/o/{org}/c/{comp}/d/{div}`. */
async function livePath(request: APIRequestContext, divisionId: string) {
  const m = /^\/o\/([^/]+)\/c\/([^/]+)\/d\/([^/?]+)/.exec(await divisionPath(request, divisionId));
  expect(m, "premise: the organiser path has the org, competition and division slugs").not.toBeNull();
  return `/live/${m![1]}/${m![2]}/${m![3]}`;
}

const disclosure = (page: Page) => page.locator("details[data-results-grid]").first();
const gridRows = (page: Page) => page.locator("[data-results-matrix] tbody tr");

test.describe("the results grid draws when its disclosure opens (B4 review I-3)", () => {
  const N = 6;

  test("a Swiss and a league, on the spectator's and the organiser's page: closed draws nothing; a click and the keyboard each draw one row per entrant", async ({ page, request }) => {
    test.setTimeout(240_000);
    const swissId = await swiss(request, N);
    const leagueId = await league(request, N);
    const pages = [
      { name: "public Swiss", url: `${await livePath(request, swissId)}?tab=standings` },
      { name: "organiser Swiss", url: await divisionPath(request, swissId, "?tab=standings") },
      { name: "public league", url: `${await livePath(request, leagueId)}?tab=standings` },
      { name: "organiser league", url: await divisionPath(request, leagueId, "?tab=standings") },
    ];
    let checked = 0;
    for (const p of pages) {
      for (const how of ["click", "keyboard"] as const) {
        await page.goto(p.url, { waitUntil: "load" });
        const details = disclosure(page);
        await expect(details, `${p.name}: the page shows the results-grid disclosure`).toBeVisible();
        await waitForHydration(details);
        await expect(page.locator("[data-results-matrix]"), `${p.name}: closed, no table is in the page`).toHaveCount(0);
        const summary = details.locator("summary");
        if (how === "click") await summary.click();
        else {
          await summary.focus();
          await page.keyboard.press("Enter");
        }
        await expect(details, `${p.name} (${how}): the disclosure is open`).toHaveAttribute("open", "");
        await expect(gridRows(page), `${p.name} (${how}): one row per entrant`).toHaveCount(N);
        await expect(gridRows(page).first().locator("td"), `${p.name} (${how}): one cell per entrant on a row`).toHaveCount(N);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: four pages, two ways in").toBe(8);
    await expectNoHorizontalScroll(page);
  });

  test("a tap BEFORE hydration opens the disclosure natively, and the grid is drawn once the page hydrates (organiser page, 320)", async ({ page, request }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 320, height: 640 });
    const url = await divisionPath(request, await swiss(request, N), "?tab=standings");

    // Every script the page loads is held until the tap has landed, so React cannot hydrate before it.
    const held: Array<() => Promise<void>> = [];
    let holding = true;
    await page.route(/\/_next\/static\/.+\.js(\?.*)?$/, async (route) => {
      if (!holding) return route.continue();
      await new Promise<void>((resolve) => held.push(async () => { await route.continue(); resolve(); }));
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const details = disclosure(page);
    await expect(details, "the server-rendered disclosure is on the page").toBeVisible();
    expect(held.length, "premise: the page's scripts are being held").toBeGreaterThan(0);
    expect(
      await details.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__react"))),
      "premise: React has not hydrated the disclosure when it is tapped",
    ).toBe(false);
    // A click, not `tap()`: the desktop project has no touch, and the native open is the same either way - what is measured is
    // WHEN it lands, not with what.
    await details.locator("summary").click();
    await expect(details, "the tap opened the <details> natively").toHaveAttribute("open", "");
    await expect(page.locator("[data-results-matrix]"), "nothing is drawn before React is in the page").toHaveCount(0);

    holding = false;
    await Promise.all(held.splice(0).map((go) => go()));
    await waitForHydration(details, { timeout: 30_000 });
    await expect(gridRows(page), "hydrated over an open disclosure: one row per entrant").toHaveCount(N);
    await expectNoHorizontalScroll(page);
  });
});
