export const dynamic = "force-dynamic";
// Registration hub (RS004 W2 shell + W3 Settings-tab data + W3c config
// panel + RS005 W2a Registrants-tab data): route, two-tab chrome, guard,
// the Settings tab's division rows plus its row-click config panel context,
// and the Registrants tab's filtered row list.
//
// `?tab=settings|registrants` is read server-side, mirroring the division
// page's pattern (d/[divSlug]/page.tsx:77-118) — there is no shared TabStrip
// component and no client tabs component in this repo, so this inlines its
// own <nav> the same way that page does.
//
// RS005 W2b (row-click detail/actions on the Registrants tab) is next.
import type { ReactNode } from "react";
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
  fetchRegistrantRows,
  fetchDivisionOptions,
  fetchRegistrantDetails,
  registrantsExportHrefFor,
  type RegistrantsRawQuery,
} from "./data";

export default async function RegistrationHubPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; compSlug: string }>;
  searchParams: Promise<RegistrantsRawQuery & { tab?: string }>;
}) {
  const [{ orgSlug, compSlug }, rawSearchParams] = await Promise.all([params, searchParams]);
  const { tab: rawTab, ...registrantsRawQuery } = rawSearchParams;
  const page = await requireCompetitionPage(orgSlug, compSlug, { tail: "/registration" });
  const { auth, canEdit } = page;
  // requireCompetitionPage (page-auth.ts:192-201) only 404s a SCORER — that
  // is pre-existing, trusted behaviour, unrelated to this page. Everyone
  // else it admits (owner/admin/viewer) reaches this hub.
  //
  // RS005 owner ruling (2026-08-25) REVERSES RS004 ruling 2 ("owner/admin
  // only … scorer/viewer never see the nav entry"): a viewer now gets the
  // hub too, read-only. There used to be a `if (!canEdit) notFound();` line
  // right here — it is gone. `canEdit` no longer gates the PAGE; it is
  // threaded down as a prop so each panel can decide which of ITS OWN
  // controls are mutating, and keep those ABSENT for a viewer rather than
  // merely disabled — the write APIs 403 a viewer anyway (same as before
  // this reversal), so a disabled button would only advertise a refusal it
  // can never carry out.
  const id = page.competition.id;
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");
  const competition = await getCompetition(auth, id);
  const tab: RegistrationHubTab = resolveRegistrationHubTab(rawTab);

  // Registration windows are ORG-level (a registration window is not a
  // per-division venue setting) — organizations.timezone or DEFAULT_TZ,
  // deliberately never resolveVenueTz's division-override lane, and never
  // users.timezone/the browser cookie. Shared by BOTH tabs (the Settings
  // row's window column, the Registrants table's submitted-at column) —
  // pure and free to compute unconditionally, no query either way.
  const orgTz = isValidIana(page.org.timezone) ? page.org.timezone : DEFAULT_TZ;

  // Each branch below fetches ONLY what its own tab needs, lexically inside
  // the branch that needs it — not a top-level `tab === "x" ? await … : …`
  // ternary. That keeps the "no wasted read on the other tab" guarantee
  // structurally obvious (the fetch is simply not reachable code on the
  // other tab) and lets each panel's props be built non-nullable, without
  // the `settingsContext === null` correlation trick this page used to
  // lean on — that trick stopped working the moment a SECOND tab needed
  // its own context to branch on too.
  let panel: ReactNode;
  if (tab === "settings") {
    const rawRows = await fetchDivisionRows(auth, id);
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

    // Finding 4 (whole-branch review, RS004): org_stripe_unsupported_currency
    // is legitimately NULL for every org whose connected Stripe account is
    // fine — `rawRows[0]?.col ?? fallback()` treated that null exactly like
    // "rows is empty" and ran the fallback query on nearly every load. Gated
    // on rawRows.length instead: a real (possibly-null) column value from an
    // existing row is used as-is, and the fallback query runs only when
    // there is no row to read it off at all.
    const cardUnsupportedCurrency =
      rawRows.length === 0
        ? await fetchOrgCardUnsupportedCurrency(auth)
        : rawRows[0]!.org_stripe_unsupported_currency;
    const feePercentPct = await feePercentFor(auth.orgId, id);

    const settingsContext: Omit<RegistrationHubRowContext, "onOpen"> = {
      dict,
      now: new Date(),
      orgTz,
      // Finding 6: resolved independently of rawRows[0] rather than
      // defaulting to "usd" whenever there are no rows to read it off (a
      // competition with zero divisions) — see fetchOrgCurrency.
      currency: asCurrency(rawRows[0]?.org_currency ?? (await fetchOrgCurrency(auth))),
      registerHref: routes.publicRegister(orgSlug, compSlug),
      registerQrFileName: `register-${competition.slug}.png`,
      showRegisterLink: competition.visibility !== "private",
      // Same reversal as the Registrants tab: the page no longer 404s a
      // viewer, so the Settings tab has a read-only audience for the first
      // time and its Configure control has to know that.
      canEdit,
    };

    panel = (
      <RegistrationHubSettingsPanel
        title={t(dict, "reg.hub.settings.title")}
        body={t(dict, "reg.hub.settings.body")}
        rows={rows}
        context={settingsContext}
        orgSlug={orgSlug}
        feePercentPct={feePercentPct}
        cardUnsupportedCurrency={cardUnsupportedCurrency}
      />
    );
  } else {
    const registrants = await fetchRegistrantRows(auth, id, registrantsRawQuery);
    const divisions = await fetchDivisionOptions(auth, id);
    // RS005 W2b: the row-expand detail's roster/siblings/form_fields for
    // EVERY row on the page, batched into 2 queries total (task 3) —
    // fetched here, eagerly, rather than on click: the row is a plain
    // <details> with no onToggle/client fetch (task 1), so the content has
    // to already be in the initial HTML. fetchRegistrantDetails itself
    // short-circuits to empty maps at zero rows, so this is safe to call
    // unconditionally rather than special-casing the empty-panel branch.
    const details = await fetchRegistrantDetails(auth, registrants.rows);

    panel = (
      <RegistrationHubRegistrantsPanel
        rows={registrants.rows}
        filters={registrants.filters}
        divisions={divisions}
        canEdit={canEdit}
        dict={dict}
        orgTz={orgTz}
        filtersAction={routes.competitionRegistration(orgSlug, compSlug)}
        clearHref={routes.competitionRegistration(orgSlug, compSlug, "registrants")}
        // RS005 F3 finding 2: registrantsExportHrefFor (data.ts) wraps
        // registrantsExportHref so the negative-filter case (?free_agent=0
        // etc.) is carried too — see that function's own comment.
        exportHref={registrantsExportHrefFor(id, registrants.filters)}
        emptyTitle={t(dict, "reg.hub.registrants.title")}
        emptyBody={t(dict, "reg.hub.registrants.body")}
        emptyCtaLabel={t(dict, "reg.hub.registrants.cta")}
        emptyCtaHref={routes.competitionRegistration(orgSlug, compSlug, "settings")}
        details={details}
      />
    );
  }

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

      {panel}
    </main>
  );
}
