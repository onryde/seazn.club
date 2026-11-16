import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { ChaseDemo } from "@/components/marketing/product/chase-demo";
import { chaseDemoLabels } from "@/components/marketing/product/chase-demo-labels";
import { Accent, Closing, DEMO_CLUB_HREF, DEMO_TEAMS, DemoBand, DemoClub, PageHero, PhoneRow, ProductPage, Questions, Road, SplitBand, Ticket } from "@/components/marketing/product/parts";
import { CHASE } from "@/lib/marketing/cricket-chase";
import { BALLS_PER_OVER } from "@/lib/marketing/cricket-chase-rules";
import { RallyDemo } from "@/components/marketing/product/rally-demo";
import { rallyDemoLabels } from "@/components/marketing/product/rally-demo-labels";
import type { ProductImageKey } from "@/lib/marketing/product-images";
import { RALLY_RULES, RALLY_SPORTS, type RallySport } from "@/lib/marketing/rally-rules";
import { GoalDemo } from "@/components/marketing/product/goal-demo";
import { goalDemoLabels } from "@/components/marketing/product/goal-demo-labels";
import { TennisDemo } from "@/components/marketing/product/tennis-demo";
import { tennisDemoLabels } from "@/components/marketing/product/tennis-demo-labels";
import { GOAL_RULES, GOAL_SPORTS, type GoalSport } from "@/lib/marketing/goal-rules";
import { TENNIS_RULES } from "@/lib/marketing/tennis-rules";
import { DEMO_SIDES, SPORT_PAGES, isSportPage, sportKeyOf, type DemoSportKey } from "@/lib/marketing/sport-pages";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale } from "@/lib/i18n-constants";
import { marketingMeta } from "@/lib/seo-meta";

const SIGNUP = "/login?tab=signup";

/** Only the listed sports are pages; the [lang] layout supplies the locales. Anything else is a 404 below. */
export function generateStaticParams() {
  return SPORT_PAGES.map((sport) => ({ sport }));
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string; sport: string }> }): Promise<Metadata> {
  const { lang, sport } = await params;
  if (!hasLocale(lang) || !isSportPage(sport)) return {};
  const d = await getDictionary(lang, "marketing");
  const key = sportKeyOf(sport);
  return marketingMeta({ lang, path: `/sports/${sport}`, title: t(d, `sport.${key}.meta.title`), description: t(d, `sport.${key}.meta.description`) });
}

/**
 * A sport's page: the sport-page shape (docs/superpowers/specs/2026-11-16-product-pages-design.md §4). Cricket's demo
 * is the chase and its body is its own (it carries the app's phone screens and the offline section). Every other sport
 * shares one page body and brings a demo from its family: rally (badminton, table tennis, volleyball), goal (football,
 * hockey, ice hockey) or tennis. Each has its own rules from the engine, its own words and its own pictures.
 *
 * The H1 is the short line; the search words (cricket tournament, scoring, tables) sit in the lede and the <title>.
 * Offline scoring is claimed for the phone app only: it was proven there, and the web pad makes no such promise.
 */
export default async function SportPage({ params }: { params: Promise<{ lang: string; sport: string }> }) {
  const { lang, sport } = await params;
  if (!hasLocale(lang) || !isSportPage(sport)) notFound();
  const d = await getDictionary(lang, "marketing");
  const key = sportKeyOf(sport);
  const s = (k: string, vars?: Record<string, string | number>) => t(d, `sport.${key}.${k}`, vars);
  const shared = (key: string) => t(d, `product.shared.${key}`);
  const app = shared("appName");
  const appSentence = app.charAt(0).toUpperCase() + app.slice(1);

  if (key !== "cricket") {
    const sportKey = key as DemoSportKey;
    const sides = DEMO_SIDES[sportKey];
    const teams = { a: sides.a, b: sides.b };
    const img = (name: "HubM" | "PadM" | "McM" | "McD") => `${sportKey}${name}` as ProductImageKey;
    const demo = (RALLY_SPORTS as readonly string[]).includes(key) ? (
      <RallyDemo labels={rallyDemoLabels(d, key)} teams={teams} others={sides.others} rules={RALLY_RULES[key as RallySport]} />
    ) : (GOAL_SPORTS as readonly string[]).includes(key) ? (
      <GoalDemo labels={goalDemoLabels(d, key, GOAL_RULES[key as GoalSport].card)} teams={teams} others={sides.others} />
    ) : (
      <TennisDemo labels={tennisDemoLabels(d)} teams={teams} others={sides.others} rules={TENNIS_RULES} />
    );
    return (
      <MarketingShell variant="night-scroll" lang={lang}>
        <ProductPage>
          <PageHero
            crumb={s("crumb")}
            title={<Accent text={s("h1")} />}
            lede={s("lede")}
            primary={{ label: s("try"), href: "#try" }}
            secondary={{ label: s("start"), href: SIGNUP }}
          >
            <DemoBand id="try" title={s("demo.title")} note={s("demo.note", teams)}>
              {demo}
            </DemoBand>
          </PageHero>

          <Road
            title={s("road.title")}
            lede={s("road.lede")}
            steps={([["1", "HubM"], ["2", "PadM"], ["3", "McM"]] as const).map(([n, image]) => ({
              heading: s(`road.${n}.h`),
              who: s(`road.${n}.who`),
              body: s(`road.${n}.p`),
              image: img(image),
              caption: s(`road.${n}.cap`),
            }))}
          />

          <Ticket
            title={s("ticket.title")}
            body={s("ticket.body")}
            kicker={s("ticket.kicker")}
            heading={s("ticket.heading")}
            rows={(["scoring", "tables", "formats", "extras"] as const).map((k) => ({ label: s(`ticket.${k}`), value: s(`ticket.${k}V`) }))}
            stub={{ top: s("ticket.stubTop"), big: s("ticket.stubBig"), bottom: s("ticket.stubBottom"), href: "/product/streaming" }}
          />

          <DemoClub title={shared("clubTitle")} text={s("club.text")} image={img("McD")} imageAlt={s("club.alt")} href={DEMO_CLUB_HREF} linkLabel="Seazn Demo Club" />

          <Questions title={shared("questions")} items={(["1", "2", "3", "4", "5"] as const).map((n) => ({ q: s(`faq.${n}.q`), a: s(`faq.${n}.a`) }))} />

          <Closing
            line={s("closing")}
            sub={shared("closingSub")}
            cta={{ label: s("start"), href: SIGNUP }}
            pricing={{ label: shared("seePricing"), href: "/pricing" }}
          />
        </ProductPage>
      </MarketingShell>
    );
  }

  return (
    <MarketingShell variant="night-scroll" lang={lang}>
      <ProductPage>
        <PageHero
          crumb={s("crumb")}
          title={<Accent text={s("h1")} />}
          lede={s("lede")}
          primary={{ label: s("try"), href: "#try" }}
          secondary={{ label: s("start"), href: SIGNUP }}
        >
          <DemoBand id="try" title={s("demo.title")} note={s("demo.note", { team: DEMO_TEAMS.batting, target: CHASE.target })}>
            <ChaseDemo tiles={["pad", "matchCentre", "table", "stream"]} streamControls={false} labels={chaseDemoLabels(d)} teams={DEMO_TEAMS} ballsPerOver={BALLS_PER_OVER} />
          </DemoBand>
        </PageHero>

        <Road
          title={s("road.title")}
          lede={s("road.lede")}
          steps={([["1", "hubM"], ["2", "appPad2"], ["3", "mcM"]] as const).map(([n, image]) => ({
            heading: s(`road.${n}.h`),
            who: s(`road.${n}.who`),
            body: s(`road.${n}.p`),
            image,
            caption: s(`road.${n}.cap`),
          }))}
        />

        <PhoneRow
          title={s("phones.title")}
          lede={s("phones.lede")}
          items={([["1", "appPad2"], ["2", "appOut"], ["3", "appWide"], ["4", "appMore"]] as const).map(([n, image]) => ({
            image,
            heading: s(`phones.${n}.h`),
            body: s(`phones.${n}.p`),
          }))}
        />

        <SplitBand
          section="offline"
          title={s("offline.title")}
          lede={s("offline.lede", { app: appSentence })}
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
          rows={(["scoring", "tables", "rain", "ties"] as const).map((k) => ({ label: s(`ticket.${k}`), value: s(`ticket.${k}V`) }))}
          stub={{ top: s("ticket.stubTop"), big: s("ticket.stubBig"), bottom: s("ticket.stubBottom"), href: "/product/streaming" }}
        />

        <DemoClub title={shared("clubTitle")} text={s("club.text")} image="mcD" imageAlt={s("club.alt")} href={DEMO_CLUB_HREF} linkLabel="Seazn Demo Club" />

        <Questions title={shared("questions")} items={(["1", "2", "3", "4", "5"] as const).map((n) => ({ q: s(`faq.${n}.q`), a: s(`faq.${n}.a`) }))} />

        <Closing
          line={s("closing")}
          sub={shared("closingSub")}
          cta={{ label: s("start"), href: SIGNUP }}
          pricing={{ label: shared("seePricing"), href: "/pricing" }}
        />
      </ProductPage>
    </MarketingShell>
  );
}
