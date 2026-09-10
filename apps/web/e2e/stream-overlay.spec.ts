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
// SERIAL, on purpose. The rig grants an org-wide entitlement halfway through
// its own life (the 404 gate is proved on the SAME fixture, before the grant),
// so the tests are ordered rather than independent. AGENTS.md class 21 applies
// to reading a red run from this file: the first failure aborts the rest, so a
// red COUNT here is a floor, never a total — re-run after each fix until a
// full pass completes.
import { test, expect, type Browser, type Page } from "@playwright/test";
import { apiJson, invalidateOrgEntitlements } from "./helpers";
import {
  HOCKEY_CARD_TONES,
  STREAM_URL,
  grantOverlay,
  seedOverlayFixture,
  sendEvent,
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
/** The route's status for this exact fixture BEFORE the entitlement existed.
 *  Captured in `beforeAll` rather than asserted there, so the gate has a named
 *  test of its own and its expectation is a real differential: one fixture,
 *  one URL, one variable. */
let statusBeforeGrant = 0;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  // `seedOverlayFixture` leaves this context signed in as the rig's OWNER, and
  // the entitlement drop below needs exactly that session: it borrows staff on
  // the org's owner row, so a bare `browser.newContext()` — which inherits the
  // shared Pro storageState — flips the rig owner to staff and then calls the
  // admin route as somebody else. That is a 401, and it is how this hook first
  // failed.
  const owner = await browser.newContext();
  const ownerPage = await owner.newPage();
  try {
    rig = await seedOverlayFixture(ownerPage);

    const anon = await anonPage(browser);
    try {
      const res = await anon.goto(`/overlay/fixtures/${rig.fixtureId}`);
      statusBeforeGrant = res?.status() ?? 0;
    } finally {
      await anon.context().close();
    }

    await grantOverlay(rig.orgId);
    // The 404 above RESOLVED `streaming.overlay` for this org, so the grant has
    // to drop whatever that resolution cached. A no-op where there is no Redis;
    // required against a cached target, and the reason the two are not one step.
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
  test("the entitlement gate 404s until streaming.overlay is granted", async ({ browser }) => {
    expect(
      statusBeforeGrant,
      "the same fixture, the same URL, no entitlement — the overlay must be indistinguishable from a missing fixture",
    ).toBe(404);
    const page = await anonPage(browser);
    try {
      const res = await page.goto(`/overlay/fixtures/${rig.fixtureId}`);
      expect(res?.status(), "and 200 once the org holds the key").toBe(200);
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
    } finally {
      await owner.close();
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
