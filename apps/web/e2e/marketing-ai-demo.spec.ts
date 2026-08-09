import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { expectNoHorizontalScroll } from "./helpers";

// #364 Task 7 — the "pick a template" AI demo on /[lang]/scheduling, driven for
// real in a browser.
//
// The section's whole claim is "this is a RECORDING of a product run, replayed
// through the product's own components". Three of the four cases below are the
// only place that claim can be checked end to end:
//
//   1. ZERO model network. The issue's actual acceptance: selecting and
//      replaying all three templates must not touch a model provider or an AI
//      endpoint. A unit test cannot see the network at all; only a real page
//      load can. The fixture chunks arriving over `_next/static` are the point
//      of the design (lazy `import()`), not a violation, so the assertion names
//      providers and the AI API surface rather than "no requests".
//   2. The T3 hero flow, animated. The unit suite runs with fake timers and no
//      DOM, so nothing there proves the replay actually reaches its end state in
//      a browser — that the outer 350ms cursor and `AiTrace`'s own 380ms reveal
//      converge on "Ready / verified" instead of stalling half-revealed.
//   3. 375px. `renderToStaticMarkup` has no layout, so page-level overflow is
//      unobservable outside a real viewport.
//   4. The four locales, server-rendered.
//
// Unauthenticated, like `marketing-scheduling.spec.ts`: the page is public and a
// signed-in session would only add noise (and a nav that differs per plan).
test.use({ storageState: { cookies: [], origins: [] } });

// ---------------------------------------------------------------------------
// Everything asserted below is READ from what ships — never retyped.
//
// Copy comes from the dictionaries, counts and prices from the committed
// recordings. A hand-copied string turns a wording change into a green test
// about text nobody ships, and a hand-typed credit total would let the demo
// print a price the recorded run never paid.
//
// `readFileSync` rather than `import … from "*.json"`: Playwright's loader
// rejects a bare JSON import ("needs an import attribute of type: json") and
// reports it as `No tests found`, which reads like a bad path filter.
// ---------------------------------------------------------------------------
const read = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")) as Record<
    string,
    unknown
  >;

const LOCALES = ["en", "es", "fr", "nl"] as const;
type Loc = (typeof LOCALES)[number];

const MARKETING = Object.fromEntries(
  LOCALES.map((l) => [l, read(`../src/dictionaries/${l}/marketing.json`)]),
) as Record<Loc, Record<string, string>>;

/** The trace and diff copy lives in `ui`, which the page ships as a `board.*`
 *  subset — the demo renders the product's components, so it renders the
 *  product's strings. */
const UI_EN = read("../src/dictionaries/en/ui.json") as Record<string, string>;

/** Hero first, exactly as the rail orders it. */
const SLUGS = ["finals-day", "club-night", "northside-open"] as const;
type Slug = (typeof SLUGS)[number];

interface Recording {
  response: {
    credits: number;
    unschedulable: { fixture_id: string }[];
    divisions?: { id: string }[];
  };
}
const RECORDING = Object.fromEntries(
  SLUGS.map((s) => [s, read(`../src/demo/ai-templates/${s}.json`)]),
) as unknown as Record<Slug, Recording>;

/** A provider hostname, or the app's own AI endpoints. `_next/static` chunks —
 *  including `…ai-templates…json.js`, the recordings themselves — are how the
 *  section is SUPPOSED to work and must not match. */
const MODEL_CALL = /anthropic|openrouter|api\.openai|generativelanguage|\/api\/v1\/.*ai/i;

const section = (page: Page): Locator => page.locator('[data-ai-demo="ready"]');
const card = (page: Page, slug: Slug): Locator =>
  section(page).locator(`[data-ai-template="${slug}"]`);
const price = (page: Page): Locator => section(page).locator('[data-ai-price="run"]');
/** The panel that actually draws the run — what the viewport gate observes. */
const screen = (page: Page): Locator => section(page).locator('[data-ai-screen="true"]');
const trace = (page: Page): Locator =>
  section(page).getByRole("region", { name: UI_EN["board.ai.trace.aria.schedule"]! });

/**
 * Select a template and wait for the replay to REACH ITS END STATE.
 *
 * `data-ai-demo="ready"` is on the section root and is present before any
 * recording has loaded — it means "the section shipped", not "the run has
 * played". So the wait is on post-JS signals instead:
 *
 *   * single-division (T1/T3) — the stepper's final `Ready` node, which only
 *     enters the DOM once the outer cursor has revealed every event, AND the
 *     state tag settling from `running` to `verified`, which needs `AiTrace`'s
 *     own reveal to have caught up too;
 *   * joint (T2) — the real joint console renders no referee trace, so neither
 *     does this; its end state is the per-division ledger.
 *
 * The price card is recomputed from the pack for every template, so it is the
 * one signal common to all three.
 */
async function playOut(page: Page, slug: Slug): Promise<void> {
  await card(page, slug).click();
  await expect(card(page, slug)).toHaveAttribute("aria-pressed", "true");

  const rec = RECORDING[slug];
  if (rec.response.divisions?.length) {
    await expect(section(page).locator('[data-ai-ledger="row"]')).toHaveCount(
      rec.response.divisions.length,
    );
  } else {
    await expect(trace(page)).toContainText(UI_EN["board.ai.trace.node.ready"]!, {
      timeout: 30_000,
    });
    await expect(
      trace(page).getByText(UI_EN["board.ai.trace.state.verified"]!, { exact: true }),
    ).toHaveCount(1, { timeout: 30_000 });
  }

  await expect(price(page)).toBeVisible();
  await expect(price(page)).toHaveAttribute("data-credits", String(rec.response.credits));
}

test.describe("/[lang]/scheduling — the recorded AI demo", () => {
  test("replaying all three recordings calls no model and no AI endpoint", async ({ page }) => {
    // Registered BEFORE goto: the document request itself is in scope.
    const urls: string[] = [];
    page.on("request", (r) => urls.push(r.url()));

    await page.goto("/en/scheduling");
    await expect(section(page)).toBeVisible();
    await expect(section(page).locator("[data-ai-template]")).toHaveCount(SLUGS.length);

    for (const slug of SLUGS) {
      await playOut(page, slug);
      // "Play it again" re-runs the reveal from zero — the one interaction that
      // would plausibly re-fetch a run if anything here were live.
      const replay = section(page).getByRole("button", {
        name: MARKETING.en["scheduling.aidemo.replay"]!,
      });
      // Asserted, not probed. `if (await replay.count())` passed whether the
      // button existed or not, so a control that stopped rendering — the one
      // interaction that would re-fetch a run if anything here were live — would
      // have taken this test's teeth with it and stayed green. The button
      // belongs to the trace, so it exists for exactly the two single-division
      // templates and must NOT exist for the joint one.
      const joint = Boolean(RECORDING[slug].response.divisions?.length);
      await expect(replay).toHaveCount(joint ? 0 : 1);
      if (!joint) {
        await replay.click();
        await expect(trace(page)).toContainText(UI_EN["board.ai.trace.node.ready"]!, {
          timeout: 30_000,
        });
      }
    }

    expect(urls.length).toBeGreaterThan(0); // the probe collected something
    expect(urls.filter((u) => MODEL_CALL.test(u))).toEqual([]);
  });

  test("holds the replay until the block is scrolled into view", async ({ page }) => {
    await page.goto("/en/scheduling");

    // The premise, measured rather than assumed: if the screen were already on
    // display at load, every assertion below would pass for the wrong reason.
    // Measured on the SCREEN, not the section — the section's own top edge is
    // inside the first viewport at this size (y≈548 of 720), which is why the
    // observer is anchored on the screen in the first place.
    const box = await screen(page).boundingBox();
    const viewport = page.viewportSize();
    expect(box, "screen has no box").not.toBeNull();
    expect(
      box!.y,
      "the demo screen starts inside the first viewport — this test proves nothing",
    ).toBeGreaterThan(viewport!.height);

    // Long enough for the whole reveal to have run twice over (350ms a line).
    // Before the gate this is where the trace finished, unwatched.
    await page.waitForTimeout(6_000);
    await expect(section(page)).toHaveAttribute("data-ai-started", "false");
    await expect(
      trace(page).getByText(UI_EN["board.ai.trace.state.verified"]!, { exact: true }),
      "the run played out below the fold",
    ).toHaveCount(0);

    // Scrolling is the whole trigger — no click. That this half passes is also
    // what proves the half above was a shut gate and not dead JavaScript.
    await screen(page).scrollIntoViewIfNeeded();
    await expect(section(page)).toHaveAttribute("data-ai-started", "true");
    await expect(trace(page)).toContainText(UI_EN["board.ai.trace.node.ready"]!, {
      timeout: 30_000,
    });
  });

  test("a card click starts the run even while the screen is still off-screen", async ({
    page,
  }) => {
    await page.goto("/en/scheduling");

    // The card scrolls into view on click; the screen below it need not, and at
    // 375px it does not. A view-only gate swallowed exactly this interaction.
    await card(page, "club-night").click();
    await expect(section(page)).toHaveAttribute("data-ai-started", "true");
    await expect(trace(page)).toContainText(UI_EN["board.ai.trace.node.ready"]!, {
      timeout: 30_000,
    });
  });

  test("T3 finals day plays through to the diff, the unplaceable list and the price", async ({
    page,
  }) => {
    await page.goto("/en/scheduling");

    // The hero is the finals-day card, and it is the default selection.
    await expect(card(page, "finals-day")).toHaveAttribute("data-ai-hero", "true");
    for (const slug of SLUGS) await expect(card(page, slug)).toBeVisible();

    await playOut(page, "finals-day");

    // The product's own change list, rendered by `AiDiffPanel`.
    await expect(section(page).getByText(UI_EN["board.ai.diff.title"]!)).toBeVisible();

    // Every fixture the run reported it could not place, one row each, keyed by
    // the recording's own fixture ids.
    const unschedulable = RECORDING["finals-day"].response.unschedulable;
    expect(unschedulable.length).toBeGreaterThan(0);
    const rows = section(page).locator('[data-ai-unschedulable="row"]');
    await expect(rows).toHaveCount(unschedulable.length);
    for (const u of unschedulable) {
      await expect(
        section(page).locator(`[data-ai-unschedulable="row"][data-fixture-id="${u.fixture_id}"]`),
      ).toHaveCount(1);
    }
    await expect(
      section(page).getByText(MARKETING.en["scheduling.aidemo.unschedulable.title"]!),
    ).toBeVisible();
  });

  test.describe("375px", () => {
    // `mobile-se`/`mobile-14` are pinned to `mobile.spec.ts` by `testMatch`, so
    // a new file is invisible to them however it is named. The viewport is set
    // here instead, which gives this section the same 375×667 reference phone
    // under the `parallel` project.
    test.use({ viewport: { width: 375, height: 667 } });

    test("no page-level horizontal scroll on any template", async ({ page }) => {
      await page.goto("/en/scheduling");
      await expect(section(page)).toBeVisible();
      await expectNoHorizontalScroll(page);

      for (const slug of SLUGS) {
        await playOut(page, slug);
        await expectNoHorizontalScroll(page);
      }
    });
  });

  test("every locale renders its own recorded-run copy", async ({ page }) => {
    for (const lang of LOCALES) {
      await page.goto(`/${lang}/scheduling`);
      const dict = MARKETING[lang];
      await expect(section(page)).toBeVisible();
      await expect(section(page)).toContainText(dict["scheduling.aidemo.recordedLabel"]!);
      await expect(section(page)).toContainText(dict["scheduling.aidemo.title"]!);
      await expect(card(page, "finals-day")).toContainText(
        dict["scheduling.aidemo.card.finals-day.name"]!,
      );
    }
  });
});
