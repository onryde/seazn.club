"use client";

import { useState } from "react";
import Link from "next/link";

/**
 * Every user-facing string this card paints, localized by the server page.
 *
 * The component holds NO copy of its own, and that is a checked property rather
 * than a convention: `lib/__tests__/pricing-card-i18n.test.ts` scans this file
 * for a hardcoded literal IN ANY LANGUAGE — both as prose and, because the two
 * worst strings here were one word each ("/month", "save 30%"), as any JSX text
 * node carrying a letter or a digit.
 *
 * There is deliberately no English default on any of them. A fallback literal
 * is the same defect wearing a shrug: `ctaLabel ?? "Start 14-day trial →"` is
 * how this card shipped, and a fallback nobody notices is a fallback that
 * renders.
 */
export interface ProPriceCardLabels {
  /** `pricing.pro.name` — the tier eyebrow. */
  tier: string;
  /** `pricing.pro.per` — the "/month" suffix beside the headline figure. */
  perMonth: string;
  /** `pricing.pro.annualBilled`, with `{total}` already filled by the page in
   *  the visitor's currency. */
  annualBilled: string;
  /** `pricing.pro.annualSaving`. */
  annualSaving: string;
  /** `pricing.pro.monthlyNote` — shown when the toggle is off. */
  monthlyNote: string;
  /** `pricing.pro.annualToggle` — the switch's own label. */
  annualToggle: string;
  /** `pricing.plus.cta` — the trial CTA. */
  cta: string;
}

interface Props {
  /** Pre-formatted, currency-correct strings from the server page. */
  monthly: string;
  annualPerMonth: string;
  features: string[];
  /** v17 credits line (SPEC-6 A1) — localized on the server, rendered as one of
   *  the two tier differentiators (fee % + credits) above the feature list. */
  creditsLine?: string;
  /** `pricing.card.feePill`, pre-filled with the live `registration.fee_percent`
   *  (R14, entitlements v18 W3) — the same pill Free prints, so the fee rate
   *  reads the same way across every offer. Absent when the matrix could not
   *  supply the rate; suppressed, never rendered with a hole. */
  feeLine?: string;
  labels: ProPriceCardLabels;
}

/**
 * Pro pricing card with the annual toggle DEFAULT-ON (v3/07 §4): the yearly
 * price is the real offer, shown as a per-month figure with the yearly total
 * and the saving beside it — "$10.75/month · $128.99 billed yearly — more than
 * two months free".
 *
 * THE SAVING IS A FLOOR, NOT A PERCENTAGE, and that is the whole point. The
 * seed prices each market independently (`config/stripe-plans.json`
 * `currency_options`), so a year up front saves 28.29% in usd, 30.08% in eur,
 * 32.52% in gbp and 30.45% in inr on the base tier, and 23.71–30.35% on the
 * extra-organisation rider — eight numbers, no single one of them true of the
 * others. This card carried "save 30%" as its example and as its markup, which
 * was false in all four markets and contradicted the FAQ a few hundred pixels
 * below it.
 *
 * `pricing.pro.annualSaving` therefore states the SAME claim, in the same
 * words, that `pricing.faq.annual.a` and `billing.annualSaves` already make —
 * one wording for one fact, so the three cannot drift apart — and
 * `lib/__tests__/dictionary-copy-truth.test.ts` holds all three against the
 * seed's own ladder in both directions.
 */
export function ProPriceCard({
  monthly,
  annualPerMonth,
  features,
  creditsLine,
  feeLine,
  labels,
}: Props) {
  const [annual, setAnnual] = useState(true);

  return (
    <div className="card relative flex flex-col border-purple-400 bg-purple-50 p-8">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-purple-500">
        {labels.tier}
      </p>

      <p className="mb-1 text-4xl font-bold text-purple-900">
        {annual ? annualPerMonth : monthly}
        <span className="text-lg font-normal text-slate-500">{labels.perMonth}</span>
      </p>
      <p className="mb-3 text-sm text-slate-500" data-pro-billing-note>
        {annual ? (
          <>
            {labels.annualBilled} —{" "}
            <span className="font-semibold text-emerald-600" data-pro-annual-saving>
              {labels.annualSaving}
            </span>
          </>
        ) : (
          labels.monthlyNote
        )}
      </p>

      <label className="mb-6 inline-flex w-fit cursor-pointer items-center gap-2 text-sm text-slate-600">
        <button
          type="button"
          role="switch"
          aria-checked={annual}
          data-annual-toggle
          onClick={() => setAnnual(!annual)}
          className={`relative h-5 w-9 rounded-full transition-colors ${annual ? "bg-purple-600" : "bg-slate-300"}`}
        >
          <span
            className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${annual ? "translate-x-4" : "translate-x-0"}`}
          />
        </button>
        {labels.annualToggle}
      </label>

      {creditsLine && (
        <p className="mb-4 flex items-center gap-1.5 rounded-lg bg-purple-100/70 px-3 py-2 text-sm font-semibold text-purple-800">
          <span aria-hidden>⚡</span>
          {creditsLine}
        </p>
      )}

      <ul className="mb-8 flex-1 space-y-2.5 text-sm text-slate-600">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <span className="mt-0.5 text-purple-500">✓</span>
            {f}
          </li>
        ))}
      </ul>
      {feeLine && (
        <p
          data-pro-fee-pill
          className="mb-5 inline-flex w-fit items-baseline gap-1 whitespace-nowrap rounded border border-purple-200 bg-purple-100/60 px-2.5 py-1.5 text-[11px] font-semibold tracking-[0.08em] text-purple-700"
        >
          {feeLine}
        </p>
      )}
      <Link href="/login?tab=signup" className="btn btn-primary w-full justify-center py-3">
        {labels.cta}
      </Link>
    </div>
  );
}
