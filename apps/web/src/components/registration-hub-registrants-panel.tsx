import { ClipboardList, SearchX } from "lucide-react";
import { t } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";
import { RegistrationHubRegistrantEmpty } from "@/components/registration-hub-registrant-empty";
import { RegistrationHubRegistrantFilters } from "@/components/registration-hub-registrant-filters";
import { RegistrationHubRegistrantTable } from "@/components/registration-hub-registrant-table";
import { hasActiveFilters } from "@/components/registration-hub-registrant-derive";
import type {
  RegistrantsFilters,
  DivisionOption,
  RegistrantDetails,
} from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";
import type { RegistrationListRow } from "@/server/usecases/registrations";

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
  orgTz,
  filtersAction,
  clearHref,
  exportHref,
  emptyTitle,
  emptyBody,
  emptyCtaLabel,
  emptyCtaHref,
  details,
}: {
  rows: RegistrationListRow[];
  filters: RegistrantsFilters;
  divisions: DivisionOption[];
  canEdit: boolean;
  dict: Dict;
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

      <RegistrationHubRegistrantFilters
        dict={dict}
        action={filtersAction}
        filters={filters}
        divisions={divisions}
        clearHref={clearHref}
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
