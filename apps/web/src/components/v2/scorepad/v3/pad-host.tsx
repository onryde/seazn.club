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
// R3/football: the STRUCTURAL `SquadState` check the legacy lane already
// carries — see `squadStateOf` below for why a field-name check is not
// enough. Imported, never re-stated: two structural checks for one shape is
// exactly where the legacy and v3 lanes would start to disagree about which
// squad a football pad is reading.
import { isSquadState } from "../attribution-picker";
import { createSkinDispatch } from "../skins/types";
import { ActionFormList } from "./action-form";
import { Scorebug } from "./scorebug";
import { TileGrid } from "./tile-grid";
import { DetailDock, makeDockStore, type DockStore } from "./detail-dock";
import { ContextStrip, type PoolView, type TFn } from "./context-strip";
import { SwapSheet, refusalMessage, type PolicyVerdict, type SwapSheetSpec } from "./swap-sheet";
import { GuidedSheet } from "./guided-sheet";
import { RecordingChip } from "./recording-chip";
import { buildRibbon, type Ribbon } from "./ribbon";
import { ActivityPanel, latestRowDetail, type ActivityDetailResolver, type ActivityEvent } from "./activity";
import { MORE_SHEET_KEY, type DockSpec, type GuidedSheetSpec, type PadHostView, type PadPhase, type ScorebugSpec, type SkinDefV3, type SwapSlot, type TapEvent, type TileSpec } from "./types";
import { sportThemeAttr, sportThemeStyle } from "./sport-theme";

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
 *
 * R3/football — `state.squads` IS NOT A RESERVED NAME, and this function used
 * to read it blind. `sports/squad-state.ts`'s `SquadCarrier` is the ADOPTED
 * shape (cricket and the period/setbased/nested kernels write it), but
 * football manages its OWN private projection at the identical field name —
 * `{home,away}` of `{onPitch, bench, offUsed, sentOff}`, with no `.members`
 * array anywhere (`FootballSquad`, football.ts). Every consumer of this
 * result reads `.members`: `combinedPool` spreads it, `sidePool` feeds
 * `resolvePool` -> `playingSquad`/`onFieldPersons` (core/lineup.ts), and
 * `ActionFormList` hands it to the shared attribution picker. So the blind
 * read did not return a slightly-wrong pool for football — it THREW
 * (`.members.filter is not a function`) the first time a swap sheet, a
 * guided-sheet person step, or a More-sheet person picker resolved a pool,
 * i.e. on football's very first substitution tap.
 *
 * The check is STRUCTURAL and REUSED, never a second copy: `isSquadState`
 * (../attribution-picker.tsx) is the identical guard the legacy lane has
 * carried since S10, written for this exact sport — its own header says
 * "reading `state.squads` blind would silently misinterpret football's squad
 * as empty/malformed". A non-adopting shape degrades to `initSquads(lineups)`,
 * the same third tier the legacy picker degrades to, so both lanes read one
 * squad for one fixture. Cricket and every other adopting module are
 * unaffected — their `state.squads` passes the shape check and is returned
 * verbatim, by reference, exactly as before.
 */
export function squadStateOf(state: unknown, lineups: LineupPair): SquadState {
  const squads = (state as { squads?: unknown } | null | undefined)?.squads;
  return isSquadState(squads) ? squads : initSquads(lineups);
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

/**
 * The TOP RIBBON's line for the most recent event, or null with nothing
 * recorded.
 *
 * R3/F (F1) — extracted from `PadHostV3`'s render body so the composition it
 * performs is assertable at all. `buildRibbon` has accepted a `detail` since
 * the 2026-08-17 sign-off review, and every converted skin builds one, but the
 * host called it with FOUR arguments here and threaded `activityDetail` into
 * `<ActivityPanel>` ONLY: `pad.ribbon.withDetail` never fired on the ribbon,
 * so a 320 capture showed "Goal recorded" on the ribbon while the dock
 * directly beneath it held the scorer's name.
 *
 * The detail comes from `latestRowDetail` (activity.tsx), NOT from a second
 * ordering rule written here — the ribbon and the panel's newest row describe
 * the same event and must read identically, which
 * `__tests__/top-ribbon.test.ts` pins against the panel's own rendered markup.
 */
export function buildTopRibbon(
  events: readonly ActivityEvent[],
  nameOf: (personId: string) => string,
  t: MsgFn,
  resolveDetail: ActivityDetailResolver | undefined,
): Ribbon | null {
  const latest = events.length > 0 ? events[events.length - 1] : undefined;
  if (latest === undefined) return null;
  return buildRibbon(
    latest.type,
    (latest.payload ?? {}) as Record<string, unknown>,
    nameOf,
    t,
    latestRowDetail(events, resolveDetail),
  );
}

/** Every event type ALREADY reachable through a dedicated tile, a guided
 *  sheet, or a swap slot — the "More" sheet's own exclusion set (item 4: a
 *  future engine action must appear WITHOUT a skin edit, which only holds if
 *  this set is derived from the skin's declarations, never hand-listed).
 *
 *  R3/football closed the one hole left here. A `{swap: id}` tile used to
 *  contribute NOTHING, so a sport whose substitution is also declared in
 *  `padSpec(cfg)` listed it BOTH on its Sub tile and again as a generic form
 *  inside "More". The original justification ("a swap's event cannot be known
 *  statically") stopped being true with R3's defect-3 fix, which gives
 *  `SwapSlot` a declared `eventType` precisely so it CAN be; all that was
 *  missing was the slot TABLE, since a `{swap}` action carries only an id.
 *  It is now a parameter, resolved through the SAME `resolveSwapSlot` the
 *  band filter uses — one resolution, so a tile cannot be band-filtered as
 *  one event and de-duplicated as another.
 *
 *  Why fixing it beat living with it (football's own ruling, `_INDEX.md`):
 *  the duplicate is not cosmetic. The generic More form for a substitution
 *  bypasses everything the swap sheet exists to provide — the module's own
 *  `lineupPolicy` verdict, the narrowed on/off lists, the reason an
 *  already-substituted player is ineligible, and the skin's stale-stamp guard
 *  on `at` — so the un-narrowed path sat one tap from the narrowed one. That
 *  is the same two-divergent-entry-points defect R2c closed for
 *  `cricket.retire`, which the sheet's own `event` already de-duplicates.
 *
 *  `swaps` is REQUIRED, not optional-with-a-default: an omitted argument
 *  would default a forgetful caller straight back to the duplicate, silently
 *  — the same reasoning `swapCandidates`'s own `offId` parameter states. A
 *  skin with no swap passes `[]`, which reads as the deliberate statement it
 *  is.
 *
 *  R4/tennis closed a third instance of it. (Not "the last" — this comment
 *  said that in draft, and a claim about holes nobody has found yet is a
 *  prediction, which is the shape this programme keeps having to correct.)
 *  Every
 *  skin before tennis was tapModel T, where the scorebug is a pure READOUT —
 *  football's own scorebug comment says declaring `tappable` there "would give
 *  one event two entry points", and it dodged the problem by not being
 *  tapModel S. Tennis IS tapModel S: its scoreboard halves ARE the point
 *  buttons, carrying a real `tapEvent`. That event was reachable from the
 *  board and STILL listed in the More sheet as a bare generic form, which is
 *  `cricket.retire` (R2c) and `football.sub` (R3) for the third time.
 *
 *  The cost of leaving it is not cosmetic, and it is worse here than for a
 *  swap: the generic form bypasses the dock, so a chair who records a point
 *  through More silently loses the shot-type enrichment (ace / double fault /
 *  winner / unforced error) that is the whole reason tennis's per-person ace
 *  and double-fault tallies can finally be fed from the pad at all.
 *
 *  `scorebug` is REQUIRED for the same reason `swaps` is. A tapModel-T skin
 *  passes its own spec and contributes nothing new, because a half with no
 *  `tappable` has no `tapEvent` to contribute — so cricket and football are
 *  provably unaffected (neither sets `tappable` on any half), and that is a
 *  property, not a promise: it falls out of the loop below rather than out of
 *  a special case. */
export function dedicatedEventTypes(
  tiles: readonly TileSpec[],
  sheets: Record<string, GuidedSheetSpec> | undefined,
  swaps: readonly SwapSlot[],
  scorebug: ScorebugSpec,
): Set<string> {
  const out = new Set<string>();
  for (const tile of tiles) {
    if ("event" in tile.action) out.add(tile.action.event.type);
    else if ("swap" in tile.action) {
      const slot = resolveSwapSlot(tile.action.swap, swaps);
      if (slot) out.add(slot.eventType);
    }
  }
  if (sheets) for (const spec of Object.values(sheets)) out.add(spec.event);
  // A tapModel-S half. `tappable` and `tapEvent` travel together by contract
  // (`assertScorebugSpec` refuses one without the other), so the `tapEvent`
  // guard is belt-and-braces against a spec that never reached the assert —
  // not a second opinion about what tappable means.
  for (const half of scorebug.halves) {
    if (half.tappable === true && half.tapEvent) out.add(half.tapEvent.type);
  }
  return out;
}

/** The "More" sheet's own content: every `padSpec(cfg)` action NOT in
 *  `dedicated` and NOT in `refused`, phase/gate/band/entitlement-filtered
 *  exactly like the panel walk `buildPadView` already does for the legacy
 *  renderer — reused verbatim, never re-derived. De-duplicated by type: a
 *  module may legitimately declare the same wire type more than once across
 *  panels (skins/types.ts's own `actionByType` doc); the FIRST resolved view
 *  wins, same "first match" convention that file already documents.
 *
 *  TWO EXCLUSION SETS, ON PURPOSE (R3 review round). `dedicated` is "already
 *  reachable through a narrowed surface" — see `dedicatedEventTypes` above.
 *  `refused` is `SkinDefV3.refusedEventTypes(view)`: "the fold will not accept
 *  this at all right now". They are not unioned into one parameter because a
 *  later reader must be able to tell which reason applied, and because they
 *  are computed from different things — the skin's own tile/sheet/swap
 *  declarations versus its engine's phase gates.
 *
 *  The comment `buildPadView` earns above ("a locked/wrong-phase action can
 *  never leak in here either") was TRUE OF THE PANEL GATE and false of the
 *  fold: `padSpec`'s gates are the only phase rules the view model can see,
 *  and football keeps most of its own inside `apply`. That gap is exactly what
 *  `refused` closes — it shipped as four dead-end taps during the shoot-out,
 *  two of them at band 0.
 *
 *  `refused` is REQUIRED, not optional-with-a-default, for the same reason
 *  `swaps` is on `dedicatedEventTypes`: a defaulted argument would silently
 *  restore the dead end for a forgetful caller. A skin that declares no
 *  refusals passes an empty set, which reads as the deliberate statement it
 *  is. */
export function moreActions(
  spec: PadSpec,
  ctx: PadViewCtx,
  dedicated: ReadonlySet<string>,
  refused: ReadonlySet<string>,
): PadActionView[] {
  const view = buildPadView(spec, ctx);
  const seen = new Set<string>();
  const out: PadActionView[] = [];
  for (const panel of view.panels) {
    for (const action of panel.actions) {
      if (dedicated.has(action.type) || refused.has(action.type) || seen.has(action.type)) continue;
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
 * THE MORE SHEET'S `null` IS LOAD-BEARING AND MUST NOT CHANGE. It hosts the
 * whole `padSpec(cfg)` action list rather than one event, and it is exactly
 * where a LOW-band org reaches its only recording action
 * (`cricket.innings.summary`) — band-filtering it would remove that. It
 * returns null because there is genuinely no single event to classify, and
 * every future edit to this function must keep it that way.
 *
 * R3 chassis sub-wave (owner ruling 2026-08-24, defect 3): a `{swap: id}` tile
 * NOW resolves, through the skin's own declared slots. It used to return null
 * for the same surface reason as the MORE sheet — "the event is built from the
 * picked people at tap time" — but the two nulls were never the same thing.
 * MORE has no single event by construction; a swap has exactly one, just not
 * yet built. `SwapSlot.eventType` (types.ts) declares it statically so the
 * band filter can see it, because `football.sub` sits above tiers 0/1 and a
 * band-0 scorer was otherwise shown a Sub tile that could only ever end in a
 * refusal after two picks.
 *
 * An id no slot declares still returns null and is therefore kept — see
 * `filterTilesByBand`'s fail-open reasoning below. (`resolveSwapSlot` fails
 * CLOSED for the same input, which is not a contradiction: showing a tile
 * nobody could classify is safe, whereas OPENING a sheet resolved to the wrong
 * slot would swap the wrong team's player.)
 */
export function tileEventType(
  tile: TileSpec,
  sheets: Record<string, GuidedSheetSpec>,
  swaps: readonly SwapSlot[],
): string | null {
  if ("event" in tile.action) return tile.action.event.type;
  if ("sheet" in tile.action) {
    if (tile.action.sheet === MORE_SHEET_KEY) return null;
    return sheets[tile.action.sheet]?.event ?? null;
  }
  return resolveSwapSlot(tile.action.swap, swaps)?.eventType ?? null;
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
  swaps: readonly SwapSlot[],
  fidelity: PadSpec["fidelity"],
  entitledBands: ReadonlySet<FidelityBand>,
): TileSpec[] {
  return tiles.filter((tile) => {
    const type = tileEventType(tile, sheets, swaps);
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
 *
 * INVESTIGATED, NOT CHANGED (R2b live bug follow-up, 2026-08-17): the owner
 * also reported that manually picking a bowler and tapping again was
 * "still refused." Suspected cause, unverified going in: this reset firing
 * between the pick and the next tap. NOT confirmed for cricket specifically
 * — cricket declares no `contextSelect` (cricket.tsx's own header), so
 * `onSelect` below only calls `setContextOverrides`; it never dispatches,
 * so picking a candidate alone never touches `pipeline.state` and cannot by
 * itself trigger this reset. What IS real and worth a future investigator's
 * time: this doc's own claim that "`prevState !== nextState` is exactly
 * 'at least one new event landed'" is slightly stronger than the code
 * actually guarantees — `foldedState`'s own `useMemo` (use-pad-pipeline.ts)
 * depends on `lastRejection`/`serverOverride` in addition to the real event
 * stream, and a rejected submission always constructs a NEW `{code,
 * message}` object (no dedup against a same-content prior value), so
 * `pipeline.state` CAN get a fresh reference from an UNRELATED async
 * settlement (e.g. a different, earlier submission's rejection arriving
 * late) landing in the gap between a pick and the next tap, not only from
 * a change that actually affects the picked slot. Separately: the client's
 * own optimistic fold (`foldClient`, called with no `opts` from
 * use-pad-pipeline.ts) runs entirely non-strict (`strictFromSeq` undefined
 * -> `strict: false` for every event, packages/engine/src/core/events.ts:
 * 466/522), so an illegal bowler is NOT caught immediately client-side —
 * it looks accepted until the server round-trip rejects it after
 * `HOLD_MS`, which is a more likely source of "did my fix even take"
 * confusion than this reset. Left AS IS: no reproduction found for the
 * literal suspicion, and Part 1's fix (the bowler default is now always
 * eligible-or-empty) closes the most common path to an illegal FIRST tap
 * that this whole chain starts from. If this resurfaces, capture exact
 * pick-to-tap timing and whether a second device/tab was scoring the same
 * fixture concurrently — this file's own pure-builder test suite cannot
 * observe either.
 */
export function contextOverridesStale(overridesFor: unknown, currentState: unknown): boolean {
  return overridesFor !== currentState;
}

/**
 * R3 chassis sub-wave (owner ruling 2026-08-24, `_INDEX.md`, defects 1+2): the
 * slot a `{swap: id}` tile addresses, or `null`.
 *
 * FAIL-CLOSED, and that direction is deliberate — the opposite of
 * `filterTilesByBand`'s fail-open. An id no slot declares opens NOTHING rather
 * than falling back to the first slot: that fallback is precisely the defect
 * being fixed (one shared sheet for every swap tile, the side taken from
 * whichever slot happened to be first), so re-introducing it as an error path
 * would make the bug survive its own fix. Failing open costs a scorer a tap
 * that does nothing; failing to a fallback silently substitutes the WRONG
 * TEAM's player, which is a scoring error nobody would notice until the
 * timeline is read back.
 *
 * `slotId === null` is the ordinary "no sheet open" state — the host's own
 * `openSwapId`, which replaced R1's `swapOpen` boolean.
 */
export function resolveSwapSlot(slotId: string | null, slots: readonly SwapSlot[]): SwapSlot | null {
  if (slotId === null) return null;
  return slots.find((slot) => slot.id === slotId) ?? null;
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
    // R3 (defect 4): `candidates`/`blocked` cross verbatim, same field names on
    // both sides. A rename here is exactly where two narrowing idioms start to
    // drift, and dropping them here would leave the whole contract dead on the
    // production path while the sheet's own unit tests still passed.
    spec: {
      offLabel: slot.offLabel,
      onLabel: slot.onLabel,
      candidates: slot.candidates,
      offCandidates: slot.offCandidates,
      blocked: slot.blocked,
    },
    view: sidePool(slot.side, squads),
    policyVerdict: slot.policyOk
      ? { ok: true }
      : { ok: false, message: slot.policyMessage !== undefined ? refusalMessage(slot.policyMessage) : undefined },
  };
}

/**
 * R2b/task 4 (`_INDEX.md`, owner ruling): the ONE line that used to call
 * `props.skin.dock(held.eventType, view)` directly inside `PadHostV3`'s own
 * render body, extracted as a pure builder — same "data in, data out" split
 * as every other decision in this section. `null` while nothing is held —
 * the skin's own `dock()` is never called with nothing to build a dock for,
 * proved by the mutation suite (a skin that throws when called with no hold
 * must never actually be called here).
 *
 * `held.payload` is forwarded to `dock()` as its (optional) 3rd argument
 * VERBATIM — cricket's own no-ball/plain-single distinction (both dispatch
 * the identical `cricket.ball` event TYPE) is exactly why this widening
 * exists; see `SkinDefV3.dock`'s own doc, types.ts.
 */
export function resolveDockSpec(
  skin: SkinDefV3,
  held: { eventType: string; payload: unknown } | null,
  view: PadHostView,
): DockSpec | null {
  if (!held) return null;
  return skin.dock(held.eventType, view, held.payload as Record<string, unknown> | undefined);
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
  /** R2b/task 4: the tap's own payload, captured at hold time — what
   *  `resolveDockSpec` forwards to `skin.dock()`'s optional 3rd argument
   *  (see that function's own doc, above). */
  payload: unknown;
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
  // R3 chassis sub-wave (defect 2): the id of the OPEN swap slot, or null.
  // Was a bare `swapOpen` boolean, which could only ever mean "the swap sheet
  // is showing" — with one sheet per skin there was nothing else to say.
  const [openSwapId, setOpenSwapId] = useState<string | null>(null);
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
  // R3 (defect 3): resolved BEFORE the tiles for the same reason `sheets` is —
  // the band filter must resolve a `{swap: id}` tile's declared event type,
  // and it can only do that against the slot table. Moving this line back
  // below the tile build silently reinstates the unfiltered swap tile.
  const swapSlots = useMemo(() => props.skin.swap?.(view) ?? [], [props.skin, view]);
  const entitledBands = useMemo(() => entitledBandsFrom(spec.fidelityEntitlements, entitlements), [spec, entitlements]);

  // Band filter applied BEFORE `phasesWithTiles`, not at render: the phase
  // machinery must reason about the tiles a scorer can actually see, or the
  // pad can snap to a phase whose only tiles were filtered away and show an
  // empty grid.
  const allTiles = useMemo(() => props.skin.tiles(view), [props.skin, view]);
  const tiles = useMemo(
    () => filterTilesByBand(allTiles, sheets ?? {}, swapSlots, spec.fidelity, entitledBands),
    [allTiles, sheets, swapSlots, spec.fidelity, entitledBands],
  );
  const availablePhases = useMemo(() => phasesWithTiles(tiles), [tiles]);
  // G3: a skin's own phase(view), when declared, overrides the self-correcting
  // default below rather than being cross-checked against it — see
  // resolvePadPhase's own doc.
  const nextPhase = resolvePadPhase(props.skin.phase?.(view) ?? null, phase, availablePhases);
  if (nextPhase !== phase) setPhase(nextPhase);

  const scorebugSpec = useMemo(() => props.skin.scorebug(view), [props.skin, view]);
  const contextSpec = useMemo(() => props.skin.context?.(view) ?? null, [props.skin, view]);

  const padViewCtx: PadViewCtx = useMemo(
    () => ({ state: pipeline.state, summary: pipeline.summary, phase, band: props.band, entitlements }),
    [pipeline.state, pipeline.summary, phase, props.band, entitlements],
  );
  const padView = useMemo(() => buildPadView(spec, padViewCtx), [spec, padViewCtx]);
  // `sheets` is declared once, further up — it had to move above the tile
  // build so the band filter can resolve a sheet-opening tile's event type.
  // G4's reasoning for not memoizing it lives with that declaration.
  // R3/football: `swapSlots` is the third argument — without it a swap's own
  // event stays listed in the More sheet as an un-narrowed generic form
  // beside its Sub tile (see dedicatedEventTypes' own doc).
  const dedicated = useMemo(() => dedicatedEventTypes(tiles, sheets, swapSlots, scorebugSpec), [tiles, sheets, swapSlots, scorebugSpec]);
  // R3 review round: the skin's own "the fold refuses this right now" set —
  // `moreActions`' second exclusion set, see its doc for why the two are not
  // one. Built from `view` (not `padViewCtx`), because it is a SKIN call and
  // every skin method takes the same view bag.
  const refusedTypes = useMemo(
    () => new Set(props.skin.refusedEventTypes?.(view) ?? []),
    [props.skin, view],
  );
  const moreActionsList = useMemo(
    () => moreActions(spec, padViewCtx, dedicated, refusedTypes),
    [spec, padViewCtx, dedicated, refusedTypes],
  );

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
      if (result) setHeld({ id: result.heldId, until: result.heldUntil, eventType: type, payload });
    },
    [pipeline],
  );
  const dispatch = useMemo(() => createSkinDispatch(padView, heldSubmit), [padView, heldSubmit]);

  const handleTileAction = useCallback(
    (action: TileSpec["action"]) => {
      if ("swap" in action) {
        // R3 (defect 2): the tile names WHICH slot. `resolveSwapSlot` at
        // render time decides whether anything opens — an id no slot declares
        // is a no-op, never a fallback to the first slot.
        setOpenSwapId(action.swap);
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

  // R3 review round 4 — the held PAYLOAD has to advance with the dock.
  //
  // `heldSubmit` records the payload as it was at tap time, and a dock chip
  // mutates the QUEUE entry, never this state. So `resolveDockSpec` below kept
  // being handed the original payload and every payload-dependent dock froze on
  // its first step — football's goal dock asked for the scorer and never became
  // the assist step. The unit tests could not see it: they call `buildDock`
  // directly with whatever payload they like.
  //
  // `fn` is applied a second time here rather than read back from the store: a
  // chip's `mutate` is a pure `(payload) => payload` (types.ts), the store has
  // no read-one API, and re-reading would race the very drain that sends it.
  const dockStore = useMemo<DockStore>(() => {
    const base = makeDockStore(pipeline.queueStore);
    return {
      releaseHeld: (id) => base.releaseHeld(id),
      mutateHeld: async (id, fn) => {
        const applied = await base.mutateHeld(id, fn);
        if (applied) {
          setHeld((prev) =>
            prev && prev.id === id
              ? { ...prev, payload: fn((prev.payload ?? {}) as Record<string, unknown>) }
              : prev,
          );
        }
        return applied;
      },
    };
  }, [pipeline.queueStore]);
  const dockSpec = resolveDockSpec(props.skin, held, view);

  // Blocker 1 — see rejectionText's own doc above.
  const rejectionMsg = rejectionText(pipeline.lastRejection, msg);
  // No memo, matching the legacy reader's own reasoning: a cheap read, and
  // `pipeline.summary` already changes identity on every fold advance.
  const headline = summaryHeadline(pipeline.summary);

  const events = pipeline.events;
  const latestEvent = events.length > 0 ? events[events.length - 1]! : null;

  // The activity panel reads four fields; `voids` is what makes a row show
  // as cancelled (activity.tsx derives it by looking for some OTHER event
  // pointing back at this id, never a flag on the target itself).
  //
  // Declared ABOVE the ribbon (R3/F, F1): the ribbon needs the same rows the
  // panel does, because it now resolves the same per-event detail for the
  // newest of them.
  const activityEvents = useMemo<ActivityEvent[]>(
    () => events.map((e) => ({ id: e.id, seq: e.seq, type: e.type, payload: e.payload, voids: e.voids ?? null })),
    [events],
  );

  // ONE resolver, built once and handed to BOTH readers — the ribbon and the
  // panel. It used to be an inline closure at the `<ActivityPanel>` call site
  // only, which is precisely how the ribbon went four waves without a detail.
  //
  // R2b-cricket-over review fix (item 1): builds the single
  // `ActivityDetailContext` object (types.ts) the skin's `activityDetail`
  // takes, instead of seven positional arguments. `history` is forwarded
  // verbatim from the caller (the panel resolves per-row history itself —
  // `priorActivityEvents`, activity.tsx; `latestRowDetail` uses the same pair
  // for the newest row). `view.cfg` and `personNames` are CAPTURED from this
  // closure's own scope rather than crossing `ActivityPanel`'s prop contract:
  // both are static per render, not per-row facts. `personNames` is the SAME
  // map this component already resolves above for the ribbon and for
  // `<ActivityPanel personNames={personNames}>` (R2b owner ruling, live-tile
  // audit wave — "name the bowler").
  const resolveDetail = useMemo<ActivityDetailResolver | undefined>(
    () =>
      props.skin.activityDetail
        ? (eventType, payload, history) =>
            props.skin.activityDetail!({ t, eventType, payload, history, cfg: view.cfg, personNames })
        : undefined,
    [props.skin, t, view.cfg, personNames],
  );

  const ribbon = buildTopRibbon(activityEvents, (id) => personNames[id] ?? id, t, resolveDetail);

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

  const openSwapSlot = resolveSwapSlot(openSwapId, swapSlots);
  const adaptedSwap = openSwapSlot ? adaptSwapSlot(openSwapSlot, squads) : null;

  return (
    /* R3/task B4 (owner ruling R3-6, per-sport visual identity): the ONE place
     * a sport's `--sport-*` overrides enter the DOM. Custom properties
     * inherit, so every descendant — scorebug, tiles, sheets, dock, swap —
     * resolves the sport's palette without any of them knowing which sport is
     * mounted. `sportThemeStyle` returns `undefined` for a sport that declares
     * no override (cricket, and every sport before its own wave), and React
     * renders no `style` attribute at all for `undefined` — an empty object
     * would emit a real `style=""` and change that pad's own markup. The
     * defaults live in globals.css's `:root` as ALIASES of the product's
     * `--mk-*` vars, so an un-overridden pad paints exactly what it painted
     * before the token layer existed. */
    <div
      data-role="pad-v3"
      className="space-y-3"
      style={sportThemeStyle(props.skin.key)}
      /* R3 review round — the ATTRIBUTE twin of the style above, emitted from
       * the same key on the same element. A CSS rule can read a `--sport-*`
       * property but cannot ask whether anyone overrode it, so a rule painting
       * "the sport's colour" had no way to leave an un-overriding sport alone:
       * B4's `.pad-half:focus-visible` turned cricket's focus ring lime. This
       * is what globals.css scopes such a rule to. `undefined` for a sport
       * with no palette, so its markup is unchanged. */
      data-sport-theme={sportThemeAttr(props.skin.key)}
    >
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
       *  here closes the sheet the same way `onSwap` does (`setOpenSwapId
       *  (null)`, unmounting `<SwapSheet>` and discarding its own local
       *  state), and `SwapSheet` itself also resets its pending off pick
       *  before calling back — see swap-sheet.tsx's own handleCancel.
       *
       *  R3 (defect 2): keyed on the OPEN SLOT's id, so switching from the
       *  home Sub tile to the away one remounts `SwapSheet` and drops any
       *  half-made off pick from the previous slot. Without the key React
       *  would reuse the instance and carry a home player's id into the away
       *  sheet — a wrong-team swap with no visible tell. */}
      {openSwapSlot && adaptedSwap && (
        <div data-role="v3-swap" data-swap-slot-id={openSwapSlot.id}>
          <SwapSheet
            key={openSwapSlot.id}
            spec={adaptedSwap.spec}
            view={adaptedSwap.view}
            policyVerdict={adaptedSwap.policyVerdict}
            // Owner ruling 2026-08-25: opt-in per-org "swap-sheet OFF-step
            // enforcement" — `scoring.swap_off_step_enforcement`, resolved by
            // fidelity.ts's resolveScorePadBootstrap into this SAME
            // `view.entitlements` map every other gated affordance already
            // reads. `=== true`, not a bare truthy check, so an absent key
            // (every org that hasn't been granted the override) reads as
            // `false` — BYTE-IDENTICAL to the sheet's default. See
            // swap-sheet.tsx's own `enforceOffStep`/`shouldRefuseOffStep`.
            enforceOffStep={view.entitlements["scoring.swap_off_step_enforcement"] === true}
            personNames={personNames}
            t={t}
            onSwap={(off, on) => {
              setOpenSwapId(null);
              const event = openSwapSlot.buildEvent(off, on);
              void dispatch(event.type, event.payload);
            }}
            onCancel={() => setOpenSwapId(null)}
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
          //
          // R3/F (F1): the SAME `resolveDetail` the top ribbon uses, built
          // once above rather than inlined here. It was inlined, this was its
          // only reader, and the ribbon spent four waves with no detail at all.
          resolveDetail={resolveDetail}
        />
      </div>
    </div>
  );
}
