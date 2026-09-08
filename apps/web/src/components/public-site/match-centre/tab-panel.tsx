// Spectator surface W1, Task 13 — the shell every tab panel's root uses.
//
// IT DELIBERATELY CARRIES NO `role="tabpanel"`, NO `id` AND NO
// `aria-labelledby`. `MatchCentre` wraps whichever panel is active in ONE
// element that owns those three, and (as of lane B's own fix round)
// `data-testid="mc-tab-panel-<id>"` as well. A panel that declared them too
// would nest two tabpanels inside each other — two elements claiming the same
// role, and an `id` appearing twice the moment anything renders a second panel.
//
// So the contract splits cleanly: the WRAPPER is the tab panel and answers to
// `mc-tab-panel-<id>`; the PANEL is its content and answers to `mc-<id>`. Each
// panel's own test asserts the trio is ABSENT from its root, which is the only
// way a later hand re-adding `role="tabpanel"` here gets caught before an axe
// run finds it.
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
