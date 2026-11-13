import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { StartWizard } from "@/components/start-wizard";
import { wizardToday } from "@/components/start-wizard-model";
import { DictProvider } from "@/components/i18n/dict-provider";
import { funnelEntrantCap } from "@/lib/funnel";
import { LOCALES, hasLocale } from "@/lib/i18n-constants";
import { getDictionary, t } from "@/lib/i18n";
import { log } from "@/server/logger";
import { listQuickMatchSports } from "@/server/usecases/quick-match-sports";
import { parseStartPrefill } from "./prefill";

// Per request: the prefill is the query, today is the server clock, the cap and the quick match offer are live reads.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const dict = await getDictionary(lang, "marketing");
  return {
    title: t(dict, "start.meta.title"),
    description: t(dict, "start.meta.description"),
    alternates: {
      canonical: `/${lang}/start`,
      // hreflang alternates — the primary SEO signal for the localized surface.
      languages: {
        ...Object.fromEntries(LOCALES.map((l) => [l, `/${l}/start`])),
        "x-default": "/en/start",
      },
    },
  };
}

/** The free plan's entrants per division, or none (the cards then count the size asked): a read that fails is not a 500. */
async function readCap(): Promise<number | null> {
  try {
    return await funnelEntrantCap();
  } catch (err) {
    log.error({ err }, "start: the free plan's entrant cap could not be read");
    return null;
  }
}

/** The sports /play offers a quick match of (its own offer read), or none: the Sent screen's link then stays hidden. */
async function readPlaySports(): Promise<string[]> {
  try {
    return (await listQuickMatchSports()).map((s) => s.sport_key);
  } catch (err) {
    log.error({ err }, "start: the quick match offer could not be read");
    return [];
  }
}

/** No-auth funnel wizard (v3/07 §6; start-wizard redesign 2026-11-13): the visitor invests first — the emailed claim link
 *  signs them in and builds what they chose here. */
export default async function StartPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const [marketingDict, uiDict, sp, maxEntrants, playSports] = await Promise.all([
    getDictionary(lang, "marketing"),
    // The wizard renders <LegalNotice/>, the Turnstile refusal and the sport and format words, all from the shared `ui`
    // catalog: a provider scoped to `marketing` alone leaked raw keys (design/fix-ui/01-marketing-auth.md).
    getDictionary(lang, "ui"),
    searchParams,
    readCap(),
    readPlaySports(),
  ]);
  const dict = { ...marketingDict, ...uiDict };
  // From the server clock only, never the request (parseStartPrefill refuses a bad today by throwing).
  const today = wizardToday(new Date());
  return (
    <MarketingShell variant="night-scroll" lang={lang}>
      <main className="relative -mt-16 min-h-[100svh] bg-[linear-gradient(180deg,var(--mk-night-2),var(--mk-night))] pb-16 pt-24 text-[var(--mk-cream)]">
        {/* The nav stays night over the top of the page, as on /play (nav-scroll.tsx). */}
        <div id="mk-hero-sentinel" aria-hidden className="absolute inset-x-0 top-0 h-48" />
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -top-1/4 left-1/2 h-[60%] w-[120%] max-w-4xl -translate-x-1/2 bg-[radial-gradient(ellipse_at_top,rgba(124,58,237,0.22),transparent_65%)]" />
        </div>
        <div className="relative">
          <noscript>
            <p className="mx-auto mb-4 max-w-xl px-4 text-sm text-[#fdba74]">{t(dict, "start.wizard.noScript")}</p>
          </noscript>
          <DictProvider dict={dict} locale={lang}>
            <StartWizard
              initial={parseStartPrefill(sp, today)}
              maxEntrants={maxEntrants}
              today={today}
              playSports={playSports}
            />
          </DictProvider>
        </div>
      </main>
    </MarketingShell>
  );
}
