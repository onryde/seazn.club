// SkinDef v3 contract types — the shared chassis waves R2-R8 build every
// per-sport skin on. Types only, no React import: apps/web vitest runs
// environment:"node" with no jsdom, so every primitive here must be pure
// data a node test can assert directly (see task-1-brief.md decisions).
//
// R2/task B (this file's first real edit since R1): deliberately imports
// NOTHING from a sibling v3 file (context-strip.tsx/swap-sheet.tsx already
// import FROM this file — guided-sheet.tsx too), so this stays the one file
// in the directory with zero risk of a circular type import. The engine
// imports below are `import type` only (zero runtime footprint, erased at
// compile time) — safe under apps/web's node-only vitest env for the exact
// reason recording-chip.tsx/context-strip.tsx already import engine types
// here the same way.
import type { EventEnvelope, SquadState } from "@seazn/engine/core";
import type { FidelityBand } from "@seazn/engine/sport";

export type TapModel = "S" | "T";
export type PadPhase = "pre" | "live" | "post";

export interface StripItem { label?: string; value: string; accent?: boolean }
// Fix round 2 (Task 5 review, Important — controller ruling): servingLabel
// is a deliberate, additive contract change. The chassis (v3/scorebug.tsx)
// must never resolve a sport-namespaced i18n key itself — reusing
// scorepad.skin.tennis.header.serving there put one sport's key inside a
// primitive every sport's ScorebugSpec renders through (racquet sports keep
// their OWN separate scorepad.skin.racquet.header.serving key precisely
// because one sport's key must not serve another; cricket/football have no
// serving concept at all). servingLabel is PRE-LOCALISED by the skin that
// builds the WhoLine, exactly like ScorebugHalf.big/ScorebugSpec.context
// are already pre-formatted strings — the chassis only renders it verbatim.
// Optional and additive: a WhoLine with serving:true and no servingLabel
// stays valid (see scorebug.tsx's whoNames for the explicit, non-fabricating
// fallback behaviour).
export interface WhoLine { name: string; serving?: boolean; servingLabel?: string }
export interface TapEvent { type: string; payload: Record<string, unknown> }

export interface ScorebugHalf {
  who: WhoLine[];
  big: string;                    // pre-formatted, tabular-nums rendering
  hint?: string;                  // i18n key; REQUIRED iff tappable
  tappable?: boolean;             // MODEL-S halves only
  tapEvent?: TapEvent;            // REQUIRED iff tappable
}
export interface ScorebugSpec {
  context: string;                // "T20 · Over 0.5 · RR 14.4" (already localised)
  phase: PadPhase;
  halves: [ScorebugHalf, ScorebugHalf];
  strip: StripItem[];
}

export type TileKind = "primary" | "standard" | "destructive" | "minor";
export interface TileSpec {
  id: string;
  label: string;                  // i18n key
  sublabel?: string;              // i18n key
  kind: TileKind;
  span?: 1 | 2 | 3 | 4;
  phases: PadPhase[];
  action: { event: TapEvent } | { sheet: string } | { swap: true };
}

export interface DockChip {
  id: string;
  label: string;                  // i18n key
  mutate: (payload: Record<string, unknown>) => Record<string, unknown>;
}
export interface DockSpec { title: string; chips: DockChip[] }

export interface ContextSlot {
  id: string;                     // "striker" | "bowler" | …
  label: string;                  // i18n key
  personId?: string;
  pool: "onfield" | "bench" | "all";
  required: boolean;
}
export interface ContextStripSpec { slots: ContextSlot[] }

/**
 * R2/task C (G2 — controller ruling 2026-08-16, binding, `docs/superpowers/
 * plans/2026-08-16-scorepad-v3-r2-cricket.md`): `when(answers)` gates
 * whether a step is shown at all, evaluated against every answer
 * accumulated SO FAR (never a later one — the step hasn't been reached yet
 * when its own `when` is checked). Absent means "always shown" — every
 * step R1 shipped before this wave keeps working with zero change, since
 * `undefined` and `() => true` are equivalent to `stepVisible()`
 * (guided-sheet.tsx). This is what lets cricket's wicket sheet ask "who's
 * out" ONLY for a run-out and "fielder" ONLY for the three kinds where
 * naming one is meaningful, instead of fanning the wicket tile out into
 * ten destructive tiles (spec §2.5's hierarchy cap) or asking a wasted tap
 * on every other dismissal (the D-15 defect restated). Convention this
 * type does not itself enforce: a `GuidedSheetSpec`'s FIRST step should
 * never declare `when` — nothing precedes it to gate on, and
 * `initialSheetState()` (guided-sheet.tsx) always starts at index 0 with
 * no answers yet, unconditionally.
 */
export type StepPredicate = (answers: Readonly<Record<string, string>>) => boolean;

export interface SheetChoiceStep { id: string; kind: "choice"; title: string; options: { id: string; label: string }[]; when?: StepPredicate }
/**
 * R2/task A5 (`_INDEX.md` R1 "owed by later waves", closed here): `side` is
 * REQUIRED, not optional-with-a-default. Cricket's wicket flow needs the
 * BATTING side for "who out" and the FIELDING side for "fielder" in ONE
 * sheet — a defaulted side would silently resolve the wrong squad for
 * whichever step didn't specify one, with nothing failing (the wrong
 * person's name would just be tappable where the right one should be). The
 * chassis (guided-sheet.tsx) stays sport-agnostic: it never decides which
 * of `lineups.home`/`lineups.away` is "batting" right now — the SKIN knows
 * that from its own folded state and emits a concrete `"home" | "away"` per
 * step; the host resolves each side's own `PoolView` once (pad-host.tsx)
 * and guided-sheet.tsx picks between the two per-step.
 */
export interface SheetPersonStep { id: string; kind: "person"; title: string; pool: "onfield" | "bench" | "all"; side: "home" | "away"; when?: StepPredicate }
export type GuidedSheetStep = SheetChoiceStep | SheetPersonStep;
export interface GuidedSheetSpec { event: string; steps: GuidedSheetStep[]; buildPayload: (answers: Record<string, string>) => Record<string, unknown> }

/**
 * R2/task B — the reserved `{sheet}` key that means "open the chassis's
 * generic `padSpec(cfg)` action-form sheet" (./action-form.tsx), never a
 * skin's own `SkinDefV3.sheets` entry. A sentinel string rather than a new
 * `TileSpec.action` variant so `tile-grid.tsx` (owned by a concurrent R1
 * task, not touched this wave) needs no change at all — it already routes
 * every `{sheet: string}` tile to `onOpenSheet` verbatim; `pad-host.tsx` is
 * the one place that tells this key apart from a real `skin.sheets[key]`
 * lookup. A skin's OWN `sheets` map must never declare a key equal to this
 * (pad-host.tsx checks the sentinel FIRST, so a colliding skin key would
 * simply be unreachable, not a crash — still worth a skin author avoiding).
 */
export const MORE_SHEET_KEY = "__pad-host/more__";

/**
 * R2/task B — one skin's declared in-play substitution flow (design §2.7).
 * Deliberately built from PRIMITIVES only (a string side tag, an i18n key,
 * a plain boolean + plain string, a pure event builder) rather than
 * referencing swap-sheet.tsx's own `SwapSheetSpec`/`PoolView`/
 * `PolicyVerdict` types directly: those live in a file that itself imports
 * FROM this one (via context-strip.tsx's `PoolView`), so importing them
 * back here would open this file's first circular type reference. The host
 * (pad-host.tsx, which already imports every concrete v3 primitive type to
 * RENDER them) adapts this into swap-sheet.tsx's real shapes at the one
 * call site that needs them — including re-wrapping `policyMessage` through
 * `refusalMessage()` there. Consequence, stated so nobody re-derives it: the
 * compile-time brand swap-sheet.tsx's `PolicyVerdict.message` uses to reject
 * a raw `LineupRejectionReason` slug at its OWN call site does not reach
 * THIS contract boundary — a skin implementing `swap()` must pass
 * `reduceLineupEvent`'s refusal `.message` (sport-worded prose), never its
 * `.reason` (machine slug), the same rule swap-sheet.tsx's own header
 * states, just enforced one call site further downstream (pad-host.tsx's
 * own render, not tsc at the skin's call site). Flagged here deliberately,
 * not silently accepted as equivalent.
 */
export interface SwapSlot {
  /** i18n key — swap-sheet.tsx's `SwapSheetSpec.offLabel`. */
  offLabel: string;
  /** i18n key — swap-sheet.tsx's `SwapSheetSpec.onLabel`. */
  onLabel: string;
  /** Which side's squad the off/on pickers both draw from — a substitution
   *  is always within ONE team, unlike a guided sheet's person steps. */
  side: "home" | "away";
  /** The module's own `lineupPolicy(cfg)` verdict for whether a
   *  substitution is currently legal for this side at all (design §2.7) —
   *  `reduceLineupEvent`'s `{ok}`, computed by the skin from its own folded
   *  state. */
  policyOk: boolean;
  /** Sport-worded refusal PROSE — `reduceLineupEvent`'s `.message`, NEVER
   *  its `.reason` machine slug (see this interface's own header). Present
   *  only when `policyOk` is false. */
  policyMessage?: string;
  /** Builds the concrete event once both picks are made — `football.sub`
   *  where the module declares one, `core.lineup.substitution` otherwise
   *  (design §2.7). Runs through the SAME dispatch guard as every other v3
   *  event (`createSkinDispatch` — item 5), so an invented type still fails
   *  at the call site. */
  buildEvent(off: string, on: string): TapEvent;
}

export interface SkinDefV3<View = unknown> {
  key: string;
  tapModel: TapModel;
  /**
   * R2/task C (G3 — controller ruling 2026-08-16, binding, same plan doc as
   * G2 above): derives the pad's phase from the MATCH, not a user-clicked
   * tab. Task B shipped `pad-host.tsx` with a self-correcting local `phase`
   * state (snaps to the first phase with a declared tile, mirroring
   * `pad-renderer.tsx`'s legacy panel-tab correction) because no skin
   * existed yet to prove a real alternative against — a real, working
   * default, never a placeholder, and it is EXACTLY what the host keeps
   * using when a skin omits this method. When present, the host trusts
   * this method's answer verbatim (never re-validated against which
   * phases currently have tiles): the whole point of G3 is that an action
   * is unavailable because the MATCH is not there yet/any more, not
   * because a tab is unselected — deferring to `resolveNextPhase` here
   * would silently reintroduce the tab-shaped bug this method exists to
   * remove. `PadPhase` stays the three-value UI concept on purpose — do
   * NOT widen it to a sport's own richer engine phase, and do not give a
   * mid-match sub-phase (cricket's `super_over`) its own slot; a skin
   * whose engine has more phases than three MAPS them down in its own
   * `phase()` body (cricket: `pre→"pre"`, `live`/`super_over→"live"`,
   * `done`/`final→"post"`). Omit this method entirely for a skin not yet
   * migrated onto it — R3–R7 opt in one sport at a time, exactly like
   * `context`/`swap` below already do for their own concerns.
   */
  phase?(view: View): PadPhase;
  scorebug(view: View): ScorebugSpec;
  tiles(view: View): TileSpec[];
  dock(eventType: string, view: View): DockSpec | null;
  context?(view: View): ContextStripSpec | null;
  /** Turns a context-strip selection (a slot id + the tapped candidate's
   *  person id) into a concrete event — e.g. a sport that records "who is
   *  currently bowling" as its own explicit event rather than inferring it
   *  from the next ball tap. `null` means this particular selection is not
   *  itself an event this skin dispatches (the chassis does not fabricate
   *  one, and does not otherwise persist the selection — a skin whose
   *  slots need to be remembered some other way is out of this contract's
   *  scope, same "chassis provides the mechanism, first real skin decides
   *  the policy" posture every other optional method here already takes).
   *  Omit the method entirely for a skin with no `context()` at all. */
  contextSelect?(slotId: string, personId: string, view: View): TapEvent | null;
  sheets?: Record<string, GuidedSheetSpec>;
  /** Declares this skin's swap-sheet integration (design §2.7) — `null`
   *  when a swap is not applicable right now (e.g. no sub currently legal
   *  to OFFER, as opposed to legal-but-refused, which is `policyOk: false`
   *  instead) or the sport has no in-play substitutions at all (boardgame,
   *  carrom singles, generic — design §3's own table). Omit the method
   *  entirely for those sports rather than returning `null` from every
   *  call — same "absent means never applicable" convention `context`
   *  already uses one line up. */
  swap?(view: View): SwapSlot | null;
}

/**
 * R2/task B — the single data bag `pad-host.tsx` builds ONCE per render and
 * hands, verbatim, to EVERY `SkinDefV3` method call (`scorebug(view)`,
 * `tiles(view)`, `dock(type, view)`, `context?.(view)`, `swap?.(view)`) —
 * the concrete answer to R1's ruling that v3 skin methods take `(view)`
 * only, never `(view, ctx)` (`_INDEX.md`). A skin's own `View` type
 * parameter (`SkinDefV3<View>`) is free to be a NARROWER or DIFFERENTLY-
 * SHAPED type than this (e.g. cricket's own `state`/`summary` casts to its
 * concrete `CricketState`/`CricketSummary` inside the skin) — this
 * interface documents the HOST's side of the contract: every field a skin
 * author can rely on `pad-host.tsx` having already resolved, from the exact
 * same inputs `pad-renderer.tsx` obtains for the legacy path (module/cfg/
 * lineups/personNames/transport/band/entitlements) — never a second data
 * path. `squads` is `state.squads` when the module's own fold populates it
 * (most sports do NOT — `reference_squad_state_persisted_only_when_it_adds_
 * information`), falling back to `initSquads(lineups)` otherwise
 * (`@seazn/engine/core`) — a skin never has to branch on which case it is.
 *
 * `events` (added for a concurrent scout's pre-task-C finding, recorded in
 * `docs/superpowers/plans/2026-08-16-scorepad-v3-r2-cricket.md`'s "C-gaps"
 * §G1): `state`/`summary` alone cannot answer "what actually happened on
 * ball N" — cricket's own state carries only running totals, not per-ball
 * outcomes, so a skin building something like an over-dots strip needs the
 * raw event stream. The SAME list `pipeline.events` already exposes
 * (oldest first, ledger + still-queued local ones), never a re-derived copy.
 */
export interface PadHostView {
  readonly cfg: unknown;
  readonly state: unknown;
  readonly summary: unknown;
  readonly phase: PadPhase;
  readonly band: FidelityBand;
  readonly entitlements: Readonly<Record<string, boolean>>;
  readonly personNames: Readonly<Record<string, string>>;
  readonly squads: SquadState;
  readonly events: readonly EventEnvelope[];
}

export function assertScorebugSpec(spec: ScorebugSpec): string[] {
  const out: string[] = [];
  spec.halves.forEach((h, i) => {
    if (h.tappable && !h.hint) out.push(`halves[${i}]: tappable requires hint`);
    if (h.tappable && !h.tapEvent) out.push(`halves[${i}]: tappable requires tapEvent`);
    if (!h.who.length) out.push(`halves[${i}]: who must be non-empty`);
  });
  return out;
}
