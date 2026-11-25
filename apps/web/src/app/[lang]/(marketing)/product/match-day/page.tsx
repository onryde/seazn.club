import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppBand } from "@/components/marketing/app-band";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { MatchDayDemo } from "@/components/marketing/product/match-day-demo";
import { matchDayDemoLabels } from "@/components/marketing/product/match-day-demo-labels";
import { Accent, Closing, DEMO_CLUB_HREF, DemoBand, DemoClub, PageHero, ProductPage, Questions, Road, SplitBand, Ticket } from "@/components/marketing/product/parts";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale } from "@/lib/i18n-constants";
import { marketingMeta } from "@/lib/seo-meta";

const PATH = "/product/match-day";
const SIGNUP = "/login?tab=signup";

/** The demo club's own teams, so the demo reads like the screens beside it. Indexed by lib/marketing/match-day.ts. */
const TEAMS = [
  "Thorpe Bay Tigers", "Southend Blue Blazers", "Benfleet Town", "Rochford Ramblers",
  "Hadleigh Hawks", "Leigh Lions", "Southend Queens", "Canvey Crusaders",
] as const;

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const d = await getDictionary(lang, "marketing");
  return marketingMeta({ lang, path: PATH, title: t(d, "product.matchday.meta.title"), description: t(d, "product.matchday.meta.description") });
}

/**
 * Match Day: the feature-page shape (docs/superpowers/specs/2026-11-16-product-pages-design.md §4). The demo is a
 * small model of the desk whose rules are the help page's (content/help/scheduling/match-day.md), and every claim in
 * the copy is one that page makes. Pictures are the real desk in Seazn Demo Club.
 */
export default async function MatchDayProductPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const d = await getDictionary(lang, "marketing");
  const s = (key: string) => t(d, `product.matchday.${key}` as never);
  const shared = (key: string) => t(d, `product.shared.${key}` as never);
  const app = shared("appName");

  return (
    <MarketingShell variant="night-scroll" lang={lang}>
      <ProductPage>
        <PageHero crumb={s("crumb")} title={<Accent text={s("h1")} />} lede={s("lede")} primary={{ label: s("try"), href: "#try" }} secondary={{ label: shared("startFree"), href: SIGNUP }}>
          <DemoBand id="try" title={s("demo.title")} note={s("demo.note")}>
            <MatchDayDemo labels={matchDayDemoLabels(d)} teams={TEAMS} />
          </DemoBand>
        </PageHero>

        <Road
          title={s("road.title")}
          lede={s("road.lede")}
          steps={([["1", "matchdayListM"], ["2", "matchdayCallM"], ["3", "matchdayCalledM"]] as const).map(([n, image]) => ({
            heading: s(`road.${n}.h`),
            who: s(`road.${n}.who`),
            body: s(`road.${n}.p`),
            image,
            caption: s(`road.${n}.cap`),
          }))}
        />

        <SplitBand
          section="courtstream"
          title={s("court.title")}
          lede={s("court.lede")}
          steps={(["1", "2", "3"] as const).map((n) => ({ heading: s(`court.${n}.h`), body: s(`court.${n}.p`).replace("{app}", app) }))}
          figures={[
            { image: "appStreamArmed", caption: `${s("court.fig1")} ${shared("illustrated")}` },
            { image: "appStreamSettings", caption: s("court.fig2") },
          ]}
        />

        {await AppBand({ lang, title: s("app.title"), label: s("app.label"), line: s("app.line") })}

        <Ticket
          title={s("ticket.title")}
          body={s("ticket.body")}
          kicker={s("ticket.kicker")}
          heading={s("ticket.heading")}
          rows={(["1", "2", "3", "4"] as const).map((n) => ({ label: s(`ticket.row.${n}`), value: s(`ticket.row.${n}v`) }))}
          stub={{ top: s("ticket.stubTop"), big: s("ticket.stubBig"), bottom: s("ticket.stubBottom"), href: "/pricing" }}
        />

        <DemoClub title={shared("clubTitle")} text={s("club.text")} image="matchdayDeskD" imageAlt={s("club.alt")} href={DEMO_CLUB_HREF} linkLabel="Seazn Demo Club" />

        <Questions title={shared("questions")} items={(["1", "2", "3", "4"] as const).map((n) => ({ q: s(`faq.${n}.q`), a: s(`faq.${n}.a`) }))} />

        <Closing line={s("closing")} sub={shared("closingSub")} cta={{ label: shared("startFree"), href: SIGNUP }} pricing={{ label: shared("seePricing"), href: "/pricing" }} />
      </ProductPage>
    </MarketingShell>
  );
}
