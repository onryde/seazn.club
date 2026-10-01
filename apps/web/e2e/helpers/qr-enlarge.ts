// D10 (owner ruling 2026-10-04): every Seazn QR opens full screen on ONE tap — white, as large as the viewport
// allows (min(vw, vh) − 2 × 16 px), the screen kept awake, closed by any tap, a 44-px ✕ or Esc, focus back on the QR.
// One helper for every call site (stream capture, Remote scoring, check-in), so each walkthrough proves the SAME
// behaviour where the person sees it (review R3). The numbers are the ruling's own, never the component's constants.
//
// B6 fix round 1 (controller ruling I-2): every painted size — inline and enlarged — is a WHOLE number of device px per
// module, the largest that fits. The module count is read from the symbol itself (its SVG viewBox, quiet zone
// included) and the DPR from the page, so the expected size is the ruling's arithmetic over what the browser shows.
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

/** D10's gutter, from the ruling's own words ("minus a 16 px gutter"), never `QR_ENLARGE_GUTTER_PX`. */
const RULING_GUTTER_PX = 16;

export type QrClose = "escape" | "x" | "tap";

/** What the open overlay measured — so a caller can screenshot or compare it across viewports. */
export interface QrEnlargedBox {
  vw: number;
  vh: number;
  width: number;
  height: number;
  /** Device px per module of the enlarged symbol. */
  perModule: number;
}

/** The symbol's edge in modules, quiet zone included, read from the SVG data URL the page paints. */
export async function qrModulesOf(img: Locator): Promise<number> {
  const src = (await img.getAttribute("src")) ?? "";
  const svg = decodeURIComponent(src.slice(src.indexOf(",") + 1));
  const m = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  expect(m, "the QR is a Seazn SVG with a viewBox").not.toBeNull();
  expect(m![1], "square").toBe(m![2]);
  return Number(m![1]);
}

/** A painted QR (inline, by its testId) is a WHOLE number of device px per module, at least `minPerModule` — ruling
 *  I-2, and I-1's floor of 3 for the check-in QR. Returns what it measured, for the caller's own figures. */
export async function expectWholeModuleScale(
  page: Page,
  img: Locator,
  opts: { minPerModule?: number; what: string },
): Promise<{ width: number; modules: number; dpr: number; perModule: number }> {
  const modules = await qrModulesOf(img);
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const box = (await img.boundingBox())!;
  const perModule = (box.width * dpr) / modules;
  expect(Math.abs(perModule - Math.round(perModule)), `${opts.what}: ${box.width} CSS px × ${dpr} over ${modules} modules is a whole number of device px per module`).toBeLessThan(0.02);
  expect(Math.round(perModule), `${opts.what}: device px per module`).toBeGreaterThanOrEqual(opts.minPerModule ?? 1);
  expect(Math.abs(box.width - box.height), `${opts.what}: square`).toBeLessThan(0.5);
  return { width: box.width, modules, dpr, perModule: Math.round(perModule) };
}

/** The open overlay's checks: a named modal dialog, the replay block where the QR is sensitive (on the overlay ROOT,
 *  the enlarged image AND the inline one), the ruling's size snapped to whole device px per module, wholly inside the
 *  viewport with its caption, clear of the ✕, the ✕ ≥ 44 px and focused. `nearSquare`: a viewport where the caption's
 *  own room (beside it in landscape, under it in portrait) or the ✕'s band is what bounds the QR, so it is BELOW
 *  D10's figure — there the checks are the fit, the whole scale and no overlap (review m-2). */
export async function expectQrEnlargedOpen(page: Page, testId: string, opts: { sensitive: boolean; nearSquare?: boolean }): Promise<QrEnlargedBox> {
  const overlay = page.getByTestId("qr-enlarged");
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveCount(1);
  await expect(overlay).toHaveAttribute("role", "dialog");
  await expect(overlay).toHaveAttribute("aria-modal", "true");
  await expect(overlay).toHaveAttribute("aria-label", /\S/);
  const img = page.getByTestId("qr-enlarged-img");
  for (const el of [overlay, img, page.getByTestId(testId)]) {
    if (opts.sensitive) await expect(el).toHaveClass(/\bph-no-capture\b/);
    else await expect(el).not.toHaveClass(/\bph-no-capture\b/);
  }
  await expect(img, "the enlarged QR is the inline QR's own symbol").toHaveAttribute("src", (await page.getByTestId(testId).getAttribute("src"))!);
  const { width: vw, height: vh } = page.viewportSize()!;
  const room = Math.min(vw, vh) - 2 * RULING_GUTTER_PX;
  const modules = await qrModulesOf(img);
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  // D10's room, snapped: the largest whole number of device px per module inside min(vw, vh) − 32.
  const want = (modules * Math.floor((room * dpr) / modules)) / dpr;
  // The size is re-read after a resize, so poll it rather than read one frame.
  if (!opts.nearSquare) {
    await expect
      .poll(async () => (await img.boundingBox())!.width, { message: `the enlarged QR is min(${vw}, ${vh}) − 32 snapped to ${modules}-module scales at ${dpr}×` })
      .toBeCloseTo(want, 1);
  } else {
    await expect
      .poll(async () => (await img.boundingBox())!.width, { message: `${vw}×${vh}: the QR gives the caption its room` })
      .toBeLessThan(want);
  }
  const box = (await img.boundingBox())!;
  expect(Math.abs(box.width - box.height), "square").toBeLessThan(1);
  const perModule = (box.width * dpr) / modules;
  expect(Math.abs(perModule - Math.round(perModule)), `${box.width} CSS px is a whole number of device px per ${modules}-module scale`).toBeLessThan(0.02);
  expect(Math.round(perModule), "at least one device px per module").toBeGreaterThanOrEqual(1);
  expect(box.x, "inside the viewport (left)").toBeGreaterThanOrEqual(-0.5);
  expect(box.y, "inside the viewport (top) — review R6").toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width, "inside the viewport (right)").toBeLessThanOrEqual(vw + 0.5);
  expect(box.y + box.height, "inside the viewport (bottom) — review R6").toBeLessThanOrEqual(vh + 0.5);
  const close = page.getByTestId("qr-enlarged-close");
  const cb = (await close.boundingBox())!;
  expect(cb.width, "the ✕ is a 44-px target").toBeGreaterThanOrEqual(44 - 0.5);
  expect(cb.height, "the ✕ is a 44-px target").toBeGreaterThanOrEqual(44 - 0.5);
  // The ✕ is hit where it is painted, not covered by the QR it sits beside.
  const hit = await close.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!at && (at === el || el.contains(at));
  });
  expect(hit, "the ✕ is reachable at its centre").toBe(true);
  // The caption never sits on the QR (review R6), and it is on screen (review m-2); the ✕ never sits on the QR either.
  const caption = overlay.locator("p");
  const capBox = (await caption.boundingBox())!;
  const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  expect(overlap(capBox, box), "the brightness caption does not overlap the QR").toBe(false);
  expect(capBox.x, "the caption is inside the viewport (left) — review m-2").toBeGreaterThanOrEqual(-0.5);
  expect(capBox.y, "the caption is inside the viewport (top)").toBeGreaterThanOrEqual(-0.5);
  expect(capBox.x + capBox.width, "the caption is inside the viewport (right)").toBeLessThanOrEqual(vw + 0.5);
  expect(capBox.y + capBox.height, "the caption is inside the viewport (bottom)").toBeLessThanOrEqual(vh + 0.5);
  expect(overlap(cb, box), "the ✕ does not sit on the QR").toBe(false);
  await expect(close).toBeFocused();
  return { vw, vh, width: box.width, height: box.height, perModule: Math.round(perModule) };
}

/** Close the open overlay one of D10's three ways, and check it is gone and focus is back on the QR's trigger. */
export async function closeQrEnlarged(page: Page, testId: string, how: QrClose): Promise<void> {
  const overlay = page.getByTestId("qr-enlarged");
  if (how === "escape") await page.keyboard.press("Escape");
  else if (how === "x") await page.getByTestId("qr-enlarged-close").click();
  else await page.getByTestId("qr-enlarged-img").click(); // "any tap" — on the QR itself
  await expect(overlay).toHaveCount(0);
  await expect(page.getByTestId(`${testId}-enlarge`)).toBeFocused();
}

/** D10: open a Seazn QR by a single tap, check the overlay, close it (Esc by default), check focus came back. */
export async function expectQrEnlarges(
  page: Page,
  testId: string,
  opts: { sensitive: boolean; close?: QrClose },
): Promise<QrEnlargedBox> {
  const trigger: Locator = page.getByTestId(`${testId}-enlarge`);
  await expect(page.getByTestId(testId)).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
  await trigger.click(); // one tap, never dblclick (a double tap is the browser's zoom)
  const box = await expectQrEnlargedOpen(page, testId, opts);
  await closeQrEnlarged(page, testId, opts.close ?? "escape");
  return box;
}

/**
 * A counting stand-in for the Screen Wake Lock API, installed before the first navigation (review R5): the real API is
 * never exercised by a walkthrough — the owner's phone gate is where it is real. `"absent"` deletes it instead, the
 * no-API path every browser without it takes.
 */
export async function installWakeLockStub(page: Page, mode: "counting" | "absent"): Promise<void> {
  await page.addInitScript((m) => {
    const w = { requests: 0, releases: 0 };
    (window as unknown as { __wake: typeof w }).__wake = w;
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value:
        m === "absent"
          ? undefined
          : {
              request: async () => {
                w.requests++;
                return {
                  release: async () => {
                    w.releases++;
                  },
                };
              },
            },
    });
  }, mode);
}

/** A crop of `target` (a QR, inline or enlarged) with `pad` px around it, clipped to the viewport — the visual
 *  evidence. Written to `VISUAL_DIR` when a run collects them, else the test's own output dir. */
export async function shotQr(page: Page, target: Locator, name: string, pad = 16): Promise<string> {
  await target.scrollIntoViewIfNeeded();
  const b = (await target.boundingBox())!;
  const vp = page.viewportSize()!;
  const x = Math.max(0, b.x - pad);
  const y = Math.max(0, b.y - pad);
  const path = join(process.env.VISUAL_DIR ?? test.info().outputPath(), name);
  await page.screenshot({
    path,
    clip: { x, y, width: Math.min(vp.width, b.x + b.width + pad) - x, height: Math.min(vp.height, b.y + b.height + pad) - y },
  });
  return path;
}

/** The counting stub's tallies (see `installWakeLockStub`). */
export async function wakeLockCounts(page: Page): Promise<{ requests: number; releases: number }> {
  return page.evaluate(() => ({ ...(window as unknown as { __wake: { requests: number; releases: number } }).__wake }));
}
