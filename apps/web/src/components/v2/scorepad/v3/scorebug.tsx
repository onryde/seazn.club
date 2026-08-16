"use client";

// The Scorebug — R1 chassis (Task 5). The pad's only always-on score
// readout: a stadium-night LCD tile sitting inside the daylight product
// shell. This is the ONE visual element the product owner kept from the
// previous pad ("the ice-hockey moment"), generalised here into the shared
// family identity every per-sport skin's ScorebugSpec renders through
// (docs/superpowers/specs/2026-08-03-scoringpad-v2-design.md).
//
// A THIN renderer, deliberately: every piece of copy is either already
// resolved by the caller (`context` — "already localised" per types.ts;
// `big` — "pre-formatted"; `WhoLine.name`; `StripItem.label`/`value` — none
// of these carry an "i18n key" comment in types.ts, unlike TileSpec.label,
// DockChip.label, and ContextSlot.label, which do) or is an i18n KEY this
// file resolves itself (`ScorebugHalf.hint` — "i18n key; REQUIRED iff
// tappable"). Hint resolution reuses padLabel() (apps/web/src/lib/
// scoring-vocab.ts:907), the SAME vocab path every legacy skin and this
// wave's own ribbon.ts already call (S7/#427; pins.md §4) — R1 registers no
// per-sport hint keys yet (V3_SKINS is empty, registry.ts), so every hint
// falls through to padLabel's raw-string fallback today; a later wave only
// has to add dictionary copy + register the key, never touch this file.
//
// D-11 (duplicate-score defect this wave exists to kill): this component
// renders each half's `big` value exactly ONCE. The consuming page must
// never add its own second score line above/around it — enforced when a
// real page composes this component, starting R2+.
//
// Token pairs + the WCAG contrast math backing this file's color choices
// live in ./tokens.ts / __tests__/contrast.test.ts — read that file's
// header before changing any color class here.
import type { ScorebugHalf, ScorebugSpec, TapEvent, WhoLine } from "./types";
import { padLabel } from "@/lib/scoring-vocab";
import type { MsgFn } from "./ribbon";

export interface ScorebugProps {
  spec: ScorebugSpec;
  /** Interpolating message lookup — same shape ribbon.ts's MsgFn takes
   *  (useMsg() and msgFor() both hand callers this shape). Passed as a
   *  prop, not called via a hook internally, so this component never
   *  assumes which one (client vs server) its caller has in hand. */
  t: MsgFn;
  /** Fires with the half's own `tapEvent` when a tappable half is tapped.
   *  Optional: R1 ships no pipeline wiring for this component yet (queue
   *  wiring is Task 4's, not this file's) — a caller not yet ready to
   *  dispatch can render a fully-formed, real, still-inert button. */
  onTap?: (event: TapEvent) => void;
}

function whoNames(who: readonly WhoLine[]): string {
  return who.map((w) => w.name).join(", ");
}

function HalfContent({ half, hintText }: { half: ScorebugHalf; hintText: string }) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 app-display text-[13px] font-semibold tracking-wide text-cream sm:text-sm">
        {half.who.map((w, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            {w.serving && (
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-lime-400" />
            )}
            {w.name}
          </span>
        ))}
      </div>
      <div
        className="app-display text-4xl font-bold leading-none text-lime-400"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {half.big}
      </div>
      {half.tappable && hintText && (
        <span className="text-[11px] font-medium text-cream/70">{hintText}</span>
      )}
    </>
  );
}

/**
 * Renders a ScorebugSpec: two halves (a tappable one is a real <button>
 * with a 44px min-height floor, visible hint text, and an aria-label
 * combining the who-line with the hint; a non-tappable one is a plain,
 * unfocusable <div>), the context line, and the stat strip.
 */
export function Scorebug({ spec, t, onTap }: ScorebugProps) {
  return (
    <div className="overflow-hidden rounded-2xl border-t-2 border-lime-400 bg-night shadow-lg">
      <div className="flex items-center justify-center gap-2 bg-night-2 px-3 py-1.5">
        {spec.phase === "live" && (
          <span
            aria-hidden="true"
            className="mk-live-dot h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--mk-live)]"
          />
        )}
        <span className="app-display text-center text-[11px] tracking-wide text-cream/80">
          {spec.context}
        </span>
      </div>

      <div className="grid grid-cols-2 divide-x divide-cream/10">
        {spec.halves.map((half, i) => {
          const hintText = half.hint ? padLabel(half.hint, t, half.hint) : "";
          const content = <HalfContent half={half} hintText={hintText} />;
          if (half.tappable) {
            return (
              <button
                key={i}
                type="button"
                onClick={() => half.tapEvent && onTap?.(half.tapEvent)}
                aria-label={[whoNames(half.who), hintText].filter(Boolean).join(" ")}
                style={{ minHeight: 44 }}
                className="flex flex-col items-center justify-center gap-1 px-3 py-3 text-center outline-offset-[-3px] transition-colors hover:bg-cream/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400"
              >
                {content}
              </button>
            );
          }
          return (
            <div key={i} className="flex flex-col items-center justify-center gap-1 px-3 py-3 text-center">
              {content}
            </div>
          );
        })}
      </div>

      {spec.strip.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 bg-night-2 px-3 py-1.5">
          {spec.strip.map((item, i) => (
            <span
              key={i}
              className={
                item.accent
                  ? "text-xs font-semibold text-cream"
                  : "text-xs font-medium text-cream/70"
              }
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {item.label ? `${item.label} ` : ""}
              {item.value}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
