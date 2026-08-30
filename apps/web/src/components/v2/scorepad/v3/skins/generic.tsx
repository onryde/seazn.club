// Generic SkinDefV3 — R7/A1, tapModel S. Converts `generic` to the v3 chassis
// (design of record `docs/superpowers/specs/2026-08-15-scoringpad-v3-redesign-
// design.md` §2/§3). Replaces the universal renderer (`../../pad-renderer.tsx`
// via `RESOLUTION_KIND.generic = "universal"`) as GENERIC'S pad surface only —
// carrom and boardgame still resolve there until their own tasks land.
//
// GENERIC IS NOT A FALLBACK SCREEN. It is a first-class, user-selectable
// catalog entry named "Generic", and it is the scoring experience for every
// sport this engine does not model — netball, squash, padel, kabaddi. Its
// scorer has already had one disappointment (their sport is not in the list)
// before they ever reach the pad, so the design stance here is HONESTY, not
// apology: the pad states exactly what it knows — two sides and a number, or
// two sides and a winner — and invents no vocabulary it cannot back. There is
// no "Goal", no "Rally", no period structure, because generic's own DOMAIN.md
// draws that line and the pad must not cross it.
//
// PURE DATA, no React — the same testability stance every v3 skin takes
// (apps/web vitest is `environment: "node"`, no jsdom). FACTORY, not a bare
// object: `ScorebugSpec.context`, `WhoLine.name` and `DockSpec.title` are
// pre-resolved TEXT, and no `SkinDefV3` method itself receives `t`
// (registry.ts's header carries the full reasoning). `t` IS REQUIRED
// EVERYWHERE, NEVER DEFAULTED — the cricket `buildTiles(view, t = (key) =>
// key)` incident this repo already paid for once
// (`reference_v3_labeltext_and_default_t_threading.md`).
//
// THE VARIANT CHANGES THE PAD, and generic is the only R7 sport where that is
// true. `padSpec(cfg)` (generic.ts) branches on `cfg.resultMode`, and so does
// every builder below:
//
//  * "score"    — a RUNNING TALLY. A half tap commits `generic.score
//                 {by, points: 1}` immediately; the ~6s dock amends the AMOUNT
//                 on that same held submission (2/3/5) rather than posting a
//                 second event, and names the scorer when the side has more
//                 than one player.
//  * "win_loss" — RESULT ONLY. A half tap commits `generic.result {winnerId}`
//                 immediately, and there is nothing left to enrich, so this
//                 mode declares NO DOCK AT ALL rather than inventing an
//                 enrichment step for a terminal card.
//
// NO `SPORT_PALETTES` ENTRY, DELIBERATELY (wave ruling, `../sport-theme.ts`
// untouched by this file). Generic is the baseline for what "no skin" looks
// like: a present-with-defaults entry would stop `sportThemeStyle` returning
// `undefined` and give the pad root a style attribute it must not have
// (`../__tests__/sport-theme.test.ts` locks exactly this). The discipline in
// this file therefore goes into WHAT IS PRESENT, never into colour.
//
// WHAT THIS SKIN DELIBERATELY DOES NOT DECLARE:
//   - `swap()`. `positions.lineup = {size: 1, benchMax: 0}` (generic.ts:487) —
//     there is no bench for an in-play substitution to come off, and generic
//     models no such event. types.ts's own `swap` doc names generic in the
//     "absent means never applicable" list.
//   - `contextSelect()`. This skin declares no `context()` strip at all: its
//     one band-shaped silence (the tally being out of band) is stated on the
//     scorebug's own context LINE, which this skin already owns, rather than
//     by adding a second surface to say one sentence.
//   - `refusedEventTypes()`. Every phase rule generic has lives in `padSpec`'s
//     own gates — `settleFromTally` is gated `path-truthy state.running`, and
//     `buildPadView` (pad-host.tsx) honours that — so there is nothing the
//     chassis cannot already compute. Declaring an empty set here would be a
//     mirror of the engine with nothing to say.
"use client";
import type { SquadState } from "@seazn/engine/core";
import type { FidelityBand } from "@seazn/engine/sport";
import type { MessageKey } from "@/lib/messages";
import {
  MORE_SHEET_KEY,
  type ActivityDetailContext,
  type DockChip,
  type DockSpec,
  type GuidedSheetSpec,
  type PadHostView,
  type PadPhase,
  type ScorebugHalf,
  type ScorebugSpec,
  type SkinDefV3,
  type StripItem,
  type TileSpec,
  type WhoLine,
} from "../types";

export type TFn = (key: string, vars?: Record<string, string | number>) => string;
export type Side = "home" | "away";

const SPORT = "generic";
export const RESULT_TYPE = `${SPORT}.result`;
export const SCORE_TYPE = `${SPORT}.score`;

export const SIDES: readonly Side[] = ["home", "away"];
const SIDE_LABEL: Record<Side, MessageKey> = {
  home: "scorepad.attribution.home",
  away: "scorepad.attribution.away",
};

/**
 * Event type -> fidelity band, MIRRORING `padSpec`'s own `fidelity` map
 * (generic.ts) rather than inventing a second scale — every converted skin
 * takes this posture, and `__tests__/generic.test.ts` pins this table EQUAL to
 * the module's own. The chassis filters tiles by the engine-side twin
 * (`filterTilesByBand` reads `PadSpec.fidelity` against the org's
 * ENTITLEMENTS); this copy exists so the builders below can decline to draw —
 * or to make a half tappable — against the FIXTURE's own recording band, an
 * earlier and separate decision from the chassis's entitlement filter.
 */
export const EVENT_BAND: Readonly<Record<string, FidelityBand>> = {
  [RESULT_TYPE]: 0,
  [SCORE_TYPE]: 1,
};

function withinBand(eventType: string, band: FidelityBand): boolean {
  const need = EVENT_BAND[eventType];
  return need === undefined || need <= band;
}

// ---------------------------------------------------------------------------
// The folded state, as this file reads it. A STRUCTURAL view of
// `GenericState` (generic.ts) — every field optional, because a pad can mount
// against a pre-fold `{}` and must degrade rather than throw.
// ---------------------------------------------------------------------------

export type ResultMode = "score" | "win_loss";

interface GenericCfgShape {
  resultMode?: string;
  allowDraws?: boolean;
}
interface GenericStateShape {
  cfg?: GenericCfgShape;
  entrants?: { home?: string; away?: string };
  phase?: string;
  score?: { home?: number; away?: number } | null;
  running?: { home?: number; away?: number };
}
interface SummaryShape {
  perSide?: { entrantId?: string; line?: string }[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function asState(state: unknown): GenericStateShape {
  return asRecord(state) as GenericStateShape;
}
function asCfg(cfg: unknown): GenericCfgShape {
  return asRecord(cfg) as GenericCfgShape;
}

/** The fixture's resolved config. Prefers the FOLD'S OWN copy
 *  (`GenericState.cfg`, what `apply` actually ran against) and falls back to
 *  `PadHostView.cfg` only for a pad mounted before any fold exists — the
 *  precedent every converted skin's own `cfgOf` sets. */
export function cfgOf(view: PadHostView): GenericCfgShape {
  const folded = asState(view.state).cfg;
  return folded !== undefined ? folded : asCfg(view.cfg);
}

/**
 * Which pad this fixture gets.
 *
 * `GenericCfg.resultMode` has NO schema default, so a cfg that never reached
 * the fold can genuinely be missing it. Defaulting to "score" is a
 * FAIL-SAFE, not a coin toss: `generic.score` is a legal event in BOTH modes
 * (`padSpec`'s tally panel is unconditional), so a pad that guesses wrong
 * still only ever offers a foldable, NON-TERMINAL tap. Guessing "win_loss"
 * would make a mis-mounted pad offer "one tap decides the match", which is
 * the one mistake this pad must never make.
 */
export function resultModeOf(cfg: GenericCfgShape): ResultMode {
  return cfg.resultMode === "win_loss" ? "win_loss" : "score";
}

/** `true` only for an EXPLICIT `allowDraws: true`. Absent reads as "no draws"
 *  for the same fail-safe reason `resultModeOf` defaults to the tally: a Draw
 *  affordance the fold refuses is a dead-end tap, and this pad's audience has
 *  no sport vocabulary to explain it with. */
function allowsDraws(cfg: GenericCfgShape): boolean {
  return cfg.allowDraws === true;
}

/** `pre` and `live` are BOTH scoreable — `applyScore`/`applyResult` (generic.ts)
 *  each accept either, so a fresh fixture is scoreable with no "Start match"
 *  tap and this pad must not pretend otherwise. */
const POST_PHASES = new Set(["done", "final"]);

function readPhase(state: GenericStateShape): string {
  return typeof state.phase === "string" && state.phase.length > 0 ? state.phase : "pre";
}

/** G3 — the engine's own `pre|live|done|final` mapped DOWN onto `PadPhase`'s
 *  closed three. `core.abandon` folds to phase "done" (generic.ts), so an
 *  abandoned fixture reaches "post" through the same branch a decided one
 *  does, with no extra clause to go untested. */
export function resolvePhase(view: Pick<PadHostView, "state">): PadPhase {
  const phase = readPhase(asState(view.state));
  if (phase === "pre") return "pre";
  if (POST_PHASES.has(phase)) return "post";
  return "live";
}

function entrantOf(state: GenericStateShape, side: Side): string {
  const id = state.entrants?.[side];
  return typeof id === "string" && id.length > 0 ? id : side;
}

function sideOfEntrant(state: GenericStateShape, entrantId: unknown): Side | null {
  for (const side of SIDES) if (entrantOf(state, side) === entrantId) return side;
  return null;
}

/** The live tally for one side, or 0. `state.running` is ABSENT until the
 *  first `generic.score` lands (generic.ts's own comment: a result-only stream
 *  folds to exactly the state it always did), so absence and zero are
 *  genuinely different and `hasTally` below is the one that tells them apart. */
function tallyOf(state: GenericStateShape, side: Side): number {
  return state.running?.[side] ?? 0;
}

function hasTally(state: GenericStateShape): boolean {
  return state.running !== undefined;
}

/** The starting roster for one side, first-named first (pairOrder, falling
 *  back to team-sheet order) — the shape every converted skin already uses. */
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

function nameOf(view: PadHostView, personId: string, t: TFn): string {
  return view.personNames[personId] ?? t("eventCopy.unknownPerson");
}

/** What this side is called on the board — the PERSON where a lineup names
 *  one (D-6: person names, never entrant display names, for individual
 *  entrants; `PadHostView` carries no entrant names at all), the side label
 *  otherwise. */
function whoNames(view: PadHostView, side: Side, t: TFn): string[] {
  const players = onFieldPlayers(view.squads, side);
  return players.length > 0 ? players.map((member) => nameOf(view, member.personId, t)) : [t(SIDE_LABEL[side])];
}

// ---------------------------------------------------------------------------
// scorebug() — tapModel S. The board IS the instrument: there is no second
// surface that records a point, and nothing records faster than one tap.
// ---------------------------------------------------------------------------

/** THE OFFICIAL SCORE, read off the engine's own `summary(state)` and never
 *  re-derived here. `generic.summary` already decides — in one place, for the
 *  pad and the public board alike — whether a side's line is the running
 *  tally, the final score, or a bare W/L/D letter
 *  (`reference_state_goals_is_not_the_official_score.md`, paid for once
 *  already in this programme). */
function bigOf(view: PadHostView, state: GenericStateShape, side: Side): string {
  const summary = asRecord(view.summary) as SummaryShape;
  const entrantId = entrantOf(state, side);
  const row = summary.perSide?.find((entry) => entry.entrantId === entrantId);
  return typeof row?.line === "string" && row.line.length > 0 ? row.line : "—";
}

/** Whether THIS FIXTURE records a running tally at all: score mode, and the
 *  band the fixture is set to. Both halves matter — a band-0 score-mode
 *  fixture records one final card and nothing else, so offering a tally tap
 *  there would earn a refusal at the scoring door
 *  (`assertEntitledToScore`, server/usecases/scoring.ts). */
export function tallyAvailable(view: PadHostView): boolean {
  return resultModeOf(cfgOf(view)) === "score" && withinBand(SCORE_TYPE, view.band);
}

/**
 * The event a half tap commits — a function of the MODE ALONE, never of the
 * band.
 *
 * Falling back to `generic.result` when the tally is out of band looks
 * tempting and is a guaranteed refusal: `applyResult`'s score branch demands
 * `p1Score`/`p2Score` (or an existing tally) and rejects a bare `winnerId`
 * outright — "score mode requires p1Score and p2Score" — so a band-0 score
 * fixture would have offered a half tap that can never fold. Caught by
 * `__tests__/generic.test.ts` before it shipped; a score-mode half either
 * records a point or is not tappable at all.
 */
function tapTypeOf(view: PadHostView): string {
  return resultModeOf(cfgOf(view)) === "score" ? SCORE_TYPE : RESULT_TYPE;
}

export const TALLY_HINT_KEY = "pad.generic.scorebug.tally.hint";
export const RESULT_HINT_KEY = "pad.generic.scorebug.result.hint";

function buildHalf(view: PadHostView, state: GenericStateShape, side: Side, t: TFn): ScorebugHalf {
  const players = onFieldPlayers(view.squads, side);
  const who: WhoLine[] = whoNames(view, side, t).map((name) => ({ name }));
  const tapType = tapTypeOf(view);
  // "post" is the only unscoreable phase — see POST_PHASES. `withinBand` is
  // the second gate and they are genuinely independent: a live band-0 score
  // fixture is scoreable but not TALLYABLE, and a decided band-3 one is
  // neither.
  const tappable = resolvePhase(view) !== "post" && withinBand(tapType, view.band);
  // SOLE-PLAYER AUTO-SET, badminton's own precedent: a one-person side has
  // nothing to choose, so its only member IS whoever scored, stamped INTO the
  // tap. A side with more than one is left for the dock's own question
  // (`buildDock`) — asking a question with one possible answer is the D-15
  // defect this chassis exists to remove.
  const soleScorer = players.length === 1 ? players[0]?.personId : undefined;
  const payload =
    tapType === SCORE_TYPE
      ? { by: entrantOf(state, side), points: 1, ...(soleScorer !== undefined ? { person: soleScorer } : {}) }
      : { winnerId: entrantOf(state, side) };
  return {
    who,
    big: bigOf(view, state, side),
    tappable,
    ...(tappable
      ? {
          hintKey: tapType === SCORE_TYPE ? TALLY_HINT_KEY : RESULT_HINT_KEY,
          tapEvent: { type: tapType, payload },
        }
      : {}),
  };
}

/**
 * The one line above the board, and the only place this pad explains itself.
 *
 * TWO FACTS, ALWAYS BOTH. What this fixture can record ("Running score" vs
 * "Result only" — a function of the variant AND the fixture's band, not of the
 * variant alone), and whether a level result is allowed at all. The second is
 * the question a generic scorer cannot answer from anywhere else on the
 * screen, and the one whose wrong guess ends in a refusal they have no
 * vocabulary to interpret; stating it once, up front, in both modes, is
 * cheaper than any recovery.
 */
function buildContext(view: PadHostView, t: TFn): string {
  const cfg = cfgOf(view);
  const mode = tallyAvailable(view) ? "pad.generic.context.tally" : "pad.generic.context.resultOnly";
  const draws = allowsDraws(cfg) ? "pad.generic.context.draws" : "pad.generic.context.noDraws";
  return `${t(mode)} · ${t(draws)}`;
}

/**
 * THE STRIP SAYS ONLY WHAT THE TWO NUMBERS CANNOT.
 *
 * One item, score mode only, and only once a tally exists: the margin in the
 * words a scorer actually says. "Level" earns its place beyond the arithmetic
 * because of what it costs — a level tally in a division that refuses draws
 * cannot be settled at all, which is why that one state is ACCENTED and no
 * other is. Everything else the strip could carry (the variant, the recording
 * mode, the draw policy) is already on the context line one row up, so it is
 * omitted rather than repeated.
 */
function buildStrip(view: PadHostView, state: GenericStateShape, t: TFn): StripItem[] {
  if (resultModeOf(cfgOf(view)) !== "score" || !hasTally(state)) return [];
  const home = tallyOf(state, "home");
  const away = tallyOf(state, "away");
  if (home === away) {
    // ACCENTED only where it bites: with draws refused, this exact state is
    // the one the fixture cannot be finished from.
    const level: StripItem = { id: "margin", value: t("pad.generic.scorebug.strip.level") };
    return [allowsDraws(cfgOf(view)) ? level : { ...level, accent: true }];
  }
  const leader: Side = home > away ? "home" : "away";
  const by = Math.abs(home - away);
  return [
    {
      id: "margin",
      value: t("pad.generic.scorebug.strip.lead", { name: whoNames(view, leader, t).join(" / "), by }),
    },
  ];
}

export function buildScorebug(view: PadHostView, t: TFn): ScorebugSpec {
  const state = asState(view.state);
  return {
    context: buildContext(view, t),
    phase: resolvePhase(view),
    halves: [buildHalf(view, state, "home", t), buildHalf(view, state, "away", t)],
    strip: buildStrip(view, state, t),
  };
}

// ---------------------------------------------------------------------------
// tiles() / sheets() / dock() — R7/A1 cycle 2 and 3.
// ---------------------------------------------------------------------------

export function buildTiles(_view: PadHostView, _t: TFn): TileSpec[] {
  return [];
}

export function buildSheets(_view: PadHostView, _t: TFn): Record<string, GuidedSheetSpec> {
  return {};
}

export function buildDock(
  _eventType: string,
  _view: PadHostView,
  _t: TFn,
  _payload?: Record<string, unknown>,
): DockSpec | null {
  return null;
}

export function genericDetail(_ctx: ActivityDetailContext): string | undefined {
  return undefined;
}

// ---------------------------------------------------------------------------
// The factory.
// ---------------------------------------------------------------------------

export function genericSkinV3(t: TFn): SkinDefV3<PadHostView> {
  return {
    key: SPORT,
    tapModel: "S",
    phase: resolvePhase,
    scorebug: (view) => buildScorebug(view, t),
    tiles: (view) => buildTiles(view, t),
    dock: (eventType, view, payload) => buildDock(eventType, view, t, payload),
    sheets: (view) => buildSheets(view, t),
    activityDetail: genericDetail,
    // No swap()/context()/contextSelect()/refusedEventTypes() — see this
    // file's header.
  };
}

// Referenced so the sentinel's import is not dead weight once `buildTiles`
// grows its More tile in cycle 2.
export const MORE_TILE_SHEET = MORE_SHEET_KEY;
// Kept for the dock's chip helpers in cycle 3.
export type { DockChip };
export { sideOfEntrant, hasTally, tallyOf, allowsDraws };
