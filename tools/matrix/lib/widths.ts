// The harness's browser widths, in a LEAF module: no imports at all
// (boundary.test.ts pins that). pairs.ts and results.ts re-export these, so
// every existing import keeps working; the browser path (lib/browser/
// viewports.ts) and results.ts import them from here, so reading a width never
// loads pairs.ts — which pulls in the catalogue, the engine and apps/web's
// match-rules table (W1c Task 3 review, carried into Task 4).

/** apps/web/playwright.config.ts mobile projects (pinned by pairs.test.ts and
 *  viewports.test.ts). */
export const L2_WIDTHS = Object.freeze([320, 360, 375, 390, 430, 768, 834] as const);
export type L2Width = (typeof L2_WIDTHS)[number];

/** Every width a browser case may run at: 1280 first (ruling 39: L1 runs
 *  there), then L2's seven in their own order. */
export const BROWSER_WIDTHS = Object.freeze([1280, ...L2_WIDTHS] as const);
export type BrowserWidth = (typeof BROWSER_WIDTHS)[number];
