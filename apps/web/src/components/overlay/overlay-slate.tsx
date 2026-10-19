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
import { warmingLine } from "@/lib/overlay-openers";
import { overlayTossOf, type OverlayCarromToss } from "@/lib/overlay-toss";
import type { OverlayHighlight, OverlayModel, OverlaySide } from "@/lib/overlay-model";
import type { OverlayThemeProps } from "./template-registry";
import type { SceneCard } from "./overlay-scene";

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
  state: "warming" | "ended" | null,
  model: OverlayModel,
  msg: OverlayThemeProps["msg"],
): string {
  // R2005: a scene card (`state` null) has no lead word — its own line or title says what it is.
  const lead = state === null ? undefined : msg(state === "warming" ? "overlay.slate.pillUpcoming" : "overlay.slate.pillResult");
  const parts = [
    lead,
    model.slateMeta?.competition,
    model.slateMeta?.stage,
  ].filter((p): p is string => Boolean(p && p.trim()));
  return parts.join(" · ");
}

/** The card a slate state shows when no scene picks one: warming → Upcoming, ended → Result, live → none. */
function layerCardOf(state: SlateState): SceneCard | null {
  return state === "warming" ? "upcoming" : state === "ended" ? "result" : null;
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

/** Warming / ended match card. Stage mounts only when not live — or, R2005, when a scene picks a card. */
export function OverlayMatchCard({
  model,
  msg,
  sportKey,
  cricketToss,
  carromToss,
  card,
}: Pick<OverlayThemeProps, "model" | "msg"> & {
  /** Whose warming line this is: only a sport that declares a toss shows one (review d, PR #974). */
  sportKey: string;
  cricketToss?: OverlayCricketToss | null;
  /** R2005 change 11: carrom's toss (who breaks first), beside cricket's. */
  carromToss?: OverlayCarromToss | null;
  /** R2005: the card the active SCENE picked (`sceneFor`). Absent: the slate state's own card, exactly as before. */
  card?: SceneCard | null;
}) {
  const state = slateStateOf(model);
  const variant = card === undefined ? layerCardOf(state) : card;

  const previousVariantRef = useRef<SceneCard | null | undefined>(undefined);
  const [fading, setFading] = useState(false);
  useEffect(() => {
    const previous = previousVariantRef.current;
    previousVariantRef.current = variant;
    if (previous === undefined || previous === variant) return;
    setFading(true);
    const timer = setTimeout(() => setFading(false), 250);
    return () => clearTimeout(timer);
  }, [variant]);

  if (variant === null) return null;
  if (variant === "reconnecting" || variant === "ended") {
    return <SceneMatchCard variant={variant} state={state} model={model} msg={msg} fading={fading} />;
  }
  // Upcoming is the warming card and Result the ended one (`sceneFor` pairs them with those slate states only).
  const cardState: "warming" | "ended" = variant === "upcoming" ? "warming" : "ended";

  const home = model.sides[0];
  const away = model.sides[1];
  const warming =
    cardState === "warming"
      ? warmingLine({ sportKey, toss: overlayTossOf({ cricketToss, carromToss }), sideNames: [home.name, away.name], startContext: model.header.context, msg })
      : "";

  return (
    <div className="ovl-slate" data-testid="ovl-slate" data-slate-state={cardState}>
      <span className="ovl-slate-brand ovl-display">{msg("overlay.brand")}</span>
      <div
        data-testid="ovl-slate-content"
        className={`ovl-slate-content${fading ? " ovl-slate-fading" : ""}`}
      >
        <div className="ovl-slate-card" data-testid="ovl-slate-card">
          <span data-testid="ovl-slate-pill" className="ovl-slate-pill">
            {metaPill(cardState, model, msg)}
          </span>

          {/* Only the pairing clamps (`--pairing`): the Result headline is the outcome sentence and is never cut. */}
          <span
            data-testid="ovl-slate-headline"
            className={`ovl-slate-headline${cardState === "warming" ? " ovl-slate-headline--pairing" : ""} ovl-display`}
          >
            {cardState === "warming"
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
                {cardState === "ended" ? (
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
                {cardState === "ended" ? (
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

          {cardState === "ended" && model.highlights && (model.highlights.batter || model.highlights.bowler) ? (
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

          {cardState === "warming" ? (
            <>
              {/* A sport with no toss and no start time has nothing to say here — never an empty line. */}
              {warming ? (
                <span data-testid="ovl-slate-line" className="ovl-slate-line">
                  {warming}
                </span>
              ) : null}
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

/** One team on a scene card: the tile (code, and the score when the card carries one) over the name pill — the same
 *  markup and classes as the Upcoming / Result cards, so the scene cards inherit their measured layout. */
function SceneTeam({ side, index, withScore }: { side: OverlaySide; index: 0 | 1; withScore: boolean }) {
  return (
    <div className="ovl-slate-team">
      <div className="ovl-slate-tile" data-testid={`ovl-slate-tile-${index}`} style={tileStyle(side, index)}>
        <span className="ovl-slate-tile-code ovl-display">{side.short}</span>
        {withScore ? (
          <span className="ovl-slate-tile-score">
            {side.big}
            {side.sub ? ` ${side.sub}` : ""}
          </span>
        ) : null}
      </div>
      <span className="ovl-slate-name-pill" data-testid={`ovl-slate-name-${index}`}>
        {side.name}
      </span>
    </div>
  );
}

/**
 * R2005's two scene cards (overlay templates spec 2026-10-15 §4.1–§4.2, D8), on the Upcoming / Result card's own
 * stadium-night plate and inside the same `.ovl-slate-content` region, so R2007's card layout and its gallery checks
 * cover them unedited.
 *
 *  - RECONNECTING: who is playing, and the one line that says the camera is coming back, led by a pulsing LED dot (the
 *    broadcast "signal" lamp). No score: the score bug stays on screen above the scene, and a second copy of it on the
 *    card would be two authorities for one number.
 *  - STREAM ENDED: the title, and the score as it stands — the match did not finish on camera, so this card never
 *    claims a result.
 */
function SceneMatchCard({
  variant,
  state,
  model,
  msg,
  fading,
}: {
  variant: "reconnecting" | "ended";
  state: SlateState;
  model: OverlayModel;
  msg: OverlayThemeProps["msg"];
  fading: boolean;
}) {
  const home = model.sides[0];
  const away = model.sides[1];
  const pill = metaPill(null, model, msg);
  const reconnecting = variant === "reconnecting";
  return (
    <div className="ovl-slate" data-testid="ovl-slate" data-slate-state={state} data-card={variant}>
      <span className="ovl-slate-brand ovl-display">{msg("overlay.brand")}</span>
      <div data-testid="ovl-slate-content" className={`ovl-slate-content${fading ? " ovl-slate-fading" : ""}`}>
        <div className="ovl-slate-card" data-testid="ovl-slate-card" data-card={variant}>
          {pill ? (
            <span data-testid="ovl-slate-pill" className="ovl-slate-pill">
              {pill}
            </span>
          ) : null}
          <span
            data-testid="ovl-slate-headline"
            className={`ovl-slate-headline${reconnecting ? " ovl-slate-headline--pairing" : ""} ovl-display`}
          >
            {reconnecting
              ? msg("overlay.slate.warmingHeadlineVs", { home: home.name, away: away.name })
              : msg("overlay.scene.ended.title")}
          </span>
          <div className="ovl-slate-matchup" data-testid="ovl-slate-matchup">
            <SceneTeam side={home} index={0} withScore={!reconnecting} />
            <span className="ovl-slate-vs" data-testid="ovl-slate-vs">
              {msg("overlay.slate.vs")}
            </span>
            <SceneTeam side={away} index={1} withScore={!reconnecting} />
          </div>
          {reconnecting ? (
            <span data-testid="ovl-slate-line" className="ovl-slate-line ovl-slate-status">
              <span data-testid="ovl-slate-status-dot" className="ovl-slate-status-dot" aria-hidden="true" />
              {msg("overlay.scene.reconnecting.line")}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** @deprecated Use OverlayMatchCard — kept as alias while tests migrate. */
export const OverlaySlate = OverlayMatchCard;
