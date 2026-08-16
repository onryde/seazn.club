"use client";

// Competition-scoped route error boundary.
//
// WHY A SECOND ONE, when `app/error.tsx` already exists. A Next error boundary
// replaces the failed segment but keeps every layout ABOVE it. The root one
// sits directly under `app/layout.tsx`, so a throw anywhere below it unmounts
// the org shell AND this competition's shell — the organiser is left on a bare
// centred paragraph with no breadcrumb, no tab strip, and no way out except
// the browser's back button. That is exactly what a division page's client
// throw looked like on staging (#575): one panel's `useMemo` raised
// `RangeError: Invalid time value` and the whole competition disappeared with
// it, on every tab.
//
// This boundary is mounted under `c/[compSlug]/layout.tsx`, the deepest layout
// in the competition subtree, so the same throw now degrades to "this page
// failed" inside a competition that still renders its own navigation. The
// organiser can switch tab or division instead of being stranded. Everything
// below — the division pages, the schedule board, registrations, fixtures —
// inherits it, because no intermediate layout exists to scope it tighter.
//
// The root boundary stays where it is and stays the last resort: a failure in
// the org layout, or in this file's own render, still escalates to it.
//
// Copy IS localized here, unlike the root boundary. That boundary deliberately
// hardcodes English because the thing that failed may be the dictionary
// provider itself; this one renders inside the provider tree, and `useMsg()`
// falls back to the shipped `en/ui.json` catalog when no provider is present
// (dict-provider.tsx), so there is no render path where reading a key throws.
import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { useMsg } from "@/components/i18n/dict-provider";

export default function CompetitionError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const msg = useMsg();

  useEffect(() => {
    // Same reporting contract as the root boundary — a caught error must not
    // become a quieter error. `scope.segment` is what tells the two apart in
    // Sentry, since both capture the identical exception object.
    Sentry.captureException(error, { tags: { segment: "competition" } });
  }, [error]);

  return (
    // A `<main>`, because in this tree the LANDMARK belongs to the page, not
    // to a layout — `d/[divSlug]/page.tsx` and `c/[compSlug]/page.tsx` each
    // open their own, and this boundary renders INSTEAD of that page. A
    // <section> here would leave the document with no main landmark at all.
    <main className="mx-auto flex min-h-[40vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <h2 className="text-lg font-semibold text-slate-800">{msg("routeError.title")}</h2>
      <p className="text-sm text-slate-500">{msg("routeError.body")}</p>
      {error.digest && (
        <p className="text-xs text-slate-400">{msg("routeError.reference", { digest: error.digest })}</p>
      )}
      <button type="button" onClick={reset} className="btn btn-primary">
        {msg("routeError.retry")}
      </button>
    </main>
  );
}
