export const dynamic = "force-dynamic";
import { redirect } from "next/navigation";
import { requireOrgPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { TemplateGallery } from "@/components/v2/template-gallery";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
// Server Component only — see template-gallery.tsx's header for why the
// client island receives this as a prop rather than importing it itself.
import { TEMPLATE_CATALOG } from "@/server/templates/catalog";
import { sql } from "@/lib/db";
import { featurePlan } from "@/lib/feature-copy";
import { planLabel } from "@/lib/plan-label";
import {
  PUBLIC_DASHBOARD_FEATURE,
  type PublicDashboardUpgrade,
} from "@/lib/public-dashboard-upgrade";

/**
 * What the cheapest plan that lifts `dashboard.public.max` hosts, for the
 * degrade card both create paths render (V395 creates private over the cap
 * rather than refusing).
 *
 * Neither half is typed. WHICH plan comes from `featurePlan`, the same helper
 * `<UpgradeGate>`'s own CTA uses to decide between a priced Pro upgrade and a
 * Contact-us mailto, so the card cannot name one plan while the button offers
 * another. Its FIGURE comes from `plan_entitlements`, the table the resolver
 * enforces — `pro` is 10 and `community` 2 today (V395), and moving either one
 * moves this sentence with it.
 *
 * `int_value` is legitimately NULL on this column (it means unlimited), so a
 * missing row and an unlimited row must stay distinguishable: the absent case
 * is `undefined`, never `?? null`, or a DB read that failed at build would
 * advertise an uncapped plan. Both cases suppress the figure downstream.
 */
async function publicDashboardUpgrade(): Promise<PublicDashboardUpgrade> {
  const planKey = featurePlan(PUBLIC_DASHBOARD_FEATURE);
  const rows = await sql<{ int_value: number | null }[]>`
    select int_value from plan_entitlements
     where plan_key = ${planKey} and feature_key = ${PUBLIC_DASHBOARD_FEATURE}`;
  return { plan: planLabel(planKey), limit: rows[0]?.int_value };
}

export default async function NewCompetitionPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { canEdit } = await requireOrgPage(orgSlug);
  if (!canEdit) redirect(routes.orgHome(orgSlug));
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");
  // Fails soft: the create form must render even when the matrix read does
  // not, and `null` here suppresses only the upgrade figure.
  const upgrade = await publicDashboardUpgrade().catch(() => null);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8" data-tour="competition-wizard">
      <h1 className="mb-6 text-xl font-semibold tracking-tight text-slate-900">
        {t(dict, "comp.new.title")}
      </h1>
      <TemplateGallery
        orgSlug={orgSlug}
        templates={TEMPLATE_CATALOG}
        publicDashboardUpgrade={upgrade}
      />
    </main>
  );
}
