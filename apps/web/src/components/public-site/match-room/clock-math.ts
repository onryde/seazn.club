/**
 * Milliseconds left on one side's clock, rendered locally.
 *
 * `baseMs` is the last value we were TOLD (an accepted move's broadcast, or
 * a reconcile's authoritative export clocks — M11), `asOfMs` is when that
 * value was true, and `nowMs` is the viewer's tick. A correction that moves
 * time backwards therefore wins by construction: a fresh `baseMs`/`asOfMs`
 * pair replaces the derivation rather than being blended with it.
 *
 * Floored at zero and never interpreted. Reaching zero is one of
 * reconcile's four triggers (design §3.5); it is never, on its own, a flag.
 */
export function remainingMs(a: { baseMs: number; asOfMs: number; nowMs: number; running: boolean }): number {
  if (!a.running) return Math.max(0, a.baseMs);
  return Math.max(0, a.baseMs - Math.max(0, a.nowMs - a.asOfMs));
}

/** Below this the face shows tenths (time trouble). */
export const TENTHS_BELOW_MS = 10_000;

/**
 * The clock face. `m:ss` with the seconds rounded UP (a clock reading 0:00
 * must mean no time at all); below ten seconds `m:ss.t`, floored to the
 * tenth but never showing 0.0 while any time remains.
 */
export function formatClock(ms: number): string {
  if (ms <= 0) return "0:00.0";
  if (ms < TENTHS_BELOW_MS) {
    const tenths = Math.max(1, Math.floor(ms / 100));
    return `0:0${Math.floor(tenths / 10)}.${tenths % 10}`;
  }
  const total = Math.ceil(ms / 1_000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
