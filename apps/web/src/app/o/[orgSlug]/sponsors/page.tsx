export const dynamic = "force-dynamic";
// The Sponsors hub (R4 sponsors-on-stream S11; spec 2026-10-27 §5.1): a top-level console page, `?tab=` one of
// `SPONSORS_TABS` (lib/sponsors-hub.ts). It replaces Settings -> Sponsors, whose two bodies moved here UNCHANGED:
//
//   Sponsors            <OrgSponsors>      (was Settings -> Sponsors, the list and the form)
//   Packages and orders <SponsorPackages>  (was the block under it, editors only)
//   Overview, On stream placeholders - S13 and S12 drop their bodies in; nothing here claims a feature yet.
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
import { OrgSponsors } from "@/components/org-sponsors";
import { SponsorPackages } from "@/components/sponsor-packages";
import { routes } from "@/lib/routes";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { resolveSponsorsTab, sponsorsTabsFor } from "@/lib/sponsors-hub";
import { HubPanel, SponsorsHubTabs, tabLabel } from "./_components/hub-chrome";

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
  searchParams: Promise<{ tab?: string }>;
}) {
  const { orgSlug } = await params;
  const page = await requireOrgPage(orgSlug, { tail: "/sponsors" });
  const { org: active, canEdit } = page;
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");

  const { tab: rawTab } = await searchParams;
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
      <HubPanel tab="sponsors" icon={Handshake} title={t(dict, "sponsors.title")}>
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
      <HubPanel tab="packages" icon={Banknote} title={t(dict, "sponsors.sell.title")}>
        <SponsorPackages
          orgId={active.id}
          competitions={competitions}
          hasMonetize={hasMonetize}
          billingHref={routes.billing(orgSlug)}
        />
      </HubPanel>
    );
  } else if (tab === "on_stream") {
    body = <HubPanel tab="on_stream" icon={Radio} title={tabLabel(dict, "on_stream")} />;
  } else {
    body = <HubPanel tab="overview" icon={LayoutGrid} title={tabLabel(dict, "overview")} />;
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-4 md:py-8">
      <h1 className="page-title mb-4 min-w-0 md:mb-6">{t(dict, "sponsors.title")}</h1>
      <SponsorsHubTabs orgSlug={orgSlug} tabs={sponsorsTabsFor(canEdit)} active={tab} dict={dict} />
      {body}
    </main>
  );
}
