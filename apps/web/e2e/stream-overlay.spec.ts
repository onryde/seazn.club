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
import { test, expect, type Browser, type Page } from "@playwright/test";
import {
  apiJson,
  expectNoHorizontalScroll,
  invalidateOrgEntitlements,
  setBoolEntitlementOverrideSql,
} from "./helpers";
import {
  OVERLAY_MOMENT_FOLD_MS,
  OVERLAY_MOMENT_HOLD_MS,
} from "../src/components/overlay/moment-timing";
import { END_OF_OVER_HOLD_MS } from "../src/lib/overlay-end-of-over";
import { POLL_MS } from "../src/components/public-site/match-centre/use-live-fixture";
import {
  HOCKEY_CARD_TONES,
  STREAM_URL,
  clearStreamingOverride,
  denyOverlay,
  seedCricketOverlayFixture,
  seedCricketOverlayFreshOver,
  seedOverlayFixture,
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
        // hockey's default is `bug` (`theme-registry.ts` `defaultThemeFor`:
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
      expect(es.tileWidth, "the tile must never grow — an OBS operator frames it").toBe(480);
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

      await sendEvent(ownerPage.request, rig.fixtureId, "hockey.goal", { by: rig.homeEntrantId });
      await sendEvent(ownerPage.request, rig.fixtureId, "hockey.goal", { by: rig.awayEntrantId });
      await sendEvent(ownerPage.request, rig.fixtureId, "hockey.goal", { by: rig.homeEntrantId });

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
// §8's PREVIEW — the organiser console, in a browser for the first time.
//
// The panel shipped `scale(640/1920)`, a constant, inside a `w-full` strip:
// at a 320 px viewport the panel is ~296 px wide and painted a 640 px canvas
// into it, so about a third of the frame showed and §3's bar — cricket's
// DEFAULT theme — lost its score cells off the right edge with nothing to
// scroll to. §8's second correction binds `scale(w/1920)` for the measured
// strip width `w`. Node cannot see that: `apps/web` vitest is
// `environment: "node"`, so `fixture-stream-panel.test.tsx` can pin the pure
// function and the props but never the paint. This is the only thing that can.
//
// The panel is opened ONCE, at 1280, and the viewport is then narrowed: the
// toggle is a phone-folded control at 320 (AGENTS.md 22) and clicking it there
// is a different test's problem. React state survives a resize.
// ===========================================================================

test.describe("§8's live preview", () => {
  test("the canvas scales to the strip at every width, not to a constant", async ({ browser }) => {
    test.setTimeout(120_000);
    const owner = await browser.newContext();
    const page = await owner.newPage();
    try {
      await signInAs(page, rig.ownerEmail);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`/o/${rig.orgSlug}/c/${rig.compSlug}/d/${rig.divSlug}?tab=fixtures`);

      // PREMISE, and the reason this is not the four-line test the review
      // estimated: the run sheet opens on its "Today" filter, and
      // `seedRosteredFixture` does not schedule for today — so the row that
      // carries the toggle is filtered OUT of the sheet even though the same
      // page's "Now playing" strip is showing the fixture. Assert the sheet
      // rendered first, or "no toggle" is indistinguishable from "no page".
      await expect(
        page.locator('[data-testid="run-sheet"]'),
        "the fixtures tab did not render its run sheet at all",
      ).toHaveCount(1);
      await page.locator('[data-testid="run-sheet-filter"] [data-filter="all"]').click();

      const toggle = page.locator('[data-testid="fixture-stream-toggle"]');
      await expect(toggle, "the rig's org holds streaming.overlay, so the row offers the panel").toHaveCount(1);
      await toggle.click();
      await expect(page.locator('[data-testid="stream-preview"]')).toHaveCount(1);

      const measure = () =>
        page.evaluate(() => {
          const strip = document.querySelector<HTMLElement>('[data-testid="stream-preview"]');
          const canvas = document.querySelector<HTMLElement>(
            '[data-testid="stream-preview-canvas"]',
          );
          if (!strip || !canvas) return null;
          const c = canvas.getBoundingClientRect();
          return {
            stripW: strip.clientWidth,
            stripH: strip.clientHeight,
            canvasW: c.width,
            canvasH: c.height,
          };
        });

      const widths: { viewport: number; strip: number; canvas: number }[] = [];
      for (const w of [1280, 768, 320]) {
        await page.setViewportSize({ width: w, height: 900 });
        // The observer fires on the frame AFTER a resize, so the first read at
        // a new width can legitimately still be the previous scale.
        await expect
          .poll(
            async () => {
              const b = await measure();
              return b !== null && b.stripW > 0 && Math.abs(b.canvasW - b.stripW) <= 1.5;
            },
            {
              message: `at ${w}: the painted canvas must settle to the strip's own width`,
              timeout: 15_000,
              intervals: [250],
            },
          )
          .toBe(true);

        const box = await measure();
        expect(box, `the preview left the DOM at ${w}`).not.toBeNull();
        // The whole authored canvas, at every width: painted size = the box it
        // is painted into. A CONSTANT scale satisfies this at one width only,
        // which is exactly the defect.
        expect(
          Math.abs(box!.canvasW - box!.stripW),
          `at ${w}: a ${box!.canvasW}px canvas in a ${box!.stripW}px strip`,
        ).toBeLessThanOrEqual(1.5);
        expect(
          Math.abs(box!.canvasH - box!.stripH),
          `at ${w}: a ${box!.canvasH}px canvas in a ${box!.stripH}px strip, vertically`,
        ).toBeLessThanOrEqual(1.5);
        expect(box!.canvasW, "§8 caps the strip at 640").toBeLessThanOrEqual(641);
        widths.push({ viewport: w, strip: box!.stripW, canvas: box!.canvasW });
      }

      // The differential. Without it "canvas == strip" could in principle be
      // met by a panel that never changed size at all.
      const at = (v: number) => widths.find((r) => r.viewport === v)!;
      expect(
        at(320).canvas,
        `the strip is ${at(320).strip}px at a 320 viewport and ${at(1280).strip}px at 1280 — the canvas must follow`,
      ).toBeLessThan(at(1280).canvas);

      // Named against the SUPERSEDED constant on purpose. `640/1920` is what
      // the panel shipped and is what a reverted `transform` would paint here
      // whatever the strip measures, so this is the assertion that kills that
      // mutant — and it is the only one anywhere that can, because
      // `environment: "node"` has no layout and the pure function returns its
      // own fallback (the same 640/1920) when nothing has been measured.
      expect(
        at(320).canvas,
        `at a 320 viewport the strip is ${at(320).strip}px; a canvas still painting the shipped 640px constant reads 640 here`,
      ).toBeLessThan(639);
    } finally {
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

  async function openPhoneTab(page: Page): Promise<void> {
    await page.goto(`/o/${community.orgSlug}/c/${community.compSlug}/d/${community.divSlug}?tab=fixtures`);
    await expect(page.locator('[data-testid="run-sheet"]'), "the fixtures tab rendered no run sheet").toHaveCount(1);
    // The sheet opens on "Today" and the seed does not schedule for today (the
    // live-preview test's own premise above).
    await page.locator('[data-testid="run-sheet-filter"] [data-filter="all"]').click();
    const toggle = page.locator('[data-testid="fixture-stream-toggle"]');
    await expect(toggle, "community holds streaming.overlay (V426), so the row offers the panel").toHaveCount(1);
    await toggle.click();
    await page.locator('[data-testid="stream-tab-phone"]').click();
  }

  test("opens with no upgrade gate, grants the plan's free match credits on the read, and says so on the card", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    expect(rate, "V426 declares a community rate of at least one match").toBeGreaterThanOrEqual(1);
    const owner = await browser.newContext({ storageState: { cookies: [], origins: [] } });
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
      await expect(page.locator('[data-testid="stream-credits-split"]')).toHaveText(
        en("stream.credits.split", { m: rate, p: 0 }),
      );

      await page.locator('[data-testid="stream-buy-more"]').click();
      await expect(page.locator('[data-testid="stream-credits-monthly"]')).toHaveText(
        rate === 1 ? en("stream.credits.monthlyNote.one") : en("stream.credits.monthlyNote.other", { n: rate }),
      );

      // The card is open with both new lines on it: no width may scroll the page.
      let widths = 0;
      for (const width of [1280, 768, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(page.locator('[data-testid="stream-credits-monthly"]')).toBeVisible();
        await expectNoHorizontalScroll(page);
        widths++;
      }
      expect(widths).toBe(3);
    } finally {
      await owner.close();
    }
  });

  test("the sibling negative: an override switches streaming.relay off, and the same tab is the UpgradeGate", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    await setBoolEntitlementOverrideSql(community.orgId, "streaming.relay", false);
    const owner = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await owner.newPage();
    try {
      await invalidateOrgEntitlements(page.request, community.orgId);
      await signInAs(page, community.ownerEmail);
      await page.setViewportSize({ width: 1280, height: 900 });
      await openPhoneTab(page);
      const gate = page.locator('[data-testid="stream-phone-gate"]');
      await expect(gate.locator(":scope > a"), "the relay's UpgradeGate pill").toHaveCount(1, { timeout: 30_000 });
      await expect(gate.locator("[data-phone-body]")).toHaveCount(0);
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
  await sendEvent(page.request, fixtureId, "hockey.goal", { by: rig.homeEntrantId });
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

      await sendEvent(ownerPage.request, moments.fixtureId, "hockey.goal", { by: moments.homeEntrantId });

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
      await sendEvent(ownerPage.request, moments.fixtureId, "hockey.goal", { by: moments.homeEntrantId });
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
