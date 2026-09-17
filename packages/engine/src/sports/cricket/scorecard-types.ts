// Spectator match centre — cricket scorecard shape (spectator-surface design,
// "The shared model"). Types only: `scorecard.ts` folds a ledger into this
// shape; nothing here computes anything.
import type { FidelityBand } from "../../sport/module.ts";
import type { CricketMargin } from "./cricket.ts";

export type SideId = string;
export type PersonId = string;

export type DismissalKind =
  | "bowled" | "caught" | "lbw" | "runout" | "stumped" | "hitwicket"
  | "retired" | "obstructed" | "timedout" | "hitballtwice";

export interface BattingLine {
  order: number;                 // 1-based batting position
  person: PersonId;
  runs: number;
  balls: number;
  fours: number | null;          // null when the ledger cannot say (band 2)
  sixes: number | null;
  strikeRate: number | null;     // runs*100/balls, null when balls === 0
  dismissal:
    | { kind: "not_out" }
    | { kind: "out_unknown" }    // band 2: the line said out, nothing more
    | { kind: DismissalKind; bowler: PersonId | null; fielder: PersonId | null; fielderAssist: PersonId | null };
}

export interface BowlingLine {
  person: PersonId;
  legalBalls: number;
  overs: string;                 // "2.3"
  maidens: number | null;        // null at band 2
  runs: number;
  wickets: number;
  economy: number | null;        // runs*6/legalBalls, null when legalBalls === 0
  wides: number | null;
  noBalls: number | null;
}

export type BallGlyph =
  | { kind: "runs"; runs: number } // 0/1/2/3/4/6 in practice
  | { kind: "wide"; runs: number }
  | { kind: "noball"; runs: number }
  | { kind: "bye" | "legbye" | "penalty"; runs: number }
  | { kind: "wicket"; dismissal: DismissalKind };

export interface OverLog {
  number: number;                // 1-based
  bowler: PersonId | null;
  balls: BallGlyph[];
  runs: number;                  // conceded in the over (all runs incl. extras)
  wickets: number;
  scoreAfter: { runs: number; wickets: number };
}

export interface FallOfWicket {
  wicket: number;                // 1-based
  runs: number;                  // team score at the fall
  over: string;                  // "3.2"
  batter: PersonId;
}

export interface Partnership {
  batters: [PersonId, PersonId];
  runs: number;
  balls: number;
  wicket: number | "unbroken";
}

export interface CricketInningsCard {
  number: number;                // 1-based
  side: SideId;
  isSuperOver: boolean;
  declared: boolean;
  closed: boolean;
  total: { runs: number; wickets: number; legalBalls: number; overs: string; runRate: number | null };
  extras: { wides: number; noBalls: number; byes: number; legByes: number; penalties: number; total: number } | null; // null at band ≤ 2
  batting: BattingLine[];
  didNotBat: PersonId[];
  bowling: BowlingLine[];
  fallOfWickets: FallOfWicket[];
  partnerships: Partnership[];
  overs: OverLog[];
}

export interface CricketLive {
  battingSide: SideId;
  striker: PersonId | null;
  nonStriker: PersonId | null;
  bowler: PersonId | null;
  thisOver: BallGlyph[];
  partnership: { runs: number; balls: number } | null;
  lastWicket: { batter: PersonId; runs: number; balls: number; scoreAt: string } | null;
  crr: number | null;
  target: number | null;
  rrr: number | null;
  needRuns: number | null;
  ballsLeft: number | null;
  projected: number | null;
}

export interface CricketScorecard {
  band: FidelityBand;            // max band present in the ledger
  toss: { wonBy: SideId; elected: "bat" | "bowl" } | null;
  innings: CricketInningsCard[];
  live: CricketLive | null;
  result: { headline: string; margin: CricketMargin | null; winner: SideId | null } | null; // from cricket.summary / outcome
}
