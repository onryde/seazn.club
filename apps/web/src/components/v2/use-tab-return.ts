"use client";

import { useEffect } from "react";

/** G1 (#848) — refresh when a human comes back to the tab. Extracted unchanged
 *  from device-score-pad.tsx so the scan page's Waiting screen uses the SAME
 *  floor (scorer sheets §4.5). `enabled: false` removes both listeners.
 *
 *  G1 gave the courtside pad the freshness floor W3 gave the console
 *  (`fixture-console.tsx`, its `visibilitychange`/`focus` effect). Every other
 *  refresh on that pad is its own `send()` or its inner pad's ledger change,
 *  and the second is downstream of the very pipeline that stalls — a 403 at
 *  the realtime token door on a Community plan, a websocket that joined and
 *  died, a wedged drain. So a stalled pipeline left the SCORER's screen stale
 *  with no upper bound, while the watcher's screen had one.
 *
 *  Deliberately not an interval: a second timer on the same fixture doubles
 *  the request rate of every courtside pad in the product. A human returning
 *  to the tab is the moment staleness is visible, and a tab nobody returns to
 *  costs nothing. (The Waiting screen's own `POLL_MS` loop is ITS timer, only
 *  while it exists; this hook never adds one.)
 *
 *  BOTH events, because they do not always co-occur: a window-manager focus
 *  with no visibility transition fires only `focus`; a tab switch inside an
 *  already-focused window fires only `visibilitychange`. A real return fires
 *  both, so it costs two refreshes — bounded per return, and the first to
 *  settle already applies fresh state.
 *
 *  The `visibilityState` guard is load-bearing: `visibilitychange` fires on
 *  the HIDE as well as the show, and refreshing a tab the scorer just left is
 *  the request this exists not to make.
 *
 *  `onReturn` is the caller's to choose, and its identity is a dependency: a
 *  new function re-subscribes. The pad passes `handlePadEvents`, NEVER
 *  `resync` directly (see its call site for why), and both callers pass a
 *  function stable for the life of the screen, so this subscribes once. */
export function useTabReturn(onReturn: () => void, enabled: boolean): void {
  useEffect(() => {
    // No DOM underneath ⇒ no listener. React never runs an effect during SSR,
    // so this is the effect's real server behaviour; it is also reachable in
    // `apps/web` vitest (`environment: "node"`), where `_hook-harness.tsx`
    // commits effects with no browser. W3 shipped the console's copy of this
    // effect unguarded and crashed three existing suites at mount.
    // BOTH clauses, and they are not redundant: a suite may stub `document`
    // without `window`, or neither, and a one-clause guard crashes in whichever
    // shape it forgot. `device-score-pad-freshness-floor.test.tsx` mounts each
    // partial DOM, so each clause has its own witness.
    if (typeof document === "undefined" || typeof window === "undefined") return;
    // Disabled ⇒ no listener, and flipping to disabled runs the cleanup below,
    // which removes both; nothing re-adds them until it is enabled again.
    if (!enabled) return;
    const refreshIfVisible = () => {
      if (document.visibilityState !== "visible") return;
      onReturn();
    };
    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("focus", refreshIfVisible);
    return () => {
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("focus", refreshIfVisible);
    };
  }, [onReturn, enabled]);
}
