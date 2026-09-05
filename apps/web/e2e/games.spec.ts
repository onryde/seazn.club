import { test, expect } from "@playwright/test";

// Seazn Games surface: listing, quest hub, lesson→game launch + persistence,
// free-play arcade, 404s, subdomain rewrite. No fixtures — static registry +
// localStorage.

// Scoped per-card, not a page-wide getByText("Play →") — W4 added Daily Word
// and 2048 as live games, so the listing now shows three "Play →" labels and
// a page-wide text locator hits Playwright's strict-mode violation (multiple
// matches). Each live game's own card link is checked instead.
test("games listing renders every live game's card as playable", async ({ page }) => {
  await page.goto("/games");
  await expect(page.getByRole("heading", { name: "Games", exact: true })).toBeVisible();
  for (const name of [/Chess Quest/, /Daily Word/, /2048/]) {
    const card = page.getByRole("link", { name });
    await expect(card).toBeVisible();
    await expect(card.getByText("Play →")).toBeVisible();
  }
});

test("quest hub shows the map and the Day 1 lesson", async ({ page }) => {
  await page.goto("/games/chess-quest");
  await page.evaluate(() => localStorage.removeItem("seazn-games:chess-quest:v1"));
  await page.reload();
  await expect(page.getByText("First Steps")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Board Land" })).toBeVisible();
});

test("marking a day done persists across a reload", async ({ page }) => {
  await page.goto("/games/chess-quest");
  await page.evaluate(() => localStorage.removeItem("seazn-games:chess-quest:v1"));
  await page.reload();
  await page.getByRole("button", { name: /Mark day done/ }).click();
  await expect(page.getByRole("button", { name: /Done — undo/ })).toBeVisible();
  await page.reload();
  // Day 1 stays done — its map stop shows a check.
  await expect(page.getByRole("button", { name: "Day 1: Board Land" })).toHaveText("✓");
});

test("a lesson launches its mini-game", async ({ page }) => {
  await page.goto("/games/chess-quest");
  await page.getByRole("button", { name: /Play Square Race/ }).click();
  await expect(page.getByRole("button", { name: /Back to quest/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Square Race" })).toBeVisible();
});

// Piece Detective used to share ONE global case pool and ONE progress array
// across lessons 17, 21, 33 and 46: solve the cases in lesson 17 and the other
// three opened already complete, on the same eight positions (the same defect
// PR #690 fixed for Mate in 1 / Mate in 2 and skipped here). Each lesson now
// gets its own slice of HUNTS with its own progress (HangingHunt `range`).
// Proven end to end rather than by a unit test because the slice is wired
// through the lesson card → index.tsx → component, and a unit test on the
// component alone cannot see a dropped prop on that path.
test("Piece Detective lessons do not share cases or progress", async ({ page }) => {
  await page.goto("/games/chess-quest");
  await page.evaluate(() => localStorage.removeItem("seazn-games:chess-quest:v1"));
  await page.reload();
  const boardHtml = () =>
    page.locator("[data-square]").evaluateAll((els) => els.map((e) => e.innerHTML).join("|"));

  // Lesson 17 (Day 33): solve case 1 — HUNTS[0], the loose knight on d7.
  await page.getByRole("button", { name: "Day 33: The Free-Stuff Detector" }).click();
  await page.getByRole("button", { name: /Play Piece Detective/ }).click();
  await expect(page.getByText("0 / 8 cases")).toBeVisible();
  const lesson17Case1 = await boardHtml();
  await page.locator('[data-square="d7"]').click();
  await expect(page.getByText(/Found it/)).toBeVisible();
  await expect(page.getByText("1 / 8 cases")).toBeVisible();

  // Lesson 21 (Day 41) opens fresh, on a different position.
  await page.getByRole("button", { name: /Back to quest/ }).click();
  await page.getByRole("button", { name: "Day 41: Winning the Won Game" }).click();
  await page.getByRole("button", { name: /Play Piece Detective/ }).click();
  await expect(page.getByText("0 / 8 cases")).toBeVisible();
  expect(await boardHtml()).not.toBe(lesson17Case1);

  // And lesson 17 still remembers its own solve.
  await page.getByRole("button", { name: /Back to quest/ }).click();
  await page.getByRole("button", { name: "Day 33: The Free-Stuff Detector" }).click();
  await page.getByRole("button", { name: /Play Piece Detective/ }).click();
  await expect(page.getByText("1 / 8 cases")).toBeVisible();
});

test("free-play arcade lists the eight games and one solves", async ({ page }) => {
  await page.goto("/games/chess-quest");
  await page.getByRole("button", { name: "Free play" }).click();
  await expect(page.getByRole("heading", { name: "Mate in 1" })).toBeVisible();
  await page.getByRole("button", { name: /Mate in 1/ }).click();
  await page.locator('[data-square="e1"]').click();
  await page.locator('[data-square="e8"]').click();
  await expect(page.getByText(/Checkmate/)).toBeVisible();
});

// Inverted, not deleted: this test used to switch the board theme picker to
// "brown" and confirm it survived a reload. Owner ruling 2026-08-27 removed
// the picker entirely (games(chess-quest) PR #660-series, one white/green
// board only) — this stale e2e spec was missed by that wave's unit-test
// inversions and kept failing CI on main until now. It now guards the
// removal end-to-end: no theme control anywhere, no data-theme attribute
// ever, and that holds across a reload.
test("board has no theme control and no data-theme attribute, before or after reload", async ({
  page,
}) => {
  await page.goto("/games/chess-quest");
  await page.evaluate(() => localStorage.removeItem("seazn-games:chess-quest:v1"));
  await page.reload();

  await expect(page.getByLabel("Board theme")).toHaveCount(0);
  await page.getByRole("button", { name: /Play Square Race/ }).click();
  await expect(page.locator(".cq-board")).not.toHaveAttribute("data-theme");
  await page.getByRole("button", { name: "← Back to quest" }).click();
  await expect(page.getByLabel("Board theme")).toHaveCount(0);

  // Survives a reload — still nothing to switch, still no attribute.
  await page.reload();
  await page.getByRole("button", { name: /Play Square Race/ }).click();
  await expect(page.locator(".cq-board")).not.toHaveAttribute("data-theme");
});

test("an Opening Trainer lesson launches and takes the first move", async ({ page }) => {
  await page.goto("/games/chess-quest");
  await page.evaluate(() => localStorage.removeItem("seazn-games:chess-quest:v1"));
  await page.reload();
  await page.getByRole("button", { name: "Free play" }).click();
  await page.getByRole("button", { name: /Opening Trainer/ }).click();
  await expect(page.getByText(/The Italian Game/)).toBeVisible();
  // First learner move in the Italian: e2–e4.
  await page.locator('[data-square="e2"]').click();
  await page.locator('[data-square="e4"]').click();
  await expect(page.locator('[data-square="e4"]')).toHaveAttribute("aria-label", /white pawn/);
});

// Every Track 3 opening must play its whole line to completion. Each step is
// the learner's move plus the SAN the trainer prompts for it — we wait for that
// prompt (which also covers the trainer's auto-reply, and the auto-1.e4 the
// Scandinavian plays before Black's first move) before making the move. Covers
// opponent-ending lines (Italian, Ruy Lopez — the regression), captures
// (Scotch), a learner-ending line (London), and a Black-learner line where the
// trainer moves first (Scandinavian).
const OPENING_WALKTHROUGHS: { day: number; title: string; steps: [string, string, string][] }[] = [
  {
    day: 97,
    title: "The Italian Game",
    steps: [
      ["e2", "e4", "e4"],
      ["g1", "f3", "Nf3"],
      ["f1", "c4", "Bc4"],
    ],
  },
  {
    day: 99,
    title: "The Ruy Lopez",
    steps: [
      ["e2", "e4", "e4"],
      ["g1", "f3", "Nf3"],
      ["f1", "b5", "Bb5"],
    ],
  },
  {
    day: 101,
    title: "The Scotch Game",
    steps: [
      ["e2", "e4", "e4"],
      ["g1", "f3", "Nf3"],
      ["d2", "d4", "d4"],
      ["f3", "d4", "Nxd4"],
    ],
  },
  {
    day: 103,
    title: "The London System",
    steps: [
      ["d2", "d4", "d4"],
      ["g1", "f3", "Nf3"],
      ["c1", "f4", "Bf4"],
    ],
  },
  {
    day: 105,
    title: "The Scandinavian Defense",
    steps: [
      ["d7", "d5", "d5"],
      ["d8", "d5", "Qxd5"],
      ["d5", "a5", "Qa5"],
    ],
  },
];

for (const opening of OPENING_WALKTHROUGHS) {
  test(`Opening Trainer plays ${opening.title} to completion`, async ({ page }) => {
    await page.goto("/games/chess-quest");
    await page.evaluate(() => localStorage.removeItem("seazn-games:chess-quest:v1"));
    await page.reload();
    // Launch the opening from its Track 3 lesson.
    await page.getByRole("button", { name: `Day ${opening.day}: ${opening.title}` }).click();
    await page.getByRole("button", { name: /Play the opening/ }).click();
    await expect(page.getByText(new RegExp(opening.title)).first()).toBeVisible();

    for (const [from, to, san] of opening.steps) {
      // Wait for this move to be prompted (covers the trainer's prior auto-move).
      await expect(page.getByText(san, { exact: true }).first()).toBeVisible();
      await page.locator(`[data-square="${from}"]`).click();
      await page.locator(`[data-square="${to}"]`).click();
    }
    await expect(page.getByText(/you played the whole line/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Play again" })).toBeVisible();
  });
}

test("unknown game slug 404s", async ({ page }) => {
  const res = await page.goto("/games/not-a-game");
  expect(res?.status()).toBe(404);
});

test("games.* host serves the games tree", async ({ browser }) => {
  const ctx = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-host": "games.seazn.club" },
  });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Games", exact: true })).toBeVisible();
  await page.goto("/chess-quest");
  await expect(page.getByRole("banner").getByRole("heading", { name: "Chess Quest" })).toBeVisible();
  await ctx.close();
});

// W2 — drag input. Same flow and same first move (e2-e4) as "an Opening
// Trainer lesson launches and takes the first move" above, but performed as
// a real pointer drag instead of two clicks, over the [data-square] rects —
// proving the board's drag path (Board.tsx's pointer handlers) reaches the
// same onTap the tap path does, not just that the pure reducer behind it is
// correct (see Board.test.tsx's unit/"Rendered" tests for that half).
test("dragging a pawn in the free-play arcade moves it", async ({ page }) => {
  await page.goto("/games/chess-quest");
  await page.evaluate(() => localStorage.removeItem("seazn-games:chess-quest:v1"));
  await page.reload();
  await page.getByRole("button", { name: "Free play" }).click();
  await page.getByRole("button", { name: /Opening Trainer/ }).click();
  await expect(page.getByText(/The Italian Game/)).toBeVisible();

  await expect(page.locator('[data-square="e2"]')).toHaveAttribute("aria-label", /white pawn/);
  const from = (await page.locator('[data-square="e2"]').boundingBox())!;
  const to = (await page.locator('[data-square="e4"]').boundingBox())!;

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect(page.locator('[data-square="e4"]')).toHaveAttribute("aria-label", /white pawn/);
  await expect(page.locator('[data-square="e2"]')).not.toHaveAttribute("aria-label", /white pawn/);
});
