"use client";
// Theme A — the TV lower third (_THEMES.md §3). Every size, colour and inset
// is a class in globals.css's `.ovl-*` block, which carries the sheet's native
// values; nothing is styled inline here except the LED bar's slide, which is a
// transform the CSS transitions.
import { useLayoutEffect, useRef, useState } from "react";
import { hasDetailBand, type OverlayModel, type OverlayMsg } from "@/lib/overlay-model";
import { OverlayBallGlyphs } from "./overlay-ball-glyphs";
import { availableNameWidth, pickNameRung } from "./name-ladder";

// Fix round 3, F5 — the bug's own pattern (`overlay-bug.tsx`'s `halfOf`),
// duplicated rather than imported: the two themes stay independent renderers
// (owner answer 18/Q7), and this is three lines. `cells[].value` is always
// "home–away" by construction in `overlayModel`.
const halfOf = (value: string, row: 0 | 1): string => {
  const parts = value.split("–");
  return parts[row] ?? value;
};

/**
 * `_THEMES.md` §1's size step (W2-F45): the longest rung of `side.ladder` that
 * fits the cell.
 *
 * MEASURED, NOT COUNTED. At 45 px the threshold sits near 34 characters, but
 * only near: the face is condensed and "Wolverhampton" and "Illinois" are the
 * same length and nowhere near the same width. A character rule would have to
 * be wrong on one side or the other, so the browser measures.
 *
 * THE PROBES ARE THE MEASUREMENT. Each rung is rendered once, `position: fixed`
 * and hidden, so its natural width is readable whichever rung is on screen —
 * which is what lets the choice be made in ONE pass instead of rendering a
 * rung to find out it did not fit. They are `visibility: hidden` rather than
 * `display: none` (no box, no width) and carry `aria-hidden`. Fixed, not
 * absolute: an absolute probe inside `overflow: hidden` still inflates the
 * name box's scrollWidth in Chromium, which the visual gate reports as a clip
 * of the full name (run 34834966169).
 *
 * FIRST PAINT IS THE FULL NAME, before any effect runs: the server render and a
 * browser source with JS still starting both show what W1 showed. `.ovl-team-name`
 * clips, so the pre-measurement frame is a clipped name rather than one painted
 * across the brand mark — §1 forbids truncation as a RESTING state, and this
 * one lasts a frame.
 *
 * RE-MEASURED BY ResizeObserver on the box AND on every probe. The box covers
 * the cell resizing (a score going 9 → 10, the context line changing); the
 * probes cover the web font arriving, which changes every natural width without
 * moving a single box.
 *
 * THE PROBE REF CALLBACK DOES NOT MEASURE (review 2026-09-14, M2). It used to
 * call the effect's own `measure()` on every attach, but React re-invokes an
 * inline ref callback (a fresh function identity) on EVERY commit, not just
 * mount — that forced a full re-measure per render for no reason: React runs
 * every ref callback for a commit before that commit's layout effects, so by
 * the time the `useLayoutEffect` below runs, `probeRefs.current` is already
 * fully populated and its own synchronous `measure()` call covers mount. The
 * ResizeObserver above covers everything after mount.
 */
function TeamName({ ladder }: { ladder: readonly string[] }) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const probeRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [rung, setRung] = useState(0);
  const [settled, setSettled] = useState(false);
  // The ladder's identity, not the array's: `overlayModel` builds a fresh one
  // every poll. NUL cannot occur in an entrant name.
  const key = ladder.join("\u0000");

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    // A shorter ladder leaves DETACHED nodes behind the new ones; observing
    // those would be watching boxes nothing renders.
    probeRefs.current.length = ladder.length;
    setSettled(false);
    const measure = () => {
      const probes = probeRefs.current.slice(0, ladder.length);
      if (probes.some((p) => p === null)) return;
      const widths = probes.map((p) => p!.getBoundingClientRect().width);
      const available = availableNameWidth(box);
      if (available === 0) return; // not laid out; every rung would read as too wide
      // `current` is read from the DOM rather than from `rung`, so this effect
      // does not have to re-run (and re-observe) on every rung change.
      const current = Number(box.dataset.rung ?? 0);
      const next = pickNameRung(widths, available, current);
      setRung(next);
      // Resting state only: the chosen rung must fit the cell the browser
      // measured. The visual gate's `no-clip` runs after `fonts.ready`, but
      // before this settles the first paint still carries the full name under
      // `overflow: hidden` — realClips, not truncatedByDesign.
      setSettled(widths[next]! <= available + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    for (const probe of probeRefs.current) if (probe !== null) observer.observe(probe);
    return () => observer.disconnect();
    // `ladder` is read from the closure; `key` is its identity (see above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <span
      ref={boxRef}
      className="ovl-team-name"
      data-rung={rung}
      data-ladder-settled={settled ? "true" : undefined}
    >
      {/* The rung ON AIR gets its own element: the probes are children of this
          box too, so `textContent` here is every rung concatenated and an
          assertion written against it would pass in every state. */}
      <span data-testid="ovl-team-name">{ladder[rung] ?? ladder[0]}</span>
      {ladder.map((text, i) => (
        <span
          key={text}
          aria-hidden
          className="ovl-team-name-probe"
          ref={(el) => {
            probeRefs.current[i] = el;
          }}
        >
          {text}
        </span>
      ))}
    </span>
  );
}

export function OverlayBar({
  model,
  tick,
  msg,
}: {
  model: OverlayModel;
  tick: [boolean, boolean];
  msg: OverlayMsg;
}) {
  // Fix round 4, R2 (was F6, round 3, which is the regression this
  // corrects) — the between-cells LED count (`_THEMES.md` §3's "games-won
  // cell LED" / tennis's points cell) belongs ONLY to the set/game sports
  // (tennis/badminton/tabletennis/volleyball). Gated on `cellsKind` — NOT
  // on `!model.header.clock` — because `clockOf` only ever returns a clock
  // when the engine snapshot's phase matches, so a great many football
  // folds carry no clock at all; the old guard fell through for exactly
  // that state and gave football the racket sports' cell.
  const betweenLed = model.cellsKind === "sets";
  const focus = model.focus;
  const sideRows: readonly (0 | 1)[] = focus ? [focus.hero] : [0, 1];
  return (
    <div className="ovl-bar">
      <div className="ovl-bar-main">
        <div className="ovl-live-cell">
          <span className="ovl-live-row">
            {model.live ? <span data-testid="ovl-live-dot" className="ovl-live-dot" /> : null}
            {model.header.context ? model.header.context : null}
          </span>
          {model.header.period ? <span className="ovl-context">{model.header.period}</span> : null}
        </div>
        {focus?.strip ? (
          <div data-testid="ovl-innings-strip" className="ovl-innings-strip ovl-label">
            {focus.strip}
          </div>
        ) : null}
        {sideRows.map((row) => {
          const side = model.sides[row];
          return (
            <div
              key={side.short + row}
              data-testid={row === 0 ? "ovl-side-home" : "ovl-side-away"}
              className={`ovl-team-cell ovl-display${focus ? " ovl-team-cell--hero" : ""}${side.led ? " ovl-side-led" : ""}${model.voided ? " ovl-voided" : ""}`}
            >
              {side.serving ? <span className="ovl-serve-dot" /> : null}
              <TeamName ladder={side.ladder} />
              {model.cellsKind === "sets" ? (
                <span data-testid="ovl-cells" className="ovl-bar-cells">
                  {model.cells.map((cell, i) => (
                    <span
                      key={cell.key}
                      className={i === model.cells.length - 1 ? "ovl-bar-cell-current" : undefined}
                    >
                      {halfOf(cell.value, row)}
                    </span>
                  ))}
                </span>
              ) : null}
              <span
                data-testid={row === 0 ? "ovl-big-home" : "ovl-big-away"}
                className={`ovl-team-score${tick[row] ? " ovl-tick" : ""}`}
              >
                {side.big}
              </span>
              {side.sub ? <span className="ovl-team-meta">{side.sub}</span> : null}
              {side.led ? <span data-testid="ovl-led" className="ovl-led" /> : null}
            </div>
          );
        })}
        {betweenLed ? (
          <div className="ovl-cells-led ovl-display">
            {model.sides[0].big} : {model.sides[1].big}
          </div>
        ) : null}
        {model.header.clock ? <div className="ovl-clock-cell ovl-display">{model.header.clock}</div> : null}
        {/* Fix round 5, I5 — `overlay.brand` shipped in all four locales with
            no reader while three components hardcoded the wordmark. One
            authority, resolved through the SAME `msg` the projection uses. */}
        <div className="ovl-brand ovl-display">{msg("overlay.brand")}</div>
      </div>
      {hasDetailBand(model) ? (
        <div data-testid="ovl-detail" className="ovl-detail-band">
          {model.result ? (
            <span data-testid="ovl-result" className="ovl-detail-emphasis">{model.result}</span>
          ) : model.chase ? (
            <span data-testid="ovl-chase" className="ovl-detail-emphasis">{model.chase}</span>
          ) : null}
          {/* §4 rule 2 (product ruling 2026-09-10) — an entry is ONE UNIT.
              `className="contents"` sat here as well as on the bug's footer,
              and `display: contents` puts separator, chip and label straight
              into the flex container as three independent items. Only the bug
              misbehaves today (480px against this band's 1776px), but the
              latent bug is identical and the ruling names both files: "the bar
              and the bug are twins, and a composition guard added to one is
              owed to the other in the same change". `.ovl-detail-entry` keeps
              this band's own 33px spacing inside the box, so nothing here
              moves. The bar keeps the FULL list — the two-entry cap is §4's
              and belongs to the bug alone. */}
          {model.detail.map((line, i) => (
            <span key={line.text + i} className="ovl-detail-entry">
              {i > 0 || model.chase || model.result ? <span className="ovl-detail-sep" /> : null}
              {line.tone ? (
                <span data-testid="ovl-chip" className={`ovl-chip ovl-chip-${line.tone}`} />
              ) : null}
              {/* `.ovl-detail-label` carries §4's ellipsis (globals.css). The
                  bar has 1776px and is nowhere near its own boundary, but the
                  guard is the PAIR — §4's own lesson is that a composition
                  guard added to one theme is owed to the other in the same
                  change, and `.ovl-detail-entry`'s `nowrap` now applies here
                  too, so an es/nl detail list would overflow this band rather
                  than wrap. */}
              <span className="ovl-detail-copy">
                {line.text ? <span className="ovl-detail-label">{line.text}</span> : null}
                {line.glyphs && line.glyphs.length > 0 ? (
                  <OverlayBallGlyphs glyphs={line.glyphs} />
                ) : null}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
