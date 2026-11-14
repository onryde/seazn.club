export const dynamic = "force-dynamic";
// Registration hub (RS004 W2 shell + W3 Settings-tab data + W3c config
// panel + RS005 W2a Registrants-tab data): route, guard, the Settings tab's
// division rows, and the Registrants tab's filtered row list.
//
// B7 T24 (spec 2026-11-13 §9): the address is the tab state —
// `?tab=settings|registrants|division:<id>&open=<a>,<b>` — read here with
// `parseHubTabs` against the divisions the viewer may open, and handed to
// `RegistrationHubTabsHost`, which draws the strip and keeps one settings page
// mounted per open division tab. The host sits at ONE place in this tree on
// every tab, so a tab switch (a soft navigation to this same page) keeps its
// state, and with it every unsaved edit; the section on screen rides in as its
// child. The settings of the (at most two) open divisions load on every tab.
import type { ReactNode } from "react";
import Link from "@/components/ui/console-link";
import { Download } from "lucide-react";
import { requireCompetitionPage } from "@/server/page-auth";
import { getCompetition } from "@/server/usecases/competitions";
import { feePercentFor } from "@/server/usecases/registrations";
import { routes, searchOf } from "@/lib/routes";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { isValidIana, DEFAULT_TZ } from "@/lib/tz";
import { asCurrency } from "@/lib/currency";
import { resolveRegistrationHubTab } from "@/components/registration-hub-tab";
import { parseHubTabs, type HubTabsState } from "@/components/registration-hub-tabs-state";
import {
  RegistrationHubTabsHost,
  type HubDivisionConfigContext,
  type OpenDivisionConfig,
  type OpenableDivision,
} from "@/components/registration-hub-tabs-host";
import { RegistrationHubSettingsPanel } from "@/components/registration-hub-settings-panel";
import { isChessSport } from "@/lib/chess-individual-only";
import {
  RegistrationHubRegistrantsPanel,
  registrantsTabIsBare,
  type PoolSummaryPanelRow,
} from "@/components/registration-hub-registrants-panel";
import type {
  RegistrationHubRowData,
  RegistrationHubRowContext,
} from "@/components/registration-hub-division-row";
import {
  fetchDivisionRows,
  fetchOrgCardUnsupportedCurrency,
  fetchOrgCurrency,
  fetchRegistrantRows,
  dropArchivedDivisionFilter,
  fetchDivisionOptions,
  fetchRegistrantDetails,
  fetchPoolSummary,
  registrantsExportHrefFor,
  openDivisionConfigOf,
  type RawDivisionRow,
  type RegistrantsRawQuery,
} from "./data";
import { cardDivisionsWaitOnConnect } from "@/lib/registration-card-payments";

export default async function RegistrationHubPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; compSlug: string }>;
  searchParams: Promise<RegistrantsRawQuery & { tab?: string | string[]; open?: string | string[] }>;
}) {
  const [{ orgSlug, compSlug }, rawSearchParams] = await Promise.all([params, searchParams]);
  const { tab: rawTab, open: rawOpen, ...registrantsRawQuery } = rawSearchParams;
  const page = await requireCompetitionPage(orgSlug, compSlug, { tail: "/registration", search: searchOf(rawSearchParams) });
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
  // Which section's data to read is known from `tab` alone: only Registrants has its own reads. Everything else — Settings,
  // or a division tab — reads the Settings rows, which are also the divisions a tab can open there.
  const tabParam = firstOf(rawTab);
  const onRegistrants = resolveRegistrationHubTab(tabParam) === "registrants";
  const openParam = firstOf(rawOpen);
  const parseTabs = (openable: readonly OpenableDivision[]): HubTabsState =>
    parseHubTabs({ tab: tabParam, open: openParam }, new Set(openable.map((d) => d.id)));

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
  let panel: ReactNode = null;
  // The tab strip's trailing slot (B6 T20, spec §8): Export CSV sits
  // right-aligned on the tabs row, only on the Registrants tab and only when
  // there is something to export.
  let tabsEnd: ReactNode = null;
  let tabs: HubTabsState;
  let openable: OpenableDivision[];
  let divisionRows: RawDivisionRow[] = [];
  let configContext: HubDivisionConfigContext | null = null;
  if (!onRegistrants) {
    const rawRows = await fetchDivisionRows(auth, id);
    divisionRows = rawRows;
    // Every non-archived division, the same set fetchDivisionOptions lists (both read `archived_at is null`), when the viewer
    // can edit; none for a viewer, who gets no division tab (T22).
    openable = canEdit ? rawRows.map((r) => ({ id: r.division_id, name: r.name })) : [];
    tabs = parseTabs(openable);
    const rows: RegistrationHubRowData[] = rawRows.map((r) => ({
      division_id: r.division_id,
      name: r.name,
      individual_only: isChessSport(r.sport_key),
      allowed_kinds: r.allowed_kinds,
      category: r.category,
      age_min: r.age_min,
      age_max: r.age_max,
      age_cutoff_month: r.age_cutoff_month,
      age_cutoff_day: r.age_cutoff_day,
      eligibility_note: r.eligibility_note,
      enabled: r.enabled,
      entrant_kind: r.entrant_kind,
      opens_at: r.opens_at,
      closes_at: r.closes_at,
      capacity: r.capacity,
      fee_cents: r.fee_cents,
      approval: r.approval,
      allow_free_agents: r.allow_free_agents,
      taken: r.taken,
      waitlisted: r.waitlisted,
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
    const currency = asCurrency(rawRows[0]?.org_currency ?? (await fetchOrgCurrency(auth)));
    configContext = { orgTz, orgSlug, currency, feePercentPct, cardUnsupportedCurrency };

    const settingsContext: Omit<RegistrationHubRowContext, "onOpen"> = {
      dict,
      now: new Date(),
      orgTz,
      // Finding 6: resolved independently of rawRows[0] rather than
      // defaulting to "usd" whenever there are no rows to read it off (a
      // competition with zero divisions) — see fetchOrgCurrency.
      currency,
      registerHref: routes.publicRegister(orgSlug, compSlug),
      registerQrFileName: `register-${competition.slug}.png`,
      showRegisterLink: competition.visibility !== "private",
      // Same reversal as the Registrants tab: the page no longer 404s a
      // viewer, so the Settings tab has a read-only audience for the first
      // time and its Configure control has to know that.
      canEdit,
    };

    // A division tab on screen shows that division's settings page, which the host draws: no section panel under it.
    if (tabs.active === "settings") {
      // Walk-fix F5: a card division the public cannot enter (Connect cannot charge) reads "Open now" on its row, so the tab says
      // so above the rows, with the way to fix it. The org's charge state rides on every row (zero rows: nothing to warn about).
      const waitsOnConnect = cardDivisionsWaitOnConnect(rawRows, rawRows[0]?.org_charges_enabled ?? true);
      const settingsPanel = (
        <RegistrationHubSettingsPanel
          title={t(dict, "reg.hub.settings.title")}
          body={t(dict, "reg.hub.settings.body")}
          rows={rows}
          context={settingsContext}
        />
      );
      panel = waitsOnConnect ? (
        <div className="flex flex-col gap-3">
          <div
            role="status"
            data-testid="reg-hub-card-payments"
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            <p className="m-0 min-w-0 flex-1 basis-64">{t(dict, "reg.hub.cardPayments.banner")}</p>
            <Link href={routes.connect(orgSlug)} className="shrink-0 font-semibold underline underline-offset-2 hover:text-amber-950">
              {t(dict, "reg.hub.cardPayments.cta")}
            </Link>
          </div>
          {settingsPanel}
        </div>
      ) : (
        settingsPanel
      );
    }
  } else {
    // RS012 `/code-review high` finding 6: fetchDivisionOptions and
    // fetchPoolSummary depend only on auth/id, not on fetchRegistrantRows'
    // own result — run all three concurrently rather than making the other
    // two wait their turn behind it. Only fetchRegistrantDetails genuinely
    // needs registrants.rows, so it stays a sequential await AFTER this.
    //
    // B7 T24: with division tabs in the address (an editor's), their settings pages need the Settings rows and the fee cut
    // too — read alongside, and only then, so a plain Registrants load reads exactly what it always did.
    const wantsConfigs = canEdit && openParam !== undefined && openParam !== "";
    const [firstRead, divisions, poolSummaryRows, configRows, feePercentPct] = await Promise.all([
      fetchRegistrantRows(auth, id, registrantsRawQuery),
      fetchDivisionOptions(auth, id),
      fetchPoolSummary(auth, id),
      wantsConfigs ? fetchDivisionRows(auth, id) : null,
      wantsConfigs ? feePercentFor(auth.orgId, id) : null,
    ]);
    openable = canEdit ? divisions.map((d) => ({ id: d.id, name: d.name })) : [];
    tabs = parseTabs(openable);
    if (configRows !== null && feePercentPct !== null && tabs.open.length > 0) {
      divisionRows = configRows;
      // A division tab is open, so its row exists (the two reads list the same divisions): the org values ride on it.
      const first = configRows[0]!;
      configContext = {
        orgTz,
        orgSlug,
        currency: asCurrency(first.org_currency),
        feePercentPct,
        cardUnsupportedCurrency: first.org_stripe_unsupported_currency,
      };
    }
    // B6 T21 review: a `?division_id=` naming an ARCHIVED division is ignored (the
    // dropdown cannot show it, so it must not narrow the table) — see the function.
    const registrants = await dropArchivedDivisionFilter(auth, id, registrantsRawQuery, firstRead, divisions);
    // Filters are not tabs (B7 T22): every link this tab writes keeps the open ones.
    const openTabs = tabs.open;
    // RS005 W2b: the row-expand detail's roster/siblings/form_fields for
    // EVERY row on the page, batched into 2 queries total (task 3) —
    // fetched here, eagerly, rather than on click: the row is a plain
    // <details> with no onToggle/client fetch (task 1), so the content has
    // to already be in the initial HTML. fetchRegistrantDetails itself
    // short-circuits to empty maps at zero rows, so this is safe to call
    // unconditionally rather than special-casing the empty-panel branch.
    const details = await fetchRegistrantDetails(auth, registrants.rows);
    // RS012 scope item 4: every division that currently has someone waiting
    // in the solo sign-up pool, plus its own href into the pre-filtered
    // table (division + free_agent checked) — built here, the same
    // convention every other href on this panel already follows (its own
    // header comment: "this component never imports routes itself").
    const poolSummary: PoolSummaryPanelRow[] = poolSummaryRows.map((row) => ({
      ...row,
      href: `${routes.competitionRegistration(orgSlug, compSlug, "registrants", row.division_id, openTabs)}&free_agent=1`,
    }));

    // Same predicate the panel uses for its own bare empty state — nothing to
    // export where the panel itself shows "no one's registered yet". A plain
    // href, not a client fetch (documents-menu.tsx's convention for every
    // export button); read-scope only (the route's own requireResourceAuth
    // "read"), so it renders for a viewer too (owner ruling).
    if (!registrantsTabIsBare(registrants.rows.length, registrants.filters)) {
      tabsEnd = (
        <a
          href={registrantsExportHrefFor(id, registrants.filters)}
          className="btn btn-ghost h-11 gap-2 text-sm max-md:ml-auto md:mb-1 md:h-10"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          {t(dict, "reg.exportCsv")}
        </a>
      );
    }

    panel = (
      <RegistrationHubRegistrantsPanel
        rows={registrants.rows}
        filters={registrants.filters}
        divisions={divisions}
        canEdit={canEdit}
        dict={dict}
        locale={locale}
        orgTz={orgTz}
        filtersAction={routes.competitionRegistration(orgSlug, compSlug)}
        clearHref={routes.competitionRegistration(orgSlug, compSlug, "registrants", undefined, openTabs)}
        emptyTitle={t(dict, "reg.hub.registrants.title")}
        emptyBody={t(dict, "reg.hub.registrants.body")}
        emptyCtaLabel={t(dict, "reg.hub.registrants.cta")}
        emptyCtaHref={routes.competitionRegistration(orgSlug, compSlug, "settings", undefined, openTabs)}
        details={details}
        poolSummary={poolSummary}
        orgSlug={orgSlug}
        compSlug={compSlug}
      />
    );
  }

  // The open tabs' settings pages, in the address's order. Each one is in the rows read above: `parseHubTabs` keeps only
  // openable ids, and openable IS those rows (Settings) or the same set by another read (Registrants).
  const openDivisions: OpenDivisionConfig[] = tabs.open.map((divisionId) => {
    const row = divisionRows.find((r) => r.division_id === divisionId);
    if (!row) throw new Error(`registration hub: open division ${divisionId} has no Settings row to load its page from`);
    return openDivisionConfigOf(row);
  });

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="page-title mb-6">{t(dict, "reg.hub.title", { name: competition.name })}</h1>

      <RegistrationHubTabsHost
        state={tabs}
        divisions={openDivisions}
        openable={openable}
        config={configContext}
        orgSlug={orgSlug}
        compSlug={compSlug}
        stripEnd={tabsEnd}
      >
        {panel}
      </RegistrationHubTabsHost>
    </main>
  );
}

/** A repeated param (`?tab=a&tab=b`, which Next hands over as an array) reads as its FIRST value — the house rule. */
function firstOf(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
