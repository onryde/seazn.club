export const dynamic = "force-dynamic";
// AI Credits — its own Settings tab (SPEC-6 §A3, moved off the billing page).
// The AI-credit wallet is the ORG's, not the payer's: an org owner inside a
// billing group they don't pay for must still see the pool they spend from, so
// this page is member-visible and NOT payer-gated. The credit-pack purchase +
// CSV export it mounts are session-authed inside their own handlers.
import { requireBillingPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { BillingCredits } from "@/components/billing-credits";
import { getCreditsTab } from "@/server/usecases/credits-tab";
import { creditPackOptions } from "@/lib/currency";
import { preferredCurrency } from "@/lib/currency-server";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { SettingsShell, navContext } from "../_components/settings-nav";

export default async function CreditsSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { org, viaPayer } = await requireBillingPage(orgSlug, { tail: "/settings/credits" });
  const orgId = org.id;
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");
  // The rail's plan + credit-balance header. Skipped for a payer who is not a
  // member: they get no rail at all (see SettingsShell.showNav), so the two
  // reads would be paid for nothing.
  const navCtx = viaPayer ? null : await navContext(org.id);

  // The same credits-only fetch the billing page used to do: the wallet view,
  // the pack ladder priced in the group's locked currency, and the CSV export
  // href (still served by the route under /settings/billing).
  const currency = await preferredCurrency(orgId);
  const creditsView = await getCreditsTab(orgId);

  return (
    <SettingsShell orgSlug={orgSlug} context={navCtx} active="credits" dict={dict} showNav={!viaPayer}>
      {/* No "back to Settings" link here any more. It existed because this page
      had no navigation of its own — #190 removed it as duplication, it was
      reported missing twice, and it came back. The rail beside it now goes
      everywhere the link went and marks where you are, so the link is the
      duplication #190 thought it was. A payer who is not a member has no rail,
      and had no link either (v17 gap #333): the Settings index is member-gated
      and would 404 on them. */}
      <div className="mb-6">
        <h1 className="page-title">{t(dict, "settings.nav.credits")}</h1>
      </div>

      <BillingCredits
        view={creditsView}
        dict={dict}
        locale={locale}
        exportHref={`${routes.billing(orgSlug)}/credits.csv`}
        packs={creditPackOptions(currency)}
        currency={currency}
      />
    </SettingsShell>
  );
}
