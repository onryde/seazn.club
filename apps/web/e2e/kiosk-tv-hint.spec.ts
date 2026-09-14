import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { TAG, apiJson, addEntrantsViaApi, createStageAndGenerate, expectNoHorizontalScroll } from "./helpers";
// A module with no imports of its own, so a spec may load it (a src module
// whose chain reaches a JSON import fails to COLLECT here).
import { KIOSK_TV_HINT_STORAGE_KEY } from "../src/components/public-site/kiosk-tv-hint-logic";

// The public /present kiosk's "made for a TV" hint in a real browser
// (spectator N1d d6). The unit suite (kiosk-tv-hint.test.tsx) pins the pure
// pieces and the component's wiring against a stubbed window; what only a
// browser can show is here:
//   - the media query answering a real viewport, and a RESIZE reaching the
//     subscription without a reload;
//   - the painted size of each control (44px), and a tap at its centre
//     landing on it;
//   - a dismissal surviving a reload through real localStorage;
//   - a browser with no Fullscreen API;
//   - 320px with no horizontal page scroll.
//
// Each "shown" assertion has its opposite in this file, so none passes on a
// banner that is always there, or never there:
//   visible at 390                     <-> absent at 1280 (same page, resized both ways)
//   Full screen button at 390          <-> absent with the API deleted
//   hidden after ✕ and a reload        <-> back after the stored key is cleared
//   division kiosk links ?division=    <-> competition kiosk links the bare hub
//   ✕ in the message's row, top right  <-> the buttons on the row below it (N1e e2)
//
// Labels are never matched by text: the seeded org's locale is whatever the
// e2e session's org carries. Controls are found by test id, and their
// accessible names are asserted non-empty.

/** One API round trip against a local production build, with headroom. */
const API_CALL_MS = 1_500;
const FLOOR_MS = 60_000;
/** Active org slug; competition create; division create + read; entrants;
 *  stage create + generate. */
const SEED_CALLS = 1 + 1 + 2 + 1 + 2;
const SEED_BUDGET_MS = FLOOR_MS + SEED_CALLS * API_CALL_MS;

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const SMALLEST = { width: 320, height: 640 };

async function activeOrgSlug(request: APIRequestContext) {
  const orgs = await apiJson<{ id: string; slug: string }[]>(request, "/api/orgs");
  const active = (await request.storageState()).cookies.find((c) => c.name === "seazn_org")?.value;
  const org = orgs.data?.find((o) => o.id === active) ?? orgs.data?.[0];
  if (!org) throw new Error("no org for the e2e session");
  return org.slug;
}

async function seedKiosk(request: APIRequestContext) {
  const orgSlug = await activeOrgSlug(request);
  const comp = await apiJson<{ id: string; slug: string; visibility: string }>(
    request,
    "/api/v1/competitions",
    "POST",
    { ends_on: "2030-12-31", name: `Kiosk TV hint ${TAG}-${Math.random().toString(36).slice(2, 6)}`, visibility: "public" },
  );
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  // A create over the public-dashboard cap degrades to private with a 201,
  // and a private competition 404s off /shared/*.
  expect(comp.data!.visibility).toBe("public");

  const created = await apiJson<{ id: string }>(request, `/api/v1/competitions/${comp.data!.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  const division = await apiJson<{ id: string; slug: string }>(request, `/api/v1/divisions/${created.data!.id}`);
  expect(division.status).toBe(200);

  const entrants = await addEntrantsViaApi(request, division.data!.id, ["North", "South", "East", "West"]);
  expect(entrants.ids).toHaveLength(4);
  const league = await createStageAndGenerate(request, division.data!.id);
  expect(league.fixtureIds.length).toBeGreaterThan(0);

  return { orgSlug, compSlug: comp.data!.slug, divisionSlug: division.data!.slug };
}

const banner = (page: Page) => page.getByTestId("kiosk-tv-hint");

/**
 * Open a kiosk and wait until the client has MOUNTED. The hint is decided
 * after mount by design (nothing on the server render or hydration's first
 * pass), so an absence asserted before hydration would pass on a broken
 * build. The masthead clock is set by an effect, so its appearance means
 * effects have run, and the hint's post-hydration render has committed.
 */
async function openMounted(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator("header span.tabular-nums")).toBeVisible();
}

/** The painted box is at least 44x44, and a tap at its centre lands on the
 *  control itself (not on a sibling or an overlay). */
async function expectTappable(control: Locator, what: string) {
  const box = await control.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  expect(box!.height, `${what} height`).toBeGreaterThanOrEqual(44);
  expect(box!.width, `${what} width`).toBeGreaterThanOrEqual(44);
  const hit = await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top !== null && (top === el || el.contains(top));
  });
  expect(hit, `${what} receives a tap at its centre`).toBe(true);
}

test.describe("public /present kiosk — the 'made for a TV' hint (N1d d6)", () => {
  let seeded: { orgSlug: string; compSlug: string; divisionSlug: string };
  const divisionKiosk = () => `/shared/${seeded.orgSlug}/${seeded.compSlug}/${seeded.divisionSlug}/present`;
  const competitionKiosk = () => `/shared/${seeded.orgSlug}/${seeded.compSlug}/present`;

  test.beforeAll(async ({ playwright }, testInfo) => {
    // A hook has its own clock; the test's `setTimeout` does not reach it.
    testInfo.setTimeout(SEED_BUDGET_MS);
    const request = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState: testInfo.project.use.storageState,
    });
    try {
      seeded = await seedKiosk(request);
    } finally {
      await request.dispose();
    }
  });

  test("390, division kiosk: the banner shows, links the hub filtered to this division, offers Full screen; each control is 44px and tappable", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openMounted(page, divisionKiosk());

    const hint = banner(page);
    await expect(hint).toBeVisible();
    await expect(hint).toHaveAttribute("role", "region");
    await expect(hint).toHaveAccessibleName(/\S/);

    const phoneView = hint.getByTestId("kiosk-tv-hint-phone-view");
    await expect(phoneView).toBeVisible();
    await expect(phoneView).toHaveAttribute(
      "href",
      `/shared/${seeded.orgSlug}/${seeded.compSlug}?division=${seeded.divisionSlug}`,
    );
    const fullScreen = hint.getByTestId("kiosk-tv-hint-full-screen");
    await expect(fullScreen).toBeVisible();
    const dismiss = hint.getByTestId("kiosk-tv-hint-dismiss");
    await expect(dismiss).toBeVisible();
    await expect(dismiss).toHaveAccessibleName(/\S/);

    await expectTappable(phoneView, "Open phone view");
    await expectTappable(fullScreen, "Full screen");
    await expectTappable(dismiss, "dismiss");
  });

  test("390, competition kiosk: the phone view links the competition's hub with no division filter", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openMounted(page, competitionKiosk());

    await expect(banner(page)).toBeVisible();
    await expect(banner(page).getByTestId("kiosk-tv-hint-phone-view")).toHaveAttribute(
      "href",
      `/shared/${seeded.orgSlug}/${seeded.compSlug}`,
    );
  });

  test("1280: no banner; narrowing the same page to 390 shows it with no reload, and widening hides it again", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openMounted(page, divisionKiosk());
    await expect(banner(page)).toHaveCount(0);

    await page.setViewportSize(PHONE);
    await expect(banner(page)).toBeVisible();

    await page.setViewportSize(DESKTOP);
    await expect(banner(page)).toHaveCount(0);
  });

  test("✕ hides the banner and a reload keeps it hidden; clearing the stored key brings it back", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openMounted(page, divisionKiosk());
    await expect(banner(page)).toBeVisible();

    await banner(page).getByTestId("kiosk-tv-hint-dismiss").click();
    await expect(banner(page)).toHaveCount(0);
    await expect
      .poll(() => page.evaluate((key) => window.localStorage.getItem(key), KIOSK_TV_HINT_STORAGE_KEY))
      .not.toBeNull();

    await page.reload();
    await expect(page.locator("header span.tabular-nums")).toBeVisible();
    await expect(banner(page)).toHaveCount(0);

    // The positive pair: the same page, same width, with the memory cleared.
    await page.evaluate((key) => window.localStorage.removeItem(key), KIOSK_TV_HINT_STORAGE_KEY);
    await page.reload();
    await expect(page.locator("header span.tabular-nums")).toBeVisible();
    await expect(banner(page)).toBeVisible();
  });

  test("a browser without the Fullscreen API: no Full screen button, the link and ✕ stay", async ({ page }) => {
    await page.addInitScript(() => {
      delete (Element.prototype as { requestFullscreen?: unknown }).requestFullscreen;
    });
    await page.setViewportSize(PHONE);
    await openMounted(page, divisionKiosk());

    await expect(banner(page)).toBeVisible();
    expect(await page.evaluate(() => typeof document.documentElement.requestFullscreen)).toBe("undefined");
    await expect(banner(page).getByTestId("kiosk-tv-hint-phone-view")).toBeVisible();
    await expect(banner(page).getByTestId("kiosk-tv-hint-dismiss")).toBeVisible();
    await expect(banner(page).getByTestId("kiosk-tv-hint-full-screen")).toHaveCount(0);
  });

  // N1e e2 (review-n1d m2): the ✕ used to wrap onto a row of its own at the
  // bottom left. It belongs at the banner's top right, beside the message, with
  // the two buttons on the row below. The session org's locale decides the
  // copy; the geometry must hold in any of them.
  for (const size of [SMALLEST, PHONE]) {
    test(`${size.width}: the ✕ is at the banner's top right, in the message's row, with the buttons on the row below`, async ({ page }) => {
      await page.setViewportSize(size);
      await openMounted(page, divisionKiosk());

      const hint = banner(page);
      await expect(hint).toBeVisible();
      const [bannerBox, messageBox, dismissBox, phoneViewBox] = await Promise.all([
        hint.boundingBox(),
        hint.getByTestId("kiosk-tv-hint-message").boundingBox(),
        hint.getByTestId("kiosk-tv-hint-dismiss").boundingBox(),
        hint.getByTestId("kiosk-tv-hint-phone-view").boundingBox(),
      ]);
      expect(bannerBox, "banner has a box").not.toBeNull();
      expect(messageBox, "message has a box").not.toBeNull();
      expect(dismissBox, "✕ has a box").not.toBeNull();
      expect(phoneViewBox, "phone view has a box").not.toBeNull();

      expect(dismissBox!.y, "✕ top is within the message's row").toBeLessThanOrEqual(messageBox!.y + 8);
      expect(
        bannerBox!.x + bannerBox!.width - (dismissBox!.x + dismissBox!.width),
        "✕ right edge to the banner's right edge",
      ).toBeLessThanOrEqual(16);
      // The positive pair: the buttons are on a lower row than the ✕, so a
      // banner that put everything on one row cannot pass.
      expect(phoneViewBox!.y, "phone view sits below the ✕'s row").toBeGreaterThanOrEqual(dismissBox!.y + dismissBox!.height);
      await expectTappable(hint.getByTestId("kiosk-tv-hint-dismiss"), "dismiss");
      await expectNoHorizontalScroll(page);
    });
  }

  test("320: the banner fits inside the viewport and the page has no horizontal scroll", async ({ page }) => {
    await page.setViewportSize(SMALLEST);
    await openMounted(page, divisionKiosk());

    const hint = banner(page);
    await expect(hint).toBeVisible();
    for (const id of ["kiosk-tv-hint-phone-view", "kiosk-tv-hint-full-screen", "kiosk-tv-hint-dismiss"]) {
      const box = await hint.getByTestId(id).boundingBox();
      expect(box, `${id} has a box`).not.toBeNull();
      expect(box!.x, `${id} left edge`).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, `${id} right edge`).toBeLessThanOrEqual(SMALLEST.width + 1);
    }
    await expectNoHorizontalScroll(page);
  });
});
