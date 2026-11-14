// Split out of the former e2e/mobile.spec.ts (2026-11-13, verbatim move): quick match: the guest setup form, home, pad and save page; the saver; the football clock sport; the Not played menu and sheet; and, last, the /start wizard case (it uses this file's qm* helpers and follows the quick match cases, so it lives here).
// Runs ONLY in the seven width projects (mobile-320/360/se/14/430, tablet-768/834 — MOBILE_SPECS in playwright.config.ts).

import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { TAG, expectNoHorizontalScroll, loginUi, overflowingIn } from "../helpers";
import { uiEn } from "../match-room-kit";
import { consentedAnonymousState } from "../scorepad-a11y-kit";
import { HOLD_MS } from "../../src/components/v2/scorepad/queue";
import { withDb } from "../rs007-money-kit";
import { projectViewport, projectTag, hitFloor, expectScorebugNotClipped, paintedInsideViewport } from "./_shared";
import { waitForHydration } from "../directory-kit";

// Not serial: no test here reads state another test writes (no module-level `let` is shared), so one red does not skip the rest (AGENTS.md class 21).

// ---------------------------------------------------------------------------
// Quick match (plan 2 Task 10; spec 2026-11-03-quick-match-design.md §5, §8) — a guest's surfaces at every width
// ---------------------------------------------------------------------------
//
// The quick match's own specs measure its pages at 320, 768 and 1280 (quick-match.spec.ts, quick-match-home.spec.ts,
// quick-match-pad-back-link.spec.ts) and the walkthrough plays it at 390; these are the seven-width cases the plan owes.
// Nothing is seeded: each quick match is made through the setup form, the pad is opened by the home's own Score, and the
// rally is a tap. A guest with no account (a context of its own: a bare `newContext()` here inherits the signed-in Pro
// state), the cookie banner already answered, at this project's viewport. At every surface: no sideways scroll
// (`expectNoHorizontalScroll` lifts the global clip before it reads) and nothing clipped inside it (`overflowingIn`: a box
// whose extra content can neither be reached nor says it was shortened is a defect; one that scrolls must be a tab stop,
// AGENTS.md class 23). The setup page had never been measured at 320 before this case: every other case resizes AFTER the
// form is posted.
//
// LAST in this serial file on purpose (AGENTS.md class 21): a red here skips nothing after it. Side names are realistic
// and long (43 and 37 characters, and of any first match among three sides at least one of them plays, so the pad's
// scorebug carries one); badminton is clicked explicitly (the spec's own example).

const QM_MK = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/marketing.json", import.meta.url)), "utf8"),
) as Record<string, string>;
/** An en line with its `{name}` slots filled; a missing key or slot throws rather than reading "undefined". */
function qmWords(dict: Record<string, string>, key: string, vars: Record<string, string | number> = {}): string {
  const text = dict[key];
  if (typeof text !== "string") throw new Error(`the en dictionary has no "${key}"`);
  return text.replace(/\{(\w+)\}/g, (_, slot: string) => {
    if (!Object.hasOwn(vars, slot)) throw new Error(`"${key}" needs {${slot}}`);
    return String(vars[slot]);
  });
}
const qmUi = (key: string, vars?: Record<string, string | number>) => qmWords(uiEn, key, vars);
const qmMk = (key: string, vars?: Record<string, string | number>) => qmWords(QM_MK, key, vars);
const QM_PLURAL = new Intl.PluralRules("en");

const QM_LONG = "The Extraordinarily Long-Named Doubles Pair";
const QM_LONG_TOO = "Priya Raghunathan & Tomasz Wisniewski";
/** A page load or a redirect followed: the budgets below are built from it and the pad's hold (AGENTS.md class 20). */
const QM_NAV_MS = 20_000;
/** A click, a fill or a measurement. */
const QM_ACT_MS = 2_000;
/** The boxes a person reads inside a surface, and the boxes that hold them (never an `<input>`/`<select>`: a field scrolls
 *  its own text by design). */
const QM_SCAN = "div,span,p,a,button,label,li,ol,ul,h1,h2,th,td,table,section,summary,legend,small,fieldset,form,details,header";
/** Badminton's live score reads as its levels in seat order (`compactScore`, lib/match-day/view.ts): the games won, then the
 *  game's points ("0–0 · 1–0", CI run 43290331372). One rally to the home side is a point and no game: games 0–0, points
 *  1–0. Before that rally the last level reads 0–0, which this does not match. */
const QM_AFTER_ONE_HOME_RALLY = /^\s*0\D+0\D+1\D+0\s*$/;

/** A guest's own browser at this project's viewport: no session, the cookie banner already answered. */
async function qmGuest(browser: import("@playwright/test").Browser) {
  const viewport = projectViewport();
  expect(viewport, "premise: this project declares a viewport").not.toBeNull();
  return browser.newContext({
    viewport: viewport!,
    storageState: await consentedAnonymousState(),
    baseURL: test.info().project.use.baseURL,
  });
}

/** Nothing clipped inside `root` at this width; the count of boxes scanned (zero would pass anything, so it fails). */
async function qmNotClipped(page: Page, root: string, label: string): Promise<number> {
  // A turning chevron mid-transition (Show QR's) reads as a clip for ~100 ms on a fast runner: settle every FINITE
  // animation under the root first (a live dot's pulse is infinite and would never settle, so it is left out).
  await page.locator(root).evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => null)),
    ),
  );
  const boxes = await page.locator(root).locator(QM_SCAN).count();
  expect(boxes, `${label}: the scan had boxes to scan`).toBeGreaterThan(0);
  const { clipped, scrollable } = await overflowingIn(page, root, QM_SCAN, `${label} was not in the DOM`);
  expect(clipped, `${label} clips content at ${projectTag()}`).toEqual([]);
  for (const box of scrollable) expect(box, `${label}: a scrolling box is not keyboard-reachable`).toMatch(/tabindex=0$/);
  return boxes;
}

/** The setup form filled the way a guest fills it: the sport (badminton unless named), the name, the sides. A quick match is a
 *  league (owner 2026-11-12), so there is no format to pick at any number of sides. */
async function qmFillSetup(page: Page, name: string, sides: readonly string[], sport: "badminton" | "football" = "badminton"): Promise<void> {
  await page.goto("/en/play", { waitUntil: "load" });
  const form = page.getByTestId("qm-setup-form");
  await expect(form).toBeVisible({ timeout: QM_NAV_MS });
  // The island is live once blank rows hold Start disabled (the server's no-script Start is enabled): typing before then races
  // React taking the inputs over.
  await expect(page.getByTestId("qm-start")).toBeDisabled();
  await form.getByText(qmUi(`sport.${sport}`), { exact: true }).click();
  await expect(form.getByRole("radio", { name: qmUi(`sport.${sport}`), exact: true })).toBeChecked();
  await form.getByLabel(qmMk("quickMatch.setup.nameLabel"), { exact: true }).fill(name);
  for (let n = 3; n <= sides.length; n += 1) await form.getByRole("button", { name: qmMk("quickMatch.setup.addSide") }).click();
  for (const [i, s] of sides.entries()) await form.getByLabel(qmMk("quickMatch.setup.sideLabel", { n: i + 1 }), { exact: true }).fill(s);
  // No League or Knockout to pick (owner 2026-11-12): the league's own help says what it is instead.
  for (const format of ["league", "knockout"] as const) {
    await expect(form.getByRole("radio", { name: qmUi(`quickMatch.format.${format}`), exact: true }), `no ${format} to pick`).toHaveCount(0);
  }
  await expect(form.getByTestId("qm-league-help")).toHaveText(qmMk("quickMatch.setup.leagueHelp"));
  // A single round robin of n sides plays n(n-1)/2 matches.
  const matches = (sides.length * (sides.length - 1)) / 2;
  await expect(page.getByTestId("qm-start-count")).toHaveText(
    qmMk(`quickMatch.setup.startCount.${QM_PLURAL.select(matches)}`, { count: matches }),
  );
}

/** Start, followed to the home; returns the home's path. */
async function qmStart(page: Page): Promise<string> {
  await page.getByTestId("qm-start").click();
  await page.waitForURL(/\/q\/qm_[^/?#]+$/, { timeout: QM_NAV_MS });
  return new URL(page.url()).pathname;
}

test("quick match (guest): the setup form, the home with Share's QR and Add a match open, the pad after one rally and its way back, and the save page hold at this width; the home reads the rally", async ({
  browser,
}) => {
  // Six page loads or redirects, the rally's hold before it is sent and the record read back, and ~30 local acts.
  test.setTimeout(6 * QM_NAV_MS + HOLD_MS + QM_NAV_MS + 30 * QM_ACT_MS);
  const ctx = await qmGuest(browser);
  let scanned = 0;
  try {
    const page = await ctx.newPage();
    const name = `Mobile quick match ${TAG}-${projectTag()}`;
    const sides = [QM_LONG, QM_LONG_TOO, "Lee & Ana"] as const;

    // ── 1. The setup form, filled, before Start ──
    await qmFillSetup(page, name, sides);
    await expectNoHorizontalScroll(page);
    // The one designed overhang: docked (below 640) the Start bar bleeds through its column's gutter to the column's edges
    // (`-mx-4 px-4` under the column's `px-4`, setup-form.tsx), and the form's own box would report it. Measured in place
    // first (docked, the bar spans its column exactly). Then, for the clip scan only, the bleed is folded back: the bar's side
    // margins AND side padding zeroed, so its content box keeps its width and nothing inside it moves, while the form's box can
    // report ANY child poking into the gutter, by 1px or by 15 (review r1: an exemption sized to the bleed hid those). No
    // exemption at any width. The bar's own style attribute is put back after the scan.
    const startBar = page.getByTestId("qm-start-bar");
    const bar = await startBar.evaluate((el) => {
      const column = el.closest<HTMLElement>('[data-testid="qm-setup-form"]')?.parentElement;
      if (!column) return null;
      const [b, c] = [el.getBoundingClientRect(), column.getBoundingClientRect()];
      return { docked: getComputedStyle(el).position === "sticky", left: Math.round(b.left - c.left), right: Math.round(c.right - b.right) };
    });
    expect(bar, "the setup form, its column and its Start bar are in the DOM").not.toBeNull();
    if (bar!.docked) expect([bar!.left, bar!.right], "docked, the Start bar spans its column exactly").toEqual([0, 0]);
    const priorStyle = await startBar.evaluate((el) => {
      const prior = el.getAttribute("style");
      for (const side of ["margin-left", "margin-right", "padding-left", "padding-right"]) el.style.setProperty(side, "0px");
      return prior;
    });
    try {
      scanned += await qmNotClipped(page, '[data-testid="qm-setup-form"]', "the setup form (the Start bar's bleed folded back)");
    } finally {
      await startBar.evaluate((el, prior) => (prior === null ? el.removeAttribute("style") : el.setAttribute("style", prior)), priorStyle);
    }
    await hitFloor(page.getByTestId("qm-start"), "Start", 44);
    const home = await qmStart(page);

    // ── 2. The home: hero, Share (its QR drawn) and Add a match, opened ──
    const hero = page.getByTestId("qm-hero");
    await expect(hero.getByTestId("qm-hero-kicker")).toHaveText(qmUi("quickMatch.home.upNext", { n: 1, total: 3 }));
    const heroNames = [(await hero.getByTestId("qm-hero-home").textContent())!.trim(), (await hero.getByTestId("qm-hero-away").textContent())!.trim()];
    expect(sides, "the hero names two of the typed sides").toEqual(expect.arrayContaining(heroNames));
    expect(heroNames.some((n) => n === QM_LONG || n === QM_LONG_TOO), "premise: a long name plays the first match (so the pad carries one)").toBe(true);
    // The list's next match is the hero's: one row marked next, and its sides are the hero's two names.
    const next = page.locator('[data-testid="qm-match"][data-next="true"]');
    await expect(next).toHaveCount(1);
    for (const n of heroNames) await expect(next.getByTestId("qm-match-sides"), "the row marked next is the hero's match").toContainText(n);
    const fixtureId = (await next.getAttribute("data-fixture-id"))!;
    await hitFloor(hero.getByTestId("qm-score"), "the hero's Score", 44);
    await expect(page.getByTestId("qm-share-copy"), "Copy is on first paint").toBeVisible();
    await hitFloor(page.getByTestId("qm-share-copy"), "Copy link", 44);
    await hitFloor(page.getByTestId("qm-share-toggle"), "Show QR", 44);
    await page.getByTestId("qm-share-toggle").click();
    await expect(page.getByTestId("qm-share-qr"), "Show QR draws the code").toBeVisible({ timeout: QM_NAV_MS });
    await hitFloor(page.getByTestId("qm-add-match-open"), "+ Add a match", 44);
    await page.getByTestId("qm-add-match-open").click();
    await expect(page.getByTestId("qm-add-match-form")).toBeVisible();
    await hitFloor(page.getByTestId("qm-add-match-submit"), "Add the match", 44);
    await expectNoHorizontalScroll(page);
    scanned += await qmNotClipped(page, '[data-testid="qm-home"]', "the home, Share and Add a match open");
    // The Full table open (owner 2026-11-12): where it is wider than the screen it scrolls in its own region (overflow-x
    // auto, tabindex 0, a role and a name; AGENTS.md rule 23), which the scan counts as reachable, never as a clip. Closed
    // again after, so the rest of the walk meets the home as a guest first sees it.
    await page.getByTestId("qm-full-table-toggle").click();
    await expect(page.getByTestId("qm-full-table-region")).toBeVisible();
    await expectNoHorizontalScroll(page);
    scanned += await qmNotClipped(page, '[data-testid="qm-standings"]', "the Full table open");
    await page.getByTestId("qm-full-table-toggle").click();
    await expect(page.getByTestId("qm-full-table-region")).toBeHidden();

    // ── 3. The pad: Score → the Confirm card → Start match → one rally to the home side ──
    await hero.getByTestId("qm-score").click();
    await page.waitForURL(/\/score\/dl_[A-Za-z0-9_-]+$/, { timeout: QM_NAV_MS });
    await expect(page.getByTestId("scan-confirm")).toBeVisible({ timeout: QM_NAV_MS });
    await expectNoHorizontalScroll(page);
    await page.getByTestId("score-start-match").click();
    const half = (s: "home" | "away") => page.locator(`[data-role="pad-v3"] button[data-role="v3-scorebug-half"][data-side="${s}"]`);
    await expect(half("home"), "Start opens the pad, its halves tappable").toBeVisible({ timeout: QM_NAV_MS });
    // Each half is the rally button: 44px tall and a tap at its edges and centre lands on it (a hit test, not a box size).
    await hitFloor(half("home"), "the home half", 44);
    await hitFloor(half("away"), "the away half", 44);
    await half("home").click();
    await expectScorebugNotClipped(page, "the quick match pad, a long name on it");
    await expectNoHorizontalScroll(page);
    // The pad soft-commits: the rally is sent after the hold (queue.ts), so the record is polled past it before leaving.
    await expect
      .poll(
        async () => {
          const [row] = await withDb(
            (sql) => sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId} and type = 'badminton.rally'`,
          );
          return row!.n;
        },
        { timeout: HOLD_MS + QM_NAV_MS, message: "the rally never reached the ledger" },
      )
      .toBe(1);
    // The way back: on screen at this width (under the pad on a phone, above it from md), a real 44px target.
    const back = page.getByTestId("quick-match-back-link");
    await expect(back).toHaveAccessibleName(qmUi("quickMatch.backToMatch"));
    scanned += await paintedInsideViewport(back, "Back to the quick match");
    await hitFloor(back, "Back to the quick match", 44);
    await back.click();
    await page.waitForURL((u) => u.pathname === home && u.search === "", { timeout: QM_NAV_MS });

    // ── 4. The home again: live, with the rally's point (one to the home side, none to the away side), still fitting ──
    await expect(hero.getByTestId("qm-hero-kicker")).toHaveText(qmUi("quickMatch.home.liveMatch", { n: 1, total: 3 }));
    await expect(hero.getByTestId("qm-hero-score"), "the home reads the rally, not a stale page").toHaveText(QM_AFTER_ONE_HOME_RALLY);
    await expectNoHorizontalScroll(page);
    scanned += await qmNotClipped(page, '[data-testid="qm-home"]', "the home with a live match");

    // ── 5. The save page, signed out ──
    await page.goto(`${home}/save`, { waitUntil: "load" });
    await expect(page.getByTestId("qm-save-title")).toHaveText(qmUi("quickMatch.save.title", { name }));
    await hitFloor(page.getByTestId("qm-save"), "Save this match", 44);
    await hitFloor(page.getByTestId("qm-save-back"), "Back to the match", 44);
    await expectNoHorizontalScroll(page);
    scanned += await qmNotClipped(page, '[data-testid="qm-save-page"]', "the save page");
  } finally {
    await ctx.close();
  }
  expect(scanned, "anti-vacuity: every surface had boxes to scan").toBeGreaterThan(40);
});

test("quick match (saver): signed in, Save; the home's Saved and In your account; /me's Quick matches with Rename and Delete opened, then Delete for everyone, hold at this width", async ({
  browser,
}) => {
  // Four page loads or redirects, a magic-link sign-in (two more), and ~25 local acts.
  test.setTimeout(6 * QM_NAV_MS + 25 * QM_ACT_MS);
  const ctx = await qmGuest(browser);
  let scanned = 0;
  try {
    const page = await ctx.newPage();
    // The longest name the create allows, its tail one unbroken word: the hardest to fit (the 3-width /me case's own name).
    const name = `Mobile me ${TAG}-${projectTag()} ${"Longwordwithoutanybreak".repeat(4)}`.slice(0, 80);
    await qmFillSetup(page, name, [QM_LONG, "Lee & Ana"]);
    const home = await qmStart(page);
    await loginUi(page, `delivered+e2e-qm-mobile-${TAG}-${projectTag()}-${Math.random().toString(36).slice(2, 7)}@resend.dev`, `${home}/save`);
    await expect(page.getByTestId("qm-save-title")).toHaveText(qmUi("quickMatch.save.title", { name }));
    await page.getByTestId("qm-save").click();
    await page.waitForURL((u) => u.pathname === home && u.search === "", { timeout: QM_NAV_MS });

    // The home, saved: "Saved" and the way to the account's list, a 44px target.
    await expect(page.getByTestId("qm-saved")).toHaveText(qmUi("quickMatch.home.saved"));
    await expect(page.getByTestId("qm-save"), "no Save once saved (the positive pair: it was there to press)").toHaveCount(0);
    await hitFloor(page.getByTestId("qm-in-account"), "In your account", 44);
    await expectNoHorizontalScroll(page);
    scanned += await qmNotClipped(page, '[data-testid="qm-home"]', "the saved home");

    // /me: the one row, then Rename's form, then Delete's confirmation, each measured open.
    await page.goto("/me", { waitUntil: "load" });
    const list = '[data-testid="me-quick-matches"]';
    const row = page.locator(list).locator("li[data-qm-id]");
    await expect(row).toHaveCount(1, { timeout: QM_NAV_MS });
    await expect(row.getByTestId("me-qm-name")).toHaveText(name);
    for (const id of ["me-qm-name", "me-qm-rename", "me-qm-delete"]) await hitFloor(row.getByTestId(id), id, 44);
    await expectNoHorizontalScroll(page);
    scanned += await qmNotClipped(page, list, "the Quick matches list");

    await row.getByTestId("me-qm-rename").click();
    await expect(row.getByTestId("me-qm-rename-input")).toHaveValue(name);
    for (const id of ["me-qm-rename-input", "me-qm-rename-save", "me-qm-rename-cancel"]) await hitFloor(row.getByTestId(id), id, 44);
    await expectNoHorizontalScroll(page);
    scanned += await qmNotClipped(page, list, "the Quick matches list, Rename open");
    await row.getByTestId("me-qm-rename-cancel").click();
    await expect(row.getByTestId("me-qm-rename-form"), "Cancel closes the form").toHaveCount(0);

    await row.getByTestId("me-qm-delete").click();
    await expect(row.getByTestId("me-qm-delete-question")).toHaveText(qmUi("quickMatch.me.deleteConfirm"));
    for (const id of ["me-qm-delete-yes", "me-qm-delete-cancel"]) await hitFloor(row.getByTestId(id), id, 44);
    await expectNoHorizontalScroll(page);
    scanned += await qmNotClipped(page, list, "the Quick matches list, Delete's confirmation open");
    await row.getByTestId("me-qm-delete-yes").click();
    await expect(page.locator(list), "the last row deleted, the section goes").toHaveCount(0);
    await expect(page.getByTestId("me-qm-status")).toHaveText(qmUi("quickMatch.me.deleted", { name }));
    await expectNoHorizontalScroll(page);
  } finally {
    await ctx.close();
  }
  expect(scanned, "anti-vacuity: every surface had boxes to scan").toBeGreaterThan(20);
});

// Review m6: one CLOCK sport. Football's pad is the taller one (the clock and its controls over the board), so its pad and
// its way back are measured at this width too. Kept short for the phone legs' clock (e2e.yml timeout-minutes): two sides,
// Start, no goal (the goal dock is scorepad-v3-football.spec.ts's).
test("quick match (football, a clock sport): the pad after Start and its way back hold at this width; the home reads it live", async ({
  browser,
}) => {
  // Four page loads or redirects, the start's hold and the record read back, and ~10 local acts.
  test.setTimeout(4 * QM_NAV_MS + HOLD_MS + QM_NAV_MS + 10 * QM_ACT_MS);
  const ctx = await qmGuest(browser);
  let painted = 0;
  try {
    const page = await ctx.newPage();
    await qmFillSetup(page, `Mobile quick match football ${TAG}-${projectTag()}`, [QM_LONG, QM_LONG_TOO], "football");
    const home = await qmStart(page);
    const hero = page.getByTestId("qm-hero");
    await expect(hero.getByTestId("qm-hero-kicker"), "before Start: up next").toHaveText(qmUi("quickMatch.home.upNext", { n: 1, total: 1 }));
    const fixtureId = (await page.locator('[data-testid="qm-match"][data-next="true"]').getAttribute("data-fixture-id"))!;

    await hero.getByTestId("qm-score").click();
    await page.waitForURL(/\/score\/dl_[A-Za-z0-9_-]+$/, { timeout: QM_NAV_MS });
    await expect(page.getByTestId("scan-confirm")).toBeVisible({ timeout: QM_NAV_MS });
    await page.getByTestId("score-start-match").click();
    await expect(page.locator('[data-role="pad-v3"] [data-role="v3-scorebug"]'), "Start opens football's pad").toBeVisible({ timeout: QM_NAV_MS });
    await expectScorebugNotClipped(page, "the football quick match pad, two long names on it");
    await expectNoHorizontalScroll(page);
    // The start is in the record before anything leaves the pad (the pad may hold it, queue.ts).
    await expect
      .poll(
        async () => {
          const [row] = await withDb(
            (sql) => sql<{ n: number }[]>`select count(*)::int as n from score_events where fixture_id = ${fixtureId} and type = 'core.start'`,
          );
          return row!.n;
        },
        { timeout: HOLD_MS + QM_NAV_MS, message: "the start never reached the ledger" },
      )
      .toBe(1);
    const back = page.getByTestId("quick-match-back-link");
    await expect(back).toHaveAccessibleName(qmUi("quickMatch.backToMatch"));
    painted += await paintedInsideViewport(back, "Back to the quick match (football)");
    await hitFloor(back, "Back to the quick match (football)", 44);
    await back.click();
    await page.waitForURL((u) => u.pathname === home && u.search === "", { timeout: QM_NAV_MS });
    await expect(hero.getByTestId("qm-hero-kicker"), "after Start: live").toHaveText(qmUi("quickMatch.home.liveMatch", { n: 1, total: 1 }));
    await expectNoHorizontalScroll(page);
  } finally {
    await ctx.close();
  }
  expect(painted, "anti-vacuity: the back link's boxes were measured").toBeGreaterThan(0);
});

// Quick match plan 4 Task 5 (docs/superpowers/plans/2026-11-13-quick-match-4-skip-match.md; spec
// docs/superpowers/specs/2026-11-12-quick-match-cancel-and-skip-design.md §6): a row's ⋯ menu and its "Not played" confirm
// sheet are new interactive regions on the guest's home, so this width measures them open: nothing painted off screen or
// clipped, no sideways scroll, every target 44px by hit test, and axe (WCAG A/AA) clean on the open menu and the open sheet,
// each run judging at least one node. Then the skip lands the row Not played with its Put back at this width, and Put back
// returns it. The sheet is a native modal <dialog> (plan D7): a bottom sheet below md, centred from md; either way all of it
// is on screen here. The island must be hydrated before "Not played" is tapped, or the tap posts at once (the no-script
// path) and no sheet opens: React's props key on the <details> is the signal.

/** axe on `selector`, WCAG A/AA: no violation, and the count of nodes it judged (zero judged would pass anything, so it fails). */
async function qmAxeClean(page: Page, selector: string, label: string): Promise<number> {
  expect(await page.locator(selector).count(), `${label}: axe has something to scan`).toBeGreaterThan(0);
  const axe = await new AxeBuilder({ page }).include(selector).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(
    axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    `${label}: axe at ${projectTag()}`,
  ).toEqual([]);
  const judged = axe.passes.reduce((n, p) => n + p.nodes.length, 0);
  expect(judged, `${label}: axe judged nodes`).toBeGreaterThan(0);
  return judged;
}

test("quick match (Not played): a row's ⋯ menu and its confirm sheet hold at this width, 44px and axe-clean; the Not played row and its Put back too", async ({
  browser,
}) => {
  // Two page loads, the skip's and the put back's redirects, and ~40 local acts (axe runs among them).
  test.setTimeout(4 * QM_NAV_MS + 40 * QM_ACT_MS);
  const ctx = await qmGuest(browser);
  let scanned = 0;
  let judged = 0;
  try {
    const page = await ctx.newPage();
    await qmFillSetup(page, `Mobile quick match skip ${TAG}-${projectTag()}`, [QM_LONG, QM_LONG_TOO, "Lee & Ana"]);
    await qmStart(page);
    const next = page.locator('[data-testid="qm-match"][data-next="true"]');
    await expect(next).toHaveCount(1);
    const fixtureId = (await next.getAttribute("data-fixture-id"))!;
    const rowSel = `[data-testid="qm-match"][data-fixture-id="${fixtureId}"]`;
    const row = page.locator(rowSel);
    await expect(row).toHaveAttribute("data-state", "ready");
    await expect
      .poll(() => row.getByTestId("qm-row-menu").evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$"))), {
        timeout: QM_NAV_MS,
        message: "the ⋯ menu never hydrated",
      })
      .toBe(true);

    // ── 1. The ⋯ menu, open: Score and Not played ──
    const toggle = row.getByTestId("qm-row-menu-toggle");
    await hitFloor(toggle, "the row's ⋯", 44);
    await toggle.click();
    const panel = row.getByTestId("qm-row-menu-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("button")).toHaveCount(2);
    await hitFloor(row.getByTestId("qm-menu-score"), "the menu's Score", 44);
    await hitFloor(row.getByTestId("qm-skip"), "Not played", 44);
    scanned += await paintedInsideViewport(panel, "the open ⋯ menu");
    await expectNoHorizontalScroll(page);
    scanned += await qmNotClipped(page, rowSel, "the row, its ⋯ menu open");
    judged += await qmAxeClean(page, `${rowSel} [data-testid="qm-row-menu"]`, "the open ⋯ menu");

    // ── 2. The confirm sheet, open: all of it on screen, its two answers 44px ──
    await row.getByTestId("qm-skip").click();
    const sheetSel = `${rowSel} [data-testid="qm-skip-sheet"]`;
    const sheet = page.locator(sheetSel);
    await expect(sheet, "Not played asks first").toBeVisible();
    await expect(row.getByTestId("qm-skip-body")).toHaveText(qmUi("quickMatch.skip.body"));
    const onScreen = await sheet.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { modal: el.matches(":modal"), top: r.top, bottom: r.bottom, vh: window.innerHeight };
    });
    expect(onScreen.modal, "the sheet is modal").toBe(true);
    expect(onScreen.top >= -0.5 && onScreen.bottom <= onScreen.vh + 0.5, `the sheet is all on screen ${JSON.stringify(onScreen)}`).toBe(true);
    await hitFloor(row.getByTestId("qm-skip-confirm"), "Mark not played", 44);
    await hitFloor(row.getByTestId("qm-skip-keep"), "Keep this match", 44);
    scanned += await paintedInsideViewport(sheet, "the confirm sheet");
    await expectNoHorizontalScroll(page);
    scanned += await qmNotClipped(page, sheetSel, "the confirm sheet");
    judged += await qmAxeClean(page, sheetSel, "the open confirm sheet");
    await row.getByTestId("qm-skip-keep").click();
    await expect(sheet, "Keep closes it").toBeHidden();
    await expect(row, "Keep changed nothing").toHaveAttribute("data-state", "ready");

    // ── 3. Mark not played: the row Not played, its ⋯ holding Put back ──
    await toggle.click();
    await row.getByTestId("qm-skip").click();
    await expect(sheet).toBeVisible();
    await row.getByTestId("qm-skip-confirm").click();
    await expect(row, "the skip landed").toHaveAttribute("data-state", "notPlayed", { timeout: QM_NAV_MS });
    await expect(row.getByTestId("qm-not-played")).toHaveText(qmUi("quickMatch.home.notPlayed"));
    await hitFloor(toggle, "the Not played row's ⋯", 44);
    await toggle.click();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("button"), "Put back only").toHaveCount(1);
    await hitFloor(row.getByTestId("qm-put-back"), "Put back", 44);
    scanned += await paintedInsideViewport(panel, "the Not played row's ⋯ menu");
    await expectNoHorizontalScroll(page);
    scanned += await qmNotClipped(page, '[data-testid="qm-home"]', "the home, a Not played row's ⋯ menu open");
    judged += await qmAxeClean(page, `${rowSel} [data-testid="qm-row-menu"]`, "the Not played row's open ⋯ menu");

    // ── 4. Put back: the match is back to play ──
    await row.getByTestId("qm-put-back").click();
    await expect(row, "Put back landed").toHaveAttribute("data-state", "ready", { timeout: QM_NAV_MS });
    await expect(row.getByTestId("qm-score")).toBeVisible();
    await expectNoHorizontalScroll(page);
  } finally {
    await ctx.close();
  }
  expect(scanned, "anti-vacuity: every open surface had boxes to scan").toBeGreaterThan(40);
  expect(judged, "anti-vacuity: axe judged the open menus and the sheet").toBeGreaterThan(0);
});

// The organiser's /start wizard (start wizard plan 2026-11-13, Task 6) at this width, walked as a visitor walks it: Sport (a
// realistic 49-character event name typed), Size and format with Planning OPEN and More formats unfolded (all five cards),
// the date chips and the date box, the address refused once (its error line showing) and then sent, and Sent. At each step:
// no sideways scroll, nothing clipped inside the wizard (`overflowingIn`; a box that scrolls must be a tab stop, AGENTS.md
// class 23), and the step's controls 44px targets a tap reaches (`hitFloor` hit-tests their edges and centre). Then /play's
// door to it ("Or register to start a season"): it follows the chips, and at its resting place — scrolled to the screen's foot,
// where the docked Start bar sits below 640px — a tap lands on the door, not on the bar. A guest's own context, as the quick
// match cases. After the quick match cases, LAST for the same reason (AGENTS.md class 21): a red here skips nothing after it.
test("start wizard: every step holds at this width with Planning open, and /play's season door is a reachable 44px link that follows the chips", async ({
  browser,
}) => {
  // Three page loads, the start's POST, and ~50 local acts and measurements.
  test.setTimeout(4 * QM_NAV_MS + 50 * QM_ACT_MS);
  const ctx = await qmGuest(browser);
  let scanned = 0;
  let steps = 0;
  try {
    const page = await ctx.newPage();
    const wizard = page.locator("[data-start-wizard]");
    const next = wizard.getByRole("button", { name: `${qmMk("start.wizard.next")} →`, exact: true });
    const hold = async (step: string, label: string): Promise<void> => {
      await expect(wizard).toHaveAttribute("data-step", step);
      await expectNoHorizontalScroll(page);
      scanned += await qmNotClipped(page, "[data-start-wizard]", `the wizard, ${label}`);
      steps += 1;
    };

    // ── Sport ──
    await page.goto("/en/start?sport=football", { waitUntil: "load" });
    await waitForHydration(next);
    await wizard.getByRole("textbox", { name: qmMk("start.wizard.compName") }).fill("The Harbourside Wednesday Night Five-a-Side League");
    await hold("sport", "Sport with a long name");
    await hitFloor(wizard.getByText(qmUi("sport.icehockey"), { exact: true }), "a sport chip", 44);
    await hitFloor(next, "Next (Sport)", 44);
    await next.click();

    // ── Size and format: Planning open, More formats unfolded ──
    await expect(wizard).toHaveAttribute("data-step", "size");
    const entrants = qmMk("start.wizard.entrants");
    await wizard.getByRole("textbox", { name: entrants, exact: true }).fill("12");
    const fold = wizard.locator('button[aria-controls="start-planning"]');
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await wizard.getByRole("textbox", { name: qmMk("start.wizard.courts"), exact: true }).fill("4");
    await wizard.getByRole("textbox", { name: qmMk("start.wizard.hours"), exact: true }).fill("6");
    await wizard.getByRole("button", { name: qmMk("start.wizard.moreFormats"), exact: true }).click();
    await expect(wizard.locator("[data-format-card]"), "the four fixed cards and Double elimination").toHaveCount(5);
    await hold("size", "Size and format, Planning open, five cards");
    await hitFloor(wizard.getByRole("button", { name: qmMk("start.wizard.stepper.more", { label: entrants }), exact: true }), "the size's +", 44);
    await hitFloor(fold, "the Planning fold", 44);
    await hitFloor(wizard.locator('[data-format-card="double_elim"]'), "a format card", 44);
    await wizard.locator('[data-format-card="groups-knockout"]').click();
    await hitFloor(next, "Next (Size and format)", 44);
    await next.click();

    // ── Date: the chips, then the date box opened ──
    await expect(wizard).toHaveAttribute("data-step", "date");
    await hold("date", "Date, the chips");
    const pick = page.locator('input[name="date"][value="pick"]');
    await hitFloor(wizard.locator("label").filter({ has: pick }), "Pick a date…", 44);
    await wizard.locator("label").filter({ has: pick }).click();
    await expect(wizard.locator('input[type="date"]')).toBeVisible();
    await hold("date", "Date, the date box open");
    const firstDay = await page.locator('input[name="date"]').first().getAttribute("value");
    await wizard.locator("label").filter({ has: page.locator(`input[name="date"][value="${firstDay}"]`) }).click();
    await next.click();

    // ── Email: refused once (its error line is the step at its tallest), then sent ──
    await expect(wizard).toHaveAttribute("data-step", "email");
    const email = wizard.getByLabel(qmMk("start.wizard.email"), { exact: true });
    const send = wizard.getByRole("button", { name: `${qmMk("start.wizard.emailMe")} →`, exact: true });
    await email.fill("sam@harbourvale");
    await send.click();
    await expect(wizard.locator("#start-email-error")).toHaveText(qmMk("start.wizard.emailMissingTld"));
    await hold("email", "Email, the address refused");
    await hitFloor(send, "Email me the link", 44);
    await email.fill(`delivered+e2e-mobile-start-${TAG}-${projectTag()}@resend.dev`);
    await send.click();

    // ── Sent ──
    await expect(wizard).toHaveAttribute("data-step", "sent", { timeout: QM_NAV_MS });
    await hold("sent", "Sent");
    await hitFloor(wizard.getByRole("button", { name: qmMk("start.wizard.changeIt"), exact: true }), "Change it", 44);
    await hitFloor(wizard.getByTestId("start-play-link"), "score a quick match", 44);

    // ── /play's season door ──
    await page.goto("/en/play", { waitUntil: "load" });
    const form = page.getByTestId("qm-setup-form");
    await expect(form).toBeVisible({ timeout: QM_NAV_MS });
    await expect(page.getByTestId("qm-start")).toBeDisabled();
    const door = page.getByTestId("qm-register-season");
    await expect(door).toHaveText(qmMk("quickMatch.setup.registerSeason"));
    await form.getByText(qmUi("sport.tennis"), { exact: true }).click();
    await expect(door, "the door follows the chip").toHaveAttribute("href", "/en/start?sport=tennis");
    await hitFloor(door, "Or register to start a season", 44);
    // At its resting place: the door at the screen's foot, where a docked Start bar would cover it if it sat inside the bar.
    const atFoot = await door.evaluate((el) => {
      el.scrollIntoView({ block: "end", inline: "nearest" });
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { reached: at !== null && (at === el || el.contains(at)), hit: at?.closest("[data-testid]")?.getAttribute("data-testid") ?? null };
    });
    expect(atFoot.reached, `at the screen's foot a tap on the door lands on ${atFoot.hit}`).toBe(true);
    // The setup form's own clip scan (the door inside it) is the quick match case's, which folds the docked bar's bleed back.
    await expectNoHorizontalScroll(page);
  } finally {
    await ctx.close();
  }
  expect(steps, "anti-vacuity: every step was held (Sport, Size, Date ×2, Email, Sent)").toBe(6);
  expect(scanned, "anti-vacuity: every step had boxes to scan").toBeGreaterThan(6 * 10);
});
