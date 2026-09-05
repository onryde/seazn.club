// Spectator surface W1, Task 13 — the shell every tab panel's ROOT is.
//
// It exists so the three attributes that make a panel a panel cannot drift
// apart across four files: `role="tabpanel"` announces it, `id` is what the
// rail's `aria-controls` points AT, and `aria-labelledby` points BACK at the
// rail's tab. A panel carrying only a `data-testid` is not a tab panel at all,
// and the relationship is unverifiable from either side alone — so both sides
// have to name it, and here that naming is derived from one `id` argument
// rather than typed out four times.
import type { ReactNode } from "react";
import type { MatchCentreTabIdT } from "@/server/public-site/match-centre-schema";

export function TabPanel({
  id,
  className,
  children,
}: {
  id: MatchCentreTabIdT;
  className?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div
      role="tabpanel"
      id={`mc-tab-panel-${id}`}
      aria-labelledby={`mc-tab-${id}`}
      data-testid={`mc-tab-panel-${id}`}
      className={className}
    >
      {children}
    </div>
  );
}
