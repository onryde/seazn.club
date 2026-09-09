"use client";
// Theme A — the TV lower third (_THEMES.md §3). Every size, colour and inset
// is a class in globals.css's `.ovl-*` block, which carries the sheet's native
// values; nothing is styled inline here except the LED bar's slide, which is a
// transform the CSS transitions.
import type { OverlayModel } from "@/lib/overlay-model";

export function OverlayBar({ model, tick }: { model: OverlayModel; tick: [boolean, boolean] }) {
  return (
    <div className="ovl-bar">
      <div className="ovl-bar-main">
        <div className="ovl-live-cell">
          <span className="ovl-live-row">
            {model.live ? <span data-testid="ovl-live-dot" className="ovl-live-dot" /> : null}
            {model.header.context}
          </span>
          {model.cells.length > 0 ? (
            <span data-testid="ovl-cells" className="ovl-context">
              {model.cells.map((c) => c.value).join("  ")}
            </span>
          ) : null}
        </div>
        {([0, 1] as const).map((row) => {
          const side = model.sides[row];
          return (
            <div
              key={side.short + row}
              data-testid={row === 0 ? "ovl-side-home" : "ovl-side-away"}
              className={`ovl-team-cell ovl-display${side.led ? " ovl-side-led" : ""}`}
            >
              {side.serving ? <span className="ovl-serve-dot" /> : null}
              <span className="ovl-team-name">{side.name}</span>
              <span
                data-testid={row === 0 ? "ovl-big-home" : "ovl-big-away"}
                className={`ovl-team-score${tick[row] ? " ovl-tick" : ""}`}
              >
                {side.big}
              </span>
              <span className="ovl-team-meta">{side.sub ?? ""}</span>
              {side.led ? <span data-testid="ovl-led" className="ovl-led" /> : null}
            </div>
          );
        })}
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
