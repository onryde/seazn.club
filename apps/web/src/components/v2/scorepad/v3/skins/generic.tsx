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
      // R7-28: this interpolated the leader's FULL entrant name, which the
      // half directly above it already carries — a third rendering of the same
      // name on one tile (page header, half, strip), and at 320 with a real
      // club name it wrapped the strip onto two more lines. The SIDE label is
      // what this sentence actually needs: it names which half leads in one
      // short word, and the half's own name answers "who is that". Contradicted
      // this function's own opening line until now: the strip is supposed to
      // say only what the two numbers cannot, and a name is not that.
      value: t("pad.generic.scorebug.strip.lead", { name: t(SIDE_LABEL[leader]), by }),
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
// tiles() — everything the board itself cannot say, and nothing else
// ---------------------------------------------------------------------------

export const SETTLE_TILE_ID = "settle";
export const SCORE_ENTRY_TILE_ID = "scoreEntry";
export const CORRECTION_TILE_ID = "correction";
export const DRAW_TILE_ID = "draw";
export const MORE_TILE_ID = "more";

/**
 * The engine's own field bounds, RESTATED here because `generic.ts` keeps them
 * module-private, and PINNED equal to the real `padSpec(cfg)` output in
 * `__tests__/generic.test.ts` — the same "restate, then prove equal to the
 * source of truth" posture table tennis takes for `EXPEDITE_RETURNS`.
 *
 * `MAX_PLAUSIBLE_SCORE` bounds a final `p1Score`/`p2Score`; `MAX_TALLY_STEP`
 * bounds a single `generic.score` press, which is what caps a correction: the
 * fold refuses `points` outside ±50 whatever the tally says.
 */
export const MAX_PLAUSIBLE_SCORE = 500;
export const MAX_TALLY_STEP = 50;

/** `applyResult`'s settle branch, mirrored: a result card with no scores
 *  settles FROM the tally, and a level tally settles only where the division
 *  allows a draw. Withholding the tile is the whole point — the alternative
 *  is a tap that ends in "draws are not allowed in this division", a sentence
 *  a generic scorer has no way to have predicted. */
function settleable(view: PadHostView, state: GenericStateShape): boolean {
  if (!hasTally(state)) return false;
  return tallyOf(state, "home") !== tallyOf(state, "away") || allowsDraws(cfgOf(view));
}

/** The biggest correction any side could legally take right now: what the
 *  leading side actually holds, capped by the engine's own single-press
 *  bound. Zero means there is nothing to subtract at all, and the tile is
 *  withheld rather than opening a sheet whose stepper has no legal value. */
function correctionCeiling(state: GenericStateShape): number {
  return Math.min(MAX_TALLY_STEP, Math.max(tallyOf(state, "home"), tallyOf(state, "away")));
}

/** Both phases the fold accepts, and — since the R7 defect fix — both phases
 *  `padSpec` declares too; the two sources now AGREE. `applyScore`/
 *  `applyResult` (generic.ts) each allow "pre" as well as "live", but
 *  `padSpec`'s own panels used to declare "live" only, so this skin's tiles
 *  were tappable in "pre" while dispatch refused them at the door
 *  ("Declared here: (none)", `createSkinDispatch`) — the "pad offers what
 *  the engine refuses" defect this repo had already closed three other
 *  instances of (R2c). `everyPhase` (generic.ts) now declares every panel
 *  at both phases, so this list is no longer this skin getting ahead of
 *  padSpec: a scorer who never tapped "Start match" — the ordinary case for
 *  a result typed in after the fact — really does have every action on
 *  screen, all the way through to dispatch. */
const SCOREABLE_PHASES: readonly PadPhase[] = ["pre", "live"];

export function buildTiles(view: PadHostView, t: TFn): TileSpec[] {
  const state = asState(view.state);
  const mode = resultModeOf(cfgOf(view));
  const tiles: TileSpec[] = [];

  if (mode === "score") {
    // The tally's own finish, first: it records what is already on the board,
    // and says so on the tile rather than making the scorer trust it.
    if (tallyAvailable(view) && settleable(view, state)) {
      tiles.push({
        id: SETTLE_TILE_ID,
        label: "pad.generic.tile.settle",
        sublabelText: `${tallyOf(state, "home")} – ${tallyOf(state, "away")}`,
        kind: "standard",
        span: 2,
        phases: [...SCOREABLE_PHASES],
        action: { event: { type: RESULT_TYPE, payload: {} } },
      });
    }
    // The typed result. A band-0 fixture records ONE card and nothing else, so
    // this is the whole pad there; at every other band it is the path for a
    // scorer who arrives at full time with a number rather than a match to
    // watch, which is the most ordinary thing a generic scorer does.
    tiles.push({
      id: SCORE_ENTRY_TILE_ID,
      label: "pad.generic.tile.scoreEntry",
      kind: "standard",
      span: 2,
      phases: [...SCOREABLE_PHASES],
      action: { sheet: SCORE_ENTRY_TILE_ID },
    });
    if (tallyAvailable(view) && correctionCeiling(state) > 0) {
      tiles.push({
        id: CORRECTION_TILE_ID,
        label: "pad.generic.tile.correction",
        kind: "minor",
        span: 2,
        phases: [...SCOREABLE_PHASES],
        action: { sheet: CORRECTION_TILE_ID },
      });
    }
  } else if (allowsDraws(cfgOf(view))) {
    // ABSENT, never disabled, when draws are refused. A disabled Draw tile
    // would be a permanent property of the division wearing a transient
    // affordance's clothes — `TileSpec.disabled`'s own doc draws exactly that
    // line, and a dead-end tap is worse than no tile.
    tiles.push({
      id: DRAW_TILE_ID,
      label: "pad.generic.tile.draw",
      kind: "standard",
      span: 4,
      phases: [...SCOREABLE_PHASES],
      action: { event: { type: RESULT_TYPE, payload: { isDraw: true } } },
    });
  }

  // R7-39/R7-39a — pushed UNCONDITIONALLY now, the same shape every other v3
  // skin already takes. This used to be `if (moreHasContent(view))`, a
  // skin-local mirror of `moreActions` (pad-host.tsx) that decided whether
  // the sheet had anything in it; `moreHasContent` is DELETED, not left
  // beside its replacement — the chassis now suppresses an empty More tile
  // centrally (`suppressEmptyMoreTile`, pad-host.tsx), from the exact same
  // `moreActionsList` computation this mirror used to duplicate, for every
  // skin at once. See that function's own doc for the full ruling.
  tiles.push({
    id: MORE_TILE_ID,
    label: "scorepad.skin.more",
    kind: "minor",
    span: 4,
    phases: [...SCOREABLE_PHASES],
    action: { sheet: MORE_SHEET_KEY },
  });

  // `t` is threaded for symmetry with every other skin's `buildTiles` and to
  // keep the factory's call shape uniform; no tile here needs a pre-resolved
  // label, because the only non-translatable string this board renders is the
  // settle tile's own score, which is `sublabelText` by design.
  void t;
  return tiles;
}

// ---------------------------------------------------------------------------
// sheets() — a METHOD of the view (rebuilt per render), the standing
// convention every v3 skin's `sheets` takes.
// ---------------------------------------------------------------------------

/** The explicit final score. PREFILLED from the tally where one exists — an
 *  unedited confirm then records exactly what the board already shows, rather
 *  than 0-0, which is the one wrong answer a prefill can give. */
function scoreEntrySheet(view: PadHostView, t: TFn): GuidedSheetSpec {
  const state = asState(view.state);
  return {
    event: RESULT_TYPE,
    steps: [
      {
        id: "home",
        kind: "number",
        title: t("pad.generic.sheet.scoreEntry.home.title"),
        initial: tallyOf(state, "home"),
        min: 0,
        max: MAX_PLAUSIBLE_SCORE,
      },
      {
        id: "away",
        kind: "number",
        title: t("pad.generic.sheet.scoreEntry.away.title"),
        initial: tallyOf(state, "away"),
        min: 0,
        max: MAX_PLAUSIBLE_SCORE,
      },
    ],
    buildPayload: (answers) => ({ p1Score: Number(answers.home ?? 0), p2Score: Number(answers.away ?? 0) }),
  };
}

/**
 * The correction — a mis-press taken back off the tally.
 *
 * `GenericScore.points` is `.refine(p => p !== 0)`, so a sheet that could
 * offer 0 would build a payload the schema refuses; `min: 1` on the magnitude
 * and a negation in `buildPayload` make zero unreachable by construction
 * rather than by validation. The ceiling is what the leading side actually
 * holds (capped by the engine's own single-press bound), because the fold
 * refuses a correction that would take a side below zero.
 */
function correctionSheet(view: PadHostView, t: TFn): GuidedSheetSpec {
  const state = asState(view.state);
  const home = tallyOf(state, "home");
  const away = tallyOf(state, "away");
  return {
    event: SCORE_TYPE,
    steps: [
      {
        id: "side",
        kind: "choice",
        title: t("pad.generic.sheet.correction.side.title"),
        options: SIDES.map((side) => ({ id: side, label: SIDE_LABEL[side] })),
      },
      {
        id: "points",
        kind: "number",
        title: t("pad.generic.sheet.correction.points.title"),
        initial: 1,
        min: 1,
        max: correctionCeiling(state),
        hintText: t("pad.generic.sheet.correction.points.hint", { home, away }),
      },
    ],
    buildPayload: (answers) => {
      const side: Side = answers.side === "away" ? "away" : "home";
      const magnitude = Math.max(1, Math.abs(Number(answers.points ?? 1)));
      return { by: entrantOf(state, side), points: -magnitude };
    },
  };
}

export function buildSheets(view: PadHostView, t: TFn): Record<string, GuidedSheetSpec> {
  // Keyed off the SAME predicates `buildTiles` uses, so a sheet is never
  // declared without an opening tile and never missing for one — pinned both
  // ways in `__tests__/generic.test.ts`.
  const sheets: Record<string, GuidedSheetSpec> = {};
  if (resultModeOf(cfgOf(view)) !== "score") return sheets;
  sheets[SCORE_ENTRY_TILE_ID] = scoreEntrySheet(view, t);
  if (tallyAvailable(view) && correctionCeiling(asState(view.state)) > 0) {
    sheets[CORRECTION_TILE_ID] = correctionSheet(view, t);
  }
  return sheets;
}

// ---------------------------------------------------------------------------
// dock() — RULING R7-2: tap decides, dock enriches.
//
// A sport with no vocabulary has exactly one thing worth enriching: HOW MUCH
// that point was worth. So the dock AMENDS the amount on the held submission
// (`DockChip.mutate` rewrites `points` on the queued payload — queue.ts's
// `mutateHeld`) and never posts a second event. That is the honest reading of
// "tap decides, dock enriches" for generic, and it is why one tap can stay
// worth exactly one point: the common case costs nothing and the uncommon one
// costs one more tap inside the same ~6s window.
//
// EVERY CHIP STAYS ON SCREEN FOR THE WHOLE HOLD, deliberately — this dock has
// no steps. `resolveDockSpec` (pad-host.tsx) calls this with the ORIGINAL tap
// payload for the life of the held entry, so a stepped dock would have to be
// driven by facts stamped at tap time, and there are none here worth stepping
// on. Keeping every chip visible also makes a mis-tap correctable: the
// controller refuses only a REPEAT of the same chip, so tapping 3 and then 2
// leaves 2, which is what a scorer who mis-tapped actually wants. It is also
// what keeps the dock — and its "Send now" control — from vanishing the
// instant a chip is chosen, the exact defect R5 found on table tennis.
//
// win_loss DECLARES NO DOCK AT ALL. A terminal result card has nothing to
// enrich, and inventing an enrichment step for one would be furniture.
// ---------------------------------------------------------------------------

/** The amounts worth one tap. Well inside the engine's own `MAX_TALLY_STEP`,
 *  and deliberately short: a scorer scanning under a countdown reads three
 *  options, not fifty. Anything else is a Correction plus a re-tap, which is
 *  the honest cost of an unusual answer. */
export const DOCK_AMOUNTS: readonly number[] = [2, 3, 5];

/** A MODIFIER of the point already recorded, rendered as a tab rather than a
 *  pill (`DockChip.kind`, football's own precedent): shape is legible in
 *  peripheral vision before colour is, and this dock can mix modifiers with
 *  person pills in one row. */
function amountChip(points: number, t: TFn): DockChip {
  return {
    id: `points:${points}`,
    label: "pad.generic.dock.points",
    labelText: t("pad.generic.dock.points", { points }),
    kind: "flag",
    mutate: (payload) => ({ ...payload, points }),
  };
}

/** ATTRIBUTION — stays the pill it already was. */
function personChip(personId: string, labelText: string): DockChip {
  return {
    id: `person:${personId}`,
    label: "pad.generic.dock.person",
    labelText,
    mutate: (payload) => ({ ...payload, person: personId }),
  };
}

export function buildDock(
  eventType: string,
  view: PadHostView,
  t: TFn,
  payload?: Record<string, unknown>,
): DockSpec | null {
  if (resultModeOf(cfgOf(view)) !== "score") return null;
  if (eventType !== SCORE_TYPE) return null;
  const state = asState(view.state);
  const side = typeof payload?.by === "string" ? sideOfEntrant(state, payload.by) : null;
  // Already answered at tap time (`buildHalf`'s sole-player auto-set), or
  // unanswerable because the payload names no side this fold knows.
  const named = typeof payload?.person === "string" && payload.person.length > 0;
  const roster = side === null || named ? [] : onFieldPlayers(view.squads, side);
  // A one-person side has nothing to choose. Offering a picker with a single
  // row is the D-15 defect this chassis exists to remove.
  const people = roster.length > 1 ? roster : [];
  return {
    title: t(people.length > 0 ? "pad.generic.dock.both.title" : "pad.generic.dock.amount.title"),
    chips: [
      ...DOCK_AMOUNTS.map((points) => amountChip(points, t)),
      ...people.map((member) => personChip(member.personId, nameOf(view, member.personId, t))),
    ],
  };
}

// ---------------------------------------------------------------------------
// activityDetail() — the ribbon's varying half.
//
// Without it every row reads "Point recorded", and a ledger of identical rows
// each carrying its own Void button is how the wrong point gets voided at a
// scoring desk.
// ---------------------------------------------------------------------------

/** Order-preserving, de-duplicating join — a name repeated against itself
 *  tells a reader nothing (table tennis paid for this one in review). */
function join(parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part.length > 0);
  const unique = [...new Set(kept)];
  return unique.length > 0 ? unique.join(" · ") : undefined;
}

export function genericDetail(ctx: ActivityDetailContext): string | undefined {
  const { t, eventType, payload, personNames } = ctx;
  const state = asState(ctx.state);
  const named = (id: unknown): string | undefined =>
    typeof id === "string" && id.length > 0 ? (personNames?.[id] ?? t("eventCopy.unknownPerson")) : undefined;
  const sideLabel = (entrantId: unknown): string | undefined => {
    const side = sideOfEntrant(state, entrantId);
    return side ? t(SIDE_LABEL[side]) : undefined;
  };

  switch (eventType) {
    case SCORE_TYPE: {
      // The person first where one is known, because that is what a scorer
      // scans for when correcting a misattribution; the SIDE otherwise, so a
      // row is never nameless. The signed amount carries a correction's own
      // meaning without a second key: "-2 pts" needs no further explanation.
      const who = named(payload.person) ?? sideLabel(payload.by);
      // R7-28: this read "1 pts" on every single-point tap — the commonest row
      // the pad writes, and the first thing a real 320 capture showed. The
      // count is what selects the form, so it goes through `plural` (which
      // carries the viewer's locale); `.other` is the fallback for a harness
      // that builds this context without one, and is correct for every count
      // but the singular. The ABSOLUTE value selects: a correction of -1 is
      // still one point, and "-1 pts" is the same defect with a sign on it.
      const amount =
        typeof payload.points === "number"
          ? (ctx.plural?.("pad.generic.ribbon.points", Math.abs(payload.points), { points: payload.points }) ??
            t("pad.generic.ribbon.points.other", { points: payload.points }))
          : undefined;
      return join([who, amount]);
    }
    case RESULT_TYPE: {
      const home = payload.p1Score;
      const away = payload.p2Score;
      const score = typeof home === "number" && typeof away === "number" ? `${home} – ${away}` : undefined;
      // `ActivityDetailContext` carries no squads, so a winner resolves to a
      // SIDE and not to a person — stated rather than faked.
      return join([score, sideLabel(payload.winnerId), payload.isDraw === true ? t("pad.generic.ribbon.draw") : undefined]);
    }
    default:
      // A settle-from-tally card carries no facts at all, and `core.*` rows
      // are the chassis's own (`buildRibbon`'s CORE_RIBBON_KEY map).
      return undefined;
  }
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
