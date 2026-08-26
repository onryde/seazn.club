import { HttpError } from "@/lib/errors";
import { assertUuid } from "@/server/api-v1/auth";
import { EntrantKind, RegistrationSort, RegistrationStatus } from "@/server/api-v1/schemas";
import type { ListRegistrationsFilters } from "@/server/usecases/registrations";

/** "1"/"0" (api-v1's boolean-query convention, matching e.g. ?archived=1) →
 *  true/false; absent → undefined (no filter). */
function queryBool(raw: string | null, field: string): boolean | undefined {
  if (raw === null) return undefined;
  if (raw === "1") return true;
  if (raw === "0") return false;
  throw new HttpError(400, `${field} must be 1 or 0`);
}

function assertOneOf(value: string | null, options: readonly string[], field: string): void {
  if (value !== null && !options.includes(value)) {
    throw new HttpError(400, `${field} must be one of ${options.join(", ")}`);
  }
}

export interface RegistrationListQuery {
  divisionId: string | null;
  status: string | null;
  filters: ListRegistrationsFilters;
}

/**
 * The Registrants tab's query string, parsed once for BOTH competition-scoped
 * routes (list and CSV export). They accept an identical filter set and must
 * reject an identical set of bad values — two hand-maintained copies of that
 * is the same drift class this wave's status-enum work removed, and the
 * export is the copy where a missed validation leaks bytes rather than JSON.
 *
 * Enum membership is checked against the zod schemas' own `.options`, so a new
 * status or entrant kind flows here without an edit.
 */
export function parseRegistrationListQuery(url: string, competitionId: string): RegistrationListQuery {
  const sp = new URL(url).searchParams;

  const status = sp.get("status");
  assertOneOf(status, RegistrationStatus.options, "status");
  const kind = sp.get("kind");
  assertOneOf(kind, EntrantKind.options, "kind");
  const sort = sp.get("sort");
  assertOneOf(sort, RegistrationSort.options, "sort");

  const divisionId = sp.get("division_id");
  if (divisionId !== null) assertUuid(divisionId, "division");

  // `competition_id` is set unconditionally, and `listRegistrations` now
  // REQUIRES it to agree with any `division_id` given alongside it — that
  // guard is what closes the cross-competition read (and the API-key
  // competition-pin bypass, since the pin resolves from the URL path only).
  const filters: ListRegistrationsFilters = { competition_id: competitionId };
  if (kind) filters.kind = kind as ListRegistrationsFilters["kind"];
  const freeAgent = queryBool(sp.get("free_agent"), "free_agent");
  if (freeAgent !== undefined) filters.free_agent = freeAgent;
  const consentPending = queryBool(sp.get("consent_pending"), "consent_pending");
  if (consentPending !== undefined) filters.consent_pending = consentPending;
  const text = sp.get("q");
  if (text) filters.text = text;
  if (sort) filters.sort = sort as ListRegistrationsFilters["sort"];

  return { divisionId, status, filters };
}
