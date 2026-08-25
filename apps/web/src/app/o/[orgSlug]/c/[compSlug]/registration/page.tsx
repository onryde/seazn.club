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
import { isValidIana, DEFAULT_TZ } from "@/lib/tz";
import { asCurrency } from "@/lib/currency";
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
import {
  fetchDivisionRows,
  fetchOrgCardUnsupportedCurrency,
  fetchOrgCurrency,
} from "./data";

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
  // Finding 4 (whole-branch review): org_stripe_unsupported_currency is
  // legitimately NULL for every org whose connected Stripe account is fine —
  // `rawRows[0]?.col ?? fallback()` treated that null exactly like "rows is
  // empty" and ran the fallback query on nearly every Settings-tab load, the
  // opposite of "only when there are no rows". Gated on rawRows.length
  // instead: a real (possibly-null) column value from an existing row is
  // used as-is, and the fallback query runs only when there is no row to
  // read it off at all. The sibling `org_currency` read above does NOT share
  // this bug — that column is NOT NULL (RawDivisionRow types it `string`),
  // so `rawRows[0]?.org_currency` is only ever undefined when rawRows itself
  // is empty, which is exactly the case the fallback is for.
  const cardUnsupportedCurrency =
    tab === "settings"
      ? rawRows.length === 0
        ? await fetchOrgCardUnsupportedCurrency(auth)
        : rawRows[0]!.org_stripe_unsupported_currency
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
        />
      )}
    </main>
  );
}
