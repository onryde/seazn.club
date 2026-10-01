// D10 (owner ruling 2026-10-04): a Seazn QR opens full screen on one tap, as large as the viewport allows, with the
// screen kept awake while it is open. This file pins the two pure halves — the size rule and the wake-lock disposer.
// The overlay that calls them is `seazn-qr-image.test.tsx`'s (wiring) and the walkthroughs' (the browser).
import { describe, expect, it, vi } from "vitest";
import { QR_ENLARGE_GUTTER_PX, enlargedQrSize, holdScreenWakeLock } from "../qr-enlarge";

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

  it("the enlarged size is DERIVED from the viewport: min(vw, vh) − 2 × gutter, portrait and landscape, phone and desktop", () => {
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
