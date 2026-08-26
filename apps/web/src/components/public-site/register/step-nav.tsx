"use client";
// RS006 chassis — step rail. Visual signature: a "matchday card" progress
// strip on the same --ps-court slab the org masthead uses (layout.tsx), so
// the stepper reads as a continuation of the courtside chrome rather than a
// generic wizard bolted onto it. Only steps that are REAL and BUILT appear
// (steps.ts's buildStepOrder) — no dimmed placeholders for consent/review
// (steps 4-5, not built yet); see register-stepper.tsx's "more on the way"
// end-cap for how that seam is surfaced instead.
import { useT } from "@/components/i18n/dict-provider";
import type { StepId } from "./types";

const STEP_LABEL_KEY: Record<StepId, "register.nav.who" | "register.nav.entries" | "register.nav.details"> = {
  who: "register.nav.who",
  entries: "register.nav.entries",
  details: "register.nav.details",
};

/** 320px is the tightest of the three overflow risks the RS006 prompt names
 *  by name (cart, roster table, stepper nav) — the numbered circles alone
 *  always fit; a label past the current step hides below `sm` rather than
 *  truncating into something unreadable. The CURRENT step's label always
 *  shows, at every width, so the registrant is never left reading only a
 *  bare number for where they are right now. */
export function StepNav({ order, currentIndex }: { order: readonly StepId[]; currentIndex: number }) {
  const t = useT();
  return (
    <ol
      aria-label={t("register.nav.step", { n: Math.min(currentIndex + 1, order.length), total: order.length })}
      className="flex items-stretch gap-px overflow-hidden rounded-xl bg-court shadow-sm"
    >
      {order.map((step, i) => {
        const state = i < currentIndex ? "done" : i === currentIndex ? "current" : "upcoming";
        return (
          <li key={step} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 sm:px-4 sm:py-3">
            <span
              aria-hidden
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-display text-xs font-bold ${
                state === "upcoming"
                  ? "bg-white/10 text-court-muted"
                  : "bg-accent text-accent-ink"
              }`}
            >
              {state === "done" ? "✓" : i + 1}
            </span>
            <span
              className={`truncate font-display text-[11px] font-semibold uppercase tracking-wider sm:text-xs ${
                state === "upcoming" ? "text-court-muted" : "text-court-ink"
              } ${state === "current" ? "" : "hidden sm:inline"}`}
            >
              {t(STEP_LABEL_KEY[step])}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
