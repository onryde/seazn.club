"use client";

// A header disclosure menu (Product, Sports). Same open / outside-click / Escape language as the mobile panel
// (mobile-nav.tsx), and like it the links are always in the DOM, class-toggled: they exist for crawlers and without
// script, and a closed panel is taken out of the tab order rather than unmounted.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export function NavMenu({ id, label, links }: { id: string; label: string; links: { href: string; label: string }[] }) {
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
    <div ref={rootRef} className="relative hidden md:block" data-testid={`nav-menu-${id}`}>
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
      <div
        id={panelId}
        className={`absolute left-0 top-10 z-50 min-w-48 rounded-xl border border-purple-100 bg-white py-1 shadow-xl ${open ? "block" : "hidden"}`}
      >
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            tabIndex={open ? undefined : -1}
            onClick={() => setOpen(false)}
            className="block whitespace-nowrap px-4 py-2.5 text-sm text-slate-700 hover:bg-purple-50 hover:text-purple-800"
          >
            {l.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
