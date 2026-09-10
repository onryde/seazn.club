"use client";
// Theme B — the corner bug (_THEMES.md §4), the pad's own stadium-night tile
// so the stream matches the app. `cells[].value` is always "home–away" by
// construction in `overlayModel`, so each row renders its own half of it —
// that split lives here, in the renderer, rather than widening the model.
import type { OverlayModel, OverlayMsg } from "@/lib/overlay-model";

const halfOf = (value: string, row: 0 | 1): string => {
  const parts = value.split("–");
  return parts[row] ?? value;
};

export function OverlayBug({
  model,
  tick,
  msg,
}: {
  model: OverlayModel;
  tick: [boolean, boolean];
  msg: OverlayMsg;
}) {
  return (
    <div className="ovl-bug">
      <div className="ovl-bug-header">
        {model.live ? <span data-testid="ovl-live-dot" className="ovl-live-dot" /> : null}
        <span className="ovl-bug-status">{model.header.context}</span>
        {model.header.period ? <span className="ovl-bug-context">{model.header.period}</span> : null}
        {/* Fix round 5, I3 — §4's header ends in "brand Barlow 24/600 .08em
            ink 70 % — football family: clock Barlow 33/700 LED instead". The
            clock used to borrow `.ovl-bug-brand` and override only `color`,
            so the one number a football viewer reads shipped 27 % small, a
            weight light, and letter-spaced like a wordmark. Its own class,
            not a widening of the brand's — the brand cell below is unchanged.
            I5 — and the brand word itself now comes from the dictionary
            (`overlay.brand`, declared in all four locales since W1 and read
            by nothing until now). */}
        {model.header.clock ? (
          <span className="ovl-bug-clock ovl-display">{model.header.clock}</span>
        ) : (
          <span className="ovl-bug-brand ovl-display">{msg("overlay.brand")}</span>
        )}
      </div>
      {([0, 1] as const).map((row) => {
        const side = model.sides[row];
        return (
          <div
            key={side.short + row}
            data-testid={row === 0 ? "ovl-side-home" : "ovl-side-away"}
            className={`ovl-bug-row ovl-display${side.led ? " ovl-side-led" : ""}${model.voided ? " ovl-voided" : ""}`}
          >
            {side.led ? <span data-testid="ovl-led" className="ovl-led" /> : null}
            <span className="ovl-bug-code">{side.short}</span>
            {side.serving ? <span className="ovl-serve-dot" /> : null}
            {model.cellsKind === "sets" ? (
              <span data-testid="ovl-cells" className="ovl-bug-cells">
                {model.cells.map((cell, i) => (
                  <span key={cell.key} className={i === model.cells.length - 1 ? "ovl-bug-cell-current" : undefined}>
                    {halfOf(cell.value, row)}
                  </span>
                ))}
              </span>
            ) : null}
            <span
              data-testid={row === 0 ? "ovl-big-home" : "ovl-big-away"}
              className={`ovl-bug-score${tick[row] ? " ovl-tick" : ""}`}
            >
              {side.big}
            </span>
            {/* Fix round 4, R4 (F8's twin, unfixed in round 3) — an empty
                meta span still reserves width 78 + gap 18 in every row;
                football has no meta per §4 and must not pay for it. */}
            {side.sub ? <span className="ovl-bug-meta">{side.sub}</span> : null}
          </div>
        );
      })}
      {model.result || model.chase || model.detail.length > 0 ? (
        <div data-testid="ovl-detail" className="ovl-bug-footer ovl-label">
          {model.result ? (
            <span data-testid="ovl-result" className="ovl-detail-emphasis">{model.result}</span>
          ) : model.chase ? (
            <span data-testid="ovl-chase" className="ovl-detail-emphasis">{model.chase}</span>
          ) : null}
          {model.detail.map((line, i) => (
            <span key={line.text + i} className="contents">
              {i > 0 ? " · " : ""}
              {line.tone ? (
                <span data-testid="ovl-chip" className={`ovl-chip ovl-chip-${line.tone}`} />
              ) : null}
              {line.text}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
