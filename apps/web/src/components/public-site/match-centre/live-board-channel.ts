"use client";
// T16 — the spectators' pushed board, relayed from the page's ONE realtime
// subscription to the watch island.
//
// `useLiveFixture` (owned by `MatchCentre`) holds the page's only private
// channel on `fixture:{id}`. realtime-js's `channel(topic)` returns the SAME
// channel object for a topic already listed, so a second subscriber on the
// page would neither join (a second `subscribe` on a joined channel does
// nothing and never calls back) nor be able to leave without closing the
// match centre's. So the hook relays each `board_state` here, and the watch
// island listens — the same one-transport, two-places shape as
// `live-fixture-channel.ts`, for events rather than a snapshot.
//
// Listeners are registered from effects only, so the server never holds one.
import { readBoardPush, type PublicBoardPush } from "@/server/external-play/public-view";

const listeners = new Map<string, Set<(push: PublicBoardPush) => void>>();

/** Relay a `board_state` payload to `fixtureId`'s listeners — checked first:
 *  a payload that is not a board reaches no one. */
export function publishBoardPush(fixtureId: string, payload: unknown): void {
  const push = readBoardPush(payload);
  if (push === null) return;
  for (const fn of [...(listeners.get(fixtureId) ?? [])]) fn(push);
}

/** Listen for `fixtureId`'s pushed boards; returns the unsubscribe. */
export function subscribeBoardPush(fixtureId: string, fn: (push: PublicBoardPush) => void): () => void {
  let set = listeners.get(fixtureId);
  if (set === undefined) {
    set = new Set();
    listeners.set(fixtureId, set);
  }
  set.add(fn);
  return () => {
    const current = listeners.get(fixtureId);
    if (current === undefined) return;
    current.delete(fn);
    if (current.size === 0) listeners.delete(fixtureId);
  };
}
