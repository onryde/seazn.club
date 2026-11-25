import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppBand } from "@/components/marketing/app-band";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { ChaseDemo } from "@/components/marketing/product/chase-demo";
import { chaseDemoLabels } from "@/components/marketing/product/chase-demo-labels";
import { Accent, Closing, DEMO_CLUB_HREF, DEMO_TEAMS, DemoBand, DemoClub, PageHero, PhoneRow, ProductPage, Questions, Road, Ticket } from "@/components/marketing/product/parts";
import { BALLS_PER_OVER } from "@/lib/marketing/cricket-chase-rules";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale } from "@/lib/i18n-constants";
import { marketingMeta } from "@/lib/seo-meta";

const PATH = "/product/streaming";
const SIGNUP = "/login?tab=signup";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const d = await getDictionary(lang, "marketing");
  return marketingMeta({ lang, path: PATH, title: t(d, "product.streaming.meta.title"), description: t(d, "product.streaming.meta.description") });
}

/**
 * Streaming: the feature-page shape (docs/superpowers/specs/2026-11-16-product-pages-design.md §4). No price is
 * quoted here on purpose: there are no live prices yet, only what a credit covers.
 */
export default async function StreamingProductPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const d = await getDictionary(lang, "marketing");
  const s = (key: string) => t(d, `product.streaming.${key}`);
  const shared = (key: string) => t(d, `product.shared.${key}`);

  return (
    <MarketingShell variant="night-scroll" lang={lang}>
      <ProductPage>
        <PageHero
          crumb={s("crumb")}
          title={<Accent text={s("h1")} />}
          lede={s("lede")}
          primary={{ label: s("try"), href: "#try" }}
          secondary={{ label: shared("startFree"), href: SIGNUP }}
        >
          <DemoBand id="try" title={s("demo.title")} note={s("demo.note")}>
            <ChaseDemo tiles={["pad", "stream"]} streamControls labels={chaseDemoLabels(d, await getDictionary(lang, "public"))} teams={DEMO_TEAMS} ballsPerOver={BALLS_PER_OVER} />
          </DemoBand>
        </PageHero>

        <Road
          title={s("road.title")}
          lede={s("road.lede")}
          steps={([["1", "destM"], ["2", "panelM"], ["3", "appPad2"]] as const).map(([n, image]) => ({
            heading: s(`road.${n}.h`),
            who: s(`road.${n}.who`),
            body: s(`road.${n}.p`),
            image,
            caption: s(`road.${n}.cap`),
          }))}
        />

        <PhoneRow
          section="camera"
          title={s("cam.title")}
          lede={s("cam.lede")}
          items={[
            { image: "appStreamArmed", heading: s("cam.1.h"), body: s("cam.1.p") },
            { image: "appStreamSettings", heading: s("cam.2.h"), body: s("cam.2.p") },
          ]}
        />

        {await AppBand({ lang, title: s("app.title"), label: s("app.label"), line: s("app.line") })}

        <Ticket
          title={s("ticket.title")}
          body={s("ticket.body")}
          kicker={s("ticket.kicker")}
          heading={s("ticket.heading")}
          rows={(["length", "on", "score", "expires"] as const).map((k) => ({ label: s(`ticket.${k}`), value: s(`ticket.${k}V`) }))}
          stub={{ top: s("ticket.stubTop"), big: "1 · 5 · 20", bottom: s("ticket.stubBottom") }}
        />

        <DemoClub title={shared("clubTitle")} text={s("club.text")} image="hubD" imageAlt={s("club.alt")} href={DEMO_CLUB_HREF} linkLabel="Seazn Demo Club" />

        <Questions title={shared("questions")} items={(["1", "2", "3", "4"] as const).map((n) => ({ q: s(`faq.${n}.q`), a: s(`faq.${n}.a`) }))} />

        <Closing
          line={s("closing")}
          sub={shared("closingSub")}
          cta={{ label: shared("startFree"), href: SIGNUP }}
          pricing={{ label: shared("seePricing"), href: "/pricing" }}
        />
      </ProductPage>
    </MarketingShell>
  );
}
