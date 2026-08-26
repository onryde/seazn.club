"use client";

import { useEffect, useRef } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "@/components/ui/console-link";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import { hasActiveFilters } from "@/components/registration-hub-registrant-derive";
import type {
  RegistrantsFilters,
  DivisionOption,
} from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";

/** The minimal structural slice of a form control `buildFilteredHref` reads
 *  — deliberately NOT `HTMLInputElement`/`Element`: `form.elements`
 *  (`HTMLFormControlsCollection`) types its members as bare `Element` with
 *  no `.name`/`.value` of its own, so the real call site below casts into
 *  this shape too, and a plain array of these satisfies it directly in
 *  tests with no DOM and no cast — see buildFilteredHref's own comment for
 *  why `form.elements` rather than `FormData(form)`. */
type FilterFormElement = { name: string; value: string; type?: string; checked?: boolean };

/**
 * Task 2 (RS005 R5): a filter change used to navigate to e.g.
 * `?tab=registrants&status=confirmed&division_id=&kind=&q=&sort=newest` —
 * every EMPTY control still contributed its key, because a native GET
 * submission serialises every named field regardless of value. The tab's
 * URL is a shareable/bookmarkable artefact (the entire reason the filters
 * are a GET form), so it should carry only what an organiser actually SET.
 *
 * Reads `form.elements` (an `HTMLFormControlsCollection` in production) —
 * never `FormData(form)`, which needs a real `HTMLFormElement` that this
 * workspace's `environment: "node"` vitest config (no jsdom,
 * `_hook-harness.tsx`'s own header comment) can never construct; typed
 * against the minimal `FilterFormElement` shape instead so a plain array
 * stands in for it in tests, and the exact resulting query string is
 * directly assertable without a DOM. A checkbox contributes its value only
 * while checked, matching the API's own 0/1 convention (the same
 * convention `registrantsQueryString` — registration-hub-registrant-
 * derive.ts's CSV export href — already uses); every other listed control
 * (text/select/hidden, `tab` included) contributes unconditionally, empty
 * string included — filtered out below rather than special-cased, so `tab`
 * needs no carve-out: its value is simply never empty.
 */
export function buildFilteredHref(action: string, elements: ArrayLike<FilterFormElement>): string {
  const params = new URLSearchParams();
  for (const el of Array.from(elements)) {
    if (!el.name) continue;
    if (el.type === "checkbox" || el.type === "radio") {
      if (el.checked) params.set(el.name, el.value);
      continue;
    }
    if (el.value !== "") params.set(el.name, el.value);
  }
  return `${action}?${params.toString()}`;
}

/** How long the search box waits after the last keystroke before it
 *  navigates — long enough that a normal typing cadence never fires a
 *  submit per character, short enough that the result still feels live. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Registration hub — Registrants tab filter bar (RS005 W2a task 3, R4 task
 * 1 auto-submit, R5 task 2 URL filtering).
 *
 * Still a `<form method="GET">` — URL state, bookmarking, the back button
 * and shareable views all keep working — but it is no longer the browser's
 * OWN unfiltered submission that lands: every control calls the browser's
 * real `form.requestSubmit()` itself (via the changed element's own `.form`
 * reference) the moment it changes, exactly as before, but that submission
 * (Enter-key implicit submission included) now runs through THIS
 * component's own `onSubmit`, which reads the form's current fields,
 * drops the empty ones (`buildFilteredHref`, above — a native GET
 * submission serialises every named control regardless of value, which is
 * exactly the noise task 2 removes), and navigates with `router.push`
 * rather than letting the browser build the query string. `push`, not
 * `replace`: each change is still its own back-button stop, matching what
 * the native submission already did. The owner's ruling (2026-08-26): this
 * console does not work without JS anyway (the config panel, the action
 * controls and the copy buttons are all client islands already), so there
 * is no no-JS fallback to preserve beyond the markup itself degrading to a
 * plain (unfiltered) GET.
 *
 * A CLIENT component (auto-submit needs `onChange` handlers, which only a
 * client component can attach, and `onSubmit`/`useRouter` need one too).
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
 * problem, and the DOM never loses what the user just typed. It is ALSO
 * why `onSubmit` has to re-read `form.elements` fresh rather than trust
 * this component's own `filters`/`text` props: the props are last render's
 * server-sanitised values, and the field that just changed is uncontrolled
 * precisely so the DOM — not React — holds the truth in between.
 */
export function RegistrationHubRegistrantFilters({
  dict,
  action,
  filters,
  divisions,
  clearHref,
  statusOptions,
  kindOptions,
}: {
  dict: Dict;
  /** The tab's bare path — no query string (see header comment). */
  action: string;
  filters: RegistrantsFilters;
  divisions: DivisionOption[];
  clearHref: string;
  /** RegistrationStatus.options, read by the SERVER parent
   *  (registration-hub-registrants-panel.tsx) and passed down as plain
   *  strings — never imported here directly. `@/server/api-v1/schemas`
   *  transitively reaches the engine's gRPC scheduling client
   *  (placement-client.ts), which dials real Node built-ins (dns/net/
   *  http2); a SERVER component importing it is fine (never bundled for
   *  the browser), but this component became a CLIENT one the moment it
   *  needed onChange handlers, and a client bundle pulling that import in
   *  fails `next build` outright — vitest and tsc both stay green, since
   *  neither one bundles for a browser. One source (the zod enum), read
   *  server-side once, never duplicated here. */
  statusOptions: readonly string[];
  kindOptions: readonly string[];
}) {
  const router = useRouter();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Flush any pending debounce on unmount — a navigation away (or the
  // component simply going away) must not leave a stale timer firing
  // `requestSubmit()` on a form that is no longer in the document.
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
  }, []);

  // Task 2 (RS005 R5): the single interception point for every submission,
  // however it was triggered — the onChange->requestSubmit() calls below,
  // AND a native Enter-key implicit submission from the search box, which
  // reaches here the same way since both fire the form's real `submit`
  // event. `preventDefault` stops the browser's own (unfiltered) GET
  // navigation; `buildFilteredHref` reads the CURRENT DOM state (never the
  // `filters` prop — see the header comment) and drops empties.
  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // `.elements` types its members as bare `Element` (no `.name`/`.value`
    // of their own) — every LISTED control here really is an input/select
    // carrying both, `FilterFormElement`'s own comment explains why this
    // is the cast site rather than a looser function signature.
    const elements = e.currentTarget.elements as unknown as ArrayLike<{
      name: string;
      value: string;
      type?: string;
      checked?: boolean;
    }>;
    router.push(buildFilteredHref(action, elements));
  }

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
      onSubmit={handleSubmit}
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
          {statusOptions.map((s) => (
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
          {kindOptions.map((k) => (
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
