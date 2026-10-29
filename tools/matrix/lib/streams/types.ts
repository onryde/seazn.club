import type { MatchOutcome, SETTLE_METHODS, StageKind } from "@seazn/engine/core";
import type { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";

export type Side = "home" | "away";

/** W2e (Tasks 19–23, spec §10, G1–G8): how a won match was DECIDED, as a request names it — the deciding path a sport's
 *  generator builds a win down (football's extra time and shoot-out; the period kernel's overtime, shoot-out and GWS;
 *  cricket's super over and DLS; a set sport's deciding set and its cap; tennis's tie-break set and short-set tie-break).
 *  One closed list for every task, so the label and the sweeps read one vocabulary; a generator builds the ones its sport
 *  has (`SportStreamGenerator.pathWitness`). */
export const DECIDING_PATHS = Object.freeze([
  "extraTime", "shootout", "overtime", "gws", "superOver", "dls", "decidingSet", "cap", "tiebreakSet", "shortSetTb",
] as const);
export type DecidingPath = (typeof DECIDING_PATHS)[number];

/** W2a: the organiser's three ways to close a match no play decided (engine core, X-ST-1). */
export type SettleMethod = (typeof SETTLE_METHODS)[number];
/** W2a: a chess bracket game's tie-break rungs (BG-KO-1). Lots is the organiser's settle, not a rung. */
export type TiebreakRung = (typeof TIEBREAK_RUNGS)[number];

/** W2b (D1): the closed list a core.forfeit records (X-RS-1), restated from the engine's `FORFEIT_REASONS`
 *  (@seazn/engine/core) so this file stays type-only on the engine; w2b-generators.test.ts pins the two equal.
 *  `withdrew` is the withdrawal cascade's alone (PF-2: the server refuses it from every other writer). */
export const FORFEIT_REASONS = Object.freeze(["walkover", "retired", "disqualified", "withdrew"] as const);
export type ForfeitReason = (typeof FORFEIT_REASONS)[number];
/** When the forfeit is recorded: before the match started (a walkover; a withdrawal before play), or after START and
 *  some play (a retirement, a disqualification; a withdrawal mid-match). D3's phase guard refuses the others. */
export type ForfeitAt = "before_start" | "after_start";
/** The phase each reason is recorded in when a request does not say otherwise (X-RS-1: walkover = before play started,
 *  retired/disqualified = after). `withdrew` is the cascade's, which runs in any phase but `over` (D3 R5). */
export const NATURAL_FORFEIT_AT: Readonly<Record<ForfeitReason, ForfeitAt>> = Object.freeze({ walkover: "before_start", withdrew: "before_start", retired: "after_start", disqualified: "after_start" });

export type RequestedOutcome =
  /** `path` (W2e, Tasks 19–23): the win is DECIDED down that path (extra time, a shoot-out, a super over, a set cap...),
   *  checked on the fold by the generator's own `pathWitness`. Absent = a win by any path, byte for byte the W1 request. */
  | { readonly kind: "win"; readonly winner: Side; readonly path?: DecidingPath }
  | { readonly kind: "draw" }
  /** W2b: `by` is the side that forfeits; `at` is when (see ForfeitAt). */
  | { readonly kind: "forfeit"; readonly by: Side; readonly reason: ForfeitReason; readonly at: ForfeitAt }
  /** W2b (X-DW-1): neither side turned up — core.forfeit {by: "both", reason: "walkover"}, before START. */
  | { readonly kind: "double_walkover" }
  /** `atScore`: W2a (spec §5.6.1) — abandoned with something on the board, not at 0–0: the sport's own win
   *  stream cut one event before it decides. Absent = the old `[START, core.abandon]`, byte for byte. `afterPartial`:
   *  W2b (X-AB-1) — START, the sport's partial play (a goal each; a cricket first innings and five overs of the chase),
   *  then the abandon: a level real score in the goal sports, past cricket's minimum overs. */
  | { readonly kind: "abandon"; readonly atScore?: true; readonly afterPartial?: true }
  /** Level scores that stand as a tie (cricket decideTie, ruling 44). A sport
   *  generator builds it only through `tied`; one that declares none cannot
   *  reach it (OutcomeUnreachable). */
  | { readonly kind: "tie" }
  /** W2a: a play-produced LEVEL result in a bracket stage, which the product holds as `needs_decision` (X-BR-2).
   *  It is a draw or a tie by the sport's own stream, checked by folding it: a sport whose bracket cfg turns a
   *  level game into something else (a chess tie-break, a carrom extra board) cannot reach it. Bracket kinds only. */
  | { readonly kind: "level" }
  /** W2a: the organiser closes a match no play decided — a level result (`after: "level"`) or an abandon at a real
   *  score (`after: "abandon"`) — by core.settle naming `then` (X-ST-1, X-ST-2). */
  | { readonly kind: "settle"; readonly then: Side; readonly method: SettleMethod; readonly after: "level" | "abandon" }
  /** W2a: a drawn chess bracket game decided by the scorer-recorded tie-break (BG-KO-1). Boardgame only. Rapid and
   *  blitz record the winner. W2c BG-KO-2: an Armageddon records who had Black and how it ended, and the engine
   *  derives who advances; `winner` is the side that does, and is Black either way (a drawn Armageddon advances Black).
   *  `result` picks how the Armageddon ended: "black" (Black won, the default) or "draw"; it means nothing on rapid or
   *  blitz, so naming it there is a refusal. */
  | { readonly kind: "tiebreak"; readonly rung: TiebreakRung; readonly winner: Side; readonly result?: "black" | "draw" }
  /** W2e G12 (Task 24 builds and matches it; typed here by Task 19 so the vocabulary has one author): `by` is the side
   *  given a sanction of `level` (the module's own sanction-level name) that ENDS the match, recorded after START and some
   *  play, then the forfeit that ends it — an award to the other side. Partial play comes from `partialPlay`, so there is
   *  no "when" field (preflight D-3). Until Task 24, generateStream refuses it by name and matchesRequest throws. */
  | { readonly kind: "sanctionEnd"; readonly by: Side; readonly level: string };

export type DecidedOutcome = Extract<RequestedOutcome, { kind: "win" | "draw" }>;

export const ALL_OUTCOMES: readonly RequestedOutcome[] = Object.freeze([
  { kind: "win", winner: "home" },
  { kind: "win", winner: "away" },
  { kind: "draw" },
  { kind: "forfeit", by: "away", reason: "walkover", at: "before_start" },
  { kind: "forfeit", by: "home", reason: "retired", at: "after_start" },
  { kind: "abandon" },
  { kind: "tie" },
]);

export function outcomeLabel(o: RequestedOutcome): string {
  switch (o.kind) {
    // W2e: a path win names its path; a win that names none is W1's label, byte for byte (committed case ids).
    case "win": return `win-${o.winner}${o.path === undefined ? "" : `-${o.path}`}`;
    case "draw": return "draw";
    // The two labels W1 shipped stay byte-identical (a walkover before start, a retirement after it); any other
    // phase is named in the label.
    case "forfeit": return `forfeit-${o.by}-${o.reason}${o.at === NATURAL_FORFEIT_AT[o.reason] ? "" : `-${o.at.replace("_", "-")}`}`;
    case "double_walkover": return "double-walkover";
    case "abandon": return o.afterPartial === true ? "abandon-after-partial" : o.atScore === true ? "abandon-at-score" : "abandon";
    case "tie": return "tie";
    case "level": return "level";
    case "settle": return `settle-${o.then}-${o.method}-after-${o.after}`;
    case "tiebreak": return `tiebreak-${o.rung}-${o.winner}`;
    case "sanctionEnd": return `sanction-${o.by}-${o.level}`;
  }
}

export interface StreamEvent {
  readonly type: string;
  readonly payload: unknown;
}

export interface StreamRequest {
  readonly sportKey: string;
  readonly cfg: unknown;
  readonly stageKind: StageKind;
  readonly home: string;
  readonly away: string;
  readonly outcome: RequestedOutcome;
}

export interface DecidedRequest extends StreamRequest {
  readonly outcome: DecidedOutcome;
}

export interface SportStreamGenerator {
  readonly sportKeys: readonly string[];
  decided(req: DecidedRequest): StreamEvent[];
  /** Level scores that fold to `{ kind: "tie" }`. Absent where the sport's
   *  engine never ends level; a generator may still refuse a cfg whose level
   *  score is played off (OutcomeUnreachable). */
  tied?(req: StreamRequest): StreamEvent[];
  /** W2a (M7): why `level` is refused for this sport under this cfg when the reason is one no refusal of the draw/tie
   *  stream could name - null/absent otherwise. Chess: a DRAWN bracket game opens the tie-break, so the one level
   *  result it has (a double forfeit, no_result) is built by no request. */
  levelRefusal?(cfg: unknown): string | null;
  /** W2a: a drawn game followed by the scorer's tie-break (BG-KO-1). Absent where the sport has no such phase. */
  tiebreak?(req: StreamRequest & { readonly outcome: Extract<RequestedOutcome, { kind: "tiebreak" }> }): StreamEvent[];
  /** W2b (X-RT-1): some play and nothing decided — scoring events only (no START), at least one for EACH side where
   *  the sport can score one short of a result. Empty where it cannot (chess: the game is its result). generateStream
   *  folds `[START, ...partial]` and refuses one that decides. */
  partial(req: StreamRequest): StreamEvent[];
  /** W2e (Task 19, preflight F8): did the folded match end down `path`? Read from the ENGINE's own facts about the fold
   *  — football: `decidedInFor` over the module's win-method table; a set sport: its folded set scores; cricket: the
   *  outcome's method or the super-over innings — never from the stream the generator built. matchesRequest asks it after
   *  the winner matched. Present exactly when `decided` builds paths: generateStream refuses a path request to a generator
   *  that declares none (GeneratorUnsupported), so no path is ever built as a plain win, and `decided` itself refuses
   *  (OutcomeUnreachable) a path its sport has no rule for, or one the request's cfg does not switch on. */
  pathWitness?(path: DecidingPath, fold: PathFold): boolean;
}

/** W2e (Task 19, preflight F8): what a path witness reads — the STRICT fold (lib/fold.ts `foldStream`) of the stream as
 *  posted, and the cfg it was folded under. `outcome` is the win matchesRequest already matched to the requested winner. */
export interface PathFold {
  readonly outcome: MatchOutcome;
  readonly state: unknown;
  readonly cfg: unknown;
}

/** First in every stream that plays. A walkover and a double walkover are recorded BEFORE it (W2b D3: the phase guard
 *  refuses a walkover once play started, except chess); a retirement after it. */
export const START: StreamEvent = Object.freeze({ type: "core.start", payload: {} });

export function idOf(req: StreamRequest, side: Side): string {
  return side === "home" ? req.home : req.away;
}

/** The module declares this outcome impossible here: a draw where supportsDraws
 *  is false, or a tie the sport cannot end on under this cfg. */
export class OutcomeUnreachable extends Error {
  readonly sportKey: string;
  readonly label: string;
  constructor(sportKey: string, label: string, why: string) {
    super(`streams: ${sportKey} cannot reach '${label}' — ${why}`);
    this.name = "OutcomeUnreachable";
    this.sportKey = sportKey;
    this.label = label;
  }
}

/** Reachable per the module, but this generator does not build it yet. Every
 *  instance is listed in known-unsupported.ts (Task 3) with the wave that owns it. */
export class GeneratorUnsupported extends Error {
  readonly sportKey: string;
  readonly label: string;
  constructor(sportKey: string, label: string, why: string) {
    super(`streams: ${sportKey} generator does not build '${label}' — ${why}`);
    this.name = "GeneratorUnsupported";
    this.sportKey = sportKey;
    this.label = label;
  }
}
