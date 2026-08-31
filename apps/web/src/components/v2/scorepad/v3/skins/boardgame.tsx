// Boardgame SkinDefV3 — R7/A2, tapModel T. Converts `boardgame` to the v3
// chassis (design of record `docs/superpowers/specs/2026-08-15-scoringpad-v3-
// redesign-design.md` §2/§3). Replaces the universal renderer (`../../pad-
// renderer.tsx` via `RESOLUTION_KIND.boardgame = "universal"`) as BOARDGAME'S
// pad surface only — carrom stays on that lane until its own task (A3).
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
// TAP MODEL T, deliberately — NOT the S every other single-terminal-event
// sport in this wave (generic's win_loss mode, badminton, tennis) took.
// Every OTHER model-S sport's decisive event carries nothing beyond who won,
// so a bare half tap already IS the whole record. Boardgame's own
// `boardgame.result` carries three more facts an arbiter routinely knows the
// instant the game ends — `method` (checkmate/resign/flag-fall/…), `moves`
// (the scoresheet's own last-written number, FIDE Art. 8.1) and, once a
// pairing card named one, `winnerPerson` — and this is a RARE, ONCE-PER-MATCH
// event with no reason to rush a scorer into the ~6s dock hold window the way
// a rally or a point does. A tap-then-dock design would make "who won" free
// and "how" a race against a timer; a guided sheet asks all of it with no
// clock running, which is the more honest reading of an arbiter's own
// scoresheet. So the halves here are pure READOUTS (no `tappable`/`tapEvent`,
// matching cricket's and football's own "provably unaffected" shape,
// `pad-host.tsx`'s own doc) and every action is a TILE opening a SHEET.
//
// THE THREE TILES MIRROR `padSpec(cfg)`'S OWN THREE ACTIONS, one tile each:
// the pre-match pairing card, the decisive result, and the drawn/no-result
// branch — the cricket ballAction/extraAction/wicketAction precedent, and the
// same one `boardgame.ts`'s own padSpec comment names for why decisive/drawn
// share one wire type. Nothing is left for a More sheet: every panel padSpec
// declares is dedicated by a tile at the SAME phase padSpec declares it, so
// `moreActions` (pad-host.tsx) has nothing to offer at any phase/band this
// skin can reach — proven, not assumed, in `__tests__/boardgame.test.ts`.
//
// `dock()` ALWAYS RETURNS NULL — see `buildDock`'s own doc. Every fact a
// dock could enrich is already a step in the sheet that opened the hold.
//
// `led` — SIDE-TO-MOVE / WHITE. `state.colorOfHome` defaults to "W" (home is
// White) the moment `cfg.colors` is true, from `init()` onward, no pairing
// card required — a Swiss pairing card MAY flip it (`applyPairing`), but the
// fact is knowable from the very first render. Rendered the same way
// badminton/tennis spend their own `led` — `WhoLine.serving` + `servingLabel`
// (types.ts's own doc: the boolean is generic, the label is skin-supplied
// prose, and racquet sports keep their own key precisely so one sport's key
// never serves another). `colorOfHome === null` (colours off) renders it on
// NEITHER half, ever.
//
// WHAT THIS SKIN DELIBERATELY DOES NOT DECLARE:
//   - `swap()`. `positions.lineup = {size: 1, benchMax: 0}` (boardgame.ts) —
//     there is no bench for an in-play substitution to come off. types.ts's
//     own `swap` doc names boardgame in the "absent means never applicable"
//     list, alongside carrom singles and generic.
//   - `context()`/`contextSelect()`. The one ambient fact worth stating
//     (colours tracked, and the board number once known) is already said on
//     the scorebug's own context LINE, which this skin already owns; there is
//     no person to pick and nothing a tap could fix, so a second surface to
//     say one sentence would be furniture.
//   - `refusedEventTypes()`. Every phase rule this fold has is already a
//     phase gate on `padSpec`'s own panels (`decideResult`'s `state.phase !==
//     "live"` guard matches the "live"-only decisive/drawn panels exactly;
//     `applyPairing`'s "pre" OR "live" guard is MORE permissive than the
//     "pre"-only pairing panel, never less — the safe direction, and this
//     skin follows padSpec's own narrower phase rather than widening past
//     it). There is nothing here the chassis cannot already compute from
//     `padSpec` alone.
"use client";
import type { SquadState } from "@seazn/engine/core";
import type { FidelityBand } from "@seazn/engine/sport";
import type { MessageKey } from "@/lib/messages";
import { ENUM_VOCAB } from "@/lib/scoring-vocab";
import {
  type ActivityDetailContext,
  type DockSpec,
  type GuidedSheetSpec,
  type GuidedSheetStep,
  type PadHostView,
  type PadPhase,
  type ScorebugHalf,
  type ScorebugSpec,
  type SkinDefV3,
  type TileSpec,
  type WhoLine,
} from "../types";
import type { SportTone } from "../sport-theme";

export type TFn = (key: string, vars?: Record<string, string | number>) => string;
export type Side = "home" | "away";

const SPORT = "boardgame";
export const RESULT_TYPE = `${SPORT}.result`;
export const PAIRING_TYPE = `${SPORT}.pairing`;

export const SIDES: readonly Side[] = ["home", "away"];
const SIDE_LABEL: Record<Side, MessageKey> = {
  home: "scorepad.attribution.home",
  away: "scorepad.attribution.away",
};

/**
 * Event type -> fidelity band, MIRRORING `padSpec`'s own `fidelity` map
 * (boardgame.ts) rather than inventing a second scale — every converted skin
 * takes this posture, and `__tests__/boardgame.test.ts` pins this table EQUAL
 * to the module's own. The result is band 0 (a board game ships its terminal
 * record free at every band); the pairing card is band 1, so a band-0 fixture
 * never sees an offer it cannot afford.
 */
export const EVENT_BAND: Readonly<Record<string, FidelityBand>> = {
  [RESULT_TYPE]: 0,
  [PAIRING_TYPE]: 1,
};

function withinBand(eventType: string, band: FidelityBand): boolean {
  const need = EVENT_BAND[eventType];
  return need === undefined || need <= band;
}

/**
 * `padSpec(cfg)`'s own decisive/drawn method vocabularies, restated because
 * `boardgame.ts` keeps them module-private — the same "restate, then prove
 * equal to the source of truth" posture badminton's `SANCTION_LEVELS` takes,
 * pinned equal to the real field's `values` in `__tests__/boardgame.test.ts`.
 * "adjudication" appears in both: an arbiter's discretionary ruling (FIDE
 * Art. 5.2) can go either way.
 */
export const DECISIVE_METHODS: readonly string[] = [
  "checkmate",
  "resign",
  "time",
  "forfeit",
  "adjudication",
  "illegal_move",
];
export const DRAWN_METHODS: readonly string[] = [
  "agreement",
  "stalemate",
  "insufficient",
  "adjudication",
  "repetition",
  "fifty_move",
  "dead_position",
  "double_forfeit",
];

/** `boardgame.ts`'s own field sentinels (`MOVES_MAX`/`BOARD_MAX`), restated
 *  for the identical module-private reason `DECISIVE_METHODS` above states —
 *  pinned equal to `padSpec(cfg)`'s real field bounds in the test file. */
export const MOVES_MAX = 400;
export const BOARD_MAX = 200;

// ---------------------------------------------------------------------------
// The folded state, as this file reads it. A STRUCTURAL view of
// `BoardgameState` (boardgame.ts) — every field optional, because a pad can
// mount against a pre-fold `{}` and must degrade rather than throw.
// ---------------------------------------------------------------------------

interface BoardgameCfgShape {
  colors?: boolean;
}
interface BoardgameStateShape {
  cfg?: BoardgameCfgShape;
  entrants?: { home?: string; away?: string };
  phase?: string;
  colorOfHome?: "W" | "B" | null;
  players?: { home?: string; away?: string };
  board?: number;
}
interface SummaryShape {
  perSide?: { entrantId?: string; line?: string }[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function asState(state: unknown): BoardgameStateShape {
  return asRecord(state) as BoardgameStateShape;
}
function asCfg(cfg: unknown): BoardgameCfgShape {
  return asRecord(cfg) as BoardgameCfgShape;
}

/** The fixture's resolved config. Prefers the FOLD'S OWN copy
 *  (`BoardgameState.cfg`, what `apply` actually ran against) and falls back
 *  to `PadHostView.cfg` only for a pad mounted before any fold exists — the
 *  precedent every converted skin's own `cfgOf` sets. */
export function cfgOf(view: PadHostView): BoardgameCfgShape {
  const folded = asState(view.state).cfg;
  return folded !== undefined ? folded : asCfg(view.cfg);
}

/** `true` unless EXPLICITLY `false` — `BoardgameCfg.colors` defaults to
 *  `true` in the schema, and a structural read of a cfg that never reached
 *  the fold must default the same way the schema does. */
function colorsOn(cfg: BoardgameCfgShape): boolean {
  return cfg.colors !== false;
}

function readPhase(state: BoardgameStateShape): string {
  return typeof state.phase === "string" && state.phase.length > 0 ? state.phase : "pre";
}

/** `pre|live|done|final|abandoned` (boardgame.ts) mapped down onto
 *  `PadPhase`'s closed three — `core.abandon` folds to its OWN distinct
 *  "abandoned" phase here (unlike generic, which folds it into "done"), so
 *  POST_PHASES carries all three terminal values. */
const POST_PHASES = new Set(["done", "final", "abandoned"]);

export function resolvePhase(view: Pick<PadHostView, "state">): PadPhase {
  const phase = readPhase(asState(view.state));
  if (phase === "pre") return "pre";
  if (POST_PHASES.has(phase)) return "post";
  return "live";
}

function entrantOf(state: BoardgameStateShape, side: Side): string {
  const id = state.entrants?.[side];
  return typeof id === "string" && id.length > 0 ? id : side;
}

function sideOfEntrant(state: BoardgameStateShape, entrantId: unknown): Side | null {
  for (const side of SIDES) if (entrantOf(state, side) === entrantId) return side;
  return null;
}

/** The starting roster for one side. `positions.lineup = {size: 1, benchMax:
 *  0}` (boardgame.ts) bounds this to AT MOST ONE member, always — never a
 *  roster to pick from, which is why nothing below ever offers a person
 *  picker (the D-15 defect this chassis exists to remove). */
function onFieldPlayers(squads: SquadState, side: Side): readonly SquadState["home"]["members"][number][] {
  return squads[side].members.filter((member) => member.onField && member.role === "player");
}

/** The sole on-field player of a side, or `undefined` for an empty roster —
 *  never a choice, per `onFieldPlayers`'s own doc. */
function soleMemberOf(squads: SquadState, side: Side): string | undefined {
  return onFieldPlayers(squads, side)[0]?.personId;
}

function nameOf(view: PadHostView, personId: string, t: TFn): string {
  return view.personNames[personId] ?? t("eventCopy.unknownPerson");
}

/** Field name -> value -> i18n KEY, the same local helper badminton's own
 *  `vocabKey` provides — `ENUM_VOCAB` is the shared table (scoring-vocab.ts),
 *  never re-keyed here. Every `DECISIVE_METHODS`/`DRAWN_METHODS` member has a
 *  real `method.*` entry (`METHOD_KEY`), so the `?? value` fallback below is
 *  defensive symmetry with the shared pattern, not a path this skin's own
 *  vocabulary ever actually takes. */
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

/** Which side has White, or `null` — colours off, or nobody knows yet
 *  (unreachable once `cfg.colors` is true, since `init()` defaults home to
 *  White from the very first render). */
function whiteSideOf(state: BoardgameStateShape): Side | null {
  if (state.colorOfHome === undefined || state.colorOfHome === null) return null;
  return state.colorOfHome === "W" ? "home" : "away";
}

// ---------------------------------------------------------------------------
// scorebug() — tapModel T. The halves are readouts; every action is a tile.
// ---------------------------------------------------------------------------

/** THE OFFICIAL SCORE, read off the engine's own `summary(state)` and never
 *  re-derived here — `boardgame.summary` already decides the half-points
 *  string ("1"/"½"/"0") in one place, for the pad and the public board alike
 *  (`reference_state_goals_is_not_the_official_score.md`). */
function bigOf(view: PadHostView, state: BoardgameStateShape, side: Side): string {
  const summary = asRecord(view.summary) as SummaryShape;
  const entrantId = entrantOf(state, side);
  const row = summary.perSide?.find((entry) => entry.entrantId === entrantId);
  return typeof row?.line === "string" && row.line.length > 0 ? row.line : "—";
}

function buildHalf(view: PadHostView, state: BoardgameStateShape, side: Side, t: TFn): ScorebugHalf {
  const players = onFieldPlayers(view.squads, side);
  const isWhite = whiteSideOf(state) === side;
  const whiteFlag = isWhite ? { serving: true as const, servingLabel: t("pad.boardgame.scorebug.white") } : {};
  const who: WhoLine[] =
    players.length > 0
      ? players.map((member) => ({ name: nameOf(view, member.personId, t), ...whiteFlag }))
      : [{ name: t(SIDE_LABEL[side]), ...whiteFlag }];
  return { who, big: bigOf(view, state, side) };
  // No `tappable`/`tapEvent` — tapModel T, see this file's header.
}

/** "Colours tracked / No colours", plus the board number once a pairing card
 *  has named one. Two facts, the same "state what this fixture records"
 *  posture generic's own context line takes — but only ONE is unconditional
 *  here, because a board number is genuinely a team-match fact that most
 *  fixtures will never have. */
function buildContext(state: BoardgameStateShape, cfg: BoardgameCfgShape, t: TFn): string {
  const colours = t(colorsOn(cfg) ? "pad.boardgame.context.colors" : "pad.boardgame.context.noColors");
  if (state.board === undefined) return colours;
  return `${colours} · ${t("pad.boardgame.context.board", { board: state.board })}`;
}

export function buildScorebug(view: PadHostView, t: TFn): ScorebugSpec {
  const state = asState(view.state);
  return {
    context: buildContext(state, cfgOf(view), t),
    phase: resolvePhase(view),
    halves: [buildHalf(view, state, "home", t), buildHalf(view, state, "away", t)],
    // Nothing the two halves' own numbers/names cannot already say — see the
    // ribbon (`boardgameDetail`) for where method/moves/board actually live.
    strip: [],
  };
}

// ---------------------------------------------------------------------------
// tiles() — one per padSpec action, each opening its own sheet.
// ---------------------------------------------------------------------------

export const PAIRING_TILE_ID = "pairing";
export const RESULT_TILE_ID = "result";
export const DRAW_TILE_ID = "draw";

export function buildTiles(view: PadHostView, t: TFn): TileSpec[] {
  const phase = resolvePhase(view);
  const tiles: TileSpec[] = [];
  if (phase === "pre" && withinBand(PAIRING_TYPE, view.band)) {
    tiles.push({
      id: PAIRING_TILE_ID,
      label: "pad.boardgame.action.pairing",
      kind: "standard",
      span: 4,
      phases: ["pre"],
      action: { sheet: PAIRING_TILE_ID },
    });
  }
  if (phase === "live" && withinBand(RESULT_TYPE, view.band)) {
    tiles.push({
      id: RESULT_TILE_ID,
      label: "pad.boardgame.action.result",
      kind: "standard",
      span: 2,
      phases: ["live"],
      action: { sheet: RESULT_TILE_ID },
    });
    tiles.push({
      id: DRAW_TILE_ID,
      label: "pad.boardgame.action.draw",
      kind: "standard",
      span: 2,
      phases: ["live"],
      action: { sheet: DRAW_TILE_ID },
    });
  }
  // `t` is threaded for symmetry with every other skin's `buildTiles` and to
  // keep the factory's call shape uniform; every label here is a bare i18n
  // key, resolved by the chassis itself.
  void t;
  return tiles;
}

// ---------------------------------------------------------------------------
// sheets() — a METHOD of the view (rebuilt per render), the standing
// convention every v3 skin's `sheets` takes. Unconditional: the TILES decide
// visibility, these specs simply exist for whichever tile is open.
// ---------------------------------------------------------------------------

/** The card code, as `SheetChoiceStep`'s `tone` — an ARRAY, the closed-
 *  vocabulary convention every toned step in this programme takes. Scoped to
 *  exactly ONE method: "time" is FIDE's flag fall, a literal clock event, and
 *  the one ending this palette's `dismissal` was picked to say
 *  (`../sport-theme.ts`'s own comment). Every other method — including the
 *  other forfeit-shaped one, `forfeit` itself — is a plain word with no card
 *  behind it, so it stays untoned. */
function toneFor(method: string): readonly SportTone[] | undefined {
  return method === "time" ? (["dismissal"] as const) : undefined;
}

/** The pre-match pairing card. `board` is always asked (a light, low-friction
 *  number step — most fixtures just accept "1"); `white` only when this
 *  division tracks colours, mirroring padSpec's own cfg-gated `attribution`
 *  list exactly. `homePerson`/`awayPerson` are NEVER a picker — `boardgame
 *  .ts`'s own `positions.lineup = {size: 1, benchMax: 0}` bounds each side to
 *  at most one on-field member, so asking would be a one-option picker (the
 *  D-15 defect); this sheet auto-attaches whichever member the lineup already
 *  names. */
function pairingSheet(view: PadHostView, t: TFn): GuidedSheetSpec {
  const state = asState(view.state);
  const cfg = cfgOf(view);
  const homeSole = soleMemberOf(view.squads, "home");
  const awaySole = soleMemberOf(view.squads, "away");
  const steps: GuidedSheetStep[] = [
    {
      id: "board",
      kind: "number",
      title: t("pad.boardgame.sheet.pairing.board.title"),
      initial: state.board ?? 1,
      min: 1,
      max: BOARD_MAX,
    },
  ];
  if (colorsOn(cfg)) {
    steps.push({
      id: "white",
      kind: "choice",
      title: t("pad.boardgame.sheet.pairing.white.title"),
      options: SIDES.map((side) => ({ id: side, label: SIDE_LABEL[side] })),
    });
  }
  return {
    event: PAIRING_TYPE,
    steps,
    buildPayload: (answers) => ({
      board: Number(answers.board ?? 1),
      ...(colorsOn(cfg) ? { white: entrantOf(state, answers.white === "away" ? "away" : "home") } : {}),
      ...(homeSole !== undefined ? { homePerson: homeSole } : {}),
      ...(awaySole !== undefined ? { awayPerson: awaySole } : {}),
    }),
  };
}

/** The decisive result: who won, how, and (optionally) the move count.
 *  `winnerPerson` is auto-attached from the pairing card's own record for the
 *  winning side (`state.players`) — never re-asked, the identical D-15
 *  reasoning `pairingSheet` states, since a pairing card can only ever have
 *  named ONE person per side. */
function resultSheet(view: PadHostView, t: TFn): GuidedSheetSpec {
  const state = asState(view.state);
  return {
    event: RESULT_TYPE,
    steps: [
      {
        id: "winner",
        kind: "choice",
        title: t("pad.boardgame.sheet.result.winner.title"),
        options: SIDES.map((side) => ({ id: side, label: SIDE_LABEL[side] })),
      },
      {
        id: "method",
        kind: "choice",
        title: t("pad.boardgame.sheet.result.method.title"),
        options: DECISIVE_METHODS.map((method) => ({
          id: method,
          label: vocabKey("method", method) ?? method,
          tone: toneFor(method),
        })),
      },
      {
        id: "moves",
        kind: "number",
        title: t("pad.boardgame.sheet.result.moves.title"),
        initial: 0,
        min: 0,
        max: MOVES_MAX,
        hintText: t("pad.boardgame.sheet.result.moves.hint"),
      },
    ],
    buildPayload: (answers) => {
      const winnerSide: Side = answers.winner === "away" ? "away" : "home";
      const moves = Number(answers.moves ?? 0);
      const winnerPerson = state.players?.[winnerSide];
      return {
        winner: entrantOf(state, winnerSide),
        method: answers.method,
        ...(moves > 0 ? { moves } : {}),
        ...(winnerPerson !== undefined ? { winnerPerson } : {}),
      };
    },
  };
}

/** Drawn or no-result. `winner` is always `null` — `decideResult` refuses a
 *  `winnerPerson` whenever it is, so this sheet never offers one, matching
 *  padSpec's own `drawnResultAction.attribution: []`. */
function drawSheet(t: TFn): GuidedSheetSpec {
  return {
    event: RESULT_TYPE,
    steps: [
      {
        id: "method",
        kind: "choice",
        title: t("pad.boardgame.sheet.result.method.title"),
        options: DRAWN_METHODS.map((method) => ({ id: method, label: vocabKey("method", method) ?? method })),
      },
      {
        id: "moves",
        kind: "number",
        title: t("pad.boardgame.sheet.result.moves.title"),
        initial: 0,
        min: 0,
        max: MOVES_MAX,
        hintText: t("pad.boardgame.sheet.result.moves.hint"),
      },
    ],
    buildPayload: (answers) => {
      const moves = Number(answers.moves ?? 0);
      return { winner: null, method: answers.method, ...(moves > 0 ? { moves } : {}) };
    },
  };
}

export function buildSheets(view: PadHostView, t: TFn): Record<string, GuidedSheetSpec> {
  return {
    [PAIRING_TILE_ID]: pairingSheet(view, t),
    [RESULT_TILE_ID]: resultSheet(view, t),
    [DRAW_TILE_ID]: drawSheet(t),
  };
}

// ---------------------------------------------------------------------------
// dock() — always null. Every fact this sport's own result carries is
// already a step in the sheet that opened the hold, and this is a rare,
// once-per-match, terminal event with nothing time-pressured about it — the
// same reasoning generic's win_loss mode states for declaring no dock at all.
// `dock()` still fires after a sheet completes (`resolveDockSpec`,
// pad-host.tsx, forwards the sheet-built payload the same way it would a tap)
// so this is a real, exercised branch, not dead code.
// ---------------------------------------------------------------------------

export function buildDock(
  eventType: string,
  view: PadHostView,
  t: TFn,
  payload?: Record<string, unknown>,
): DockSpec | null {
  void eventType;
  void view;
  void t;
  void payload;
  return null;
}

// ---------------------------------------------------------------------------
// activityDetail() — the ribbon's varying half. Without it every
// `boardgame.pairing`/`boardgame.result` row reads identically off the
// static base caption, and a ledger of identical rows is how the wrong game
// gets voided at a scoring desk.
// ---------------------------------------------------------------------------

/** Order-preserving, de-duplicating join — the same helper generic's and
 *  badminton's own `activityDetail` builders take. */
function join(parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part.length > 0);
  const unique = [...new Set(kept)];
  return unique.length > 0 ? unique.join(" · ") : undefined;
}

function pairingDetail(ctx: ActivityDetailContext, state: BoardgameStateShape): string | undefined {
  const { t, payload, personNames } = ctx;
  const named = (id: unknown): string | undefined =>
    typeof id === "string" && id.length > 0 ? (personNames?.[id] ?? t("eventCopy.unknownPerson")) : undefined;
  const board = typeof payload.board === "number" ? t("pad.boardgame.ribbon.board", { board: payload.board }) : undefined;
  const whiteSide = typeof payload.white === "string" ? sideOfEntrant(state, payload.white) : null;
  const white = whiteSide ? t("pad.boardgame.ribbon.white", { side: t(SIDE_LABEL[whiteSide]) }) : undefined;
  return join([board, white, named(payload.homePerson), named(payload.awayPerson)]);
}

function resultDetail(ctx: ActivityDetailContext, state: BoardgameStateShape): string | undefined {
  const { t, payload, personNames } = ctx;
  const named = (id: unknown): string | undefined =>
    typeof id === "string" && id.length > 0 ? (personNames?.[id] ?? t("eventCopy.unknownPerson")) : undefined;
  const method = vocabText("method", payload.method, t);
  const moves = typeof payload.moves === "number" ? t("pad.boardgame.ribbon.moves", { moves: payload.moves }) : undefined;
  const winner = payload.winner;
  if (typeof winner !== "string") {
    // A drawn or no-result card — `method`'s own vocab text ("Draw by
    // agreement", "Double forfeit", …) already says which, so no extra word
    // is minted here.
    return join([method, moves]);
  }
  const side = sideOfEntrant(state, winner);
  const who = named(payload.winnerPerson) ?? (side ? t(SIDE_LABEL[side]) : undefined);
  return join([who, method, moves]);
}

export function boardgameDetail(ctx: ActivityDetailContext): string | undefined {
  const state = asState(ctx.state);
  switch (ctx.eventType) {
    case PAIRING_TYPE:
      return pairingDetail(ctx, state);
    case RESULT_TYPE:
      return resultDetail(ctx, state);
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// The factory.
// ---------------------------------------------------------------------------

export function boardgameSkinV3(t: TFn): SkinDefV3<PadHostView> {
  return {
    key: SPORT,
    tapModel: "T",
    phase: resolvePhase,
    scorebug: (view) => buildScorebug(view, t),
    tiles: (view) => buildTiles(view, t),
    dock: (eventType, view, payload) => buildDock(eventType, view, t, payload),
    sheets: (view) => buildSheets(view, t),
    activityDetail: boardgameDetail,
    // No swap()/context()/contextSelect()/refusedEventTypes() — see this
    // file's header.
  };
}
