"use client";
// The quick match home after the browser's Back (plan 2 Task 10 review I-1). A phone's browser (iOS Safari above all) keeps the
// home whole in its back-forward cache when the guest taps Score, and Back shows that copy without asking the server, so the
// hero would still read "Up next" over a match the guest has just scored. `force-dynamic` (no-store) does not stop a restore.
// A restore says so with one signal, `pageshow` with `persisted` true: then this loads the page again. An ordinary load is
// fresh already and reloads nothing, so a reload never leads to another.
//
// A reload, not `router.refresh()`: the router hook throws outside a mounted app router ("invariant expected app router to
// be mounted"), and the home is rendered whole, with `renderToStaticMarkup`, by the server tests that read it
// (app/q/[token]/__tests__). Next's own restore handler (app-router.js) only puts its router state back; it fetches nothing.
//
// Renders nothing; the token never reaches it.
import { useEffect } from "react";

export function QuickMatchRefreshOnRestore() {
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
  return null;
}
