import { test as base, expect, type Browser, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stageDefaultsFor } from "@seazn/engine/sport";
import { builtinModules } from "@seazn/engine/sports";
import { expectNoHorizontalScroll, overflowingIn, TAG, withDb } from "./helpers";
import { expectQrDecodesAsPainted, expectQrEnlarges, expectWholeModuleScale } from "./helpers/qr-enlarge";
import { consentedAnonymousState } from "./scorepad-a11y-kit";
import { HOLD_MS } from "../src/components/v2/scorepad/queue";
import { HUMAN_FASTEST_REPEAT_MS } from "../src/components/v2/scorepad/use-pad-pipeline";

// Quick match plan 2 Task 5 (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 3, §8): the guest's home
// at `/q/<token>` in a real browser, at the three widths the task is verified at (320, 768, 1280), for a league and the dead
// link. Task 10 owns the flow (`quick-match.spec.ts`: setup → home → Score → back) and the seven-width case
// (`mobile.spec.ts`); this file is the home's own width check, which no unit test can see: the page's real width with a
// 43-character side name, the hero, the table and the list laid out by the browser.
//
// A guest's quick match is a league (owner 2026-11-12, "take out": League + Knockout comes later), so no knockout can be
// made here: the knockout home (the draw, the waiting final and its "not yet", Add a match refused) stays in code for
// League + Knockout and is covered by its tests in app/q/[token]/__tests__/ (page, score-route and add-match-route) until then.
//
// Every quick match here is made the way a guest makes one: the setup page's form, posted by its Start button, followed to
// the home (the real producer, never a seed). Measured with `expectNoHorizontalScroll` (helpers.ts), which lifts the
// `overflow-x: clip` backstop before it reads.
//
// Sport: badminton, clicked explicitly (A11), as quick-match.spec.ts does; the home has no sport-specific layout beyond its
// score line, which the page test (app/q/[token]/__tests__/page.test.tsx) covers for badminton and football.

const test = base.extend<{ guest: Page }>({
  guest: async ({ browser }, provide) => {
    const ctx = await browser.newContext({ storageState: await consentedAnonymousState() });
    try {
      await provide(await ctx.newPage());
    } finally {
      await ctx.close();
    }
  },
});

const WIDTHS = [320, 768, 1280] as const;
/** A realistic long entrant name (AGENTS.md: the defect a short name hides), 43 characters. */
const LONG = "The Extraordinarily Long-Named Doubles Pair";

const form = (page: Page) => page.getByTestId("qm-setup-form");
const side = (page: Page, n: number) => form(page).getByLabel(`Side ${n}`, { exact: true });

/** Make a quick match through the setup page and land on its home. It is a league: there is no format to pick
 *  (owner 2026-11-12). `variant` picks badminton's rules by key (the setup's own select); absent, the setup's default. */
async function createThroughSetup(page: Page, sides: string[], variant?: string) {
  await page.goto("/en/play");
  await expect(form(page)).toBeVisible();
  await form(page).getByText("Badminton", { exact: true }).click();
  await form(page).getByLabel("Name", { exact: true }).fill(`e2e home ${TAG}`);
  for (let n = 3; n <= sides.length; n++) await page.getByRole("button", { name: "+ Add a side" }).click();
  for (const [k, name] of sides.entries()) await side(page, k + 1).fill(name);
  if (variant !== undefined) await form(page).locator('select[name="variant_key"]').selectOption(variant);
  await page.getByTestId("qm-start").click();
  await expect(page).toHaveURL(/\/q\/[^/?#]+$/);
}

/** Each width in turn: reloaded by default (the page as it first paints there); `{ reload: false }` keeps the page on
 *  screen as it is and only resizes it, for a state a reload would not bring back (a flash whose `?e=` is spent). */
async function atEachWidth(page: Page, check: (width: number) => Promise<void>, { reload = true } = {}) {
  let checked = 0;
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    if (reload) await page.reload();
    await check(width);
    await expectNoHorizontalScroll(page);
    checked++;
  }
  expect(checked).toBe(WIDTHS.length);
}

test("home (Task 5): a league of 4 with a 43-character side, at 320, 768 and 1280: hero, table and list, no sideways scroll", async ({ guest: page }) => {
  await createThroughSetup(page, [LONG, "Priya & Tom", "Lee & Ana", "Jo & Max"]);
  await atEachWidth(page, async (width) => {
    await expect(page.getByTestId("qm-played"), `${width}`).toHaveText("0 of 6 matches played · deleted 7 days after the last score unless saved");
    await expect(page.getByTestId("qm-hero"), `${width}`).toContainText("Up next · match 1 of 6");
    await expect(page.getByTestId("qm-standings-row"), `${width}`).toHaveCount(4);
    // The short table's own row header: the closed Full table's copy of the name is in the DOM too (a native <details>).
    await expect(page.getByTestId("qm-standings-row").getByRole("rowheader", { name: LONG, exact: true }), `${width}`).toBeVisible();
    await expect(page.getByTestId("qm-match"), `${width}`).toHaveCount(6);
    await expect(page.getByTestId("qm-anyone"), `${width}`).toBeVisible();
    // Plan 3 Task 5 (D13 lifted): an unsaved match offers Save to anyone, a 44px target in the actions row.
    const save = page.getByTestId("qm-save");
    await expect(save, `${width}: Save is offered`).toHaveText("Save this match");
    expect((await save.boundingBox())?.height ?? 0, `${width}: Save is a 44px target`).toBeGreaterThanOrEqual(44);
    await expect(page.getByTestId("qm-saved"), `${width}: nobody saved it yet`).toHaveCount(0);
    // Owner 2026-11-12: under Save, the day it is deleted (the date itself is pinned against the row in page.test.tsx).
    await expect(page.getByTestId("qm-not-saved"), `${width}: the deletion day under Save`).toHaveText(
      /^Not saved — deleted on \d{1,2} [A-Z][a-z]+ \d{4}$/,
    );
  });
});

// Owner 2026-11-12, "Full table": the short table (P, W, Pts) opens in place, a native <details>, into the public table's own
// columns for the sport; open, the short table steps aside, and the wider table scrolls inside its own focusable region,
// never the page. At the house's three widths, 1280, 768 (review m4) and 320 (the narrowest phone, where the table is
// widest against the screen). The columns and their order are the public table's, pinned against it in
// app/q/[token]/__tests__/page.test.tsx; here the browser shows that the fold opens, swaps, scrolls in place and closes back.
test("Full table (owner 2026-11-12): at 1280, 768 and 320 the fold opens in place to the public table's columns, the short table steps aside, and it closes back; no sideways scroll", async ({ guest: page }) => {
  const EN_UI = readDict("../src/dictionaries/en/ui.json");
  const EN_PUB = readDict("../src/dictionaries/en/public.json");
  const label = EN_UI["quickMatch.home.fullTable"]!;
  const regionName = EN_PUB["table.regionCaptioned"]!.replace("{caption}", label);
  await createThroughSetup(page, [LONG, "Priya & Tom", "Lee & Ana", "Jo & Max"]);
  let checked = 0;
  const WIDTHS = [1280, 768, 320] as const;
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    const short = page.getByTestId("qm-standings-short");
    const fold = page.getByTestId("qm-full-table");
    const toggle = page.getByTestId("qm-full-table-toggle");
    const region = page.getByTestId("qm-full-table-region");
    // First paint: the short table, the fold closed under it.
    await expect(short, `${width}`).toBeVisible();
    await expect(toggle, `${width}`).toContainText(label);
    await expect(region, `${width}: closed`).toBeHidden();
    // Closed, the fold's table is in the DOM (no script: a native <details>) but NOT in the accessibility tree: one row
    // header for the side (the short table's), and no region by the fold's name.
    await expect(page.getByTestId("qm-full-table-row"), `${width}: closed, its rows are in the DOM`).toHaveCount(4);
    await expect(page.getByRole("rowheader", { name: LONG, exact: true }), `${width}: closed, one row header for the side`).toHaveCount(1);
    await expect(page.getByRole("region", { name: regionName }), `${width}: closed, the region is not exposed`).toHaveCount(0);
    expect((await toggle.boundingBox())?.height ?? 0, `${width}: the toggle is a 44px target`).toBeGreaterThanOrEqual(44);

    await toggle.click();
    await expect(fold, `${width}: open`).toHaveAttribute("open", "");
    await expect(region, `${width}`).toBeVisible();
    await expect(short, `${width}: one table at a time`).toBeHidden();
    // Open, the accessibility tree swaps tables with the screen: the region by its name, still one row header for the side.
    await expect(page.getByRole("region", { name: regionName }), `${width}: open, the region is exposed`).toHaveCount(1);
    await expect(page.getByRole("rowheader", { name: LONG, exact: true }), `${width}: open, one row header for the side`).toHaveCount(1);
    // More than the short table's columns, Lost among them, and every side a row.
    const heads = page.getByTestId("qm-full-table-head").locator("th[title]");
    expect(await heads.count(), `${width}: more than P, W and Pts`).toBeGreaterThan(3);
    await expect(page.getByTestId("qm-full-table-head").locator(`th[title="${EN_PUB["table.col.lost"]}"]`), `${width}`).toHaveCount(1);
    await expect(page.getByTestId("qm-full-table-row"), `${width}`).toHaveCount(4);
    await expect(page.getByTestId("qm-full-table").getByText(LONG), `${width}`).toBeVisible();
    // Its own scrolling region: a role, a name and a tab stop (axe's scrollable-region-focusable), and the page stays put.
    await expect(region).toHaveAttribute("role", "region");
    await expect(region).toHaveAttribute("tabindex", "0");
    await expect(region).toHaveAttribute("aria-label", regionName);
    await region.focus();
    await expect(region, `${width}: the region takes focus`).toBeFocused();
    await expectNoHorizontalScroll(page);
    // AGENTS.md rule 23: where the open table is wider than the screen it is a REACHABLE scroll strip (overflow-x auto, a
    // tab stop, a role and a name), never a clip. Every overflowing box in the fold is the reachable kind with tabindex 0;
    // at 320 the region itself overflows (measured 448px of table in 286px), so the exemption is exercised, not assumed.
    const { clipped, scrollable } = await overflowingIn(page, '[data-testid="qm-full-table"]', "*", `${width}: no Full table`);
    expect(clipped, `${width}: the open Full table clips nothing`).toEqual([]);
    for (const box of scrollable) expect(box, `${width}: a scrolling box is a tab stop`).toMatch(/tabindex=0$/);
    const overflows = await region.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    if (width === 320) expect(overflows, "320: the open Full table scrolls in its region (premise of the checks)").toBe(true);
    expect(scrollable.length > 0, `${width}: the scan saw the region's overflow`).toBe(overflows);
    // axe's own verdict on the open fold (scrollable-region-focusable among the WCAG A/AA rules): no violation, and when
    // the region scrolls the rule judged at least one node, so a green here is not an axe run that evaluated nothing.
    const axe = await new AxeBuilder({ page }).include('[data-testid="qm-full-table"]').withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(
      axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
      `${width}: axe on the open Full table`,
    ).toEqual([]);
    const judged = axe.passes.filter((p) => p.id === "scrollable-region-focusable").flatMap((p) => p.nodes).length;
    if (overflows) expect(judged, `${width}: axe judged the scrolling region`).toBeGreaterThan(0);

    await toggle.click();
    await expect(region, `${width}: closed again`).toBeHidden();
    await expect(short, `${width}: the short table is back`).toBeVisible();
    await expectNoHorizontalScroll(page);
    checked++;
  }
  expect(checked).toBe(WIDTHS.length);
});

// ── Task 6: Score ───────────────────────────────────────────────────────────────────────────────────────────────────
//
// The Score control is a plain form post (`POST /q/<token>/score/<fixture>`) answered with a 303 into the pad, or back to the
// home with a flash (app/q/[token]/score/[fixtureId]/route.ts). Its unit and DB tests prove the route and the island; this is
// what only a browser shows: the post followed to the pad, the Back button and a second tap that reopens the same link, and
// the buttons as real 44px targets at the three widths. (Its refused post, a waiting knockout final, needs a knockout, which
// a guest cannot make since the owner's 2026-11-12 "take out": score-route.test.ts proves that refusal until League +
// Knockout.)

/** A real tap target: at least 44px tall, and the element a tap at its centre actually hits (`boundingBox()` measures paint,
 *  not hit area). Scrolled into view first: `elementFromPoint` is viewport-relative and reads null below the fold. */
async function expectTappable(locator: Locator, what: string) {
  await locator.scrollIntoViewIfNeeded();
  const seen = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { height: r.height, hit: top !== null && (top === el || el.contains(top)) };
  });
  expect(seen.height, `${what}: 44px or more`).toBeGreaterThanOrEqual(44);
  expect(seen.hit, `${what}: the tap lands on it`).toBe(true);
}

/** The pad's Start, pressed once its island runs. It is a plain button with no form, so a press before hydration is lost and
 *  the Confirm card stays (seen on a loaded local run, the French case below). React's props key on the button is the
 *  signal; pressed once, never retried (a second Start is a write of its own). */
async function pressStart(pad: Page) {
  const start = pad.getByTestId("score-start-match");
  await expect
    .poll(() => start.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$"))), {
      message: "the pad's Start never hydrated",
      timeout: 20_000,
    })
    .toBe(true);
  await start.click();
}

test("Score (Task 6): a league of 4 at 320, 768 and 1280: Score on the hero and on each of the 6 matches, real 44px targets", async ({ guest: page }) => {
  await createThroughSetup(page, [LONG, "Priya & Tom", "Lee & Ana", "Jo & Max"]);
  await atEachWidth(page, async (width) => {
    const hero = page.getByTestId("qm-hero").getByTestId("qm-score");
    await expect(hero, `${width}`).toHaveText("Score this match");
    const rows = page.getByTestId("qm-match").getByTestId("qm-score");
    await expect(rows, `${width}`).toHaveCount(6);
    await expectTappable(hero, `${width}: the hero's Score`);
    await expectTappable(rows.first(), `${width}: a row's Score`);
    await expectTappable(rows.last(), `${width}: the last row's Score`);
  });
});

test("Score (Task 6): the hero's Score lands in the pad on its match; Back, then Score again, reopens the same link", async ({ guest: page }) => {
  await createThroughSetup(page, ["Ravi & Sam", "Priya & Tom", "Lee & Ana", "Jo & Max"]);
  const home = new URL(page.url()).pathname;
  await page.getByTestId("qm-hero").getByTestId("qm-score").click();
  // The secret alone in the path (O3): no query, no fragment.
  await expect(page).toHaveURL(/\/score\/dl_[A-Za-z0-9_-]{43}$/);
  const pad = new URL(page.url()).pathname;
  await expect(page.getByTestId("quick-match-back-link")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${home}$`));
  // Playwright launches Chromium with its back-forward cache OFF (`--disable-back-forward-cache`), so this Back always
  // RELOADS the home: it proves the second post and the reopened link, not the island's bfcache unlock. (No-store alone would
  // not stop a phone's browser restoring it.) That unlock is proven by its unit test
  // (components/quick-match/__tests__/score-form.test.tsx, "back from the pad (bfcache)"); a restore on a Chromium WITH the
  // cache is quick-match.spec.ts's review I-1 case.
  await page.getByTestId("qm-hero").getByTestId("qm-score").click();
  await expect(page).toHaveURL(/\/score\/dl_/);
  expect(new URL(page.url()).pathname, "the same link, reopened (not a second one)").toBe(pad);
});

// ── Task 7: Share ───────────────────────────────────────────────────────────────────────────────────────────────────
//
// The island's unit test (components/quick-match/__tests__/share.test.tsx) proves its wiring with doubles; this is what only
// a browser shows: the link built on the page's real origin, the real clipboard, the Seazn QR as painted (it must decode to
// exactly the home link, logo and all), the row's width with a 43-character side on the page, and the share sheet handed
// the home link. The link, Copy and the share sheet are on first paint (one tap to WhatsApp); only the QR is behind "Show
// QR" (controller ruling 2026-11-08). Desktop Chrome on Linux has no `navigator.share`, so each case sets it explicitly:
// removed for the first, a recording stand-in for the second (the real sheet is the operating system's).

test("Share (Task 7): the link and Copy on first paint, the QR closed; Copy fills the clipboard, Show QR draws exactly the link, at 320, 768 and 1280", async ({ guest: page }) => {
  await page.addInitScript(() => {
    delete (Navigator.prototype as { share?: unknown }).share;
  });
  await createThroughSetup(page, [LONG, "Priya & Tom", "Lee & Ana", "Jo & Max"]);
  // The home link a guest shares is the page's own address: `/q/<token>` on this origin, never the pad's device link.
  const homeUrl = page.url();
  expect(new URL(homeUrl).pathname).toMatch(/^\/q\/qm_[A-Za-z0-9_-]+$/);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(homeUrl).origin });
  await atEachWidth(page, async (width) => {
    // First paint, no tap: the link and Copy are there; the QR is not.
    const field = page.getByTestId("qm-share-url");
    await expect(field, `${width}: the home link on this origin`).toHaveValue(homeUrl);
    await expect(field, `${width}`).toBeVisible();
    await expect(field, `${width}`).toHaveClass(/\bph-no-capture\b/);
    const copy = page.getByTestId("qm-share-copy");
    await expect(copy, `${width}`).toBeVisible();
    await expect(copy, `${width}`).toHaveText("Copy link");
    const toggle = page.getByTestId("qm-share-toggle");
    await expect(toggle, `${width}`).toHaveText("Show QR");
    await expect(toggle, `${width}: the QR is closed on first paint`).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("qm-share-qr"), `${width}: no QR before the tap`).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Share on WhatsApp" }), `${width}: no share sheet on this browser`).toHaveCount(0);
    await expectTappable(copy, `${width}: Copy link`);
    await expectTappable(toggle, `${width}: Show QR`);

    // One tap copies, without opening anything.
    await copy.click();
    await expect(copy, `${width}`).toHaveText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText()), `${width}: the clipboard holds the home link`).toBe(homeUrl);
    await expect(toggle, `${width}: Copy never opens the QR`).toHaveAttribute("aria-expanded", "false");

    // Show QR: the Seazn QR, drawn on the tap, painted sensitive, whole device px per module, decoding to exactly the link.
    await toggle.click();
    await expect(toggle, `${width}`).toHaveAttribute("aria-expanded", "true");
    const qr = page.getByTestId("qm-share-qr");
    await expect(qr, `${width}`).toBeVisible();
    await expect(qr, `${width}`).toHaveClass(/\bph-no-capture\b/);
    await expectWholeModuleScale(page, qr, { minPerModule: 3, what: `${width}: the share QR` });
    await expectQrDecodesAsPainted(qr, homeUrl, `${width}: the share QR`);
  });
  // One tap enlarges it (D10), and the enlarged QR is blocked from replay too.
  await expectQrEnlarges(page, "qm-share-qr", { sensitive: true });
});

test("Share (Task 7): where the phone has a share sheet, 'Share on WhatsApp' is on first paint and ONE tap hands it the home link, the name and the message", async ({ guest: page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "share", {
      configurable: true,
      value: async function share(data: ShareData) {
        const w = window as unknown as { __qmShared?: ShareData[] };
        (w.__qmShared ??= []).push(data);
      },
    });
  });
  await createThroughSetup(page, ["Ravi & Sam", "Priya & Tom"]);
  const homeUrl = page.url();
  const name = `e2e home ${TAG}`;
  await atEachWidth(page, async (width) => {
    const native = page.getByRole("button", { name: "Share on WhatsApp" });
    await expect(native, `${width}: on first paint, no toggle`).toBeVisible();
    await expect(page.getByTestId("qm-share-copy"), `${width}`).toBeVisible();
    await expect(page.getByTestId("qm-share-qr"), `${width}: the QR stays closed`).toHaveCount(0);
    await expectTappable(native, `${width}: Share on WhatsApp`);
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole("button", { name: "Share on WhatsApp" }).click();
  // `ShareButton` hands the sheet `{ title, text, url }` (share-button.tsx); the text is quickMatch.home.shareNative (en).
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __qmShared?: ShareData[] }).__qmShared ?? []))
    .toEqual([{ title: name, text: `${name}: our quick match on Seazn. Open the link to score or follow the results.`, url: homeUrl }]);
});

test("home (Task 5): an unknown link is the dead screen at 320, 768 and 1280, and it offers a new quick match", async ({ guest: page }) => {
  await page.goto(`/q/qm_${TAG}NotAHomeTokenAtAll0000000000`);
  await atEachWidth(page, async (width) => {
    await expect(page.getByTestId("qm-dead-title"), `${width}`).toHaveText("This link has ended or doesn't exist");
    await expect(page.getByTestId("qm-dead-start"), `${width}`).toHaveAttribute("href", "/en/play");
    await expect(page.getByTestId("qm-home"), `${width}`).toHaveCount(0);
  });
});

// ── Edit result (branch-fix A review I1) ─────────────────────────────────────────────────────────────────────────────
// A French guest: the setup page at /fr/play, whose create sets the locale cookie (A-M8), so the home and the pad read
// French. One match is played on the pad and decided, and its row's "Edit result" ("Modifier le résultat", the longest of
// the four) is measured at 320 under the row's ⋯ (plan 4: the row's one menu), the 43-character side name in the row. The
// walkthrough (walkthrough/quick-match.spec.ts) taps the correction itself; this case is the row's width check.

type Dict = Record<string, string>;
const readDict = (rel: string): Dict => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")) as Dict;
const FR_UI = readDict("../src/dictionaries/fr/ui.json");
const FR_MK = readDict("../src/dictionaries/fr/marketing.json");
const fr = (dict: Dict, key: string, vars: Record<string, string | number> = {}) => {
  const text = dict[key];
  if (typeof text !== "string") throw new Error(`the fr dictionary has no "${key}"`);
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name]));
};

test("Edit result (review I1): a French home at 320 with a settled row: its ⋯ opens to 'Modifier le résultat', both 44px and tappable, no sideways scroll", async ({ guest: page }) => {
  // The rules, from the engine: badminton's "short" variant as a league plays it; the home side takes every game to nothing.
  const mod = builtinModules.find((m) => m.key === "badminton");
  expect(mod, "premise: the engine ships badminton").toBeDefined();
  const rules = mod!.configSchema.parse({ ...mod!.variants["short"], ...stageDefaultsFor(mod!, "league", "short") }) as {
    bestOf: number;
    setTo: number;
    finalSetTo: number;
  };
  const games = Math.ceil(rules.bestOf / 2);
  const taps = Array.from({ length: games }, (_, i) => (i === rules.bestOf - 1 ? rules.finalSetTo : rules.setTo)).reduce((n, t) => n + t, 0);
  // Derived, never flat (AGENTS.md #20): five page loads, every rally at the human floor, the deciding rally's hold.
  test.setTimeout(5 * 20_000 + taps * (HUMAN_FASTEST_REPEAT_MS + 900) + HOLD_MS + 20_000);

  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/fr/play");
  await expect(form(page)).toBeVisible();
  await expect(page.getByTestId("qm-start"), "the island is live (blank sides hold Start)").toBeDisabled();
  await form(page).getByText(fr(FR_UI, "sport.badminton"), { exact: true }).click();
  await form(page).getByLabel(fr(FR_MK, "quickMatch.setup.nameLabel"), { exact: true }).fill(`e2e modifier ${TAG}`);
  await form(page).getByLabel(fr(FR_MK, "quickMatch.setup.sideLabel", { n: 1 }), { exact: true }).fill(LONG);
  await form(page).getByLabel(fr(FR_MK, "quickMatch.setup.sideLabel", { n: 2 }), { exact: true }).fill("Priya & Tom");
  await form(page).locator('select[name="variant_key"]').selectOption("short");
  await page.getByTestId("qm-start").click();
  await expect(page).toHaveURL(/\/q\/qm_[^/?#]+$/);
  const home = new URL(page.url()).pathname;
  expect(home, "the home has no locale segment: its language is the cookie the create set").not.toMatch(/^\/fr\//);

  // ---- The match, played on the pad until it is decided ----
  await page.getByTestId("qm-hero").getByTestId("qm-score").click();
  await expect(page).toHaveURL(/\/score\/dl_/);
  await pressStart(page);
  const homeHalf = page.locator('[data-role="pad-v3"] button[data-role="v3-scorebug-half"][data-side="home"]');
  await expect(homeHalf).toBeVisible({ timeout: 20_000 });
  let last = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < taps; k++) {
    const wait = HUMAN_FASTEST_REPEAT_MS - (Date.now() - last);
    if (wait > 0) await page.waitForTimeout(wait);
    await homeHalf.click();
    last = Date.now();
  }
  await expect(page.getByText(fr(FR_UI, "device.quickMatch.resultSaved")), "the pad's decided line, in French").toBeVisible({
    timeout: HOLD_MS + 20_000,
  });
  await page.getByTestId("quick-match-back-link").click();
  await expect(page).toHaveURL(new RegExp(`${home}$`));

  // ---- The settled row at 320 ----
  // Plan 4 (owner 2026-11-13): "Edit result" lives in the row's ⋯ menu, so the ⋯ is the row's own target and the item it
  // opens is the one the guest presses; both are measured, the item with the menu open.
  const settled = page.locator('[data-testid="qm-match"][data-state="settled"]');
  await expect(settled, "the one match reads settled").toHaveCount(1, { timeout: 20_000 });
  const toggle = settled.getByTestId("qm-row-menu-toggle");
  await expectTappable(toggle, "320, fr: the settled row's ⋯");
  await toggle.click();
  const edit = settled.getByTestId("qm-edit-result");
  await expect(edit).toHaveText(fr(FR_UI, "quickMatch.home.editResult"));
  await expect(settled.getByTestId("qm-match-score"), "the score sits under its result").toBeVisible();
  await expectTappable(edit, "320, fr: Edit result, in the open ⋯ menu");
  await expectNoHorizontalScroll(page);
});

// ── Task 8: Add a match ─────────────────────────────────────────────────────────────────────────────────────────────
//
// "+ Add a match" is a native disclosure holding a plain form post (`POST /q/<token>/add-match`) answered with a 303 back to
// the home, the new match on it, or with a flash (app/q/[token]/add-match/route.ts). The route's DB test proves every answer
// and the island's unit test its wiring; this is what only a browser shows: the disclosure opening, the selects' real width
// with a 43-character side in them, the 44px targets at the three widths, and a refused post landing on its flash. (A
// knockout's missing control is page.test.tsx's and its "league only" refusal add-match-route.test.ts's: a guest cannot
// make a knockout since the owner's 2026-11-12 "take out".) The walkthrough (walkthrough/quick-match.spec.ts, step 7) adds
// one to a finished league and plays it.

test("Add a match (Task 8): a league of 4 at 320, 768 and 1280: closed on first paint, opens to two selects at the table's top two, 44px targets; Add lands the new match on the home", async ({ guest: page }) => {
  const sides = [LONG, "Priya & Tom", "Lee & Ana", "Jo & Max"];
  await createThroughSetup(page, sides);
  const home = new URL(page.url()).pathname;
  const open = page.getByTestId("qm-add-match-open");
  const addForm = page.getByTestId("qm-add-match-form");
  const selects = [addForm.locator('select[name="home"]'), addForm.locator('select[name="away"]')] as const;
  await atEachWidth(page, async (width) => {
    await expect(open, `${width}`).toHaveText("+ Add a match");
    await expect(addForm, `${width}: closed on first paint`).toBeHidden();
    await expectTappable(open, `${width}: + Add a match`);
    await open.click();
    await expect(addForm, `${width}`).toBeVisible();
    // Every side in each select, as typed; they open at the table's top two (a fresh table: its stored order).
    const top = await page.getByTestId("qm-standings-row").getByRole("rowheader").allTextContents();
    expect(top.map((t) => t.trim()).sort(), `${width}: the table lists every side`).toEqual([...sides].sort());
    for (const select of selects) await expect(select.locator("option"), `${width}`).toHaveText(sides);
    await expect(selects[0].locator("option:checked"), `${width}`).toHaveText(top[0]!.trim());
    await expect(selects[1].locator("option:checked"), `${width}`).toHaveText(top[1]!.trim());
    await expectTappable(selects[0], `${width}: the first select`);
    await expectTappable(selects[1], `${width}: the second select`);
    await expectTappable(addForm.getByTestId("qm-add-match-submit"), `${width}: Add the match`);
    // Open, with the 43-character side among both selects' options: atEachWidth measures the page straight after this.
  });
  // The add itself: two sides picked explicitly, posted, and the 303 followed to the bare home.
  await selects[0].selectOption({ label: "Jo & Max" });
  await selects[1].selectOption({ label: "Priya & Tom" });
  await addForm.getByTestId("qm-add-match-submit").click();
  await page.waitForURL((url) => url.pathname === home && url.search === "");
  await expect(page.getByTestId("qm-flash")).toHaveCount(0);
  // A round robin of 4 plays 6 (n(n-1)/2); the added match is the 7th, listed last, seated as picked.
  await expect(page.getByTestId("qm-match")).toHaveCount(7);
  await expect(page.getByTestId("qm-played")).toHaveText("0 of 7 matches played · deleted 7 days after the last score unless saved");
  await expect(page.getByTestId("qm-match").last().getByTestId("qm-match-sides")).toHaveText("Jo & Max v Priya & Tom");
  await expect(page.getByTestId("qm-hero"), "the hero is still the first match").toContainText("Up next · match 1 of 7");
  await expectNoHorizontalScroll(page);
});

test("Add a match (Task 8): the same side twice lands back on the home with 'Pick two different sides.', the form open at the picks, nothing added, at 320, 768 and 1280", async ({ guest: page }) => {
  await createThroughSetup(page, ["Ravi & Sam", "Priya & Tom", "Lee & Ana"]);
  const home = new URL(page.url()).pathname;
  await page.getByTestId("qm-add-match-open").click();
  const addForm = page.getByTestId("qm-add-match-form");
  await addForm.locator('select[name="home"]').selectOption({ label: "Lee & Ana" });
  await addForm.locator('select[name="away"]').selectOption({ label: "Lee & Ana" });
  const picked = await addForm.locator('select[name="home"]').inputValue();
  // The refusal is caught as the redirected GET: `?e=` and the guest's picks handed back (review m4) stay in the URL only
  // until the home's ClearFlashParam takes them out.
  const isRefusal = (raw: string) => {
    const url = new URL(raw);
    return url.pathname === home && url.searchParams.get("e") === "QUICK_MATCH_SAME_SIDE";
  };
  const landed = page.waitForRequest((r) => r.method() === "GET" && isRefusal(r.url()));
  await addForm.getByTestId("qm-add-match-submit").click();
  const refused = await landed;
  expect(refused.redirectedFrom()?.method(), "the post's 303 landed on the refusal").toBe("POST");
  const back = new URL(refused.url()).searchParams;
  expect([back.get("home"), back.get("away")], "the picks are handed back").toEqual([picked, picked]);
  await expect(page).toHaveURL(new RegExp(`${home}$`));
  await atEachWidth(
    page,
    async (width) => {
      const flash = page.getByTestId("qm-flash");
      await expect(flash, `${width}`).toHaveText("Pick two different sides.");
      await expect(flash, `${width}`).toHaveAttribute("role", "alert");
      await expect(flash, `${width}: in view at the top`).toBeInViewport();
      // Nothing added: a round robin of 3 still plays 3.
      await expect(page.getByTestId("qm-match"), `${width}`).toHaveCount(3);
      // The form came back open at the guest's own picks: the fix is one select away (review m4).
      await expect(page.getByTestId("qm-add-match"), `${width}`).toHaveAttribute("open", "");
      await expect(addForm.locator('select[name="home"] option:checked'), `${width}`).toHaveText("Lee & Ana");
      await expect(addForm.locator('select[name="away"] option:checked'), `${width}`).toHaveText("Lee & Ana");
    },
    { reload: false },
  );
});

// ── Plan 4: Not played and Put back ─────────────────────────────────────────────────────────────────────────────────
//
// Plan docs/superpowers/plans/2026-11-13-quick-match-4-skip-match.md Task 5; spec
// docs/superpowers/specs/2026-11-12-quick-match-cancel-and-skip-design.md §3, §6 (owner sign-off 2026-11-13: one ⋯ menu per
// row, a confirm sheet, "N of M played · K not played" with M the full total, Put back hidden once the league finishes, no
// play hides the table). The unit and DB tests prove the view model, the island and the two routes; this is what only a
// browser shows: the ⋯ and the sheet as real 44px targets at the three widths, the sheet asking first once the island runs,
// each post followed through its 303, the stale screens a second phone holds (a home's Score, the pad's Start, a pad left
// open across a skip and a put back), and the finished and nothing-played homes laid out by the browser.
//
// Every expected line is the en dictionary's own (filled by `en`/`enPlural`, plural() rules), or the spec's literal played
// line; the order is plan D8's. Sport: badminton only, as the rest of this file: Not played and Put back are one status write
// for every sport (T3's DB test sweeps every offered sport through both), and the home differs by sport only in its score
// line. One finished league plays badminton's "short" variant, whose rally count comes from the engine's own rules.

const EN = readDict("../src/dictionaries/en/ui.json");
const EN_RULES = new Intl.PluralRules("en");
/** An en line with its `{name}` slots filled; a missing key or slot throws rather than reading "undefined". */
function en(key: string, vars: Record<string, string | number> = {}): string {
  const text = EN[key];
  if (typeof text !== "string") throw new Error(`the en dictionary has no "${key}"`);
  return text.replace(/\{(\w+)\}/g, (_, slot: string) => {
    if (!Object.hasOwn(vars, slot)) throw new Error(`"${key}" needs {${slot}}`);
    return String(vars[slot]);
  });
}
/** `plural()`'s choice: the `.one`/`.other` line by English plural rules, `{count}` always filled. */
const enPlural = (key: string, count: number, vars: Record<string, string | number> = {}) =>
  en(`${key}.${EN_RULES.select(count)}`, { count, ...vars });

/** Plan D8: still to play first (live, ready, waiting), then Not played, then finished. */
const LIST_RANK: Readonly<Record<string, number>> = { live: 0, ready: 0, waiting: 0, notPlayed: 1, settled: 2 };
/** Badminton's live score reads as its levels in seat order: games, then the game's points ("0–0 · 1–0"; mobile.spec.ts's
 *  QM_AFTER_ONE_HOME_RALLY). `n` rallies to the home side and none to the away side, inside one game. */
const afterHomeRallies = (n: number) => new RegExp(`^\\s*0\\D+0\\D+${n}\\D+0\\s*$`);

const rowOf = (page: Page, fixtureId: string) => page.locator(`[data-testid="qm-match"][data-fixture-id="${fixtureId}"]`);
const nextRow = (page: Page) => page.locator('[data-testid="qm-match"][data-next="true"]');

/** The match the list marks next (the hero's): its id, and its row wherever the list order moves it. */
async function nextMatch(page: Page): Promise<{ id: string; row: Locator }> {
  await expect(nextRow(page), "one match is marked next").toHaveCount(1);
  const id = (await nextRow(page).getAttribute("data-fixture-id"))!;
  return { id, row: rowOf(page, id) };
}

/** The two sides a row names, as typed at setup, home first. */
async function sidesOf(row: Locator, typed: readonly string[]): Promise<[string, string]> {
  const text = ((await row.getByTestId("qm-match-sides").textContent()) ?? "").replace(/\s+/g, " ").trim();
  const pair = text.split(" v ");
  expect(pair.length === 2 && pair.every((s) => typed.includes(s)), `the row names two typed sides: "${text}"`).toBe(true);
  return [pair[0]!, pair[1]!];
}

/** The ⋯ menu island is hydrated: React has claimed its `<details>` (it carries React's props key). Before then "Not played"
 *  posts at once, the no-script path (plan D7), and never asks; a test that taps it then would skip without a sheet. */
async function expectMenuHydrated(row: Locator, what: string) {
  await expect
    .poll(() => row.getByTestId("qm-row-menu").evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$"))), {
      message: `${what}: the ⋯ menu never hydrated`,
      timeout: 20_000,
    })
    .toBe(true);
}

/** Open a row's ⋯: the ⋯ is a real 44px target, and its panel opens. */
async function openRowMenu(row: Locator, what: string): Promise<Locator> {
  const toggle = row.getByTestId("qm-row-menu-toggle");
  await expectTappable(toggle, `${what}: the ⋯`);
  await toggle.click();
  const panel = row.getByTestId("qm-row-menu-panel");
  await expect(panel, `${what}: the menu opens`).toBeVisible();
  return panel;
}

/** Press `control`, a form post, and wait for the GET its 303 landed on; returns where it landed. */
async function postAndLand(page: Page, control: Locator, path: "skip" | "put-back" | "score"): Promise<URL> {
  const landed = page.waitForRequest((r) => {
    const from = r.redirectedFrom();
    return r.method() === "GET" && from?.method() === "POST" && new URL(from.url()).pathname.includes(`/${path}/`);
  });
  await control.click();
  return new URL((await landed).url());
}

/** The list's rows in order, checked against plan D8; returns their states. */
async function expectListOrder(page: Page, what: string): Promise<string[]> {
  const states = await page.getByTestId("qm-match").evaluateAll((els) => els.map((e) => e.getAttribute("data-state") ?? ""));
  for (const s of states) expect(Object.hasOwn(LIST_RANK, s), `${what}: a row in a state plan D8 places ("${s}")`).toBe(true);
  const ranks = states.map((s) => LIST_RANK[s]!);
  expect(ranks, `${what}: still to play, then Not played, then finished (${states.join(", ")})`).toEqual([...ranks].sort((a, b) => a - b));
  return states;
}

/** The confirm sheet as plan D7 places it: a modal (the page behind inert), all of it on screen; below `md` (768) a bottom
 *  sheet from edge to edge, from `md` a dialog centred on the screen. */
async function expectSheetPlaced(sheet: Locator, width: number) {
  const box = await sheet.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      vw: document.documentElement.clientWidth,
      vh: window.innerHeight,
      modal: el.matches(":modal"),
    };
  });
  expect(box.modal, `${width}: the sheet is modal`).toBe(true);
  expect(box.top >= -0.5 && box.left >= -0.5 && box.right <= box.vw + 0.5 && box.bottom <= box.vh + 0.5, `${width}: the whole sheet on screen ${JSON.stringify(box)}`).toBe(true);
  if (width < 768) {
    expect([box.left, box.vw - box.right, box.vh - box.bottom].map((d) => Math.round(Math.abs(d))), `${width}: a bottom sheet, edge to edge`).toEqual([0, 0, 0]);
  } else {
    expect(Math.abs(box.left - (box.vw - box.right)), `${width}: centred across`).toBeLessThanOrEqual(1);
    expect(Math.abs(box.top - (box.vh - box.bottom)), `${width}: centred down`).toBeLessThanOrEqual(1);
  }
}

/** Each match's status and its sport events in the record. */
async function recordOf(ids: readonly string[]): Promise<Map<string, { status: string; events: number }>> {
  const rows = await withDb(
    (sql) => sql<{ id: string; status: string; events: number }[]>`
      select f.id::text as id, f.status,
             (select count(*)::int from score_events e where e.fixture_id = f.id and e.type <> 'core.start') as events
      from fixtures f where f.id in ${sql(ids as string[])}`,
  );
  expect(rows.length, "every match is in the record").toBe(ids.length);
  return new Map(rows.map((r) => [r.id, { status: r.status, events: r.events }]));
}
const rallies = async (fixtureId: string) =>
  (await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId} and type = 'badminton.rally'`))[0]!.n;

/** Skip a row's match through its ⋯ and the sheet, which must say `body`; lands on the bare home. */
async function skipThroughSheet(page: Page, row: Locator, body: string, what: string) {
  await expectMenuHydrated(row, what);
  await openRowMenu(row, what);
  await row.getByTestId("qm-skip").click();
  await expect(row.getByTestId("qm-skip-sheet"), `${what}: the sheet asks first`).toBeVisible();
  await expect(row.getByTestId("qm-skip-body"), `${what}: the sheet's words`).toHaveText(body);
  const landed = await postAndLand(page, row.getByTestId("qm-skip-confirm"), "skip");
  expect(landed.search, `${what}: the skip lands on the bare home`).toBe("");
  await expect(row, `${what}: the row reads Not played`).toHaveAttribute("data-state", "notPlayed");
}

test("Not played (skip): a league of 4 at 320, 768 and 1280: ⋯ opens, the sheet asks, Keep closes with nothing changed, Mark not played lands the row as Not played with Put back; the played line counts them; 44px targets; no sideways scroll", async ({ guest: page }) => {
  const sides = [LONG, "Priya & Tom", "Lee & Ana", "Jo & Max"];
  await createThroughSetup(page, sides);
  const home = new URL(page.url()).pathname;
  // A round robin of 4 plays 6 (n(n-1)/2): one skip per width leaves three still to play, so every sheet here says `body`.
  const total = 6;
  const line = (k: number) =>
    k === 0
      ? `0 of ${total} matches played · deleted 7 days after the last score unless saved`
      : `0 of ${total} matches played · ${k} not played · deleted 7 days after the last score unless saved`;
  const skipped: string[] = [];
  await atEachWidth(page, async (width) => {
    const { id, row } = await nextMatch(page);
    await expect(row, `${width}`).toHaveAttribute("data-state", "ready");
    const [h, a] = await sidesOf(row, sides);
    await expectMenuHydrated(row, `${width}`);
    const toggle = row.getByTestId("qm-row-menu-toggle");
    await expect(toggle, `${width}: the ⋯ names its match`).toHaveAccessibleName(en("quickMatch.home.moreActions", { home: h, away: a }));
    if (width === 1280) {
      // Keyboard (one width: the keys are the same at every width): Enter opens, Tab walks the items, and a Tab past the last
      // closes the menu (T4 fix m3, WCAG 2.2 SC 2.4.11: an open panel would cover the next row's controls).
      await toggle.focus();
      await page.keyboard.press("Enter");
      await expect(row.getByTestId("qm-row-menu-panel"), "Enter opens the menu").toBeVisible();
      await page.keyboard.press("Tab");
      await expect(row.getByTestId("qm-menu-score")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(row.getByTestId("qm-skip")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(row.getByTestId("qm-row-menu-panel"), "a Tab past the last item closes the menu").toBeHidden();
    }

    // The menu of a match still to play: Score, then Not played with its hint; nothing else.
    const panel = await openRowMenu(row, `${width}`);
    await expect(panel.getByRole("button"), `${width}: two items`).toHaveCount(2);
    await expect(panel.getByRole("button").first(), `${width}: Score first`).toHaveAttribute("data-testid", "qm-menu-score");
    await expect(row.getByTestId("qm-menu-score")).toHaveText(en("quickMatch.home.scoreShort"));
    const skip = row.getByTestId("qm-skip");
    await expect(skip).toContainText(en("quickMatch.home.notPlayed"));
    await expect(skip).toContainText(en("quickMatch.home.notPlayedHint"));
    await expectTappable(row.getByTestId("qm-menu-score"), `${width}: the menu's Score`);
    await expectTappable(skip, `${width}: Not played`);
    await expectNoHorizontalScroll(page);

    // The sheet asks: its title names the match, nothing is scored, more than one match is left, and Keep has the focus.
    await skip.click();
    const sheet = row.getByTestId("qm-skip-sheet");
    await expect(sheet, `${width}: the sheet opens`).toBeVisible();
    await expect(panel, `${width}: the menu closes behind it`).toBeHidden();
    await expect(row.getByTestId("qm-skip-title")).toHaveText(en("quickMatch.skip.title", { home: h, away: a }));
    await expect(row.getByTestId("qm-skip-body")).toHaveText(en("quickMatch.skip.body"));
    await expect(row.getByTestId("qm-skip-partial"), `${width}: nothing scored, no partial line`).toHaveCount(0);
    const keep = row.getByTestId("qm-skip-keep");
    const confirm = row.getByTestId("qm-skip-confirm");
    await expect(keep, `${width}: the safe answer has the focus`).toBeFocused();
    await expect(keep).toHaveText(en("quickMatch.skip.keep"));
    await expect(confirm).toHaveText(en("quickMatch.skip.confirm"));
    await expectTappable(confirm, `${width}: Mark not played`);
    await expectTappable(keep, `${width}: Keep this match`);
    await expectSheetPlaced(sheet, width);
    await expectNoHorizontalScroll(page);

    // Keep: the sheet closes, focus goes back to the ⋯, and nothing changed (the post never left).
    await keep.click();
    await expect(sheet, `${width}: Keep closes it`).toBeHidden();
    await expect(toggle, `${width}: focus back on the ⋯`).toBeFocused();
    await expect(row).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("qm-played")).toHaveText(line(skipped.length));
    expect((await recordOf([id])).get(id)?.status, `${width}: Keep wrote nothing`).toBe("scheduled");

    // Mark not played: the 303 lands on the bare home, the row Not played (no Score), its ⋯ holding only Put back.
    await openRowMenu(row, `${width}, again`);
    await skip.click();
    await expect(sheet).toBeVisible();
    const landed = await postAndLand(page, confirm, "skip");
    expect([landed.pathname, landed.search], `${width}: the bare home`).toEqual([home, ""]);
    skipped.push(id);
    await expect(row, `${width}`).toHaveAttribute("data-state", "notPlayed");
    await expect(row.getByTestId("qm-not-played")).toHaveText(en("quickMatch.home.notPlayed"));
    await expect(row.getByTestId("qm-score"), `${width}: a Not played match has no Score`).toHaveCount(0);
    await expect(page.getByTestId("qm-flash"), `${width}: no refusal`).toHaveCount(0);
    await expect(page.getByTestId("qm-played"), `${width}: M stays the full total`).toHaveText(line(skipped.length));
    await expect(page.getByTestId("qm-standings-note")).toHaveText(en("quickMatch.home.countsPlayedOnly"));
    await expect(page.getByTestId("qm-hero"), `${width}: matches are left, so the hero stays`).toBeVisible();
    const after = await openRowMenu(row, `${width}, Not played`);
    await expect(after.getByRole("button"), `${width}: Put back only`).toHaveCount(1);
    await expect(row.getByTestId("qm-put-back")).toHaveText(en("quickMatch.home.putBack"));
    await expectTappable(row.getByTestId("qm-put-back"), `${width}: Put back`);
    const states = await expectListOrder(page, `${width}`);
    expect(states.filter((s) => s === "notPlayed").length, `${width}: the Not played rows are listed`).toBe(skipped.length);
  });
  // The record: each skipped match is Not played (`cancelled`, spec §5 call 4), nothing was written to its ledger, and the
  // three still to play are untouched.
  const all = await page.getByTestId("qm-match").evaluateAll((els) => els.map((e) => e.getAttribute("data-fixture-id")!));
  expect(all.length).toBe(total);
  const record = await recordOf(all);
  for (const id of all) {
    expect(record.get(id), `match ${id}`).toEqual({ status: skipped.includes(id) ? "cancelled" : "scheduled", events: 0 });
  }
  expect(skipped.length, "one skip per width").toBe(WIDTHS.length);
});

test("Put back: the row returns with its Score and the hero, and that Score lands in the pad on that match, which then scores", async ({ guest: page }) => {
  test.setTimeout(8 * 20_000 + HOLD_MS);
  const sides = ["Ravi & Sam", "Priya & Tom", "Lee & Ana"];
  await createThroughSetup(page, sides);
  const home = new URL(page.url()).pathname;
  const { id, row } = await nextMatch(page);
  const [h, a] = await sidesOf(row, sides);
  // A round robin of 3 plays 3; skipping one leaves two, so the sheet says `body`.
  await skipThroughSheet(page, row, en("quickMatch.skip.body"), "skip");
  await expect(page.getByTestId("qm-played")).toHaveText("0 of 3 matches played · 1 not played · deleted 7 days after the last score unless saved");
  await expect(nextRow(page), "the hero moved on to another match").not.toHaveAttribute("data-fixture-id", id);

  await openRowMenu(row, "Not played");
  const landed = await postAndLand(page, row.getByTestId("qm-put-back"), "put-back");
  expect([landed.pathname, landed.search], "Put back lands on the bare home").toEqual([home, ""]);
  await expect(row, "back to play, as it was: nothing scored").toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("qm-played")).toHaveText("0 of 3 matches played · deleted 7 days after the last score unless saved");
  await expect(page.getByTestId("qm-standings-note"), "no Not played match, no note").toHaveCount(0);
  await expect(nextRow(page), "the hero is this match again, first in play order").toHaveAttribute("data-fixture-id", id);
  expect((await recordOf([id])).get(id), "the record: unplayed again").toEqual({ status: "scheduled", events: 0 });
  await expectListOrder(page, "after Put back");

  // The row's own Score lands in the pad on THIS match: its Confirm card names its two sides, and a rally there is this
  // match's.
  const score = row.getByTestId("qm-score");
  await expectTappable(score, "the row's Score, back");
  await score.click();
  await expect(page).toHaveURL(/\/score\/dl_[A-Za-z0-9_-]{43}$/);
  const confirmCard = page.getByTestId("scan-confirm");
  await expect(confirmCard).toBeVisible({ timeout: 20_000 });
  await expect(confirmCard).toContainText(h);
  await expect(confirmCard).toContainText(a);
  await pressStart(page);
  const homeHalf = page.locator('[data-role="pad-v3"] button[data-role="v3-scorebug-half"][data-side="home"]');
  await expect(homeHalf).toBeVisible({ timeout: 20_000 });
  await homeHalf.click();
  await expect.poll(() => rallies(id), { timeout: HOLD_MS + 20_000, message: "the rally never reached this match's ledger" }).toBe(1);
  expect((await recordOf([id])).get(id)?.status, "scored again after Put back").toBe("in_play");
});

/** Badminton's "short" variant as a league plays it, from the engine: the rallies the home side needs to take every game to
 *  nothing (the Edit result case's derivation). */
function shortBadmintonTaps(): number {
  const mod = builtinModules.find((m) => m.key === "badminton");
  expect(mod, "premise: the engine ships badminton").toBeDefined();
  const rules = mod!.configSchema.parse({ ...mod!.variants["short"], ...stageDefaultsFor(mod!, "league", "short") }) as {
    bestOf: number;
    setTo: number;
    finalSetTo: number;
  };
  const games = Math.ceil(rules.bestOf / 2);
  return Array.from({ length: games }, (_, i) => (i === rules.bestOf - 1 ? rules.finalSetTo : rules.setTo)).reduce((n, t) => n + t, 0);
}

test("Finished by skips: one match of a league of 3 played on the pad, the other two skipped (the second sheet warns it is the last) → the winner, the Final table, no Put back; a stale Put back lands on 'The league has finished'", async ({ guest: page }) => {
  const taps = shortBadmintonTaps();
  // Derived, never flat (AGENTS.md #20): ten page loads, every rally at the human floor, the deciding rally's hold.
  test.setTimeout(10 * 20_000 + taps * (HUMAN_FASTEST_REPEAT_MS + 900) + HOLD_MS + 20_000);
  const sides = ["Ravi & Sam", "Priya & Tom", "Lee & Ana"];
  await createThroughSetup(page, sides, "short");
  const home = new URL(page.url()).pathname;

  // ---- Match 1 (the hero's), played on the pad: the home side takes every rally, so it tops the table ----
  const played = await nextMatch(page);
  const [winner] = await sidesOf(played.row, sides);
  await page.getByTestId("qm-hero").getByTestId("qm-score").click();
  await expect(page).toHaveURL(/\/score\/dl_/);
  await pressStart(page);
  const homeHalf = page.locator('[data-role="pad-v3"] button[data-role="v3-scorebug-half"][data-side="home"]');
  await expect(homeHalf).toBeVisible({ timeout: 20_000 });
  let last = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < taps; k++) {
    const wait = HUMAN_FASTEST_REPEAT_MS - (Date.now() - last);
    if (wait > 0) await page.waitForTimeout(wait);
    await homeHalf.click();
    last = Date.now();
  }
  await expect(page.getByText(en("device.quickMatch.resultSaved")), "the pad's decided line").toBeVisible({ timeout: HOLD_MS + 20_000 });
  await page.getByTestId("quick-match-back-link").click();
  await expect(page).toHaveURL(new RegExp(`${home}$`));
  await expect(played.row).toHaveAttribute("data-state", "settled", { timeout: 20_000 });
  await expect(page.getByTestId("qm-played")).toHaveText("1 of 3 matches played · deleted 7 days after the last score unless saved");

  // ---- The first skip: two left, so the sheet says `body` ----
  const second = await nextMatch(page);
  await skipThroughSheet(page, second.row, en("quickMatch.skip.body"), "the first skip");
  await expect(page.getByTestId("qm-played")).toHaveText("1 of 3 matches played · 1 not played · deleted 7 days after the last score unless saved");

  // A second phone holds the home as it is now: the Not played match still offers Put back there.
  const stale = await page.context().newPage();
  await stale.goto(home);
  const staleRow = rowOf(stale, second.id);
  await expect(staleRow).toHaveAttribute("data-state", "notPlayed");
  await openRowMenu(staleRow, "the stale home");
  await expect(staleRow.getByTestId("qm-put-back"), "the stale home still offers Put back").toBeVisible();

  // ---- The last skip: the sheet warns that the league finishes now and the skip can't be put back (plan D6) ----
  const third = await nextMatch(page);
  await skipThroughSheet(page, third.row, en("quickMatch.skip.bodyLast"), "the last skip");

  // ---- Finished: no hero, the winner (the side the pad made win) with the note, the Final table and its note ----
  await expect(page.getByTestId("qm-hero"), "a finished league has no next match").toHaveCount(0);
  await expect(page.getByTestId("qm-winner")).toBeVisible();
  await expect(page.getByTestId("qm-winner-name"), "the side that took every rally").toHaveText(winner);
  await expect(page.getByTestId("qm-winner-note")).toHaveText(
    `${enPlural("quickMatch.home.winnerAfter", 1)} ${enPlural("quickMatch.home.winnerSkipped", 2)}`,
  );
  await expect(page.getByTestId("qm-standings-title")).toHaveText(en("quickMatch.home.finalTable"));
  await expect(page.getByTestId("qm-standings-note")).toHaveText(en("quickMatch.home.countsPlayedOnly"));
  // Finished: the line keeps M as the full total and drops the countdown (T4 review m1).
  await expect(page.getByTestId("qm-played")).toHaveText("1 of 3 matches played · 2 not played");
  for (const m of [second, third]) {
    await expect(m.row).toHaveAttribute("data-state", "notPlayed");
    await expect(m.row.getByTestId("qm-row-menu"), "finished: no Put back, so no ⋯ on a Not played row").toHaveCount(0);
  }
  await expect(page.getByTestId("qm-put-back"), "no Put back anywhere").toHaveCount(0);
  await expectListOrder(page, "finished");
  const record = await recordOf([played.id, second.id, third.id]);
  expect([second.id, third.id].map((i) => record.get(i)), "both skips are Not played, nothing written").toEqual([
    { status: "cancelled", events: 0 },
    { status: "cancelled", events: 0 },
  ]);
  expect(record.get(played.id)?.status, "the played match keeps its result").not.toBe("cancelled");
  await atEachWidth(page, async (width) => {
    await expect(page.getByTestId("qm-winner-name"), `${width}`).toHaveText(winner);
    await expect(page.getByTestId("qm-put-back"), `${width}`).toHaveCount(0);
  });

  // ---- The stale Put back: refused, it lands on its flash, and the league stays finished ----
  const isRefusal = (raw: string) => {
    const url = new URL(raw);
    return url.pathname === home && url.searchParams.get("e") === "QUICK_MATCH_LEAGUE_FINISHED";
  };
  const refused = stale.waitForRequest((r) => r.method() === "GET" && isRefusal(r.url()));
  await staleRow.getByTestId("qm-put-back").click();
  expect((await refused).redirectedFrom()?.method(), "the post's 303 landed on the refusal").toBe("POST");
  const flash = stale.getByTestId("qm-flash");
  await expect(flash).toHaveText(en("quickMatch.flash.leagueFinished"));
  await expect(flash).toHaveAttribute("role", "alert");
  await expect(stale.getByTestId("qm-winner-name"), "still finished").toHaveText(winner);
  await expect(staleRow).toHaveAttribute("data-state", "notPlayed");
  expect((await recordOf([second.id])).get(second.id)?.status, "the refused Put back wrote nothing").toBe("cancelled");
  await stale.close();
});

test("No play: a league of 2, its only match skipped (the sheet warns it is the last) → 'No matches were played', no table; Start a new quick match goes to /en/play; at 320, 768 and 1280", async ({ guest: page }) => {
  const sides = ["Ravi & Sam", "Priya & Tom"];
  await createThroughSetup(page, sides);
  const { id, row } = await nextMatch(page);
  await skipThroughSheet(page, row, en("quickMatch.skip.bodyLast"), "the only match");
  await atEachWidth(page, async (width) => {
    const card = page.getByTestId("qm-no-play");
    await expect(card, `${width}`).toBeVisible();
    await expect(page.getByTestId("qm-no-play-kicker")).toHaveText(en("quickMatch.home.leagueFinished"));
    await expect(page.getByTestId("qm-no-play-title")).toHaveText(en("quickMatch.home.noPlay"));
    await expect(page.getByTestId("qm-no-play-hint")).toHaveText(enPlural("quickMatch.home.noPlayHint", 1));
    for (const gone of ["qm-standings", "qm-winner", "qm-hero", "qm-put-back"]) {
      await expect(page.getByTestId(gone), `${width}: no ${gone} with nothing played`).toHaveCount(0);
    }
    await expect(page.getByTestId("qm-played")).toHaveText("0 of 1 match played · 1 not played");
    await expect(row, `${width}`).toHaveAttribute("data-state", "notPlayed");
    await expect(row.getByTestId("qm-row-menu"), `${width}: finished, no ⋯`).toHaveCount(0);
    const start = page.getByTestId("qm-no-play-start");
    await expect(start).toHaveText(en("quickMatch.dead.startNew"));
    await expect(start).toHaveAttribute("href", "/en/play");
    await expectTappable(start, `${width}: Start a new quick match`);
  });
  expect((await recordOf([id])).get(id)).toEqual({ status: "cancelled", events: 0 });
  await page.getByTestId("qm-no-play-start").click();
  await expect(page).toHaveURL(/\/en\/play$/);
  await expect(form(page)).toBeVisible();
});

/** A second guest's own browser: the same link, another phone. */
async function anotherPhone(browser: Browser) {
  return browser.newContext({ storageState: await consentedAnonymousState() });
}

test("Stale screens: a match skipped on another phone: the pad held on Confirm says Not played on Start and writes nothing; a home loaded before the skip lands Score on the Not played line", async ({ guest: page, browser }) => {
  test.setTimeout(8 * 20_000);
  const sides = ["Ravi & Sam", "Priya & Tom", "Lee & Ana"];
  await createThroughSetup(page, sides);
  const home = new URL(page.url()).pathname;
  const { id, row } = await nextMatch(page);
  // This phone: the home stays on screen (stale from here on), and the pad is opened on the same match, held on Confirm.
  const pad = await page.context().newPage();
  await pad.goto(home);
  await nextRow(pad).getByTestId("qm-score").click();
  await expect(pad).toHaveURL(/\/score\/dl_/);
  await expect(pad.getByTestId("scan-confirm")).toBeVisible({ timeout: 20_000 });

  // Another phone marks it Not played.
  const other = await anotherPhone(browser);
  try {
    const theirs = await other.newPage();
    await theirs.goto(home);
    await skipThroughSheet(theirs, rowOf(theirs, id), en("quickMatch.skip.body"), "the other phone");
  } finally {
    await other.close();
  }

  // Start on the held pad: refused, the pad says the match was marked Not played (View-only, no controls), and no refusal
  // line beside it (T3: the re-read speaks, not "already has a result").
  await pressStart(pad);
  await expect(pad.getByTestId("scan-view-only")).toHaveText(en("device.quickMatch.notPlayed"), { timeout: 20_000 });
  await expect(pad.getByTestId("score-start-match"), "no Start left").toHaveCount(0);
  await expect(pad.getByText(en("engineError.ALREADY_DECIDED")), "no refusal line").toHaveCount(0);
  await expect(pad.getByText(en("device.failed")), "no failure line").toHaveCount(0);
  const [started] = await withDb((sql) => sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${id}`);
  expect(started!.n, "the refused Start wrote nothing").toBe(0);
  expect((await recordOf([id])).get(id)?.status).toBe("cancelled");
  await pad.close();

  // The stale home still shows the match ready, with Score: its post lands on the Not played line, the row now Not played.
  await expect(row, "the stale home, as loaded").toHaveAttribute("data-state", "ready");
  const isRefusal = (raw: string) => {
    const url = new URL(raw);
    return url.pathname === home && url.searchParams.get("e") === "QUICK_MATCH_NOT_PLAYED";
  };
  const refused = page.waitForRequest((r) => r.method() === "GET" && isRefusal(r.url()));
  await row.getByTestId("qm-score").click();
  expect((await refused).redirectedFrom()?.method(), "the Score post's 303 landed on the refusal").toBe("POST");
  await expect(page.getByTestId("qm-flash")).toHaveText(en("quickMatch.flash.notPlayed"));
  await expect(page.getByTestId("qm-flash")).toHaveAttribute("role", "alert");
  await expect(row, "the home, read again").toHaveAttribute("data-state", "notPlayed");
});

test("Pad left open: a rally on the pad, the match skipped on another phone (the sheet names the score that won't count): the next tap writes nothing and the pad says Not played; Put back restores it as it was, and the pad, looked at again, scores on", async ({ guest: page, browser }) => {
  // Six page loads, two held rallies and the refused one's hold.
  test.setTimeout(6 * 20_000 + 3 * (HOLD_MS + 20_000));
  const sides = ["Ravi & Sam", "Priya & Tom", "Lee & Ana"];
  await createThroughSetup(page, sides);
  const home = new URL(page.url()).pathname;
  const { id } = await nextMatch(page);

  // This phone: the pad, Start, one rally to the home side, in the record.
  await page.getByTestId("qm-hero").getByTestId("qm-score").click();
  await expect(page).toHaveURL(/\/score\/dl_/);
  await pressStart(page);
  const homeHalf = page.locator('[data-role="pad-v3"] button[data-role="v3-scorebug-half"][data-side="home"]');
  await expect(homeHalf).toBeVisible({ timeout: 20_000 });
  await homeHalf.click();
  await expect.poll(() => rallies(id), { timeout: HOLD_MS + 20_000, message: "the first rally never reached the ledger" }).toBe(1);

  const other = await anotherPhone(browser);
  try {
    const theirs = await other.newPage();
    await theirs.goto(home);
    const row = rowOf(theirs, id);
    await expect(row).toHaveAttribute("data-state", "live");
    const scoreText = ((await row.getByTestId("qm-match-score").textContent()) ?? "").trim();
    expect(scoreText, "the live row reads the one rally").toMatch(afterHomeRallies(1));
    // The sheet says what is lost: the score so far will not count (it stays in the history).
    await expectMenuHydrated(row, "the other phone");
    await openRowMenu(row, "the other phone");
    await row.getByTestId("qm-skip").click();
    await expect(row.getByTestId("qm-skip-partial")).toHaveText(en("quickMatch.skip.partial", { score: scoreText }));
    await expect(row.getByTestId("qm-skip-body")).toHaveText(en("quickMatch.skip.body"));
    await postAndLand(theirs, row.getByTestId("qm-skip-confirm"), "skip");
    await expect(row).toHaveAttribute("data-state", "notPlayed");

    // The pad was left open on the live match. Its next tap is refused (Review Focus 1): nothing is written, and the pad
    // says the match was marked Not played, with no refusal line.
    await homeHalf.click();
    await expect(page.getByTestId("scan-view-only")).toHaveText(en("device.quickMatch.notPlayed"), { timeout: HOLD_MS + 20_000 });
    await expect(page.getByText(en("engineError.ALREADY_DECIDED")), "no refusal line").toHaveCount(0);
    await expect(homeHalf, "View-only: no controls").toHaveCount(0);
    expect(await rallies(id), "the tap after the skip wrote nothing").toBe(1);
    expect((await recordOf([id])).get(id)?.status).toBe("cancelled");

    // Put back from the other phone: the match is live again at its score (plan Q1, PO rec: restored as it was).
    await openRowMenu(row, "the other phone, Not played");
    await postAndLand(theirs, row.getByTestId("qm-put-back"), "put-back");
    await expect(row, "live again").toHaveAttribute("data-state", "live");
    await expect(row.getByTestId("qm-match-score"), "at the score it had").toHaveText(scoreText);
    expect((await recordOf([id])).get(id)?.status).toBe("in_play");

    // The scorer looks at the pad again (a tab return, as a phone coming back from the home does): it reads the match
    // again, View-only lifts, and the next rally is recorded on top of the first.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.getByTestId("scan-view-only"), "live again on the pad").toHaveCount(0, { timeout: 20_000 });
    await expect(homeHalf).toBeVisible();
    await homeHalf.click();
    await expect.poll(() => rallies(id), { timeout: HOLD_MS + 20_000, message: "the rally after Put back never reached the ledger" }).toBe(2);
    await expect(page.getByText(en("device.seqConflict")), "no stale-seq refusal").toHaveCount(0);
    await theirs.reload();
    await expect(row.getByTestId("qm-match-score"), "the home reads both rallies").toHaveText(afterHomeRallies(2));
  } finally {
    await other.close();
  }
});
