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
  /**
   * R2b (owner sign-off finding, single-line label fix): a PRE-LOCALISED
   * raw string, rendered VERBATIM by the chassis (tile-grid.tsx) — never
   * resolved through `t()`. Same convention `WhoLine.servingLabel` and
   * `ScorebugSpec.context` already establish elsewhere in this file, and
   * `sublabelText` below establishes for the sublabel slot: the chassis
   * never resolves a sport-namespaced key itself, not even an interpolated
   * one — a skin whose label needs a variable INSIDE the sentence itself
   * (cricket's over-summary tile: "End of over 2", the over number belongs
   * IN the label, not a separate sublabel line) calls `t(key, vars)` itself
   * and hands the chassis the already-resolved string. `label` stays
   * REQUIRED and keeps resolving through the chassis's own bare
   * `t(tile.label)` (no vars — tile-grid.tsx never gained a vars argument)
   * for every tile that does not set `labelText`; every existing skin is
   * unchanged.
   *
   * A tile always sets `label` (the type still requires a valid key as the
   * fallback/canonical value) and OPTIONALLY also sets `labelText` — but
   * when `labelText` is present, it WINS and `label`'s key is never
   * resolved at all (tile-grid.tsx), never concatenated or merged. Same
   * "explicit pre-localised value overrides the key-resolved one" posture
   * `sublabelText` takes below, and `PadHostView.contextOverrides`
   * documents for a different field pair in this file.
   */
  labelText?: string;
  sublabel?: string;              // i18n key
  /**
   * Fix round (review finding 1, R2b): a PRE-LOCALISED raw string, rendered
   * VERBATIM by the chassis (tile-grid.tsx) — never resolved through `t()`.
   * Same convention `WhoLine.servingLabel` and `ScorebugSpec.context`
   * already establish elsewhere in this file: some tile sublabels are not
   * translatable prose at all (a bare NUMBER is the motivating category —
   * the same "locale-invariant" one `variantCode()` documents for T20/ODI/
   * HUNDRED/TEST, cricket.tsx), and routing one through `sublabel` (an
   * i18n KEY) fires `[i18n] missing key: …` on every render, since no
   * dictionary will ever carry a key literally named "6". A skin with a
   * genuinely translatable sublabel keeps using `sublabel` exactly as
   * before — this field is additive/optional, so every existing skin is
   * unchanged.
   *
   * A tile sets ONE of `sublabel`/`sublabelText`, not both, in the normal
   * case — but if both are present, `sublabelText` WINS and `sublabel`'s
   * key is never resolved at all (tile-grid.tsx), never concatenated or
   * merged. Same "explicit pre-localised value overrides the key-resolved
   * one" posture `PadHostView.contextOverrides` already documents for a
   * different field pair in this file.
   *
   * R2b follow-up (owner sign-off, single-line label fix): cricket's
   * over-summary tile — this doc's own original motivating example — no
   * longer sets this field. The owner wanted the over NUMBER inside the
   * tile's LABEL sentence ("End of over 2"), not a visually separate
   * second line, so that tile now uses `labelText` above instead. This
   * field has NO shipped production setter as of that change — kept,
   * deliberately not deleted, as a chassis capability a later R3-R7 skin
   * may still need for a genuinely non-translatable SUBLABEL (as opposed
   * to a non-translatable LABEL); its own tests (`__tests__/tiles.test.ts`)
   * stay in place unchanged.
   */
  sublabelText?: string;
  kind: TileKind;
  span?: 1 | 2 | 3 | 4;
  phases: PadPhase[];
  action: { event: TapEvent } | { sheet: string } | { swap: true };
  /**
   * R2b (owner ruling, bowler-eligibility block, 2026-08-17): `true` when
   * this tile's action must NOT fire on a tap right now, while the tile
   * itself stays fully VISIBLE — never removed. This is deliberately a
   * DIFFERENT precedent from the over-summary tile's own "gone, not
   * disabled" history (that one is a PERMANENT property of the innings'
   * fidelity band): `disabled` exists for a TRANSIENT condition instead —
   * cricket's run/extra/wicket tiles while the resolved bowler is
   * ineligible, which clears the moment a legal bowler is picked. Removing
   * every run tile at each over boundary would read as the pad breaking;
   * disabling them, with the reason visible elsewhere (see below), does
   * not.
   *
   * `tile-grid.tsx` renders such a tile as a real, native `disabled`
   * `<button>` — no dispatch, no `onOpenSheet` — plus a stable
   * `data-tile-disabled` attribute a Playwright spec can assert on without
   * relying on visual styling (opacity/cursor) alone. Optional/absent
   * means tappable — every pre-existing skin's tiles keep behaving
   * identically with zero change, same additive/opt-in posture
   * `labelText` above and `ContextSlot.readOnly` below already take.
   *
   * Deliberately carries NO paired reason-text field of its own: a single
   * cause (e.g. one ineligible bowler) can disable MANY tiles at once —
   * every run/extra/wicket tile that would emit `cricket.ball` — and
   * repeating one long sentence on each of ten-plus tiles is worse UX than
   * a plain disabled look, not better. The explanation lives once, on
   * `ContextSlot.message` below, next to the affordance that can actually
   * fix it (the bowler chip a scorer taps to pick someone eligible).
   */
  disabled?: boolean;
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
  /**
   * R2/task C (Blocker 2 — review finding, `docs/superpowers/plans/2026-08-
   * 16-scorepad-v3-r2-cricket.md`, binding): `true` when the sport's own
   * engine fold will NEVER accept a scorer's override for this slot on the
   * LIVE submit path — e.g. cricket's striker/non-striker, derived under
   * `strictOrder: true` (`cricket.ts`'s own `applyDelivery`) and rejected
   * outright the moment a submitted payload disagrees with the fold's own
   * derived pair (`isStrictFold` defaults TRUE — only reconciliation/replay
   * of already-ledgered history ever passes `strict:false`, never the live
   * dispatch path a context-strip tap feeds). Rendering such a slot as an
   * ordinary tappable chip is the "picker opens and silently fails" defect
   * G5 was fixed to close, reopened for a slot the engine can never actually
   * move: a scorer could pick ANY candidate and every next ball would be
   * refused.
   *
   * `readOnly: true` keeps the chip's INFORMATION — who is on strike / who
   * is non-striker is genuinely useful even when it cannot be reassigned —
   * while removing the false affordance: the chassis renderer
   * (context-strip.tsx) must render such a slot with no tap target and no
   * picker at all, never a control that merely LOOKS disabled. Optional/
   * absent means editable — every pre-R2 slot, and every other sport's own
   * `context()`, keeps behaving identically with zero change.
   */
  readOnly?: boolean;
  /**
   * R2b (owner ruling, bowler-eligibility block, 2026-08-17): a
   * PRE-LOCALISED raw string, rendered VERBATIM by the chassis
   * (context-strip.tsx) — never resolved through `t()` itself, same
   * convention `WhoLine.servingLabel`/`ScorebugSpec.context`/
   * `TileSpec.labelText` already establish in this file: the chassis never
   * resolves a sport-namespaced key, and this string needs an
   * INTERPOLATED person name (and, for cricket's quota case, a cfg-derived
   * number) baked in before it ever reaches here — `ContextSlot.label`'s
   * own `t(slot.label)` call takes no `vars` argument, so it cannot carry
   * this on its own.
   *
   * First use: cricket's bowler slot, explaining why `TileSpec.disabled`
   * is currently true on every run/extra/wicket tile — "why can't I score
   * a ball right now" and "who is on strike" are different questions, so
   * this lives on the SLOT that names the person at fault (or, when
   * nobody in particular is at fault, the slot whose affordance would
   * normally fix it), not on `ScorebugSpec.context`'s ambient format/over/
   * run-rate line, and not repeated onto every blocked tile
   * (`TileSpec.disabled`'s own doc explains why not the latter).
   *
   * Optional/additive: every pre-existing `ContextSlot` (every other
   * sport, and cricket's own striker/non-striker slots) omits this and
   * renders exactly as before. Orthogonal to `readOnly` — either, both, or
   * neither may be set on the same slot.
   */
  message?: string;
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
/**
 * R2/task C (G6 — controller ruling 2026-08-16, binding, `docs/superpowers/
 * plans/2026-08-16-scorepad-v3-r2-cricket.md`): `candidates`, when present,
 * SUPERSEDES `pool` entirely — same additive shape as `when` above. Exists
 * because `pool` alone cannot express "exactly these two people": cricket's
 * "who's out" step needs exactly the two batters at the crease, but
 * `SquadMember.onField` is never cleared by a dismissal (only by lineup/
 * substitution events), so `pool:"onfield"` alone offers the WHOLE
 * batting-side on-field roster — by the ninth wicket, ~9 already-out
 * players beside the 2 real ones (D-15 wearing a new coat). A skin that
 * knows the exact eligible set states it directly; `pool`/`side` stay
 * REQUIRED regardless (guided-sheet.tsx's own resolvePool still needs a
 * pool/side to fall back to for every step that does NOT set `candidates`,
 * which is still the common case — a swap's off/on pickers, a fielder pick
 * with no narrower notion than "the whole fielding side").
 */
export interface SheetPersonStep { id: string; kind: "person"; title: string; pool: "onfield" | "bench" | "all"; side: "home" | "away"; candidates?: readonly string[]; when?: StepPredicate }

/**
 * R2b/task 1 (`docs/superpowers/plans/2026-08-17-scorepad-v3-r2b-cricket-
 * over.md`): a numeric step for guided sheets — an answer that is a
 * QUANTITY, not a choice from a fixed list (`SheetChoiceStep`) or a person
 * from a roster pool (`SheetPersonStep`). First real use is cricket's
 * over-summary sheet (task 3): a scorer editing a running total (runs,
 * wickets, legal balls) UP from wherever the fold's own current total
 * already sits, never counting from zero.
 *
 * `initial` is the value the stepper/field opens showing. Task 3's own
 * design ruling (plan doc, Q2) is that the sheet PREFILLS from the fold's
 * CURRENT total rather than starting at 0, so an unedited confirm can never
 * trip the engine's "summary totals may not decrease" guard (`cricket.ts`)
 * — but this type does not itself enforce that policy; it only carries
 * whatever number the skin hands it, same as `SheetChoiceStep.options`/
 * `SheetPersonStep.pool` carry whatever the skin decides without this file
 * validating the choice.
 *
 * `min`/`max` are enforced by the CHASSIS renderer (guided-sheet.tsx), not
 * left for the skin's own `buildPayload` to catch after the fact: the
 * stepper's `−`/`+` buttons and the editable field are two paths to the
 * SAME control, and a clamp only the skin enforces in `buildPayload` is a
 * clamp the renderer itself could still be made to bypass (type an
 * out-of-range number directly into the field). Both optional — an absent
 * bound simply never clamps on that side, same "absent means unrestricted"
 * reading `SheetPersonStep.candidates`'s own absence already gets.
 *
 * `hint` follows `WhoLine.servingLabel`'s already-established rule (this
 * file, above): pre-localised, skin-supplied prose — the chassis never
 * resolves a sport-namespaced key itself.
 *
 * Deliberately NOT widening `GuidedSheetSpec.buildPayload`'s `answers:
 * Record<string, string>` to admit a number: a number step's answer is
 * still a plain STRING — the decimal rendering of whatever the stepper/
 * field last held (`String(value)`) — read and parsed back by the SKIN's
 * own `buildPayload`, exactly like a `SheetChoiceStep` answer is an option
 * id and a `SheetPersonStep` answer is a person id, neither its own type
 * either. Widening the map itself would be a contract change every R3-R7
 * skin inherits for one sport's convenience, when the cost of NOT widening
 * it is a one-line `Number(answers.x)` parse at cricket's own call site.
 */
export interface SheetNumberStep {
  id: string;
  kind: "number";
  title: string;
  initial: number;
  min?: number;
  max?: number;
  /** Pre-localised, skin-supplied (same rule as WhoLine.servingLabel):
   *  the chassis never resolves a sport-namespaced key. */
  hint?: string;
  when?: StepPredicate;
}
export type GuidedSheetStep = SheetChoiceStep | SheetPersonStep | SheetNumberStep;
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
  /**
   * R2/task C (G4 — controller ruling 2026-08-16, binding, `docs/superpowers/
   * plans/2026-08-16-scorepad-v3-r2-cricket.md`): a METHOD of the view, not a
   * static record. `GuidedSheetSpec.buildPayload(answers)` sees only the
   * wizard's own answers, but a real sheet's event often needs more than
   * that — cricket's wicket is a `cricket.ball` event whose payload also
   * needs `over`/`ballInOver`/`striker`/`nonStriker`/`bowler`, all already
   * held by the context strip and none worth asking again (re-asking IS the
   * D-14/D-15 defect this chassis exists to remove). Rather than adding a
   * second parameter to `buildPayload`, `sheets` closes over the live
   * `view` at build time — the same shape every OTHER member here already
   * takes (`scorebug`, `tiles`, `dock`, `context`, `swap`, `phase`); the
   * static record R1 shipped was the anomaly, not the norm.
   *
   * CALLER OBLIGATION (nothing else enforces this): the host must rebuild
   * this record EVERY RENDER, from the CURRENT `view` — never cache/memoize
   * it across renders keyed on anything narrower than `view` itself, or a
   * sheet's closed-over `over`/`striker`/`bowler`/etc. goes stale the moment
   * the match state moves and the memo doesn't recompute. `pad-host.tsx`
   * calls `props.skin.sheets?.(view)` inline in its own render body (no
   * `useMemo`) for exactly this reason.
   */
  sheets?(view: View): Record<string, GuidedSheetSpec>;
  /**
   * Per-event detail for the activity panel's row captions (R2 sign-off
   * defect D2). `buildRibbon` resolves a caption per event TYPE, so every
   * `cricket.ball` row read identically "Ball recorded" — useless in a panel
   * whose whole job is finding ONE ball to correct.
   *
   * Lives on the skin, not the chassis: "4 runs" / "wide" / "bowled" is sport
   * vocabulary, and the chassis must not learn it (the same rule that keeps
   * `WhoLine.servingLabel` skin-supplied). Returns `undefined` when the skin
   * has nothing to add, which leaves the static caption untouched.
   *
   * `prev` (R2b, owner request — "show when the bowler changed"): the
   * PREVIOUS event in real chronological time — OLDER, never the previous
   * ARRAY INDEX. `ActivityPanel` (activity.tsx) renders rows NEWEST FIRST
   * (`orderedActivity`'s own doc), so for `rows[i]` this is `rows[i+1]`,
   * never `rows[i-1]` — getting that backwards silently annotates the WRONG
   * event while still looking plausible on screen. The caller also SKIPS
   * voided rows when picking this candidate (`previousActivityEvent`,
   * activity.tsx) — a voided delivery must never establish a fact like "the
   * previous bowler", or undoing a ball would invent a change that never
   * happened. What the caller does NOT do is filter by event TYPE: it has
   * no sport vocabulary to filter with, so `prev` may be a structural row
   * (`core.start`, a sport's own non-ball event, even a `core.void` marker)
   * sitting immediately before this one. A skin that only cares about SOME
   * event types (e.g. cricket comparing ball to ball) checks `prev.type`
   * against its own closed set itself once it receives this — the same
   * "chassis provides the mechanism, skin decides the policy" split every
   * other optional member here already takes. `undefined` at the oldest
   * row, or when every older row is voided — a skin must treat that as
   * "nothing to compare", never crash and never claim a change. Optional
   * and additive-only: every pre-R2b call site omits this 4th argument
   * entirely and keeps compiling and behaving identically, and the other
   * ten skins that decline to implement `activityDetail` at all are
   * unaffected either way.
   */
  activityDetail?(
    t: (key: string, vars?: Record<string, string | number>) => string,
    eventType: string,
    payload: Record<string, unknown>,
    prev?: { type: string; payload: Record<string, unknown> },
  ): string | undefined;
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
 *
 * `contextOverrides` (G5 — controller ruling 2026-08-16, same plan doc):
 * a slot id -> person id map of PENDING context-strip picks the HOST holds
 * in local state, not the fold. Exists because a context-strip selection is
 * not always a real event a sport's engine can persist (cricket has no
 * event that records "who is currently striking/bowling" as its own
 * standalone fact) — without somewhere to hold a pending pick, a scorer
 * tapping a candidate would watch the chip silently revert on the next
 * render, forever (the exact regression G5 found and fixed). A skin reads
 * `view.contextOverrides[slotId] ?? <its own fold-derived value>` when
 * building BOTH the context strip (so the chip shows the pick) and the next
 * dispatched payload (so the tap actually carries it) — cricket's
 * `resolvePeople(state, overrides)` is the one place this happens, reused
 * by every builder that needs striker/nonStriker/bowler. CALLER OBLIGATION
 * (pad-host.tsx, nothing else enforces this): an override lives only until
 * the fold itself advances — the WHOLE map resets, unconditionally, the
 * moment `pipeline.state` moves to a new object (a render-phase reset keyed
 * on state identity, `contextOverridesStale` in pad-host.tsx), never
 * per-slot and never left to outlive the ball it was captured for. Without
 * this, a stale override could contradict the engine's own fold after a
 * strike rotation (an odd run swaps striker/non-striker) or a new batter
 * arriving after a wicket.
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
  readonly contextOverrides: Readonly<Record<string, string>>;
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
