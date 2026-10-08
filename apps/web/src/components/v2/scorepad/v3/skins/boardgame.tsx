// Boardgame SkinDefV3 — R7/A2, tapModel S. Converts `boardgame` to the v3
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
// TAP MODEL S — owner ruling R7-2: "tap DECIDES, dock enriches." A tap on a
// player half commits `boardgame.result` IMMEDIATELY, naming that side the
// winner; the ribbon reads the result in words with Undo; a ~6s dock then
// offers Method (checkmate / resignation / timeout / agreement …) as
// OPTIONAL enrichment — the result is the event, the method is a field on
// it. Identical grammar to football's goal.
//
// THIS SHIPPED ONCE AS TAPMODEL T INSTEAD (every action a tile opening a
// guided sheet, halves pure readouts, `dock()` always null), on the argument
// that boardgame's own result carries more than a bare "who won" and is a
// rare, once-per-match event with no reason to race a scorer against the ~6s
// hold. THE OWNER CONSIDERED THAT ARGUMENT AND REJECTED IT (R7-2): "tap
// arms, Method commits" breaks the foundation ruling that nothing records
// slower than one tap, on the one sport where that ruling costs least, and a
// slower sheet-gated path is not warranted just because the event happens
// rarely — press-and-hold was rejected too, for inventing a gesture that
// exists nowhere else in the product and is undiscoverable on touch. Recorded
// here so nobody re-derives tapModel T a third time. The mis-tap exposure a
// bare half tap carries is real and accepted, mitigated by Undo only.
//
// So: the halves ARE tappable (`tappable`/`tapEvent`, MODEL-S), each posting
// `boardgame.result {winner: <this side>}` — plus `winnerPerson` when a
// pairing card already named one, auto-attached and never re-asked, the same
// D-15 reasoning `pairingSheet`'s own doc states. `buildDock` then offers the
// DECISIVE method set as chips that `mutate` the held payload's `method`
// field. The ½–½ / no-result branch has no "half" of its own to tap, so it
// keeps ONE tile (`DRAW_TILE_ID`) that posts the same event type with
// `winner: null` and opens a dock scoped to the DRAWN set instead — R7-10:
// "R7-2's dock must offer the DECISIVE set after a half tap and the DRAWN
// set after the ½–½ tile, never one flat list of 13." The pairing card stays
// a guided SHEET, unchanged: R7-2 is a ruling about the RESULT event, and a
// pre-match card with no clock running is not the surface it is about.
//
// Nothing is left for a More sheet: `PAIRING_TYPE` is dedicated by the
// pairing tile, `RESULT_TYPE` by BOTH tappable halves and the draw tile
// (`dedicatedEventTypes`, pad-host.tsx, walks `scorebug.halves[].tapEvent`
// as well as tile actions) — proven, not assumed, against the real
// `moreActions` in `__tests__/boardgame.test.ts`.
//
// `led` — SIDE-TO-MOVE / WHITE. `state.colorOfHome` defaults to "W" (home is
// White) the moment `cfg.colors` is true, from `init()` onward, no pairing
// card required — a Swiss pairing card MAY flip it (`applyPairing`), but the
// fact is knowable from the very first render. Rendered the same way
// badminton/tennis spend their own `led` — `WhoLine.serving` + `servingLabel`
// (types.ts's own doc: the boolean is generic, the label is skin-supplied
// prose, and racquet sports keep their own key precisely so one sport's key
// never serves another). `colorOfHome === null` (colours off) renders it on
// NEITHER half, ever. Orthogonal to the tap grammar above: which side is TO
// MOVE and which side just WON are two different facts, and this skin has
// always shown the first as ambient context, not an answer to a tap.
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
//     "live"` guard matches the tappable-halves/draw-tile "live"-only gate
//     exactly; `applyPairing`'s "pre" OR "live" guard is MORE permissive than
//     the "pre"-only pairing panel, never less — the safe direction, and this
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
  type DockChip,
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
  "boardgame.tiebreak": 0, // W2a BG-KO-1 — the module's own band (ruling D-C4; Task 12 owns the rest of this skin)
};

function withinBand(eventType: string, band: FidelityBand): boolean {
  const need = EVENT_BAND[eventType];
  return need === undefined || need <= band;
}

/**
 * `padSpec(cfg)`'s own decisive/drawn method vocabularies, restated because
 * `boardgame.ts` keeps them module-private (`DECISIVE_METHODS`/
 * `DRAWN_METHODS`, boardgame.ts:378-385) — the same "restate, then prove
 * equal to the source of truth" posture badminton's `SANCTION_LEVELS` takes,
 * pinned equal to the real field's `values` in `__tests__/boardgame.test.ts`.
 * "adjudication" appears in both: an arbiter's discretionary ruling (FIDE
 * Art. 5.2) can go either way. Consumed by `buildDock` below: a decisive
 * half tap's dock offers exactly the first list, the draw tile's dock exactly
 * the second, never one flat list of 13 (R7-10).
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

/** `boardgame.ts`'s own field sentinel (`BOARD_MAX`), restated for the
 *  identical module-private reason `DECISIVE_METHODS` above states — pinned
 *  equal to `padSpec(cfg)`'s real field bound in the test file. (`MOVES_MAX`
 *  does not live here any more: the move count was a guided-sheet step, and
 *  tapModel S's dock is chips only — see `buildDock`'s own doc.) */
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
// scorebug() — tapModel S. The halves decide; the White indicator is
// ambient context, unrelated to the tap.
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

export const RESULT_HINT_KEY = "pad.boardgame.scorebug.result.hint";

function buildHalf(view: PadHostView, state: BoardgameStateShape, side: Side, t: TFn): ScorebugHalf {
  const players = onFieldPlayers(view.squads, side);
  const isWhite = whiteSideOf(state) === side;
  const whiteFlag = isWhite ? { serving: true as const, servingLabel: t("pad.boardgame.scorebug.white") } : {};
  const who: WhoLine[] =
    players.length > 0
      ? players.map((member) => ({ name: nameOf(view, member.personId, t), ...whiteFlag }))
      : [{ name: t(SIDE_LABEL[side]), ...whiteFlag }];
  // "live" only — a decisive result before the match starts, or after one
  // already decided it, is exactly the tap `decideResult`'s own phase guard
  // refuses. `withinBand` is always true today (RESULT_TYPE is band 0 in
  // EVERY fixture), kept for the same defensive-symmetry reason every other
  // converted skin's own `tappable` gate keeps its band check.
  const tappable = resolvePhase(view) === "live" && withinBand(RESULT_TYPE, view.band);
  // SOLE-NAMED-PLAYER AUTO-SET — the same D-15 reasoning `pairingSheet`'s own
  // doc states: a pairing card can only ever have named ONE person per side,
  // so a tap stamps it straight onto the payload rather than asking again.
  // Absent when no pairing card has run at all (`state.players` stays
  // `undefined` until `applyPairing` sets it).
  const winnerPerson = state.players?.[side];
  return {
    who,
    side,
    big: bigOf(view, state, side),
    tappable,
    ...(tappable
      ? {
          hintKey: RESULT_HINT_KEY,
          tapEvent: {
            type: RESULT_TYPE,
            payload: {
              winner: entrantOf(state, side),
              ...(winnerPerson !== undefined ? { winnerPerson } : {}),
            },
          },
        }
      : {}),
  };
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
    // ribbon (`boardgameDetail`) for where method/board actually live.
    strip: [],
  };
}

// ---------------------------------------------------------------------------
// tiles() — the pairing card (a sheet, "pre" only) and, live, the ONE
// outcome a half tap cannot express: a drawn/no-result game, which posts
// `boardgame.result` directly (`winner: null`) exactly the way a half tap
// posts its own `winner`, and opens the SAME dock, scoped to the DRAWN set.
// ---------------------------------------------------------------------------

export const PAIRING_TILE_ID = "pairing";
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
      id: DRAW_TILE_ID,
      label: "pad.boardgame.action.draw",
      kind: "standard",
      span: 4,
      phases: ["live"],
      action: { event: { type: RESULT_TYPE, payload: { winner: null } } },
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
// convention every v3 skin's `sheets` takes. The pairing card is the only
// entry left: the decisive/drawn result no longer opens a sheet at all under
// tapModel S — see this file's header.
// ---------------------------------------------------------------------------

/** The pre-match pairing card. `board` is always asked (a light, low-friction
 *  number step — most fixtures just accept "1"); `white` only when this
 *  division tracks colours, mirroring padSpec's own cfg-gated `attribution`
 *  list exactly. `homePerson`/`awayPerson` are NEVER a picker — `boardgame
 *  .ts`'s own `positions.lineup = {size: 1, benchMax: 0}` bounds each side to
 *  at most one on-field member, so asking would be a one-option picker (the
 *  D-15 defect); this sheet auto-attaches whichever member the lineup already
 *  names. */
function pairingSheet(view: PadHostView): GuidedSheetSpec {
  const state = asState(view.state);
  const cfg = cfgOf(view);
  const homeSole = soleMemberOf(view.squads, "home");
  const awaySole = soleMemberOf(view.squads, "away");
  const steps: GuidedSheetStep[] = [
    {
      id: "board",
      kind: "number",
      title: "pad.boardgame.sheet.pairing.board.title",
      initial: state.board ?? 1,
      min: 1,
      max: BOARD_MAX,
    },
  ];
  if (colorsOn(cfg)) {
    steps.push({
      id: "white",
      kind: "choice",
      title: "pad.boardgame.sheet.pairing.white.title",
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

export function buildSheets(view: PadHostView, t: TFn): Record<string, GuidedSheetSpec> {
  return { [PAIRING_TILE_ID]: pairingSheet(view) };
}

// ---------------------------------------------------------------------------
// dock() — RULING R7-2: tap decides, dock enriches.
//
// A half tap (or the draw tile) commits `boardgame.result` immediately with
// nothing beyond `winner` — plus `winnerPerson` when a pairing card already
// named one (`buildHalf`'s own auto-attach; never re-asked, the same D-15
// reasoning `pairingSheet` states). The one thing worth enriching afterwards
// is HOW the game ended, which `boardgame.ts` splits into two closed,
// DISJOINT-BY-INTENT vocabularies (its own comment: "every decisive method
// needs a winner; every drawn/no-result method needs none") — so a decisive
// tap's dock must only ever offer `DECISIVE_METHODS`, and the draw tile's
// only ever `DRAWN_METHODS`, never one flat list of 13 (R7-10). The held
// payload's own `winner` is what tells the two apart here: a half tap's
// payload always names a real entrant id; the draw tile's is the one place
// this skin ever posts an explicit `winner: null`.
//
// A chip only ever REWRITES `method` on the held payload (`DockChip.mutate`
// — the `mutateHeld` idiom `skins/generic.tsx`'s own `amountChip` documents,
// and whose own header cites this same R7-2 ruling) and never posts a second
// event — tapping a different method simply overwrites the last choice, so a
// mis-tap is correctable for the whole ~6s hold, the same "repeat is
// refused, a different chip wins" behaviour every other dock in this chassis
// gives a scorer.
//
// No `moves` capture any more — R7-2's own words scope the dock to "Method
// … as OPTIONAL enrichment" alone, and a dock's `chips: DockChip[]` shape
// has no field for an arbitrary typed number in the first place (a "how many
// moves" question would need 400 chips, not one). The move count this pad
// used to ask for a guided sheet is not reachable from this grammar.
// ---------------------------------------------------------------------------

/** A method chip only ever rewrites `method` — the same bare-key convention
 *  the old sheet's own `SheetChoiceStep.options[].label` used (every
 *  `DECISIVE_METHODS`/`DRAWN_METHODS` member has a real `method.*`
 *  dictionary entry; the `?? method` fallback is defensive symmetry with
 *  `vocabText`'s own posture, not a path this skin's vocabulary ever
 *  actually takes). No `labelText` needed: unlike a person's name or an
 *  interpolated amount, a method label is a closed, already-registered key
 *  the chassis resolves on its own (`detail-dock.tsx`: `chip.labelText ??
 *  t(chip.label)`). */
function methodChip(method: string): DockChip {
  return {
    id: `method:${method}`,
    label: vocabKey("method", method) ?? method,
    mutate: (payload) => ({ ...payload, method }),
  };
}

export function buildDock(
  eventType: string,
  view: PadHostView,
  t: TFn,
  payload?: Record<string, unknown>,
): DockSpec | null {
  void view;
  if (eventType !== RESULT_TYPE) return null;
  const methods = payload?.winner === null ? DRAWN_METHODS : DECISIVE_METHODS;
  return {
    title: t("pad.boardgame.sheet.result.method.title"),
    chips: methods.map(methodChip),
  };
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
    // is minted here. `moves` stays defensively handled (a payload from
    // before this change, or any other producer, may still carry it) even
    // though nothing in this file writes it any more — see `buildDock`'s
    // own header.
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
    tapModel: "S",
    phase: resolvePhase,
    /** R7/D — same identity as generic: `bigOf` renders `summary.perSide[].
     *  line` and boardgame.ts builds `headline` from the very same
     *  `pointsText(home/away)` pair. The undecided state makes the case
     *  stronger rather than weaker — before an outcome the headline is the
     *  literal string "vs" and both `perSide` lines are empty, so the bar
     *  reads "vs" above two halves already showing the two names and a dash.
     *  Nothing is lost in either state. */
    ownsHeadline: () => true,
    scorebug: (view) => buildScorebug(view, t),
    tiles: (view) => buildTiles(view, t),
    dock: (eventType, view, payload) => buildDock(eventType, view, t, payload),
    sheets: (view) => buildSheets(view, t),
    activityDetail: boardgameDetail,
    // No swap()/context()/contextSelect()/refusedEventTypes() — see this
    // file's header.
  };
}
