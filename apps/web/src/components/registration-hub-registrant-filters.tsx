"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, SlidersHorizontal } from "lucide-react";
import Link from "@/components/ui/console-link";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import { hasActiveFilters } from "@/components/registration-hub-registrant-derive";
import { filterSheet } from "@/components/registration-hub-registrant-filter-sheet";
import {
  FILTER_NAMES,
  chip,
  describeFilters,
  divisionOptionEls,
  kindOptionEls,
  selectPill,
  statusOptionEls,
  togglePill,
} from "@/components/registration-hub-registrant-filter-pills";
import type { FilterName, PillContext } from "@/components/registration-hub-registrant-filter-pills";
import type {
  RegistrantsFilters,
  DivisionOption,
} from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";

// The filter vocabulary lives beside the pills; the bar's own module is where
// callers (and the tests) have always imported it from.
export { FILTER_NAMES };
export type { FilterName };

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
 *
 * B6 T21: the form's own fields come first, then every param of the LIVE
 * address the form does not own (`current`) rides along — B7's `open` tabs, a
 * stray `page` — by the same `carryOver` rule a pill's "×" uses, so the two
 * ways of changing a filter cannot disagree about what survives. Before this a
 * submit silently dropped them.
 */
export function buildFilteredHref(
  action: string,
  elements: ArrayLike<FilterFormElement>,
  current: URLSearchParams,
): string {
  const params = new URLSearchParams();
  for (const el of Array.from(elements)) {
    if (!el.name) continue;
    if (el.type === "checkbox" || el.type === "radio") {
      if (el.checked) params.set(el.name, el.value);
      continue;
    }
    if (el.value !== "") params.set(el.name, el.value);
  }
  for (const [name, value] of carryOver(current, FORM_FIELDS).entries()) params.append(name, value);
  return `${action}?${params.toString()}`;
}

/** Every param the form itself writes. Anything else in the address is somebody
 *  else's and is never dropped by a filter change. */
const FORM_FIELDS: readonly string[] = ["tab", "q", "sort", ...FILTER_NAMES];

/** THE carry-over rule, shared by "×" (`clearOneHref`) and a submit
 *  (`buildFilteredHref`): a copy of the CURRENT address minus the params this
 *  action owns. A copy, because the live `useSearchParams()` object is read-only
 *  and a caller reusing one `current` for several links must get the same
 *  answer each time; `delete` drops every copy of a repeated param (a
 *  hand-edited URL), not just the first. */
function carryOver(current: URLSearchParams, owned: readonly string[]): URLSearchParams {
  const params = new URLSearchParams(current);
  for (const name of owned) params.delete(name);
  return params;
}

/** "Clear all": the bare tab, no filter params (owner 1). NOT the bare
 *  `/registration` — that lands on the Settings tab (`resolveRegistrationHubTab`
 *  falls back to it), so "bare" means "no filter params, still on the tab".
 *
 *  Filters are not tabs (B7 T22 ruling, 2026-11-13): everything in the CURRENT
 *  address that this form does not own rides along — the open division tabs
 *  (`open`) above all — through the same `carryOver` rule as a "×" and a submit,
 *  so the three ways of changing the filters cannot disagree about what survives.
 *  `tab` comes first, so with nothing to carry the result is exactly the old
 *  `?tab=registrants`. Query-only on purpose: the caller prefixes the route's own
 *  path. */
export function clearAllHref(current: URLSearchParams): string {
  const params = new URLSearchParams({ tab: "registrants" });
  for (const [name, value] of carryOver(current, FORM_FIELDS).entries()) params.append(name, value);
  return `?${params.toString()}`;
}

/** The "×" on a pill or chip: the CURRENT query string minus the one param it
 *  owns. Every other param rides along — tab, sort, the other filters and
 *  anything this form does not know about (B7's `open`) — and `tab` is
 *  re-asserted so a clear can never strand the organiser on Settings.
 *  Query-only, like `clearAllHref`. */
export function clearOneHref(current: URLSearchParams, name: FilterName): string {
  const params = carryOver(current, [name]);
  params.set("tab", "registrants");
  return `?${params.toString()}`;
}

/** How long the search box waits after the last keystroke before it
 *  navigates — long enough that a normal typing cadence never fires a
 *  submit per character, short enough that the result still feels live. */
const SEARCH_DEBOUNCE_MS = 300;

/** The value of the control called `name` in a form's `elements`, or null when
 *  there is no form or no such control. Typed against the same minimal shape
 *  `buildFilteredHref` reads, so a test needs no DOM. */
function namedValue(form: { elements: unknown } | null, name: string): string | null {
  if (!form) return null;
  const found = Array.from(form.elements as ArrayLike<FilterFormElement>).find((el) => el.name === name);
  return found ? found.value : null;
}

/** The search box's debounce timer, kept in a hook of its own. A ref read by a
 *  handler that the bar then hands to the pill helpers (`ctx.onChange`) trips the
 *  React Compiler's "no refs during render" rule — it cannot tell the helper only
 *  attaches it to an element — and a hook's returned functions are opaque to it,
 *  which is the truth: they run in event handlers and effects, never in render.
 *  `cancel` also flushes on unmount: a navigation away must not leave a stale
 *  timer firing `requestSubmit()` on a form that is no longer in the document. */
function useSearchDebounce() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);
  const cancel = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const schedule = (form: HTMLFormElement | null) => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      form?.requestSubmit();
    }, SEARCH_DEBOUNCE_MS);
  };
  return { cancel, schedule };
}

/**
 * Registration hub — Registrants tab filter bar (RS005 W2a task 3, R4 task
 * 1 auto-submit, R5 task 2 URL filtering, B6 T20 the A3 pill bar, T21 the phone
 * sheet).
 *
 * B6 T20 (mock rfm12a01 §A3, spec §8) changed the FACE, not the mechanism:
 * two rows — search + sort, then one pill per filter — instead of a card of
 * stacked-label controls. Every select, checkbox and the search box keeps its
 * `name`, its auto-submit and its keyed remount (everything below still holds);
 * what is new is that a set filter shows "Label: Value" with a "×" link to the
 * URL without that param (`clearOneHref`), and "Clear all" links to the bare tab
 * (`clearAllHref`, which keeps whatever else the address carries).
 *
 * B6 T21 (mock A1, spec §8 "Below md"): one DOM, two faces. From md the bar above
 * is unchanged. Below md the pill row and the standalone sort fold away
 * (`max-md:hidden`) and the bar is the search box plus ONE row (`md:hidden`): a
 * "Filters" button with a count of what is set, a removable chip per set filter
 * and "Clear all". The button opens `filterSheet` — a Modal holding every filter
 * plus Sort whose edits are staged until "Show registrants" applies them with
 * one push, through the SAME `buildFilteredHref`, so what the sheet writes and
 * what a pill writes cannot differ. Whether the sheet is open is local state and
 * never goes in the URL. The folded pill controls stay in the DOM (they carry the
 * server's values into a search-box submit), so a phone's two copies of
 * `select[name=status]` are told apart by the sheet being inside a dialog.
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
 *
 * RS005 F3 finding 3: that same uncontrolled-ness has a cost React never
 * papers over — a REAL browser never re-applies `defaultValue`/
 * `defaultChecked` to an EXISTING DOM node on a later render. "Clear
 * all" (and each pill's "×") is a plain `<Link>` navigation (not this form's own submit), so
 * it delivers a fresh, all-cleared `filters` prop without ever touching
 * this form's DOM; without something forcing a remount, every widget kept
 * showing its PRE-clear value, and the NEXT change — `handleSubmit`
 * reading LIVE `e.currentTarget.elements` — read that stale DOM and
 * silently resurrected the filter the organiser had just cleared. Browser
 * Back/Forward hits the same gap: it also delivers a fresh `filters` prop
 * outside this form's own onChange/onSubmit path.
 *
 * Fixed by giving every uncontrolled control a `key` derived from its OWN
 * filter value (below) — React unmounts and remounts an element whenever
 * its `key` changes between renders (true for any element, not only
 * `.map()`-generated siblings; the same technique as
 * `<UserProfile key={userId} />`), which forces the browser to build a
 * FRESH DOM node and re-read `defaultValue`/`defaultChecked` from the
 * current props, regardless of what produced the new render — this form's
 * own submit, Clear, or Back/Forward all look identical from here: a new
 * `filters` prop arrived. Keyed per FIELD, not once on the whole `<form>`,
 * so changing one filter does not also tear down (and lose the DOM
 * identity/focus of) every other, unrelated control.
 */
export function RegistrationHubRegistrantFilters({
  dict,
  action,
  filters,
  divisions,
  statusOptions,
  kindOptions,
}: {
  dict: Dict;
  /** The tab's bare path — no query string (see header comment). Every
   *  "×" and "Clear all" href is this plus a query-only href from
   *  `clearOneHref`/`clearAllHref`. */
  action: string;
  filters: RegistrantsFilters;
  divisions: DivisionOption[];
  /** RegistrationStatus.options, read by the SERVER parent
   *  (registration-hub-registrants-panel.tsx) and passed down as plain
   *  strings — never imported here directly. `@/server/api-v1/schemas`
   *  once reached the engine's gRPC scheduling client (placement-client.ts,
   *  since moved to `@seazn/scheduler`), which dials real Node built-ins
   *  (dns/net/http2); a SERVER component importing it was fine (never
   *  bundled for the browser), but this component became a CLIENT one the
   *  moment it needed onChange handlers, and a client bundle pulling that
   *  import in failed `next build` outright — vitest and tsc both stayed
   *  green, since neither one bundles for a browser. api-v1/schemas/ is a server
   *  module regardless (zod, the whole API surface). One source (the zod enum), read
   *  server-side once, never duplicated here. */
  statusOptions: readonly string[];
  kindOptions: readonly string[];
}) {
  const router = useRouter();
  // The live address, not the `filters` prop: a "×" has to keep every param
  // it does not own, and only the address knows them all (B6 T20).
  const current = useSearchParams();
  const debounce = useSearchDebounce();
  const formId = useId();
  // The phone sheet. `null` = closed. While open it carries the search box's text
  // as of the moment it opened, and how many times "Reset" has been pressed (each
  // press remounts the staged controls). Local state only — never in the URL (spec §8).
  const [sheet, setSheet] = useState<{ q: string; resets: number } | null>(null);

  // Task 2 (RS005 R5): the single interception point for every submission,
  // however it was triggered — the onChange->requestSubmit() calls below,
  // AND a native Enter-key implicit submission from the search box, which
  // reaches here the same way since both fire the form's real `submit`
  // event. `preventDefault` stops the browser's own (unfiltered) GET
  // navigation; `buildFilteredHref` reads the CURRENT DOM state (never the
  // `filters` prop — see the header comment) and drops empties.
  //
  // `.elements` types its members as bare `Element` (no `.name`/`.value`
  // of their own) — every LISTED control here really is an input/select
  // carrying both, `FilterFormElement`'s own comment explains why this
  // is the cast site rather than a looser function signature.
  function pushFrom(form: { elements: unknown }) {
    router.push(buildFilteredHref(action, form.elements as ArrayLike<FilterFormElement>, current));
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    pushFrom(e.currentTarget);
  }

  // Every dropdown/checkbox: submit the instant it changes. Any OUTSTANDING
  // search debounce is cancelled first — the fresh submit already carries
  // whatever is currently typed in the search box (a real form submission
  // reads every field's LIVE value at call time), so the delayed one would
  // just be a redundant second navigation to the same URL.
  function submitOnChange(e: { target: { form: HTMLFormElement | null } }) {
    debounce.cancel();
    e.target.form?.requestSubmit();
  }

  // The search box alone: debounce ~300ms of inactivity rather than
  // submitting per keystroke. `e.target.form` is captured NOW, synchronously
  // — not read again once the timer fires — so a re-render between the
  // keystroke and the timeout can never matter.
  function onSearchChange(e: { target: { form: HTMLFormElement | null } }) {
    debounce.schedule(e.target.form);
  }

  // ── the phone sheet (B6 T21) ─────────────────────────────────────────────────

  // Opening reads what is typed in the search box RIGHT NOW (the form this
  // button sits in), not `filters.text`: a person who types and taps Filters
  // inside the debounce window has text the URL does not hold yet, and the sheet
  // pushes the whole bar at once. A pending debounce is left running — closing
  // the sheet without applying must still search what was typed.
  function openSheet(e: { currentTarget: { form: { elements: unknown } | null } }) {
    setSheet({ q: namedValue(e.currentTarget.form, "q") ?? filters.text, resets: 0 });
  }

  // Show registrants: ONE push of the staged controls + the search text, then
  // the sheet closes. The pending search debounce is cancelled first — the push
  // already carries that text, and left alone the timer would fire a second
  // push AFTER this one, from the main form, overwriting the sheet's filters
  // with the old ones.
  function handleSheetSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    debounce.cancel();
    pushFrom(e.currentTarget);
    setSheet(null);
  }

  // ── the faces ────────────────────────────────────────────────────────────────
  // Plain helper calls returning JSX (registration-hub-registrant-filter-pills.tsx),
  // NOT nested components: the node-env harness renders one component one level
  // deep, and a nested component would hide every select below from it (and from
  // the next reader's grep).
  const hrefFor = (query: string) => `${action}${query}`;
  const ctx: PillContext = {
    dict,
    clearHref: (name) => hrefFor(clearOneHref(current, name)),
    onChange: submitOnChange,
  };
  const specs = describeFilters(dict, filters, divisions);
  const [status, division, kind, solo, consent] = specs;
  // The Filters count, the chips and the set pills all read these same specs, so
  // the number on the button is exactly the number of chips beneath it.
  const setSpecs = specs.filter((s) => s.set);
  const active = hasActiveFilters(filters);

  return (
    <>
      <form
        method="GET"
        action={action}
        onSubmit={handleSubmit}
        data-registration-hub-registrant-filters
        className="mb-3 flex flex-col gap-2.5"
      >
        <input type="hidden" name="tab" value="registrants" />

        {/* Row 1: search, then (from md) sort. No stacked labels anywhere — each
            control is named by its aria-label, so nothing can sit out of line.
            Below md Sort lives in the sheet. */}
        <div className="flex flex-wrap items-center gap-2 md:flex-nowrap">
          <div className="relative min-w-0 max-md:w-full md:flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden="true"
            />
            <input
              key={`q:${filters.text}`}
              type="text"
              name="q"
              aria-label={t(dict, "reg.hub.registrants.filters.search")}
              defaultValue={filters.text}
              onChange={onSearchChange}
              placeholder={t(dict, "reg.filters.searchPlaceholder")}
              className="input h-11 pl-9 text-sm md:h-10"
            />
          </div>
          <select
            key={`sort:${filters.sort}`}
            name="sort"
            aria-label={t(dict, "reg.hub.registrants.filters.sort")}
            defaultValue={filters.sort}
            onChange={submitOnChange}
            className="input h-10 w-auto shrink-0 text-sm max-md:hidden"
          >
            <option value="newest">{t(dict, "reg.hub.registrants.filters.sortNewest")}</option>
            <option value="oldest">{t(dict, "reg.hub.registrants.filters.sortOldest")}</option>
          </select>
        </div>

        {/* Below md: the Filters button, then one removable chip per set filter,
            then "Clear all" while anything narrows. */}
        <div data-filter-phone-row className="flex flex-wrap items-center gap-2 md:hidden">
          <button
            type="button"
            data-filters-open
            aria-haspopup="dialog"
            onClick={openSheet}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-white px-4 text-sm font-medium text-purple-700 ring-1 ring-inset ring-purple-200 transition hover:bg-purple-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-600"
          >
            <SlidersHorizontal className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t(dict, "reg.filters.open")}
            {setSpecs.length > 0 && (
              <span
                data-filters-count
                className="grid h-5 min-w-5 place-items-center rounded-full bg-purple-600 px-1.5 text-xs font-semibold text-white"
              >
                {setSpecs.length}
              </span>
            )}
          </button>
          {setSpecs.map((spec) => chip(ctx, spec))}
          {active && (
            <Link
              href={hrefFor(clearAllHref(current))}
              data-chip-clear-all
              className="inline-flex h-11 items-center rounded-full px-3 text-sm font-medium text-purple-700 hover:bg-purple-50 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-600"
            >
              {t(dict, "reg.filters.clearAll")}
            </Link>
          )}
        </div>

        {/* From md, row 2: one pill per filter, then "Clear all" while anything
            narrows the rows — with nothing active there is nothing to clear, and a
            no-op link would only invite an idle click. */}
        <div data-filter-pill-row className="flex flex-wrap items-center gap-2 max-md:hidden">
          {selectPill(ctx, status!, statusOptionEls(dict, statusOptions))}
          {selectPill(ctx, division!, divisionOptionEls(dict, divisions))}
          {selectPill(ctx, kind!, kindOptionEls(dict, kindOptions))}
          {togglePill(ctx, solo!)}
          {togglePill(ctx, consent!)}

          {active && (
            <Link
              href={hrefFor(clearAllHref(current))}
              data-filter-clear-all
              className="inline-flex h-10 items-center rounded-full px-3 text-sm font-medium text-purple-700 hover:bg-purple-50 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-600"
            >
              {t(dict, "reg.filters.clearAll")}
            </Link>
          )}
        </div>
      </form>

      {/* A sibling of the bar's form, not inside it: its own controls carry the
          same names, and nested forms are not a thing. */}
      {sheet &&
        filterSheet({
          dict,
          filters,
          divisions,
          statusOptions,
          kindOptions,
          formId,
          q: sheet.q,
          resets: sheet.resets,
          onSubmit: handleSheetSubmit,
          onReset: () => setSheet({ ...sheet, resets: sheet.resets + 1 }),
          onClose: () => setSheet(null),
        })}
    </>
  );
}
