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
import { scoringErrorText } from "@/lib/scoring-vocab";
import type { MessageKey } from "@/lib/messages";
import type { PadTransport } from "./transport";
import type { OwnIdentity } from "./types";
import { usePadPipeline } from "./use-pad-pipeline";
import { buildPadView, PAD_PHASES, summaryHeadline, type PadActionView } from "./view-model";
import type { ActionValues } from "./action-form";
import { Panel } from "./panel";
import { FidelitySwitcher } from "./fidelity-switcher";
import { AttributionPicker } from "./attribution-picker";
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
  /** Typed seam for the timeline (a later pass) — rendered as-is, wherever
   *  this component decides a persistent slot belongs. Neither built nor
   *  interpreted here. */
  timelineSlot?: ReactNode;
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

  return (
    <div className="space-y-3">
      <header className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-[0_0_40px_-12px_rgba(16,185,129,0.25)]">
        {headline && (
          <div data-role="score-headline" className="border-b border-slate-800/70 px-3 pt-2.5 pb-2 text-center">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
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
                className={`rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-widest transition ${
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
          {scoringErrorText(
            pipeline.lastRejection.code,
            pipeline.lastRejection.message,
            msg,
            "scorepad.rejection.fallback",
          )}
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
        <p className="card p-4 text-center text-sm text-purple-400">{msg("scorepad.emptyPhase")}</p>
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

      {props.timelineSlot}
    </div>
  );
}
