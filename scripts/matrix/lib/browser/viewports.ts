// Width → viewport for every browser case. The seven L2 sizes are the
// product's own e2e matrix (apps/web/playwright.config.ts:190-262); 1280 is
// the bench's organiser viewport (scorer.ts ORGANISER_VIEWPORT; ruling 39 runs
// L1 there). viewports.test.ts reads both as the authority. The widths come
// from the leaf widths.ts, so this module never loads pairs.ts or results.ts
// (boundary.test.ts pins that).
import { BROWSER_WIDTHS, type BrowserWidth } from "../widths.ts";

export { BROWSER_WIDTHS } from "../widths.ts";
export type { BrowserWidth } from "../widths.ts";

export interface Viewport { readonly width: number; readonly height: number }

const vp = (width: number, height: number): Viewport => Object.freeze({ width, height });

export const VIEWPORT: Readonly<Record<BrowserWidth, Viewport>> = Object.freeze({
  1280: vp(1280, 900),   // bench ORGANISER_VIEWPORT
  320: vp(320, 568),     // mobile-320
  360: vp(360, 800),     // mobile-360
  375: vp(375, 667),     // mobile-se
  390: vp(390, 844),     // mobile-14
  430: vp(430, 932),     // mobile-430
  768: vp(768, 1024),    // tablet-768
  834: vp(834, 1194),    // tablet-834
});

export class UnknownWidth extends Error {
  readonly width: number;
  constructor(width: number) {
    super(`viewports: ${width} is not a browser width (declared: ${BROWSER_WIDTHS.join(", ")})`);
    this.name = "UnknownWidth";
    this.width = width;
  }
}

/** The viewport for a width; refuses one the harness does not declare (a
 *  typo'd CLI width would otherwise open a context with no viewport at all). */
export function viewportFor(width: number): Viewport {
  if (!(BROWSER_WIDTHS as readonly number[]).includes(width)) throw new UnknownWidth(width);
  return VIEWPORT[width as BrowserWidth];
}
