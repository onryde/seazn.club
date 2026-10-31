// The overlay readability floor's visual gate (R2007, spec 2026-10-15 §4.5, D9 + D11).
//
// A CAPTURE HARNESS, not a spec: `.capture.ts` falls outside every other project's `testMatch`, and the `GALLERY_DIR`
// guard below makes it a no-op without one. Run it deliberately, once on the base build and once on the branch:
//
//   GALLERY_DIR=/tmp/ovl-before PLAYWRIGHT_BASE=http://localhost:PORT E2E_PROD_TARGET=1 \
//     pnpm exec playwright test --project=gallery e2e/overlay-readability.capture.ts
//
// What it shoots: the two default scorebugs at the size they are authored at (1920×1080), live and ended — cricket on
// the bar, badminton on the bug — through the `?style=` alias, which both the base and the branch read, so the before
// and after pictures come from the same URL. The phone frames (844×475 landscape, 390×219 portrait: the size a viewer
// watching the broadcast in a phone's YouTube app sees the 1920 canvas at) are the same captures scaled down by the
// browser itself, through a 1920-wide canvas transformed into a frame-sized box — never a resized PNG.
//
// With `OVERLAY_GALLERY=1` (a build that has `/admin/overlay-gallery`, i.e. the branch), it also shoots the staff gallery
// at 1280 — the `/admin` width — at each of its three frames, one crop per template × sport of the live cell, plus the
// warming and ended cells of the two default pairs (cricket on the bar, badminton on the bug): spec step 14. R4 S7 adds
// the sponsor cards: every sponsor-slot cell (a live cell, so the live set already holds it) and every scene-carousel
// cell, shot with CSS animations finished so a showing that rotates mid-shot is photographed in place.
//
// THE GATE HAS ITS OWN VACUOUS MODE (AGENTS.md class 10): every scene asserts the DOM state it photographs in the same
// step, and the last test asserts every file exists, is non-empty, and differs from every other one byte for byte.
import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dismissConsent } from "./directory-kit";
import { seedCricketOverlayFixture, seedUndoOverlayFixture, sendEvent, signInStaff } from "./overlay-kit";

const DIR = process.env.GALLERY_DIR ?? "";
test.skip(!DIR, "set GALLERY_DIR to capture");
test.describe.configure({ mode: "serial" });

const CANVAS_W = 1920;
const CANVAS_H = 1080;
/** The two phone frames spec §4.5 names. */
const FRAMES = [
  { name: "844x475", width: 844 },
  { name: "390x219", width: 390 },
] as const;

const shots: string[] = [];
const WITH_GALLERY = process.env.OVERLAY_GALLERY === "1";
/** Gallery crops expected, counted as they are taken (the cell list comes from the page, never from a typed table). */
let galleryExpected = 0;

async function anon(page: Page): Promise<Page> {
  const ctx = await page.context().browser()!.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: { width: CANVAS_W, height: CANVAS_H },
  });
  return ctx.newPage();
}

/** Shoots the overlay at 1920×1080, then the same page scaled into each phone frame. */
async function shoot(page: Page, url: string, name: string, state: "live" | "ended"): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId("ovl-root")).toHaveCount(1);
  if (state === "ended") {
    await expect(page.getByTestId("ovl-slate")).toHaveAttribute("data-slate-state", "ended", { timeout: 40_000 });
  } else {
    await expect(page.getByTestId("ovl-slate")).toHaveCount(0);
  }
  await page.evaluate(() => document.fonts.ready);
  // Let every entrance transition finish: a motion frame photographs like a layout defect.
  await page.waitForTimeout(1_500);
  const full = join(DIR, `${name}-1920x1080.png`);
  await page.screenshot({ path: full, clip: { x: 0, y: 0, width: CANVAS_W, height: CANVAS_H } });
  shots.push(full);

  for (const frame of FRAMES) {
    const scale = frame.width / CANVAS_W;
    const height = Math.round(CANVAS_H * scale);
    // The browser scales the live page: the html element becomes a 1920×1080 canvas transformed into the frame.
    await page.evaluate(
      ({ scale }) => {
        const root = document.documentElement;
        root.style.transformOrigin = "0 0";
        root.style.transform = `scale(${scale})`;
        root.style.background = "#2e6a2d";
      },
      { scale },
    );
    await page.waitForTimeout(300);
    const path = join(DIR, `${name}-${frame.name}.png`);
    await page.screenshot({ path, clip: { x: 0, y: 0, width: frame.width, height } });
    shots.push(path);
    await page.evaluate(() => {
      const root = document.documentElement;
      root.style.transform = "";
      root.style.background = "";
    });
  }
}

test.beforeAll(() => {
  if (DIR) mkdirSync(DIR, { recursive: true });
});

test("cricket on the bar: live, then ended", async ({ page }) => {
  test.setTimeout(240_000);
  // Live: the rostered over (a single, a four, a wide, a wicket) — the bar's crease band and this-over glyphs.
  const live = await seedCricketOverlayFixture(page);
  const viewer = await anon(page);
  await shoot(viewer, `/overlay/fixtures/${live.fixtureId}?style=bar`, "cricket-bar-live", "live");
  await expect(viewer.locator(".ovl-bar")).toHaveCount(1);

  // Ended: a T20 decided by its second innings' summary (the undo e2e's own deciding write).
  const ended = await seedUndoOverlayFixture(page, {
    sportKey: "cricket",
    variantKey: "t20",
    entrantKind: "team",
    prefix: "ovlrc",
  });
  await sendEvent(page.request, ended.fixtureId, "cricket.innings.summary", { runs: 168, wickets: 5, legalBalls: 120 });
  await sendEvent(page.request, ended.fixtureId, "cricket.innings.summary", { runs: 141, wickets: 9, legalBalls: 120 });
  await shoot(viewer, `/overlay/fixtures/${ended.fixtureId}?style=bar`, "cricket-bar-ended", "ended");
  await viewer.context().close();
});

test("badminton on the bug: live, then ended", async ({ page }) => {
  test.setTimeout(240_000);
  const rally = (fixtureId: string, wonBy: string) => sendEvent(page.request, fixtureId, "badminton.rally", { wonBy });

  // Live: game 1 to home 11-7, game 2 under way at 4-6 — two set cells on the bug.
  const live = await seedUndoOverlayFixture(page, {
    sportKey: "badminton",
    variantKey: "short",
    entrantKind: "individual",
    prefix: "ovlrb",
  });
  for (let i = 0; i < 7; i++) {
    await rally(live.fixtureId, live.homeEntrantId);
    await rally(live.fixtureId, live.awayEntrantId);
  }
  for (let i = 0; i < 4; i++) await rally(live.fixtureId, live.homeEntrantId);
  for (let i = 0; i < 4; i++) {
    await rally(live.fixtureId, live.homeEntrantId);
    await rally(live.fixtureId, live.awayEntrantId);
  }
  await rally(live.fixtureId, live.awayEntrantId);
  await rally(live.fixtureId, live.awayEntrantId);
  const viewer = await anon(page);
  await shoot(viewer, `/overlay/fixtures/${live.fixtureId}?style=bug`, "badminton-bug-live", "live");
  await expect(viewer.locator(".ovl-bug")).toHaveCount(1);

  // Ended: home wins 11-7, 11-9.
  const ended = await seedUndoOverlayFixture(page, {
    sportKey: "badminton",
    variantKey: "short",
    entrantKind: "individual",
    prefix: "ovlrb",
  });
  for (let i = 0; i < 7; i++) {
    await rally(ended.fixtureId, ended.homeEntrantId);
    await rally(ended.fixtureId, ended.awayEntrantId);
  }
  for (let i = 0; i < 4; i++) await rally(ended.fixtureId, ended.homeEntrantId);
  for (let i = 0; i < 9; i++) {
    await rally(ended.fixtureId, ended.homeEntrantId);
    await rally(ended.fixtureId, ended.awayEntrantId);
  }
  await rally(ended.fixtureId, ended.homeEntrantId);
  await rally(ended.fixtureId, ended.homeEntrantId);
  await shoot(viewer, `/overlay/fixtures/${ended.fixtureId}?style=bug`, "badminton-bug-ended", "ended");
  await viewer.context().close();
});

test("the staff gallery at each frame: one crop per template × sport (live), and the default pairs' cards", async ({ page }) => {
  test.skip(!WITH_GALLERY, "OVERLAY_GALLERY=1 on a build that has /admin/overlay-gallery");
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInStaff(page);
  // A fresh staff user has no consent choice yet: the banner would sit over the bottom of every crop.
  await dismissConsent(page);
  for (const frame of ["full", "844", "390"] as const) {
    await page.goto(`/admin/overlay-gallery${frame === "full" ? "" : `?frame=${frame}`}`);
    const root = page.getByTestId("overlay-gallery");
    await expect(root).toHaveCount(1, { timeout: 60_000 });
    const declared = Number(await root.getAttribute("data-cell-count"));
    await expect(page.locator("[data-gallery-cell]")).toHaveCount(declared, { timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1_500);
    const live = page.locator('[data-gallery-cell][data-snapshot="live"][data-moment=""]');
    const carousel = page.locator('[data-gallery-cell][data-sponsor-carousel="1"]');
    const keysOf = (els: Element[]) => els.map((el) => (el as HTMLElement).dataset.galleryCell!);
    const carouselKeys = await carousel.evaluateAll(keysOf);
    const sponsorKeys = await page.locator('[data-gallery-cell]:not([data-sponsor-slot=""])').evaluateAll(keysOf);
    // A Set: a reconnecting carousel cell is a live cell too, and must be shot once (the digest gate refuses twins).
    const wanted = [
      ...new Set([
        ...(await live.evaluateAll(keysOf)),
        "bar|cricket|live|warming",
        "bar|cricket|live|ended",
        "bug|badminton|live|warming",
        "bug|badminton|live|ended",
        ...carouselKeys,
      ]),
    ];
    expect(wanted.length, "anti-vacuity").toBeGreaterThan(4);
    expect(sponsorKeys.length, "anti-vacuity: sponsor slot cells").toBeGreaterThan(0);
    expect(carouselKeys.length, "anti-vacuity: carousel cells").toBeGreaterThan(0);
    expect(sponsorKeys.filter((k) => !wanted.includes(k)), "every sponsor slot cell is shot").toEqual([]);
    await expect
      .poll(() => carousel.locator('[data-testid="ovl-sponsor-card"]').count(), { timeout: 30_000 })
      .toBe(carouselKeys.length);
    console.log(`[gallery ${frame}] cells shot: ${wanted.length} (sponsor slots ${sponsorKeys.length}, carousels ${carouselKeys.length})`);
    for (const key of wanted) {
      const cell = page.locator(`[data-gallery-cell="${key}"]`);
      await expect(cell, key).toHaveCount(1);
      const path = join(DIR, `gallery-${frame}-${key.replaceAll("|", "_")}.png`);
      await cell.screenshot({ path, ...(carouselKeys.includes(key) ? { animations: "disabled" as const } : {}) });
      shots.push(path);
      galleryExpected++;
    }
  }
});

test("every capture exists, is non-empty and differs from every other", () => {
  expect(shots.length, "captures taken").toBe(4 * (1 + FRAMES.length) + galleryExpected);
  const digests = new Map<string, string>();
  for (const path of shots) {
    expect(existsSync(path), path).toBe(true);
    const bytes = readFileSync(path);
    expect(bytes.length, path).toBeGreaterThan(1_000);
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(digests.get(digest), `${path} is byte-identical to ${digests.get(digest)}`).toBeUndefined();
    digests.set(digest, path);
  }
  console.log(`captures: ${shots.length}, distinct: ${digests.size}`);
});
