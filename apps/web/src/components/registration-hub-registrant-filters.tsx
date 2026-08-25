"use client";

import { useEffect, useRef } from "react";
import Link from "@/components/ui/console-link";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import { RegistrationStatus, EntrantKind } from "@/server/api-v1/schemas";
import { hasActiveFilters } from "@/components/registration-hub-registrant-derive";
import type {
  RegistrantsFilters,
  DivisionOption,
} from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";

/** How long the search box waits after the last keystroke before it
 *  navigates — long enough that a normal typing cadence never fires a
 *  submit per character, short enough that the result still feels live. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Registration hub — Registrants tab filter bar (RS005 W2a task 3, R4 task
 * 1 auto-submit).
 *
 * Still a `<form method="GET">`, and that is still the ENTIRE submission
 * mechanism — URL state, bookmarking, the back button and shareable views
 * all keep working exactly as before. What changed is WHO presses submit:
 * every control now calls the browser's real `form.requestSubmit()` itself
 * (via the changed element's own `.form` reference — no ref, no hand-rolled
 * query-string building) the moment it changes, so the organiser never
 * clicks a button that no longer exists. The owner's ruling (2026-08-26):
 * this console does not work without JS anyway (the config panel, the
 * action controls and the copy buttons are all client islands already), so
 * there is no no-JS fallback to preserve here either.
 *
 * A CLIENT component now (it wasn't before) purely because auto-submit
 * needs `onChange` handlers, which only a client component can attach.
 * `t` comes from `@/lib/i18n-runtime`, NOT `@/lib/i18n` — the latter's
 * `server-only` import poisons the whole module for a client bundle even
 * though `t` itself is pure (gotcha 6 in the original W2a dispatch); both
 * re-export the identical function, so this is a bundling fix only, no
 * behaviour change.
 *
 * Every `<select>`/`<input>` below stays UNCONTROLLED (`defaultValue`/
 * `defaultChecked`, never `value`) — deliberately preserved from the
 * original design, and now doing double duty: it is also what keeps the
 * search box's caret and in-progress text untouched by React while the
 * debounce timer is pending. A `useState`-controlled value would re-render
 * the input on every keystroke; an uncontrolled one is the DOM's own
 * problem, and the DOM never loses what the user just typed.
 */
export function RegistrationHubRegistrantFilters({
  dict,
  action,
  filters,
  divisions,
  clearHref,
}: {
  dict: Dict;
  /** The tab's bare path — no query string (see header comment). */
  action: string;
  filters: RegistrantsFilters;
  divisions: DivisionOption[];
  clearHref: string;
}) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Flush any pending debounce on unmount — a navigation away (or the
  // component simply going away) must not leave a stale timer firing
  // `requestSubmit()` on a form that is no longer in the document.
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
  }, []);

  function clearPending() {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }

  // Every dropdown/checkbox: submit the instant it changes. Any OUTSTANDING
  // search debounce is cancelled first — the fresh submit already carries
  // whatever is currently typed in the search box (a real form submission
  // reads every field's LIVE value at call time), so the delayed one would
  // just be a redundant second navigation to the same URL.
  function submitOnChange(e: { target: { form: HTMLFormElement | null } }) {
    clearPending();
    e.target.form?.requestSubmit();
  }

  // The search box alone: debounce ~300ms of inactivity rather than
  // submitting per keystroke. `e.target.form` is captured NOW, synchronously
  // — not read again once the timer fires — so a re-render between the
  // keystroke and the timeout can never matter.
  function onSearchChange(e: { target: { form: HTMLFormElement | null } }) {
    clearPending();
    const form = e.target.form;
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      form?.requestSubmit();
    }, SEARCH_DEBOUNCE_MS);
  }

  return (
    <form
      method="GET"
      action={action}
      data-registration-hub-registrant-filters
      className="card mb-4 flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-end"
    >
      <input type="hidden" name="tab" value="registrants" />

      <label className="flex flex-col text-xs font-medium text-slate-600">
        {t(dict, "reg.hub.registrants.filters.status")}
        <select
          name="status"
          defaultValue={filters.status ?? ""}
          onChange={submitOnChange}
          className="input min-h-11 mt-1"
        >
          <option value="">{t(dict, "reg.hub.registrants.filters.statusAll")}</option>
          {RegistrationStatus.options.map((s) => (
            <option key={s} value={s}>
              {t(dict, `reg.hub.registrants.status.${s}`)}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col text-xs font-medium text-slate-600">
        {t(dict, "reg.hub.registrants.filters.division")}
        <select
          name="division_id"
          defaultValue={filters.divisionId ?? ""}
          onChange={submitOnChange}
          className="input min-h-11 mt-1"
        >
          <option value="">{t(dict, "reg.hub.registrants.filters.divisionAll")}</option>
          {divisions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col text-xs font-medium text-slate-600">
        {t(dict, "reg.hub.registrants.filters.kind")}
        <select
          name="kind"
          defaultValue={filters.kind ?? ""}
          onChange={submitOnChange}
          className="input min-h-11 mt-1"
        >
          <option value="">{t(dict, "reg.hub.registrants.filters.kindAll")}</option>
          {EntrantKind.options.map((k) => (
            <option key={k} value={k}>
              {t(dict, `divset.entrants.kind.${k}`)}
            </option>
          ))}
        </select>
      </label>

      <label className="flex min-w-[10rem] flex-1 flex-col text-xs font-medium text-slate-600">
        {t(dict, "reg.hub.registrants.filters.search")}
        <input
          type="text"
          name="q"
          defaultValue={filters.text}
          onChange={onSearchChange}
          placeholder={t(dict, "reg.hub.registrants.filters.searchPlaceholder")}
          className="input mt-1"
        />
      </label>

      <label className="flex flex-col text-xs font-medium text-slate-600">
        {t(dict, "reg.hub.registrants.filters.sort")}
        <select
          name="sort"
          defaultValue={filters.sort}
          onChange={submitOnChange}
          className="input min-h-11 mt-1"
        >
          <option value="newest">{t(dict, "reg.hub.registrants.filters.sortNewest")}</option>
          <option value="oldest">{t(dict, "reg.hub.registrants.filters.sortOldest")}</option>
        </select>
      </label>

      {/* Grouped so the pair wraps together rather than drifting apart, and
          given the same 44px slot the dropdowns sit in (`sm:min-h-11`, row
          layout only) so the bar reads as one consistent row of controls
          instead of five boxes plus two loose checkboxes. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:min-h-11">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            name="free_agent"
            value="1"
            defaultChecked={filters.freeAgent}
            onChange={submitOnChange}
          />
          {t(dict, "reg.hub.registrants.filters.freeAgent")}
        </label>

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            name="consent_pending"
            value="1"
            defaultChecked={filters.consentPending}
            onChange={submitOnChange}
          />
          {t(dict, "reg.hub.registrants.filters.consentPending")}
        </label>
      </div>

      {/* No submit button — every control above submits itself. Only when a
          filter is actually narrowing the rows — with nothing active there
          is nothing to clear, and a no-op link would only invite an idle
          click. */}
      {hasActiveFilters(filters) && (
        <Link href={clearHref} className="btn btn-ghost min-h-11">
          {t(dict, "reg.hub.registrants.filters.clear")}
        </Link>
      )}
    </form>
  );
}
