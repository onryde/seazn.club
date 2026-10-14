"use client";
// T17 fix round 2, V1 — when an online board's round opened, from the watch panel to the line under the fixture title.
//
// The line renders off the match centre's document, which does not carry the round's open; the watch panel polls the
// board and so learns it live — a viewer who loaded the page before the organiser opened the round sees it the moment
// the panel does. Keyed by fixture, like `live-fixture-channel`; nothing is published on the server or during
// hydration, so the first paint is the page's own value.
import { useCallback, useSyncExternalStore } from "react";

const opened = new Map<string, string | null>();
const listeners = new Map<string, Set<() => void>>();

function notify(fixtureId: string): void {
  for (const fn of [...(listeners.get(fixtureId) ?? [])]) fn();
}

/** The panel's current answer for `fixtureId`: the round's open instant, or null while it is not open. */
export function publishRoundOpenedAt(fixtureId: string, at: string | null): void {
  if (opened.has(fixtureId) && opened.get(fixtureId) === at) return;
  opened.set(fixtureId, at);
  notify(fixtureId);
}

/** The panel is gone: the line falls back to the page's own value. */
export function clearRoundOpenedAt(fixtureId: string): void {
  if (!opened.delete(fixtureId)) return;
  notify(fixtureId);
}

/** What the panel last published for `fixtureId` — `undefined` while nothing has been (the server, hydration, a page
 *  with no panel). */
export function useRoundOpenedAt(fixtureId: string): string | null | undefined {
  const subscribe = useCallback(
    (onChange: () => void) => {
      let set = listeners.get(fixtureId);
      if (set === undefined) {
        set = new Set();
        listeners.set(fixtureId, set);
      }
      set.add(onChange);
      return () => {
        const current = listeners.get(fixtureId);
        if (current === undefined) return;
        current.delete(onChange);
        if (current.size === 0) listeners.delete(fixtureId);
      };
    },
    [fixtureId],
  );
  return useSyncExternalStore(
    subscribe,
    () => opened.get(fixtureId),
    () => undefined,
  );
}
