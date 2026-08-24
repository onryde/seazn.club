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
// file resolves itself (`ScorebugHalf.hintKey` — "i18n key; REQUIRED iff
// tappable", renamed from `hint` — R2b-cricket-over follow-up, hint-field
// naming pass, 2026-08-17). Hint resolution reuses padLabel() (apps/web/src/lib/
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
import { NIGHT_TILE_CLASSES, SCORE_TEXT_SIZE_CLASS } from "./tokens";

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

/**
 * Fix round 1 (review, Minor finding 3): the visible serving dot (below,
 * `aria-hidden`) carried no screen-reader equivalent — the aria-label built
 * from this function's output was who + hint only, silently dropping the
 * "who is serving" cue sighted users get.
 *
 * Fix round 2 (review, Important — controller ruling): round 1's fix
 * resolved `scorepad.skin.tennis.header.serving` itself, from inside this
 * shared chassis primitive — wrong, because that key belongs to ONE sport
 * and this file renders every sport's ScorebugSpec (racquet sports already
 * keep their OWN separate `scorepad.skin.racquet.header.serving` key
 * precisely because one sport's key must not serve another; cricket and
 * football, the first two sports this wave converts, have no serving
 * concept at all). The chassis must never resolve a sport-namespaced key.
 *
 * Corrected shape: `WhoLine.servingLabel` (types.ts) is PRE-LOCALISED by
 * the skin that builds the WhoLine — exactly like `ScorebugHalf.big` and
 * `ScorebugSpec.context` are already pre-formatted/pre-localised strings —
 * and this function only renders it verbatim. No `t`/MsgFn needed here at
 * all any more. Explicit, stated fallback (no fabricated English): a
 * WhoLine with `serving:true` and no `servingLabel` renders its bare name
 * only — the "serving" fact simply does not reach this string until the
 * skin populates the field; the visible dot (HalfContent, below) still
 * marks it visually in the meantime. Exported so it's testable as a plain
 * function (`__tests__/scorebug.test.ts`) with no DOM/render involved.
 */
export function whoNames(who: readonly WhoLine[]): string {
  return who
    .map((w) => (w.serving && w.servingLabel ? `${w.name}, ${w.servingLabel}` : w.name))
    .join(", ");
}

function HalfContent({ half, hintText }: { half: ScorebugHalf; hintText: string }) {
  return (
    <>
      <div
        className={`flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 app-display text-[13px] font-semibold tracking-wide ${NIGHT_TILE_CLASSES.creamText} sm:text-sm`}
      >
        {half.who.map((w, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            {w.serving && (
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${NIGHT_TILE_CLASSES.ledDot}`}
              />
            )}
            {w.name}
          </span>
        ))}
      </div>
      <div
        className={`app-display ${SCORE_TEXT_SIZE_CLASS} font-bold leading-none ${NIGHT_TILE_CLASSES.limeText}`}
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {half.big}
      </div>
      {half.tappable && hintText && (
        <span className={`text-[11px] font-medium ${NIGHT_TILE_CLASSES.creamTextMuted}`}>{hintText}</span>
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
    <div
      className={`overflow-hidden rounded-2xl border-t-2 ${NIGHT_TILE_CLASSES.ledEdge} ${NIGHT_TILE_CLASSES.tileBg} shadow-lg`}
    >
      <div className={`flex items-center justify-center gap-2 ${NIGHT_TILE_CLASSES.bandBg} px-3 py-1.5`}>
        {spec.phase === "live" && (
          <span
            aria-hidden="true"
            className="mk-live-dot h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--mk-live)]"
          />
        )}
        <span
          className={`app-display text-center text-[11px] tracking-wide ${NIGHT_TILE_CLASSES.creamTextSubtle}`}
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {spec.context}
        </span>
      </div>

      <div className={`grid grid-cols-2 divide-x ${NIGHT_TILE_CLASSES.rule}`}>
        {spec.halves.map((half, i) => {
          const hintText = half.hintKey ? padLabel(half.hintKey, t, half.hintKey) : "";
          const content = <HalfContent half={half} hintText={hintText} />;
          if (half.tappable) {
            return (
              <button
                key={i}
                type="button"
                onClick={() => half.tapEvent && onTap?.(half.tapEvent)}
                aria-label={[whoNames(half.who), hintText].filter(Boolean).join(" ")}
                style={{ minHeight: 44 }}
                className={`${NIGHT_TILE_CLASSES.half} flex flex-col items-center justify-center gap-1 px-3 py-3 text-center outline-offset-[-3px] transition-colors focus-visible:outline focus-visible:outline-2`}
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
        <div className={`flex flex-wrap items-center justify-center gap-x-4 gap-y-1 ${NIGHT_TILE_CLASSES.bandBg} px-3 py-1.5`}>
          {spec.strip.map((item, i) => {
            // R3/B4 (owner ruling R3-6, the per-sport signature): a strip item
            // may ask for the LED-panel treatment — the fourth official's
            // added-time board, an inset well of `--sport-board` inside the
            // `--sport-board-2` band with the accent as its digits. OPT-IN and
            // additive: `tone` is absent on every item shipped before this, so
            // the two branches below are byte-for-byte what R1/R2 rendered.
            //
            // Label and value are separate elements here (rather than the
            // concatenated string the plain branches use) because the board's
            // hierarchy IS the treatment: a small tracked-out caption over a
            // dominant tabular figure, the way a real board reads. Same colour
            // for both, deliberately — no opacity step means the panel needs
            // exactly one contrast pair, not a composited second one.
            if (item.tone === "led") {
              return (
                <span
                  key={i}
                  {...(item.id ? { "data-strip-item-id": item.id } : {})}
                  data-strip-tone="led"
                  className={`${NIGHT_TILE_CLASSES.ledPanel} text-xs font-semibold`}
                >
                  {item.label && (
                    <span className={NIGHT_TILE_CLASSES.ledPanelLabel}>{item.label}</span>
                  )}
                  <span>{item.value}</span>
                </span>
              );
            }
            return (
              <span
                key={i}
                // R2b (owner ruling, freeHit chip removal): a stable, i18n-
                // independent hook for a Playwright spec to target ONE strip
                // item — StripItem.id is optional/additive (types.ts); only
                // rendered when a skin actually sets it, so every other strip
                // item (over dots, names, target) is unchanged.
                {...(item.id ? { "data-strip-item-id": item.id } : {})}
                className={
                  item.accent
                    ? `text-xs font-semibold ${NIGHT_TILE_CLASSES.creamText}`
                    : `text-xs font-medium ${NIGHT_TILE_CLASSES.creamTextMuted}`
                }
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {item.label ? `${item.label} ` : ""}
                {item.value}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
