export const dynamic = "force-dynamic";
// The Sponsors hub (R4 sponsors-on-stream S11; spec 2026-10-27 §5.1): a top-level console page, `?tab=` one of
// `SPONSORS_TABS` (lib/sponsors-hub.ts). It replaces Settings -> Sponsors, whose two bodies moved here UNCHANGED:
//
//   Sponsors            <OrgSponsors>      (was Settings -> Sponsors, the list and the form)
//   Packages and orders <SponsorPackages>  (was the block under it, editors only)
//   On stream          <OnStreamTab>       (S12: the rotation's switch and dial, the tick list, a preview per sport; editors only)
//   Overview            <OverviewTab>      (S13: per-sponsor times shown, on screen, viewers, link clicks for a period; Share
//                                           report links for editors)
//
// Role: the existing Settings guard, reused (R19). Settings never refused a non-editor - it rendered a READ-ONLY view
// (`OrgSponsors canEdit={false}`, no packages) - so the hub does not either: every member reaches Overview and
// Sponsors, and the tabs that only an editor can use are neither offered nor reachable by URL (they fall back to
// Overview, `resolveSponsorsTab`). The write routes keep their own guards.
//
// Data is loaded per tab, as Settings did: a tab that shows no sponsors reads no sponsors.
import { Banknote, Handshake, LayoutGrid, Radio } from "lucide-react";
import { requireOrgPage } from "@/server/page-auth";
import { sql } from "@/lib/db";
import { hasFeatureOnAnyPass } from "@/lib/entitlements";
import { listSponsorPackages, listSponsorRows } from "@/server/usecases/sponsors";
import { finishedPackageCompetitions, listDeals } from "@/server/usecases/sponsor-deals";
import { loadOnStreamScope } from "@/server/sponsors/on-stream";
import { listReportLinks, reportLinkDefaults, sponsorOverview } from "@/server/sponsors/report";
import { OrgSponsors } from "@/components/org-sponsors";
import { OnStreamTab } from "@/components/sponsors/on-stream-tab";
import { OverviewTab } from "@/components/sponsors/overview-tab";
import { SponsorPackages } from "@/components/sponsor-packages";
import { routes } from "@/lib/routes";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import {
  resolveDealParam,
  resolveOnStreamScope,
  resolveSponsorParam,
  resolveSponsorsTab,
  sponsorsHref,
  sponsorsTabsFor,
} from "@/lib/sponsors-hub";
import { resolveSponsorPeriod } from "@/lib/sponsor-report";
import { HubPanel, SponsorsHubTabs } from "./_components/hub-chrome";

/** The org's competitions, newest first: the composer's and the package form's scope PICKER (not a scope - there is no
 *  one competition to thread on an org-level page). Same query, same cap, as Settings -> Sponsors had. `ends_on` (text, so a
 *  date column never reaches the client as a Date) is the deal timeline's "ends with the competition" hint, nothing more: a
 *  deal ends on the competition's derived phase, not on this date. */
async function orgCompetitions(orgId: string): Promise<{ id: string; name: string; ends_on: string | null }[]> {
  return sql<{ id: string; name: string; ends_on: string | null }[]>`
    select id, name, ends_on::text as ends_on from competitions
    where org_id = ${orgId}
    order by created_at desc limit 100`;
}

/** Can the org take card charges? The Add deal sheet offers Send invoice only if it can. The server's `checkoutOrg`
 *  (usecases/sponsor-deals.ts) refuses a deal's Checkout with 409 `connect_required` unless the org has a connected Stripe
 *  account AND that account takes charges, so this asks for both: the flag alone would offer Send invoice to an org whose
 *  Checkout the server refuses (review M4). An org the read cannot find is not charge-ready. */
async function orgChargesEnabled(orgId: string): Promise<boolean> {
  const [org] = await sql<{ stripe_account_id: string | null; stripe_charges_enabled: boolean }[]>`
    select stripe_account_id, stripe_charges_enabled from organizations where id = ${orgId}`;
  return Boolean(org?.stripe_account_id) && org?.stripe_charges_enabled === true;
}

export default async function SponsorsHubPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{
    tab?: string;
    scope?: string | string[];
    period?: string | string[];
    sponsor?: string | string[];
    deal?: string | string[];
  }>;
}) {
  const { orgSlug } = await params;
  const page = await requireOrgPage(orgSlug, { tail: "/sponsors" });
  const { org: active, canEdit } = page;
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");

  const { tab: rawTab, scope: rawScope, period: rawPeriod, sponsor: rawSponsor, deal: rawDeal } = await searchParams;
  const tab = resolveSponsorsTab(rawTab, canEdit);

  // ORG-LEVEL, so `hasFeatureOnAnyPass` and not `hasFeature` - the Settings tab's own reasoning, unchanged: the
  // competition list is a PICKER, not this page's scope, so resolving org-wide is the honest question and an Event
  // Pass on one competition opens the UI without opening the org (usecases/sponsors.ts still resolves the
  // competition actually being written). These two flags are AFFORDANCES only.
  let body: React.ReactNode;
  if (tab === "sponsors") {
    // The sponsor and deal screens read more than the list (sponsor deals PR 2, Task 13): the org's deals and packages, both plan
    // flags (affordances, org-wide like the rest of this page), whether Stripe takes charges, and each competition's end date.
    const [sponsorRows, deals, packages, hasTiers, hasMonetize, chargesEnabled, competitions] = await Promise.all([
      listSponsorRows(active.id),
      listDeals(page.auth),
      listSponsorPackages(page.auth),
      hasFeatureOnAnyPass(active.id, "sponsors.tiers"),
      hasFeatureOnAnyPass(active.id, "sponsors.monetize"),
      orgChargesEnabled(active.id),
      orgCompetitions(active.id),
    ]);
    // `?sponsor=` / `?deal=` are selections only if they are THIS org's: the sponsor from the rows just read, the deal from the
    // selected sponsor's own deals. Anything else is the list again - never a 404, never a crash.
    const sponsorId = resolveSponsorParam(rawSponsor, sponsorRows);
    const dealId = sponsorId === null ? null : resolveDealParam(rawDeal, deals.filter((d) => d.sponsor_id === sponsorId));
    // The sponsor page's Report link section: the selected sponsor's live links. The read is an editor's (it refuses a viewer).
    // Its opening dates are this year's (`resolveSponsorPeriod` with no `?period=` - the Overview's landing window). Read with the
    // links, for an editor's page only: a viewer's sponsor page has no such section.
    const reportLinks =
      sponsorId !== null && canEdit
        ? (await listReportLinks(page.auth, active.id)).filter((l) => l.sponsorId === sponsorId)
        : [];
    const reportDefaults =
      sponsorId !== null && canEdit
        ? await reportLinkDefaults(page.auth, active.id, resolveSponsorPeriod(undefined, competitions), new Date())
        : null;
    body = (
      <HubPanel tab="sponsors" icon={Handshake} dict={dict}>
        <OrgSponsors
          orgId={active.id}
          initialSponsors={sponsorRows}
          competitions={competitions}
          hasTiers={hasTiers}
          billingHref={routes.billing(orgSlug)}
          canEdit={canEdit}
          hub={{ orgSlug, deals, packages, hasMonetize, chargesEnabled, sponsorId, dealId, reportLinks, reportDefaults }}
        />
      </HubPanel>
    );
  } else if (tab === "packages") {
    // The invoice form picks one of the org's sponsors (sponsor deals T12): only the picker's three fields cross to the client.
    // A plan without the feature sees the upsell and no form, so it reads no sponsors (the page loads only what its tab shows).
    // A package whose competition has finished offers no Send invoice (batch F review m4; the create refuses it anyway).
    const hasMonetize = await hasFeatureOnAnyPass(active.id, "sponsors.monetize");
    const [competitions, sponsorRows, finishedCompetitionIds] = await Promise.all([
      orgCompetitions(active.id),
      hasMonetize ? listSponsorRows(active.id) : Promise.resolve([]),
      hasMonetize ? finishedPackageCompetitions(active.id) : Promise.resolve([]),
    ]);
    body = (
      <HubPanel tab="packages" icon={Banknote} dict={dict}>
        <SponsorPackages
          orgId={active.id}
          competitions={competitions}
          sponsors={sponsorRows.map((s) => ({ id: s.id, name: s.name, display_order: s.display_order }))}
          hasMonetize={hasMonetize}
          billingHref={routes.billing(orgSlug)}
          sponsorsHref={sponsorsHref(orgSlug, "sponsors")}
          finishedCompetitionIds={finishedCompetitionIds}
        />
      </HubPanel>
    );
  } else if (tab === "on_stream") {
    // Editors only (R19): `resolveSponsorsTab` already sent anyone else to Overview, so nothing below runs for them. The
    // scope is the picker's choice, kept only if it is one of THIS org's competitions; the loader is never asked about
    // another id. Tiers are the org-level question for the same reason as on the Sponsors tab.
    const [sponsorRows, hasTiers, competitions] = await Promise.all([
      listSponsorRows(active.id),
      hasFeatureOnAnyPass(active.id, "sponsors.tiers"),
      orgCompetitions(active.id),
    ]);
    const scope = resolveOnStreamScope(rawScope, competitions);
    const data = await loadOnStreamScope(active.id, scope);
    body = (
      <HubPanel tab="on_stream" icon={Radio} dict={dict}>
        <OnStreamTab
          orgId={active.id}
          orgSlug={orgSlug}
          sponsors={sponsorRows.map((s) => ({
            id: s.id,
            name: s.name,
            tier: s.tier,
            status: s.status,
            competition_id: s.competition_id,
            on_stream: s.on_stream,
            // F24: this map names the tab's fields one by one, so a field left out never reaches the tick.
            locked_by_deal: s.locked_by_deal,
          }))}
          competitions={competitions}
          scope={scope}
          hasTiers={hasTiers}
          settings={data.settings}
          ownRow={data.ownRow}
          sports={data.sports}
        />
      </HubPanel>
    );
  } else {
    // Overview (S13): every member reads the numbers (R19 - read-only for a viewer, never refused); only an editor's page loads
    // the report links and the share form's opening dates. The period is kept only if it names a period or one of THIS org's
    // competitions. `now` is read ONCE and handed to every reader and to the island, so the counts, the link defaults and the
    // caption all name the same window.
    const competitions = await orgCompetitions(active.id);
    const period = resolveSponsorPeriod(rawPeriod, competitions);
    const now = new Date();
    const [rows, links, shareDefaults] = await Promise.all([
      sponsorOverview(page.auth, active.id, period, now),
      canEdit ? listReportLinks(page.auth, active.id) : Promise.resolve([]),
      canEdit ? reportLinkDefaults(page.auth, active.id, period, now) : Promise.resolve(null),
    ]);
    body = (
      <HubPanel tab="overview" icon={LayoutGrid} dict={dict}>
        <OverviewTab
          orgId={active.id}
          orgSlug={orgSlug}
          period={period}
          nowIso={now.toISOString()}
          competitions={competitions}
          rows={rows}
          canEdit={canEdit}
          links={links}
          shareDefaults={shareDefaults}
        />
      </HubPanel>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-4 md:py-8">
      <h1 className="page-title mb-4 min-w-0 md:mb-6">{t(dict, "sponsors.title")}</h1>
      <SponsorsHubTabs orgSlug={orgSlug} tabs={sponsorsTabsFor(canEdit)} active={tab} dict={dict} />
      {body}
    </main>
  );
}
