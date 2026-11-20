import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { Accent, Closing, DemoBand, PageHero, ProductPage, Questions, Road, Ticket } from "@/components/marketing/product/parts";
import { SponsorDemo } from "@/components/marketing/product/sponsor-demo";
import { sponsorDemoLabels } from "@/components/marketing/product/sponsor-demo-labels";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale } from "@/lib/i18n-constants";
import { buildDealTable } from "@/lib/marketing/sponsor-deal-table";
import { marketingMeta } from "@/lib/seo-meta";
import { SPONSOR_TIERS, SPONSOR_TIER_WEIGHTS } from "@/lib/sponsor-tiers";

const PATH = "/product/sponsoring";
const SIGNUP = "/login?tab=signup";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const d = await getDictionary(lang, "marketing");
  return marketingMeta({ lang, path: PATH, title: t(d, "product.sponsoring.meta.title"), description: t(d, "product.sponsoring.meta.description") });
}

/**
 * Sponsoring: the feature-page shape (docs/superpowers/specs/2026-11-16-product-pages-design.md §4). The demo walks a
 * table of deal states built here, on the server, from the product's own deal rules; the tiers and their turns on the
 * stream are the product's own lists. Plan facts in the ticket are the help page's (content/help/sharing/sponsors-packages.md and sponsor-deals.md).
 */
export default async function SponsoringProductPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const d = await getDictionary(lang, "marketing");
  const s = (key: string) => t(d, `product.sponsoring.${key}` as never);
  const shared = (key: string) => t(d, `product.shared.${key}` as never);

  return (
    <MarketingShell variant="night-scroll" lang={lang}>
      <ProductPage>
        <PageHero crumb={s("crumb")} title={<Accent text={s("h1")} />} lede={s("lede")} primary={{ label: s("try"), href: "#try" }} secondary={{ label: shared("startFree"), href: SIGNUP }}>
          <DemoBand id="try" title={s("demo.title")} note={s("demo.note")}>
            <SponsorDemo labels={sponsorDemoLabels(d)} table={buildDealTable()} tiers={SPONSOR_TIERS.map((key) => ({ key, turns: SPONSOR_TIER_WEIGHTS[key] }))} />
          </DemoBand>
        </PageHero>

        <Road
          title={s("road.title")}
          lede={s("road.lede")}
          steps={([["1", "sponsorListM"], ["2", "sponsorPublicM"], ["3", "sponsorReportM"]] as const).map(([n, image]) => ({
            heading: s(`road.${n}.h`),
            who: s(`road.${n}.who`),
            body: s(`road.${n}.p`),
            image,
            caption: s(`road.${n}.cap`),
          }))}
        />

        <Ticket
          title={s("ticket.title")}
          body={s("ticket.body")}
          kicker={s("ticket.kicker")}
          heading={s("ticket.heading")}
          rows={(["1", "2", "3", "4"] as const).map((n) => ({ label: s(`ticket.row.${n}`), value: s("ticket.included") }))}
          stub={{ top: s("ticket.stubTop"), big: s("ticket.stubBig"), bottom: s("ticket.stubBottom"), href: "/pricing" }}
        />

        <Questions title={shared("questions")} items={(["1", "2", "3", "4"] as const).map((n) => ({ q: s(`faq.${n}.q`), a: s(`faq.${n}.a`) }))} />

        <Closing line={s("closing")} sub={shared("closingSub")} cta={{ label: shared("startFree"), href: SIGNUP }} pricing={{ label: shared("seePricing"), href: "/pricing" }} />
      </ProductPage>
    </MarketingShell>
  );
}
