import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale } from "@/lib/i18n-constants";
import { AFFILIATE_PORTAL_URL, AFFILIATE_TERMS } from "@/lib/affiliate-terms";
import { revshareEnabled } from "@/lib/revshare-shared";

// Public entry point to the Revshare affiliate program. 404s unless the master
// switch is on (NEXT_PUBLIC_REVSHARE_ENABLED=1), so stg/local never advertise a
// program that is not live. The numbers come from AFFILIATE_TERMS, never from
// the dictionaries, so the copy cannot drift from the single source.

const CARDS = ["0", "1", "2"] as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang) || !revshareEnabled()) return {};
  const d = await getDictionary(lang, "marketing");
  return {
    title: t(d, "affiliates.meta.title"),
    description: t(d, "affiliates.meta.description", AFFILIATE_TERMS),
    alternates: {
      canonical: `/${lang}/affiliates`,
      languages: {
        ...Object.fromEntries(["en", "fr", "es", "nl"].map((l) => [l, `/${l}/affiliates`])),
        "x-default": "/en/affiliates",
      },
    },
  };
}

export default async function AffiliatesPage({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!hasLocale(lang) || !revshareEnabled()) notFound();
  const d = await getDictionary(lang, "marketing");
  return (
    <MarketingShell lang={lang}>
      <main>
        <section className="mx-auto max-w-4xl px-4 pb-16 pt-16">
          <div className="mk-display mb-4 inline-flex items-center gap-2 rounded-full bg-[var(--mk-lime)] px-3 py-1 text-xs font-semibold tracking-[0.14em] text-[var(--mk-night)]">
            {t(d, "affiliates.badge")}
          </div>
          <h1 className="mk-display mb-4 text-5xl font-bold text-purple-950 sm:text-6xl">
            {t(d, "affiliates.h1", AFFILIATE_TERMS)}
          </h1>
          <p className="mb-8 max-w-2xl text-lg text-slate-600">
            {t(d, "affiliates.subhead", AFFILIATE_TERMS)}
          </p>
          <div className="grid gap-6 sm:grid-cols-3">
            {CARDS.map((i) => (
              <div key={i} className="card p-6">
                <div className="mk-display mb-3 text-3xl font-bold text-purple-300">{Number(i) + 1}</div>
                <h2 className="mb-1 font-semibold text-slate-800">{t(d, `affiliates.card.${i}.title`)}</h2>
                <p className="text-sm text-slate-500">{t(d, `affiliates.card.${i}.body`, AFFILIATE_TERMS)}</p>
              </div>
            ))}
          </div>
          <p className="mt-6 max-w-2xl text-sm text-slate-500" data-testid="affiliates-payout">
            {t(d, "affiliates.payout", AFFILIATE_TERMS)}
          </p>
        </section>
        <section className="bg-purple-50 py-14 text-center">
          <h2 className="mb-3 text-2xl font-bold text-purple-900">{t(d, "affiliates.cta.title")}</h2>
          <p className="mb-6 text-slate-500">{t(d, "affiliates.cta.subtext")}</p>
          <a
            href={AFFILIATE_PORTAL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary px-8 py-3 text-base"
            data-testid="affiliates-join"
          >
            {t(d, "affiliates.cta.button")} →
          </a>
        </section>
      </main>
    </MarketingShell>
  );
}
