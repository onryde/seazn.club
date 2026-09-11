"use client";
// The public surface's ONE `?tab=` reader.
//
// This is an EXTRACTION, not a new mechanism, and the reason it exists is
// written up at length in `tabs.tsx`'s own header: the division page and the
// competition hub both need a deep-linkable tab on an ISR route, and both of
// them are `export const revalidate = …`, so reading `searchParams` on the
// server would make the whole route DYNAMIC and trade the public surface's CDN
// caching for a tab default. `tabs.tsx` closed with "the right end state is ONE
// — most likely a shared `useTabParam()` both call", and deferred it because
// doing it then meant touching W1's merged match centre mid-wave. Task 11 is
// the third caller, so it is done here instead of written a third time.
//
// WHY NOT `useSearchParams`. Next's own hook bails its calling subtree to
// CLIENT-SIDE RENDERING up to the nearest `<Suspense>` boundary (its docs say
// so, and a static build without the boundary fails outright). W1's match
// centre pays that cost today at `match-centre/match-centre-with-tab-param.tsx`
// — a `<Suspense>` whose fallback is the same component with `tabParam={null}`.
// Reading `window.location` through `useSyncExternalStore` costs one frame
// instead and additionally survives Back/Forward via `popstate`, so this is
// where the two mechanisms converge. **W1 STILL HAS ITS OWN**: converging the
// match centre is owed work, deliberately not done from this task, because it
// is a merged surface with its own suite and its own `<Suspense>` boundary in a
// page file. Two mechanisms is the state of the tree until that lands; three
// was the state this file prevents.
//
// WHY `useSyncExternalStore` AND NOT `useState` + a mount effect. The query
// string is an external store in React's own sense — the browser owns it,
// components only read it — and `setActive` from an effect body is exactly the
// cascading render `react-hooks/set-state-in-effect` warns about
// (`v2/scorepad/v3/scorebug.tsx:56-76` moved off that shape for that rule;
// `components/client-time.tsx` still carries four of the warnings).
import { useSyncExternalStore } from "react";

/**
 * Subscribe to the things that can change `?tab=` WITHOUT a render.
 *
 * `popstate` and nothing else: our own `history.replaceState` — the write both
 * callers perform when a spectator taps a tab — deliberately does NOT fire it,
 * and must not, because by then the tap has already moved the component's own
 * state and a store update would be a second, redundant render.
 *
 * Exported for its own test. There is no other way to witness it: the hook's
 * browser arm is unreachable from every component test on this surface, because
 * `renderToStaticMarkup` and the shared `_hook-harness` dispatcher BOTH answer
 * `useSyncExternalStore` with the server snapshot by contract.
 */
export function subscribeToTabParam(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

/**
 * The raw `?tab=` value, or null when the parameter is absent.
 *
 * RAW on purpose — no validation, no defaulting. Which ids are legal differs
 * per caller (the division page has three, the hub derives its list per
 * document and drops `gallery`), and a shared reader that guessed would either
 * have to know all of them or would quietly accept a stale one. Every caller
 * already owes a membership test against ITS OWN renderable list, because the
 * document changes under a live page (Task 8, review F1/F2): a value that is
 * legal at first paint can stop being legal on the next poll.
 *
 * Note a valueless `?tab=` reads as `""`, not null — `URLSearchParams.get`'s
 * own behaviour. It is passed through rather than folded to null so a caller's
 * membership test is what rejects it; `""` is no tab's id, so every caller's
 * test already does.
 */
export function readTabParam(): string | null {
  return new URLSearchParams(window.location.search).get("tab");
}

/**
 * Put the chosen tab back in the URL, so what a spectator shares is what they
 * are looking at.
 *
 * `replaceState`, never `pushState`: a tab is not a page, and stacking history
 * entries would make Back walk the tab bar instead of leaving the competition.
 * It deliberately does not fire `popstate` — the tap has already moved the
 * caller's own state, and a store update would be a second, redundant render.
 *
 * ⚠️ WHAT THIS CREATES, and the reason it lives beside `readTabParam` instead
 * of in each caller: after this runs, `readTabParam()` returns OUR OWN WRITE.
 * The parameter stops being an arrival fact and becomes an echo, and a caller
 * that keeps treating it as "the tab this spectator arrived on" is reading its
 * own output as input. That is exactly the defect the final review found in
 * `competition-landing.tsx` — see `arrivalTab` there. The two halves of the
 * round trip are in one file so the next reader meets the hazard at the same
 * time as the mechanism.
 */
export function writeTabParam(tab: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("tab", tab);
  window.history.replaceState(null, "", url.toString());
}

/** The SERVER snapshot, always null. React renders this on the server and again
 *  on the hydrating client's first pass, so the markup cannot mismatch; the
 *  browser value arrives on the frame after. A caller that must open on the
 *  deep-linked tab in the HTML itself needs a dynamic route, which is the trade
 *  this whole module exists to avoid. */
function readTabParamOnServer(): string | null {
  return null;
}

/** The `?tab=` value the browser currently shows, re-read on Back/Forward. */
export function useTabParam(): string | null {
  return useSyncExternalStore(subscribeToTabParam, readTabParam, readTabParamOnServer);
}
