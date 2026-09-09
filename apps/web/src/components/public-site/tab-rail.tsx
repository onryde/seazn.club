"use client";
// Spectator surface W2, Task 7 — the generic tab rail behind the competition
// hub's OWN sections (Overview/Matches/Table/Stats/Teams/Info). Same DOM
// contract and pill classes as W1's `TabRail` (`match-centre/tab-rail.tsx`,
// `tabs.tsx:18,30-33`) but parameterised on caller-supplied `{id,label}`
// pairs instead of the match-centre's fixed dictionary lookups — the hub's
// tab set is DERIVED per document (`deriveHubTabs`), so this rail cannot
// hard-code a vocabulary the way `TabRail` does.
import { useEffect, useRef, type KeyboardEvent } from "react";
import { prefersReducedMotion, scrollActiveTabIntoView } from "./match-centre/tab-rail";

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
// not restate a "quieter" or differently-sized variant), and the SAME
// button/span split as `match-centre/tab-rail.tsx:124-127`.
//
// The split is the whole point and this file used to describe it while doing
// the opposite: both constants were concatenated onto one `<button>`, so
// `min-h-11` stretched the `bg-accent rounded-full` background itself to 44px
// and the hub's tabs rendered visibly chunkier than the match centre's and
// than `tabs.tsx`'s — on surfaces a spectator moves between in one session.
// W1 separated them deliberately after `boundingBox()` measured a 32px tap
// target at 320 in defect round 15b: per `_DESIGN.md` P2, "the pill keeps its
// look, the button carries the hit area". So the BUTTON is the 44px hit
// target (it also carries `shrink-0`, since it is what must not shrink in the
// scrolling flex row) and the inner SPAN carries the pill's visual classes,
// unchanged.
const TAB_BUTTON_CLASS = "shrink-0 flex min-h-11 items-center justify-center";
const ACTIVE_PILL_CLASS = "rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-accent-ink shadow-sm";
const INACTIVE_PILL_CLASS =
  "rounded-full px-4 py-1.5 text-sm font-medium text-ink-muted transition hover:bg-accent-soft hover:text-accent-strong";

export function PublicTabRail<Id extends string>({
  tabs,
  active,
  onChange,
  ariaLabel,
  testidPrefix,
}: PublicTabRailProps<Id>) {
  const buttonRefs = useRef<Partial<Record<Id, HTMLButtonElement | null>>>({});

  // W1's C6 fix, carried forward by IMPORT rather than re-derived (review I3).
  // This rail is `overflow-x-auto` carrying up to six tabs
  // (`deriveHubTabs`'s widest output is
  // `[overview, matches, table, stats, teams, info]`), which comfortably
  // overflows 320 at `px-4 py-1.5 text-sm` — so a tab picked via a `?tab=`
  // deep link (Task 13's exact trigger) or a keyboard Home/End jump past the
  // fold renders CLIPPED at the viewport edge unless the rail scrolls it in.
  // `match-centre/tab-rail.tsx` found and fixed precisely this
  // (`match-a-tab-commentary-320.png`) and the shipping rail had neither half.
  //
  // The resize listener is the second half and just as load-bearing: a click
  // made while the rail is wide enough needs no scroll at all, and a later
  // resize down to a phone width does not itself change `active`, so an
  // effect keyed on `[active]` alone fires once at the wrong width. Mount is
  // covered by the same run — the deep link resolves to a starting `active`
  // the first render already carries.
  useEffect(() => {
    const run = () => scrollActiveTabIntoView(buttonRefs.current[active], prefersReducedMotion());
    run();
    window.addEventListener("resize", run);
    return () => window.removeEventListener("resize", run);
  }, [active]);

  // Left/Right (adjacent tab, wrapping) and Home/End (first/last) — the same
  // APG "automatic activation" behaviour `match-centre/tab-rail.tsx`'s own
  // `handleKeyDown` implements, generalised over caller-supplied tabs.
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // An EMPTY rail has no next tab, and the arithmetic below produces `NaN`
    // for the arrows (`(-1 + 1) % 0`) and an out-of-range index for Home/End
    // — all of which are `!== null`, so `tabs[nextIndex]!` is `undefined` and
    // `next.id` throws a TypeError that unmounts the tree. A hub document
    // cannot reach it (`tabs: z.array(…).min(1)`), but this is an exported
    // GENERIC primitive: Task 12's division rail and every later caller
    // inherit the crash, and none of them share that schema constraint.
    if (tabs.length === 0) return;
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
    // Wrapper from `tabs.tsx:18` MINUS its `mb-5` — the hub page owns its own
    // section spacing. Not "verbatim", as an earlier version of this comment
    // claimed. The `-mx-4 px-4` edge bleed is unconditional here where
    // `match-centre/tab-rail.tsx:177` scopes its own to `max-md:`; both rails
    // ship that way today and reconciling them is Task 19's job, when the two
    // are folded together and one of the two behaviours can be chosen against
    // a screenshot rather than guessed at.
    <div className="sticky top-[54px] z-30 -mx-4 bg-canvas/90 px-4 py-2 backdrop-blur">
      <div
        // NO `tabIndex` on the tablist. W1's whole-branch review found and
        // fixed exactly this on `match-centre/tab-rail.tsx:38-49`: a rail with
        // its own `tabIndex={0}` plus one focusable button per tab costs a
        // keyboard user N+1 tab stops before they reach the content. The APG
        // tabs pattern puts exactly ONE stop on the rail — the SELECTED tab —
        // and moves between tabs with the arrow keys, which `handleKeyDown`
        // already implements. `onKeyDown` stays here regardless: the event
        // bubbles up from the focused button.
        role="tablist"
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
              // Roving tabindex — the selected tab is the rail's single tab
              // stop. Placed BEFORE `data-testid`, matching `TabRail`, because
              // the pill-class assertions capture the attributes that FOLLOW
              // `data-testid`, and an attribute wedged in between reds a test
              // about something else entirely.
              tabIndex={isActive ? 0 : -1}
              data-testid={`${testidPrefix}-tab-${tab.id}`}
              aria-selected={isActive}
              onClick={() => onChange(tab.id)}
              className={TAB_BUTTON_CLASS}
            >
              <span className={isActive ? ACTIVE_PILL_CLASS : INACTIVE_PILL_CLASS}>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
