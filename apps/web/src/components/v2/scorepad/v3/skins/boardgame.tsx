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
import { deciderPending, resolveVoids, type Settlement, type SettleMethod, type SquadState } from "@seazn/engine/core";
import { boardgamePadRules } from "@seazn/engine/pad";
import {
  ARMAGEDDON_RESULTS,
  boardgame,
  DECISIVE_METHODS as ENGINE_DECISIVE_METHODS,
  DRAWN_METHODS as ENGINE_DRAWN_METHODS,
  effectiveRungs,
  type BoardgameState,
  type TiebreakRung,
} from "@seazn/engine/sports/boardgame";
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
  type SheetContextLine,
  type SkinDefV3,
  type StepPredicate,
  type TileSpec,
  type WhoLine,
} from "../types";

export type TFn = (key: string, vars?: Record<string, string | number>) => string;
export type Side = "home" | "away";

const SPORT = "boardgame";
export const RESULT_TYPE = `${SPORT}.result`;
export const PAIRING_TYPE = `${SPORT}.pairing`;
/** W2a BG-KO-1 — the engine's decider event (`boardgame.deciderTypes`), restated because the entry does not export
 *  `BOARDGAME_TIEBREAK_TYPE`; pinned equal to the module's own list in `boardgame-tiebreak.test.ts`. */
export const TIEBREAK_TYPE = `${SPORT}.tiebreak`;

export const SIDES: readonly Side[] = ["home", "away"];
const SIDE_LABEL: Record<Side, MessageKey> = {
  home: "scorepad.attribution.home",
  away: "scorepad.attribution.away",
};

/**
 * Event type -> fidelity band: `boardgamePadRules.eventBands`, the very map `padSpec(cfg).fidelity` returns (pad wave P4.1),
 * so there is no second scale to keep equal. The result is band 0 (a board game ships its terminal record free at every
 * band); the pairing card is band 1, so a band-0 fixture never sees an offer it cannot afford.
 */
function withinBand(eventType: string, band: FidelityBand): boolean {
  const need = boardgamePadRules.eventBands[eventType];
  return need === undefined || need <= band;
}

/**
 * `padSpec(cfg)`'s own decisive/drawn method vocabularies, IMPORTED from the engine (W2e T10, BG-RS-1): the write path
 * refuses a result whose method is in only one list against the winner it was given, so a second copy here could offer a
 * chip the server refuses. They are the engine's exports re-typed `readonly string[]` (the dock compares them to string
 * ids), never restated; `__tests__/boardgame.test.ts` pins them equal to the real field's `values`.
 * "adjudication" appears in both: an arbiter's discretionary ruling (FIDE Art. 5.2) can go either way. Consumed by
 * `buildDock` below: a decisive half tap's dock offers exactly the first list, the draw tile's dock exactly the second,
 * never one flat list (R7-10).
 *
 * W2b (D15): no `forfeit` / `double_forfeit`. Both are retired on write for
 * EVERY writer (append-event.ts `RETIRED_ON_WRITE_SPORT_EVENTS`; the engine's
 * padSpec dropped them too) — a chess forfeit is `core.forfeit` with a reason,
 * recorded through the console's forfeit dialog like every other sport's
 * (UI-1). A chip for either would be a tap the server refuses for everybody.
 */
export const DECISIVE_METHODS: readonly string[] = ENGINE_DECISIVE_METHODS;
export const DRAWN_METHODS: readonly string[] = ENGINE_DRAWN_METHODS;

/** The tie-break rung that records who had Black and the result rather than a winner (BG-KO-2): the engine's own literal,
 *  `boardgamePadRules.armageddonRung`. The board-number bound is `boardgamePadRules.boardMax` (BG-PA-1). (`MOVES_MAX` does
 *  not live here any more: the move count was a guided-sheet step, and tapModel S's dock is chips only — see
 *  `buildDock`'s own doc.) */
const ARMAGEDDON_RUNG: string = boardgamePadRules.armageddonRung;

// ---------------------------------------------------------------------------
// The folded state, as this file reads it. A STRUCTURAL view of
// `BoardgameState` (boardgame.ts) — every field optional, because a pad can
// mount against a pre-fold `{}` and must degrade rather than throw.
// ---------------------------------------------------------------------------

interface BoardgameCfgShape {
  colors?: boolean;
  /** W2c BG-KO-3 — the rungs the stage plays, in the stage's order; absent = every rung (`effectiveRungs`). */
  tiebreakRungs?: TiebreakRung[];
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

/** `pre|live|tiebreak|done|final|abandoned` (boardgame.ts) mapped down onto
 *  `PadPhase`'s closed three. `core.abandon` folds to its OWN "abandoned"
 *  phase (as generic's does since W2b D16), so POST_PHASES carries all three
 *  terminal values. "tiebreak" is neither: it is live while the decider is
 *  owed and post once settled (`resolvePhase` below). */
const POST_PHASES = new Set(["done", "final", "abandoned"]);

export function resolvePhase(view: Pick<PadHostView, "state" | "events">): PadPhase {
  const phase = readPhase(asState(view.state));
  if (phase === "pre") return "pre";
  if (POST_PHASES.has(phase)) return "post";
  // W2a (addendum 1; ruling D-C5): a drawn bracket game sits in module phase "tiebreak" until its decider is
  // recorded — and STAYS there after an organiser settles it (the settle never reaches the module). Live only while
  // the decider is still owed; settled, the match is over and every tap the pad could offer is refused.
  if (phase === "tiebreak") return tiebreakPending(view) ? "live" : "post";
  return "live";
}

/** The ledger's active `core.settle`, as the kernel folds it (core/events.ts): read off the SAME events the pad
 *  folded, with voids resolved by the engine's own `resolveVoids` — so a voided settle is no settle. The kernel
 *  accepts at most one active settle (a second is SETTLE_NOT_APPLICABLE), so the last one seen is the one. */
export function settlementOf(view: Pick<PadHostView, "state" | "events">): Settlement | null {
  const state = asState(view.state);
  let settlement: Settlement | null = null;
  for (const event of resolveVoids(view.events)) {
    if (event.type !== "core.settle") continue;
    const payload = asRecord(event.payload);
    const winnerSide = sideOfEntrant(state, payload.winner);
    // The kernel refused any settle naming neither side (INVALID_EVENT), so the fold that produced this state never
    // saw one. Reaching here means this view's events and state disagree — fail loudly, never guess a winner.
    if (winnerSide === null) throw new Error(`boardgame pad: core.settle ${event.id} names neither side of this fixture`);
    settlement = {
      winner: entrantOf(state, winnerSide),
      loser: entrantOf(state, winnerSide === "home" ? "away" : "home"),
      method: payload.method as SettleMethod,
      eventId: event.id,
    };
  }
  return settlement;
}

/** THE gate for the tie-break panel (addendum 1): the kernel's `deciderPending`, fed the module's own hook and the
 *  ledger's settle — never the module phase alone, which still says "tiebreak" after a settle. */
export function tiebreakPending(view: Pick<PadHostView, "state" | "events">): boolean {
  return deciderPending(boardgame, { state: view.state as BoardgameState, settlement: settlementOf(view) });
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
  // W2a: never while a tie-break is owed — the result is already recorded (drawn), and the decider is the only write
  // the engine accepts (the panel below).
  const tappable = resolvePhase(view) === "live" && !tiebreakPending(view) && withinBand(RESULT_TYPE, view.band);
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
export const TIEBREAK_TILE_ID = "tiebreak";

export function buildTiles(view: PadHostView, t: TFn): TileSpec[] {
  const phase = resolvePhase(view);
  const tiles: TileSpec[] = [];
  // W2a (spec §5.5, UI-2 option B): while a tie-break is owed it is the ONLY thing to record — no Draw (the game is
  // already drawn), no tappable half (`buildHalf`). Draw itself stays in every stage kind while live (ruling D-P1:
  // the drawn game is how a bracket reaches its tie-break).
  if (tiebreakPending(view)) {
    if (withinBand(TIEBREAK_TYPE, view.band)) {
      tiles.push({
        id: TIEBREAK_TILE_ID,
        label: "pad.boardgame.action.tiebreak",
        kind: "standard",
        span: 4,
        phases: ["live"],
        action: { sheet: TIEBREAK_TILE_ID },
      });
    }
    return tiles;
  }
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
      max: boardgamePadRules.boardMax,
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

/** D6 — the optional mini-match score, written from the WINNER's side (the engine validates any `CHESS_SCORE`). Ids
 *  are the score itself; "none" sends no score. The ORDER is this file's presentation (none, clean, narrow); WHICH scores are
 *  offered is `boardgamePadRules.tiebreakScores` (BG-KO-4, `null` = none), compared as a set in `__tests__/pad-rules-small.test.ts`. */
const SCORES = ["none", "2–0", "1½–½"] as const;
const SCORE_LABEL: Record<(typeof SCORES)[number], MessageKey> = {
  none: "pad.boardgame.tiebreak.score.none",
  "2–0": "pad.boardgame.tiebreak.score.clean",
  "1½–½": "pad.boardgame.tiebreak.score.narrow",
};

/** The side a rapid/blitz winner step answered — the step the RUNG shows, never a stale answer left by a different rung. */
function winnerSideOf(answers: Readonly<Record<string, string>>, rung: string | undefined = answers.rung): Side {
  const answer = answers.winner;
  if (answer === "home" || answer === "away") return answer;
  // The chassis completes a sheet only once every shown step is answered, so this is unreachable from the pad —
  // and defaulting would record the wrong player as advancing.
  throw new Error(`boardgame tie-break: no winner answered for rung "${String(rung)}"`);
}

/** W2c Task 21 (S5) — the Armageddon sheet's option ids. Each step prefixes its own, so a page-wide
 *  `[data-choice-option-id]` hook names ONE control (rapid and blitz already use a bare `home`/`away` for their winner).
 *  An answer IS the tapped option id (guided-sheet.tsx `answerStep`), so the prefix comes off again here. */
export const BLACK_OPTION_PREFIX = "black-";
export const RESULT_OPTION_PREFIX = "result-";

/** Who had Black — the Black step's answer, as a side. Never defaulted: the wrong colour would advance the wrong player. */
function blackSideOf(answers: Readonly<Record<string, string>>, rung: string | undefined = answers.rung): Side {
  const answer = answers.black;
  if (answer === `${BLACK_OPTION_PREFIX}home`) return "home";
  if (answer === `${BLACK_OPTION_PREFIX}away`) return "away";
  throw new Error(`boardgame tie-break: no Black answered for rung "${String(rung)}"`);
}

/** How the Armageddon ended, from White's side — one of the ENGINE's results, never defaulted. */
function armageddonResultOf(answers: Readonly<Record<string, string>>, rung: string | undefined = answers.rung): (typeof ARMAGEDDON_RESULTS)[number] {
  const result = ARMAGEDDON_RESULTS.find((r) => answers.result === `${RESULT_OPTION_PREFIX}${r}`);
  if (result !== undefined) return result;
  throw new Error(`boardgame tie-break: no result answered for rung "${String(rung)}"`);
}

/** The colour word the read-back names ("White won"). Literal keys, so the dictionary gate sees every one. */
const COLOUR_KEY: Record<"white" | "black", MessageKey> = {
  white: "pad.boardgame.tiebreak.colour.white",
  black: "pad.boardgame.tiebreak.colour.black",
};

/**
 * W2a — the tie-break (spec §5.5; UI-2 option B; BG-KO-1; BG-KO-2 per ruling 82; D6), reshaped by W2c Task 21 (S5, owner
 * option A "facts, then the engine decides"; design pass at the owner's sign-off).
 *
 * Step 1 the rung, OFFERED FROM THE STAGE: only the rungs its list plays, in the list's order (BG-KO-3; `effectiveRungs`
 * — absent means every rung), with a hint that sends lots to the organiser (lots is `core.settle {method: "lot"}`,
 * ruling 73 — never a rung here). The order is a menu, not a rule: the engine does not enforce it (open owner item).
 * A stage that plays exactly ONE rung has nothing to ask: the sheet is built for that rung alone, opens on its first step,
 * and names the round in its context line (design pass, owner question (b)). Back is then absent on the first screen, which
 * is the chassis' own rule for step 0 — Cancel is the way out.
 *
 * Rapid and blitz are unchanged: who won (exactly the two entrants), then the optional score (D6).
 *
 * The Armageddon (BG-KO-2) records FACTS: who had Black, then how it ended (White won / Black won / Drawn). The scorer
 * never names a winner and never applies the rule — the ENGINE derives who advances (a draw is Black's) — and a closing
 * read-back says what that will be ("Advances: Priya Menon — Black, Armageddon drawn") before the one Confirm writes.
 * Colour lives on the tie-break event and never touches the main game's `colorOfHome`.
 *
 * Every step after the rung pick carries a context block: the round, and — once Black is known — who is White and who is
 * Black, so "White won" never asks the scorer to remember a mapping. Colour discs appear only where colour is a FACT (that
 * legend and the three results), never on the Black step's own options, which would pre-judge a tap that has not said it yet.
 *
 * Each branch's steps are gated on the rung, so a hint or an answer left by another rung never reaches the payload. Option
 * labels are keys; a side option also carries a name (`labelText`): the player the lineup or pairing card SEATS, else the
 * side's entrant as the screen names it (`view.entrantNames`, fix round 1 I2: with no pairing card nobody is seated, and
 * the options read "Home"/"Away"), else the key. Fix round 2 (N1) restored the seated person's precedence, which round 1
 * had let the entrant label beat.
 */
function tiebreakSheet(view: PadHostView, t: TFn): GuidedSheetSpec {
  const state = asState(view.state);
  const sides = SIDES.map((side) => {
    const names = onFieldPlayers(view.squads, side)
      .map((member) => view.personNames[member.personId])
      .filter((name): name is string => typeof name === "string" && name.length > 0);
    const entrant = view.entrantNames[side];
    const labelText = names.length > 0 ? names.join(" & ") : entrant !== undefined && entrant.length > 0 ? entrant : undefined;
    return { side, label: SIDE_LABEL[side], ...(labelText !== undefined ? { labelText } : {}) };
  });
  const sideOptions = (idOf: (side: Side) => string) =>
    sides.map(({ side, label, labelText }) => ({ id: idOf(side), label, ...(labelText !== undefined ? { labelText } : {}) }));
  /** What the screen calls a side — the name its option wears, else the Home/Away word. */
  const nameOf = (side: Side): string => {
    const found = sides.find((s) => s.side === side)!;
    return found.labelText ?? t(found.label);
  };
  const rungs = effectiveRungs(cfgOf(view));
  /** The stage's ONLY rung, when it plays exactly one: there is nothing to ask, so the sheet never shows the pick. */
  const only = rungs.length === 1 ? rungs[0] : undefined;
  /** The rung the answers so far are about: the stage's only one, else the scorer's pick. */
  const rungOf = (a: Readonly<Record<string, string>>): string | undefined => only ?? a.rung;
  /** `when` for a branch's steps: gated on the pick when there is one, ungated (always shown) for a one-rung sheet, whose first
   *  step must never declare `when` (types.ts `StepPredicate`) and whose other branch is not built at all. */
  const gate = (shown: (rung: string | undefined) => boolean): { when?: StepPredicate } => (only === undefined ? { when: (a) => shown(a.rung) } : {});
  const rungWord = (rung: string): string => {
    const key = vocabKey("rung", rung);
    return key === null ? rung : t(key);
  };
  /** The round line every step after the pick opens its context with. */
  const roundLine = (a: Readonly<Record<string, string>>): SheetContextLine[] => {
    const rung = rungOf(a);
    return rung === undefined ? [] : [{ text: rungWord(rung) }];
  };
  /** Who is White and who is Black, once the Black step has been answered (BG-KO-2: the other entrant is White). */
  const colourLines = (a: Readonly<Record<string, string>>): SheetContextLine[] => {
    const black = blackSideOf(a, rungOf(a));
    const white: Side = black === "home" ? "away" : "home";
    return [
      { label: t("pad.boardgame.tiebreak.who.white"), text: nameOf(white), disc: "white" },
      { label: t("pad.boardgame.tiebreak.who.black"), text: nameOf(black), disc: "black" },
    ];
  };
  const rungStep: GuidedSheetStep = {
    id: "rung",
    kind: "choice",
    title: "pad.boardgame.tiebreak.rung.title",
    hintKey: "pad.boardgame.tiebreak.lotsHint",
    layout: "rows",
    options: rungs.map((rung) => ({ id: rung, label: vocabKey("rung", rung) ?? rung })),
  };
  const timedSteps: GuidedSheetStep[] = [
    {
      id: "winner",
      kind: "choice",
      title: "pad.boardgame.tiebreak.winner.title",
      ...gate((rung) => rung !== ARMAGEDDON_RUNG),
      layout: "rows",
      context: roundLine,
      options: sideOptions((side) => side),
    },
    {
      id: "score",
      kind: "choice",
      title: "pad.boardgame.tiebreak.score.title",
      ...gate((rung) => rung !== ARMAGEDDON_RUNG),
      context: roundLine,
      options: SCORES.map((score) => ({ id: score, label: SCORE_LABEL[score] })),
    },
  ];
  const armageddonSteps: GuidedSheetStep[] = [
    {
      id: "black",
      kind: "choice",
      title: "pad.boardgame.tiebreak.black.title",
      ...gate((rung) => rung === ARMAGEDDON_RUNG),
      layout: "rows",
      context: roundLine,
      options: sideOptions((side) => `${BLACK_OPTION_PREFIX}${side}`),
    },
    {
      id: "result",
      kind: "choice",
      title: "pad.boardgame.tiebreak.result.title",
      hintKey: "pad.boardgame.tiebreak.armageddonHint",
      ...gate((rung) => rung === ARMAGEDDON_RUNG),
      layout: "rows",
      context: (a) => [...roundLine(a), ...colourLines(a)],
      // The engine's own three results, in its order; the Draw's label carries its consequence ("Drawn — Black advances"), and
      // each wears the colour it is about: White won, Black won, and a split disc for the draw.
      options: ARMAGEDDON_RESULTS.map((result) => ({
        id: `${RESULT_OPTION_PREFIX}${result}`,
        label: vocabKey("result", result) ?? result,
        disc: result === "draw" ? ("split" as const) : result,
      })),
    },
    {
      id: "confirm",
      kind: "confirm",
      title: "pad.boardgame.tiebreak.confirm.title",
      ...gate((rung) => rung === ARMAGEDDON_RUNG),
      context: (a) => [...roundLine(a), ...colourLines(a)],
      summary: (a) => {
        const black = blackSideOf(a, rungOf(a));
        const result = armageddonResultOf(a, rungOf(a));
        // BG-KO-2, as the scorer reads it: White won → the other entrant; Black won or drawn → Black. The ENGINE
        // decides the real outcome from the same two facts; the seam test folds each pair and pins that they agree.
        const advancer: Side = result === "white" ? (black === "home" ? "away" : "home") : black;
        return result === "draw"
          ? t("pad.boardgame.tiebreak.confirm.drawn", { name: nameOf(advancer) })
          : t("pad.boardgame.tiebreak.confirm.won", { name: nameOf(advancer), colour: t(COLOUR_KEY[result]) });
      },
    },
  ];
  return {
    event: TIEBREAK_TYPE,
    // A one-rung sheet is built for that rung alone (no pick, no `when`); a several-rung sheet keeps both branches, gated on the pick.
    steps: only === undefined ? [rungStep, ...timedSteps, ...armageddonSteps] : only === ARMAGEDDON_RUNG ? armageddonSteps : timedSteps,
    buildPayload: (a) => {
      const rung = rungOf(a);
      if (rung === ARMAGEDDON_RUNG) return { rung, black: entrantOf(state, blackSideOf(a, rung)), result: armageddonResultOf(a, rung) };
      const score = a.score;
      return {
        rung,
        winner: entrantOf(state, winnerSideOf(a, rung)),
        ...(score !== undefined && score !== "none" ? { score } : {}),
      };
    },
  };
}

export function buildSheets(view: PadHostView, t: TFn): Record<string, GuidedSheetSpec> {
  return { [PAIRING_TILE_ID]: pairingSheet(view), [TIEBREAK_TILE_ID]: tiebreakSheet(view, t) };
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
    // agreement", or a replayed pre-W2b "Double forfeit") already says which, so no extra word
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
