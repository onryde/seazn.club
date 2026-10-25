"use client";
// Browser-only values, read hydration-safely (ESLint L3, 2026-10-14).
//
// The shape these replace: `const [x, setX] = useState(serverDefault)` plus a
// mount effect that copies a browser value (`window.location.origin`, a
// `localStorage` item, a media query) into state. That is the cascading render
// `react-hooks/set-state-in-effect` exists to flag — every mount paints the
// default, then renders again — and on a client-side mount (no hydration at
// all) it paints a frame of the wrong value for nothing.
//
// `useSyncExternalStore` is React's own answer: the browser owns the value,
// the component only reads it. `getServerSnapshot` is what the server renders
// AND what a hydrating client renders first, so hydration never mismatches;
// React then re-renders with the live snapshot by itself. A component mounted
// on the client after hydration (a dialog, a client navigation) reads the live
// value on its FIRST render — no flash.
//
// Every server snapshot below is the value the replaced `useState` started
// with, so the server markup is byte-for-byte what it was.
//
// The repo already had this shape, privately, in three places
// (`v3/scorebug.tsx` useIsPhone, `kiosk-phone-card.tsx`'s storage read,
// `fixture-stream-panel.tsx`'s origin). Those are left as they are; this is the
// shared copy for the rest.
import { useCallback, useSyncExternalStore } from "react";

/** A store that never changes after mount needs no subscription. */
function subscribeToNothing(): () => void {
  return () => {};
}

const onClient = () => true;
const onServer = () => false;

/**
 * `false` on the server and during hydration, `true` from the render after
 * hydration — and `true` on the very first render of a component mounted on
 * the client later. The replacement for `const [mounted, setMounted] =
 * useState(false); useEffect(() => setMounted(true), [])`.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribeToNothing, onClient, onServer);
}

function readBrowserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
const noZone = () => null;

/** The browser's own IANA zone ("Asia/Tokyo"); `null` on the server, during hydration, and where the engine cannot resolve one. For
 *  asking whether a venue's clock is the viewer's (the arbiter panel's "(Tokyo time)" label, Task 16 D1): the server cannot know it,
 *  so a server render that guessed would hydrate to something else. A zone does not change under a page, so there is no subscription. */
export function useBrowserZone(): string | null {
  return useSyncExternalStore(subscribeToNothing, readBrowserZone, noZone);
}

const readOrigin = () => window.location.origin;
const noOrigin = () => "";

/** `window.location.origin`; `""` on the server and during hydration, so an
 *  absolute URL built from it degrades to the site-relative path there. */
export function useOrigin(): string {
  return useSyncExternalStore(subscribeToNothing, readOrigin, noOrigin);
}

/** Another tab's write arrives as a `storage` event. This tab's own write does
 *  NOT fire one, so a caller that writes keeps its own pick in state too. */
export function subscribeToStorage(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/** Read a `localStorage` item, or `null` when storage throws (Safari private
 *  mode throws on the accessor itself) — a preference that cannot be read must
 *  never stop a page from rendering. */
export function readLocalStorageItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Write a `localStorage` item; `false` when storage refused it. */
export function writeLocalStorageItem(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

const noItem = () => null;

/**
 * A `localStorage` item, hydration-safe: `null` on the server, during
 * hydration, when absent, and when storage throws. Re-read on every render, so
 * this tab's own write shows on the next render; another tab's arrives through
 * the `storage` event.
 */
export function useLocalStorageItem(key: string): string | null {
  return useSyncExternalStore(subscribeToStorage, () => readLocalStorageItem(key), noItem);
}

/**
 * Whether `query` matches, live (a resize or rotation re-renders). `false` on
 * the server and during hydration.
 */
export function useMediaQuery(query: string): boolean {
  // Memoised on the query: a fresh `subscribe` identity every render would
  // make React drop and re-add the listener on every render.
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, onServer);
}
