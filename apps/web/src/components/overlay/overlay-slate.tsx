"use client";
// Match / end card layer (2026-09-12) — NOT a ?style= theme.
// Spec: docs/superpowers/specs/2026-09-12-overlay-match-card-layer-design.md
//
// Transparent canvas + stadium-night plate with `--sport-led` border. Mounted
// by OverlayStage above bar/bug when warming or ended; the scorebug stays
// visible underneath. Live = not mounted.
//
// Class / i18n prefix remains `ovl-slate` / `overlay.slate.*` (rename later).
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { OverlayCricketToss } from "@/lib/overlay-cricket";
import { warmingTossLine } from "@/lib/overlay-openers";
import type { OverlayHighlight, OverlayModel, OverlaySide } from "@/lib/overlay-model";
import type { OverlayThemeProps } from "./theme-registry";

export type SlateState = "warming" | "ended" | "live";

export function slateStateOf(model: OverlayModel): SlateState {
  if (model.decided || model.voided) return "ended";
  if (!model.live) return "warming";
  return "live";
}

const FALLBACK_TILE = ["#7f1d1d", "#115e59"] as const;

function tileStyle(side: OverlaySide, index: 0 | 1): CSSProperties {
  return { background: side.colour ?? FALLBACK_TILE[index] };
}

function metaPill(
  state: "warming" | "ended",
  model: OverlayModel,
  msg: OverlayThemeProps["msg"],
): string {
  const lead = msg(state === "warming" ? "overlay.slate.pillUpcoming" : "overlay.slate.pillResult");
  const parts = [
    lead,
    model.slateMeta?.competition,
    model.slateMeta?.stage,
  ].filter((p): p is string => Boolean(p && p.trim()));
  return parts.join(" · ");
}

function HighlightBox(props: {
  role: "batter" | "bowler";
  item: OverlayHighlight;
  msg: OverlayThemeProps["msg"];
}) {
  return (
    <div className="ovl-slate-highlight" data-testid={`ovl-slate-highlight-${props.role}`}>
      <span className="ovl-slate-highlight-role">
        {props.msg(
          props.role === "batter" ? "overlay.slate.topBatter" : "overlay.slate.topBowler",
        )}
      </span>
      <span className="ovl-slate-highlight-name">{props.item.name}</span>
      <span className="ovl-slate-highlight-stats">
        <span className="ovl-slate-highlight-line">{props.item.line}</span>
        {props.item.detail ? (
          <span className="ovl-slate-highlight-detail">{props.item.detail}</span>
        ) : null}
      </span>
    </div>
  );
}

/** Warming / ended match card. Stage mounts only when not live. */
export function OverlayMatchCard({
  model,
  msg,
  cricketToss,
}: Pick<OverlayThemeProps, "model" | "msg"> & {
  cricketToss?: OverlayCricketToss | null;
}) {
  const state = slateStateOf(model);

  const previousStateRef = useRef<SlateState | undefined>(undefined);
  const [fading, setFading] = useState(false);
  useEffect(() => {
    const previous = previousStateRef.current;
    previousStateRef.current = state;
    if (previous === undefined || previous === state) return;
    setFading(true);
    const timer = setTimeout(() => setFading(false), 250);
    return () => clearTimeout(timer);
  }, [state]);

  if (state === "live") return null;

  const home = model.sides[0];
  const away = model.sides[1];

  return (
    <div className="ovl-slate" data-testid="ovl-slate" data-slate-state={state}>
      <span className="ovl-slate-brand ovl-display">{msg("overlay.brand")}</span>
      <div
        data-testid="ovl-slate-content"
        className={`ovl-slate-content${fading ? " ovl-slate-fading" : ""}`}
      >
        <div className="ovl-slate-card" data-testid="ovl-slate-card">
          <span data-testid="ovl-slate-pill" className="ovl-slate-pill">
            {metaPill(state, model, msg)}
          </span>

          <span data-testid="ovl-slate-headline" className="ovl-slate-headline ovl-display">
            {state === "warming"
              ? msg("overlay.slate.warmingHeadlineVs", { home: home.name, away: away.name })
              : (model.result ?? msg("overlay.slate.endedHeadline"))}
          </span>

          <div className="ovl-slate-matchup" data-testid="ovl-slate-matchup">
            <div className="ovl-slate-team">
              <div
                className="ovl-slate-tile"
                data-testid="ovl-slate-tile-0"
                style={tileStyle(home, 0)}
              >
                <span className="ovl-slate-tile-code ovl-display">{home.short}</span>
                {state === "ended" ? (
                  <span className="ovl-slate-tile-score">
                    {home.big}
                    {home.sub ? ` ${home.sub}` : ""}
                  </span>
                ) : null}
              </div>
              <span className="ovl-slate-name-pill" data-testid="ovl-slate-name-0">
                {home.name}
              </span>
            </div>

            <span className="ovl-slate-vs" data-testid="ovl-slate-vs">
              {msg("overlay.slate.vs")}
            </span>

            <div className="ovl-slate-team">
              <div
                className="ovl-slate-tile"
                data-testid="ovl-slate-tile-1"
                style={tileStyle(away, 1)}
              >
                <span className="ovl-slate-tile-code ovl-display">{away.short}</span>
                {state === "ended" ? (
                  <span className="ovl-slate-tile-score">
                    {away.big}
                    {away.sub ? ` ${away.sub}` : ""}
                  </span>
                ) : null}
              </div>
              <span className="ovl-slate-name-pill" data-testid="ovl-slate-name-1">
                {away.name}
              </span>
            </div>
          </div>

          {state === "ended" && model.highlights && (model.highlights.batter || model.highlights.bowler) ? (
            <div className="ovl-slate-highlights" data-testid="ovl-slate-highlights">
              {model.highlights.batter ? (
                <HighlightBox role="batter" item={model.highlights.batter} msg={msg} />
              ) : (
                <div className="ovl-slate-highlight ovl-slate-highlight--empty" />
              )}
              {model.highlights.bowler ? (
                <HighlightBox role="bowler" item={model.highlights.bowler} msg={msg} />
              ) : (
                <div className="ovl-slate-highlight ovl-slate-highlight--empty" />
              )}
            </div>
          ) : null}

          {state === "warming" ? (
            <>
              <span data-testid="ovl-slate-line" className="ovl-slate-line">
                {warmingTossLine({
                  toss: cricketToss,
                  sideNames: [home.name, away.name],
                  startContext: model.header.context,
                  msg,
                })}
              </span>
              <span data-testid="ovl-slate-indicator-warming" className="ovl-slate-warming-dots">
                <span />
                <span />
                <span />
              </span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** @deprecated Use OverlayMatchCard — kept as alias while tests migrate. */
export const OverlaySlate = OverlayMatchCard;
