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
import { listSponsorRows } from "@/server/usecases/sponsors";
import { loadOnStreamScope } from "@/server/sponsors/on-stream";
import { listReportLinks, reportLinkDefaults, sponsorOverview } from "@/server/sponsors/report";
import { OrgSponsors } from "@/components/org-sponsors";
import { OnStreamTab } from "@/components/sponsors/on-stream-tab";
import { OverviewTab } from "@/components/sponsors/overview-tab";
import { SponsorPackages } from "@/components/sponsor-packages";
import { routes } from "@/lib/routes";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { resolveOnStreamScope, resolveSponsorsTab, sponsorsTabsFor } from "@/lib/sponsors-hub";
import { resolveSponsorPeriod } from "@/lib/sponsor-report";
import { HubPanel, SponsorsHubTabs } from "./_components/hub-chrome";

/** The org's competitions, newest first: the composer's and the package form's scope PICKER (not a scope - there is no
 *  one competition to thread on an org-level page). Same query, same cap, as Settings -> Sponsors had. */
async function orgCompetitions(orgId: string): Promise<{ id: string; name: string }[]> {
  return sql<{ id: string; name: string }[]>`
    select id, name from competitions
    where org_id = ${orgId}
    order by created_at desc limit 100`;
}

export default async function SponsorsHubPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ tab?: string; scope?: string | string[]; period?: string | string[] }>;
}) {
  const { orgSlug } = await params;
  const page = await requireOrgPage(orgSlug, { tail: "/sponsors" });
  const { org: active, canEdit } = page;
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");

  const { tab: rawTab, scope: rawScope, period: rawPeriod } = await searchParams;
  const tab = resolveSponsorsTab(rawTab, canEdit);

  // ORG-LEVEL, so `hasFeatureOnAnyPass` and not `hasFeature` - the Settings tab's own reasoning, unchanged: the
  // competition list is a PICKER, not this page's scope, so resolving org-wide is the honest question and an Event
  // Pass on one competition opens the UI without opening the org (usecases/sponsors.ts still resolves the
  // competition actually being written). These two flags are AFFORDANCES only.
  let body: React.ReactNode;
  if (tab === "sponsors") {
    const [sponsorRows, hasTiers, competitions] = await Promise.all([
      listSponsorRows(active.id),
      hasFeatureOnAnyPass(active.id, "sponsors.tiers"),
      orgCompetitions(active.id),
    ]);
    body = (
      <HubPanel tab="sponsors" icon={Handshake} dict={dict}>
        <OrgSponsors
          orgId={active.id}
          initialSponsors={sponsorRows}
          competitions={competitions}
          hasTiers={hasTiers}
          billingHref={routes.billing(orgSlug)}
          canEdit={canEdit}
        />
      </HubPanel>
    );
  } else if (tab === "packages") {
    const [hasMonetize, competitions] = await Promise.all([
      hasFeatureOnAnyPass(active.id, "sponsors.monetize"),
      orgCompetitions(active.id),
    ]);
    body = (
      <HubPanel tab="packages" icon={Banknote} dict={dict}>
        <SponsorPackages
          orgId={active.id}
          competitions={competitions}
          hasMonetize={hasMonetize}
          billingHref={routes.billing(orgSlug)}
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
