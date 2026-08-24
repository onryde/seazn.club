// Football SkinDefV3 — R3/task B2, the wave's centrepiece. Converts football
// to the v3 chassis (design of record `docs/superpowers/specs/2026-08-15-
// scoringpad-v3-redesign-design.md` §2/§3, wave brief `.../2026-08-15-
// scoringpad-v3-prompts/R3-football.md`, rulings R3-1..R3-5 in `_INDEX.md`).
// Replaces `../../skins/football-skin.tsx` (v2, left on disk — R8 deletes it)
// as the sport's PAD surface; nothing here imports or is imported by it.
//
// PURE DATA, no React: every `SkinDefV3` method returns plain data, the same
// testability stance every other v3 primitive takes (apps/web vitest is
// `environment: "node"`, no jsdom). `.tsx` only because the sibling skins are.
//
// FACTORY, not a bare object — `ScorebugSpec.context`/`WhoLine.name`/
// `DockSpec.title` and every `Blocked` reason are PRE-RESOLVED text, while no
// `SkinDefV3` method receives a `t` (R1 ruling). `V3_SKINS` is built at module
// evaluation, before any request has picked a locale, so it can only ever hold
// the factory (registry.ts's own header has the full reasoning).
//
// EVENT VOCABULARY (9 `football.*` types, `FOOTBALL_EVENT_SCHEMAS`). Where
// each is reachable, per ruling R3-4:
//   goal / card / sub / period / penalty  — dedicated tiles + sheets here
//   shot / sinbin.start / sinbin.end / shootout.kick — the generic More sheet
// `__tests__/football-dispatch-totality.test.ts` sweeps all nine across the
// whole cfg space rather than trusting this comment.
//
// THREE ENGINE FACTS THIS FILE MIRRORS RATHER THAN IMPORTS (the closed
// vocabularies below, and `periodMarkersOf`). Football's barrel exports the
// module and its zod schemas but neither `padSpec` nor the private
// `periodMarkers`, and cricket's own skin establishes the mirror-with-a-
// comment precedent for exactly this. Every mirror is PINNED against the
// engine's own `padSpec(cfg)` in this skin's test file, so a module change
// reds there instead of drifting silently.
//
// WHAT THIS SKIN DELIBERATELY DOES NOT DECLARE:
//   - `context()`. Football has no persistent per-person slot the fold could
//     hold (no striker/bowler equivalent), so a strip would be affordance with
//     nothing behind it. `contextSelect` follows it out.
//   - a "pre" or "post" tile. Every panel `padSpec(cfg)` declares is
//     `phase: "live"` (football.ts's own comment: "every one of this module's
//     types is a live action"), and `buildPadView` drops a panel whose phase
//     is not the current one, so `createSkinDispatch` REFUSES any dispatch at
//     pre/post. A pre-kickoff card is legal in the FOLD (`applyCard` allows
//     phase "pre") but unreachable from any declared pad surface — an
//     engine-side asymmetry recorded in this wave's report, not worked around
//     here with a tile that throws on tap.
"use client";
import type { FidelityBand } from "@seazn/engine/sport";
import type { MessageKey } from "@/lib/messages";
import { ENUM_VOCAB } from "@/lib/scoring-vocab";
import {
  MORE_SHEET_KEY,
  type ActivityDetailContext,
  type Blocked,
  type DockChip,
  type DockSpec,
  type GuidedSheetSpec,
  type GuidedSheetStep,
  type PadHostView,
  type PadPhase,
  type ScorebugSpec,
  type SkinDefV3,
  type StripItem,
  type SwapSlot,
  type TileSpec,
} from "../types";

export type TFn = (key: string, vars?: Record<string, string | number>) => string;
export type Side = "home" | "away";
export type CardColor = "yellow" | "red" | "second_yellow";

// ---------------------------------------------------------------------------
// Closed vocabularies, MIRRORED from packages/engine/src/sports/football/
// football.ts (see this file's header for why mirrored, and where the drift
// pins live). Scouted 2026-08-24 against `CardColor` (:221), `CardReason`
// (:226), `PenaltyOutcome` (:305) and `padSpec`'s own `fidelity` map (:2380).
// ---------------------------------------------------------------------------

/** R3-1: THREE colours, not two. The brief's "yellow/red" is recorded false in
 *  `_INDEX.md` — `second_yellow` is its own colour in the engine, carries its
 *  own suspension tariff, and already has copy in all four locales
 *  (`cardColor.second_yellow`, scoring-vocab.ts). */
export const CARD_COLORS: readonly CardColor[] = ["yellow", "red", "second_yellow"];

/** Law 12.3 cautionable + Law 12.4 sending-off offences, in the engine's own
 *  order. `FootballCard.reason` is `.optional()`, which is what lets bands 0-1
 *  commit a card without ever asking. */
export const CARD_REASONS: readonly string[] = [
  "unsporting_behaviour",
  "dissent",
  "persistent_offences",
  "delaying_restart",
  "failure_to_respect_distance",
  "entering_or_leaving_without_permission",
  "serious_foul_play",
  "violent_conduct",
  "spitting",
  "denying_goal_by_handball",
  "denying_obvious_goalscoring_opportunity",
  "offensive_language",
  "second_caution",
];

/** The shared attempt vocabulary MINUS `scored`: a converted penalty is a
 *  `football.goal {penalty: true}`, and accepting "scored" here would let one
 *  kick be counted twice (`PenaltyOutcome`'s own doc). */
export const PENALTY_OUTCOMES: readonly string[] = ["saved", "missed", "post"];

/**
 * One band per event type — `padSpec(cfg).fidelity` verbatim.
 *
 * Read by `buildTiles` for a reason the chassis's own band filter cannot
 * cover: `filterTilesByBand` (pad-host.tsx) filters on the bands the org is
 * ENTITLED to, while `buildPadView` drops an action whose band exceeds the
 * ACTIVE band (`view-model.ts:133`) — and `createSkinDispatch` refuses
 * anything the resulting view does not declare. So an entitled org scoring at
 * band 0 would SEE every card/sub tile and every tap would throw. Withholding
 * them here is the same "never offer what the engine will refuse" rule the
 * rest of this programme keeps applying, one layer earlier.
 */
export const EVENT_BAND: Readonly<Record<string, FidelityBand>> = {
  "football.goal": 0,
  "football.period": 0,
  "football.shootout.kick": 0,
  "football.card": 2,
  "football.sub": 2,
  "football.penalty": 2,
  "football.sinbin.start": 2,
  "football.sinbin.end": 2,
  "football.shot": 3,
};

/** The phases in which the ball is in play — `PLAY_PHASES` (football.ts:628).
 *  A goal, a substitution, a penalty and a period marker are all refused
 *  outside one (`isPlayPhase` guards each `apply*`); a CARD is not, which is
 *  why the card tiles are not gated on this. */
const PLAY_PHASES = new Set(["H1", "H2", "Q2", "Q3", "Q4", "ET_H1", "ET_H2"]);

/** Phases in which the match is over — `applyCard`'s own refusal set, and the
 *  three that map to `PadPhase` "post". */
const POST_PHASES = new Set(["done", "final", "abandoned"]);

// ---------------------------------------------------------------------------
// State/cfg readers. `PadHostView.state`/`.cfg` are `unknown` by contract;
// every reader degrades cleanly from `{}` (the shape the dispatch-totality
// sweep and several unit fixtures use), never throws.
// ---------------------------------------------------------------------------

interface GameTimeShape { period: string; elapsed: number }

interface FootballSquadShape {
  onPitch?: string[];
  bench?: string[];
  offUsed?: string[];
  sentOff?: string[];
  subWindows?: GameTimeShape[];
}

interface FootballStateShape {
  phase?: string;
  entrants?: { home?: string; away?: string };
  goals?: { home?: number; away?: number };
  periods?: { phase?: string; addedMinutes?: number }[];
  cards?: { side?: string; person?: string; color?: string }[];
  squads?: { home?: FootballSquadShape; away?: FootballSquadShape };
  asOf?: GameTimeShape;
}

interface FootballCfgShape {
  halves?: 2 | 4;
  extraTime?: { enabled?: boolean };
  rollingSubs?: boolean;
  maxSubs?: number;
  subWindows?: number;
  teamSize?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asState(state: unknown): FootballStateShape {
  return asRecord(state) as FootballStateShape;
}

function asCfg(cfg: unknown): FootballCfgShape {
  return asRecord(cfg) as FootballCfgShape;
}

/** football.ts's own `Phase` union read as a bare string. "pre" is the
 *  documented starting value (`init` always sets it), so an unfolded state
 *  reads as pre-kickoff rather than as a live match — v2's own `readPhase`
 *  (skins/football-skin.tsx:96) takes the identical position. */
function readPhase(state: unknown): string {
  const phase = asState(state).phase;
  return typeof phase === "string" && phase.length > 0 ? phase : "pre";
}

function squadOf(state: FootballStateShape, side: Side): Required<Pick<FootballSquadShape, "onPitch" | "bench" | "offUsed" | "sentOff">> & { subWindows: GameTimeShape[] } {
  const squad = state.squads?.[side] ?? {};
  return {
    onPitch: squad.onPitch ?? [],
    bench: squad.bench ?? [],
    offUsed: squad.offUsed ?? [],
    sentOff: squad.sentOff ?? [],
    subWindows: squad.subWindows ?? [],
  };
}

/** The real entrant id, straight off `state.entrants` (present from football's
 *  very first fold). Falls back to the literal side name only for a pad
 *  mounted before any state exists — which the server refuses anyway, rather
 *  than this file fabricating a plausible id. Same reader v2 ships
 *  (`readEntrantId`, football-skin.tsx:133). */
function entrantOf(state: FootballStateShape, side: Side): string {
  const id = state.entrants?.[side];
  return typeof id === "string" && id.length > 0 ? id : side;
}

const SIDE_LABEL: Record<Side, MessageKey> = {
  home: "scorepad.attribution.home",
  away: "scorepad.attribution.away",
};

const SIDES: readonly Side[] = ["home", "away"];

/**
 * MM:SS, only when the fold's own `asOf` names the CURRENT phase — and
 * `undefined` when it does not.
 *
 * The guard is v2's (`readClock`, skins/football-skin.tsx:115), which mirrors
 * the one football's own (unexported) `footballPosition` applies: a stamp left
 * over from a phase the match has since left must never read as "now".
 * `buildSwap` below depends on this same decision for the `at` it stamps, so
 * the two can never disagree about whether the clock is current.
 *
 * B3 changed the MISS from v2's "—" placeholder to `undefined`, so the caller
 * can drop the strip item rather than render a labelled em-dash forever. The
 * clock is genuinely reachable — `state.asOf` is a `GameTime` the fold keeps
 * (`{...swept, asOf: at}`, football.ts:2528) — but ONLY a stamped event sets
 * it, and no v3 tile sends `at` except the swap, which copies an `asOf` that
 * already exists. A stream recorded entirely through this pad therefore has
 * no clock at all, which is exactly the case the placeholder was papering
 * over. Restoring the value is an engine-side question (nothing here can
 * bootstrap a stamp), recorded in this wave's report rather than faked.
 */
export function readClock(state: unknown, phase: string): string | undefined {
  const asOf = asState(state).asOf;
  const elapsed = asOf?.elapsed;
  if (asOf?.period !== phase || typeof elapsed !== "number" || !Number.isFinite(elapsed) || elapsed < 0) {
    return undefined;
  }
  return `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`;
}

/**
 * The stamp a NEW event may carry, or `undefined`.
 *
 * R3-2 rules a substitution is stamped, and `_INDEX.md`'s own "where the `at`
 * stamp comes from" note fixes the source as the fold's `asOf` — the same
 * `GameTime` `readClock` reads — WITH the staleness guard: if `asOf` is
 * missing, or names a phase the match has left, OMIT `at` rather than stamp a
 * wrong one. `at` is `.optional()` on every football payload, so omitting is
 * legal; the cost is that the substitution consumes no window, which is the
 * honest failure. A WRONG stamp silently mis-attributes a stoppage — and,
 * through `applySub`'s window arithmetic, could refuse a legal substitution or
 * admit an illegal one. Do not "fix" this later by stamping unconditionally.
 */
function stampOf(state: FootballStateShape): GameTimeShape | undefined {
  const asOf = state.asOf;
  if (!asOf || asOf.period !== readPhase(state)) return undefined;
  if (typeof asOf.elapsed !== "number" || !Number.isFinite(asOf.elapsed) || asOf.elapsed < 0) return undefined;
  return { period: asOf.period, elapsed: asOf.elapsed };
}

/**
 * The `football.period` markers THIS cfg's fold accepts — mirrors the engine's
 * own private `periodMarkers` (football.ts:2157) so the sheet can never offer
 * a marker `applyPeriod` would then refuse for the wrong mode. Quarters
 * (`halves === 4`) get QT/HT/3QT/FT — Q1 itself reuses "H1" and is never a
 * marker; halves get HT/FT. Both gain ET_HT/ET_FT when extra time is enabled,
 * because `applyPeriod`'s ET arms are not gated on the halves mode at all.
 */
export function periodMarkersOf(cfg: unknown): readonly string[] {
  const c = asCfg(cfg);
  return [
    ...(c.halves === 4 ? ["QT", "HT", "3QT", "FT"] : ["HT", "FT"]),
    ...(c.extraTime?.enabled === true ? ["ET_HT", "ET_FT"] : []),
  ];
}

/**
 * The period a SCORER would name it, never the fold's own token.
 *
 * B3 (rendered-board review): the scorebug strip printed `Period H1`. "H1",
 * "ET_H2" and "SHOOTOUT" are internal literals of football's `Phase` union
 * (football.ts:458) — the strip is the most space-constrained surface in the
 * product and not the place to teach a scorer the engine's vocabulary.
 *
 * Skin-local rather than a `matchPhase.*` addition, for a reason the shared
 * table structurally cannot hold: "H1" is AMBIGUOUS. Quarters mode
 * (`cfg.halves === 4`) reuses it as quarter 1 — deliberately, so `core.start`
 * always pushes "H1" and needs no cfg branch (football.ts:454's own comment)
 * — so only football's own cfg can read the token. Extra time is the other
 * way round and is DELEGATED below: `matchPhase.ET_H1`/`ET_H2` already carry
 * exactly this prose, and one value must not gain a second wording.
 */
const PHASE_LABEL: Readonly<Record<string, MessageKey>> = {
  pre: "pad.football.phase.pre",
  H1: "pad.football.phase.H1",
  H2: "pad.football.phase.H2",
  Q2: "pad.football.phase.Q2",
  Q3: "pad.football.phase.Q3",
  Q4: "pad.football.phase.Q4",
  SHOOTOUT: "pad.football.phase.SHOOTOUT",
  done: "pad.football.phase.done",
  final: "pad.football.phase.final",
  abandoned: "pad.football.phase.abandoned",
};

/** The ONE literal quarters mode renames. Q2-Q4 have their own literals and
 *  read identically in both modes, so they are not repeated here. */
const QUARTER_PHASE_LABEL: Readonly<Record<string, MessageKey>> = {
  H1: "pad.football.phase.Q1",
};

export function phaseLabel(phase: string, cfg: unknown, t: TFn): string {
  const own = (asCfg(cfg).halves === 4 ? QUARTER_PHASE_LABEL[phase] : undefined) ?? PHASE_LABEL[phase];
  if (own !== undefined) return t(own);
  const shared = vocabKey("phase", phase); // ET_H1 / ET_H2
  // An unmapped token prints VERBATIM, the same position `vocabText` takes: a
  // missing label is a copy finding, and printing the token is what makes it
  // visible instead of a plausible-looking guess.
  return shared !== null ? t(shared) : phase;
}

// ---------------------------------------------------------------------------
// Vocabulary lookup — the same `ENUM_VOCAB` path cricket's own skin uses, so
// one enum value has one label across both lanes and every sport.
// ---------------------------------------------------------------------------

function vocabKey(field: string, value: string): MessageKey | null {
  for (const map of ENUM_VOCAB[field] ?? []) {
    const key = map[value];
    if (key) return key;
  }
  return null;
}

/** The localised label for an enum value, or the raw token when the shared
 *  vocabulary has none. Never a humanised guess: an unmapped token is a
 *  missing-copy finding, and printing it verbatim is what makes it visible. */
function vocabText(field: string, value: unknown, t: TFn): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const key = vocabKey(field, value);
  return key ? t(key) : value;
}

// ---------------------------------------------------------------------------
// phase() — G3 / R3-4. OPT-IN: a skin that omits this silently keeps the
// tab-shaped behaviour D-16 describes, so declaring it IS the deliverable.
// Football's richer engine phases map DOWN to the three-value `PadPhase`;
// SHOOTOUT joins "live" (it is a phase of the MATCH, and cards are legal in
// it), and `PadPhase` is never widened to carry a sub-phase of its own.
// ---------------------------------------------------------------------------

export function resolvePhase(view: Pick<PadHostView, "state">): PadPhase {
  const phase = readPhase(view.state);
  if (phase === "pre") return "pre";
  if (POST_PHASES.has(phase)) return "post";
  return "live"; // H1 | H2 | Q2..Q4 | ET_H1 | ET_H2 | SHOOTOUT
}

// ---------------------------------------------------------------------------
// scorebug() — tapModel T: both halves are READOUTS. A Model-S half is a tap
// target that scores; football scores through the Goal tiles, so declaring
// `tappable` here would give one event two entry points.
// ---------------------------------------------------------------------------

export function buildScorebug(view: PadHostView, t: TFn): ScorebugSpec {
  const state = asState(view.state);
  const cfg = asCfg(view.cfg);
  const phase = readPhase(state);

  // The context band states the FORMAT, which is exactly what a small-sided,
  // youth or mini-soccer variant changes ("Small-sided/youth/mini variants
  // shrink via cfg only" — the wave brief). Always non-empty: the band renders
  // unconditionally (scorebug.tsx), and 11-a-side is a format like any other.
  const contextParts = [t("pad.football.context.smallSided", { size: cfg.teamSize ?? 11 })];
  if (cfg.halves === 4) contextParts.push(t("pad.football.context.quarters"));

  // strip = period · clock (the wave brief's own words for this scorebug).
  // The period is PROSE — `phaseLabel` above, which reads the cfg because the
  // "H1" token means quarter 1 in quarters mode. v2 showed the raw token here
  // (football-skin.tsx:141) and B2 carried that over; B3 closes it.
  const strip: StripItem[] = [
    { id: "period", label: t("scorepad.skin.football.header.period"), value: phaseLabel(phase, view.cfg, t) },
  ];
  // OMITTED, not blanked, when nothing has stamped a clock (see `readClock`):
  // a labelled em-dash that can never fill in is dead weight on the most
  // space-constrained surface in the product.
  const clock = readClock(state, phase);
  if (clock !== undefined) {
    strip.push({ id: "clock", label: t("scorepad.skin.football.header.clock"), value: clock, accent: true });
  }
  // Law 7 added time, stamped by the fold on the period a marker CLOSES. A
  // bare "+3" is locale-invariant (the same reasoning `TileSpec.sublabelText`
  // documents for a bare number), so it needs no key of its own.
  const added = state.periods?.[state.periods.length - 1]?.addedMinutes;
  if (typeof added === "number" && added > 0) strip.push({ id: "added", value: `+${added}` });

  return {
    context: contextParts.join(" · "),
    phase: resolvePhase(view),
    halves: [
      { who: [{ name: t(SIDE_LABEL.home) }], big: String(state.goals?.home ?? 0) },
      { who: [{ name: t(SIDE_LABEL.away) }], big: String(state.goals?.away ?? 0) },
    ],
    strip,
  };
}

// ---------------------------------------------------------------------------
// tiles() — §2.5. Per-side Goal / Card / Sub columns, Period shared, Pen
// minor, More carrying the rest (ruling R3-4).
//
// TWO VERTICAL LANES ARE THE BOARD'S ORGANISING IDEA: Home on the left, Away
// on the right, so a scorer addresses a team by POSITION and never has to
// select one. Every tile that belongs to a side therefore spans exactly HALF
// the chassis's 4-column grid, and the two sides of one action are pushed
// adjacently so each pair fills one row:
//
//   [ Goal · Home ][ Goal · Away ]
//   [ Card · Home ][ Card · Away ]
//   [ Sub  · Home ][ Sub  · Away ]
//   [ End of period ][ Penalty   ]
//   [           More             ]
//
// B3 (rendered-board review, 2026-08-24) found the card column breaking it:
// three tiles per side (yellow 1 + red 1 + second yellow 2) filled a FULL row
// per side, so Home's second yellow rendered in columns 3-4 — bodily inside
// the AWAY lane, directly under "Goal · Away". Ruling R3-1's "[Yellow] [Red]
// [2nd Yellow] inline" was read as a row of TILES; it is one Card tile whose
// sheet opens on the colour. The cost is deliberate and was weighed: a card
// now takes two taps rather than one, and cards are far rarer than goals.
// `__tests__/football.test.ts` pins the lane geometry itself (span AND the
// column each side lands in) so the next wave cannot re-break it silently.
// ---------------------------------------------------------------------------

/** Sheet key for one side's card. ONE per side, not one per colour: the colour
 *  is the sheet's own first step, so the tile stays inside its lane. */
export function cardSheetKey(side: Side): string {
  return `card-${side}`;
}

export function swapSlotId(side: Side): string {
  return `sub-${side}`;
}

/** Whether this event may be dispatched at the ACTIVE band — see `EVENT_BAND`. */
function withinBand(eventType: string, band: FidelityBand): boolean {
  const declared = EVENT_BAND[eventType];
  return declared === undefined || declared <= band;
}

export function buildTiles(view: PadHostView): TileSpec[] {
  const state = asState(view.state);
  const inPlay = PLAY_PHASES.has(readPhase(state));
  const band = view.band;
  const tiles: TileSpec[] = [];

  // Goal — commits SIDE-LEVEL on tap. Honest: `scorer`/`assist` are both
  // `.optional()` on `FootballGoal` (football.ts:213-214), so the event the
  // engine receives is complete without them. The dock then offers the
  // attribution (`buildDock`), which is the D-14 "ask only what varies" shape
  // rather than a modal before every goal.
  if (inPlay && withinBand("football.goal", band)) {
    for (const side of SIDES) {
      tiles.push({
        id: `goal-${side}`,
        label: "pad.football.action.goal",
        sublabel: SIDE_LABEL[side],
        kind: "primary",
        span: 2,
        phases: ["live"],
        action: { event: { type: "football.goal", payload: { by: entrantOf(state, side) } } },
      });
    }
  }

  // Card — legal in every phase except a decided match (`applyCard`), so
  // deliberately NOT gated on `inPlay`: a card during the shoot-out is a real
  // scoring moment this pad must still reach. ONE tile per side (see this
  // section's header): the colour is the sheet's first step, and the person
  // still arrives through the dock, exactly as R3-1 rules.
  if (!POST_PHASES.has(readPhase(state)) && withinBand("football.card", band)) {
    for (const side of SIDES) {
      tiles.push({
        id: cardSheetKey(side),
        label: "pad.football.action.card",
        sublabel: SIDE_LABEL[side],
        kind: "standard",
        span: 2,
        phases: ["live"],
        action: { sheet: cardSheetKey(side) },
      });
    }
  }

  // Sub — one tile per side, each addressing its OWN `SwapSlot` (R3-5's
  // defect 1: a bare `{swap:true}` could only ever open one sheet, so per-side
  // Sub tiles were structurally unreachable before the chassis fix).
  if (inPlay && withinBand("football.sub", band)) {
    for (const side of SIDES) {
      tiles.push({
        id: swapSlotId(side),
        label: "pad.football.action.sub",
        sublabel: SIDE_LABEL[side],
        kind: "standard",
        span: 2,
        phases: ["live"],
        action: { swap: swapSlotId(side) },
      });
    }
  }

  if (inPlay && withinBand("football.period", band)) {
    tiles.push({
      id: "period",
      // The SKIN's own word, not `pad.football.action.period` — that is the
      // ENGINE's action label ("Period marker"), and nobody standing on a
      // touchline thinks "period marker". This one has to generalise across
      // halves, quarters AND extra time, because `periodMarkersOf` yields
      // HT/FT, QT/3QT and ET_HT/ET_FT depending on cfg; the sheet behind it
      // ("Which break?") names the specific one.
      label: "pad.football.action.periodEnd",
      kind: "standard",
      span: 2,
      phases: ["live"],
      action: { sheet: "period" },
    });
  }

  if (inPlay && withinBand("football.penalty", band)) {
    tiles.push({
      id: "penalty",
      label: "pad.football.action.penalty",
      kind: "minor",
      span: 2,
      phases: ["live"],
      action: { sheet: "penalty" },
    });
  }

  // More — `football.shot`, `football.sinbin.start`, `football.sinbin.end` and
  // `football.shootout.kick` ride the chassis's generic sheet (R3-4), which
  // builds itself from `padSpec(cfg)` and therefore picks up the shoot-out
  // panel exactly when its own cfg + state gate opens. Never band-filtered
  // (`tileEventType` returns null for the More key, deliberately): MORE is
  // where a LOW-band org reaches its only recording actions.
  tiles.push({
    id: "more",
    label: "scorepad.skin.more",
    kind: "minor",
    span: 4,
    phases: ["live"],
    action: { sheet: MORE_SHEET_KEY },
  });

  return tiles;
}

// ---------------------------------------------------------------------------
// sheets() — a METHOD of the view (G4), rebuilt every render so a closed-over
// entrant id or cfg marker list can never go stale. No `t`: every `title` and
// `options[].label` here is an i18n KEY the chassis resolves itself.
// ---------------------------------------------------------------------------

/**
 * The card sheet for one side. `Which card?` then `Offence?`, the second gated
 * at band ≥2 (R3-1); the PERSON is not asked here at all — the dock offers the
 * on-pitch chips after the card commits, which is what keeps one field to one
 * entry point.
 *
 * The colour step is B3's: it was six TILES until the rendered board showed
 * what that did to the two lanes (see `buildTiles`'s header). `color` is
 * REQUIRED on `FootballCard`, so this step carries no `when` — the sheet can
 * never be fully gated off, and `second_yellow` stays its own colour rather
 * than a red with a note, because the engine reads the suspension tariff off
 * the reason and not the colour.
 *
 * `reason` is `.optional()` on `FootballCard` (football.ts:249), which is what
 * makes its gate honest rather than a shortcut: at bands 0-1 the engine
 * accepts a card with no offence, so asking would be a wasted tap — the D-15
 * defect this chassis exists to remove.
 *
 * The predicate closes over the view's band rather than reading an answer,
 * which `StepPredicate` permits (it is evaluated at render, against whatever
 * the skin knows). `buildTiles` still withholds the card tile below band 2
 * entirely — `football.card` is a band-2 event, and a tile the ACTIVE band
 * refuses would throw through `createSkinDispatch` on tap.
 */
function cardSheet(view: PadHostView, side: Side): GuidedSheetSpec {
  const by = entrantOf(asState(view.state), side);
  const asksOffence = view.band >= 2;
  const steps: GuidedSheetStep[] = [
    {
      id: "color",
      kind: "choice",
      title: "pad.football.sheet.card.color.title",
      // `cardColor.*` is the shared vocabulary both lanes already use, so no
      // new copy and no second wording for a colour.
      options: CARD_COLORS.map((colour) => ({ id: colour, label: vocabKey("color", colour) ?? colour })),
    },
    {
      id: "reason",
      kind: "choice",
      title: "pad.football.sheet.card.reason.title",
      options: CARD_REASONS.map((reason) => ({ id: reason, label: vocabKey("reason", reason) ?? reason })),
      when: () => asksOffence,
    },
  ];
  return {
    event: "football.card",
    steps,
    buildPayload: (answers) => ({
      by,
      color: answers.color,
      ...(answers.reason ? { reason: answers.reason } : {}),
    }),
  };
}

/** Which break this whistle closes. `FootballPeriod` carries no `by` — a
 *  whistle belongs to neither side — so this sheet has exactly one step. */
function periodSheet(view: PadHostView): GuidedSheetSpec {
  return {
    event: "football.period",
    steps: [
      {
        id: "marker",
        kind: "choice",
        title: "pad.football.sheet.period.marker.title",
        options: periodMarkersOf(view.cfg).map((marker) => ({
          id: marker,
          label: vocabKey("phase", marker) ?? marker,
        })),
      },
    ],
    buildPayload: (answers) => ({ phase: answers.marker }),
  };
}

/** Which side was awarded it, then what happened. `outcome` is REQUIRED on
 *  `FootballPenalty` (it is what keeps the branch structurally distinct inside
 *  the event union), so unlike the card's offence it can never be skipped —
 *  and "scored" is deliberately absent: a converted penalty is a
 *  `football.goal {penalty: true}`, not this event. */
function penaltySheet(view: PadHostView): GuidedSheetSpec {
  const state = asState(view.state);
  return {
    event: "football.penalty",
    steps: [
      {
        id: "by",
        kind: "choice",
        title: "pad.football.sheet.penalty.by.title",
        options: SIDES.map((side) => ({ id: entrantOf(state, side), label: SIDE_LABEL[side] })),
      },
      {
        id: "outcome",
        kind: "choice",
        title: "pad.football.sheet.penalty.outcome.title",
        options: PENALTY_OUTCOMES.map((outcome) => ({ id: outcome, label: vocabKey("outcome", outcome) ?? outcome })),
      },
    ],
    buildPayload: (answers) => ({ by: answers.by, outcome: answers.outcome }),
  };
}

export function buildSheets(view: PadHostView): Record<string, GuidedSheetSpec> {
  const sheets: Record<string, GuidedSheetSpec> = {
    period: periodSheet(view),
    penalty: penaltySheet(view),
  };
  for (const side of SIDES) sheets[cardSheetKey(side)] = cardSheet(view, side);
  return sheets;
}

// ---------------------------------------------------------------------------
// swap() — R3-2 + R3-5, the wave's centrepiece. PLURAL: one slot per side,
// each addressed by that side's own Sub tile.
//
// `FootballSub.off`/`.on` are both REQUIRED `PersonId` (football.ts:254-255),
// which is precisely why a substitution is a two-step sheet and not a tile
// that commits on tap the way Goal does.
// ---------------------------------------------------------------------------

/**
 * The two INDEPENDENT caps Law 3 puts on substitutions, and the copy for each.
 *
 * `maxSubs` counts PLAYERS (`lineupPolicy`, football.ts:1756 -> the kernel's
 * own cap), `subWindows` counts STOPPAGES (football.ts:1211). Neither implies
 * the other: five substitutions taken one at a time break the Law while never
 * reaching a five-player cap. The brief's single "3 of 3 subs used" example
 * covers the first only.
 *
 * WORDED HERE, IN FOUR LOCALES, rather than forwarded from the engine.
 * `SwapSlot.policyMessage` documents "reduceLineupEvent's `.message`, never
 * its `.reason`" — that rule is about never putting a MACHINE SLUG on screen,
 * and it is satisfied strictly better by localised prose: there is no
 * server-side i18n in this repo, so an engine message reaches every scorer in
 * English (`use-pad-pipeline.ts`'s own note). Cricket set this precedent for
 * `pad.<sport>.context.<thing>.blocked.<reason>`, and `_INDEX.md` routes this
 * copy to the skin task explicitly.
 *
 * The window cap is evaluated against the stamp this skin would actually
 * SEND (`stampOf`, with its staleness guard) — not against "some stamp":
 * an unstamped substitution joins no window and consumes none, so refusing it
 * on a window cap would refuse a substitution the fold accepts. Equally, a
 * stamp EQUAL to a window the side has already opened joins that window rather
 * than opening a new one (three substitutions at one stoppage are one window),
 * so it must not refuse either.
 */
function subPolicy(
  state: FootballStateShape,
  cfg: FootballCfgShape,
  side: Side,
  t: TFn,
): { ok: boolean; message?: string } {
  const squad = squadOf(state, side);
  const rolling = cfg.rollingSubs === true;

  if (!rolling && cfg.maxSubs !== undefined && squad.offUsed.length >= cfg.maxSubs) {
    return {
      ok: false,
      message: t("pad.football.context.sub.blocked.maxSubs", { used: squad.offUsed.length, max: cfg.maxSubs }),
    };
  }

  const stamp = stampOf(state);
  if (stamp !== undefined && cfg.subWindows !== undefined) {
    const known = squad.subWindows.some((w) => w.period === stamp.period && w.elapsed === stamp.elapsed);
    if (!known && squad.subWindows.length >= cfg.subWindows) {
      return {
        ok: false,
        message: t("pad.football.context.sub.blocked.subWindows", {
          side: t(SIDE_LABEL[side]),
          windows: cfg.subWindows,
        }),
      };
    }
  }

  return { ok: true };
}

/**
 * Who may come ON, and who is visible-but-blocked.
 *
 * SCOPE (`candidates`) is everyone the KERNEL still knows about who is not on
 * the pitch — the bench, plus the already-substituted ("gone") members
 * `liftSide` (football.ts:2047) keeps in its own lift. Not the chassis's
 * `pool: "bench"`: `view.squads` degrades to `initSquads(lineups)` for this
 * sport (football's fold does not adopt the kernel's `SquadState`), i.e. the
 * KICKOFF sheet, which never moves again.
 *
 * ELIGIBILITY (`blocked`) keeps the ones the fold will refuse VISIBLE with the
 * reason beside the name — R2b's binding ruling. Two grounds:
 *   - already substituted off, under `reentry: "none"` (the non-rolling
 *     variants). Under `rollingSubs` the same player is legally back on the
 *     bench, so nothing is blocked at all.
 *   - sent off. Reachable only for a SUBSTITUTE shown a red card: an on-pitch
 *     player leaves `onPitch` and appears in neither list, while a benched one
 *     stays on the bench and would otherwise be offered.
 * Both wordings are name-free, matching cricket's `*.short` precedent: the
 * reason renders directly beside the name it would otherwise repeat, and width
 * at 320px is the scarcest thing on this surface.
 */
function onCandidates(state: FootballStateShape, cfg: FootballCfgShape, side: Side, t: TFn): { candidates: string[]; blocked: Blocked } {
  const squad = squadOf(state, side);
  const onPitch = new Set(squad.onPitch);
  const bench = squad.bench.filter((id) => !onPitch.has(id));
  const gone = squad.offUsed.filter((id) => !onPitch.has(id) && !squad.bench.includes(id));
  const rolling = cfg.rollingSubs === true;

  const blocked: Record<string, string> = {};
  const sentOff = new Set(squad.sentOff);
  for (const id of [...bench, ...gone]) {
    if (sentOff.has(id)) blocked[id] = t("pad.football.context.sub.blocked.sentOff.short");
    else if (!rolling && gone.includes(id)) blocked[id] = t("pad.football.context.sub.blocked.reentry.short");
  }
  return { candidates: [...bench, ...gone], blocked };
}

export function buildSwap(view: PadHostView, t: TFn): SwapSlot[] {
  const state = asState(view.state);
  const cfg = asCfg(view.cfg);
  // `applySub` refuses a substitution outside a play phase — including during
  // the shoot-out — so no slot is offerable there. An EMPTY array is the
  // contract's own "not applicable right now" (as opposed to
  // legal-but-refused, which is a returned slot with `policyOk: false`).
  if (!PLAY_PHASES.has(readPhase(state))) return [];

  return SIDES.map((side) => {
    const by = entrantOf(state, side);
    const policy = subPolicy(state, cfg, side, t);
    const { candidates, blocked } = onCandidates(state, cfg, side, t);
    const stamp = stampOf(state);
    return {
      id: swapSlotId(side),
      offLabel: "scorepad.skin.football.swap.off",
      onLabel: "scorepad.skin.football.swap.on",
      side,
      // Declared STATICALLY because the band filter runs at TILE-BUILD time,
      // before any pick exists. Nothing in the chassis can check it against
      // what `buildEvent` returns — this skin's own test file pins the pair,
      // which is the obligation `SwapSlot.eventType`'s doc states.
      eventType: "football.sub",
      policyOk: policy.ok,
      ...(policy.message === undefined ? {} : { policyMessage: policy.message }),
      offCandidates: squadOf(state, side).onPitch,
      candidates,
      blocked,
      buildEvent: (off, on) => ({
        type: "football.sub",
        payload: { by, off, on, ...(stamp === undefined ? {} : { at: stamp }) },
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// dock() — the held tap's own enrichment window (~6s). `payload` is the THIRD
// argument the chassis forwards (the held tap's own payload, captured at hold
// time): a goal's `by` is what narrows the scorer chips to the side that
// actually scored, and a card's `color` is what narrows its person chips.
// Without it a dock could only key on the event TYPE, which cannot tell a
// yellow from a second yellow.
// ---------------------------------------------------------------------------

/** A chip that sets ONE payload field, labelled with the person's own name.
 *  `labelText` (not `label`) because a display name is not a dictionary key —
 *  see `DockChip.labelText`, types.ts. */
function personChip(id: string, field: string, personId: string, labelText: string): DockChip {
  return { id, label: "pad.football.dock.person", labelText, mutate: (payload) => ({ ...payload, [field]: personId }) };
}

function nameOf(view: PadHostView, personId: string, t: TFn): string {
  return view.personNames[personId] ?? t("eventCopy.unknownPerson");
}

function sideOfEntrant(state: FootballStateShape, entrantId: unknown): Side | null {
  for (const side of SIDES) if (entrantOf(state, side) === entrantId) return side;
  return null;
}

export function buildDock(
  eventType: string,
  view: PadHostView,
  t: TFn,
  payload?: Record<string, unknown>,
): DockSpec | null {
  const state = asState(view.state);
  const side = sideOfEntrant(state, payload?.by);

  if (eventType === "football.goal") {
    const chips: DockChip[] = [
      // `ownGoal` and `penalty` are booleans on the SAME payload, so they are
      // dock toggles rather than tiles of their own — six goal tiles for four
      // flag combinations is exactly the fan-out §2.5 caps.
      { id: "ownGoal", label: "pad.football.dock.ownGoal", mutate: (p) => ({ ...p, ownGoal: true }) },
      { id: "penalty", label: "pad.football.dock.penalty", mutate: (p) => ({ ...p, penalty: true }) },
    ];
    // Attribution is the band-2 timeline, and both fields are skippable: the
    // dock closes on its own and the goal is already recorded.
    if (side !== null && view.band >= 2) {
      // ON PITCH only, for the SCORING side — `applyGoal` refuses a scorer who
      // is not on the pitch of `by`, own goals included (football.ts:1074).
      for (const id of squadOf(state, side).onPitch) {
        chips.push(personChip(`scorer:${id}`, "scorer", id, nameOf(view, id, t)));
      }
      for (const id of squadOf(state, side).onPitch) {
        chips.push(personChip(`assist:${id}`, "assist", id, t("pad.football.dock.assist", { name: nameOf(view, id, t) })));
      }
    }
    return { title: t("pad.football.dock.goal.title"), chips };
  }

  if (eventType === "football.card") {
    if (side === null) return { title: t("pad.football.dock.card.title"), chips: [] };
    const squad = squadOf(state, side);
    const sentOff = new Set(squad.sentOff);
    // `applyCard`'s own two refusals, applied to the LIST rather than caught
    // afterwards: a yellow to someone already on one must be recorded as
    // `second_yellow`, and a `second_yellow` without a prior yellow is
    // refused outright (football.ts:1119-1125).
    const priorYellow = new Set(
      (state.cards ?? [])
        .filter((card) => card.color === "yellow" && typeof card.person === "string")
        .map((card) => card.person as string),
    );
    const colour = payload?.color;
    const chips = squad.onPitch
      .filter((id) => !sentOff.has(id))
      .filter((id) => (colour === "yellow" ? !priorYellow.has(id) : colour === "second_yellow" ? priorYellow.has(id) : true))
      .map((id) => personChip(`person:${id}`, "person", id, nameOf(view, id, t)));
    return { title: t("pad.football.dock.card.title"), chips };
  }

  return null;
}

// ---------------------------------------------------------------------------
// activityDetail() — the ribbon's VARYING half.
//
// The nine `pad.football.ribbon.*` keys are var-free BASES ("Goal recorded"):
// `buildRibbon` resolves them with NO vars, so a `{scorer}` placeholder in one
// would render literally with nothing failing. Every name and flag reaches the
// line through `pad.ribbon.withDetail` = "{base} — {detail}", with this skin
// supplying `detail` — the same split cricket ships.
//
// Fragments are joined with " · ", the punctuation join this chassis already
// uses for a scorebug's own context parts, so no join key is minted; each
// fragment is individually localised, so word order inside a fragment stays a
// per-locale decision.
// ---------------------------------------------------------------------------

function join(parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return kept.length > 0 ? kept.join(" · ") : undefined;
}

export function footballDetail(ctx: ActivityDetailContext): string | undefined {
  const { t, eventType, payload, personNames } = ctx;
  const named = (id: unknown): string | undefined =>
    typeof id === "string" && id.length > 0 ? (personNames?.[id] ?? t("eventCopy.unknownPerson")) : undefined;

  switch (eventType) {
    case "football.goal":
      return join([
        named(payload.scorer),
        payload.assist === undefined ? undefined : t("pad.football.ribbon.goal.assist", { name: named(payload.assist) ?? "" }),
        payload.ownGoal === true ? t("pad.football.ribbon.goal.ownGoal") : undefined,
        payload.penalty === true ? t("pad.football.ribbon.goal.penalty") : undefined,
      ]);
    case "football.card":
      return join([vocabText("color", payload.color, t), named(payload.person)]);
    case "football.sub": {
      const off = named(payload.off);
      const on = named(payload.on);
      return off === undefined || on === undefined ? undefined : t("pad.football.ribbon.sub.pair", { on, off });
    }
    case "football.period":
      return join([
        vocabText("phase", payload.phase, t),
        typeof payload.addedMinutes === "number" && payload.addedMinutes > 0 ? `+${payload.addedMinutes}` : undefined,
      ]);
    case "football.penalty":
      return join([vocabText("outcome", payload.outcome, t), named(payload.taker)]);
    case "football.shot":
      return join([vocabText("outcome", payload.outcome, t), named(payload.taker)]);
    case "football.shootout.kick":
      return join([t(payload.scored === true ? "outcome.scored" : "outcome.missed"), named(payload.person)]);
    case "football.sinbin.start":
    case "football.sinbin.end":
      return join([named(payload.person)]);
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// The factory.
// ---------------------------------------------------------------------------

export function footballSkinV3(t: TFn): SkinDefV3<PadHostView> {
  return {
    key: "football",
    tapModel: "T",
    phase: resolvePhase,
    scorebug: (view) => buildScorebug(view, t),
    tiles: buildTiles,
    dock: (eventType, view, payload) => buildDock(eventType, view, t, payload),
    sheets: buildSheets,
    swap: (view) => buildSwap(view, t),
    // Declared HERE, not merely exported: a detail builder that exists but is
    // never wired ships INERT — its unit tests pass while every activity row
    // still reads "Goal recorded".
    activityDetail: footballDetail,
    // No `context`/`contextSelect` — see this file's header.
  };
}
