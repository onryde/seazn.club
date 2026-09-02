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
//
// R3/task B4 admits ONE sibling, `./sport-theme`, and states the reason so
// the invariant above is not quietly eroded: sport-theme.ts is a LEAF — it
// imports only a React type and nothing else in this directory — so no cycle
// is possible, and it is the file that owns the token vocabulary. Restating
// `SportTone` here instead would fork the vocabulary in two, which is the
// exact failure `SPORT_TONES`'s own doc (a SUBSET of `SPORT_TOKENS`, never a
// parallel list) exists to prevent. Keep any future sibling import to that
// same bar: leaf module, vocabulary owner, `import type`.
//
// R6/task A admits a SECOND sibling, `./clock`, against that same bar and for
// the same reason: clock.ts imports nothing at all (not even React), it owns
// the clock vocabulary, and restating `PadClockSpec` here would fork the shape
// the chassis reads from the shape the skin writes.
import type { EventEnvelope, SquadState } from "@seazn/engine/core";
import type { FidelityBand } from "@seazn/engine/sport";
import type { MessageKey } from "@/lib/messages";
import type { GameTimeStamp, PadClockSpec } from "./clock";
import type { SportTone } from "./sport-theme";

export type TapModel = "S" | "T";
export type PadPhase = "pre" | "live" | "post";

/**
 * R2b (owner ruling, live-tile audit — freeHit chip removal): `id`, an
 * OPTIONAL/additive identity for a strip item. Every pre-existing item (over
 * dots, striker/non-striker/bowler names, the chase target) omits it and
 * renders exactly as before. Exists solely so a Playwright spec has a
 * stable, localisation-independent `data-*` hook (`scorebug.tsx`'s
 * `data-strip-item-id`) to target ONE item in what is otherwise a plain,
 * unindexed list — matching text against a translated `value` is not a
 * stable hook, and the strip had no per-item identity at all before this.
 * First (only, as of this change) setter: cricket's free-hit indicator
 * (`skins/cricket.tsx` `buildScorebug`) — a property of the DELIVERY, so
 * `strip` (the scorebug's own ambient, always-on delivery status line — the
 * same bucket as the over dots) is the natural home, not `ContextSlot.
 * message` below (a PERSON slot's own explanation), which would be a misfit
 * for a fact that isn't about any one person.
 */
/**
 * R3/task B4 (owner ruling R3-6, per-sport visual identity): `tone`, an
 * OPTIONAL/additive request for the LED-PANEL treatment — the chassis renders
 * the item as an inset well of `--sport-board` inside the band, with
 * `--sport-led` as its digits, condensed uppercase and tabular figures
 * (globals.css `.pad-led-panel`, scorebug.tsx's strip branch).
 *
 * Football's signature: the strip BECOMES the fourth official's added-time
 * board. It replaces the permanently-dead `Clock —` field rather than adding
 * furniture (B3 removed that field; this does not restore it), and it stays
 * honest when there is nothing to show — a skin OMITS an item it cannot fill,
 * so a fresh match reads as one quiet period panel, never an empty well.
 *
 * A CLOSED one-value vocabulary, not a free class name: the whole point of
 * the token layer is that a skin names a treatment and the chassis owns what
 * it looks like. `accent` (above) is unrelated and unchanged — it is the
 * plain strip's own emphasis, and an item may set either, neither, or both
 * (`tone` wins, since it replaces the rendering entirely).
 */
export interface StripItem { id?: string; label?: string; value: string; accent?: boolean; tone?: "led" }
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
  /**
   * R3.5 — an OPTIONAL second figure against `big`, for a decider running
   * alongside the regulation score: football's shoot-out tally, and R6's
   * `(GWS 2–1)` for icehockey and hockey, which `period/kernel.ts` already
   * composes for its own summary and has nowhere to render.
   *
   * PRE-FORMATTED and pre-localised, the same convention `big` and
   * `ScorebugSpec.context` already follow — brackets, separators and all.
   * The chassis renders it verbatim and never resolves a sport-namespaced
   * key.
   *
   * Absent on every half shipped before this, so the two render branches
   * (scorebug.tsx's `HalfContent`) are byte-for-byte what R1–R4 rendered.
   * Design note D-11 (one score, rendered once) is not weakened: this is
   * the SAME score's decider, in the same element, not a second readout
   * somewhere else on the page.
   */
  sub?: string;
  /** i18n KEY, resolved by the chassis (scorebug.tsx, via padLabel()) —
   *  REQUIRED iff tappable. Renamed from `hint` (R2b-cricket-over
   *  follow-up, hint-field naming pass, 2026-08-17): shared a bare name
   *  with `SheetNumberStep.hint`, an opposite, PRE-RESOLVED convention —
   *  see `SheetChoiceStep.hintKey`'s doc below for the full reasoning. */
  hintKey?: string;
  tappable?: boolean;             // MODEL-S halves only
  tapEvent?: TapEvent;            // REQUIRED iff tappable
  /**
   * R5 — open this SHEET instead of posting `tapEvent`, for the one case
   * where scoring silently would destroy information the pad can never
   * recover (volleyball's set opener, FIVB 7.6.2).
   *
   * A tap on a model-S half normally IS the score, and that immediacy is the
   * whole point of the model — so this exists for a single, narrow shape:
   * the question must be unanswerable later, and the sheet must ask it once
   * and then get out of the way. Volleyball's case is exactly that. Under
   * side-out the next server is simply the last rally's winner, so once ONE
   * point is scored, who opened the set is gone for good and the rotation
   * number with it. Before that first point the scorer knows the answer and
   * nobody has asked them for it.
   *
   * `tapEvent` stays REQUIRED alongside it (`assertScorebugSpec`), because
   * the sheet's whole job is to build that same event with one more fact
   * attached — the half still knows which side won.
   */
  tapSheet?: string;
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
  label: MessageKey;
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
  /**
   * R3 chassis sub-wave (owner ruling 2026-08-24, `_INDEX.md` "R3 — owner
   * ruling: FIX SwapSheet in the chassis, then use it", defect 2): the swap
   * variant is `{swap: string}` — the ID of one `SwapSlot` this skin's own
   * `swap(view)` declared — where it used to be a bare `{swap: true}`.
   *
   * A boolean could only ever address THE swap sheet, so every swap tile in a
   * skin opened the same one and the side came only from `slot.side`. Football
   * is the first skin to need two (a Sub tile per side) and could not express
   * it at all. Slot-addressed, per-side Sub tiles are just two tiles naming
   * two ids.
   *
   * A `{swap}` naming an id no slot declares opens NOTHING (`resolveSwapSlot`,
   * pad-host.tsx, returns null rather than falling back to the first slot —
   * that fallback would silently reinstate the exact defect). Deliberately not
   * a typed union of a skin's own slot ids: `SkinDefV3` is generic over `View`
   * only, and threading a second type parameter through every method to make
   * one string literal-checked buys less than it costs. A skin owes its own
   * test that every `{swap}` tile it declares names a slot its own `swap()`
   * declares — the same posture `{sheet: string}` already takes.
   */
  action: { event: TapEvent } | { sheet: string } | { swap: string };
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
  /**
   * R3/football — a PRE-LOCALISED raw string, rendered VERBATIM by the
   * chassis (detail-dock.tsx), never resolved through `t()`. The same
   * key-plus-text pair `TileSpec.labelText`/`sublabelText`,
   * `ContextSlot.message`, `WhoLine.servingLabel` and `SheetNumberStep.
   * hintText` already establish in this file: the chassis never resolves a
   * sport-namespaced key, and some labels are not dictionary keys at all.
   *
   * The motivating category is a PERSON'S NAME. Every dock shipped before
   * football's chose from a fixed vocabulary ("4 runs", "Wide"), but a goal's
   * scorer/assist chips are one chip per player, and a display name routed
   * through `t()` fires `[i18n] missing key: A. Mensah` on every render while
   * only rendering correctly by accident (the runtime returns the key it was
   * handed). That is the exact defect `sublabelText`'s own doc describes for
   * a bare number.
   *
   * `label` stays REQUIRED — it remains the canonical key, and is what every
   * chip that does not set this still resolves through. When `labelText` IS
   * present it WINS and `label` is never resolved at all, never concatenated
   * or merged: the same "explicit pre-localised value overrides the
   * key-resolved one" posture `labelText`/`sublabelText` already take above.
   * Optional/additive, so every pre-R3 dock (cricket's bat-run and extra-run
   * chips) renders identically with zero change.
   */
  labelText?: string;
  /**
   * R3/football — what KIND of answer this chip gives, which the chassis
   * renders as a shape rather than a colour.
   *
   * A goal dock mixes two genuinely different things: `ownGoal`/`penalty` are
   * MODIFIERS of the event that was already recorded, and the rest are
   * ATTRIBUTION — one chip per player. Rendered identically (every chip was a
   * `rounded-full` pill), the two flags sat inside the name list, and a scorer
   * hunting a name inside the ~6s hold window had to read past them. The cost
   * of a mis-tap is not symmetric either: picking the wrong person is a wrong
   * name on a goal, while `ownGoal` changes which SIDE the fold credits.
   *
   * Deliberately a SHAPE and not a tone: shape is legible in peripheral vision
   * before colour is, which is what a timed scan actually needs, and it adds no
   * new colour for `contrast.test.ts` to have to license. A person stays the
   * pill it already was; a flag becomes a tab.
   *
   * Optional/additive, exactly as `labelText` above: every pre-R3 dock
   * (cricket's bat-run and extra-run chips) sets nothing and renders
   * byte-identically — pinned by `dock.test.ts`.
   */
  kind?: "flag";
  mutate: (payload: Record<string, unknown>) => Record<string, unknown>;
}
export interface DockSpec { title: string; chips: DockChip[] }

/**
 * R2c — a person/option id -> the PRE-LOCALISED reason it is not selectable
 * RIGHT NOW. An ABSENT key means selectable; the map is never exhaustive, and
 * a key naming someone already out of scope is simply never rendered rather
 * than an error (the two narrowing operations compose, see below).
 *
 * Pre-localised, skin-supplied prose — the same rule `WhoLine.servingLabel`,
 * `TileSpec.labelText`, `ContextSlot.message` and `SheetNumberStep.hintText`
 * already establish in this file: the chassis never resolves a
 * sport-namespaced key, and these strings need an interpolated person name
 * (and sometimes a cfg-derived number) baked in before they arrive. A skin
 * has `t` for this — the skin FACTORY takes it (`cricketSkinV3(t)`) and every
 * builder closes over it.
 *
 * NARROWING HAS TWO CAUSES AND THEY WANT OPPOSITE TREATMENTS. This type is
 * only the second one:
 *
 * - SCOPE — the person is not in question at all (a batter in a bowler
 *   picker). REMOVED, via `candidates`. Nobody expects them, and rendering
 *   eleven greyed names is noise on a touch-first surface at 320px.
 * - ELIGIBILITY — in scope, but blocked right now (bowled the previous over,
 *   at quota, side has no reviews left). RENDERED, disabled, WITH ITS REASON.
 *   This is R2b's binding ruling ("visible, blocked, and REASONED — not
 *   removed"; `TileSpec.disabled`'s own doc above) applied to a candidate
 *   list rather than a tile, and it is what stops a silently shortened list
 *   leaving a scorer who expected a name with no idea why it is gone.
 *
 * Named `Blocked` rather than `Disabled` deliberately: `TileSpec.disabled` is
 * a bare boolean on one tile, and reusing that word for a per-id map would
 * invite a skin author to expect the same shape.
 */
export type Blocked = Readonly<Record<string, string>>;

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
   * R8 (owner ruling 2026-09-02, register row D2) — WHAT this slot names.
   *
   * Absent (or `"person"`) is every pre-existing slot and stays byte-identical:
   * a PERSON in a role, whose chip may open a picker when the fold would
   * actually honour the pick.
   *
   * `"mode"` is a locked SCORING MODE — how the sport is currently being
   * entered, where the sport itself offers more than one lane and the choice
   * is already made. Cricket is the first: an innings is ball-by-ball or
   * over-by-over, decided by its FIRST event and reversible only by undoing
   * back past it (`inningsFidelity`, skins/cricket.tsx). Before this the pad
   * expressed that fork only as WHICH TILES APPEAR — no words anywhere — so a
   * scorer who did not already know the rule could not learn it from the pad.
   *
   * A chassis-wide field, not a cricket hack: any skin whose sport has more
   * than one entry lane may declare one, and the chassis then guarantees the
   * three things a mode statement must be, so no skin can get them wrong:
   *
   *   1. NEVER A CONTROL. `context-strip.tsx` never opens a picker on a
   *      `"mode"` slot, whatever `readOnly` says. The mode is locked; a picker
   *      that cannot move it is the "opens and silently fails" defect
   *      `readOnly` above exists to close, in its purest form.
   *   2. NEVER SHAPED LIKE ONE. WS-M copy round 2 (controller ruling,
   *      2026-09-02): it renders as PLAIN TEXT with a lock glyph, never a
   *      pill — see `renderModeStatement` (context-strip.tsx) for why shape
   *      carries more of this signal than words do.
   *   3. NEVER AN EXCUSE FOR A DISABLED TILE. `assertDisabledTilesExplained`
   *      (tile-grid.tsx) counts context-slot messages as the explanation a
   *      disabled tile owes; a mode slot's message is ALWAYS present, so
   *      counting it would make that validator vacuously green for every skin
   *      that declares one. It is excluded there by `kind` for that reason.
   *
   * DISTINCT FROM THE BAND (recording-chip.tsx), and the axis is AGENCY, not
   * topic. Both are granularity, which is exactly why they are easy to
   * conflate. What separates them is whose value it is: the band is the
   * SCORER'S CHOICE of how much to record, changeable now; a mode is a FACT
   * THE SPORT LOCKED when the period began, and no control on this pad can
   * move it. That is why a mode slot's own label names its owner ("This
   * innings: …") — a scorer needs to know whose the value is before deciding
   * whether to reach for it. Deliberately worded without reference to plans or
   * entitlements: what the band means commercially has changed once already
   * and may change again; what it means to a SCORER — my choice, not the
   * innings' — is the part that makes this distinction stable.
   */
  kind?: "person" | "mode";
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
  /**
   * R5 — WHAT KIND of message this is, because the chassis had exactly one
   * answer and it was the wrong one for the second caller.
   *
   * `message` shipped hard-coded `text-red-600` (context-strip.tsx), which is
   * right for its first and only case: cricket's "the resolved bowler is
   * ineligible" is a fault, it blocks every run tile, and red is the register
   * a scorer should read it in. Badminton's own message is not a fault at all
   * — "rally-by-rally scoring needs Pro" is a TIER, the pad is working exactly
   * as configured, and putting it in the same red as a rejected submission
   * teaches a scorer that red on this pad means nothing in particular. The
   * recording chip already words a plan lock a few pixels away, in amber; this
   * makes the two agree instead of arguing.
   *
   * DEFAULTS TO `"alert"`, so every pre-existing slot — cricket's bowler, and
   * every future one that says nothing — renders byte-identically to before.
   * A skin opts into `"info"` deliberately, the same additive posture
   * `readOnly`/`candidates`/`blocked` above already take.
   */
  messageTone?: "alert" | "info";
  /**
   * R2c — SCOPE. When present, SUPERSEDES `pool` entirely: the identical
   * contract, wording and semantics `SheetPersonStep.candidates` (G6) already
   * ships, extended to the strip, and honoured by the same
   * `candidates ?? resolvePool(...)` line guided-sheet.tsx already uses.
   *
   * An EMPTY array means "nobody is eligible" and renders the empty-pool
   * text — it must never read as "no narrowing" and fall back to `pool`.
   * That absent-vs-empty divergence is the trap `ContextSlot.message` already
   * hit (R2b review item 3); here the two states have genuinely different
   * meanings, so the check is presence, not truthiness.
   *
   * `pool` stays REQUIRED regardless — every slot that does not narrow (every
   * other sport, and cricket's own striker/non-striker) still needs it, and
   * keeps behaving identically with zero change.
   *
   * First use: cricket's bowler chip, narrowed to the FIELDING side. That
   * also makes the engine's "not in the fielding lineup" refusal structurally
   * unreachable from the picker rather than merely checked afterwards.
   */
  candidates?: readonly string[];
  /**
   * R2c — ELIGIBILITY. Applied AFTER `candidates`/`pool` resolves, so scope
   * and eligibility never fight. See `Blocked` above for why these are two
   * operations and not one.
   *
   * A plain VALUE here while `SheetChoiceStep.blocked` is a METHOD, and the
   * asymmetry is load-bearing rather than sloppiness: a strip slot has no
   * answers to depend on and is rebuilt every render from the live `view`, so
   * a value is already current. A sheet step is built once per render but
   * read across several answer transitions within one sheet, so its verdict
   * must be a function of `answers` or it goes stale mid-wizard.
   *
   * First use: cricket's bowler chip — the previous over's bowler and anyone
   * at quota, each named with the reason. Orthogonal to `message`, which says
   * why the TILES are blocked; this says why a CANDIDATE is.
   */
  blocked?: Blocked;
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

/**
 * R2b-over (review finding — the recurring "never offer what the engine
 * will refuse" defect class, `_INDEX.md`): an OPTIONAL, additive reason line
 * for a choice step whose `options` the skin has narrowed for the current
 * fold state. First use: cricket's wicket "kind" step offers only
 * runout/obstructed while a free hit is pending (`wicketSheet`,
 * skins/cricket.tsx) — a silently shortened list is better than the bare
 * rejection it replaces, but still leaves a scorer who expected "bowled"
 * with no idea why it is missing; `hintKey` is that explanation. Absent
 * means "no reason line" — every pre-existing `SheetChoiceStep` (every step
 * shipped before this) omits it and renders identically.
 *
 * A plain i18n KEY, resolved by the chassis exactly like `title`/
 * `options[].label` already are (`t(step.hintKey)`, guided-sheet.tsx) — the
 * same convention `ScorebugHalf.hintKey` above already establishes for a
 * hint with nothing to interpolate. Deliberately NOT `SheetNumberStep.
 * hintText`'s pre-resolved-string convention below: that field needed an
 * INTERPOLATED value baked in before `sheets()` returns, and `SkinDefV3.
 * sheets` (unlike `tiles`/`scorebug`/`dock`/`context`) never receives a `t`
 * at all (`sheets()`'s own header, skins/cricket.tsx) — keeping this a bare
 * key lets a static, translatable sentence stay that way without widening
 * `sheets()`'s signature for every skin.
 *
 * R2b-cricket-over follow-up (hint-field naming pass, 2026-08-17): renamed
 * from `hint`. This field and `SheetNumberStep.hint` shared one bare name
 * for opposite contracts — a key to resolve vs. an already-resolved string
 * — a coin-flip for any R3-R7 skin author, and wrong in the worst possible
 * direction either way: a raw key mis-typed into a `hintText`-shaped field
 * renders literally to a scorer, while a resolved sentence mis-typed into a
 * `hintKey`-shaped field is re-sent through `t()`, which logs a
 * missing-key warning yet still renders the original sentence — so it
 * looks fine in English and only breaks once translated. `ScorebugHalf`
 * shared this same KEY convention (resolved by the chassis, never
 * skin-supplied prose) and was renamed to `hintKey` alongside it for the
 * identical reason, so neither convention is left as an unmarked default.
 */
/**
 * R2c — `blocked(answers)`, the choice-step counterpart to
 * `ContextSlot.blocked` (see `Blocked` above). A METHOD, not a value: the
 * deciding fact is frequently not known when `sheets(view)` builds the spec,
 * because it depends on an answer given EARLIER IN THE SAME SHEET. Same
 * evaluation point and same single-argument signature `when`
 * (`StepPredicate`) already uses, so a skin author meets one convention
 * rather than two. Absent means every option is selectable, and every
 * pre-R2c choice step is unchanged.
 *
 * The motivating case is cricket's review sheet, and it doubles as the proof
 * that this needed no step REORDERING: the per-innings review quota is fully
 * known from `view` at build time, and the only late-bound fact is whether
 * the review is a player one (umpire reviews are never capped) — which is
 * already step 1, while the side being asked is step 3. A reorder would have
 * been strictly worse, since it would ask the side even for the uncapped case.
 */
/**
 * R3/task B4 (owner ruling R3-6) — `options[].tone`, OPTIONAL/additive: the
 * card-code colours, and the one place in this pad where colour is
 * INFORMATION rather than decoration. A referee does not raise a "destructive
 * action"; yellow and red are the only colours in football's visual language
 * that carry meaning, and before B4 a red card rendered in the chassis's
 * generic `destructive` red (identical to Abandon) while a yellow rendered
 * neutral. B3 collapsed cards to ONE neutral tile per side, so no tile carries
 * colour any more — the three options inside `card-<side>`'s first step are
 * where these belong.
 *
 * R6-3 widened that vocabulary to THREE (`advisory`, hockey's FIH green card)
 * — additively, and without touching this field's type: `SportTone` is derived
 * from `SPORT_TONES`, so the accepted subset here grows with the ruling rather
 * than being restated. That is the whole reason this reads `readonly
 * SportTone[]` and not a hand-written union; a second vocabulary for the same
 * values is the drift this file's own import note forbids.
 *
 * An ARRAY over a closed vocabulary (`SportTone`, ./sport-theme.ts), not a
 * single value, because one option legitimately carries two: a second yellow
 * IS a yellow card and a red one, not a red card with a note (the engine
 * keeps `second_yellow` as its own colour for the same reason — the
 * suspension tariff comes off the reason, not the colour). The chassis
 * renders one swatch per entry, overlapped, and washes the button in the LAST
 * entry — the outcome.
 *
 * A NAME, never a value: `guided-sheet.tsx` maps it to `--sport-*` tokens the
 * chassis owns, so a skin still supplies no colour of its own and a sport
 * with no override renders the app's daylight signal pair. Absent means the
 * plain option button every pre-B4 step already rendered.
 */
export interface SheetChoiceStep { id: string; kind: "choice"; title: MessageKey; options: { id: string; label: string; tone?: readonly SportTone[] }[]; when?: StepPredicate; hintKey?: string; blocked?(answers: Readonly<Record<string, string>>): Blocked }
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
export interface SheetPersonStep {
  /**
   * This step can be answered with NOBODY, and the skin's `buildPayload`
   * must treat the empty answer as "field absent".
   *
   * R6 follow-up. Two defects, one cause — a person step with no way to
   * decline:
   *
   *   1. A division with no rosters offers ZERO candidates, so
   *      `renderCandidateRow` draws only "No roster available yet." and the
   *      sheet's only exits are Back and Cancel. The event cannot be
   *      recorded AT ALL. Rosterless divisions are ordinary, not exotic.
   *   2. Even WITH a roster the step was compulsory, though the field it
   *      collects is an exception by definition — `servedBy` is the
   *      team-mate who sits a penalty when the assessed player is not the
   *      one serving it (a bench minor, a coach's card). The common case is
   *      that nobody needs naming, and the scorer was being made to name
   *      somebody anyway.
   *
   * The engine has always treated these fields as optional; only the sheet
   * insisted. Skins whose person step is genuinely required (cricket's
   * "who's out") simply do not set this.
   */
  optional?: boolean; id: string; kind: "person"; title: MessageKey; pool: "onfield" | "bench" | "all"; side: "home" | "away"; candidates?: readonly string[]; when?: StepPredicate }

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
 * `hintText` follows `WhoLine.servingLabel`'s already-established rule
 * (this file, above): pre-localised, skin-supplied prose — the chassis
 * never resolves a sport-namespaced key itself. Renamed from `hint`
 * (R2b-cricket-over follow-up, hint-field naming pass, 2026-08-17) — see
 * `SheetChoiceStep.hintKey`'s doc above for why the shared bare name was a
 * defect, not a coincidence.
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
 *
 * `initial` WIDENED (R6 fix, W-1 — 2026-08-31): admits `(answers) => number`
 * alongside the plain literal every step used before. A literal is fixed
 * when the sheet is BUILT, before this sheet has any answers at all — fine
 * for cricket's over-summary (prefills from the fold's current total, never
 * from an earlier step in the SAME sheet) but wrong for a step whose right
 * opening value depends on what an EARLIER step in this sheet just
 * answered (period-shared.ts's minutes stepper: the suspension class the
 * scorer picked one step ago). `guided-sheet.tsx` resolves the function
 * form at the moment a step is freshly seeded, against the answers
 * accumulated so far (`GuidedSheetState.answers`) — never against the step
 * being seeded itself, which has no answer yet. Backward compatible: every
 * step that passes a literal is untouched, and `clampNumberStep` still
 * clamps whichever form resolves.
 */
export interface SheetNumberStep {
  id: string;
  kind: "number";
  title: MessageKey;
  initial: number | ((answers: Record<string, string>) => number);
  min?: number;
  max?: number;
  /** Pre-localised, skin-supplied (same rule as WhoLine.servingLabel):
   *  the chassis never resolves a sport-namespaced key. */
  hintText?: string;
  when?: StepPredicate;
  /**
   * Step ids this step's `initial` READS. Answering any of them to a
   * different value discards this step's own answer, so the next visit
   * re-seeds instead of carrying a number derived from the old answer.
   *
   * R6 W-1, the Back path. Seeding correctly on the way in is not enough:
   * a scorer who picks a suspension class, accepts its minutes, taps Back
   * and picks a DIFFERENT class would otherwise carry the first class's
   * duration forward — `pruneAnswers` keeps the minutes answer (the step is
   * still visible for the new class) and a prior answer beats `initial` by
   * design, because Back must not blank a value somebody typed.
   *
   * Only the DERIVED value is dropped, and only when the thing it was
   * derived from actually changed: re-answering a step with the SAME value
   * keeps everything, so Back-and-forward with no change is still lossless.
   * A literal `initial` needs none of this and should not declare it.
   */
  resetOn?: readonly string[];
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
/**
 * Optional per-candidate decoration for a picker row (R5, owner ruling
 * 2026-08-30). A LOOKUP, not a list: keyed by person id, so one table serves
 * both steps of a swap sheet without either step needing to know how the
 * other resolved its pool.
 *
 * Exists because a picker of six teammates is six visually identical rows —
 * wrapping names and nothing else — and the person tapping it between rallies
 * scans by POSITION, not by name. The information was always in the fold
 * (`SquadMember.positionKey`, `.roles`); the row simply threw it away.
 *
 * Both fields are optional and both default to rendering NOTHING, so every
 * caller that supplies no meta keeps its exact current row. That default is
 * load-bearing: `renderCandidateRow` is chassis shared by cricket's bowler
 * picker, football's subs and every context strip in the app.
 */
export interface CandidateMeta {
  /** Short leading badge — a position CODE ("S", "OH", "MB", "OPP"), not a
   *  translated word. Deliberately untranslated: these codes are volleyball's
   *  own vernacular, identical across the four locales this app ships, and
   *  short enough to hold 320px beside a two-line name. A sport whose
   *  positions are NOT code-like should pass a translated string here
   *  instead — this field is prose to the renderer either way. */
  readonly lead?: string;
  /** Trailing tag, ALREADY TRANSLATED by the skin ("Libero"). Marks a role
   *  the position code cannot express: a libero on court holds whichever
   *  position they replaced, so `lead` reads "MB" and only this says which
   *  player is the one the sheet is actually about. */
  readonly tag?: string;
}

export interface SwapSlot {
  /**
   * R3 chassis sub-wave (owner ruling 2026-08-24, defect 1). Stable, skin-
   * authored identity — the string a `TileSpec.action = {swap: id}` names.
   * Unique within one skin's own `swap(view)` result; `resolveSwapSlot`
   * (pad-host.tsx) takes the FIRST match, so a duplicate id makes the later
   * slot unreachable rather than crashing.
   *
   * Exists because `swap` returned ONE slot per view: every `{swap:true}` tile
   * opened that same sheet and the side came only from `slot.side`, so a
   * per-side Sub tile pair — football's actual requirement, and the first real
   * use this primitive ever had — was structurally unreachable.
   */
  id: string;
  /** i18n key — swap-sheet.tsx's `SwapSheetSpec.offLabel`. */
  offLabel: string;
  /** i18n key — swap-sheet.tsx's `SwapSheetSpec.onLabel`. */
  onLabel: string;
  /** Which side's squad the off/on pickers both draw from — a substitution
   *  is always within ONE team, unlike a guided sheet's person steps. */
  side: "home" | "away";
  /**
   * R3 chassis sub-wave (owner ruling 2026-08-24, defect 3): the event type
   * `buildEvent` will produce — `"football.sub"` where the module declares
   * one, `"core.lineup.substitution"` otherwise (design §2.7).
   *
   * Declared STATICALLY, and separately from `buildEvent`, for one reason: the
   * band filter runs at TILE-BUILD time, long before any pick exists, and
   * `buildEvent(off, on)` needs a concrete pair it cannot have yet. Without
   * this, `tileEventType` (pad-host.tsx) returned null for every swap tile and
   * the fail-open filter kept it unconditionally — so a band-0 org saw the Sub
   * tile, picked two people, and only THEN earned a refusal at the scoring
   * door (`assertEntitledToScore`, server/usecases/scoring.ts). A dead-end
   * tap, the defect class this programme keeps closing.
   *
   * MUST equal the `.type` `buildEvent` actually returns. Nothing can check
   * that here — the two are separated by a pick that only exists at tap time —
   * so a skin owes its own test that the pair agree. `createSkinDispatch`'s "a
   * skin cannot invent an event" guard still catches an invented type at
   * dispatch, but only after the taps have already been spent.
   */
  eventType: string;
  /** Per-candidate row decoration for BOTH steps — see `CandidateMeta`.
   *  Absent keeps every row exactly as it renders without it. */
  candidateMeta?: Readonly<Record<string, CandidateMeta>>;
  /** The module's own `lineupPolicy(cfg)` verdict for whether a
   *  substitution is currently legal for this side at all (design §2.7) —
   *  `reduceLineupEvent`'s `{ok}`, computed by the skin from its own folded
   *  state. */
  policyOk: boolean;
  /** Sport-worded refusal PROSE — `reduceLineupEvent`'s `.message`, NEVER
   *  its `.reason` machine slug (see this interface's own header). Present
   *  only when `policyOk` is false. */
  policyMessage?: string;
  /**
   * R3 chassis sub-wave (owner ruling 2026-08-24, defect 4) — SCOPE for the
   * ON list (who may come ON). Field-for-field the contract `ContextSlot.
   * candidates` already ships, honoured by the same `candidates ?? resolvePool
   * (...)` line, so the two narrowing surfaces cannot fork. See `Blocked`
   * above for why scope and eligibility are two operations, not one.
   *
   * When present it SUPERSEDES the bench pool entirely, and an EMPTY array
   * means "nobody is eligible" — it must never read as "no narrowing" and fall
   * back to the pool. Absent keeps R1's behaviour exactly (`pool: "bench"`).
   *
   * The ON LIST ONLY, and the asymmetry is deliberate rather than an
   * oversight. The OFF list stays `resolvePool({pool: "onfield"})` because no
   * shipped sport has a per-candidate rule about who may be taken OFF —
   * swap-sheet.tsx's own SCOPE NOTE has priced that deferral in since R1.
   * Adding `offCandidates`/`offBlocked` later is purely additive; inventing
   * them now would be two more fields with no caller and no test that could
   * fail.
   *
   * A VALUE, not a method, matching `ContextSlot` rather than
   * `SheetChoiceStep`: this is rebuilt every render from the live `view`, so a
   * value is already current. The cost, stated so a skin author does not
   * discover it the hard way: it therefore CANNOT depend on which OFF player
   * was picked, since that pick lives in `SwapSheet`'s own local state and
   * never re-enters `swap(view)`. The one dependency that genuinely matters —
   * a player cannot replace themselves — is handled by the chassis instead
   * (`swapCandidates` excludes the picked OFF person, defect 5).
   */
  candidates?: readonly string[];
  /**
   * R3/football — SCOPE for the OFF list (who may come off), the additive
   * counterpart `candidates` above priced in for "whichever wave first has
   * one". Same `?? resolvePool(...)` resolution, same absent-vs-EMPTY
   * distinction (an empty array means "nobody may come off" and must never
   * read as "no narrowing"), same field name across `adaptSwapSlot`.
   *
   * The reason is NOT a per-candidate rule about who may be taken off — it is
   * that the on-field POOL is stale for a sport whose fold does not adopt the
   * kernel's `SquadState`. `squadStateOf` (pad-host.tsx) degrades football's
   * own private squad projection to `initSquads(lineups)`, i.e. the KICKOFF
   * team sheet, which never moves again: one substitution later the pool still
   * offers the player who came off and still omits the one who came on. Both
   * halves are dead-end taps — `reduceLineupEvent` refuses "off" for someone
   * not on the field, and a substitute who came on could never be withdrawn.
   * A skin whose engine state DOES track the live pitch states it here.
   *
   * No `offBlocked` alongside it, deliberately: no shipped sport has a reason
   * to render someone on the pitch as visibly-ineligible-to-leave, and a field
   * with no caller is a field with no test that could fail. Adding one later
   * stays purely additive, exactly as this one was.
   */
  offCandidates?: readonly string[];
  /**
   * R3 chassis sub-wave (owner ruling 2026-08-24, defect 4) — ELIGIBILITY for
   * the ON list, applied AFTER `candidates`/the pool resolves so scope and
   * eligibility never fight. Same `Blocked` type, same pre-localised
   * person-id -> reason shape and the same renderer (`renderCandidateRow`) the
   * context strip already uses.
   *
   * A blocked candidate stays VISIBLE, disabled, WITH ITS REASON beside the
   * name — R2b's binding "visible, blocked, and REASONED — not removed"
   * ruling. Without it the swap sheet could only offer everyone and let the
   * engine refuse afterwards, which is the whole defect: the sheet could not
   * say WHY someone was ineligible.
   *
   * First real use: football's already-substituted-off players, whom
   * `reentry: "none"` will refuse.
   */
  blocked?: Blocked;
  /** Builds the concrete event once both picks are made — `football.sub`
   *  where the module declares one, `core.lineup.substitution` otherwise
   *  (design §2.7). Runs through the SAME dispatch guard as every other v3
   *  event (`createSkinDispatch` — item 5), so an invented type still fails
   *  at the call site. */
  buildEvent(off: string, on: string): TapEvent;
}

/**
 * R2b-cricket-over review fix (item 1): the single object `SkinDefV3.
 * activityDetail` takes, replacing what had grown to seven positional
 * parameters. Field-for-field the same information the removed positional
 * signature carried, MINUS `prev` (item 2 — review proved it redundant: a
 * "previous event" lookup and a "every older event" lookup were computed
 * from the IDENTICAL range with the identical voided-skip rule — see
 * `history` below and `activity.tsx`'s `priorActivityEvents`; `prev` was
 * always exactly `history`'s own last element, so a skin that needs it
 * derives `history[history.length - 1]` itself instead of receiving a
 * separate, independently-computed argument that can never actually
 * disagree with `history`).
 */
export interface ActivityDetailContext {
  /** Interpolating message lookup — same shape every other v3 chassis
   *  renderer's own `t` prop takes. */
  t: (key: string, vars?: Record<string, string | number>) => string;
  /** Plural-aware lookup for the SAME dictionary `t` reads, selecting
   *  `<key>.one` / `<key>.other` through `Intl.PluralRules` for the viewer's
   *  own locale (`usePlural`, dict-provider.tsx). OPTIONAL because a skin's
   *  `activityDetail` is also called from harnesses that build this context
   *  by hand; a skin that needs a plural falls back to the `.other` form,
   *  which is the correct English reading for every count but one.
   *
   *  A skin cannot do this for itself: `t` takes no count and the skin
   *  factory receives no locale, so "1 pts" was unfixable inside the skin —
   *  R7-28, found by reading a real 320 capture rather than a test. */
  plural?: (key: string, count: number, vars?: Record<string, string | number>) => string;
  /** The event's own type, e.g. `"cricket.ball"`. */
  eventType: string;
  /** The event's own payload. */
  payload: Record<string, unknown>;
  /**
   * Every strictly OLDER, non-voided event before this row, OLDEST FIRST —
   * the order a REPLAY-style derivation needs to walk forward through
   * (`ActivityPanel`'s own `priorActivityEvents`, activity.tsx). The
   * caller does not filter by event TYPE: it has no sport vocabulary to
   * filter with, so this may contain structural rows (`core.start`, a
   * sport's own non-ball event) — a skin that only cares about SOME event
   * types (e.g. cricket comparing ball to ball) checks `.type` against its
   * own closed set itself once it receives this, the same "chassis
   * provides the mechanism, skin decides the policy" split every other
   * optional member of `SkinDefV3` already takes. The caller also SKIPS
   * voided rows — a voided delivery must never establish a fact like "the
   * previous bowler", or undoing a ball would invent a change that never
   * happened. Empty array at the oldest row, or when every older row is
   * voided — never `undefined` for "nothing older" (only the whole
   * `history` field itself is optional, for a pre-R2b call site that
   * never computes it at all). A skin deriving a single "previous event"
   * fact reads `history[history.length - 1]` itself (item 2 — see this
   * interface's own header).
   */
  history?: readonly { type: string; payload: Record<string, unknown> }[];
  /**
   * `PadHostView.cfg` verbatim — `unknown`, same as every other view field
   * a skin re-derives its own shape from. Exists because a per-row
   * derivation can depend on a cfg-level fact no event payload carries on
   * its own (cricket's free hit only arms at all when
   * `cfg.ballsPerInnings !== null`, a format property, not a per-ball
   * one). `ActivityPanel` itself never learns what `cfg` means or that
   * this field exists — `pad-host.tsx`'s own `resolveDetail` closure
   * captures `view.cfg` directly and forwards it here.
   */
  cfg?: unknown;
  /**
   * R3.5/Task E — `PadHostView.state` verbatim, the same "closure-captured,
   * unknown" convention `cfg` above already takes. Exists for the identical
   * reason: a per-row derivation can depend on a STATE-level fact no event
   * payload carries on its own. Football's `football.shootout.kick` payload
   * carries `by`, an entrant id — resolving it to a SIDE ("home"/"away") for
   * the activity row needs `state.entrants`, which only the fold holds; no
   * `cfg` fact and no payload field can answer it. `ActivityPanel` itself
   * never learns what `state` means or that this field exists —
   * `pad-host.tsx`'s own `resolveDetail` closure captures `view.state`
   * directly and forwards it here, exactly as it already does for `cfg`.
   *
   * Optional/additive: every pre-R3.5 `activityDetail` implementation
   * (cricket's `cricketBallDetail`) omits reading this and keeps behaving
   * identically with zero change.
   */
  state?: unknown;
  /**
   * `PadHostView.personNames` verbatim — a static, closure-captured data
   * bag `pad-host.tsx`'s own `resolveDetail` closure forwards alongside
   * `view.cfg`, never a resolver FUNCTION threaded through the contract.
   * Exists so a skin can turn a raw person id on the payload (e.g.
   * cricket's `bowler`) into a display name instead of a name-free note.
   * A skin that resolves a name from this MUST fall back to something
   * sane (e.g. `t("eventCopy.unknownPerson")`) and must NEVER render the
   * raw id — unlike `ActivityPanel`'s own `nameOf` (`personNames[id] ??
   * id`), which is safe only because its output never reaches a skin's
   * own composed prose.
   */
  personNames?: Readonly<Record<string, string>>;
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

  /**
   * R7/task D — does this skin's OWN surface already say everything the
   * engine's `summary.headline` says? Return true and the chassis stops
   * rendering the `data-role="v3-headline"` bar above the scorebug.
   *
   * THE RULING, verbatim (R6's position, sent to R7 and recorded in
   * `_INDEX.md`): "do not hardcode a per-sport suppression list in the
   * chassis. A skin should DECLARE whether it owns the headline's
   * information, the same opt-in shape `phase?(view)` already uses — then
   * hockey and ice hockey suppress it once their own strip surfaces shootout
   * and OT, cricket keeps it (the chase equation earns its place), and no
   * chassis-side list has to be kept in sync with eleven skins."
   *
   * WHY THE BAR EXISTS AT ALL, so nobody deletes it wholesale. The legacy
   * renderer showed the fold's headline; v3 dropped it and a finished match
   * showed two scores and nothing saying who won — on a TIE that is the whole
   * outcome. It is the ONLY statement of the result on the pad. So the
   * question is never "is the bar ugly", it is "does this skin already carry
   * every fact this string carries, in every state".
   *
   * TAKES `view` DELIBERATELY, like `phase` does. A skin whose own surface
   * covers the headline in some states and not others answers per state
   * rather than opting out of the whole thing. (No skin needs that yet —
   * every current answer is state-independent — but the alternative, a bare
   * boolean field, would force such a skin to choose between a duplicated bar
   * and a lost fact.)
   *
   * OMITTING IT MEANS "KEEP", which is the safe direction: a new skin renders
   * one redundant bar until someone looks, rather than silently dropping the
   * only statement of its result.
   */
  ownsHeadline?(view: View): boolean;
  scorebug(view: View): ScorebugSpec;
  tiles(view: View): TileSpec[];
  /**
   * R2b/task 4 (`_INDEX.md`, owner ruling): `payload`, the OPTIONAL 3rd
   * argument, is the held tap's own event payload. Additive: every
   * pre-existing 2-arg `dock(eventType, view)` call site, and every skin
   * that declines to read this parameter at all, keeps compiling and
   * behaving identically — zero change, same "chassis provides the
   * mechanism, skin decides the policy" posture every other optional
   * parameter in this file already takes.
   *
   * Exists because `eventType` alone cannot tell two taps apart: a no-ball
   * and a plain single both dispatch the identical `cricket.ball` event
   * TYPE, so a skin whose dock should offer different chips for the two
   * (e.g. bat-run chips only for a no-ball, never for an ordinary run or a
   * wide — the engine refuses bat runs off a wide, cricket.ts:1229) needs
   * the actual PAYLOAD that was tapped, not just its type, to decide.
   * `pad-host.tsx`'s own `resolveDockSpec` is the one call site that
   * supplies this: the held tap's payload, captured at hold time
   * (`HeldTap.payload`), forwarded verbatim, never re-derived from `view`
   * (by dock-render time the optimistic fold has already advanced past the
   * held tap, so `view.state` alone cannot answer "which tile was this").
   */
  dock(eventType: string, view: View, payload?: Record<string, unknown>): DockSpec | null;
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
   * R2b-cricket-over review fix (item 1): takes a SINGLE `ActivityDetailContext`
   * object (below) rather than positional parameters. This grew to seven
   * positional params one fix round at a time — `cfg?: unknown` sat sixth
   * among four trailing optionals, and since TypeScript types callbacks
   * POSITIONALLY, a skin author who reordered params would get a silently
   * type-safe wrong call (`unknown` accepts anything). Collapsing to one
   * object makes every field self-naming at the call site instead. See
   * `ActivityDetailContext`'s own doc for what each field means.
   */
  activityDetail?(ctx: ActivityDetailContext): string | undefined;
  /**
   * Declares this skin's swap-sheet integration (design §2.7) — EVERY slot
   * currently offerable, each addressed by a `TileSpec.action = {swap: id}`.
   *
   * R3 chassis sub-wave (owner ruling 2026-08-24, defect 1): PLURAL, where
   * this returned `SwapSlot | null`. One slot per view meant every swap tile
   * in a skin opened the same sheet, so football's per-side Sub tiles were
   * unreachable; cricket never noticed because it declined the primitive
   * entirely. An EMPTY array is the new "not applicable right now" (no sub
   * currently legal to OFFER — as opposed to legal-but-refused, which is
   * `policyOk: false` on a slot that IS returned, so the scorer still gets to
   * see the sport's own reason).
   *
   * Still optional: omit the method entirely for a sport with no in-play
   * substitutions at all (boardgame, carrom singles, generic — design §3's own
   * table), the same "absent means never applicable" convention `context`
   * already uses one line up. Cricket omits it, and stayed untouched by this
   * change for exactly that reason.
   */
  swap?(view: View): SwapSlot[];
  /**
   * R3 review round — the event types this sport's own fold will REFUSE in the
   * current view, whatever the pad might otherwise draw. The generic More
   * sheet's SECOND exclusion set, alongside `dedicatedEventTypes`.
   *
   * The two sets exclude for opposite reasons and are deliberately kept apart
   * rather than unioned into one variable: `dedicated` means "already reachable
   * through a better, narrowed surface", and this means "not reachable at all
   * right now". Merging them would leave a later reader unable to tell a
   * de-duplication from a phase refusal.
   *
   * WHY THE CHASSIS CANNOT COMPUTE THIS ITSELF. `padSpec(cfg)` carries a
   * `PadGate` per panel, and a sport that expresses every phase rule as a gate
   * needs nothing here. Football does not: `applyGoal`/`applySub`/`applyShot`/
   * `applySinBin*`/`applyPenalty` each guard on `isPlayPhase(state.phase)`
   * INSIDE the fold, while their panels are ungated `phase: "live"` — and
   * football's own `PadPhase` mapping puts SHOOTOUT in "live" (it IS a phase of
   * the match). So the More sheet listed goal, sub, shot and both sin-bin
   * forms during a shoot-out, every one of them WRONG_PHASE on tap and two of
   * them reachable at band 0. That was found by the R3 review pass, and it is
   * the same "never offer what the engine will refuse" rule R2b and R2c each
   * applied to cricket's tiles and candidate lists.
   *
   * A SKIN THAT DECLARES THIS IS MIRRORING ITS OWN ENGINE, which is the thing
   * this programme keeps getting wrong — so the obligation comes with it: the
   * skin owes a test that drives the real fold and proves nothing it leaves
   * unrefused is refused (football's is the `phaseVerdict` sweep in
   * `__tests__/football-dispatch-totality.test.ts`). A mirror agrees with
   * itself; only the fold can referee.
   *
   * FAILS OPEN. Omit the method and nothing is excluded — every skin written
   * before this renders exactly as it did, and a sport whose gates already
   * live in `padSpec` never needs it.
   */
  refusedEventTypes?(view: View): readonly string[];
  /**
   * R6/task A (owner ruling R6-4) — THE PAD'S CLOCK, opted into one sport at a
   * time exactly like `phase`/`context`/`swap` above.
   *
   * Returns the engine phase the clock counts within (plus, optionally, the
   * seconds the FOLD already knows about in that phase), or `null` when this
   * sport has no clock right now — before kick-off, at full time, or in a
   * phase where a running clock would be a lie. Omit the method entirely for a
   * sport with no clock at all, which is every skin written before this wave
   * and most of the ones after it.
   *
   * WHY THIS IS THE SEAM AND NOT A CHASSIS-WIDE FLAG. `../clock.ts` explains
   * what the clock IS; what only the skin can supply is the two facts in
   * `PadClockSpec`. The chassis has no sport vocabulary — `PadHostView.phase`
   * is the three-value UI concept and NEVER an engine phase token — so it
   * cannot name the period a stamp belongs to. And the seed is
   * `state.asOf.elapsed` guarded against a stamp left over from a phase the
   * match has since left, which needs the state's own shape.
   *
   * DECLARING THIS TURNS ON THE STAMP. `pad-host.tsx` attaches `at` to every
   * event it dispatches while a clock exists, and this method is the only
   * switch. That is deliberate: an unclocked pad's payloads are the tile's own
   * objects, untouched and byte-identical to the pre-R6 build.
   *
   * WHAT IT DOES NOT DO: it never says whether the clock is RUNNING. Starting
   * and pausing is the scorer's, held in the host's own state and reset only
   * when this method's `period` changes. A skin returning a different `period`
   * is therefore declaring a whistle, and the origin resets; returning the
   * same one every render costs nothing and is the normal case.
   */
  clock?(view: View): PadClockSpec | null;
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
  /**
   * R6 fix pass 2 (gap 2) — THE HOST CLOCK'S LIVE READING, so a skin can show a
   * number that changes between events.
   *
   * The `at` this host would put on an event dispatched right now: exactly
   * `stampOf(clock, nowMs)`, the SAME derivation the `send` gateway stamps
   * with, never a second one. `undefined` when this pad has no clock, or has
   * one that has never been told the time (`PadClock.known` — a pad displaying
   * 0:00 because it has nothing better to display must not drive a countdown
   * from that zero).
   *
   * WHY IT EXISTS. `ActiveSuspension.expiresAt` is derived once, at the card,
   * from the stamped `at` plus the awarded minutes, and the kernel's release is
   * LAZY — swept at the next stamped event and at each whistle (kernel.ts:
   * 842-843 says so in as many words). A skin measuring a countdown against
   * `state.asOf` therefore measures against the last thing anybody RECORDED:
   * hockey showed "back on 2:00" at the card and still 2:00 two minutes later,
   * and still 2:00 after the player was back. The most urgent number on the
   * band never moved. Nothing in this bag could reach live seconds, so no skin
   * could fix it on its own.
   *
   * WHY THE PERIOD COMES WITH IT, and why this is not "a second clock". The
   * countdown must not subtract across a whistle — `expiresAt.period` routinely
   * differs from the period being played — so a bare number would force every
   * reader to ASSUME the host is counting within the phase it happens to be
   * looking at. The host knows which period it is stamping; it says so. What a
   * skin must NOT be handed is `PadClock` itself (`base`/`runningSince`/
   * `known`), which would let it run its own arithmetic and drift from the
   * stamp `send` actually applies.
   *
   * DISPLAY ONLY. This never becomes an `at` on a payload and never corrects
   * the fold: the ENGINE's laziness is correct and is not to be "fixed" from
   * here. A ticking display and a lazily-swept state legitimately disagree
   * between events.
   */
  readonly clockAt?: GameTimeStamp;
}

export function assertScorebugSpec(spec: ScorebugSpec): string[] {
  const out: string[] = [];
  spec.halves.forEach((h, i) => {
    if (h.tappable && !h.hintKey) out.push(`halves[${i}]: tappable requires hintKey`);
    if (h.tappable && !h.tapEvent) out.push(`halves[${i}]: tappable requires tapEvent`);
    if (!h.who.length) out.push(`halves[${i}]: who must be non-empty`);
  });
  return out;
}
