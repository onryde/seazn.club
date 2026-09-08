export const dynamic = "force-dynamic";
// Add-ons — its own Settings tab (v17 gap #293, SPEC-6 §A5).
//
// TODAY THIS TAB HOLDS ONE ROW: extra organisations. SPEC-6 §A5 also draws a
// seat picker and a size-pack list, and neither has ever had a UI — both have
// been API-only since they shipped. Building them is not #293's job; the route
// and nav are plural so they land here later without a rename, and there are
// deliberately no "coming soon" placeholders standing in for them.
//
// Member-visible like Credits and Billing (an org owner inside a group they do
// not pay for should still see what the bill covers), with the purchase control
// itself payer-only. `lib/feature-copy.ts`'s 402 offer points customers here by
// name — "Settings → Add-ons" — so routes.addOns and that sentence move
// together.
import { requireBillingPage } from "@/server/page-auth";
import { getAddOnsTab } from "@/server/usecases/add-ons-tab";
import { preferredCurrency } from "@/lib/currency-server";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, plural, t } from "@/lib/i18n";
import { ExtraOrgsControl } from "@/components/extra-orgs-control";
import { Tip } from "@/components/ui/tip";
import { SettingsShell, navContext } from "../_components/settings-nav";

export default async function AddOnsSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { org, user, viaPayer } = await requireBillingPage(orgSlug, {
    tail: "/settings/add-ons",
  });
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");
  // The rail's plan + credit-balance header. Skipped for a payer who is not a
  // member: they get no rail at all (see SettingsShell.showNav), so the two
  // reads would be paid for nothing.
  const navCtx = viaPayer ? null : await navContext(org.id);
  const currency = await preferredCurrency(org.id);
  const view = await getAddOnsTab(org.id, user.id, currency);

  // ONE capacity number on this page, and it is the one the customer bought
  // (`purchasedCapacity`). The resolver's admission cap is allowed to degrade
  // during dunning; a receipt is not. The degradation is said in words below
  // instead, so the page never shows two caps that disagree.
  //
  // `plural()`, not `t()`, on BOTH halves (W8 F2, then F16 for this one). A
  // group that has never added a second organisation is the commonest one
  // there is, and a flat key reads "Using 1 organisations on this bill" — and
  // a Community group's cap is 1 (plan_entitlements orgs.max_owned), so the
  // ordinary Community rendering hit this too: "Using 1 of 1 organisations".
  const capSummary =
    view.orgCap === null
      ? plural(dict, "addOns.cap.summaryUnlimited", view.liveOrgCount, locale)
      : plural(dict, "addOns.cap.summary", view.liveOrgCount, locale, { cap: view.orgCap });

  return (
    <SettingsShell orgSlug={orgSlug} context={navCtx} active="add-ons" dict={dict} showNav={!viaPayer}>
      {/* No "back to Settings" link here any more. It existed because this page
      had no navigation of its own — #190 removed it as duplication, it was
      reported missing twice, and it came back. The rail beside it now goes
      everywhere the link went and marks where you are, so the link is the
      duplication #190 thought it was. A payer who is not a member has no rail,
      and had no link either (v17 gap #333): the Settings index is member-gated
      and would 404 on them. */}
      <div className="mb-1 flex items-center gap-2">
        <h1 className="page-title">{t(dict, "settings.nav.addOns")}</h1>
        <Tip id="billing.addons.extra-org" small />
      </div>
      <p className="mb-6 text-sm text-slate-600">{t(dict, "addOns.intro")}</p>

      <p className="mb-4 text-sm font-medium text-slate-700">{capSummary}</p>

      {/* Never disables anything. A customer who can no longer afford a rider is
          here precisely to cancel it, and taking the control away would leave
          them paying for capacity they cannot use until they call support. */}
      {view.capReduced && (
        <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {t(dict, "addOns.capReduced")}
        </p>
      )}

      {/* UNLIMITED FIRST, and the order is half the fix (W8 F1). A plan whose
          `orgs.max_owned` is NULL sells no rider either — there is nothing to
          sell a group that already has no ceiling — so it ALSO fails
          `addonAvailable`, and behind the community arm this branch would never
          be reached. Before it existed, an unlimited customer was told to
          "Upgrade to buy past the Community limit" one line under a summary
          that had just said their plan sets no limit.

          BOTH CLAUSES, and the second one is the other half. `orgCap === null`
          alone is NOT "the plan is unlimited": `purchasedCapacity`
          (lib/billing-group.ts) answers null for three different states, and a
          staff `int_value = null` override on a PRO group is one of them
          (add-ons-tab.test.ts seeds exactly that). Firing on `orgCap` alone
          would take the control away from a payer who is still billed monthly
          for riders and is here to cancel them — the invariant stated over the
          capReduced notice above. Adding `!view.addonAvailable` makes this arm
          a strict SUBSET of the community arm below, so it can only ever change
          WHICH NOTICE shows, never whether the control does. */}
      {view.orgCap === null && !view.addonAvailable ? (
        <p className="rounded-xl border border-purple-100 bg-purple-50/50 p-4 text-sm text-slate-600">
          {t(dict, "addOns.unlimitedNotice")}
        </p>
      ) : !view.addonAvailable || view.priceMinor === null ? (
        <p className="rounded-xl border border-purple-100 bg-purple-50/50 p-4 text-sm text-slate-600">
          {t(dict, "addOns.communityNotice")}
        </p>
      ) : !view.hasLiveSubscription ? (
        <p className="rounded-xl border border-purple-100 bg-purple-50/50 p-4 text-sm text-slate-600">
          {t(dict, "addOns.noLiveSubscription")}
        </p>
      ) : !view.isPayer ? (
        <p className="rounded-xl border border-purple-100 bg-purple-50/50 p-4 text-sm text-slate-600">
          {t(dict, "addOns.guestNotice")}
        </p>
      ) : (
        <ExtraOrgsControl
          initialCount={view.extraOrgCount}
          min={view.minExtraOrgs}
          max={view.maxExtraOrgs}
          priceMinor={view.priceMinor}
          currency={currency}
          dict={dict}
          locale={locale}
        />
      )}
    </SettingsShell>
  );
}
