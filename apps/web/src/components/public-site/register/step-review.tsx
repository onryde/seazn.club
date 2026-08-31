"use client";
// RS006 Step 5 — REVIEW→PAY (design §4 step 5). Read-only line items: no
// remove/duplicate/rename/self-link controls here (those are step 2/3's
// job — back-navigation already gets a registrant to them). Computes
// NOTHING of its own beyond formatting — `summary` (cart.ts's
// summarizeCart) is passed in already built, so the subtotal/waitlist math
// can never drift from step 2's own EntryCart (which shares the SAME
// function — see summarizeCart's own doc comment for why forking it is the
// specific thing the RS006 dispatch calls out not to do).
import { useT } from "@/components/i18n/dict-provider";
import { formatMinor, type Currency } from "@/lib/currency";
import { entryDisplayName, UNNAMED_KEY } from "./entry-cart";
import { payableDivision, type CartSummary, lineFeeCents } from "./cart";

export function StepReview({ summary, locale }: { summary: CartSummary; locale: string }) {
  const t = useT();
  // Every payable division in a cart shares one payment method by
  // construction (assertUniformPaymentMethod, registration-submit.ts) — see
  // payableDivision's own doc comment for why this is the SAME lookup the
  // submit button's own label reads (register-stepper.tsx), never a second
  // one.
  const payable = payableDivision(summary);

  return (
    <div className="rounded-xl border border-zinc-200/80 bg-surface p-4 shadow-sm sm:p-6">
      <h2 tabIndex={-1} className="font-display text-xl font-semibold uppercase tracking-wide text-ink">
        {t("register.review.heading")}
      </h2>
      <p className="mt-1 text-sm text-ink-muted">{t("register.review.subtitle")}</p>

      <ul className="mt-4 space-y-2.5">
        {summary.lines.map(({ entry, division, waitlisted, staleClosed }) => {
          const name = entryDisplayName(entry);
          // `lineFeeCents`, not `division.fee_cents` — a solo sign-up is
          // charged the division's solo price, and reading the team fee here
          // quoted one number on screen while Stripe asked for another.
          const lineFee = division == null ? null : lineFeeCents(entry, division);
          const feeLabel =
            division == null || lineFee == null
              ? null
              : lineFee === 0
                ? t("register.entries.free")
                : formatMinor(lineFee, division.currency as Currency, locale);
          return (
            <li key={entry.id} className="rounded-lg border border-zinc-200 bg-canvas p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-display text-sm font-semibold uppercase tracking-wide text-ink">
                    {division?.name ?? entry.division_id}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {entry.free_agent ? t("register.entries.cart.freeAgentBadge") : name || t(UNNAMED_KEY[entry.entrant_kind])}
                  </p>
                </div>
                {feeLabel && (
                  <span className="shrink-0 font-display text-sm font-semibold text-ink">
                    {waitlisted || staleClosed ? t("register.entries.free") : feeLabel}
                  </span>
                )}
              </div>
              {waitlisted && <p className="mt-1.5 text-xs text-amber-700">{t("register.entries.cart.waitlistNote")}</p>}
              {staleClosed && <p className="mt-1.5 text-xs text-red-700">{t("register.entries.cart.closedNote")}</p>}
            </li>
          );
        })}
      </ul>

      <div className="mt-4 flex items-center justify-between border-t border-zinc-200 pt-3">
        <span className="font-display text-xs font-semibold uppercase tracking-wider text-ink-muted">
          {t("register.entries.cart.subtotal")}
        </span>
        <span className="text-right">
          <span className="font-display text-lg font-bold text-ink">
            {summary.subtotalCents === 0 || !summary.currency
              ? t("register.entries.free")
              : formatMinor(summary.subtotalCents, summary.currency as Currency, locale)}
          </span>
          {payable && (
            <span className="block font-sans text-xs font-normal text-ink-muted">
              {t(payable.payment_method === "stripe" ? "register.method.card" : "register.method.offline")}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
