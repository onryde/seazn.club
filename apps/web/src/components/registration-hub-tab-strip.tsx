"use client";

// B7 T24 (spec 2026-11-13 §9.4) — the registration hub's tab strip: Settings, Registrants, then up to two division settings
// tabs, each with its own close button, and a trailing slot (Export CSV on Registrants, B6 T20) right-aligned on the same row.
// Presentation only: the host (registration-hub-tabs-host.tsx) works out every tab, its href and its dirty dot, and owns
// what a close does.
//
// Why a <nav> of links, not role="tablist" (a recorded deviation from §9.4's wording). Every tab is a LINK — each one is an
// address with its own history entry (§9.2: "push") — and a division tab carries a sibling close BUTTON. axe 4.12's
// `aria-required-children` (impact critical) fails a tablist that owns anything but tabs, so a sibling button inside one is a
// violation, and the same button inside the tab is `nested-interactive`. A navigation landmark of links with
// `aria-current="page"` on the one on screen is what these are, takes the buttons, and is the strip this page already had.
//
// The scroller is the nav itself: it scrolls inside itself below the width the tabs need and never the page, and as a
// scrolling region it is focusable (tabindex 0) and named (AGENTS.md class 23). The tab on screen is scrolled into view
// whenever it changes, horizontally only, so arriving on a tab never moves the page.
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import Link from "@/components/ui/console-link";

export interface HubStripTab {
  /** "settings", "registrants", or the division id. */
  key: string;
  label: string;
  href: string;
  active: boolean;
  /** Present on a division settings tab. */
  division?: {
    id: string;
    dirty: boolean;
    /** "Close {name}". */
    closeLabel: string;
    onClose: () => void;
  };
}

export function RegistrationHubTabStrip({
  label,
  unsavedLabel,
  tabs,
  end,
  onFollow,
}: {
  /** The strip's accessible name ("Registration sections"). */
  label: string;
  /** What the dirty dot says ("Unsaved changes"). */
  unsavedLabel: string;
  tabs: readonly HubStripTab[];
  /** Right-aligned on the tabs row from md up; its own line below md. */
  end?: ReactNode;
  /** Told before a tab's link is followed (the host remembers where Settings was scrolled to). */
  onFollow?: (key: string) => void;
}) {
  const navRef = useRef<HTMLElement>(null);
  const activeKey = tabs.find((tab) => tab.active)?.key ?? null;

  // The tab on screen, brought into the strip's own view — the strip stays mounted across tab switches, so this runs on every
  // change, not once. Its scrollLeft only: scrollIntoView would also scroll the page to the strip.
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active) return;
    const box = nav.getBoundingClientRect();
    // The whole tab, its close button included, and a little room beyond it for the fade on the right.
    const tab = (active.closest("[data-reg-hub-tab-group]") ?? active).getBoundingClientRect();
    if (tab.left < box.left) nav.scrollLeft -= box.left - tab.left + 8;
    else if (tab.right > box.right) nav.scrollLeft += tab.right - box.right + 24;
  }, [activeKey]);

  const follow = (key: string) => (onFollow ? () => onFollow(key) : undefined);
  const sectionTabs = tabs.filter((tab) => !tab.division);
  const divisionTabs = tabs.filter((tab) => tab.division);

  return (
    // From md up the row owns the rule under both the strip and the trailing slot; below md the strip keeps its own rule and the
    // slot wraps to a right-aligned line under it, where Export always sat.
    <div
      data-registration-hub-tabs-row
      className="mb-6 flex min-w-0 flex-wrap items-end justify-between gap-x-3 gap-y-2 md:flex-nowrap md:border-b md:border-slate-200"
    >
      <nav
        ref={navRef}
        aria-label={label}
        tabIndex={0}
        data-reg-hub-tab-strip
        className="scroll-x scroll-x-fade flex min-w-0 grow items-end whitespace-nowrap rounded-t-md border-b border-slate-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-500 max-md:basis-full md:border-b-0"
      >
        {sectionTabs.map((tab) => (
          <Link
            key={tab.key}
            href={tab.href}
            data-testid={`reg-hub-tab-${tab.key}`}
            aria-current={tab.active ? "page" : undefined}
            onClick={follow(tab.key)}
            className={`inline-flex min-h-11 shrink-0 items-center border-b-2 px-4 text-sm font-medium transition-colors ${
              tab.active ? "border-purple-600 text-purple-700" : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {tab.label}
          </Link>
        ))}
        {divisionTabs.length > 0 && (
          // The open divisions are a different kind of tab from the two sections: a hairline sets them apart.
          <span aria-hidden className="mx-1 mb-3 h-5 w-px shrink-0 self-end bg-slate-200" />
        )}
        {divisionTabs.map((tab) => {
          const division = tab.division!;
          return (
            <div
              key={tab.key}
              data-reg-hub-tab-group
              className={`flex min-w-0 shrink-0 items-center border-b-2 transition-colors ${
                tab.active ? "border-purple-600" : "border-transparent"
              }`}
            >
              <Link
                href={tab.href}
                data-testid="reg-hub-tab-division"
                data-division-id={division.id}
                aria-current={tab.active ? "page" : undefined}
                onClick={follow(tab.key)}
                className={`flex min-h-11 min-w-0 items-center gap-1.5 pl-4 pr-1 text-sm font-medium transition-colors ${
                  tab.active ? "text-purple-700" : "text-slate-500 hover:text-slate-800"
                }`}
              >
                <span className="min-w-0 max-w-[12rem] truncate">{tab.label}</span>
                {division.dirty && (
                  <span
                    role="img"
                    aria-label={unsavedLabel}
                    data-reg-hub-tab-dirty
                    className="h-2 w-2 shrink-0 rounded-full bg-purple-600"
                  />
                )}
              </Link>
              <button
                type="button"
                data-testid="reg-hub-tab-close"
                data-division-id={division.id}
                aria-label={division.closeLabel}
                onClick={division.onClose}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-slate-400 transition-colors hover:bg-purple-50 hover:text-purple-700 focus-visible:outline-2 focus-visible:outline-purple-500"
              >
                <X className="h-4 w-4" strokeWidth={2} aria-hidden />
              </button>
            </div>
          );
        })}
      </nav>
      {end}
    </div>
  );
}
