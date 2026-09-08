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
import type { MatchCentreTabIdT } from "@/server/public-site/match-centre-schema";
import type { LiveFixtureData } from "../live-score-data";
import { LiveScoreBody } from "../live-score";
import { useLiveFixture } from "./use-live-fixture";
import { CourtCard } from "./court-card";
import { TabRail } from "./tab-rail";
import { TAB_PANELS } from "./tab-panels";
import { EMPTY_DECIDED_TEMPLATES } from "./decided-templates";

export interface MatchCentreProps {
  fixtureId: string;
  initial: LiveFixtureData;
  realtime: boolean;
  dict: PublicDict;
  tabParam: string | null;
}

function initialTab(tabParam: string | null, tabs: MatchCentreTabIdT[]): MatchCentreTabIdT {
  if (tabParam && (tabs as string[]).includes(tabParam)) return tabParam as MatchCentreTabIdT;
  return tabs[0]!;
}

export function MatchCentre({ fixtureId, initial, realtime, dict, tabParam }: MatchCentreProps) {
  // CourtCard derives its freshness line from `doc.header.updatedAt`
  // (IMPORTANT 4), not the hook's own `updatedAt` — but `transport` is
  // still needed here, to thread `subscribed` down to whichever panel (or
  // the fallback) ends up calling `LiveScoreBody` (review fix round 2 minor).
  const { data, transport } = useLiveFixture(fixtureId, initial, realtime);
  const subscribed = transport === "realtime";
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
    // Review fix round 2 (Task 10 deferred minor) — when a document IS
    // present (just an empty `tabs` list), its `header.sides` still names
    // both entrants; only the true no-document case has nothing to derive
    // names from.
    const entrantNames = doc
      ? { [doc.header.sides[0].entrantId]: doc.header.sides[0].name, [doc.header.sides[1].entrantId]: doc.header.sides[1].name }
      : {};
    return (
      <div data-testid="mc-fallback">
        <LiveScoreBody
          data={data}
          entrantNames={entrantNames}
          sportKey={doc?.sportKey ?? ""}
          decidedTemplates={EMPTY_DECIDED_TEMPLATES}
          dict={dict}
          subscribed={subscribed}
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
      {/* R11 fix round, C8 — the "sets" tab's label reads the sport's OWN
          unit (`doc.sets?.unit`: "set"/"game"/"period"), never a fixed
          word — see `tab-rail.tsx`'s own doc comment. */}
      <TabRail tabs={doc.tabs} active={active} onChange={onChange} dict={dict} setsUnit={doc.sets?.unit} />
      {/* Whole-branch review, Accessibility group — `tabIndex={0}`. The Info
          and Timeline panels contain NO focusable element at all (prose,
          definition rows, a list of lines), so a keyboard user arrowing along
          the rail and pressing Tab landed PAST the content the rail had just
          selected, with no way to reach or scroll it. The APG tabs pattern
          gives the panel itself a tab stop for exactly that case.
          UNCONDITIONAL, not "only when nothing inside is focusable": which
          panels hold a focusable child is document-dependent (a scorecard's
          scroll regions exist only when there are rows to scroll), so a
          conditional would be a rule that silently changed with the data. */}
      <div
        role="tabpanel"
        tabIndex={0}
        id={`mc-tab-panel-${active}`}
        aria-labelledby={`mc-tab-${active}`}
        data-testid={`mc-tab-panel-${active}`}
      >
        <ActivePanel doc={doc} dict={dict} data={data} subscribed={subscribed} />
      </div>
    </div>
  );
}
