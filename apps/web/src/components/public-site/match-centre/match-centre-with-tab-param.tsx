"use client";
// Spectator surface W1, Task 14d — the fixture page's ISR contract (task-8:
// `revalidate = 30` + an empty-array `generateStaticParams`) is incompatible
// with reading `searchParams` on the SERVER: this Next version throws
// `DYNAMIC_SERVER_USAGE` on every request once the page component reads it
// directly (confirmed live — see page.tsx's own history). The `?tab=` deep
// link moves HERE instead, read client-side via `useSearchParams`
// (next/navigation). Per that hook's own docs
// (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/
// use-search-params.md, "Prerendering"): calling it on a prerendered route
// bails the CALLING component's subtree to client-side rendering, up to the
// nearest `<Suspense>` boundary — and a production build of a static page
// that calls it WITHOUT that boundary fails outright ("Missing Suspense
// boundary with useSearchParams").
//
// The Suspense fallback below is not a spinner — it is the SAME
// `<MatchCentre>`, with `tabParam={null}` (its own documented default: the
// document's first tab). That keeps the FULL match centre — scoreboard,
// tabs, active panel — inside the cached static/ISR HTML; only the deep-link
// tab CHOICE itself waits for the hydration pass that resolves
// `useSearchParams` (a synchronous read of `window.location`, no network
// round trip, so the swap is not a visible loading state in practice).
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { MatchCentre, type MatchCentreProps } from "./match-centre";

export type MatchCentreTabParamProps = Omit<MatchCentreProps, "tabParam">;

function MatchCentreDeepLinked(props: MatchCentreTabParamProps) {
  const searchParams = useSearchParams();
  return <MatchCentre {...props} tabParam={searchParams.get("tab")} />;
}

export function MatchCentreWithTabParam(props: MatchCentreTabParamProps) {
  return (
    <Suspense fallback={<MatchCentre {...props} tabParam={null} />}>
      <MatchCentreDeepLinked {...props} />
    </Suspense>
  );
}
