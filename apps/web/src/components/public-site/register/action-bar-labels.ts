// Registration redesign B2 (review: the stepper held the whole action bar inline) — what the action bar SAYS, as one pure function: the
// forward button's name, the phone running total, what the submit button reads in the phase it is in, and the longest label it will
// ever show. register-stepper.tsx hands in its own state (the cart's summary, the step, the submit phase) and `action-bar.tsx` draws
// what comes back; nothing here reads a hook, a clock or the DOM, so it is tested with the real English dictionary and no React.
//
// `t` and `plural` are PARAMETERS, not imports of the dictionary hooks: the one dependency this has on the outside world, handed in at
// the seam so a test can bind the real dictionary and the component can bind the provider's.
import { formatMoneyExact } from "@/lib/currency";
import type { TKey } from "@/lib/i18n-runtime";
import { payableDivision, submitLabelKey, type CartSummary } from "./cart";
import { STEP_LABEL_KEY } from "./steps";
import type { StepId } from "./types";

/** Where the submit is (registration redesign B1 T6, spec §3.3 item 5). `saving`: the POST (and the bot-check token it waits for) is
 *  in flight. `opening_payment`: the response carried a `checkout_url` and the page is on its way to Stripe. A cart with no checkout
 *  goes `saving` straight to navigation, so `opening_payment` is never shown for a free or pay-the-organiser-later cart. */
export type SubmitPhase = "idle" | "saving" | "opening_payment";

export interface ActionBarLabels {
  /** "Continue to {step}": the step the forward button leads to, by name. "" when there is none (Review: its action is the submit). */
  continueLabel: string;
  /** What the submit button says right now: its ready text, or the phase the submit is in. */
  submitLabel: string;
  /** The longest label the submit button will show for this cart, in ANY phase. Its width sizer draws this invisibly, so the click
   *  that changes the words does not change the button's width. Never changes with the phase. */
  widestSubmitLabel: string;
  /** The phone bar's running total ("2 entries · £50.00"), or null when there is nothing to say: Review (the Pay label states the
   *  fee), an empty cart, and a cart that costs nothing. Counts only the entries the total is for (a waiting entry is in neither). */
  total: string | null;
}

/** The longest of the labels, by character count; the FIRST of equals, so a tie never flips as the labels change phase.
 *  A character count is a PROXY for rendered width (a near tie can still differ by a few pixels). It is the best that can be known
 *  without a browser, and the width sizer only has to be wide enough for the labels, so a proxy that is off by a pixel costs a
 *  pixel; the rule is pinned by cases whose answer is a known string, not recomputed in the test. */
export function widestLabel(labels: readonly [string, ...string[]]): string {
  return labels.reduce((widest, label) => (label.length > widest.length ? label : widest));
}

export function actionBarLabels(input: {
  t: (key: TKey, vars?: Record<string, string | number>) => string;
  plural: (key: string, count: number, vars?: Record<string, string | number>) => string;
  locale: string;
  /** The ONE summary the Review step's total and line items read (cart.ts `summarizeCart`), so the labels cannot disagree with them. */
  summary: CartSummary;
  /** The step the bar is on. */
  step: StepId;
  /** The step the forward button leads to, or undefined when there is none. */
  stepAfter: StepId | undefined;
  phase: SubmitPhase;
}): ActionBarLabels {
  const { t, plural, locale, summary, step, stepAfter, phase } = input;

  // The ready label: free, pay-by-card-now, pay-the-organiser, or (when every entry waits) join the waiting list (`submitLabelKey`,
  // cart.ts: the same verdict the heading and the total read). The fee it quotes is the charged subtotal, which leaves out waiting entries.
  const ready = t(submitLabelKey(summary), {
    fee: summary.currency ? formatMoneyExact(summary.subtotalCents, summary.currency, locale) : "",
  });
  const saving = t("register.submit.saving");
  const opening = t("register.submit.openingPayment");
  const submitLabel = phase === "saving" ? saving : phase === "opening_payment" ? opening : ready;

  // "Opening secure payment…" only exists for a card cart (a free or pay-the-organiser cart goes saving -> navigation), so only a card
  // cart is sized for it. `payableDivision` is the SAME lookup the Review step's own payment-method note reads.
  const phases: [string, ...string[]] =
    payableDivision(summary)?.payment_method === "stripe" ? [ready, saving, opening] : [ready, saving];

  // The running total in the phone bar (spec §7.2): what the cart costs now, so the person is never a step away from the number.
  // Hidden for an empty cart and for a cart that costs nothing ("3 entries · £0.00" says nothing), and ON Review, where the Review
  // card's own total is on the page and the button reads the fee: a third copy is a line of bar for nothing.
  // The count is of the entries the total is FOR (B3 review m2): the lines `summarizeCart` summed, so a waiting or stale-closed entry is
  // in neither ("2 entries · £25.00" over one charged entry and one waiting read as two entries for £25). A free line entered beside a
  // charged one is entered now, so it counts.
  const entered = summary.lines.filter((l) => !l.notChargedNow).length;
  const total =
    step !== "review" && summary.subtotalCents > 0 && summary.currency
      ? plural("register.bar.summary", entered, {
          total: formatMoneyExact(summary.subtotalCents, summary.currency, locale),
        })
      : null;

  return {
    continueLabel: stepAfter ? t("register.nav.continueTo", { step: t(STEP_LABEL_KEY[stepAfter]) }) : "",
    submitLabel,
    widestSubmitLabel: widestLabel(phases),
    total,
  };
}
