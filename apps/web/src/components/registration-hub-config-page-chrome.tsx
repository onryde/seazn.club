"use client";

// B7 T23 (spec §9.3) — the two pieces of the division settings PAGE that the modal never had: the section index beside the
// sections (md and up) and the Save bar pinned to the bottom of the viewport. Presentation only: the panel
// (registration-hub-config-panel.tsx) owns the state and hands each one its copy and handlers, so both stay hookless — its
// test harness expands them as plain functions, the same way it expands the sections.
import type { MouseEvent } from "react";
import { Check } from "lucide-react";
import { SECTION_IDS, type SectionId } from "@/components/registration-hub-config-panel-sections";

/** A section's element id on the page. Two division tabs can be mounted at once (the host hides the inactive one), so the
 *  division is part of it: a bare `section-capacity` would be in the document twice, and the link would land on the hidden one. */
export function sectionAnchor(id: SectionId, divisionId: string): string {
  return `section-${id}-${divisionId}`;
}

/** Scroll to the section and move focus there, without the `#hash` history entry a bare anchor adds: Back must leave the tab,
 *  not walk back through its sections. The href stays on the link, so it still says where it goes. */
function goToSection(event: MouseEvent<HTMLAnchorElement>, anchor: string) {
  const target = document.getElementById(anchor);
  if (!target) return;
  event.preventDefault();
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
  target.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
}

export function ConfigSectionIndex({
  divisionId,
  label,
  titles,
  changed,
}: {
  divisionId: string;
  /** The nav's accessible name ("Sections"). */
  label: string;
  titles: Record<SectionId, string>;
  /** Sections holding an unsaved edit: each gets a dot beside its link. */
  changed: readonly SectionId[];
}) {
  return (
    // One DOM: hidden below md by CSS, where the sections are accordions and an index would only repeat them.
    <nav aria-label={label} className="max-md:hidden md:sticky md:top-[calc(var(--app-header-h)+1rem)]">
      <ul className="border-l border-slate-200">
        {SECTION_IDS.map((id) => {
          const anchor = sectionAnchor(id, divisionId);
          return (
            <li key={id}>
              <a
                href={`#${anchor}`}
                data-section-link={id}
                onClick={(e) => goToSection(e, anchor)}
                className="-ml-px flex items-center gap-2 border-l-2 border-transparent py-1.5 pl-3 pr-1 text-sm text-slate-600 transition-colors hover:border-purple-300 hover:text-purple-700"
              >
                <span className="min-w-0 truncate">{titles[id]}</span>
                {changed.includes(id) && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-purple-600" />}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function ConfigSaveBar({
  dirty,
  status,
  busy,
  cancelLabel,
  saveLabel,
  onCancel,
  onSave,
}: {
  dirty: boolean;
  /** "All changes saved" or "{n} unsaved changes", already worded. */
  status: string;
  busy: boolean;
  cancelLabel: string;
  saveLabel: string;
  onCancel: () => void;
  onSave: () => void | Promise<void>;
}) {
  return (
    // Pinned to the bottom of the viewport while the sections scroll under it. Below md it runs edge to edge over the page's
    // 16px gutter, padded for the home indicator; from md it is a card-edged bar in the column. z-30 keeps the cookie banner
    // (fixed, z-40) answerable above it, as the register form's action bar does.
    <div
      data-config-save-bar
      className="sticky bottom-0 z-30 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-slate-200 bg-white/95 py-3 backdrop-blur-sm max-md:-mx-4 max-md:px-4 max-md:pb-[max(0.75rem,env(safe-area-inset-bottom))] md:rounded-xl md:border md:px-4 md:shadow-sm"
    >
      <p role="status" data-config-dirty={dirty ? "dirty" : "clean"} className="flex min-w-0 items-center gap-2 text-sm">
        {dirty ? (
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-purple-600" />
        ) : (
          <Check className="h-4 w-4 shrink-0 text-slate-400" strokeWidth={2} aria-hidden />
        )}
        <span className={dirty ? "font-medium text-slate-900" : "text-slate-500"}>{status}</span>
      </p>
      {/* Below md the two buttons split one full-width row, and a long label wraps inside its own button ("Enregistrer les
          modifications" at 320) instead of pushing the pair onto two rows of a bar that already covers the form. */}
      <div className="ml-auto flex flex-wrap justify-end gap-2 max-md:grid max-md:w-full max-md:grid-cols-2">
        {/* Disabled in flight too: a Cancel during a save would show the old values over a save that is still landing. */}
        <button type="button" data-action="cancel" disabled={busy} className="btn btn-ghost min-h-11" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="button" data-action="save" disabled={busy} className="btn btn-primary min-h-11" onClick={onSave}>
          {saveLabel}
        </button>
      </div>
    </div>
  );
}
