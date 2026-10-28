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
import { CoreForfeit, forfeitOf, isStrictFold, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import type { Rng } from "../../core/rng.ts";
import {
  BRACKET_KINDS,
  DRAW_KINDS,
  EntrantId,
  type LineupPair,
  type AwardReason,
  type ForfeitBy,
  type ForfeitCredit,
  type ForfeitPhase,
  type ForfeitReason,
  type MatchOutcome,
  type ScoreSummary,
  type StageKind,
  type StandingsDelta,
} from "../../core/types.ts";
import type { PositionCatalog } from "../../sport/catalog.ts";
import { boundsFrom, stampAttributionRequired, winMethodTable, type DecidedIn } from "../../sport/module.ts";
import { awardOffenderSide, awardReasonOf, creditFor, creditedMetrics, doubleWalkoverCredit } from "../../sport/forfeit-credit.ts";
import type {
  ModuleEvent,
  PadAction,
  PadGate,
  PadPanel,
  PadSpec,
  SportModule,
  TiebreakerKey,
} from "../../sport/module.ts";
import { forfeitStatsRole, personsForEntrant, statsUnplayed, type PlayerStatRow, type PlayerStatsFoldCtx } from "../../stats/stats.ts";

// ---------------------------------------------------------------------------
// Cfg — spec 04 §6.1
// ---------------------------------------------------------------------------

// W2a BG-KO-1/BG-KO-2 (ruling 73). Lots is NOT a rung: drawing lots is the
// organiser's core.settle {method: "lot"}. Declared before the cfg, which
// validates a stage's rung list against it.
export const TIEBREAK_RUNGS = ["rapid", "blitz", "armageddon"] as const;
export type TiebreakRung = (typeof TIEBREAK_RUNGS)[number];
/** W2c D8: the rungs a stage plays, IN THE STAGE'S ORDER. Absent = every rung, in `TIEBREAK_RUNGS` order (today's
 *  behaviour); an empty list sends no drawn game to a tie-break. Never re-sorted: the order is the order played. */
export function effectiveRungs(cfg: Pick<BoardgameCfg, "tiebreakRungs">): readonly TiebreakRung[] {
  return cfg.tiebreakRungs ?? TIEBREAK_RUNGS;
}

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
  // W2c BG-KO-3 (D8) — the stage's tie-break rungs, in the order they are played. OPTIONAL with NO default (the same
  // golden rule as `tiebreak`): absent means every rung. An EMPTY list is the organiser's "no tie-break games": a
  // drawn bracket game folds level and the server holds it for a decision (ruling 79), so the list is authoritative
  // and `bracketDeciders` never writes it. No rung twice, none the engine does not declare.
  tiebreakRungs: z
    .array(z.enum(TIEBREAK_RUNGS))
    .max(TIEBREAK_RUNGS.length)
    .refine((rungs) => new Set(rungs).size === rungs.length, { message: "a tie-break rung is listed once" })
    .optional(),
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
  })
  // W2b (spec §5.2, f-w2): the method and the winner must agree. A double forfeit has no winner (an omitted `winner`
  // reads as null, as for every null-winner method); a single forfeit names one.
  .refine((result) => result.method !== "double_forfeit" || result.winner == null, {
    message: "a double forfeit has no winner",
    path: ["winner"],
  })
  .refine((result) => result.method !== "forfeit" || typeof result.winner === "string", {
    message: "a forfeit names its winner",
    path: ["winner"],
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

// A chess match score: whole points with an optional half either side of an en dash ("1½–½", "2–0").
export const CHESS_SCORE = /^(\d+½?|½)–(\d+½?|½)$/;
export const BOARDGAME_TIEBREAK_TYPE = "boardgame.tiebreak";
/** Rapid and blitz: the scorer records who won (ruling 82). */
export const BoardgameRungTiebreak = z.strictObject({
  rung: z.enum(["rapid", "blitz"]),
  // The entrant who advances — the same schema core.settle names its winner with
  // (review Minor 4); it was typed PersonId, a different brand of the same string.
  winner: EntrantId,
  score: z.string().regex(CHESS_SCORE).optional(),
});
/** W2c BG-KO-2 (D7): how a single Armageddon game ended, from White's side. */
export const ARMAGEDDON_RESULTS = ["white", "black", "draw"] as const;
/** Armageddon (W2c D7, greenfield — no live ledger carries the old `{rung, winner}` shape): the scorer records who
 *  had Black and the result, and the ENGINE decides who advances (BG-KO-2: a drawn Armageddon is Black's). The
 *  entrant is never named as a winner, so there is no way to record a draw that advances White. `black` is required;
 *  an event without it is refused by name (TIEBREAK_COLOUR_REQUIRED, see `requireArmageddonColour`). */
export const BoardgameArmageddon = z.strictObject({
  rung: z.literal("armageddon"),
  black: EntrantId,
  result: z.enum(ARMAGEDDON_RESULTS),
});
export const BoardgameTiebreak = z.discriminatedUnion("rung", [BoardgameRungTiebreak, BoardgameArmageddon]);
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
  // W2c BG-KO-2 — the entrant who had Black in the Armageddon, once one is recorded. ABSENT until then (never null in
  // `init`), so every stream that never played an Armageddon folds to exactly the state it always did (review I11).
  // Its own field: `colorOfHome` is the classical game's colour and stays untouched.
  armageddonBlack?: string;
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

/**
 * W2e BG-RS-1 (RB2B-20, D8; FIDE Laws of Chess Arts 5.1, 5.2 and 9.2 to 9.6): a result's method must agree with its winner.
 * A method only a decisive game ends by (checkmate, resignation, time, illegal move) needs a winner, and a method only a
 * drawn game ends by (agreement, stalemate, insufficient material, repetition, the fifty-move rule, a dead position) needs
 * none. `adjudication` is in both lists, so an arbiter's ruling is free either way, and an absent method has nothing to
 * contradict. `forfeit` and `double_forfeit` are in neither: the schema's own refinement judges them. The two lists are the
 * pad's, so the write path refuses exactly what the pad never offers.
 */
function requireMethodAgreesWithWinner(winner: string | null, method: BoardgameMethod | undefined): void {
  if (method === undefined) return;
  const decisive = (DECISIVE_METHODS as readonly string[]).includes(method);
  const drawn = (DRAWN_METHODS as readonly string[]).includes(method);
  const contradicts = winner === null ? decisive && !drawn : drawn && !decisive;
  if (!contradicts) return;
  throw new EngineError(
    "RESULT_METHOD_CONTRADICTS_WINNER",
    "the method does not fit the result: a win needs checkmate, resignation, time, illegal move or adjudication, and a draw needs a drawing method",
    { method, winner },
  );
}

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
    // Double forfeit ⇒ a DOUBLE WALKOVER in every stage kind (W2b BG-DW-1: both
    // players absent — nobody advances, both lose, 0 points); otherwise an
    // ordinary draw — unless this is a bracket game (BG-KO-1), which goes to the
    // tie-break. The double forfeit is checked FIRST: it is not a drawn game, so
    // it never opens a tie-break. It replaces T15-R1's held `no_result`, which a
    // settle had to close; a settle recorded over one before W2b still replays
    // (the kernel's legacy settle, D6).
    if (method === "double_forfeit") return { ...base, outcome: { kind: "double_walkover" } };
    // W2c BG-KO-3: the stage's rung list is authoritative. An empty list is "no tie-break games", so the drawn game
    // stays a draw (the server holds a bracket's level result for the organiser, ruling 79) instead of waiting for a
    // decider nobody may record.
    const rungs = effectiveRungs(state.cfg);
    if (state.cfg.tiebreak === true && rungs.length > 0) return { ...base, phase: "tiebreak", outcome: null, tiebreak: {} };
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

// W2b (spec §5.2, chess unified) — `core.forfeit` decides the same
// `award{winner, loser, reason}` as the other ten modules, or `double_walkover`
// for `by: "both"`. It used to decide `win{method:"forfeit"}` and drop the
// reason, which seated the loser in a double-elimination losers' bracket
// (DE-RK). Recordable before the game, during it and in a pending tie-break
// (FIDE Laws 6.7.1; R14 — the kernel's phase guard judges which reason, this
// module only refuses a game that is over). `forfeited: true` and the method
// enum value keep the colour history and the pad reading the game as unplayed.
function applyForfeit(state: BoardgameState, by: string, reason: ForfeitReason): BoardgameState {
  if (state.phase !== "pre" && state.phase !== "live" && state.phase !== "tiebreak") {
    wrongPhase(`forfeit not allowed in phase "${state.phase}"`);
  }
  const base = { ...state, phase: "done" as const, forfeited: true };
  if (by === "both") return { ...base, method: "double_forfeit", outcome: { kind: "double_walkover" } };
  const loserSide = sideOf(state, by);
  return {
    ...base,
    method: "forfeit",
    outcome: { kind: "award", winner: state.entrants[opponent(loserSide)], loser: state.entrants[loserSide], reason },
  };
}

/** W2b (plan D3) — the kernel's forfeit guard reads boardgame's phase through this Record (closed union). */
const FORFEIT_PHASE: Record<BoardgameState["phase"], ForfeitPhase> = {
  pre: "pre",
  live: "play",
  tiebreak: "tiebreak",
  done: "over",
  final: "over",
  abandoned: "over",
};

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

/** BG-KO-2: White won, the other entrant advances; Black won or the Armageddon was drawn, Black advances. */
function armageddonAdvancer(black: Side, result: (typeof ARMAGEDDON_RESULTS)[number]): Side {
  return result === "white" ? opponent(black) : black;
}

/** BG-KO-3: a rung the stage does not list is not played, whatever else the event says. Which of the LISTED rungs may be
 *  recorded first is not decided here: the engine is only ever given the rung that decided the game (it has no "this rung
 *  ended level" fact), so "the next rung after the last drawn one" has nothing to read. See the order test in
 *  tiebreak.test.ts (open ruling). */
function refuseUnlistedRung(state: BoardgameState, rung: TiebreakRung): void {
  const listed = effectiveRungs(state.cfg);
  if (!listed.includes(rung)) {
    tiebreakRefused(`tie-break rung "${rung}" is not one this stage plays`, { rung, allowed: [...listed] });
  }
}

/** W2c D7: an Armageddon names who had Black, or it is refused by name. Read from the raw payload, ahead of the
 *  schema, so a scorer who left the colour out is told what to record rather than that the payload is invalid. A
 *  stage that does not play an Armageddon is told that first: the rung list outranks the colour. */
function requireArmageddonColour(state: BoardgameState, payload: unknown): void {
  if (typeof payload !== "object" || payload === null) return;
  const { rung, black } = payload as { rung?: unknown; black?: unknown };
  // Missing is anything that names no entrant: absent, null, "" or a non-string (an API client that clears the field sends
  // null or ""). A non-empty string no one owns is not missing; the schema and the lineup lookup refuse that one.
  if (rung === "armageddon" && (typeof black !== "string" || black === "")) {
    refuseUnlistedRung(state, rung);
    throw new EngineError("TIEBREAK_COLOUR_REQUIRED", "an Armageddon must record who had Black", { rung });
  }
}

// W2a BG-KO-1. Only in phase "tiebreak", and only on a rung the stage lists (W2c BG-KO-3). Rapid and blitz: the
// scorer records the winner. Armageddon (W2c BG-KO-2): the scorer records Black and the result and the winner is
// DERIVED here, never typed — the colour is kept in its own field and never written to `colorOfHome`.
function applyTiebreak(state: BoardgameState, p: BoardgameTiebreak): BoardgameState {
  if (state.phase !== "tiebreak") tiebreakRefused(`tie-break not allowed in phase "${state.phase}"`);
  refuseUnlistedRung(state, p.rung);
  if (p.rung === "armageddon") {
    const blackSide = sideOf(state, p.black);
    const winnerSide = armageddonAdvancer(blackSide, p.result);
    return {
      ...state,
      phase: "done",
      armageddonBlack: state.entrants[blackSide],
      tiebreak: { rung: p.rung },
      outcome: { kind: "win", winner: state.entrants[winnerSide], loser: state.entrants[opponent(winnerSide)], method: `tiebreak_${p.rung}` },
    };
  }
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

/**
 * W2b (spec §5.2; BG-WO-1, BG-WO-2) — every chess forfeit credits the same: 1-0 (the winner's win, from cfg's scoring
 * in `standingsDelta`), counted as a game for the table's tie-breaks and OUT of colour history — nobody sat at a board,
 * or the game was not finished, so "Games as White/Black" must not move (an unplayed state, as `colorOf` already
 * reads a forfeit). A bye is today's bye delta (C-5), which is the same unplayed 1-0; a double walkover credits nothing.
 */
function boardgameForfeitCredit(_cfg: BoardgameCfg, state: BoardgameState, reason: AwardReason, by: ForfeitBy): ForfeitCredit {
  const unplayed: BoardgameState = { ...state, forfeited: true };
  if (by === "both") {
    return doubleWalkoverCredit(sideMetrics(unplayed, "home", false), sideMetrics(unplayed, "away", false), ["wins", "white", "black"]);
  }
  const winner = opponent(by);
  return {
    perSide: creditFor(by, sideMetrics(unplayed, winner, true), sideMetrics(unplayed, by, false)),
    excluded: reason === "bye" ? [] : ["white", "black"],
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

// The Swiss order (W3's; unchanged by W2d, OC1): the Buchholz family first.
export const BOARDGAME_TIEBREAKERS: TiebreakerKey[] = [
  "points",
  "buchholz_cut1",
  "buchholz",
  "sberger",
  "direct",
  "wins",
  "lots",
];

// W2d (spec §5.10, BG-TB-1, BG-TB-2; RBG:459-461) — the round-robin order: points → direct encounter → number of wins →
// Sonneborn-Berger → lots. No Buchholz outside Swiss (FIDE C.07 Art. 8 note).
export const BOARDGAME_RR_TIEBREAKERS: TiebreakerKey[] = ["points", "direct", "wins", "sberger", "lots"];

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
// none (W2e BG-RS-1: `requireMethodAgreesWithWinner` refuses a contradiction on the write path; the web pad imports
// these two lists rather than restating them) — `decideResult` refuses `winnerPerson` whenever winner is null, so
// the two actions below never share a field. "adjudication" appears in BOTH:
// an arbiter's discretionary ruling (FIDE Art. 5.2) can go either way.
//
// W2b (spec §5.2 "Chess forfeit paths", plan D15): `forfeit` and `double_forfeit` are no longer offered. A forfeit is
// `core.forfeit` with its reason, in chess as in the other ten sports (award, credit, stats skip and public tag alike);
// `boardgame.result{forfeit | double_forfeit}` stays readable only for streams written before W2b, and the append
// guard refuses it on write. The schema's method/winner refinement would also refuse a winnerless "forfeit".
export const DECISIVE_METHODS = ["checkmate", "resign", "time", "adjudication", "illegal_move"] as const;
export const DRAWN_METHODS = [
  "agreement", "stalemate", "insufficient", "adjudication",
  "repetition", "fifty_move", "dead_position",
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
  // data. (Until W2b chess's single forfeit was the exception, riding
  // `boardgame.result` with `method: "forfeit"` / `"double_forfeit"`; W2b
  // unified it on `core.forfeit` — see DECISIVE_METHODS.)

  // W2a BG-KO-1 — the tie-break, offered only in a bracket cfg and only in
  // phase "tiebreak"; the result panels are then gated to phase "live", so a
  // drawn bracket game swaps them for the tie-break. Without `tiebreak` in cfg
  // no panel carries a gate (the spec is unchanged).
  // W2c: the tie-break has two payload shapes (rapid/blitz name the winner; an Armageddon names Black and the result),
  // so it is two actions of one event type, each offering only the rungs the stage lists, in the stage's order. An
  // empty list offers none, and a stage with no rung to play has no tie-break panel at all.
  const rungsListed = effectiveRungs(cfg);
  const timedRungs = rungsListed.filter((r) => r !== "armageddon");
  const timedAction: PadAction = {
    type: BOARDGAME_TIEBREAK_TYPE,
    labelKey: { key: "pad.boardgame.action.tiebreak", label: "Tie-break" },
    fields: [{ kind: "enum", path: "rung", values: timedRungs }],
    attribution: [{ kind: "side", path: "winner" }],
  };
  const armageddonAction: PadAction = {
    type: BOARDGAME_TIEBREAK_TYPE,
    labelKey: { key: "pad.boardgame.action.armageddon", label: "Armageddon game" },
    fields: [
      { kind: "enum", path: "rung", values: ["armageddon"] },
      { kind: "enum", path: "result", values: ARMAGEDDON_RESULTS },
    ],
    attribution: [{ kind: "side", path: "black" }],
  };
  const tiebreakActions: PadAction[] = [
    ...(timedRungs.length > 0 ? [timedAction] : []),
    ...(rungsListed.includes("armageddon") ? [armageddonAction] : []),
  ];
  const inPhase = (value: string): PadGate => ({ op: "path-equals", path: "state.phase", value });
  const tb = cfg.tiebreak === true && tiebreakActions.length > 0;

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
          actions: tiebreakActions,
          gate: inPhase("tiebreak"),
        }]
      : []),
  ];

  // R8/WS-B — `required` stamped ONCE, here, from BOARDGAME_EVENT_SCHEMAS
  // itself (never hand-typed per action; see module.ts's own doc comment). `boardgame.tiebreak` is a union of the
  // rapid/blitz and Armageddon payloads, and `isPathRequired` resolves a path through its branches.
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
/** The classical game's result — a `boardgame.result` — stands before any later forfeit (ruling D-C6, BG-WO-3). */
const isGameResult = (event: EventEnvelope): boolean => event.type === "boardgame.result";

/** W2b (X-PS-1; rulings 118, 120, 127) — a chess fixture nobody played: a walkover or a double walkover before any game
 *  result, or a withdrawal or an abandon before the Start. A forfeit after the classical game (a tie-break walkover)
 *  leaves that game played, and so do a withdrawal and an abandon after the Start (ruling 118: in chess the Start is
 *  play) — the withdrawal with no personal result (ruling 127, `forfeitStatsRole` "appeared"). The shared reading with
 *  this module and the game's result, so the forfeit and abandon rules keep one copy. */
function boardgameUnplayed(events: readonly EventEnvelope[]): boolean {
  return statsUnplayed(events, boardgame, isGameResult);
}

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

  // W2b (X-PS-2): a retirement or an in-match disqualification BEFORE any game result is a game both players played,
  // decided against the offender — its win (the plain metric's key, shared below) and its loss. Since W2b chess folds a
  // forfeit through `core.forfeit` (no `boardgame.result`), this is the only place it is credited.
  if (forfeitStatsRole(events, isGameResult, boardgame) === "played") {
    const forfeit = [...events].reverse().find((event) => event.type === "core.forfeit");
    const parsed = forfeit === undefined ? undefined : CoreForfeit.safeParse(forfeit.payload);
    if (parsed?.success === true) {
      for (const entrant of ctx.entrants) creditEach(entrant, entrant.id === parsed.data.by ? "losses" : "wins");
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
  // W2c (spec §4.1 Q5) — a chess match has no per-match format: the time control is set per stage (item 14), and the
  // tie-break games exist only where someone must advance (`bracketDeciders`). Scoring and the bye are table points.
  ruleKeys: {
    variant: { scope: "stage" },
    clock: { scope: "stage" },
    // W2c BG-KO-1, BG-KO-3 (item 13): the stage's tie-break rungs, in order, ARE the chess decider; their off state is the
    // EMPTY list, which holds a drawn game for the organiser (ruling 79). Stage-only (Q5). The bare `tiebreak` switch is no
    // organiser key: `bracketDeciders` forces it on, and the rung list now decides whether anything is played.
    tiebreakRungs: { scope: "stage", decider: true, appliesTo: { stageKinds: [...BRACKET_KINDS] } },
    scoring: { scope: "points" },
    byeScore: { scope: "points" },
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
        const winner = payload.winner ?? null;
        // W2e BG-RS-1 (RB2B-20, D8): STRICT ONLY, so a result recorded before the rule replays to what it recorded.
        if (isStrictFold(ctx)) requireMethodAgreesWithWinner(winner, payload.method);
        return decideResult(state, winner, payload.method, {
          ...(payload.moves === undefined ? {} : { moves: payload.moves }),
          ...(payload.winnerPerson === undefined ? {} : { winnerPerson: payload.winnerPerson }),
        });
      }
      case "boardgame.pairing":
        return applyPairing(state, parsePayload(BoardgamePairing, ev.payload, ev.type), isStrictFold(ctx));
      case BOARDGAME_TIEBREAK_TYPE:
        requireArmageddonColour(state, ev.payload);
        return applyTiebreak(state, parsePayload(BoardgameTiebreak, ev.payload, ev.type));
      case "core.forfeit": {
        const { by, reason } = forfeitOf(ev.payload);
        return applyForfeit(state, by, reason);
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
  forfeitPhase: (state) => FORFEIT_PHASE[state.phase],
  // W2b (plan D3 R2) — chess records a walkover before the game, after the session starts (FIDE Laws 6.7.1: a
  // player absent at the default time) and in a pending tie-break (R14). The only module that widens ["pre"].
  walkoverPhases: ["pre", "play", "tiebreak"],
  // W2b ruling 118 — Seazn records no chess moves: the Start is play, so a retirement or a disqualification after it is
  // a game both players played (X-PS-2), and a no-show is still a walkover (the reason the organiser picks tells them
  // apart).
  startIsPlay: true,
  // W2b (spec §5.2) — see boardgameForfeitCredit.
  forfeitCredit: boardgameForfeitCredit,

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
    } else if (outcome?.kind === "win" || outcome?.kind === "award") {
      // W2b (BG-WO-1, X-WO-1): a forfeit is an `award` since W2b and reads the credited 1-0, as the `win` it was.
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
        // A bye, a walkover or a forfeit after the game started (BG-WO-1). Until W2b this kernel decided its own
        // `core.forfeit` as a `win` with method "forfeit", and only a competition-layer bye reached this arm (Swiss
        // odd-field sit-out, knockout seeded bye — apps/web engine-db/competition.ts `awardByeDelta`, which threw
        // INVALID_EVENT here until 2026-09-20). W2b unified chess on the award every other sport folds a forfeit to.
        //
        // The advancing side scores what a win scores, from cfg — FIDE's full-point bye, and the same pair total
        // (`win + loss`) that `declaredPointsSets` already declares, so the conformance kit holds. `cfg.byeScore` is
        // deliberately NOT read here: a half-point bye would take the pair outside declaredPointsSets. Scoring a bye
        // below a win is a competition-layer decision, which is what byeScore's own comment says.
        //
        // The metrics are `boardgameForfeitCredit`'s: 1-0, out of colour history.
        const winnerSide = sideOf(state, outcome.winner);
        const offender = awardOffenderSide(outcome, winnerSide, (id) => sideOf(state, id));
        const credit = boardgameForfeitCredit(cfg, state, awardReasonOf(outcome), offender);
        const at = (side: Side, w: number, l: number, pts: number): StandingsDelta => ({
          ...build(side, w, 0, l, pts, w === 1),
          metrics: creditedMetrics(sideMetrics(state, side, w === 1), credit, side),
        });
        const winner = at(winnerSide, 1, 0, cfg.scoring.win);
        const loser = at(offender, 0, 1, cfg.scoring.loss);
        return winnerSide === "home" ? [winner, loser] : [loser, winner];
      }
      case "draw":
        return [
          build("home", 0, 1, 0, cfg.scoring.draw, false),
          build("away", 0, 1, 0, cfg.scoring.draw, false),
        ];
      case "double_walkover": {
        // W2b X-DW-1 / BG-DW-1 — both players absent: each is charged a game played and LOST, 0 points, and nothing
        // enters colour history or any ratio (X-DW-4). A double forfeit was a held no_result before W2b; this arm is
        // what a `boardgame.result{double_forfeit}` and a `core.forfeit{by:"both"}` now rank as.
        const credit = boardgameForfeitCredit(cfg, state, "walkover", "both");
        const at = (side: Side): StandingsDelta => ({ ...build(side, 0, 0, 1, 0, false), metrics: creditedMetrics(sideMetrics(state, side, false), credit, side) });
        return [at("home"), at("away")];
      }
      case "no_result":
        // An abandoned game that nothing settled — nobody's win, draw or loss (chess.md §7). (A double forfeit was
        // ranked here before W2b; it is a double walkover now, above.)
        return [
          build("home", 0, 0, 0, 0, false),
          build("away", 0, 0, 0, 0, false),
        ];
      default:
        invalid(`board-game module cannot rank outcome "${outcome.kind}"`);
    }
  },

  metrics: [
    // The table's columns derive from the stage's cascade (competition/display.ts): a Swiss shows Score, Buchholz Cut-1,
    // SB; a round robin shows no Buchholz (C.07 Art. 8 note, BG-TB-2) — colour tallies
    // are pairing metadata, not table columns.
    { key: "wins", label: "Wins", direction: "desc" },
    { key: "white", label: "Games as White", direction: "desc", display: false },
    { key: "black", label: "Games as Black", direction: "desc", display: false },
  ],
  defaultTiebreakers: (kind) => [...(kind === "swiss" ? BOARDGAME_TIEBREAKERS : BOARDGAME_RR_TIEBREAKERS)],
  // W2d (spec §5.10, BG-PT-1) — FIDE's 1 / ½ / 0 in half-points on every table stage, and the 3/1/0 "football scoring"
  // some opens use (RB2B-18) on a round-robin stage only: a Swiss pairs on the score, which 3/1/0 would distort.
  tablePresets: (stageKind) => ({
    points: [
      { id: "fide_1_half_0", rule: { win: { regulation: 2 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "result", unit: "half", bonuses: [] } },
      ...(stageKind === "swiss"
        ? []
        : [{ id: "three_one_zero", rule: { win: { regulation: 3 }, loss: { regulation: 0 }, draw: 1, shootoutAs: "result" as const, unit: "whole" as const, bonuses: [] } }]),
    ],
    tiebreakers: [],
  }),
  primaryTableKey: "points", // W2d (D11): the table ranks on points first.

  // X-DR-1 (ruling 78): draws only where nobody must advance. A drawn bracket
  // game goes to the tie-break (BG-KO-1), never to a decided draw.
  supportsDraws(_cfg, stage: StageKind) {
    return DRAW_KINDS.has(stage);
  },

  // BG-KO-1
  bracketDeciders: () => ({ tiebreak: true }),
  // M-3 (BG-KO-1, BG-KO-3): a drawn game goes to its tie-break when the stage plays one and lists at least one rung
  // (`decideResult`), and every tie-break event names a winner. Anything else - no tie-break, or an empty rung list -
  // leaves the draw standing, held for the organiser (ruling 79).
  canEndLevel: (cfg) => !(cfg.tiebreak === true && effectiveRungs(cfg).length > 0),
  // W2d (spec §5.2, D4; X-PT-2) — a result names any method a winner may carry (the result schema refuses a winner only
  // on a double forfeit), `regulation` when it names none (`decideResult`), and a tie-break game names its rung: chess's
  // shoot-out (author's call, D4).
  ...winMethodTable("boardgame", {
    regulation: "regulation",
    ...Object.fromEntries(BoardgameMethod.options.filter((m) => m !== "double_forfeit").map((m): [string, DecidedIn] => [m, "regulation"])),
    ...Object.fromEntries(TIEBREAK_RUNGS.map((r): [string, DecidedIn] => [`tiebreak_${r}`, "so"])),
  }),
  // A drawn game goes to tie-break games only where the stage plays them and lists a rung (`decideResult`, `canEndLevel`).
  reachableDecidedIn: (cfg) => new Set<DecidedIn>(cfg.tiebreak === true && effectiveRungs(cfg).length > 0 ? ["regulation", "so"] : ["regulation"]),
  reachableResultKinds: (cfg, stage) => new Set<"draw" | "tie" | "noResult">(boardgame.supportsDraws(cfg, stage) ? ["draw"] : []),
  shootoutAs: "result",
  // W2d (spec §5.10; BG-PT-1) — `scoring` as stored, in half-points (2/1/0 is FIDE's 1/½/0, `unit: "half"`); a
  // tie-break game's winner is paid a win (no `so` split).
  tablePointsRule: (cfg) => ({
    win: { regulation: cfg.scoring.win },
    loss: { regulation: cfg.scoring.loss },
    draw: cfg.scoring.draw,
    shootoutAs: boardgame.shootoutAs,
    unit: "half",
    bonuses: [],
  }),
  // C12: lots is the organiser's settle (ruling 73) — settleApplies is true while
  // the tie-break is pending. A held double forfeit is phase "done": false (T15-R1).
  awaitingDecider: (s: BoardgameState) => s.phase === "tiebreak",
  // D-C7: the kernel refuses a tie-break TIEBREAK_NOT_APPLICABLE unless one is pending.
  deciderTypes: [BOARDGAME_TIEBREAK_TYPE],
  // D-R7 / W2c D7: who a tie-break event would advance. Rapid and blitz name the winner; an Armageddon names Black and
  // the result, so the advancer is derived (BG-KO-2). The server's withdrawn-entrant guard asks this, because the
  // payload no longer carries a `winner` for an Armageddon. Undefined = the payload names nobody (the fold refuses it).
  deciderWinner(payload, entrants) {
    const parsed = BoardgameTiebreak.safeParse(payload);
    if (!parsed.success) return undefined;
    const t = parsed.data;
    if (t.rung !== "armageddon") return t.winner;
    const black: Side | null = t.black === entrants.home ? "home" : t.black === entrants.away ? "away" : null;
    return black === null ? undefined : entrants[armageddonAdvancer(black, t.result)];
  },

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
      // W2b (X-PS-1): an appearance — not credited when the game was never played (`boardgameUnplayed`).
      { key: "games", label: "Games", from: "boardgame.pairing", field: "homePerson", agg: "count", appearance: true },
      { key: "games", label: "Games", from: "boardgame.pairing", field: "awayPerson", agg: "count", appearance: true },
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
        // W2b (X-PS-2): a forfeit after the start credits the winner's win here (no `boardgame.result` carries it).
        { key: "wins", label: "Wins" },
      ],
      sharesMetricKeys: ["wins"],
      fold: foldBoardgameStats,
    },
    unplayed: boardgameUnplayed,
  },

  // spec 03 §6 — deterministic generator: start, then a single result
  // (win/draw/forfeit) that decides the fixture.
  // Stryker disable all: W2b ruling 109 (owner-approved, MD-1) — arbitraryEvent is test-data generation, never mutated
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
      // W2c: only a rung the stage lists (a drawn game reaches this phase only when the list is not empty), and an
      // Armageddon records Black and the result instead of a winner. For the absent list the draws are the ones the
      // generator always made, rung then side, so a rapid or blitz stream is the one it always was.
      const rung = pickFrom(rng, effectiveRungs(state.cfg));
      const side = state.entrants[pickFrom(rng, SIDES)];
      if (rung === "armageddon") {
        return { type: BOARDGAME_TIEBREAK_TYPE, payload: { rung, black: side, result: pickFrom(rng, ARMAGEDDON_RESULTS) } };
      }
      const score = pickFrom(rng, TIEBREAK_SCORES);
      return {
        type: BOARDGAME_TIEBREAK_TYPE,
        payload: { rung, winner: side, ...(score === null ? {} : { score }) },
      };
    }
    if (state.phase !== "live") return null;
    const roll = rng();
    if (roll < 0.05) {
      // W2b D3 + ruling 113: a legal reason for the phase (chess admits a walkover after the session starts), drawn
      // from the roll already taken so the generator's rng stream is unchanged. Never a retirement here: in phase live
      // a chess game has no play short of its result, and nobody retires from a game never played (ruling 113) — the
      // retirement band reads as a disqualification.
      const reason = roll < 0.02 ? "walkover" : "disqualified";
      return { type: "core.forfeit", payload: { by: state.entrants[rng() < 0.5 ? "home" : "away"], reason } };
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
  // Stryker restore all
};
