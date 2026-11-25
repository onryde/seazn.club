import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { TAG, addEntrantsViaApi, apiJson, expectNoHorizontalScroll } from "./helpers";
import { consentedAnonymousState } from "./scorepad-a11y-kit";
import { closeOpenContexts } from "./spectator-public-helpers";
import { activeOrgSlug, division, leagueFixtures, publicCompetition, spectator } from "./spectator-w2-kit";
// `with { type: "json" }` is required: without it the spec collects no tests under Node's ESM loader.
import fr from "../src/dictionaries/fr/marketing.json" with { type: "json" };

// The Android app's promotion (spec 2026-11-25 §4; owner-approved Option B, 2026-11-25): one slim band on the home page
// and three product pages, one Play badge in the marketing footer, and neither anywhere else. What only a browser can
// see: widths, centring, what is really on top, and the served pages of the surfaces that must stay clean. The pages and
// their copy are the same for every sport, so there is no sport sweep; the excluded surfaces are seeded on `generic`.

const PLAY = "https://play.google.com/store/apps/details?id=com.seazn.capture";
const LABEL = "Seazn Club Mobile App";
const WIDTHS = [1280, 768, 320] as const;
/** Tailwind `sm`: below it the band stacks and centres. */
const SM = 640;

// The owner's approved English, typed from the task brief. `before` and `after` are the band's neighbours on the page.
const BANDS = [
  {
    path: "/",
    key: "home.app",
    title: "Your phone is the camera and the scorer",
    line: "Scan your organiser’s code to stream a match with the score on screen, or to score it.",
    before: '[data-testid="competition-flow"]',
    after: ':has(a[href$="/start"])',
  },
  {
    path: "/product/streaming",
    key: "product.streaming.app",
    title: "Put the camera in your pocket",
    line: "Scan a match or court code, then hold Go live. No laptop, no capture card.",
    before: '[data-section="camera"]',
    after: '[data-section="ticket"]',
  },
  {
    path: "/product/match-day",
    key: "product.matchday.app",
    title: "One phone follows the court",
    line: "Scan a court code once. It goes live when a match starts and stops when it ends.",
    before: '[data-section="courtstream"]',
    after: '[data-section="ticket"]',
  },
  {
    path: "/product/remote-scoring",
    key: "product.remote.app",
    title: "Score from the app too",
    line: "Scan your organiser’s scoring code and score every point, ball or goal. The browser pad still works.",
    before: '[data-section="hero"]',
    after: '[data-section="road"]',
  },
] as const;

/** Where the text of the band's three blocks and its badge really are: line boxes, not the full-width element boxes. */
async function bandGeometry(page: Page, texts: readonly string[]) {
  return page.getByTestId("app-band").evaluate((section, wanted) => {
    const rect = (r: DOMRect) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    const blocks = wanted.map((text) => {
      const el = [...section.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent === text);
      if (!el) throw new Error(`no element in the band holds exactly "${text}"`);
      const range = document.createRange();
      range.selectNodeContents(el);
      return { ...rect(el.getBoundingClientRect()), lines: [...range.getClientRects()].map(rect) };
    });
    const badge = rect(section.querySelector('[data-testid="play-badge"]')!.getBoundingClientRect());
    // The dashed box is the section's one child: what has to hold everything.
    const box = rect(section.firstElementChild!.getBoundingClientRect());
    const style = getComputedStyle(section.firstElementChild!);
    const escaped = [...section.querySelectorAll("*")].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && (r.left < box.left - 0.5 || r.right > box.right + 0.5);
    }).length;
    return { blocks, badge, box, escaped, border: `${style.borderTopStyle} ${style.borderTopColor}`, viewport: document.documentElement.clientWidth };
  }, texts);
}

/** Scroll `testid`'s nth element to mid-screen, then prove a tap at its centre lands on it and its art has loaded. */
async function expectBadgeTappable(page: Page, nth: number, where: string) {
  const badge = page.getByTestId("play-badge").nth(nth);
  await badge.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "instant" }));
  await expect
    .poll(() => badge.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), { message: `${where}: art loaded` })
    .toBe(true);
  const onTop = await badge.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('[data-testid="play-badge"]') === el;
  });
  expect(onTop, `${where}: the badge is what a tap at its centre hits`).toBe(true);
}

test.describe("app promotion: the marketing pages", () => {
  // A first visit's cookie banner is fixed over the foot of the screen; these tests are the visitor who has answered it.
  // `provide`, not Playwright's usual `use`: the lint reads that name as a React hook.
  test.use({ storageState: async ({}, provide) => provide(await consentedAnonymousState()) });

  for (const band of BANDS) {
    test(`${band.path}: one app band, two Play links (band + footer), no sideways scroll — counted`, async ({ page }) => {
      let checked = 0;
      for (const width of WIDTHS) {
        const at = `${band.path} at ${width}`;
        await page.setViewportSize({ width, height: 800 });
        await page.goto(band.path);
        const section = page.getByTestId("app-band");
        await expect(section, at).toHaveCount(1);
        await expect(page.getByTestId("play-badge"), at).toHaveCount(2);
        await expect(section.getByTestId("play-badge"), at).toHaveAttribute("href", PLAY);
        await expect(page.locator("footer").getByTestId("play-badge"), at).toHaveAttribute("href", PLAY);
        await expectNoHorizontalScroll(page);
        // The brief's neighbours: the section before the band and the one after it.
        expect(
          await section.evaluate((el, [before, after]) => [el.previousElementSibling?.matches(before!), el.nextElementSibling?.matches(after!)], [band.before, band.after]),
          `${at}: placement`,
        ).toEqual([true, true]);

        await page.evaluate(() => document.fonts.ready);
        const g = await bandGeometry(page, [band.title, LABEL, band.line]);
        const [title, label, line] = g.blocks as [(typeof g.blocks)[number], (typeof g.blocks)[number], (typeof g.blocks)[number]];
        // The product pages clip sideways overflow on <main>, which the page-level check cannot see through.
        expect(g.box.left, at).toBeGreaterThanOrEqual(0);
        expect(g.box.right, at).toBeLessThanOrEqual(g.viewport + 0.5);
        expect(g.escaped, `${at}: nothing leaves the dashed box`).toBe(0);
        expect(g.border, `${at}: the lime ticket stub`).toBe("dashed rgb(163, 230, 53)");
        // Three blocks, one under the other, at every width: never a joined line.
        expect(label.top, `${at}: label under title`).toBeGreaterThanOrEqual(title.bottom - 0.5);
        expect(line.top, `${at}: line under label`).toBeGreaterThanOrEqual(label.bottom - 0.5);
        const lines = g.blocks.flatMap((b) => b.lines);
        expect(lines.length, at).toBeGreaterThanOrEqual(3);
        const middle = (r: { left: number; right: number }) => (r.left + r.right) / 2;
        if (width < SM) {
          expect(g.badge.top, `${at}: badge under the line`).toBeGreaterThanOrEqual(line.bottom);
          for (const r of [...lines, g.badge]) expect(Math.abs(middle(r) - middle(g.box)), `${at}: centred`).toBeLessThanOrEqual(3);
        } else {
          expect(g.badge.left, `${at}: badge right of the words`).toBeGreaterThanOrEqual(Math.max(...lines.map((r) => r.right)) + 8);
          expect(g.box.right - g.badge.right, `${at}: badge at the right edge`).toBeLessThanOrEqual(32);
          for (const b of [label, line]) expect(Math.abs(b.lines[0]!.left - title.lines[0]!.left), `${at}: one left edge`).toBeLessThanOrEqual(1);
          expect(Math.abs((g.badge.top + g.badge.bottom) / 2 - (g.box.top + g.box.bottom) / 2), `${at}: badge mid-height`).toBeLessThanOrEqual(2);
        }

        // The footer badge: centred in the footer, below every link column and above the bottom bar.
        const footer = await page.locator("footer").evaluate((el) => {
          const badge = el.querySelector('[data-testid="play-badge"]')!.getBoundingClientRect();
          const all = el.getBoundingClientRect();
          const links = [...el.querySelectorAll("li")].map((li) => li.getBoundingClientRect().bottom);
          const bar = el.querySelector(".border-t")!.getBoundingClientRect();
          return { off: badge.left + badge.width / 2 - (all.left + all.width / 2), top: badge.top, bottom: badge.bottom, links: links.length, linksBottom: Math.max(...links), barTop: bar.top };
        });
        expect(footer.links, `${at}: footer links measured`).toBeGreaterThanOrEqual(15);
        expect(Math.abs(footer.off), `${at}: footer badge centred`).toBeLessThanOrEqual(1);
        expect(footer.top, `${at}: footer badge below the link columns`).toBeGreaterThanOrEqual(footer.linksBottom);
        expect(footer.bottom, `${at}: footer badge above the bottom bar`).toBeLessThanOrEqual(footer.barTop);

        await expectBadgeTappable(page, 0, `${at} band`);
        await expectBadgeTappable(page, 1, `${at} footer`);
        checked++;
      }
      expect(checked).toBe(3);

      const axe = await new AxeBuilder({ page }).include('[data-testid="app-band"]').analyze();
      expect(axe.passes.length, "axe looked at the band").toBeGreaterThan(0);
      expect(axe.violations.map((v) => v.id)).toEqual([]);
    });
  }

  test("fr pages use the fr art and the fr words — counted", async ({ page }) => {
    let checked = 0;
    for (const band of BANDS) {
      const path = `/fr${band.path === "/" ? "" : band.path}`;
      await page.goto(path);
      const images = page.getByTestId("play-badge").locator("img");
      await expect(images, path).toHaveCount(2);
      for (const src of await images.evaluateAll((els) => els.map((e) => e.getAttribute("src")!))) {
        expect(src.endsWith("google-play-fr.png"), `${path}: ${src}`).toBe(true);
      }
      const title = (fr as Record<string, string>)[`${band.key}.title`]!;
      expect(title, path).not.toBe(band.title);
      await expect(page.getByTestId("app-band").getByRole("heading"), path).toHaveText(title);
      checked++;
    }
    expect(checked).toBe(4);
  });
});

test.describe("app promotion: surfaces that never show it", () => {
  test.afterEach(async () => {
    await closeOpenContexts();
  });

  test("a public competition, its division, an embed and the scoring pad: no band, no badge — counted", async ({ browser, request }) => {
    const org = await activeOrgSlug(request);
    const competition = await publicCompetition(request, { name: `App promo clean ${TAG}`, orgId: org.id });
    const div = await division(request, competition.id, {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    const names = [`Ada Promo ${TAG}`, `Bo Promo ${TAG}`];
    expect((await addEntrantsViaApi(request, div.id, names)).status).toBe(201);
    const [fixture] = await leagueFixtures(request, div.id);
    const link = await apiJson<{ secret: string }>(request, `/api/v1/fixtures/${fixture!.id}/device-links`, "POST", { label: "Court 1" });
    expect(link.status, JSON.stringify(link.error)).toBe(201);

    const either = new RegExp(names.join("|"));
    const surfaces = [
      { what: "public competition page", path: `/live/${org.slug}/${competition.slug}`, rendered: new RegExp(`App promo clean ${TAG}`) },
      { what: "public division page", path: `/live/${org.slug}/${competition.slug}/${div.slug}?tab=standings`, rendered: either },
      { what: "embed", path: `/embed/divisions/${div.id}/standings`, rendered: either },
      { what: "scoring pad", path: `/score/${link.data!.secret}`, rendered: either },
    ];
    const page = await spectator(browser, { width: 1280, height: 900 });
    let checked = 0;
    for (const s of surfaces) {
      const res = await page.goto(s.path);
      expect(res!.status(), s.what).toBe(200);
      // The premise first: a page that rendered nothing has no badge either.
      await expect(page.getByText(s.rendered).filter({ visible: true }).first(), s.what).toBeVisible({ timeout: 20_000 });
      await page.waitForLoadState("load");
      await expect(page.getByTestId("app-band"), s.what).toHaveCount(0);
      await expect(page.getByTestId("play-badge"), s.what).toHaveCount(0);
      await expect(page.locator(`a[href="${PLAY}"]`), s.what).toHaveCount(0);
      checked++;
    }
    expect(checked).toBe(4);

    // The positive control: the same three locators, in the same browser context, do find the home page's promotion.
    await page.goto("/");
    await expect(page.getByTestId("app-band")).toHaveCount(1);
    await expect(page.getByTestId("play-badge")).toHaveCount(2);
    await expect(page.locator(`a[href="${PLAY}"]`)).toHaveCount(2);
  });
});
