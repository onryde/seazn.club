"use client";
// Theme A — the TV lower third (_THEMES.md §3). Every size, colour and inset
// is a class in globals.css's `.ovl-*` block, which carries the sheet's native
// values; nothing is styled inline here except the LED bar's slide, which is a
// transform the CSS transitions.
import type { OverlayModel } from "@/lib/overlay-model";

// Fix round 3, F5 — the bug's own pattern (`overlay-bug.tsx`'s `halfOf`),
// duplicated rather than imported: the two themes stay independent renderers
// (owner answer 18/Q7), and this is three lines. `cells[].value` is always
// "home–away" by construction in `overlayModel`.
const halfOf = (value: string, row: 0 | 1): string => {
  const parts = value.split("–");
  return parts[row] ?? value;
};

export function OverlayBar({ model, tick }: { model: OverlayModel; tick: [boolean, boolean] }) {
  // Fix round 3, F6 — the between-cells LED count (`_THEMES.md` §3's
  // "games-won cell LED" / tennis's points cell): only for the sport
  // families that have both a cell breakdown AND no clock cell of their own
  // (tennis/badminton/tabletennis/volleyball) — football/hockey/icehockey
  // already occupy this slot with `header.clock`.
  const betweenLed = model.cells.length > 0 && !model.header.clock;
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
              {model.cells.length > 0 ? (
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
        <div className="ovl-brand ovl-display">seazn</div>
      </div>
      {model.detail.length > 0 || model.chase || model.result ? (
        <div data-testid="ovl-detail" className="ovl-detail-band">
          {model.result ? (
            <span data-testid="ovl-result" className="ovl-detail-emphasis">{model.result}</span>
          ) : model.chase ? (
            <span data-testid="ovl-chase" className="ovl-detail-emphasis">{model.chase}</span>
          ) : null}
          {model.detail.map((line, i) => (
            <span key={line.text + i} className="contents">
              {i > 0 || model.chase || model.result ? <span className="ovl-detail-sep" /> : null}
              {line.tone ? (
                <span data-testid="ovl-chip" className={`ovl-chip ovl-chip-${line.tone}`} />
              ) : null}
              <span>{line.text}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
