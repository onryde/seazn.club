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
import { maxSeq } from "@/lib/overlay-moments";
import { closedOverBaselineOf } from "@/lib/overlay-end-of-over";
import { stageIncoming } from "@/lib/overlay-incoming";
import { useMomentQueue } from "./use-moment-queue";
import { OverlayMomentSlab } from "./overlay-moment";
import { OverlayEndOfOverCard } from "./overlay-end-of-over";
import { OverlayTossCard } from "./overlay-toss-card";
import { OVERLAY_MOMENT_FOLD_MS } from "./moment-timing";
import { fetchOverlayFixture, type OverlayLiveData, type RealtimePurpose } from "@/components/public-site/live-score-data";
import type { OverlayMoment } from "@/lib/overlay-moments";
import {
  hasDetailBand,
  overlayModel,
  type OverlayModel,
  type OverlayMsg,
  type OverlaySideInput,
} from "@/lib/overlay-model";
import { useOverlayClock } from "./use-overlay-clock";
import { t } from "@/lib/i18n-runtime";
import type { DecidedOutcomeTemplates } from "@/lib/scoring-vocab";
// Owner answer 18 (Q7): the stage knows the REGISTRY, not two components. It
// imports neither `overlay-bar` nor `overlay-bug` — registering a third template
// must not touch this file, and an import here would be exactly that edit.
import { OVERLAY_TEMPLATES, cardRegionBeside, cardRegionFor, type CanvasBox, type TemplateId } from "./template-registry";
import { OverlayMatchCard, slateStateOf } from "./overlay-slate";
import { forfeitCopyOf } from "@/lib/forfeit-tag";
import { COMPOSITOR_HOST } from "@/lib/overlay-compositor";
import { STREAM_POLL_MS } from "@/lib/stream-session-view";
import { SPONSOR_CAROUSEL_SCENES, momentsFireIn, type SceneId } from "./overlay-scenes";
import { OverlaySceneBackdrop, phaseForScene, sceneFor } from "./overlay-scene";
import { useProgrammePhase } from "./use-programme-phase";
import { useCompositorSignals } from "./use-compositor-signals";
import { SponsorCardView, SponsorCarousel, carouselMemoryStore } from "./sponsor-card";

export interface OverlayStageProps {
  fixtureId: string;
  /** The overlay endpoint's payload (Task 0, design §3.2) — the SAME shape the
   *  stage polls, so first paint and every refresh render one contract. */
  initial: OverlayLiveData;
  realtime: boolean;
  sportKey: string;
  /** A registry id, already resolved server-side by `resolveTemplate` (Step 6c;
   *  R2007 kept the prop's NAME — `?style=` is the alias forever, and the DOM's
   *  `data-style` is what e2e and OBS-facing tests read). The stage never
   *  validates: by the time a value reaches this prop it has been through the
   *  resolver, and a `TemplateId` that is not a registry key is a compile error. */
  style: TemplateId;
  sides: [OverlaySideInput, OverlaySideInput];
  startLabel: string | null;
  /** Competition / stage for the slate card meta pill. */
  slateMeta?: { competition?: string; stage?: string } | null;
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
  /** RT (lane-close fix, ruled 2026-09-29): the realtime purpose and signed key the OBS page read off the URL the
   *  organiser copied. Both or neither: the OBS page passes both when its URL carries a key, and the Phone tab's preview
   *  passes NEITHER — so the preview never mints a token and its `realtime={false}` means what it says. Passed straight
   *  to `useLiveFixture`; the stage declares nothing of its own. */
  realtimePurpose?: RealtimePurpose;
  overlayKey?: string;
  /** R2007, preview-only (`OverlayPreview`): the transport's fetcher returns `initial`, so no request ever leaves the
   *  page — a preview over sample data would otherwise poll a fixture id that does not exist, every `POLL_MS`. */
  snapshotOnly?: boolean;
  /** R2007, preview-only (the gallery's moment cells): a slab shown statically in the slot, in the queue's fully-shown
   *  phase (`hold`). A static render never raises one from the queue — the baseline is the mount's tip. */
  pinnedMoment?: OverlayMoment;
  /** R2005: the page's `?host=compositor` — the composed session's `overlayUrl` is its only producer. It turns on the
   *  compositor's console signals (ready, alive, score stale), the phase channel and the scene layer. Absent on every
   *  OBS page, which therefore logs, fetches and shows nothing new. Ignored under `snapshotOnly`. */
  host?: typeof COMPOSITOR_HOST;
  /** R2005: the relay page access (`sid` + `st`) the page verified, passed on with every poll so the overlay route
   *  answers through the same check (fallback B's `programmePhase`, and a fixture that is not public). Absent on the
   *  public path. */
  relay?: { sid: string; st: string };
  /** R2005, PREVIEW-ONLY (`OverlayPreview`, review I6): the scene the gallery cell or the picker's toggle names. The
   *  overlay PAGE never sets it, so an OBS URL shows no scene. `live` means no scene, whatever the phase. */
  sceneOverride?: SceneId;
}

/** The card layout's inputs, as the inline custom properties `.ovl-slate-content` reads (R2007 step 9b, decision G2):
 *  the template's declared box and the region `cardRegionFor` leaves beside it, in canvas px. R4 S7: `brand` is the
 *  region the slate's brand mark keeps its corner of — the template's WHOLE card region, even while the scene carousel
 *  moves the card into the strip beside its banner (`region`): a card that fills a narrowed strip reaches the strip's
 *  top-right corner, where the brand would sit on it (gallery check 4, bar × carousel). */
function cardLayoutVars(box: CanvasBox, region: CanvasBox | null, brand: CanvasBox | null): Record<string, string> {
  const px = (n: number) => `${n}px`;
  return {
    "--ovl-safe-x": px(box.x),
    "--ovl-safe-y": px(box.y),
    "--ovl-safe-w": px(box.width),
    "--ovl-safe-h": px(box.height),
    ...(region === null
      ? {}
      : {
          "--ovl-card-x": px(region.x),
          "--ovl-card-y": px(region.y),
          "--ovl-card-w": px(region.width),
          "--ovl-card-h": px(region.height),
        }),
    ...(brand === null
      ? {}
      : { "--ovl-brand-x": px(brand.x), "--ovl-brand-y": px(brand.y), "--ovl-brand-w": px(brand.width) }),
  };
}

/** R4 S7: a sponsor slot's box (`OverlayTemplateDef.sponsorSlots`), as the inline custom properties `.ovl-sponsor-slot`
 *  reads, plus the fold duration the card's slide shares with the slab's (`moment-timing.ts`). */
function sponsorSlotVars(box: CanvasBox): React.CSSProperties {
  const px = (n: number) => `${n}px`;
  return {
    "--ovl-sponsor-x": px(box.x),
    "--ovl-sponsor-y": px(box.y),
    "--ovl-sponsor-w": px(box.width),
    "--ovl-sponsor-h": px(box.height),
    "--ovl-slab-fold": `${OVERLAY_MOMENT_FOLD_MS}ms`,
  } as React.CSSProperties;
}


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
  // subtracts it either way. RT (lane-close fix): the purpose and key are the
  // CALLER's — the OBS page's, off the URL the organiser copied — so a
  // community org's overlay asks for realtime on a signed key and a refusal
  // leaves it on the poll; the console preview passes neither and never asks.
  // R2005: the compositor host. Never in a preview: a preview has no compositor and must not touch the network.
  const compositor = props.host === COMPOSITOR_HOST && !props.snapshotOnly;
  const relay = props.relay;
  const { data, transport, presentationNowOffsetMs, awaitingDelay, received } = useLiveFixture(props.fixtureId, props.initial, props.realtime, {
    // R2007: a preview (`snapshotOnly`) never touches the network — its fetcher hands back the snapshot it was given.
    // The hook holds its fetcher in a ref, so a fresh closure per render is harmless. R2005: a relay page polls with
    // its own access, so the route can answer for a fixture that is not public and add the programme phase.
    fetcher: props.snapshotOnly
      ? async () => props.initial
      : relay
        ? (id: string) => fetchOverlayFixture(id, relay)
        : fetchOverlayFixture,
    delayMs: props.delayMs,
    realtimePurpose: props.realtimePurpose,
    overlayKey: props.overlayKey,
    // R2005 change 2: every tier's own interval (15 s, 60 s, never) is longer than the 10 s score-stale rule, so the
    // compositor host polls at the stream panel's STREAM_POLL_MS (5 s) whatever the status. Recorded choice.
    ...(compositor ? { steadyPollMs: STREAM_POLL_MS } : {}),
  });
  // R2005 change 6: the programme phase — loopback first, fallback B off the newest RECEIVED snapshot (the phase is
  // the compositor's now, so it never waits out the score's presentation delay). No request without the host.
  const programme = useProgrammePhase({ enabled: compositor, webPhase: received.snapshot.programmePhase ?? null });
  // R2005 changes 2 and 10: ready, the alive beat and score stale. HERE, at the stage's top level and never under the
  // scene or card subtree — a scene change must never unmount the beat (compositor PR #22 review G3).
  useCompositorSignals({ enabled: compositor, contentReady: !awaitingDelay, lastSuccessAt: received.at });
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
  const [closedOverBaseline] = useState(() => closedOverBaselineOf(props.initial.lastClosedOver));
  // The registry entry: the ONE place the template's component, slab placement and card box are read (R2007).
  const template = OVERLAY_TEMPLATES[props.style];
  const placement = template.slabPlacement;
  // Step 9b (G2): cards are laid out beside the template's DECLARED box. No region big enough ⇒ no card at all — a
  // card squeezed over the scorebug is the defect this replaced.
  const cardRegion = cardRegionFor(template.sceneCardSafeArea);
  const reducedMotion = usePrefersReducedMotion();

  const model: OverlayModel = overlayModel({
    sportKey: props.sportKey,
    data,
    sides: props.sides,
    startLabel: props.startLabel,
    clockLabel,
    msg,
    decidedTemplates: props.decidedTemplates,
    // W2b T13 review M-4: the forfeit sentences come from the public dictionary this stage already holds.
    forfeitCopy: forfeitCopyOf((key) => props.dict[key] ?? key),
    slateMeta: props.slateMeta,
  });

  // R2005 change 5: the scene layer and the one card on screen. The phase is the preview's override, else the
  // channel's (null without the host: today's card layer, unchanged — `sceneFor`'s first row).
  const scenePhase = props.sceneOverride !== undefined ? phaseForScene(props.sceneOverride) : programme.phase;
  const decision = sceneFor(scenePhase, slateStateOf(model));
  const showMatchCard = decision.card !== null && cardRegion !== null;

  // R4 S7 — the sponsor plan (S5's, on the payload). The carousel shows the TICKED cards only: `plan.cards` also carries
  // an unticked card an airing still names (S4), and `onStream` is the one thing that tells them apart.
  const sponsorPlan = data.sponsorPlan ?? null;
  const ticked = (sponsorPlan?.cards ?? []).filter((c) => c.onStream === true);
  const carouselScene = decision.scene !== null && SPONSOR_CAROUSEL_SCENES.includes(decision.scene) ? decision.scene : null;
  // The carousel's banner shares the scene with the match card, so the card moves into the region beside the banner
  // (`cardRegionBeside`). No room for the card there ⇒ no carousel: the match card outranks it.
  const carouselRegion =
    showMatchCard && cardRegion !== null ? cardRegionBeside(cardRegion, template.sponsorSlots.banner) : cardRegion;
  const showCarousel = carouselScene !== null && ticked.length > 0 && (!showMatchCard || carouselRegion !== null);
  const layoutRegion = showCarousel ? carouselRegion : cardRegion;
  // Fix round 1 (I1): the carousel unmounts whenever its scene leaves or a poll carries no plan, so ITS reducer cannot
  // remember the rotation. The stage is mounted for the page's life: it holds the memory, and each mount resumes from
  // it — the next card, and never a start inside a 10 s bucket a showing on this page already used (one id, one card).
  const [carouselMemory] = useState(carouselMemoryStore);

  // The ONE incoming list — moments, end-of-over, toss, sponsor cards, behind the mount's tip and inside the delay gate.
  // Its order and filters live in `stageIncoming` (lib/overlay-incoming.ts), which the sponsor seam test runs too.
  const sideShorts: [string, string] = [model.sides[0].short, model.sides[1].short];
  const sideNames: [string, string] = [model.sides[0].name, model.sides[1].name];
  const incoming = stageIncoming({
    sportKey: props.sportKey,
    recent: data.recent,
    lastClosedOver: data.lastClosedOver,
    cricketToss: data.cricketToss,
    scoringStarted: data.scoringStarted === true,
    sponsorPlan,
    momentBaseline,
    closedOverBaseline,
    msg,
    sideShorts,
    sideNames,
    showMatchCard,
    awaitingDelay,
  });

  // R2005 change 7 (spec §4.8, D14): the active scene's own `momentsFire` decides — Final discards, so nothing it drops
  // can ever replay. Read off the declaration (`momentsFireIn`), never off a scene id.
  // R4 S7: proof-of-play lines at the compositor host only (never an OBS page, never a preview).
  const queued = useMomentQueue(incoming, {
    reducedMotion,
    discard: !momentsFireIn(decision.scene),
    sponsorLines: compositor,
    // Ruling m4: no break card over a match card (a scene's or the slate's); the carousel is the scene's sponsor path.
    holdSponsors: showMatchCard,
  });
  // A pinned moment (the gallery's moment cells) replaces the queue's, held in the fully-shown phase.
  const moment = props.pinnedMoment ?? queued.current;
  const phase = props.pinnedMoment ? "hold" : queued.phase;
  // R4 S7: a sponsor moment draws its card (the plan's, by id) in the slot its template declares for its look. A card
  // missing from the current plan (an out-fold after the plan dropped it) draws nothing rather than a blank box.
  const sponsorOnAir =
    moment !== null && moment.graphic === "sponsor" && moment.sponsor !== undefined
      ? (() => {
          const look = moment.sponsor;
          const card = sponsorPlan?.cards.find((c) => c.id === look.cardId);
          return card === undefined ? null : { card, style: look.style };
        })()
      : null;

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

  // The registry lookup, and the ONLY place a template becomes a component. A
  // `props.style === "bar" ? <OverlayBar/> : <OverlayBug/>` branch is what the
  // owner's answer replaces: a third template would have had to edit it.
  const Theme = template.component;
  const canvasStyle = {
    ...sportThemeStyle(props.sportKey),
    ...cardLayoutVars(template.sceneCardSafeArea, layoutRegion, cardRegion),
    transform: `scale(${scale})`,
  } as React.CSSProperties;

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
          data-transport={transport}
          data-awaiting-delay="1"
          data-led="none"
          className="ovl-canvas ovl-label ovl-static"
          style={canvasStyle}
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
        data-transport={transport}
        data-led={model.sides[0].led ? "home" : model.sides[1].led ? "away" : "none"}
        className={`ovl-canvas ovl-label${model.live ? "" : " ovl-static"}`}
        style={canvasStyle}
      >
        {/* R2005: the scene's opaque backdrop, FIRST — below the template, so the score bug paints over every scene. */}
        {decision.scene !== null ? <OverlaySceneBackdrop scene={decision.scene} /> : null}
        {/* Scorebug theme (bar|bug). Match/end card is a LAYER above it when
            warming or ended — not a third ?style= (2026-09-12). R2005: the scene picks the card when one is active
            (one card at a time); without one it is exactly the card layer's. */}
        {showMatchCard ? (
          <OverlayMatchCard
            model={model}
            msg={msg}
            sportKey={props.sportKey}
            cricketToss={data.cricketToss}
            carromToss={data.carromToss}
            {...(decision.scene !== null ? { card: decision.card } : {})}
          />
        ) : null}
        {/* `display: contents`: no box of its own, so the template lays out exactly as before. It exists so the gallery
            e2e can find THE TEMPLATE'S elements (its children) and measure them against the declared box. */}
        <div data-testid="ovl-template" data-template={props.style} style={{ display: "contents" }}>
          <Theme model={model} tick={tick} msg={msg} sportKey={props.sportKey} />
        </div>
        {/* W2's slab attaches here (R4). The slot CLIPS: the slab slides out
            from under the scorebug rather than appearing beside it, so the
            wrapper owns the `overflow: hidden` and the slab owns the
            transform. The fold duration crosses into CSS as a custom property
            from `moment-timing.ts`, so the paint and the state machine cannot
            disagree about how long a fold takes. */}
        {/* Toss is a CENTER card (A2), not the anchored moment slot. */}
        {moment !== null && moment.graphic === "toss" ? (
          <OverlayTossCard moment={moment} phase={phase} />
        ) : null}
        {/* R4 S7: the break's sponsor card, in its template's declared slot for its look. The slot clips, as the slab's
            does, so the card slides out from under its own edge. */}
        {sponsorOnAir !== null ? (
          <div
            data-testid="ovl-sponsor-slot"
            data-slot={sponsorOnAir.style}
            className="ovl-sponsor-slot"
            style={sponsorSlotVars(template.sponsorSlots[sponsorOnAir.style])}
          >
            <SponsorCardView card={sponsorOnAir.card} style={sponsorOnAir.style} phase={phase} />
          </div>
        ) : null}
        {/* R4 S7 (spec §3.4): the scene carousel, in the banner slot. It steps aside while any moment is on air — one
            card at a time — and logs its showings only at the compositor host. */}
        {showCarousel && carouselScene !== null ? (
          <div
            data-testid="ovl-sponsor-slot"
            data-slot="banner"
            data-carousel=""
            className="ovl-sponsor-slot"
            style={sponsorSlotVars(template.sponsorSlots.banner)}
          >
            <SponsorCarousel
              cards={ticked}
              scene={carouselScene}
              host={compositor ? COMPOSITOR_HOST : null}
              yielding={moment !== null}
              memory={carouselMemory}
            />
          </div>
        ) : null}
        <div
          data-testid="ovl-moment-slot"
          className={`ovl-moment-slot ovl-moment-slot--${placement}`}
          /* §3's detail band is CONDITIONAL ("an empty detail band is not
             rendered"), so the bar is 126 or 177 tall and the slab's underside
             has to follow it. One authority — `hasDetailBand` — feeds the
             bar's own render and this attribute; the stylesheet derives both
             offsets from the two band heights rather than freezing a sum. */
          data-band={hasDetailBand(model) ? "" : undefined}
          style={{ "--ovl-slab-fold": `${OVERLAY_MOMENT_FOLD_MS}ms` } as React.CSSProperties}
        >
          {moment === null || moment.graphic === "toss" || moment.graphic === "sponsor" ? null : moment.graphic === "endOfOver" &&
            moment.endOfOver ? (
            <OverlayEndOfOverCard moment={moment} phase={phase} msg={msg} />
          ) : (
            <OverlayMomentSlab moment={moment} phase={phase} placement={placement} />
          )}
        </div>
      </div>
    </div>
  );
}
