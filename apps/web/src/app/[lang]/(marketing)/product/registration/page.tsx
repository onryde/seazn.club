import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { RegistrationDemo } from "@/components/marketing/product/registration-demo";
import { registrationDemoLabels } from "@/components/marketing/product/registration-demo-labels";
import { Accent, Closing, DemoBand, PageHero, ProductPage, Questions, Road, SplitBand, Ticket } from "@/components/marketing/product/parts";
import { preferredCurrency } from "@/lib/currency-server";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale } from "@/lib/i18n-constants";
import { REG_DEMO } from "@/lib/marketing/registration-demo";
import { loadPricingMatrix } from "@/lib/pricing-matrix-server";
import { marketingMeta } from "@/lib/seo-meta";

const PATH = "/product/registration";
const SIGNUP = "/login?tab=signup";
/** The plans whose fee the page quotes, in the order shown: the copy key and the plan's key in the pricing table. */
const FEE_PLANS = [
  ["community", "community"],
  ["pass", "event_pass"],
  ["pro", "pro"],
] as const;

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const d = await getDictionary(lang, "marketing");
  return marketingMeta({ lang, path: PATH, title: t(d, "product.registration.meta.title"), description: t(d, "product.registration.meta.description") });
}

/**
 * /product/registration (owner 2026-11-18, demo option A). The demo walks lib/marketing/registration-demo.ts. Every
 * fee is read from the pricing table, never typed: a plan the table has no fee for gets no row. Money is formatted
 * here, in the visitor's currency, so the demo island ships no formatter. Pictures are the real screens
 * in the local Seazn Demo Club (Southend Badminton Open), with the public address shown in place of the capture host.
 */
export default async function RegistrationProductPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const [d, currency, matrix] = await Promise.all([
    getDictionary(lang, "marketing"),
    preferredCurrency(null).catch(() => "usd" as const),
    loadPricingMatrix().catch(() => ({}) as Awaited<ReturnType<typeof loadPricingMatrix>>),
  ]);
  const s = (key: string, vars?: Record<string, string | number>) => t(d, `product.registration.${key}` as never, vars as never);
  const shared = (key: string) => t(d, `product.shared.${key}` as never);
  const money = (minor: number) =>
    new Intl.NumberFormat(lang, { style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: 0 }).format(minor / 100);
  const feeRows = FEE_PLANS.flatMap(([key, plan]) => {
    const fee = matrix["registration.fee_percent"]?.[plan]?.int_value;
    return typeof fee === "number" ? [{ label: s(`ticket.row.${key}`), value: s("ticket.fee", { fee }) }] : [];
  });
  const entered = Array.from({ length: REG_DEMO.capacity + 1 }, (_, paid) => money(paid * REG_DEMO.feeMinor));

  return (
    <MarketingShell variant="night-scroll" lang={lang}>
      <ProductPage>
        <PageHero crumb={s("crumb")} title={<Accent text={s("h1")} />} lede={s("lede")} primary={{ label: s("try"), href: "#try" }} secondary={{ label: shared("startFree"), href: SIGNUP }}>
          <DemoBand id="try" title={s("demo.title")} note={s("demo.note")}>
            <RegistrationDemo labels={registrationDemoLabels(d)} fee={money(REG_DEMO.feeMinor)} collected={entered} />
          </DemoBand>
        </PageHero>

        <Road
          title={s("road.title")}
          lede={s("road.lede")}
          steps={([["1", "regSettingsM"], ["2", "regFormM"], ["3", "regListM"]] as const).map(([n, image]) => ({
            heading: s(`road.${n}.h`),
            who: s(`road.${n}.who`),
            body: s(`road.${n}.p`),
            image,
            caption: s(`road.${n}.cap`),
          }))}
        />

        <SplitBand
          section="entry"
          title={s("split.title")}
          lede={s("split.lede")}
          steps={(["1", "2", "3"] as const).map((n) => ({ heading: s(`split.${n}.h`), body: s(`split.${n}.p`) }))}
          figures={[{ image: "regEntryM", caption: s("split.cap") }]}
        />

        <Ticket
          title={s("ticket.title")}
          body={s("ticket.body")}
          kicker={s("ticket.kicker")}
          heading={s("ticket.heading")}
          rows={feeRows}
          stub={{ top: s("ticket.stubTop"), big: s("ticket.stubBig"), bottom: s("ticket.stubBottom"), href: "/pricing" }}
        />

        <Questions
          title={shared("questions")}
          items={(["1", "2", "3", "4", "5", "6"] as const).map((n) => ({ q: s(`faq.${n}.q`), a: s(`faq.${n}.a`, { hours: REG_DEMO.holdHours }) }))}
        />

        <Closing line={s("closing")} sub={shared("closingSub")} cta={{ label: shared("startFree"), href: SIGNUP }} pricing={{ label: shared("seePricing"), href: "/pricing" }} />
      </ProductPage>
    </MarketingShell>
  );
}
