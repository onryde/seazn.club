import { useEffect } from "react";
import { withoutLichessParam } from "@/lib/lichess-link";

/** Owner staging test, 2026-10-19: once the room has READ `?lichess=<code>` (the page handed it to the shell), the
 *  parameter comes out of the address bar - so a reload does not show a stale outcome, and the link the player
 *  copies is the personal link alone. Everything else in the address, `t=` above all, is kept byte for byte.
 *
 *  Once, on mount, `replaceState` with the history entry's own state (never a push, never a navigation: nothing
 *  re-renders, and Next's router keeps the state it stamped). Nothing is touched when there is no such parameter.
 *  The outcome itself is not lost with the parameter: the shell holds it in state (room-shell.tsx). */
export function useStripLichessParam(): void {
  useEffect(() => {
    // Effects run in a browser; the guard is for the node renders that drive the shell without one (the hook harness).
    if (typeof window === "undefined") return;
    const { pathname, search, hash } = window.location;
    const here = `${pathname}${search}${hash}`;
    const clean = withoutLichessParam(here);
    if (clean !== here) window.history.replaceState(window.history.state, "", clean);
  }, []);
}
