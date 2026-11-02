"use client";

// Match Day C5 (owner request 2026-11-01, with a screenshot): the competition masthead's tool row read Slideshow ↗ · Schedule
// Board · View Public Page ↗ · QR · Registration · Settings, and the owner asked for the three "go and look at it" tools to be
// ONE button with a drop-down — "Open", then the three. This is that button.
//
// The pattern is the house's popover (`ui/card-menu.tsx`, `help-menu.tsx`): a `aria-haspopup="menu"` trigger, a `role="menu"`
// panel of link items, dismissed by an outside press, Escape, or choosing an item. Two deliberate differences:
//   - the panel is `hidden`, not unmounted, while closed. A closed `{open && …}` menu renders NOTHING on the server, so a render
//     test (and a crawler, and a "folded away" vs "never rendered" diagnosis) could not see that the tools are in the menu.
//     `DeskToolsMore` (the phone fold beside this) does the same for the same reason.
//   - Escape hands focus back to the trigger. A menu that closes with focus on a vanished element drops a keyboard user at the
//     top of the page.
// No arrow-key roving: no menu in this house has it (card-menu, help-menu, org-switcher), and a lone menu growing a different
// keyboard model from its siblings is worse than none — the items are ordinary links, reachable with Tab.
//
// TWO CALLERS, one component, each choosing its phone treatment through `className` / `panelClassName`:
//   - the COMPETITION page is desktop only (it supplies `max-md:hidden`). Below `md` its masthead already folds these same three
//     destinations, plus Settings, into the labelled "More" disclosure (`DeskToolsMore`, F2 round J) at the 44px floor; a second
//     drop-down listing the same links beside it would be the duplication that fold exists to avoid.
//   - the DIVISION page (C5b) has no phone fold, so Open is its one menu at every width. Below `md` the trigger clears the 44px
//     floor (`max-md:min-h-11`, here, so it holds for any caller) and the panel opens as a full-width sheet under the header row.
//
// A fourth item, "Match Day", leads the menu on a day that is NOT a match day (owner addition 2026-11-01): the filled Open Match Day
// button only exists on the day, and the door should not vanish the rest of the week. The page decides which of the two the
// organiser sees — never both — and this component just lists what it is handed (same tab, no ↗: it is the console, not a viewer).
//
// The icons stay what they were on the three buttons this replaces. They are keyed by `id` rather than passed as components,
// because the page is a server component and a component cannot cross into a client island as a prop.
import Link from "@/components/ui/console-link";
import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Globe, MonitorPlay, Printer, Radio } from "lucide-react";

export type DeskOpenIcon = "matchday" | "slideshow" | "public" | "qr";

export interface DeskOpenItem {
  id: DeskOpenIcon;
  /** The visible words (an existing `action.*` key, resolved by the server parent). */
  label: string;
  /** The accessible name — the same `aria.*…NewTab` the standalone button carried. Omitted when the visible words are the name. */
  ariaLabel?: string;
  href: string;
  /** Opens in a new tab. Required, not defaulted: a forgotten flag would silently keep the organiser's console behind them. */
  newTab: boolean;
  /** The ↗ mark: set on every item that opens a new tab (Slideshow, View Public Page and QR, since 2026-11-01), never on a same-tab one. */
  arrow?: boolean;
  /** A plain `<a>` rather than a router link: the QR poster is a PDF route handler, not a page. */
  plainAnchor?: boolean;
}

const ICONS = { matchday: Radio, slideshow: MonitorPlay, public: Globe, qr: Printer } as const;

export function DeskOpenMenu({
  label,
  items,
  className = "",
  panelClassName = "",
}: {
  label: string;
  items: DeskOpenItem[];
  /** On the wrapper. The competition page adds `max-md:hidden`; the division page adds `max-md:static` (see `panelClassName`). */
  className?: string;
  /** Appended to the panel. A caller that wants the panel to open as a full-width sheet under a positioned row on a phone says so
   *  here (`max-md:inset-x-0 max-md:w-auto max-md:max-w-none`) and makes the wrapper `max-md:static`: the division page, whose
   *  trigger sits at an x that depends on how its title wraps, so no fixed anchor side is safe at 320. */
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Nothing to open → no button (a trigger over an empty menu is a dead control).
  if (items.length === 0) return null;

  return (
    <div ref={rootRef} data-testid="desk-open-menu" className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        data-testid="desk-open-menu-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={`btn btn-ghost gap-1.5 max-md:min-h-11 ${open ? "bg-purple-50 text-purple-700" : ""}`}
      >
        <span>{label}</span>
        <ChevronDown
          aria-hidden
          className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
          strokeWidth={1.75}
        />
      </button>
      <div
        id={panelId}
        role="menu"
        aria-label={label}
        hidden={!open}
        className={`absolute left-0 top-full z-30 mt-1 w-max min-w-full max-w-[85vw] rounded-xl border border-purple-100 bg-white py-1 shadow-lg ${panelClassName}`}
      >
        {items.map((item) => {
          const Icon = ICONS[item.id];
          const props = {
            role: "menuitem",
            href: item.href,
            target: item.newTab ? "_blank" : undefined,
            "aria-label": item.ariaLabel,
            "data-testid": `desk-open-item-${item.id}`,
            onClick: () => setOpen(false),
            className:
              "flex min-h-11 items-center gap-2 px-3 text-sm text-slate-700 hover:bg-purple-50 hover:text-purple-800",
          };
          const body = (
            <>
              <Icon aria-hidden className="h-4 w-4 shrink-0" strokeWidth={1.75} />
              <span className="whitespace-nowrap">{item.arrow ? `${item.label} ↗` : item.label}</span>
            </>
          );
          return item.plainAnchor ? (
            <a key={item.id} {...props}>
              {body}
            </a>
          ) : (
            <Link key={item.id} {...props}>
              {body}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
