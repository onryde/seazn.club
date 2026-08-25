import Link from "@/components/ui/console-link";
import { t } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";
import { RegistrationStatus, EntrantKind } from "@/server/api-v1/schemas";
import { hasActiveFilters } from "@/components/registration-hub-registrant-derive";
import type {
  RegistrantsFilters,
  DivisionOption,
} from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";

/**
 * Registration hub — Registrants tab filter bar (RS005 W2a task 3).
 *
 * A plain `<form method="GET">`, deliberately: the surface needs no
 * JavaScript, stays shareable/back-buttonable, and the seven-width e2e
 * matrix can drive every control the same way it drives any other link. The
 * `action` is the tab's bare path (no query string — a GET form submission
 * REPLACES the action's own query string with the serialized form fields,
 * so embedding `?tab=registrants` in `action` would just be discarded); the
 * hidden `tab` input below is what reconstructs it on submit.
 *
 * Every `<select>`/`<input defaultValue>` below is UNCONTROLLED (no
 * `value`/`onChange`) on purpose — this is a server component with no
 * client state to control them with, and none is needed: the browser's
 * native form serialization is the entire "state management".
 *
 * Not a client component: no interactivity here needs `"use client"`, so `t`
 * comes straight from `@/lib/i18n` (server) rather than `i18n-runtime` —
 * unlike the Settings tab's row/panel, which ARE client components (gotcha
 * 6 in the dispatch: importing `@/lib/i18n` into a client component pulls in
 * `server-only` and only fails at `next build`, not tsc or vitest).
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
  return (
    <form
      method="GET"
      action={action}
      data-registration-hub-registrant-filters
      className="card mb-4 flex flex-wrap items-end gap-3 p-4"
    >
      <input type="hidden" name="tab" value="registrants" />

      <label className="flex flex-col text-xs font-medium text-slate-600">
        {t(dict, "reg.hub.registrants.filters.status")}
        <select name="status" defaultValue={filters.status ?? ""} className="input min-h-11 mt-1">
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
        <select name="division_id" defaultValue={filters.divisionId ?? ""} className="input min-h-11 mt-1">
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
        <select name="kind" defaultValue={filters.kind ?? ""} className="input min-h-11 mt-1">
          <option value="">{t(dict, "reg.hub.registrants.filters.kindAll")}</option>
          {EntrantKind.options.map((k) => (
            <option key={k} value={k}>
              {t(dict, `divset.entrants.kind.${k}`)}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col text-xs font-medium text-slate-600">
        {t(dict, "reg.hub.registrants.filters.search")}
        <input
          type="text"
          name="q"
          defaultValue={filters.text}
          placeholder={t(dict, "reg.hub.registrants.filters.searchPlaceholder")}
          className="input mt-1"
        />
      </label>

      <label className="flex flex-col text-xs font-medium text-slate-600">
        {t(dict, "reg.hub.registrants.filters.sort")}
        <select name="sort" defaultValue={filters.sort} className="input min-h-11 mt-1">
          <option value="newest">{t(dict, "reg.hub.registrants.filters.sortNewest")}</option>
          <option value="oldest">{t(dict, "reg.hub.registrants.filters.sortOldest")}</option>
        </select>
      </label>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" name="free_agent" value="1" defaultChecked={filters.freeAgent} />
        {t(dict, "reg.hub.registrants.filters.freeAgent")}
      </label>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" name="consent_pending" value="1" defaultChecked={filters.consentPending} />
        {t(dict, "reg.hub.registrants.filters.consentPending")}
      </label>

      <button type="submit" className="btn btn-primary min-h-11">
        {t(dict, "reg.hub.registrants.filters.apply")}
      </button>

      {/* Only when a filter is actually narrowing the rows — with nothing
          active there is nothing to clear, and a no-op link/button would
          only invite an idle click. */}
      {hasActiveFilters(filters) && (
        <Link href={clearHref} className="btn btn-ghost min-h-11">
          {t(dict, "reg.hub.registrants.filters.clear")}
        </Link>
      )}
    </form>
  );
}
