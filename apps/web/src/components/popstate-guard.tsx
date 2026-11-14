"use client";

// B7 T24 fix round 1 G1 — the one popstate listener that can hold a Back (or Forward) before Next's router acts on it.
//
// Chromium runs a window's popstate listeners in the order they were added — the capture flag changes nothing at the target
// — and Next's router adds its own once, when the app first hydrates. A page that adds a listener later runs AFTER the
// router, whose transition React flushes synchronously inside the popstate: the page unmounts, its listener is removed
// mid-dispatch, and it never runs. So this listener is added by the root layout, whose effects commit before the router's
// (a child's effects run before its parent's, and the router is the root layout's ancestor), and a page holds it — lends it
// a guard — only while it has something to protect. With no guard held it does nothing.

import { useEffect } from "react";

type Guard = (event: PopStateEvent) => void;

let held: Guard | null = null;

/** Hold every popstate with `guard` until the returned release is called. A newer hold replaces an older one; a release
 *  lets go of its own hold only, so a page's late cleanup cannot drop the guard the next page holds. */
export function holdPopState(guard: Guard): () => void {
  held = guard;
  return () => {
    if (held === guard) held = null;
  };
}

/** The window's listener: the held guard, if any. */
export function runPopStateGuard(event: PopStateEvent): void {
  held?.(event);
}

/** Adds the listener. Mounted once, in the root layout. */
export function PopStateGuardRoot(): null {
  useEffect(() => {
    window.addEventListener("popstate", runPopStateGuard);
    return () => window.removeEventListener("popstate", runPopStateGuard);
  }, []);
  return null;
}
