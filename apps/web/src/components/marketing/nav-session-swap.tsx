"use client";

// The marketing nav's signed-in swap for a page that must stay cacheable (MarketingNav `auth="client"`; /blog uses it now,
// /help joins it in the caching task).
// The server renders the signed-out actions and never asks who is looking; this island, after hydration, shows the
// signed-in action instead when the browser carries the readable hint cookie (lib/session-hint.ts). The hint
// carries no identity and no authority: it only picks which of two links to draw, and the dashboard behind the
// "Dashboard" link checks the real session itself. A wrong or stale hint costs one link that leads to the login page.
//
// useSyncExternalStore with a `false` server snapshot: the server markup and the first client render both say
// "signed out", so hydration never disagrees, and the swap happens in the commit that follows it.
import { useSyncExternalStore } from "react";
import { hasSessionHint } from "@/lib/session-hint";

const subscribe = () => () => {};
const read = () => hasSessionHint(document.cookie);
const readOnServer = () => false;

/** True once this browser carries the signed-in hint; false on the server and in the first client render. */
export function useSessionHint(): boolean {
  return useSyncExternalStore(subscribe, read, readOnServer);
}

/**
 * The bar's actions: `signedOut` as rendered by the server, `signedIn` in its place when the hint is set.
 *
 * Nothing in the bar may move when the swap happens. The signed-out pair ("Log in", "Start free") is wider than the
 * "Dashboard" button, so were one simply replaced by the other the links to its left would jump right by the difference.
 * The signed-out pair therefore stays in the page as the slot's sizer (invisible, inert, so not focusable and not read
 * out) and "Dashboard" is drawn over it, right-aligned. The server markup is unchanged: it carries no dashboard link.
 * Below `sm` both are hidden (the phone panel carries the actions), so the slot is not drawn at all.
 */
export function NavSessionSwap({ signedOut, signedIn }: { signedOut: React.ReactNode; signedIn: React.ReactNode }) {
  const hinted = useSessionHint();
  return (
    <div className="hidden justify-items-end sm:grid" data-testid="nav-session-slot">
      <div className={`col-start-1 row-start-1 flex items-center gap-2 ${hinted ? "invisible" : ""}`} inert={hinted}>
        {signedOut}
      </div>
      {hinted ? <div className="col-start-1 row-start-1 flex items-center">{signedIn}</div> : null}
    </div>
  );
}
