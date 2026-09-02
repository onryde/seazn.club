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
import { CORE_EVENT_SCHEMAS, initSquads, isCoreEventType } from "@seazn/engine/core";
import type { AnySportModule, FidelityBand, PadSpec } from "@seazn/engine/sport";
import { useMsg, useMsgPlural } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { type MsgFn } from "@/lib/scoring-vocab";
import { deepEqual } from "../pipeline";
import { refusalText } from "../refusal-copy";
import type { PadTransport } from "../transport";
import type { OwnIdentity } from "../types";
import { usePadPipeline } from "../use-pad-pipeline";
import type { RejectionInfo, UsePadPipelineResult } from "../use-pad-pipeline";
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
import {
  CLOCK_NUDGE_SECONDS,
  CLOCK_NUDGE_FINE_SECONDS,
  adjustClock,
  elapsedOf,
  formatClock,
  reseatClock,
  stampOf,
  stampPayload,
  toggleClock,
  type PadClock,
  type PayloadSchemaProbe,
} from "./clock";
import {
  ActivityPanel,
  activityRowState,
  latestRowDetail,
  type ActivityDetailResolver,
  type ActivityEvent,
} from "./activity";
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
 *  a special case.
 *
 *  R3.5/B closed a fourth instance, and this one is the INVERSE of the first
 *  three. R3/football's swap, R2c's `cricket.retire`, and R4/tennis's tappable
 *  half were all "this type IS reachable through a narrowed tile/sheet/half,
 *  so the generic More form is a redundant, worse-enrichment duplicate" — the
 *  type was claimed correctly, and the bug was a second route to it. Here the
 *  type is claimed by a surface nobody can actually reach: a cricket super
 *  over disables its ENTIRE delivery row (`TileSpec.disabled` — a transient
 *  per-tile block, never a phase-gated removal), and BOTH loops below used to
 *  add `cricket.superover.ball` regardless — the tile loop directly, and the
 *  `wicket` SHEET (`{sheet: "wicket"}` is that same tile's own action) a
 *  second, independent way, because a sheet's claim on its own event used to
 *  be unconditional. Fixing only the tile loop was not enough: `resolveSheet`
 *  (:854) has exactly ONE call site, reached only from a tile tap, so a sheet
 *  is never an independently reachable surface — one whose every opening
 *  tile is disabled is exactly as unreachable as those tiles, which is what
 *  `sheetOpenable` below answers. A sheet NO tile points at at all
 *  (`undefined`, never observed as `false`) stays claimed on purpose:
 *  cricket's `overSummary` sheet has no opening tile in the fine lane, and
 *  un-claiming it would surface `cricket.innings.summary` in More during a
 *  fine innings, where the fold refuses it outright (cricket.ts:1402-1404) —
 *  a brand-new dead-end tap, the exact defect class this whole function
 *  exists to prevent. Still not "the last" — but now the family has both
 *  directions: claimed-and-reachable-twice, and claimed-but-reachable-never.
 */
export function dedicatedEventTypes(
  tiles: readonly TileSpec[],
  sheets: Record<string, GuidedSheetSpec> | undefined,
  swaps: readonly SwapSlot[],
  scorebug: ScorebugSpec,
): Set<string> {
  const out = new Set<string>();
  for (const tile of tiles) {
    // R3.5/B — a DISABLED tile is not a reachable surface (see this
    // function's own doc above for the fourth, inverted instance this
    // closes). Per-TYPE correctness falls out for free: a type with one
    // enabled and one disabled tile is still added by the enabled one.
    if (tile.disabled === true) continue;
    if ("event" in tile.action) out.add(tile.action.event.type);
    else if ("swap" in tile.action) {
      const slot = resolveSwapSlot(tile.action.swap, swaps);
      if (slot) out.add(slot.eventType);
    }
  }
  // Which sheets an ENABLED tile can actually open — see this function's
  // own doc above for why a sheet is not an independent surface. Built from
  // EVERY tile (disabled included), unlike the loop above: a disabled
  // opener still needs to be counted so a sheet with only disabled openers
  // reads as `false`, not `undefined` (silently and wrongly treated as
  // "no opener at all", which stays claimed).
  const sheetOpenable = new Map<string, boolean>();
  for (const tile of tiles) {
    if (!("sheet" in tile.action)) continue;
    const key = tile.action.sheet;
    sheetOpenable.set(key, (sheetOpenable.get(key) ?? false) || tile.disabled !== true);
  }
  if (sheets) {
    for (const [key, spec] of Object.entries(sheets)) {
      // `false` = every tile that opens it is disabled — not claimed.
      // `undefined` = NO tile opens it at all — left claimed, deliberately.
      if (sheetOpenable.get(key) === false) continue;
      out.add(spec.event);
    }
  }
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

/**
 * R7-39 (owner-approved), corrected by R7-39a: the More tile was offered
 * even when the sheet it opens has nothing in it. R7-39's own filing
 * overstated the symptom as a BLANK sheet — `action-form.tsx`'s
 * `actions.length === 0` branch renders `pad.host.moreEmpty` ("Nothing else
 * to record here yet."), never a blank panel, so this was never a rendering
 * bug. The real defect: a tile that is a GUARANTEED DEAD END at a knowable
 * phase/band, discoverable only by tapping it. `pad.host.moreEmpty` stays —
 * it is the safety net for any case this tile-level suppression cannot see
 * (a future skin that forgets to push the tile through this function, or a
 * hole this pure builder's own test suite has not yet enumerated).
 *
 * FIXED IN THE CHASSIS, not per-skin (R7-39's own ruling): `moreActionsList`
 * (this file's own render body) is already computed from exactly the inputs
 * that decide whether the More sheet has anything in it, so this function
 * takes that SAME list rather than re-deriving a second opinion. The tile is
 * found STRUCTURALLY, via `action.sheet === MORE_SHEET_KEY` — never the id
 * string `"more"`, which skins do not agree on (generic's own tile uses
 * `MORE_TILE_ID`, every other skin a bare `"more"` literal). One check here
 * fixes all seven current skins (and the eighth, whenever it lands) without
 * either one adding its own guard — `skins/generic.tsx` used to carry
 * exactly that guard (`moreHasContent`, a hand-mirror of `moreActions`
 * proved equal to it by its own test sweep) and it is DELETED as part of
 * this fix, not left beside it: two paths to one fact only ever drift.
 *
 * A skin's own `tiles(view)` now pushes the More tile UNCONDITIONALLY, the
 * same shape every non-generic skin already took before this fix — this
 * function is the one and only place that removes it.
 */
export function suppressEmptyMoreTile(tiles: readonly TileSpec[], moreActionsList: readonly PadActionView[]): TileSpec[] {
  return tiles.filter((tile) => moreActionsList.length > 0 || !("sheet" in tile.action) || tile.action.sheet !== MORE_SHEET_KEY);
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
 * (pad-renderer.tsx: `pipeline.lastRejection && <p>{…}</p>`) — same source
 * (`pipeline.lastRejection`), same resolver, same fallback key. `null` means
 * "render nothing", matching the legacy renderer's `&&`-gated JSX.
 *
 * R6 FIX PASS 3, GAP 1 — the resolver moved from `scoringErrorText` to
 * `refusalText` (../refusal-copy.ts), and BOTH lanes moved together. The
 * difference is the fall-through: `scoringErrorText`'s contract ends "…else
 * the RAW SERVER MESSAGE", which was unreachable while only a 422 could get
 * here (every engine code has copy) and became reachable the moment
 * transport.ts started surfacing the whole permanent 4xx class. A 402 then
 * resolved to "Plan upgrade required: scoring.match_timeline" — English in
 * every locale, and an internal feature slug on a rink-side screen.
 * `refusalText` never falls through to server prose. `scoringErrorText`
 * itself is untouched: the fixture console and the device pad still want its
 * raw-message behaviour, and neither is the pad chassis.
 */
export function rejectionText(rejection: RejectionInfo | null, m: MsgFn): string | null {
  return refusalText(rejection, m);
}

/**
 * The durable queue's own status, the other half of `usePadPipeline` this
 * host built and held but never rendered — same shape as `rejectionText`
 * above, and the same discovery method: R7 deleted the legacy renderer
 * (pad-renderer.tsx, `queueLabel`/`queueAttention`) without ever porting its
 * offline/resyncing/pending/synced indicator onto the v3 chassis, so a v3
 * scorer who goes offline gets no on-screen sign of it at all — the durable
 * queue (queue.ts) keeps working underneath; only the status pill was lost.
 * `usePadPipeline` is the SAME hook both lanes always shared, so `offline`/
 * `resyncing`/`queueDepth` were sitting on `pipeline` unused the whole time.
 * Ports the legacy renderer's own four-way precedence verbatim: offline
 * beats resyncing beats a non-zero queue beats synced.
 */
export function queueStatusText(
  pipeline: Pick<UsePadPipelineResult, "offline" | "resyncing" | "queueDepth">,
  m: MsgFn,
): string {
  if (pipeline.offline) return m("scorepad.queue.offline");
  if (pipeline.resyncing) return m("scorepad.queue.resyncing");
  if (pipeline.queueDepth > 0) return m("scorepad.queue.pending", { count: pipeline.queueDepth });
  return m("scorepad.queue.synced");
}

/** Whether the status pill above needs the scorer's attention (amber, with a
 *  pulsing dot) rather than reading as steady-state clean (emerald). */
export function queueStatusAttention(
  pipeline: Pick<UsePadPipelineResult, "offline" | "queueDepth">,
): boolean {
  return pipeline.offline || pipeline.queueDepth > 0;
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
 * WHICH event the ribbon's take-back acts on, or `null` for "offer nothing".
 *
 * R7/C4 (ruling R7-5, the open item the design of record left to verify —
 * and it was a real defect). The ribbon used to hand `handleUndo` the raw
 * `events[events.length - 1]`, UNFILTERED, where the console's own control
 * (`lastVoidable`, fixture-console.tsx) had always skipped `core.void` rows.
 * After ANY void the newest event IS a `core.void`, so the ribbon offered a
 * control the engine hard-refuses: `resolveVoids`
 * (packages/engine/src/core/events.ts) throws INVALID_EVENT — "voids are not
 * themselves voidable" — and an event some other void already cancelled is
 * refused for the same reason it is struck through in the panel. Offering
 * either is the pad promising what the engine will reject, which is the
 * defect class this programme exists to remove.
 *
 * A HELD tap short-circuits both rules and is ALWAYS offered. Inside the
 * soft-commit window take-back does not void at all — `decideUndo` returns
 * `{kind:"drop"}` and the submission never reaches the server (spec 2.3) —
 * so no ledger rule can apply to it, and gating it on one would delete the
 * cancel-before-send path for any skin whose held event happens to be a
 * `core.*` type.
 *
 * Deliberately the SAME rule the panel beside it applies, not a second one:
 * two controls that both write `core.void` must agree on what is voidable.
 *
 * R7/C review fix #2 — and "the same rule" now means the same FUNCTION.
 * C4 restated the console's half of the rule and applied it on BOTH surfaces,
 * so a device link whose newest row came from the console was still offered a
 * take-back — one the activity panel one line below already hid, and one the
 * server refuses outright (`server/usecases/scoring.ts`: "A device link can
 * only undo its own events", 403). `activityRowState` (activity.tsx) is the
 * one place that rule lives; this delegates to it with the same arguments the
 * sibling `<ActivityPanel>` mount receives, and `authority` follows the
 * SURFACE exactly as those mounts' own props do — the in-app console
 * (`deviceLinkId === null`) mounts its ledger with authority and may void
 * anything that is not itself a void; the device link keeps
 * `isVoidableEventType`'s allowlist and its own rows. `voidingEnabled` is
 * `true` here because reaching this function IS the pad offering the control.
 */
export function ribbonUndoTarget(
  events: readonly ActivityEvent[],
  heldId: string | null,
  ownEventIds: ReadonlySet<string>,
  deviceLinkId: string | null,
): string | null {
  if (heldId !== null) return heldId;
  const latest = events.length > 0 ? events[events.length - 1]! : null;
  if (latest === null) return null;
  const { canVoid } = activityRowState(
    latest,
    events,
    ownEventIds,
    deviceLinkId,
    true,
    deviceLinkId === null,
  );
  return canVoid ? latest.id : null;
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
 * R7/C2 — THE OTHER HALF OF D-12. "Forfeit/Abandon are not representable in
 * the tile grid" has been a CONVENTION stated in prose since R1, with no
 * type and no runtime block (`_INDEX.md`: "Skin-level validation owes the
 * enforcement"). Nothing enforced it; the eleven shipped skins simply never
 * declared such a tile, which is not the same thing as the chassis refusing
 * one.
 *
 * Console chrome is where the enforcement belongs because console chrome is
 * where these two events LIVE: the labelled "Match actions" band
 * (fixture-console.tsx), below the pad and below the ledger, with a sentence
 * saying they end the match record and a confirmation on Abandon. A tile
 * reaching the same event from inside the scoring grid would put the most
 * destructive action in the product one thumb-width from a rally tap — the
 * hierarchy failure D-12 names — and bypass both the sentence and the
 * confirmation.
 *
 * Enforced INSIDE `filterTilesByBand` rather than as a separate pass with
 * its own call site: every tile the host renders already goes through that
 * one filter, so there is no second wiring step a later wave can forget, and
 * a guard nothing is wired to is not a guard.
 *
 * A CLOSED PAIR, not a ban on `core.*`. `core.note` and `core.award` stay
 * tile-able — the activity panel's own void allowlist already treats those
 * two as the safe ones for the same reason (no state effect).
 *
 * KNOWN, LATENT BYPASS — the MORE SHEET (R7/C review, item 5). This block
 * lives in `filterTilesByBand` and therefore covers the tile GRID only.
 * `dedicated` (`dedicatedEventTypes`, below) is built from the FILTERED
 * tiles, so an event this set removes leaves `dedicated` too, and
 * `moreActions` then has no reason to exclude it: a `padSpec`-declared
 * `core.forfeit`/`core.abandon` action would fall through to the More sheet
 * as an un-narrowed generic form, bypassing this block, the band's sentence
 * and the Abandon confirmation alike.
 *
 * It is latent and NOT a live defect: no engine `padSpec` declares either
 * type in any panel today, which is what makes the tile grid the only route
 * that exists. That premise is a tripwire, not an assumption — see "no
 * engine padSpec declares an authority action" in
 * `__tests__/authority-only-tiles.test.ts`, which fails the day a module
 * declares one. Deliberately recorded rather than fixed: the fix belongs
 * where the exclusion sets are decided (`moreActions`' own two-set contract),
 * not bolted onto a filter whose whole virtue is having a single call site.
 */
export const AUTHORITY_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set([
  "core.forfeit",
  "core.abandon",
]);

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
 *
 * ONE clause fails CLOSED — `AUTHORITY_ONLY_EVENT_TYPES`, see its own doc.
 * The fail-open reasoning above does not transfer to it and the two are not
 * in tension: a tile we could not classify is a nuisance, and a Forfeit tile
 * a scorer taps by mistake ends someone's match.
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
    if (AUTHORITY_ONLY_EVENT_TYPES.has(type)) return false;
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
      // R5: same verbatim crossing, and the same reason. This adapter copies
      // BY HAND, so a field added to `SwapSlot` and to `SwapSheetSpec` but not
      // here is dead on the production path while both ends' unit tests stay
      // green — the defect this comment block was written for.
      candidateMeta: slot.candidateMeta,
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
/**
 * R6/task A — the host's stamping step, as a pure function so it can be driven
 * from a node test against a REAL engine module (`__tests__/clock.test.ts`
 * does exactly that: real skin tile -> this -> real `foldMatch`).
 *
 * The whole decision is delegated: `stampPayload` (../clock.ts) probes the
 * owning schema — `schemaFor` below — with the stamp applied, and keeps it
 * only if that schema parses. Nothing here mirrors which event types accept an
 * `at`: `at` is `GameTime.optional()` on all nine football payloads, on the
 * period kernel's seven, and on seven of the fourteen `CORE_EVENT_SCHEMAS`,
 * while the other seven are `z.strictObject`s that would reject the extra key
 * outright. See `stampPayload`'s own doc for why asking the engine beats a
 * skin-side list, and `schemaFor` for why the core table has to be reachable
 * at all.
 *
 * `eventSchemas` is OPTIONAL on `AnySportModule`, and a module without one
 * stamps nothing but its kernel events — the same fail-safe direction every
 * branch in this path takes: a pad that would have dispatched still dispatches.
 */
export function stampFor(
  module: AnySportModule,
  type: string,
  payload: unknown,
  clock: PadClock | null,
  nowMs: number,
): unknown {
  return stampPayload(payload, stampOf(clock, nowMs), schemaFor(module, type));
}

/**
 * The schema that owns `type` — the module's registry first, the KERNEL's
 * second.
 *
 * R6 review, gap 3. Consulting `module.eventSchemas` alone made the probe's
 * refusal arm dead code and left a real hole behind it: NO module registers a
 * `core.*` key (they are kernel-owned — `core/events.ts` validates them and
 * never forwards them to `module.apply`), so every kernel event a pad can send
 * fell through `stampPayload`'s `schema === undefined` arm and went out
 * unstamped however the clock read. `skins/period-shared.ts`'s `SWAP_TYPE` is
 * `core.lineup.substitution`, so a hockey line change — precisely the event a
 * window calculation reads `at` from — was the one thing a clocked pad could
 * never stamp.
 *
 * Both arms are now live and both are enumerated in `__tests__/clock.test.ts`
 * against the engine's own export: seven core types DECLARE `at`
 * (`core.suspend`, `core.resume`, and all five `core.lineup.*`) and seven are
 * `z.strictObject`s without it (`core.start`, `core.void`, `core.forfeit`,
 * `core.abandon`, `core.finalize`, `core.note`, `core.award`), which the probe
 * drops the stamp for rather than turning a dispatch that would have worked
 * into one that does not.
 *
 * `isCoreEventType` is the engine's own membership test rather than a bare
 * index, so an arbitrary type string cannot reach `Object.prototype` and hand
 * the probe something that merely looks callable. The module wins on a tie: a
 * sport that ever did register a `core.*` key of its own is answering about
 * its own payload.
 */
function schemaFor(module: AnySportModule, type: string): PayloadSchemaProbe | undefined {
  const own = module.eventSchemas?.[type];
  if (own !== undefined) return own;
  return isCoreEventType(type) ? CORE_EVENT_SCHEMAS[type] : undefined;
}

/**
 * R6/task A — the clock strip, extracted as a PURE presentational component
 * for the reason this file's own header gives: `PadHostV3` renders seven
 * independently-stateful nested primitives, which is exactly the shape the
 * node-only `_hook-harness` cannot walk. This one holds no state of its own,
 * so `__tests__/pad-host.test.ts` can render it and assert the real markup
 * instead of asserting a mirror of it.
 *
 * A DISPLAY PLUS TWO CONTROLS: start/stop it, and correct it. `aria-live="off"`
 * because a value that changes every second would otherwise be read out every
 * second.
 *
 * THE READOUT IS THE CONTROL (R6 fix pass 2, gap 7). The bar used to be
 * start/pause only, and always seated at 0, paused, per period — so a scorer who
 * reached the pad five minutes into a period stamped every `at` five minutes
 * low, and watched a penalty countdown that was wrong by the same amount, with
 * no way back. Starting late is the normal case, not the edge case.
 *
 * The correction is not a gear, a modal or a typed time. It is the time figure
 * itself: it sits in a shallow slate tray, which is what says "this is a field,
 * not a label", and pressing it reveals ONE subordinate row of two minute
 * nudges. At rest the bar is byte-identical to the one that already carries a
 * width sign-off, so the cost of the affordance is paid only by the scorer who
 * asks for it.
 *
 * AND IT IS NOT A SECOND SCORING SURFACE. Everything in the correction group is
 * monochrome — slate on slate, mono numerals, no accent — against a board whose
 * recording controls are large and coloured. Nothing here dispatches, and the
 * caption says so: a recorded time is a frozen fact and does not move.
 *
 * PURE, deliberately: `adjusting` is the HOST's state, not this component's, so
 * `__tests__/clock.test.ts` can render both halves of the disclosure and assert
 * the real markup rather than a mirror of it (apps/web vitest has no jsdom, so
 * a `useState` here would put the open state beyond every test in the tree).
 *
 * `fixtureId` — R6 fix pass 4, finding 6 (LOW). The disclosure's `id` used to
 * be the hardcoded literal `"v3-clock-adjust"`, document-unique by
 * construction; two clocked pads on one page (this repo's own harnesses
 * render side-by-side surfaces) produced duplicate ids and cross-wired the
 * `aria-controls` relationship — expanding one bar's disclosure could name
 * the WRONG one to assistive tech. `useId()` is unavailable in this repo's
 * node-only hook harness (`_hook-harness`), so the suffix comes from the one
 * value already guaranteed unique per pad: the fixture it is scoring.
 */
export function PadClockBar(props: {
  elapsed: number;
  running: boolean;
  adjusting: boolean;
  onToggle: () => void;
  onToggleAdjust: () => void;
  onAdjust: (deltaSeconds: number) => void;
  fixtureId: string;
  t: TFn;
}) {
  const adjustId = `v3-clock-adjust-${props.fixtureId}`;
  return (
    <div className="space-y-1.5">
      <div
        data-role="v3-clock"
        data-running={props.running ? "yes" : "no"}
        data-adjusting={props.adjusting ? "yes" : "no"}
        className="flex items-center justify-between gap-2 rounded-full border border-slate-200 bg-white px-4 py-2"
      >
        <span className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wider text-slate-500">
          {props.t("scorepad.clock.label")}
        </span>
        {/* The accessible name is the TIME, which is the information; what
         *  pressing does is carried by `aria-expanded` and the group it opens,
         *  and by the title. Naming the button "Correct the clock" instead would
         *  put the one number a scorer needs out of a screen reader's reach. */}
        <button
          type="button"
          data-role="v3-clock-value"
          aria-live="off"
          aria-expanded={props.adjusting}
          aria-controls={adjustId}
          title={props.t("scorepad.clock.adjust")}
          onClick={props.onToggleAdjust}
          style={{ minHeight: 44 }}
          className="shrink-0 rounded-lg bg-slate-50 px-2 text-right font-mono text-lg font-semibold tabular-nums text-slate-900 transition-colors hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400"
        >
          {formatClock(props.elapsed)}
        </button>
        <button
          type="button"
          data-role="v3-clock-toggle"
          onClick={props.onToggle}
          style={{ minHeight: 44, minWidth: 44 }}
          className="shrink-0 rounded-full px-3 text-sm font-semibold text-violet-700 transition-colors hover:bg-violet-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400"
        >
          {props.t(props.running ? "scorepad.clock.pause" : "scorepad.clock.start")}
        </button>
      </div>

      {props.adjusting && (
        <div id={adjustId} data-role="v3-clock-adjust" className="space-y-1">
          {/* Right-aligned, and content-sized: the row hangs off the readout it
             *  corrects rather than spanning the board like a tile. */}
          <div className="flex items-stretch justify-end gap-1.5">
            {/* Coarse OUTWARD, fine INWARD, and read left-to-right as a number
             *  line: −1 min, −10s, +10s, +1 min. The two a scorer reaches for
             *  most sit nearest the readout they correct. */}
            {[
              { role: "v3-clock-minus", delta: -CLOCK_NUDGE_SECONDS, label: "scorepad.clock.minute.off" },
              { role: "v3-clock-minus-fine", delta: -CLOCK_NUDGE_FINE_SECONDS, label: "scorepad.clock.second.off" },
              { role: "v3-clock-plus-fine", delta: CLOCK_NUDGE_FINE_SECONDS, label: "scorepad.clock.second.on" },
              { role: "v3-clock-plus", delta: CLOCK_NUDGE_SECONDS, label: "scorepad.clock.minute.on" },
            ].map((nudge) => (
              <button
                key={nudge.role}
                type="button"
                data-role={nudge.role}
                onClick={() => props.onAdjust(nudge.delta)}
                title={props.t(`${nudge.label}.hint`)}
                style={{ minHeight: 44 }}
                className="min-w-[44px] shrink-0 rounded-full border border-slate-200 bg-slate-50 px-3 font-mono text-[13px] font-semibold tabular-nums text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400"
              >
                {props.t(nudge.label)}
              </button>
            ))}
          </div>
          <p className="px-2 text-right text-[11px] leading-snug text-slate-500">{props.t("scorepad.clock.adjust.scope")}</p>
        </div>
      )}
    </div>
  );
}

export function resolveDockSpec(
  skin: SkinDefV3,
  held: { eventType: string; payload: unknown } | null,
  view: PadHostView,
): DockSpec | null {
  if (!held) return null;
  return skin.dock(held.eventType, view, held.payload as Record<string, unknown> | undefined);
}

/**
 * R7-42/F (owner ruling on P-5, `_INDEX.md`) — "a doubles rally opens the
 * dock; if nobody answers within HOLD_MS the hold drains and the rally
 * submits with `wonBy` only... label the stat as partial wherever it
 * surfaces". This is that label's own predicate: whether a SETTLED event's
 * payload still lacks an attribution answer its own dock would offer for
 * it — chassis-level and sport-agnostic, driven entirely by the payload and
 * the skin's own REQUIRED `dock()` method (types.ts), never a stored flag.
 *
 * Deliberately NOT "did the hold's natural timer fire". A dock chip TAP
 * never releases the hold early — `detail-dock.tsx`'s own header: "dismissing
 * early sends immediately... exactly the same outcome as letting the window
 * expire on its own" — so an ANSWERED rally drains through the identical
 * natural timer an UNANSWERED one does. That signal cannot tell the two
 * apart; only the payload's own content can, which is why this calls
 * `skin.dock()` again with the FINAL payload rather than reading anything
 * recorded at hold time.
 *
 * `kind: "flag"` chips (types.ts, `DockChip.kind`) are excluded on purpose.
 * Football's own `ownGoal`/`penalty` are documented as skippable MODIFIERS
 * ("the dock closes on its own and the goal is already recorded") — an
 * ordinary goal that is neither is not "less than the scorer did", it is
 * the scorer correctly reporting an ordinary goal. Every dock chip shipped
 * to date sets its own field unconditionally (never a toggle), so
 * re-applying one to the settled payload and finding NO CHANGE is exactly
 * "this chip's own answer is already in the payload" — no chip needs to
 * declare an "already selected" flag of its own for this to work.
 */
/**
 * R7/task D — does the chassis render its `data-role="v3-headline"` bar?
 *
 * Extracted rather than inlined at the JSX so it can be driven directly: the
 * host is not renderable in this workspace's test environment (node, no DOM),
 * and the whole point of this wave is that a declaration nobody can exercise
 * is a declaration nobody has checked.
 *
 * Two independent reasons NOT to render, and they must stay independent: the
 * engine published no usable headline at all (`summaryHeadline` degrades to
 * null rather than inventing copy), or the skin declares it already says all
 * of this itself. Omitting `ownsHeadline` means RENDER — see the method's own
 * doc for why the safe direction is a redundant bar rather than a lost result.
 */
export function shouldRenderHeadline(
  headline: string | null,
  skin: Pick<SkinDefV3, "ownsHeadline">,
  view: PadHostView,
): boolean {
  if (headline === null) return false;
  return !(skin.ownsHeadline?.(view) ?? false);
}

export function isPartialDockAnswer(
  skin: SkinDefV3,
  eventType: string,
  payload: Record<string, unknown>,
  view: PadHostView,
): boolean {
  const spec = skin.dock(eventType, view, payload);
  if (spec === null) return false;
  const attribution = spec.chips.filter((chip) => chip.kind !== "flag");
  if (attribution.length === 0) return false;
  return attribution.every((chip) => !deepEqual(chip.mutate(payload), payload));
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
  /**
   * R7-46 — a sink the host publishes its `isPartial` predicate to, for
   * chrome that mounts the ledger ITSELF (`showActivity: false`).
   *
   * WHY THIS EXISTS. `isPartialDockAnswer` needs the skin AND a live
   * `PadHostView` — cfg, state, summary, phase, band, entitlements, squads,
   * events, context overrides and the host clock's live reading. The organiser
   * console has none of that: it passes `hideActivity` and renders its own
   * `<ActivityPanel>` one level out, which meant the partial badge was wired
   * on the device pad and INERT on the console — the one screen whose whole
   * job is telling an organiser what the courtside scorer left incomplete.
   *
   * WHY A HANDOFF RATHER THAN A SECOND CONSTRUCTION SITE. The console could
   * assemble a `PadHostView` of its own from `live.state` + cfg + lineups.
   * It must not: `fixture-console.tsx`'s R7-28 comment records what happened
   * the last time this exact bag was built twice — `plural` was added to one
   * site only, and the same rally read "1 pt" in the pad's ribbon and "1 pts"
   * in the console's ledger, on one screen. One construction site, published
   * upward.
   *
   * KNOWN GAP, recorded rather than hidden: the pad unmounts when a fixture is
   * decided, and never mounts at all on a fresh load of an already-decided
   * fixture — so the box is empty there and the console's rows carry no
   * partial badge. Rows already on screen keep theirs (the box is not cleared
   * on unmount, deliberately). Closing that needs the predicate to survive
   * without a pad, which is a bigger change than this one.
   */
  onPartialResolver?: (resolve: (eventType: string, payload: Record<string, unknown>) => boolean) => void;
  /**
   * R7/C1 (D-4, ruling R7-1) — whether THIS host also mounts the activity
   * ledger. Default true, which is the device link and every other surface
   * with no chrome of its own: `/score/[token]` has no page around the pad,
   * so the panel here is the only history a courtside scorer ever sees.
   *
   * The organiser console passes false and mounts the SAME component itself,
   * one level out — with void authority, provenance and the audit strip, and
   * outliving the pad, which unmounts the moment a fixture is decided. Two
   * mounts of one component, never two panels on one screen.
   */
  showActivity?: boolean;
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
  // Plural selection needs a count AND the locale, neither of which `t` or a
  // skin factory carries — see `ActivityDetailContext.plural`'s own doc.
  // Resolved HERE, from the same provider `useMsg` reads, so a skin never
  // reaches for a locale itself.
  const pluralMsg = useMsgPlural();

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

  // R6/task A — the pad-local clock (owner ruling R6-4). `clock` is the whole
  // of this host's clock state; the ticking value is DERIVED from it and
  // `nowMs`, never stored, so nothing here can persist a running time.
  //
  // `nowMs` is what the interval below moves. It exists as its own state
  // because a re-render is the only way a `Date.now()`-derived display can
  // advance, and because the SEND path deliberately does NOT read it: `send`
  // takes a fresh `Date.now()` at tap time, so a stamp is never up to a
  // tick-interval stale.
  //
  // SEEDED 0, NOT `Date.now()` (R6 review, gap 7). Seven of the nine v3 skins
  // declare no `clock()` at all, and a lazy initialiser still runs on every one
  // of their mounts to produce a value nothing will ever read. Zero is not a
  // placeholder here, it is unreachable: `elapsedOf` ignores `nowMs` entirely
  // while a clock is PAUSED, `reseatClock` only ever returns a paused clock or
  // the one already held, and the sole transition into running is
  // `toggleClockNow` below — which sets a real `Date.now()` in the same update
  // that starts it. Both facts are pinned in `__tests__/clock.test.ts`.
  const [clock, setClock] = useState<PadClock | null>(null);
  const [nowMs, setNowMs] = useState(0);
  // R6 fix pass 2 (gap 7) — whether the clock's correction row is showing. Held
  // HERE rather than inside `PadClockBar` so that component stays pure and both
  // halves of the disclosure are renderable by a node test (see its own doc).
  const [adjusting, setAdjusting] = useState(false);

  // R6 fix pass 2 (gap 2) — the live reading handed to the skins, so a skin can
  // render a number that moves between events. `stampOf` is THE derivation the
  // `send` gateway below stamps with, called here as well rather than
  // re-derived, so what a scorer watches count down and what an event records
  // cannot disagree. `known` gates it, so a pad nobody has started drives no
  // countdown from its placeholder zero.
  //
  // Split into its two primitives before the memo on purpose: `stampOf` builds
  // a fresh object every render and `nowMs` moves twice a second, so keying the
  // memo on the object would rebuild every tile, sheet, dock and swap slot in
  // the pad at 2 Hz. `elapsedOf` returns WHOLE seconds, so keyed on the values
  // the view's identity changes once a second while the clock runs and not at
  // all while it is paused.
  const liveStamp = stampOf(clock, nowMs);
  const livePeriod = liveStamp?.period;
  const liveElapsed = liveStamp?.elapsed;
  const clockAt = useMemo(
    () => (livePeriod === undefined || liveElapsed === undefined ? undefined : { period: livePeriod, elapsed: liveElapsed }),
    [livePeriod, liveElapsed],
  );

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
      // The host clock's live reading — see PadHostView.clockAt (types.ts) for
      // why the period travels with the number and why this is display-only.
      clockAt,
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
    [props.cfg, pipeline.state, pipeline.summary, phase, props.band, entitlements, personNames, squads, pipeline.events, contextOverrides, clockAt],
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

  // The clock the skin declares RIGHT NOW, reconciled with the one this host
  // is holding. Render-phase adjustment, the same React-sanctioned recipe the
  // `contextOverrides` reset above uses and for the same reason (this repo's
  // react-hooks/refs rule forbids touching a ref during render).
  //
  // `reseatClock` is where the load-bearing guard lives: it re-seeds ONLY when
  // the declared period changes, and otherwise returns the held clock by
  // reference. Following the spec's `seed` instead would drag a running clock
  // back to the last stamped event's time on every tap, since `seed` is
  // rebuilt from a fold that advances on every tap. See ../clock.ts.
  const clockSpec = props.skin.clock?.(view) ?? null;
  const nextClock = reseatClock(clock, clockSpec);
  if (nextClock !== clock) {
    setClock(nextClock);
    // A whistle re-seats the clock, and a correction row left open across it
    // would be offering to nudge a period the scorer has already left. Closing
    // here rather than in an effect keeps it in the same render as the re-seat.
    if (adjusting) setAdjusting(false);
  }

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
  // R7-39/R7-39a — the More tile is a guaranteed dead end once
  // `moreActionsList` is empty (this function's own doc, above); suppressed
  // here, the one render-time consumer of `tiles`, rather than upstream —
  // `dedicated`/`availablePhases`/`phasesWithTiles` above must keep seeing
  // the UNSUPPRESSED band-filtered set, since the More tile itself is never
  // band-filtered (`filterTilesByBand`'s own "NEVER hides the MORE tile"
  // case) and contributes nothing to `dedicatedEventTypes` either way
  // (`tileEventType` returns null for it).
  const visibleTiles = useMemo(() => suppressEmptyMoreTile(tiles, moreActionsList), [tiles, moreActionsList]);

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

  /**
   * THE send. Every dispatch site in this host goes through it.
   *
   * R5 blocker, found in a browser and not by any unit test: each of these six
   * call sites used to be a bare `void dispatch(...)`. `dispatch` is
   * `createSkinDispatch`'s async guard, so `void` DISCARDS a rejected promise —
   * and the one rejection it can raise (a type the spec does not declare) then
   * produced no event, no banner, no console line, and no clue. The volleyball
   * libero swap hit exactly that: the sheet closed on a completed off/on pick
   * and NOTHING was written. The type gate is fixed at its own end
   * (`skins/types.ts`'s `KERNEL_DISPATCHABLE`), but a swallow that turns any
   * future dispatch fault into a silent no-op is the deeper defect, so it is
   * closed here rather than only at the one type that tripped it.
   *
   * Human copy only, `scorepad.rejection.fallback` — the same string the 422
   * path already shows, already in all four dictionaries. The raw reason names
   * internal event types and is useless to a scorer, so it goes to the console
   * exactly as `org-payment-instructions.tsx` does with Stripe's own errors.
   * Cleared on the next send, so one bad tap does not leave a stuck banner.
   */
  const [dispatchRefusal, setDispatchRefusal] = useState<string | null>(null);
  const send = useCallback(
    (type: string, payload: unknown): void => {
      setDispatchRefusal(null);
      // R6/task A — THE one place `at` enters an event, for exactly the reason
      // this file's header gives for `dispatch` being the one gateway: a
      // second stamping site is a second answer to "what time is it". A pad
      // with no clock (`clock === null`, every skin that declares none) gets
      // the caller's own payload back by reference, unchanged.
      //
      // `Date.now()` here rather than the render-throttled `nowMs`: the stamp
      // must be the time of the TAP, not of the last tick.
      const stamped = stampFor(props.module, type, payload, clock, Date.now());
      void dispatch(type, stamped).catch((err: unknown) => {
        console.error("scorepad v3: dispatch failed", type, err);
        setDispatchRefusal(msg("scorepad.rejection.fallback"));
      });
    },
    [dispatch, msg, clock, props.module],
  );

  // ONE interval, and only while the clock is actually running: a paused clock
  // cannot change, so re-rendering the whole pad once a second to redraw the
  // same digits would be pure waste. 500ms rather than 1000ms so the displayed
  // second is never a full second behind the second that would be STAMPED —
  // the two must not visibly disagree at the moment a scorer taps.
  //
  // No synchronous `setNowMs` in the effect body: the only transition into a
  // running clock is `toggleClockNow` below, which sets it at the tap, and
  // `reseatClock` never returns a running clock. Setting it here as well would
  // trip react-hooks/set-state-in-effect for a value that is already current.
  //
  // WHAT IS STILL UNPROVEN HERE, stated once for both this effect and
  // `toggleClockNow`. Neither is inert any more — R6/task C landed
  // `skins/hockey.tsx` and `skins/icehockey.tsx`, both of which declare
  // `clock()`, so `PadClockBar` mounts and both `setNowMs` sites run in the
  // product. What no test in this repo can execute is the React shell around
  // them: apps/web vitest is `environment: "node"` with no jsdom, so an
  // interval that stopped firing, or an `onToggle` that stopped being wired,
  // would leave every clock test green. THE BROWSER e2e IS R6/TASK E'S, and it
  // is the only thing that will ever see this effect run.
  useEffect(() => {
    if (!clock || clock.runningSince === null) return;
    const id = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(id);
  }, [clock]);

  const toggleClockNow = useCallback(() => {
    setClock((prev) => (prev === null ? prev : toggleClock(prev, Date.now())));
    setNowMs(Date.now());
  }, []);

  // R6 fix pass 2, gap 7. `adjustClock` touches `base` only — host state — so
  // nothing already stamped moves and nothing is dispatched. `setNowMs` so a
  // RUNNING clock repaints at the tap instead of up to half a second later.
  //
  // R6 fix pass 4, findings 1+2 — `floor` is the high-water mark a correction
  // must not cross: `clockSpec` (just above) is the SKIN's declaration
  // rebuilt fresh THIS render from the live fold, and its `seed` — when
  // present — IS `state.asOf.elapsed` for the CURRENT period (`buildClock`'s
  // own doc, skins/period-shared.ts). Reading it here rather than `clock`'s
  // own `.base` is deliberate: `clock` is the host's held value, seeded once
  // per period and then left alone by design (property 3), so it can go
  // stale the instant another device — or this one's own last dispatch —
  // moves `state.asOf` forward; `clockSpec` cannot, because it is rebuilt on
  // every render from the SAME `view` the rest of this render pass uses.
  // `clockSpec` in the dependency list keeps this callback's closure as
  // fresh as that value, unlike `toggleClockNow` above, which needs no cfg
  // read at all.
  const adjustClockNow = useCallback(
    (deltaSeconds: number) => {
      const floor =
        clockSpec !== null && clockSpec.seed !== undefined
          ? { period: clockSpec.period, elapsed: clockSpec.seed }
          : undefined;
      setClock((prev) => (prev === null ? prev : adjustClock(prev, deltaSeconds, Date.now(), floor)));
      setNowMs(Date.now());
    },
    [clockSpec],
  );

  const handleTileAction = useCallback(
    (action: TileSpec["action"]) => {
      if ("swap" in action) {
        // R3 (defect 2): the tile names WHICH slot. `resolveSwapSlot` at
        // render time decides whether anything opens — an id no slot declares
        // is a no-op, never a fallback to the first slot.
        setOpenSwapId(action.swap);
        return;
      }
      if ("event" in action) send(action.event.type, action.event.payload);
    },
    [send],
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
  // See queueStatusText's own doc above — the durable queue's status, ported
  // from the legacy renderer and never rendered on v3 until now.
  const queueLabel = queueStatusText(pipeline, msg);
  const queueAttention = queueStatusAttention(pipeline);
  // No memo, matching the legacy reader's own reasoning: a cheap read, and
  // `pipeline.summary` already changes identity on every fold advance.
  const headline = summaryHeadline(pipeline.summary);

  const events = pipeline.events;

  // The activity panel reads four fields; `voids` is what makes a row show
  // as cancelled (activity.tsx derives it by looking for some OTHER event
  // pointing back at this id, never a flag on the target itself).
  //
  // Declared ABOVE the ribbon (R3/F, F1): the ribbon needs the same rows the
  // panel does, because it now resolves the same per-event detail for the
  // newest of them.
  const activityEvents = useMemo<ActivityEvent[]>(
    () =>
      events.map((e) => ({
        id: e.id,
        seq: e.seq,
        type: e.type,
        payload: e.payload,
        voids: e.voids ?? null,
        // R7/C1 — the panel gained a provenance line. `recordedAt` is the
        // half this surface can answer; `recordedByLabel` is not, because
        // `recordedBy` is a USER id and `score_events.device_link_id` never
        // reaches an `EventEnvelope` at all — the console resolves that one
        // at its own mount.
        recordedAt: e.recordedAt,
      })),
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
            props.skin.activityDetail!({
              t,
              plural: pluralMsg,
              eventType,
              payload,
              history,
              cfg: view.cfg,
              // R3.5/Task E — `view.state` CAPTURED verbatim, same posture as
              // `view.cfg` one line up (types.ts's `ActivityDetailContext.state`
              // doc). Football's shoot-out kick is the first `activityDetail`
              // case that needs a state-level fact (entrant->side) no payload
              // field or cfg value can answer.
              state: view.state,
              personNames,
            })
        : undefined,
    [props.skin, t, pluralMsg, view.cfg, view.state, personNames],
  );

  // R7-42/F — the SAME shape `resolveDetail` above takes, for the SAME
  // reason: `ActivityPanel` is chassis-level and has no dock vocabulary of
  // its own, so this is the one place `isPartialDockAnswer` gets called,
  // built once and handed to the panel below. `view` is captured verbatim
  // (its own identity already keys every other per-render memo here), so
  // this recomputes exactly when the dock's own inputs could have changed.
  const isPartial = useCallback(
    (eventType: string, payload: Record<string, unknown>) => isPartialDockAnswer(props.skin, eventType, payload, view),
    [props.skin, view],
  );

  // R7-46 — publish it for chrome that renders the ledger itself. Deliberately
  // NOT cleared on unmount: a decided fixture unmounts the pad while its rows
  // stay on the console's screen, and a badge that vanished at the whistle
  // would be worse than one that persists. See `partialResolverRef`'s own note.
  const publishPartial = props.onPartialResolver;
  useEffect(() => {
    publishPartial?.(isPartial);
  }, [publishPartial, isPartial]);

  const ribbon = buildTopRibbon(activityEvents, (id) => personNames[id] ?? id, t, resolveDetail);
  // R7/C4 — see `ribbonUndoTarget`. Resolved next to the ribbon it belongs to
  // rather than inside the JSX so the rule is one named, testable function
  // instead of a condition buried in a `!`-asserted call site.
  const undoTarget = ribbonUndoTarget(
    activityEvents,
    held?.id ?? null,
    // The SAME two the `<ActivityPanel>` below is handed — pass anything
    // else and the ribbon and the ledger start answering differently
    // about the same row, which is the defect this rule was unified for.
    pipeline.ownEventIds,
    props.identity.deviceLinkId,
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
      {/* The durable queue's own status — offline/resyncing/pending(count)/
       *  synced, ported verbatim from the legacy renderer's header pill
       *  (pad-renderer.tsx: `queueLabel`/`queueAttention`), which v3 dropped
       *  along with the rest of that component. Right-aligned rather than
       *  sharing a row with phase tabs, since v3's chassis has no such row
       *  here — every skin gets it for free from the host, same as the
       *  rejection banner below. `-700`, not `-600` (axe caught it): this
       *  surface's own established fix for small bold text on white,
       *  timeline.tsx's `text-amber-600` (~3.19:1, WCAG AA fail) vs
       *  `text-amber-700` (~5.05:1, pass).
       *
       *  Review finding: the legacy pill lived in a wide DESKTOP header row
       *  beside phase tabs; `scorepad.queue.offline` is a full sentence
       *  (66 chars), and `shrink-0` on a `justify-end` flex child forces it
       *  to its natural single-line width, which overflows a phone-width
       *  pad LEFTWARD off screen, taking the status dot with it —
       *  `expectNoHorizontalScroll` only ever measures rightward overflow
       *  (`html.scrollWidth`), so the seven-width matrix never caught it.
       *  `min-w-0` on the label (same fix this chassis already uses for
       *  scorebug names, lineup rows, everywhere else text meets a flex
       *  item) lets it wrap onto a second line instead of refusing to
       *  shrink; the dot keeps its own `shrink-0` so it's never the thing
       *  that gets squeezed away. `resyncing`/`pending`/`synced` are all
       *  short and were never at risk — this only ever bit `offline`. */}
      <div className="flex justify-end">
        <span
          data-role="v3-queue-status"
          className={`flex min-w-0 max-w-full items-center gap-1.5 text-right text-[11px] font-semibold uppercase tracking-widest ${
            queueAttention ? "text-amber-700" : "text-emerald-700"
          }`}
        >
          <span
            aria-hidden
            className={`mt-0.5 h-1.5 w-1.5 shrink-0 self-start rounded-full ${queueAttention ? "animate-live-pulse bg-amber-500" : "bg-emerald-500"}`}
          />
          <span className="min-w-0">{queueLabel}</span>
        </span>
      </div>

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
      {/* R7/task D — suppressed for a skin that declares it already says all
       *  of this itself (`SkinDefV3.ownsHeadline`). NOT a per-sport list in
       *  the chassis: R6's ruling is that the skin declares, so nothing here
       *  has to be kept in sync with eleven skins. `?? false` — omitting the
       *  method means KEEP, so a skin that has never considered the question
       *  shows one redundant bar rather than silently losing the only
       *  statement of its result. */}
      {shouldRenderHeadline(headline, props.skin, view) && headline && (
        <p data-role="v3-headline" className="rounded-xl bg-slate-900 px-4 py-2 text-center text-sm font-semibold text-white">
          {headline}
        </p>
      )}

      <div data-role="v3-scorebug">
        <Scorebug
          spec={scorebugSpec}
          t={t}
          onTap={(event: TapEvent) => send(event.type, event.payload)}
          onOpenSheet={handleOpenSheet}
        />
      </div>

      {/* The server's own 422-class refusal (`pipeline.lastRejection`) and a
       *  CLIENT-side dispatch fault (`dispatchRefusal`, see `send` above) share
       *  one surface deliberately: to a scorer they are the same event — the tap
       *  did not stick — and a second banner would only ask them to tell two
       *  kinds of failure apart. Server first when both are set, because it
       *  carries a real reason code while the client one is always the generic
       *  fallback. */}
      {(rejectionMsg ?? dispatchRefusal) && (
        <p
          data-role="v3-rejection"
          // R6 fix pass 3, gap 1: this banner appears AFTER a tap, and it is
          // now the only evidence the tap happened at all — the optimistic
          // ribbon/row/chip/countdown are rolled back with it. A bare <p>
          // that materialises mid-match is announced to nobody; `alert` is a
          // live region, changes no pixel, and is the difference between
          // "rendered" and "noticed" for a scorer whose eyes are on the ice.
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {rejectionMsg ?? dispatchRefusal}
        </p>
      )}

      {/* R6/task A — the clock, between the scorebug and the ribbon: it belongs
       *  with the score (it is a readout of the match, not of the event log),
       *  and it must not sit above the scorebug, which is the one thing a
       *  scorer looks at without reading. Rendered only for a skin that
       *  declares `clock()`, so every pad written before this wave is
       *  unchanged down to the DOM. */}
      {clock && (
        <PadClockBar
          elapsed={elapsedOf(clock, nowMs)}
          running={clock.runningSince !== null}
          adjusting={adjusting}
          onToggle={toggleClockNow}
          onToggleAdjust={() => setAdjusting((open) => !open)}
          onAdjust={adjustClockNow}
          fixtureId={props.fixtureId}
          t={t}
        />
      )}

      {ribbon && (
        <div
          data-role="v3-ribbon"
          className="flex items-center justify-between gap-2 rounded-full border border-slate-200 bg-white px-4 py-2"
        >
          <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{ribbon.text}</span>
          {/* Withdrawn, not disabled, when nothing on the strip can be taken
              back (R7/C4) — a disabled control still reads as "there is an
              action here", and after a void there is not. The strip's TEXT
              stays either way: losing the last-event line would be a
              different regression. */}
          {undoTarget !== null && (
            <button
              type="button"
              data-role="v3-ribbon-undo"
              onClick={() => void handleUndo(undoTarget)}
              style={{ minHeight: 44, minWidth: 44 }}
              className="shrink-0 rounded-full px-3 text-sm font-semibold text-violet-700 transition-colors hover:bg-violet-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400"
            >
              {msg("pad.ribbon.takeBack")}
            </button>
          )}
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
              if (event) send(event.type, event.payload);
            }}
          />
        </div>
      )}

      <div data-role="v3-tiles">
        <TileGrid tiles={visibleTiles} phase={phase} t={t} onAction={handleTileAction} onOpenSheet={handleOpenSheet} />
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
              send(event.type, event.payload);
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
                send(event.type, event.payload);
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
                  onSubmit={(type, payload) => send(type, payload)}
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
      {(props.showActivity ?? true) && (
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
          // R7-42/F — "label the stat as partial wherever it surfaces"
          // (ruling on P-5). Wired here, not just built above: an
          // unwired helper is exactly the D2 defect this same comment
          // already warns about, one line up.
          isPartial={isPartial}
        />
      </div>
      )}
    </div>
  );
}
