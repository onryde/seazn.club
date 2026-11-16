import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DiscoveryCard } from "@/components/discovery-cards";
import { LiveRefresh } from "@/components/marketing/live-refresh";
import { LiveWall } from "@/components/marketing/live-wall";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { Accent, Closing, PageHero, ProductPage } from "@/components/marketing/product/parts";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale } from "@/lib/i18n-constants";
import { marketingMeta } from "@/lib/seo-meta";
import { getDiscoveryDirectory, getDiscoveryLiveAll } from "@/server/public-site/discovery";

// The wall stays fresh on its own: 30s ISR + a visibility-aware client refresh (LiveRefresh) for parked tabs.
export const revalidate = 30;

const SIGNUP = "/login?tab=signup";
/** How many upcoming competitions the page lists. No search or filters for now (owner, 2026-11-16). */
const UPCOMING = 12;

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const d = await getDictionary(lang, "marketing");
  return marketingMeta({ lang, path: "/live", title: t(d, "live.meta.title"), description: t(d, "live.meta.description") });
}

/**
 * Live (docs/superpowers/specs/2026-11-16-product-pages-design.md §6): the one public listing page, in the product
 * pages' theme. Matches in play on top, upcoming public competitions below, both from the same listing rule as before
 * (`public_discovery_v`). With nothing in play the wall says so and shows the "start your own tournament" banner. It
 * takes over from /discover, so nothing here links there.
 */
export default async function LivePage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const [d, fixtures, upcoming] = await Promise.all([
    getDictionary(lang, "marketing"),
    getDiscoveryLiveAll().catch(() => []),
    getDiscoveryDirectory({ status: "upcoming" }, UPCOMING).catch(() => []),
  ]);
  const shared = (key: string) => t(d, `product.shared.${key}`);

  return (
    <MarketingShell variant="night-scroll" lang={lang} hideBackButton>
      <ProductPage>
        <PageHero crumb={t(d, "live.eyebrow")} title={<Accent text={t(d, "live.h1")} />} lede={t(d, "live.lede")} primary={{ label: shared("startFree"), href: SIGNUP }} secondary={{ label: shared("seePricing"), href: "/pricing" }}>
          <div className="mkp-demo" data-section="wall">
            <div className="mkp-wrap">
              <LiveWall fixtures={fixtures} dict={d} lang={lang} />
            </div>
          </div>
        </PageHero>

        {upcoming.length > 0 ? (
          <section className="mkp-sec" data-section="upcoming">
            <div className="mkp-wrap">
              <h2 className="mkp-d">{t(d, "live.upcoming.title")}</h2>
              <p className="mkp-lede">{t(d, "live.upcoming.lede")}</p>
              <ul className="mkp-upcoming">
                {upcoming.map((e) => (
                  <li key={e.id}>
                    <DiscoveryCard entry={e} dict={d} lang={lang} withJsonLd />
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ) : null}

        <Closing line={t(d, "live.start.title")} sub={shared("closingSub")} cta={{ label: shared("startFree"), href: SIGNUP }} pricing={{ label: shared("seePricing"), href: "/pricing" }} />
      </ProductPage>
      <LiveRefresh />
    </MarketingShell>
  );
}
