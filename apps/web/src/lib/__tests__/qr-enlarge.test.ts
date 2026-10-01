// D10 (owner ruling 2026-10-04): a Seazn QR opens full screen on one tap, as large as the viewport allows, with the
// screen kept awake while it is open. This file pins the two pure halves — the size rule and the wake-lock disposer.
// The overlay that calls them is `seazn-qr-image.test.tsx`'s (wiring) and the walkthroughs' (the browser).
import { describe, expect, it, vi } from "vitest";
import {
  QR_ENLARGE_CAPTION_H_PX,
  QR_ENLARGE_CAPTION_W_PX,
  QR_ENLARGE_CLOSE_BAND_PX,
  QR_ENLARGE_GAP_PX,
  QR_ENLARGE_GUTTER_PX,
  enlargedQrSize,
  holdScreenWakeLock,
  snapQrSize,
} from "../qr-enlarge";

const flush = () => new Promise((r) => setTimeout(r, 0));
const fakeNav = () => {
  const release = vi.fn(() => Promise.resolve());
  const request = vi.fn<(type: "screen") => Promise<{ release: typeof release }>>(() => Promise.resolve({ release }));
  return { nav: { wakeLock: { request } }, request, release };
};

describe("D10 — tap to enlarge", () => {
  it("the ruling's gutter is 16 px (owner 2026-10-04)", () => {
    expect(QR_ENLARGE_GUTTER_PX).toBe(16);
  });

  it("the enlarged ROOM is DERIVED from the viewport: min(vw, vh) − 2 × gutter, portrait and landscape, phone and desktop", () => {
    // Phone portrait, phone landscape, tablet, desktop: the caption's room (below in portrait, beside in landscape) is
    // free on every one of these, so D10's own words decide the room.
    const viewports: [number, number][] = [[320, 568], [568, 320], [390, 844], [768, 1024], [1280, 800], [1920, 1080]];
    let checked = 0;
    const seen = new Set<number>();
    for (const [vw, vh] of viewports) {
      const got = enlargedQrSize(vw, vh);
      // The ruling's own words, with its own 16: never QR_ENLARGE_GUTTER_PX, which would move with a wrong constant.
      expect(got, `${vw}×${vh}`).toBe(Math.min(vw, vh) - 2 * 16);
      seen.add(got);
      checked++;
    }
    expect(checked).toBe(viewports.length);
    expect(seen.size).toBeGreaterThan(3); // a constant would collapse this to one value
    expect(enlargedQrSize(320, 568), "portrait and landscape agree").toBe(enlargedQrSize(568, 320));
    expect(enlargedQrSize(20, 20)).toBe(0); // never negative
    expect(enlargedQrSize(0, 0)).toBe(0); // the empty viewport
  });

  it("the wake lock is requested on open and RELEASED on close", async () => {
    const { nav, request, release } = fakeNav();
    const dispose = holdScreenWakeLock(nav);
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("screen");
    expect(release).not.toHaveBeenCalled();
    dispose();
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("a second close releases nothing more (the disposer is idempotent)", async () => {
    const { nav, release } = fakeNav();
    const dispose = holdScreenWakeLock(nav);
    await flush();
    dispose();
    dispose();
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("a lock granted AFTER close is released the moment it arrives", async () => {
    const { nav, request, release } = fakeNav();
    const dispose = holdScreenWakeLock(nav);
    dispose(); // closed before the request resolved
    await flush();
    expect(request, "premise: the request was made").toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("open → close → open again: each opening holds its OWN lock and releases it", async () => {
    const { nav, request, release } = fakeNav();
    const first = holdScreenWakeLock(nav);
    await flush();
    first();
    await flush();
    const second = holdScreenWakeLock(nav);
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(release, "the reopened lock is held").toHaveBeenCalledTimes(1);
    second();
    await flush();
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("no crash when navigator.wakeLock is undefined, when navigator is undefined, and when the request or the release rejects", async () => {
    let checked = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      for (const nav of [
        undefined,
        {},
        { wakeLock: undefined },
        { wakeLock: { request: () => Promise.reject(new Error("NotAllowedError")) } },
        { wakeLock: { request: () => { throw new Error("sync throw"); } } },
        { wakeLock: { request: () => Promise.resolve({ release: () => Promise.reject(new Error("gone")) }) } },
      ]) {
        let dispose: () => void = () => {};
        expect(() => { dispose = holdScreenWakeLock(nav as never); }).not.toThrow();
        await flush();
        expect(() => dispose()).not.toThrow();
        await flush();
        checked++;
      }
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled, "no rejection escaped").toEqual([]);
    expect(checked).toBe(6);
  });
});

// B6 fix round 1, controller ruling I-2: a symbol painted between two whole module scales is read back unreliably (jsQR
// misses about a third of such sizes, logo or not), and every whole scale decodes. So the painted size is snapped to a
// whole number of DEVICE px per module — CSS size = modules × k ÷ DPR — the largest k that fits.
describe("snapQrSize — the largest whole number of device px per module that fits (ruling I-2)", () => {
  it("the figures the sheet and the review record, each worked from the rule's own arithmetic", () => {
    // [available CSS px, modules incl. the quiet zone, DPR, expected CSS px, how]
    const rows: [number, number, number, number, string][] = [
      [363, 113, 1, 339, "3 × 113 — the stream at 1280 (§8a's cap)"],
      [236, 113, 1, 226, "2 × 113 — the stream at 320 (fixture page)"],
      [172, 113, 1.25, 113 / 1.25, "1 × 113 device px ÷ 1.25 — 320 @ 125 % zoom (215 device px fit one, not two)"],
      [236, 113, 2, 452 / 2, "4 × 113 device px on a 2× phone"],
      [236, 113, 3, 678 / 3, "6 × 113 device px on a 3× phone (708 device px fit six)"],
      [291, 113, 3, 791 / 3, "7 × 113 device px ÷ 3 — finer than a CSS-px snap (which would give 226)"],
      [240, 57, 1, 228, "4 × 57 — Remote scoring under its 240 cap"],
      [280, 89, 1, 267, "3 × 89 — the check-in QR in the 320 dialog: three px per module"],
      [288, 113, 1, 226, "2 × 113 — the stream enlarged at 320 × 568"],
      [768, 113, 1, 678, "6 × 113 — the stream enlarged at 1280 × 800"],
    ];
    let checked = 0;
    for (const [available, modules, dpr, want, how] of rows) {
      expect(snapQrSize(available, modules, dpr), how).toBeCloseTo(want, 9);
      checked++;
    }
    expect(checked).toBe(rows.length);
  });

  it("property: for any box, module count and DPR, the result is whole device px per module, fits, and is the LARGEST that does", () => {
    let checked = 0;
    let snapped = 0;
    const dprs = [1, 1.25, 1.5, 2, 2.625, 3];
    for (let modules = 21; modules <= 185; modules += 4) {
      for (let available = 40; available <= 900; available += 37) {
        for (const dpr of dprs) {
          const got = snapQrSize(available, modules, dpr);
          checked++;
          expect(got, "fits its box").toBeLessThanOrEqual(available + 1e-9);
          if (available * dpr < modules) {
            // Fewer device px than modules: no whole scale exists, so the box is filled unsnapped (never 0, never wider).
            expect(got).toBe(available);
            continue;
          }
          snapped++;
          const k = (got * dpr) / modules;
          expect(Math.abs(k - Math.round(k)), `${available}/${modules}@${dpr}: whole device px per module`).toBeLessThan(1e-9);
          expect(Math.round(k)).toBeGreaterThanOrEqual(1);
          expect(got + modules / dpr, "one more module of scale would not fit").toBeGreaterThan(available);
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(snapped, "the snapped branch was exercised, not just the fallback").toBeGreaterThan(checked / 2);
  });

  it("guards: no box, no modules or a broken DPR never paint wider than the box, never negative, never NaN", () => {
    expect(snapQrSize(0, 113, 1)).toBe(0);
    expect(snapQrSize(-5, 113, 1)).toBe(0);
    expect(snapQrSize(236, 0, 1), "no module count: the box, unsnapped").toBe(236);
    expect(snapQrSize(236, Number.NaN, 1)).toBe(236);
    expect(snapQrSize(236, 113, 0), "a zero DPR reads as 1").toBe(226);
    expect(snapQrSize(236, 113, Number.NaN), "a NaN DPR reads as 1").toBe(226);
    expect(snapQrSize(Number.POSITIVE_INFINITY, 113, 1), "an unbounded box is no box").toBe(0);
  });
});

// m-2 (B6 review): the caption needs room too. In landscape it sits BESIDE the QR, in portrait UNDER it, and the ✕ sits
// in the top-right corner — so on a near-square viewport, D10's min(vw, vh) − 32 alone overflows (1024 × 960 put the
// QR's left edge at about −12 px) or runs the QR under the ✕. The room keeps all three on screen.
describe("enlargedQrSize — the caption's and the ✕'s room on a near-square viewport (review m-2)", () => {
  it("the reserved room is the overlay's own layout: a 12 px gap, a 160 px caption beside, two 20 px lines under, a 52 px ✕ band", () => {
    expect(QR_ENLARGE_GAP_PX).toBe(12); // gap-3
    expect(QR_ENLARGE_CAPTION_W_PX).toBe(160); // landscape:w-40
    expect(QR_ENLARGE_CAPTION_H_PX).toBe(40); // two lines of text-sm (line height 20 px)
    expect(QR_ENLARGE_CLOSE_BAND_PX).toBe(52); // the ✕'s h-11 (44) below its top-2 (8)
  });

  it("near-square and square viewports: the QR, the gap and the caption fit across (landscape) or down (portrait), clear of the ✕", () => {
    const viewports: [number, number][] = [[1024, 960], [1000, 999], [960, 1024], [800, 800], [600, 600], [1366, 1024], [1024, 768]];
    let checked = 0;
    for (const [vw, vh] of viewports) {
      const room = enlargedQrSize(vw, vh);
      expect(room, `${vw}×${vh}: never more than D10's own bound`).toBeLessThanOrEqual(Math.min(vw, vh) - 2 * 16);
      expect(room, `${vw}×${vh}: still a real QR`).toBeGreaterThan(Math.min(vw, vh) / 2);
      if (vw > vh) {
        // landscape: QR + gap + caption across the width, inside the two gutters
        expect(room + 12 + 160, `${vw}×${vh} across`).toBeLessThanOrEqual(vw - 2 * 16);
      } else {
        // portrait (a square is portrait to CSS): QR + gap + caption down the height, clear of the ✕ band at the top
        // (the column is centred, so the band is kept at the bottom too)
        expect(room + 12 + 40, `${vw}×${vh} down`).toBeLessThanOrEqual(vh - 2 * 52);
      }
      checked++;
    }
    expect(checked).toBe(viewports.length);
    expect(enlargedQrSize(1024, 960), "premise: the reviewer's 1024 × 960 is where the old rule overflowed").toBeLessThan(960 - 32);
  });
});

// m-1 (B6 review): the browser drops a screen wake lock whenever the page is hidden, and does not give it back. The
// overlay re-requests it when the page is shown again (the wiring is QrEnlarged's, in seazn-qr-image.test.tsx).
