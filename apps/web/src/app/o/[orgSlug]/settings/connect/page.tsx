export const dynamic = "force-dynamic";
// Connect settings (spec 2026-07-12 §8; renamed from Payments 2026-07-18) —
// its own route like billing: Stripe Connect onboarding/status, the org's
// default payment method for new divisions, and the org-wide offline
// instructions. Returning from Stripe onboarding lands here (?connect=return)
// and the card re-reads live status.
import Link from "@/components/ui/console-link";
import { sql } from "@/lib/db";
import { requireOrgPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { OrgPaymentInstructions } from "@/components/org-payment-instructions";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { SettingsShell, navContext } from "../_components/settings-nav";

export default async function ConnectSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { org } = await requireOrgPage(orgSlug, { tail: "/settings/connect" });
  const isOwner = org.role === "owner";
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");
  // The rail's plan + credit-balance header. Skipped for a payer who is not a
  // member: they get no rail at all (see SettingsShell.showNav), so the two
  // reads would be paid for nothing.
  const navCtx = await navContext(org.id);

  const [row] = await sql<
    { payment_instructions: string | null; default_payment_method: "offline" | "stripe" }[]
  >`
    select payment_instructions, default_payment_method
    from organizations where id = ${org.id}`;

  return (
    <SettingsShell orgSlug={orgSlug} context={navCtx} active="connect" dict={dict}>
      {/* No "back to Settings" link here any more. It existed because this page
      had no navigation of its own — #190 removed it as duplication, it was
      reported missing twice, and it came back. The rail beside it now goes
      everywhere the link went and marks where you are, so the link is the
      duplication #190 thought it was. A payer who is not a member has no rail,
      and had no link either (v17 gap #333): the Settings index is member-gated
      and would 404 on them. */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">{t(dict, "payments.title")}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {t(dict, "payments.desc")}
        </p>
      </div>

      <section className="card p-6">
        <OrgPaymentInstructions
          orgId={org.id}
          initialValue={row?.payment_instructions ?? null}
          initialDefaultMethod={row?.default_payment_method ?? "offline"}
          isOwner={isOwner}
        />
      </section>

      <p className="mt-4 text-xs text-slate-400">
        {t(dict, "payments.planNote")}{" "}
        <Link href={routes.billing(orgSlug)} className="underline hover:text-slate-600">
          {t(dict, "payments.planBilling")}
        </Link>
        .
      </p>
    </SettingsShell>
  );
}
