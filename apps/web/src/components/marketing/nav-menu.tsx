"use client";

// A header disclosure menu (Product, Sports). Same open / outside-click / Escape language as the mobile panel
// (mobile-nav.tsx), and like it the links are always in the DOM, class-toggled: they exist for crawlers and without
// script, and a closed panel is taken out of the tab order rather than unmounted.
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/** A menu row: the page's name, one line on what it does, and its drawing (made on the server, passed in). */
export type NavMenuLink = { href: string; label: string; desc?: string; icon?: ReactNode };

export function NavMenu({ id, label, links }: { id: string; label: string; links: NavMenuLink[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const panelId = `mk-menu-${id}`;
  return (
    <div ref={rootRef} className="hidden md:block" data-testid={`nav-menu-${id}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="mk-nav-link inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm"
      >
        {label}
        <ChevronDown aria-hidden className={`h-3.5 w-3.5 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`} strokeWidth={2} />
      </button>
      {/* The panel hangs from the bar (the header's inner row is its positioning box), not from the button, so a
          two-column panel never runs off the right edge at 768. */}
      <div id={panelId} className={`mk-menu-panel ${open ? "grid" : "hidden"}`}>
        {links.map((l) => (
          <Link key={l.href} href={l.href} tabIndex={open ? undefined : -1} onClick={() => setOpen(false)} className="mk-menu-row">
            {l.icon ? <span className="mk-menu-icon">{l.icon}</span> : null}
            <span className="min-w-0">
              <b>{l.label}</b>
              {l.desc ? <small>{l.desc}</small> : null}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
