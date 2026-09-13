"use client";
// The public surface's ONE query-string reader — `?tab=`, the hub's
// `?division=`, the Knockout tab's `?view=` — and the writer beside it, which
// share one store and one set of reasons.
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
// GENERIC SINCE THE KNOCKOUT TAB (plan 2026-09-13, R6). `?view=` made three
// named parameters, so the reader, the writer and the hook each take a NAME
// now, and the six named exports below are one-line wrappers kept for their
// callers and their tests — which stay exactly as they were.
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
 * Subscribe to the things that can change the query string WITHOUT a render.
 *
 * `popstate` and nothing else: our own `history.replaceState` — the write every
 * caller performs when a spectator taps a control — deliberately does NOT fire
 * it, and must not, because by then the tap has already moved the component's
 * own state and a store update would be a second, redundant render.
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
 * The raw value of the named parameter, or null when it is absent.
 *
 * RAW on purpose — no validation, no defaulting. Which values are legal differs
 * per caller (the division page has three tabs, the hub derives its list per
 * document and drops `gallery`, a division slug is only legal while the live
 * document carries a chip for it), and a shared reader that guessed would
 * either have to know all of them or would quietly accept a stale one. Every
 * caller already owes a membership test against ITS OWN renderable list,
 * because the document changes under a live page (Task 8, review F1/F2): a
 * value that is legal at first paint can stop being legal on the next poll.
 *
 * Note a valueless `?tab=` reads as `""`, not null — `URLSearchParams.get`'s
 * own behaviour. It is passed through rather than folded to null so a caller's
 * membership test is what rejects it; `""` is no tab's id, so every caller's
 * test already does.
 */
export function readSearchParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

/**
 * Put a value back in the URL under `name`, or take the parameter out for
 * `null` — so what a spectator shares is what they are looking at, and a
 * default carries no parameter at all.
 *
 * `replaceState`, never `pushState`: a tab, a division chip or a view switch is
 * not a page, and stacking history entries would make Back walk the controls
 * instead of leaving the competition. It deliberately does not fire `popstate`
 * — the tap has already moved the caller's own state, and a store update would
 * be a second, redundant render.
 *
 * ⚠️ WHAT THIS CREATES, and the reason it lives beside `readSearchParam`
 * instead of in each caller: after this runs, the reader returns OUR OWN WRITE.
 * The parameter stops being an arrival fact and becomes an echo, and a caller
 * that keeps treating it as "the value this spectator arrived with" is reading
 * its own output as input. That is exactly the defect the final review found in
 * `competition-landing.tsx` — see `arrivalTab` there. The two halves of the
 * round trip are in one file so the next reader meets the hazard at the same
 * time as the mechanism.
 */
export function writeSearchParam(name: string, value: string | null): void {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  window.history.replaceState(null, "", url.toString());
}

/** The SERVER snapshot, always null. React renders this on the server and again
 *  on the hydrating client's first pass, so the markup cannot mismatch; the
 *  browser value arrives on the frame after. A caller that must open on the
 *  deep-linked value in the HTML itself needs a dynamic route, which is the
 *  trade this whole module exists to avoid. */
function readParamOnServer(): string | null {
  return null;
}

/**
 * One `getSnapshot` per parameter NAME, created once and reused.
 *
 * `useSyncExternalStore` is handed a `getSnapshot` on every render; a fresh
 * `() => readSearchParam(name)` each time is a new function identity per
 * render, where the two named hooks this replaced each passed one module-level
 * reader. Caching per name keeps that property for any name.
 */
const snapshotReaders = new Map<string, () => string | null>();
function snapshotReaderFor(name: string): () => string | null {
  let reader = snapshotReaders.get(name);
  if (reader === undefined) {
    reader = () => readSearchParam(name);
    snapshotReaders.set(name, reader);
  }
  return reader;
}

/** The named parameter's value the browser currently shows, re-read on
 *  Back/Forward. */
export function useSearchParam(name: string): string | null {
  return useSyncExternalStore(subscribeToTabParam, snapshotReaderFor(name), readParamOnServer);
}

/** The raw `?tab=` value, or null when the parameter is absent. A wrapper over
 *  `readSearchParam` — see there for why it does not validate. */
export function readTabParam(): string | null {
  return readSearchParam("tab");
}

/** Put the chosen tab back in the URL. A wrapper over `writeSearchParam`, whose
 *  comment carries the echo hazard this write creates. */
export function writeTabParam(tab: string): void {
  writeSearchParam("tab", tab);
}

/** The `?tab=` value the browser currently shows, re-read on Back/Forward. */
export function useTabParam(): string | null {
  return useSearchParam("tab");
}

/**
 * The raw `?division=` value, or null when the parameter is absent — the
 * hub's division chip, carried in the URL.
 *
 * WHY THIS EXISTS: `MatchesTab` had declared an `initialDivision` prop
 * documented as "a `?division=` deep link" since W2 Task 8, and nothing ever
 * read the parameter or passed the prop. A spectator sharing a Premier-only
 * view shared a link that opened on All. The prop was unit-green the whole
 * time, because its tests hand it a value directly.
 *
 * RAW for `readSearchParam`'s reason: each tab's own reconciliation is the
 * membership test (a slug with no chip, or `""`, falls back to All), and a
 * reader that validated here would need the live document to do it.
 */
export function readDivisionParam(): string | null {
  return readSearchParam("division");
}

/**
 * Put the chosen division back in the URL, or take it out for All.
 *
 * The echo `writeSearchParam` warns about is HARMLESS here, and deliberately
 * so: the Matches and Knockout tabs read `initialDivision` only as a mount-time
 * seed, never as a live value, so their own write is read back only when a tab
 * MOUNTS again — which is exactly the spectator switching to Stats and back and
 * finding the division they left.
 */
export function writeDivisionParam(slug: string | null): void {
  writeSearchParam("division", slug);
}

/** The `?division=` value the browser currently shows, re-read on Back/Forward.
 *  Same `popstate` subscription as `useTabParam`, and the same null server
 *  snapshot, for the same ISR reason. */
export function useDivisionParam(): string | null {
  return useSearchParam("division");
}
