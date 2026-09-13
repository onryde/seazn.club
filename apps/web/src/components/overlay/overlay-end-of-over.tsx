"use client";
// Anchored end-of-over card — split (full) or compact (design 2026-09-12 B).
import {
  ballGlyphText,
  type OverlayClosedOver,
  type OverlayCricketBatter,
  type OverlayCricketBowler,
} from "@/lib/overlay-cricket";
import { isFullEndOfOver } from "@/lib/overlay-end-of-over";
import type { OverlayMoment } from "@/lib/overlay-moments";
import type { OverlayMsg } from "@/lib/overlay-model";
import type { Phase } from "./moment-queue";

function batterLine(b: OverlayCricketBatter, mark: string): string {
  const name = b.name ?? "";
  return `${name}${b.onStrike ? mark : ""} ${b.runs} (${b.balls})`;
}

function bowlerLine(b: OverlayCricketBowler): string {
  const parts = [
    b.overs,
    ...(b.maidens === null ? [] : [String(b.maidens)]),
    String(b.runs),
    String(b.wickets),
  ];
  return `${b.name ?? ""} ${parts.join("-")}`.trim();
}

export function OverlayEndOfOverCard(props: {
  moment: OverlayMoment;
  phase: Phase;
  msg: OverlayMsg;
}) {
  const closed = props.moment.endOfOver as OverlayClosedOver;
  const full = isFullEndOfOver(closed);
  const mark = props.msg("overlay.cricket.strikerMark");

  if (!full) {
    return (
      <div
        data-testid="ovl-end-of-over"
        data-variant="compact"
        data-phase={props.phase}
        className={`ovl-end-of-over ovl-end-of-over--compact ovl-end-of-over--${props.phase}`}
      >
        <span className="ovl-end-of-over-title ovl-display">{props.moment.headline}</span>
        <span className="ovl-end-of-over-line">{props.moment.line}</span>
      </div>
    );
  }

  const namedBatters = closed.batters.filter((b) => Boolean(b.name));

  return (
    <div
      data-testid="ovl-end-of-over"
      data-variant="full"
      data-phase={props.phase}
      className={`ovl-end-of-over ovl-end-of-over--full ovl-end-of-over--${props.phase}`}
    >
      <div className="ovl-end-of-over-main">
        <span className="ovl-end-of-over-title ovl-display">{props.moment.headline}</span>
        {namedBatters.map((b) => (
          <span key={`${b.name}-${b.runs}-${b.balls}`} className="ovl-end-of-over-batter">
            {batterLine(b, mark)}
          </span>
        ))}
        {closed.bowler?.name ? (
          <span className="ovl-end-of-over-bowler">{bowlerLine(closed.bowler)}</span>
        ) : null}
      </div>
      <div className="ovl-end-of-over-side">
        <span className="ovl-end-of-over-side-label">{props.msg("overlay.cricket.thisOver")}</span>
        <span className="ovl-end-of-over-glyphs">
          {closed.glyphs.map((g, i) => (
            <span key={i} className="ovl-end-of-over-glyph">
              {ballGlyphText(g)}
            </span>
          ))}
        </span>
        <span className="ovl-end-of-over-runs ovl-display">
          {props.msg("overlay.endOfOver.runsScore", { runs: closed.runs, score: closed.score })}
        </span>
      </div>
    </div>
  );
}
