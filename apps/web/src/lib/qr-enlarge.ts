// lib/qr-enlarge.ts — owner ruling D10 (2026-10-04): a Seazn QR opens full screen on one tap, as large as the
// viewport allows, with the screen kept awake while it is open.

/** The gutter on each side of the enlarged QR (D10: "min(viewport width, viewport height) minus a 16 px gutter"). */
export const QR_ENLARGE_GUTTER_PX = 16;
/** The overlay's own layout, reserved so the QR never pushes its caption or itself off a near-square screen, nor runs
 *  under the ✕ (B6 review m-2) — each is a class in `QrEnlargedView`, pinned there by its test: */
/** `gap-3` between the QR and the caption. */
export const QR_ENLARGE_GAP_PX = 12;
/** The caption's width BESIDE the QR in landscape (`landscape:w-40`). */
export const QR_ENLARGE_CAPTION_W_PX = 160;
/** The caption's height UNDER the QR in portrait: two lines of `text-sm` (20 px each). */
export const QR_ENLARGE_CAPTION_H_PX = 40;
/** The ✕'s band at the top: `top-2` (8) + `h-11` (44). The column is centred, so it is kept at the bottom as well. */
export const QR_ENLARGE_CLOSE_BAND_PX = 52;

/** The ROOM the enlarged QR is painted into, in CSS px — derived from the viewport every time, never a constant. D10's
 *  `min(vw, vh) − 2 × 16`, less whatever the caption and the ✕ need on a near-square screen (on a phone and on a
 *  desktop they fit in the free side, and D10's own figure stands). The painted edge is this room SNAPPED to whole
 *  device px per module (`snapQrSize`). Portrait (a square is portrait to CSS) stacks the caption under the QR;
 *  landscape puts it beside. */
export function enlargedQrSize(vw: number, vh: number): number {
  const g = 2 * QR_ENLARGE_GUTTER_PX;
  const room =
    vw > vh
      ? Math.min(vh - g, vw - g - QR_ENLARGE_GAP_PX - QR_ENLARGE_CAPTION_W_PX)
      : Math.min(vw - g, vh - 2 * QR_ENLARGE_CLOSE_BAND_PX - QR_ENLARGE_GAP_PX - QR_ENLARGE_CAPTION_H_PX);
  return Math.max(0, room);
}

/**
 * The CSS px a Seazn QR is painted at inside a box of `available` CSS px: the LARGEST whole number of DEVICE px per
 * module that fits — `modules × k ÷ dpr` — where `modules` is the symbol's edge with its quiet zone (B6 fix round 1,
 * controller ruling I-2). A symbol drawn between two whole scales is read back unreliably: jsQR misses about a third
 * of such sizes, with the logo or without it, and decodes every whole scale. Device px, not CSS px, because that is
 * what a camera sees: at 2× and 3× it is the same as a CSS-px snap or finer, and at 125 % zoom (1.25) a CSS-px snap
 * would still draw uneven modules.
 *
 * Guards: a box with fewer device px than modules has no whole scale, so it is filled unsnapped (never 0, never wider
 * than the box); a missing or broken module count paints the box unsnapped; a broken DPR reads as 1; no box is 0.
 */
export function snapQrSize(available: number, modules: number, dpr = 1): number {
  if (!Number.isFinite(available) || available <= 0) return 0;
  if (!Number.isFinite(modules) || modules <= 0) return available;
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  // The epsilon keeps a float like 2.9999999999 (236 × 1.25 …) from losing a whole scale to rounding.
  const k = Math.floor((available * d) / modules + 1e-9);
  return k >= 1 ? (k * modules) / d : available;
}

type WakeSentinel = { release(): Promise<void> };
type WakeNavigator = { wakeLock?: { request(type: "screen"): Promise<WakeSentinel> } } | undefined;

/** A release that can neither throw nor reject, whatever the sentinel does. */
function releaseQuietly(s: WakeSentinel): void {
  try {
    void Promise.resolve(s.release()).catch(() => {});
  } catch {
    // a sentinel whose release throws synchronously: the lock is the browser's to drop
  }
}

/** Hold a screen wake lock while the overlay is open. Feature-detected: no API, a refused request or a failed release
 *  never throws and never rejects (D10). The disposer also releases a lock that is granted AFTER it ran. */
export function holdScreenWakeLock(nav: WakeNavigator): () => void {
  let disposed = false;
  let sentinel: WakeSentinel | null = null;
  const lock = nav?.wakeLock;
  if (lock && typeof lock.request === "function") {
    Promise.resolve()
      .then(() => lock.request("screen"))
      .then((s) => {
        if (disposed) releaseQuietly(s);
        else sentinel = s;
      })
      .catch(() => {});
  }
  return () => {
    disposed = true;
    if (sentinel) releaseQuietly(sentinel);
    sentinel = null;
  };
}
