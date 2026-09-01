// The Settings tab's data layer. It lives beside page.tsx rather than inside
// it because Next tolerates only a fixed export surface from a page module
// (default, `metadata`, `dynamic`, `generateStaticParams`, …) — a helper
// exported from page.tsx is a build-time hazard, and src/__tests__/
// app-module-exports.test.ts is the sweep that says so. It caught these three
// on RS004's first full CI run; nothing local runs that suite.
import { withTenant } from "@/lib/db";
import { SPOT_HOLDERS } from "@/lib/registration-status";
import { HttpError } from "@/lib/errors";
// A real (non-type-only) VALUE import of a "components" module, into this
// data layer — safe here (no bundling concern, unlike the client filter
// component's own header comment about @/server/api-v1/schemas): this file
// is server-only and registration-hub-registrant-derive.ts is itself
// "pure and dependency-light (no React, no i18n, no DB)" per its own header
// comment. Its OWN reach back into this file is type-only
// (`import type {...} from ".../data"`), so there is no runtime cycle.
// Used by registrantsExportHrefFor below (RS005 F3 finding 2).
import { registrantsExportHref } from "@/components/registration-hub-registrant-derive";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { RegistrationHubRowData } from "@/components/registration-hub-division-row";
import {
  listRegistrations,
  rosterCapExpr,
  type RegistrationListRow,
  type ListRegistrationsFilters,
} from "@/server/usecases/registrations";
// Type/enum-only reads off the zod schemas RS005 W1b's own API query parser
// (server/api-v1/registration-list-query.ts, on this wave's do-not-touch
// list) uses for the identical validation job — never a call into anything
// ELSE under server/api-v1, which stays closed this wave.
import {
  RegistrationStatus,
  RegistrationSort,
  EntrantKind,
  type RegistrationFormField,
} from "@/server/api-v1/schemas";

export interface RawDivisionRow {
  division_id: string;
  name: string;
  category: RegistrationHubRowData["category"];
  age_min: number | null;
  age_max: number | null;
  /** RS007/V380 — the age-band cutoff override (default 1 January) and the
   *  retired jsonb "custom rule" note, now first-class `divisions` columns
   *  alongside category/age_min/age_max above; the config panel's
   *  Eligibility section edits all six as one PATCH. */
  age_cutoff_month: number | null;
  age_cutoff_day: number | null;
  eligibility_note: string | null;
  enabled: boolean;
  entrant_kind: RegistrationHubRowData["entrant_kind"];
  opens_at: Date | string | null;
  closes_at: Date | string | null;
  capacity: number | null;
  fee_cents: number;
  approval: RegistrationHubRowData["approval"];
  allow_free_agents: boolean;
  taken: number;
  /** Registrations in `waitlisted` status for this division (RS005 F4) —
   *  read by the config panel's Money section to warn an organiser editing
   *  the fee that promoting any of them re-prices at whatever fee is LIVE
   *  at promotion time, not what they saw when they joined (waitlisted rows
   *  hold `amount_cents = 0`, so there is no earlier quote to honour — see
   *  `promoteWaitlistedRow`, registrations.ts). Counted by its OWN
   *  subquery, deliberately never folded into `taken`'s SPOT_HOLDERS set —
   *  a waitlisted entry holds no spot. */
  waitlisted: number;
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
        d.age_cutoff_month,
        d.age_cutoff_day,
        d.eligibility_note,
        coalesce(rs.enabled, false) as enabled,
        rs.entrant_kind,
        rs.opens_at,
        rs.closes_at,
        rs.capacity,
        coalesce(rs.fee_cents, 0) as fee_cents,
        rs.approval,
        coalesce(rs.allow_free_agents, false) as allow_free_agents,
        -- RS012 ruling 1: capacity/taken counts TEAM entries only — a
        -- solo sign-up ("free agent") never occupies a team slot, matching
        -- the submit-time gate this display must agree with
        -- (registration-submit.ts).
        (select count(*)::int from registrations r
           where r.division_id = d.id and r.status in ${tx([...SPOT_HOLDERS])}
             and r.free_agent = false) as taken,
        (select count(*)::int from registrations r
           where r.division_id = d.id and r.status = 'waitlisted') as waitlisted,
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
 *  `{ tab?: string }` shape, widened).
 *
 *  Each field is `string | string[]`, not just `string` (RS005 F3 finding
 *  1): a REPEATED key (`?q=a&q=b`) reaches a page's `searchParams` as
 *  `string[]`, per Next's own docs (`/shop?a=1&a=2` -> `{ a: ['1', '2'] }`),
 *  and Next never dedupes. `page.tsx`'s `searchParams` prop is typed
 *  `Promise<any>` by Next's own generated `PageProps`, so a `RawQuery`
 *  declared as plain `string` fields used to hide that shape from tsc
 *  entirely — `parseRegistrantsQuery` below is where it actually gets
 *  handled, via `firstOf`. */
export interface RegistrantsRawQuery {
  status?: string | string[];
  division_id?: string | string[];
  kind?: string | string[];
  free_agent?: string | string[];
  consent_pending?: string | string[];
  q?: string | string[];
  sort?: string | string[];
}

/** RS005 F3 finding 1: collapses a possibly-repeated query param to ONE
 *  string before anything else touches it. FIRST VALUE WINS — the same
 *  choice `URLSearchParams.get()` already makes for the API route's
 *  identical parsing job (registration-list-query.ts's `sp.get(...)`),
 *  rather than "ignore the field entirely": a dupe is far more likely a
 *  bookmarked/hand-edited URL carrying one stale copy alongside the current
 *  one than a deliberate "no value" signal. An empty array (should Next
 *  ever produce one) falls through to `undefined`, same as truly absent. */
function firstOf(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** "1" -> true (filter ON), "0" -> explicit false (narrows to the OPPOSITE
 *  case), anything else — absent, malformed, or an array `firstOf` already
 *  reduced to its first value — -> null, meaning "no filter" (RS005 F3
 *  finding 2). This page's own convention has to keep "unset" and
 *  "explicitly false" distinguishable, mirroring `queryBool`'s
 *  true/false/undefined split in registration-list-query.ts, just with
 *  `null` standing in for `undefined` to match this file's OWN "unset"
 *  convention (status/divisionId/kind, above) rather than introducing a
 *  second one. Never throws (unlike `queryBool`) — this page's ruling that
 *  a malformed value must be ignored, not fatal, applies here too. */
function parseTriBool(v: string | undefined): boolean | null {
  if (v === "1") return true;
  if (v === "0") return false;
  return null;
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
  /** Tri-state (RS005 F3 finding 2): `null` means unset (no filter — every
   *  row passes); `true`/`false` are both ACTIVE, opposite filters. Never
   *  collapse this back to a plain boolean — `toListFilters` below (and
   *  `registrantsExportHrefFor`) both depend on telling "unset" and
   *  "explicitly false" apart. */
  freeAgent: boolean | null;
  /** Same tri-state as `freeAgent`, same reason. */
  consentPending: boolean | null;
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
  const rawStatus = firstOf(raw.status);
  const status =
    rawStatus && (RegistrationStatus.options as readonly string[]).includes(rawStatus) ? rawStatus : null;
  const rawKind = firstOf(raw.kind);
  const kind =
    rawKind && (EntrantKind.options as readonly string[]).includes(rawKind)
      ? (rawKind as RegistrantEntrantKind)
      : null;
  // This tab's OWN default is "newest" (task 4) — deliberately NOT
  // listRegistrations' own default ("oldest", unchanged for the pre-existing
  // division-scoped route that never sets `sort` at all).
  const rawSort = firstOf(raw.sort);
  const sort: "newest" | "oldest" =
    rawSort && (RegistrationSort.options as readonly string[]).includes(rawSort)
      ? (rawSort as "newest" | "oldest")
      : "newest";
  const rawDivisionId = firstOf(raw.division_id);
  const divisionId = rawDivisionId && UUID_RE.test(rawDivisionId) ? rawDivisionId : null;
  const rawQ = firstOf(raw.q);
  return {
    status,
    divisionId,
    kind,
    freeAgent: parseTriBool(firstOf(raw.free_agent)),
    consentPending: parseTriBool(firstOf(raw.consent_pending)),
    text: rawQ?.trim() ?? "",
    sort,
  };
}

function toListFilters(competitionId: string, filters: RegistrantsFilters): ListRegistrationsFilters {
  const listFilters: ListRegistrationsFilters = { competition_id: competitionId, sort: filters.sort };
  if (filters.kind) listFilters.kind = filters.kind;
  // `!== null`, not truthiness (RS005 F3 finding 2) — the same distinction
  // registration-list-query.ts's own `queryBool` draws (`!== undefined`), so
  // an explicit `false` (query "0") reaches `listRegistrations` as an
  // explicit false rather than being collapsed into "omit the filter",
  // which a plain `if (filters.freeAgent)` guard did before this fix.
  if (filters.freeAgent !== null) listFilters.free_agent = filters.freeAgent;
  if (filters.consentPending !== null) listFilters.consent_pending = filters.consentPending;
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

/**
 * RS005 F3 finding 2: wraps `registrantsExportHref` (registration-hub-
 * registrant-derive.ts, this wave's do-not-touch list — owned by a sibling
 * agent) so the CSV export link matches what `fetchRegistrantRows` actually
 * put on screen. `registrantsExportHref`'s own `registrantsQueryString`
 * only ever emits the "1" form of free_agent/consent_pending (both fields
 * were plain booleans everywhere until this wave's tri-state fix, above) —
 * an explicit `false` (the table narrowed to "no free agents" /
 * "nothing outstanding") silently vanished from the export link entirely,
 * so the exported file could disagree with the table the organiser was
 * looking at.
 *
 * Rather than editing the owned-by-another-agent file (a second hand-kept
 * copy of its query-building would be exactly the drift class RS005 W1b's
 * status-enum work removed), this appends the explicit "0" ONLY when the
 * table is actually narrowed to the negative case — never for a bare
 * "unset" `null`, which stays absent from the query string same as every
 * other filter. `registrantsExportHref`'s own result always carries at
 * least `sort=...` (set unconditionally), so it always already has a `?`
 * to append `&` onto.
 */
export function registrantsExportHrefFor(competitionId: string, filters: RegistrantsFilters): string {
  const href = registrantsExportHref(competitionId, filters);
  const negatives: string[] = [];
  if (filters.freeAgent === false) negatives.push("free_agent=0");
  if (filters.consentPending === false) negatives.push("consent_pending=0");
  return negatives.length === 0 ? href : `${href}&${negatives.join("&")}`;
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

// ---------------------------------------------------------------------------
// The Registrants tab's pool summary banner (RS012 scope item 4).
// ---------------------------------------------------------------------------

export interface PoolSummaryRow {
  division_id: string;
  division_name: string;
  waiting: number;
  free_slots: number;
  /** coalesce(place_by_at, closes_at) — the SAME fallback the Stage 2 sweep
   *  (registrations.ts's duePool query) and the Stage 3b status page
   *  (poolPlaceByDate) both already use. Null only if the division has
   *  neither set (nothing enforces a deadline yet). */
  place_by_at: string | null;
}

/**
 * The Registrants tab's proactive pool banner (RS012 scope item 4): every
 * division in this competition that has someone WAITING in the solo sign-up
 * pool, alongside the free roster room already sitting on its registered
 * teams and the effective place-by deadline — everything an organiser needs
 * to decide whether to act, without first having to know to tick the
 * `free_agent` filter checkbox.
 *
 * Three separately-testable queries, not one complex join:
 *
 *  1. Which divisions have anyone actually waiting — the exact same
 *     "pooled" predicate `soloPoolIsFull` and the Stage 2 sweep's `duePool`
 *     already use (`free_agent = true`, `status in SPOT_HOLDERS`, and NOT
 *     already assigned via `registration_players.assigned_from_registration_id`).
 *     `having count(*) > 0` means a division with an empty (or fully-placed)
 *     pool never reaches queries 2/3 at all — the whole function returns
 *     `[]` when nothing needs attention, so the banner renders nothing.
 *  2. Free roster room on registered (non-terminal, non-waitlisted,
 *     non-free-agent) teams in those SAME divisions — deliberately the SAME
 *     population `listAssignTargets` (registration-assign.ts) already
 *     computes per-solo-sign-up when an organiser opens the assign picker,
 *     using the SAME `rosterCapExpr` (registrations.ts) every roster-cap
 *     display in this codebase reads off. This is NOT `soloPoolIsFull`'s
 *     abstract `capacity × roster_cap` admission bound — an organiser
 *     asking "do my existing teams have room?" wants the former, and
 *     conflating the two would tell them slots exist that no real team can
 *     currently hold.
 *  3. Division names and the effective deadline (`coalesce(place_by_at,
 *     closes_at)`) for those same divisions — LEFT JOINed to
 *     registration_settings for the same "predates configuration" reason
 *     `listRegistrations` LEFT JOINs it (a division a solo sign-up belongs
 *     to always has settings in production, but a direct-SQL test fixture
 *     might not).
 *
 * All three keyed by division_id and merged into one row per division in
 * JS afterwards — never a query inside a loop.
 */
export async function fetchPoolSummary(
  auth: Pick<AuthCtx, "orgId">,
  competitionId: string,
): Promise<PoolSummaryRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    const waitingRows = await tx<{ division_id: string; waiting: number }[]>`
      select r.division_id, count(*)::int as waiting
      from registrations r
      join divisions d on d.id = r.division_id
      where d.competition_id = ${competitionId} and d.archived_at is null
        and r.free_agent = true
        and r.status in ${tx([...SPOT_HOLDERS])}
        and not exists (
          select 1 from registration_players rp
          where rp.assigned_from_registration_id = r.id
        )
      group by r.division_id
      having count(*) > 0`;
    if (waitingRows.length === 0) return [];
    const divisionIds = waitingRows.map((w) => w.division_id);

    const slotRows = await tx<{ division_id: string; free_slots: number }[]>`
      select t.division_id,
        coalesce(sum(greatest(${rosterCapExpr(tx)} - t.roster_count, 0)), 0)::int as free_slots
      from (
        select r.division_id, r.id,
          (select count(*)::int from registration_players rp
             where rp.registration_id = r.id) as roster_count
        from registrations r
        where r.division_id in ${tx(divisionIds)}
          and r.free_agent = false
          and r.status not in ('withdrawn', 'rejected', 'expired', 'waitlisted')
      ) t
      join divisions d on d.id = t.division_id
      join sports sp on sp.key = d.sport_key
      group by t.division_id`;

    const meta = await tx<
      { division_id: string; division_name: string; place_by_at: Date | null; closes_at: Date | null }[]
    >`
      select d.id as division_id, d.name as division_name, rs.place_by_at, rs.closes_at
      from divisions d
      left join registration_settings rs on rs.division_id = d.id
      where d.id in ${tx(divisionIds)}`;

    const slotsByDivision = new Map(slotRows.map((s) => [s.division_id, s.free_slots]));
    const metaByDivision = new Map(meta.map((m) => [m.division_id, m]));
    return waitingRows.map((w) => {
      const m = metaByDivision.get(w.division_id);
      return {
        division_id: w.division_id,
        division_name: m?.division_name ?? "",
        waiting: w.waiting,
        free_slots: slotsByDivision.get(w.division_id) ?? 0,
        place_by_at: (m?.place_by_at ?? m?.closes_at)?.toISOString() ?? null,
      };
    });
  });
}

// ---------------------------------------------------------------------------
// The Registrants tab's row-expand detail (RS005 W2b).
// ---------------------------------------------------------------------------

/** `registration_players.consent_status` (V363 CHECK constraint) — declared
 *  locally rather than imported off `RegistrationPlayerRow` (registrations.ts),
 *  same convention `RegistrantEntrantKind` above already uses: this tab's own
 *  types stay self-contained rather than pulling in that row's full shape for
 *  one field. */
export type ConsentStatus = "pending" | "granted" | "guardian";

export interface RegistrantRosterPlayer {
  id: string;
  full_name: string;
  squad_number: number | null;
  is_captain: boolean;
  consent_status: ConsentStatus;
}

export interface RegistrantCartSibling {
  id: string;
  display_name: string;
  division_name: string;
  status: RegistrationListRow["status"];
}

export interface RegistrantDetails {
  rosterByRegistration: Map<string, RegistrantRosterPlayer[]>;
  /** SELF-INCLUSIVE — every entry is trivially a member of its own cart (a
   *  single-entry cart's own row appears here too, as a list of length 1).
   *  Callers building the "cart siblings" section filter their own row's id
   *  back out; this same map is also how `formFieldsByRegistration` below
   *  gets its data, without a third query — see fetchRegistrantDetails'
   *  own comment. */
  siblingsByGroup: Map<string, RegistrantCartSibling[]>;
  /** Keyed by REGISTRATION id (not division id) — read off the same joined
   *  query as siblingsByGroup, a LEFT JOIN to registration_settings on each
   *  returned entry's own division. */
  formFieldsByRegistration: Map<string, RegistrationFormField[]>;
}

interface RawPlayerRow {
  registration_id: string;
  id: string;
  full_name: string;
  squad_number: number | null;
  is_captain: boolean;
  consent_status: ConsentStatus;
}

interface RawSiblingRow {
  id: string;
  group_id: string;
  display_name: string;
  status: RegistrationListRow["status"];
  division_name: string;
  /** LEFT JOIN — null for a division with no registration_settings row at
   *  all (same "predates configuration" case listRegistrations' own doc
   *  comment describes; see also RawDivisionRow above). */
  form_fields: RegistrationFormField[] | null;
}

/**
 * The row-expand detail's data (task 3): the roster and cart siblings behind
 * every row on the CURRENT page, batched into exactly TWO queries regardless
 * of row count — never one query per row, which a 200-row competition-wide
 * hub view would turn into 200+ round trips:
 *
 *  1. registration_players WHERE registration_id IN (this page's row ids).
 *  2. registrations (JOIN divisions, LEFT JOIN registration_settings) WHERE
 *     group_id IN (this page's DISTINCT group ids).
 *
 * Query 2 is also where `form_fields` (the answers label lookup, task 2)
 * comes from, rather than a third query keyed by division: every page row's
 * OWN registration is necessarily a member of its OWN group (a cart always
 * contains itself), so query 2's result set already carries one row per
 * page-row with that row's own division's form_fields attached — reading it
 * back off the SAME rows used for the siblings section costs nothing extra.
 *
 * Both results are grouped into Maps in JS afterwards — one `.push` per
 * result row, never a query inside a loop. Skips both queries entirely when
 * `rows` is empty, so this stays correct standalone rather than relying on
 * the caller never passing one (the panel does not reach the table in that
 * case, but page.tsx calls this unconditionally rather than special-casing
 * "no rows" itself).
 */
export async function fetchRegistrantDetails(
  auth: Pick<AuthCtx, "orgId">,
  rows: Pick<RegistrationListRow, "id" | "group_id">[],
): Promise<RegistrantDetails> {
  const registrationIds = rows.map((r) => r.id);
  const groupIds = [...new Set(rows.map((r) => r.group_id))];
  if (registrationIds.length === 0) {
    return {
      rosterByRegistration: new Map(),
      siblingsByGroup: new Map(),
      formFieldsByRegistration: new Map(),
    };
  }

  return withTenant(auth.orgId, async (tx) => {
    const players = await tx<RawPlayerRow[]>`
      select registration_id, id, full_name, squad_number, is_captain, consent_status
      from registration_players
      where registration_id in ${tx(registrationIds)}
      order by is_captain desc, squad_number nulls last, full_name, id`;

    const rosterByRegistration = new Map<string, RegistrantRosterPlayer[]>();
    for (const p of players) {
      const list = rosterByRegistration.get(p.registration_id) ?? [];
      list.push({
        id: p.id,
        full_name: p.full_name,
        squad_number: p.squad_number,
        is_captain: p.is_captain,
        consent_status: p.consent_status,
      });
      rosterByRegistration.set(p.registration_id, list);
    }

    const siblingRows = await tx<RawSiblingRow[]>`
      select r.id, r.group_id, r.display_name, r.status, d.name as division_name,
        rs.form_fields
      from registrations r
      join divisions d on d.id = r.division_id
      left join registration_settings rs on rs.division_id = r.division_id
      where r.group_id in ${tx(groupIds)}
      order by r.created_at, r.id`;

    const siblingsByGroup = new Map<string, RegistrantCartSibling[]>();
    const formFieldsByRegistration = new Map<string, RegistrationFormField[]>();
    for (const s of siblingRows) {
      const list = siblingsByGroup.get(s.group_id) ?? [];
      list.push({
        id: s.id,
        display_name: s.display_name,
        division_name: s.division_name,
        status: s.status,
      });
      siblingsByGroup.set(s.group_id, list);
      formFieldsByRegistration.set(s.id, s.form_fields ?? []);
    }

    return { rosterByRegistration, siblingsByGroup, formFieldsByRegistration };
  });
}
