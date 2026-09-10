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
        {/* §4 (product ruling 2026-09-10, review finding IMPORTANT 1) — "the
            bug's header never carries the result sentence". `header.period`
            is ONE field and BOTH themes read it, but once a fixture is decided
            it holds the short RESULT sentence, and §4 puts the bug's result in
            the FOOTER while spec'ing this slot at 19.5/500 for "2nd half"-sized
            labels. ~291px ≈ 32 characters are free here after "Final", the gaps
            and "seazn": "NOR won by 8 wickets with 12 balls remaining" wraps
            inside a fixed 48px header and clips, and fr/nl run 15-25% longer.
            `decided` covers a verdict-carrying void too; a void with NO verdict
            is not decided and keeps the sport's own line (I2's regression). */}
        {!model.decided && model.header.period ? (
          <span className="ovl-bug-context">{model.header.period}</span>
        ) : null}
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
          {/* §4 rules 1 and 2 (product rulings 2026-09-10, on the defect Task
              8's hockey seed photographed). "A corner bug is not a log": AT
              MOST THE TWO MOST RECENT entries — `slice(-2)`, because
              `detailOf` pushes the serve/strength lines first and the
              discipline list in engine order, so the newest card is last. With
              `11v8` plus three cards this row wrapped and `.ovl-bug`'s
              `overflow: hidden` cut "AWA Red" in half; the tile must NOT grow
              instead (an OBS operator frames the bug against their camera).
              §3's bar keeps the full list — it has 1776px and a dedicated
              51px band, and this cap is the BUG's, not the model's.

              And each entry is a REAL BOX, not `className="contents"`:
              `display: contents` put separator, chip and label straight into
              the flex container as three independent items, which is what let
              the `·` land on the clipped line as a stray dot detached from its
              label. The same shim was on `overlay-bar.tsx` and is gone there
              too — the bar is merely wide enough to hide it today. */}
          {model.detail.slice(-2).map((line, i) => (
            <span key={line.text + i} className="ovl-detail-entry">
              {i > 0 ? "·" : null}
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
