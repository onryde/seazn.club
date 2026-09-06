// Spectator surface W1, Task 10 — the tab-id → panel map. Task 11 wired the
// `summary` tab to the real `SummaryTab`; Tasks 12–13 built the real
// scorecard/commentary/timeline/sets/info panels, and Task 14 wires the
// remaining five here, retiring the five placeholders that used to stand in
// for them (they returned `null` — see the report/git history for the
// pre-Task-14 shape of this file). Every value is now a REAL panel: TS
// structurally allows a function with fewer declared parameters to satisfy
// `TabPanelProps` (several panels never read `subscribed`), which is why
// their own signatures vary slightly and none of that needs papering over
// here.
//
// `data-testid="mc-tab-panel-<id>"` lives on `MatchCentre`'s own tabpanel
// wrapper (`match-centre.tsx`), never on a panel's own root — see
// `tab-panel.tsx`'s doc comment for why a panel declaring it too would
// duplicate the id/role.
import type { ReactNode } from "react";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import type { LiveFixtureData } from "../live-score-data";
import type { MatchCentreDocT, MatchCentreTabIdT } from "@/server/public-site/match-centre-schema";
import { SummaryTab } from "./summary-tab";
import { ScorecardTab } from "./scorecard-tab";
import { CommentaryTab } from "./commentary-tab";
import { TimelineTab } from "./timeline-tab";
import { SetsTab } from "./sets-tab";
import { InfoTab } from "./info-tab";

export interface TabPanelProps {
  doc: MatchCentreDocT;
  dict: PublicDict;
  data: LiveFixtureData;
  /**
   * Review fix round 2 (minor) — whether the live transport is currently
   * receiving realtime pushes, threaded down from `MatchCentre`'s own
   * `useLiveFixture` result so a panel that falls back to `LiveScoreBody`
   * (`SummaryTab`'s non-cricket and pre-play branches) can pass it through
   * for the pre-existing "· realtime" indicator.
   */
  subscribed?: boolean;
}

export const TAB_PANELS: Record<MatchCentreTabIdT, (props: TabPanelProps) => ReactNode> = {
  summary: SummaryTab,
  scorecard: ScorecardTab,
  commentary: CommentaryTab,
  timeline: TimelineTab,
  sets: SetsTab,
  info: InfoTab,
};
