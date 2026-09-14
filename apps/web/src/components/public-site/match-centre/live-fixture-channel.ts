"use client";
// M1 k2 — one live subscription, two places on the page.
//
// `useLiveFixture` is the page's ONLY transport (poll + realtime push), and
// `MatchCentre` owns the single instance of it. The fixture page also has a
// subheading line ABOVE the match centre in the DOM — above the stream link,
// directly under the title — and that line has to move when a match is
// rescheduled (rule R10: live pages update without a reload).
//
// A second `useLiveFixture` in the subheading would have been a second 15 s
// poll and a second private realtime channel for one page. Lifting the hook
// above both would have meant taking the transport out of `MatchCentre` and
// re-threading `data`/`transport` through it and its Suspense wrapper — a much
// wider change to the component every tab renders from, for one paragraph.
//
// So the publisher broadcasts instead: `MatchCentre` writes each snapshot it
// receives here, keyed by fixture id, and anything else on the page reads it
// through `useLiveFixtureSnapshot`. `use-live-fixture.ts` and `lib/realtime.ts`
// are untouched (#782's lane).
//
// SERVER SAFETY. This map is module scope, so on the server it would be shared
// by every concurrent request. It is never written there — only an effect
// publishes, and effects do not run during SSR — and `useSyncExternalStore`'s
// third argument (the server snapshot) returns `null` unconditionally, so a
// server render can never READ it either. Subscribers therefore fall back to
// the `initial` document their own props carry, which is exactly what the page
// server-rendered: same first paint, no hydration mismatch, no flash.
import { useCallback, useSyncExternalStore } from "react";
import type { LiveFixtureData } from "../live-score-data";

const snapshots = new Map<string, LiveFixtureData>();
const listeners = new Map<string, Set<() => void>>();

/** Announce the newest snapshot for `fixtureId`. Called from an EFFECT (never
 *  a render body) — a render-phase store write is unsound under concurrent
 *  rendering, and would tear a subscriber rendering in the same pass. */
export function publishLiveFixture(fixtureId: string, data: LiveFixtureData): void {
  // Reference equality, not deep: `useLiveFixture` hands out a new object only
  // when it has new data, so this is both correct and the cheap way to stop a
  // re-render of the publisher from waking every subscriber.
  if (snapshots.get(fixtureId) === data) return;
  snapshots.set(fixtureId, data);
  for (const notify of [...(listeners.get(fixtureId) ?? [])]) notify();
}

/** Drop a fixture's snapshot. The PUBLISHER calls this on unmount: it owns the
 *  entry, and a subscriber unmounting first must not delete a document the
 *  publisher is still updating. Without it, every fixture visited in one
 *  client-side session would be retained for the life of the tab. */
export function clearLiveFixture(fixtureId: string): void {
  snapshots.delete(fixtureId);
}

/**
 * The newest published snapshot for `fixtureId`, or `null` when nothing has
 * published yet — on the server, on the hydration pass, and after the
 * publisher unmounts. Callers render their own `initial` prop in that case.
 */
export function useLiveFixtureSnapshot(fixtureId: string): LiveFixtureData | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      let set = listeners.get(fixtureId);
      if (set === undefined) {
        set = new Set();
        listeners.set(fixtureId, set);
      }
      set.add(onStoreChange);
      return () => {
        set.delete(onStoreChange);
        if (set.size === 0) listeners.delete(fixtureId);
      };
    },
    [fixtureId],
  );
  // Returns the STORED object, so repeated calls in one render pass are
  // referentially equal — `useSyncExternalStore` loops forever on a getSnapshot
  // that mints a new value each time.
  const getSnapshot = useCallback(() => snapshots.get(fixtureId) ?? null, [fixtureId]);
  const getServerSnapshot = useCallback(() => null, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
