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
// R3.5 — the pad's own alternation and tally rules for the shoot-out, both
// re-exported from the football module's own barrel (not imported out of
// `sports/period` directly): a skin must not reach into another sport
// family's folder, matching how this skin already imports nothing from
// cricket's or tennis's own directories. Mirrors the cricket skin's
// `import { eligibleBowlers, nextBattingSide, reviewsRemaining } from
// "@seazn/engine/sports/cricket"`.
import type { SquadState } from "@seazn/engine/core";
import { expectedKicker, shootoutTally, type ShootoutKick } from "@seazn/engine/sports/football";
import type { MessageKey } from "@/lib/messages";
import { ENUM_VOCAB } from "@/lib/scoring-vocab";
import type { SportTone } from "../sport-theme";
import {
  MORE_SHEET_KEY,
  type ActivityDetailContext,
  type Blocked,
  type CandidateMeta,
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

/**
 * R3-6 / task B4 — the CARD CODE, and the load-bearing argument for the whole
 * per-sport-identity ruling. Yellow and red are the only colours in football's
 * visual language that carry MEANING: a referee does not raise a "destructive
 * action". Before B4 this pad discarded that entirely — a red rendered in the
 * chassis's generic `destructive` red, indistinguishable from Abandon, and a
 * yellow rendered as neutral `standard`.
 *
 * NAMES, never values: these are `SportTone`s from the chassis's closed
 * vocabulary (../sport-theme.ts), which resolve to `--sport-caution` /
 * `--sport-dismissal`. This skin supplies no colour of its own — that is the
 * point of the token layer, and `__tests__/sport-theme.test.ts` fails if any
 * hex ever appears in this file.
 *
 * `second_yellow` carries BOTH, in offence order: it is a yellow card and a
 * red one, not a red with a note — the same reason the engine keeps it as its
 * own colour. The chassis draws one swatch per entry and takes the OUTCOME
 * (the last) for the option's wash.
 *
 * They land on the SHEET, not on a tile: B3 collapsed cards to one neutral
 * `Card` tile per side to keep the two lanes intact, so the colour step inside
 * `card-<side>` is now the only place a card colour can be shown at all.
 */
const CARD_TONES: Readonly<Record<CardColor, readonly SportTone[]>> = {
  yellow: ["caution"],
  red: ["dismissal"],
  second_yellow: ["caution", "dismissal"],
};

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

/** IFAB Law 12 §3 — the direct-free-kick offence that CONCEDED the penalty
 *  (`PenaltyOffence`, football.ts:314). A DIFFERENT question from
 *  `CardReason`: not every penalty carries a card, and a penalty for handball
 *  can sit beside a caution for dissent. `.optional()` on `FootballPenalty`,
 *  which is what lets bands 0-1 record a kick and nothing else. */
export const PENALTY_OFFENCES: readonly string[] = [
  "kicking",
  "tripping",
  "jumping_at",
  "charging",
  "pushing",
  "striking",
  "tackling",
  "handball",
];

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
  /** Per exemption key (`{concussion: 1}`) — football's own mirror of
   *  `SideSquad.exemptUsed` (football.ts:527), written by the kernel's
   *  `onLineup` hook when a `core.lineup.replacement` folds through. Read by
   *  `subPolicy` for the same reason `liftSide` reads it: an exempt
   *  replacement sits OUTSIDE the substitution cap. */
  exemptUsed?: Readonly<Record<string, number>>;
}

interface FootballStateShape {
  phase?: string;
  entrants?: { home?: string; away?: string };
  goals?: { home?: number; away?: number };
  cards?: { side?: string; person?: string; color?: string }[];
  squads?: { home?: FootballSquadShape; away?: FootballSquadShape };
  asOf?: GameTimeShape;
  /** R3.5 — `football.ts`'s own `State.shootout`. `kicks` typed as the SHARED
   *  `ShootoutKick[]` (not a hand-mirrored `{side;scored}[]`), so this file
   *  can never drift from what `expectedKicker`/`shootoutTally` themselves
   *  accept. `null` before the phase reaches SHOOTOUT; `{kicks: []}` from
   *  the moment it does, even before the first kick — the engine sets it in
   *  the same step it sets `phase: "SHOOTOUT"` (football.ts's
   *  `resolveFullTime`). */
  shootout?: { kicks: readonly ShootoutKick[] } | null;
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

function squadOf(state: FootballStateShape, side: Side): Required<Pick<FootballSquadShape, "onPitch" | "bench" | "offUsed" | "sentOff">> & { subWindows: GameTimeShape[]; exemptUsed: Readonly<Record<string, number>> } {
  const squad = state.squads?.[side] ?? {};
  return {
    onPitch: squad.onPitch ?? [],
    bench: squad.bench ?? [],
    offUsed: squad.offUsed ?? [],
    sentOff: squad.sentOff ?? [],
    subWindows: squad.subWindows ?? [],
    exemptUsed: squad.exemptUsed ?? {},
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
 *
 * MODE ONLY — this is the cfg half of the answer and NOT the whole one. See
 * `legalPeriodMarkers` below for the phase half, and this file's ruling
 * comment there for why offering this list raw was a dead-end tap.
 */
export function periodMarkersOf(cfg: unknown): readonly string[] {
  const c = asCfg(cfg);
  return [
    ...(c.halves === 4 ? ["QT", "HT", "3QT", "FT"] : ["HT", "FT"]),
    ...(c.extraTime?.enabled === true ? ["ET_HT", "ET_FT"] : []),
  ];
}

/**
 * The marker(s) `applyPeriod` will accept IN THIS PHASE — a strict subset of
 * `periodMarkersOf`, and the fix for the wave's first dead-end tap.
 *
 * `applyPeriod` gates on cfg.halves AND on `state.phase`, one arm per marker
 * (football.ts:1529-1578). `periodMarkersOf` mirrored only the first gate, so
 * in halves mode at H1 the sheet offered Half time AND Full time, and Full
 * time raised WRONG_PHASE; quarters plus extra time offered six markers of
 * which exactly one was legal. Every play phase has EXACTLY ONE legal marker,
 * which is what makes the list below a lookup rather than a filter:
 *
 *   halves    H1 -> HT      H2 -> FT
 *   quarters  H1 -> QT      Q2 -> HT     Q3 -> 3QT    Q4 -> FT
 *   either    ET_H1 -> ET_HT             ET_H2 -> ET_FT
 *
 * Intersected with `periodMarkersOf` rather than returned raw: the two mirrors
 * then cannot disagree about a cfg (an ET phase is unreachable without
 * `extraTime.enabled`, so the intersection never removes a legal marker — it
 * removes a mirror bug if one is ever introduced).
 *
 * EMPTY is a real answer, and the callers rely on it: at "pre", "SHOOTOUT" and
 * every decided phase there is no next whistle at all.
 */
export function legalPeriodMarkers(phase: string, cfg: unknown): readonly string[] {
  const quarters = asCfg(cfg).halves === 4;
  const marker =
    phase === "ET_H1"
      ? "ET_HT"
      : phase === "ET_H2"
        ? "ET_FT"
        : quarters
          ? { H1: "QT", Q2: "HT", Q3: "3QT", Q4: "FT" }[phase]
          : { H1: "HT", H2: "FT" }[phase];
  if (marker === undefined) return [];
  return periodMarkersOf(cfg).includes(marker) ? [marker] : [];
}

/**
 * The `football.*` types whose `apply` refuses outside a PLAY phase — every
 * one of them guards on `isPlayPhase(state.phase)` as its first statement
 * (`applyGoal:1070`, `applySub:1143`, `applyPenalty:1402`, `applyShot:1447`,
 * `applySinBinStart:1333`, `applySinBinEnd:1285`). The other three are the
 * exceptions: a card is legal in every phase but a decided one, a shoot-out
 * kick only inside the shoot-out, and a period marker per the table above.
 */
const PLAY_PHASE_ONLY: readonly string[] = [
  "football.goal",
  "football.sub",
  "football.penalty",
  "football.shot",
  "football.sinbin.start",
  "football.sinbin.end",
];

/**
 * Whether the FOLD accepts this type in this phase — the one place this skin
 * states football's phase rules, read by `buildTiles` (so a tile is never
 * drawn) and by `refusedEventTypes` (so the generic More sheet never lists it
 * either). ONE function because the two used to disagree: the tiles gated on
 * `inPlay` while More did not, so during a shoot-out the Goal tile vanished
 * and `football.goal` reappeared one tap away inside More as an un-narrowed
 * generic form that `applyGoal` refuses.
 *
 * FAILS OPEN for a type it does not know. A future `football.*` event must
 * become reachable by existing, not by being listed here — the totality sweep
 * catches an unreachable type, and nothing would catch one silently hidden.
 */
export function phaseAllows(eventType: string, phase: string, cfg: unknown): boolean {
  if (eventType === "football.card") return !POST_PHASES.has(phase);
  if (eventType === "football.shootout.kick") return phase === "SHOOTOUT";
  if (eventType === "football.period") return legalPeriodMarkers(phase, cfg).length > 0;
  return PLAY_PHASE_ONLY.includes(eventType) ? PLAY_PHASES.has(phase) : true;
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

/**
 * R3.5/Task F — the side due to kick next, in the scorer's own words, or
 * `undefined` when there is no cue to show. `undefined` covers TWO real
 * cases, both deliberate: outside SHOOTOUT entirely (this is the same phase
 * gate `phaseAllows("football.shootout.kick", …)` already applies to the
 * tile — a stray `state.shootout` object must not resurrect the cue once the
 * match has moved on, e.g. to `done`), and at zero kicks, where
 * `expectedKicker` returning `null` is a REAL answer (either side may start)
 * rather than a missing one.
 *
 * Feeds BOTH surfaces this ruling touches from ONE computation: the
 * `buildScorebug` LED strip item below, and `buildTiles`' disabled-tile
 * gate (which reads `expectedKicker` directly, since it has no `t` to
 * resolve text with).
 *
 * Why this exists at all, beyond convenience: `applyShootoutKick` hard-
 * refuses an out-of-turn kick, and server-side error messages are not
 * localised in this repo (no server-side i18n) — an out-of-turn tap would
 * otherwise reach a Spanish or Dutch scorer in English. This prevents the
 * refusal rather than explaining it afterwards.
 */
export function kickerCue(rawState: unknown, t: TFn): string | undefined {
  const s = asState(rawState);
  if (readPhase(s) !== "SHOOTOUT" || !s.shootout) return undefined;
  const next = expectedKicker(s.shootout.kicks);
  return next === null ? undefined : t(SIDE_LABEL[next]);
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

  // THE STRIP IS THE FOURTH OFFICIAL'S ADDED-TIME BOARD (R3-6, task B4). Every
  // item takes `tone: "led"`, which the chassis renders as an inset amber LED
  // panel (types.ts's `StripItem.tone`, globals.css `.pad-led-panel`) — one
  // memorable element, unmistakably football, occupying the space the
  // permanently-dead `Clock —` field used to hold rather than adding furniture.
  //
  // IT IS HONEST WHEN THERE IS NOTHING TO SHOW, which is the NORMAL case on a
  // pad-only stream: `state.asOf` is set only from an event's own `at`, and no
  // v3 tile sends one (see `readClock`), so the clock may never arrive. It is
  // OMITTED rather than lit empty, so a fresh match reads as one quiet period
  // panel — a board with nothing added yet, which is exactly what a fourth
  // official's board looks like before a stoppage. There is no placeholder, no
  // em-dash, and no zero. R3/F removed the third item on the same principle;
  // its own note sits below.
  //
  // The period is PROSE — `phaseLabel` above, which reads the cfg because the
  // "H1" token means quarter 1 in quarters mode. v2 showed the raw token here
  // (football-skin.tsx:141) and B2 carried that over; B3 closes it.
  const strip: StripItem[] = [
    {
      id: "period",
      label: t("scorepad.skin.football.header.period"),
      value: phaseLabel(phase, view.cfg, t),
      tone: "led",
    },
  ];
  const clock = readClock(state, phase);
  if (clock !== undefined) {
    strip.push({ id: "clock", label: t("scorepad.skin.football.header.clock"), value: clock, tone: "led" });
  }
  // R3.5/Task F — whose kick is next, the engine's own alternation rule
  // (`expectedKicker`) surfaced BEFORE the refusal rather than explaining it
  // after. `kickerCue` returns `undefined` at zero kicks (either side may
  // start — a real answer) and outside SHOOTOUT entirely, so this item is
  // simply never pushed in either case, the same "honest when there is
  // nothing to show" posture the clock item above already takes.
  const nextKicker = kickerCue(state, t);
  if (nextKicker !== undefined) {
    strip.push({
      id: "nextKicker",
      label: t("scorepad.skin.football.header.nextKicker"),
      value: nextKicker,
      tone: "led",
    });
  }
  // NO ADDED-TIME ITEM — R3/F (F2), removed rather than re-attributed. B4 put
  // one here reading `periods[last].addedMinutes`, and the fixture that proved
  // it (an OPEN "H1" already carrying `addedMinutes: 3`) is a state the fold
  // cannot produce. Two engine facts decide it, both pinned by
  // `__tests__/football.test.ts` against a real fold rather than restated here:
  //
  //   - `applyPeriod` stamps the minutes on the period a marker CLOSES and, for
  //     every marker but the final whistle, pushes the next period in the SAME
  //     step (`pushPeriod(close(), …)`, football.ts:1536-1550). So the period
  //     the board is showing never carries added time. The only states where
  //     `periods[last]` does are the two `resolveFullTime` arms that push
  //     nothing — `done` and `SHOOTOUT` — where the item printed the SECOND
  //     HALF's minutes beside a "Shoot-out"/"Match over" label. Mis-attributed,
  //     not merely rare.
  //   - No v3 football surface can record added time anyway: `football.period`
  //     is dedicated (a tile and a sheet), so the generic More form carrying
  //     `padSpec`'s own `addedMinutes` field is never offered for it, and
  //     `periodSheet.buildPayload` sends `{ phase }` alone.
  //
  // The information is NOT lost, which is why removal beats attribution: the
  // minutes ride the period event's own ribbon/activity line through
  // `footballDetail` ("Half time · +3"), where they are attached to the whistle
  // that set them and cannot go stale. `scorepad.skin.football.header.added`
  // stays in the four dictionaries for the wave that gives the pad a way to
  // record added time (R6/R8) — see `_INDEX.md`.

  // R3.5/Task D — the shoot-out tally rides the SAME halves as the
  // regulation score. Before this the board showed `1` and `1` while the
  // headline above it already read "1 — 1 (2-1 pens)": two score readouts on
  // one screen, disagreeing, which is exactly what design note D-11 exists
  // to prevent. `shootoutTally` is the shared primitive, never a fourth
  // hand-rolled reduce (see Task H — `summary()` itself no longer forks it).
  //
  // `state.shootout?.kicks` truthy from the MOMENT the fold reaches
  // SHOOTOUT (`{kicks: []}`, never `undefined`), so `sub` reads `(0)`/`(0)`
  // before the first kick too — a real, honest fact (the tally so far),
  // not a placeholder.
  const kicks = state.shootout?.kicks;
  const pens = kicks ? shootoutTally(kicks) : null;
  return {
    context: contextParts.join(" · "),
    phase: resolvePhase(view),
    halves: [
      {
        who: [{ name: t(SIDE_LABEL.home) }],
        big: String(state.goals?.home ?? 0),
        ...(pens ? { sub: `(${pens.home})` } : {}),
      },
      {
        who: [{ name: t(SIDE_LABEL.away) }],
        big: String(state.goals?.away ?? 0),
        ...(pens ? { sub: `(${pens.away})` } : {}),
      },
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

/** Sheet key for one side's shoot-out kick (R3.5/Task J). ONE per side, same
 *  shape as `cardSheetKey`: the outcome (Scored/Missed) is the sheet's own
 *  first and only step. */
export function kickSheetKey(side: Side): string {
  return `kick-${side}`;
}

/** Whether this event may be dispatched at the ACTIVE band — see `EVENT_BAND`. */
function withinBand(eventType: string, band: FidelityBand): boolean {
  const declared = EVENT_BAND[eventType];
  return declared === undefined || declared <= band;
}

export function buildTiles(view: PadHostView): TileSpec[] {
  const state = asState(view.state);
  const phase = readPhase(state);
  const band = view.band;
  const tiles: TileSpec[] = [];
  // ONE gate for both halves of "can this be dispatched at all right now" —
  // the fold's phase rule (`phaseAllows`) and the ACTIVE band (`withinBand`).
  // Before the R3 review round the phase half was written inline per tile and
  // disagreed with what the More sheet offered; see `phaseAllows`.
  const offerable = (eventType: string): boolean =>
    phaseAllows(eventType, phase, view.cfg) && withinBand(eventType, band);

  // Goal — commits SIDE-LEVEL on tap. Honest: `scorer`/`assist` are both
  // `.optional()` on `FootballGoal` (football.ts:213-214), so the event the
  // engine receives is complete without them. The dock then offers the
  // attribution (`buildDock`), which is the D-14 "ask only what varies" shape
  // rather than a modal before every goal.
  if (offerable("football.goal")) {
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

  // R3.5/Task J (ruling R3.5-5) — R3-4 AMENDED for the SHOOTOUT phase ONLY.
  // That ruling put four RARE types in the generic More sheet, and it still
  // stands everywhere else; in this phase the rare type IS the whole match,
  // and the board otherwise held two card tiles and nothing else while the
  // only action of the phase sat two taps deep. These occupy the space the
  // Goal tiles vacate (`offerable("football.goal")` and
  // `offerable("football.shootout.kick")` are mutually exclusive — see
  // `phaseAllows` — so the two blocks never both fire).
  //
  // A tile opens a two-outcome SHEET (Scored/Missed) rather than emitting
  // directly like Goal does: `football.shootout.kick`'s only required field
  // beyond `by` is `scored`, but a mis-tap here decides a knockout match, so
  // the sheet's own Cancel gives a mis-tap a step to escape from, and the
  // DOCK still opens after commit for band-2+ taker attribution (same as
  // Goal's scorer/assist chips) — see `buildDock`.
  //
  // The out-of-turn side's tile is DISABLED, not absent: a vanishing tile
  // reads as a bug, and this same phase's `buildScorebug` strip already
  // names whose turn it is (`kickerCue`) — the LED cue a scorer reads
  // ambiently on the board itself, right above this grid. (`tile-grid.tsx`'s
  // own `assertDisabledTilesExplained` is a `ContextStripSpec`-shaped
  // validator no skin currently exercises against its own real output —
  // football declines `context()` altogether, same as before this task,
  // for the reason this file's header states: no persistent PER-PERSON slot
  // the fold could hold, and "whose side kicks next" is not a person fact.
  // The LED cue is the mechanism that actually reaches the scorer here.)
  if (offerable("football.shootout.kick")) {
    const next = state.shootout ? expectedKicker(state.shootout.kicks) : null;
    for (const side of SIDES) {
      tiles.push({
        id: kickSheetKey(side),
        label: "pad.football.action.shootoutKick",
        sublabel: SIDE_LABEL[side],
        kind: "primary",
        span: 2,
        phases: ["live"],
        ...(next !== null && next !== side ? { disabled: true } : {}),
        action: { sheet: kickSheetKey(side) },
      });
    }
  }

  // Card — legal in every phase except a decided match (`applyCard`), so
  // deliberately NOT gated on `inPlay`: a card during the shoot-out is a real
  // scoring moment this pad must still reach. ONE tile per side (see this
  // section's header): the colour is the sheet's first step, and the person
  // still arrives through the dock, exactly as R3-1 rules.
  if (offerable("football.card")) {
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
  if (offerable("football.sub")) {
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

  if (offerable("football.period")) {
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

  if (offerable("football.penalty")) {
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

/**
 * `SkinDefV3.refusedEventTypes` — what the More sheet must not list right now.
 *
 * Derived from `EVENT_BAND`'s key set, which is `padSpec(cfg).fidelity`
 * verbatim and is PINNED against the engine in this skin's test file, so a
 * ninth-and-a-half event type cannot appear in the engine and be silently
 * absent from this sweep. `phaseAllows` decides each one.
 *
 * Why the skin owes this at all, in one line: football's panels are ungated
 * `phase: "live"` and its phase rules live inside `apply`, so `buildPadView`
 * cannot see them — see `refusedEventTypes`' own doc in ../types.ts.
 */
export function refusedEventTypes(view: PadHostView): string[] {
  const phase = readPhase(asState(view.state));
  return Object.keys(EVENT_BAND).filter((type) => !phaseAllows(type, phase, view.cfg));
}

// ---------------------------------------------------------------------------
// sheets() — a METHOD of the view (G4), rebuilt every render so a closed-over
// entrant id or cfg marker list can never go stale. No `t`: every `title` and
// `options[].label` here is an i18n KEY the chassis resolves itself.
// ---------------------------------------------------------------------------

/**
 * Who on `side` may receive a card of `colour` RIGHT NOW — `applyCard`'s own
 * two person rules (football.ts:1113-1122) applied to the LIST rather than
 * caught afterwards: a yellow to someone already on one must be recorded as
 * `second_yellow`, and a `second_yellow` without a prior yellow is refused
 * outright. Already-sent-off players are out entirely.
 *
 * ONE implementation, read by the dock's person chips AND by the card sheet's
 * colour step. It has to be one, because they were the two halves of a real
 * defect: `applyCard` applies the prior-yellow rules ONLY when `person` is
 * given, so a person-less second yellow COMMITS — and the dock then filtered
 * its chips down to prior-yellow holders and produced NONE. An unattributable
 * card and an empty dock, from a colour the sheet offered unconditionally.
 *
 * NARROWER THAN `applyCard` ON PURPOSE, and this is the deliberate part: the
 * fold would also accept a card for a benched, already-substituted, sin-binned
 * or non-playing squad member, while this list is `onPitch` only. That is the
 * DOCK's pre-existing scope (its chips have always been the on-pitch eleven),
 * and the sheet now agrees with the dock rather than with a wider set it has
 * no way to offer. Widening both is a real improvement and a separate one.
 */
function cardCandidates(state: FootballStateShape, side: Side, colour: unknown): string[] {
  const squad = squadOf(state, side);
  const sentOff = new Set(squad.sentOff);
  const priorYellow = new Set(
    (state.cards ?? [])
      .filter((card) => card.color === "yellow" && typeof card.person === "string")
      .map((card) => card.person as string),
  );
  return squad.onPitch
    .filter((id) => !sentOff.has(id))
    .filter((id) =>
      colour === "yellow" ? !priorYellow.has(id) : colour === "second_yellow" ? priorYellow.has(id) : true,
    );
}

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
function cardSheet(view: PadHostView, side: Side, t: TFn): GuidedSheetSpec {
  const state = asState(view.state);
  const by = entrantOf(state, side);
  const asksOffence = view.band >= 2;
  // R3 review round: a card with nobody to carry it cannot be attributed to
  // anyone, and the dock that opens after it commits would render zero chips.
  // BLOCKED with its reason, never dropped — the colour list is three long and
  // a scorer notices when it is two.
  //
  // Round 2 widened this from `second_yellow` alone. Each colour has its OWN
  // candidate set (`cardCandidates`), so each empties for its own reason: a
  // second yellow needs somebody already booked, a first yellow needs somebody
  // NOT yet booked, and a red needs only an unsent player on the pitch. Every
  // side booked to a man is the reachable one — guarding one arm of a
  // three-way split left the same defect open in the other two.
  // `red` IS the eligibility universe — on the pitch and not sent off, with no
  // caution condition either way — so the other two are subsets of it. Reading
  // it first is what keeps the reason honest: with an empty pitch all three
  // sets are empty, and "everyone is already booked" would be a false sentence
  // about a side that has nobody to book.
  const eligible = cardCandidates(state, side, "red");
  const blockedColours: Record<string, string> = {};
  for (const colour of CARD_COLORS) {
    if (cardCandidates(state, side, colour).length > 0) continue;
    blockedColours[colour] =
      eligible.length === 0
        ? t("pad.football.context.card.blocked.nobodyOnPitch")
        : colour === "yellow"
          ? t("pad.football.context.card.blocked.allBooked")
          : t("pad.football.context.card.blocked.noPriorYellow");
  }
  const steps: GuidedSheetStep[] = [
    {
      id: "color",
      kind: "choice",
      title: "pad.football.sheet.card.color.title",
      // `cardColor.*` is the shared vocabulary both lanes already use, so no
      // new copy and no second wording for a colour. `tone` (B4) is the card
      // CODE beside that label — see CARD_TONES above for why it is a name and
      // not a colour, and why a second yellow carries two.
      options: CARD_COLORS.map((colour) => ({
        id: colour,
        label: vocabKey("color", colour) ?? colour,
        tone: CARD_TONES[colour],
      })),
      blocked: () => blockedColours,
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

/**
 * Which break this whistle closes. `FootballPeriod` carries no `by` — a
 * whistle belongs to neither side — so this sheet has exactly one step.
 *
 * R3 REVIEW ROUND — THE OPTIONS ARE NARROWED BY PHASE, NOT JUST BY CFG. This
 * sheet used to offer `periodMarkersOf(cfg)` raw, which mirrors only
 * `applyPeriod`'s MODE gate; the fold also gates every arm on `state.phase`,
 * so at H1 in halves mode the sheet offered Half time AND Full time and Full
 * time raised WRONG_PHASE. Quarters plus extra time offered six, of which one
 * was legal.
 *
 * BLOCKED, NOT REMOVED — R2b's binding ruling, applied to a choice step rather
 * than a candidate list. A scorer looking for "Full time" at half time must be
 * told why it is not available; a silently one-item list leaves them hunting
 * for a control that is on screen in every other minute of the match. The
 * reason names the CURRENT period in the scorer's own words (`phaseLabel`),
 * because "not now" without saying when is the generic-error shape R2b's other
 * ruling bans.
 *
 * `blocked` is a METHOD taking `answers` (types.ts) and this one ignores them:
 * the verdict depends on the fold, not on anything asked earlier in the sheet.
 */
function periodSheet(view: PadHostView, t: TFn): GuidedSheetSpec {
  const phase = readPhase(asState(view.state));
  const legal = new Set(legalPeriodMarkers(phase, view.cfg));
  const reason = t("pad.football.context.period.blocked.wrongPhase", {
    phase: phaseLabel(phase, view.cfg, t),
  });
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
        blocked: () =>
          Object.fromEntries(
            periodMarkersOf(view.cfg).filter((marker) => !legal.has(marker)).map((marker) => [marker, reason]),
          ),
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
/**
 * The two-outcome sheet a kick tile opens (R3.5/Task J). A SHEET, not a
 * direct-emit tile like Goal: a mis-tap here decides a knockout match, so
 * the sheet's own Cancel gives a mis-tap a step to escape from before it
 * commits — one tap more than Goal, matched to the stakes.
 *
 * `person` (the taker) is deliberately NOT asked here: it is `.optional()`
 * on `FootballShootoutKick`, exactly like a goal's `scorer` — and the DOCK
 * offers it after commit for band-2+ attribution (`buildDock`'s own
 * `"football.shootout.kick"` case), which is what keeps that attribution
 * reachable at all now that the kick is no longer routed through the
 * generic More form (whose own `padSpec` field list carried it as an
 * `attribution` entry — football.ts:2241).
 */
function kickSheet(view: PadHostView, side: Side): GuidedSheetSpec {
  const state = asState(view.state);
  const by = entrantOf(state, side);
  return {
    event: "football.shootout.kick",
    steps: [
      {
        id: "outcome",
        kind: "choice",
        title: "pad.football.sheet.shootoutKick.outcome.title",
        options: [
          { id: "scored", label: vocabKey("outcome", "scored") ?? "scored" },
          { id: "missed", label: vocabKey("outcome", "missed") ?? "missed" },
        ],
      },
    ],
    buildPayload: (answers) => ({ by, scored: answers.outcome === "scored" }),
  };
}

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

export function buildSheets(view: PadHostView, t: TFn): Record<string, GuidedSheetSpec> {
  const sheets: Record<string, GuidedSheetSpec> = {
    period: periodSheet(view, t),
    penalty: penaltySheet(view),
  };
  for (const side of SIDES) sheets[cardSheetKey(side)] = cardSheet(view, side, t);
  // R3.5/Task J — ALWAYS declared, same convention period/penalty/card take
  // above: the SHEET's presence never depends on phase, only the TILE that
  // opens it does (`buildTiles`' own `offerable("football.shootout.kick")`
  // gate). Keeping the sheet unconditional is what lets `dedicatedEventTypes`
  // (pad-host.tsx) resolve it at all, and what lets the copy-truth sweep
  // (this skin's own test file) see its title/option labels without a
  // phase-specific special case.
  for (const side of SIDES) sheets[kickSheetKey(side)] = kickSheet(view, side);
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

  // THE CAP COUNTS ORDINARY SUBSTITUTIONS, and `offUsed` is not that number.
  //
  // R3 review round. `lineupPolicy(cfg)` grants `exemptions.concussion` when
  // the competition has adopted the IFAB trial, and `liftSide` (football.ts:
  // 2073) hands the kernel `subsUsed = max(0, offUsed.length - exemptTotal)` —
  // an exempt replacement is permanent, so it is in `offUsed` too and has to be
  // subtracted back out or it spends the allowance it exists to sit outside.
  // This mirror counted `offUsed` raw, so a side that had used a concussion
  // replacement was refused its last legal substitution: `policyOk: false` on a
  // swap `reduceLineupEvent` would have accepted. The refusal-side twin of the
  // dead-end tap — the pad refusing what the engine allows.
  //
  // ROUTED, NOT FIXED HERE: the pad still cannot ORIGINATE a concussion
  // replacement. `applySub` always builds a `core.lineup.substitution`, and the
  // exemption channel is `core.lineup.replacement`, which no football event
  // carries — so `football.sub` at the cap is refused whatever `concussionSubs`
  // says, and this arithmetic only restores the headroom an ALREADY-RECORDED
  // exempt replacement freed. Recorded in `_INDEX.md`; engine work, and R3's
  // engine exception is spent.
  const exemptUsed = Object.values(squad.exemptUsed).reduce((total, n) => total + n, 0);
  const ordinarySubs = Math.max(0, squad.offUsed.length - exemptUsed);
  if (!rolling && cfg.maxSubs !== undefined && ordinarySubs >= cfg.maxSubs) {
    return {
      ok: false,
      message: t("pad.football.context.sub.blocked.maxSubs", { used: ordinarySubs, max: cfg.maxSubs }),
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

/**
 * Row decoration for the substitution sheet (R8 sweep, task WS-D) — the R7
 * `CandidateMeta` mechanism (`types.ts`, rendered by `context-strip.tsx`'s
 * `renderCandidateRow`) that volleyball's `liberoCandidateMeta` already
 * populates and football never wired, so eleven near-identical on-pitch
 * names rendered with no distinguisher on the very step the whole sheet is
 * about.
 *
 * Sourced from `view.squads`, deliberately NOT the live `squadOf(state,
 * side)` this file's own `onCandidates`/`offCandidates` read above.
 * `onCandidates`'s own doc explains why `view.squads` is the WRONG source
 * for the candidate POOL — it degrades to `initSquads(lineups)`, the
 * kickoff team sheet, frozen the moment a substitution happens. That
 * staleness does not apply here: a squad number and a declared role do not
 * change when a player is substituted, so the kickoff sheet is exactly the
 * right (and only) place this file has either fact.
 *
 * `positionKey` is carried only for a STARTING slot (`memberFromSlot`,
 * core/lineup.ts — a bench slot's declared position is a preference, not an
 * occupancy, the same distinction volleyball's own doc draws), so a bench
 * candidate falls back to their squad number: still a real distinguisher
 * from data the view already has, never invented. `tag` mirrors the ONE
 * role key football's own `PositionCatalog` declares (`football.ts`'s
 * `positions.roles`, "captain") — matching this file's own precedent of
 * mirroring the engine's closed vocabularies rather than typing a new one.
 *
 * Keyed over the WHOLE squad (starting and bench), matching
 * `liberoCandidateMeta`'s own reasoning: the OFF step's pool is the live
 * on-pitch set (`offCandidates`) and the ON step's is bench-plus-already-
 * substituted (`candidates`), and a table built for only one would silently
 * decorate one step and not the other.
 */
function footballCandidateMeta(squads: SquadState, side: Side, t: TFn): Readonly<Record<string, CandidateMeta>> {
  const meta: Record<string, CandidateMeta> = {};
  for (const member of squads[side].members) {
    const lead = member.positionKey ?? (member.squadNumber !== undefined ? String(member.squadNumber) : undefined);
    const tag = member.roles?.includes("captain") ? t("pad.football.swap.captainTag") : undefined;
    if (lead === undefined && tag === undefined) continue;
    meta[member.personId] = {
      ...(lead !== undefined ? { lead } : {}),
      ...(tag !== undefined ? { tag } : {}),
    };
  }
  return meta;
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
      candidateMeta: footballCandidateMeta(view.squads, side, t),
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
        // THE `at` KEY IS ALWAYS PRESENT, and that presence is the whole of the
        // guard `stampOf` above documents (R6 fix pass 2, gap 6).
        //
        // `stampPayload` (../clock.ts) hands a skin-supplied `at` back BY
        // REFERENCE whatever its value, `undefined` included — "the skin owns
        // the field; the chassis fills a blank" — so `at: undefined` is the
        // deliberate-omission channel and a SPREAD of `{}` is not. Spreading
        // left no key at all, which reads as "expressed no opinion", so the
        // host's live clock filled the blank this skin had decided to leave
        // empty. That is exactly the "fix" `stampOf`'s own comment forbids:
        // `applySub`'s window arithmetic reads this `at`, and a wrong one can
        // refuse a legal substitution or admit an illegal one.
        //
        // `at: undefined` is legal on the wire — `GameTime.optional()` parses
        // it, and JSON drops it — so the event folds exactly as before.
        type: "football.sub",
        payload: { by, off, on, at: stamp },
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
      { id: "ownGoal", label: "pad.football.dock.ownGoal", kind: "flag", mutate: (p) => ({ ...p, ownGoal: true }) },
      { id: "penalty", label: "pad.football.dock.penalty", kind: "flag", mutate: (p) => ({ ...p, penalty: true }) },
    ];
    // Attribution is the band-2 timeline, and both fields are skippable: the
    // dock closes on its own and the goal is already recorded.
    //
    // ONE QUESTION AT A TIME (owner ruling, review round 3). This offered every
    // scorer chip AND every assist chip together: at 11-a-side that is 24 chips
    // in a panel with a ~6s soft-commit window, and `mutateHeld` does not extend
    // `heldUntil` (queue.ts) — so the window is a hard budget for the whole
    // interaction. Two questions on screen at once made the scorer read all 24
    // to answer the first one.
    //
    // Split on the payload, the same way cricket's dock already distinguishes a
    // no-ball from a plain single: `resolveDockSpec` forwards `held.payload`
    // verbatim and re-runs on every mutation, so picking a scorer re-renders
    // this panel as the assist step. The tap COUNT for full attribution is
    // unchanged — what changes is that each step asks one thing, and the list
    // to scan is roughly half as long.
    if (side !== null && view.band >= 2) {
      const scorer = typeof payload?.scorer === "string" ? payload.scorer : undefined;
      const ownGoal = payload?.ownGoal === true;
      if (scorer === undefined) {
        // ON PITCH only, for the SCORING side — `applyGoal` refuses a scorer who
        // is not on the pitch of `by`, own goals included (football.ts:1074).
        for (const id of squadOf(state, side).onPitch) {
          chips.push(personChip(`scorer:${id}`, "scorer", id, nameOf(view, id, t)));
        }
      } else if (!ownGoal) {
        // Two rules the ENGINE tolerates but its own domain rejects, both taken
        // verbatim from the generator's `assistPool` (football.ts:3026-3034):
        // the assist pool is "the striking side's pitch, MINUS the scorer", and
        // an own goal has no assist to credit at all — "naming one would put a
        // second player on a goal the fold credits to the opponent". `applyGoal`
        // validates only the scorer, so offering either would not be refused;
        // it would just be wrong, and silently so.
        for (const id of squadOf(state, side).onPitch) {
          if (id === scorer) continue;
          chips.push(personChip(`assist:${id}`, "assist", id, t("pad.football.dock.assist", { name: nameOf(view, id, t) })));
        }
      }
    }
    const goalTitle =
      typeof payload?.scorer === "string" && payload.ownGoal !== true
        ? t("pad.football.dock.goal.assist.title")
        : t("pad.football.dock.goal.title");
    return { title: goalTitle, chips };
  }

  // R3 review round — THE PENALTY'S OFFENCE, restored to the v3 pad.
  //
  // The v2 pad drew `football.penalty` through the generic ActionForm, which
  // rendered every field `padSpec` declares, `offence` (the IFAB Law 12
  // taxonomy, S4/#428) included. The v3 skin gives the penalty a dedicated
  // sheet, and a dedicated sheet REMOVES its event from More — so `offence`
  // became unaskable anywhere on the pad, a regression against v2 and
  // asymmetric with the CARD, whose own offence IS asked at band >=2 (R3-1).
  //
  // ASKED IN THE DOCK, NOT AS A THIRD SHEET STEP, and the reason is the
  // field's own shape rather than convenience: `outcome` is REQUIRED and
  // `offence` is `.optional()`, so a third step would hold a required event
  // hostage to an optional answer — the D-15 "ask a wasted tap" defect this
  // chassis exists to remove. The dock is where this pad already puts optional
  // enrichment of an event that has ALREADY committed (`ownGoal`/`penalty` on
  // a goal, the scorer, the card's person), it closes on its own, and skipping
  // it costs nothing. Band >=2 exactly like the card's `reason` step.
  if (eventType === "football.penalty") {
    if (view.band < 2) return null;
    const chips = PENALTY_OFFENCES.map((offence) => ({
      id: `offence:${offence}`,
      label: vocabKey("offence", offence) ?? offence,
      mutate: (p: Record<string, unknown>) => ({ ...p, offence }),
    }));
    return { title: t("pad.football.dock.penalty.title"), chips };
  }

  if (eventType === "football.card") {
    if (side === null) return { title: t("pad.football.dock.card.title"), chips: [] };
    // `cardCandidates` is the SAME list the card sheet blocks its colour step
    // against — see its doc for why one implementation rather than two.
    const chips = cardCandidates(state, side, payload?.color).map((id) =>
      personChip(`person:${id}`, "person", id, nameOf(view, id, t)),
    );
    return { title: t("pad.football.dock.card.title"), chips };
  }

  // R3.5/Task J — the taker, `person` on `FootballShootoutKick`, exactly as
  // optional as a goal's `scorer`. Before this task the generic More-sheet
  // form's own `attribution: [BY_SIDE, {kind:"person", path:"person"}]`
  // (football.ts's `padSpec`) offered it; a dedicated tile+sheet removes
  // that generic route entirely, so THIS is what keeps "band-2+ taker
  // attribution stays reachable" true rather than a claim this task quietly
  // broke. Band-gated like the penalty's own offence chips (`view.band < 2`
  // returns `null`, no empty panel) — `by` needs no chip of its own here,
  // the TILE already fixed the side.
  if (eventType === "football.shootout.kick") {
    if (side === null || view.band < 2) return null;
    const chips = squadOf(state, side).onPitch.map((id) => personChip(`person:${id}`, "person", id, nameOf(view, id, t)));
    return { title: t("pad.football.dock.shootoutKick.title"), chips };
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
  const state = asState(ctx.state);
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
    case "football.shootout.kick": {
      // R3.5/Task E — the SIDE first. For every other football event the
      // side is inferable because the score moves; for a shoot-out kick it
      // is the entire content of the event, and this is the panel a scorer
      // VOIDS from, so a mis-tap was being corrected blind. The review's
      // original "the log cannot say which side kicked" framing was WRONG
      // (`_INDEX.md`): the read-only audit table already names it — only
      // this, the SCORER's Activity panel, did not.
      //
      // `sideOfEntrant` already maps an entrant id to `Side` and returns
      // `null` when it cannot — reused rather than a second resolver.
      // `null` drops the segment through `join`, never a raw entrant id: an
      // unresolvable side is a real state (a foreign entrant on a replayed
      // ledger), and a UUID in a scorer's activity feed is the defect S13
      // already had to fix once.
      const kickSide = sideOfEntrant(state, payload.by);
      return join([
        kickSide === null ? undefined : t(SIDE_LABEL[kickSide]),
        t(payload.scored === true ? "outcome.scored" : "outcome.missed"),
        named(payload.person),
      ]);
    }
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
    /** R7/D — football's headline is `${goals} — ${goals}` plus, after a
     *  shoot-out, ` (${home}–${away} pens)`. Both facts are already on the
     *  halves: `big` is the goals and `sub` is `(${pens.side})`, built from
     *  the SAME `shootoutTally` primitive the engine's summary uses (R3.5/H
     *  made that one tally, precisely so display and decision cannot fork).
     *  So the bar restates the halves in every state this kernel has. */
    ownsHeadline: () => true,
    scorebug: (view) => buildScorebug(view, t),
    tiles: buildTiles,
    dock: (eventType, view, payload) => buildDock(eventType, view, t, payload),
    sheets: (view) => buildSheets(view, t),
    swap: (view) => buildSwap(view, t),
    // Declared HERE, not merely exported: without it the generic More sheet
    // keeps listing goal/sub/shot/sin-bin during a shoot-out, every one of
    // them WRONG_PHASE on tap and two of them reachable at band 0.
    refusedEventTypes,
    // Declared HERE, not merely exported: a detail builder that exists but is
    // never wired ships INERT — its unit tests pass while every activity row
    // still reads "Goal recorded".
    activityDetail: footballDetail,
    // No `context`/`contextSelect` — see this file's header.
  };
}
