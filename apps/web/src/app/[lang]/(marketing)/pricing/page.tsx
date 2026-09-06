import type { Metadata } from "next";
import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
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
import { lowestPricedRung, PASS_RUNG_MARKETING_KEY } from "@/lib/pass-ladder";
import { PRICING_RAIL_SPORTS, pricingRailKey, PRICING_RAIL_FOOTER_KEY } from "@/lib/pricing-rail";
import {
  FREE_CARD_BULLETS,
  PASS_CARD_BULLETS,
  PRO_CARD_BULLETS,
  PASS_CREDIT_GRANT,
  cardBullets,
} from "@/lib/pricing-cards";
import { loadPricingMatrix } from "@/lib/pricing-matrix-server";
import {
  formatMinor,
  lowestCreditPackAmount,
  SELLABLE_PASS_KEYS,
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
 *  without a tone is a compile error, not an unstyled column. Every pass rung
 *  takes the lime the Event Pass card uses — one offer, however many sizes. */
const CELL_TONE: Record<PricingPlanKey, string> = {
  community: "text-slate-500",
  event_pass: "text-[#4d7c0f]",
  pro: "font-medium text-purple-700",
};

// "proPlus" removed (entitlements v18 — the plan is retired, and its
// {plus}/{plusAnnual}-interpolated answer went with it). The page already
// carries a Contact-us strip under the table (`pricing.enterprise.*`) for
// the above-Pro conversation; a proper FAQ entry for it is W3's redesign,
// not restored here as a stopgap.
// W3 fix round 2 (item 6): `platformFee` is a DEDICATED entry — the existing
// `fees` answer only covers the rates inside "Can I charge entry fees?",
// which nobody scans looking for the fee itself. Rendered CONDITIONALLY
// (see `platformFeeReadable` below): its rates are interpolated live from
// the same matrix the fee pills and comparison table read, and absence must
// suppress the entry rather than print an unfilled `{communityFee}`
// placeholder.
const FAQ_KEYS = [
  "card",
  "eventPass",
  "upgraded",
  "trialEnd",
  "fees",
  "platformFee",
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
  const matrix: MatrixData = await loadPricingMatrix().catch(() => ({}));
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
  // W2 T5 (design R9): the top-up is sized by rung. The chip used to name both
  // rungs' grants because the card sold both; with the L rung off sale
  // (2026-09-05) it names the grant of the rung actually being offered — the
  // cheapest one on sale, the same rung the headline price quotes, so the two
  // figures on this card are about the same product.
  const offeredRung = lowestPricedRung(
    SELLABLE_PASS_KEYS.map((key) => ({ key, amountMinor: passPrice(currency, key) })),
  );
  const passCreditsLine = t(d, "pricing.credits.passGrant", {
    count: PASS_CREDIT_GRANT[offeredRung.key],
  });
  const proCreditsLine =
    proCredits != null ? t(d, "pricing.credits.perMonth", { count: proCredits }) : null;

  const passLabel = formatMinor(passPrice(currency, "event_pass"), currency);

  // The fee-percent pill Free and Pro cards both print (R14 composition —
  // the mockup repeats this pill across every offer). Absence must suppress
  // it, never render a hole: `feeCell`'s own "—" is a matrix-table concept,
  // not something a marketing pill should ever say.
  const feePercent = (plan: string): number | null | undefined =>
    matrix["registration.fee_percent"]?.[plan]?.int_value;
  const feePill = (plan: string): string | null => {
    const fee = feePercent(plan);
    return typeof fee === "number" ? t(d, "pricing.card.feePill", { fee }) : null;
  };

  // ── R14 stub slot 1: Size M — its price, caps, and one-time credit grant.
  // Every figure read from the SAME matrix/catalogue the comparison table
  // renders from; nothing here is typed. `divisions` must be a NUMBER (the
  // copy reads "{divisions} divisions ×…") while `entrants` may legitimately
  // be null (unlimited) — the same asymmetry the old M/L ladder pinned.
  const rungCap = (feature: string, plan: string): number | null | undefined =>
    matrix[feature]?.[plan]?.int_value;
  const stubDivisions = rungCap("divisions.per_competition.max", offeredRung.key);
  const stubEntrants = rungCap("entrants.per_division.max", offeredRung.key);
  const stubCapsLine =
    typeof stubDivisions === "number" && stubEntrants !== undefined
      ? stubEntrants === null
        ? t(d, "pricing.pass.stub.capsUnlimited", { divisions: stubDivisions })
        : t(d, "pricing.pass.stub.caps", { divisions: stubDivisions, entrants: stubEntrants })
      : null;

  // Who is reading the Event Pass column? An anonymous visitor still gets the
  // signup path; a signed-in organiser gets handed to their competition list,
  // which is the only place a pass can actually be bought. The nav on this very
  // page already resolves the viewer this way (MarketingNav → /dashboard).
  // Fail soft to the anonymous column — a marketing page must render even if
  // the session or the plan read is unavailable.
  const passCta = await passColumnCta().catch(() => "signup" as const);
  const proMonthly = formatMinor(proPrice("monthly", currency), currency);

  // ── R14 stub slot 2: where Pro overtakes the Event Pass (owner-approved
  // composition, decided this session — discharges gap #4 of 2026-09-04).
  // The mockup's stub was a two-rung M/L comparison; L is off sale, so the
  // second slot is this crossover instead, derived live from
  // lib/pricing-crossover.ts. Every input is a live read (stripe-plans.json
  // prices, `registration.fee_percent`); the line disappears rather than
  // misleads when a rate is unreadable or the ladder has no crossing at all —
  // the same rule the old ladder followed for a cap it did not have.
  const proFeePercent = feePercent("pro");
  const passFeePercent = feePercent(offeredRung.key);
  // W3 fix round 2 (item 6): the three live rates the new Platform fee FAQ
  // entry names — read once here so the FAQ, the fee pills and the crossover
  // comparator can never quote different numbers for the same plan.
  const communityFeePercent = feePercent("community");
  const platformFeeReadable =
    typeof communityFeePercent === "number" &&
    typeof passFeePercent === "number" &&
    typeof proFeePercent === "number";
  const crossoverMinor = feeCrossoverMinor({
    passMinor: offeredRung.amountMinor,
    proMonthlyMinor: proPrice("monthly", currency),
    passFeePercent,
    proFeePercent,
  });
  const crossoverReadable = crossoverMinor === null ? 0 : readableMinor(crossoverMinor);
  // The FULL correctness-hardened sentence (pricing.pass.crossover), not a
  // shorter paraphrase: `pricing-crossover.test.ts`'s "states its own
  // assumption" guard exists precisely because an unscoped short line — "Pro
  // is cheaper above {amount}" — is the wording that shipped once already and
  // recommended the wrong offer for a season (it omits that the crossing is a
  // ONE-MONTH crossing) and the wrong rung once after that (the card sells one
  // rung on sale, but a bare "the pass" reads as a claim about the whole
  // Event Pass column, which is false of the hidden L rung). Reusing this
  // key, verbatim, in the stub rather than inventing a shorter one keeps both
  // lessons enforced instead of reintroducing the defect they were written
  // for. `pass-cards-i18n.test.ts` and `pricing-crossover.test.ts` both pin
  // this key's wording; changing it here would change it there too.
  const crossoverStubLine =
    crossoverReadable > 0
      ? t(d, "pricing.pass.crossover", {
          amount: formatMinor(crossoverReadable, currency),
          pro: proMonthly,
          rung: t(d, PASS_RUNG_MARKETING_KEY[offeredRung.key]),
          pass: passLabel,
          // Non-null wherever `crossoverMinor` is: `feeCrossoverMinor` returns
          // null unless both rates are numbers. Narrowed rather than
          // defaulted, so a rate that went missing can never render as 0%.
          proFee: proFeePercent as number,
          passFee: passFeePercent as number,
        })
      : null;

  // The FAQ used to hardcode "$19/mo" while the cards above it honoured the
  // currency switcher — a GBP visitor saw £ and $ on one page. Every answer is
  // interpolated with the same switched amounts instead; `t()` leaves an answer
  // without placeholders untouched, so only the ones that quote a price change.
  // `plus`/`plusAnnual` dropped with the Pro Plus card (entitlements v18).
  // `passL` dropped with the L rung's copy (2026-09-05): the Event Pass answer
  // no longer describes two sizes, so nothing interpolates it.
  const faqVars = {
    pass: passLabel,
    pro: proMonthly,
    proAnnual: formatMinor(proPrice("annual", currency), currency),
    // Read only by `pricing.faq.platformFee.a`, and only rendered when
    // `platformFeeReadable` is true (see the FAQ_KEYS filter below) — the
    // `?? 0` here is unreachable in practice, never a rendered "0%".
    communityFee: communityFeePercent ?? 0,
    passFee: passFeePercent ?? 0,
    proFee: proFeePercent ?? 0,
  };

  // Most matrix cells are locale-free literals (numbers, ∞, ✓, —); only the
  // "passedEvent" prose cell is a real dict key (see lib/pricing-matrix).
  const cellText = (value: string): string =>
    value.startsWith("pricing.matrix.") ? t(d, value) : value;

  // The pass card's CTA — one Link, reused both on the stub (always) and at
  // the ticket's foot on phone (the phone-only repeat action, md:hidden). No
  // repeat for `included`: there is no buy action to repeat for a paying org.
  const passCtaLabel =
    passCta === "console" ? t(d, "pricing.pass.ctaSignedIn") : t(d, "pricing.pass.cta");
  const passCtaHref = passCta === "console" ? "/dashboard" : "/login?tab=signup";

  return (
    <>
      <TrackOnMount event={EVENTS.PRICING_VIEWED} />
      <MarketingShell lang={lang}>
        <main>
          {/* ══ Box office marquee (R14) ═══════════════════════════════════
              A night band, matching the home page's own marquee/finale
              sections — the eyebrow, the promise, and the sport board that
              answers "which sports?" without an eleventh "and more" line. */}
          <section className="relative overflow-hidden bg-[linear-gradient(180deg,var(--mk-night-2),var(--mk-night))] px-4 pb-10 pt-16 text-cream sm:pb-14 sm:pt-20">
            <div className="mx-auto max-w-6xl">
              <p className="mk-display mb-3 text-xs font-medium tracking-[0.22em] text-lime-400">
                {t(d, "pricing.eyebrow")}
              </p>
              <h1 className="mk-display max-w-[16ch] text-4xl font-bold leading-[0.95] text-cream sm:text-6xl">
                {t(d, "pricing.title")}
              </h1>
              <p className="mt-4 max-w-[56ch] text-base leading-relaxed text-[#bdb4e2] sm:text-lg">
                {t(d, "pricing.subhead")}
              </p>

              {/* The board: ten sports in hairline-ruled slots, `generic` as
                  the foot line rather than an eleventh sport. A wrapping
                  ribbon at 320, 5×2 from 768, ten across from 1280 — a
                  different DEVICE per width, not one narrowed. */}
              <ul
                className="pr-board mt-7 divide-x divide-y divide-[rgb(124,58,237,0.35)] overflow-hidden rounded-lg border border-[rgb(124,58,237,0.35)] bg-[#100827]"
                data-pricing-rail
              >
                {PRICING_RAIL_SPORTS.map((sport) => (
                  <li
                    key={sport}
                    data-rail-sport={sport}
                    className="mk-cond px-3 py-2.5 text-[15px] leading-tight text-[#ded7f5] sm:text-sm"
                  >
                    {t(d, pricingRailKey(sport))}
                  </li>
                ))}
                <li
                  data-rail-footer
                  className="col-span-full px-3 py-2 text-xs leading-snug text-[#a99ad4]"
                >
                  {t(d, PRICING_RAIL_FOOTER_KEY)}
                </li>
              </ul>
            </div>
          </section>

          {/* Currency switcher — its own light strip. The component's own
              colours assume a light background (shared with Settings →
              Preferences), so it sits just off the night band rather than
              inside it. */}
          <div className="border-b border-purple-100 bg-white py-3">
            <div className="mx-auto flex max-w-6xl justify-center px-4">
              <CurrencySwitcher current={currency} label={t(d, "pricing.currency.label")} />
            </div>
          </div>

          {/* ══ The counter (R14): a real ticket, then the two subscribe-or-
              not offers, then the enterprise strip — all on one night band,
              matching the marquee above. ══ */}
          <section className="bg-[linear-gradient(180deg,var(--mk-night),var(--mk-night-2))] px-4 pb-16 pt-12 sm:pt-14">
            <div className="mx-auto max-w-6xl">
              {/* ══ EVENT PASS — the hero: a real ticket with a tear-off stub.
                  Portrait at 320 (stub across the top, tear horizontal),
                  landscape from 768 (stub down the right, tear vertical) —
                  one DOM, branched by `.pr-pass`'s CSS grid. ══ */}
              <article className="relative mb-8 min-w-0 overflow-hidden rounded-2xl bg-cream text-night shadow-[0_0_0_1px_rgba(163,230,53,0.35),0_26px_70px_-28px_rgba(163,230,53,0.55),0_10px_40px_-20px_rgba(124,58,237,0.7)] sm:mb-10">
                <div className="pr-pass">
                  {/* head — the promise, above the stub on phone, top of the
                      left column on desktop. */}
                  <div className="pr-pass-head min-w-0 px-6 pb-5 pt-7 sm:px-8 md:pb-0 md:pt-9">
                    <p className="mk-display mb-2 text-[13px] font-semibold tracking-[0.26em] text-[#4d7c0f]">
                      {t(d, "pricing.pass.name")}
                    </p>
                    <p className="max-w-[48ch] text-[0.9375rem] leading-snug text-[#5a4b78]">
                      {t(d, "pricing.pass.note")}
                    </p>
                  </div>

                  {/* the lit tear-off stub: serial, ADMIT ONE, the M rung and
                      the pass/Pro crossover, and the buy action. */}
                  <div
                    className="pr-pass-stub relative min-w-0 bg-[linear-gradient(158deg,var(--mk-night-2),var(--mk-night))] px-6 pb-7 pt-5 text-cream sm:px-7 md:pr-12 md:pt-8"
                    data-pass-stub
                  >
                    <p
                      aria-hidden
                      className="mk-cond mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-[#3b2a6e] pb-3 text-[10.5px] tracking-[0.16em] text-[#9a8cc9] md:mb-5 md:block md:border-0 md:pb-0"
                    >
                      <span>№ 0001</span>
                      <span className="md:block">ADMIT ONE COMPETITION</span>
                    </p>

                    {/* W3 fix round 2 (item 1): ALWAYS one column. With the L
                        rung off sale, slot 2 is the crossover PARAGRAPH, not a
                        second short price — a 2-up phone layout squeezed it
                        into an 84px column and produced 22 wrapped lines. Two
                        full-width row cards, stacked, at every width this stub
                        grid renders at (phone AND the narrow desktop stub
                        column) — never a side-by-side comparison. */}
                    <div className="grid grid-cols-1 gap-3 md:gap-4">
                      <div
                        className="rounded-xl border border-[#3b2a6e] bg-black/25 px-3.5 py-3"
                        data-pass-stub-slot="m"
                      >
                        <p className="mk-cond text-[12.5px] font-semibold tracking-[0.22em] text-lime-400">
                          {t(d, "pricing.pass.stub.label")}
                        </p>
                        {/* W3 fix round 2 (item 1): `whitespace-nowrap` keeps
                            the price and its "/ event" qualifier on one
                            line — it used to orphan onto its own line two
                            lines below the number. */}
                        <p
                          data-pass-price
                          className="mk-cond mt-0.5 whitespace-nowrap text-[2.25rem] font-bold leading-[0.95] text-cream"
                        >
                          {passLabel}
                          <span className="text-sm font-normal text-[#bdb4e2]">
                            {t(d, "pricing.pass.per")}
                          </span>
                        </p>
                        {stubCapsLine && (
                          <p className="mt-1.5 text-[0.78rem] leading-snug text-[#bdb4e2]">
                            {stubCapsLine}
                          </p>
                        )}
                        <p className="mt-1 text-[0.78rem] leading-snug text-lime-300">
                          {passCreditsLine}
                        </p>
                      </div>

                      {crossoverStubLine && (
                        <div className="rounded-xl border border-[#3b2a6e] bg-black/25 px-3.5 py-3">
                          <p className="mk-cond text-[12.5px] font-semibold tracking-[0.22em] text-lime-400">
                            {t(d, "pricing.table.pro")}
                          </p>
                          <p
                            data-pass-crossover
                            className="mt-1.5 text-[0.78rem] leading-snug text-[#bdb4e2]"
                          >
                            {crossoverStubLine}
                          </p>
                        </div>
                      )}
                    </div>

                    {/* Three readers, three honest endings (task 19, spec D3).
                        `included` is not a disabled button: a paying customer
                        is not being refused, the offer simply does not apply —
                        Pro already exceeds every key the pass lifts. */}
                    {passCta === "included" ? (
                      <p
                        data-pass-column-cta="included"
                        className="mt-5 rounded-lg bg-white/10 px-4 py-3 text-center text-sm font-medium text-lime-300"
                      >
                        {t(d, "pricing.pass.included")}
                      </p>
                    ) : (
                      <Link
                        href={passCtaHref}
                        data-pass-column-cta={passCta}
                        className="mk-display mt-5 block w-full rounded-lg bg-lime-400 px-4 py-4 text-center text-[15px] font-bold tracking-[0.1em] text-night transition hover:bg-lime-300 md:py-3.5"
                      >
                        {passCtaLabel}
                      </Link>
                    )}
                  </div>

                  <div className="pr-pass-seam pr-seam" aria-hidden />

                  {/* body — the bullets, and (phone only) the buy action
                      repeated at the thumb. */}
                  <div className="pr-pass-body flex min-w-0 flex-col px-6 pb-8 pt-7 sm:px-8 md:pb-9 md:pt-6">
                    <ul className="grid flex-1 gap-x-7 gap-y-3 text-[0.95rem] leading-snug text-[#463a60] sm:grid-cols-2 sm:gap-y-2.5 sm:text-[0.9rem] lg:grid-cols-3">
                      {cardBullets(d, PASS_CARD_BULLETS, matrix).map((f) => (
                        <li key={f} className="flex gap-2.5">
                          <span aria-hidden className="mt-[3px] shrink-0 text-[#4d7c0f]">
                            ✓
                          </span>
                          {f}
                        </li>
                      ))}
                    </ul>

                    {/* The mobile ticket is a screen and a half tall; the buy
                        action repeats where the thumb already is. Pointless
                        at desktop, where the stub button never leaves the
                        screen — hence md:hidden. No repeat for `included`,
                        which has no buy action to repeat. */}
                    {passCta !== "included" && (
                      <Link
                        href={passCtaHref}
                        data-pass-cta-repeat={passCta}
                        className="mk-display mt-6 block w-full rounded-lg bg-lime-400 px-4 py-4 text-center text-[15px] font-bold tracking-[0.1em] text-night transition hover:bg-lime-300 md:hidden"
                      >
                        {passCtaLabel}
                      </Link>
                    )}
                  </div>
                </div>
              </article>

              {/* ══ The two subscriptions-or-nothing offers, quieter ═══════ */}
              <div className="grid gap-6 md:grid-cols-2">
                {/* Community — a torn counterfoil, cream on the night band. */}
                <div className="card pr-tear-top flex flex-col p-8 pt-9">
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
                  <ul className="mb-6 flex-1 space-y-2.5 text-sm text-slate-600">
                    {cardBullets(d, FREE_CARD_BULLETS, matrix).map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <span className="mt-0.5 text-emerald-500">✓</span>
                        {f}
                      </li>
                    ))}
                  </ul>
                  {feePill("community") && (
                    <p
                      data-community-fee-pill
                      className="mb-5 inline-flex w-fit items-baseline gap-1 whitespace-nowrap rounded border border-slate-200 px-2.5 py-1.5 text-[11px] font-semibold tracking-[0.08em] text-slate-500"
                    >
                      {feePill("community")}
                    </p>
                  )}
                  <Link href="/login?tab=signup" className="btn btn-ghost w-full justify-center py-3">
                    {t(d, "pricing.community.cta")}
                  </Link>
                </div>

                {/* Pro — annual toggle default-on */}
                <ProPriceCard
                  monthly={proMonthly}
                  annualPerMonth={formatMinor(Math.round(proPrice("annual", currency) / 12), currency)}
                  features={cardBullets(d, PRO_CARD_BULLETS, matrix)}
                  creditsLine={proCreditsLine ?? undefined}
                  feeLine={feePill("pro") ?? undefined}
                  // Every string the card paints, resolved HERE. The component
                  // carries no copy and no English fallback — see
                  // components/pro-price-card.tsx and the source scan in
                  // lib/__tests__/pricing-card-i18n.test.ts.
                  labels={{
                    // `pricing.table.pro`, NOT a `pricing.pro.name` — there is
                    // no such key. Community and the pass have `.name`; the Pro
                    // column's label has only ever lived on the comparison
                    // table's key, which is what `ticketTiers` reads for the home
                    // stub too (lib/pricing-cards.ts).
                    tier: t(d, "pricing.table.pro"),
                    perMonth: t(d, "pricing.pro.per"),
                    annualBilled: t(d, "pricing.pro.annualBilled", {
                      total: formatMinor(proPrice("annual", currency), currency),
                    }),
                    annualSaving: t(d, "pricing.pro.annualSaving"),
                    monthlyNote: t(d, "pricing.pro.monthlyNote"),
                    annualToggle: t(d, "pricing.pro.annualToggle"),
                    // W3: the retired `pricing.plus.cta` key. Pro's own CTA now
                    // has its own name — the last of the `pricing.plus.*` family
                    // was pruned in the same commit that stopped reading it.
                    cta: t(d, "pricing.pro.cta"),
                  }}
                />
              </div>

              {/* ══ Enterprise — a hairline band, not a priced column ══════ */}
              <div className="mt-10 rounded-2xl border border-[#3b2a6e] bg-[#1d1145] px-6 py-7 sm:px-8">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <h2 className="mk-display text-2xl font-bold text-cream">
                      {t(d, "pricing.enterprise.heading")}
                    </h2>
                    <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-[#bdb4e2]">
                      {t(d, "pricing.enterprise.text")}
                    </p>
                  </div>
                  <a
                    href="mailto:hello@seazn.club"
                    className="mk-display block shrink-0 rounded-lg border-2 border-lime-400 px-6 py-3.5 text-center text-[15px] font-semibold tracking-[0.1em] text-lime-400 transition hover:bg-lime-400 hover:text-night lg:w-auto lg:py-3"
                  >
                    {t(d, "pricing.enterprise.link")}
                  </a>
                </div>
              </div>
            </div>
          </section>

          <section className="mx-auto max-w-6xl px-4 pb-20 pt-12">
            {/* Add-ons strip (SPEC-6 A1): the recurring + one-time extras sit
                beneath the tier ladder. Non-committal labels — the actual
                purchase surfaces are later SPEC-6 billing tabs — so these are
                static, not links, and never gate money. */}
            <div className="rounded-2xl border border-purple-100 bg-purple-50/60 px-6 py-4">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-slate-600">
                <span className="text-xs font-semibold uppercase tracking-wider text-purple-500">
                  {t(d, "pricing.addons.label")}
                </span>
                <span className="flex items-center gap-1.5">
                  <span aria-hidden>⚡</span>
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

            {/* Feature comparison — a real TABLE at ≥768 (unchanged markup —
                same `data-pricing-matrix`, same `data-pricing-column={plan}`,
                the e2e/smoke suites read those), a per-plan ACCORDION at 320
                so a comparison table never becomes a horizontally-scrolling
                desktop table shrunk to fit a phone. Both render from the SAME
                `sections` — one data source, two renderers. */}
            {sections.length > 0 && (
              <>
                <h2 className="sr-only">{t(d, "pricing.table.compareLabel")}</h2>

                <div
                  className="scroll-x scroll-x-fade mt-12 hidden rounded-2xl border border-purple-100 bg-white md:block"
                  tabIndex={0}
                  role="region"
                  aria-label={t(d, "pricing.table.compareLabel")}
                >
                  <table className="table w-full" data-pricing-matrix>
                    <thead>
                      <tr>
                        <th className="py-3 text-left">{t(d, "pricing.table.feature")}</th>
                        {PRICING_PLAN_KEYS.map((plan) => (
                          <th
                            key={plan}
                            data-pricing-column={plan}
                            className="py-3 text-center whitespace-nowrap"
                          >
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
                                {r.noteKey && (
                                  <span className="mt-0.5 block text-xs font-normal text-slate-500">
                                    {t(d, r.noteKey)}
                                  </span>
                                )}
                              </td>
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

                {/* The phone accordion: one collapsible `<details>` per plan,
                    each listing that plan's OWN values grouped by the same
                    ENTITLEMENT_DOMAINS sections. Native disclosure — no client
                    JS needed, so the page stays a server component. */}
                <div className="mt-8 space-y-2 md:hidden" data-pricing-accordion>
                  {PRICING_PLAN_KEYS.map((plan) => (
                    <details
                      key={plan}
                      className="group rounded-xl border border-purple-100 bg-white px-4 py-3"
                      data-pricing-accordion-plan={plan}
                    >
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-1 font-semibold text-purple-900">
                        {t(d, PRICING_COLUMN_LABEL_KEY[plan])}
                        <span aria-hidden className="text-purple-400 transition group-open:rotate-180">
                          ⌄
                        </span>
                      </summary>
                      <div className="mt-3 space-y-4 border-t border-purple-50 pt-3">
                        {sections.map((section) => (
                          <div key={section.labelKey}>
                            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-purple-400">
                              {t(d, section.labelKey)}
                            </p>
                            <dl className="divide-y divide-purple-50 text-sm">
                              {section.rows.map((r) => (
                                <div
                                  key={r.labelKey}
                                  className="flex items-center justify-between gap-3 py-1.5"
                                  data-pricing-accordion-row={r.labelKey}
                                >
                                  <dt className="min-w-0 text-slate-600">
                                    {t(d, r.labelKey)}
                                    {r.noteKey && (
                                      <span className="mt-0.5 block text-xs font-normal text-slate-500">
                                        {t(d, r.noteKey)}
                                      </span>
                                    )}
                                  </dt>
                                  <dd className={`shrink-0 font-medium ${CELL_TONE[plan]}`}>
                                    {cellText(r.cells[plan])}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          </div>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              </>
            )}
          </section>

          {/* FAQ */}
          <section className="bg-purple-50 py-16">
            <div className="mx-auto max-w-3xl px-4">
              <h2 className="mb-10 text-center text-2xl font-bold text-purple-900">
                {t(d, "pricing.faq.heading")}
              </h2>
              <div className="space-y-6">
                {FAQ_KEYS.filter((k) => k !== "platformFee" || platformFeeReadable).map((k) => (
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
