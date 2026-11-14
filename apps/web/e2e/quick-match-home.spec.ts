import { test as base, expect, type Browser, type Locator, type Page, type Route } from "@playwright/test";
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
import { NOT_PLAYED_RECHECK_MS } from "../src/lib/scan-screen";
import { QUICK_MATCH_EXPIRY_DAYS } from "../src/lib/quick-match-constants";

// Quick match plan 2 Task 5 (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 3, §8): the guest's home
// at `/q/<token>` in a real browser, at the three widths the task is verified at (320, 768, 1280), for a league and the dead
// link. Task 10 owns the flow (`quick-match.spec.ts`: setup → home → Score → back) and the seven-width case
// (`mobile.spec.ts`); this file is the home's own width check, which no unit test can see: the page's real width with a
// 43-character side name, the hero, the table and the list laid out by the browser.
//
// A guest's quick match is a League, or a League + Knockout (plan 5, docs/superpowers/plans/2026-11-13-quick-match-5-league-
// knockout.md Task 8): the knockout fills itself from the league's table, asks the guests when a tie straddles the cut, and
// names its champion. Those cases are the "Plan 5" block at the end of this file; a plain Knockout is still not offered.
//
// Every quick match here is made the way a guest makes one: the setup page's form, posted by its Start button, followed to
// the home (the real producer, never a seed). Measured with `expectNoHorizontalScroll` (helpers.ts), which lifts the
// `overflow-x: clip` backstop before it reads.
//
// Sport: badminton, clicked explicitly (A11), as quick-match.spec.ts does; the home has no sport-specific layout beyond its
// score line, which the page test (app/q/[token]/__tests__/page.test.tsx) covers for badminton and football. The plan 5 block
// plays chess (one tap on the pad decides a game, owner R7-2), the one sport where a whole league and its knockout can be
// played by taps inside a test's budget; the fill, the cut and the champion are one code path for every sport (T4's DB tests
// sweep the offered sports).

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
  await pressHydrated(pad.getByTestId("score-start-match"), "the pad's Start");
}

/** Press a plain island button (no form) once React has claimed it: before that a press is lost. Pressed once. */
async function pressHydrated(control: Locator, what: string) {
  await expect
    .poll(() => control.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$"))), {
      message: `${what} never hydrated`,
      timeout: 20_000,
    })
    .toBe(true);
  await control.click();
}

/** FR3: a mark on the page's own window, so "no reload" is read, not assumed: a reload starts a window without it. */
const markPage = (page: Page) => page.evaluate(() => void ((window as unknown as { fr3Mark?: number }).fr3Mark = 1));
const samePage = (page: Page) => page.evaluate(() => (window as unknown as { fr3Mark?: number }).fr3Mark === 1);
/** The pad's own read of the match (`/state`), as a request to wait on. */
const stateRead = (page: Page, fixtureId: string) =>
  page.waitForRequest((r) => r.method() === "GET" && new URL(r.url()).pathname.endsWith(`/fixtures/${fixtureId}/state`));

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

test("Stale screens: a match skipped on another phone: the pad held on Confirm says Not played on Start and writes nothing; a home loaded before the skip lands Score on the Not played line; the pad opened again on it says Not played, and once put back, Check again brings Confirm back with no reload", async ({ guest: page, browser }) => {
  test.setTimeout(12 * 20_000);
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

  // FR3: the pad opened again on the Not played match — View-only from the page's first paint. Its pill says Not played
  // (T5 finding 2, never "cancelled"), and Check again is a real target.
  await pad.reload();
  await expect(pad.getByTestId("scan-view-only")).toHaveText(en("device.quickMatch.notPlayed"));
  await expect(pad.getByTestId("scan-status"), "the pill, in the home's word").toHaveText(en("quickMatch.home.notPlayed"));
  const checkAgain = pad.getByTestId("scan-check-again");
  await expect(checkAgain).toHaveText(en("device.quickMatch.checkAgain"));
  await expectTappable(checkAgain, "Check again");
  await markPage(pad);
  // Put back on the home. It was never played, so it is ready again; on the pad, Check again reads it, and Confirm comes
  // back with Start, on the same page (T5 finding 1: no reload).
  await expectMenuHydrated(row, "the home, Not played");
  await openRowMenu(row, "the home, Not played");
  await postAndLand(page, row.getByTestId("qm-put-back"), "put-back");
  await expect(row, "put back: ready again").toHaveAttribute("data-state", "ready");
  const read = stateRead(pad, id);
  await pressHydrated(checkAgain, "Check again");
  await read;
  await expect(pad.getByTestId("scan-view-only"), "Check again lifts View-only").toHaveCount(0, { timeout: 20_000 });
  await expect(pad.getByTestId("score-start-match"), "Confirm, with Start").toBeVisible();
  await expect(checkAgain, "Check again goes with the Not played screen").toHaveCount(0);
  expect(await samePage(pad), "the same page: no reload").toBe(true);
  await pad.close();
});

test("Pad left open: a rally on the pad, the match skipped on another phone (the sheet names the score that won't count): the next tap writes nothing and the pad says Not played; Put back restores it as it was, and the pad, left open with no tap or reload, comes back by itself at the stored score and scores on", async ({ guest: page, browser }) => {
  // Six page loads, two held rallies and the refused one's hold, and the Not played screen's own clock (FR3).
  test.setTimeout(6 * 20_000 + 3 * (HOLD_MS + 20_000) + (NOT_PLAYED_RECHECK_MS + 20_000));
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
  const halfAtStart = ((await homeHalf.textContent()) ?? "").trim();
  await homeHalf.click();
  await expect.poll(() => rallies(id), { timeout: HOLD_MS + 20_000, message: "the first rally never reached the ledger" }).toBe(1);
  // What the pad shows for the home side once that rally is in: the score Put back must bring back (FR3).
  await expect(homeHalf, "the pad shows the rally").not.toHaveText(halfAtStart);
  const halfAfterRally = ((await homeHalf.textContent()) ?? "").trim();

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
    // FR3 (T5 finding 2): the pill over that line says Not played, never "cancelled".
    await expect(page.getByTestId("scan-status"), "the pill, in the home's word").toHaveText(en("quickMatch.home.notPlayed"));
    // FR3 (T5 finding 1): Check again, a real target; while the match is still Not played a tap reads it and nothing moves.
    const checkAgain = page.getByTestId("scan-check-again");
    await expect(checkAgain).toHaveText(en("device.quickMatch.checkAgain"));
    await expectTappable(checkAgain, "Check again");
    const read = stateRead(page, id);
    await pressHydrated(checkAgain, "Check again");
    await read;
    await expect(page.getByTestId("scan-view-only"), "still Not played: still View-only").toHaveText(en("device.quickMatch.notPlayed"));
    await markPage(page);

    // Put back from the other phone: the match is live again at its score (plan Q1, PO rec: restored as it was).
    await openRowMenu(row, "the other phone, Not played");
    await postAndLand(theirs, row.getByTestId("qm-put-back"), "put-back");
    await expect(row, "live again").toHaveAttribute("data-state", "live");
    await expect(row.getByTestId("qm-match-score"), "at the score it had").toHaveText(scoreText);
    expect((await recordOf([id])).get(id)?.status).toBe("in_play");

    // FR3: the pad is left exactly as it is — no tap, no tab return, no reload. Its Not played screen reads the match on
    // its own clock (NOT_PLAYED_RECHECK_MS), sees it put back, and View-only lifts onto the pad.
    await expect(page.getByTestId("scan-view-only"), "live again on the pad, by itself").toHaveCount(0, {
      timeout: NOT_PLAYED_RECHECK_MS + 20_000,
    });
    expect(await samePage(page), "the same page: no reload").toBe(true);
    await expect(homeHalf).toBeVisible();
    // Before any tap, the pad is at the stored score: it mounted on the read that saw the Put back, not on the seed of its
    // first Start (T3 review m5b), which would show the side's score before the rally.
    expect(((await homeHalf.textContent()) ?? "").trim(), "the pad comes back at the stored score").toBe(halfAfterRally);
    await expect(page.getByTestId("scan-check-again"), "Check again goes with the Not played screen").toHaveCount(0);
    await homeHalf.click();
    await expect.poll(() => rallies(id), { timeout: HOLD_MS + 20_000, message: "the rally after Put back never reached the ledger" }).toBe(2);
    await expect(page.getByText(en("device.seqConflict")), "no stale-seq refusal").toHaveCount(0);
    await theirs.reload();
    await expect(row.getByTestId("qm-match-score"), "the home reads both rallies").toHaveText(afterHomeRallies(2));
  } finally {
    await other.close();
  }
});

// ── Plan 5 Task 8: League + Knockout ────────────────────────────────────────────────────────────────────────────────
//
// Plan docs/superpowers/plans/2026-11-13-quick-match-5-league-knockout.md Task 8 Step 2; spec
// docs/superpowers/specs/2026-11-12-quick-match-league-knockout-design.md §5, §6, §11, §12 (mockup qmd13a01 §7-12, layout only).
// What the unit and DB tests cannot see, and these do: a whole league and its knockout played through the real pad by taps,
// the fill landing on the home, the tie question answered by a real Toss and a real Pick panel (after hydration), a second
// phone's stale answer, and the stale posts an old tab still holds.
//
// The knockout fills inside the request that finished the league (the scoring hook, the decision routes); the home's own
// read retries the fill on every load (T5), which would mask a hook or a route that never ran. So each fill is witnessed in
// the record BEFORE the first home load after it: on the pad, between the deciding result's 201 and the way back; and for a
// Toss or a Send, between the post and the page its 303 lands on (`beforeLanding`).
//
// Expected names come from the taps (the side each game is steered to) and the table read on screen, never from a typed
// table; expected lines from the en dictionary; counts from the rulebook (a round robin of n plays n(n-1)/2 a pass; a
// knockout of q plays q-1, no 3rd-place match); chess's round-robin order is points → direct encounter → wins →
// Sonneborn-Berger → lots (engine BOARDGAME_RR_TIEBREAKERS; the cut drops seed, T2), so two sides who split their games and
// lost both to the same third side are level on every step but the lot. The semi-finals' home/away order is the engine's
// and is not pinned (T7 review G2): a semi is read as a pair.

const MK_EN = readDict("../src/dictionaries/en/marketing.json");
/** An en marketing line (the setup page's copy). */
function mkEn(key: string, vars: Record<string, string | number> = {}): string {
  const text = MK_EN[key];
  if (typeof text !== "string") throw new Error(`the en marketing dictionary has no "${key}"`);
  return text.replace(/\{(\w+)\}/g, (_, slot: string) => {
    if (!Object.hasOwn(vars, slot)) throw new Error(`"${key}" needs {${slot}}`);
    return String(vars[slot]);
  });
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** An en list of names, as the home joins them (`Intl.ListFormat`, the house rule). */
const enList = (names: readonly string[]) => new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(names);

/** How many go through for each knockout row of the setup's Format list (spec §12). */
const LK_THROUGH = { final: 2, semis: 4 } as const;
type LkShape = keyof typeof LK_THROUGH;
/** A page load or a redirect followed: every budget below is built from it and the pad's hold (AGENTS.md class 20). */
const LK_NAV_MS = 20_000;
/** One chess game on the pad, from the home's Score to the home again: Score's 303, the pad's load, Start, the tap's hold
 *  before it is sent, and the way back. */
const LK_GAME_MS = HOLD_MS + 4 * LK_NAV_MS;
/** A chess win as the home writes it, winner first: the rulebook's 1 point to 0 (FIDE), with the house dash. */
const CHESS_WIN = "1–0";

/** A League + Knockout of chess made the way a guest makes one: the setup page (hydrated first), the sides, the Format row,
 *  how often each pair plays, and a Start count the rulebook agrees with; returns the home's path. */
async function createLeagueKnockout(page: Page, name: string, sides: readonly string[], shape: LkShape, plays: 1 | 2): Promise<string> {
  await page.goto("/en/play");
  await expect(form(page)).toBeVisible();
  await expect(page.getByTestId("qm-start"), "the island is live (blank sides hold Start)").toBeDisabled();
  await form(page).getByText(en("sport.boardgame"), { exact: true }).click();
  await form(page).getByLabel("Name", { exact: true }).fill(name);
  for (let n = 3; n <= sides.length; n++) await page.getByRole("button", { name: "+ Add a side" }).click();
  for (const [k, s] of sides.entries()) await side(page, k + 1).fill(s);
  await form(page).locator(`label:has(input[name="shape"][value="${shape}"])`).click();
  await expect(form(page).locator(`input[name="shape"][value="${shape}"]`)).toBeChecked();
  if (plays === 2) await form(page).getByText(mkEn("quickMatch.setup.plays.2"), { exact: true }).click();
  const n = sides.length;
  const total = ((n * (n - 1)) / 2) * plays + LK_THROUGH[shape] - 1;
  await expect(page.getByTestId("qm-start-count")).toHaveText(mkEn(`quickMatch.setup.startCount.${EN_RULES.select(total)}`, { count: total }));
  await page.getByTestId("qm-start").click();
  await page.waitForURL(/\/q\/qm_[^/?#]+$/, { timeout: LK_NAV_MS });
  await expect(page.getByTestId("qm-eyebrow")).toHaveText(`${en("sport.boardgame")} · ${en("quickMatch.format.league_knockout")}`);
  return new URL(page.url()).pathname;
}

const nextCard = (page: Page) => page.locator('[data-testid="qm-draw-card"][data-next="true"]');
const cardOf = (page: Page, fixtureId: string) => page.locator(`[data-testid="qm-draw-card"][data-fixture-id="${fixtureId}"]`);

async function heroSides(page: Page): Promise<[string, string]> {
  const hero = page.getByTestId("qm-hero");
  await expect(hero, "a match is up next").toBeVisible();
  const read = async (id: string) => ((await hero.getByTestId(id).textContent()) ?? "").trim();
  return [await read("qm-hero-home"), await read("qm-hero-away")];
}

interface Game {
  fixtureId: string;
  winner: string;
  loser: string;
}

/**
 * Play the match the home marks next on the pad. Chess: one tap on the winner's half decides the game (owner R7-2). Score
 * (the hero's for a league match, the knockout card's own for a knockout one), Start, the half that names the winner, and the
 * result written: the pad's own events post answered 201. Then `whileOnPad`, still on the pad (no home load since the
 * result), then back by the pad's own link to the bare home. `winnerOf` picks the winner from the two sides the hero names.
 */
async function playNext(
  page: Page,
  home: string,
  winnerOf: (homeSide: string, awaySide: string) => string,
  whileOnPad?: (game: Game) => Promise<void>,
): Promise<Game> {
  const [h, a] = await heroSides(page);
  const winner = winnerOf(h, a);
  expect([h, a], `the steered winner plays this match (${h} v ${a})`).toContain(winner);
  const knockout = (await nextCard(page).count()) > 0;
  const holder = knockout ? nextCard(page) : nextRow(page);
  await expect(holder, "one match is marked next").toHaveCount(1);
  const fixtureId = (await holder.getAttribute("data-fixture-id"))!;
  const score = knockout ? holder.getByTestId("qm-score") : page.getByTestId("qm-hero").getByTestId("qm-score");
  await expectTappable(score, `${h} v ${a}: Score`);
  await score.click();
  await page.waitForURL(/\/score\/dl_[A-Za-z0-9_-]{43}$/, { timeout: LK_NAV_MS });
  await expect(page.getByTestId("scan-confirm"), `${h} v ${a}: the pad's Confirm`).toBeVisible({ timeout: LK_NAV_MS });
  await pressStart(page);
  const half = page.locator(`[data-role="pad-v3"] button[data-role="v3-scorebug-half"][data-side="${winner === h ? "home" : "away"}"]`);
  await expect(half).toBeVisible({ timeout: LK_NAV_MS });
  await expect(half, "the half tapped names the winner").toHaveAttribute("aria-label", new RegExp(escapeRe(winner)));
  const written = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === `/api/v1/fixtures/${fixtureId}/events` &&
      (r.request().postData() ?? "").includes('"boardgame.result"'),
    { timeout: HOLD_MS + LK_NAV_MS },
  );
  await half.click();
  expect((await written).status(), `${winner} beat ${winner === h ? a : h}: the result is written`).toBe(201);
  await expect(page.getByText(en("device.quickMatch.resultSaved")), "the pad's decided line").toBeVisible({ timeout: LK_NAV_MS });
  const game = { fixtureId, winner, loser: winner === h ? a : h };
  if (whileOnPad) await whileOnPad(game);
  await page.getByTestId("quick-match-back-link").click();
  await page.waitForURL((u) => u.pathname === home && u.search === "", { timeout: LK_NAV_MS });
  return game;
}

type LkRecord = Awaited<ReturnType<typeof lkRecord>>;
/** The record of a quick match, from any one of its fixtures: its cut decision, and its knockout stage's fill (a confirmed
 *  seed proposal) with every knockout line's seats by entrant name. */
async function lkRecord(fixtureId: string) {
  return withDb(async (sql) => {
    const [qm] = await sql<{ cut: { how: string; through: string[]; tie: string[] } | null; division: string }[]>`
      select q.cut_decision as cut, f.division_id::text as division
      from fixtures f join divisions d on d.id = f.division_id join quick_matches q on q.competition_id = d.competition_id
      where f.id = ${fixtureId}`;
    expect(qm, "the fixture is a quick match's").toBeDefined();
    const names = new Map(
      (await sql<{ id: string; name: string }[]>`select id::text, display_name as name from entrants where division_id = ${qm!.division}`).map(
        (e) => [e.id, e.name],
      ),
    );
    const ko = await sql<{ id: string; home: string | null; away: string | null; is_final: boolean }[]>`
      select f.id::text, f.home_entrant_id::text as home, f.away_entrant_id::text as away, f.is_final
      from fixtures f join stages s on s.id = f.stage_id
      where f.division_id = ${qm!.division} and s.kind = 'knockout' order by f.round_no, f.seq_in_round`;
    const [{ confirmed }] = await sql<{ confirmed: number }[]>`
      select count(*)::int as confirmed from stage_seed_proposals p join stages s on s.id = p.stage_id
      where s.division_id = ${qm!.division} and s.kind = 'knockout' and p.status = 'confirmed'`;
    const [league] = await sql<{ rows: { entrantId: string; rank: number }[] | null }[]>`
      select ss.rows from stages s left join standings_snapshots ss on ss.stage_id = s.id and ss.pool_id is null
      where s.division_id = ${qm!.division} and s.kind = 'league'`;
    const nameOf = (id: string | null) => (id === null ? null : (names.get(id) ?? `?${id}`));
    return {
      cut: qm!.cut === null ? null : { how: qm!.cut.how, through: qm!.cut.through.map((id) => nameOf(id)!), tie: qm!.cut.tie.map((id) => nameOf(id)!) },
      knockout: ko.map((f) => ({ id: f.id, home: nameOf(f.home), away: nameOf(f.away), isFinal: f.is_final })),
      confirmed,
      /** The stored league table's order, by name: the lot's order inside a class it ordered (§11: what a Toss reveals). */
      leagueOrder: [...(league?.rows ?? [])].sort((x, y) => x.rank - y.rank).map((r) => nameOf(r.entrantId)!),
    };
  });
}

/**
 * Read the record between a form post and the page its 303 lands on: the next post to `path` is sent from here unfollowed
 * (`route.fetch`, maxRedirects 0), `read` runs, and the browser is handed the 303 to follow. So what `read` sees is the
 * route's own work, before the home's read could retry it. Returns the read's result once the browser has the 303.
 *
 * The route stays registered for the page's life; a later post to `path` falls through. Seen twice on the toss with a
 * `times: 1` route (2026-11-13): the 303 was fulfilled, the GET it redirects to stayed pending, and the click never
 * returned until the test's budget ran out.
 */
async function beforeLanding<T>(page: Page, path: string, read: () => Promise<T>): Promise<() => Promise<{ status: number; seen: T }>> {
  let answered: { status: number; seen: T } | null = null;
  let failed: unknown = null;
  let taken = false;
  await page.route((url) => url.pathname === path, async (route: Route) => {
    if (route.request().method() !== "POST" || taken) return route.fallback();
    taken = true;
    try {
      const response = await route.fetch({ maxRedirects: 0 });
      const seen = await read();
      await route.fulfill({ response });
      answered = { status: response.status(), seen };
    } catch (err) {
      failed = err;
      await route.abort().catch(() => undefined);
    }
  });
  return async () => {
    await expect.poll(() => answered !== null || failed !== null, { message: `${path} was never posted`, timeout: LK_NAV_MS }).toBe(true);
    if (failed !== null) throw failed;
    return answered!;
  };
}

/** The short table as a person sees it, top to bottom: each row's place (as painted: a level table's screen-reader word
 *  left out), name, tag beside the name ("level — to decide", "decided by lot", "picked"; "" for none), and whether it is
 *  marked going through. */
async function tableRows(page: Page): Promise<{ place: string; name: string; tag: string; through: boolean }[]> {
  const rows = page.getByTestId("qm-standings-short").getByTestId("qm-standings-row");
  await expect(rows.first(), "the table has rows").toBeAttached();
  return rows.evaluateAll((els) =>
    els.map((el) => {
      const cell = el.querySelector("td");
      const painted = cell?.querySelector('[aria-hidden="true"]') ?? cell;
      const header = el.querySelector('th[scope="row"]');
      const tag = el.querySelector('[data-testid="qm-standings-tag"]');
      const name = tag === null ? header : (header?.querySelector("span > span") ?? header);
      return {
        place: (painted?.textContent ?? "").trim(),
        name: (name?.textContent ?? "").trim(),
        tag: (tag?.textContent ?? "").trim(),
        through: (el as HTMLElement).dataset.through === "true",
      };
    }),
  );
}

/** A knockout card's two seats as their names read, in the card's order (a seat waiting reads its words). */
async function seatsOf(card: Locator): Promise<string[]> {
  return (await card.getByTestId("qm-draw-name").allTextContents()).map((t) => t.trim());
}

/** The bracket is above the table: the knockout's section comes first in the page and paints above it. */
async function expectKnockoutFirst(page: Page, what: string) {
  const order = await page.evaluate(() => {
    const ko = document.querySelector('[data-testid="qm-knockout"]');
    const table = document.querySelector('[data-testid="qm-standings"]');
    if (ko === null || table === null) return null;
    return {
      first: (ko.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      above: ko.getBoundingClientRect().bottom <= table.getBoundingClientRect().top,
    };
  });
  expect(order, `${what}: both the knockout and the table`).not.toBeNull();
  expect(order, `${what}: the knockout above the table`).toEqual({ first: true, above: true });
}

/** The played line with the countdown (an unsaved home still being played): `played` of `total`, then `extra` parts. */
const playedWithCountdown = (played: number, total: number, ...extra: string[]) =>
  [en(`quickMatch.home.played.${EN_RULES.select(total)}`, { played, count: total, days: QUICK_MATCH_EXPIRY_DAYS }), ...extra].join(" · ");

test("League → Semi-finals (plan 5 T8 (1) and (5)): a chess league of 4 played on the pad fills its semi-finals, 1st v 4th and 2nd v 3rd by the table on screen, before the home loads again; the bracket moves above the table and the hero says Semi-final 1; the league's rows offer no Edit result and a stale tab's Edit result opens the pad View-only, locked; the semi-finals and the final played on their own cards name the final's winner Champion, not the table's leader", async ({ guest: page }) => {
  const sides = ["Ines Duarte", "Mika Laine", "Oskar Lind", LONG];
  const league = (sides.length * (sides.length - 1)) / 2;
  const knockout = LK_THROUGH.semis - 1;
  // Derived, never flat (AGENTS.md #20): every game's loads and hold, and a dozen more loads (the stale tab, reloads, widths).
  test.setTimeout((league + knockout) * LK_GAME_MS + 12 * LK_NAV_MS);
  const home = await createLeagueKnockout(page, `e2e lk semis ${TAG}`, sides, "semis", 1);
  // The steer: of any two, the one typed first wins the league game, so the table is the typing order, 3, 2, 1 and 0 wins.
  const typed = (name: string) => sides.indexOf(name);

  // ---- Before a game: the knockout's three cards wait on the league (D7), under the table, filling itself at the end ----
  const ko = page.getByTestId("qm-knockout");
  await expect(ko.getByTestId("qm-knockout-caption")).toHaveText(en("quickMatch.home.knockoutFills"));
  const cards = ko.getByTestId("qm-draw-card");
  await expect(cards).toHaveCount(knockout);
  const semiSeats = [...(await seatsOf(cards.nth(0))), ...(await seatsOf(cards.nth(1)))];
  expect(semiSeats.sort(), "the semi-finals wait on 1st to 4th in the league").toEqual(
    [1, 2, 3, 4].map((r) => en(`quickMatch.home.leagueRank.${r}`)).sort(),
  );
  expect(await seatsOf(cards.nth(2)), "the final waits on both semi-finals").toEqual([
    en("quickMatch.home.winnerOfSemi", { n: 1 }),
    en("quickMatch.home.winnerOfSemi", { n: 2 }),
  ]);
  await expect(page.getByTestId("qm-played")).toHaveText(
    playedWithCountdown(0, league + knockout, en("quickMatch.home.stagePart.split", { league, knockout })),
  );
  const tableFirst = await page.evaluate(() => {
    const ko = document.querySelector('[data-testid="qm-knockout"]')!;
    return (ko.compareDocumentPosition(document.querySelector('[data-testid="qm-standings"]')!) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
  });
  expect(tableFirst, "while the league is on, the table comes first").toBe(true);

  // ---- The league, game by game on the pad. A second tab loads the home before the last game: it is stale after it ----
  const atLast: { record?: LkRecord } = {};
  let stale: Page | null = null;
  for (let g = 1; g <= league; g++) {
    await expect(page.getByTestId("qm-hero-kicker"), `game ${g}: the hero counts the league's matches (D8)`).toHaveText(
      en("quickMatch.home.upNext", { n: g, total: league }),
    );
    if (g === league) {
      stale = await page.context().newPage();
      await stale.goto(home);
      await expect(stale.locator('[data-testid="qm-match"][data-state="settled"]'), "the stale tab, as loaded").toHaveCount(league - 1);
    }
    const last = g === league;
    await playNext(page, home, (h, a) => (typed(h) < typed(a) ? h : a), last ? async (game) => void (atLast.record = await lkRecord(game.fixtureId)) : undefined);
  }
  // The scoring hook filled the knockout inside the last game's write: read while the pad was still open, no home load since.
  expect(atLast.record, "the record was read on the pad").toBeDefined();
  const atFill = atLast.record!;
  expect(atFill.confirmed, "one confirmed fill of the knockout").toBe(1);
  expect(atFill.cut, "no tie, so no decision").toBeNull();
  const semisInRecord = atFill.knockout.filter((f) => !f.isFinal);
  expect(semisInRecord.map((f) => [f.home, f.away].sort()).sort(), "the record's semi-finals: 1st v 4th, 2nd v 3rd (the steer)").toEqual(
    [[sides[0]!, sides[3]!].sort(), [sides[1]!, sides[2]!].sort()].sort(),
  );

  // ---- Filled: the table on screen, the semi-finals from it, the bracket above it, the hero on Semi-final 1 ----
  const table = await tableRows(page);
  expect(table.map((r) => r.name), "the table: the steer's order").toEqual(sides);
  expect(table.every((r) => r.through), "all four went through").toBe(true);
  const pairs = [
    [table[0]!.name, table[3]!.name],
    [table[1]!.name, table[2]!.name],
  ];
  const semiCards = [cards.nth(0), cards.nth(1)];
  const onCards = await Promise.all(semiCards.map(async (c) => (await seatsOf(c)).sort()));
  expect(onCards.sort(), "1st v 4th and 2nd v 3rd, from the table on screen (seat order not pinned, G2)").toEqual(pairs.map((p) => [...p].sort()).sort());
  for (const card of semiCards) {
    const names = await seatsOf(card);
    const notes = (await card.getByTestId("qm-draw-note").allTextContents()).map((t) => t.trim());
    expect(notes, "each seat says where it finished").toEqual(names.map((n) => en(`quickMatch.home.rankShort.${table.findIndex((r) => r.name === n) + 1}`)));
  }
  await expectKnockoutFirst(page, "filled");
  await expect(ko.getByTestId("qm-knockout-caption"), "filled: no caption").toHaveCount(0);
  await expect(page.getByTestId("qm-standings-title")).toHaveText(en("quickMatch.home.finalLeagueTable"));
  await expect(page.getByTestId("qm-standings-caption")).toHaveText(en("quickMatch.home.wentThrough", { count: LK_THROUGH.semis }));
  const semi1 = en("quickMatch.home.semiFinal", { n: 1 });
  await expect(page.getByTestId("qm-hero-kicker")).toHaveText(en("quickMatch.home.upNextRound", { round: semi1 }));
  await expect(nextCard(page).getByTestId("qm-draw-round"), "the next card says it is next (T7 m1)").toHaveText(
    en("quickMatch.home.upNextRound", { round: semi1 }),
  );
  expect((await heroSides(page)).sort(), "the hero is the next card's match").toEqual((await seatsOf(nextCard(page))).sort());
  await expect(page.getByTestId("qm-played")).toHaveText(playedWithCountdown(league, league + knockout, en("quickMatch.home.stagePart.knockoutOn")));
  await expect(page.getByTestId("qm-add-match-open"), "the league is complete: no Add a match").toHaveCount(0);
  // (5) Edit result after the fill: every league row is settled and its result has moved the match on, so none has a ⋯.
  await expect(page.locator('[data-testid="qm-match"][data-state="settled"]')).toHaveCount(league);
  await expect(page.getByTestId("qm-match").getByTestId("qm-row-menu"), "no ⋯ on a league row").toHaveCount(0);
  await expect(page.getByTestId("qm-edit-result"), "no Edit result anywhere").toHaveCount(0);

  // ---- (5) The stale tab still offers Edit result on a league row: it lands in the pad View-only, the result locked ----
  const staleRow = stale!.locator('[data-testid="qm-match"][data-state="settled"]').first();
  await openRowMenu(staleRow, "the stale tab");
  const edit = staleRow.getByTestId("qm-edit-result");
  await expect(edit).toHaveText(en("quickMatch.home.editResult"));
  await edit.click();
  await stale!.waitForURL(/\/score\/dl_[A-Za-z0-9_-]{43}$/, { timeout: LK_NAV_MS });
  await expect(stale!.getByTestId("scan-view-only")).toHaveText(en("device.quickMatch.resultLocked"), { timeout: LK_NAV_MS });
  await expect(stale!.locator('[data-role="pad-v3"] button[data-role="v3-scorebug-half"]'), "View-only: no halves to tap").toHaveCount(0);
  await stale!.close();

  // ---- The semi-finals on their cards: the lower-placed side wins each, so the final is 3rd v 4th ----
  const upset = (h: string, a: string) => (typed(h) > typed(a) ? h : a);
  const s1 = await playNext(page, home, upset);
  const semi2 = en("quickMatch.home.semiFinal", { n: 2 });
  await expect(page.getByTestId("qm-hero-kicker")).toHaveText(en("quickMatch.home.upNextRound", { round: semi2 }));
  await expect(nextCard(page).getByTestId("qm-draw-round")).toHaveText(en("quickMatch.home.upNextRound", { round: semi2 }));
  await expect(cardOf(page, s1.fixtureId).locator('[data-testid="qm-draw-seat"][data-winner="true"]')).toContainText(s1.winner);
  await expect(cardOf(page, s1.fixtureId).getByTestId("qm-draw-seat-score"), "the winner's line carries the score").toHaveText(CHESS_WIN);
  const s2 = await playNext(page, home, upset);
  const final = en("bracket.round.final");
  await expect(page.getByTestId("qm-hero-kicker")).toHaveText(en("quickMatch.home.upNextRound", { round: final }));
  expect((await seatsOf(nextCard(page))).sort(), "the final: both semi-finals' winners").toEqual([s1.winner, s2.winner].sort());
  expect([s1.winner, s2.winner].sort(), "the steer's upsets: 4th and 3rd").toEqual([table[3]!.name, table[2]!.name].sort());
  const champion = table[2]!.name;
  const f = await playNext(page, home, () => champion);

  // ---- The champion: the final's winner, who they beat and by what; not top of the league, so no "too" ----
  await expect(page.getByTestId("qm-champion-kicker")).toHaveText(en("quickMatch.home.champion"));
  await expect(page.getByTestId("qm-champion-name")).toHaveText(champion);
  await expect(page.getByTestId("qm-champion-beat"), "3rd in the league: no 'Top of the league too'").toHaveText(
    en("quickMatch.home.championBeat", { loser: f.loser, score: CHESS_WIN }),
  );
  expect(champion, "the champion is not the table's leader (the steer's witness)").not.toBe(table[0]!.name);
  await expect(page.getByTestId("qm-hero"), "nothing left to play").toHaveCount(0);
  await expect(page.getByTestId("qm-winner"), "no league winner card: the final names the winner").toHaveCount(0);
  await expect(page.getByTestId("qm-played")).toHaveText(en(`quickMatch.home.playedSaved.${EN_RULES.select(league + knockout)}`, { played: league + knockout, count: league + knockout }));
  await atEachWidth(page, async (width) => {
    await expect(page.getByTestId("qm-champion-name"), `${width}`).toHaveText(champion);
    await expectKnockoutFirst(page, `${width}`);
  });
});

/** Three sides, each pair twice (Twice), steered to a tie at 2nd: the first side wins all four of its games; the other two
 *  split theirs (the first meeting to the side typed second, the next to the side typed third). Then they are level on every
 *  chess round-robin step but the lot (points, direct encounter, wins, Sonneborn-Berger), straddling a cut of 2: "pick 1 of
 *  2". The last game's record is read on the pad: nothing filled, nothing decided. */
async function playToTieAtSecond(page: Page, home: string, sides: readonly [string, string, string]) {
  const [top, b, c] = sides;
  let meetings = 0;
  const steer = (h: string, a: string) => {
    if (h === top || a === top) return top;
    meetings += 1;
    return meetings === 1 ? b : c;
  };
  const games = 2 * 3;
  const atLast: { record?: LkRecord } = {};
  for (let g = 1; g <= games; g++) {
    await playNext(page, home, steer, g === games ? async (game) => void (atLast.record = await lkRecord(game.fixtureId)) : undefined);
  }
  expect(meetings, "the two level sides met twice").toBe(2);
  const open = atLast.record;
  expect(open, "the record was read on the pad").toBeDefined();
  expect([open!.cut, open!.confirmed, open!.knockout.flatMap((f) => [f.home, f.away])], "a tie at the cut: nothing decided, nothing filled").toEqual([
    null,
    0,
    [null, null],
  ]);
  return open!;
}

/** The open question as the home asks it (§5, mockup §8): orange where the hero was, the tie named in the order typed, the
 *  table's level rows marked "=", the knockout waiting for it, and no Add a match. */
async function expectTieAtSecond(page: Page, sides: readonly [string, string, string], what: string) {
  const [top, b, c] = sides;
  await expect(page.getByTestId("qm-cut"), `${what}: the question`).toBeVisible();
  await expect(page.getByTestId("qm-hero"), `${what}: no match is up next`).toHaveCount(0);
  await expect(page.getByTestId("qm-cut-kicker")).toHaveText(en("quickMatch.cut.kicker.one", { count: 1 }));
  await expect(page.getByTestId("qm-cut-title")).toHaveText(
    en("quickMatch.cut.title", { place: en("quickMatch.home.rankShort.2"), names: enList([b, c]) }),
  );
  await expect(page.getByTestId("qm-cut-body")).toHaveText(en("quickMatch.cut.body"));
  await expect(page.getByTestId("qm-knockout-caption")).toHaveText(en("quickMatch.home.knockoutWaiting"));
  expect(await seatsOf(page.getByTestId("qm-draw-card")), `${what}: the final waits on 1st and the tie`).toEqual([
    en("quickMatch.home.leagueRank.1"),
    en("quickMatch.home.toDecide", { seat: en("quickMatch.home.leagueRank.2") }),
  ]);
  const rows = await tableRows(page);
  expect(
    rows.map((r) => [r.place, r.name, r.tag]),
    `${what}: the leader, then the tie in the order typed, level and to decide (D9, never the lot's order)`,
  ).toEqual([
    ["1", top, ""],
    ["=", b, en("quickMatch.home.levelToDecide")],
    ["=", c, en("quickMatch.home.levelToDecide")],
  ]);
  await expect(page.getByTestId("qm-add-match-open"), `${what}: the league is complete`).toHaveCount(0);
  await expectTappable(page.getByTestId("qm-cut-pick"), `${what}: Pick who goes through`);
  await expectTappable(page.getByTestId("qm-cut-toss"), `${what}: Toss a coin`);
  await expect(page.getByTestId("qm-cut-toss")).toHaveText(en("quickMatch.cut.toss"));
  await expect(page.getByTestId("qm-cut-pick")).toHaveText(en("quickMatch.cut.pick"));
}

/** The stored lot's order inside the tie: the side a Toss sends through first (§11: the toss reveals the stored lot). */
function lotOrder(record: LkRecord, tie: readonly string[]): string[] {
  const order = record.leagueOrder.filter((n) => tie.includes(n));
  expect([...order].sort(), "the stored table holds the whole tie").toEqual([...tie].sort());
  return order;
}

test("Tie at the cut (plan 5 T8 (2)): Twice, 3 sides, League → Final, steered level at 2nd: the question shows; Toss fills the final with the stored lot's side before the home loads, the result line names it, a reload says the same; a second phone's stale Toss lands on 'Someone already decided' and the same names", async ({ guest: page, browser }) => {
  const sides = ["Ines Duarte", "Mika Laine", "Oskar Lind"] as const;
  test.setTimeout(6 * LK_GAME_MS + 12 * LK_NAV_MS);
  const home = await createLeagueKnockout(page, `e2e lk toss ${TAG}`, sides, "final", 2);
  const open = await playToTieAtSecond(page, home, sides);
  await expectTieAtSecond(page, sides, "the tie");
  // The side the lot already ranks ahead inside the tie: what a Toss must reveal (D5: no second draw).
  const [tossed, other] = lotOrder(open, [sides[1], sides[2]]) as [string, string];

  // A second phone holds the question as it is now.
  const phone2Ctx = await anotherPhone(browser);
  try {
    const phone2 = await phone2Ctx.newPage();
    await phone2.goto(home);
    await expectTieAtSecond(phone2, sides, "the second phone");

    // Toss: the decision and the fill are in the record before the page its 303 lands on is asked for.
    const answered = await beforeLanding(page, `${home}/cut/toss`, () => lkRecord(open.knockout[0]!.id));
    await page.getByTestId("qm-cut-toss").click();
    const { status, seen } = await answered();
    expect(status, "the toss answers with a redirect").toBe(303);
    expect(seen.cut && { how: seen.cut.how, through: seen.cut.through, tie: [...seen.cut.tie].sort() }, "the toss's decision").toEqual({
      how: "toss",
      through: [tossed],
      tie: [sides[1], sides[2]].sort(),
    });
    expect([seen.confirmed, [seen.knockout[0]!.home, seen.knockout[0]!.away].sort()], "filled by the toss route itself").toEqual([
      1,
      [sides[0], tossed].sort(),
    ]);
    await page.waitForURL((u) => u.pathname === home && u.search === "", { timeout: LK_NAV_MS });
    const resultLines = [en("quickMatch.cut.tossResult", { names: tossed }), en("quickMatch.cut.tossBody")];
    const expectTossed = async (p: Page, what: string) => {
      await expect(p.getByTestId("qm-cut-result").locator("p"), `${what}: the toss's result`).toHaveText(resultLines);
      await expect(p.getByTestId("qm-cut"), `${what}: the question is gone`).toHaveCount(0);
      await expect(p.getByTestId("qm-hero-kicker"), what).toHaveText(en("quickMatch.home.upNextRound", { round: en("bracket.round.final") }));
      const card = p.getByTestId("qm-draw-card");
      expect((await seatsOf(card)).sort(), `${what}: the final`).toEqual([sides[0], tossed].sort());
      const names = await seatsOf(card);
      const notes = (await card.getByTestId("qm-draw-note").allTextContents()).map((t) => t.trim());
      expect(notes, `${what}: 1st, and 2nd by lot`).toEqual(
        names.map((n) => (n === sides[0] ? en("quickMatch.home.rankShort.1") : `${en("quickMatch.home.rankShort.2")} · ${en("quickMatch.home.byLotShort")}`)),
      );
      const rows = await tableRows(p);
      expect(rows.map((r) => [r.name, r.tag, r.through]), `${what}: the lot's order, both marked decided by lot (D6)`).toEqual([
        [sides[0], "", true],
        [tossed, en("quickMatch.home.byLot"), true],
        [other, en("quickMatch.home.byLot"), false],
      ]);
      await expectKnockoutFirst(p, what);
    };
    await expectTossed(page, "after the toss");
    await page.reload();
    await expectTossed(page, "reloaded");

    // The second phone's Toss is stale: refused, its flash says someone decided, and it shows the same result.
    const refused = phone2.waitForRequest((r) => {
      const url = new URL(r.url());
      return r.method() === "GET" && url.pathname === home && url.searchParams.get("e") === "QUICK_MATCH_ALREADY_DECIDED";
    });
    await phone2.getByTestId("qm-cut-toss").click();
    expect((await refused).redirectedFrom()?.method(), "the stale toss's 303 landed on the refusal").toBe("POST");
    const flash = phone2.getByTestId("qm-flash");
    await expect(flash).toHaveText(en("quickMatch.flash.alreadyDecided"));
    await expect(flash).toHaveAttribute("role", "alert");
    await expectTossed(phone2, "the second phone");
    const after = await lkRecord(open.knockout[0]!.id);
    expect([after.cut?.how, after.cut?.through, after.confirmed], "the first answer stands, once").toEqual(["toss", [tossed], 1]);
  } finally {
    await phone2Ctx.close();
  }
});

test("Pick (plan 5 T8 (3)): the same tie, the panel opened once the island runs: Send is disabled until one side is chosen and then names it; Back shuts the panel; Send fills the final with the side the lot had NOT ranked ahead, before the home loads; the table marks it picked; the final played, its winner is Champion and top of the league too", async ({ guest: page }) => {
  const sides = ["Ines Duarte", "Mika Laine", "Oskar Lind"] as const;
  test.setTimeout(7 * LK_GAME_MS + 10 * LK_NAV_MS);
  const home = await createLeagueKnockout(page, `e2e lk pick ${TAG}`, sides, "final", 2);
  const open = await playToTieAtSecond(page, home, sides);
  await expectTieAtSecond(page, sides, "the tie");
  // The pick a Toss would NOT make: the side the stored lot ranks behind, so a pick that merely followed the lot fails.
  const [lotAhead, picked] = lotOrder(open, [sides[1], sides[2]]) as [string, string];

  // The island is live once Send is disabled (the server's markup never disables it: the no-script path, T7).
  const send = page.getByTestId("qm-cut-send");
  await expect(send, "hydrated: Send waits for a choice").toBeDisabled({ timeout: LK_NAV_MS });
  await page.getByTestId("qm-cut-pick").click();
  await expect(page.getByTestId("qm-cut-pick-panel")).toHaveAttribute("open", "");
  const question = page.getByTestId("qm-cut-question");
  await expect(question).toHaveText(en("quickMatch.cut.pickQuestion.one", { count: 1 }));
  await expect(question, "the focus moves to the question (T7 m7)").toBeFocused();
  await expect(page.getByTestId("qm-cut-toss"), "the toss steps aside while the panel is open").toBeHidden();
  const options = page.getByTestId("qm-cut-option");
  await expect(options, "the tie's two sides, in the order typed").toHaveText([sides[1], sides[2]]);
  await expect(options.locator("input"), "one place: radios").toHaveCount(2);
  for (const input of await options.locator("input").all()) await expect(input).toHaveAttribute("type", "radio");
  await expect(send).toBeDisabled();
  await expect(send).toHaveText(en("quickMatch.cut.pick"));
  for (let k = 0; k < 2; k++) await expectTappable(options.nth(k), `option ${k + 1}`);
  const back = page.getByTestId("qm-cut-back");
  await expectTappable(back, "Back");
  await back.click();
  await expect(page.getByTestId("qm-cut-pick-panel"), "Back shuts the panel").not.toHaveAttribute("open", "");
  await expect(page.getByTestId("qm-cut-pick"), "and hands the focus back to Pick").toBeFocused();
  await page.getByTestId("qm-cut-pick").click();
  await options.filter({ hasText: picked }).click();
  await expect(send, "one chosen of one place").toBeEnabled();
  await expect(send).toHaveText(en("quickMatch.cut.send", { names: picked }));
  await expectTappable(send, "Send");

  const answered = await beforeLanding(page, `${home}/cut/pick`, () => lkRecord(open.knockout[0]!.id));
  await send.click();
  const { status, seen } = await answered();
  expect(status).toBe(303);
  expect([seen.cut?.how, seen.cut?.through], "the pick's decision").toEqual(["pick", [picked]]);
  expect([seen.confirmed, [seen.knockout[0]!.home, seen.knockout[0]!.away].sort()], "filled by the pick route itself").toEqual([
    1,
    [sides[0], picked].sort(),
  ]);
  expect(picked, "the pick overrode the lot").not.toBe(lotAhead);
  await page.waitForURL((u) => u.pathname === home && u.search === "", { timeout: LK_NAV_MS });
  await expect(page.getByTestId("qm-cut-result").locator("p")).toHaveText([en("quickMatch.cut.pickResult", { names: picked })]);
  const card = page.getByTestId("qm-draw-card");
  expect((await seatsOf(card)).sort()).toEqual([sides[0], picked].sort());
  const names = await seatsOf(card);
  expect((await card.getByTestId("qm-draw-note").allTextContents()).map((t) => t.trim()), "picked, not by lot (D6)").toEqual(
    names.map((n) => en(`quickMatch.home.rankShort.${n === sides[0] ? 1 : 2}`)),
  );
  const rows = await tableRows(page);
  expect(rows.map((r) => [r.place, r.name, r.tag, r.through]), "the picked side first in the tie, marked picked; '=' for both").toEqual([
    ["1", sides[0], "", true],
    ["=", picked, en("quickMatch.home.picked"), true],
    ["=", lotAhead, "", false],
  ]);
  await expectKnockoutFirst(page, "after the pick");

  // The final: the league's leader wins it, so the champion tops the league too (the other polarity of (1)'s champion).
  const f = await playNext(page, home, () => sides[0]);
  expect(f.loser).toBe(picked);
  await expect(page.getByTestId("qm-champion-name")).toHaveText(sides[0]);
  await expect(page.getByTestId("qm-champion-beat")).toHaveText(
    `${en("quickMatch.home.championBeat", { loser: picked, score: CHESS_WIN })} ${en("quickMatch.home.championTopToo")}`,
  );
  await expect(page.getByTestId("qm-cut-result"), "finished: the cut's answer has had its day").toHaveCount(0);
});

test("Every league match skipped (plan 5 T8 (4)): three level sides straddle a cut of 2 and no lot was drawn, so the home asks with Pick only; Send waits for exactly two; the pick fills the final before the home loads; a stale tab's Put back lands on 'The league has finished'", async ({ guest: page }) => {
  test.setTimeout(14 * LK_NAV_MS);
  const sides = ["Ines Duarte", "Mika Laine", "Oskar Lind"] as const;
  const home = await createLeagueKnockout(page, `e2e lk skipped ${TAG}`, sides, "final", 1);
  const league = 3;
  let stale: Page | null = null;
  let first: string | null = null;
  for (let k = 1; k <= league; k++) {
    const next = await nextMatch(page);
    first ??= next.id;
    await skipThroughSheet(page, next.row, en(k === league ? "quickMatch.skip.bodyLast" : "quickMatch.skip.body"), `skip ${k}`);
    if (k === 1) {
      // A second tab holds the home with one match Not played: its Put back is stale from the last skip on.
      stale = await page.context().newPage();
      await stale.goto(home);
      await expect(rowOf(stale, first)).toHaveAttribute("data-state", "notPlayed");
    }
  }
  // Nothing was played, so the three sides are level and the engine drew no lot (T4 ruling): the question, Pick only.
  await expect(page.getByTestId("qm-cut")).toBeVisible();
  await expect(page.getByTestId("qm-cut-kicker")).toHaveText(en("quickMatch.cut.kicker.other", { count: 2 }));
  await expect(page.getByTestId("qm-cut-title")).toHaveText(
    en("quickMatch.cut.titleMany.other", { place: en("quickMatch.home.rankShort.1"), sides: 3, count: 2 }),
  );
  await expect(page.getByTestId("qm-cut-toss"), "no lot was drawn: no Toss").toHaveCount(0);
  await expect(page.getByTestId("qm-put-back"), "the league is done: no Put back").toHaveCount(0);
  // M stays the whole match's (league + final, D8), the Not played part counted, then how M splits.
  await expect(page.getByTestId("qm-played")).toHaveText(
    [
      en(`quickMatch.home.playedSkipped.${EN_RULES.select(league + 1)}`, {
        played: 0,
        count: league + 1,
        skipped: enPlural("quickMatch.home.notPlayedPart", league),
        days: QUICK_MATCH_EXPIRY_DAYS,
      }),
      en("quickMatch.home.stagePart.split", { league, knockout: 1 }),
    ].join(" · "),
  );

  const send = page.getByTestId("qm-cut-send");
  await expect(send, "hydrated: Send waits for a choice").toBeDisabled({ timeout: LK_NAV_MS });
  await page.getByTestId("qm-cut-pick").click();
  await expect(page.getByTestId("qm-cut-question")).toHaveText(en("quickMatch.cut.pickQuestion.other", { count: 2 }));
  const options = page.getByTestId("qm-cut-option");
  await expect(options, "all three, in the order typed").toHaveText([...sides]);
  for (const input of await options.locator("input").all()) await expect(input, "two places: checkboxes").toHaveAttribute("type", "checkbox");
  // Not the typing order's first two (the order the engine falls back to with no lot): the guests' own choice.
  const chosen = [sides[0], sides[2]];
  const tick = (name: string) => options.filter({ hasText: name }).click();
  await tick(chosen[0]!);
  await expect(send, "one of two places").toBeDisabled();
  await tick(chosen[1]!);
  await expect(send, "two of two").toBeEnabled();
  await expect(send).toHaveText(en("quickMatch.cut.send", { names: enList(chosen) }));
  await tick(sides[1]);
  await expect(send, "three for two places").toBeDisabled();
  await tick(sides[1]);
  await expect(send, "two again").toBeEnabled();

  const answered = await beforeLanding(page, `${home}/cut/pick`, () => lkRecord(first!));
  await send.click();
  const { status, seen } = await answered();
  expect(status).toBe(303);
  expect([seen.cut?.how, [...(seen.cut?.through ?? [])].sort()], "the pick's decision").toEqual(["pick", [...chosen].sort()]);
  expect([seen.confirmed, [seen.knockout[0]!.home, seen.knockout[0]!.away].sort()], "filled by the pick route itself").toEqual([1, [...chosen].sort()]);
  await page.waitForURL((u) => u.pathname === home && u.search === "", { timeout: LK_NAV_MS });
  await expect(page.getByTestId("qm-cut-result").locator("p")).toHaveText([en("quickMatch.cut.pickResult", { names: enList(seen.cut!.through) })]);
  expect((await seatsOf(page.getByTestId("qm-draw-card"))).sort()).toEqual([...chosen].sort());
  await expect(page.getByTestId("qm-hero-kicker")).toHaveText(en("quickMatch.home.upNextRound", { round: en("bracket.round.final") }));

  // The stale tab's Put back: refused, its flash says the league has finished, and nothing moved.
  const staleRow = rowOf(stale!, first!);
  await openRowMenu(staleRow, "the stale tab");
  const refused = stale!.waitForRequest((r) => {
    const url = new URL(r.url());
    return r.method() === "GET" && url.pathname === home && url.searchParams.get("e") === "QUICK_MATCH_LEAGUE_FINISHED";
  });
  await staleRow.getByTestId("qm-put-back").click();
  expect((await refused).redirectedFrom()?.method(), "the stale Put back's 303 landed on the refusal").toBe("POST");
  await expect(stale!.getByTestId("qm-flash")).toHaveText(en("quickMatch.flash.leagueFinished"));
  await expect(rowOf(stale!, first!)).toHaveAttribute("data-state", "notPlayed");
  expect((await recordOf([first!])).get(first!)?.status, "the refused Put back wrote nothing").toBe("cancelled");
  const after = await lkRecord(first!);
  expect([after.confirmed, [after.knockout[0]!.home, after.knockout[0]!.away].sort()], "the final is as the pick filled it").toEqual([1, [...chosen].sort()]);
  await stale!.close();
});
