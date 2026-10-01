// lib/qr-enlarge.ts — owner ruling D10 (2026-10-04): a Seazn QR opens full screen on one tap, as large as the
// viewport allows, with the screen kept awake while it is open.

/** The gutter on each side of the enlarged QR (D10: "min(viewport width, viewport height) minus a 16 px gutter"). */
export const QR_ENLARGE_GUTTER_PX = 16;

/** The enlarged QR's edge in CSS px — derived from the viewport every time, never a constant. */
export function enlargedQrSize(vw: number, vh: number): number {
  return Math.max(0, Math.min(vw, vh) - 2 * QR_ENLARGE_GUTTER_PX);
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
