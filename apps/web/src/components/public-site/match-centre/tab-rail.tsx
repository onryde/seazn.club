// Spectator surface W1, Task 10 — the match-centre tab rail (W0 option A).
// Segmented-pill pattern from `tabs.tsx` (accent bg active / accent-soft
// otherwise), sized down to `px-2.5 py-0.5` (Task 10 dispatch Step 3) so all
// six tab ids fit a phone-width rail without truncation. One DOM, phone-first:
// `overflow-x-auto` plus `max-md:-mx-4 max-md:px-4` bleeds the rail to the
// viewport edge below `md`; `md` and up adds no extra control (rule R1/R10).
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { MatchCentreTabIdT } from "@/server/public-site/match-centre-schema";

export interface TabRailProps {
  tabs: MatchCentreTabIdT[];
  active: MatchCentreTabIdT;
  onChange: (tab: MatchCentreTabIdT) => void;
  dict: PublicDict;
}

const ACTIVE_CLASS = "shrink-0 rounded-full bg-accent px-2.5 py-0.5 text-sm font-semibold text-accent-ink";
const INACTIVE_CLASS =
  "shrink-0 rounded-full bg-accent-soft px-2.5 py-0.5 text-sm font-medium text-accent-strong transition hover:bg-accent";

export function TabRail({ tabs, active, onChange, dict }: TabRailProps) {
  return (
    <div
      role="tablist"
      tabIndex={0}
      aria-label={t(dict, "public.matchCentre.tabs.label")}
      className="flex gap-2 overflow-x-auto max-md:-mx-4 max-md:px-4"
    >
      {tabs.map((tab) => {
        const isActive = tab === active;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            data-testid={`mc-tab-${tab}`}
            aria-selected={isActive}
            onClick={() => onChange(tab)}
            className={isActive ? ACTIVE_CLASS : INACTIVE_CLASS}
          >
            {t(dict, `public.matchCentre.tab.${tab}`)}
          </button>
        );
      })}
    </div>
  );
}
