// Board-game SportModule — spec 04 §6 + engine/sports/chess.md (PROMPT-07).
// Chess, draughts, go, carrom and every generic 1-v-1 win/draw/loss sport. The
// match itself is trivial (one terminal `result` event); the module exists to
// carry the metrics and pairing metadata the Swiss competition engine needs.
//
// Half-point integers, never floats: 1 / ½ / 0 are stored as 2 / 1 / 0
// throughout (points, byeScore, the Swiss ledger) and divided by two only for
// display — spec 04 §6.1, chess.md §2. This keeps the ledger exact (spec 04
// §9.4) and Buchholz/Sonneborn-Berger integer arithmetic (competition/
// tiebreakers.ts).
import { z } from "zod";
import { EngineError } from "../../core/errors.ts";
import { forfeitOf, isStrictFold, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import type { Rng } from "../../core/rng.ts";
import {
  DRAW_KINDS,
  EntrantId,
  type LineupPair,
  type MatchOutcome,
  type ScoreSummary,
  type StageKind,
  type StandingsDelta,
} from "../../core/types.ts";
import type { PositionCatalog } from "../../sport/catalog.ts";
import { boundsFrom, stampAttributionRequired } from "../../sport/module.ts";
import type {
  ModuleEvent,
  PadAction,
  PadGate,
  PadPanel,
  PadSpec,
  SportModule,
  TiebreakerKey,
} from "../../sport/module.ts";
import { personsForEntrant, type PlayerStatRow, type PlayerStatsFoldCtx } from "../../stats/stats.ts";

// ---------------------------------------------------------------------------
// Cfg — spec 04 §6.1
// ---------------------------------------------------------------------------

// Points are HALF-POINTS (×2): a win is 2 (= 1.0), a draw 1 (= 0.5), a loss 0.
export const BoardgameScoring = z.object({
  win: z.number().int().nonnegative().default(2),
  draw: z.number().int().nonnegative().default(1),
  loss: z.number().int().nonnegative().default(0),
});

export const BoardgameCfg = z.object({
  scoring: BoardgameScoring.default({ win: 2, draw: 1, loss: 0 }),
  colors: z.boolean().default(true), // home = White (chess.md §2)
  // Half-points a bye is worth (FIDE full-point bye = 2, half-point bye = 1).
  // Byes are a competition-level concept; this value is read by the Swiss
  // engine, not folded here.
  byeScore: z.number().int().nonnegative().default(2),
  // Clock family — metadata only, no scoring effect (chess.md §2).
  variant: z.enum(["classical", "rapid", "blitz"]).default("classical"),
  // Time control. Still metadata only: the board game has no clock in the fold,
  // the engine never reads a clock inside a fold, and none of these fields
  // changes any fold behaviour. What they record is WHICH control was in force,
  // so a pad can drive the right countdown (W4a §5.5).
  //
  // `increment` and `delay` are two DIFFERENT clocks, and they are independent
  // knobs — a control may carry both, either, or neither:
  //
  //   increment  Fischer. When the move is completed, `increment` is ADDED to
  //              that player's clock. Time not used on the move is BANKED and
  //              accumulates over the game. ("90+30")
  //   delay      Bronstein / simple (US) delay. The clock is WITHHELD for
  //              `delay` at the start of the move and only starts running once
  //              it elapses. Unused delay is NOT banked — it does not carry to
  //              the next move, so the base time can only ever go down. ("G/5 d3")
  //   neither    Sudden death: `base` for the whole game.
  //
  // `increment` and `delay` are in the same unit as `base`. Both optional with
  // NO default — cfg is serialised into the frozen golden state strings (§8).
  // `increment` was widened to optional to record INTENT: an absent increment
  // is behaviourally identical to `increment: 0` (adding zero after each move
  // IS sudden death), so this buys nothing a pad can act on — it only lets a
  // sudden-death or delay-only control say so, instead of writing a zero that
  // reads as a deliberate Fischer setting.
  // W2a BG-KO-1 — set by bracketDeciders in a bracket stage. OPTIONAL with NO
  // default (finding 12): cfg is serialised into every frozen golden state.
  // Absent reads as false (spec §5.2 "default false").
  tiebreak: z.boolean().optional(),
  clock: z
    .object({
      base: z.number().int().nonnegative(),
      increment: z.number().int().nonnegative().optional(),
      delay: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type BoardgameCfg = z.infer<typeof BoardgameCfg>;

// ---------------------------------------------------------------------------
// Ev — spec 04 §6.2 (a single terminal event; undo = void it)
// ---------------------------------------------------------------------------

const PersonId = z.string().min(1);

// W4 domain audit — the FIDE result vocabulary a scoresheet/arbiter report
// distinguishes. The first nine are PROMPT-07's; the tail is additive (FIDE
// Laws of Chess 2023 Art. 5.2, 7.5.5, 9.2/9.3/9.6):
//   repetition    — threefold/fivefold repetition (Art. 9.2 / 9.6.1)
//   fifty_move    — the 50-move claim / 75-move automatic draw (9.3 / 9.6.2)
//   dead_position — no legal sequence of moves can mate (5.2.2); wider than
//                   `insufficient`, which is the flag-fall material rule (6.9)
//   illegal_move  — the loss an arbiter awards for a repeated illegal move
//                   (7.5.5; immediate in blitz, Appendix B.3.2)
export const BoardgameMethod = z.enum([
  "checkmate",
  "resign",
  "time",
  "agreement",
  "stalemate",
  "insufficient",
  "forfeit",
  "adjudication",
  "double_forfeit",
  "repetition",
  "fifty_move",
  "dead_position",
  "illegal_move",
]);
export type BoardgameMethod = z.infer<typeof BoardgameMethod>;

// winner: entrantId to decide; null = draw (or, with method double_forfeit, a
// no-result double default — chess.md §7). S6/#416 (W5): ALSO tolerates
// omission, treated identically to explicit `null` at the one call site below
// — the padSpec field/attribution DSL (`sport/module.ts`) has no primitive
// that can emit a literal `null` (an attribution item always resolves to a
// real entrant id; there is no "constant" PadField kind), so a
// required-but-nullable `winner` made a draw/no-result padSpec action
// unbuildable. Purely additive: every payload that was valid before (an
// explicit string or explicit `null`) still means exactly what it meant; only
// the previously-impossible "winner key absent" shape newly parses. The
// `.refine()` below is copied from `BoardgamePairing`'s own (a payload with
// every field absent must still fail) so `{}` stays disambiguated from a
// pairing card and the union's structural-lookahead comment stays true.
export const BoardgameResult = z
  .strictObject({
    winner: EntrantId.nullable().optional(),
    method: BoardgameMethod.optional(),
    // W4: move number the scoresheet finished on (Art. 8.1 — each player records
    // every move). The game length, not the moves themselves; per-ply recording
    // is deliberately out of scope (see DOMAIN.md).
    //
    // R7-40 (owner ruling, 2026-09-01): NO LONGER COLLECTABLE. The v3 pad is
    // tapModel S — a tap commits the result and the dock enriches it with
    // Method only (ruling R7-2), and a dock chip cannot carry a free number.
    // The two `padSpec` field declarations that used to ask for it are gone.
    // It affects no result, standing or computation, so the capability was
    // dropped rather than given a surface of its own.
    //
    // THE SCHEMA FIELD STAYS, deliberately and not by oversight: this is a
    // `strictObject`, and every `boardgame.result` already recorded with a
    // `moves` value must keep validating and replaying. Removing it would
    // reject historical streams — including the frozen golden corpus. So the
    // field is accepted on the way IN and never asked for by the pad; it is
    // not an inert declaration, it is backward compatibility.
    moves: z.number().int().nonnegative().optional(),
    // W4: the player who won the board. In an individual event the entrant IS
    // the player; in a team match (board order, chess.md §5) the entrant is the
    // club and the person is what a stat model needs. Always optional.
    winnerPerson: PersonId.optional(),
  })
  .refine((result) => Object.values(result).some((value) => value !== undefined), {
    message: "a result must record at least one fact",
  });
export type BoardgameResult = z.infer<typeof BoardgameResult>;

// W4: the arbiter's pairing card — the facts a scoresheet header carries and
// the module could not previously hold. `white` is the entrant with White
// (Swiss alternates colours, so home is NOT always White); homePerson /
// awayPerson name who actually sat down; board is the board number in a team
// match. Every field optional, at least one required.
export const BoardgamePairing = z
  .strictObject({
    white: EntrantId.optional(),
    homePerson: PersonId.optional(),
    awayPerson: PersonId.optional(),
    board: z.number().int().positive().optional(),
  })
  .refine((card) => Object.values(card).some((value) => value !== undefined), {
    message: "a pairing card must record at least one fact",
  });
export type BoardgamePairing = z.infer<typeof BoardgamePairing>;

// W2a BG-KO-1/BG-KO-2 (ruling 73). Lots is NOT a rung: drawing lots is the
// organiser's core.settle {method: "lot"}.
export const TIEBREAK_RUNGS = ["rapid", "blitz", "armageddon"] as const;
export type TiebreakRung = (typeof TIEBREAK_RUNGS)[number];
// A chess match score: whole points with an optional half either side of an en dash ("1½–½", "2–0").
export const CHESS_SCORE = /^(\d+½?|½)–(\d+½?|½)$/;
export const BOARDGAME_TIEBREAK_TYPE = "boardgame.tiebreak";
export const BoardgameTiebreak = z.strictObject({
  rung: z.enum(TIEBREAK_RUNGS),
  // The entrant who advances — the same schema core.settle names its winner with
  // (review Minor 4); it was typed PersonId, a different brand of the same string.
  winner: EntrantId,
  score: z.string().regex(CHESS_SCORE).optional(),
});
export type BoardgameTiebreak = z.infer<typeof BoardgameTiebreak>;

// Branches are told apart structurally (spec 03 §2): a result always carries
// `winner`, which the strict pairing branch rejects, and vice versa.
// W2a: the tie-break is told apart by `rung`, which both other branches reject.
export const BoardgameEv = z.union([BoardgameResult, BoardgamePairing, BoardgameTiebreak]);
export type BoardgameEv = z.infer<typeof BoardgameEv>;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Side = "home" | "away";
type Color = "W" | "B";

export interface BoardgameState {
  cfg: BoardgameCfg;
  entrants: { home: string; away: string };
  phase: "pre" | "live" | "tiebreak" | "done" | "final" | "abandoned";
  colorOfHome: Color | null; // null = colours disabled (go/generic)
  method: BoardgameMethod | null;
  // Forfeits score like a win but are excluded from colour history (chess.md §7).
  forfeited: boolean;
  outcome: MatchOutcome | null;
  replayFlagged: boolean;
  // W4 pairing-card facts — absent until a boardgame.pairing event records
  // them, so a stream that never pairs folds to exactly the state it always
  // did (the golden corpus is byte-identical).
  players?: { home?: string; away?: string };
  board?: number;
  // W4 result facts — absent unless the result event carried them.
  moves?: number;
  winnerPerson?: string;
  // W2a — present from the moment a bracket game is drawn (phase "tiebreak");
  // `rung`/`score` land when the tie-break is recorded.
  // Absent on every stream that never reached a tie-break (golden-safe).
  tiebreak?: { rung?: TiebreakRung; score?: string };
}

function opponent(side: Side): Side {
  return side === "home" ? "away" : "home";
}

function invalid(message: string, data?: unknown): never {
  throw new EngineError("INVALID_EVENT", message, data);
}

function wrongPhase(message: string, data?: unknown): never {
  throw new EngineError("WRONG_PHASE", message, data);
}

function sideOf(state: BoardgameState, entrantId: string): Side {
  if (entrantId === state.entrants.home) return "home";
  if (entrantId === state.entrants.away) return "away";
  invalid(`unknown entrant "${entrantId}"`, { entrantId });
}

function parsePayload<T>(schema: z.ZodType<T>, payload: unknown, type: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) invalid(`invalid ${type} payload`, { issues: parsed.error.issues });
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Result application
// ---------------------------------------------------------------------------

function decideResult(
  state: BoardgameState,
  winner: string | null,
  method: BoardgameMethod | undefined,
  extra: { moves?: number; winnerPerson?: string } = {},
): BoardgameState {
  if (state.phase !== "live") wrongPhase(`result not allowed in phase "${state.phase}"`);
  // A person can only be credited with a decisive board — a draw credits both
  // players a half point, which is a stats-model join, not a result field.
  if (extra.winnerPerson !== undefined && winner === null) {
    invalid("winnerPerson requires a decisive winner", { winnerPerson: extra.winnerPerson });
  }
  const forfeited = method === "forfeit" || method === "double_forfeit";
  const base = {
    ...state,
    phase: "done" as const,
    method: method ?? null,
    forfeited,
    ...(extra.moves === undefined ? {} : { moves: extra.moves }),
    ...(extra.winnerPerson === undefined ? {} : { winnerPerson: extra.winnerPerson }),
  };
  if (winner === null) {
    // Double forfeit ⇒ no result (both default); otherwise an ordinary draw —
    // unless this is a bracket game (BG-KO-1), which goes to the tie-break.
    // The double forfeit is checked FIRST: it is not a drawn game, so it never
    // opens a tie-break (controller ruling T15-R1; held needs_decision, X-BR-2).
    if (method === "double_forfeit") return { ...base, outcome: { kind: "no_result" } };
    if (state.cfg.tiebreak === true) return { ...base, phase: "tiebreak", outcome: null, tiebreak: {} };
    return { ...base, outcome: { kind: "draw" } };
  }
  const winnerSide = sideOf(state, winner);
  return {
    ...base,
    outcome: {
      kind: "win",
      winner: state.entrants[winnerSide],
      loser: state.entrants[opponent(winnerSide)],
      method: method ?? "regulation",
    },
  };
}

// W4 — the arbiter's pairing card. Recordable before or during the game (an
// arbiter corrects a mis-set board); refused once the game is over.
function applyPairing(
  state: BoardgameState,
  card: BoardgamePairing,
  strict: boolean,
): BoardgameState {
  if (state.phase !== "pre" && state.phase !== "live") {
    wrongPhase(`pairing not allowed in phase "${state.phase}"`);
  }
  let colorOfHome = state.colorOfHome;
  if (card.white !== undefined) {
    // STRICT ONLY (§3.3 seam). `colors` is a cfg switch an arbiter turns off
    // for a casual division, and doing so would otherwise refuse every pairing
    // card already recorded with a colour — no event to void, and the whole
    // division's history goes dark. The colour is a recorded fact; the switch
    // says only whether the pad offers the field today.
    if (strict && state.cfg.colors === false) {
      invalid("this division plays without colours", { white: card.white });
    }
    colorOfHome = sideOf(state, card.white) === "home" ? "W" : "B";
  }
  const players = {
    ...state.players,
    ...(card.homePerson === undefined ? {} : { home: card.homePerson }),
    ...(card.awayPerson === undefined ? {} : { away: card.awayPerson }),
  };
  return {
    ...state,
    colorOfHome,
    ...(Object.keys(players).length === 0 ? {} : { players }),
    ...(card.board === undefined ? {} : { board: card.board }),
  };
}

function tiebreakRefused(message: string, data?: unknown): never {
  throw new EngineError("TIEBREAK_NOT_APPLICABLE", message, data);
}

// W2a BG-KO-1. Only in phase "tiebreak". The scorer records the winner on every
// rung; BG-KO-2 (a drawn armageddon goes to Black) is the pad's hint in W2a, and
// armageddon colours are W2c's (ruling 82).
function applyTiebreak(state: BoardgameState, p: BoardgameTiebreak): BoardgameState {
  if (state.phase !== "tiebreak") tiebreakRefused(`tie-break not allowed in phase "${state.phase}"`);
  const winnerSide = sideOf(state, p.winner);
  return {
    ...state,
    phase: "done",
    tiebreak: {
      rung: p.rung,
      ...(p.score === undefined ? {} : { score: p.score }),
    },
    outcome: { kind: "win", winner: state.entrants[winnerSide], loser: state.entrants[opponent(winnerSide)], method: `tiebreak_${p.rung}` },
  };
}

// ---------------------------------------------------------------------------
// Colour / ledger helpers — the Swiss inputs (spec 04 §6.3, chess.md §3–4)
// ---------------------------------------------------------------------------

function colorOf(state: BoardgameState, side: Side): Color | null {
  if (state.colorOfHome === null || state.forfeited) return null; // excluded
  return side === "home" ? state.colorOfHome : state.colorOfHome === "W" ? "B" : "W";
}

// Per-side ledger row: `wins` for the cascade tail, `white`/`black` = the colour
// this entrant held (both 0 when colours are off or the game was forfeited — a
// forfeit is excluded from colour history). Integers only (spec 04 §9.4).
function sideMetrics(state: BoardgameState, side: Side, won: boolean): Record<string, number> {
  const color = colorOf(state, side);
  return {
    wins: won ? 1 : 0,
    white: color === "W" ? 1 : 0,
    black: color === "B" ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// Positions — spec 04 §6 / chess.md §5 (team chess uses board order later)
// ---------------------------------------------------------------------------

const positions: PositionCatalog = {
  groups: [], // 1-v-1: no positions
  lineup: { size: 1, benchMax: 0 },
};

// ---------------------------------------------------------------------------
// Tiebreakers — spec 04 §6.3 / chess.md §4 (score = the standings points key).
// ---------------------------------------------------------------------------

export const BOARDGAME_TIEBREAKERS: TiebreakerKey[] = [
  "points",
  "buchholz_cut1",
  "buchholz",
  "sberger",
  "direct",
  "wins",
  "lots",
];

// ---------------------------------------------------------------------------
// Display — half-points → points string (2 → "1", 1 → "½", 3 → "1½").
// ---------------------------------------------------------------------------

function pointsText(halfPoints: number): string {
  const whole = Math.floor(halfPoints / 2);
  const half = halfPoints % 2 === 1 ? "½" : "";
  if (whole === 0) return half === "" ? "0" : "½";
  return `${whole}${half}`;
}

// ---------------------------------------------------------------------------
// S6/#416 (W5) — padSpec. Pure function of resolved cfg. Board games have the
// smallest event surface in the engine — one terminal result, one pairing
// card — so this stays proportionally small; chess.md §6 already made the
// same call for the fidelity band ("no coarse/fine split").
// ---------------------------------------------------------------------------

export const BOARDGAME_EVENT_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  "boardgame.result": BoardgameResult,
  "boardgame.pairing": BoardgamePairing,
  [BOARDGAME_TIEBREAK_TYPE]: BoardgameTiebreak,
};

// Sentinels for fields with no cfg knob to derive a bound from (spec 04 §6
// has no move-count or board-count cap) — generous, not a rules number, only
// a property-testing upper bound. Mirrors cricket's UNBOUNDED_BALLS_SENTINEL.
const BOARD_MAX = 200; // team-match board-number sentinel

// Every decisive method needs a winner; every drawn/no-result method needs
// none — `decideResult` refuses `winnerPerson` whenever winner is null, so
// the two actions below never share a field. "adjudication" appears in BOTH:
// an arbiter's discretionary ruling (FIDE Art. 5.2) can go either way.
const DECISIVE_METHODS = ["checkmate", "resign", "time", "forfeit", "adjudication", "illegal_move"] as const;
const DRAWN_METHODS = [
  "agreement", "stalemate", "insufficient", "adjudication",
  "repetition", "fifty_move", "dead_position", "double_forfeit",
] as const;

export function padSpec(cfg: BoardgameCfg): PadSpec {
  // --- Pre-match: the arbiter's pairing card -------------------------------
  const pairingAction: PadAction = {
    type: "boardgame.pairing",
    labelKey: { key: "pad.boardgame.action.pairing", label: "Pairing card" },
    fields: [{ kind: "number", path: "board", min: 1, max: BOARD_MAX }],
    // cfg-only inclusion, no gate needed (cricket's declare/followOn
    // precedent): offering a `white` picker when the division plays without
    // colours would build a payload `applyPairing` refuses on every cfg it
    // would ever render for (the STRICT-ONLY §3.3 seam above).
    attribution: cfg.colors
      ? [
          { kind: "side", path: "white" },
          { kind: "person", path: "homePerson" },
          { kind: "person", path: "awayPerson" },
        ]
      : [
          { kind: "person", path: "homePerson" },
          { kind: "person", path: "awayPerson" },
        ],
  };

  // --- Live: the terminal result, decisive vs drawn/no-result -------------
  // Two actions, ONE type ("boardgame.result") — the cricket ballAction/
  // extraAction/wicketAction precedent. `winner` cannot be a third "no side"
  // attribution choice (a `side` item always resolves to a real entrant); see
  // `BoardgameResult`'s own comment for why draws are representable at all.
  const decisiveResultAction: PadAction = {
    type: "boardgame.result",
    labelKey: { key: "pad.boardgame.action.result", label: "Result" },
    fields: [
      { kind: "enum", path: "method", values: DECISIVE_METHODS },
    ],
    attribution: [
      { kind: "side", path: "winner" },
      { kind: "person", path: "winnerPerson" },
    ],
  };
  const drawnResultAction: PadAction = {
    type: "boardgame.result",
    labelKey: { key: "pad.boardgame.action.draw", label: "Draw / no result" },
    fields: [
      { kind: "enum", path: "method", values: DRAWN_METHODS },
    ],
    attribution: [], // `winner` omitted — decideResult treats that like null.
  };

  // Deliberately NO action for core.abandon / core.finalize / core.forfeit
  // here. `PadAction.type` is documented as "a key in SportModule.eventSchemas"
  // and `checkActionCoverage` enforces that literally (an action naming a type
  // outside the module's own registry is flagged, not silently ignored) —
  // confirmed empirically this session, and matching cricket's OWN spec,
  // which declares zero `core.*` actions. Match lifecycle (start / forfeit /
  // abandon / finalize) is IDENTICAL shape across all eleven sports, so it
  // reads as universal renderer chrome (S10), not per-module declarative
  // data — the one boardgame-specific exception is a single forfeit, which
  // already has a native path: `boardgame.result` with `method: "forfeit"`
  // (decisive action above) or `"double_forfeit"` (drawn action above).

  // W2a BG-KO-1 — the tie-break, offered only in a bracket cfg and only in
  // phase "tiebreak"; the result panels are then gated to phase "live", so a
  // drawn bracket game swaps them for the tie-break. Without `tiebreak` in cfg
  // no panel carries a gate (the spec is unchanged).
  const tiebreakAction: PadAction = {
    type: BOARDGAME_TIEBREAK_TYPE,
    labelKey: { key: "pad.boardgame.action.tiebreak", label: "Tie-break" },
    fields: [{ kind: "enum", path: "rung", values: TIEBREAK_RUNGS }],
    attribution: [{ kind: "side", path: "winner" }],
  };
  const inPhase = (value: string): PadGate => ({ op: "path-equals", path: "state.phase", value });
  const tb = cfg.tiebreak === true;

  const panels: PadPanel[] = [
    {
      labelKey: { key: "pad.boardgame.panel.pre", label: "Pre-match" },
      phase: "pre",
      layout: "primary",
      actions: [pairingAction],
    },
    {
      labelKey: { key: "pad.boardgame.panel.result", label: "Result" },
      phase: "live",
      layout: "primary",
      actions: [decisiveResultAction],
      ...(tb ? { gate: inPhase("live") } : {}),
    },
    {
      labelKey: { key: "pad.boardgame.panel.draw", label: "Draw / no result" },
      phase: "live",
      layout: "grid",
      actions: [drawnResultAction],
      ...(tb ? { gate: inPhase("live") } : {}),
    },
    ...(tb
      ? [{
          labelKey: { key: "pad.boardgame.panel.tiebreak", label: "Tie-break" },
          phase: "live" as const,
          layout: "primary" as const,
          actions: [tiebreakAction],
          gate: inPhase("tiebreak"),
        }]
      : []),
  ];

  // R8/WS-B — `required` stamped ONCE, here, from BOARDGAME_EVENT_SCHEMAS
  // itself (never hand-typed per action; see module.ts's own doc comment).
  return stampAttributionRequired(
    {
      panels,
      // Band 0 is the result alone, band 1 adds the pairing card. Board
      // games declare nothing above band 1 today.
      fidelity: {
        "boardgame.result": 0,
        "boardgame.pairing": 1,
        [BOARDGAME_TIEBREAK_TYPE]: 0, // W2a: the result family's band
      },
    },
    BOARDGAME_EVENT_SCHEMAS,
  );
}

// ---------------------------------------------------------------------------
// S8/#417 — playerStats.folded: draws / losses / white / black, resolved from
// the entrant roster (`PlayerStatsFoldCtx`) when a payload names no person.
// "wins" and "games" stay plain `playerStats.metrics` entries (below) — only
// "wins" gained `fromEntrant`/`entrantField`, so an explicit `winnerPerson`
// still outranks the roster exactly like `resolveMetricPersons` mandates.
//
// This fold deliberately never writes an explicit 0 for the side a fact does
// NOT apply to (unlike some sibling sports' folded stats): "wins" lives on
// the plain metric so its explicit `winnerPerson` can keep outranking the
// roster fallback per S8/#417's resolution order. If this fold ALSO wrote
// `losses:0`/`draws:0` for the WINNER's entrant, a `winnerPerson` naming
// someone other than that entrant's own roster person would still leave the
// roster person with a stray row — exactly the case the acceptance suite
// pins ("the entrant's own roster person gets no row at all"). Only ever
// crediting the side a fact concretely applies to avoids that.
function foldBoardgameStats(
  events: readonly EventEnvelope[],
  ctx: PlayerStatsFoldCtx,
): PlayerStatRow[] {
  const rows = new Map<string, Record<string, number>>();
  const bump = (personId: string, key: string): void => {
    const stats = rows.get(personId) ?? {};
    stats[key] = (stats[key] ?? 0) + 1;
    rows.set(personId, stats);
  };
  // Credits every person the roster names for this entrant — UNLESS the
  // entrant is "team"-kind (S8/#417's mandatory kind guard, applied via the
  // shared `personsForEntrant` helper, W6 fix 5, rather than a local
  // re-derivation): a team credits nobody even when `personsOf` hands back a
  // full roster. Takes the whole entrant (not just an id) so callers can
  // iterate `ctx.entrants` directly without pre-filtering, and a mixed
  // team/individual fixture still credits its individual side correctly.
  const creditEach = (entrant: PlayerStatsFoldCtx["entrants"][number], key: string): void => {
    for (const personId of personsForEntrant(ctx, entrant.id)) bump(personId, key);
  };

  for (const event of events) {
    if (event.type === "boardgame.pairing") {
      const parsed = BoardgamePairing.safeParse(event.payload);
      if (!parsed.success || parsed.data.white === undefined) continue;
      const whiteId = parsed.data.white;
      for (const entrant of ctx.entrants) {
        creditEach(entrant, entrant.id === whiteId ? "white" : "black");
      }
      continue;
    }
    if (event.type !== "boardgame.result") continue;
    const parsed = BoardgameResult.safeParse(event.payload);
    if (!parsed.success) continue;
    const { winner, method } = parsed.data;
    if (winner === undefined || winner === null) {
      // Double forfeit is a no_result (chess.md §7) — nobody's game, draw or
      // loss; "games" (the plain pairing-card metric) is unaffected either
      // way, since attendance is recorded independently of how the game
      // ended. Any OTHER null-winner method is an ordinary draw: every
      // entrant's roster earns it.
      //
      // Ruling D-C6 (FIDE practice): that holds in a bracket too. A tie-break
      // or a settle decides who ADVANCES, not the game, so the classical game
      // stays a draw here — deliberately read from the result event, never
      // from the effective outcome (`outcomeOf`), unlike carrom's and
      // generic's stat folds (D-C3).
      if (method === "double_forfeit") continue;
      for (const entrant of ctx.entrants) creditEach(entrant, "draws");
      continue;
    }
    // Decisive: the winner's persons already earn "wins" through the plain
    // metric below (same `winner` field, entrant fallback) — this only owes
    // the OTHER side(s) their "losses".
    for (const entrant of ctx.entrants) {
      if (entrant.id !== winner) creditEach(entrant, "losses");
    }
  }

  return [...rows.entries()].map(([personId, stats]) => ({ personId, stats }));
}

// W2a — the generator's tie-break draws: one uniform pick per choice (`rng` is
// uniform in [0, 1), so the index is always in range). `null` = no score.
const SIDES = ["home", "away"] as const;
const TIEBREAK_SCORES = [null, "1½–½", "2–0"] as const;
function pickFrom<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export const boardgame: SportModule<BoardgameCfg, BoardgameEv, BoardgameState> = {
  key: "boardgame",
  version: "1.0.0",
  configSchema: BoardgameCfg,
  eventSchema: BoardgameEv,
  eventSchemas: BOARDGAME_EVENT_SCHEMAS,
  padSpec,
  positions,
  entrantModel: { kinds: ["individual"], defaultKind: "individual" },
  variants: {
    // Clock family only — the scoring is identical (chess.md §2).
    classical: { variant: "classical" },
    rapid: { variant: "rapid" },
    blitz: { variant: "blitz" },
  },

  init(cfg, lineups: LineupPair): BoardgameState {
    return {
      cfg,
      entrants: { home: lineups.home.entrantId, away: lineups.away.entrantId },
      phase: "pre",
      colorOfHome: cfg.colors ? "W" : null,
      method: null,
      forfeited: false,
      outcome: null,
      replayFlagged: false,
    };
  },

  apply(state, ev: EventEnvelope<BoardgameEv | CoreEv>, ctx): BoardgameState {
    switch (ev.type) {
      case "core.start":
        if (state.phase !== "pre") wrongPhase("already started");
        return { ...state, phase: "live" };
      case "boardgame.result": {
        const payload = parsePayload(BoardgameResult, ev.payload, ev.type);
        // `winner` omitted reads exactly like explicit `null` (see the
        // schema's own comment) — coerced once, here, so `decideResult`
        // keeps its existing `string | null` signature unchanged.
        return decideResult(state, payload.winner ?? null, payload.method, {
          ...(payload.moves === undefined ? {} : { moves: payload.moves }),
          ...(payload.winnerPerson === undefined ? {} : { winnerPerson: payload.winnerPerson }),
        });
      }
      case "boardgame.pairing":
        return applyPairing(state, parsePayload(BoardgamePairing, ev.payload, ev.type), isStrictFold(ctx));
      case BOARDGAME_TIEBREAK_TYPE:
        return applyTiebreak(state, parsePayload(BoardgameTiebreak, ev.payload, ev.type));
      case "core.forfeit": {
        if (state.phase !== "live") wrongPhase(`forfeit not allowed in phase "${state.phase}"`);
        // The REASON is deliberately not carried onto the outcome here, and
        // boardgame is the only module that does not carry it. Its
        // `outcome.method` is already a MEANINGFUL typed value — the
        // `BoardgameMethod` enum, "forfeit" — where the other ten leave the
        // field empty, so filling it from `core.forfeit`'s free-text reason
        // would overwrite a classification with prose and cost more than it
        // buys. Boardgame states a walkover through its own `boardgame.result`
        // method enum instead (padSpec offers it; see the "single forfeit
        // rides boardgame.result's own method enum" test). Recording the
        // finer-grained reason for boardgame too is a separate, smaller gap.
        const { by } = forfeitOf(ev.payload);
        return decideResult(state, state.entrants[opponent(sideOf(state, by))], "forfeit");
      }
      case "core.abandon":
        if (state.phase === "done" || state.phase === "final" || state.phase === "abandoned") {
          wrongPhase("match already over");
        }
        // Rare for a board game; leave undecided and flag for regeneration.
        return { ...state, phase: "abandoned", replayFlagged: true };
      case "core.finalize":
        if (state.outcome === null) wrongPhase("cannot finalize an undecided fixture");
        return { ...state, phase: "final" };
      case "core.note":
      case "core.award":
        return state; // PGN/move upload rides here (chess.md §6) — no state effect
      default:
        invalid(`unknown event type "${ev.type}"`);
    }
  },

  outcome: (state) => state.outcome,

  // §9.5 — defined at every prefix; displays points, not half-points.
  summary(state): ScoreSummary {
    const { win, draw, loss } = state.cfg.scoring;
    let home = 0;
    let away = 0;
    const outcome = state.outcome;
    // W2a: a game that went to the tie-break is level on the board; the
    // tie-break decides who advances and never rewrites the score.
    const level = state.tiebreak !== undefined;
    if (level) {
      home = draw;
      away = draw;
    } else if (outcome?.kind === "win") {
      const winnerHome = outcome.winner === state.entrants.home;
      home = winnerHome ? win : loss;
      away = winnerHome ? loss : win;
    } else if (outcome?.kind === "draw") {
      home = draw;
      away = draw;
    }
    const decided = outcome !== null || level;
    return {
      headline: decided ? `${pointsText(home)} — ${pointsText(away)}` : "vs",
      perSide: [
        { entrantId: state.entrants.home, line: decided ? pointsText(home) : "" },
        { entrantId: state.entrants.away, line: decided ? pointsText(away) : "" },
      ],
      detail: {
        ...(state.method === null ? {} : { method: state.method }),
        ...(state.colorOfHome === null ? {} : { colorOfHome: state.colorOfHome }),
        ...(state.replayFlagged ? { abandoned: true } : {}),
        // W4 pairing/result facts — only when recorded, so a stream that never
        // used them summarises exactly as it always did.
        ...(state.players === undefined ? {} : { players: state.players }),
        ...(state.board === undefined ? {} : { board: state.board }),
        ...(state.moves === undefined ? {} : { moves: state.moves }),
        ...(state.winnerPerson === undefined ? {} : { winnerPerson: state.winnerPerson }),
        ...(state.tiebreak === undefined ? {} : { tiebreak: state.tiebreak }),
      },
    };
  },

  standingsDelta(outcome, cfg, _ctx, state): [StandingsDelta, StandingsDelta] {
    const build = (
      side: Side,
      w: number,
      d: number,
      l: number,
      pts: number,
      won: boolean,
      // The state the metrics are read from. Defaults to the folded state;
      // the `award` case below passes an unplayed one (see there).
      from: BoardgameState = state,
    ): StandingsDelta => ({
      entrantId: from.entrants[side],
      played: 1,
      won: w,
      drawn: d,
      lost: l,
      points: pts, // half-points — integer (spec 04 §9.4)
      metrics: sideMetrics(from, side, won),
    });

    switch (outcome.kind) {
      case "win": {
        const winnerSide = sideOf(state, outcome.winner);
        const winner = build(winnerSide, 1, 0, 0, cfg.scoring.win, true);
        const loser = build(opponent(winnerSide), 0, 0, 1, cfg.scoring.loss, false);
        return winnerSide === "home" ? [winner, loser] : [loser, winner];
      }
      case "award": {
        // A bye or a walkover — a fixture nobody played. THIS KERNEL NEVER
        // EMITS IT: boardgame's own `core.forfeit` decides a `win` with
        // method "forfeit" (decideResult above), which is why this case was
        // missing until 2026-09-20 and why chess/draughts/go threw
        // INVALID_EVENT the moment a competition-layer bye reached the table
        // (Swiss odd-field sit-out, knockout seeded bye — apps/web
        // engine-db/competition.ts `awardByeDelta`). The other seven modules
        // all handle it because their kernels DO fold a forfeit to an award.
        //
        // The advancing side scores what a win scores, from cfg — FIDE's
        // full-point bye, and the same pair total (`win + loss`) that
        // `declaredPointsSets` already declares, so the conformance kit
        // holds. `cfg.byeScore` is deliberately NOT read here: a half-point
        // bye would take the pair outside declaredPointsSets, and this
        // function cannot tell a bye from a two-sided walkover anyway — by
        // the time it is called the empty seat has been filled with a
        // phantom. Scoring a bye below a win is a competition-layer
        // decision, which is what byeScore's own comment says.
        //
        // Metrics come from an UNPLAYED state so `colorOf` excludes it from
        // colour history, exactly as it already excludes a forfeit — nobody
        // sat at a board, so "Games as White" must not move.
        const unplayed: BoardgameState = { ...state, forfeited: true };
        const winnerSide = sideOf(state, outcome.winner);
        const winner = build(winnerSide, 1, 0, 0, cfg.scoring.win, true, unplayed);
        const loser = build(opponent(winnerSide), 0, 0, 1, cfg.scoring.loss, false, unplayed);
        return winnerSide === "home" ? [winner, loser] : [loser, winner];
      }
      case "draw":
        return [
          build("home", 0, 1, 0, cfg.scoring.draw, false),
          build("away", 0, 1, 0, cfg.scoring.draw, false),
        ];
      case "no_result":
        // Double forfeit — both default to a zero score (chess.md §7).
        return [
          build("home", 0, 0, 0, 0, false),
          build("away", 0, 0, 0, 0, false),
        ];
      default:
        invalid(`board-game module cannot rank outcome "${outcome.kind}"`);
    }
  },

  metrics: [
    // doc 09 §2: chess shows Score, Buchholz Cut-1, SB (cascade-derived
    // columns, engine competition/display.ts) — colour tallies are pairing
    // metadata, not table columns.
    { key: "wins", label: "Wins", direction: "desc" },
    { key: "white", label: "Games as White", direction: "desc", display: false },
    { key: "black", label: "Games as Black", direction: "desc", display: false },
  ],
  defaultTiebreakers: BOARDGAME_TIEBREAKERS,

  // X-DR-1 (ruling 78): draws only where nobody must advance. A drawn bracket
  // game goes to the tie-break (BG-KO-1), never to a decided draw.
  supportsDraws(_cfg, stage: StageKind) {
    return DRAW_KINDS.has(stage);
  },

  // BG-KO-1
  bracketDeciders: () => ({ tiebreak: true }),
  // C12: lots is the organiser's settle (ruling 73) — settleApplies is true while
  // the tie-break is pending. A held double forfeit is phase "done": false (T15-R1).
  awaitingDecider: (s: BoardgameState) => s.phase === "tiebreak",
  // D-C7: the kernel refuses a tie-break TIEBREAK_NOT_APPLICABLE unless one is pending.
  deciderTypes: [BOARDGAME_TIEBREAK_TYPE],

  // §9.3 — {win+loss, 2·draw, 0 (double forfeit)}.
  declaredPointsSets(cfg) {
    return [
      ...new Set([cfg.scoring.win + cfg.scoring.loss, cfg.scoring.draw * 2, 0]),
    ];
  },

  matchPointsBounds(cfg) {
    return boundsFrom([cfg.scoring.win], [cfg.scoring.loss], [cfg.scoring.draw]);
  },

  officialLabel: { scorer: "Arbiter" }, // doc 13 §1

  // W4 — person credit. `games` fires once per named player on the pairing
  // card (the two fields never name the same person), `wins` off the result.
  // S8/#417 — `wins` gained the entrant fallback (`fromEntrant`/`entrantField`):
  // an explicit `winnerPerson` still wins when present (unchanged), and a
  // v1-era stream that names only the winning ENTRANT now still credits a
  // person via the roster (`PlayerStatsFoldCtx`). `draws`/`losses`/`white`/
  // `black` cannot be expressed as a flat metric+field walk at all — a draw
  // has no single "entrant" to key off, and a decisive result's LOSER has no
  // field of its own — so those four live in `folded` (`foldBoardgameStats`,
  // above). Per-person half points (1/½/0, as opposed to a plain win/draw/
  // loss count) remain a `derived` stat nobody has asked for yet — see
  // DOMAIN.md "downstream owed".
  playerStats: {
    metrics: [
      { key: "games", label: "Games", from: "boardgame.pairing", field: "homePerson", agg: "count" },
      { key: "games", label: "Games", from: "boardgame.pairing", field: "awayPerson", agg: "count" },
      {
        key: "wins",
        label: "Wins",
        from: "boardgame.result",
        field: "winnerPerson",
        agg: "count",
        entrantField: "winner",
        fromEntrant: true,
      },
    ],
    folded: {
      // "Games as White"/"Games as Black" match this module's OWN standings
      // `metrics` labels for the same two keys (above) — one word choice for
      // one concept, not a second name invented for the player-facing row.
      keys: [
        { key: "draws", label: "Draws" },
        { key: "losses", label: "Losses" },
        { key: "white", label: "Games as White" },
        { key: "black", label: "Games as Black" },
      ],
      fold: foldBoardgameStats,
    },
  },

  // spec 03 §6 — deterministic generator: start, then a single result
  // (win/draw/forfeit) that decides the fixture.
  arbitraryEvent(state, rng: Rng): ModuleEvent<BoardgameEv> | null {
    // Person ids follow the testkit lineup convention (`<entrantId>-p1`) —
    // the module holds no roster, so the generator synthesises them.
    const personOf = (side: Side) => `${state.entrants[side]}-p1`;
    if (state.phase === "pre") {
      // W4 — the arbiter's pairing card, once, before the clocks start.
      if (state.players === undefined && rng() < 0.5) {
        return {
          type: "boardgame.pairing",
          payload: {
            ...(state.cfg.colors
              ? { white: state.entrants[rng() < 0.5 ? "home" : "away"] }
              : {}),
            homePerson: personOf("home"),
            awayPerson: personOf("away"),
            board: 1,
          },
        };
      }
      return { type: "core.start", payload: {} };
    }
    if (state.phase === "tiebreak") {
      // W2a BG-KO-1 — a drawn bracket game: one tie-break on any rung, the
      // winner either side, and the tie-break's match score present or absent.
      const rung = pickFrom(rng, TIEBREAK_RUNGS);
      const winner = state.entrants[pickFrom(rng, SIDES)];
      const score = pickFrom(rng, TIEBREAK_SCORES);
      return {
        type: BOARDGAME_TIEBREAK_TYPE,
        payload: { rung, winner, ...(score === null ? {} : { score }) },
      };
    }
    if (state.phase !== "live") return null;
    const roll = rng();
    if (roll < 0.05) {
      return { type: "core.forfeit", payload: { by: state.entrants[rng() < 0.5 ? "home" : "away"], reason: "no-show" } };
    }
    if (roll < 0.1) {
      return { type: "boardgame.result", payload: { winner: null, method: "double_forfeit" } };
    }
    if (roll < 0.4) {
      return { type: "boardgame.result", payload: { winner: null, method: "agreement" } };
    }
    if (roll < 0.45) {
      // W4 — the widened drawing vocabulary (repetition / 50-move / dead).
      const drawn = ["repetition", "fifty_move", "dead_position"] as const;
      const method = drawn[Math.min(2, Math.floor(rng() * 3))] as BoardgameMethod;
      return { type: "boardgame.result", payload: { winner: null, method, moves: 40 } };
    }
    const winnerSide: Side = rng() < 0.5 ? "home" : "away";
    const winner = state.entrants[winnerSide];
    const method = rng() < 0.5 ? "checkmate" : "resign";
    return {
      type: "boardgame.result",
      payload: {
        winner,
        method,
        moves: 20 + Math.floor(rng() * 40),
        // Credit the player when the pairing card named one.
        ...(state.players === undefined ? {} : { winnerPerson: personOf(winnerSide) }),
      },
    };
  },
};
