// Spectator surface W1, Task 10 — placeholder tab panels. The real
// summary/scorecard/commentary/timeline/sets/info renderers are built by
// Tasks 11–13; this file exists so `MatchCentre` (this task) has something
// concrete to switch on and so those later tasks have one map to extend
// rather than inventing a second switch. Every placeholder renders ONLY its
// own testid container — no copy, no data reads — so a static-markup test
// can assert exactly one panel container is present per active tab (and the
// others absent) without depending on panel content that doesn't exist yet.
// Each placeholder takes no parameters even though `TAB_PANELS`' value type
// is `(props: TabPanelProps) => ReactNode` — TS structurally allows a
// function with FEWER declared parameters to satisfy a type expecting more,
// so this avoids an unused-`props` binding in five components that have
// nothing to read yet.
import type { ReactNode } from "react";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import type { LiveFixtureData } from "../live-score-data";
import type { MatchCentreDocT, MatchCentreTabIdT } from "@/server/public-site/match-centre-schema";

export interface TabPanelProps {
  doc: MatchCentreDocT;
  dict: PublicDict;
  data: LiveFixtureData;
}

export function SummaryPanelPlaceholder(): ReactNode {
  return <div data-testid="mc-tab-panel-summary" />;
}

export function ScorecardPanelPlaceholder(): ReactNode {
  return <div data-testid="mc-tab-panel-scorecard" />;
}

export function CommentaryPanelPlaceholder(): ReactNode {
  return <div data-testid="mc-tab-panel-commentary" />;
}

export function TimelinePanelPlaceholder(): ReactNode {
  return <div data-testid="mc-tab-panel-timeline" />;
}

export function SetsPanelPlaceholder(): ReactNode {
  return <div data-testid="mc-tab-panel-sets" />;
}

export function InfoPanelPlaceholder(): ReactNode {
  return <div data-testid="mc-tab-panel-info" />;
}

export const TAB_PANELS: Record<MatchCentreTabIdT, (props: TabPanelProps) => ReactNode> = {
  summary: SummaryPanelPlaceholder,
  scorecard: ScorecardPanelPlaceholder,
  commentary: CommentaryPanelPlaceholder,
  timeline: TimelinePanelPlaceholder,
  sets: SetsPanelPlaceholder,
  info: InfoPanelPlaceholder,
};
