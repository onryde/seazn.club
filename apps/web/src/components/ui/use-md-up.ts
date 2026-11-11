"use client";

// Is the viewport at Tailwind's `md` (768px) or wider? Read through `useSyncExternalStore`, the way the repo reads every browser
// value (client-time.tsx, share-bar.tsx): the SERVER snapshot is `null` - "not known yet" - so the markup the server sends, and the
// first client render that must match it, carry no guess about the viewport. After hydration React re-reads the live value.
//
// For a screen that is a PAGE on a phone and a side panel from md up (the sponsor page): CSS alone cannot make one element both
// the in-flow page body and a focus-trapped dialog, so the choice of wrapper is made here, once, around ONE body. The caller owns
// what `null` renders (the sponsor page renders the phone body hidden from md up, so a desktop never flashes it).
import { useSyncExternalStore } from "react";

/** Tailwind's `md` breakpoint (the AGENTS.md phone composition: below 768 is a phone). */
export const MD_QUERY = "(min-width: 768px)";

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(MD_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readLive(): boolean {
  return window.matchMedia(MD_QUERY).matches;
}

function readOnServer(): null {
  return null;
}

/** `true` from 768px up, `false` below, `null` until the browser has been asked (the server render and hydration). */
export function useMdUp(): boolean | null {
  return useSyncExternalStore<boolean | null>(subscribe, readLive, readOnServer);
}
