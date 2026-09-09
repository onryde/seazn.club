"use client";
// Spectator surface W2, Task 7 — the generic tab rail behind the competition
// hub's OWN sections (Overview/Matches/Table/Stats/Teams/Info). Same DOM
// contract and pill classes as W1's `TabRail` (`match-centre/tab-rail.tsx`,
// `tabs.tsx:18,30-33`) but parameterised on caller-supplied `{id,label}`
// pairs instead of the match-centre's fixed dictionary lookups — the hub's
// tab set is DERIVED per document (`deriveHubTabs`), so this rail cannot
// hard-code a vocabulary the way `TabRail` does.
import { useRef, type KeyboardEvent } from "react";

export interface PublicTabRailProps<Id extends string> {
  tabs: { id: Id; label: string }[];
  active: Id;
  onChange: (id: Id) => void;
  ariaLabel: string;
  /** Every id/testid this rail emits is `${testidPrefix}-tab-...` — lets more
   *  than one rail exist on a page without their ids colliding. */
  testidPrefix: string;
}

// Pill classes verbatim from `tabs.tsx:30-33` (the SHIPPED vocabulary — do
// not restate a "quieter" or differently-sized variant). `min-h-11` is added
// on the button itself for the 44px tap target (R11's own reasoning in
// `match-centre/tab-rail.tsx`), not part of the pill's visual class.
const TAB_BUTTON_BASE = "min-h-11 flex items-center justify-center";
const ACTIVE_PILL_CLASS =
  "shrink-0 rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-accent-ink shadow-sm";
const INACTIVE_PILL_CLASS =
  "shrink-0 rounded-full px-4 py-1.5 text-sm font-medium text-ink-muted transition hover:bg-accent-soft hover:text-accent-strong";

export function PublicTabRail<Id extends string>({
  tabs,
  active,
  onChange,
  ariaLabel,
  testidPrefix,
}: PublicTabRailProps<Id>) {
  const buttonRefs = useRef<Partial<Record<Id, HTMLButtonElement | null>>>({});

  // Left/Right (adjacent tab, wrapping) and Home/End (first/last) — the same
  // APG "automatic activation" behaviour `match-centre/tab-rail.tsx`'s own
  // `handleKeyDown` implements, generalised over caller-supplied tabs.
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const idx = tabs.findIndex((tab) => tab.id === active);
    let nextIndex: number | null = null;
    if (e.key === "ArrowRight") nextIndex = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") nextIndex = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    e.preventDefault();
    const next = tabs[nextIndex]!;
    onChange(next.id);
    buttonRefs.current[next.id]?.focus();
  }

  return (
    // Wrapper verbatim from `tabs.tsx:18`.
    <div className="sticky top-[54px] z-30 -mx-4 bg-canvas/90 px-4 py-2 backdrop-blur">
      <div
        role="tablist"
        tabIndex={0}
        aria-label={ariaLabel}
        className="flex gap-1 overflow-x-auto"
        onKeyDown={handleKeyDown}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                buttonRefs.current[tab.id] = el;
              }}
              id={`${testidPrefix}-tab-${tab.id}`}
              type="button"
              role="tab"
              // Only the active tab, matching `TabRail`'s own fix: a panel
              // container that renders only the ACTIVE panel means every
              // other tab's `aria-controls` would name an element that is
              // not in the document.
              aria-controls={isActive ? `${testidPrefix}-tab-panel-${tab.id}` : undefined}
              data-testid={`${testidPrefix}-tab-${tab.id}`}
              aria-selected={isActive}
              onClick={() => onChange(tab.id)}
              className={`${TAB_BUTTON_BASE} ${isActive ? ACTIVE_PILL_CLASS : INACTIVE_PILL_CLASS}`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
