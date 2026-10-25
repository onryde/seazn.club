"use client";
// The viewer's own browser zone, for one question only: is the venue's clock the same as mine? (Task 16 sign-off D1.)
//
// `null` on the server and on the first client render - the server cannot know it, and a server render that guessed would hydrate to
// something else. React swaps in the browser's zone right after hydration (`useSyncExternalStore`'s server snapshot is what a
// hydrating tree reads first), so nothing in the first paint depends on it. A zone is a fact of the machine, not an event: nothing to
// subscribe to.
import { useSyncExternalStore } from "react";

const subscribe = () => () => undefined;

function browserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function useViewerZone(): string | null {
  return useSyncExternalStore(subscribe, browserZone, () => null);
}
