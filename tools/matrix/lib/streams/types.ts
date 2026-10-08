import type { SETTLE_METHODS, StageKind } from "@seazn/engine/core";
import type { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";

export type Side = "home" | "away";

/** W2a: the organiser's three ways to close a match no play decided (engine core, X-ST-1). */
export type SettleMethod = (typeof SETTLE_METHODS)[number];
/** W2a: a chess bracket game's tie-break rungs (BG-KO-1). Lots is the organiser's settle, not a rung. */
export type TiebreakRung = (typeof TIEBREAK_RUNGS)[number];

export type RequestedOutcome =
  | { readonly kind: "win"; readonly winner: Side }
  | { readonly kind: "draw" }
  | { readonly kind: "forfeit"; readonly by: Side; readonly reason: "walkover" | "retired hurt" }
  /** `atScore`: W2a (spec §5.6.1) — abandoned with something on the board, not at 0–0: the sport's own win
   *  stream cut one event before it decides. Absent = the old `[START, core.abandon]`, byte for byte. */
  | { readonly kind: "abandon"; readonly atScore?: true }
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
  /** W2a: a drawn chess bracket game decided by the scorer-recorded tie-break (BG-KO-1, ruling 82: the scorer
   *  records the winner on every rung). Boardgame only. */
  | { readonly kind: "tiebreak"; readonly rung: TiebreakRung; readonly winner: Side };

export type DecidedOutcome = Extract<RequestedOutcome, { kind: "win" | "draw" }>;

export const ALL_OUTCOMES: readonly RequestedOutcome[] = Object.freeze([
  { kind: "win", winner: "home" },
  { kind: "win", winner: "away" },
  { kind: "draw" },
  { kind: "forfeit", by: "away", reason: "walkover" },
  { kind: "forfeit", by: "home", reason: "retired hurt" },
  { kind: "abandon" },
  { kind: "tie" },
]);

export function outcomeLabel(o: RequestedOutcome): string {
  switch (o.kind) {
    case "win": return `win-${o.winner}`;
    case "draw": return "draw";
    case "forfeit": return `forfeit-${o.by}-${o.reason === "walkover" ? "walkover" : "retired"}`;
    case "abandon": return o.atScore === true ? "abandon-at-score" : "abandon";
    case "tie": return "tie";
    case "level": return "level";
    case "settle": return `settle-${o.then}-${o.method}-after-${o.after}`;
    case "tiebreak": return `tiebreak-${o.rung}-${o.winner}`;
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
  /** W2a: a drawn game followed by the scorer's tie-break (BG-KO-1). Absent where the sport has no such phase. */
  tiebreak?(req: StreamRequest & { readonly outcome: Extract<RequestedOutcome, { kind: "tiebreak" }> }): StreamEvent[];
}

/** Always first: boardgame refuses a forfeit outside `live`, and every kernel but
 *  generic needs it (plan-facts-sports.md "Harness cautions"). */
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
