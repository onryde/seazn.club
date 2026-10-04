import type { StageKind } from "@seazn/engine/core";

export type Side = "home" | "away";

export type RequestedOutcome =
  | { readonly kind: "win"; readonly winner: Side }
  | { readonly kind: "draw" }
  | { readonly kind: "forfeit"; readonly by: Side; readonly reason: "walkover" | "retired hurt" }
  | { readonly kind: "abandon" }
  /** Level scores that stand as a tie (cricket decideTie, ruling 44). A sport
   *  generator builds it only through `tied`; one that declares none cannot
   *  reach it (OutcomeUnreachable). */
  | { readonly kind: "tie" };

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
    case "abandon": return "abandon";
    case "tie": return "tie";
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
