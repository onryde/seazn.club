import { ChevronRight, ClipboardList, Clock, SearchX } from "lucide-react";
import { t, plural } from "@/lib/i18n";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { fmtDateTime, fmtZoneAbbrev } from "@/lib/format";
import { RegistrationHubRegistrantEmpty } from "@/components/registration-hub-registrant-empty";
import { RegistrationHubRegistrantFilters } from "@/components/registration-hub-registrant-filters";
import { RegistrationHubRegistrantTable } from "@/components/registration-hub-registrant-table";
import { hasActiveFilters } from "@/components/registration-hub-registrant-derive";
// A real (non-type-only) VALUE import — safe here because this file has no
// "use client": it is a server component, never bundled for the browser, so
// schemas.ts's own transitive reach into the engine's gRPC scheduling
// client (Node built-ins: dns/net/http2) never becomes the browser's
// problem. RegistrationHubRegistrantFilters (below) is the opposite case —
// it BECAME a client component (R4's auto-submit needs onChange handlers)
// and broke `next build` importing this same module directly, which is why
// its two option lists are read HERE, server-side, and handed down as
// plain string props instead.
import { RegistrationStatus, EntrantKind } from "@/server/api-v1/schemas";
import type {
  RegistrantsFilters,
  DivisionOption,
  RegistrantDetails,
  PoolSummaryRow,
} from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";
import type { RegistrationListRow } from "@/server/usecases/registrations";

/** RS012 scope item 4 — `PoolSummaryRow` (data.ts) widened with the ONE
 *  thing this panel needs that the raw row doesn't carry: the href into that
 *  division's pre-filtered Registrants table. Built by page.tsx from
 *  `division_id` + `routes.competitionRegistration`, exactly like
 *  `exportHref`/`clearHref`/`emptyCtaHref` below — this panel does not
 *  import `routes` itself (see the panel doc comment). */
export interface PoolSummaryPanelRow extends PoolSummaryRow {
  href: string;
}

/**
 * Registration hub — Registrants tab (RS005 W2a). RS004 W2 shipped this as
 * a data-free designed placeholder; this wave replaces it with the real
 * read surface: an export link, the filter bar, and either the table or one
 * of TWO deliberately different empty states (task 5) — never the same
 * "no one's registered" copy for "your competition is empty" and "you have
 * over-filtered it", which would misinform an organiser about the former
 * when it's actually the latter.
 *
 * `canEdit` gated no visible control through W2a — that wave shipped no
 * mutating controls at all. RS005 W2b's row-expand detail is the first
 * consumer: the join-code copy control is ABSENT for a viewer (owner
 * ruling: mutating controls must be ABSENT, not disabled). `canEdit` is
 * still threaded to the root's `data-can-edit` attribute too, unchanged
 * from W2a.
 *
 * Every href (`filtersAction`/`clearHref`/`exportHref`/`emptyCtaHref`) is
 * pre-built by page.tsx via `routes.*`, exactly like the Settings panel's
 * `registerHref` — this component never imports `routes` itself. W2b reuses
 * `clearHref` a second time, as the table context's `baseHref`: a cart
 * sibling's link (registration-hub-registrant-detail.tsx) needs the SAME
 * filters-cleared URL, for the same reason the "filters matched nothing"
 * empty state's CTA does — a sibling excluded by the active filter would
 * otherwise link nowhere.
 */
export function RegistrationHubRegistrantsPanel({
  rows,
  filters,
  divisions,
  canEdit,
  dict,
  locale,
  orgTz,
  filtersAction,
  clearHref,
  exportHref,
  emptyTitle,
  emptyBody,
  emptyCtaLabel,
  emptyCtaHref,
  details,
  poolSummary,
}: {
  rows: RegistrationListRow[];
  filters: RegistrantsFilters;
  divisions: DivisionOption[];
  canEdit: boolean;
  dict: Dict;
  /** RS012 `/code-review high` finding 3 — needed for the pool banner's
   *  `plural()` calls below (Intl.PluralRules selection); every other
   *  string on this panel goes through `t()`, which needs no locale. */
  locale: Locale;
  orgTz: string;
  filtersAction: string;
  clearHref: string;
  exportHref: string;
  emptyTitle: string;
  emptyBody: string;
  emptyCtaLabel: string;
  emptyCtaHref: string;
  /** RS005 W2b — the row-expand detail's batched roster/siblings/form_fields
   *  (fetchRegistrantDetails, task 3). Threaded straight through to the
   *  table; this panel does no lookups of its own. */
  details: RegistrantDetails;
  /** RS012 scope item 4 — one row per division that has someone WAITING in
   *  the solo sign-up pool right now (fetchPoolSummary, data.ts) — empty for
   *  every other competition, which is what keeps the banner below silent
   *  rather than an "everything's fine" wrapper. */
  poolSummary: PoolSummaryPanelRow[];
}) {
  const filtered = hasActiveFilters(filters);

  // "No registrations at all" — RS004's designed treatment, reused
  // byte-for-byte, and nothing ELSE on the tab: a filter bar or export
  // link above a "no one's registered yet" message has nothing to act on.
  if (rows.length === 0 && !filtered) {
    return (
      <div data-registration-hub-registrants-panel data-can-edit={canEdit}>
        <RegistrationHubRegistrantEmpty
          icon={ClipboardList}
          title={emptyTitle}
          body={emptyBody}
          ctaLabel={emptyCtaLabel}
          ctaHref={emptyCtaHref}
          variant="empty"
        />
      </div>
    );
  }

  return (
    <div data-registration-hub-registrants-panel data-can-edit={canEdit}>
      <div className="mb-3 flex justify-end">
        {/* A plain href, not a client fetch — this codebase's established
            convention for every export button (documents-menu.tsx's own
            header comment). Read-scope only (the route's own
            requireResourceAuth(..., "read")), so this renders for a
            viewer too (owner ruling). */}
        <a href={exportHref} className="btn btn-ghost text-sm">
          {t(dict, "reg.exportCsv")}
        </a>
      </div>

      {/* RS012 scope item 4 — the proactive pool banner. Rendered ONLY when
          some division actually has someone waiting (poolSummary.length),
          so a competition with nothing to act on gets no wrapper at all —
          never a quiet "0 waiting" line. Amber/attention-toned on purpose
          (same palette entry-card.tsx's own money/deadline text uses,
          register/status/entry-card.tsx), with a left rail — the same visual
          device that file's own status badges use for "pending" — so this
          reads as something that wants action, not as one more row of the
          panel's ordinary gray copy. */}
      {poolSummary.length > 0 && (
        <div
          data-registration-hub-pool-summary
          className="mb-4 rounded-lg border border-amber-200 border-l-4 border-l-amber-400 bg-amber-50 p-4"
        >
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
            <p className="text-sm font-semibold text-amber-900">{t(dict, "reg.hub.registrants.pool.heading")}</p>
          </div>
          <ul className="mt-2 space-y-2">
            {poolSummary.map((row) => (
              <li key={row.division_id}>
                {/* A real <a href>, not a div+onClick (task requirement) —
                    works with no JS and is keyboard-navigable. The whole row
                    is the click target, not just a small "View" affordance. */}
                <a
                  href={row.href}
                  className="flex items-center gap-2 rounded-md border border-amber-200 bg-white px-3 py-2 text-sm transition hover:border-amber-300 hover:bg-amber-100"
                >
                  <span className="min-w-0 grow">
                    <span className="block truncate font-medium text-amber-900">{row.division_name}</span>
                    <span className="mt-0.5 block text-xs text-amber-800">
                      {/* RS012 `/code-review high` finding 3 — a manual
                          `=== 1` ternary picks the wrong grammatical form for
                          locales whose plural boundary is not "exactly 1"
                          (`new Intl.PluralRules('fr').select(0) === 'one'`,
                          not 'other'), and free_slots: 0 is a real, reachable
                          state (fetchPoolSummary's own test). `plural()`
                          (lib/i18n-runtime) runs the real Intl.PluralRules
                          selection this panel's server-rendered `locale` prop
                          makes available — no DictProvider/usePlural needed
                          (registration-hub-config-panel.tsx's own header
                          comment on that different constraint). */}
                      {plural(dict, "reg.hub.registrants.pool.waiting", row.waiting, locale)}
                      {" · "}
                      {plural(dict, "reg.hub.registrants.pool.freeSlots", row.free_slots, locale)}
                    </span>
                    {/* Omitted entirely when null (task requirement) — a
                        division with neither place_by_at nor closes_at set has
                        nothing enforcing a deadline yet, same "nothing to show"
                        rule the Stage 3b status page's own poolPlaceByDate
                        follows, never "Invalid Date". */}
                    {row.place_by_at && (
                      <span className="mt-0.5 block text-xs text-amber-700">
                        {t(dict, "reg.hub.registrants.pool.placeBy", {
                          date: `${fmtDateTime(orgTz, row.place_by_at)} ${fmtZoneAbbrev(orgTz, row.place_by_at)}`,
                        })}
                      </span>
                    )}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <RegistrationHubRegistrantFilters
        dict={dict}
        action={filtersAction}
        filters={filters}
        divisions={divisions}
        clearHref={clearHref}
        statusOptions={RegistrationStatus.options}
        kindOptions={EntrantKind.options}
      />

      {rows.length === 0 ? (
        // "Filters matched nothing" — task 5's OTHER, deliberately different
        // empty state: a clear-filters affordance, not a "go to Settings"
        // one, and different copy/icon so it never reads as "your
        // competition is empty" when it is actually just over-filtered.
        <RegistrationHubRegistrantEmpty
          icon={SearchX}
          title={t(dict, "reg.hub.registrants.emptyFiltered.title")}
          body={t(dict, "reg.hub.registrants.emptyFiltered.body")}
          ctaLabel={t(dict, "reg.hub.registrants.filters.clear")}
          ctaHref={clearHref}
          variant="filtered"
        />
      ) : (
        <RegistrationHubRegistrantTable
          rows={rows}
          context={{ dict, orgTz, canEdit, baseHref: clearHref }}
          details={details}
        />
      )}
    </div>
  );
}
