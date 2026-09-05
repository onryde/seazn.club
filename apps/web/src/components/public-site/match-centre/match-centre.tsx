"use client";
// Spectator surface W1, Task 10 — the match-centre root (W0 option A): court
// card → tab rail → the active tab's panel, re-rendered wholesale whenever
// `useLiveFixture` delivers a new document (rule R10 — every tab updates in
// place, never a reload, because ALL of it is derived from `doc` on every
// render). Composition is one DOM, phone-first classes throughout (rule R1);
// `TabRail`/`CourtCard` carry the ≥`md` behaviour themselves.
//
// Review fix round 1:
// - IMPORTANT 6 — `data.match_centre` absent used to render a silent, blank
//   `null`. Now falls back to `LiveScoreBody` (today's page, degraded but
//   never empty) inside `data-testid="mc-fallback"`. `entrantNames`/
//   `sportKey` have no source without a document, so the fallback passes an
//   empty map and an empty sport key — `LiveScoreBody`'s own
//   `entrantNames[id] ?? "—"` fallbacks already render gracefully for this.
// - MINOR 8 — `doc.tabs[0]!` would crash on an empty `tabs` array (the
//   schema's own `.min(1)` should prevent this, but the crash is one bad
//   document away); an empty `tabs` now takes the SAME fallback as no
//   document at all.
// - IMPORTANT 7 — the active panel is wrapped in the ONE
//   `role="tabpanel" id="mc-tab-panel-<id>" aria-labelledby="mc-tab-<id>"`
//   container the APG tabs pattern needs, applied HERE rather than inside
//   each of the six panel components (5 placeholders + `SummaryTab`) — there
//   is only ever one panel rendered at a time, so one wrapper at the single
//   call site gives the exact same DOM contract without touching every
//   panel file individually.
import { useCallback, useState } from "react";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import type { DecidedOutcomeTemplates } from "@/lib/scoring-vocab";
import type { MatchCentreTabIdT } from "@/server/public-site/match-centre-schema";
import type { LiveFixtureData } from "../live-score-data";
import { LiveScoreBody } from "../live-score";
import { useLiveFixture } from "./use-live-fixture";
import { CourtCard } from "./court-card";
import { TabRail } from "./tab-rail";
import { TAB_PANELS } from "./tab-panels";

export interface MatchCentreProps {
  fixtureId: string;
  initial: LiveFixtureData;
  realtime: boolean;
  dict: PublicDict;
  locale: string;
  tabParam: string | null;
}

function initialTab(tabParam: string | null, tabs: MatchCentreTabIdT[]): MatchCentreTabIdT {
  if (tabParam && (tabs as string[]).includes(tabParam)) return tabParam as MatchCentreTabIdT;
  return tabs[0]!;
}

// Same reasoning as `SummaryTab`'s own `EMPTY_DECIDED_TEMPLATES` (Task 11):
// `LiveScoreBody`'s decided-sentence templates live in the "ui" dictionary
// namespace, not "public", and this fallback has no document at all — never
// mind a namespace to reach into. All-empty templates make
// `renderDecidedOutcome` resolve to `""`, which `LiveScoreBody` treats as
// falsy and renders nothing for, rather than leaking a raw key.
const EMPTY_DECIDED_TEMPLATES: DecidedOutcomeTemplates = { tie: "", plain: "", shootoutPlain: "", byMethod: {} };

export function MatchCentre({ fixtureId, initial, realtime, dict, tabParam }: MatchCentreProps) {
  // Only `data` is needed here — CourtCard now derives its freshness line
  // from `doc.header.updatedAt` (IMPORTANT 4), not the hook's own
  // `updatedAt`/`transport`.
  const { data } = useLiveFixture(fixtureId, initial, realtime);
  const doc = data.match_centre;

  // Hooks run unconditionally every render (Rules of Hooks) even though `doc`
  // can be absent or empty — see the `if (!doc || …) return <fallback/>`
  // AFTER every hook below, never before one.
  //
  // Only an explicit CLICK is stored in state; which tab is actually active
  // is a plain derivation every render (below), never synced via an effect —
  // a poll that drops the manually-picked tab therefore falls back to
  // `tabParam`-or-first on the very next render, with no extra render pass
  // and no `react-hooks/set-state-in-effect` warning.
  const [manualTab, setManualTab] = useState<MatchCentreTabIdT | null>(null);

  // `history.replaceState`, never `push` — switching tabs is not a new page
  // in the browser's history sense (R10: in-place update, not a navigation).
  const onChange = useCallback((tab: MatchCentreTabIdT) => {
    setManualTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", url.toString());
  }, []);

  if (!doc || doc.tabs.length === 0) {
    return (
      <div data-testid="mc-fallback">
        <LiveScoreBody
          data={data}
          entrantNames={{}}
          sportKey=""
          decidedTemplates={EMPTY_DECIDED_TEMPLATES}
          dict={dict}
        />
      </div>
    );
  }

  const active =
    manualTab && (doc.tabs as MatchCentreTabIdT[]).includes(manualTab) ? manualTab : initialTab(tabParam, doc.tabs);
  const ActivePanel = TAB_PANELS[active];

  return (
    <div data-testid="mc-root" className="space-y-4">
      <CourtCard header={doc.header} dict={dict} />
      <TabRail tabs={doc.tabs} active={active} onChange={onChange} dict={dict} />
      <div role="tabpanel" id={`mc-tab-panel-${active}`} aria-labelledby={`mc-tab-${active}`}>
        <ActivePanel doc={doc} dict={dict} data={data} />
      </div>
    </div>
  );
}
