"use client";

// The marketing nav's signed-in swap for a page that must stay cacheable (/help, /blog: MarketingNav `auth="client"`).
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

/** The bar's actions: `signedOut` as rendered by the server, `signedIn` in its place when the hint is set. */
export function NavSessionSwap({ signedOut, signedIn }: { signedOut: React.ReactNode; signedIn: React.ReactNode }) {
  return <>{useSessionHint() ? signedIn : signedOut}</>;
}
