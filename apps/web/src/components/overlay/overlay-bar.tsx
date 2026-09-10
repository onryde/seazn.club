"use client";
// Theme A — the TV lower third (_THEMES.md §3). Every size, colour and inset
// is a class in globals.css's `.ovl-*` block, which carries the sheet's native
// values; nothing is styled inline here except the LED bar's slide, which is a
// transform the CSS transitions.
import type { OverlayModel, OverlayMsg } from "@/lib/overlay-model";

// Fix round 3, F5 — the bug's own pattern (`overlay-bug.tsx`'s `halfOf`),
// duplicated rather than imported: the two themes stay independent renderers
// (owner answer 18/Q7), and this is three lines. `cells[].value` is always
// "home–away" by construction in `overlayModel`.
const halfOf = (value: string, row: 0 | 1): string => {
  const parts = value.split("–");
  return parts[row] ?? value;
};

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
  return (
    <div className="ovl-bar">
      <div className="ovl-bar-main">
        <div className="ovl-live-cell">
          <span className="ovl-live-row">
            {model.live ? <span data-testid="ovl-live-dot" className="ovl-live-dot" /> : null}
            {model.header.context}
          </span>
          {model.header.period ? <span className="ovl-context">{model.header.period}</span> : null}
        </div>
        {([0, 1] as const).map((row) => {
          const side = model.sides[row];
          return (
            <div
              key={side.short + row}
              data-testid={row === 0 ? "ovl-side-home" : "ovl-side-away"}
              className={`ovl-team-cell ovl-display${side.led ? " ovl-side-led" : ""}${model.voided ? " ovl-voided" : ""}`}
            >
              {side.serving ? <span className="ovl-serve-dot" /> : null}
              <span className="ovl-team-name">{side.name}</span>
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
      {model.detail.length > 0 || model.chase || model.result ? (
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
              <span className="ovl-detail-label">{line.text}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
