"use client";
// The overlay's one client island: transport + projection + the three motions.
//
// Authored at a fixed 1920×1080 canvas and scaled with
// `transform: scale(min(vw/1920, vh/1080))` from the top-left (R15), so OBS at
// 1080p renders 1:1 and the organiser panel's preview renders THE SAME
// COMPONENT at a smaller scale rather than a picture of it.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { sportThemeAttr, sportThemeStyle } from "@/components/v2/scorepad/v3/sport-theme";
import { useLiveFixture } from "@/components/public-site/match-centre/use-live-fixture";
import { fetchOverlayFixture, type OverlayLiveData } from "@/components/public-site/live-score-data";
import { overlayModel, type OverlayModel, type OverlaySideInput } from "@/lib/overlay-model";
import { useOverlayClock } from "./use-overlay-clock";
import { t } from "@/lib/i18n-runtime";
import type { DecidedOutcomeTemplates } from "@/lib/scoring-vocab";
// Owner answer 18 (Q7): the stage knows the REGISTRY, not two components. It
// imports neither `overlay-bar` nor `overlay-bug` — registering a third theme
// must not touch this file, and an import here would be exactly that edit.
import { OVERLAY_THEMES, type ThemeId } from "./theme-registry";

export interface OverlayStageProps {
  fixtureId: string;
  /** The overlay endpoint's payload (Task 0, design §3.2) — the SAME shape the
   *  stage polls, so first paint and every refresh render one contract. */
  initial: OverlayLiveData;
  realtime: boolean;
  sportKey: string;
  /** A registry id, already resolved server-side by `resolveTheme` (Step 6c).
   *  The stage never validates: by the time a value reaches this prop it has
   *  been through the resolver, and a `ThemeId` that is not a registry key is
   *  a compile error. */
  style: ThemeId;
  sides: [OverlaySideInput, OverlaySideInput];
  startLabel: string | null;
  /** The `public` namespace, en-merged server-side. A plain object, so the
   *  island carries only the active locale. */
  dict: Record<string, string>;
  decidedTemplates: DecidedOutcomeTemplates;
  /** True on the overlay route: fill the viewport. False in the console
   *  preview, which sets its own scale on the wrapper. */
  fit?: boolean;
}

export function OverlayStage(props: OverlayStageProps) {
  // One transport, two payloads (Task 1): the overlay endpoint is this
  // stage's fetcher; `MatchCentre` keeps the public JSON. `presentationNowOffsetMs`
  // is 0 until R2 passes `delayMs` — the clock subtracts it either way.
  const { data, presentationNowOffsetMs } = useLiveFixture(props.fixtureId, props.initial, props.realtime, {
    fetcher: fetchOverlayFixture,
  });
  // The ONE timer in the overlay (Step 8a; _THEMES.md §6; owner 2026-09-06:
  // the clock TICKS). Formatted here, handed to the pure model as a string.
  const clockLabel = useOverlayClock(data.clock, data.status, presentationNowOffsetMs);

  const model: OverlayModel = overlayModel({
    sportKey: props.sportKey,
    data,
    sides: props.sides,
    startLabel: props.startLabel,
    clockLabel,
    msg: (key, vars) => t(props.dict, key, vars),
    decidedTemplates: props.decidedTemplates,
  });

  // Score tick: the ONE `big` that changed, and only that one (R13). The
  // previous pair lives in a ref that is read AND written only inside this
  // effect — never during render (`react-hooks/refs` forbids reading
  // `ref.current` in the render body; a separate `usePrevious(value)` hook
  // returning `ref.current` synchronously, as first drafted, tripped it).
  // Held in state and cleared on a 300 ms timer so re-adding the class
  // re-triggers the animation; a bare CSS class on a value that changes twice
  // inside 300 ms would not restart it.
  const previousBigRef = useRef<[string, string] | undefined>(undefined);
  const [tick, setTick] = useState<[boolean, boolean]>([false, false]);
  useEffect(() => {
    const current: [string, string] = [model.sides[0].big, model.sides[1].big];
    const previous = previousBigRef.current;
    previousBigRef.current = current;
    if (previous === undefined) return; // never on mount — OBS shows the page mid-stream
    const next: [boolean, boolean] = [previous[0] !== current[0], previous[1] !== current[1]];
    if (!next[0] && !next[1]) return;
    setTick(next);
    const timer = setTimeout(() => setTick([false, false]), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.sides[0].big, model.sides[1].big]);

  // Canvas scale. useLayoutEffect so the first paint is already at the right
  // size — a visible resize would be an entrance animation, which R13 forbids.
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    if (!props.fit) return;
    const measure = () => setScale(Math.min(window.innerWidth / 1920, window.innerHeight / 1080));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [props.fit]);

  // The registry lookup, and the ONLY place a theme becomes a component. A
  // `props.style === "bar" ? <OverlayBar/> : <OverlayBug/>` branch is what the
  // owner's answer replaces: a third theme would have had to edit it.
  const Theme = OVERLAY_THEMES[props.style].component;

  return (
    <div className={props.fit ? "ovl-fit" : undefined}>
      <div
        data-testid="ovl-root"
        data-style={props.style}
        data-sport-theme={sportThemeAttr(props.sportKey)}
        data-led={model.sides[0].led ? "home" : model.sides[1].led ? "away" : "none"}
        className={`ovl-canvas ovl-label${model.live ? "" : " ovl-static"}`}
        style={{ ...sportThemeStyle(props.sportKey), transform: `scale(${scale})` }}
      >
        <Theme model={model} tick={tick} />
        {/* W2's slab attaches here (R4). Empty and unstyled in W1. */}
        <div data-testid="ovl-moment-slot" />
      </div>
    </div>
  );
}
