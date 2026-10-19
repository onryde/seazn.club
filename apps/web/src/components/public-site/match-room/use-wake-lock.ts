"use client";
// Best-effort screen wake lock for the check-in line (spec §5.7.5): a phone that dims and sleeps stops the claim loop, and a
// player silent for LINE_ABANDON_AFTER_MS loses their place. Not every browser has one, and a request can be refused (battery
// saver, a hidden tab): the card says "Keep this page open" either way, so every failure is swallowed. A lock is released by
// the browser when the tab hides, so it is asked for again when the tab is visible.
import { useEffect } from "react";

type WakeLockApi = { request: (type: "screen") => Promise<WakeLockSentinel> };

export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === "undefined") return;
    const api = (navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock;
    if (!api) return;
    let held: WakeLockSentinel | null = null;
    let cancelled = false;
    const ask = async () => {
      try {
        const lock = await api.request("screen");
        if (cancelled) {
          void lock.release().catch(() => undefined);
          return;
        }
        held = lock;
      } catch {
        // Refused or unsupported in this state: the card's own words are the fallback.
      }
    };
    void ask();
    const onVisible = () => {
      if (document.visibilityState === "visible" && (held === null || held.released)) void ask();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void held?.release().catch(() => undefined);
    };
  }, [active]);
}
