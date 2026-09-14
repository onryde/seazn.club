// The pure half of the public /present kiosk's "made for a TV" hint (spectator
// N1d d6; the component is `kiosk-tv-hint.tsx`). NO IMPORTS, on purpose: the
// e2e spec reads the storage key from here, and a spec that loads a module
// whose chain reaches a JSON import fails to collect.

/** Where a ✕ is remembered, per browser. */
export const KIOSK_TV_HINT_STORAGE_KEY = "seazn:kiosk-tv-hint-dismissed";

/** Below 1024px, a board sized for a screen across a hall is being read on a
 *  phone or a small tablet. */
export const KIOSK_TV_HINT_QUERY = "(max-width: 1023px)";

/**
 * The page a phone should open instead of the kiosk: the competition's public
 * hub, filtered with `?division=` (the hub's own division parameter, read by
 * `use-tab-param.ts`) when the kiosk shows one division.
 */
export function kioskHubHref(orgSlug: string, competitionSlug: string, divisionSlug?: string | null): string {
  const hub = `/shared/${encodeURIComponent(orgSlug)}/${encodeURIComponent(competitionSlug)}`;
  return divisionSlug ? `${hub}?division=${encodeURIComponent(divisionSlug)}` : hub;
}

/** Narrow and not dismissed. Nothing else shows it. */
export function shouldShowTvHint({ narrow, dismissed }: { narrow: boolean; dismissed: boolean }): boolean {
  return narrow && !dismissed;
}

/** The slice of `Storage` the hint uses. */
export interface TvHintStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A getter, not the storage: reading `window.localStorage` can itself throw
 *  (blocked site data), before any call is made on it. */
export type TvHintStorageGetter = () => TvHintStorage | null | undefined;

/** Whether this browser remembers a ✕. Any failure reads as not dismissed: the
 *  hint shows again, and the board never breaks over it. */
export function readTvHintDismissed(getStorage: TvHintStorageGetter): boolean {
  try {
    return getStorage()?.getItem(KIOSK_TV_HINT_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remember a ✕. Returns whether it was stored. A failure is swallowed; the
 *  component still hides the hint for the rest of the visit. */
export function writeTvHintDismissed(getStorage: TvHintStorageGetter): boolean {
  try {
    const storage = getStorage();
    if (!storage) return false;
    storage.setItem(KIOSK_TV_HINT_STORAGE_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

/** Whether the root element can go full screen. The button renders only then. */
export function canRequestFullscreen(doc: { documentElement?: { requestFullscreen?: unknown } } | undefined): boolean {
  return typeof doc?.documentElement?.requestFullscreen === "function";
}
