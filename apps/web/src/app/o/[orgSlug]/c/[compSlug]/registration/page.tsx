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
// TEMP(RS004 variants) — sign-off scaffold for the division-row/config-
// panel taste round: the owner has not yet approved a look, so `?variant=`
// picks which of three presentation-only directions renders (see
// registration-hub-variant.ts's header for the full explanation and what
// to delete once a direction is picked).
import { resolveRegistrationHubVariant, type RegistrationHubVariant } from "@/components/registration-hub-variant";
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
  // TEMP(RS004 variants): `variant` added alongside `tab` — see the import
  // above. Remove this key once the owner picks a direction.
  searchParams: Promise<{ tab?: string; variant?: string }>;
}) {
  const [{ orgSlug, compSlug }, { tab: rawTab, variant: rawVariant }] = await Promise.all([params, searchParams]);
  // TEMP(RS004 variants): resolved alongside `tab` via the identical
  // whitelist-with-fallback pattern. Only the Settings tab's row/panel
  // components read this (see settingsContext below) — it has no effect on
  // the Registrants tab, which has no row/panel of its own yet (RS005).
  const variant: RegistrationHubVariant = resolveRegistrationHubVariant(rawVariant);
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
  //
  // Both org-level fallbacks below, and the context that carries them, are
  // built ONLY for the Settings tab.
  //
  // The gap-pass review flagged the previous shape — `tab === "settings" ? …
  // : "usd"` — because the Registrants tab's rows list is ALWAYS empty, so it
  // took the hardcoded default every time. Resolving the real values there
  // instead would have been worse in a different way: it costs two queries to
  // compute what that tab renders nothing from, and the suite already pins
  // "the Registrants tab runs no division query — no wasted read".
  //
  // So neither fabricate nor fetch: on the Registrants tab there is no context
  // at all, and `undefined` cannot be mistaken for "usd" or for "this org's
  // card payments are fine". RS005 builds its own context when it has
  // something that actually reads one.
  const settingsContext: Omit<RegistrationHubRowContext, "onOpen"> | null =
    tab === "settings"
      ? {
          dict,
          now: new Date(),
          orgTz,
          currency: asCurrency(rawRows[0]?.org_currency ?? (await fetchOrgCurrency(auth))),
          registerHref: routes.publicRegister(orgSlug, compSlug),
          registerQrFileName: `register-${competition.slug}.png`,
          showRegisterLink: competition.visibility !== "private",
        }
      : null;
  const cardUnsupportedCurrency =
    tab === "settings"
      ? (rawRows[0]?.org_stripe_unsupported_currency ??
        (await fetchOrgCardUnsupportedCurrency(auth)))
      : null;
  const feePercentPct = tab === "settings" ? await feePercentFor(auth.orgId, id) : 0;

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

      {/* Branch on the CONTEXT, not on `tab`: the context is null exactly
          when the tab is "registrants", and narrowing on it is what lets the
          settings panel take a non-nullable prop without an assertion. */}
      {settingsContext === null ? (
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
          context={settingsContext}
          orgSlug={orgSlug}
          feePercentPct={feePercentPct}
          cardUnsupportedCurrency={cardUnsupportedCurrency}
          variant={variant} // TEMP(RS004 variants)
        />
      )}
    </main>
  );
}
