import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppBand } from "@/components/marketing/app-band";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { Accent, Closing, DEMO_TEAMS, DemoBand, PageHero, ProductPage, Questions, Road, SplitBand, Ticket } from "@/components/marketing/product/parts";
import { SignalDemo } from "@/components/marketing/product/signal-demo";
import { signalDemoLabels } from "@/components/marketing/product/signal-demo-labels";
import { BALLS_PER_OVER } from "@/lib/marketing/cricket-chase-rules";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale } from "@/lib/i18n-constants";
import { marketingMeta } from "@/lib/seo-meta";

const PATH = "/product/remote-scoring";
const SIGNUP = "/login?tab=signup";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const d = await getDictionary(lang, "marketing");
  return marketingMeta({ lang, path: PATH, title: t(d, "product.remote.meta.title"), description: t(d, "product.remote.meta.description") });
}

/**
 * Remote scoring: the feature-page shape (docs/superpowers/specs/2026-11-16-product-pages-design.md §4, §5). Offline
 * scoring is this page's HERO, by owner decision, and it is claimed for the Seazn app only: that is where it was
 * proven on a device. The web pad a scoring link opens in a browser makes no offline promise, and the questions say so.
 *
 * The demo club block is omitted (a shape may omit a part): there is no club to open yet.
 */
export default async function RemoteScoringProductPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const d = await getDictionary(lang, "marketing");
  const s = (key: string, vars?: Record<string, string | number>) => t(d, `product.remote.${key}`, vars);
  const shared = (key: string) => t(d, `product.shared.${key}`);

  return (
    <MarketingShell variant="night-scroll" lang={lang}>
      <ProductPage>
        <PageHero
          crumb={s("crumb")}
          title={<Accent text={s("h1")} />}
          lede={s("lede", { app: shared("appName") })}
          primary={{ label: s("try"), href: "#try" }}
          secondary={{ label: shared("startFree"), href: SIGNUP }}
        >
          <DemoBand id="try" title={s("demo.title")} note={s("demo.note")}>
            <SignalDemo labels={signalDemoLabels(d)} teams={DEMO_TEAMS} ballsPerOver={BALLS_PER_OVER} />
          </DemoBand>
        </PageHero>

        {await AppBand({ lang, title: s("app.title"), label: s("app.label"), line: s("app.line") })}

        <Road
          title={s("road.title")}
          lede={s("road.lede")}
          steps={([["1", "remotePanelM"], ["2", "appPad2"], ["3", "mcM"]] as const).map(([n, image]) => ({
            heading: s(`road.${n}.h`),
            who: s(`road.${n}.who`),
            body: s(`road.${n}.p`),
            image,
            caption: s(`road.${n}.cap`),
          }))}
        />

        <SplitBand
          section="offline"
          title={s("offline.title")}
          lede={s("offline.lede")}
          steps={(["1", "2", "3"] as const).map((n) => ({ heading: s(`offline.${n}.h`), body: s(`offline.${n}.p`) }))}
          figures={[
            { image: "appOffline", caption: s("offline.fig1") },
            { image: "appOfflineHistory", caption: s("offline.fig2") },
          ]}
        />

        <Ticket
          title={s("ticket.title")}
          body={s("ticket.body")}
          kicker={s("ticket.kicker")}
          heading={s("ticket.heading")}
          rows={(["account", "works", "ends", "lost"] as const).map((k) => ({ label: s(`ticket.${k}`), value: s(`ticket.${k}V`) }))}
          stub={{ top: s("ticket.stubTop"), big: s("ticket.stubBig"), bottom: s("ticket.stubBottom"), href: "/product/streaming" }}
        />

        <Questions title={shared("questions")} items={(["1", "2", "3", "4"] as const).map((n) => ({ q: s(`faq.${n}.q`), a: s(`faq.${n}.a`) }))} />

        <Closing line={s("closing")} sub={shared("closingSub")} cta={{ label: shared("startFree"), href: SIGNUP }} pricing={{ label: shared("seePricing"), href: "/pricing" }} />
      </ProductPage>
    </MarketingShell>
  );
}
