"use client";
// RS006 chassis — step rail, S1 (registration redesign B2 T7, spec §7.1; owner decision "Step n of total").
// Visual signature: a "matchday card" progress strip on the same --ps-court slab the org masthead uses (layout.tsx), so the
// stepper reads as a continuation of the courtside chrome rather than a generic wizard bolted onto it. Only steps that are REAL
// and BUILT appear (steps.ts's buildStepOrder) — 5 steps, or 4 when the lone open division collapses Entries away — so the total
// is always read off the order, never written down.
//
// ONE DOM, two faces (never a second phone tree): below `md` a header block — "Step n of total" and what comes next, the step's
// name in large type, a progress bar; from `md` the numbered bar it always was, whose finished steps are now buttons back to
// that step. The block is `md:hidden` and the bar `max-md:hidden`, so the two never show at once and nothing is duplicated
// beyond the step's name. Finished steps are NOT jumpable on a phone: the sticky Back is the phone's way back (§7.2).
import { useT } from "@/components/i18n/dict-provider";
import { STEP_LABEL_KEY } from "./steps";
import type { StepId } from "./types";

/** One cell of the numbered bar. The same box whether the step is a button (finished, jump wired) or plain text, so a step does
 *  not change size when it is finished. */
const CELL = "flex min-w-0 flex-1 items-center gap-2 px-4 py-3";

/** `onJump` is called with a step's index, and only ever for a FINISHED step (below the current one) — the only buttons the bar
 *  has. Left out, finished steps are plain text: a button that does nothing is an inert control. An empty order renders nothing
 *  (there is no "step 1 of 0"); the stepper never passes one. */
export function StepNav({
  order,
  currentIndex,
  onJump,
}: {
  order: readonly StepId[];
  currentIndex: number;
  onJump?: (index: number) => void;
}) {
  const t = useT();
  if (order.length === 0) return null;
  // The stepper clamps its own index to the last real step; this keeps a stray one from reading "step 6 of 5".
  const at = Math.min(currentIndex, order.length - 1);
  const total = order.length;
  const stepText = t("register.nav.step", { n: at + 1, total });
  const currentName = t(STEP_LABEL_KEY[order[at]!]);
  const after = order[at + 1];
  return (
    <>
      <div className="rounded-xl bg-court px-4 py-3 shadow-sm md:hidden">
        <div className="flex items-baseline justify-between gap-3 text-xs text-court-muted">
          <span className="shrink-0">{stepText}</span>
          <span className="min-w-0 truncate">
            {after ? t("register.nav.nextLabel", { name: t(STEP_LABEL_KEY[after]) }) : t("register.nav.lastStep")}
          </span>
        </div>
        <p className="mt-1 truncate font-display text-xl font-semibold uppercase tracking-wide text-court-ink">{currentName}</p>
        <div
          role="progressbar"
          aria-label={stepText}
          aria-valuemin={1}
          aria-valuemax={total}
          aria-valuenow={at + 1}
          aria-valuetext={`${stepText}, ${currentName}`}
          className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-white/10"
        >
          <span
            className="block h-full rounded-full bg-accent transition-[width] motion-reduce:transition-none"
            style={{ width: `${((at + 1) * 100) / total}%` }}
          />
        </div>
      </div>

      <ol aria-label={stepText} className="flex items-stretch gap-px overflow-hidden rounded-xl bg-court shadow-sm max-md:hidden">
        {order.map((step, i) => {
          const state = i < at ? "done" : i === at ? "current" : "upcoming";
          const body = (
            <>
              <span
                aria-hidden
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-display text-xs font-bold ${
                  state === "upcoming" ? "bg-white/10 text-court-muted" : "bg-accent text-accent-ink"
                }`}
              >
                {state === "done" ? "✓" : i + 1}
              </span>
              <span
                className={`truncate font-display text-xs font-semibold uppercase tracking-wider ${
                  state === "upcoming" ? "text-court-muted" : "text-court-ink"
                }`}
              >
                {t(STEP_LABEL_KEY[step])}
              </span>
            </>
          );
          return (
            // The current step says so to assistive tech, as the colour does to the eye (B2 review m7).
            <li key={step} aria-current={state === "current" ? "step" : undefined} className="flex min-w-0 flex-1">
              {state === "done" && onJump ? (
                // Inside the bar's `overflow-hidden`, so the global focus ring (outline-offset 2px) would be clipped: drawn inside.
                <button
                  type="button"
                  onClick={() => onJump(i)}
                  className={`${CELL} text-left transition hover:bg-white/10 focus-visible:-outline-offset-2`}
                >
                  {body}
                </button>
              ) : (
                <div className={CELL}>{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}
