"use client";

// One section of the registration config panel (registration-hub-config-panel.tsx): its title, and the box it sits in.
// Moved out of the panel (B7 T23) with no change to the modal's markup; the page layout adds a heading inside each section and,
// from md up, renders the section as a plain always-open <section> instead of a disclosure.
import { ChevronDown } from "lucide-react";
import type { ReactEventHandler, ReactNode } from "react";
import type { MessageKey } from "@/lib/messages";
import type { SectionId } from "@/components/registration-hub-config-panel-sections";

/** The panel's copy lookup, as every section is handed it. */
export type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** A section's name, as its header shows it. Exported for the hub's division tabs (T24), which name a section in their own
 *  prompts; `formFieldCount` only words the sign-up form's ("Sign-up form · 1 extra question"). */
export function sectionTitle(id: SectionId, msg: Msg, formFieldCount: number): string {
  switch (id) {
    case "eligibility":
      return msg("reg.hub.config.eligibility");
    case "schedule":
      return msg("reg.settings.openClose");
    case "capacity":
      return msg("reg.settings.capacity");
    case "money":
      return msg("reg.settings.money");
    case "form":
      // NOT `usePlural`: it throws outside a `DictProvider` and this panel is
      // rendered without one — the same reason and the same shape as
      // create-org-form.tsx:134-140, which documents it. Safe rather than a
      // shortcut: all four shipped locales (en/es/fr/nl) put the one/other
      // boundary at exactly 1, so this ternary IS the plural rule for every
      // locale the product has. A locale with a dual or paucal form would
      // need the real Intl.PluralRules path.
      //
      // It said "1 extra questions" before, and a division with one extra
      // question is the COMMON case, not an edge one.
      return `${msg("reg.settings.signupForm")} · ${msg(
        formFieldCount === 1 ? "reg.settings.extraQuestions.one" : "reg.settings.extraQuestions.other",
        { count: formFieldCount },
      )}`;
  }
}

/** A section's bare name, without the sign-up form's question count: the section index, and the hub's close prompt naming
 *  the sections holding unsaved edits (T24). */
export function sectionName(id: SectionId, msg: Msg): string {
  return id === "form" ? msg("reg.settings.signupForm") : sectionTitle(id, msg, 0);
}

/** B7 T23: what the settings page adds to a section. Absent: the bare accordion. */
export interface DisclosurePage {
  /** The element id the section index links to (sectionAnchor). */
  anchorId: string;
  /** From md up: every section open, so it is a plain section with a heading — nothing a click or a key would fold, and so
   *  nothing exposed as a button. */
  alwaysOpen: boolean;
  /** The "Changed" tag, while the section holds an unsaved edit. */
  changedLabel: string | null;
}

// Exported (not a private closure) for the same reason the section
// components are: _hook-harness.tsx's walk() never INVOKES a child
// component — it only reads the static `.props.children` already authored
// on it — so a test rendering the panel needs to call Disclosure(props)
// directly to see what it actually renders. Safe here because Disclosure
// holds no hooks of its own.
export function Disclosure({
  id,
  title,
  open,
  hasError,
  onToggle,
  page,
  children,
}: {
  id: string;
  title: string;
  open: boolean;
  hasError: boolean;
  // The real DOM event type, not a hand-rolled `{ currentTarget: { open } }`
  // shape. That invented type is what let a real crash through tsc once: it
  // described `currentTarget` as always carrying an `open` boolean, so
  // reading it was a type error nowhere — while the native `toggle` event
  // fired during commit hands the handler a null `currentTarget`.
  onToggle: ReactEventHandler<HTMLDetailsElement>;
  page?: DisclosurePage;
  children: ReactNode;
}) {
  const errorDot = hasError && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />;
  const body = <div className="space-y-3 border-t border-purple-100 p-4">{children}</div>;

  if (!page) {
    // The modal: unchanged.
    return (
      <details data-accordion-section={id} className="card group overflow-hidden p-0" open={open} onToggle={onToggle}>
        {/* list-none + both marker rules: <summary> carries a native
            disclosure triangle via TWO different mechanisms depending on
            engine (::marker in modern engines, ::-webkit-details-marker in
            WebKit/Blink) — hiding only one leaves the native triangle
            showing alongside the custom chevron below. */}
        <summary className="marker:content-none flex cursor-pointer list-none items-center justify-between gap-2 p-4 text-sm font-semibold text-slate-700 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2">
            {title}
            {errorDot}
          </span>
          <ChevronDown
            className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180"
            strokeWidth={1.75}
            aria-hidden
          />
        </summary>
        {body}
      </details>
    );
  }

  const headingId = `${page.anchorId}-title`;
  // The heading, the error dot and the Changed tag, as siblings rather than one wrapper: below md they sit straight inside the
  // <summary>, whose content is phrasing and heading content only — no <div> (B7 T23 re-review m7). Both parents lay them out
  // in a wrapping row, so the page's tag can push a long translated title onto a second line of a 320px card.
  const head = (
    <>
      {/* A heading under the page's own h2 (the division), so a screen reader's heading list is the section list. Focus target
          of the section index (tabIndex -1: reachable by script, never a Tab stop); the ring shows when that focus came from
          the keyboard. */}
      <h3
        id={headingId}
        data-section-heading
        tabIndex={page.alwaysOpen ? -1 : undefined}
        className="min-w-0 break-words rounded-sm text-sm font-semibold text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2"
      >
        {title}
      </h3>
      {errorDot}
      {page.changedLabel && (
        <span
          data-section-changed
          className="rounded-full bg-purple-50 px-2 py-0.5 text-xs font-medium text-purple-700 ring-1 ring-inset ring-purple-200"
        >
          {page.changedLabel}
        </span>
      )}
    </>
  );
  // Clear of the sticky app header when the index (or a failed save) scrolls a section to the top.
  const scrollClear = "scroll-mt-[calc(var(--app-header-h)+1rem)]";

  if (page.alwaysOpen) {
    return (
      <section
        id={page.anchorId}
        data-accordion-section={id}
        aria-labelledby={headingId}
        className={`card overflow-hidden p-0 ${scrollClear}`}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2 p-4">{head}</div>
        {body}
      </section>
    );
  }

  return (
    <details
      id={page.anchorId}
      data-accordion-section={id}
      className={`card group overflow-hidden p-0 ${scrollClear}`}
      open={open}
      onToggle={onToggle}
    >
      <summary className="marker:content-none flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-2 p-4 [&::-webkit-details-marker]:hidden">
        {head}
        <ChevronDown
          className="ml-auto h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180"
          strokeWidth={1.75}
          aria-hidden
        />
      </summary>
      {body}
    </details>
  );
}
