// The moment slab's visual gate (stream overlay W2 Task 5).
//
// A CAPTURE HARNESS, not a spec: `.capture.ts` falls outside every other
// project's `testMatch`, and the `GALLERY_DIR` guard below makes it a no-op
// without one. Run it deliberately:
//
//   GALLERY_DIR=/tmp/slab PLAYWRIGHT_BASE=http://localhost:PORT E2E_PROD_TARGET=1 \
//     pnpm exec playwright test --project=gallery e2e/overlay-moments.capture.ts
//
// WHY IT IS COMMITTED. W1's overlay contact sheet was produced ad hoc and left
// no way to reproduce it, so W2 re-derived the whole rig. This file is the
// answer to that: the scenes are named, the ledger that produces each one is
// written down, and the next wave re-shoots rather than re-invents.
//
// THE GATE HAS ITS OWN VACUOUS MODE (AGENTS.md class 10): a harness that errors
// before the first screenshot, or that captures the same picture twice, will
// collect a sign-off on nothing. So every scene asserts the DOM state it is
// photographing in the same step, and the final check asserts the files exist,
// are non-empty, and DIFFER from one another byte-for-byte.
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { apiJson } from "./helpers";
import {
  seedCricketOverlayFixture,
  seedFootballOverlayFixture,
  seedHockeyGoalOverlayFixture,
  seedOverlayFixture,
  sendEvent,
} from "./overlay-kit";
import { OVERLAY_MOMENT_FOLD_MS } from "../src/components/overlay/moment-timing";

const DIR = process.env.GALLERY_DIR ?? "";
test.skip(!DIR, "set GALLERY_DIR to capture");
test.describe.configure({ mode: "serial" });

const shots: string[] = [];

/** Waits for the slab to be SETTLED, never merely present.
 *
 *  `data-phase="hold"` flips when the state machine says so — which is when the
 *  CSS transition STARTS, not when it ends. Every screenshot taken on the
 *  attribute alone was a motion frame, and a slab halfway out from behind the
 *  scorebug photographs exactly like one whose text overflows. That cost an
 *  hour and a wrong bug report. */
async function settled(page: Page): Promise<void> {
  const slab = page.locator('[data-testid="overlay-moment"]');
  await expect(slab).toHaveAttribute("data-phase", "hold", { timeout: 40_000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="overlay-moment"]');
      if (!el) return false;
      const t = getComputedStyle(el).transform;
      return t === "none" || t === "matrix(1, 0, 0, 1, 0, 0)";
    },
    undefined,
    { timeout: OVERLAY_MOMENT_FOLD_MS + 10_000 },
  );
}

async function shoot(page: Page, name: string): Promise<void> {
  mkdirSync(DIR, { recursive: true });
  const path = join(DIR, `${name}.png`);
  await page.screenshot({ path });
  shots.push(path);
}

test("cricket — six and out, on the bar", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const rig = await seedCricketOverlayFixture(page);
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: { width: 1920, height: 1080 },
  });
  const view = await ctx.newPage();
  await view.goto(`/overlay/fixtures/${rig.fixtureId}?style=bar`);
  const slab = view.locator('[data-testid="overlay-moment"]');
  await expect(slab, "nothing replays on mount").toHaveCount(0);

  const ball = (ballInOver: number, extra: Record<string, unknown>) =>
    sendEvent(page.request, rig.fixtureId, "cricket.ball", {
      over: 0,
      ballInOver,
      striker: rig.offenderIds[1],
      nonStriker: rig.offenderIds[0],
      bowler: rig.offenderIds[2],
      ...extra,
    });

  await ball(4, { runs: { bat: 6 }, boundary: 6 });
  await settled(view);
  await expect(slab).toHaveAttribute("data-kind", "six");
  await shoot(view, "cricket-bar-six");
  await expect(slab).toHaveCount(0, { timeout: 40_000 });

  await ball(5, {
    runs: { bat: 0 },
    wicket: { kind: "caught", out: rig.offenderIds[1], fielder: rig.offenderIds[2], bowlerCredited: true },
  });
  await settled(view);
  await expect(slab).toHaveAttribute("data-tone", "dismissal");
  // The batter's line and the crease band in ONE frame — the wave's two
  // surfaces together, which is what a reviewer actually needs to judge.
  await expect(slab).toContainText("(");
  await shoot(view, "cricket-bar-out");
  await ctx.close();
});

test("hockey — goal and red card, on the bug", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const rig = await seedOverlayFixture(page);
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: { width: 1920, height: 1080 },
  });
  const view = await ctx.newPage();
  await view.goto(`/overlay/fixtures/${rig.fixtureId}?style=bug`);
  const slab = view.locator('[data-testid="overlay-moment"]');

  await sendEvent(page.request, rig.fixtureId, "hockey.goal", { by: rig.homeEntrantId });
  await settled(view);
  await expect(slab).toHaveAttribute("data-tone", "led");
  await shoot(view, "hockey-bug-goal");
  await expect(slab).toHaveCount(0, { timeout: 40_000 });

  await sendEvent(page.request, rig.fixtureId, "hockey.suspension.start", {
    by: rig.awayEntrantId,
    class: "red",
  });
  await settled(view);
  await expect(slab).toHaveAttribute("data-tone", "dismissal");
  await shoot(view, "hockey-bug-red");
  await ctx.close();
});

test("football — a penalty goal names its taker AND says penalty, on the bar", async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  // Owner ruling 28 (2026-09-11). Football reaches this slab through
  // `penalty: true`; ruling 31 the same day gave the period sports parity
  // through `kind`, so the hockey scene below is this one's twin and the two
  // must be judged together.
  const rig = await seedFootballOverlayFixture(page);
  const taker = rig.offenderIds[0];
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: { width: 1920, height: 1080 },
  });
  const view = await ctx.newPage();
  await view.goto(`/overlay/fixtures/${rig.fixtureId}?style=bar`);
  const slab = view.locator('[data-testid="overlay-moment"]');

  await sendEvent(page.request, rig.fixtureId, "football.goal", {
    by: rig.homeEntrantId,
    scorer: taker,
    penalty: true,
  });
  await settled(view);
  await expect(slab).toHaveAttribute("data-kind", "goal");
  await expect(slab).toHaveAttribute("data-tone", "led");

  // BOTH halves, asserted as a shape rather than as a literal. The defect this
  // scene exists for put the bare word on the line ALONE, which still "mentions
  // a penalty" — so the assertion has to see a name in front of it. The name
  // itself is whatever the public-site consent resolver returns (initialled, as
  // every other name on air is), so it is never hard-coded here.
  const line = view.locator('[data-testid="overlay-moment-line"]');
  await expect(line).toHaveText(/\S.*·\s*Penalty$/);

  await shoot(view, "football-bar-penalty");
  await ctx.close();
});

test("hockey — a penalty stroke names its taker AND says stroke, on the bar", async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  // Ruling 31 (2026-09-11), the period sports' parity with ruling 28. Before
  // it, `PeriodGoal` had no `penalty` field and nothing read `kind`, so the one
  // goal in field hockey that most deserves a name reached air as a bare name
  // and was indistinguishable from one scored in open play.
  const rig = await seedHockeyGoalOverlayFixture(page);
  const taker = rig.offenderIds[0];
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: { width: 1920, height: 1080 },
  });
  const view = await ctx.newPage();
  await view.goto(`/overlay/fixtures/${rig.fixtureId}?style=bar`);
  const slab = view.locator('[data-testid="overlay-moment"]');
  const line = view.locator('[data-testid="overlay-moment-line"]');

  // OPEN PLAY FIRST, and photographed: without it "the line says stroke" would
  // be satisfied by a build that put a set piece on every goal.
  await sendEvent(page.request, rig.fixtureId, "hockey.goal", {
    by: rig.homeEntrantId,
    person: taker,
  });
  await settled(view);
  await expect(slab).toHaveAttribute("data-kind", "goal");
  await expect(line, "an open-play goal must carry the name ALONE").not.toHaveText(/·/);
  await shoot(view, "hockey-bar-goal-openplay");
  await expect(slab).toHaveCount(0, { timeout: 40_000 });

  await sendEvent(page.request, rig.fixtureId, "hockey.goal", {
    by: rig.homeEntrantId,
    person: taker,
    kind: "stroke",
  });
  await settled(view);
  await expect(slab).toHaveAttribute("data-tone", "led");
  // Both halves, as a shape. The name is whatever the consent resolver returns
  // and is never hard-coded; the suffix is the English dictionary's own words
  // for `overlay.moment.goalKind.stroke`.
  await expect(line).toHaveText(/\S.*·\s*Penalty stroke$/);
  await shoot(view, "hockey-bar-penalty-stroke");
  await ctx.close();
});

test("§1's ladder — a name the cell cannot hold falls to its three-letter code", async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  // W2-F45. `_THEMES.md` §1: "a name longer than the cell can hold at 45 px
  // falls to the entrant's short name, then to the three-letter code; this is
  // the only size step." W1 rendered `side.name` unconditionally, so at
  // 1920×1080 the home name ran 376 px past its cell (339→1438 in 297→1062),
  // the home SCORE painted inside the away cell, and the away name reached
  // 2000 — across the brand mark at 1708 and off the canvas.
  //
  // BOTH SIDES LONG, because that is the only arrangement that reproduces it:
  // with one long name and one short one the long side simply grows and the
  // short one shrinks, and nothing spills (measured, `stream-overlay.spec.ts`).
  // This is therefore the frame to sign off — the one the defect lived in.
  const rig = await seedFootballOverlayFixture(page);
  for (const [id, name] of [
    [rig.homeEntrantId, "Royal Kingsbridge & Wandsworth Wanderers Athletic Club Reserves"],
    [rig.awayEntrantId, "Northbridge Athletic & Riverside Wanderers Reserve XI"],
  ] as const) {
    // Before the first public read: `getPublicFixture` caches for 30 s and the
    // overlay page takes its entrant names from it.
    const res = await apiJson(page.request, `/api/v1/entrants/${id}`, "PATCH", {
      display_name: name,
    });
    if (res.status >= 300) throw new Error(`ladder scene: PATCH -> ${res.status}`);
  }
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: { width: 1920, height: 1080 },
  });
  const view = await ctx.newPage();
  await view.goto(`/overlay/fixtures/${rig.fixtureId}?style=bar`);

  const home = view.locator('[data-testid="ovl-side-home"] [data-testid="ovl-team-name"]');
  const away = view.locator('[data-testid="ovl-side-away"] [data-testid="ovl-team-name"]');
  await expect(home).toBeVisible({ timeout: 30_000 });
  await expect(home).toHaveText("ROY", { timeout: 15_000 });
  // Different codes, so the picture cannot be of a bar showing one side twice.
  // The "a name that fits is left alone" pair is the spec's, not a scene: it
  // needs a second fixture and would photograph as an ordinary bar.
  await expect(away).toHaveText("NOR");
  await shoot(view, "bar-name-ladder");
  await ctx.close();
});

test("reduced motion — the slab still appears, it just does not slide", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const rig = await seedOverlayFixture(page);
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: { width: 1920, height: 1080 },
    reducedMotion: "reduce",
  });
  const view = await ctx.newPage();
  await view.goto(`/overlay/fixtures/${rig.fixtureId}?style=bug`);
  await sendEvent(page.request, rig.fixtureId, "hockey.goal", { by: rig.homeEntrantId });
  await settled(view);
  await shoot(view, "hockey-bug-goal-reduced");
  await ctx.close();
});

test.afterAll(() => {
  if (!DIR) return;
  // The gate's own vacuous modes, both closed here: no file, an empty file, or
  // several identical pictures.
  expect(shots.length, "no scene captured — the harness errored before shooting").toBeGreaterThan(8);
  const digests = new Map<string, string>();
  for (const path of shots) {
    expect(existsSync(path), `${path} was never written`).toBe(true);
    const bytes = readFileSync(path);
    expect(bytes.byteLength, `${path} is empty`).toBeGreaterThan(1_000);
    digests.set(path, createHash("sha256").update(bytes).digest("hex"));
  }
  expect(
    new Set(digests.values()).size,
    `identical captures: ${[...digests].map(([p, d]) => `${p}=${d.slice(0, 8)}`).join(" ")}`,
  ).toBe(shots.length);
});
