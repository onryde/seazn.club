// The stream overlay route, in a real browser (stream overlay W1, Task 8).
//
// THIS FILE CARRIES T1'S ONE HANDED-FORWARD OBLIGATION. Two WCAG 1.4.11
// findings — football's dismissal chip at 2.56:1 and hockey's live dot at
// 2.75:1, both under the 3:1 graphical floor — were closed as "covered by the
// 1-px `--sport-ink` hairline" rather than waived. `apps/web` vitest is
// `environment: "node"`: no unit test in this repo can see a rendered border,
// so if this file does not assert it in a browser, BOTH closures are unbacked.
// The assertions live in the first describe below and are deliberately exact
// (`1px` / `solid` / the RESOLVED custom property, never a hex literal — a hex
// passes for one sport and rots silently for the other ten).
//
// SERIAL, on purpose. The rig switches the overlay OFF by an org-wide override
// and back on halfway through its own life (the 404 is proved on the SAME
// fixture before the override comes off — since V426 every plan grants
// `streaming.overlay`, so an override is the only negative left), so the tests
// are ordered rather than independent. AGENTS.md class 21 applies
// to reading a red run from this file: the first failure aborts the rest, so a
// red COUNT here is a floor, never a total — re-run after each fix until a
// full pass completes.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";
import { builtinModules } from "@seazn/engine/sports";
import {
  apiJson,
  expectNoHorizontalScroll,
  invalidateOrgEntitlements,
  setBoolEntitlementOverrideSql,
  withDb,
} from "./helpers";
import {
  OVERLAY_MOMENT_FOLD_MS,
  OVERLAY_MOMENT_HOLD_MS,
} from "../src/components/overlay/moment-timing";
import { OVERLAY_SCENES } from "../src/components/overlay/overlay-scenes";
import { END_OF_OVER_HOLD_MS } from "../src/lib/overlay-end-of-over";
import { SPONSOR_COOLDOWN_MS, SPONSOR_STYLE_BY_SIZE } from "../src/lib/sponsor-plan";
import { SPONSOR_TIER_WEIGHTS } from "../src/lib/sponsor-tiers";
import { sponsorShortLinkText } from "../src/lib/sponsor-clicks";
import { POLL_MS, SETTLED_POLL_MS } from "../src/components/public-site/match-centre/use-live-fixture";
import { OVERLAY_REALTIME_PURPOSE, realtimeTokenPath } from "../src/components/public-site/live-score-data";
import { OVERLAY_KEY_PARAM } from "../src/lib/realtime-purpose";
import { watchFixtureRealtime } from "./realtime-propagation-kit";
import {
  HOCKEY_CARD_TONES,
  STREAM_URL,
  clearStreamingOverride,
  denyOverlay,
  grantRigPackCredits,
  seedCricketOverlayFixture,
  seedCricketOverlayFreshOver,
  seedOverlayFixture,
  seedUndoOverlayFixture,
  sendEvent,
  setRigPlan,
  signInAs,
  type OverlayRig,
} from "./overlay-kit";

test.describe.configure({ mode: "serial" });

/** OBS, and every other viewer of this route, is anonymous. The project's
 *  `use.storageState` is the shared Pro org's session and a bare
 *  `browser.newContext()` INHERITS it, so every context here names its state. */
async function anonPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  return context.newPage();
}

/** Resolve `--sport-ink` the way the browser does, through the cascade, at the
 *  position the element under test actually sits in. Never a hex literal: the
 *  sheet's palette is per-sport (`sport-theme.ts`'s `SPORT_PALETTES`), so a
 *  hard-coded value would pass for hockey and rot for the other ten sports the
 *  same CSS rule serves. */
async function resolveInk(page: Page, within: string): Promise<string> {
  return page.evaluate((sel) => {
    const host = document.querySelector<HTMLElement>(sel);
    if (!host) throw new Error(`resolveInk: ${sel} is not in the DOM`);
    const probe = document.createElement("span");
    probe.style.color = "var(--sport-ink)";
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    host.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, within);
}

/** The four sides of one element's border, read individually. The `border`
 *  shorthand collapses to a single string when all four agree, which is
 *  exactly the case a broken override would stop being — so this reads each
 *  side and the assertions compare all four. */
async function borderOf(
  page: Page,
  selector: string,
  index: number,
): Promise<{ widths: string[]; styles: string[]; colors: string[]; background: string }> {
  return page.evaluate(
    ({ sel, i }) => {
      const el = document.querySelectorAll<HTMLElement>(sel)[i];
      if (!el) throw new Error(`borderOf: ${sel}[${i}] is not in the DOM`);
      const cs = getComputedStyle(el);
      return {
        widths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
        styles: [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle],
        colors: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor],
        background: cs.backgroundColor,
      };
    },
    { sel: selector, i: index },
  );
}

/** The custom property as the canvas resolves it — used to hold each chip's
 *  FILL against the tone token its class is supposed to pick, which is what
 *  makes the three chips three tones rather than one repeated. */
async function resolveToken(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const host = document.querySelector<HTMLElement>('[data-testid="ovl-root"]');
    if (!host) throw new Error("resolveToken: ovl-root is not in the DOM");
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    host.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, token);
}

/** The fixture's organiser page — where the stream panel lives (spec 2026-09-30 §2). The overlay rig carries no
 *  fixture NUMBER, so it is read over the API, from the same row the page resolves. */
async function openFixture(page: Page, r: OverlayRig): Promise<void> {
  const fx = await apiJson<{ fixture_no: number | null }>(page.request, `/api/v1/fixtures/${r.fixtureId}`);
  expect(fx.data?.fixture_no ?? 0, "the rig's fixture has a run-sheet number").toBeGreaterThan(0);
  await page.goto(`/o/${r.orgSlug}/c/${r.compSlug}/d/${r.divSlug}/f/${fx.data!.fixture_no}`);
  await expect(
    page.locator('[data-role="console-scoring"], [data-role="console-stream"]').first(),
    "the fixture console rendered",
  ).toBeAttached({ timeout: 30_000 });
}

/** The width's own Stream control — the desktop button at ≥768, the strip icon below. Exactly one is visible. */
const streamControl = (page: Page): Locator =>
  page.locator('[data-role="fixture-stream"]:visible, [data-role="fixture-stream-phone"]:visible');

let rig: OverlayRig;
/** The route's status for this exact fixture while an override switched
 *  `streaming.overlay` OFF. Captured in `beforeAll` rather than asserted there,
 *  so the gate has a named test of its own and its expectation is a real
 *  differential: one fixture, one URL, one variable (the override row). */
let statusWhileDenied = 0;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  // Empty storage on purpose. A bare `browser.newContext()` inherits the
  // project's Pro `storageState`; after `signInAs` the page can show the rig
  // owner while `page.request` still rides the Pro cookie jar — persons POST
  // then 401s (seen 2026-09-13). Same empty shape as `anonPage` below.
  const owner = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const ownerPage = await owner.newPage();
  try {
    rig = await seedOverlayFixture(ownerPage);

    // V426: the rig's plan grants the overlay, so the only 404 left is an
    // override. The seed's own API calls may already have resolved this org's
    // entitlements, so the override drops that cache before the fetch reads it.
    await denyOverlay(rig.orgId);
    await invalidateOrgEntitlements(ownerPage.request, rig.orgId);
    const anon = await anonPage(browser);
    try {
      const res = await anon.goto(`/overlay/fixtures/${rig.fixtureId}`);
      statusWhileDenied = res?.status() ?? 0;
    } finally {
      await anon.context().close();
    }

    // The override comes OFF (not flipped to true): what serves the route from
    // here on is the plan's own V426 row, which is the thing every later test
    // in this file now rides. The 404 above RESOLVED `streaming.overlay` for
    // this org, so the removal has to drop whatever that resolution cached — a
    // no-op where there is no Redis, required against a cached target.
    await clearStreamingOverride(rig.orgId, "streaming.overlay");
    await invalidateOrgEntitlements(ownerPage.request, rig.orgId);
  } finally {
    await owner.close();
  }
});

// ===========================================================================
// THE HAIRLINE — T1's obligation. Both themes, both elements, all three tones.
// ===========================================================================

for (const style of ["bar", "bug"] as const) {
  test.describe(`the --sport-ink hairline (${style})`, () => {
    test(`${style}: the live dot carries a 1px solid --sport-ink border`, async ({ browser }) => {
      const page = await anonPage(browser);
      try {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.goto(`/overlay/fixtures/${rig.fixtureId}?style=${style}`);
        const dot = page.locator('[data-testid="ovl-live-dot"]');
        // The count is the anti-vacuity guard: `getComputedStyle` of nothing
        // throws, but a spec that only asserted "no offender" would pass on a
        // page that drew no dot at all.
        await expect(dot, `${style}: the live dot must render on a live fixture`).toHaveCount(1);
        const ink = await resolveInk(page, '[data-testid="ovl-live-dot"]');
        const rootInk = await resolveInk(page, "body");
        expect(
          ink,
          "the canvas must resolve the SPORT's ink, not the root default — sportThemeStyle did not apply",
        ).not.toBe(rootInk);

        const b = await borderOf(page, '[data-testid="ovl-live-dot"]', 0);
        expect(b.widths, `${style}: live dot border widths`).toEqual(["1px", "1px", "1px", "1px"]);
        expect(b.styles, `${style}: live dot border styles`).toEqual([
          "solid",
          "solid",
          "solid",
          "solid",
        ]);
        expect(b.colors, `${style}: live dot border colours must be --sport-ink (${ink})`).toEqual([
          ink,
          ink,
          ink,
          ink,
        ]);
      } finally {
        await page.context().close();
      }
    });

    test(`${style}: every card chip carries the hairline, and its own tone's fill`, async ({
      browser,
    }) => {
      const page = await anonPage(browser);
      try {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.goto(`/overlay/fixtures/${rig.fixtureId}?style=${style}`);
        const chips = page.locator('[data-testid="ovl-chip"]');
        // HOW MANY CHIPS IS PER THEME, and that is a product ruling rather than
        // an accident (`_THEMES.md` §4, 2026-09-10): §3's bar carries the WHOLE
        // detail list in its own 51 px band, while §4's bug caps its footer at
        // the two most recent entries — "a corner bug is not a log". So the bug
        // draws a SUFFIX of what the bar draws.
        //
        // The bug's number is NOT retyped here. `bug-footer-cap.test.tsx` pins
        // the cap; what only a browser can say is that the cap BITES on a real
        // ledger and that it keeps the NEWEST cards — a `slice(2)` instead of a
        // `slice(-2)` would still draw two bordered chips and satisfy every
        // per-chip assertion below.
        const rendered = await chips.count();
        if (style === "bar") {
          expect(rendered, "the bar shows one chip per card on the ledger").toBe(
            HOCKEY_CARD_TONES.length,
          );
        } else {
          expect(rendered, "the bug must still show cards").toBeGreaterThan(0);
          expect(
            rendered,
            `the bug's footer cap must BITE on ${HOCKEY_CARD_TONES.length} cards — it drew ${rendered}`,
          ).toBeLessThan(HOCKEY_CARD_TONES.length);
        }
        // The TAIL, so the tones assert which cards survived the cap and not
        // merely how many did.
        const expectedTones = HOCKEY_CARD_TONES.slice(-rendered);
        const ink = await resolveInk(page, '[data-testid="ovl-chip"]');

        const fills: string[] = [];
        for (const [i, { classKey, tone }] of expectedTones.entries()) {
          const b = await borderOf(page, '[data-testid="ovl-chip"]', i);
          expect(b.widths, `${style}: ${classKey} chip border widths`).toEqual([
            "1px",
            "1px",
            "1px",
            "1px",
          ]);
          expect(b.styles, `${style}: ${classKey} chip border styles`).toEqual([
            "solid",
            "solid",
            "solid",
            "solid",
          ]);
          expect(
            b.colors,
            `${style}: ${classKey} chip border colours must be --sport-ink (${ink})`,
          ).toEqual([ink, ink, ink, ink]);
          // The tone MAPPING, end to end: the engine's classKey chose this
          // chip's CSS class, which reads this token. A `disciplineTone` that
          // collapsed all three onto one tone would still draw three bordered
          // chips and satisfy every assertion above.
          expect(
            b.background,
            `${style}: the ${classKey} card must paint --sport-${tone}`,
          ).toBe(await resolveToken(page, `--sport-${tone}`));
          fills.push(b.background);
        }
        expect(
          new Set(fills).size,
          `${style}: every tone drawn must be its own colour, not one repeated (${fills.join(", ")})`,
        ).toBe(rendered);
      } finally {
        await page.context().close();
      }
    });
  });
}

// ===========================================================================
// The route's own behaviour
// ===========================================================================

test.describe("the overlay route", () => {
  test("an override switches overlay off → 404", async ({ browser }) => {
    expect(
      statusWhileDenied,
      "the same fixture, the same URL, an override-false row — the overlay must be indistinguishable from a missing fixture",
    ).toBe(404);
    const page = await anonPage(browser);
    try {
      const res = await page.goto(`/overlay/fixtures/${rig.fixtureId}`);
      expect(res?.status(), "and 200 once the override is gone: the rig's plan grants it on its own (V426)").toBe(200);
      await expect(page.locator('[data-testid="ovl-root"]')).toHaveCount(1);
    } finally {
      await page.context().close();
    }
  });

  test("an unusable ?style= falls back to the sport's default instead of throwing", async ({
    browser,
  }) => {
    const page = await anonPage(browser);
    try {
      // The positive half first, or "it rendered `bug`" proves nothing: a
      // route that ignored `?style=` entirely would pass the fallback case.
      const named = await page.goto(`/overlay/fixtures/${rig.fixtureId}?style=bar`);
      expect(named?.status()).toBe(200);
      await expect(page.locator('[data-testid="ovl-root"]')).toHaveAttribute("data-style", "bar");

      for (const bad of ["nonsense", "", "slate ", "BAR"]) {
        const res = await page.goto(
          `/overlay/fixtures/${rig.fixtureId}?style=${encodeURIComponent(bad)}`,
        );
        expect(res?.status(), `?style=${JSON.stringify(bad)} must not take a club off air`).toBe(
          200,
        );
        // hockey's default is `bug` (`template-registry.ts` `defaultTemplateFor`:
        // everything but cricket). Read from the registry's behaviour, not
        // retyped: `bar` above proves the parameter is honoured when valid.
        await expect(page.locator('[data-testid="ovl-root"]')).toHaveAttribute("data-style", "bug");
      }
    } finally {
      await page.context().close();
    }
  });

  test("?lang= picks the broadcast's language, not the org's", async ({ browser }) => {
    const page = await anonPage(browser);
    try {
      await page.goto(`/overlay/fixtures/${rig.fixtureId}?style=bar&lang=en`);
      const english = await page.locator('[data-testid="ovl-root"]').innerText();
      await page.goto(`/overlay/fixtures/${rig.fixtureId}?style=bar&lang=fr`);
      const french = await page.locator('[data-testid="ovl-root"]').innerText();
      // `overlay.header.live` — "Live" in en, "En direct" in fr. Both halves,
      // because a page that rendered neither would satisfy either alone.
      expect(english, "en: the live header").toContain("Live");
      expect(french, "fr: the live header").toContain("En direct");
      expect(french, "fr must not fall back to the English dictionary").not.toContain("Live");
    } finally {
      await page.context().close();
    }
  });

  test("the canvas is scaled to the viewport rather than scrolled", async ({ browser }) => {
    const page = await anonPage(browser);
    try {
      // `scrollWidth === clientWidth` is VACUOUS here: `globals.css:66-71` sets
      // `html, body { overflow-x: clip }` app-wide, so a 1920 px canvas in a
      // 320 px window reports no overflow whatever it does. The SCALE is the
      // measurable thing (`overlay-stage.tsx`: `min(vw/1920, vh/1080)`).
      for (const [w, h] of [
        [1920, 1080],
        [1280, 800],
        [768, 1024],
        [320, 568],
      ] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.goto(`/overlay/fixtures/${rig.fixtureId}?style=bar`);
        await expect(page.locator('[data-testid="ovl-root"]')).toHaveCount(1);
        const scale = await page.evaluate(() => {
          const el = document.querySelector<HTMLElement>('[data-testid="ovl-root"]');
          const m = new DOMMatrixReadOnly(getComputedStyle(el!).transform);
          return { a: m.a, d: m.d, width: el!.getBoundingClientRect().width };
        });
        const expected = Math.min(w / 1920, h / 1080);
        expect(scale.a, `x scale at ${w}x${h}`).toBeCloseTo(expected, 3);
        expect(scale.d, `y scale at ${w}x${h}`).toBeCloseTo(expected, 3);
        // The transform is not merely declared — it is what the box measures.
        expect(scale.width, `painted canvas width at ${w}x${h}`).toBeCloseTo(1920 * expected, 0);
      }
    } finally {
      await page.context().close();
    }
  });

  test("the segment paints no consent banner and sets no cookies", async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    try {
      await page.goto(`/overlay/fixtures/${rig.fixtureId}?style=bar`);
      await expect(page.locator('[data-testid="ovl-root"]')).toHaveCount(1);
      await expect(
        page.locator('[data-testid="cookie-consent"]'),
        "a consent banner on this route is burned into the club's broadcast",
      ).toHaveCount(0);
      expect(
        await context.cookies(),
        "the overlay segment sets no cookies — the claim cookie-consent.tsx makes about this spec",
      ).toEqual([]);

      // The positive half, in the SAME context: the banner is absent because
      // the segment suppresses it, not because this browser had already
      // dismissed it or because the testid moved.
      await page.goto(`/shared/${rig.orgSlug}/${rig.compSlug}/${rig.divSlug}`);
      await expect(
        page.locator('[data-testid="cookie-consent"]'),
        "the same fresh context must still be offered the banner off the overlay segment",
      ).toHaveCount(1);
    } finally {
      await context.close();
    }
  });
});

// ===========================================================================
// A RECORDED DEFECT, stated as the behaviour that SHOULD hold
// ===========================================================================

test.describe("§4's corner bug and its footer", () => {
  test("the tile shows a footer it cannot hold, and does not clip it", async ({ browser }) => {
    // FIXED 2026-09-10 — the `test.fail()` that stood here is gone and this
    // now runs as an ordinary test. It was written asserting the CORRECT
    // behaviour rather than freezing the live bug as an expected value
    // (AGENTS.md class 4), so closing the defect meant deleting one line and
    // changing no assertion. Everything below is the defect it was recorded
    // for, kept because it is why each of these numbers is what it is.
    //
    // WHAT WAS WRONG, found by looking at a picture and nothing else. With three
    // cards on the ledger the bug's footer (`.ovl-bug-footer`, a 45 px
    // `justify-content: space-between` flex row inside a 480 px tile) wraps to a
    // second line, and `.ovl-bug`'s `overflow: hidden` cuts it in half: "AWA
    // Red" is sliced through and the `·` separators leave stray dots along the
    // tile's bottom edge. `className="contents"` on each entry's wrapper
    // (`overlay-bug.tsx:84`) is what lets chip, label and separator wrap
    // independently — `display: contents` puts all three straight into the flex
    // container, so an "entry" is not a box that can be kept together.
    //
    // Owner ruling 2026-09-10 (`_THEMES.md` §4): the footer holds at most the
    // two most recent entries, on ONE nowrap line, and the tile must NOT grow
    // instead — an OBS operator frames the bug against their camera and a
    // graphic that changes height on air moves into the shot.
    //
    // MEASURED, with `test.fail()` lifted for one run: the tile clipped 9px of
    // its own footer at 1920x1080 (`overflow-y: hidden`).
    //
    // THE FIX (`overlay-bug.tsx`, `overlay-bar.tsx`, `globals.css`): the cap to
    // the two most recent entries, each in a real `.ovl-detail-entry` box, and
    // `white-space: nowrap` on the footer and the entry. The footer deliberately
    // does NOT take `overflow: hidden` — that would make it its own scroll
    // container and absorb any future wrap before the probe below could see it
    // (measured: 273 vs 273 with it, 299 vs 273 without).
    //
    // The visual gate cannot see this and could not have: `expectNoClip`
    // compares `scrollWidth` with `clientWidth`, so every VERTICAL clip in the
    // product is invisible to it.
    //
    // The PRECONDITIONS are held by normal tests, never by this one: under the
    // `test.fail()` this used to carry, a missing tile would have read as the
    // expected failure and masked itself. `bug: every card chip carries the
    // hairline` above renders this exact page and this exact footer, and reds
    // honestly if either is absent.
    const page = await anonPage(browser);
    try {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto(`/overlay/fixtures/${rig.fixtureId}?style=bug`);
      await expect(page.locator('[data-testid="ovl-detail"]')).toHaveCount(1);
      const overflow = await page.evaluate(() => {
        const tile = document.querySelector<HTMLElement>(".ovl-bug");
        if (!tile) throw new Error("no .ovl-bug on the page");
        return {
          scrollHeight: tile.scrollHeight,
          clientHeight: tile.clientHeight,
          overflowY: getComputedStyle(tile).overflowY,
        };
      });
      // VERTICAL only. §4 as corrected 2026-09-10 no longer allows a
      // horizontal clip either ("overflowing text ELLIPSES; it never clips and
      // never wraps") — that half is `.ovl-detail-label`'s, and the describe
      // below measures it at a non-English locale. This probe stays what it
      // was: content taller than the box it is drawn in is a line the viewer
      // simply never sees, and the tile is the only thing that could tell them.
      expect(
        overflow.scrollHeight - overflow.clientHeight,
        `the bug tile clips ${overflow.scrollHeight - overflow.clientHeight}px of its own footer (overflow-y: ${overflow.overflowY})`,
      ).toBeLessThanOrEqual(1);
    } finally {
      await page.context().close();
    }
  });
});

// ===========================================================================
// §4 as corrected — the footer ELLIPSES, AT A NON-ENGLISH LOCALE
//
// Every visual row and every browser assertion in this suite ran in English
// until this test, which is why a Spanish card label overflowing the tile was
// invisible to all of it: an English-only suite cannot witness this class at
// all. `overlay.detail.card` is `"{side} {card}"` in every locale and es/fr/nl
// carry real translations since `e00bba49f`.
//
// WHAT THIS MEASURES AND WHAT IT DOES NOT, stated rather than implied.
// Measured in Chromium against the real stylesheet and this exact hockey seed
// (green/yellow/red, so the footer's two most recent are yellow + red):
// the es pair "AWA Tarjeta amarilla" / "AWA Tarjeta roja" runs about 3 px past
// its share of a 480 px tile — so the ellipsis DOES bite here, but only just,
// and removing it produces no tile overhang on this seed. The 170-px overflow
// the ruling was written for needs icehockey's `gameMisconduct` / `match`
// classes ("AWA Wangedrag in de wedstrijd" measures 299 px against 229 px of
// room, and 18 px of tile overhang without the guard), and NO fixture this rig
// can seed produces them. So the discriminating assertions below are the
// COMPUTED properties — each dies to its own mutant, whatever the font metrics
// happen to be on the runner — plus the locale differential. The tile
// invariants are the sheet's rule and are asserted, but they do not
// discriminate on this seed and are not claimed to.
// ===========================================================================

interface FooterProbe {
  tileWidth: number;
  /** `--ovl-bug-w`, the width the stylesheet declares for the tile (R2007: 560, was 480) — read, never retyped. */
  declaredWidth: number;
  overhang: number;
  vclip: number;
  entryMinWidths: string[];
  chipShrinks: string[];
  labels: {
    text: string;
    scrollWidth: number;
    clientWidth: number;
    textOverflow: string;
    overflowX: string;
    minWidth: string;
  }[];
}

async function readBugFooter(page: Page, fixtureId: string, lang: string): Promise<FooterProbe> {
  await page.goto(`/overlay/fixtures/${fixtureId}?style=bug&lang=${lang}`);
  await expect(page.locator('[data-testid="ovl-detail"]')).toHaveCount(1);
  return page.evaluate(() => {
    const tile = document.querySelector<HTMLElement>(".ovl-bug");
    if (!tile) throw new Error("no .ovl-bug on the page");
    const read = (sel: string, prop: "minWidth" | "flexShrink") =>
      [...document.querySelectorAll<HTMLElement>(sel)].map((el) => getComputedStyle(el)[prop]);
    return {
      tileWidth: tile.getBoundingClientRect().width,
      declaredWidth: parseFloat(getComputedStyle(tile).getPropertyValue("--ovl-bug-w")),
      overhang: tile.scrollWidth - tile.clientWidth,
      vclip: tile.scrollHeight - tile.clientHeight,
      entryMinWidths: read(".ovl-bug-footer .ovl-detail-entry", "minWidth"),
      chipShrinks: read(".ovl-bug-footer .ovl-chip", "flexShrink"),
      labels: [...document.querySelectorAll<HTMLElement>(".ovl-bug-footer .ovl-detail-label")].map(
        (l) => {
          const cs = getComputedStyle(l);
          return {
            text: l.textContent ?? "",
            scrollWidth: l.scrollWidth,
            clientWidth: l.clientWidth,
            textOverflow: cs.textOverflow,
            overflowX: cs.overflowX,
            minWidth: cs.minWidth,
          };
        },
      ),
    };
  });
}

test.describe("§4's footer at a non-English locale", () => {
  test("the card labels ellipse instead of reaching the tile, and es really is longer than en", async ({
    browser,
  }) => {
    const page = await anonPage(browser);
    try {
      await page.setViewportSize({ width: 1920, height: 1080 });
      const es = await readBugFooter(page, rig.fixtureId, "es");
      const en = await readBugFooter(page, rig.fixtureId, "en");

      // PREMISE first, or everything below is satisfied by an empty footer.
      expect(es.labels.length, "the es broadcast renders §4's two capped entries").toBe(2);
      expect(en.labels.length).toBe(2);
      expect(
        es.labels.map((l) => l.text),
        "es must not fall back to the English dictionary — that is the blindness this test exists for",
      ).not.toEqual(en.labels.map((l) => l.text));

      // THE MECHANISM, one assertion per property. `text-overflow` paints
      // nothing without a non-visible `overflow`, and a flex item will not
      // shrink below its content while `min-width` is `auto` — so all three
      // have to be in effect, not merely declared, and each of the three has
      // its own mutant.
      for (const label of es.labels) {
        expect(label.textOverflow, `${label.text}: §4 binds an ellipsis, not a clip`).toBe(
          "ellipsis",
        );
        expect(label.overflowX, `${label.text}: an ellipsis needs a clipped box to sit in`).toBe(
          "hidden",
        );
        expect(label.minWidth, `${label.text}: min-width:auto refuses to shrink`).toBe("0px");
      }
      // The chain either side of the label: the entry gives, the chip does not
      // (a shrinking chip is a card with no colour). Counted against what is
      // ACTUALLY on the row rather than against a literal 2 — a green card is a
      // 2-minute suspension and a yellow a 5-minute one, so a slow runner can
      // legitimately reach this test with the strength line back in the pair.
      expect(es.entryMinWidths.length, "one guard per entry").toBe(es.labels.length);
      for (const mw of es.entryMinWidths) {
        expect(mw, "an entry that cannot shrink pushes the row out").toBe("0px");
      }
      expect(es.chipShrinks.length, "at least one card chip must be on the row").toBeGreaterThan(0);
      for (const fs of es.chipShrinks) expect(fs, "a shrinking chip is a card with no colour").toBe("0");

      // THE DIFFERENTIAL that makes this a locale test and not a second copy
      // of the English one: the Spanish labels are measurably wider, in the
      // same font, on the same tile.
      const width = (p: FooterProbe) => p.labels.reduce((n, l) => n + l.scrollWidth, 0);
      expect(
        width(es),
        `es labels ${width(es)}px vs en ${width(en)}px — if these are equal the es dictionary is not reaching the overlay`,
      ).toBeGreaterThan(width(en));

      // THE SHEET'S INVARIANT. Not the discriminating assertion on this seed
      // (see the block comment above), but it is what §4 binds and it is what
      // will bite first when a longer sport reaches this route.
      expect(es.declaredWidth, "premise: the stylesheet declares --ovl-bug-w").toBeGreaterThan(0);
      expect(es.tileWidth, "the tile must never grow — an OBS operator frames it").toBe(es.declaredWidth);
      expect(
        es.overhang,
        `the es footer overhangs the tile by ${es.overhang}px; §4 says nothing may`,
      ).toBeLessThanOrEqual(1);
      expect(es.vclip, `and clips ${es.vclip}px of it vertically`).toBeLessThanOrEqual(1);
    } finally {
      await page.context().close();
    }
  });
});

// ===========================================================================
// THE SCORE — the one thing this feature exists to put on air, and until now
// no browser and no HTTP test ever read one off this route. Every assertion in
// this file was satisfied by ANY score, a blank one included (AGENTS.md 19 at
// feature scale): `overlay-stage.tsx` has a hold branch that deliberately
// paints an empty canvas, and `use-live-fixture`'s `data` can hold a value the
// consumer must not paint.
//
// 2–1 rather than 1–0: a wrong answer that happened to be a constant, or a
// renderer that painted the home value into both rows, passes 1–0 and 0–0 far
// too easily. The baseline is read BEFORE the goals so the expectation is a
// real differential — one fixture, one URL, three events.
// ===========================================================================

test.describe("the overlay puts the right score on air", () => {
  test("the big numbers follow the ledger, in BOTH themes", async ({ browser }) => {
    test.setTimeout(120_000);
    const owner = await browser.newContext();
    const ownerPage = await owner.newPage();
    const page = await anonPage(browser);
    try {
      await signInAs(ownerPage, rig.ownerEmail);

      const scoreOn = async (style: "bar" | "bug") => {
        await page.goto(`/overlay/fixtures/${rig.fixtureId}?style=${style}`);
        await expect(page.locator('[data-testid="ovl-root"]')).toHaveCount(1);
        return {
          home: await page.locator('[data-testid="ovl-big-home"]').innerText(),
          away: await page.locator('[data-testid="ovl-big-away"]').innerText(),
        };
      };

      expect(await scoreOn("bug"), "a goalless fixture is the baseline, not the answer").toEqual({
        home: "0",
        away: "0",
      });

      await sendEvent(ownerPage.request, rig.fixtureId, "hockey.goal", { by: rig.homeEntrantId, kind: "fg" });
      await sendEvent(ownerPage.request, rig.fixtureId, "hockey.goal", { by: rig.awayEntrantId, kind: "fg" });
      await sendEvent(ownerPage.request, rig.fixtureId, "hockey.goal", { by: rig.homeEntrantId, kind: "fg" });

      // A poll with a reload, not a bare assertion: the public row this route
      // reads is `unstable_cache`-wrapped, so the first load after a write can
      // legitimately still be serving the old snapshot.
      for (const style of ["bug", "bar"] as const) {
        await expect
          .poll(async () => JSON.stringify(await scoreOn(style)), {
            message: `${style}: the overlay must show 2-1 once the ledger does`,
            timeout: 60_000,
            intervals: [2_000],
          })
          .toBe(JSON.stringify({ home: "2", away: "1" }));
      }
    } finally {
      await owner.close();
      await page.context().close();
    }
  });
});

// ===========================================================================
// OWNER BUG 2026-10-15 — the end card stayed on air after an UNDO.
//
// Live proof of concept: the match was decided, the overlay put up its
// Result card, the scorer undid the deciding point — and the card stayed.
// The server had reopened the fixture (status back to in_play); the page had
// stopped listening the moment a poll brought `decided` (`useLiveFixture`'s
// `live` predicate), so it never heard about the undo.
//
// NO RELOAD anywhere in this test, and that is the whole point: OBS keeps one
// browser source open for the broadcast, and a reload would hide the defect
// by refetching. The sequence is the test — decide → undo → re-decide → undo
// — in two sports whose deciding writes differ in shape (a badminton rally,
// a cricket innings summary).
//
// BOTH transports died at `decided`, so each is held to its own budget, and
// each step RECORDS which transport carried it rather than assuming one. On
// CI's stub Supabase host the overlay stays on the poll. A card-up step is
// polled from an OPEN fixture (every POLL_MS); a card-down step from a
// SETTLED one (every SETTLED_POLL_MS, the bounded post-match window) — both
// budgets derived from the hook's own constants (AGENTS.md #20). Where a
// private channel really SUBSCRIBES (a server with the ES256 signing key) and
// stayed subscribed across the whole step, the step must land well under
// POLL_MS: the channel survived `decided`. A step that neither transport
// delivers within the slowest path's budget fails, naming the transport.
// ===========================================================================

const SLACK_MS = 15_000;
/** Poll path, from an open fixture (the card goes up). */
const OPEN_POLL_STEP_MS = POLL_MS + SLACK_MS;
/** Poll path, from a settled fixture (the card comes down). */
const SETTLED_POLL_STEP_MS = SETTLED_POLL_MS + SLACK_MS;
/** Realtime path: a push, not a poll. */
const REALTIME_STEP_MS = POLL_MS / 2;

const UNDO_CASES = [
  {
    // `short`: to 11, best of three — 21 unanswered rallies leave home one rally from the match.
    sportKey: "badminton",
    variantKey: "short",
    entrantKind: "individual" as const,
    approach: async (request: Page["request"], r: OverlayRig) => {
      for (let i = 0; i < 21; i++) await sendEvent(request, r.fixtureId, "badminton.rally", { wonBy: r.homeEntrantId });
    },
    decide: (request: Page["request"], r: OverlayRig) =>
      sendEvent(request, r.fixtureId, "badminton.rally", { wonBy: r.homeEntrantId }),
  },
  {
    // A T20 whose chase falls short in its full quota: the second innings' summary decides it.
    sportKey: "cricket",
    variantKey: "t20",
    entrantKind: "team" as const,
    approach: async (request: Page["request"], r: OverlayRig) => {
      await sendEvent(request, r.fixtureId, "cricket.innings.summary", { runs: 150, wickets: 5, legalBalls: 120 });
    },
    decide: (request: Page["request"], r: OverlayRig) =>
      sendEvent(request, r.fixtureId, "cricket.innings.summary", { runs: 100, wickets: 6, legalBalls: 120 }),
  },
];

test.describe("an undo of the deciding write takes the end card down on the OPEN page", () => {
  for (const c of UNDO_CASES) {
    test(`${c.sportKey}: decide → card up → undo → down → re-decide → up → undo → down, never reloaded`, async ({
      browser,
    }) => {
      test.setTimeout(120_000 + 2 * OPEN_POLL_STEP_MS + 2 * SETTLED_POLL_STEP_MS);
      const owner = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      const ownerPage = await owner.newPage();
      const page = await anonPage(browser);
      try {
        const r = await seedUndoOverlayFixture(ownerPage, {
          sportKey: c.sportKey,
          variantKey: c.variantKey,
          entrantKind: c.entrantKind,
          prefix: `ovlu${c.sportKey.slice(0, 2)}`,
        });
        await c.approach(ownerPage.request, r);

        await page.goto(`/overlay/fixtures/${r.fixtureId}`);
        const root = page.getByTestId("ovl-root");
        await expect(root).toHaveCount(1);
        const card = page.getByTestId("ovl-slate");
        await expect(card, "empty case first: an in-play match carries no end card").toHaveCount(0);
        let reloads = 0;
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) reloads++;
        });
        // Give a real channel its chance to subscribe before the first write, so a step is not sent mid-handshake.
        // `waitForFunction(fn, arg, options)`: options is the THIRD argument (see the private-realtime test). Whether
        // it subscribed is NOT taken from here — every step reads the transport itself, below.
        await page
          .waitForFunction(
            () => document.querySelector('[data-testid="ovl-root"]')?.getAttribute("data-transport") === "realtime",
            undefined,
            { timeout: 8_000 },
          )
          .catch(() => {});
        const transport = async (): Promise<"realtime" | "poll"> => {
          const t = await root.getAttribute("data-transport");
          expect(["realtime", "poll"], `data-transport is one of the two transports, got ${t}`).toContain(t);
          return t as "realtime" | "poll";
        };
        const paths: string[] = [];

        const cardIs = async (up: boolean, step: string) => {
          // The slowest path this step can legitimately take: the poll, at the rate of the tier the page is in.
          const pollBudget = up ? OPEN_POLL_STEP_MS : SETTLED_POLL_STEP_MS;
          const before = await transport();
          const t0 = Date.now();
          const delivered = up
            ? expect(card).toHaveAttribute("data-slate-state", "ended", { timeout: pollBudget })
            : expect(card).toHaveCount(0, { timeout: pollBudget });
          await delivered.catch(async (e: unknown) => {
            throw new Error(
              `${c.sportKey} ${step}: NEITHER transport delivered within ${pollBudget}ms (the poll budget) — the page ` +
                `was on "${before}" when the write was sent and on "${await transport()}" after; the end card should be ` +
                `${up ? "UP" : "DOWN"}.\n${String(e)}`,
            );
          });
          const elapsed = Date.now() - t0;
          const after = await transport();
          // The path that ran: realtime only if the channel was subscribed for the WHOLE step; otherwise the poll did it.
          const path = before === "realtime" && after === "realtime" ? "realtime" : "poll";
          const budget = path === "realtime" ? REALTIME_STEP_MS : pollBudget;
          paths.push(path);
          test.info().annotations.push({ type: "step", description: `${c.sportKey} ${step}: ${path} ${elapsed}ms (budget ${budget}ms)` });
          expect(elapsed, `${c.sportKey} ${step}: delivered over ${path} in ${elapsed}ms, over its ${budget}ms budget`).toBeLessThanOrEqual(budget);
        };
        const undo = (eventId: string) => sendEvent(ownerPage.request, r.fixtureId, "core.void", { event_id: eventId });

        const first = await c.decide(ownerPage.request, r);
        await cardIs(true, "after the deciding write");
        await undo(first);
        await cardIs(false, "after the undo");
        const second = await c.decide(ownerPage.request, r);
        await cardIs(true, "after re-deciding");
        await undo(second);
        await cardIs(false, "after the second undo");

        expect(reloads, "the OBS page was never reloaded — every change arrived over its own transport").toBe(0);
        // Anti-vacuity: four steps, each with its path recorded.
        expect(paths, "every step recorded the transport that carried it").toHaveLength(4);
        test.info().annotations.push({ type: "transport", description: `${c.sportKey}: ${paths.join(", ")}` });
      } finally {
        await owner.close();
        await page.context().close();
      }
    });
  }
});

// ===========================================================================
// R2006 (owner ruling 2026-10-19, "Option C"; overlay templates spec §4.4 D5–D7): the OBS tab's score STYLE GRID.
//
// It replaced §8's style tabs and the one big preview. What only a browser can see, and so what this test owns:
//  - PAINT: every thumbnail is the real `<OverlayPreview>`, its 1920×1080 canvas scaled to its OWN measured cell at
//    1280, 768 and 320 — a constant scale satisfies one width only (§8's shipped defect, now per cell). No page scroll.
//  - TAP: every option and every scene segment is a real 44px target where the finger lands (elementFromPoint).
//  - SCENES: each segment moves EVERY thumbnail (data-scene), never persisted.
//  - THE SEAM: a pick is saved (PUT stream-settings), survives a reload, moves the OBS link (`?template=`, never
//    `?style=`), and the anonymous overlay page opening that link renders the picked template.
// The expected default is the overlay page's own (`ovl-root` data-style with no query), never a value typed here.
//
// The panel is opened ONCE, at 1280, and the viewport is then narrowed: the Stream control is a desktop button that
// becomes a strip icon below 768 (spec 2026-09-30 §2), and clicking that is a different test's problem
// (stream-relay.spec.ts opens it at every width). React state survives a resize.
// ===========================================================================

test.describe("R2006: the OBS tab's score style grid", () => {
  test("a real thumbnail per template fits its cell at every width; scenes move them all; a pick persists and moves the OBS link", async ({ browser }) => {
    test.setTimeout(150_000);
    const owner = await browser.newContext();
    const page = await owner.newPage();
    const obs = await anonPage(browser);
    try {
      // The overlay page's own default for this fixture — the producer the picker must agree with.
      await obs.goto(`/overlay/fixtures/${rig.fixtureId}`);
      const root = obs.locator('[data-testid="ovl-root"]');
      await expect(root).toHaveCount(1, { timeout: 30_000 });
      const pageDefault = await root.getAttribute("data-style");
      expect(pageDefault, "the overlay page resolves a template with no query").toBeTruthy();

      await signInAs(page, rig.ownerEmail);
      await page.setViewportSize({ width: 1280, height: 900 });
      await openFixture(page, rig);
      const control = streamControl(page);
      await expect(control, "the rig's org holds streaming.overlay, so the fixture page offers Stream").toHaveCount(1);
      await control.click();
      await expect(page.locator('[data-testid="stream-tab-phone"]'), "the panel opens on its Phone tab").toHaveAttribute("aria-selected", "true");
      await page.locator('[data-testid="stream-tab-obs"]').click();
      await expect(page.locator('[data-testid="stream-tab-obs"]')).toHaveAttribute("aria-selected", "true");
      // §8's style tabs and big preview are gone (Option C item 4).
      await expect(page.locator('[data-testid="stream-preview"]')).toHaveCount(0);
      await expect(page.locator("[data-stream-style]")).toHaveCount(0);
      const picker = page.locator('[data-testid="stream-template-picker"]');
      await expect(picker).toHaveCount(1);
      const options = picker.locator('[role="radio"][data-template]');
      const ids = await options.evaluateAll((els) => els.map((el) => el.getAttribute("data-template")!));
      console.log(`templates offered: ${ids.length} (${ids.join(", ")})`);
      expect(ids.length, "a choice needs at least two templates").toBeGreaterThanOrEqual(2);
      expect(new Set(ids).size, "one option per template").toBe(ids.length);
      expect(ids, "the overlay page's default is one of them").toContain(pageDefault);
      const checked = () => picker.locator('[role="radio"][data-template][aria-checked="true"]');
      await expect(checked()).toHaveCount(1);
      await expect(checked(), "nothing stored: the panel opens on the overlay page's own default").toHaveAttribute("data-template", pageDefault!);
      const link = page.locator('[data-testid="stream-link"]');
      const linkUrl = async () => new URL(await link.inputValue());
      await expect.poll(async () => (await linkUrl()).searchParams.get("template"), { timeout: 30_000 }).toBe(pageDefault);
      expect((await linkUrl()).searchParams.has("style"), "the panel writes ?template=, never ?style=").toBe(false);

      // PAINT + TAP at every width.
      const measure = () =>
        page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('[data-testid="stream-template-picker"] [role="radio"][data-template]')].map((opt) => {
            const cell = opt.querySelector<HTMLElement>("span[aria-hidden]")!;
            const canvas = opt.querySelector<HTMLElement>('[data-testid="ovl-preview-canvas"]')!;
            const c = canvas.getBoundingClientRect();
            const box = opt.getBoundingClientRect();
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + Math.min(box.height / 2, 40));
            return {
              id: opt.getAttribute("data-template"),
              cellW: cell.clientWidth, cellH: cell.clientHeight, canvasW: c.width, canvasH: c.height,
              optH: box.height, hitOwn: hit !== null && opt.contains(hit),
            };
          }),
        );
      let thumbs = 0;
      const at: Record<number, number> = {};
      for (const w of [1280, 768, 320]) {
        await page.setViewportSize({ width: w, height: 900 });
        await expect
          .poll(async () => (await measure()).every((b) => b.cellW > 0 && Math.abs(b.canvasW - b.cellW) <= 1.5), {
            message: `at ${w}: every thumbnail's canvas must settle to its own cell's width`,
            timeout: 15_000,
            intervals: [250],
          })
          .toBe(true);
        const boxes = await measure();
        expect(boxes.map((b) => b.id), `${w}: every option still there`).toEqual(ids);
        for (const b of boxes) {
          expect(Math.abs(b.canvasW - b.cellW), `${w} ${b.id}: a ${b.canvasW}px canvas in a ${b.cellW}px cell`).toBeLessThanOrEqual(1.5);
          expect(Math.abs(b.canvasH - b.cellH), `${w} ${b.id}: a ${b.canvasH}px canvas in a ${b.cellH}px cell, vertically`).toBeLessThanOrEqual(1.5);
          expect(b.optH, `${w} ${b.id}: the option is a 44px target`).toBeGreaterThanOrEqual(44);
          expect(b.hitOwn, `${w} ${b.id}: a tap on the option lands on the option`).toBe(true);
          thumbs++;
        }
        for (const scene of OVERLAY_SCENES) {
          const seg = page.locator(`[data-testid="stream-scene-${scene.id}"]`);
          const box = (await seg.boundingBox())!;
          expect(box.height, `${w} ${scene.id}: ${w < 768 ? 44 : 36}px segment`).toBeGreaterThanOrEqual(w < 768 ? 44 : 36);
          const hitOwn = await seg.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return hit !== null && el.contains(hit);
          });
          expect(hitOwn, `${w} ${scene.id}: a tap on the segment lands on it`).toBe(true);
        }
        await expectNoHorizontalScroll(page);
        at[w] = boxes[0]!.canvasW;
      }
      console.log(`thumbnails checked: ${thumbs}`);
      expect(thumbs).toBe(ids.length * 3);
      // The differential: a constant scale would paint the same width everywhere.
      expect(at[320], `the first thumbnail is ${at[320]}px at 320 and ${at[1280]}px at 1280 — each width measures its own cell`).not.toBe(at[1280]);

      // SCENES: each segment moves every thumbnail; the first declared scene is where it opens.
      await page.setViewportSize({ width: 1280, height: 900 });
      const scenesOf = () => picker.locator('[data-testid="ovl-preview"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-scene")));
      expect(await scenesOf(), "opens on the first declared scene").toEqual(ids.map(() => OVERLAY_SCENES[0].id));
      let scenes = 0;
      for (const scene of [...OVERLAY_SCENES].reverse()) {
        await page.locator(`[data-testid="stream-scene-${scene.id}"]`).click();
        await expect(page.locator(`[data-testid="stream-scene-${scene.id}"]`)).toHaveAttribute("aria-checked", "true");
        await expect.poll(scenesOf, { message: `scene ${scene.id} on every thumbnail` }).toEqual(ids.map(() => scene.id));
        scenes++;
      }
      console.log(`scenes checked: ${scenes}`);
      expect(scenes).toBe(OVERLAY_SCENES.length);

      // THE SEAM: pick the other template; it is saved, moves the link, survives a reload, and OBS renders it.
      const other = ids.find((id) => id !== pageDefault)!;
      const saved = page.waitForResponse(
        (r) => r.request().method() === "PUT" && new URL(r.url()).pathname === `/api/v1/fixtures/${rig.fixtureId}/stream-settings`,
      );
      await picker.locator(`[role="radio"][data-template="${other}"]`).click();
      const res = await saved;
      expect(res.status(), "the pick is saved").toBe(200);
      expect(res.request().postDataJSON(), "the body names the template alone").toEqual({ overlayTemplate: other });
      await expect(checked()).toHaveAttribute("data-template", other);
      await expect.poll(async () => (await linkUrl()).searchParams.get("template")).toBe(other);
      await page.reload();
      await expect(page.locator('[data-role="console-scoring"], [data-role="console-stream"]').first()).toBeAttached({ timeout: 30_000 });
      await streamControl(page).click();
      await page.locator('[data-testid="stream-tab-obs"]').click();
      await expect(checked(), "the stored pick, after a reload").toHaveAttribute("data-template", other);
      await expect.poll(async () => (await linkUrl()).searchParams.get("template"), { timeout: 30_000 }).toBe(other);
      expect((await linkUrl()).searchParams.has("style")).toBe(false);
      await obs.goto((await linkUrl()).toString());
      await expect(root, "OBS opening the copied link renders the picked template").toHaveAttribute("data-style", other, { timeout: 30_000 });
    } finally {
      // Back to "nothing stored", so no later test in this serial file inherits the pick.
      await apiJson(page.request, `/api/v1/fixtures/${rig.fixtureId}/stream-settings`, "PUT", { overlayTemplate: null }).catch(() => undefined);
      await obs.context().close();
      await owner.close();
    }
  });

  // PR #989 review m6: the WAI-ARIA radio group pattern, in a real browser — focus is what a keyboard user has, and only
  // a browser moves it. Each group is ONE tab stop (the checked radio); the arrows move AND select, wrapping; Tab leaves.
  test("the keyboard: each radiogroup is one tab stop; the arrows move focus and the selection, wrapping; a keyboard pick is saved", async ({ browser }) => {
    test.setTimeout(90_000);
    const owner = await browser.newContext();
    const page = await owner.newPage();
    try {
      await signInAs(page, rig.ownerEmail);
      await page.setViewportSize({ width: 1280, height: 900 });
      await openFixture(page, rig);
      await streamControl(page).click();
      await page.locator('[data-testid="stream-tab-obs"]').click();
      const picker = page.locator('[data-testid="stream-template-picker"]');
      const ids = await picker.locator('[role="radio"][data-template]').evaluateAll((els) => els.map((el) => el.getAttribute("data-template")!));
      expect(ids.length, "premise: at least two templates").toBeGreaterThanOrEqual(2);
      const focused = () => page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el?.getAttribute("data-template") ?? el?.getAttribute("data-testid") ?? el?.tagName ?? null;
      });
      const tabStops = (group: string) => page.locator(`[data-testid="${group}"] [role="radio"][tabindex="0"]`);
      await expect(tabStops("stream-scene-group"), "the scene group: one tab stop").toHaveCount(1);
      await expect(tabStops("stream-template-group"), "the template group: one tab stop").toHaveCount(1);
      const start = (await picker.locator('[role="radio"][data-template][aria-checked="true"]').getAttribute("data-template"))!;

      // Scenes: from the checked scene, ArrowRight moves the scene and focus; Tab goes to the CHECKED template (the
      // template group's only stop), never to its first option by default.
      const scenes = OVERLAY_SCENES.map((x) => `stream-scene-${x.id}`);
      await page.getByTestId(scenes[0]!).focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByTestId(scenes[1]!)).toHaveAttribute("aria-checked", "true");
      expect(await focused(), "focus follows the scene").toBe(scenes[1]);
      await page.keyboard.press("Tab");
      expect(await focused(), "Tab lands on the checked template").toBe(start);

      // Templates: ArrowRight picks the next option in order (wrapping), focus follows, and the pick is saved.
      const next = ids[(ids.indexOf(start) + 1) % ids.length]!;
      const saved = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === `/api/v1/fixtures/${rig.fixtureId}/stream-settings`);
      await page.keyboard.press("ArrowRight");
      const res = await saved;
      expect(res.status()).toBe(200);
      expect(res.request().postDataJSON(), "a keyboard pick is a pick").toEqual({ overlayTemplate: next });
      await expect(picker.locator(`[role="radio"][data-template="${next}"]`)).toHaveAttribute("aria-checked", "true");
      expect(await focused(), "focus follows the selection").toBe(next);
      await expect(tabStops("stream-template-group"), "still one tab stop — now the new selection").toHaveCount(1);
      await expect(tabStops("stream-template-group")).toHaveAttribute("data-template", next);
      // Wrap: ArrowLeft from the first option lands on the last.
      await page.keyboard.press("Home");
      await expect(picker.locator(`[role="radio"][data-template="${ids[0]}"]`)).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("ArrowLeft");
      await expect(picker.locator(`[role="radio"][data-template="${ids[ids.length - 1]}"]`)).toHaveAttribute("aria-checked", "true");
      expect(await focused()).toBe(ids[ids.length - 1]);
      // Tab leaves the group: the next stop is not a template; Shift+Tab comes back to the checked one.
      await page.keyboard.press("Tab");
      expect(ids, "Tab leaves the template group").not.toContain(await focused());
      await page.keyboard.press("Shift+Tab");
      expect(await focused(), "Shift+Tab returns to the checked template").toBe(ids[ids.length - 1]);
    } finally {
      await apiJson(page.request, `/api/v1/fixtures/${rig.fixtureId}/stream-settings`, "PUT", { overlayTemplate: null }).catch(() => undefined);
      await owner.close();
    }
  });
});

// ===========================================================================
// V426 (Task 14b): the Phone tab on the plan with the LEAST — community.
// ===========================================================================

/** The English copy the card must read, from the dictionary itself — never
 *  typed here, so a copy edit moves the expectation with it. */
const EN_UI = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;
const en = (key: string, vars: Record<string, number> = {}): string => {
  const raw = EN_UI[key];
  if (raw === undefined) throw new Error(`en/ui.json has no ${key}`);
  return raw.replace(/\{(\w+)\}/g, (_, v: string) => String(vars[v]));
};

test.describe("the Phone tab on a community org (V426)", () => {
  // Single-sport (hockey) by design: the plan gate, the monthly grant and the credit lines are org-level and read no
  // sport; the overlay kit's seed is a rostered hockey fixture, and nothing on this path branches on it.
  // A rig of its own: this block moves its org's PLAN and writes an org-wide
  // `streaming.relay` override, neither of which may reach `rig` above.
  let community: OverlayRig;
  let rate = 0;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const owner = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const ownerPage = await owner.newPage();
    try {
      community = await seedOverlayFixture(ownerPage);
      // Seeded on pro (the kit's recipe needs a paid plan's limits to build a
      // rostered hockey fixture), then moved to community BEFORE any page read
      // grants this period's credits — so the grant the page makes is the
      // community rate, read from V426's row.
      ({ monthlyMatchCredits: rate } = await setRigPlan(community.orgId, "community"));
      await invalidateOrgEntitlements(ownerPage.request, community.orgId);
    } finally {
      await owner.close();
    }
  });

  /** The fixture page's stream panel, open — on its default Phone tab (spec §3.1, T9b). */
  async function openPanel(page: Page): Promise<void> {
    await openFixture(page, community);
    const control = streamControl(page);
    await expect(control, "community holds streaming.overlay (V426), so the fixture page offers Stream").toHaveCount(1);
    await control.click();
    await expect(page.locator('[data-testid="stream-tab-phone"]'), "the panel opens on its Phone tab").toHaveAttribute("aria-selected", "true");
  }

  /** …then the OBS overlay tab, the second — one tap away. */
  async function openObsTab(page: Page): Promise<void> {
    await openPanel(page);
    await page.locator('[data-testid="stream-tab-obs"]').click();
    await expect(page.locator('[data-testid="stream-tab-obs"]')).toHaveAttribute("aria-selected", "true");
  }

  async function openPhoneTab(page: Page): Promise<void> {
    await openPanel(page);
    await page.locator('[data-testid="stream-tab-phone"]').click();
  }

  test("opens with no upgrade gate, grants the plan's free match credits on the read, and says so on the card", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    expect(rate, "V426 declares a community rate of at least one match").toBeGreaterThanOrEqual(1);
    // The project's storageState, as the live-preview test above: it carries the pre-dismissed cookie banner, which
    // an empty context paints over the run sheet's first row — over the stream toggle itself.
    const owner = await browser.newContext();
    const page = await owner.newPage();
    try {
      await signInAs(page, community.ownerEmail);
      await page.setViewportSize({ width: 1280, height: 900 });
      await openPhoneTab(page);

      const gate = page.locator('[data-testid="stream-phone-gate"]');
      await expect(gate.locator("[data-phone-body]"), "the Phone tab body, not the relay's UpgradeGate").toHaveCount(1, {
        timeout: 30_000,
      });
      await expect(gate.locator(":scope > a"), "no UpgradeGate pill in the tab").toHaveCount(0);

      // The org owned NO credits before this render: the balance is the grant
      // the page's own read made (R3b), at the community rate.
      await expect(page.locator('[data-testid="stream-balance"]')).toHaveText(
        rate === 1 ? en("stream.phone.credits.one") : en("stream.phone.credits.other", { n: rate }),
      );
      // No bought credits yet, so there is nothing to SPLIT: the line is hidden (review M2 — "1 free this month · 0
      // bought" read as a nudge, not information), and the chip alone says it.
      await expect(page.locator('[data-testid="stream-credits-split"]')).toHaveCount(0);

      // The positive half: with credits in BOTH buckets the same line appears, summing to the chip.
      const bought = 2;
      expect(await grantRigPackCredits(community.orgId, bought), "the org total after the bought credits").toBe(rate + bought);
      await openPhoneTab(page);
      await expect(page.locator('[data-testid="stream-balance"]')).toHaveText(
        en("stream.phone.credits.other", { n: rate + bought }),
        { timeout: 30_000 },
      );
      await expect(page.locator('[data-testid="stream-credits-split"]')).toHaveText(
        en("stream.credits.split", { m: rate, p: bought }),
      );

      await page.locator('[data-testid="stream-buy-more"]').click();
      await expect(page.locator('[data-testid="stream-credits-monthly"]')).toHaveText(
        rate === 1 ? en("stream.credits.monthlyNote.one") : en("stream.credits.monthlyNote.other", { n: rate }),
      );

      // The card is open with both new lines on it: nothing in the PANEL may reach past the viewport at any width.
      // Scoped to the panel, not the page: at 320 the division page already overflows by ~56 px from the "Now
      // playing" chip (stages-panel.tsx — two 9rem names side by side), with this panel closed, on main as well.
      // That is not this card's to fix, and a page-level check here would stay red for a reason it cannot move.
      let widths = 0;
      for (const width of [1280, 768, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(page.locator('[data-testid="stream-credits-monthly"]')).toBeVisible();
        const seen = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          const panel = document.querySelector<HTMLElement>('[data-testid="stream-panel"]');
          if (!panel) return { checked: 0, past: ["stream-panel is not in the DOM"] };
          const boxes = [panel, ...Array.from(panel.querySelectorAll<HTMLElement>("*"))];
          const past = boxes
            .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > vw + 1)
            .map((el) => `${el.tagName.toLowerCase()}[${el.dataset.testid ?? ""}] right=${Math.round(el.getBoundingClientRect().right)}`);
          return { checked: boxes.length, past };
        });
        expect(seen.checked, `${width}: no panel box was measured`).toBeGreaterThan(10);
        expect(seen.past, `${width}: a panel box reaches past the ${width}px viewport`).toEqual([]);
        widths++;
      }
      expect(widths).toBe(3);
    } finally {
      await owner.close();
    }
  });

  // RT (lane-close fix, ruled 2026-09-29; supersedes addendum RT's session-based bypass): community orgs get REAL-TIME
  // overlays through the SIGNED KEY the organiser's panel puts in the OBS URL it copies. The plan-wide `realtime` stays
  // off — a spectator keeps the poll. Driven on the PRODUCT path, end to end: the organiser copies the OBS URL from the
  // panel, OBS (an anonymous browser) opens exactly that URL, and what is asserted is the overlay's own token request and
  // the subscription it leads to. Nothing is seeded — no session is needed any more, and none exists here. The route's
  // unit table (realtime-token/__tests__/route.test.ts) owns every other combination.
  test("RT: the OBS URL copied from the panel earns the overlay a realtime subscription — the same URL with its key tampered does not", async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    // The project's storageState (the pre-dismissed cookie banner), as the Phone-tab test above.
    const owner = await browser.newContext();
    const page = await owner.newPage();
    const obs = await anonPage(browser);
    const tamperedObs = await anonPage(browser);
    try {
      await signInAs(page, community.ownerEmail);
      await page.setViewportSize({ width: 1280, height: 900 });
      await openObsTab(page);

      // Copy, as the organiser does — the button, not just the value it would copy.
      const origin = new URL(page.url()).origin;
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
      const field = page.locator('[data-testid="stream-link"]');
      // Anchored on the ORIGIN too: the panel fills it in after hydration, and a copy taken before that is a path OBS
      // cannot open.
      const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      await expect(field).toHaveValue(new RegExp(`^${escaped}/overlay/fixtures/${community.fixtureId}\\?`), { timeout: 30_000 });
      await page.locator('[data-testid="stream-copy"]').click();
      await expect(page.locator('[data-testid="stream-copy"]')).toContainText(en("stream.copied"));
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied, "Copy writes the field's own URL").toBe(await field.inputValue());
      const url = new URL(copied);
      expect(url.origin, "a URL OBS can open: this deployment's own origin").toBe(origin);
      expect(url.pathname).toBe(`/overlay/fixtures/${community.fixtureId}`);
      const key = url.searchParams.get(OVERLAY_KEY_PARAM);
      expect(key, "the copied OBS URL carries the fixture's signed key").toMatch(/^[A-Za-z0-9_-]{22}$/);

      // Premise, and the spectator path unchanged: community has no `realtime`, and the declared purpose alone is refused.
      expect((await obs.request.get(realtimeTokenPath(community.fixtureId))).status(), "a spectator is refused").toBe(403);
      expect(
        (await obs.request.get(realtimeTokenPath(community.fixtureId, OVERLAY_REALTIME_PURPOSE))).status(),
        "the declared purpose without its key never mints",
      ).toBe(403);

      // OBS opens the copied URL. The watch is armed BEFORE the navigation: the token request fires from a mount effect.
      const watch = await watchFixtureRealtime(obs, community.fixtureId);
      await obs.setViewportSize({ width: 1920, height: 1080 });
      await obs.goto(copied);
      const ovl = obs.locator('[data-testid="ovl-root"]');
      await expect(ovl).toHaveCount(1, { timeout: 30_000 });
      await expect
        .poll(() => watch.tokenStatuses.length, { message: "the overlay never asked the realtime-token door", timeout: 30_000 })
        .toBeGreaterThan(0);
      expect(watch.tokenStatuses[0], "the overlay's own keyed request is minted a token").toBe(200);

      // The subscription. A stub Supabase host (CI) mints but never dials — the hook's own stub guard — so there the
      // join cannot happen and the overlay stays on the poll; E2E_REQUIRE_REALTIME=1 says this environment HAS realtime,
      // and turns that degradation into the failure.
      const subscribed = await obs
        .waitForFunction(
          () => document.querySelector('[data-testid="ovl-root"]')?.getAttribute("data-transport") === "realtime",
          undefined,
          { timeout: 15_000 },
        )
        .then(() => true)
        .catch(() => false);
      if (subscribed) {
        expect(watch.joined(), "the DOM says realtime, and a Phoenix join for THIS fixture's channel confirmed it").toBe(true);
      } else {
        expect(
          process.env.E2E_REQUIRE_REALTIME === "1",
          "E2E_REQUIRE_REALTIME=1: this environment is supposed to have realtime, and the keyed overlay never subscribed",
        ).toBe(false);
        await expect(ovl, "no subscription: the stub-host fallback is the poll, anything else is a crash").toHaveAttribute("data-transport", "poll");
        test.info().annotations.push({ type: "realtime-unavailable", description: "RT: minted 200, but no websocket joined (stub host)" });
      }

      // The pair: the SAME URL with one character of its key changed. Asked, refused, and on the poll.
      const bad = new URL(copied);
      bad.searchParams.set(OVERLAY_KEY_PARAM, (key![0] === "A" ? "B" : "A") + key!.slice(1));
      const badWatch = await watchFixtureRealtime(tamperedObs, community.fixtureId);
      await tamperedObs.goto(bad.toString());
      await expect(tamperedObs.locator('[data-testid="ovl-root"]')).toHaveCount(1, { timeout: 30_000 });
      await expect
        .poll(() => badWatch.tokenStatuses.length, { message: "the tampered overlay never asked", timeout: 30_000 })
        .toBeGreaterThan(0);
      expect(badWatch.tokenStatuses[0], "a tampered key takes the normal path: refused").toBe(403);
      await expect(tamperedObs.locator('[data-testid="ovl-root"]')).toHaveAttribute("data-transport", "poll");
      expect(badWatch.joined(), "no channel join on a refused token").toBe(false);
    } finally {
      await owner.close();
      await obs.context().close();
      await tamperedObs.context().close();
    }
  });

  test("the sibling negative: an override switches streaming.relay off, and the same tab says streaming is SWITCHED OFF — never a price", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    await setBoolEntitlementOverrideSql(community.orgId, "streaming.relay", false);
    // The project's storageState, as the live-preview test above: it carries the pre-dismissed cookie banner, which
    // an empty context paints over the run sheet's first row — over the stream toggle itself.
    const owner = await browser.newContext();
    const page = await owner.newPage();
    try {
      await invalidateOrgEntitlements(page.request, community.orgId);
      await signInAs(page, community.ownerEmail);
      await page.setViewportSize({ width: 1280, height: 900 });
      await openPhoneTab(page);
      const gate = page.locator('[data-testid="stream-phone-gate"]');
      // Review I4: every plan streams (V426), so the only way here is a staff override — an org that no plan can
      // buy its way out of. The tab says so and names who to contact; it never shows a plan, a price or an upgrade.
      await expect(gate.locator('[data-testid="stream-switched-off"]'), "the switched-off state").toHaveCount(1, {
        timeout: 30_000,
      });
      await expect(gate.locator('[data-testid="stream-switched-off"]')).toContainText(en("stream.phone.switchedOff"));
      await expect(gate.locator("[data-phone-body]"), "no Phone tab body behind the override").toHaveCount(0);
      await expect(gate.locator(":scope > a"), "no UpgradeGate pill").toHaveCount(0);
      await expect(gate.locator('a[href*="/billing"], a[href*="upgrade"]'), "no billing or upgrade link").toHaveCount(0);
    } finally {
      await owner.close();
    }
  });
});

// ===========================================================================
// Private Realtime → overlay scorebug (JWT mint + Realtime Authorization)
// Must stay BEFORE the stream-link describe: that one decides the fixture.
// ===========================================================================

test.describe("private realtime push to the overlay", () => {
  test("subscribes private and paints a goal well under POLL_MS", async ({ browser }) => {
    test.setTimeout(120_000);
    const owner = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const ownerPage = await owner.newPage();
    const anon = await anonPage(browser);
    try {
      await signInAs(ownerPage, rig.ownerEmail);
      await anon.setViewportSize({ width: 1920, height: 1080 });

      // Mint from the test process — same route the overlay client hits.
      // Waiting on the page's own fetch raced a hung stub websocket (local)
      // and is unnecessary for the ES256 assert.
      const tokenRes = await anon.request.get(
        `/api/v1/public/fixtures/${rig.fixtureId}/realtime-token`,
      );
      expect(tokenRes.status(), "Pro org must mint a spectator realtime token").toBe(200);
      const tokenBody = (await tokenRes.json()) as { data?: { token?: string }; token?: string };
      const jwt = tokenBody.data?.token ?? tokenBody.token;
      expect(jwt, "token body").toBeTruthy();
      const headerJson = Buffer.from(String(jwt).split(".")[0]!, "base64url").toString("utf8");
      const header = JSON.parse(headerJson) as { alg?: string; kid?: string };
      expect(header.alg, "mint must be ES256 after JWKS key import").toBe("ES256");
      expect(header.kid, "mint must carry the imported signing kid").toBeTruthy();

      await anon.goto(`/overlay/fixtures/${rig.fixtureId}?style=bug`);
      const ovl = anon.locator('[data-testid="ovl-root"]');
      await expect(ovl).toHaveCount(1, { timeout: 30_000 });

      // CI builds against stub.supabase.co — no Realtime websocket (run
      // 34834966169 stayed on poll after a valid ES256 mint). Live Supabase
      // still must flip to realtime and paint under POLL_MS.
      // `waitForFunction(fn, arg, options)` — options is the THIRD argument.
      // Passing `{ timeout }` as arg (as #783 did) leaves the default timeout,
      // which is this test's 120s budget: on stub.supabase.co transport never
      // flips to realtime, so CI hung until the whole test timed out
      // (run 34844721555).
      const subscribed = await anon
        .waitForFunction(
          () =>
            document.querySelector('[data-testid="ovl-root"]')?.getAttribute("data-transport") ===
            "realtime",
          undefined,
          { timeout: 8_000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!subscribed) {
        await expect(
          ovl,
          "private channel did not SUBSCRIBE; poll is the stub-host fallback, anything else is a mint/client crash",
        ).toHaveAttribute("data-transport", "poll");
        return;
      }

      const home = anon.locator('[data-testid="ovl-big-home"]');
      const before = ((await home.textContent()) ?? "").trim();
      expect(before.length, "home score must be painted before the push").toBeGreaterThan(0);

      const t0 = Date.now();
      await sendEvent(ownerPage.request, rig.fixtureId, "hockey.goal", {
        by: rig.homeEntrantId,
        kind: "fg", // W2d T18: a hockey goal carries its type
      });

      await expect
        .poll(
          async () => ((await home.textContent()) ?? "").trim(),
          {
            message: `home score must move off "${before}" via realtime, not the ${POLL_MS}ms poll`,
            timeout: 8_000,
            intervals: [200, 400, 800],
          },
        )
        .not.toBe(before);

      const elapsed = Date.now() - t0;
      expect(
        elapsed,
        `push took ${elapsed}ms — at or above POLL_MS (${POLL_MS}) this is poll, not realtime`,
      ).toBeLessThan(POLL_MS);
    } finally {
      await owner.close();
      await anon.context().close();
    }
  });
});

// ===========================================================================
// The public match page's link to the club's broadcast (Task 7)
// ===========================================================================

test.describe("the public match page's stream link", () => {
  // LAST in the file, and it must stay last: it plays the seeded fixture out
  // to full time, and every assertion above needs it LIVE.
  test("says Watch live while the match is on, and Replay only after a reload", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const owner = await browser.newContext();
    const ownerPage = await owner.newPage();
    const anon = await anonPage(browser);
    try {
      await signInAs(ownerPage, rig.ownerEmail);
      const path = `/shared/${rig.orgSlug}/${rig.compSlug}/${rig.divSlug}/fixtures/${rig.fixtureId}`;
      await anon.goto(path);
      const link = anon.locator('[data-testid="public-stream-link"]');
      await expect(link).toHaveCount(1);
      await expect(link).toHaveAttribute("href", STREAM_URL);
      // `rel="noopener"` per design §3.9 and `data.ts`'s own comment; the W1
      // plan's snippet said `noopener noreferrer`. Either form passes.
      expect(await link.getAttribute("rel")).toMatch(/noopener/);
      await expect(link).toHaveText(/Watch live/i);

      await decideFixture(ownerPage, rig.fixtureId);

      // A SECOND page proves the SERVER has flipped before anything is claimed
      // about the first one. `getPublicFixture` is cached for 30 s, so a
      // straight reload here would still be serving the in_play row and
      // "the open page still says Watch live" would pass for the wrong reason
      // — the cache, not the transport.
      const witness = await anonPage(browser);
      try {
        await expect
          .poll(
            async () => {
              await witness.goto(path);
              return (
                (await witness.locator('[data-testid="public-stream-link"]').textContent()) ?? ""
              );
            },
            {
              message: "a freshly-loaded page must say Replay once the fixture is decided",
              timeout: 60_000,
              intervals: [2_000],
            },
          )
          .toMatch(/Replay/i);
      } finally {
        await witness.context().close();
      }

      // Only NOW is the stale label attributable to the transport: the live
      // -> Replay flip needs a RELOAD, because the client payload carries
      // `status` but not `stream_url`, so the open page cannot re-derive the
      // label (Task 7's handed-forward finding). Both directions, because
      // "it says Replay after a reload" alone would also pass on a page that
      // had flipped live.
      await expect(link, "the page that was open when the match ended keeps its label").toHaveText(
        /Watch live/i,
      );
      await anon.reload();
      await expect(
        anon.locator('[data-testid="public-stream-link"]'),
        "and picks up Replay on the next load",
      ).toHaveText(/Replay/i);
    } finally {
      await owner.close();
      await anon.context().close();
    }
  });
});

/** Full time on the seeded hockey fixture, through the real reducer.
 *
 *  The phase ladder is READ OFF THE ENGINE (`summary.detail.nextAdvance`)
 *  rather than typed here as `Q2, Q3, Q4, FT`: FIH's quarter labels are a
 *  variant's business, and a table in a test asserts yesterday's numbers the
 *  day a preset moves. One goal first — a level score sends hockey to a
 *  shoot-out instead of deciding. */
async function decideFixture(page: Page, fixtureId: string): Promise<void> {
  await sendEvent(page.request, fixtureId, "hockey.goal", { by: rig.homeEntrantId, kind: "fg" });
  for (let guard = 0; guard < 10; guard++) {
    const state = await apiJson<{
      status: string;
      summary: { detail?: { nextAdvance?: string | null } } | null;
    }>(page.request, `/api/v1/fixtures/${fixtureId}/state`);
    if (state.status !== 200 || !state.data) {
      throw new Error(`decideFixture: GET state -> ${state.status}`);
    }
    if (state.data.status === "decided" || state.data.status === "finalized") return;
    const next = state.data.summary?.detail?.nextAdvance;
    if (!next) {
      throw new Error(
        `decideFixture: status ${state.data.status} and no nextAdvance — the ladder ran out`,
      );
    }
    await sendEvent(page.request, fixtureId, "hockey.period.advance", { to: next });
  }
  throw new Error("decideFixture: ten advances and the fixture is still not decided");
}

/**
 * W2 — THE MOMENT SLAB, in a browser.
 *
 * The only place this half of the wave can be proven. `apps/web` vitest is
 * `environment: "node"`: the reducer is unit-tested one deadline at a time, but
 * nothing in this repo can see the slab mount, carry its tone, fold, or leave —
 * and "the queue is green" says nothing about whether the stage ever hands it a
 * moment. That gap is the inert seam this file exists to close.
 *
 * SERIAL, like the rest of the file, and it appends events to the SAME hockey
 * rig. A red count here is a floor, never a total (AGENTS.md class 21).
 */
test.describe("moments (W2)", () => {
  /**
   * ITS OWN RIG, not the file's.
   *
   * This file is serial and shares one hockey fixture, and a test above DECIDES
   * it — so by the time these run, appending anything answers
   * `422 ALREADY_DECIDED`. Reordering would fix it today and break the next
   * time somebody adds a test; an independent rig cannot be broken by
   * neighbours at all. AGENTS.md class 21 is about exactly this coupling.
   */
  let moments: OverlayRig;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const owner = await browser.newContext();
    const ownerPage = await owner.newPage();
    try {
      moments = await seedOverlayFixture(ownerPage);
    } finally {
      await owner.close();
    }
  });

  /** The budget is DERIVED from the slab's own constants, never typed. Moving
   *  the hold moves this with it — a flat timeout beside a derived cost is the
   *  latent red of AGENTS.md class 20. */
  const CYCLE_MS = OVERLAY_MOMENT_FOLD_MS * 2 + OVERLAY_MOMENT_HOLD_MS;

  test("a goal scored while the overlay is open raises a slab, holds, and folds away", async ({
    browser,
  }) => {
    // Three extra cycles over the sibling test: the replay watch below samples
    // for exactly that long. Derived from the same constant, never typed.
    test.setTimeout(CYCLE_MS * 9 + 60_000);
    // The overlay VIEW is anonymous; the event SENDS are not. `sendEvent` posts
    // to `/api/v1/fixtures/{id}/events`, which 401s without the rig owner's
    // session — the anon context has none, and the project's shared storageState
    // belongs to a different org. Two contexts, deliberately.
    const owner = await browser.newContext();
    const ownerPage = await owner.newPage();
    await signInAs(ownerPage, moments.ownerEmail);
    const anon = await anonPage(browser);
    try {
      await anon.goto(`/overlay/fixtures/${moments.fixtureId}?style=bar`);
      const slab = anon.locator('[data-testid="overlay-moment"]');

      // NOTHING ON MOUNT. The window already carries three suspensions from the
      // seed, and an overlay opened mid-broadcast must not replay them.
      //
      // SAMPLED, not asserted once. A bare `toHaveCount(0)` straight after
      // `goto` resolves before hydration can mount anything, so it passed with
      // `momentBaseline` (overlay-stage.tsx) deleted — a reachability check
      // where a behaviour was wanted. Three replayed suspensions would occupy
      // 3 x CYCLE_MS and then be GONE, so a single late assertion passes too.
      // Polling every 250 ms across that whole span is what actually kills the
      // mutant: a 4.5 s slab cannot hide between two samples.
      await expect(anon.locator('[data-testid="ovl-side-home"]')).toBeVisible();
      const watchUntil = Date.now() + CYCLE_MS * 3;
      while (Date.now() < watchUntil) {
        expect(await slab.count(), "the seeded history must not replay on mount").toBe(0);
        await anon.waitForTimeout(250);
      }

      await sendEvent(ownerPage.request, moments.fixtureId, "hockey.goal", { by: moments.homeEntrantId, kind: "fg" });

      // It arrives, carrying the engine's own kind and the sheet's tone.
      await expect(slab).toHaveAttribute("data-kind", "goal", { timeout: 30_000 });
      await expect(slab).toHaveAttribute("data-tone", "led");
      await expect(slab).toBeVisible();

      // …reaches `hold`, which is the phase that is actually ON SCREEN…
      await expect(slab).toHaveAttribute("data-phase", "hold", { timeout: CYCLE_MS });
      // …and then leaves entirely, rather than sitting on the broadcast.
      await expect(slab, "the slab must not stay on air").toHaveCount(0, {
        timeout: CYCLE_MS * 2,
      });
    } finally {
      await anon.context().close();
      await owner.close();
    }
  });

  test("a dismissal takes the dismissal tone, and its ink is the one the PALETTE derives", async ({
    browser,
  }) => {
    test.setTimeout(CYCLE_MS * 6 + 60_000);
    // The overlay VIEW is anonymous; the event SENDS are not. `sendEvent` posts
    // to `/api/v1/fixtures/{id}/events`, which 401s without the rig owner's
    // session — the anon context has none, and the project's shared storageState
    // belongs to a different org. Two contexts, deliberately.
    const owner = await browser.newContext();
    const ownerPage = await owner.newPage();
    await signInAs(ownerPage, moments.ownerEmail);
    const anon = await anonPage(browser);
    try {
      await anon.goto(`/overlay/fixtures/${moments.fixtureId}?style=bar`);
      const slab = anon.locator('[data-testid="overlay-moment"]');
      await sendEvent(ownerPage.request, moments.fixtureId, "hockey.suspension.start", {
        by: moments.awayEntrantId,
        class: "red",
      });
      await expect(slab).toHaveAttribute("data-tone", "dismissal", { timeout: 30_000 });

      // _THEMES.md §5, owner pick 5C — hockey's dismissal ink is the BOARD, not
      // the near-white, because `--sport-dismissal` is a light colour in this
      // palette. Derived from the palette here rather than typed, so a palette
      // revision moves the expectation with it.
      const expected = await anon.evaluate(() => {
        const host = document.querySelector<HTMLElement>('[data-testid="ovl-root"]');
        if (!host) throw new Error("no ovl-root");
        const probe = document.createElement("span");
        probe.style.color = "var(--sport-board)";
        host.appendChild(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      });
      await expect(slab).toHaveCSS("color", expected);
    } finally {
      await anon.context().close();
      await owner.close();
    }
  });

  test("two moments QUEUE: the second waits for the first to leave, and neither is lost", async ({
    browser,
  }) => {
    test.setTimeout(CYCLE_MS * 8 + 60_000);
    // The overlay VIEW is anonymous; the event SENDS are not. `sendEvent` posts
    // to `/api/v1/fixtures/{id}/events`, which 401s without the rig owner's
    // session — the anon context has none, and the project's shared storageState
    // belongs to a different org. Two contexts, deliberately.
    const owner = await browser.newContext();
    const ownerPage = await owner.newPage();
    await signInAs(ownerPage, moments.ownerEmail);
    const anon = await anonPage(browser);
    try {
      await anon.goto(`/overlay/fixtures/${moments.fixtureId}?style=bar`);
      const slab = anon.locator('[data-testid="overlay-moment"]');
      await sendEvent(ownerPage.request, moments.fixtureId, "hockey.goal", { by: moments.homeEntrantId, kind: "fg" });
      await sendEvent(ownerPage.request, moments.fixtureId, "hockey.suspension.start", {
        by: moments.awayEntrantId,
        class: "yellow",
      });

      // Exactly ONE slab at a time, ever — the second is queued, not stacked.
      await expect(slab).toHaveCount(1, { timeout: 30_000 });
      const first = await slab.getAttribute("data-kind");
      expect(first, "the goal is older, so it goes first").toBe("goal");

      // The card follows on its own turn rather than being dropped.
      await expect(slab).toHaveAttribute("data-kind", "card.yellow", {
        timeout: CYCLE_MS * 3,
      });
      await expect(slab).toHaveAttribute("data-tone", "caution");
    } finally {
      await anon.context().close();
      await owner.close();
    }
  });
});

/**
 * 2026-09-13 — pad Pause / Correct publish `*.clock`; the OBS clock must hold
 * when `running: false`. Own rig: the shared hockey fixture is decided earlier.
 */
test.describe("overlay clock holds when paused (*.clock)", () => {
  let clockRig: OverlayRig;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const owner = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const ownerPage = await owner.newPage();
    try {
      clockRig = await seedOverlayFixture(ownerPage);
    } finally {
      await owner.close();
    }
  });

  test("a paused stamp freezes .ovl-bug-clock; resume lets it advance again", async ({ browser }) => {
    test.setTimeout(120_000);
    const owner = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const ownerPage = await owner.newPage();
    await signInAs(ownerPage, clockRig.ownerEmail);
    const anon = await anonPage(browser);
    const clockCell = anon.locator(".ovl-bug-clock");

    const parseFace = (text: string): number => {
      const m = /^(\d+):(\d{2})$/.exec(text.trim());
      if (!m) throw new Error(`not MM:SS: "${text}"`);
      return Number(m[1]) * 60 + Number(m[2]);
    };

    try {
      await sendEvent(ownerPage.request, clockRig.fixtureId, "hockey.clock", {
        at: { period: "Q1", elapsed: 90 },
        running: true,
      });

      await anon.goto(`/overlay/fixtures/${clockRig.fixtureId}?style=bug`);
      await expect
        .poll(async () => ((await clockCell.count()) > 0 ? (await clockCell.innerText()).trim() : ""), {
          timeout: 60_000,
          intervals: [2_000],
          message: "bug clock must appear once asOf is stamped",
        })
        .toMatch(/^\d+:\d{2}$/);

      await sendEvent(ownerPage.request, clockRig.fixtureId, "hockey.clock", {
        at: { period: "Q1", elapsed: 90 },
        running: false,
      });

      // Overlay paints via formatClock → zero-padded MM:SS (`01:30`, not `1:30`).
      let held = "";
      await expect
        .poll(
          async () => {
            await anon.reload();
            held = (await clockCell.innerText()).trim();
            return held;
          },
          { timeout: 60_000, intervals: [2_000], message: "paused stamp must paint 01:30" },
        )
        .toBe("01:30");

      await anon.waitForTimeout(2_500);
      await anon.reload();
      await expect(clockCell, "paused clock must not advance on wall time alone").toHaveText("01:30", {
        timeout: 30_000,
      });
      expect(parseFace(held)).toBe(90);

      await sendEvent(ownerPage.request, clockRig.fixtureId, "hockey.clock", {
        at: { period: "Q1", elapsed: 90 },
        running: true,
      });

      await expect
        .poll(
          async () => {
            await anon.reload();
            const face = (await clockCell.innerText()).trim();
            if (!/^\d+:\d{2}$/.test(face)) return 0;
            return parseFace(face);
          },
          { timeout: 60_000, intervals: [1_000], message: "resume must let the bug clock tick past 01:30" },
        )
        .toBeGreaterThan(90);
    } finally {
      await anon.context().close();
      await owner.close();
    }
  });
});

/**
 * W2 TASK 3 — the cricket bar's SECOND BAND, in a browser and in CI.
 *
 * Its own describe and its own rig, for the reason the moments describe states:
 * this file is serial and a test above decides the shared hockey fixture.
 *
 * WHY IT EXISTS. Before this, `cricketLive` had no automated gate anywhere that
 * runs: there was no cricket case in this file, `scripts/smoke.ts` checks only
 * `recent[]` against the hockey rig, and the sole end-to-end proof was
 * `overlay-moments.capture.ts` — which is `test.skip` without `GALLERY_DIR`, and
 * whose `gallery` project no workflow invokes. A whole wave task rested on a
 * harness CI never runs. Found by the W2 final review.
 */
test.describe("cricket crease band (W2 Task 3)", () => {
  let cricket: OverlayRig;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const owner = await browser.newContext();
    const ownerPage = await owner.newPage();
    try {
      cricket = await seedCricketOverlayFixture(ownerPage);
    } finally {
      await owner.close();
    }
  });

  test("the band names both batters and the bowler, through the consent resolver", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const anon = await anonPage(browser);
    try {
      await anon.goto(`/overlay/fixtures/${cricket.fixtureId}?style=bar`);
      const band = anon.locator('[data-testid="ovl-detail"]');
      await expect(band).toBeVisible({ timeout: 30_000 });

      // The seed's over is a single, a four, a wide, then a bowled — so by the
      // time this reads, one batter is out and the incoming one is at the
      // crease. FIGURES, not just a name: "N (M)" is what the band is FOR, and
      // a test that only saw a name would pass on a band that lost its
      // arithmetic. `(` is the cheapest witness of the figures' shape that
      // cannot be satisfied by a bare name.
      await expect(band).toContainText("(");

      // The bowler's analysis, four numbers joined by hyphens (O-M-R-W). Pinned
      // as a SHAPE rather than as "0.4-0-12-1", which would freeze this seed's
      // arithmetic into a test about rendering.
      await expect(band).toContainText(/\d+(\.\d)?-\d+-\d+-\d+/);

      // A NAME REACHED AIR. Deliberately NOT "the name is masked": this rig's
      // division sets no youth flag and no display policy, so the consent
      // resolver's correct answer here IS the full name, and a test asserting
      // initials would assert a policy this fixture does not have. What the
      // band owes is that people appear at all — the resolver being the route
      // is pinned by `recent.test.ts`, which drives it against the real one.
      await expect(band).toContainText(/Bat \d+ /);
    } finally {
      await anon.context().close();
    }
  });

  // R2007 decision 2 (spec 2026-10-15 §4.4): `?template=` names the template and `?style=` stays its alias for every
  // OBS URL written before it. Cricket because its default is `bar`, so `?template=bug` is a choice the route has to
  // HONOUR rather than one it lands on by default — the hockey rig above opens on `bug` either way.
  test("?template= picks the template; ?style= is the alias; an unknown template never falls through to style", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const anon = await anonPage(browser);
    const root = anon.locator('[data-testid="ovl-root"]');
    try {
      const cases: [string, "bar" | "bug"][] = [
        ["", "bar"], // the sport default — the positive pair for every row below
        ["?template=bug", "bug"],
        ["?style=bar", "bar"],
        ["?style=bug", "bug"],
        ["?template=bug&style=bar", "bug"],
        ["?template=nonsense&style=bug", "bar"],
      ];
      for (const [query, want] of cases) {
        const res = await anon.goto(`/overlay/fixtures/${cricket.fixtureId}${query}`);
        expect(res?.status(), query || "(no query)").toBe(200);
        await expect(root, query || "(no query)").toHaveAttribute("data-style", want);
      }
      console.log(`template query cases: ${cases.length}`);
    } finally {
      await anon.context().close();
    }
  });
});

/**
 * End-of-over card (design 2026-09-12 Feature B) — browser gate.
 * Unit tests cover builders; this proves the card raises after an over
 * completes while the overlay is open, and does not replay on mount.
 */
test.describe("cricket end-of-over card (EOO)", () => {
  const CYCLE_MS = OVERLAY_MOMENT_FOLD_MS * 2 + OVERLAY_MOMENT_HOLD_MS;
  // The EOO card doubleBeats (2026-09-14, same mechanism as SIX/FOUR/OUT/
  // GOAL) at its own longer hold, not the slab default — deriving the
  // per-beat cost from END_OF_OVER_HOLD_MS rather than reusing CYCLE_MS
  // (which is keyed to OVERLAY_MOMENT_HOLD_MS) so a future change to either
  // constant moves this budget with it, not past it (AGENTS.md rule 20).
  const EOO_BEAT_MS = OVERLAY_MOMENT_FOLD_MS * 2 + END_OF_OVER_HOLD_MS;
  const EOO_CYCLE_MS = EOO_BEAT_MS * 2;

  test("completing an over while open raises ovl-end-of-over; remount does not replay it", async ({
    browser,
  }) => {
    test.setTimeout(EOO_CYCLE_MS * 5 + 180_000);
    // Empty storage on purpose (review 2026-09-14, M9 — same fix as the
    // beforeAll above and `anonPage`, "seen 2026-09-13"). A bare
    // `browser.newContext()` inherits the project's Pro `storageState`;
    // `seedCricketOverlayFreshOver` calls `signInAs`, and afterwards
    // `ownerPage.request` (used below for every `sendEvent` ball) still rides
    // the inherited Pro cookie jar and 401s.
    const owner = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const ownerPage = await owner.newPage();
    const { rig, striker, nonStriker, bowler } = await seedCricketOverlayFreshOver(ownerPage);

    const anon = await anonPage(browser);
    const anonBug = await anonPage(browser);
    try {
      await anon.goto(`/overlay/fixtures/${rig.fixtureId}?style=bar`);
      await expect(anon.locator('[data-testid="ovl-side-home"]')).toBeVisible({ timeout: 30_000 });
      await anonBug.goto(`/overlay/fixtures/${rig.fixtureId}?style=bug`);
      await expect(anonBug.locator('[data-testid="ovl-side-home"]')).toBeVisible({ timeout: 30_000 });
      const eoo = anon.locator('[data-testid="ovl-end-of-over"]');
      const eooBug = anonBug.locator('[data-testid="ovl-end-of-over"]');

      const watchUntil = Date.now() + CYCLE_MS * 2;
      while (Date.now() < watchUntil) {
        expect(await eoo.count(), "pre-over mount must not show end-of-over").toBe(0);
        await anon.waitForTimeout(250);
      }

      for (let ballInOver = 1; ballInOver <= 6; ballInOver += 1) {
        await sendEvent(ownerPage.request, rig.fixtureId, "cricket.ball", {
          over: 0,
          ballInOver,
          striker,
          nonStriker,
          bowler,
          runs: { bat: 0 },
        });
      }

      await expect(eoo).toHaveAttribute("data-phase", "hold", { timeout: 30_000 });
      await expect(eoo, "fine scoring must paint the full split card, not compact").toHaveAttribute(
        "data-variant",
        "full",
      );
      // Bug theme shares the same `.ovl-end-of-over*` CSS block and moment
      // data on purpose (`_THEMES.md` §4, "the bar and the bug are twins") —
      // prove it actually raises there too, not just on the bar.
      await expect(eooBug).toHaveAttribute("data-phase", "hold", { timeout: 5_000 });
      await expect(eoo, "end-of-over must leave the air").toHaveCount(0, {
        timeout: EOO_CYCLE_MS + CYCLE_MS,
      });
      await expect(eooBug, "bug theme's end-of-over must leave the air too").toHaveCount(0, {
        timeout: EOO_CYCLE_MS + CYCLE_MS,
      });

      await anon.goto(`/overlay/fixtures/${rig.fixtureId}?style=bar`);
      await expect(anon.locator('[data-testid="ovl-side-home"]')).toBeVisible({ timeout: 30_000 });
      const remountUntil = Date.now() + CYCLE_MS * 3;
      while (Date.now() < remountUntil) {
        expect(await eoo.count(), "OBS remount must not replay a closed over").toBe(0);
        await anon.waitForTimeout(250);
      }
    } finally {
      await anon.context().close();
      await anonBug.context().close();
      await owner.close();
    }
  });
});

/**
 * R4 sponsors on stream, S15 — the break card on OBS (no `host`: F4, the overlay every OBS user adds), driven by the
 * real ledger and the real served plan. Expectations are DECLARATIONS: the break's size is the engine module's own
 * `naturalBreaks`, its style and hold `SPONSOR_STYLE_BY_SIZE[size]`, the first card the heavier tier by
 * `SPONSOR_TIER_WEIGHTS` (P7), the cooldown `SPONSOR_COOLDOWN_MS`.
 *
 * TIME: OBS polls (`POLL_MS`), and the cooldown is judged on the EVENTS' server time (`sponsor-plan.ts`, the planner
 * compares the breaks' `at`), so `page.clock` cannot move it — the page's clock is not the planner's. The second over is
 * bowled at once, so it lands inside the cooldown by construction (asserted, not assumed); the positive pair (a break
 * past the cooldown gets a card) is the planner's unit tests', where the clock is the test's.
 *
 * "A score cuts the card" runs on the PAGE's clock (`page.clock`, installed before the page loads, paused once it has):
 * the poll interval and every queue timer are fake, so the test steps time and nothing moves between steps. A score
 * sent during the hold reaches the page on the next poll, and with the clock paused the only way the card can leave
 * `hold` is that poll's data. The hold cannot run out on its own. The seam drives the same cut through the real
 * reducer (`server/sponsors/__tests__/seam.test.ts`).
 */
test.describe("R4 sponsors: the break card on OBS", () => {
  const CYCLE_MS = OVERLAY_MOMENT_FOLD_MS * 2 + OVERLAY_MOMENT_HOLD_MS;
  // The end-of-over card double-beats at its own hold (the EOO describe above).
  const EOO_CYCLE_MS = (OVERLAY_MOMENT_FOLD_MS * 2 + END_OF_OVER_HOLD_MS) * 2;
  /** A card's whole showing: fold in, its hold, fold out. */
  const cardCycle = (holdMs: number) => OVERLAY_MOMENT_FOLD_MS * 2 + holdMs;
  /** What a rig's seed and one browser cost before the first ball (the EOO describe's own allowance). */
  const SEED_MS = 180_000;
  /** Review Focus 5's realistic sponsor name: 43 characters. */
  const LONG_NAME = "Harbourside Building Supplies and Timber Co";

  /** The size the sport's engine module DECLARES for a break kind. */
  function sizeOf(sport: string, kind: string): "minor" | "major" {
    const declared = builtinModules.find((m) => m.key === sport)?.naturalBreaks?.kinds.find((k) => k.kind === kind);
    if (declared === undefined) throw new Error(`${sport} declares no "${kind}" break`);
    return declared.size;
  }

  type ServedPlan = {
    cards: { id: string; tier: string; shortCode: string | null }[];
    airings: { momentId: string; cardId: string; style: string; breakKind: string }[];
  };
  /** The plan the overlay route serves (S5): the page's own source. */
  async function servedPlan(page: Page, fixtureId: string): Promise<ServedPlan> {
    const res = await apiJson<{ sponsorPlan: ServedPlan | null }>(page.request, `/api/v1/public/fixtures/${fixtureId}/overlay`);
    expect(res.status, "the overlay route answers").toBe(200);
    expect(res.data?.sponsorPlan, "the overlay serves a sponsor plan").toBeTruthy();
    return res.data!.sponsorPlan!;
  }

  /** The organiser's writes (S12, S11): each sponsor created OFF the stream, then ticked; then the dial. */
  async function sponsorsOn(page: Page, orgId: string, sponsors: { name: string; tier: string; url: string }[]): Promise<string[]> {
    const ids: string[] = [];
    for (const s of sponsors) {
      const made = await apiJson<{ id: string; on_stream: boolean }>(page.request, `/api/v1/orgs/${orgId}/sponsors`, "POST", s);
      expect(made.status, `create ${s.name}: ${JSON.stringify(made.error)}`).toBe(201);
      expect(made.data!.on_stream, "a created sponsor starts off the stream").toBe(false);
      const ticked = await apiJson<{ on_stream: boolean }>(page.request, `/api/v1/orgs/${orgId}/sponsors/${made.data!.id}`, "PATCH", { on_stream: true });
      expect(ticked.data?.on_stream, `tick ${s.name}`).toBe(true);
      ids.push(made.data!.id);
    }
    const dial = await apiJson(page.request, `/api/v1/orgs/${orgId}/sponsor-stream-settings`, "PUT", { competitionId: null, enabled: true, frequency: "busy" });
    expect(dial.status, "the dial to Busy").toBe(200);
    return ids;
  }

  test("cricket, Busy: the over's break airs the heavier tier as a lower third AFTER the end-of-over card; a second over inside the cooldown airs its end-of-over card and no sponsor card", async ({
    browser,
  }) => {
    const look = SPONSOR_STYLE_BY_SIZE[sizeOf("cricket", "over_end")];
    // Two overs, each: a poll to reach the page, the end-of-over card's two beats, and a card's showing.
    const OVER_MS = POLL_MS + EOO_CYCLE_MS + cardCycle(look.holdMs);
    test.setTimeout(SEED_MS + 2 * OVER_MS + 60_000);
    // Empty storage: see the EOO describe (a bare context inherits the shared Pro session and its requests 401).
    const owner = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const ownerPage = await owner.newPage();
    const { rig, striker, nonStriker, bowler } = await seedCricketOverlayFreshOver(ownerPage);
    // Law 17.6: a bowler never bowls two overs running — the second over's is another of the fielding side.
    const [other] = await withDb((sql) => sql<{ person_id: string }[]>`
      select person_id from entrant_members where entrant_id = ${rig.awayEntrantId} and person_id <> ${bowler} order by person_id limit 1`);
    expect(other, "premise: the fielding side has a second bowler").toBeTruthy();
    await sponsorsOn(ownerPage, rig.orgId, [
      { name: LONG_NAME, tier: "title", url: "https://harbourside.example/" },
      { name: `Ridge Gold ${rig.fixtureId.slice(0, 6)}`, tier: "gold", url: "https://ridge-gold.example/" },
    ]);
    expect(SPONSOR_TIER_WEIGHTS.title, "premise (D9): the tiers are not tied").not.toBe(SPONSOR_TIER_WEIGHTS.gold);
    const heavier = SPONSOR_TIER_WEIGHTS.title > SPONSOR_TIER_WEIGHTS.gold ? "title" : "gold";

    const anon = await anonPage(browser);
    try {
      await anon.goto(`/overlay/fixtures/${rig.fixtureId}?style=bar`);
      await expect(anon.locator('[data-testid="ovl-side-home"]')).toBeVisible({ timeout: 30_000 });
      const card = anon.getByTestId("ovl-sponsor-card");
      const eoo = anon.getByTestId("ovl-end-of-over");
      expect(await card.count(), "no card before the first break").toBe(0);

      const over = async (n: number, pair: [string, string], by: string) => {
        for (let ballInOver = 1; ballInOver <= 6; ballInOver += 1) {
          await sendEvent(ownerPage.request, rig.fixtureId, "cricket.ball", {
            over: n, ballInOver, striker: pair[0], nonStriker: pair[1], bowler: by, runs: { bat: 0 },
          });
        }
        return Date.now();
      };

      // --- Over 1: the end-of-over card, then the sponsor's.
      const firstBreakAt = await over(0, [striker, nonStriker], bowler);
      await expect(eoo, "the end-of-over card goes first (spec §3.4)").toHaveAttribute("data-phase", "hold", { timeout: POLL_MS + 15_000 });
      expect(await card.count(), "never beside it").toBe(0);
      await expect(card, "the break card follows it").toHaveAttribute("data-phase", "hold", {
        timeout: EOO_CYCLE_MS + OVERLAY_MOMENT_FOLD_MS + 5_000,
      });
      await expect(eoo, "and the end-of-over card is gone by then").toHaveCount(0);
      await expect(card, "in the style its break's size declares").toHaveAttribute("data-style", look.style);
      await expect(anon.getByTestId("ovl-sponsor-slot")).toHaveAttribute("data-slot", look.style);
      await expect(card, "the heavier tier airs first (D9 weights)").toHaveAttribute("data-tier", heavier);
      const plan = await servedPlan(anon, rig.fixtureId);
      const aired = plan.cards.find((c) => c.tier === heavier);
      expect(plan.airings, "the served plan airs that break with that card").toEqual([
        { momentId: expect.stringMatching(/:sponsor\.over_end$/), seq: expect.any(Number), cardId: aired?.id, style: look.style, holdMs: look.holdMs, breakKind: "over_end" },
      ]);
      await expect(anon.getByTestId("ovl-sponsor-link"), "the card prints its short link").toHaveText(sponsorShortLinkText(aired?.shortCode)!);
      await expect(card, "it leaves after its hold").toHaveCount(0, { timeout: cardCycle(look.holdMs) + 5_000 });

      // --- Over 2, at once: the batters changed ends (Law 17.1), another bowler. Inside the cooldown.
      const secondBreakAt = await over(1, [nonStriker, striker], other!.person_id);
      expect(secondBreakAt - firstBreakAt, "premise: the second break is inside the cooldown").toBeLessThan(SPONSOR_COOLDOWN_MS);
      await expect(eoo, "premise: the page DID see the second over").toHaveAttribute("data-phase", "hold", { timeout: POLL_MS + 15_000 });
      // Watch both of its beats and the slot a card would take after them.
      const watchUntil = Date.now() + EOO_CYCLE_MS + cardCycle(look.holdMs);
      let watched = 0;
      while (Date.now() < watchUntil) {
        expect(await card.count(), "the cooldown: no card for the second over").toBe(0);
        watched += 1;
        await anon.waitForTimeout(250);
      }
      console.log(`cooldown watch: ${watched} checks`);
      expect(watched, "anti-vacuity: the watch ran").toBeGreaterThan(0);
      expect((await servedPlan(anon, rig.fixtureId)).airings.map((a) => a.momentId), "and the served plan still airs only the first").toEqual(
        plan.airings.map((a) => a.momentId),
      );
    } finally {
      await anon.context().close();
      await owner.close();
    }
  });

  test("cricket, page clock: a six during the card's hold cuts it — the card folds out on the poll that brings the six, with no time passing", async ({
    browser,
  }) => {
    const look = SPONSOR_STYLE_BY_SIZE[sizeOf("cricket", "over_end")];
    // One step is a FIFTH of the fold, the shortest phase, so every queue timer is re-armed (React's effect, real
    // time) before its own deadline comes up: no phase is skipped and no deadline drifts.
    const STEP_MS = OVERLAY_MOMENT_FOLD_MS / 5;
    // The card holds from (the poll that brought the over) + the end-of-over card's two beats + its own fold in. The
    // NEXT poll must land inside that hold, or the score cannot reach the card in time. These are the declared constants.
    const holdFrom = EOO_CYCLE_MS + OVERLAY_MOMENT_FOLD_MS;
    expect(POLL_MS, "premise: the next poll lands after the card's hold begins").toBeGreaterThan(holdFrom + 2 * STEP_MS);
    expect(POLL_MS, "premise: and before the hold runs out").toBeLessThan(holdFrom + look.holdMs - 2 * STEP_MS);
    // Real time is the seed and the steps' round trips (fake time costs nothing): a bounded number of steps, each one
    // CDP round trip, plus the waits for two fetches to render.
    const MAX_STEPS = Math.ceil((2 * POLL_MS) / STEP_MS) + 20;
    test.setTimeout(SEED_MS + MAX_STEPS * 250 + 60_000);
    const owner = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const ownerPage = await owner.newPage();
    const { rig, striker, nonStriker, bowler } = await seedCricketOverlayFreshOver(ownerPage);
    const [other] = await withDb((sql) => sql<{ person_id: string }[]>`
      select person_id from entrant_members where entrant_id = ${rig.awayEntrantId} and person_id <> ${bowler} order by person_id limit 1`);
    expect(other, "premise: the fielding side has a second bowler").toBeTruthy();
    await sponsorsOn(ownerPage, rig.orgId, [{ name: LONG_NAME, tier: "title", url: "https://harbourside.example/" }]);

    const anon = await anonPage(browser);
    try {
      // Counts the stage's poll requests in the page, so a step knows at once whether its timers fired a poll.
      // `window.fetch` is wrapped before any app code runs. The count is read in the page, never off a network event
      // that could arrive after the step.
      const pollPath = `/api/v1/public/fixtures/${rig.fixtureId}/overlay`;
      await anon.addInitScript((path: string) => {
        const w = window as unknown as { __ovlPolls: number; fetch: typeof fetch };
        w.__ovlPolls = 0;
        const real = w.fetch.bind(window);
        w.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (new URL(url, location.href).pathname === path) w.__ovlPolls += 1;
          return real(input, init);
        };
      }, pollPath);
      const polls = () => anon.evaluate(() => (window as unknown as { __ovlPolls: number }).__ovlPolls);
      const fakeNow = () => anon.evaluate(() => Date.now());
      await anon.clock.install();
      await anon.goto(`/overlay/fixtures/${rig.fixtureId}?style=bar`);
      await expect(anon.locator('[data-testid="ovl-side-home"]')).toBeVisible({ timeout: 30_000 });
      await anon.clock.pauseAt((await fakeNow()) + 1_000);
      const card = anon.getByTestId("ovl-sponsor-card");
      const eoo = anon.getByTestId("ovl-end-of-over");
      const phaseOf = async (l: Locator) => ((await l.count()) === 0 ? null : l.getAttribute("data-phase"));
      let steps = 0;
      const step = async () => {
        expect(++steps, "the step budget").toBeLessThanOrEqual(MAX_STEPS);
        await anon.clock.runFor(STEP_MS);
      };

      // --- The over, bowled with the page's clock stopped; the next poll brings it.
      for (let ballInOver = 1; ballInOver <= 6; ballInOver += 1) {
        await sendEvent(ownerPage.request, rig.fixtureId, "cricket.ball", {
          over: 0, ballInOver, striker, nonStriker, bowler, runs: { bat: 0 },
        });
      }
      const beforeOver = await polls();
      while ((await polls()) === beforeOver) await step();
      await expect(eoo, "the poll brings the over: its end-of-over card folds in, the clock still stopped").toHaveAttribute("data-phase", "in", { timeout: 15_000 });
      expect(await card.count(), "no card beside the end-of-over card").toBe(0);

      // --- Step through the end-of-over card's beats to the sponsor card's hold.
      while ((await phaseOf(card)) !== "hold") await step();
      const holdSeenAt = await fakeNow();
      await expect(card, "the card on air is the over's (its declared style)").toHaveAttribute("data-style", look.style);

      // --- A six off the next over's first ball (Law 17.1: the batters changed ends; Law 17.6: another bowler).
      // `sendEvent` throws on anything but a 201 with an event id.
      await sendEvent(ownerPage.request, rig.fixtureId, "cricket.ball", {
        over: 1, ballInOver: 1, striker: nonStriker, nonStriker: striker, bowler: other!.person_id, runs: { bat: 6 }, boundary: 6,
      });
      const beforeSix = await polls();
      let held = 0;
      while ((await polls()) === beforeSix) {
        expect(await phaseOf(card), "premise: the card is still holding when the next poll fires").toBe("hold");
        held += 1;
        await step();
      }
      console.log(`score-cut: ${held} held steps before the poll`);
      expect(held, "anti-vacuity: the card held across steps before the poll").toBeGreaterThan(0);
      const cutAt = await fakeNow();
      expect(cutAt - holdSeenAt, "the poll fired inside the card's declared hold").toBeLessThan(look.holdMs - STEP_MS);

      // --- With the clock stopped, the poll's data alone folds the card out. No timer can.
      await expect(card, "the score cuts the card: it folds out on the poll's data").toHaveAttribute("data-phase", "out", { timeout: 15_000 });
      expect(await fakeNow(), "and no page time passed: the fold is the data's doing, not the hold running out").toBe(cutAt);
      await anon.clock.runFor(OVERLAY_MOMENT_FOLD_MS + STEP_MS);
      await expect(card, "gone one fold later").toHaveCount(0);
    } finally {
      await anon.context().close();
      await owner.close();
    }
  });

  test("volleyball, Busy: a set's end airs a banner", async ({ browser }) => {
    const look = SPONSOR_STYLE_BY_SIZE[sizeOf("volleyball", "set_end")];
    // A poll to reach the page; the set's own score moments (a double beat at most each) ahead of the card; the card.
    test.setTimeout(SEED_MS + POLL_MS + 4 * CYCLE_MS + cardCycle(look.holdMs) + 60_000);
    const owner = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const ownerPage = await owner.newPage();
    const rig = await seedUndoOverlayFixture(ownerPage, { sportKey: "volleyball", variantKey: "indoor", entrantKind: "team", prefix: "ovlspvb" });
    const [goldId] = await sponsorsOn(ownerPage, rig.orgId, [{ name: `Net Gold ${rig.fixtureId.slice(0, 6)}`, tier: "gold", url: "https://net-gold.example/" }]);
    const anon = await anonPage(browser);
    try {
      await anon.goto(`/overlay/fixtures/${rig.fixtureId}?style=bar`);
      await expect(anon.locator('[data-testid="ovl-side-home"]')).toBeVisible({ timeout: 30_000 });
      const card = anon.getByTestId("ovl-sponsor-card");
      expect(await card.count(), "no card before the set ends").toBe(0);
      // Indoor set 1 is to 25 (setbased/volleyball.ts): one summary closes it, and the closed set opens set_end.
      await sendEvent(ownerPage.request, rig.fixtureId, "volleyball.set.summary", { home: 25, away: 20 });
      await expect(card, "the set's end airs the card").toHaveAttribute("data-phase", "hold", {
        timeout: POLL_MS + 4 * CYCLE_MS + OVERLAY_MOMENT_FOLD_MS + 5_000,
      });
      await expect(card, "a major break's style").toHaveAttribute("data-style", look.style);
      await expect(anon.getByTestId("ovl-sponsor-slot")).toHaveAttribute("data-slot", look.style);
      const plan = await servedPlan(anon, rig.fixtureId);
      expect(plan.airings.map((a) => [a.breakKind, a.cardId, a.style])).toEqual([["set_end", goldId, look.style]]);
    } finally {
      await anon.context().close();
      await owner.close();
    }
  });
});

test.describe("§1's name ladder on the bar (W2-F45)", () => {
  // "Team names never wrap and never truncate on the overlay… a name longer
  // than the cell can hold at 45 px falls to the entrant's short name, then to
  // the three-letter code; this is the only size step." (`_THEMES.md` §1.)
  //
  // W1 rendered `side.name` unconditionally and the ladder was never built.
  //
  // BOTH SIDES ARE LONG, AND THAT IS THE WHOLE FIXTURE. Measured on the
  // pre-fix build at 1920×1080, one long name and one short one does NOT
  // reproduce anything: the team cells are `flex: 1 1 auto`, so the long side
  // simply GROWS (297→1506) and the short side shrinks to its own content
  // (1506→1708). Nothing spills and every assertion below would pass on the
  // defect. It is when BOTH bases exceed the bar that the cells shrink and the
  // unshrinkable names overflow them — pre-fix, measured:
  //
  //   home cell  297→1062   home name 339→1438   home score 1462→1501
  //   away cell 1062→1708   away name 1104→2000  brand      1708→1848
  //
  // — the home score painted inside the away cell, and the away name ran 80 px
  // past the canvas, across the brand mark. That is the defect, and it took a
  // measurement to find the fixture that shows it.
  //
  // ONLY A BROWSER CAN SEE THIS. `apps/web` vitest is `environment: "node"`:
  // `pickNameRung` is arithmetic and is unit-tested, the probes are asserted in
  // the markup, and the MEASUREMENT — the thing the ladder actually is — has no
  // other gate than this one.
  const HOME_LONG = "Royal Kingsbridge & Wandsworth Wanderers Athletic Club Reserves"; // ROY
  const AWAY_LONG = "Northbridge Athletic & Riverside Wanderers Reserve XI"; // NOR
  let crowded: OverlayRig;
  let roomy: OverlayRig;

  /** Renames both entrants BEFORE anything reads the public row.
   *  `getPublicFixture` is `unstable_cache`-wrapped at 30 s and the overlay page
   *  takes its entrant names from it, so a rename after the first read is
   *  invisible for up to half a minute — which is how the rig's `stream_url`
   *  write first failed. */
  async function named(browser: Browser, home: string, away: string): Promise<OverlayRig> {
    const owner = await browser.newContext();
    const ownerPage = await owner.newPage();
    try {
      const rig = await seedOverlayFixture(ownerPage);
      for (const [id, name] of [
        [rig.homeEntrantId, home],
        [rig.awayEntrantId, away],
      ] as const) {
        const res = await apiJson(ownerPage.request, `/api/v1/entrants/${id}`, "PATCH", {
          display_name: name,
        });
        if (res.status >= 300) {
          throw new Error(`ladder rig: PATCH entrant -> ${res.status} ${JSON.stringify(res.error)}`);
        }
      }
      return rig;
    } finally {
      await owner.close();
    }
  }

  /** The OBS canvas one-to-one. `anonPage` takes the project's viewport, which
   *  scales `.ovl-canvas` by `min(vw/1920, vh/1080)` — uniformly, so the ladder
   *  behaves identically, but every box in a failure message is then in scaled
   *  px and cannot be read against §3's inset block or against the measurements
   *  recorded above. Pinned here so the numbers a reader sees are the sheet's. */
  async function anonAtCanvas(browser: Browser): Promise<Page> {
    const ctx = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      viewport: { width: 1920, height: 1080 },
    });
    return ctx.newPage();
  }

  /** Every non-absolute child of a team cell that paints outside it, described.
   *  `.ovl-led` is `position: absolute` and is inset deliberately. */
  async function spill(page: Page, testid: string): Promise<string[]> {
    return page.evaluate((id) => {
      const cell = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (!cell) return ["no cell"];
      const outer = cell.getBoundingClientRect();
      return [...cell.children]
        .filter((c) => getComputedStyle(c).position !== "absolute")
        .map((c) => ({ el: (c as HTMLElement).className, box: c.getBoundingClientRect() }))
        .filter((c) => c.box.right > outer.right + 1 || c.box.left < outer.left - 1)
        .map(
          (c) =>
            `${c.el} ${Math.round(c.box.left)}→${Math.round(c.box.right)} outside ${Math.round(outer.left)}→${Math.round(outer.right)}`,
        );
    }, testid);
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    crowded = await named(browser, HOME_LONG, AWAY_LONG);
    roomy = await named(browser, "Rye", "Deal Town");
  });

  test("two names the bar cannot hold BOTH fall to their codes, and nothing leaves its cell", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const anon = await anonAtCanvas(browser);
    try {
      await anon.goto(`/overlay/fixtures/${crowded.fixtureId}?style=bar`);
      const home = anon.locator('[data-testid="ovl-side-home"] [data-testid="ovl-team-name"]');
      const away = anon.locator('[data-testid="ovl-side-away"] [data-testid="ovl-team-name"]');
      await expect(home).toBeVisible({ timeout: 30_000 });

      // THE DEFECT ITSELF, FIRST. Run against the pre-fix build this prints,
      // verbatim, for the home row:
      //   ovl-team-name  339→1438 outside 297→1062
      //   ovl-team-score 1462→1501 outside 297→1062
      // — the name 376 px past its cell and the score painted inside the AWAY
      // cell. The away row is the same story one worse (name 1104→2000, across
      // the brand at 1708 and off the 1920 canvas); it is not reached because
      // the home row fails first.
      for (const row of ["ovl-side-home", "ovl-side-away"]) {
        expect(await spill(anon, row), `${row}: content painted outside its cell`).toEqual([]);
      }
      // THE VACUITY GUARD, ON BOTH SIDES. If either name fitted, the step
      // below would pass on a bar with no ladder at all — which is exactly what
      // an earlier draft of this test did. Read from the page: the full name's
      // own probe against the room its cell gives it.
      //
      // AFTER the spill check, deliberately. On a build with no ladder the name
      // box cannot shrink, so `available` degenerates to the full width and this
      // guard fires too — with a message blaming the FIXTURE for a defect in the
      // CODE. Ordered this way the reader gets the boxes first (AGENTS.md 20:
      // two error lines, one event, and the misleading one must not come first).
      for (const row of ["ovl-side-home", "ovl-side-away"]) {
        const m = await anon.evaluate((id) => {
          const box = document.querySelector<HTMLElement>(`[data-testid="${id}"] .ovl-team-name`);
          const probe = box?.querySelector<HTMLElement>(".ovl-team-name-probe");
          if (!box || !probe) return null;
          const next = box.nextElementSibling as HTMLElement | null;
          const gap = parseFloat(getComputedStyle(box.parentElement!).columnGap) || 0;
          const slack =
            next === null
              ? 0
              : next.getBoundingClientRect().left - box.getBoundingClientRect().right - gap;
          return {
            full: probe.getBoundingClientRect().width,
            available: box.getBoundingClientRect().width + Math.max(0, slack),
          };
        }, row);
        expect(m, `${row}: the probes are not in the DOM — the ladder is not mounted`).not.toBeNull();
        expect(
          m!.full,
          `${row}: the full name fits in ${Math.round(m!.available)}px — this fixture cannot witness the step down`,
        ).toBeGreaterThan(m!.available);
      }

      // The step itself, on both sides and to DIFFERENT codes — one row cannot
      // witness a per-side ladder.
      await expect(home).toHaveText("ROY", { timeout: 15_000 });
      await expect(away).toHaveText("NOR");

    } finally {
      await anon.context().close();
    }
  });

  test("names that FIT are left exactly as they are — the bar does not code everything", async ({
    browser,
  }) => {
    // The positive pair, and it is not optional: every assertion in the test
    // above is satisfied by a bar that renders three letters unconditionally.
    // "Rye" is also its own three letters in a different case, so this pins
    // that a name which fits is not upper-cased on the way through.
    test.setTimeout(120_000);
    const anon = await anonAtCanvas(browser);
    try {
      await anon.goto(`/overlay/fixtures/${roomy.fixtureId}?style=bar`);
      const home = anon.locator('[data-testid="ovl-side-home"] [data-testid="ovl-team-name"]');
      const away = anon.locator('[data-testid="ovl-side-away"] [data-testid="ovl-team-name"]');
      await expect(home).toHaveText("Rye", { timeout: 30_000 });
      await expect(away).toHaveText("Deal Town");
      for (const row of ["ovl-side-home", "ovl-side-away"]) {
        expect(await spill(anon, row), `${row}: content painted outside its cell`).toEqual([]);
      }
    } finally {
      await anon.context().close();
    }
  });
});
