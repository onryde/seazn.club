// Spectator surface W1, Task 10 — placeholder tab panels. Task 11 replaced
// the `summary` placeholder with the real `SummaryTab`; scorecard/commentary/
// timeline/sets/info are still built by Tasks 12–13. Every remaining
// placeholder renders ONLY its own testid container — no copy, no data reads
// — so a static-markup test can assert exactly one panel container is
// present per active tab (and the others absent) without depending on panel
// content that doesn't exist yet. Each placeholder takes no parameters even
// though `TAB_PANELS`' value type is `(props: TabPanelProps) => ReactNode` —
// TS structurally allows a function with FEWER declared parameters to
// satisfy a type expecting more, so this avoids an unused-`props` binding in
// components that have nothing to read yet.
import type { ReactNode } from "react";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import type { LiveFixtureData } from "../live-score-data";
import type { MatchCentreDocT, MatchCentreTabIdT } from "@/server/public-site/match-centre-schema";
import { SummaryTab } from "./summary-tab";

export interface TabPanelProps {
  doc: MatchCentreDocT;
  dict: PublicDict;
  data: LiveFixtureData;
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
  summary: SummaryTab,
  scorecard: ScorecardPanelPlaceholder,
  commentary: CommentaryPanelPlaceholder,
  timeline: TimelinePanelPlaceholder,
  sets: SetsPanelPlaceholder,
  info: InfoPanelPlaceholder,
};
