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
import { maxSeq, momentsFor } from "@/lib/overlay-moments";
import { useMomentQueue } from "./use-moment-queue";
import { OverlayMomentSlab } from "./overlay-moment";
import { OVERLAY_MOMENT_FOLD_MS } from "./moment-timing";
import { fetchOverlayFixture, type OverlayLiveData } from "@/components/public-site/live-score-data";
import {
  overlayModel,
  type OverlayModel,
  type OverlayMsg,
  type OverlaySideInput,
} from "@/lib/overlay-model";
import { useOverlayClock } from "./use-overlay-clock";
import { t } from "@/lib/i18n-runtime";
import type { DecidedOutcomeTemplates } from "@/lib/scoring-vocab";
// Owner answer 18 (Q7): the stage knows the REGISTRY, not two components. It
// imports neither `overlay-bar` nor `overlay-bug` — registering a third theme
// must not touch this file, and an import here would be exactly that edit.
import { OVERLAY_THEMES, slabPlacementFor, type ThemeId } from "./theme-registry";

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
  /** Presentation delay in ms — Task 5d's `?delay=`, already parsed and
   *  bounded server-side by `resolveDelayMs` (`lib/overlay-delay.ts`) before
   *  it ever reaches this prop; the stage passes it straight through to
   *  `useLiveFixture`, never re-validates it. `undefined`/0 behaves exactly
   *  like every pre-Task-5d caller (no delay).
   *
   *  Non-zero means the stage draws NO theme for its first `delayMs` — see
   *  the `awaitingDelay` branch below and I1 in `use-live-fixture.ts`. */
  delayMs?: number;
  /** True on the overlay route: fill the viewport. False in the console
   *  preview, which sets its own scale on the wrapper. */
  fit?: boolean;
}

/** Stable identity: a fresh `[]` every render would re-run the enqueue effect
 *  on every poll for nothing. */
const EMPTY_MOMENTS: never[] = [];

/**
 * SSR-safe `prefers-reduced-motion`, live if the viewer flips it.
 *
 * A second copy of the one in `components/v2/board/ai-trace.tsx`, and stated as
 * such: that one is a v2 board internal, not exported, and reaching into
 * another wave's component from the overlay to save ten lines buys a coupling
 * worth more than the duplication. Worth unifying into `lib/` when something
 * else needs a third.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    // Guarded for TWO no-DOM callers, not one: the server render, and this
    // repo's own unit tests — `apps/web` vitest is `environment: "node"` and
    // the hook harness really does run effects, so an unguarded
    // `window.matchMedia` here reddened eight stage tests with
    // `ReferenceError: window is not defined`.
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return reduced;
}

export function OverlayStage(props: OverlayStageProps) {
  // One transport, two payloads (Task 1): the overlay endpoint is this
  // stage's fetcher; `MatchCentre` keeps the public JSON. `presentationNowOffsetMs`
  // is `props.delayMs` (Task 5d's `?delay=`, resolved server-side in
  // page.tsx) — 0 when absent, exactly as before Task 5d; the clock
  // subtracts it either way.
  const { data, presentationNowOffsetMs, awaitingDelay } = useLiveFixture(props.fixtureId, props.initial, props.realtime, {
    fetcher: fetchOverlayFixture,
    delayMs: props.delayMs,
  });
  // The ONE timer in the overlay (Step 8a; _THEMES.md §6; owner 2026-09-06:
  // the clock TICKS). Formatted here, handed to the pure model as a string.
  const clockLabel = useOverlayClock(data.clock, data.status, presentationNowOffsetMs);

  // ONE dictionary channel (Task 5e fix round). The projection and the theme
  // read the SAME resolver over the SAME `props.dict` — a theme that resolved
  // its own copy would be a second authority for the same fact, and the two
  // could disagree about the locale mid-broadcast.
  const msg: OverlayMsg = (key, vars) => t(props.dict, key, vars);

  /**
   * W2 — the moments the slab raises, and the two rules that stop it lying.
   *
   * THE BASELINE IS THE MOUNT'S TIP, taken once. OBS opens a browser source
   * mid-broadcast; without this the whole window would replay the last eight
   * events at whoever just went live. A lazy `useState` initialiser rather than
   * a ref, because reading a ref during render is what `react-hooks/refs`
   * forbids (the score tick above carries the same note).
   *
   * AND NOTHING IS RAISED WHILE THE DELAYED TRANSPORT IS CATCHING UP
   * (`awaitingDelay`, W2-F11). Under `?delay=`, `initial` is the UNDELAYED
   * server render while `data` walks forward from further back — so the
   * baseline already sits ahead of the delayed tip and nothing fires until the
   * stream genuinely passes it. The gate is belt and braces on top of that: a
   * burst of history arriving in one frame is exactly what it must not do.
   *
   * Repeats are the QUEUE's problem, not this one: the transport re-sends the
   * whole window every poll and `momentQueueReducer` remembers what it has
   * shown.
   */
  const [momentBaseline] = useState(() => maxSeq(props.initial.recent));
  const placement = slabPlacementFor(props.style, props.sportKey);
  const reducedMotion = usePrefersReducedMotion();

  const model: OverlayModel = overlayModel({
    sportKey: props.sportKey,
    data,
    sides: props.sides,
    startLabel: props.startLabel,
    clockLabel,
    msg,
    decidedTemplates: props.decidedTemplates,
  });

  // The slab's queue. `momentsFor` is pure and cheap; the queue owns every
  // decision about WHEN, and this hands it the short codes the set-won line
  // names a winner with — the same `model.sides[].short` the scorebug paints,
  // never a second derivation.
  const { current: moment, phase } = useMomentQueue(
    awaitingDelay
      ? EMPTY_MOMENTS
      : momentsFor(props.sportKey, data.recent ?? [], momentBaseline, msg, [
          model.sides[0].short,
          model.sides[1].short,
        ]),
    { reducedMotion },
  );

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

  // I1 (2026-09-10). Under `?delay=`, the transport presents nothing until the
  // delay has elapsed — the snapshot in hand at t=0 was taken at t=0 and says
  // nothing about t−delayMs, so painting it puts the score AHEAD of the
  // picture, which is the one failure the parameter exists to prevent. The
  // stage therefore draws no theme meanwhile.
  //
  // The root still mounts: `.ovl-canvas` and `.ovl-fit` carry no background of
  // their own, so an empty canvas is transparent — the browser source shows
  // the picture with no scorebug, not a black rectangle over it, and OBS gets
  // a document rather than an empty body. Nothing model-derived is emitted:
  // `data-led` would put who-is-leading in the DOM even with nothing drawn.
  //
  // Reached only when `props.delayMs` is set. Every pre-Task-5d caller — the
  // overlay route without `?delay=`, and the console preview — has
  // `awaitingDelay === false` for the life of the island and never sees this.
  if (awaitingDelay) {
    return (
      <div className={props.fit ? "ovl-fit" : undefined}>
        <div
          data-testid="ovl-root"
          data-style={props.style}
          data-sport-theme={sportThemeAttr(props.sportKey)}
          data-awaiting-delay="1"
          data-led="none"
          className="ovl-canvas ovl-label ovl-static"
          style={{ ...sportThemeStyle(props.sportKey), transform: `scale(${scale})` }}
        />
      </div>
    );
  }

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
        {/* `OverlayThemeProps` (theme-registry.ts) — the model, the score
            tick, the ONE `msg` above, and the sport. The last two are what
            let a theme carry its own copy and composite the sport's own
            scorebug; §3's bar and §4's bug ignore both. */}
        <Theme model={model} tick={tick} msg={msg} sportKey={props.sportKey} />
        {/* W2's slab attaches here (R4). The slot CLIPS: the slab slides out
            from under the scorebug rather than appearing beside it, so the
            wrapper owns the `overflow: hidden` and the slab owns the
            transform. The fold duration crosses into CSS as a custom property
            from `moment-timing.ts`, so the paint and the state machine cannot
            disagree about how long a fold takes. */}
        <div
          data-testid="ovl-moment-slot"
          className={`ovl-moment-slot ovl-moment-slot--${placement}`}
          style={{ "--ovl-slab-fold": `${OVERLAY_MOMENT_FOLD_MS}ms` } as React.CSSProperties}
        >
          {moment === null ? null : (
            <OverlayMomentSlab moment={moment} phase={phase} placement={placement} />
          )}
        </div>
      </div>
    </div>
  );
}
