export const dynamic = "force-dynamic";
// Credits — its own Settings tab (SPEC-6 §A3, moved off the billing page), with two sides: AI (the default, and what every
// link made before the tab had two sides still opens) and Streaming (`?kind=stream`, owner decision 2026-10-20, Option A:
// match credits, the free allowance, the packs and the history, mirroring the AI side).
// Both wallets are the ORG's, not the payer's: an org owner inside a billing group they don't pay for must still see the
// pool they spend from, so this page is member-visible and NOT payer-gated. The credit-pack purchases + CSV exports it
// mounts are session-authed inside their own handlers.
import { requireBillingPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { BillingCredits } from "@/components/billing-credits";
import { BillingStreamCredits, type StreamPurchaseNotice } from "@/components/billing-stream-credits";
import { CreditsKindSwitch, creditsKindOf } from "@/components/credits-kind-switch";
import { getCreditsTab } from "@/server/usecases/credits-tab";
import { getStreamCreditsTab } from "@/server/usecases/stream-credits-tab";
import { cursorFromQuery } from "@/server/usecases/stream-credit-history";
import { reconcileStreamCreditsCheckout } from "@/server/usecases/stream-credits-checkout";
import { creditPackOptions } from "@/lib/currency";
import { preferredCurrency } from "@/lib/currency-server";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { SettingsShell, navContext } from "../_components/settings-nav";

export default async function CreditsSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ kind?: string | string[]; before?: string | string[]; checkout?: string | string[]; session_id?: string | string[] }>;
}) {
  const { orgSlug } = await params;
  const sp = await searchParams;
  const { org, viaPayer, auth } = await requireBillingPage(orgSlug, { tail: "/settings/credits" });
  const orgId = org.id;
  const kind = creditsKindOf(sp.kind);
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");
  // The rail's plan + credit-balance header. Skipped for a payer who is not a
  // member: they get no rail at all (see SettingsShell.showNav), so the two
  // reads would be paid for nothing. It shows the AI balance on both sides of
  // the tab: it is the plan header, and the match-credit balance is one tap away.
  const navCtx = viaPayer ? null : await navContext(org.id);

  // The currency both packs ladders are priced in: the group's locked one.
  const currency = await preferredCurrency(orgId);

  let body;
  if (kind === "stream") {
    // Back from Stripe: reconcile the session BEFORE the balance is read, so the credits are on the page even when this
    // render beats the webhook (best-effort, idempotent, never throws). Only a `checkout=success` return with a session id.
    let notice: StreamPurchaseNotice = null;
    if (sp.checkout === "success" && typeof sp.session_id === "string" && sp.session_id !== "") {
      notice = (await reconcileStreamCreditsCheckout(orgId, sp.session_id)) ? "paid" : "pending";
    }
    const cursor = cursorFromQuery(sp.before);
    const view = await getStreamCreditsTab(auth, orgId, { cursor });
    body = (
      <BillingStreamCredits
        view={view}
        dict={dict}
        locale={locale}
        orgId={orgId}
        orgSlug={orgSlug}
        currency={currency}
        notice={notice}
        cursor={cursor}
      />
    );
  } else {
    // The same credits-only fetch the billing page used to do: the wallet view,
    // the pack ladder priced in the group's locked currency, and the CSV export
    // href (still served by the route under /settings/billing).
    const creditsView = await getCreditsTab(orgId);
    body = (
      <BillingCredits
        view={creditsView}
        dict={dict}
        locale={locale}
        exportHref={`${routes.billing(orgSlug)}/credits.csv`}
        packs={creditPackOptions(currency)}
        currency={currency}
      />
    );
  }

  return (
    <SettingsShell orgSlug={orgSlug} context={navCtx} active="credits" dict={dict} showNav={!viaPayer}>
      {/* No "back to Settings" link here any more. It existed because this page
      had no navigation of its own — #190 removed it as duplication, it was
      reported missing twice, and it came back. The rail beside it now goes
      everywhere the link went and marks where you are, so the link is the
      duplication #190 thought it was. A payer who is not a member has no rail,
      and had no link either (v17 gap #333): the Settings index is member-gated
      and would 404 on them. */}
      <div className="mb-4">
        <h1 className="page-title">{t(dict, "settings.nav.credits")}</h1>
      </div>

      <CreditsKindSwitch orgSlug={orgSlug} active={kind} dict={dict} />

      {body}
    </SettingsShell>
  );
}
