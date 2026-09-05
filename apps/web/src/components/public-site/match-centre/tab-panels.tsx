// Spectator surface W1, Task 10 — placeholder tab panels. Task 11 replaced
// the `summary` placeholder with the real `SummaryTab`; scorecard/commentary/
// timeline/sets/info are still built by Tasks 12–13. Each placeholder takes
// no parameters even though `TAB_PANELS`' value type is
// `(props: TabPanelProps) => ReactNode` — TS structurally allows a function
// with FEWER declared parameters to satisfy a type expecting more, so this
// avoids an unused-`props` binding in components that have nothing to read
// yet.
//
// Review fix round 2 — placeholders no longer render their own
// `data-testid="mc-tab-panel-<id>"`: `MatchCentre`'s own tabpanel wrapper
// (`match-centre.tsx`) now carries that testid ALONGSIDE its
// `role="tabpanel"`/`id`/`aria-labelledby`, for every tab regardless of
// whether its panel is a placeholder or a real one — a placeholder that
// ALSO carried it would leave two elements with the SAME `data-testid` in
// the DOM at once (a real, later-caught duplicate-testid bug, not a
// hypothetical one). Placeholders return `null`; the wrapper's testid alone
// is what every panel-identity assertion needs.
import type { ReactNode } from "react";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import type { LiveFixtureData } from "../live-score-data";
import type { MatchCentreDocT, MatchCentreTabIdT } from "@/server/public-site/match-centre-schema";
import { SummaryTab } from "./summary-tab";

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

export function ScorecardPanelPlaceholder(): ReactNode {
  return null;
}

export function CommentaryPanelPlaceholder(): ReactNode {
  return null;
}

export function TimelinePanelPlaceholder(): ReactNode {
  return null;
}

export function SetsPanelPlaceholder(): ReactNode {
  return null;
}

export function InfoPanelPlaceholder(): ReactNode {
  return null;
}

export const TAB_PANELS: Record<MatchCentreTabIdT, (props: TabPanelProps) => ReactNode> = {
  summary: SummaryTab,
  scorecard: ScorecardPanelPlaceholder,
  commentary: CommentaryPanelPlaceholder,
  timeline: TimelinePanelPlaceholder,
  sets: SetsPanelPlaceholder,
  info: InfoPanelPlaceholder,
};
