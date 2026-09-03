"use client";

// The out-of-credits recovery state (SPEC-6 §A6). Rendered inline wherever an AI
// run returns a 402 with feature_key `ai.credits` (an empty wallet) — the board's
// brief/apply steps and the officials review all share THIS one block so the two
// surfaces never diverge. It turns the bare "you're out of credits" sentence into
// an action state that is never a dead end: buy a pack in-place, upgrade, or (soon)
// switch on auto-topup. The 402→outOfCredits mapping is unchanged (ai-console-state);
// this is purely the enriched render.
import { useDict, useLocale, useMsg } from "@/components/i18n/dict-provider";
import ConsoleLink from "@/components/ui/console-link";
import { BuyCredits } from "@/components/buy-credits";
import { creditPackOptions, type Currency } from "@/lib/currency";

export function AiOutOfCredits({ currency }: { currency: Currency }) {
  const msg = useMsg();
  const dict = useDict();
  const locale = useLocale();
  // Client-safe pack ladder (single source — stripe-plans.json packs), priced in
  // the group's locked currency. The BuyCredits modal is embedded verbatim, so
  // "Buy credits" opens the SAME A4 sheet + embedded Checkout used on the Credits
  // tab — nothing here re-implements it.
  const packs = creditPackOptions(currency);

  return (
    <div
      role="alert"
      className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 dark:border-amber-900/40 dark:bg-amber-950/40"
    >
      <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-900 dark:text-amber-200">
        <span aria-hidden>⚡</span>
        {msg("board.ai.error.outOfCreditsTitle")}
      </p>
      <p className="mt-1 text-xs text-amber-800 dark:text-amber-200/80">
        {msg("board.ai.error.outOfCredits")}
      </p>
      {/* The three recovery CTAs. Stacked at 375px (flex-col), a wrapping row from
          sm up — no horizontal scroll on mobile. */}
      <div className="mt-3 flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <BuyCredits packs={packs} currency={currency} dict={dict} locale={locale} />
        {/* WAS "Upgrade to Pro Plus", data-upgrade="pro_plus" — a plan V392
            deleted from `plans` outright, so the CTA pointed at a tier nobody
            can buy. Owner steer (2026-09-03): a Free org should be offered Pro;
            a Pro org is already at the top of self-serve and its offer is a
            CREDIT PACK, which is the `<BuyCredits>` button rendered FIRST above
            — already present for every org, already the recovery this block
            leads with.

            NOT plan-aware, and that is a deliberate limit rather than an
            oversight: this is a client component with no org plan in scope, and
            there is no plan context anywhere in the tree (`usePlan`,
            `PlanProvider` and friends return nothing). Hiding this link for a
            Pro org means threading a plan key through `ai-console.tsx`,
            `ai-competition-console.tsx` and `ai-officials-review.tsx`, which is
            a redesign rather than the false-string fix this is. A Pro org that
            follows it lands on Settings → Billing and sees the plan it already
            has: redundant, not false. Recorded as owed. */}
        <ConsoleLink
          href="/settings/billing"
          className="btn btn-ghost justify-center text-xs"
          data-upgrade="pro"
        >
          {msg("board.ai.error.upgradeToPro")}
        </ConsoleLink>
        {/* Auto-topup (D1) is a fast-follow — render it, disabled, so the recovery
            path is discoverable before it is wired. */}
        <button
          type="button"
          disabled
          aria-disabled="true"
          title={msg("board.ai.error.autoTopupSoon")}
          className="btn btn-ghost inline-flex cursor-not-allowed items-center justify-center gap-1.5 text-xs opacity-50"
        >
          {msg("board.ai.error.autoTopup")}
          <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-700 dark:text-slate-300">
            {msg("board.ai.error.autoTopupSoon")}
          </span>
        </button>
      </div>
    </div>
  );
}
