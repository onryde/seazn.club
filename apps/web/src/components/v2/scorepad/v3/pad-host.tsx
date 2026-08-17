"use client";
// PadHostV3 — R2/task B. R1 shipped six chassis primitives (scorebug,
// tile-grid, detail-dock, context-strip, swap-sheet, recording-chip) with
// ZERO production import sites, and registry.tsx:280 threw on purpose for
// any sport resolved to the v3 lane ("no v3 renderer is wired yet"). This
// file is that renderer: it assembles every v3 primitive — scorebug,
// ribbon, context strip, tile grid, detail dock, swap sheet, guided sheet,
// recording chip — into one pad, driven entirely by a `SkinDefV3`.
//
// DATA PATH: mirrors pad-renderer.tsx exactly — module/cfg/lineups/
// identity/transport/band/entitlements arrive as props, `usePadPipeline`
// is the ONE source of live state, `module.padSpec?.(cfg)` is the ONE
// source of the action vocabulary. No second data path anywhere in this
// file (task brief, explicit constraint).
//
// SOFT-COMMIT (spec §2.3): every dispatched event — a tile's `{event}`
// action, a guided sheet's completed wizard, a generic action-form
// confirm, a swap's built event, a context-strip selection the skin turns
// into an event — goes through ONE gateway: `dispatch`, built from
// `createSkinDispatch(padView, heldSubmit)` (skins/types.ts, reused
// verbatim — "a skin cannot invent an event" holds here exactly as it
// does for every v2 skin). `heldSubmit` calls `pipeline.submitHeld`
// (use-pad-pipeline.ts) — the optimistic fold advances immediately,
// durable enqueue happens immediately, the actual network send is
// deferred `HOLD_MS` (queue.ts's chassis constant) unless the dock is
// dismissed early or a later tap flushes it. `onDue` — fired either way,
// exactly once — clears this component's own `held` state AND calls
// `pipeline.retryDrain()`, the one sanctioned way to trigger a real send
// outside `submit()` itself (`runDrain` stays private, per the brief).
//
// PURE BUILDERS below (task brief item 8) are what this file's own tests
// exercise. `PadHostV3` itself renders SEVEN independently-stateful
// nested v3 primitives (DetailDock/ContextStrip/SwapSheet/GuidedSheet/
// RecordingChip/TileGrid/ActionFormList each own a `useState`) — the
// node-only `_hook-harness` renders one function component ONE level deep,
// so a tree this deep is exactly the shape it cannot walk (discovered
// concretely while building action-form.tsx's own list — see that file's
// header). The React shell is covered by e2e in a later task; this file's
// own suite proves every DECISION, not the DOM.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { EventEnvelope, LineupPair, SquadState } from "@seazn/engine/core";
import { initSquads } from "@seazn/engine/core";
import type { AnySportModule, FidelityBand, PadSpec } from "@seazn/engine/sport";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { scoringErrorText, type MsgFn } from "@/lib/scoring-vocab";
import type { PadTransport } from "../transport";
import type { OwnIdentity } from "../types";
import { usePadPipeline } from "../use-pad-pipeline";
import type { RejectionInfo } from "../use-pad-pipeline";
import { HOLD_MS } from "../queue";
import { buildPadView, summaryHeadline, type PadActionView, type PadViewCtx } from "../view-model";
import { createSkinDispatch } from "../skins/types";
import { ActionFormList } from "./action-form";
import { Scorebug } from "./scorebug";
import { TileGrid } from "./tile-grid";
import { DetailDock, makeDockStore } from "./detail-dock";
import { ContextStrip, type PoolView, type TFn } from "./context-strip";
import { SwapSheet, refusalMessage, type PolicyVerdict, type SwapSheetSpec } from "./swap-sheet";
import { GuidedSheet } from "./guided-sheet";
import { RecordingChip } from "./recording-chip";
import { buildRibbon } from "./ribbon";
import { ActivityPanel, type ActivityEvent } from "./activity";
import { MORE_SHEET_KEY, type GuidedSheetSpec, type PadHostView, type PadPhase, type SkinDefV3, type SwapSlot, type TapEvent, type TileSpec } from "./types";

// ---------------------------------------------------------------------------
// Pure builders — every decision this file makes, tested directly
// (__tests__/pad-host.test.ts). No React, no pipeline, no store: data in,
// data out, same discipline as every other v3 primitive's own split.
// ---------------------------------------------------------------------------

/**
 * The `SquadState` a skin's `view.squads` carries. `state.squads` wins when
 * the module's own fold populates it (most sports don't —
 * `reference_squad_state_persisted_only_when_it_adds_information`);
 * `initSquads(lineups)` — the SAME engine primitive every module's own
 * squad adopter falls back to internally — otherwise. A skin never
 * branches on which case it is.
 */
export function squadStateOf(state: unknown, lineups: LineupPair): SquadState {
  const squads = (state as { squads?: SquadState } | null | undefined)?.squads;
  return squads ?? initSquads(lineups);
}

/**
 * The union of both sides' rosters, as one `PoolView` — what backs the
 * context strip. A context slot (striker/non-striker/bowler) is
 * meaningfully "onfield, from EITHER side", unlike a guided sheet's person
 * steps (A5) or a swap (always within ONE side) — a real correctness gap
 * for those two, but only a slightly wider-than-ideal candidate list here
 * (see this file's own header note on why context-strip.tsx was NOT given
 * a `side` field this wave). `resolvePool`/`onFieldPersons`/`playingSquad`
 * (context-strip.tsx, core/lineup.ts) read `.members` only — never
 * `entrantId`/`subsUsed`/`exemptUsed` — so the synthesised squad below is
 * safe for every real caller despite carrying placeholder values for the
 * fields nothing reads.
 */
export function combinedPool(squads: SquadState): PoolView {
  return {
    squad: {
      entrantId: "combined",
      members: [...squads.home.members, ...squads.away.members],
      subsUsed: squads.home.subsUsed + squads.away.subsUsed,
      exemptUsed: {},
    },
  };
}

/** Which side's own squad backs a guided-sheet person step or a swap —
 *  A5's actual fix: never guesses, never defaults, just indexes. */
export function sidePool(side: "home" | "away", squads: SquadState): PoolView {
  return { squad: side === "home" ? squads.home : squads.away };
}

const ALL_BANDS: readonly FidelityBand[] = [0, 1, 2, 3];

/** Bands the org currently holds — `recording-chip.tsx`'s own header names
 *  this exact computation as "the same way fidelity-switcher.tsx's own
 *  isLocked does" (that function isn't exported; this mirrors its logic,
 *  not its code). A band with no declared gate (`fidelityEntitlements[b]
 *  === undefined`) is always entitled — bands 0/1 are never keyed there. */
export function entitledBandsFrom(
  fidelityEntitlements: PadSpec["fidelityEntitlements"],
  entitlements: Readonly<Record<string, boolean>>,
): Set<FidelityBand> {
  const out = new Set<FidelityBand>();
  for (const band of ALL_BANDS) {
    const needed = fidelityEntitlements[band];
    if (needed === undefined || entitlements[needed]) out.add(band);
  }
  return out;
}

/** Every event type ALREADY reachable through a dedicated tile or a guided
 *  sheet — the "More" sheet's own exclusion set (item 4: a future engine
 *  action must appear WITHOUT a skin edit, which only holds if this set is
 *  derived from the skin's declarations, never hand-listed). A `{swap:
 *  true}` tile contributes nothing: its real event is built dynamically
 *  from a picked (off, on) pair (`SwapSlot.buildEvent`), never declared
 *  statically as one type. */
export function dedicatedEventTypes(
  tiles: readonly TileSpec[],
  sheets: Record<string, GuidedSheetSpec> | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const tile of tiles) {
    if ("event" in tile.action) out.add(tile.action.event.type);
  }
  if (sheets) for (const spec of Object.values(sheets)) out.add(spec.event);
  return out;
}

/** The "More" sheet's own content: every `padSpec(cfg)` action NOT in
 *  `dedicated`, phase/gate/band/entitlement-filtered exactly like the
 *  panel walk `buildPadView` already does for the legacy renderer — reused
 *  verbatim, never re-derived, so a locked/wrong-phase action can never
 *  leak in here either. De-duplicated by type: a module may legitimately
 *  declare the same wire type more than once across panels
 *  (skins/types.ts's own `actionByType` doc); the FIRST resolved view
 *  wins, same "first match" convention that file already documents. */
export function moreActions(spec: PadSpec, ctx: PadViewCtx, dedicated: ReadonlySet<string>): PadActionView[] {
  const view = buildPadView(spec, ctx);
  const seen = new Set<string>();
  const out: PadActionView[] = [];
  for (const panel of view.panels) {
    for (const action of panel.actions) {
      if (dedicated.has(action.type) || seen.has(action.type)) continue;
      seen.add(action.type);
      out.push(action);
    }
  }
  return out;
}

export type SheetResolution = { kind: "guided"; spec: GuidedSheetSpec } | { kind: "action" } | { kind: "none" };

/** What a tapped `{sheet: key}` tile actually opens. `MORE_SHEET_KEY` is
 *  checked FIRST, unconditionally — a skin's own `sheets` map must never
 *  shadow it (types.ts's own doc on the sentinel). An unknown key resolves
 *  to `"none"`, never a crash — a skin-authoring bug this chassis stays
 *  silent about rather than guessing. */
export function resolveSheet(sheetKey: string, sheets: Record<string, GuidedSheetSpec> | undefined): SheetResolution {
  if (sheetKey === MORE_SHEET_KEY) return { kind: "action" };
  const spec = sheets?.[sheetKey];
  return spec ? { kind: "guided", spec } : { kind: "none" };
}

/**
 * Blocker 1 (R2 review finding, `docs/superpowers/plans/2026-08-16-
 * scorepad-v3-r2-cricket.md`): `PadHostV3` built and held `pipeline.
 * lastRejection` (usePadPipeline's own surfaced 422-class refusal) but never
 * rendered it anywhere — a rejected v3 submission, in ANY sport, for ANY
 * reason, produced NO on-screen feedback at all; the pad simply looked like
 * it silently ignored the tap. This is chassis-wide (every later wave's
 * skin renders through this one host), not a per-sport fix.
 *
 * Ports the legacy renderer's own surface verbatim in semantics
 * (pad-renderer.tsx: `pipeline.lastRejection && <p>{scoringErrorText(...)}
 * </p>`) — same source (`pipeline.lastRejection`), same resolver
 * (`scoringErrorText`), same fallback key (`scorepad.rejection.fallback`,
 * already localized in all 4 dictionaries — no new i18n key needed). `null`
 * means "render nothing", matching the legacy renderer's `&&`-gated JSX.
 */
export function rejectionText(rejection: RejectionInfo | null, m: MsgFn): string | null {
  if (!rejection) return null;
  return scoringErrorText(rejection.code, rejection.message, m, "scorepad.rejection.fallback");
}

export type UndoDecision = { kind: "drop"; heldId: string } | { kind: "void"; eventId: string };

/** Undo INSIDE the hold window drops (no `core.void`, queue.ts's
 *  `dropHeld`); undo AFTER send voids, exactly as today (spec §2.3). The
 *  ribbon's own `EventEnvelope.id` for a still-held tap IS its
 *  `idempotencyKey` (use-pad-pipeline.ts's `pendingToEnvelope`) — the
 *  SAME id `submitHeld` hands back as `heldId` — so `heldId === eventId`
 *  is exactly "this is the tap still sitting in the hold window", never a
 *  coincidence needing a second lookup. */
export function decideUndo(eventId: string, heldId: string | null): UndoDecision {
  return heldId !== null && heldId === eventId ? { kind: "drop", heldId } : { kind: "void", eventId };
}

/**
 * The event type a tile will dispatch, or `null` when it cannot be known
 * statically.
 *
 * `{swap:true}` builds its event from the picked people at tap time, and the
 * MORE sheet hosts the whole `padSpec(cfg)` action list rather than one event,
 * so neither can be classified here — both return `null` and are therefore
 * never filtered. That is deliberate: the MORE sheet is exactly where a
 * LOW-band org reaches `cricket.innings.summary`, so hiding it by band would
 * remove the only recording action such an org has.
 */
export function tileEventType(tile: TileSpec, sheets: Record<string, GuidedSheetSpec>): string | null {
  if ("event" in tile.action) return tile.action.event.type;
  if ("sheet" in tile.action) {
    if (tile.action.sheet === MORE_SHEET_KEY) return null;
    return sheets[tile.action.sheet]?.event ?? null;
  }
  return null;
}

/**
 * Sign-off review 2026-08-17: tiles were rendered regardless of the org's
 * fidelity band, so an org without `scoring.ball_by_ball` saw every ball tile
 * and each tap earned a server refusal — `assertEntitledToScore` gates at the
 * scoring door (`server/usecases/scoring.ts`). The events were never written,
 * so this was a wrong affordance rather than data loss, but a control that
 * always fails is not a control.
 *
 * Filtered on the CHASSIS, not in a skin: `PadSpec.fidelity` already maps
 * every event type to its band for all 11 sports, so one filter here fixes
 * the sports still to be converted too.
 *
 * FAIL-OPEN by design. A tile whose event type cannot be resolved, or whose
 * type carries no `fidelity` entry, is KEPT. Hiding a control we failed to
 * classify is a worse failure than showing one that refuses: the scorer can
 * see and report a refusal, but cannot report a button that was never drawn.
 */
export function filterTilesByBand(
  tiles: readonly TileSpec[],
  sheets: Record<string, GuidedSheetSpec>,
  fidelity: PadSpec["fidelity"],
  entitledBands: ReadonlySet<FidelityBand>,
): TileSpec[] {
  return tiles.filter((tile) => {
    const type = tileEventType(tile, sheets);
    if (type === null) return true;
    const band = fidelity[type];
    if (band === undefined) return true;
    return entitledBands.has(band);
  });
}

const PHASE_ORDER: readonly PadPhase[] = ["pre", "live", "post"];

/** The distinct phases at least one tile currently declares, canonically
 *  ordered — the structural set `resolveNextPhase` below snaps into, the
 *  same "never depends on the CURRENT band/gate state" posture
 *  pad-renderer.tsx's own phase self-correction already established. */
export function phasesWithTiles(tiles: readonly TileSpec[]): PadPhase[] {
  const set = new Set<PadPhase>();
  for (const tile of tiles) for (const p of tile.phases) set.add(p);
  return PHASE_ORDER.filter((p) => set.has(p));
}

/** Keeps `current` when it still has something declared; snaps to the
 *  first available phase otherwise (never leaves the scorer stuck on a
 *  permanently-empty tab); keeps `current` unchanged when NOTHING is
 *  declared anywhere yet (nothing to snap to). A render-phase adjustment,
 *  same idiom pad-renderer.tsx's own phase correction uses. */
export function resolveNextPhase(current: PadPhase, available: readonly PadPhase[]): PadPhase {
  if (available.length === 0) return current;
  return available.includes(current) ? current : available[0]!;
}

/**
 * G3 (controller ruling 2026-08-16, `docs/superpowers/plans/2026-08-16-
 * scorepad-v3-r2-cricket.md`): when a skin declares `phase(view)`
 * (types.ts), its answer is AUTHORITATIVE — never re-derived or
 * cross-checked against `resolveNextPhase`'s tile-declared set, because
 * the whole point of G3 is "unavailable because the match is not there",
 * not "unavailable because a tab is unselected". `resolveNextPhase`'s
 * self-correcting default (task B) is used ONLY when the skin has no
 * `phase()` at all — R3–R7 opt in one sport at a time; a skin that omits
 * this method keeps behaving exactly as task B shipped it, zero change.
 */
export function resolvePadPhase(
  skinPhase: PadPhase | null,
  current: PadPhase,
  available: readonly PadPhase[],
): PadPhase {
  return skinPhase ?? resolveNextPhase(current, available);
}

/**
 * G5 (controller ruling 2026-08-16, `docs/superpowers/plans/2026-08-16-
 * scorepad-v3-r2-cricket.md`): the PRECEDENCE RULE for `PadHostView.
 * contextOverrides` — a pending context-strip pick lives only until the
 * fold itself advances. `true` means "the fold has moved on since
 * `overridesFor` was captured, so every override is stale and must be
 * dropped", checked by REFERENCE: every module's own fold is an immutable
 * update (a new object every time, never a mutated one in place — same
 * assumption `squadStateOf`/every `useMemo` dependency in this file already
 * makes), so `prevState !== nextState` is exactly "at least one new
 * event landed". Deliberately WHOLE-MAP, never per-slot: any state change
 * means at least one ball/event was just processed, so the entire
 * pre-ball override set is stale, not merely whichever slot happened to
 * move (e.g. an odd run rotates the strike — the NON-striker slot's own
 * override is just as stale as the striker's, even though only one name
 * actually swapped). `PadHostV3`'s own render-phase reset (below) is the
 * one call site — see that block's own comment for why a ref cannot back
 * this comparison in this repo (`react-hooks/refs`).
 */
export function contextOverridesStale(overridesFor: unknown, currentState: unknown): boolean {
  return overridesFor !== currentState;
}

/** Adapts a skin's primitive-only `SwapSlot` (types.ts) into swap-sheet.tsx's
 *  own concrete shapes — see types.ts's `SwapSlot` header for why the
 *  contract stays primitive-only (avoiding a circular type import) and why
 *  this adaptation, INCLUDING re-wrapping `policyMessage` through
 *  `refusalMessage()`, happens here rather than at the contract boundary. */
export function adaptSwapSlot(
  slot: SwapSlot,
  squads: SquadState,
): { spec: SwapSheetSpec; view: PoolView; policyVerdict: PolicyVerdict } {
  return {
    spec: { offLabel: slot.offLabel, onLabel: slot.onLabel },
    view: sidePool(slot.side, squads),
    policyVerdict: slot.policyOk
      ? { ok: true }
      : { ok: false, message: slot.policyMessage !== undefined ? refusalMessage(slot.policyMessage) : undefined },
  };
}

// ---------------------------------------------------------------------------
// PadHostV3 — the React shell
// ---------------------------------------------------------------------------

const EMPTY_SPEC: PadSpec = { panels: [], fidelity: {}, fidelityEntitlements: {} };

export interface PadHostV3Props {
  module: AnySportModule;
  cfg: unknown;
  fixtureId: string;
  lineups: LineupPair;
  identity: OwnIdentity;
  transport: PadTransport;
  /** The fixture's own configured/entitled recording band. Unlike the
   *  legacy renderer's `FidelitySwitcher`, v3 has no interactive band
   *  picker (`RecordingChip` replaces it — spec §2.6 — as a worded
   *  display + upsell, never an editable control), so this value is used
   *  as-is, never locally overridden. */
  band: FidelityBand;
  entitlements: Readonly<Record<string, boolean>>;
  initialEvents?: readonly EventEnvelope[];
  queueDbName?: string;
  personNames?: Readonly<Record<string, string>>;
  /** The resolved v3 skin — a REQUIRED prop, unlike the legacy renderer's
   *  registry-consulting default: registry.tsx already resolves this
   *  before choosing the v3 lane at all, so passing it explicitly keeps
   *  ONE place deciding which skin renders. */
  skin: SkinDefV3;
  onStateChange?: (state: unknown, summary: unknown) => void;
  onEvents?: (events: readonly EventEnvelope[]) => void;
}

interface HeldTap {
  id: string;
  until: number;
  eventType: string;
}

const NO_ENTITLEMENTS: Readonly<Record<string, boolean>> = {};
const NO_NAMES: Readonly<Record<string, string>> = {};

export function PadHostV3(props: PadHostV3Props) {
  const msg = useMsg();
  // Widens useMsg()'s MessageKey-only param to the loose `string` every v3
  // primitive's own `t` prop declares (tile-grid.tsx's own header explains
  // why: TileSpec.label/DockChip.label/ContextSlot.label are skin-authored
  // plain strings, not literal MessageKeys) — MsgFn's narrower parameter
  // is not itself assignable where the wider TFn is expected, so this is a
  // real (and safe) widening, not a formality.
  const t: TFn = useCallback((key: string, vars?: Record<string, string | number>) => msg(key as MessageKey, vars), [msg]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline.state, pipeline.summary]);
  useEffect(() => {
    props.onEvents?.(pipeline.events);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline.events]);

  const personNames = props.personNames ?? NO_NAMES;
  const entitlements = props.entitlements ?? NO_ENTITLEMENTS;
  const spec = useMemo(() => props.module.padSpec?.(props.cfg) ?? EMPTY_SPEC, [props.module, props.cfg]);
  const squads = useMemo(() => squadStateOf(pipeline.state, props.lineups), [pipeline.state, props.lineups]);

  const [phase, setPhase] = useState<PadPhase>("live");
  const [held, setHeld] = useState<HeldTap | null>(null);
  const [swapOpen, setSwapOpen] = useState(false);
  const [openSheet, setOpenSheet] = useState<SheetResolution | null>(null);

  // G5's own precedence rule (contextOverridesStale, above): a pending
  // context-strip pick lives only until the fold itself advances. Render-
  // phase reset (React's own sanctioned "adjust state during render" recipe
  // — https://react.dev/reference/react/useState#storing-information-from-
  // previous-renders — TWO useState calls, deliberately NOT a ref: this
  // repo's react-hooks/refs lint rule forbids reading OR writing a ref's
  // `.current` during render, same reason DetailDock's own heldId reset
  // uses this exact recipe, detail-dock.tsx). `overridesFor` tracks WHICH
  // state object the current `contextOverrides` were captured against;
  // once `pipeline.state` moves to a new object (a ball/event just landed),
  // the whole map resets to `{}` in the SAME render that notices it, never
  // a stale value bleeding into this render's own `view`.
  const [contextOverrides, setContextOverrides] = useState<Record<string, string>>({});
  const [overridesFor, setOverridesFor] = useState<unknown>(pipeline.state);
  if (contextOverridesStale(overridesFor, pipeline.state)) {
    setOverridesFor(pipeline.state);
    setContextOverrides({});
  }

  const view: PadHostView = useMemo(
    () => ({
      cfg: props.cfg,
      state: pipeline.state,
      summary: pipeline.summary,
      phase,
      band: props.band,
      entitlements,
      personNames,
      squads,
      // C-gaps §G1 (docs/superpowers/plans/2026-08-16-scorepad-v3-r2-cricket.md):
      // state/summary alone cannot answer "what happened on ball N" — a skin
      // building an over-dots strip needs the raw stream. The SAME list this
      // component's own ribbon reads (`pipeline.events`), never a second copy.
      events: pipeline.events,
      // G5: pending context-strip picks not yet reflected by the fold — see
      // types.ts's own doc on PadHostView.contextOverrides and this file's
      // contextOverridesStale/render-phase-reset block above.
      contextOverrides,
    }),
    [props.cfg, pipeline.state, pipeline.summary, phase, props.band, entitlements, personNames, squads, pipeline.events, contextOverrides],
  );

  // `sheets` is resolved BEFORE the tiles so the band filter below can read a
  // sheet-opening tile's underlying event type. Deliberately not memoized —
  // see the note that used to sit at this call's old position, further down:
  // a skin's sheet closes over live view state and a memo would let it go
  // stale the moment the match moves.
  const sheets = props.skin.sheets?.(view);
  const entitledBands = useMemo(() => entitledBandsFrom(spec.fidelityEntitlements, entitlements), [spec, entitlements]);

  // Band filter applied BEFORE `phasesWithTiles`, not at render: the phase
  // machinery must reason about the tiles a scorer can actually see, or the
  // pad can snap to a phase whose only tiles were filtered away and show an
  // empty grid.
  const allTiles = useMemo(() => props.skin.tiles(view), [props.skin, view]);
  const tiles = useMemo(
    () => filterTilesByBand(allTiles, sheets ?? {}, spec.fidelity, entitledBands),
    [allTiles, sheets, spec.fidelity, entitledBands],
  );
  const availablePhases = useMemo(() => phasesWithTiles(tiles), [tiles]);
  // G3: a skin's own phase(view), when declared, overrides the self-correcting
  // default below rather than being cross-checked against it — see
  // resolvePadPhase's own doc.
  const nextPhase = resolvePadPhase(props.skin.phase?.(view) ?? null, phase, availablePhases);
  if (nextPhase !== phase) setPhase(nextPhase);

  const scorebugSpec = useMemo(() => props.skin.scorebug(view), [props.skin, view]);
  const contextSpec = useMemo(() => props.skin.context?.(view) ?? null, [props.skin, view]);
  const swapSlot = useMemo(() => props.skin.swap?.(view) ?? null, [props.skin, view]);

  const padViewCtx: PadViewCtx = useMemo(
    () => ({ state: pipeline.state, summary: pipeline.summary, phase, band: props.band, entitlements }),
    [pipeline.state, pipeline.summary, phase, props.band, entitlements],
  );
  const padView = useMemo(() => buildPadView(spec, padViewCtx), [spec, padViewCtx]);
  // `sheets` is declared once, further up — it had to move above the tile
  // build so the band filter can resolve a sheet-opening tile's event type.
  // G4's reasoning for not memoizing it lives with that declaration.
  const dedicated = useMemo(() => dedicatedEventTypes(tiles, sheets), [tiles, sheets]);
  const moreActionsList = useMemo(() => moreActions(spec, padViewCtx, dedicated), [spec, padViewCtx, dedicated]);

  // The ONE dispatch gateway (task brief item 5): every event this host
  // sends — tile taps, guided-sheet completions, action-form confirms,
  // swap completions, context selections — passes through
  // `createSkinDispatch`'s "a skin cannot invent an event" guard, then
  // this function's own soft-commit (submitHeld, never plain submit —
  // spec §2.3).
  const heldSubmit = useCallback(
    async (type: string, payload: unknown) => {
      const result = await pipeline.submitHeld(type, payload, HOLD_MS, () => {
        setHeld(null);
        void pipeline.retryDrain();
      });
      if (result) setHeld({ id: result.heldId, until: result.heldUntil, eventType: type });
    },
    [pipeline],
  );
  const dispatch = useMemo(() => createSkinDispatch(padView, heldSubmit), [padView, heldSubmit]);

  const handleTileAction = useCallback(
    (action: TileSpec["action"]) => {
      if ("swap" in action) {
        setSwapOpen(true);
        return;
      }
      if ("event" in action) void dispatch(action.event.type, action.event.payload);
    },
    [dispatch],
  );
  const handleOpenSheet = useCallback(
    (sheetKey: string) => {
      const resolution = resolveSheet(sheetKey, sheets);
      if (resolution.kind !== "none") setOpenSheet(resolution);
    },
    [sheets],
  );

  const dockStore = useMemo(() => makeDockStore(pipeline.queueStore), [pipeline.queueStore]);
  const dockSpec = held ? props.skin.dock(held.eventType, view) : null;

  // Blocker 1 — see rejectionText's own doc above.
  const rejectionMsg = rejectionText(pipeline.lastRejection, msg);
  // No memo, matching the legacy reader's own reasoning: a cheap read, and
  // `pipeline.summary` already changes identity on every fold advance.
  const headline = summaryHeadline(pipeline.summary);

  const events = pipeline.events;
  const latestEvent = events.length > 0 ? events[events.length - 1]! : null;
  const ribbon = latestEvent
    ? buildRibbon(latestEvent.type, latestEvent.payload as Record<string, unknown>, (id) => personNames[id] ?? id, t)
    : null;

  // The activity panel reads four fields; `voids` is what makes a row show
  // as cancelled (activity.tsx derives it by looking for some OTHER event
  // pointing back at this id, never a flag on the target itself).
  const activityEvents = useMemo<ActivityEvent[]>(
    () => events.map((e) => ({ id: e.id, seq: e.seq, type: e.type, payload: e.payload, voids: e.voids ?? null })),
    [events],
  );

  const [voidingId, setVoidingId] = useState<string | null>(null);

  async function handleUndo(eventId: string) {
    const decision = decideUndo(eventId, held?.id ?? null);
    setVoidingId(eventId);
    try {
      if (decision.kind === "drop") {
        if (await pipeline.dropHeldSubmission(decision.heldId)) setHeld(null);
      } else {
        await pipeline.submit("core.void", { event_id: decision.eventId });
      }
    } finally {
      setVoidingId(null);
    }
  }

  const adaptedSwap = swapSlot ? adaptSwapSlot(swapSlot, squads) : null;

  return (
    <div data-role="pad-v3" className="space-y-3">
      {/* Sign-off review 2026-08-17: the legacy renderer showed the fold's own
       *  headline (pad-renderer.tsx:192,296, added by S10/#419 as a fix) and
       *  v3 dropped it — `ScorebugSpec` carries no result field, so a finished
       *  match showed two scores and nothing that said who won. On a TIE that
       *  is the whole outcome, and on a super-over or boundary-count decision
       *  the pad said nothing about how it was decided. Rendered by the HOST,
       *  not a skin: the string comes from the engine's own summary, so it
       *  stays sport-agnostic and every converted skin gets it for free.
       *  `summaryHeadline` is the SAME reader the legacy pad uses — reused,
       *  not reimplemented, so the two cannot drift. It degrades to null for
       *  anything that is not a genuine `{headline: string}`, and null means
       *  render nothing rather than invent placeholder copy. */}
      {headline && (
        <p data-role="v3-headline" className="rounded-xl bg-slate-900 px-4 py-2 text-center text-sm font-semibold text-white">
          {headline}
        </p>
      )}

      <div data-role="v3-scorebug">
        <Scorebug spec={scorebugSpec} t={t} onTap={(event: TapEvent) => void dispatch(event.type, event.payload)} />
      </div>

      {rejectionMsg && (
        <p
          data-role="v3-rejection"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {rejectionMsg}
        </p>
      )}

      {ribbon && (
        <div
          data-role="v3-ribbon"
          className="flex items-center justify-between gap-2 rounded-full border border-slate-200 bg-white px-4 py-2"
        >
          <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{ribbon.text}</span>
          <button
            type="button"
            onClick={() => void handleUndo(latestEvent!.id)}
            style={{ minHeight: 44, minWidth: 44 }}
            className="shrink-0 rounded-full px-3 text-sm font-semibold text-violet-700 transition-colors hover:bg-violet-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400"
          >
            {msg("pad.ribbon.undo")}
          </button>
        </div>
      )}

      <div data-role="v3-recording">
        <RecordingChip activeBand={props.band} entitledBands={entitledBands} fidelityEntitlements={spec.fidelityEntitlements} t={msg} />
      </div>

      {contextSpec && (
        <div data-role="v3-context">
          <ContextStrip
            spec={contextSpec}
            view={combinedPool(squads)}
            personNames={personNames}
            t={t}
            onSelect={(slotId, personId) => {
              // G5: always record the pick as a pending override FIRST — the
              // chip must reflect it and the next tap's payload must carry
              // it even for a skin (like cricket) with no contextSelect at
              // all. A skin whose engine CAN persist the pick as a real
              // event (contextSelect present) still gets that event
              // dispatched too — the override simply self-clears once the
              // fold catches up (contextOverridesStale, above), so there is
              // no conflict between the two mechanisms.
              setContextOverrides((prev) => ({ ...prev, [slotId]: personId }));
              const event = props.skin.contextSelect?.(slotId, personId, view);
              if (event) void dispatch(event.type, event.payload);
            }}
          />
        </div>
      )}

      <div data-role="v3-tiles">
        <TileGrid tiles={tiles} phase={phase} t={t} onAction={handleTileAction} onOpenSheet={handleOpenSheet} />
      </div>

      {held && (
        <div data-role="v3-dock">
          <DetailDock spec={dockSpec} heldId={held.id} store={dockStore} heldUntil={held.until} t={t} />
        </div>
      )}

      {/* Defect fix (walkthrough 2026-08-17): this mount used to omit
       *  onCancel entirely, while the sibling GuidedSheet mount just below
       *  always got one — a scorer opening cricket's Retire flow could
       *  only finish the whole off->on swap or navigate away. `onCancel`
       *  here closes the sheet the same way `onSwap` does (`setSwapOpen
       *  (false)`, unmounting `<SwapSheet>` and discarding its own local
       *  state), and `SwapSheet` itself also resets its pending off pick
       *  before calling back — see swap-sheet.tsx's own handleCancel. */}
      {swapOpen && swapSlot && adaptedSwap && (
        <div data-role="v3-swap">
          <SwapSheet
            spec={adaptedSwap.spec}
            view={adaptedSwap.view}
            policyVerdict={adaptedSwap.policyVerdict}
            personNames={personNames}
            t={t}
            onSwap={(off, on) => {
              setSwapOpen(false);
              const event = swapSlot.buildEvent(off, on);
              void dispatch(event.type, event.payload);
            }}
            onCancel={() => setSwapOpen(false)}
          />
        </div>
      )}

      {openSheet && (
        <div data-role="v3-sheet">
          {openSheet.kind === "guided" ? (
            <GuidedSheet
              spec={openSheet.spec}
              views={{ home: sidePool("home", squads), away: sidePool("away", squads) }}
              personNames={personNames}
              t={t}
              onComplete={(event) => {
                setOpenSheet(null);
                void dispatch(event.type, event.payload);
              }}
              onCancel={() => setOpenSheet(null)}
            />
          ) : (
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between gap-2 px-4 pt-3">
                <p className="mk-eyebrow text-slate-600">{t("pad.host.moreTitle")}</p>
                <button
                  type="button"
                  onClick={() => setOpenSheet(null)}
                  style={{ minHeight: 44 }}
                  className="min-w-0 shrink-0 break-words rounded-full border border-dashed border-slate-300 bg-transparent px-4 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400"
                >
                  {t("pad.sheet.cancel")}
                </button>
              </div>
              <div className="px-4 pb-3 pt-2">
                <ActionFormList
                  actions={moreActionsList}
                  t={t}
                  submittingType={null}
                  onSubmit={(type, payload) => void dispatch(type, payload)}
                  squads={squads}
                  lineups={props.lineups}
                  personNames={personNames}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Sign-off review 2026-08-17: the legacy renderer mounts <Timeline>
       *  INSIDE the pad, so event history and per-event void reached the
       *  device-link surface, which has no console chrome to fall back on.
       *  v3 shipped with neither (ribbon reads `latestEvent` only, and undo
       *  had a single call site passing `latestEvent.id`), so on cricket a
       *  scorer could not correct anything but the last ball once the hold
       *  window elapsed. Restored on the CHASSIS so R3-R6 inherit it. */}
      <div data-role="v3-activity-slot">
        <ActivityPanel
          events={activityEvents}
          ownEventIds={pipeline.ownEventIds}
          deviceLinkId={props.identity.deviceLinkId}
          personNames={personNames}
          t={t}
          onVoid={(eventId) => void handleUndo(eventId)}
          voidingId={voidingId}
          // Threads the skin's own per-event detail into the panel (D2). The
          // helper and its tests landed without this line, which made the fix
          // INERT in the product while green in CI — the exact shape of defect
          // this wave already fixed three times.
          resolveDetail={
            props.skin.activityDetail
              ? (eventType, payload, prev) => props.skin.activityDetail!(t, eventType, payload, prev)
              : undefined
          }
        />
      </div>
    </div>
  );
}
