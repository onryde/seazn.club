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
      {/* R7-28 — line-clamped, found by reading a real 320 capture: a long
       *  entrant name wrapped to three lines above a single-digit score, so
       *  the name outweighed the number on a surface whose entire job is to
       *  show the score. `line-clamp-N` needs `display:-webkit-box`, which
       *  is why this is no longer `flex` — the children are each
       *  `inline-flex` already, so the LED dot and the "/" separator keep
       *  their own alignment, and a half whose name fits on one or two
       *  lines (cricket's, football's, every singles fixture, most doubles
       *  pairs) renders exactly what it rendered before — a clamp only
       *  takes effect once content actually needs the extra lines.
       *
       *  Landed at SIX lines (was two, then three — see git history for the
       *  intermediate attempt and why it still clipped at a different CI
       *  width). Two AND three both left a render sitting right at the wrap
       *  boundary at the narrowest column (320, ~98px): the actual root
       *  cause turned out to be the TEST'S OWN fixture, not this box — its
       *  doubles player names carried a redundant `${TAG}-${projectTag()}`
       *  suffix copied from the competition label's OWN (genuinely needed)
       *  collision-avoidance pattern, with no equivalent need at the player-
       *  name level (an entrant has no uniqueness requirement; it's scoped
       *  to the one fixture the label already isolates) — see
       *  mobile.spec.ts's own comment at that fixture. Trimming that
       *  brought two real names + separator down from ~89 to ~67 characters
       *  and cleared even the narrowest column reliably (`--repeat-each=5`,
       *  local). Six lines stays as real margin, not a razor's edge, for
       *  whatever length of REAL long name a doubles pair legitimately has
       *  — most render in one or two lines exactly as before; this only
       *  ever matters for a name that's actually this long.
       *
       *  Nothing is lost when it clamps: `whoNames()` builds the half's
       *  ACCESSIBLE name from the same data and is unaffected, so a screen
       *  reader still hears every name in full — the clamp is visual only.
       *  Chassis-wide: every skin's ScorebugSpec renders through here, so
       *  this was verified against the other skins' captures too. */}
      <div
        className={`line-clamp-6 min-w-0 text-center app-display text-[12px] font-semibold tracking-wide ${NIGHT_TILE_CLASSES.creamText} sm:text-sm max-md:line-clamp-2`}
      >
        {half.who.map((w, i) => (
          // NOT `inline-flex`: an inline-flex box is ATOMIC to the
          // `-webkit-box` above, so `line-clamp-2` counted the whole span as
          // ONE line and never clamped at all — the fix shipped inert, and
          // the 320 capture still showed three lines of name. Plain inline
          // text is what the clamp can actually count. The LED dot carries
          // its own spacing now that there is no flex `gap`.
          <span key={i} className="inline wrap-anywhere">
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
                className={`mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle ${NIGHT_TILE_CLASSES.ledDot}`}
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
        <span className={`text-[11px] font-medium ${NIGHT_TILE_CLASSES.creamTextMuted} max-md:block max-md:max-w-full max-md:truncate`}>{hintText}</span>
      )}
    </>
  );
}

/**
 * R8/#676, review round 3 — THE SIZERS' OWN CLASS, and deliberately NOT the
 * `weight` the visible layer uses.
 *
 * THE DEFECT THIS REPLACES. `weight` is built from `item.accent`, and the
 * answered server slot in badminton/tabletennis/volleyball is `accent: true`
 * while its reserved twin is not. Applying `weight` to the sizers therefore
 * measured the SAME `reserve` candidates in `font-semibold` when the slot was
 * answered and `font-medium` when it was held — two different widths for the
 * one slot, so the centred row still moved. That is the exact defect the whole
 * feature exists to close, shrunk rather than removed, and every guard in the
 * wave was blind to it because they all compared the `reserve` ARRAYS (identical
 * by construction) and never what those strings were MEASURED IN.
 *
 * FIXED HERE RATHER THAN IN THE THREE SKINS. Setting `accent: true` on each
 * reserved twin would also equalise the two states, but it asks three skins —
 * and every skin added later — to remember, and it makes `accent` mean two
 * things: types.ts defines it as the VISIBLE strip's own emphasis, and a slot
 * that renders no ink has no emphasis to declare. The sizers are `invisible`
 * by construction, so their weight is a measuring instrument, not a style, and
 * that belongs to the chassis. A skin can now get `accent` wrong in either
 * direction without the reservation moving.
 *
 * `font-semibold` specifically: the WIDER of the plain branch's two weights, so
 * a sizer always reserves at least what the visible layer needs, never less.
 * No colour token — the layer is `visibility:hidden` and paints nothing.
 * `break-words` for the same reason the who-line has it (see HalfContent).
 */
const STRIP_SIZER_CLASS =
  "invisible col-start-1 row-start-1 min-w-0 break-words text-xs font-semibold";

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
                className={`${NIGHT_TILE_CLASSES.half} flex min-w-0 flex-col items-center justify-center gap-1 px-3 py-3 text-center outline-offset-[-3px] transition-colors focus-visible:outline focus-visible:outline-2 max-md:px-2 max-md:py-2`}
              >
                {content}
              </button>
            );
          }
          return (
            <div
              key={i}
              data-role="v3-scorebug-half"
              className="flex min-w-0 flex-col items-center justify-center gap-1 px-3 py-3 text-center max-md:px-2 max-md:py-2"
            >
              {content}
            </div>
          );
        })}
      </div>

      {spec.strip.length > 0 && (
        // Task 13 finding C — the strip is a swipeable rail on phones
        // (`max-md:overflow-x-auto` above), and a still screenshot of it
        // reads as clipped text, not "there is more, scroll for it" (this
        // is an APPROVED affordance the design review flagged as needing a
        // visual cue, not a defect in the scroll behaviour itself — see the
        // dispatch's own already-triaged note on the strip). `relative`
        // here (never on the scrolling div itself) is what lets the fade
        // below stay pinned to the outer box's visible right edge — an
        // `absolute` child of the SCROLLING div would instead be positioned
        // against that div's full scrollable width and sit off-screen past
        // whatever is currently scrolled out of view.
        <div className="relative">
          {/* CI e2e finding (run 33735186301, `parallel 2/2`): making this band
              a scrolling rail on phones tripped axe's `scrollable-region-
              focusable` at SERIOUS impact — `scorepad-skins.spec.ts`'s
              `expectPadA11yClean`. A region that scrolls must be reachable by
              keyboard, and every child here is static text, so the rule's
              "focusable content" escape does not apply either. `tabIndex={0}`
              alone silences axe; `role="group"` + a name is what makes the
              resulting tab stop mean something instead of announcing as a bare
              empty group.

              Unconditional, not `max-md`-scoped: there is no way to vary
              `tabindex` by media query, and the alternatives (measuring
              `scrollWidth`, a width listener) would hydrate differently on the
              server and the client. One extra tab stop on the status band at
              every width, which now also announces itself to a screen reader —
              a net gain at desktop, not a regression.

              `className` stays the FIRST prop: `phone-classes.test.tsx` anchors
              on `<div class="…` immediately after `<div class="relative">`, and
              React emits attributes in JSX order. */}
          <div
            className={`flex flex-wrap items-center justify-center gap-x-4 gap-y-1 ${NIGHT_TILE_CLASSES.bandBg} px-3 py-1.5 max-md:flex-nowrap max-md:justify-start max-md:gap-x-3 max-md:overflow-x-auto max-md:[scrollbar-width:none]`}
            role="group"
            tabIndex={0}
            aria-label={t("pad.scorebug.strip.label")}
          >
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
                  className={`${NIGHT_TILE_CLASSES.ledPanel} text-xs font-semibold max-md:shrink-0 max-md:whitespace-nowrap`}
                >
                  {item.label && (
                    <span className={NIGHT_TILE_CLASSES.ledPanelLabel}>{item.label}</span>
                  )}
                  <span>{item.value}</span>
                </span>
              );
            }
            const text = `${item.label ? `${item.label} ` : ""}${item.value}`;
            const weight = item.accent
              ? `text-xs font-semibold ${NIGHT_TILE_CLASSES.creamText}`
              : `text-xs font-medium ${NIGHT_TILE_CLASSES.creamTextMuted}`;

            // R8/#676 — WIDTH-RESERVING SLOT. `reserve` (types.ts) is the
            // widest value this slot can take; it is laid out INVISIBLY in the
            // same single-cell grid as the real text, so the cell is as wide as
            // the wider of the two and stops depending on WHICH value landed —
            // or on whether one landed at all. That is what keeps the centred
            // row from re-centring when the serve reader refuses and badminton
            // loses both `server` and `court` at once.
            //
            // `invisible` (visibility:hidden), never `display:none` or `w-0`:
            // the sizer must still take part in layout, which is the whole job.
            // `aria-hidden` on the sizer because it is a duplicate of text the
            // visible layer already carries, and on a RESERVED slot because
            // there is no text at all — an empty item announced as one would be
            // exactly the placeholder D-17 refuses.
            //
            // MOBILE FIRST, and this is the part that is easy to get wrong
            // (owner ruling, R8: compose at 320 and expand upward). The
            // reservation must be a PREFERRED width, never a floor. Two things
            // keep it one:
            //
            //  - `min-w-0` — without it a grid/flex child's min-content width is
            //    a hard floor the parent cannot shrink past, so reserving the
            //    WIDER of two names would push the band into horizontal scroll
            //    on a 320px phone: an overflow traded for a re-flow, which is
            //    the worse defect and one the no-h-scroll gate would catch.
            //  - NO `truncate`/`whitespace-nowrap` anywhere in here. `truncate`
            //    sets `white-space: nowrap`, which makes min-content the whole
            //    un-wrapped string — reintroducing exactly the floor `min-w-0`
            //    just removed. The sizers wrap like any other text.
            //
            // So where there is room the slot holds its width and the row stops
            // moving; where there is not, it yields and the band wraps (the row
            // is already `flex-wrap` with a `gap-y-1` for precisely that).
            // `item.reserved ||`, not `item.reserve?.length` alone. A held slot
            // whose reserve came back empty fell through to the PLAIN branch
            // below and printed `${label} ` with no value after it — "Serving "
            // where a fact belongs, which is precisely the D-17 placeholder
            // this field exists to avoid. `assertScorebugSpec` flags that shape
            // but has NO production caller (test-only), so this branch is the
            // only thing standing there.
            if (item.reserved || item.reserve?.length) {
              return (
                <span
                  key={i}
                  {...(item.reserved ? { "aria-hidden": true, "data-strip-reserved": "true" } : {})}
                  // THE ELEMENT WHOSE WIDTH IS ACTUALLY BEING RESERVED, marked
                  // in BOTH states so a browser can read a rect off it. Before
                  // this, nothing could: `data-strip-item-id` sits on the
                  // `justify-self:center` inner span, whose box is its own text
                  // and NOT the reserved cell, and `data-strip-reserved` is
                  // emitted only while the slot is held — so an ANSWERED
                  // reserving slot carried no attribute at all, and the
                  // feature's central claim (the same width in both states) was
                  // unmeasurable by any e2e in either state.
                  data-strip-reserve="true"
                  // `place-items-center`, not `justify-items-center`: a grid
                  // item defaults to `align-self: stretch`, so an `invisible`
                  // sizer that wraps to two lines made the CELL two lines tall
                  // and top-aligned the visible value inside it, while every
                  // sibling strip item sits on the band's own `items-center`.
                  // The reservation is a WIDTH; it must not buy height.
                  className="grid min-w-0 place-items-center max-md:shrink-0"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {/* THE SIZERS ARE SIBLINGS OF THE VISIBLE LAYER, NEVER ITS
                      ANCESTORS' ONLY CONTENT — and `data-strip-item-id` goes on
                      the VISIBLE span below, not on this wrapper.

                      Playwright's toHaveText/toContainText read `textContent`,
                      not `innerText` (`useInnerText` is the opt-OUT), and
                      `textContent` includes visibility:hidden subtrees. Putting
                      the id on this wrapper therefore folded every reserve
                      candidate into the located element's text: table tennis's
                      `toHaveText("2nd serve")` saw "1st serve2nd serve2nd
                      serve", volleyball's saw "Rotation 6Rotation 2", and every
                      `not.toContainText(<the other player>)` assertion went
                      vacuously green because the reserve holds both names by
                      construction. Eight live assertions across four specs.

                      `min-w-0` on each sizer as well as the track: a grid
                      track's automatic minimum is its items' min-content, so
                      without it the widest candidate is still a floor and the
                      box yields while the ink overflows. */}
                  {item.reserve?.map((candidate, c) => (
                    <span key={c} aria-hidden className={STRIP_SIZER_CLASS}>
                      {item.label ? `${item.label} ` : ""}
                      {candidate}
                    </span>
                  ))}
                  <span
                    {...(item.id && !item.reserved ? { "data-strip-item-id": item.id } : {})}
                    // `break-words` beside `min-w-0`, the same pair HalfContent
                    // uses on the who-line and for the same reason: `min-w-0`
                    // lets the box shrink, but an unbroken surname has no break
                    // opportunity without `overflow-wrap`, so the ink overflows
                    // a box that yielded and is CLIPPED at both ends by the
                    // centring, under the tile root's `overflow-hidden`. The
                    // page never scrolls, so the h-scroll gate cannot see it.
                    className={`col-start-1 row-start-1 min-w-0 break-words ${weight}`}
                  >
                    {item.reserved ? "" : text}
                  </span>
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
                className={`${weight} max-md:shrink-0 max-md:whitespace-nowrap`}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {text}
              </span>
            );
          })}
          </div>
          {/* The fade itself: `pointer-events-none` so it never intercepts a
              swipe or a tap on the last visible strip item, `aria-hidden`
              since it is purely decorative (the scrollable region's own
              content is what a screen reader needs), and `md:hidden` so it
              is zero-cost/zero-DOM-effect at the width this rail wraps
              instead of scrolls. `pad-strip-fade` (globals.css) is the
              SAME custom property `NIGHT_TILE_CLASSES.bandBg` (`pad-board-2`,
              just above) paints the rail's own background from — a class,
              not an inline `var(--sport-...)` here, so the fade blends into
              whichever sport's band colour is live without this file's own
              source tripping sport-theme.test.ts's ban on any v3 component
              writing a literal `--sport-` of its own (see that class's own
              comment in globals.css). */}
          <div
            aria-hidden="true"
            className="pad-strip-fade pointer-events-none absolute inset-y-0 right-0 w-8 md:hidden"
          />
        </div>
      )}
    </div>
  );
}
