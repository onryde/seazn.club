// D10 (owner ruling 2026-10-04): every Seazn QR opens full screen on ONE tap — white, as large as the viewport
// allows (min(vw, vh) − 2 × 16 px), the screen kept awake, closed by any tap, a 44-px ✕ or Esc, focus back on the QR.
// One helper for every call site (stream capture, Remote scoring, check-in), so each walkthrough proves the SAME
// behaviour where the person sees it (review R3). The numbers are the ruling's own, never the component's constants.
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
}

/** The open overlay's checks: a named modal dialog, the replay block where the QR is sensitive (on the overlay ROOT,
 *  the enlarged image AND the inline one), the ruling's size, wholly inside the viewport, the ✕ ≥ 44 px and focused. */
export async function expectQrEnlargedOpen(page: Page, testId: string, opts: { sensitive: boolean }): Promise<QrEnlargedBox> {
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
  const want = Math.min(vw, vh) - 2 * RULING_GUTTER_PX;
  // The size is re-read after a resize, so poll it rather than read one frame.
  await expect.poll(async () => (await img.boundingBox())!.width, { message: `the enlarged QR is min(${vw}, ${vh}) − 32` }).toBeCloseTo(want, 0);
  const box = (await img.boundingBox())!;
  expect(Math.abs(box.width - box.height), "square").toBeLessThan(1);
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
  // The caption never sits on the QR (review R6): their boxes do not overlap.
  const caption = overlay.locator("p");
  const capBox = (await caption.boundingBox())!;
  const overlaps = capBox.x < box.x + box.width && box.x < capBox.x + capBox.width && capBox.y < box.y + box.height && box.y < capBox.y + capBox.height;
  expect(overlaps, "the brightness caption does not overlap the QR").toBe(false);
  await expect(close).toBeFocused();
  return { vw, vh, width: box.width, height: box.height };
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
