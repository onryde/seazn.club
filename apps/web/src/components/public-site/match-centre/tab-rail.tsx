"use client";
// Spectator surface W1, Task 10 — the match-centre tab rail (W0 option A).
// One DOM, phone-first: `overflow-x-auto` plus `max-md:-mx-4 max-md:px-4`
// bleeds the rail to the viewport edge below `md`; `md` and up adds no extra
// control (rule R1/R10).
//
// Review fix round 1:
// - IMPORTANT 2 — pill classes now match the SHIPPED vocabulary in
//   `tabs.tsx:30-31` exactly (active `bg-accent … shadow-sm`; inactive has
//   NO resting background, only a `hover:bg-accent-soft` — my first draft
//   invented a resting `bg-accent-soft` state and a `px-2.5 py-0.5` size
//   that produced a ~24px control and a ~1.3:1 hover-text contrast).
// - IMPORTANT 7 — each tab gets `id="mc-tab-<id>"` and
//   `aria-controls="mc-tab-panel-<id>"` (the panel container carrying that
//   id/role is `MatchCentre`'s job, wrapping whichever panel is active —
//   see match-centre.tsx); the rail supports Left/Right (adjacent tab,
//   wrapping) and Home/End (first/last) per the APG "automatic activation"
//   tabs pattern — moving focus also selects, matching a click's behaviour.
//   Keyboard behaviour itself is not unit-testable in this workspace (no
//   jsdom to dispatch a real KeyboardEvent against); the static test here
//   only pins the id/aria-controls PAIRING `handleKeyDown` and a browser's
//   own Tab-key focus order rely on.
import { useRef } from "react";
import type { Dict as PublicDict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { MatchCentreTabIdT } from "@/server/public-site/match-centre-schema";

export interface TabRailProps {
  tabs: MatchCentreTabIdT[];
  active: MatchCentreTabIdT;
  onChange: (tab: MatchCentreTabIdT) => void;
  dict: PublicDict;
}

const ACTIVE_CLASS = "shrink-0 rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-accent-ink shadow-sm";
const INACTIVE_CLASS =
  "shrink-0 rounded-full px-4 py-1.5 text-sm font-medium text-ink-muted transition hover:bg-accent-soft hover:text-accent-strong";

export function TabRail({ tabs, active, onChange, dict }: TabRailProps) {
  const buttonRefs = useRef<Partial<Record<MatchCentreTabIdT, HTMLButtonElement | null>>>({});

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const idx = tabs.indexOf(active);
    let nextIndex: number | null = null;
    if (e.key === "ArrowRight") nextIndex = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") nextIndex = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    e.preventDefault();
    const next = tabs[nextIndex]!;
    onChange(next);
    buttonRefs.current[next]?.focus();
  }

  return (
    <div
      role="tablist"
      tabIndex={0}
      aria-label={t(dict, "matchCentre.tabs.label")}
      className="flex gap-2 overflow-x-auto max-md:-mx-4 max-md:px-4"
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => {
        const isActive = tab === active;
        return (
          <button
            key={tab}
            ref={(el) => {
              buttonRefs.current[tab] = el;
            }}
            id={`mc-tab-${tab}`}
            type="button"
            role="tab"
            aria-controls={`mc-tab-panel-${tab}`}
            data-testid={`mc-tab-${tab}`}
            aria-selected={isActive}
            onClick={() => onChange(tab)}
            className={isActive ? ACTIVE_CLASS : INACTIVE_CLASS}
          >
            {t(dict, `matchCentre.tab.${tab}`)}
          </button>
        );
      })}
    </div>
  );
}
