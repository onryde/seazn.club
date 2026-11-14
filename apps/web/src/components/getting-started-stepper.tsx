// The /start "Sent stepper" (owner-approved 2026-11-14, mock sss14a section 1 Option A and section 4): five steps joined by
// green dashed connectors, the current one tinted with a "Now" pill. One component for both places it shows, so the two
// cannot drift: the Sent screen (night, always one column) and the division page the claim lands on (light; one column on
// phones and tablets, five across from `lg`). It renders words it is handed — the caller owns the dictionary — and holds no
// state, so a server page and a client island mount it alike.
//
// Accessibility: an ordered list (the list position is the step number to a screen reader), `aria-current="step"` on the
// current step, the numbered or ticked node and the dashed connector `aria-hidden` (decoration), and a ticked step says so in
// words.
import { Check } from "lucide-react";
import type { GettingStartedStep, StepState } from "@/lib/getting-started-steps";

export interface StepperItem {
  key: GettingStartedStep;
  state: StepState;
  title: string;
  hint: string;
  /** The current step's way on (the landing only): a link to where the step is done. */
  action?: { href: string; label: string };
}

type Tone = "night" | "light";

const TONE: Record<
  Tone,
  {
    connector: string;
    node: Record<StepState, string>;
    title: Record<StepState, string>;
    hint: Record<StepState, string>;
    currentBox: string;
    now: string;
  }
> = {
  night: {
    connector: "border-[var(--mk-lime)]",
    node: {
      done: "border-[var(--mk-lime)] bg-[var(--mk-lime)] text-[var(--mk-night)]",
      current: "border-[var(--mk-lime)] bg-[var(--mk-lime)] text-[var(--mk-night)] shadow-[0_0_0_5px_rgb(163_230_53/0.18)]",
      todo: "border-[#4c3f8a] bg-[#1f1452] text-[#a69bd6]",
    },
    title: { done: "font-medium text-[#a69bd6]", current: "font-semibold text-white", todo: "font-medium text-[#c9c1ea]" },
    hint: { done: "text-[#8d7fc0]", current: "text-[#b7aede]", todo: "text-[#8d7fc0]" },
    currentBox: "rounded-[10px] border border-[rgb(163_230_53/0.35)] bg-[rgb(163_230_53/0.08)] px-3 py-2",
    now: "bg-[var(--mk-lime)] text-[var(--mk-night)]",
  },
  light: {
    connector: "border-[#65a30d]",
    node: {
      done: "border-[#65a30d] bg-[#65a30d] text-white",
      current: "border-[var(--mk-lime)] bg-[var(--mk-lime)] text-[#1a2e05] shadow-[0_0_0_5px_rgb(132_204_22/0.2)]",
      todo: "border-slate-300 bg-white text-slate-500",
    },
    title: {
      done: "font-medium text-slate-500 line-through decoration-slate-300",
      current: "font-semibold text-slate-800",
      todo: "font-medium text-slate-600",
    },
    hint: { done: "text-slate-500", current: "text-slate-600", todo: "text-slate-500" },
    currentBox: "rounded-[10px] border border-lime-300 bg-lime-50 px-3 py-2",
    now: "bg-lime-200 text-lime-900",
  },
};

/** `across`: five columns from `lg` (the landing); otherwise one column at every width (the Sent screen, Option A). */
export function GettingStartedStepper({
  items,
  label,
  nowLabel,
  doneLabel,
  tone,
  across = false,
}: {
  items: readonly StepperItem[];
  label: string;
  nowLabel: string;
  doneLabel: string;
  tone: Tone;
  across?: boolean;
}) {
  const c = TONE[tone];
  return (
    <ol aria-label={label} data-getting-started-steps className={across ? "lg:grid lg:grid-cols-5 lg:gap-x-3" : undefined}>
      {items.map((item, i) => {
        const last = i === items.length - 1;
        const current = item.state === "current";
        return (
          <li
            key={item.key}
            data-step-key={item.key}
            data-step-state={item.state}
            aria-current={current ? "step" : undefined}
            className={`relative grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] gap-3 ${last ? "" : "pb-4"} ${
              across ? "lg:flex lg:flex-col lg:items-center lg:gap-0 lg:pb-0 lg:text-center" : ""
            }`}
          >
            {last ? null : (
              <span
                aria-hidden
                className={`absolute bottom-1 left-[15px] top-9 border-l-2 border-dashed ${c.connector} ${
                  item.state === "todo" ? "opacity-50" : ""
                } ${across ? "lg:bottom-auto lg:left-[calc(50%+24px)] lg:right-[calc(-50%+18px)] lg:top-[15px] lg:border-l-0 lg:border-t-2" : ""}`}
              />
            )}
            <span
              aria-hidden
              className={`relative grid h-8 w-8 flex-none place-items-center rounded-full border-2 text-sm font-bold ${c.node[item.state]}`}
            >
              {item.state === "done" ? <Check className="h-4 w-4" strokeWidth={3} /> : i + 1}
            </span>
            <div
              className={`min-w-0 ${current ? `${c.currentBox} -mt-0.5` : "pt-1"} ${across ? (current ? "lg:mt-2.5" : "lg:pt-3") : ""}`}
            >
              <p className={`text-[15px] leading-snug ${c.title[item.state]}`}>
                {item.title}
                {current ? (
                  <span className={`ml-1.5 inline-block rounded-full px-2 align-[2px] text-[11.5px] font-bold no-underline ${c.now}`}>
                    {nowLabel}
                  </span>
                ) : null}
                {item.state === "done" ? <span className="sr-only"> ({doneLabel})</span> : null}
              </p>
              <p className={`mt-0.5 text-[13.5px] leading-snug ${c.hint[item.state]}`}>{item.hint}</p>
              {item.action ? (
                <a
                  href={item.action.href}
                  data-step-action={item.key}
                  className="btn btn-primary mt-2.5 min-h-11 px-3 text-[13px] lg:min-h-9"
                >
                  {item.action.label}
                </a>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
