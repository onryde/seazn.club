export const dynamic = "force-dynamic";
// Registration status page — CLOSED (RS001 registration demolition, #588).
// `publicRegistrationStatus`/`reconcileRegistration` read the old per-entry
// payment/access-token columns, which V364 moved to `registration_groups`;
// nothing can submit a registration right now (the old endpoint is deleted,
// the new one lands in RS003), so there is no live status to reconcile or
// show. RS007 rebuilds this against the group shape. Owner-accepted: prod
// has zero registration rows, so nothing regresses (design §7 phasing).
import Link from "next/link";
import type { Metadata } from "next";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Props = {
  params: Promise<{ orgSlug: string; competitionSlug: string }>;
};

export default async function RegistrationStatusPage({ params }: Props) {
  const { orgSlug, competitionSlug } = await params;
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");

  return (
    <DictProvider dict={ui} locale={locale}>
      <div className="mx-auto max-w-xl">
        <p className="text-xs text-ink-muted">
          <Link
            href={`/shared/${orgSlug}/${competitionSlug}`}
            className="hover:text-accent-strong hover:underline"
          >
            {t(ui, "status.breadcrumb")}
          </Link>
        </p>
        <h1 className="mt-1 font-display text-2xl font-semibold text-ink">
          {t(ui, "register.closed.title")}
        </h1>
        <p className="mt-2 text-sm text-zinc-500">{t(ui, "register.notOpen")}</p>
        <Link
          href={`/shared/${orgSlug}/${competitionSlug}`}
          className="mt-4 inline-block rounded-md border border-zinc-300 px-4 py-2 text-sm hover:border-zinc-500"
        >
          {t(ui, "register.closed.dashboard")}
        </Link>
      </div>
    </DictProvider>
  );
}
