// Tennis SkinDefV3 — R4, tapModel S. Converts tennis to the v3 chassis
// (design of record `docs/superpowers/specs/2026-08-15-scoringpad-v3-
// redesign-design.md` §2/§3, build spec `docs/superpowers/plans/2026-08-25-
// scorepad-v3-r4-tennis.md`, rulings R4-1..R4-4 + the false-premises section
// in `_INDEX.md`). Replaces `../../skins/tennis-skin.tsx` (v2, left on disk —
// R8 deletes it) as the sport's PAD surface.
//
// PURE DATA, no React — the same testability stance every v3 skin takes
// (apps/web vitest is `environment: "node"`, no jsdom). FACTORY, not a bare
// object: `ScorebugSpec.context`/`WhoLine.name`/`DockSpec.title` are
// pre-resolved text, and no `SkinDefV3` method itself receives `t`
// (registry.ts's header has the full reasoning).
//
// TAP MODEL S — the wave's real product value. The scoreboard halves ARE the
// point buttons (`ScorebugHalf.tappable`+`tapEvent`, `v3/types.ts:91-92`),
// enforced by `assertScorebugSpec` and already rendered as a real `<button>`
// by `scorebug.tsx` — tennis is the FIRST consumer of a chassis primitive
// that has sat unused since R1. Nobody else has proven the path, so this file
// carries the burden of a first user (the R3 lesson `_INDEX.md` states for
// `SwapSheet`): see the `dedicatedEventTypes` gap noted on `refusedEventTypes`
// below, discovered while building this.
//
// THE ENGINE FACTS THIS FILE ONCE MIRRORED, AND WHAT CHANGED (R4-3 restored).
// R4 shipped against a real gap: `nested/kernel.ts`'s `serveContext` (and the
// private helpers it composes — `setInProgress`, `rulesFor`,
// `nestedGamesOf`/`completedGames`) were not exported from any subpath this
// package's `package.json` "exports" map allowed — `@seazn/engine/sports/
// tennis` re-exported only the `tennis` VALUE (`sports/tennis/index.ts` was
// `export { tennis } from "./tennis.ts"` and nothing else), and there was no
// `sports/nested/index.ts` at all. `packages/engine/**` was frozen for that
// wave, so this file mirrored nine kernel facts instead of importing them,
// each commented with the exact kernel.ts range it restated — the same
// precedent football.tsx set.
//
// THE FIX: `packages/engine/src/sports/nested/index.ts` now exists and
// exports `serveContext`/`NestedState` — the one mirror that actually
// mattered for correctness, per the original ruling. Consuming the real
// function collapses FIVE of the nine mirrors in one step:
// `nestedGamesOf`/`completedGames`/`pairOrderOf`/`expectedPairServer` existed
// here only to recompose `serveContext`'s own answer by hand, so importing
// the composed answer removes them along with `serveContext`'s own mirror —
// see `deriveServeContext` below. Proven against REAL folds of the public
// `tennis` module in this file's test suite, reusing the engine's own
// `serve-context.test.ts` scenarios as the oracle — a stronger pin than a
// hand-derived expectation would be — plus a barrel-import smoke test
// against the same oracle so a future barrel edit can't silently re-fork
// this.
//
// WHAT STAYS LOCAL, AND WHY THAT IS A DIFFERENT GAP. `isDecidingSet`,
// `rulesFor`, `setInProgress`, `gamesFieldBound` and `tbFieldBound`
// (`sheets()` section below) restate kernel.ts functions that stay
// MODULE-PRIVATE there BY THE KERNEL'S OWN DESIGN — none of the five carries
// an `export` keyword, and this fix's grant was to export what the barrel's
// own readers already make public, not to widen kernel.ts's visibility
// (kernel.ts itself is otherwise untouched — see the barrel file's header).
// So these five stay as local re-derivations, each still commented with the
// kernel.ts range it restates for provenance, but "restates" is now the
// honest word: there is no barrel gap left to close here, only an
// architectural boundary. Widening kernel.ts's exports to close it is a call
// for whoever owns that file next, not something this fix reaches for.
//
// WHAT THIS SKIN DELIBERATELY DOES NOT DECLARE:
//   - `swap()`. `lineupPolicy: () => ({reentry: "none", ...})` (tennis.ts) —
//     ITF Rule 30, a retiring player does not resume and there is no
//     substitute — so there is no in-play swap for this sport to declare.
//   - `context()`/`contextSelect()`. Nothing here needs a persistent
//     context-strip slot the way cricket's striker/bowler do; the serving
//     player is carried on the scorebug's own `WhoLine`, not a strip pick.
//   - a Fault tile, a Let tile, a Retire tile (R4-1, R4-2): tennis declares
//     five event types only (`point`/`set_summary`/`sanction`/
//     `interruption`/`game.award`, `kernel.ts:1766-1772`) — no fault/let
//     event exists to dispatch, and §9.4 bars a new one. Forfeit/Abandon
//     already have a home in `fixture-console.tsx`'s console chrome; a Retire
//     tile here would be a second entry point to that same capability, the
//     defect R2c closed for `cricket.retire`, rebuilt deliberately.
"use client";
import type { EventEnvelope, SquadState } from "@seazn/engine/core";
import { resolveVoids } from "@seazn/engine/core";
import type { FidelityBand } from "@seazn/engine/sport";
import { serveContext, type NestedState } from "@seazn/engine/sports/nested";
import type { MessageKey } from "@/lib/messages";
import { ENUM_VOCAB } from "@/lib/scoring-vocab";
import {
  MORE_SHEET_KEY,
  type ActivityDetailContext,
  type DockChip,
  type DockSpec,
  type GuidedSheetSpec,
  type GuidedSheetStep,
  type PadHostView,
  type PadPhase,
  type ScorebugHalf,
  type ScorebugSpec,
  type SkinDefV3,
  type StepPredicate,
  type StripItem,
  type TileSpec,
  type WhoLine,
} from "../types";
import type { SportTone } from "../sport-theme";

export type TFn = (key: string, vars?: Record<string, string | number>) => string;
export type Side = "home" | "away";

const SPORT = "tennis";
const POINT_TYPE = `${SPORT}.point`;
const SET_SUMMARY_TYPE = `${SPORT}.set_summary`;
const SANCTION_TYPE = `${SPORT}.sanction`;
const INTERRUPTION_TYPE = `${SPORT}.interruption`;
const GAME_AWARD_TYPE = `${SPORT}.game.award`;

export const SIDES: readonly Side[] = ["home", "away"];
const SIDE_LABEL: Record<Side, MessageKey> = {
  home: "scorepad.attribution.home",
  away: "scorepad.attribution.away",
};
/** `NestedPointMeta.kind` (`kernel.ts:200-205`) — R4-1's dock chips. */
export const POINT_KINDS: readonly string[] = ["ace", "double_fault", "winner", "ue"];
/** `NestedInterruptionKind` (`kernel.ts:90`). */
export const INTERRUPTION_KINDS: readonly string[] = ["medical", "toilet", "heat", "other"];
/** `NestedSanctionLevel` (`kernel.ts:250-255`) — the ITF ladder, in order. */
export const SANCTION_LEVELS: readonly string[] = [
  "warning",
  "point_penalty",
  "game_penalty",
  "default",
];

/**
 * R4-4's recorded note (`_INDEX.md`): tennis's four-step ladder against TWO
 * colour tokens — the ENDS take a tone, the two middle steps "read as words
 * in the sanction sheet and carry no colour". A partial map, deliberately:
 * `point_penalty`/`game_penalty` have no entry at all (never an empty array)
 * so their option renders as the same plain button every untoned choice
 * already does.
 */
const SANCTION_LEVEL_TONE: Readonly<Partial<Record<string, readonly SportTone[]>>> = {
  warning: ["caution"],
  default: ["dismissal"],
};

/**
 * One band per event type — `nestedPadSpec`'s own `fidelity` map verbatim
 * (`kernel.ts:1553-1559`). Same reason football's `EVENT_BAND` mirrors it:
 * `buildPadView` drops an action whose band exceeds the ACTIVE band, so an
 * entitled-but-scoring-low org must never be shown a tile that band would
 * refuse.
 */
export const EVENT_BAND: Readonly<Record<string, FidelityBand>> = {
  [SET_SUMMARY_TYPE]: 0,
  [SANCTION_TYPE]: 1,
  [INTERRUPTION_TYPE]: 1,
  [POINT_TYPE]: 3,
  [GAME_AWARD_TYPE]: 3,
};

function withinBand(eventType: string, band: FidelityBand): boolean {
  const declared = EVENT_BAND[eventType];
  return declared === undefined || declared <= band;
}

// ---------------------------------------------------------------------------
// State/cfg readers. `PadHostView.state`/`.cfg` are `unknown` by contract;
// every reader degrades cleanly from `{}`, never throws — the same posture
// every v3 skin's own readers take.
// ---------------------------------------------------------------------------

interface TennisClosedSet {
  home?: number;
  away?: number;
  tb?: { home?: number; away?: number };
  mtb?: boolean;
}
type TennisPoints =
  | { kind: "standard"; home?: number; away?: number; advantage?: Side | null }
  | { kind: "tiebreak" | "matchTiebreak"; home?: number; away?: number };

interface TennisStateShape {
  phase?: string;
  entrants?: { home?: string; away?: string };
  sets?: TennisClosedSet[];
  games?: { home?: number; away?: number };
  points?: TennisPoints;
  setsWon?: { home?: number; away?: number };
  serving?: string;
}

type TennisFinalSet = "same" | { matchTiebreakTo: number } | { tiebreakTo: number };
interface TennisCfgShape {
  bestOf?: number;
  set?: { gamesTo?: number; winBy?: number; tiebreakAt?: number | null; tiebreakTo?: number };
  finalSet?: TennisFinalSet;
  tiebreak?: { winBy?: number };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asState(state: unknown): TennisStateShape {
  return asRecord(state) as TennisStateShape;
}
function asCfg(cfg: unknown): TennisCfgShape {
  return asRecord(cfg) as TennisCfgShape;
}

/** `NestedState.phase`'s default (`kernel.ts:1933`'s own `init`). */
function readPhase(state: TennisStateShape): string {
  return typeof state.phase === "string" && state.phase.length > 0 ? state.phase : "pre";
}

/** The real entrant id, off `state.entrants` — present from tennis's very
 *  first fold. Falls back to the literal side name only for a pad mounted
 *  before any state exists, which the server refuses anyway (football's
 *  `entrantOf` takes the identical position). */
function entrantOf(state: TennisStateShape, side: Side): string {
  const id = state.entrants?.[side];
  return typeof id === "string" && id.length > 0 ? id : side;
}

function sideOfEntrant(state: TennisStateShape, entrantId: unknown): Side | null {
  for (const side of SIDES) if (entrantOf(state, side) === entrantId) return side;
  return null;
}

function vocabKey(field: string, value: string): MessageKey | null {
  for (const map of ENUM_VOCAB[field] ?? []) {
    const key = map[value];
    if (key) return key;
  }
  return null;
}
function vocabText(field: string, value: unknown, t: TFn): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const key = vocabKey(field, value);
  return key ? t(key) : value;
}

// ---------------------------------------------------------------------------
// phase() — build spec §2. `NestedState.phase` is `pre|live|done|final|
// abandoned` (`kernel.ts:393`); the kernel already collapses the last three
// pairwise at `:1143`/`:1155` — mirror that, never give a sub-phase its own
// `PadPhase` slot.
// ---------------------------------------------------------------------------

const POST_PHASES = new Set(["done", "final", "abandoned"]);

export function resolvePhase(view: Pick<PadHostView, "state">): PadPhase {
  const phase = readPhase(asState(view.state));
  if (phase === "pre") return "pre";
  if (POST_PHASES.has(phase)) return "post";
  return "live";
}

// ---------------------------------------------------------------------------
// Engine-private re-derivations. `isDecidingSet`/`rulesFor`/`setInProgress`
// restate kernel.ts functions the kernel itself keeps MODULE-PRIVATE (see
// this file's header) — there is no barrel gap left to close for these
// three, only a boundary this fix does not cross. Every function here still
// restates a SPECIFIC, cited kernel.ts range; none invents tennis domain
// logic of its own.
// ---------------------------------------------------------------------------

/** `isDecidingSet` (`kernel.ts:692-695`). */
function isDecidingSet(state: TennisStateShape, cfg: TennisCfgShape): boolean {
  const bestOf = cfg.bestOf ?? 3;
  const need = Math.ceil(bestOf / 2) - 1;
  return (state.setsWon?.home ?? 0) === need && (state.setsWon?.away ?? 0) === need;
}

interface TennisSetRules {
  tiebreakAt: number | null;
  tiebreakTo: number;
  mtbTo: number | null;
}

/** `rulesFor` (`kernel.ts:697-703`) — which rules govern the set ABOUT TO BE
 *  PLAYED, i.e. the one `state.games`/`state.points` are currently tracking.
 *  Defaults mirror tennis's own shipped "tour" variant (`tennis.ts:17-24`)
 *  only as a degrade-safe fallback for a `{}` fixture — a real `view.cfg` is
 *  always the module's own fully-parsed, defaulted config. */
function rulesFor(state: TennisStateShape, cfg: TennisCfgShape): TennisSetRules {
  const set = cfg.set ?? {};
  const tiebreakAt = set.tiebreakAt === undefined ? 6 : set.tiebreakAt;
  const base: TennisSetRules = { tiebreakAt, tiebreakTo: set.tiebreakTo ?? 7, mtbTo: null };
  const finalSet = cfg.finalSet ?? "same";
  if (!isDecidingSet(state, cfg) || finalSet === "same") return base;
  if ("matchTiebreakTo" in finalSet) return { ...base, mtbTo: finalSet.matchTiebreakTo };
  return { ...base, tiebreakTo: finalSet.tiebreakTo }; // the slam rule: same tiebreakAt, richer target
}

/** `setInProgress` (`kernel.ts:1107-1111`) — D-16's gate. Scoped to the
 *  CURRENT set only: `bankSet` (`kernel.ts:753-789`) resets both
 *  `state.games` and `state.points` the moment a set closes, so this can
 *  never read a past set as "in progress". */
function setInProgressOf(state: TennisStateShape): boolean {
  if ((state.games?.home ?? 0) > 0 || (state.games?.away ?? 0) > 0) return true;
  return (state.points?.home ?? 0) > 0 || (state.points?.away ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// serveContext — genuinely consumed from the engine (R4-3, restored). The
// barrel this fix adds (`packages/engine/src/sports/nested/index.ts`) makes
// this section one delegating function instead of five mirrored ones: what
// used to be `nestedGamesOfMirror`/`completedGamesMirror`/`pairOrderOfMirror`
// /`expectedPairServerMirror`/`serveContextMirror` existed only to recompose
// `serveContext`'s own answer by hand — importing the composed answer is
// strictly closer to R4-3's intent than re-importing the pieces and
// recomposing them here would have been, since that recomposition (`side =
// state.serving`, `serviceTurn = floor(completedGames/2)`, ...) was exactly
// the fork risk the ruling names.
// ---------------------------------------------------------------------------

interface ServeContext {
  side: Side;
  serviceTurn: number;
  personId: string | null;
}

/**
 * Adapts `PadHostView`'s split shape into `serveContext`'s real input, then
 * delegates outright — no recomputation. `.state` and `.squads` are separate
 * fields on `PadHostView`, where `NestedState.squads` is one of `.state`'s
 * own properties (`kernel.ts:426`), so this builds the one object the real
 * function expects rather than casting `view.state` wholesale.
 *
 * Every field `serveContext`'s call graph actually reads — `serving`,
 * `sets`, `games` (transitively, via `completedGames`/`nestedGamesOf`), and
 * `squads` (via `expectedDoublesServer`) — is defaulted exactly as the
 * deleted mirrors defaulted it, so a `{}`/pre-fold state behaves identically
 * to before this change; every OTHER `NestedState` field (`cfg`, `entrants`,
 * `phase`, `points`, `setsWon`, `outcome`, ...) is provably unread by that
 * call graph (checked against kernel.ts), so the cast below never asserts
 * something the call actually depends on.
 */
function deriveServeContext(state: TennisStateShape, squads: SquadState): ServeContext {
  const shim = {
    serving: state.serving === "away" ? "away" : "home",
    sets: (state.sets ?? []).map((set) => ({
      home: set.home ?? 0,
      away: set.away ?? 0,
      ...(set.mtb === undefined ? {} : { mtb: set.mtb }),
    })),
    games: { home: state.games?.home ?? 0, away: state.games?.away ?? 0 },
    squads,
  } as unknown as NestedState;
  return serveContext(shim);
}

/**
 * A tier-0 `tennis.set_summary` never moves `state.serving` (`bankSet`,
 * `kernel.ts:753-789`, never calls `serveAfterGame`), so once ANY set has
 * ever been coarse-scored, `state.serving` — and everything derived from it —
 * is stale BY CONSTRUCTION for the REST of the match, not merely "during"
 * that one set: `completedGames` keeps counting correctly off the summary's
 * own numbers, but the side that toggles with it does not, so the two
 * desynchronise and never resynchronise. `resolveVoids` first, so a
 * set-summary that was recorded and then undone before anything else folded
 * never poisons this — it genuinely never happened.
 */
function hasStaleServeInfo(view: PadHostView): boolean {
  return resolveVoids(view.events as EventEnvelope[]).some((event) => event.type === SET_SUMMARY_TYPE);
}

/** The starting roster for one side, first-named first (pairOrder, falling
 *  back to team-sheet order) — `positions.lineup.size = 1` is ONE nominated
 *  unit (`tennis.ts:9`), one person for an individual entrant, two for a
 *  pair (D-3's false premise: a unit is not a person count). `view.squads`
 *  is always populated (`initSquads(lineups)` fallback, `v3/types.ts`'s own
 *  doc), so this never has to branch on singles vs. doubles. */
function onFieldPlayers(squads: SquadState, side: Side): readonly SquadState["home"]["members"][number][] {
  return squads[side].members
    .filter((member) => member.onField && member.role === "player")
    .slice()
    .sort((a, b) => {
      const pa = a.pairOrder ?? Number.POSITIVE_INFINITY;
      const pb = b.pairOrder ?? Number.POSITIVE_INFINITY;
      return pa !== pb ? pa - pb : a.orderNo - b.orderNo;
    });
}

interface ServingInfo {
  side: Side;
  personId: string | null;
}

/**
 * Who is serving right now, or `null` when that answer cannot be trusted
 * (`hasStaleServeInfo`) — an omitted fact beats an authoritative-looking
 * wrong one (build spec §1).
 *
 * R4 ruling: a SINGLES side (one on-field player) names its own sole member
 * directly whenever it is that side's turn to serve — "the only member", not
 * a second copy of the ITF pair-rotation rule `serveContext` (via
 * `expectedDoublesServer`) already implements. Doubles defers to the real
 * rotation, which answers `null` for an undeclared pair order rather than
 * guessing.
 */
function servingInfo(view: PadHostView): ServingInfo | null {
  if (hasStaleServeInfo(view)) return null;
  const state = asState(view.state);
  const ctx = deriveServeContext(state, view.squads);
  const players = onFieldPlayers(view.squads, ctx.side);
  if (players.length <= 1) return { side: ctx.side, personId: players[0]?.personId ?? null };
  return { side: ctx.side, personId: ctx.personId };
}

// ---------------------------------------------------------------------------
// scorebug() — tapModel S.
// ---------------------------------------------------------------------------

const CALLS = ["0", "15", "30", "40"] as const;

/** The points as a scorer WORDS them, for one half — `gameScoreLine`
 *  (`kernel.ts:1242-1257`)'s per-side twin: that function renders both sides
 *  as one spoken line, and `ScorebugHalf.big` needs exactly one side's word. */
function pointBig(points: TennisPoints | undefined, side: Side): string {
  // `points === undefined` folds into the "standard, love-all" branch — an
  // absent `points` degrades exactly like a fresh game would, never like a
  // tiebreak. Checked as ONE condition (rather than defaulting `points` to a
  // literal via `??`) so the union stays genuinely discriminated: TypeScript
  // narrows `points` to the "standard" member below, `advantage` included.
  if (points === undefined || points.kind === "standard") {
    const home = points?.home ?? 0;
    const away = points?.away ?? 0;
    if (home === 3 && away === 3) return points?.advantage === side ? "AD" : "40";
    const idx = (side === "home" ? home : away) as 0 | 1 | 2 | 3;
    return CALLS[idx] ?? "0";
  }
  return String(points[side] ?? 0);
}

/** "Best of 3 · Set 2", plus "· Tie-break" while `points.kind` is a tiebreak
 *  or a match tiebreak (build spec §1) — extended to `matchTiebreak` on top
 *  of the brief's literal "tiebreak" wording, deliberately: an unexplained
 *  jump to double-digit "points" with no set context read as a bug in
 *  review, and the same suffix reads correctly for both shapes. */
function buildContext(state: TennisStateShape, cfg: TennisCfgShape, t: TFn): string {
  const bestOf = cfg.bestOf ?? 3;
  const setNumber = (state.sets?.length ?? 0) + 1;
  const base = t("pad.tennis.context.line", { bestOf, set: setNumber });
  const kind = state.points?.kind;
  return kind === "tiebreak" || kind === "matchTiebreak" ? `${base} · ${t("pad.tennis.context.tiebreak")}` : base;
}

function buildHalf(
  view: PadHostView,
  state: TennisStateShape,
  side: Side,
  serving: ServingInfo | null,
  t: TFn,
): ScorebugHalf {
  const players = onFieldPlayers(view.squads, side);
  const servingPersonId = serving && serving.side === side ? serving.personId : null;
  const who: WhoLine[] =
    players.length > 0
      ? players.map((member) => {
          const isServing = servingPersonId !== null && member.personId === servingPersonId;
          return {
            name: view.personNames[member.personId] ?? t("eventCopy.unknownPerson"),
            ...(isServing ? { serving: true, servingLabel: t("pad.tennis.scorebug.serving") } : {}),
          };
        })
      : [{ name: t(SIDE_LABEL[side]) }]; // defensive: assertScorebugSpec requires a non-empty `who`

  // Band 3 gate (build spec §1): below it `tennis.point` is unreachable (it
  // is a band-3 event itself), so a tappable half there would be a dead-end
  // tap. WITHHELD above the ACTIVE band, not merely the entitled one — the
  // same `filterTilesByBand` vs. `buildPadView` distinction football's own
  // `EVENT_BAND` doc states.
  const tappable = resolvePhase(view) === "live" && view.band >= 3;
  const server = serving?.personId ?? undefined;
  return {
    who,
    big: pointBig(state.points, side),
    tappable,
    ...(tappable
      ? {
          hintKey: "pad.tennis.scorebug.point.hint",
          tapEvent: {
            type: POINT_TYPE,
            payload: { by: entrantOf(state, side), ...(server !== undefined ? { server } : {}) },
          },
        }
      : {}),
  };
}

/** Whether the ends should currently read as swapped relative to the start
 *  of the set (or the tie-break) — build spec §1: "after the 1st game … and
 *  every 2 games thereafter" is "whenever the completed-game total is ODD",
 *  and "every 6 points inside a tiebreak" is the identical rule one level
 *  down. DERIVED, no state field — there is no ends-change anywhere in
 *  `nested/kernel.ts` (checked). */
function endsChanged(state: TennisStateShape): boolean {
  const kind = state.points?.kind;
  if (kind === "tiebreak" || kind === "matchTiebreak") {
    const total = (state.points?.home ?? 0) + (state.points?.away ?? 0);
    return Math.floor(total / 6) % 2 === 1;
  }
  const completed = (state.games?.home ?? 0) + (state.games?.away ?? 0);
  return completed % 2 === 1;
}

function buildStrip(view: PadHostView, state: TennisStateShape, serving: ServingInfo | null, t: TFn): StripItem[] {
  const items: StripItem[] = [
    {
      id: "sets",
      label: t("pad.tennis.scorebug.strip.sets"),
      value: `${state.setsWon?.home ?? 0}–${state.setsWon?.away ?? 0}`,
    },
    {
      id: "games",
      label: t("pad.tennis.scorebug.strip.games"),
      value: `${state.games?.home ?? 0}–${state.games?.away ?? 0}`,
    },
  ];
  // Omitted, not rendered stale, whenever `servingInfo` cannot answer —
  // build spec §1's "an authoritative-looking wrong answer is worse than an
  // omitted one" applied to the strip rather than the WhoLine dot.
  if (serving) {
    const value = serving.personId
      ? (view.personNames[serving.personId] ?? t("eventCopy.unknownPerson"))
      : t(SIDE_LABEL[serving.side]);
    items.push({ id: "server", label: t("pad.tennis.scorebug.strip.server"), value });
  }
  if (endsChanged(state)) {
    items.push({ id: "ends", value: t("pad.tennis.scorebug.strip.endsChanged") });
  }
  return items;
}

export function buildScorebug(view: PadHostView, t: TFn): ScorebugSpec {
  const state = asState(view.state);
  const cfg = asCfg(view.cfg);
  const serving = servingInfo(view);
  return {
    context: buildContext(state, cfg, t),
    phase: resolvePhase(view),
    halves: [buildHalf(view, state, "home", serving, t), buildHalf(view, state, "away", serving, t)],
    strip: buildStrip(view, state, serving, t),
  };
}

// ---------------------------------------------------------------------------
// tiles() — build spec §3.
// ---------------------------------------------------------------------------

export function sanctionSheetKey(side: Side): string {
  return `sanction-${side}`;
}
export function gameAwardTileId(side: Side): string {
  return `gameAward-${side}`;
}

export function buildTiles(view: PadHostView): TileSpec[] {
  const state = asState(view.state);
  const live = resolvePhase(view) === "live";
  const band = view.band;
  const offerable = (eventType: string): boolean => live && withinBand(eventType, band);
  const tiles: TileSpec[] = [];

  // ORDER IS LOAD-BEARING (`reference_v3_board_two_lanes_and_dock_after_
  // sheet.md`; the exact defect this note warns about is football's own
  // R3/B2 incident: three card tiles per side put Home's second yellow
  // bodily inside the away lane, 65 green unit assertions notwithstanding).
  // `tile-grid.tsx` is a bare `grid-cols-4`; nothing checks that a side pair
  // lands home-left/away-right — array order IS row/column order. Both
  // side-paired actions below (Code violation, Award game) are each pushed
  // as an ATOMIC 0-or-2 block sharing one condition, so putting them BOTH
  // before any single, side-less tile keeps their combined preceding count
  // a multiple of 2 in every band/state combination — home always col 0,
  // away always col 2. `setScore`/`interruption` carry no side identity, so
  // where THEY land is cosmetic; do not reorder them ahead of the pairs.

  // Code violation — per side, mirroring football's per-side Card tile:
  // `NestedSanction.by` is REQUIRED, so the side is fixed by WHICH tile was
  // tapped rather than asked inside the sheet.
  if (offerable(SANCTION_TYPE)) {
    for (const side of SIDES) {
      tiles.push({
        id: sanctionSheetKey(side),
        label: "pad.tennis.action.sanction",
        sublabel: SIDE_LABEL[side],
        kind: "standard",
        span: 2,
        phases: ["live"],
        action: { sheet: sanctionSheetKey(side) },
      });
    }
  }

  // Award game — per side, direct commit (no sheet): `NestedGameAward.winner`
  // is the whole payload bar an uncollectable free-text `reason` (no text
  // step exists, per build spec §5's identical ruling for the sanction's own
  // `reason`). NOT while a tie-break/match-tie-break is in force — the
  // breaker itself IS the deciding game (`applyGameAward`, `kernel.ts:
  // 1081-1101`; mirrored here via `state.points.kind`, the SAME condition the
  // engine's own gate reads, `kernel.ts:1526-1532`).
  if (offerable(GAME_AWARD_TYPE) && (state.points?.kind ?? "standard") === "standard") {
    for (const side of SIDES) {
      tiles.push({
        id: gameAwardTileId(side),
        label: "pad.tennis.action.gameAward",
        sublabel: SIDE_LABEL[side],
        kind: "minor",
        span: 2,
        phases: ["live"],
        action: { event: { type: GAME_AWARD_TYPE, payload: { winner: entrantOf(state, side) } } },
      });
    }
  }

  // Set score — D-16. Withheld while the CURRENT set is in progress; the
  // paired `refusedEventTypes` entry is what keeps the generic More sheet
  // from offering the same refused action a second time.
  if (offerable(SET_SUMMARY_TYPE) && !setInProgressOf(state)) {
    tiles.push({
      id: "setScore",
      label: "pad.tennis.action.setScore",
      kind: "standard",
      span: 2,
      phases: ["live"],
      action: { sheet: "setScore" },
    });
  }

  // Interruption — R4-2: replaces the brief's Retire tile. `by` is OPTIONAL
  // on `NestedInterruption` (a rain delay is charged to nobody), so this is
  // ONE generic tile, not per-side — the sheet itself asks which side, if any.
  if (offerable(INTERRUPTION_TYPE)) {
    tiles.push({
      id: "interruption",
      label: "pad.tennis.action.interruption",
      kind: "minor",
      span: 2,
      phases: ["live"],
      action: { sheet: "interruption" },
    });
  }

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
 * `SkinDefV3.refusedEventTypes` — the More sheet's second exclusion set:
 * "the fold will not accept this at all right now".
 *
 * ONE entry, and it is a real refusal. `applySetSummary` throws for a set
 * already being scored point-by-point (`nested/kernel.ts`), so offering the
 * generic form mid-set is the D-16 dead-end tap this wave closes. Listed only
 * in that state, mirroring `buildTiles`'s own withholding condition exactly —
 * the two must never disagree, or the pad either hides a legal action or
 * offers a refused one.
 *
 * `tennis.point` USED TO BE LISTED HERE and no longer is. It was never a
 * refusal — the fold accepts a point whenever the match is live — it was this
 * contract being borrowed as a "reachable elsewhere" lever, because
 * `dedicatedEventTypes` computed that only from tiles/sheets/swaps and could
 * not see that a tapModel-S scorebug half IS an entry point. R3 kept the two
 * sets apart deliberately (`_INDEX.md`: "a later reader must be able to tell
 * which reason applied"), and collapsing them here would have made this skin
 * the first to defeat that distinction.
 *
 * The chassis learned about tap model S instead (`pad-host.tsx`'s
 * `dedicatedEventTypes`, owner-authorised), so the half's own `tapEvent` now
 * de-duplicates the point the same way a tile's `event` always did. This
 * function went back to meaning what it says.
 */
export function refusedEventTypes(view: PadHostView): string[] {
  const state = asState(view.state);
  return setInProgressOf(state) ? [SET_SUMMARY_TYPE] : [];
}

// ---------------------------------------------------------------------------
// sheets() — a METHOD of the view (rebuilt per render), matching the standing
// convention every v3 skin's `sheets` takes.
// ---------------------------------------------------------------------------

/** `gamesFieldBound` (`kernel.ts:1382-1391`) — no counterpart to import (not
 *  exported; see this file's header), and the real kernel function computes
 *  it straight off `cfg` too rather than via `rulesFor`, so there is no
 *  already-imported reader to derive this from either. A re-derivation, kept
 *  and renamed rather than left claiming to mirror something reachable. */
function gamesFieldBound(cfg: TennisCfgShape): number {
  const set = cfg.set ?? {};
  const base = set.tiebreakAt === null ? 200 : (set.gamesTo ?? 6) + (set.winBy ?? 2) + 2;
  const finalSet = cfg.finalSet;
  const mtb = finalSet && typeof finalSet === "object" && "matchTiebreakTo" in finalSet ? finalSet.matchTiebreakTo + 2 : 0;
  return Math.max(base, mtb);
}
/** `tbFieldBound` (`kernel.ts:1396-1403`) — same posture as `gamesFieldBound`
 *  above: no export to consume, and the kernel's own version reads `cfg`
 *  directly rather than through `rulesFor`. */
function tbFieldBound(cfg: TennisCfgShape): number {
  const ordinary = (cfg.set?.tiebreakTo ?? 7) + (cfg.tiebreak?.winBy ?? 2) + 2;
  const finalSet = cfg.finalSet;
  const decider =
    finalSet && typeof finalSet === "object" && "tiebreakTo" in finalSet
      ? finalSet.tiebreakTo + (cfg.tiebreak?.winBy ?? 2) + 2
      : 0;
  return Math.max(ordinary, decider);
}

/** Whether a `home`/`away` games pair is the tie-break SET-SCORE shape
 *  (`tiebreakAt+1 : tiebreakAt`, either order) that `applySetSummary`
 *  requires a `tb` block for in strict mode (`kernel.ts:1151-1156`). `false`
 *  outright when the current set is a match-tie-break decider — that shape
 *  carries its points in `home`/`away` directly and REFUSES a `tb` block
 *  (`kernel.ts:1136-1138`) — and when the set has no tie-break at all
 *  (advantage set, `tiebreakAt: null`). */
function isTbShape(home: number, away: number, rules: TennisSetRules): boolean {
  if (rules.mtbTo !== null || rules.tiebreakAt === null) return false;
  const at = rules.tiebreakAt;
  return (home === at + 1 && away === at) || (away === at + 1 && home === at);
}

function setScoreSheet(view: PadHostView): GuidedSheetSpec {
  const state = asState(view.state);
  const cfg = asCfg(view.cfg);
  const rules = rulesFor(state, cfg);
  const gamesBound = gamesFieldBound(cfg);
  const tbBound = tbFieldBound(cfg);
  const tbShape: StepPredicate = (answers) => {
    const home = Number(answers.home);
    const away = Number(answers.away);
    return Number.isFinite(home) && Number.isFinite(away) && isTbShape(home, away, rules);
  };
  const steps: GuidedSheetStep[] = [
    { id: "home", kind: "number", title: "pad.tennis.sheet.setScore.home.title", initial: 0, min: 0, max: gamesBound },
    { id: "away", kind: "number", title: "pad.tennis.sheet.setScore.away.title", initial: 0, min: 0, max: gamesBound },
    {
      id: "tbHome",
      kind: "number",
      title: "pad.tennis.sheet.setScore.tbHome.title",
      initial: 0,
      min: 0,
      max: tbBound,
      when: tbShape,
    },
    {
      id: "tbAway",
      kind: "number",
      title: "pad.tennis.sheet.setScore.tbAway.title",
      initial: 0,
      min: 0,
      max: tbBound,
      when: tbShape,
    },
  ];
  return {
    event: SET_SUMMARY_TYPE,
    steps,
    buildPayload: (answers) => {
      const home = Number(answers.home);
      const away = Number(answers.away);
      return {
        home,
        away,
        ...(tbShape(answers) ? { tb: { home: Number(answers.tbHome), away: Number(answers.tbAway) } } : {}),
      };
    },
  };
}

/** The code-violation sheet for one FIXED side (the tile that opened it).
 *  `person` is asked as a SHEET STEP here, unlike football's card (which
 *  defers the person to the dock) — build spec §5's own instruction.
 *  `NestedSanction.reason` is free text and there is no text step, so it is
 *  not collected from the pad; `by` names the OFFENDER (the engine's own
 *  convention — `game.award.winner` is the opposite party, `kernel.ts:
 *  336-343`). */
function sanctionSheet(view: PadHostView, side: Side): GuidedSheetSpec {
  const state = asState(view.state);
  const by = entrantOf(state, side);
  const candidates = onFieldPlayers(view.squads, side).map((member) => member.personId);
  const steps: GuidedSheetStep[] = [
    {
      id: "level",
      kind: "choice",
      title: "pad.tennis.sheet.sanction.level.title",
      options: SANCTION_LEVELS.map((level) => ({
        id: level,
        label: vocabKey("level", level) ?? level,
        ...(SANCTION_LEVEL_TONE[level] ? { tone: SANCTION_LEVEL_TONE[level] } : {}),
      })),
    },
    {
      id: "person",
      kind: "person",
      title: "pad.tennis.sheet.sanction.person.title",
      pool: "onfield",
      side,
      candidates,
    },
  ];
  return {
    event: SANCTION_TYPE,
    steps,
    buildPayload: (answers) => ({ by, level: answers.level, person: answers.person }),
  };
}

/**
 * The interruption sheet — R4-2's replacement for the brief's Retire tile.
 * `NestedInterruption.by`/`.person` are BOTH optional (a rain delay is
 * charged to nobody), which the generic sheet chassis cannot express as a
 * skippable step (`renderCandidateRow`/`renderChoiceRow` always require a
 * real tap to advance) — so the "side" step carries an explicit `none`
 * option, and `person` is gated to fire only once a real side is chosen
 * (build spec §5: "person REQUIRES by … gate the step accordingly or the tap
 * dead-ends"). Two static person steps (one per side), never one dynamic
 * step: `SheetPersonStep.candidates`/`.side` are fixed at `sheets(view)`
 * build time, not a function of an earlier answer in the SAME sheet — the
 * `when` gate is what is dynamic, not the candidate list.
 */
function interruptionSheet(view: PadHostView): GuidedSheetSpec {
  const state = asState(view.state);
  const sideIsHome: StepPredicate = (answers) => answers.side === "home";
  const sideIsAway: StepPredicate = (answers) => answers.side === "away";
  const steps: GuidedSheetStep[] = [
    {
      id: "kind",
      kind: "choice",
      title: "pad.tennis.sheet.interruption.kind.title",
      options: INTERRUPTION_KINDS.map((kind) => ({ id: kind, label: vocabKey("kind", kind) ?? kind })),
    },
    {
      id: "side",
      kind: "choice",
      title: "pad.tennis.sheet.interruption.side.title",
      options: [
        { id: "home", label: SIDE_LABEL.home },
        { id: "away", label: SIDE_LABEL.away },
        { id: "none", label: "pad.tennis.sheet.interruption.side.none" },
      ],
    },
    {
      id: "personHome",
      kind: "person",
      title: "pad.tennis.sheet.interruption.person.title",
      pool: "onfield",
      side: "home",
      candidates: onFieldPlayers(view.squads, "home").map((member) => member.personId),
      when: sideIsHome,
    },
    {
      id: "personAway",
      kind: "person",
      title: "pad.tennis.sheet.interruption.person.title",
      pool: "onfield",
      side: "away",
      candidates: onFieldPlayers(view.squads, "away").map((member) => member.personId),
      when: sideIsAway,
    },
    {
      id: "duration",
      kind: "number",
      title: "pad.tennis.sheet.interruption.duration.title",
      initial: 0,
      min: 0,
      // Mirrors `nested/kernel.ts`'s own `PLAUSIBLE_INTERRUPTION_SECONDS`
      // sentinel (`kernel.ts:1410`) — a plausibility bound, not an ITF rule:
      // the allowance itself is recorded/flagged, never refused.
      max: 3600,
    },
  ];
  return {
    event: INTERRUPTION_TYPE,
    steps,
    buildPayload: (answers) => {
      const side = answers.side === "home" || answers.side === "away" ? answers.side : undefined;
      const by = side ? entrantOf(state, side) : undefined;
      const person = answers.personHome ?? answers.personAway;
      const duration = Number(answers.duration);
      return {
        kind: answers.kind,
        ...(by !== undefined ? { by } : {}),
        ...(person !== undefined ? { person } : {}),
        ...(Number.isFinite(duration) ? { duration } : {}),
      };
    },
  };
}

export function buildSheets(view: PadHostView): Record<string, GuidedSheetSpec> {
  const sheets: Record<string, GuidedSheetSpec> = {
    setScore: setScoreSheet(view),
    interruption: interruptionSheet(view),
  };
  for (const side of SIDES) sheets[sanctionSheetKey(side)] = sanctionSheet(view, side);
  return sheets;
}

// ---------------------------------------------------------------------------
// dock() — build spec §4, the wave's real product value. Only `tennis.point`
// has a dock; every other tennis event commits complete on tap/sheet-close.
// ---------------------------------------------------------------------------

function sideOfPerson(squads: SquadState, personId: string): Side | null {
  for (const side of SIDES) if (squads[side].members.some((member) => member.personId === personId)) return side;
  return null;
}

function pointKindChip(kind: string): DockChip {
  return {
    id: kind,
    label: vocabKey("kind", kind) ?? kind,
    mutate: (payload) => ({ ...payload, meta: { ...(isRecord(payload.meta) ? payload.meta : {}), kind } }),
  };
}

export function buildDock(
  eventType: string,
  view: PadHostView,
  t: TFn,
  payload?: Record<string, unknown>,
): DockSpec | null {
  if (eventType !== POINT_TYPE) return null;
  const state = asState(view.state);
  const side = typeof payload?.by === "string" ? sideOfEntrant(state, payload.by) : null;
  const server = typeof payload?.server === "string" ? payload.server : undefined;
  const meta = isRecord(payload?.meta) ? payload.meta : undefined;
  const kind = typeof meta?.kind === "string" ? meta.kind : undefined;
  const title = t("pad.tennis.dock.point.title");

  // One-way, and the alternatives leave (build spec §4): once a kind lands,
  // the dock shows ONLY that chip — a second tap re-affirms the same value
  // (the chassis's own no-inverse rule), never offers the other three
  // alongside a payload that already holds the last one.
  //
  // THIS BRANCH IS UNIT-TESTABLE AND UNIT-PROVABLE, AND THAT IS NOT ENOUGH —
  // see this file's own unit tests, which call `buildDock` directly with a
  // hand-built `payload.meta.kind` already set, the same way every test
  // before R3's "shipped inert" incident did. What that incident proved is
  // that a pure builder whose output depends on live state can be fully
  // testable and fully inert AT THE SAME TIME: whether tapping "Ace" ACTUALLY
  // re-renders this dock down to one chip depends entirely on `DetailDock`'s
  // `setSpec`/`dockStore` mirror (pad-host.tsx, `0b709fadd`) re-invoking this
  // function with the ADVANCED payload — a real React re-render this file's
  // node-environment unit tests cannot exercise at all. The e2e task (out of
  // this task's grant) MUST tap a chip on a live point and assert the
  // resulting event's DRAINED `meta.kind`, not merely that this function
  // returns the right thing when handed the answer already.
  if (kind !== undefined) return { title, chips: [pointKindChip(kind)] };

  // Legality by SIDE, read from the PAYLOAD — by the time the dock renders,
  // the optimistic fold has already advanced past this point, so `view.state`
  // cannot answer "who served THIS point" any more. An ace is the SERVER's
  // point; a double fault is the RECEIVER's. Neither is offered when the
  // server is unknown (an undeclared doubles order, or a match with any
  // history of coarse set-scoring) — winner/ue stay available regardless.
  const serverSide = server !== undefined ? sideOfPerson(view.squads, server) : null;
  const chips: DockChip[] = [];
  if (side !== null && serverSide !== null) {
    if (side === serverSide) chips.push(pointKindChip("ace"));
    else chips.push(pointKindChip("double_fault"));
  }
  chips.push(pointKindChip("winner"));
  chips.push(pointKindChip("ue"));
  return { title, chips };
}

// ---------------------------------------------------------------------------
// activityDetail() — the ribbon's varying half. Five keys for five event
// types (`pad.tennis.ribbon.*`) — the brief said four; the engine declares
// five (`kernel.ts:1766-1772`), and this skin's ribbon coverage is complete.
// ---------------------------------------------------------------------------

function join(parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return kept.length > 0 ? kept.join(" · ") : undefined;
}

export function tennisDetail(ctx: ActivityDetailContext): string | undefined {
  const { t, eventType, payload, personNames } = ctx;
  const named = (id: unknown): string | undefined =>
    typeof id === "string" && id.length > 0 ? (personNames?.[id] ?? t("eventCopy.unknownPerson")) : undefined;
  const reasonOf = (): string | undefined => (typeof payload.reason === "string" ? payload.reason : undefined);

  switch (eventType) {
    case POINT_TYPE: {
      const meta = isRecord(payload.meta) ? payload.meta : undefined;
      return join([vocabText("kind", meta?.kind, t), named(payload.server)]);
    }
    case SET_SUMMARY_TYPE: {
      const home = payload.home;
      const away = payload.away;
      const tb = isRecord(payload.tb) ? payload.tb : undefined;
      const score = typeof home === "number" && typeof away === "number" ? `${home}–${away}` : undefined;
      const tbLine =
        tb && typeof tb.home === "number" && typeof tb.away === "number" ? `(${tb.home}-${tb.away})` : undefined;
      return join([score, tbLine]);
    }
    case SANCTION_TYPE:
      return join([vocabText("level", payload.level, t), named(payload.person), reasonOf()]);
    case INTERRUPTION_TYPE:
      return join([vocabText("kind", payload.kind, t), named(payload.person)]);
    case GAME_AWARD_TYPE:
      // `winner` is an ENTRANT id; `ActivityDetailContext` carries no fold
      // state to resolve which side that is (unlike `payload`/`personNames`,
      // it is not part of this contract) — the free-text reason is the one
      // fact this function CAN add.
      return join([reasonOf()]);
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// The factory.
// ---------------------------------------------------------------------------

export function tennisSkinV3(t: TFn): SkinDefV3<PadHostView> {
  return {
    key: "tennis",
    tapModel: "S",
    phase: resolvePhase,
    scorebug: (view) => buildScorebug(view, t),
    tiles: buildTiles,
    dock: (eventType, view, payload) => buildDock(eventType, view, t, payload),
    sheets: buildSheets,
    refusedEventTypes,
    activityDetail: tennisDetail,
    // No swap()/context()/contextSelect() — see this file's header.
  };
}
