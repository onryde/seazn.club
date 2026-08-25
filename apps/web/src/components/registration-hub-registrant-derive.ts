// Registration hub — Registrants tab pure derivations (RS005 W2a): the
// status-pill style map, "is any filter active" (which of the two empty
// states to show), and the CSV export href builder. Pure and
// dependency-light (no React, no i18n, no DB) so every boundary is
// unit-testable without a component render or a database — same convention
// as registration-hub-row-derive.ts/registration-hub-status.ts for the
// Settings tab.
import type { RegistrationListRow } from "@/server/usecases/registrations";
import type { RegistrantsFilters } from "@/app/o/[orgSlug]/c/[compSlug]/registration/data";

/** Keyed by `Record<..., string>` against the REAL status union (not a
 *  hand-copied string literal list) so a missing entry is a compile error,
 *  not just a runtime gap — RS005 W1a's own history is that a `rejected`
 *  status was missed from a hand-kept list twice before W1b made
 *  `RegistrationStatus.options` the single source; this file has the same
 *  drift shape and gets the same guard, doubled by a completeness test
 *  (registration-hub-registrant-derive.test.ts) that iterates the real
 *  enum rather than trusting a count. */
export const REGISTRANT_STATUS_STYLE: Record<RegistrationListRow["status"], string> = {
  pending: "bg-amber-100 text-amber-700",
  paid: "bg-blue-100 text-blue-700",
  confirmed: "bg-green-100 text-green-700",
  waitlisted: "bg-purple-100 text-purple-700",
  withdrawn: "bg-slate-100 text-slate-500",
  expired: "bg-slate-100 text-slate-500",
  rejected: "bg-red-100 text-red-700",
};

/** Whether any filter NARROWS the row set — sort is deliberately excluded,
 *  it only orders. Drives which of the two empty states renders (task 5):
 *  zero rows with no active filter reads "no registrations at all" (RS004's
 *  designed empty panel, pointing at Settings/the register link); zero rows
 *  WITH one or more active reads "filters matched nothing" (a clear-filters
 *  affordance) instead. Reads off the SANITIZED filters
 *  (`fetchRegistrantRows`'s returned `.filters`, never the raw query
 *  string), so a dropped malformed value (an unknown status, a
 *  cross-competition division_id) never counts as "active" here either —
 *  it was ignored, so as far as this decision is concerned it was never
 *  there. */
export function hasActiveFilters(filters: RegistrantsFilters): boolean {
  return (
    filters.status !== null ||
    filters.divisionId !== null ||
    filters.kind !== null ||
    filters.freeAgent ||
    filters.consentPending ||
    filters.text !== ""
  );
}

/** The API's own query param names/convention (registration-list-query.ts,
 *  on this wave's do-not-touch list, read only) — `division_id`/`q`/1-0
 *  booleans — so the export always matches what `fetchRegistrantRows` sent
 *  `listRegistrations` to build what's on screen. `sort` is ALWAYS included,
 *  even at the default, so the exported rows are ordered exactly like the
 *  visible table regardless of that route's own default. */
function registrantsQueryString(filters: RegistrantsFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.divisionId) params.set("division_id", filters.divisionId);
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.freeAgent) params.set("free_agent", "1");
  if (filters.consentPending) params.set("consent_pending", "1");
  if (filters.text) params.set("q", filters.text);
  params.set("sort", filters.sort);
  return params.toString();
}

/** CSV export link — GET /api/v1/competitions/{id}/registrations/export,
 *  read-scope only (the route's own `requireResourceAuth(..., "read")`), so
 *  this renders for a viewer as well as an editor (owner ruling: "CSV
 *  export IS available to a viewer"). A plain href, not a client fetch —
 *  the codebase's established convention for every export button
 *  (documents-menu.tsx's own header comment; officiating-lane.tsx's rota
 *  PDF link is the single-button case this mirrors most closely). */
export function registrantsExportHref(competitionId: string, filters: RegistrantsFilters): string {
  return `/api/v1/competitions/${competitionId}/registrations/export?${registrantsQueryString(filters)}`;
}
