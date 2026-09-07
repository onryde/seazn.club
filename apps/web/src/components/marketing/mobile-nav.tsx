"use client";

// Marketing header mobile nav (design/fix-ui README.md cross-cutting #3):
// below `md` the nav links were `hidden md:inline-flex` with no replacement
// — Formats/Scheduling/Pricing/Use cases became unreachable except by
// scrolling all the way to the footer. This adds the missing hamburger →
// slide-down panel, same open/close/outside-click/Escape pattern as the
// console's CardMenu/OrgCrumb dropdowns (components/ui/card-menu.tsx,
// components/breadcrumbs.tsx) so the interaction language matches the rest
// of the app rather than inventing a new one.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";

export interface MobileNavLink {
  href: string;
  label: string;
}

/** An auth action folded out of the bar below `sm` (see marketing-nav.tsx for
 *  why). `primary` is the one action the panel styles as a filled button —
 *  hiding a signup CTA behind a hamburger is only acceptable if it still reads
 *  as the primary action once the panel is open. */
export interface MobileNavAuthLink extends MobileNavLink {
  primary: boolean;
}

export function MarketingMobileNav({
  links,
  openLabel,
  closeLabel,
  night,
  auth = [],
}: {
  links: MobileNavLink[];
  openLabel: string;
  closeLabel: string;
  /** Matches the header's night/light chrome so the button and panel read as
   *  part of the same bar instead of a foreign overlay. */
  night: boolean;
  /** Rendered below a divider, and ONLY below `sm` — from `sm` up these same
   *  actions are in the bar itself, so showing them twice would put two
   *  "Start free" controls on one screen. */
  auth?: MobileNavAuthLink[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Close on route change (a link tap navigates — nothing else needs to).
  useEffect(() => {
    setOpen(false);
  }, [links]);

  return (
    <div ref={rootRef} className="relative md:hidden">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={open ? closeLabel : openLabel}
        onClick={() => setOpen((v) => !v)}
        className={`grid h-9 w-9 place-items-center rounded-lg transition ${
          night
            ? "text-cream/85 hover:bg-cream/10 hover:text-cream"
            : "text-slate-600 hover:bg-purple-50 hover:text-purple-700"
        }`}
      >
        {open ? <X className="h-5 w-5" strokeWidth={2} /> : <Menu className="h-5 w-5" strokeWidth={2} />}
      </button>
      {/* Always in the DOM (class-toggled, not unmounted) so the links exist
          statelessly for SSR/no-JS/testing, not only after a client click —
          the bug this fixes was links vanishing entirely below `md`, so the
          fix shouldn't reintroduce a JS-only path to reach them. */}
      <div
        role="menu"
        aria-hidden={!open}
        // w-64, not w-56: "Commencer gratuitement" is ~190px at this size and
        // needs the extra 32px to stay on one line in the panel.
        className={`absolute right-0 top-11 z-50 w-64 rounded-xl border border-purple-100 bg-white py-1 shadow-xl ${
          open ? "block" : "hidden"
        }`}
      >
        {links.map((l) => (
          <Link
            key={l.href}
            role="menuitem"
            href={l.href}
            tabIndex={open ? undefined : -1}
            onClick={() => setOpen(false)}
            className="block px-4 py-2.5 text-sm text-slate-700 hover:bg-purple-50 hover:text-purple-800"
          >
            {l.label}
          </Link>
        ))}
        {auth.length > 0 && (
          // `sm:hidden` because from `sm` up these actions are in the bar
          // itself — without it a 640-767px viewport (where the hamburger is
          // still shown) would carry two "Start free" controls at once.
          <div className="sm:hidden mt-1 border-t border-purple-100 pt-1">
            {auth.map((a) => (
              <Link
                key={a.href}
                role="menuitem"
                href={a.href}
                tabIndex={open ? undefined : -1}
                onClick={() => setOpen(false)}
                className={
                  a.primary
                    ? "mx-2 my-1.5 block rounded-lg bg-purple-600 px-4 py-2.5 text-center text-sm font-semibold text-white hover:bg-purple-700"
                    : "block px-4 py-2.5 text-sm text-slate-700 hover:bg-purple-50 hover:text-purple-800"
                }
              >
                {a.label}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
