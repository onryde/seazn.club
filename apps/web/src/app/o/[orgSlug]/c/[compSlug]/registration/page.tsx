export const dynamic = "force-dynamic";
// Registration hub (RS004 W2 shell + W3 Settings-tab data + W3c config
// panel): route, two-tab chrome, guard, and the Settings tab's division
// rows plus the context its row-click config panel needs.
//
// `?tab=settings|registrants` is read server-side, mirroring the division
// page's pattern (d/[divSlug]/page.tsx:77-118) — there is no shared TabStrip
// component and no client tabs component in this repo, so this inlines its
// own <nav> the same way that page does.
//
// Registrants' real content is RS005. See docs/superpowers/specs/2026-08-16-
// registration-redesign-prompts/{RS004-hub-settings-tab.md,RS005-hub-registrants-tab.md}.
import { notFound } from "next/navigation";
import Link from "@/components/ui/console-link";
import { requireCompetitionPage } from "@/server/page-auth";
import { getCompetition } from "@/server/usecases/competitions";
import { feePercentFor } from "@/server/usecases/registrations";
import { routes } from "@/lib/routes";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { withTenant } from "@/lib/db";
import { isValidIana, DEFAULT_TZ } from "@/lib/tz";
import { asCurrency } from "@/lib/currency";
import { SPOT_HOLDERS } from "@/lib/registration-status";
import type { AuthCtx } from "@/server/api-v1/auth";
import {
  REGISTRATION_HUB_TABS,
  resolveRegistrationHubTab,
  type RegistrationHubTab,
} from "@/components/registration-hub-tab";
import { RegistrationHubSettingsPanel } from "@/components/registration-hub-settings-panel";
import { RegistrationHubRegistrantsPanel } from "@/components/registration-hub-registrants-panel";
import type {
  RegistrationHubRowData,
  RegistrationHubRowContext,
} from "@/components/registration-hub-division-row";

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
 *  Only called from that empty-rows branch below; the common case (rows
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
 *  (non-archived) divisions has none to read it off. Only called from that
 *  empty-rows branch below — the common case reads it off `rawRows[0]` at
 *  zero extra queries, same as org_currency. */
export async function fetchOrgCardUnsupportedCurrency(
  auth: Pick<AuthCtx, "orgId">,
): Promise<string | null> {
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<{ stripe_unsupported_currency: string | null }[]>`
      select stripe_unsupported_currency from organizations where id = ${auth.orgId}`;
    return row?.stripe_unsupported_currency ?? null;
  });
}

export default async function RegistrationHubPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; compSlug: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ orgSlug, compSlug }, { tab: rawTab }] = await Promise.all([params, searchParams]);
  const page = await requireCompetitionPage(orgSlug, compSlug, { tail: "/registration" });
  const { auth, canEdit } = page;
  // requireCompetitionPage (page-auth.ts:192-201) only 404s a SCORER — a
  // viewer reaches it fine with canEdit:false. Registration data (contacts,
  // payment state) is more sensitive than the read-only competition-settings
  // page a viewer may already open, so this hub is owner/admin only, matching
  // the RS004 prompt's scope item 1 ("Owner/admin only … scorer/viewer never
  // see the nav entry") — the extra role check is this page's own.
  if (!canEdit) notFound();
  const id = page.competition.id;
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");
  const competition = await getCompetition(auth, id);
  const tab: RegistrationHubTab = resolveRegistrationHubTab(rawTab);

  // Gated to the Settings tab: Registrants has nothing to do with these rows,
  // and fetching them there would be a wasted read on every tab switch.
  const rawRows = tab === "settings" ? await fetchDivisionRows(auth, id) : [];
  const rows: RegistrationHubRowData[] = rawRows.map((r) => ({
    division_id: r.division_id,
    name: r.name,
    category: r.category,
    age_min: r.age_min,
    age_max: r.age_max,
    enabled: r.enabled,
    entrant_kind: r.entrant_kind,
    opens_at: r.opens_at,
    closes_at: r.closes_at,
    capacity: r.capacity,
    fee_cents: r.fee_cents,
    approval: r.approval,
    allow_free_agents: r.allow_free_agents,
    taken: r.taken,
  }));

  // Registration windows are ORG-level (a registration window is not a
  // per-division venue setting) — organizations.timezone or DEFAULT_TZ,
  // deliberately never resolveVenueTz's division-override lane, and never
  // users.timezone/the browser cookie.
  const orgTz = isValidIana(page.org.timezone) ? page.org.timezone : DEFAULT_TZ;
  // Finding 6: resolved independently of rawRows[0] rather than defaulting
  // to "usd" whenever there are no rows to read it off (Registrants tab, or
  // a Settings-tab competition with zero divisions) — see fetchOrgCurrency.
  const orgCurrency =
    rawRows[0]?.org_currency ?? (tab === "settings" ? await fetchOrgCurrency(auth) : "usd");
  // Same finding-6 shape for the config panel's card-unsupported message —
  // see fetchOrgCardUnsupportedCurrency. null (never gated) on the
  // Registrants tab, which never mounts the config panel that reads this.
  const cardUnsupportedCurrency =
    rawRows[0]?.org_stripe_unsupported_currency ??
    (tab === "settings" ? await fetchOrgCardUnsupportedCurrency(auth) : null);
  // The config panel's platform-cut copy (owner decision 3) — gated the
  // same way as the row query, since only the Settings tab ever mounts it.
  const feePercentPct = tab === "settings" ? await feePercentFor(auth.orgId, id) : 0;
  const registrationContext: Omit<RegistrationHubRowContext, "onOpen"> = {
    dict,
    now: new Date(),
    orgTz,
    currency: asCurrency(orgCurrency),
    registerHref: routes.publicRegister(orgSlug, compSlug),
    registerQrFileName: `register-${competition.slug}.png`,
    showRegisterLink: competition.visibility !== "private",
  };

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="page-title mb-6">{t(dict, "reg.hub.title", { name: competition.name })}</h1>

      <nav className="scroll-x scroll-x-fade mb-6 flex gap-1 whitespace-nowrap border-b border-slate-200">
        {REGISTRATION_HUB_TABS.map((tabKey) => (
          <Link
            key={tabKey}
            href={routes.competitionRegistration(orgSlug, compSlug, tabKey)}
            className={`border-b-2 px-4 py-2 text-sm font-medium transition ${
              tab === tabKey
                ? "border-purple-600 text-purple-700"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {t(dict, `reg.hub.tab.${tabKey}`)}
          </Link>
        ))}
      </nav>

      {tab === "registrants" ? (
        <RegistrationHubRegistrantsPanel
          title={t(dict, "reg.hub.registrants.title")}
          body={t(dict, "reg.hub.registrants.body")}
          ctaLabel={t(dict, "reg.hub.registrants.cta")}
          ctaHref={routes.competitionRegistration(orgSlug, compSlug, "settings")}
        />
      ) : (
        <RegistrationHubSettingsPanel
          title={t(dict, "reg.hub.settings.title")}
          body={t(dict, "reg.hub.settings.body")}
          rows={rows}
          context={registrationContext}
          orgSlug={orgSlug}
          feePercentPct={feePercentPct}
          cardUnsupportedCurrency={cardUnsupportedCurrency}
        />
      )}
    </main>
  );
}
