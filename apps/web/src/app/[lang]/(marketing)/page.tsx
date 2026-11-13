import type { Metadata } from "next";
import Link from "@/components/ui/console-link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getDiscoveryLive, getDiscoveryThisWeek } from "@/server/public-site/discovery";
import { ThisWeekSection } from "@/components/discovery-cards";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { HeroVignette } from "@/components/marketing/hero-vignette";
import { LiveTicker } from "@/components/marketing/live-ticker";
import { TheDraw } from "@/components/marketing/the-draw";
import { MatchdayTools, AlsoInTheKit } from "@/components/marketing/matchday-tools";
import { MotifDivider } from "@/components/marketing/motif-divider";
import { TicketStubs } from "@/components/marketing/ticket-stubs";
import { QuickMatchCta } from "@/components/marketing/quick-match-cta";
import { RecentStrip } from "@/components/quick-match/recent-strip";
import { marketingPreview } from "@/lib/marketing/format-preview";
import { preferredCurrency } from "@/lib/currency-server";
import { loadPricingMatrix } from "@/lib/pricing-matrix-server";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale } from "@/lib/i18n-constants";
import { readRecentQuickMatches } from "@/server/usecases/quick-match-recent";
import { listQuickMatchSports } from "@/server/usecases/quick-match-sports";
import { setupSports } from "./play/setup-props";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const d = await getDictionary(lang, "marketing");
  return {
    title: t(d, "home.meta.title"),
    description: t(d, "home.meta.description"),
    alternates: {
      canonical: `/${lang}`,
      languages: {
        ...Object.fromEntries(["en", "fr", "es", "nl"].map((l) => [l, `/${l}`])),
        "x-default": "/en",
      },
    },
    openGraph: {
      title: t(d, "home.og.title"),
      description: t(d, "home.og.description"),
      url: "/",
      siteName: "Seazn Club",
      type: "website",
      // Explicit: in this Next build a page-level openGraph object replaces
      // the inherited one wholesale, dropping the root file-convention
      // opengraph-image (home shipped with no og:image at all).
      images: [{ url: "/opengraph-image", width: 1200, height: 630 }],
    },
  };
}

export default async function HomePage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();

  // Signed-in visitors see the marketing home like anyone else. It used to
  // redirect them to /dashboard, which made the page unreachable once you had
  // an account — no way to re-read the pitch, check pricing copy, or send
  // someone a link and see what they see. MarketingNav already swaps its
  // sign-in pair for a "Dashboard →" button when there's a session, so the way
  // back is on screen. Note /login still redirects: a signed-in user has no
  // business on the login form, but every reason to visit the home page.
  const user = await getCurrentUser().catch(() => null);

  const d = await getDictionary(lang, "marketing");
  const audiences = [
    { key: "clubs", href: "/use-cases/clubs" },
    { key: "events", href: "/use-cases/events" },
    { key: "schools", href: "/use-cases/schools" },
  ] as const;

  // Fail-soft: DB may be unreachable at build (same contract as before).
  //
  // `planMatrix` joined this list when the ticket stubs' bullets became
  // dictionary copy: the caps and fee rates they quote are interpolated from
  // `plan_entitlements`, through the SAME loader /pricing reads, so the stub
  // and the full card can never quote different numbers for the same plan.
  // Empty on failure — `cardBullets` then drops the bullets it cannot fill
  // rather than rendering "{entrants} entrants per division".
  //
  // `recentQuickMatches` (quick match plan 2 Task 9): the strip of this browser's quick matches, read from the visitor
  // cookie. Fail-soft inside (`readRecentQuickMatches` answers none on any failure, pre-flight A9), so no `.catch` here:
  // a `.catch` would also swallow Next's own render signal, which the reader rethrows on purpose.
  //
  // `quickMatchOffer` (owner 2026-11-13, the hero's quick match start): the hero's Sport select lists exactly what the setup
  // screen offers, read and named the way that page does (`listQuickMatchSports`, `setupSports`), so it never offers a
  // sport /play would ignore. Empty on failure: the Start alone, and /play says why.
  const [liveNow, thisWeek, currency, planMatrix, recentQuickMatches, quickMatchOffer, ui] = await Promise.all([
    getDiscoveryLive().catch(() => []),
    getDiscoveryThisWeek().catch(() => []),
    preferredCurrency(null).catch(() => "usd" as const),
    loadPricingMatrix().catch(() => ({})),
    readRecentQuickMatches(),
    listQuickMatchSports().catch(() => []),
    getDictionary(lang, "ui"),
  ]);
  const heroSports = setupSports(quickMatchOffer, ui);
  // SSR default draw = the configurator's no-JS fallback (design/v3/12 §4.4).
  const defaultDraw = marketingPreview("groups-knockout", 8);

  return (
    <MarketingShell variant="night-scroll" lang={lang}>
      <main>
        {/* Hero — stadium night. */}
        <section className="relative -mt-16 overflow-hidden bg-[linear-gradient(180deg,var(--mk-night-2),var(--mk-night))] pb-16 pt-28 text-[var(--mk-cream)]">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-1/3 left-[-8%] h-[130%] w-[45%] rotate-12 bg-[radial-gradient(ellipse_at_top,rgba(163,230,53,0.10),transparent_65%)]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -top-1/3 right-[-8%] h-[130%] w-[45%] -rotate-12 bg-[radial-gradient(ellipse_at_top,rgba(163,230,53,0.10),transparent_65%)]"
          />
          <div id="mk-hero-sentinel" aria-hidden className="absolute inset-x-0 top-0 h-[70%]" />
          <div className="relative mx-auto grid max-w-6xl items-center gap-10 px-4 lg:grid-cols-[1.1fr_0.9fr]">
            <div>
              <p className="mk-display text-xs font-semibold tracking-[0.22em] text-[var(--mk-lime)]">
                {t(d, "home.hero.eyebrow")}
              </p>
              <h1 className="mk-display mt-3 max-w-xl text-5xl font-bold leading-[0.95] sm:text-7xl">
                {t(d, "home.hero.title")}
              </h1>
              <p className="mt-4 max-w-md text-base text-[#b7aede]">{t(d, "home.hero.subhead")}</p>
              {/* Quick match is the hero's one primary (owner 2026-11-13, Option A): a sport, then Start, no account. */}
              <div className="mt-8">
                <QuickMatchCta
                  lang={lang}
                  sports={heroSports}
                  copy={{
                    sport: t(d, "quickMatch.setup.sport"),
                    start: t(d, "quickMatch.cta"),
                    hint: t(d, "quickMatch.ctaHint"),
                  }}
                />
              </div>
              {/* The organiser's setup, one quiet link below: the same /start wizard (it defaults the sport and field
                  size the hero no longer asks), so its server-side funnel events fire as before. Locale-prefixed, so
                  the wizard keeps the page's language. */}
              <Link
                href={`/${lang}/start`}
                data-testid="hero-event-link"
                className="group mt-3 inline-flex min-h-11 max-w-full items-center text-sm text-[#ddd6f5] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--mk-lime)]"
              >
                <span className="min-w-0 underline decoration-[#4a3885] underline-offset-4 transition group-hover:decoration-[var(--mk-lime)]">
                  {t(d, "home.hero.eventPrompt")}{" "}
                  <span className="font-semibold text-[var(--mk-lime)]">{t(d, "home.hero.eventLink")}</span>
                </span>
              </Link>
              <p className="mt-2 text-xs text-[#8d7fc0]">
                {t(d, "home.hero.freeNote")}
                <Link href="/pricing" className="underline hover:text-[var(--mk-lime)]">
                  {t(d, "home.hero.upgradeLink")}
                </Link>
              </p>
            </div>
            <div className="w-full max-w-md justify-self-center">
              <HeroVignette />
            </div>
          </div>
          {/* A returning guest's quick matches, still on the night stage, under the hero (renders nothing for none). */}
          <RecentStrip
            lang={lang}
            title={t(d, "quickMatch.recent.title")}
            items={recentQuickMatches}
            className="relative mx-auto mt-12 max-w-6xl px-4"
          />
        </section>

        <LiveTicker fixtures={liveNow} />

        {/* The Draw */}
        <section id="the-draw" className="bg-[var(--mk-light-violet)] py-20">
          <div className="mx-auto max-w-5xl px-4">
            <h2 className="mk-display mb-2 text-center text-4xl font-bold text-purple-950">
              {t(d, "home.draw.title")}
            </h2>
            <p className="mb-10 text-center text-slate-600">{t(d, "home.draw.subhead")}</p>
            <TheDraw initialPhases={defaultDraw} />
          </div>
        </section>

        <MotifDivider kind="shuttle" />

        {/* Matchday tools */}
        <section className="mx-auto max-w-5xl px-4 pb-20 pt-4">
          <h2 className="mk-display mb-2 text-center text-4xl font-bold text-purple-950">
            {t(d, "home.tools.title")}
          </h2>
          <p className="mb-10 text-center text-slate-600">{t(d, "home.tools.subhead")}</p>
          <MatchdayTools dict={d} />
          <div className="mt-12 border-t border-purple-100 pt-8">
            <AlsoInTheKit dict={d} />
          </div>
        </section>

        <MotifDivider kind="knight" />

        {/* Who plays here */}
        <section className="bg-[var(--mk-light-warm)] py-16">
          <div className="mx-auto max-w-5xl px-4">
            <h2 className="mk-display mb-8 text-center text-4xl font-bold text-purple-950">
              {t(d, "home.audiences.title")}
            </h2>
            <div className="grid gap-6 sm:grid-cols-3">
              {audiences.map((c) => (
                <Link
                  key={c.href}
                  href={c.href}
                  className="card block p-6 transition hover:border-purple-300 hover:shadow-md"
                >
                  <h3 className="mk-display mb-1 text-lg font-semibold text-slate-800">
                    {t(d, `home.audiences.${c.key}.title`)}
                  </h3>
                  <p className="text-sm text-slate-500">{t(d, `home.audiences.${c.key}.body`)}</p>
                  <p className="mt-3 text-xs font-semibold text-purple-600">
                    {t(d, "home.audiences.learnMore")}
                  </p>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* Playing this week (collapses when empty) */}
        <ThisWeekSection entries={thisWeek} dict={d} lang={lang} />

        {/* Floodlit finale — pricing + CTA in one night block */}
        <section className="relative overflow-hidden bg-[linear-gradient(180deg,var(--mk-night-2),var(--mk-night))] py-20 text-center">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-1/3 left-[-8%] h-[130%] w-[45%] rotate-12 bg-[radial-gradient(ellipse_at_top,rgba(163,230,53,0.08),transparent_65%)]"
          />
          <div className="relative mx-auto max-w-5xl px-4">
            <p className="mk-display text-xs font-semibold tracking-[0.22em] text-[var(--mk-lime)]">
              {t(d, "home.finale.eyebrow")}
            </p>
            <h2 className="mk-display mb-2 mt-3 text-5xl font-bold text-[var(--mk-cream)]">
              {t(d, "home.finale.title")}
            </h2>
            <p className="mb-10 text-sm text-[#b7aede]">{t(d, "home.finale.subhead")}</p>
            <TicketStubs currency={currency} dict={d} matrix={planMatrix} />
            {/* "Create free account" is the wrong ask of someone who already
                has one, so the signed-in pair leads with the console instead.
                Starting a tournament stays available — an existing organiser is
                exactly who does that next. */}
            <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
              <Link
                href="/start"
                className="mk-display rounded-xl bg-[var(--mk-lime)] px-8 py-3 text-base font-bold text-[var(--mk-night)]"
              >
                {t(d, "home.cta.start")}
              </Link>
              <Link
                href={user ? "/dashboard" : "/login?tab=signup"}
                className="rounded-xl border border-[#4a3885] px-6 py-3 text-sm text-[var(--mk-cream)]"
              >
                {user ? `${t(d, "nav.dashboard")} →` : t(d, "home.cta.signup")}
              </Link>
            </div>
          </div>
        </section>
      </main>
    </MarketingShell>
  );
}
