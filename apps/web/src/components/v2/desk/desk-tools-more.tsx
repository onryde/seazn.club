"use client";

// F2 (round J): the phone half of the competition masthead's tool row.
//
// Below `sm` every tool label was `hidden sm:inline`, so the row collapsed to
// five unlabelled 46x34 icon tiles — under the 44px tap bar, unreadable, on
// the width most likely to be in a hand at a venue. That is a groomed shrink
// of the desktop row, which is the thing this programme exists to undo.
//
// This is deliberately NOT `ui/card-menu.tsx`: that trigger is a 32px icon
// button opening a 176px popup, which is the same defect one layer down.
// Here the trigger carries the WORD and the panel is a full-width stack of
// labelled rows, each at the tap floor.
//
// It renders only below `sm` (the caller supplies `sm:hidden`); at `sm` and up
// the labelled row is unchanged and must stay that way.
import Link from "@/components/ui/console-link";
import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export interface DeskToolItem {
  label: string;
  href: string;
  external?: boolean;
}

export function DeskToolsMore({
  label,
  items,
  className = "",
}: {
  label: string;
  items: DeskToolItem[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
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

  if (items.length === 0) return null;

  return (
    <div ref={rootRef} data-testid="desk-tools-more" className={`w-full ${className}`}>
      <button
        type="button"
        data-testid="desk-tools-more-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="btn btn-ghost flex min-h-11 w-full items-center justify-between gap-1.5 text-sm"
      >
        <span>{label}</span>
        <ChevronDown
          aria-hidden
          className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
          strokeWidth={1.75}
        />
      </button>
      {/* `hidden` rather than an unmounted branch: the panel's links stay in
          the DOM so a test can tell "folded away" from "never rendered" — the
          two diagnoses this wave has already confused once. */}
      {/* Round J, from looking at 320: an open fold of bare links floated
          against the page with no edge of its own, reading as loose text
          rather than as the menu the trigger just opened. It is a contained
          panel now, with the same border language as the buttons above it. */}
      <div
        id={panelId}
        hidden={!open}
        className="mt-2 flex flex-col overflow-hidden rounded-xl border border-purple-200 bg-white"
      >
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            target={item.external ? "_blank" : undefined}
            onClick={() => setOpen(false)}
            className="flex min-h-11 items-center border-b border-purple-100 px-4 text-sm text-purple-700 last:border-b-0 hover:bg-purple-50"
          >
            {item.label}
            {item.external ? " ↗" : ""}
          </Link>
        ))}
      </div>
    </div>
  );
}
