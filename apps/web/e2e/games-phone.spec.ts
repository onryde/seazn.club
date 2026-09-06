import { test, expect, type Browser, type Page } from "@playwright/test";
import { TACTICS } from "../src/games/chess-quest/content/puzzles";

// Phone composition for the Seazn Games surface (design of record: Option 1,
// owner-approved 2026-09-05 — "board first, picks in a sheet"). Every games
// page used to be the desktop column shrunk to 320px: same controls, same
// order, smaller type. These tests drive the composed phone view LIVE at
// 320×568 and compare its visible control SET against 1280 — the owner's
// test for "composed, not shrunk" is that the sets differ (dropped, merged,
// re-ordered, or moved into a sheet), never that boxes are smaller.
//
// Viewport is set per test rather than per project so one spec proves both
// branches of the same DOM (`max-md:*` / `md:hidden`) on one page state.

const PHONE = { width: 320, height: 568 };
const DESKTOP = { width: 1280, height: 800 };
const STORAGE_KEY = "seazn-games:chess-quest:v1";

// The site-wide cookie banner is a fixed bottom panel: at phone widths it
// sits exactly over the sticky thumb bar and intercepts every click there.
// A fresh context has no consent stored, so dismiss it before driving.
async function dismissConsent(page: Page) {
  const reject = page.getByRole("button", { name: /^Reject$/ }).first();
  if (await reject.isVisible().catch(() => false)) {
    await reject.click();
    await expect(reject).toBeHidden();
  }
}

async function freshHub(page: Page) {
  await page.goto("/games/chess-quest");
  await page.evaluate((k) => localStorage.removeItem(k), STORAGE_KEY);
  await page.reload();
  await expect(page.getByText("First Steps").first()).toBeVisible();
  await dismissConsent(page);
}

async function openArcadeGame(page: Page, name: RegExp) {
  await freshHub(page);
  await page.getByRole("button", { name: "Free play" }).click();
  await page.getByRole("button", { name }).first().click();
  await expect(page.locator(".cq-board")).toBeVisible();
}

// The visible, named controls on the page in DOM order — board squares
// excluded (64 identical taps at every width would swamp the diff).
async function visibleControlNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("button, a[href], [role=tab]"))
      .filter((el) => {
        if (el.closest("[data-square]")) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      })
      .map((el) => (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim()),
  );
}

async function pageOverflowPx(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

// Hit-test, not paint: the centre of the box must resolve to the control
// itself, so nothing (a sticky bar, a scrim, a banner) sits on top of it.
async function hitTestName(page: Page, box: { x: number; y: number; width: number; height: number }) {
  return page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("button, a[href]");
      return (el?.getAttribute("aria-label") || el?.textContent || "").replace(/\s+/g, " ").trim();
    },
    [box.x + box.width / 2, box.y + box.height / 2] as const,
  );
}

const boardHtml = (page: Page) =>
  page.locator("[data-square]").evaluateAll((els) => els.map((e) => e.innerHTML).join("|"));

// The control-set diff runs each width in its OWN browser context (the hub
// persists the selected lesson and progress in localStorage, so a resized
// page would carry phone-side state into the desktop reading). The resize
// checks inside each test still prove both branches of the one DOM.
async function controlSetInFreshContext(
  browser: Browser,
  viewport: { width: number; height: number },
  drive: (page: Page) => Promise<void>,
): Promise<string[]> {
  const ctx = await browser.newContext({ viewport });
  try {
    const page = await ctx.newPage();
    await drive(page);
    return await visibleControlNames(page);
  } finally {
    await ctx.close();
  }
}

test("Trick Shots on a phone: board on the first screen, packs in a sheet, a different control set", async ({
  page,
  browser,
}) => {
  await page.setViewportSize(PHONE);
  await openArcadeGame(page, /Trick Shots/);
  expect(await pageOverflowPx(page), "no horizontal page scroll at 320").toBe(0);

  // The board is the hero: it starts near the top and fits inside 320×568.
  const board = await page.locator(".cq-board").boundingBox();
  expect(board, "board box").not.toBeNull();
  expect(board!.y, "board top at 320").toBeLessThan(200);
  expect(board!.y + board!.height, "board bottom at 320").toBeLessThanOrEqual(PHONE.height);

  // The 17-pack chip wall / tier tabs are gone from the phone view…
  await expect(page.getByRole("tablist", { name: "Trick tiers" })).toBeHidden();
  // …replaced by a 44px Packs button in the thumb bar that nothing overlays.
  const packs = page.getByRole("button", { name: "Packs" });
  await expect(packs).toBeVisible();
  const packsBox = (await packs.boundingBox())!;
  expect(packsBox.height, "Packs button height").toBeGreaterThanOrEqual(44);
  expect(await hitTestName(page, packsBox)).toBe("Packs");
  for (const name of ["Hint", /Start pack over|Restart/]) {
    const b = page.getByRole("button", { name });
    await expect(b).toBeVisible();
    const box = (await b.boundingBox())!;
    expect(box.height, `${String(name)} height`).toBeGreaterThanOrEqual(44);
    expect(box.y + box.height, `${String(name)} inside the first screen`).toBeLessThanOrEqual(PHONE.height);
  }
  const phoneSet = await visibleControlNames(page);

  // The sheet: opens, is a named dialog, closes on Escape, closes on a pick,
  // and the pick actually changes the pack (subtitle follows).
  await packs.click();
  const sheet = page.getByRole("dialog", { name: "Packs" });
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await packs.click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: /The Pin/ }).first().click();
  await expect(sheet).toBeHidden();
  await expect(page.locator('[data-cq="subtitle"]')).toContainText("The Pin");

  // Same page, desktop width: the tier tabs are back and the Packs button is
  // gone (both branches of the one DOM on one state)…
  await page.setViewportSize(DESKTOP);
  await expect(page.getByRole("tablist", { name: "Trick tiers" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Packs" })).toBeHidden();
  // …and in a FRESH desktop context the control SET differs — composed, not shrunk.
  const desktopSet = await controlSetInFreshContext(browser, DESKTOP, (p) =>
    openArcadeGame(p, /Trick Shots/),
  );
  expect(desktopSet).toContain("First tricks");
  expect(phoneSet).not.toContain("First tricks");
  expect(phoneSet).toContain("Packs");
  expect(desktopSet).not.toContain("Packs");
  expect(phoneSet, "phone and desktop control sets must differ").not.toEqual(desktopSet);
});

test("Trick Shots on desktop: tier tabs replace the 17-chip wall, and switching packs resumes the first unsolved case", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await openArcadeGame(page, /Trick Shots/);

  // Tier tabs + ONE chip row: only the active tier's packs are visible.
  const tabs = page.getByRole("tablist", { name: "Trick tiers" });
  await expect(tabs.getByRole("tab")).toHaveCount(5);
  await expect(page.getByRole("button", { name: /The Fork — Master/ })).toBeHidden();
  await page.getByRole("tab", { name: "Master" }).click();
  await expect(page.getByRole("button", { name: /The Fork — Master/ })).toBeVisible();
  await page.getByRole("tab", { name: "First tricks" }).click();

  // Solve fork case 1 with the pack's own solution, then leave and come back:
  // the pack must reopen on case 2 (its first unsolved), not case 1.
  const case1 = await boardHtml(page);
  const sol = TACTICS.fork[0].solution;
  await page.locator(`[data-square="${sol.slice(0, 2)}"]`).click();
  await page.locator(`[data-square="${sol.slice(2, 4)}"]`).click();
  await expect(page.getByText(/Beautifully done/)).toBeVisible();
  await expect(page.getByText(`1 / ${TACTICS.fork.length}`)).toBeVisible();
  await page.getByRole("button", { name: /The Pin/ }).first().click();
  await expect(page.locator('[data-cq="subtitle"]')).toContainText("The Pin");
  await page.getByRole("button", { name: /The Fork/ }).first().click();
  await expect(page.locator('[data-cq="subtitle"]')).toContainText("The Fork");
  await expect(page.getByText(`1 / ${TACTICS.fork.length}`)).toBeVisible();
  expect(await boardHtml(page), "reopened on the first UNSOLVED case, not case 1").not.toBe(case1);
});

test("puzzle games on a phone: a stepper replaces the dot grid, the jump grid lives in a sheet", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await openArcadeGame(page, /Mate in 1/);
  expect(await pageOverflowPx(page)).toBe(0);

  // 24px numbered dots are gone from the phone view; 44px stepper instead.
  await expect(page.getByRole("button", { name: "Puzzle 2", exact: true })).toBeHidden();
  const next = page.getByRole("button", { name: "Next puzzle" });
  await expect(next).toBeVisible();
  expect((await next.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.locator('[data-cq="puzzle-stepper"]')).toContainText(/\b1 of \d+\b/);
  const first = await boardHtml(page);
  await next.click();
  await expect(page.locator('[data-cq="puzzle-stepper"]')).toContainText(/\b2 of \d+\b/);
  expect(await boardHtml(page)).not.toBe(first);

  // Jump grid in the sheet, 44px targets, closes on pick.
  await page.getByRole("button", { name: "Puzzles" }).click();
  const sheet = page.getByRole("dialog", { name: "Puzzles" });
  await expect(sheet).toBeVisible();
  const jump = sheet.getByRole("button", { name: "Go to puzzle 5" });
  expect((await jump.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await jump.click();
  await expect(sheet).toBeHidden();
  await expect(page.locator('[data-cq="puzzle-stepper"]')).toContainText(/\b5 of \d+\b/);

  // Desktop, same state: dot grid back, stepper gone, dot 5 is the current one.
  await page.setViewportSize(DESKTOP);
  await expect(page.getByRole("button", { name: "Next puzzle" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Puzzle 5", exact: true })).toBeVisible();
});

test("quest hub on a phone: today's lesson is on the first screen and only the current land's days are shown", async ({
  page,
  browser,
}) => {
  await page.setViewportSize(PHONE);
  await freshHub(page);
  expect(await pageOverflowPx(page)).toBe(0);

  // Today's lesson (Day 1) and its Play button are within the first screen.
  const play = page.getByRole("button", { name: /Play Square Race/ });
  await expect(play).toBeVisible();
  const playBox = (await play.boundingBox())!;
  expect(playBox.y, "Play button top at 320").toBeLessThan(PHONE.height);
  expect(playBox.height).toBeGreaterThanOrEqual(44);

  // Current land open, the next land collapsed; expanding it reveals its days.
  const day1 = page.getByRole("button", { name: "Day 1: Board Land" });
  await expect(day1).toBeVisible();
  expect((await day1.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const day9 = page.getByRole("button", { name: /^Day 9:/ });
  await expect(day9).toBeHidden();
  const knightForest = page.getByRole("button", { name: /Knight Forest/ });
  await expect(knightForest).toHaveAttribute("aria-expanded", "false");
  await knightForest.click();
  await expect(knightForest).toHaveAttribute("aria-expanded", "true");
  await expect(day9).toBeVisible();
  // Selecting a day in the expanded land swaps the lesson card above it.
  await day9.click();
  await expect(page.getByRole("button", { name: /Play Square Race/ })).toBeHidden();
  const phoneSet = await visibleControlNames(page);

  // Desktop, same DOM: every day chip of every land is visible without expanding.
  await page.setViewportSize(DESKTOP);
  await expect(page.getByRole("button", { name: /^Day 123:/ })).toBeVisible();
  // Fresh desktop context for the set comparison (the hub persists state).
  const desktopSet = await controlSetInFreshContext(browser, DESKTOP, (p) => freshHub(p));
  expect(phoneSet).not.toEqual(desktopSet);
  expect(desktopSet.filter((n) => /^Day \d+:/.test(n)).length).toBe(62);
  expect(phoneSet.filter((n) => /^Day \d+:/.test(n)).length).toBeLessThan(62);
});

// Keyboard behaviour the markup tests cannot see: the sheet takes focus and
// gives it back, Tab stays inside it, the tier tabs move with arrow keys,
// and the land toggle is inert from the keyboard at ≥768 where nothing
// collapses.
test("sheet focus: opens focused, traps Tab, restores focus on Escape", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openArcadeGame(page, /Trick Shots/);
  const packs = page.getByRole("button", { name: "Packs" });
  await packs.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: "Packs" });
  await expect(sheet).toBeVisible();
  const inDialog = () =>
    page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
  await expect.poll(inDialog, { message: "focus moves into the sheet on open" }).toBe(true);
  const focusables = await sheet.locator("button, a[href], [tabindex]:not([tabindex='-1'])").count();
  for (let i = 0; i < focusables + 2; i++) {
    await page.keyboard.press("Tab");
    expect(await inDialog(), `Tab #${i + 1} stays inside the sheet`).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  const restored = await page.evaluate(
    () => (document.activeElement as HTMLElement | null)?.textContent?.trim() ?? "",
  );
  expect(restored, "focus returns to the Packs button").toBe("Packs");
});

test("desktop keyboard: tier tabs move with arrow keys; the land toggle is inert where nothing collapses", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await openArcadeGame(page, /Trick Shots/);
  const first = page.getByRole("tab", { name: "First tricks" });
  await first.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Master" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Master" })).toBeFocused();
  await expect(page.getByRole("button", { name: /The Fork — Master/ })).toBeVisible();
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Win a Piece" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "First tricks" }), "wraps at the end").toHaveAttribute(
    "aria-selected",
    "true",
  );

  await freshHub(page);
  const knightForest = page.getByRole("button", { name: /Knight Forest/ });
  const day9 = page.getByRole("button", { name: /^Day 9:/ });
  await expect(day9).toBeVisible();
  const before = await knightForest.getAttribute("aria-expanded");
  await knightForest.focus();
  await page.keyboard.press("Enter");
  await expect(knightForest).toHaveAttribute("aria-expanded", before ?? "");
  await expect(day9).toBeVisible();
});

// The in-game phone layout at every phone width the mobile matrix covers —
// mobile.spec.ts only sweeps the hub for horizontal scroll, so the sticky
// thumb bar, the board fit and the tap floor would otherwise be proven at
// 320 alone. Each width gets its own context (persisted state).
for (const width of [360, 375, 390, 430]) {
  test(`Trick Shots at ${width}px: board and thumb bar on the first screen, no page overflow`, async ({
    browser,
  }) => {
    const height = width >= 390 ? 844 : 667;
    const ctx = await browser.newContext({ viewport: { width, height } });
    try {
      const page = await ctx.newPage();
      await openArcadeGame(page, /Trick Shots/);
      expect(await pageOverflowPx(page), `overflow at ${width}`).toBe(0);
      const board = (await page.locator(".cq-board").boundingBox())!;
      expect(board.y + board.height, `board bottom at ${width}`).toBeLessThanOrEqual(height);
      for (const name of ["Hint", "Packs", /Start pack over|Restart/]) {
        const b = page.getByRole("button", { name });
        await expect(b).toBeVisible();
        const box = (await b.boundingBox())!;
        expect(box.height, `${String(name)} height at ${width}`).toBeGreaterThanOrEqual(44);
        expect(box.y + box.height, `${String(name)} on the first screen at ${width}`).toBeLessThanOrEqual(height);
        expect(await hitTestName(page, box), `${String(name)} hit-test at ${width}`).toMatch(name);
      }
      await expect(page.getByRole("tablist", { name: "Trick tiers" })).toBeHidden();
    } finally {
      await ctx.close();
    }
  });
}

test("game page header on a phone: one row, attribution rendered once at every width", async ({ page }) => {
  for (const vp of [PHONE, DESKTOP]) {
    await page.setViewportSize(vp);
    await page.goto("/games/chess-quest");
    await dismissConsent(page);
    await expect(page.getByRole("link", { name: /Powered by Seazn Club/ })).toHaveCount(1);
    await expect(page.getByRole("link", { name: /Powered by Seazn Club/ })).toBeVisible();
  }
  await page.setViewportSize(PHONE);
  const back = (await page.getByRole("link", { name: /Games/ }).first().boundingBox())!;
  const title = (await page.getByRole("heading", { level: 1 }).first().boundingBox())!;
  expect(Math.abs(back.y + back.height / 2 - (title.y + title.height / 2)), "back link and title share a row").toBeLessThan(
    12,
  );
  expect(await pageOverflowPx(page)).toBe(0);
});
