import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { Accent, Closing, PageHero, ProductPage, Questions, Shot } from "@/components/marketing/product/parts";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale } from "@/lib/i18n-constants";
import type { ProductImageKey } from "@/lib/marketing/product-images";
import { SPORT_PAGES, sportKeyOf } from "@/lib/marketing/sport-pages";
import { marketingMeta } from "@/lib/seo-meta";

const PATH = "/sports";
const SIGNUP = "/login?tab=signup";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const d = await getDictionary(lang, "marketing");
  return marketingMeta({ lang, path: PATH, title: t(d, "product.sports.meta.title"), description: t(d, "product.sports.meta.description") });
}

/**
 * The Sports index: one card per sport page (SPORT_PAGES, in its order). A card says nothing of its own: the name is
 * the nav's, the line is that sport page's headline, and the picture is that sport's real scoring pad, so a new sport
 * page shows up here by joining the list.
 */
export default async function SportsIndexPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const d = await getDictionary(lang, "marketing");
  const s = (key: string) => t(d, `product.sports.${key}` as never);
  const shared = (key: string) => t(d, `product.shared.${key}` as never);
  // Cricket's pad picture is the phone app's; the other sports' are named for the sport.
  const padOf = (key: string) => (key === "cricket" ? "appPad2" : `${key}PadM`) as ProductImageKey;

  return (
    <MarketingShell variant="night-scroll" lang={lang}>
      <ProductPage>
        <PageHero crumb={s("crumb")} title={<Accent text={s("h1")} />} lede={s("lede")} primary={{ label: s("pick"), href: "#sports" }} secondary={{ label: shared("startFree"), href: SIGNUP }} />

        <section className="mkp-sec mkp-night" id="sports" data-section="sports">
          <div className="mkp-wrap">
            <h2 className="mkp-d">{s("grid.title")}</h2>
            <p className="mkp-lede">{s("grid.lede")}</p>
            <div className="mkp-phones mkp-sportgrid">
              {SPORT_PAGES.map((slug, i) => {
                const key = sportKeyOf(slug);
                const name = t(d, `nav.sport.${key}` as never);
                return (
                  <Link key={slug} href={`/sports/${slug}`} className="mkp-sportcard" data-testid={`sport-card-${slug}`}>
                    <figure>
                      <Shot image={padOf(key)} alt={name} eager={i === 0} />
                      <figcaption>
                        <b>{name}</b>
                        {t(d, `sport.${key}.h1` as never).replace(/\*/g, "")}
                      </figcaption>
                    </figure>
                  </Link>
                );
              })}
            </div>
          </div>
        </section>

        <Questions title={shared("questions")} items={(["1", "2", "3"] as const).map((n) => ({ q: s(`faq.${n}.q`), a: s(`faq.${n}.a`) }))} />

        <Closing line={s("closing")} sub={shared("closingSub")} cta={{ label: shared("startFree"), href: SIGNUP }} pricing={{ label: shared("seePricing"), href: "/pricing" }} />
      </ProductPage>
    </MarketingShell>
  );
}
