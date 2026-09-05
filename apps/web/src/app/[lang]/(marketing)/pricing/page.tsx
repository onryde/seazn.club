import type { Metadata } from "next";
import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { TrackOnMount } from "@/components/analytics-track-mount";
import { EVENTS } from "@/lib/analytics-events";
import {
  buildPricingSections,
  PRICING_PLAN_KEYS,
  PRICING_COLUMN_LABEL_KEY,
  type MatrixData,
  type PricingPlanKey,
} from "@/lib/pricing-matrix";
import { lowestPricedRung, passLadderOptions, PASS_RUNG_MARKETING_KEY } from "@/lib/pass-ladder";
import {
  FREE_FEATURES,
  PASS_FEATURES,
  PRO_FEATURES,
  PASS_CREDIT_GRANT,
} from "@/lib/pricing-cards";
import {
  formatMinor,
  lowestCreditPackAmount,
  PASS_KEYS,
  passPrice,
  proPrice,
  type Currency,
} from "@/lib/currency";
import { feeCrossoverMinor, readableMinor } from "@/lib/pricing-crossover";
import { preferredCurrency } from "@/lib/currency-server";
import { getActiveOrgId, getCurrentUser, getUserOrgs } from "@/lib/auth";
import { pickActiveOrg } from "@/lib/active-org";
import { isPaidPlan, orgPlanKey } from "@/lib/entitlements";
import { passCtaVariant } from "@/lib/pass-cta";
import { CurrencySwitcher } from "@/components/currency-switcher";
import { ProPriceCard } from "@/components/pro-price-card";
import { getDictionary, t } from "@/lib/i18n";
import { hasLocale } from "@/lib/i18n-constants";

// The switcher cookie re-renders prices per request.
export const dynamic = "force-dynamic";

/** Per-column cell styling. A `Record` so a plan added to PRICING_PLAN_KEYS
 *  without a tone is a compile error, not an unstyled column. Both pass rungs
 *  share the lime the Event Pass card uses — they are one offer, two sizes. */
const CELL_TONE: Record<PricingPlanKey, string> = {
  community: "text-slate-500",
  event_pass: "text-[#4d7c0f]",
  event_pass_l: "text-[#4d7c0f]",
  pro: "font-medium text-purple-700",
};

// "proPlus" removed (entitlements v18 — the plan is retired, and its
// {plus}/{plusAnnual}-interpolated answer went with it). The page already
// carries a Contact-us strip under the table (`pricing.enterprise.*`) for
// the above-Pro conversation; a proper FAQ entry for it is W3's redesign,
// not restored here as a stopgap.
const FAQ_KEYS = [
  "card",
  "eventPass",
  "upgraded",
  "trialEnd",
  "fees",
  "groups",
  "currencies",
  "annual",
  "cancel",
] as const;

// `pricing.meta.description` quotes USD amounts deliberately, unlike the page
// body, which honours the currency switcher. Metadata is what a crawler reads,
// and a crawler carries no switcher cookie — it would always resolve to the
// USD default anyway, so reading the cookie here would buy nothing and make the
// <meta> vary per visitor for no SEO gain. One canonical currency, kept
// accurate: the amounts must be re-checked whenever stripe-plans.json moves.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const d = await getDictionary(lang, "marketing");
  return {
    title: t(d, "pricing.meta.title"),
    description: t(d, "pricing.meta.description"),
    alternates: {
      canonical: `/${lang}/pricing`,
      languages: {
        ...Object.fromEntries(["en", "fr", "es", "nl"].map((l) => [l, `/${l}/pricing`])),
        "x-default": "/en/pricing",
      },
    },
  };
}

/**
 * Resolve the viewer's Event Pass call-to-action.
 *
 * The plan comes from `orgPlanKey` + `isPaidPlan` — the entitlement resolver's
 * own derivation — so "what we sell here" cannot drift from "what we grant".
 * A user with no org yet reads as community: they are one signup step from one.
 */
async function passColumnCta(): Promise<ReturnType<typeof passCtaVariant>> {
  const user = await getCurrentUser();
  if (!user) return passCtaVariant({ signedIn: false, paidPlan: false });
  const orgs = await getUserOrgs(user.id);
  // No path segment to read on a marketing page — the cookie is all there is.
  const active = pickActiveOrg(orgs, { cookieOrgId: await getActiveOrgId() });
  const paidPlan = active ? isPaidPlan(await orgPlanKey(active.id)) : false;
  return passCtaVariant({ signedIn: true, paidPlan });
}

async function loadMatrix(): Promise<MatrixData> {
  const rows = await sql<
    { plan_key: string; feature_key: string; bool_value: boolean | null; int_value: number | null }[]
  >`
    select plan_key, feature_key, bool_value, int_value
    from plan_entitlements
    where plan_key = any(${[...PRICING_PLAN_KEYS]})`;
  const data: MatrixData = {};
  for (const r of rows) {
    (data[r.feature_key] ??= {})[r.plan_key] = {
      bool_value: r.bool_value,
      int_value: r.int_value,
    };
  }
  return data;
}

export default async function PricingPage({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const d = await getDictionary(lang, "marketing");

  const currency: Currency = await preferredCurrency(null);
  // The comparison table AND the per-card credit lines render from
  // plan_entitlements so marketing can never drift from what the resolver
  // enforces (spec 2026-07-18 pro-plus-tier §5; v17 SPEC-6 A1 for credits). DB
  // may be unreachable at build: fail soft to an empty table.
  const matrix: MatrixData = await loadMatrix().catch(() => ({}));
  const sections = buildPricingSections(matrix);

  // v17 AI credit wallet (SPEC-6 A1): each plan's monthly grant is the live
  // `ai.credits.monthly` value — the same single source the wallet meters
  // against — so the marketing number cannot drift. The Event Pass adds a
  // one-time top-up (PASS_CREDIT_GRANT, per rung); it has no monthly matrix row.
  const creditsMonthly = (plan: string): number | null =>
    matrix["ai.credits.monthly"]?.[plan]?.int_value ?? null;
  const communityCredits = creditsMonthly("community");
  const proCredits = creditsMonthly("pro");
  const communityCreditsLine =
    communityCredits != null ? t(d, "pricing.credits.perMonth", { count: communityCredits }) : null;
  // W2 T5 (design R9): the top-up is sized by rung, so this chip names both.
  // It is rendered UNCONDITIONALLY — unlike the ladder below it, which is
  // suppressed when `loadMatrix` fails soft — so a single `{count}` here would
  // be the one credit figure a buyer sees, and it advertised M's 25 beside L's
  // price. Both numbers are interpolated from `PASS_CREDIT_GRANT`, so a
  // repricing moves the copy with the declaration.
  const passCreditsLine = t(d, "pricing.credits.passGrant", {
    m: PASS_CREDIT_GRANT.event_pass,
    l: PASS_CREDIT_GRANT.event_pass_l,
  });
  const proCreditsLine =
    proCredits != null ? t(d, "pricing.credits.perMonth", { count: proCredits }) : null;

  const passLabel = formatMinor(passPrice(currency, "event_pass"), currency);
  const passLLabel = formatMinor(passPrice(currency, "event_pass_l"), currency);

  // The M/L ladder on the Event Pass card. Prices come from stripe-plans.json;
  // the CAPS come from the same `matrix` the comparison table below renders
  // from, so the card and the table can never quote different limits for the
  // same rung (the whole reason lib/pass-ladder.ts takes caps as an argument).
  //
  // Rendered only when every figure is real. `loadMatrix` fails soft to `{}`
  // when the DB is unreachable at build, and a null `int_value` legitimately
  // means UNLIMITED — so a missing row read through `?? null` would advertise
  // an unlimited pass. Absence must suppress the block, not embellish it.
  const rungCap = (feature: string, plan: string): number | null | undefined =>
    matrix[feature]?.[plan]?.int_value;
  const passLadder = (["event_pass", "event_pass_l"] as const).every(
    (k) =>
      matrix["entrants.per_division.max"]?.[k] !== undefined &&
      typeof rungCap("divisions.per_competition.max", k) === "number",
  )
    ? passLadderOptions(currency, {
        event_pass: {
          entrants: rungCap("entrants.per_division.max", "event_pass") ?? null,
          divisions: rungCap("divisions.per_competition.max", "event_pass") ?? null,
        },
        event_pass_l: {
          entrants: rungCap("entrants.per_division.max", "event_pass_l") ?? null,
          divisions: rungCap("divisions.per_competition.max", "event_pass_l") ?? null,
        },
      })
    : null;
  // Who is reading the Event Pass column? An anonymous visitor still gets the
  // signup path; a signed-in organiser gets handed to their competition list,
  // which is the only place a pass can actually be bought. The nav on this very
  // page already resolves the viewer this way (MarketingNav → /dashboard).
  // Fail soft to the anonymous column — a marketing page must render even if
  // the session or the plan read is unavailable.
  const passCta = await passColumnCta().catch(() => "signup" as const);
  const proMonthly = formatMinor(proPrice("monthly", currency), currency);

  // WHERE THE TWO OFFERS CROSS (lib/pricing-crossover.ts). The pass is cheaper
  // up front and dearer per pound of entry fees, so for a competition that runs
  // a month the two cost the same at exactly one volume — and the page never
  // said so. Read plainly it said "the pass is cheaper", which is true only
  // below that point and pushes volume at the ONE-TIME sku when the recurring
  // one is what retains.
  //
  // Every input is live: the two prices from the same `stripe-plans.json` the
  // cards above quote, both fee rates from the `matrix` the comparison table
  // below renders from. The line disappears rather than misleads when a rate is
  // unreadable or the ladder stops having a crossing at all — the same rule the
  // M/L ladder above follows for a cap it does not have.
  const feePercent = (plan: string): number | null | undefined =>
    matrix["registration.fee_percent"]?.[plan]?.int_value;
  const proFeePercent = feePercent("pro");
  // WHICH RUNG the sentence is about is the SAME value as the rung the number
  // is derived from, because it is read once. The line used to solve for
  // `event_pass` and then say "this is the cheaper option" on a card that sells
  // BOTH rungs — and it is not true of L: at 4499 against a month of Pro at
  // 1499, L is dearer up front AND dearer per pound of entry fees, so there is
  // no volume at which the two cross. `feeCrossoverMinor` says so itself
  // (`null` for that shape); the sentence was simply printed beside it anyway.
  // The entry rung is the honest subject: it is the cheapest, it is what the
  // in-app picker pre-selects, and it is the only one the crossing exists for.
  const crossoverRung = lowestPricedRung(
    PASS_KEYS.map((key) => ({ key, amountMinor: passPrice(currency, key) })),
  );
  const passFeePercent = feePercent(crossoverRung.key);
  const crossoverMinor = feeCrossoverMinor({
    passMinor: crossoverRung.amountMinor,
    proMonthlyMinor: proPrice("monthly", currency),
    passFeePercent,
    proFeePercent,
  });
  const crossoverReadable = crossoverMinor === null ? 0 : readableMinor(crossoverMinor);
  const crossoverLine =
    crossoverReadable > 0
      ? t(d, "pricing.pass.crossover", {
          amount: formatMinor(crossoverReadable, currency),
          pro: proMonthly,
          // The rung the claim is scoped to — its ladder label and its price,
          // the two things the list directly above the line shows it by.
          rung: t(d, PASS_RUNG_MARKETING_KEY[crossoverRung.key]),
          pass: formatMinor(crossoverRung.amountMinor, currency),
          // Non-null wherever `crossoverMinor` is: `feeCrossoverMinor` returns
          // null unless both rates are numbers. Narrowed rather than defaulted,
          // so a rate that went missing can never render as a rate of 0.
          proFee: proFeePercent as number,
          passFee: passFeePercent as number,
        })
      : null;

  // The FAQ used to hardcode "$19/mo" while the cards above it honoured the
  // currency switcher — a GBP visitor saw £ and $ on one page. Every answer is
  // interpolated with the same switched amounts instead; `t()` leaves an answer
  // without placeholders untouched, so only the ones that quote a price change.
  // `plus`/`plusAnnual` dropped with the Pro Plus card (entitlements v18).
  const faqVars = {
    pass: passLabel,
    passL: passLLabel,
    pro: proMonthly,
    proAnnual: formatMinor(proPrice("annual", currency), currency),
  };

  // Most matrix cells are locale-free literals (numbers, ∞, ✓, —); only the
  // "passedEvent" prose cell is a real dict key (see lib/pricing-matrix).
  const cellText = (value: string): string =>
    value.startsWith("pricing.matrix.") ? t(d, value) : value;

  return (
    <>
      <TrackOnMount event={EVENTS.PRICING_VIEWED} />
      <MarketingShell lang={lang}>
        <main>
          <section className="mx-auto max-w-5xl px-4 pb-14 pt-16 text-center">
            <p className="mk-eyebrow mb-3 justify-center">{t(d, "pricing.eyebrow")}</p>
            <h1 className="mk-display mb-3 text-5xl font-bold text-purple-950 sm:text-6xl">
              {t(d, "pricing.title")}
            </h1>
            <p className="text-lg text-slate-600">{t(d, "pricing.subhead")}</p>
            <div className="mt-6 flex justify-center">
              <CurrencySwitcher current={currency} />
            </div>
          </section>

          {/* Three offers — entitlements v18: Community / Event Pass / Pro.
              The Pro Plus card that used to sit here is retired along with
              the plan (V392); the above-Pro conversation is now the
              Contact-us strip under the comparison table below, per design
              §4 — a redesigned ticket-styled layout is W3's, this interim
              grid just stops rendering a fourth card for a plan that no
              longer exists. Each card still carries the two v17
              differentiators (fee % + the credit line). Stacks on mobile,
              3-up on desktop — no horizontal scroll at 375px. */}
          <section className="mx-auto max-w-6xl px-4 pb-20">
            <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
              {/* Community */}
              <div className="card flex flex-col p-8">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  {t(d, "pricing.community.name")}
                </p>
                <p className="mb-1 text-4xl font-bold text-slate-900">
                  {t(d, "pricing.community.price")}
                </p>
                <p className="mb-4 text-sm text-slate-500">{t(d, "pricing.community.note")}</p>
                {communityCreditsLine && (
                  <p className="mb-4 flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700">
                    <span aria-hidden>⚡</span>
                    {communityCreditsLine}
                  </p>
                )}
                <ul className="mb-8 flex-1 space-y-2.5 text-sm text-slate-600">
                  {FREE_FEATURES.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <span className="mt-0.5 text-emerald-500">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
                <Link href="/login?tab=signup" className="btn btn-ghost w-full justify-center py-3">
                  {t(d, "pricing.community.cta")}
                </Link>
              </div>

              {/* Event Pass */}
              <div className="card flex flex-col border-[#b5d977] bg-[#f7fce9] p-8">
                <p className="mk-display mb-1 text-xs font-semibold tracking-[0.18em] text-[#4d7c0f]">
                  {t(d, "pricing.pass.name")}
                </p>
                {/* "from", because the pass is a ladder: $29 is the floor, not
                    the price. The two rungs are laid out below so a buyer sees
                    the difference without clicking through to a competition. */}
                <p className="mb-1 text-4xl font-bold text-slate-900">
                  <span className="mr-1.5 align-middle text-sm font-semibold uppercase tracking-wider text-slate-400">
                    {t(d, "pricing.pass.from")}
                  </span>
                  {passLabel}
                  <span className="text-lg font-normal text-slate-500">
                    {t(d, "pricing.pass.per")}
                  </span>
                </p>
                <p className="mb-4 text-sm text-slate-500">{t(d, "pricing.pass.note")}</p>
                {/* The ladder, led by the entrant/division difference — the
                    only thing that differs between the rungs — in the same
                    order and shape as the in-app picker (spec A7). No "best
                    value" badge and no multiplier claim: L/M is 2.03× in USD
                    but 1.96× in GBP, so any "double" framing is false
                    somewhere. */}
                {passLadder && (
                  <ul className="mb-4 space-y-1.5" data-pass-ladder>
                    {passLadder.map((o) => (
                      <li
                        key={o.key}
                        className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg bg-white/70 px-3 py-2"
                      >
                        <span className="min-w-4 text-sm font-bold text-[#4d7c0f]">
                          {t(d, PASS_RUNG_MARKETING_KEY[o.key])}
                        </span>
                        <span className="text-sm font-semibold text-slate-900">
                          {formatMinor(o.amountMinor, currency)}
                        </span>
                        {/* Always its own line. `sm:` is a VIEWPORT breakpoint,
                            not a container one, so letting this sit inline on a
                            wide screen still wraps it mid-phrase inside a card
                            this narrow ("128 entrants / each"). */}
                        <span className="basis-full text-xs text-slate-500">
                          {o.entrants === null
                            ? t(d, "pricing.pass.ladder.capsUnlimited", {
                                divisions: o.divisions ?? "",
                              })
                            : t(d, "pricing.pass.ladder.caps", {
                                divisions: o.divisions ?? "",
                                entrants: o.entrants,
                              })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mb-4 flex items-center gap-1.5 rounded-lg bg-[#eaf6cf] px-3 py-2 text-sm font-semibold text-[#4d7c0f]">
                  <span aria-hidden>⚡</span>
                  {passCreditsLine}
                </p>
                {passLadder && (
                  <p className="mb-4 text-xs text-slate-500">{t(d, "pricing.pass.ladderNote")}</p>
                )}
                {/* The comparator, on the pass card rather than beside Pro:
                    this is where the buyer is choosing, and the mis-sale this
                    prevents is choosing the pass for a competition big enough
                    that Pro is cheaper. */}
                {crossoverLine && (
                  <p className="mb-4 text-xs text-slate-500" data-pass-crossover>
                    {crossoverLine}
                  </p>
                )}
                <ul className="mb-8 flex-1 space-y-2.5 text-sm text-slate-600">
                  {PASS_FEATURES.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <span className="mt-0.5 text-[#4d7c0f]">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
                {/* Three readers, three honest endings (task 19, spec D3).
                    `included` is not a disabled button: a paying customer is
                    not being refused, the offer simply does not apply to
                    them — Pro already exceeds every key the pass lifts. */}
                {passCta === "included" ? (
                  <p
                    data-pass-column-cta="included"
                    className="rounded-xl bg-white/70 px-4 py-3 text-center text-sm font-medium text-[#4d7c0f]"
                  >
                    {t(d, "pricing.pass.included")}
                  </p>
                ) : (
                  <Link
                    href={passCta === "console" ? "/dashboard" : "/login?tab=signup"}
                    data-pass-column-cta={passCta}
                    className="btn btn-ghost w-full justify-center border-amber-300 py-3 hover:bg-amber-100"
                  >
                    {passCta === "console"
                      ? t(d, "pricing.pass.ctaSignedIn")
                      : t(d, "pricing.pass.cta")}
                  </Link>
                )}
              </div>

              {/* Pro — annual toggle default-on */}
              <ProPriceCard
                monthly={proMonthly}
                annualPerMonth={formatMinor(Math.round(proPrice("annual", currency) / 12), currency)}
                annualTotal={formatMinor(proPrice("annual", currency), currency)}
                features={PRO_FEATURES}
                creditsLine={proCreditsLine ?? undefined}
                ctaLabel={t(d, "pricing.plus.cta")}
              />
            </div>

            {/* Add-ons strip (SPEC-6 A1): the recurring + one-time extras sit
                beneath the tier ladder. Non-committal labels — the actual
                purchase surfaces are later SPEC-6 billing tabs — so these are
                static, not links, and never gate money. */}
            <div className="mt-8 rounded-2xl border border-purple-100 bg-purple-50/60 px-6 py-4">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-slate-600">
                <span className="text-xs font-semibold uppercase tracking-wider text-purple-500">
                  {t(d, "pricing.addons.label")}
                </span>
                <span className="flex items-center gap-1.5">
                  <span aria-hidden>⚡</span>
                  {/* fix round 2: this line hardcoded "$10" in all four
                      locales while every other price on the page honours the
                      CurrencySwitcher. The seed's cheapest pack was eur 900 /
                      gbp 800 / inr 79900 then and is eur 900 / gbp 800 /
                      inr 39900 now, so the literal was false in three of
                      four currencies — #191's defect, again. The point of
                      deriving it is that this comment can go stale and the
                      rendered price cannot. */}
                  {t(d, "pricing.addons.credits", {
                    price: formatMinor(lowestCreditPackAmount(currency), currency),
                  })}
                </span>
                <span className="flex items-center gap-1.5">
                  <span aria-hidden>＋</span>
                  {t(d, "pricing.addons.org")}
                </span>
                <span className="flex items-center gap-1.5">
                  <span aria-hidden>⤢</span>
                  {t(d, "pricing.addons.sizePack")}
                </span>
              </div>
            </div>

            {/* Feature comparison table — rendered from plan_entitlements,
                grouped into ENTITLEMENT_DOMAINS sections. Columns come from
                PRICING_PLAN_KEYS, the same tuple `loadMatrix` selects on, so a
                plan can never be read from the database and then have nowhere
                to render. Wider than the card grid on purpose: the Event Pass
                is one card and two columns, because the rungs differ in the
                only two rows a buyer chooses between. */}
            {sections.length > 0 && (
              <div className="scroll-x scroll-x-fade mt-12 rounded-2xl border border-purple-100 bg-white">
                <table className="table w-full" data-pricing-matrix>
                  <thead>
                    <tr>
                      <th className="py-3 text-left">{t(d, "pricing.table.feature")}</th>
                      {PRICING_PLAN_KEYS.map((plan) => (
                        <th key={plan} className="py-3 text-center whitespace-nowrap">
                          {t(d, PRICING_COLUMN_LABEL_KEY[plan])}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="text-sm">
                    {sections.map((section) => (
                      <Fragment key={section.labelKey}>
                        <tr>
                          <td
                            colSpan={PRICING_PLAN_KEYS.length + 1}
                            className="bg-purple-50/60 pt-5 pb-1.5 text-xs font-semibold uppercase tracking-wider text-purple-500"
                          >
                            {t(d, section.labelKey)}
                          </td>
                        </tr>
                        {section.rows.map((r) => (
                          <tr key={r.labelKey}>
                            <td className="font-medium text-slate-700">
                              {t(d, r.labelKey)}
                              {/* A count that is really a price gets a second
                                  line, so the number is never read as an
                                  allowance (billing groups, spec 2026-07-21). */}
                              {r.noteKey && (
                                <span className="mt-0.5 block text-xs font-normal text-slate-500">
                                  {t(d, r.noteKey)}
                                </span>
                              )}
                            </td>
                            {/* `whitespace-nowrap` because a sixth column
                                narrows every one of them: at 375px the folded
                                fee cell broke across two lines as "✓" / "2%".
                                The region already scrolls horizontally, so a
                                cell staying on one line costs nothing and a
                                split percentage is unreadable. */}
                            {PRICING_PLAN_KEYS.map((plan) => (
                              <td
                                key={plan}
                                className={`whitespace-nowrap text-center ${CELL_TONE[plan]}`}
                              >
                                {cellText(r.cells[plan])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="mt-6 text-center text-sm text-slate-500">
              {t(d, "pricing.enterprise.text")}{" "}
              <a href="mailto:hello@seazn.club" className="font-medium text-purple-700 underline">
                {t(d, "pricing.enterprise.link")}
              </a>
              .
            </p>
          </section>

          {/* FAQ */}
          <section className="bg-purple-50 py-16">
            <div className="mx-auto max-w-3xl px-4">
              <h2 className="mb-10 text-center text-2xl font-bold text-purple-900">
                {t(d, "pricing.faq.heading")}
              </h2>
              <div className="space-y-6">
                {FAQ_KEYS.map((k) => (
                  <div key={k} className="card p-6">
                    <h3 className="mb-2 font-semibold text-slate-800">
                      {t(d, `pricing.faq.${k}.q`)}
                    </h3>
                    <p className="text-sm text-slate-600">{t(d, `pricing.faq.${k}.a`, faqVars)}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="bg-purple-900 py-14 text-center text-white">
            <h2 className="mb-3 text-2xl font-bold">{t(d, "pricing.final.title")}</h2>
            <p className="mb-6 text-purple-200">{t(d, "pricing.final.subhead")}</p>
            <Link
              href="/login?tab=signup"
              className="btn bg-white px-8 py-3 text-base font-semibold text-purple-900 hover:bg-purple-50"
            >
              {t(d, "pricing.final.cta")}
            </Link>
          </section>
        </main>
      </MarketingShell>
    </>
  );
}
