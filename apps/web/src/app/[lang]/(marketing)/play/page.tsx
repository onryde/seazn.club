// `/<lang>/play`: the quick match setup screen (plan 2 Task 4; spec docs/superpowers/specs/2026-11-03-quick-match-design.md
// §5 step 2; design of record docs/superpowers/specs/mockups/2026-11-03-quick-match/setup.html, the stadium-night stage).
//
// The create route spells this path (app/api/quick-match/route.ts sends a refusal to `/<locale>/play?e=<code>`), and only
// the prefixed path resolves (proxy.ts rewrites an unprefixed marketing path only when it is listed). Dynamic: the offer
// and `?e=` are per request. The server resolves every name, computes the whole preview table and hands both to the
// island, which never fetches a count (pre-flight D1, B4b).
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { QuickMatchSetupForm } from "@/components/quick-match/setup-form";
import { RecentStrip } from "@/components/quick-match/recent-strip";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale, LOCALES } from "@/lib/i18n-constants";
import { log } from "@/server/logger";
import { quickMatchPreviewTable } from "@/server/usecases/quick-match-preview";
import { listQuickMatchSports, type QuickMatchSport } from "@/server/usecases/quick-match-sports";
import { refusalCode, setupCopy, setupSports } from "./setup-props";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const d = await getDictionary(lang, "marketing");
  return {
    title: t(d, "quickMatch.meta.title"),
    description: t(d, "quickMatch.meta.description"),
    alternates: {
      canonical: `/${lang}/play`,
      languages: {
        ...Object.fromEntries(LOCALES.map((l) => [l, `/${l}/play`])),
        "x-default": "/en/play",
      },
    },
  };
}

/** The offer, or none: a catalog that cannot be read shows the same honest line as an empty one (Q2), never a 500. */
async function readOffer(): Promise<QuickMatchSport[]> {
  try {
    return await listQuickMatchSports();
  } catch (err) {
    log.error({ err }, "quick match setup: the offer could not be read");
    return [];
  }
}

export default async function PlayPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ e?: string | string[] }>;
}) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const [{ e }, d, ui, offer] = await Promise.all([
    searchParams,
    getDictionary(lang, "marketing"),
    getDictionary(lang, "ui"),
    readOffer(),
  ]);
  const [first, ...rest] = setupSports(offer, ui);
  const refused = refusalCode(e);

  return (
    <MarketingShell variant="night-scroll" lang={lang}>
      {/* No `overflow-hidden` here: it would make <main> the Start bar's scroll container and unstick it (m6). Only the
          glow's own layer clips. */}
      <main className="relative -mt-16 min-h-[100svh] bg-[linear-gradient(180deg,var(--mk-night-2),var(--mk-night))] pb-12 pt-24 text-[var(--mk-cream)]">
        {/* The nav stays night over the top of the page, as over the home's hero (nav-scroll.tsx). */}
        <div id="mk-hero-sentinel" aria-hidden className="absolute inset-x-0 top-0 h-48" />
        <div aria-hidden data-testid="qm-glow" className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -top-1/4 left-1/2 h-[60%] w-[120%] max-w-4xl -translate-x-1/2 bg-[radial-gradient(ellipse_at_top,rgba(163,230,53,0.08),transparent_65%)]" />
        </div>
        <div className="relative mx-auto w-full max-w-xl px-4">
          {first ? (
            <QuickMatchSetupForm
              lang={lang}
              sports={[first, ...rest]}
              table={quickMatchPreviewTable()}
              copy={setupCopy(d, ui)}
              initialError={refused}
            />
          ) : (
            <section className="py-10">
              <p className="mk-display text-xs font-semibold tracking-[0.22em] text-[var(--mk-lime)]">
                {t(d, "quickMatch.setup.title")}
              </p>
              <p role="status" className="mt-3 text-base text-[#b7aede]">
                {t(d, "quickMatch.errors.unavailable")}
              </p>
            </section>
          )}
          <RecentStrip title={t(d, "quickMatch.recent.title")} items={[]} />
        </div>
      </main>
    </MarketingShell>
  );
}
