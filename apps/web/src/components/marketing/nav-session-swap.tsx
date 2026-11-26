"use client";

// The marketing nav's signed-in swap for a page that must stay cacheable (MarketingNav `auth="client"`: /help and /blog).
// The server renders the signed-out actions and never asks who is looking; this island, after hydration, shows the
// signed-in action instead when the browser carries the readable hint cookie (lib/session-hint.ts). The hint
// carries no identity and no authority: it only picks which of two links to draw, and the dashboard behind the
// "Dashboard" link checks the real session itself. A wrong or stale hint costs one link that leads to the login page.
//
// useSyncExternalStore with a `false` server snapshot: the server markup and the first client render both say
// "signed out", so hydration never disagrees, and the swap happens in the commit that follows it.
import { useSyncExternalStore } from "react";
import { InlineScript } from "@/components/inline-script";
import { SESSION_HINT_PREPAINT, hasSessionHint } from "@/lib/session-hint";

const subscribe = () => () => {};
const read = () => hasSessionHint(document.cookie);
const readOnServer = () => false;

/** True once this browser carries the signed-in hint; false on the server and in the first client render. */
export function useSessionHint(): boolean {
  return useSyncExternalStore(subscribe, read, readOnServer);
}

/**
 * The mark made before the first paint. MarketingNav draws it as the bar's FIRST child on a cached page: parsed there, it
 * sets `data-signed-in` on the bar (its parent) before any of the bar is drawn. It must stay first. Chrome paints a frame
 * around an inline script, so one further along leaves a half-parsed bar on screen: with the script inside the actions'
 * slot the links stood 117px off for one frame, in 23 of 25 signed-in loads and 8 of 25 signed-out ones.
 * A client-side navigation runs no inline script, and needs none: the first render in the browser already reads the hint.
 */
export function NavSessionMark() {
  return <InlineScript html={SESSION_HINT_PREPAINT} />;
}

/**
 * The bar's actions: `signedOut` as rendered by the server, `signedIn` alone in its place when the hint is set.
 *
 * "Dashboard" sits right after the item before it, as on a server-drawn page: the slot is only ever as wide as what it
 * shows. (It used to keep the wider signed-out pair as an invisible sizer, which left a gap after the Help icon.)
 *
 * Nothing in the bar moves on the way there. The server's markup is the signed-out one; under the mark (NavSessionMark,
 * on the bar, the `group/nav-session` these variants ask) CSS drops the signed-out pair and holds the room with a sizer
 * as wide as the button (the button's classes; its label drawn by CSS, so the page served to everyone has no "Dashboard"
 * link or text). After hydration React draws the real link there.
 * Below `sm` the slot is not drawn at all (the phone panel carries the actions).
 */
export function NavSessionSwap({
  signedOut,
  signedIn,
  signedInLabel,
}: {
  signedOut: React.ReactNode;
  signedIn: React.ReactNode;
  /** `signedIn`'s own text, for the sizer. */
  signedInLabel: string;
}) {
  const hinted = useSessionHint();
  return (
    <div className="hidden items-center sm:flex" data-testid="nav-session-slot">
      {hinted ? (
        signedIn
      ) : (
        <>
          <div className="flex items-center gap-2 group-data-[signed-in]/nav-session:hidden">{signedOut}</div>
          <span
            aria-hidden="true"
            data-label={signedInLabel}
            className="btn btn-primary invisible hidden whitespace-nowrap text-sm before:content-[attr(data-label)] group-data-[signed-in]/nav-session:inline-flex"
          />
        </>
      )}
    </div>
  );
}
