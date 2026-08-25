// The Settings tab's data layer. It lives beside page.tsx rather than inside
// it because Next tolerates only a fixed export surface from a page module
// (default, `metadata`, `dynamic`, `generateStaticParams`, …) — a helper
// exported from page.tsx is a build-time hazard, and src/__tests__/
// app-module-exports.test.ts is the sweep that says so. It caught these three
// on RS004's first full CI run; nothing local runs that suite.
import { withTenant } from "@/lib/db";
import { SPOT_HOLDERS } from "@/lib/registration-status";
import { HttpError } from "@/lib/errors";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { RegistrationHubRowData } from "@/components/registration-hub-division-row";
import {
  listRegistrations,
  type RegistrationListRow,
  type ListRegistrationsFilters,
} from "@/server/usecases/registrations";
// Type/enum-only reads off the zod schemas RS005 W1b's own API query parser
// (server/api-v1/registration-list-query.ts, on this wave's do-not-touch
// list) uses for the identical validation job — never a call into anything
// ELSE under server/api-v1, which stays closed this wave.
import { RegistrationStatus, RegistrationSort, EntrantKind } from "@/server/api-v1/schemas";

export interface RawDivisionRow {
  division_id: string;
  name: string;
  category: RegistrationHubRowData["category"];
  age_min: number | null;
  age_max: number | null;
  enabled: boolean;
  entrant_kind: RegistrationHubRowData["entrant_kind"];
  opens_at: Date | string | null;
  closes_at: Date | string | null;
  capacity: number | null;
  fee_cents: number;
  approval: RegistrationHubRowData["approval"];
  allow_free_agents: boolean;
  taken: number;
  /** Same value on every row (org-level, RS001b) — carried per-row rather
   *  than fetched separately so this stays a SINGLE query for the rows. */
  org_currency: string;
  /** Same value on every row (org-level) — non-null when the org's
   *  connected Stripe account settles outside the registration-currency
   *  allowlist, meaning card collection is not viable (RS004 W3c config
   *  panel). Read the same way app/o/[orgSlug]/settings/page.tsx derives
   *  it for its (owner-and-admin) audience — a raw column read, not through
   *  stripe-connect.ts's connectStatus(), which is owner-session-only and
   *  would 403 an admin opening this hub. */
  org_stripe_unsupported_currency: string | null;
}

/** The Settings tab's one query: every (non-archived) division of this
 *  competition, LEFT JOINed to its registration_settings (a division not yet
 *  configured has no row there at all), with the live spot-count and the
 *  org's registration currency riding along — no client fetch, no N+1. */
export async function fetchDivisionRows(
  auth: Pick<AuthCtx, "orgId">,
  competitionId: string,
): Promise<RawDivisionRow[]> {
  return withTenant(auth.orgId, (tx) =>
    tx<RawDivisionRow[]>`
      select
        d.id as division_id,
        d.name,
        d.category,
        d.age_min,
        d.age_max,
        coalesce(rs.enabled, false) as enabled,
        rs.entrant_kind,
        rs.opens_at,
        rs.closes_at,
        rs.capacity,
        coalesce(rs.fee_cents, 0) as fee_cents,
        rs.approval,
        coalesce(rs.allow_free_agents, false) as allow_free_agents,
        (select count(*)::int from registrations r
           where r.division_id = d.id and r.status in ${tx([...SPOT_HOLDERS])}) as taken,
        (select currency from organizations where id = ${auth.orgId}) as org_currency,
        (select stripe_unsupported_currency from organizations where id = ${auth.orgId})
          as org_stripe_unsupported_currency
      from divisions d
      left join registration_settings rs on rs.division_id = d.id
      where d.competition_id = ${competitionId} and d.archived_at is null
      order by d.name, d.id`,
  );
}

/** Finding 6 fallback: `fetchDivisionRows`'s `org_currency` column rides on
 *  a DIVISION row, so a competition with zero (non-archived) divisions
 *  returns zero rows — nothing to read a currency off at all, and
 *  `asCurrency(rawRows[0]?.org_currency)` silently defaulted to "usd".
 *  Only called from page.tsx's empty-rows branch; the common case (rows
 *  exist) keeps reading org_currency off rawRows[0] at zero extra queries,
 *  so this never runs alongside a non-empty result and fetchDivisionRows
 *  itself still costs exactly one round trip. */
export async function fetchOrgCurrency(auth: Pick<AuthCtx, "orgId">): Promise<string> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ currency: string }[]>`
      select currency from organizations where id = ${auth.orgId}`;
    return row?.currency ?? "usd";
  });
}

/** The SAME finding-6 shape as `fetchOrgCurrency`, for the config panel's
 *  card-unsupported-currency message: `fetchDivisionRows`'s own column
 *  rides on a division row, so a Settings-tab competition with zero
 *  (non-archived) divisions has none to read it off. Only called from
 *  page.tsx's empty-rows branch — the common case reads it off `rawRows[0]`
 *  at zero extra queries, same as org_currency. */
export async function fetchOrgCardUnsupportedCurrency(
  auth: Pick<AuthCtx, "orgId">,
): Promise<string | null> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ stripe_unsupported_currency: string | null }[]>`
      select stripe_unsupported_currency from organizations where id = ${auth.orgId}`;
    return row?.stripe_unsupported_currency ?? null;
  });
}

// ---------------------------------------------------------------------------
// The Registrants tab's data layer (RS005 W2a).
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RegistrantEntrantKind = "team" | "individual" | "pair";

/** The tab's raw `?status=`/`?division_id=`/... — untyped strings straight
 *  off `searchParams`, exactly as Next hands them over (a page's own
 *  `{ tab?: string }` shape, widened). */
export interface RegistrantsRawQuery {
  status?: string;
  division_id?: string;
  kind?: string;
  free_agent?: string;
  consent_pending?: string;
  q?: string;
  sort?: string;
}

/** The SANITIZED filter set — what actually got applied, after dropping
 *  anything malformed. Doubles as (a) what gets sent to `listRegistrations`
 *  and (b) what the filter form pre-fills / what "is any filter active"
 *  (the empty-state choice) is computed from, so the applied state and the
 *  displayed state can never drift into two separate copies. */
export interface RegistrantsFilters {
  status: string | null;
  divisionId: string | null;
  kind: RegistrantEntrantKind | null;
  freeAgent: boolean;
  consentPending: boolean;
  text: string;
  sort: "newest" | "oldest";
}

/** Raw query -> sanitized filters. PURE (no DB, no auth) — task 3's ruling
 *  ("unknown or malformed values must not 500 the page — ignore them and
 *  render unfiltered") is enforced entirely here, once, rather than at
 *  every call site: this is a page, not the API, and has no envelope to 400
 *  with. Every enum membership check reads `.options` off the SAME zod
 *  schemas RS005 W1b's own API query parser uses
 *  (RegistrationStatus/EntrantKind/RegistrationSort), so a status this page
 *  accepts can never silently diverge from one the API accepts.
 *
 *  `division_id` gets its own shape check rather than a DB round trip: a
 *  non-UUID string handed straight to `listRegistrations` reaches a raw
 *  `where id = $1` comparison against a `uuid` column and throws a Postgres
 *  syntax error — not the graceful HttpError(404) `fetchRegistrantRows`'s
 *  cross-competition retry (below) expects. Same regex
 *  app/admin/fixtures/page.tsx already uses for the identical reason. */
export function parseRegistrantsQuery(raw: RegistrantsRawQuery): RegistrantsFilters {
  const status =
    raw.status && (RegistrationStatus.options as readonly string[]).includes(raw.status)
      ? raw.status
      : null;
  const kind =
    raw.kind && (EntrantKind.options as readonly string[]).includes(raw.kind)
      ? (raw.kind as RegistrantEntrantKind)
      : null;
  // This tab's OWN default is "newest" (task 4) — deliberately NOT
  // listRegistrations' own default ("oldest", unchanged for the pre-existing
  // division-scoped route that never sets `sort` at all).
  const sort: "newest" | "oldest" =
    raw.sort && (RegistrationSort.options as readonly string[]).includes(raw.sort)
      ? (raw.sort as "newest" | "oldest")
      : "newest";
  const divisionId = raw.division_id && UUID_RE.test(raw.division_id) ? raw.division_id : null;
  return {
    status,
    divisionId,
    kind,
    freeAgent: raw.free_agent === "1",
    consentPending: raw.consent_pending === "1",
    text: raw.q?.trim() ?? "",
    sort,
  };
}

function toListFilters(competitionId: string, filters: RegistrantsFilters): ListRegistrationsFilters {
  const listFilters: ListRegistrationsFilters = { competition_id: competitionId, sort: filters.sort };
  if (filters.kind) listFilters.kind = filters.kind;
  if (filters.freeAgent) listFilters.free_agent = true;
  if (filters.consentPending) listFilters.consent_pending = true;
  if (filters.text) listFilters.text = filters.text;
  return listFilters;
}

export interface RegistrantRowsResult {
  rows: RegistrationListRow[];
  /** The filters ACTUALLY applied — after dropping anything malformed, and
   *  after the cross-competition retry below (if it fired). */
  filters: RegistrantsFilters;
}

/**
 * The Registrants tab's one function, one round trip for the rows —
 * delegates entirely to `listRegistrations` (RS005 W1a/W1b), the SAME read
 * model the organiser JSON/CSV routes use, so there is no second query path
 * for this tab's rows to drift from it.
 *
 * A `division_id` that parses as a UUID but does not exist, or belongs to a
 * DIFFERENT competition, makes `listRegistrations` throw `HttpError(404)` —
 * its own cross-competition guard (RS005 W1b). Task 3's "ignore malformed
 * values, render unfiltered" ruling extends to this case too: it is
 * reachable the exact same way (a hand-edited query string), and hard
 * 404ing the whole hub over one bad filter would lose the header/nav/
 * Settings tab for no reason a viewer or organiser caused. So this drops
 * the division filter and retries ONCE rather than propagating — the same
 * treatment as any other malformed value, just discovered a round trip
 * later, because only the database can say whether a syntactically-valid
 * UUID actually belongs to this competition. The retry is cheap even on the
 * unhappy path: `listRegistrations`'s division guard fails fast on a small
 * lookup query, before it ever runs the expensive joined SELECT.
 */
export async function fetchRegistrantRows(
  auth: AuthCtx,
  competitionId: string,
  query: RegistrantsRawQuery,
): Promise<RegistrantRowsResult> {
  const filters = parseRegistrantsQuery(query);
  try {
    const rows = await listRegistrations(
      auth,
      filters.divisionId,
      filters.status,
      toListFilters(competitionId, filters),
    );
    return { rows, filters };
  } catch (err) {
    // Scoped to "we just sent a division_id" so this can never mask an
    // unrelated 404 (e.g. a bad competition id — this page never sends one,
    // `competitionId` is always the page's own already-resolved competition).
    if (filters.divisionId && err instanceof HttpError && err.status === 404) {
      const droppedFilters: RegistrantsFilters = { ...filters, divisionId: null };
      const rows = await listRegistrations(
        auth,
        null,
        droppedFilters.status,
        toListFilters(competitionId, droppedFilters),
      );
      return { rows, filters: droppedFilters };
    }
    throw err;
  }
}

export interface DivisionOption {
  id: string;
  name: string;
}

/** The Registrants tab's division-filter dropdown — deliberately a SEPARATE,
 *  smaller query than `fetchDivisionRows` (task 2): that one joins
 *  registration_settings and computes taken/org_currency/
 *  org_stripe_unsupported_currency for the Settings tab's row cards, all of
 *  it wasted work for a dropdown that only needs id+name. */
export async function fetchDivisionOptions(
  auth: Pick<AuthCtx, "orgId">,
  competitionId: string,
): Promise<DivisionOption[]> {
  return withTenant(auth.orgId, (tx) =>
    tx<DivisionOption[]>`
      select id, name
      from divisions
      where competition_id = ${competitionId} and archived_at is null
      order by name, id`,
  );
}
