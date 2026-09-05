// Spectator surface W1, Task 13 — the shell every tab panel's root uses.
//
// IT DELIBERATELY CARRIES NO `role="tabpanel"`, NO `id` AND NO
// `aria-labelledby`. `MatchCentre` wraps whichever panel is active in ONE
// element that owns all three (plus `data-testid="mc-tab-panel-<id>"`), so a
// panel that also declared them would nest two tabpanels inside each other —
// two elements claiming the same role, and an `id` that appears twice in the
// document the moment anything renders a second panel.
//
// What is left here is worth keeping anyway: one place that names each panel's
// own testid from its tab id, so the five roots cannot drift apart.
import type { ReactNode } from "react";
import type { MatchCentreTabIdT } from "@/server/public-site/match-centre-schema";

export function TabPanel({
  id,
  className,
  children,
}: {
  id: MatchCentreTabIdT;
  className?: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <div data-testid={`mc-${id}`} className={className}>
      {children}
    </div>
  );
}
