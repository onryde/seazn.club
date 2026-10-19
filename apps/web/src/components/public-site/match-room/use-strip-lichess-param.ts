import { useEffect } from "react";
import { withoutLichessParam } from "@/lib/lichess-link";

/** Owner staging test, 2026-10-19: once the room has READ `?lichess=<code>` (the page handed it to the shell), the
 *  parameter comes out of the address bar - so a reload does not show a stale outcome, and the link the player
 *  copies is the personal link alone. Everything else in the address, `t=` above all, is kept byte for byte.
 *
 *  Once, on mount, a `replaceState` (never a push). The outcome itself is not lost with the parameter: the shell holds
 *  it in state (room-shell.tsx).
 *
 *  Next-router-safe (PR #990 review, M2; node_modules/next/dist/client/components/app-router.js, this repo's Next 16.3).
 *  The app router patches `window.history.replaceState` so that a native call "integrates into the Next.js Router"
 *  (docs: 01-app/01-getting-started/04-linking-and-navigating.md, "Native History API") - its `canonicalUrl`,
 *  `useSearchParams`, and the URL it re-stamps on every later router change (`router.refresh()`, a navigation) all
 *  follow it. Two things make that work, and the strip honours both:
 *   1. The call must carry NO Next marker. The patch passes straight through, router NOT told, any state with `__NA` -
 *      which is what `window.history.state` is. So the state is `null`: the patch copies the router's own state onto it
 *      and dispatches ACTION_RESTORE with the clean URL. (Next then re-reads this server page for it, once; the shell
 *      keeps the outcome it holds across that - room-lichess-strip.test.tsx.)
 *   2. The patch must exist. It is installed by the router's own MOUNT EFFECT, and React runs a child's mount effect
 *      before its parent's - on the first hydration this hook's effect runs BEFORE the router's. A task later, every
 *      effect of that commit has run, and the patch is there. (A room mounted by a client navigation is past that
 *      already; the timer costs it a task.)
 *  Without either, the browser's address bar looks right and the router's does not: the first `router.refresh()` writes
 *  `lichess=` back (the e2e's reload-free `router.refresh()` check is the proof in a real browser). */
export function useStripLichessParam(): void {
  useEffect(() => {
    // Effects run in a browser; the guard is for the node renders that drive the shell without one (the hook harness).
    if (typeof window === "undefined") return;
    const id = setTimeout(() => {
      const { pathname, search, hash } = window.location;
      const here = `${pathname}${search}${hash}`;
      const clean = withoutLichessParam(here);
      if (clean !== here) window.history.replaceState(null, "", clean);
    }, 0);
    return () => clearTimeout(id);
  }, []);
}
