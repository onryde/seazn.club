"use client";
// The composed universal renderer (S10/#419 W8, chassis item 2): phase nav +
// fidelity switcher + queue/offline status live in a dark "scoreboard" strip
// (this product area's own established signature — device-score-pad.tsx's
// header), panels/actions draw in the app's ordinary light card/btn system
// below it. Wires `usePadPipeline` (the live submit/fold/reconcile hook,
// already shipped) to `buildPadView` (this session's pure projection) and to
// `Panel`/`FidelitySwitcher` (this session's React surface).
//
// Deliberately takes the module/cfg/band/entitlements as PROPS rather than
// calling `usePadContext()` itself: pad-context.tsx's own test file documents
// that this repo's node-only hook harness has no real Provider->Consumer
// subscription (`useContext` always returns the DEFAULT), so a component
// that read context directly could never be driven by a test here. A future
// page mounts `<PadContextProvider>` and reads `usePadContext()` ONCE to
// supply these props — out of scope this pass (no routes).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { EventEnvelope, LineupPair } from "@seazn/engine/core";
import type { AnySportModule, FidelityBand, PadFieldValue, PadPhase, PadSpec } from "@seazn/engine/sport";
import { useMsg } from "@/components/i18n/dict-provider";
import { refusalText } from "./refusal-copy";
import type { MessageKey } from "@/lib/messages";
import type { PadTransport } from "./transport";
import type { OwnIdentity } from "./types";
import { usePadPipeline } from "./use-pad-pipeline";
import { buildPadView, PAD_PHASES, summaryHeadline, type PadActionView } from "./view-model";
import type { ActionValues } from "./action-form";
import { Panel } from "./panel";
import { FidelitySwitcher } from "./fidelity-switcher";
import { AttributionPicker } from "./attribution-picker";
import { Timeline, type TimelineEvent } from "./timeline";
import { skinFor } from "./skins/registry";
import { createSkinDispatch, type SkinDef } from "./skins/types";

const EMPTY_SPEC: PadSpec = { panels: [], fidelity: {}, fidelityEntitlements: {} };

const PHASE_LABEL_KEY: Record<PadPhase, MessageKey> = {
  pre: "scorepad.phase.pre",
  live: "scorepad.phase.live",
  post: "scorepad.phase.post",
};

export interface PadRendererProps {
  module: AnySportModule;
  cfg: unknown;
  fixtureId: string;
  lineups: LineupPair;
  identity: OwnIdentity;
  transport: PadTransport;
  /** Initial fidelity band — the fixture's own configured/entitled ceiling
   *  (pad-context.tsx's `fidelityBand`). The scorer may view a DIFFERENT
   *  band via `FidelitySwitcher`; that choice lives in this component's own
   *  state, never written back up. */
  band: FidelityBand;
  entitlements: Readonly<Record<string, boolean>>;
  initialEvents?: readonly EventEnvelope[];
  queueDbName?: string;
  /** personId -> display name for the attribution picker's chips. Absent is
   *  survivable: the picker labels an unnamed person generically rather than
   *  blocking the action. */
  personNames?: Readonly<Record<string, string>>;
  /** OVERRIDE for the built-in attribution picker, not the only way to get
   *  one — S11's skins may draw their own. Omitted ⇒ this component renders
   *  `AttributionPicker` itself, fed the live folded state. */
  renderAttribution?: (
    action: PadActionView,
    values: ActionValues,
    setValue: (path: string, value: ActionValues[string]) => void,
  ) => ReactNode;
  /** OVERRIDE for the built-in timeline (`Timeline`, this file's default) —
   *  same pattern as `renderAttribution` above: a render prop receiving what
   *  it needs (the resolved event list, already narrowed to this pad's own
   *  `TimelineEvent` wire shape, plus an `onVoid` already wired to this
   *  pipeline's `submit`), not a bare slot a caller fills blindly. Omitted
   *  (the default) ⇒ this component renders `Timeline` itself, fed the live
   *  event list and this pad's own `identity` — S11's skins may draw their
   *  own instead, exactly as they may override `renderAttribution`. */
  timelineSlot?: (events: readonly TimelineEvent[], onVoid: (eventId: string) => void) => ReactNode;
  /** Skin selection. THREE distinct states, and the difference matters:
   *   - `undefined` (the default): consult the registry — a sport with a
   *     hand-crafted layout gets it, everything else gets the universal panel
   *     walk. This is what every real caller wants.
   *   - `null`: force the universal renderer even for a skinned sport. Exists
   *     so the universal path stays testable against a multi-phase spec
   *     (cricket is the only module declaring pre/live/post, and it is
   *     skinned), and so S12 can fall back deliberately.
   *   - a `SkinDef`: draw this skin regardless of sport.
   *  Note the default is registry lookup, NOT "no skin" — a seam that only
   *  works when a caller remembers to pass something is how S10's attribution
   *  picker shipped inert. */
  skin?: SkinDef | null;
  /** Fires whenever the pipeline's own fold advances — e.g. for a persistent
   *  score header mounted alongside this component. Never drives anything
   *  inside this file itself. */
  onStateChange?: (state: unknown, summary: unknown) => void;
  /** Fires whenever the pipeline's reconciled ledger changes, oldest-first.
   *
   *  Exists because chrome mounted AROUND this pad keeps its own copy of the
   *  event list and has no other way to learn about events the pad submits:
   *  `fixture-console.tsx` and `device-score-pad.tsx` both derive their "Undo
   *  last" target from a server-loaded snapshot that the pad's separate
   *  pipeline never touches, so undo silently operated on a pre-pad state and
   *  only worked after a reload. `onStateChange` above cannot serve this — it
   *  carries the FOLD's outputs, not the raw events an undo needs an id from.
   *
   *  Keyed on the events themselves for the same reason as onStateChange: a
   *  caller passing a fresh inline function each render must not loop. */
  onEvents?: (events: readonly EventEnvelope[]) => void;
}

export function PadRenderer(props: PadRendererProps) {
  const msg = useMsg();
  const pipeline = usePadPipeline({
    fixtureId: props.fixtureId,
    module: props.module,
    cfg: props.cfg,
    lineups: props.lineups,
    identity: props.identity,
    transport: props.transport,
    initialEvents: props.initialEvents,
    queueDbName: props.queueDbName,
  });

  useEffect(() => {
    props.onStateChange?.(pipeline.state, pipeline.summary);
    // Deliberately keyed on the fold's own outputs, not `props.onStateChange`
    // itself — a caller handing down a fresh inline function every render
    // must not turn this into a loop or re-fire for no fold change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline.state, pipeline.summary]);

  useEffect(() => {
    props.onEvents?.(pipeline.events);
    // Same rule as the effect above: keyed on the pipeline's own output, never
    // on the callback identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline.events]);

  const spec = useMemo(() => props.module.padSpec?.(props.cfg) ?? EMPTY_SPEC, [props.module, props.cfg]);

  const [phase, setPhase] = useState<PadPhase>("live");
  const [band, setBand] = useState<FidelityBand>(props.band);
  const [submittingType, setSubmittingType] = useState<string | null>(null);

  const view = useMemo(
    () =>
      buildPadView(spec, {
        state: pipeline.state,
        summary: pipeline.summary,
        phase,
        band,
        entitlements: props.entitlements,
      }),
    [spec, pipeline.state, pipeline.summary, phase, band, props.entitlements],
  );

  // Render-phase adjustment (schedule-board.tsx's own established
  // convention — see reference_hook_harness_render_phase_setstate.md): if
  // the currently-selected phase has nothing declared at all for this
  // module, snap to the first phase that does, rather than pinning the
  // scorer on a permanently-empty tab. Structural (`view.phases`), so this
  // does not depend on the CURRENT band/gate state either.
  if (view.phases.length > 0 && !view.phases.includes(phase)) {
    setPhase(view.phases[0]!);
  }

  async function handleSubmit(type: string, payload: Record<string, unknown>) {
    setSubmittingType(type);
    try {
      await pipeline.submit(type, payload);
    } finally {
      setSubmittingType(null);
    }
  }

  const queueLabel = pipeline.offline
    ? msg("scorepad.queue.offline")
    : pipeline.resyncing
      ? msg("scorepad.queue.resyncing")
      : pipeline.queueDepth > 0
        ? msg("scorepad.queue.pending", { count: pipeline.queueDepth })
        : msg("scorepad.queue.synced");
  const queueAttention = pipeline.offline || pipeline.queueDepth > 0;
  // S10/#419 W8 fix 3 — the fold's own headline, read defensively
  // (summaryHeadline degrades to null for anything that isn't a genuine
  // `{headline: string}`). Recomputed every render straight off
  // `pipeline.summary` (no memo of its own needed — it's a cheap read, and
  // `pipeline.summary` already changes identity on every fold advance), so
  // this stays in lockstep with the fold without a caller ever wiring
  // anything: PadRenderer already re-renders on every `pipeline.summary`
  // change via the onStateChange effect above.
  const headline = summaryHeadline(pipeline.summary);

  // S11/#420 W9 — the sport's hand-crafted layout, if it has one. Keyed on the
  // module's own key, so a module added later with no skin simply keeps the
  // universal renderer with no change here.
  const skin = useMemo(
    () => (props.skin === undefined ? skinFor(props.module.key) : props.skin),
    [props.skin, props.module.key],
  );
  const skinCtx = useMemo(
    () => ({
      cfg: props.cfg,
      state: pipeline.state,
      summary: pipeline.summary,
      band,
      personNames: props.personNames,
      lineups: props.lineups,
    }),
    [props.cfg, pipeline.state, pipeline.summary, band, props.personNames, props.lineups],
  );
  // A skin never receives `pipeline.submit`. It gets a dispatch that refuses
  // any type the CURRENT view does not declare, so "a skin invented an event"
  // fails at the call site rather than 422-ing server-side. Submit-state
  // tracking stays identical to the universal path (`handleSubmit`).
  const skinDispatch = useMemo(
    () => createSkinDispatch(view, (type, payload) => handleSubmit(type, payload as Record<string, unknown>)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view],
  );

  // Default attribution rendering — see the note at the render site below.
  const renderAttribution = useMemo(
    () =>
      props.renderAttribution ??
      ((action: PadActionView, values: ActionValues, setValue: (path: string, value: PadFieldValue | undefined) => void) => (
        <AttributionPicker
          action={action}
          values={values}
          setValue={setValue}
          state={pipeline.state}
          lineups={props.lineups}
          personNames={props.personNames}
        />
      )),
    [props.renderAttribution, props.lineups, props.personNames, pipeline.state],
  );

  // S12/#421 — Timeline's own props (TimelineEvent, snake_case wire shape),
  // built from the pipeline's engine-shaped `events` (camelCase, no
  // device-link field at all — see use-pad-pipeline.ts's `ownEventIds`
  // JSDoc). `device_link_id` is populated ONLY for events `ownEventIds`
  // marks as this pipeline instance's own — never guessed for a row loaded
  // from server history — so Timeline's "a device link may only void its
  // own events" rule never over-grants on data this component isn't sure of.
  const timelineEvents = useMemo<TimelineEvent[]>(
    () =>
      pipeline.events.map((e) => ({
        id: e.id,
        seq: e.seq,
        type: e.type,
        payload: e.payload,
        recorded_at: e.recordedAt,
        recorded_by: e.recordedBy,
        device_link_id: pipeline.ownEventIds.has(e.id) ? props.identity.deviceLinkId : null,
        voids_event_id: e.voids ?? null,
      })),
    [pipeline.events, pipeline.ownEventIds, props.identity.deviceLinkId],
  );

  const [voidingId, setVoidingId] = useState<string | null>(null);
  async function handleVoid(eventId: string) {
    setVoidingId(eventId);
    try {
      await pipeline.submit("core.void", { event_id: eventId });
    } finally {
      setVoidingId(null);
    }
  }

  // The timeline is the DEFAULT, not an opt-in — same reasoning as the
  // attribution picker above, restated because this is the sixth instance of
  // this programme's signature defect (_INDEX.md, S12/#421): `timeline.tsx`
  // was imported by NOTHING outside its own test and could not be wired by
  // any caller even in principle before this session (`timelineSlot` was a
  // bare ReactNode; `usePadPipeline` exposed neither `submit` upward nor its
  // event list). `timelineSlot` survives as an OVERRIDE, exactly like
  // `renderAttribution`.
  const timeline = props.timelineSlot ? (
    props.timelineSlot(timelineEvents, handleVoid)
  ) : (
    <Timeline
      events={timelineEvents}
      personNames={props.personNames}
      homeEntrantId={props.lineups.home.entrantId}
      awayEntrantId={props.lineups.away.entrantId}
      deviceLinkId={props.identity.deviceLinkId}
      onVoid={handleVoid}
      voidingId={voidingId}
    />
  );

  return (
    <div className="space-y-3">
      <header className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-[0_0_40px_-12px_rgba(16,185,129,0.25)]">
        {headline && (
          <div data-role="score-headline" className="border-b border-slate-800/70 px-3 pt-2.5 pb-2 text-center">
            {/* S13/#422 W11 cutover — text-slate-500 on this dark scoreboard
             *  header measures ~3.74:1, below WCAG AA's 4.5:1 floor for
             *  normal text (real OKLab->linear-sRGB->relative-luminance
             *  computation, not eyeballed). text-slate-400 clears it at
             *  6.79:1, the exact fix already applied to the byte-identical
             *  caption in period-skin.tsx (dac2b6bb) — same two colors,
             *  reused here rather than inventing a new step. */}
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">
              {msg("scorepad.header.score")}
            </p>
            <p className="truncate text-xl font-bold tabular-nums tracking-tight text-white sm:text-2xl">{headline}</p>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
          <nav className="flex gap-1">
            {PAD_PHASES.filter((p) => view.phases.includes(p)).map((p) => (
              <button
                key={p}
                type="button"
                data-phase={p}
                aria-pressed={p === phase}
                onClick={() => setPhase(p)}
                /* min-h-11 = 44px: the phase tabs are the pad's most-tapped
                 * chrome and sat at 28px until S11 measured them in a real
                 * browser at 375. Height only — the pill's horizontal padding
                 * already exceeds the bar. */
                className={`inline-flex min-h-11 items-center rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-widest transition ${
                  p === phase ? "bg-emerald-400 text-slate-900" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {msg(PHASE_LABEL_KEY[p])}
              </button>
            ))}
          </nav>
          <span
            className={`flex shrink-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest ${
              queueAttention ? "text-amber-400" : "text-emerald-400"
            }`}
          >
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full ${queueAttention ? "animate-live-pulse bg-amber-400" : "bg-emerald-400"}`}
            />
            {queueLabel}
          </span>
        </div>
      </header>

      {pipeline.lastRejection && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {/* R6 fix pass 3, gap 1 — the SAME resolver the v3 lane uses
           *  (./refusal-copy.ts). Both lanes share one `usePadPipeline`, so
           *  once transport.ts started surfacing the permanent 4xx class this
           *  surface began receiving codes `scoringErrorText` had no copy for
           *  and answered with the server's own English. */}
          {refusalText(pipeline.lastRejection, msg)}
        </p>
      )}

      {/* The picker is the DEFAULT, not an opt-in. Shipping it behind a prop
       *  every caller must remember to pass is how this programme's recurring
       *  defect happens — a component that is written, tested and never
       *  reached (S4's person-role discriminator, S8's declared-but-inert stat
       *  models, S8's computed-but-unrenderable rows). `renderAttribution`
       *  survives as an OVERRIDE for S11's skins, which may draw their own.
       *  The default is handed the LIVE folded state, so the keeper comes
       *  from `core.lineup.*` rather than the kickoff sheet. */}
      <FidelitySwitcher
        value={band}
        onChange={setBand}
        entitlements={props.entitlements}
        fidelityEntitlements={spec.fidelityEntitlements}
      />

      {view.panels.length === 0 ? (
        /* S13/#422 W11 cutover — text-purple-400 on this white .card
         *  measures ~2.79:1, below the 4.5:1 AA floor. text-purple-700
         *  clears it at 7.07:1 and is already this surface's own
         *  established "readable purple" (globals.css .label/.btn-ghost),
         *  so this reuses a step already visible right next to it rather
         *  than introducing a new one. */
        <p className="card p-4 text-center text-sm text-purple-700">{msg("scorepad.emptyPhase")}</p>
      ) : skin ? (
        /* S11/#420 W9 — a sport with a hand-crafted layout draws through it
         *  instead of the universal panel walk. Consulted HERE rather than
         *  left for S12 to wire (owner ruling 2026-08-13): a registry nothing
         *  calls is the same defect as S10's picker, which shipped reachable
         *  only if a caller remembered to pass it. Every unskinned sport falls
         *  through to the panel walk below, unchanged. */
        <skin.Component
          view={view}
          spec={spec}
          ctx={skinCtx}
          layout={skin.layout(view, skinCtx)}
          dispatch={skinDispatch}
          queueDepth={pipeline.queueDepth}
          offline={pipeline.offline}
          submittingType={submittingType}
        />
      ) : (
        view.panels.map((panel) => (
          <Panel
            key={panel.labelKey.key}
            panel={panel}
            onSubmit={handleSubmit}
            submittingType={submittingType}
            renderAttribution={renderAttribution}
          />
        ))
      )}

      {timeline}
    </div>
  );
}
