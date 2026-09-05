"use client";
// Spectator surface W1, Task 10 — the match-centre root (W0 option A): court
// card → tab rail → the active tab's panel, re-rendered wholesale whenever
// `useLiveFixture` delivers a new document (rule R10 — every tab updates in
// place, never a reload, because ALL of it is derived from `doc` on every
// render). Composition is one DOM, phone-first classes throughout (rule R1);
// `TabRail`/`CourtCard` carry the ≥`md` behaviour themselves.
import { useCallback, useState } from "react";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import type { MatchCentreTabIdT } from "@/server/public-site/match-centre-schema";
import type { LiveFixtureData } from "../live-score-data";
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

export function MatchCentre({ fixtureId, initial, realtime, dict, tabParam }: MatchCentreProps) {
  const { data, updatedAt } = useLiveFixture(fixtureId, initial, realtime);
  const doc = data.match_centre;

  // Hooks run unconditionally every render (Rules of Hooks) even though `doc`
  // can be absent — see the `if (!doc) return null` AFTER every hook below,
  // never before one. `doc` is expected to always be present once a caller
  // actually mounts `MatchCentre` (no page does yet — ruling 1 of the Task 10
  // dispatch: the server side that populates `match_centre` is a later task);
  // this guard exists purely so the shared `LiveFixtureData` type (still used
  // by the legacy, `match_centre`-less `LiveScore`) does not force it here.
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

  if (!doc) return null;

  const active =
    manualTab && (doc.tabs as MatchCentreTabIdT[]).includes(manualTab) ? manualTab : initialTab(tabParam, doc.tabs);
  const ActivePanel = TAB_PANELS[active];

  return (
    <div data-testid="mc-root" className="space-y-4">
      <CourtCard header={doc.header} dict={dict} updatedAt={updatedAt} />
      <TabRail tabs={doc.tabs} active={active} onChange={onChange} dict={dict} />
      <ActivePanel doc={doc} dict={dict} data={data} />
    </div>
  );
}
