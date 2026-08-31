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
  /** Fires with the half's own `tapSheet` key when one is set, INSTEAD of
   *  `onTap`. The host opens it through the same `resolveSheet` path a tile
   *  uses, so a half-opened sheet and a tile-opened sheet cannot diverge. */
  onOpenSheet?: (sheetKey: string) => void;
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
  // R5 — lines are joined with "; ", NOT ", ". A serving line already folds
  // its label in with a comma, so a comma between LINES made the two levels
  // indistinguishable: a tennis doubles half spoke as "Ada Lovelace, Serving,
  // Alan Turing", three flat items in which "Serving" attaches to nobody in
  // particular. The semicolon separates the two levels, so the same half now
  // speaks as "Ada Lovelace, Serving; Alan Turing".
  //
  // Found by verifying a claim rather than trusting it: R5's visible "/"
  // separator was asserted to also improve tennis doubles, and driving a real
  // tennis-doubles fixture to check showed the VISIBLE half had been fixed
  // while its accessible name was still ambiguous. This function's own test
  // had frozen the defect as its expectation (`"Alice, Serving, Bob"`).
  //
  // A half with ONE who-line — cricket's two, football's two, and every
  // singles fixture in every sport — joins a single-element array and is
  // byte-for-byte unchanged.
  return who
    .map((w) => (w.serving && w.servingLabel ? `${w.name}, ${w.servingLabel}` : w.name))
    .join("; ");
}

function HalfContent({ half, hintText }: { half: ScorebugHalf; hintText: string }) {
  return (
    <>
      {/* R3/F (F3): `min-w-0` + `break-words` on BOTH boxes, and on the half
       *  itself below. A grid item and a flex item both default to
       *  `min-width: auto`, i.e. a floor at their widest word, so a long
       *  unbroken name widened the half past its column; the scorebug root is
       *  `overflow-hidden`, so the page never scrolled horizontally and the
       *  name was silently CLIPPED at both ends instead (the row is
       *  `justify-center`). Measured at 320 in a real browser before and after
       *  — see __tests__/scorebug.test.ts's own note for the rects. Chassis-
       *  wide: every skin's ScorebugSpec renders through this component. */}
      {/* R7-28 — capped at TWO lines, found by reading a real 320 capture:
       *  a long entrant name wrapped to three lines above a single-digit
       *  score, so the name outweighed the number on a surface whose entire
       *  job is to show the score. `line-clamp-2` needs `display:-webkit-box`,
       *  which is why this is no longer `flex` — the children are each
       *  `inline-flex` already, so the LED dot and the "/" separator keep
       *  their own alignment, and a half whose name fits on one or two lines
       *  (cricket's, football's, every singles fixture, most doubles pairs)
       *  renders exactly what it rendered before.
       *
       *  Nothing is lost when it clamps: `whoNames()` builds the half's
       *  ACCESSIBLE name from the same data and is unaffected, so a screen
       *  reader still hears every name in full — the clamp is visual only.
       *  Chassis-wide: every skin's ScorebugSpec renders through here, so
       *  this was verified against the other skins' captures too. */}
      <div
        className={`line-clamp-2 min-w-0 text-center app-display text-[13px] font-semibold tracking-wide ${NIGHT_TILE_CLASSES.creamText} sm:text-sm`}
      >
        {half.who.map((w, i) => (
          <span key={i} className="inline-flex min-w-0 items-center gap-1 wrap-anywhere">
            {/* R5 — a SEPARATOR between names, found only by playing the pad.
             *  A doubles half renders one span per WhoLine with nothing but a
             *  6px `gap-x-1.5` between them, so two real names run together
             *  into one unreadable string on screen ("PLAY BAD H1 PLAY BAD
             *  H2") while `whoNames()` — the ACCESSIBLE name for the same
             *  button — has always joined with ", ". Sighted and screen-reader
             *  users were reading different content off one control.
             *
             *  A slash rather than the aria label's comma because that is how
             *  a racquet pair is written on a real board (CHEN/WANG), which is
             *  the register this scorebug is written in; `aria-hidden` so the
             *  spoken name keeps its comma and never says "slash". Gated on
             *  `i > 0`, so every half with ONE name — cricket's two halves,
             *  football's two, and every singles fixture in every sport —
             *  renders byte-for-byte what it rendered before. */}
            {i > 0 && (
              <span aria-hidden="true" className="mx-1.5 opacity-60">
                /
              </span>
            )}
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
      {/* R3.5/Task D — a decider's second figure, e.g. football's shoot-out
       *  tally beside the frozen regulation score. `creamText`, NOT
       *  `limeText`: the decider is subordinate to the regulation score, and
       *  reusing the lime would give the two figures equal weight — which is
       *  the confusion this field exists to remove. Absent on every half
       *  shipped before this (types.ts's own doc), so this renders nothing
       *  extra when `sub` is omitted. */}
      {half.sub && (
        <div
          data-half-sub=""
          className={`app-display text-base font-semibold leading-none ${NIGHT_TILE_CLASSES.creamText}`}
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {half.sub}
        </div>
      )}
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
export function Scorebug({ spec, t, onTap, onOpenSheet }: ScorebugProps) {
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
                // Stable e2e handle (R7 review) — `nth(0)`/`nth(1)` is home/
                // away by this map's own render order (documented at every
                // e2e call site). Replaces a `.grid > * >> .app-display.font-
                // bold` structural chain three call sites reached through
                // instead: brittle because it depends on the score figure's
                // OWN layout classes rather than on the half itself, and it
                // breaks the moment either restyles. Clicking the half
                // (anywhere in the button) is equivalent to clicking the
                // score figure inside it — same `onClick`.
                data-role="v3-scorebug-half"
                // `tapSheet` WINS where a skin set it. The half still carries
                // its `tapEvent` — the sheet's job is to build that same
                // event with one more fact attached — so the order here is
                // the contract, not a preference: a skin that sets both means
                // "ask first, then score", never "score and also ask".
                onClick={() => {
                  if (half.tapSheet !== undefined) {
                    onOpenSheet?.(half.tapSheet);
                    return;
                  }
                  if (half.tapEvent) onTap?.(half.tapEvent);
                }}
                aria-label={[whoNames(half.who), hintText].filter(Boolean).join(" ")}
                style={{ minHeight: 44 }}
                className={`${NIGHT_TILE_CLASSES.half} flex min-w-0 flex-col items-center justify-center gap-1 px-3 py-3 text-center outline-offset-[-3px] transition-colors focus-visible:outline focus-visible:outline-2`}
              >
                {content}
              </button>
            );
          }
          return (
            <div
              key={i}
              data-role="v3-scorebug-half"
              className="flex min-w-0 flex-col items-center justify-center gap-1 px-3 py-3 text-center"
            >
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
