import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { TAG, apiJson, addEntrantsViaApi, createStageAndGenerate, expectNoHorizontalScroll } from "./helpers";
// A module with no imports of its own, so a spec may load it (a src module
// whose chain reaches a JSON import fails to COLLECT here).
import { KIOSK_BOARD_CHOSEN_STORAGE_KEY } from "../src/components/public-site/kiosk-phone-card-logic";

// The kiosk on a phone, in a real browser (OWNER RULING C1, 2026-09-15): below
// the TV cut-off a board shows a card, "This board is made for a TV", with Open
// the live page, and a small Show the board anyway that shows the board as it
// is, broken phone layout included. It replaced the "made for a TV" banner.
// Controller rulings pinned here (not the owner's): the cut-off is lg (1024),
// CSS decides which shows (no JS width read), the choice is remembered on the
// device, and a chosen board carries no banner.
//
// The unit suites (kiosk-phone-card.test.tsx, slideshow-labels.test.tsx) pin
// the classes each state renders, the link each page hands over, and the
// remembered choice against a stubbed storage. What only a browser can show:
//   - `lg:hidden` / `max-lg:hidden` actually hiding at a real viewport, and a
//     RESIZE swapping them with no reload;
//   - the painted 44px and a tap at the centre landing on the control;
//   - a visible focus ring from the keyboard;
//   - the choice surviving a real reload through real localStorage;
//   - the card at 320 with nothing cut off and no horizontal page scroll;
//   - K-1: the board spanning a TV-size viewport, now that /present lives in
//     the `(kiosk)` route group, outside the org chrome layout;
//   - K-1: a bad /present link still reaching the branded /shared 404, which
//     inside `(kiosk)` only `(kiosk)/[orgSlug]/not-found.tsx` provides.
//
// Each "shown" assertion has its opposite in this file:
//   card at 390                   <-> no card at 1024 and 1280 (same page, resized)
//   board hidden before the tap   <-> board shown after it, and after a reload
//   card gone after a reload      <-> card back once the stored key is cleared
//   division kiosk: ?division=    <-> competition kiosk: the bare hub
//
// Copy is never matched by text: the seeded org's locale is whatever the e2e
// session's org carries. Controls are found by test id.

/** One API round trip against a local production build, with headroom. */
const API_CALL_MS = 1_500;
const FLOOR_MS = 60_000;
/** Active org slug; competition create; then, for each of two divisions,
 *  division create + read, entrants, stage create + generate. */
const SEED_CALLS = 1 + 1 + 2 * (2 + 1 + 2);
const SEED_BUDGET_MS = FLOOR_MS + SEED_CALLS * API_CALL_MS;

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const SMALLEST = { width: 320, height: 640 };
/** Tailwind `lg`: the card below it, the board from it. */
const LG = 1024;

async function activeOrgSlug(request: APIRequestContext) {
  const orgs = await apiJson<{ id: string; slug: string }[]>(request, "/api/orgs");
  const active = (await request.storageState()).cookies.find((c) => c.name === "seazn_org")?.value;
  const org = orgs.data?.find((o) => o.id === active) ?? orgs.data?.[0];
  if (!org) throw new Error("no org for the e2e session");
  return org.slug;
}

/** A league division with four entrants and its generated fixtures. */
async function seedLeagueDivision(request: APIRequestContext, competitionId: string, name: string) {
  const created = await apiJson<{ id: string }>(request, `/api/v1/competitions/${competitionId}/divisions`, "POST", {
    name,
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
  return { id: division.data!.id, slug: division.data!.slug, fixtureIds: league.fixtureIds };
}

async function seedKiosk(request: APIRequestContext) {
  const orgSlug = await activeOrgSlug(request);
  const comp = await apiJson<{ id: string; slug: string; visibility: string }>(
    request,
    "/api/v1/competitions",
    "POST",
    { ends_on: "2030-12-31", name: `Kiosk phone card ${TAG}-${Math.random().toString(36).slice(2, 6)}`, visibility: "public" },
  );
  expect(comp.status, JSON.stringify(comp.error)).toBe(201);
  // A create over the public-dashboard cap degrades to private with a 201,
  // and a private competition 404s off /shared/*.
  expect(comp.data!.visibility).toBe("public");

  // Two divisions with fixtures: the hub's Matches tab shows its division
  // chips only when there is more than one, and the live link's filter can
  // only be seen applied on that rail.
  const open = await seedLeagueDivision(request, comp.data!.id, "Open");
  const second = await seedLeagueDivision(request, comp.data!.id, "Second");

  return {
    orgSlug,
    compSlug: comp.data!.slug,
    divisionId: open.id,
    divisionSlug: open.slug,
    fixtureIds: open.fixtureIds,
    otherDivisionSlug: second.slug,
    otherFixtureIds: second.fixtureIds,
  };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Any one of these fixtures' hub match cards. */
const anyMatchCard = (page: Page, fixtureIds: readonly string[]) =>
  page.locator(fixtureIds.map((id) => `[data-testid="mh-match-${id}"]`).join(", ")).first();

const card = (page: Page) => page.getByTestId("kiosk-phone-card");
const openLive = (page: Page) => page.getByTestId("kiosk-phone-card-open-live");
const showBoard = (page: Page) => page.getByTestId("kiosk-phone-card-show-board");
/** The board's masthead clock: set by an effect, rendered in both states. */
const clock = (page: Page) => page.locator("header span.tabular-nums");

/**
 * Open a board and wait until the client has MOUNTED. The card and the board
 * are both in the server markup, so a visibility check alone passes before
 * hydration, when Show the board anyway has no handler yet and a stored
 * choice has not been read. The clock is set by an effect, so its presence
 * means effects have run. `toBeAttached`, not `toBeVisible`: below lg the
 * board is hidden, which is exactly what is being tested (AGENTS.md #22).
 */
async function openMounted(page: Page, path: string) {
  await page.goto(path);
  await expect(clock(page)).toBeAttached();
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

/** Every text in the card that a person cannot read in full: no box, off the
 *  viewport, cut by an overflow-hidden/clip ancestor, or ellipsised/clamped.
 *  An auto/scroll ancestor would be a reachable scroller and is not counted
 *  (AGENTS.md #23). Also names the texts it checked, so an empty card cannot
 *  pass. */
async function cardReadability(page: Page): Promise<{ checked: string[]; problems: string[] }> {
  return card(page).evaluate((root) => {
    const checked: string[] = [];
    const problems: string[] = [];
    const leaves = [...root.querySelectorAll("*")].filter(
      (el) => el.children.length === 0 && (el.textContent ?? "").trim().length > 0,
    );
    for (const el of leaves) {
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      checked.push(text);
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) problems.push(`"${text}" has no box`);
      if (box.left < -1 || box.right > window.innerWidth + 1) problems.push(`"${text}" runs off the viewport`);
      for (let a = el.parentElement; a; a = a.parentElement) {
        const ox = getComputedStyle(a).overflowX;
        if (ox !== "hidden" && ox !== "clip") continue;
        const ab = a.getBoundingClientRect();
        if (box.left < ab.left - 1 || box.right > ab.right + 1) problems.push(`"${text}" cut off by <${a.tagName.toLowerCase()}>`);
      }
      // Only a cut the element's own style hides: overflow that stays visible is
      // drawn whole (a glyph taller than a leading-none line box overflows its
      // box yet reads in full — this probe once failed the card's 📺 for that).
      const st = getComputedStyle(el);
      const clamped = st.webkitLineClamp !== "" && st.webkitLineClamp !== "none";
      const hidesX = st.overflowX !== "visible";
      const hidesY = st.overflowY !== "visible" || clamped;
      if (
        el.clientWidth > 0 &&
        ((hidesX && el.scrollWidth > el.clientWidth + 1) || (hidesY && el.scrollHeight > el.clientHeight + 1))
      ) {
        problems.push(`"${text}" truncated`);
      }
    }
    return { checked, problems };
  });
}

test.describe("the kiosk on a phone: the 'made for a TV' card (OWNER RULING C1)", () => {
  let seeded: Awaited<ReturnType<typeof seedKiosk>>;
  const divisionKiosk = () => `/shared/${seeded.orgSlug}/${seeded.compSlug}/${seeded.divisionSlug}/present`;
  const competitionKiosk = () => `/shared/${seeded.orgSlug}/${seeded.compSlug}/present`;
  const divisionHub = () => `/shared/${seeded.orgSlug}/${seeded.compSlug}?division=${seeded.divisionSlug}`;

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

  test("390, division kiosk: the card, not the board; Open the live page links the hub filtered to this division; both controls 44px and tappable; no banner", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openMounted(page, divisionKiosk());

    await expect(card(page)).toBeVisible();
    await expect(card(page)).toHaveAccessibleName(/\S/);
    await expect(clock(page), "the board is hidden until chosen").toBeHidden();
    await expect(page.getByTestId("kiosk-tv-hint"), "the retired banner").toHaveCount(0);

    await expect(openLive(page)).toHaveAttribute("href", divisionHub());
    await expect(openLive(page)).toHaveAccessibleName(/\S/);
    await expect(showBoard(page)).toHaveAccessibleName(/\S/);
    await expectTappable(openLive(page), "Open the live page");
    await expectTappable(showBoard(page), "Show the board anyway");
    await expectNoHorizontalScroll(page);
  });

  // The href alone does not prove the filter survives the trip: the link is a
  // client navigation, the hub reads `?division=` from the browser, and its
  // Matches tab seeds its chip once at mount.
  test("390, division kiosk: Open the live page lands on the hub with ?division=, and the hub applies it on the Matches tab", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openMounted(page, divisionKiosk());

    await openLive(page).click();
    await expect(page).toHaveURL(
      new RegExp(
        `/shared/${escapeRegExp(seeded.orgSlug)}/${escapeRegExp(seeded.compSlug)}\\?division=${escapeRegExp(seeded.divisionSlug)}$`,
      ),
    );
    await expect(page.getByTestId("mh-root")).toBeVisible();

    await page.getByTestId("mh-tab-matches").click();
    await expect(page.getByTestId("mh-tab-panel-matches")).toBeVisible();
    await expect(page.getByTestId(`mh-division-${seeded.divisionSlug}`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId(`mh-division-${seeded.otherDivisionSlug}`)).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("mh-division-all")).toHaveAttribute("aria-pressed", "false");
    await expect(anyMatchCard(page, seeded.fixtureIds)).toBeVisible();
    for (const id of seeded.otherFixtureIds) await expect(page.getByTestId(`mh-match-${id}`)).toHaveCount(0);

    // The positive pair: the other division's matches ARE on this hub, so
    // their absence above was the filter, not an empty list.
    await page.getByTestId("mh-division-all").click();
    await expect(page.getByTestId("mh-division-all")).toHaveAttribute("aria-pressed", "true");
    await expect(anyMatchCard(page, seeded.otherFixtureIds)).toBeVisible();
  });

  test("390, competition kiosk: Open the live page links the competition's hub with no division filter", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openMounted(page, competitionKiosk());

    await expect(card(page)).toBeVisible();
    await expect(openLive(page)).toHaveAttribute("href", `/shared/${seeded.orgSlug}/${seeded.compSlug}`);
  });

  test("Show the board anyway shows the board with no banner, a reload keeps the board, and clearing the stored key brings the card back", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openMounted(page, divisionKiosk());
    await expect(card(page)).toBeVisible();

    await showBoard(page).click();
    await expect(card(page)).toHaveCount(0);
    await expect(clock(page)).toBeVisible();
    await expect(page.getByTestId("kiosk-tv-hint"), "no banner over a chosen board").toHaveCount(0);
    await expect
      .poll(() => page.evaluate((key) => window.localStorage.getItem(key), KIOSK_BOARD_CHOSEN_STORAGE_KEY))
      .toBe("1");

    await page.reload();
    await expect(clock(page)).toBeVisible();
    await expect(card(page)).toHaveCount(0);

    // The positive pair: the same page, same width, with the choice cleared.
    await page.evaluate((key) => window.localStorage.removeItem(key), KIOSK_BOARD_CHOSEN_STORAGE_KEY);
    await page.reload();
    await expect(clock(page)).toBeAttached();
    await expect(card(page)).toBeVisible();
    await expect(clock(page)).toBeHidden();
  });

  test("the cut-off is lg, decided by CSS: the same page swaps card and board on a resize, with no reload", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openMounted(page, divisionKiosk());
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });

    for (const [width, cardShown] of [
      [DESKTOP.width, false],
      [SMALLEST.width, true],
      [768, true],
      [LG - 1, true],
      [LG, false],
      [DESKTOP.width, false],
    ] as const) {
      await page.setViewportSize({ width, height: 800 });
      if (cardShown) {
        await expect(card(page), `card at ${width}`).toBeVisible();
        await expect(clock(page), `board at ${width}`).toBeHidden();
      } else {
        await expect(card(page), `card at ${width}`).toBeHidden();
        await expect(clock(page), `board at ${width}`).toBeVisible();
      }
    }
    expect(navigations, "no reload or navigation while resizing").toEqual([]);
  });

  test("1280: no card, and the board spans the viewport (K-1: no org chrome around /present)", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await openMounted(page, divisionKiosk());

    await expect(card(page)).toBeHidden();
    await expect(clock(page)).toBeVisible();
    const root = page.getByTestId("kiosk-board").locator(":scope > div").first();
    const box = await root.boundingBox();
    expect(box, "the board root has a box").not.toBeNull();
    expect(box!.x, "board left edge").toBeLessThanOrEqual(1);
    expect(box!.width, "board width").toBeGreaterThanOrEqual(DESKTOP.width - 1);
    await expectNoHorizontalScroll(page);
  });

  test("K-1: a /present link to a competition that does not exist gets the branded /shared 404, not Next's bare page", async ({ page }) => {
    // The page's own notFound() is caught by the nearest not-found.tsx above
    // it. In the `(kiosk)` group that is `(kiosk)/[orgSlug]/not-found.tsx`;
    // without it the miss falls through to Next's built-in page. (An org-level
    // miss is thrown by the layout itself and skips its own segment's boundary
    // in BOTH trees — not what this test covers.)
    await page.setViewportSize(DESKTOP);
    const response = await page.goto(`/shared/${seeded.orgSlug}/no-such-competition-${TAG.toLowerCase()}/present`);
    expect(response?.status(), "a 404 status").toBe(404);
    await expect(page.getByTestId("shared-not-found")).toBeVisible();
    await expect(page.getByTestId("kiosk-board")).toHaveCount(0);
  });

  test("320: every text on the card reads in full, both controls sit inside the viewport, and the page has no horizontal scroll", async ({ page }) => {
    await page.setViewportSize(SMALLEST);
    await openMounted(page, competitionKiosk());
    await expect(card(page)).toBeVisible();

    const { checked, problems } = await cardReadability(page);
    expect(checked.length, `texts checked: ${checked.join(" | ")}`).toBeGreaterThanOrEqual(3);
    expect(problems, `texts checked: ${checked.join(" | ")}`).toEqual([]);
    for (const control of [openLive(page), showBoard(page)]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(SMALLEST.width + 1);
    }
    await expectTappable(showBoard(page), "Show the board anyway at 320");
    await expectNoHorizontalScroll(page);
  });

  test("390: each control shows a focus ring when reached from the keyboard", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openMounted(page, divisionKiosk());
    await expect(card(page)).toBeVisible();

    for (const [control, what] of [
      [openLive(page), "Open the live page"],
      [showBoard(page), "Show the board anyway"],
    ] as const) {
      let focused = false;
      for (let i = 0; i < 20 && !focused; i++) {
        await page.keyboard.press("Tab");
        focused = await control.evaluate((el) => el === document.activeElement);
      }
      expect(focused, `${what} is reachable with Tab`).toBe(true);
      const ring = await control.evaluate((el) => {
        const s = getComputedStyle(el);
        return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
      });
      expect(ring.style, `${what} outline style`).not.toBe("none");
      expect(ring.width, `${what} outline width`).toBeGreaterThan(0);
    }
  });

  test("390, organiser noticeboard: the same card, and Open the live page goes where the board's own back link goes", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openMounted(page, `/slideshow/divisions/${seeded.divisionId}`);

    await expect(card(page)).toBeVisible();
    await expect(clock(page)).toBeHidden();
    const back = await page.locator("header a").first().getAttribute("href");
    expect(back, "the board's back link").toMatch(/^\/o\/[^/]+\/c\/[^/]+\/d\//);
    await expect(openLive(page)).toHaveAttribute("href", back!);
    await expectTappable(showBoard(page), "Show the board anyway");
  });
});
