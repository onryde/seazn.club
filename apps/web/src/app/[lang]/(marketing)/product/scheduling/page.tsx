import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { DayBoardDemo } from "@/components/marketing/product/day-board-demo";
import { dayBoardLabels } from "@/components/marketing/product/day-board-labels";
import { RecordedRuns } from "@/components/marketing/product/recorded-runs";
import { Accent, Closing, DemoBand, PageHero, ProductPage, Questions, Road, Ticket } from "@/components/marketing/product/parts";
import { getDictionary, t } from "@/lib/i18n";
import { schedulingRungWeights } from "@/lib/ai-rung";
import { hasLocale } from "@/lib/i18n-constants";
import { pickDictPrefixes } from "@/lib/i18n-subset";
import { marketingMeta } from "@/lib/seo-meta";

const PATH = "/product/scheduling";
const SIGNUP = "/login?tab=signup";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const d = await getDictionary(lang, "marketing");
  return marketingMeta({ lang, path: PATH, title: t(d, "product.scheduling.meta.title"), description: t(d, "product.scheduling.meta.description") });
}

/**
 * Scheduling: the feature-page shape (docs/superpowers/specs/2026-11-16-product-pages-design.md §4). Replaces the old
 * `/scheduling` page (deleted 2026-11-16) as the one the nav links to. The demo is a small model of the schedule board that keeps the
 * board's own two refusals (one match per court per time; nobody in two matches at once) and its 15-minute day shift.
 * Below the steps, the recorded-runs section (carried over from the old page) replays three real scheduler runs.
 * The ticket's plan rows reuse the pricing matrix's own labels.
 */
export default async function SchedulingProductPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const d = await getDictionary(lang, "marketing");
  // The recorded-runs section replays real scheduler runs through the PRODUCT's own trace and diff components, whose
  // copy lives in the `ui` catalogue: only the two prefixes they read are shipped. Rung weights are resolved here
  // because their overrides exist only on the server (#385).
  // `courtPicker.` is the diff panel's fallback court label; `sched.board.court` numbers the recordings' courts.
  const runsDict = {
    ...pickDictPrefixes(d, ["scheduling.aidemo.", "sched.board.court"]),
    ...pickDictPrefixes(await getDictionary(lang, "ui"), ["board.ai.", "board.conflict.", "courtPicker."]),
  };
  const s = (key: string) => t(d, `product.scheduling.${key}`);
  const shared = (key: string) => t(d, `product.shared.${key}`);

  return (
    <MarketingShell variant="night-scroll" lang={lang}>
      <ProductPage>
        <PageHero crumb={s("crumb")} title={<Accent text={s("h1")} />} lede={s("lede")} primary={{ label: s("try"), href: "#try" }} secondary={{ label: shared("startFree"), href: SIGNUP }}>
          <DemoBand id="try" title={s("demo.title")} note={s("demo.note")}>
            <DayBoardDemo labels={dayBoardLabels(d)} />
          </DemoBand>
        </PageHero>

        <Road
          title={s("road.title")}
          lede={s("road.lede")}
          steps={([["1", "schedTrayM"], ["2", "schedRepairM"], ["3", "hubM"]] as const).map(([n, image]) => ({
            heading: s(`road.${n}.h`),
            who: s(`road.${n}.who`),
            body: s(`road.${n}.p`),
            image,
            caption: s(`road.${n}.cap`),
          }))}
        />

        <div data-section="runs">
          <RecordedRuns locale={lang} weights={schedulingRungWeights()} dict={runsDict} title={t(d, "scheduling.aidemo.title")} subtitle={t(d, "scheduling.aidemo.subtitle")} />
        </div>

        <Ticket
          title={s("ticket.title")}
          body={s("ticket.body")}
          kicker={s("ticket.kicker")}
          heading={s("ticket.heading")}
          rows={[t(d, "pricing.matrix.scheduling.board"), t(d, "pricing.matrix.scheduling.constraints"), s("ticket.shift")].map((label) => ({ label, value: s("ticket.included") }))}
          stub={{ top: s("ticket.stubTop"), big: t(d, "pricing.matrix.scheduling.ai"), bottom: s("ticket.stubBottom"), href: "/pricing" }}
        />

        <Questions title={shared("questions")} items={(["1", "2", "3", "4"] as const).map((n) => ({ q: s(`faq.${n}.q`), a: s(`faq.${n}.a`) }))} />

        <Closing line={s("closing")} sub={shared("closingSub")} cta={{ label: shared("startFree"), href: SIGNUP }} pricing={{ label: shared("seePricing"), href: "/pricing" }} />
      </ProductPage>
    </MarketingShell>
  );
}
