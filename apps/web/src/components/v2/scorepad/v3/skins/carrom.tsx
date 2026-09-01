// v3/skins/carrom.tsx — CARROM (ICF), ScoringPad v3 wave R7 (task A3).
//
// RULING: carrom is tapModel T (carried into this wave verbatim): "HYBRID tap
// model (S: tennis/badminton/tabletennis/volleyball/boardgame/generic · T:
// cricket/football/hockey/icehockey/carrom)." Both scorebug halves are
// READOUTS — no `tappable`, no `tapEvent` — and every action is a TILE that
// opens a SHEET. Do not copy boardgame's shape: boardgame is tapModel S and
// was reworked INTO S from T; the grammar its own header argues for is
// exactly the one this file must not use. Cricket, football, hockey and ice
// hockey are the precedents this file follows.
//
// PURE DATA, no React: every `SkinDefV3` method returns plain data, the same
// testability stance every other v3 primitive takes (apps/web vitest is
// `environment: "node"`, no jsdom). `.tsx` only because the sibling skins are.
//
// FACTORY, not a bare object — `carromSkinV3(t)` is built once per render by
// `v3/registry.ts`'s `resolvePad`, off the caller's OWN live translator, for
// the identical reason cricket's/football's own header comments give:
// `ScorebugSpec.context` is PRE-RESOLVED text, and `V3_SKINS` is built at
// module-evaluation time, before any request has picked a locale.
//
// THE ENGINE SURFACE THIS FILE MIRRORS (`packages/engine/src/sports/carrom/
// carrom.ts`), read rather than retyped from a brief. Three event types
// only — `carrom.toss`, `carrom.board.summary`, `carrom.game.adjust` — and
// `padSpec(cfg)` gives every one of them a DEDICATED action already: a toss
// tile (pre-match), two board tiles (no queen / queen covered — one
// `carrom.board.summary` TYPE, two attribution shapes, the cricket
// ballAction/extraAction/wicketAction precedent `carrom.ts`'s own padSpec
// comment cites), and two umpire-adjustment tiles (credit / deduct — the
// `generic.score` add/correct split, split at zero because `delta` is
// `.refine(d => d !== 0)`). NOTHING is left for the generic "More" sheet, so
// this skin declares none — `dedicatedEventTypes` (pad-host.tsx) already
// excludes all three from it, and a tile that opened an empty form would be
// worse than no tile at all.
//
// `ADJUST_REASONS` below MIRRORS carrom.ts's own private (unexported)
// constant of the identical name (`carrom.ts:582`) — pinned against the real
// module in `__tests__/carrom.test.ts`, the same "mirror it, pin it" pattern
// football's `CARD_REASONS`/hockey's `HOCKEY_REASONS` already establish.
//
// R7-10: carrom's `icf`/`club-29` variants shift cfg numbers only (`gameTo`,
// `queenPoints`, `queenCapAt`) — no event-surface or pad effect, so this file
// reads every bound off `cfg` and needs no variant branch of its own.
//
// WHAT THIS SKIN DELIBERATELY DOES NOT DECLARE:
//   - `context()`/`contextSelect()`. Carrom has no persistent per-person slot
//     the fold could hold — `breaker` is a per-BOARD attribution, not an
//     ongoing "who is currently X" fact — so a context strip would be
//     affordance with nothing behind it, the identical reasoning football's
//     own header gives for declining the same pair.
//   - `swap()`. No lineup/substitution event exists anywhere in
//     `CARROM_EVENT_SCHEMAS`; `types.ts`'s own doc on `SkinDefV3.swap` names
//     "carrom singles" directly as a sport with no in-play substitutions.
//   - `clock()`. Carrom's state carries no `asOf`/elapsed-time field at all —
//     boards and games are counted, not timed.
//   - `refusedEventTypes()`. Every `carrom.*` type is dedicated (see above),
//     so there is no generic More sheet for this method to narrow — it exists
//     only to keep that sheet honest, and carrom never opens one.
"use client";
import type { FidelityBand } from "@seazn/engine/sport";
import type { MessageKey } from "@/lib/messages";
import { ENUM_VOCAB } from "@/lib/scoring-vocab";
import type {
  ActivityDetailContext,
  DockChip,
  DockSpec,
  GuidedSheetSpec,
  PadHostView,
  PadPhase,
  ScorebugSpec,
  SkinDefV3,
  StripItem,
  TileSpec,
} from "../types";

export type TFn = (key: string, vars?: Record<string, string | number>) => string;
export type Side = "home" | "away";

/**
 * Mirrors carrom.ts's own private `ADJUST_REASONS` (`carrom.ts:582`) — the
 * pad-only enum `padSpec`'s `adjustCredit`/`adjustDeduct` actions declare for
 * `reason` (the schema's own `CarromGameAdjust.reason` stays free text; see
 * that file's comment on why some enum is unavoidable here). Pinned against
 * the real module by `__tests__/carrom.test.ts`.
 */
export const ADJUST_REASONS = ["due_coins", "foul", "other"] as const;

// ---------------------------------------------------------------------------
// State/cfg/summary readers. `PadHostView.state`/`.cfg`/`.summary` are
// `unknown` by contract; every reader degrades cleanly from `{}`, never
// throws.
// ---------------------------------------------------------------------------

interface CarromGameShape {
  score?: { home?: number; away?: number };
  winner?: Side | "draw" | null;
}

interface CarromStateShape {
  phase?: string;
  entrants?: { home?: string; away?: string };
  games?: CarromGameShape[];
  gamesWon?: { home?: number; away?: number };
  gamesDrawn?: number;
}

interface CarromCfgShape {
  gameTo?: number;
  maxBoards?: number;
  bestOf?: number;
  queenPoints?: number;
  queenCapAt?: number;
}

/** One entry of `summary().detail.games[].boards[]` (carrom.ts's own
 *  `summary()`) — every id already resolved from the fold's internal `Side`
 *  literal to a real entrant id, which is why the DOCK reads this rather than
 *  re-deriving `breakerOf`'s alternation formula a second time (that formula
 *  is carrom.ts-private; the fold has ALREADY applied it by the time this
 *  pad's dock renders — see `lastBoard`'s own doc below). */
interface CarromSummaryBoardShape {
  winner?: string;
  points?: number;
  queenTo?: string | null;
  queenScored?: boolean;
  breaker?: string;
  breakerPerson?: string;
  queenPerson?: string;
}

interface CarromSummaryShape {
  detail?: {
    games?: { boards?: CarromSummaryBoardShape[] }[];
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asState(state: unknown): CarromStateShape {
  return asRecord(state) as CarromStateShape;
}

function asCfg(cfg: unknown): CarromCfgShape {
  return asRecord(cfg) as CarromCfgShape;
}

function asSummary(summary: unknown): CarromSummaryShape {
  return asRecord(summary) as CarromSummaryShape;
}

/** carrom.ts's own `State.phase` union read as a bare string. "pre" is the
 *  documented starting value (`init` always sets it), so an unfolded state
 *  reads as pre-match rather than as a live one. */
function readPhase(state: CarromStateShape): string {
  return typeof state.phase === "string" && state.phase.length > 0 ? state.phase : "pre";
}

/** Phases in which the fixture is over — `applyForfeit`/`applyAbandon`'s own
 *  refusal set, and the three that map to `PadPhase` "post". */
const POST_PHASES = new Set(["done", "final", "abandoned"]);

// ---------------------------------------------------------------------------
// phase() — G3. OPT-IN: declaring it is the deliverable. Carrom's five engine
// phases map DOWN to the three-value `PadPhase` with no sub-phase nuance at
// all (unlike football's SHOOTOUT) — pre -> "pre", the three decided phases
// -> "post", everything else -> "live".
// ---------------------------------------------------------------------------

export function resolvePhase(view: Pick<PadHostView, "state">): PadPhase {
  const phase = readPhase(asState(view.state));
  if (phase === "pre") return "pre";
  if (POST_PHASES.has(phase)) return "post";
  return "live";
}

const SIDE_LABEL: Record<Side, MessageKey> = {
  home: "scorepad.attribution.home",
  away: "scorepad.attribution.away",
};
const SIDES: readonly Side[] = ["home", "away"];

/** The real entrant id, straight off `state.entrants` (present from carrom's
 *  very first fold). Falls back to the literal side name only for a pad
 *  mounted before any state exists — the server refuses that fixture anyway,
 *  rather than this file fabricating a plausible id. Same posture football's
 *  own `entrantOf` takes. */
function entrantOf(state: CarromStateShape, side: Side): string {
  const id = state.entrants?.[side];
  return typeof id === "string" && id.length > 0 ? id : side;
}

function sideOfEntrant(state: CarromStateShape, entrantId: unknown): Side | null {
  for (const side of SIDES) if (entrantOf(state, side) === entrantId) return side;
  return null;
}

/** A guided-sheet choice-step answer ("home"/"away") normalised to `Side` —
 *  anything else (including no answer at all) reads as "home", the same
 *  fail-safe default `generic.tsx`'s own `correctionSheet` takes. */
function sideAnswer(value: string | undefined): Side {
  return value === "away" ? "away" : "home";
}

function sideOptions(): { id: string; label: MessageKey }[] {
  return SIDES.map((side) => ({ id: side, label: SIDE_LABEL[side] }));
}

// ---------------------------------------------------------------------------
// Vocabulary lookup — the same `ENUM_VOCAB` path every other v3 skin uses, so
// one enum value has one label across every sport and both lanes.
// ---------------------------------------------------------------------------

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

/** The starting roster for one side, first-named first (`pairOrder`, falling
 *  back to team-sheet order) — the same reader badminton's own
 *  `onFieldPlayers` uses. `entrantModel: {kinds: ["individual", "pair"]}`
 *  (carrom.ts) means a carrom "side" is a NAMED PLAYER or pair, not a team —
 *  the WHO line below shows THEM, never a bare "Home"/"Away" label, exactly
 *  the boardgame/badminton precedent (a team sport's football/cricket-style
 *  side label would be a name-free scorebug for an individual entrant). */
function playersOf(view: PadHostView, side: Side) {
  return view.squads[side].members
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

/** `WhoLine[]` for one half — the real player name(s) when the lineup names
 *  any, falling back to the plain side label only for a pad mounted with an
 *  empty roster (defensive: `assertScorebugSpec` requires a non-empty
 *  `who`). */
function whoLine(view: PadHostView, side: Side, t: TFn) {
  const players = playersOf(view, side);
  return players.length > 0
    ? players.map((member) => ({ name: nameOf(view, member.personId, t) }))
    : [{ name: t(SIDE_LABEL[side]) }];
}

// ---------------------------------------------------------------------------
// scorebug() — tapModel T: both halves are READOUTS. Carrom scores through
// the Board tiles, so declaring `tappable` here would give one event two
// entry points, exactly the reason football's own header states.
// ---------------------------------------------------------------------------

export function buildScorebug(view: PadHostView, t: TFn): ScorebugSpec {
  const state = asState(view.state);
  const cfg = asCfg(view.cfg);
  const games = state.games ?? [];
  const current = games[games.length - 1];
  const gamesWon = state.gamesWon ?? {};

  // The context band states the FORMAT — the one thing icf vs club-29 (or a
  // house cfg) actually changes, per R7-10. Always non-empty: the band
  // renders unconditionally (scorebug.tsx).
  const context = t("pad.carrom.context.format", {
    bestOf: cfg.bestOf ?? 3,
    gameTo: cfg.gameTo ?? 25,
  });

  // ONE strip item — which game of the series this is. OMITTED before
  // `core.start` opens the first game (`games` is `[]` until then), the same
  // "honest when there is nothing to show" posture football's own clock item
  // takes, rather than a placeholder "Game —".
  const strip: StripItem[] = [];
  if (games.length > 0) {
    strip.push({
      id: "game",
      label: t("pad.carrom.header.game"),
      value: `${games.length}/${cfg.bestOf ?? 3}`,
      tone: "led",
    });
  }

  return {
    context,
    phase: resolvePhase(view),
    halves: [
      {
        who: whoLine(view, "home", t),
        big: String(current?.score?.home ?? 0),
        sub: `(${gamesWon.home ?? 0})`,
      },
      {
        who: whoLine(view, "away", t),
        big: String(current?.score?.away ?? 0),
        sub: `(${gamesWon.away ?? 0})`,
      },
    ],
    strip,
  };
}

// ---------------------------------------------------------------------------
// tiles() — one tile per padSpec ACTION (never per side): `padSpec` already
// gives toss/board/boardQueen/adjustCredit/adjustDeduct exactly one label
// each, and every one of them takes its remaining required fields through
// the sheet it opens rather than through a tile fan-out.
// ---------------------------------------------------------------------------

/**
 * One band per event type — `padSpec(cfg).fidelity` verbatim, pinned against
 * the real module in `__tests__/carrom.test.ts`. Read by `buildTiles` for the
 * reason football's own `EVENT_BAND` doc states: the chassis's
 * `filterTilesByBand` (pad-host.tsx) filters on the bands the org is
 * ENTITLED to, while this gate is the ACTIVE band the org is scoring AT right
 * now — an org entitled to band 1 but currently scoring at band 0 must not be
 * shown a Toss/Adjustment tile that would throw on tap.
 */
export const EVENT_BAND: Readonly<Record<string, FidelityBand>> = {
  "carrom.board.summary": 0,
  "carrom.toss": 1,
  "carrom.game.adjust": 1,
};

function offerable(eventType: string, band: FidelityBand): boolean {
  const declared = EVENT_BAND[eventType];
  return declared === undefined || declared <= band;
}

export function buildTiles(view: PadHostView): TileSpec[] {
  const band = view.band;
  const phase = resolvePhase(view);
  const tiles: TileSpec[] = [];

  // Toss — pre-match only (`applyToss` refuses outside phase "pre"), gated
  // internally on the CURRENT phase (not merely tagged `phases: ["pre"]` for
  // the chassis to filter later — the same posture football's own
  // `offerable` takes), and withheld below band 1: a toss the org cannot
  // afford is simply never reachable, and carrom.ts's own toss schema
  // comment records the honest fallback ("Absent a toss, home breaks
  // first").
  if (phase === "pre" && offerable("carrom.toss", band)) {
    tiles.push({
      id: "toss",
      label: "pad.carrom.action.toss",
      kind: "primary",
      span: 4,
      phases: ["pre"],
      action: { sheet: "toss" },
    });
  }

  if (phase === "live") {
    // Board — two tiles, ONE per padSpec action, side by side (one row of
    // the chassis's 4-column grid). Always offerable: `carrom.board.summary`
    // is band 0.
    tiles.push({
      id: "board",
      label: "pad.carrom.action.board",
      kind: "primary",
      span: 2,
      phases: ["live"],
      action: { sheet: "board" },
    });
    tiles.push({
      id: "boardQueen",
      label: "pad.carrom.action.boardQueen",
      kind: "primary",
      span: 2,
      phases: ["live"],
      action: { sheet: "boardQueen" },
    });

    // Umpire adjustment — the rarer, correction-shaped action (Laws 51/55),
    // so `minor` rather than `primary`/`standard`, echoing football's own
    // `penalty` tile treatment for a similarly infrequent action. Withheld
    // below band 1, same reason the toss tile is.
    if (offerable("carrom.game.adjust", band)) {
      tiles.push({
        id: "adjustCredit",
        label: "pad.carrom.action.adjustCredit",
        kind: "minor",
        span: 2,
        phases: ["live"],
        action: { sheet: "adjustCredit" },
      });
      tiles.push({
        id: "adjustDeduct",
        label: "pad.carrom.action.adjustDeduct",
        kind: "minor",
        span: 2,
        phases: ["live"],
        action: { sheet: "adjustDeduct" },
      });
    }
  }

  return tiles;
}

// ---------------------------------------------------------------------------
// sheets() — a METHOD of the view (G4), rebuilt every render so a closed-over
// entrant id or cfg bound can never go stale. No `t`: every `title` and
// `options[].label` here is an i18n KEY the chassis resolves itself.
// ---------------------------------------------------------------------------

/** Who breaks first — carrom.ts's own toss schema has exactly one field
 *  (`firstBreak`, a side), so this is a single-step sheet rather than a
 *  fan-out of two tiles: `padSpec` gives the toss ONE action, and this is
 *  that action opening its one question. */
function tossSheet(state: CarromStateShape): GuidedSheetSpec {
  return {
    event: "carrom.toss",
    steps: [
      {
        id: "firstBreak",
        kind: "choice",
        title: "pad.carrom.sheet.toss.firstBreak.title",
        options: sideOptions(),
      },
    ],
    buildPayload: (answers) => ({ firstBreak: entrantOf(state, sideAnswer(answers.firstBreak)) }),
  };
}

/** Board (no queen). `winner` and `opponentCoinsLeft` are BOTH required on
 *  `CarromBoardSummary`, so this sheet asks both; `queenTo` is simply never
 *  asked here, which reads exactly like an explicit `null` to the fold
 *  (carrom.ts's own schema comment). `9` is Law 52(b)(ii)'s own fixed bound,
 *  not cfg-derived — the same note carrom.ts's padSpec carries at this
 *  field. */
function boardSheet(state: CarromStateShape): GuidedSheetSpec {
  return {
    event: "carrom.board.summary",
    steps: [
      { id: "winner", kind: "choice", title: "pad.carrom.sheet.board.winner.title", options: sideOptions() },
      { id: "coins", kind: "number", title: "pad.carrom.sheet.board.coins.title", initial: 0, min: 0, max: 9 },
    ],
    buildPayload: (answers) => ({
      winner: entrantOf(state, sideAnswer(answers.winner)),
      opponentCoinsLeft: Number(answers.coins ?? 0),
    }),
  };
}

/** Board (queen covered) — the SAME `carrom.board.summary` type as the sheet
 *  above, the cricket ballAction/extraAction/wicketAction precedent
 *  `carrom.ts`'s own padSpec comment names: one type, two attribution
 *  shapes. `winner` and `queenTo` are independent sides (Law 53(b)/(c): a
 *  board can be WON by one side while the QUEEN was covered by the other, in
 *  which case no queen bonus is credited — the fold decides that, not this
 *  sheet), so both are asked. */
function boardQueenSheet(state: CarromStateShape): GuidedSheetSpec {
  return {
    event: "carrom.board.summary",
    steps: [
      { id: "winner", kind: "choice", title: "pad.carrom.sheet.board.winner.title", options: sideOptions() },
      {
        id: "queenTo",
        kind: "choice",
        title: "pad.carrom.sheet.boardQueen.queenTo.title",
        options: sideOptions(),
      },
      { id: "coins", kind: "number", title: "pad.carrom.sheet.board.coins.title", initial: 0, min: 0, max: 9 },
    ],
    buildPayload: (answers) => ({
      winner: entrantOf(state, sideAnswer(answers.winner)),
      queenTo: entrantOf(state, sideAnswer(answers.queenTo)),
      opponentCoinsLeft: Number(answers.coins ?? 0),
    }),
  };
}

/** Umpire adjustment, credit or deduction (Laws 51/55) — `entrantId`,
 *  `delta` and `reason` are all REQUIRED on `CarromGameAdjust`, so all three
 *  are asked; `person`/`offendingEntrantId` stay optional and reach the
 *  event through the DOCK below instead (`buildDock`), the same "ask only
 *  what's required here, enrich after commit" split football's card sheet
 *  takes for its own optional person field.
 *
 *  `delta`'s bound is split at zero (`min: 1`/`max: cfg.gameTo` for a
 *  credit, the mirror image for a deduction) because `CarromGameAdjust.
 *  delta` is `.refine(d => d !== 0)` — a single field spanning both signs
 *  would let a scorer land on exactly zero and be refused after the fact.
 *  Mirrors `generic.tsx`'s own `correctionSheet`, which splits at zero for
 *  the identical reason. */
function adjustSheet(state: CarromStateShape, cfg: CarromCfgShape, mode: "credit" | "deduct"): GuidedSheetSpec {
  const gameTo = cfg.gameTo ?? 25;
  const bound = mode === "credit" ? { min: 1, max: gameTo } : { min: -gameTo, max: -1 };
  const initial = mode === "credit" ? 1 : -1;
  return {
    event: "carrom.game.adjust",
    steps: [
      { id: "side", kind: "choice", title: "pad.carrom.sheet.adjust.side.title", options: sideOptions() },
      { id: "delta", kind: "number", title: "pad.carrom.sheet.adjust.delta.title", initial, ...bound },
      {
        id: "reason",
        kind: "choice",
        title: "pad.carrom.sheet.adjust.reason.title",
        options: ADJUST_REASONS.map((reason) => ({ id: reason, label: vocabKey("reason", reason) ?? reason })),
      },
    ],
    buildPayload: (answers) => ({
      entrantId: entrantOf(state, sideAnswer(answers.side)),
      delta: Number(answers.delta ?? initial),
      reason: answers.reason,
    }),
  };
}

export function buildSheets(view: PadHostView): Record<string, GuidedSheetSpec> {
  const state = asState(view.state);
  const cfg = asCfg(view.cfg);
  return {
    toss: tossSheet(state),
    board: boardSheet(state),
    boardQueen: boardQueenSheet(state),
    adjustCredit: adjustSheet(state, cfg, "credit"),
    adjustDeduct: adjustSheet(state, cfg, "deduct"),
  };
}

// ---------------------------------------------------------------------------
// dock() — the held tap's own ~12s enrichment window (queue.ts's `HOLD_MS`).
// Both board actions' optional PERSON fields (`breaker`, `queenBy`) and the
// adjustment's optional `person` reach the event here, never as a sheet step
// — the same "required fields on the sheet, optional attribution in the
// dock" split football's goal/card docks take, and gated at band >= 1
// alongside the tiles that reach these event types at all: carrom's own
// fidelity map (above) has no tier above 1, so gating person attribution any
// higher would make it unreachable for a fully-featured carrom org.
// ---------------------------------------------------------------------------

/** A chip that sets ONE payload field, labelled with the person's own name.
 *  `labelText` (not `label`) because a display name is not a dictionary key
 *  — see `DockChip.labelText`, types.ts. Mirrors football's own
 *  `personChip`. */
function personChip(id: string, field: string, personId: string, labelText: string): DockChip {
  return { id, label: "pad.carrom.dock.person", labelText, mutate: (payload) => ({ ...payload, [field]: personId }) };
}

/**
 * The board this tap JUST recorded, entrant-id-resolved.
 *
 * `dock()` renders AFTER the optimistic fold has already applied the tapped
 * event (`SkinDefV3.dock`'s own doc, types.ts: "by dock-render time the
 * optimistic fold has already advanced past the held tap"), so
 * `summary().detail.games[].boards[]` — carrom.ts's own `summary()`, which
 * already resolves each board's `breaker`/`queenTo` from the fold's internal
 * `Side` literal to a real entrant id — already carries the board this tap
 * added, as its very last entry across every game (boards are only ever
 * appended, never removed, and a board that closes its game simply opens the
 * next one alongside it). Reading it here is what lets this file avoid
 * re-deriving carrom.ts's own private `breakerOf` alternation formula a
 * second time — the placer/verifier fork this codebase keeps re-finding.
 */
function lastBoard(view: PadHostView): CarromSummaryBoardShape | undefined {
  const games = asSummary(view.summary).detail?.games ?? [];
  const boards = games.flatMap((game) => game.boards ?? []);
  return boards[boards.length - 1];
}

export function buildDock(
  eventType: string,
  view: PadHostView,
  t: TFn,
  payload?: Record<string, unknown>,
): DockSpec | null {
  const state = asState(view.state);

  if (eventType === "carrom.board.summary") {
    if (view.band < 1) return null;
    const board = lastBoard(view);
    if (board === undefined) return null;

    // ONE QUESTION AT A TIME (the football goal-dock precedent): breaker
    // first, then — only for the queen-covered path, and only once breaker
    // is answered — who covered the queen. `board.queenTo` is `null` for the
    // no-queen sheet (never a plain side), so this branch never fires for it.
    if (payload?.breaker === undefined) {
      const side = sideOfEntrant(state, board.breaker);
      if (side === null) return null;
      const chips = playersOf(view, side).map((member) =>
        personChip(`breaker:${member.personId}`, "breaker", member.personId, nameOf(view, member.personId, t)),
      );
      return { title: t("pad.carrom.dock.breaker.title"), chips };
    }
    if (board.queenTo !== null && board.queenTo !== undefined && payload?.queenBy === undefined) {
      const side = sideOfEntrant(state, board.queenTo);
      if (side === null) return null;
      const chips = playersOf(view, side).map((member) =>
        personChip(`queenBy:${member.personId}`, "queenBy", member.personId, nameOf(view, member.personId, t)),
      );
      return { title: t("pad.carrom.dock.queenBy.title"), chips };
    }
    return null;
  }

  if (eventType === "carrom.game.adjust") {
    if (view.band < 1) return null;
    if (payload?.person !== undefined) return null;
    // Pooled across BOTH squads, not scoped to `entrantId`'s side: Laws
    // 51/55 name "the player whose act caused the adjustment", which is
    // routinely the OPPONENT of the side whose score moved (a credit is
    // usually a penalty against the other side — carrom.ts's own schema
    // comment). `offendingEntrantId` is deliberately not offered here at
    // all: it is additive and optional, and the projection it exists for
    // already falls back to the sign of `delta` when it is absent
    // (carrom.ts's own comment on that field) — asking for it would cost a
    // tap for a fact the read side can already infer correctly by default.
    const chips = [...playersOf(view, "home"), ...playersOf(view, "away")].map((member) =>
      personChip(`person:${member.personId}`, "person", member.personId, nameOf(view, member.personId, t)),
    );
    return { title: t("pad.carrom.dock.adjust.title"), chips };
  }

  // carrom.toss has no optional field at all (`firstBreak` is the schema's
  // only member) — no dock for it, ever.
  return null;
}

// ---------------------------------------------------------------------------
// activityDetail() — the ribbon's VARYING half. The three `pad.carrom.
// ribbon.*` base keys are var-free (`ribbon.ts`'s own convention); every
// fragment below is its own, individually-localised key joined with " · ",
// the same join this chassis already uses for a scorebug's own context
// parts.
// ---------------------------------------------------------------------------

function join(parts: (string | undefined)[]): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return kept.length > 0 ? kept.join(" · ") : undefined;
}

export function carromDetail(ctx: ActivityDetailContext): string | undefined {
  const { t, eventType, payload, personNames } = ctx;
  const state = asState(ctx.state);
  const named = (id: unknown): string | undefined =>
    typeof id === "string" && id.length > 0 ? (personNames?.[id] ?? t("eventCopy.unknownPerson")) : undefined;
  const sideName = (entrantId: unknown): string | undefined => {
    const side = sideOfEntrant(state, entrantId);
    return side === null ? undefined : t(SIDE_LABEL[side]);
  };

  switch (eventType) {
    case "carrom.toss":
      return join([sideName(payload.firstBreak)]);

    case "carrom.board.summary": {
      const coins = typeof payload.opponentCoinsLeft === "number" ? payload.opponentCoinsLeft : undefined;
      // R7-28 (found the hard way on a different sport's ribbon: "1 pts" on
      // the commonest row the pad writes): the COUNT selects the plural
      // form, via `ctx.plural` when a real one is threaded through, falling
      // back to `.other` — correct for every count but one — for a harness
      // that builds this context without one.
      const coinsText =
        coins === undefined
          ? undefined
          : (ctx.plural?.("pad.carrom.ribbon.board.coins", coins, { points: coins }) ??
            t("pad.carrom.ribbon.board.coins.other", { points: coins }));
      const breakerName = named(payload.breaker);
      return join([
        sideName(payload.winner),
        coinsText,
        typeof payload.queenTo === "string"
          ? t("pad.carrom.ribbon.board.queen", { side: sideName(payload.queenTo) ?? "" })
          : undefined,
        breakerName === undefined ? undefined : t("pad.carrom.ribbon.board.breaker", { name: breakerName }),
      ]);
    }

    case "carrom.game.adjust": {
      const delta = typeof payload.delta === "number" ? payload.delta : undefined;
      const deltaText =
        delta === undefined
          ? undefined
          : (ctx.plural?.("pad.carrom.ribbon.adjust.points", Math.abs(delta), { delta }) ??
            t("pad.carrom.ribbon.adjust.points.other", { delta }));
      return join([sideName(payload.entrantId), deltaText, vocabText("reason", payload.reason, t), named(payload.person)]);
    }

    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// The factory.
// ---------------------------------------------------------------------------

export function carromSkinV3(t: TFn): SkinDefV3<PadHostView> {
  return {
    key: "carrom",
    tapModel: "T",
    phase: resolvePhase,
    scorebug: (view) => buildScorebug(view, t),
    tiles: buildTiles,
    dock: (eventType, view, payload) => buildDock(eventType, view, t, payload),
    sheets: buildSheets,
    // Declared HERE, not merely exported: a detail builder that exists but is
    // never wired ships INERT — its unit tests pass while every activity row
    // still reads the generic base sentence.
    activityDetail: carromDetail,
    // No `context`/`contextSelect`/`swap`/`clock`/`refusedEventTypes` — see
    // this file's header.
  };
}
