import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { FormatDemo } from "@/components/marketing/product/format-demo";
import { FREE_FORMATS, PRO_FORMAT } from "@/components/marketing/product/format-demo-config";
import { formatDemoLabels } from "@/components/marketing/product/format-demo-labels";
import { Accent, Closing, DemoBand, PageHero, ProductPage, Questions, Road, Ticket } from "@/components/marketing/product/parts";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale } from "@/lib/i18n-constants";
import { marketingMeta } from "@/lib/seo-meta";

const PATH = "/product/format";
const SIGNUP = "/login?tab=signup";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const d = await getDictionary(lang, "marketing");
  return marketingMeta({ lang, path: PATH, title: t(d, "product.format.meta.title"), description: t(d, "product.format.meta.description") });
}

/**
 * Formats: the feature-page shape (docs/superpowers/specs/2026-11-16-product-pages-design.md §4). Replaces the old
 * `/formats` gallery (deleted 2026-11-16) as the page the nav links to. The demo runs the product's own format recommender, and the format
 * names in the ticket are the format gallery's (`ui`), so nothing here is a second description of the product.
 */
export default async function FormatProductPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const [d, ui] = await Promise.all([getDictionary(lang, "marketing"), getDictionary(lang, "ui")]);
  const s = (key: string) => t(d, `product.format.${key}`);
  const shared = (key: string) => t(d, `product.shared.${key}`);
  const familyTitle = (slug: string) => t(ui, `format.${slug}.title` as never);

  return (
    <MarketingShell variant="night-scroll" lang={lang}>
      <ProductPage>
        <PageHero crumb={s("crumb")} title={<Accent text={s("h1")} />} lede={s("lede")} primary={{ label: s("try"), href: "#try" }} secondary={{ label: shared("startFree"), href: SIGNUP }}>
          <DemoBand id="try" title={s("demo.title")} note={s("demo.note")}>
            <FormatDemo labels={formatDemoLabels(d, ui)} />
          </DemoBand>
        </PageHero>

        <Road
          title={s("road.title")}
          lede={s("road.lede")}
          steps={([["1", "formatWizardM"], ["2", "formatDrawM"], ["3", "hubM"]] as const).map(([n, image]) => ({
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
          rows={FREE_FORMATS.map((slug) => ({ label: familyTitle(slug), value: s("ticket.included") }))}
          stub={{ top: s("ticket.stubTop"), big: familyTitle(PRO_FORMAT), bottom: s("ticket.stubBottom"), href: "/pricing" }}
        />

        <Questions title={shared("questions")} items={(["1", "2", "3", "4"] as const).map((n) => ({ q: s(`faq.${n}.q`), a: s(`faq.${n}.a`) }))} />

        <Closing line={s("closing")} sub={shared("closingSub")} cta={{ label: shared("startFree"), href: SIGNUP }} pricing={{ label: shared("seePricing"), href: "/pricing" }} />
      </ProductPage>
    </MarketingShell>
  );
}
