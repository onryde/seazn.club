// The pure half of the kiosk's phone card (OWNER RULING C1, 2026-09-15; the
// gate is `kiosk-phone-card.tsx`). It replaces the "made for a TV" banner's
// logic (N1d d6): the hub link is unchanged, and the remembered ✕ became the
// remembered "Show the board anyway". NO IMPORTS, on purpose: the e2e spec
// reads the storage key from here, and a spec that loads a module whose chain
// reaches a JSON import fails to collect.

/** Where "Show the board anyway" is remembered, per browser. */
export const KIOSK_BOARD_CHOSEN_STORAGE_KEY = "seazn:kiosk-board-chosen";

/**
 * Where a public kiosk's "Open the live page" goes: the competition's public
 * hub, filtered with `?division=` (the hub's own division parameter, read by
 * `use-tab-param.ts`) when the kiosk shows one division.
 */
export function kioskHubHref(orgSlug: string, competitionSlug: string, divisionSlug?: string | null): string {
  const hub = `/shared/${encodeURIComponent(orgSlug)}/${encodeURIComponent(competitionSlug)}`;
  return divisionSlug ? `${hub}?division=${encodeURIComponent(divisionSlug)}` : hub;
}

/** The slice of `Storage` the choice uses. */
export interface BoardChoiceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** A getter, not the storage: reading `window.localStorage` can itself throw
 *  (blocked site data), before any call is made on it. */
export type BoardChoiceStorageGetter = () => BoardChoiceStorage | null | undefined;

/** Whether this browser chose the board anyway. Any failure reads as no
 *  choice: the card shows again, and the page never breaks over it. */
export function readBoardChosen(getStorage: BoardChoiceStorageGetter): boolean {
  try {
    return getStorage()?.getItem(KIOSK_BOARD_CHOSEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remember the choice. Returns whether it was stored. A failure is swallowed;
 *  the gate still shows the board for the rest of the visit. */
export function writeBoardChosen(getStorage: BoardChoiceStorageGetter): boolean {
  try {
    const storage = getStorage();
    if (!storage) return false;
    storage.setItem(KIOSK_BOARD_CHOSEN_STORAGE_KEY, "1");
    return true;
  } catch {
    return false;
  }
}
