"use client";

// Has the visitor asked their device for less motion? Read through `useSyncExternalStore`, the way the repo reads every browser value
// (use-md-up.ts, client-time.tsx): the SERVER snapshot is `false`, so the markup the server sends, and the first client render that
// must match it, carry no guess about the visitor. After hydration React re-reads the live value, and a `change` (the visitor flips the
// OS setting) re-renders. It is not a `setState` in an effect, which the repo's `react-hooks/set-state-in-effect` rule bans.
//
// Every `window` access is guarded: on the server there is none, and an old or embedded browser may have no `matchMedia`; both read
// `false` ("motion is fine") and subscribe to nothing.
//
// The Title sponsor showcase is the first consumer. The three older private copies (v2/board/ai-trace.tsx, marketing's
// ai-architect-demo, the stream overlay's overlay-stage) are not migrated here: that is a separate change.
import { useSyncExternalStore } from "react";

/** The one media query this hook asks. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function canAsk(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

function subscribe(onChange: () => void): () => void {
  if (!canAsk()) return () => {};
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readLive(): boolean {
  return canAsk() ? window.matchMedia(REDUCED_MOTION_QUERY).matches : false;
}

function readOnServer(): boolean {
  return false;
}

/** `true` while the visitor prefers reduced motion; `false` on the server, during hydration, and whenever the browser cannot say. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, readLive, readOnServer);
}
