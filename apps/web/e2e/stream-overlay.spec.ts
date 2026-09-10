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
        // Three cards on the ledger, three chips on air. This is the half of
        // the obligation that had never rendered for anyone before this seed.
        await expect(chips, `${style}: one chip per card on the ledger`).toHaveCount(
          HOCKEY_CARD_TONES.length,
        );
        const ink = await resolveInk(page, '[data-testid="ovl-chip"]');

        const fills: string[] = [];
        for (const [i, { classKey, tone }] of HOCKEY_CARD_TONES.entries()) {
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
          `${style}: the three tones must be three colours, not one repeated (${fills.join(", ")})`,
        ).toBe(HOCKEY_CARD_TONES.length);
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
