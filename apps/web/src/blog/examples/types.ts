// The shapes the example harness shares. Client-safe on purpose: no fs, no engine import. A page renders from an
// ExampleResult read out of the committed golden; the engine runs only in the regenerate test and in
// UPDATE_BLOG_EXAMPLES=1 (design: "Generated examples").
import type { SportKey } from "@/lib/blog";

export type Cell = string | number;

export interface ExampleTable {
  caption: string;
  columns: string[];
  rows: Cell[][];
}

/**
 * What a diagram component draws. A tagged union: each member is the model of ONE diagram, and the component
 * that draws it lands with the first post that needs it (design: "Pictures and diagrams"). Task 3 declares the
 * types only; a member's fields are the minimum its diagram needs and may be widened by that component's task.
 * Every member carries `title`, which the SVG's <title> and its caption repeat in text.
 */
export type DiagramModel =
  | {
      kind: "bracket";
      title: string;
      rounds: { name: string; matches: { home: string | null; away: string | null; winner?: string }[] }[];
    }
  | {
      // Batch 3 widened this (the Swiss round grid, components/blog/swiss-round-diagram.tsx): one round's boards with each
      // side's score going in, the colours (chess), the boards that pair across scores (a float), the byes, and the players
      // the round did not seat (a late entrant not yet in, a player who has left).
      kind: "swissRound";
      title: string;
      round: number;
      pairings: {
        board: number;
        first: string;
        second: string | null;
        result?: string;
        /** Points each side takes into the round, as the table prints them. */
        firstScore?: string;
        secondScore?: string;
        /** Chess only: `first` has White. Absent, the diagram draws no colours. */
        firstWhite?: boolean;
        /** The board seats two different scores. */
        float?: boolean;
      }[];
      byes: string[];
      notSeated?: { name: string; why: string }[];
    }
  | { kind: "roundRobinWheel"; title: string; fixed: string; rotating: string[]; round: number }
  | {
      kind: "groupsToBracket";
      title: string;
      groups: { name: string; entrants: string[]; advancing: number }[];
      bracket: { name: string; matches: { home: string | null; away: string | null }[] }[];
    }
  | { kind: "ladder"; title: string; rungs: string[]; challenger: string; target: string; swapped: boolean }
  | { kind: "partnerGrid"; title: string; players: string[]; rounds: { pairs: [string, string][] }[] };

/** What an example produces, and what the committed golden holds: plain JSON, nothing that needs the engine to read. */
export interface ExampleResult {
  /** Values a post cites with `{{fact:<id>.<key>}}`. Strings are what the reader sees ("½"), never a key. */
  facts: Record<string, string | number>;
  table?: ExampleTable;
  diagram?: DiagramModel;
  /**
   * Every other sentence the example prints; scanned by the leak sweep with the caption and the cells. These lines are
   * for the sweep and for a reviewer: they may carry scores the engine made up for the match it played ("25-0"), so a
   * page must NOT render them as facts about the sport. Anything a post shows a reader is a fact or a table cell.
   */
  text: string[];
}

/**
 * One statement the result must keep true. `check` reads a DECLARATION (a sport module's `tablePointsRule`,
 * `primaryTableKey`, ...) or the named rulebook, and compares the result to it. It never compares the result to
 * itself or to `build()`'s own intermediate values (TEST-STRATEGY). It returns true, or false / a message when
 * the result is wrong, and it never throws on a result that lacks what it looks for: a missing value is a failure.
 */
export interface Claim {
  says: string;
  /** The declaration or rulebook article the expected value comes from. */
  source: string;
  /** The sport the claim is about, for the per-sport sweep (an `all` example has a claim set per registry sport). */
  sport?: SportKey;
  check(result: ExampleResult): boolean | string;
}

export interface BlogExample {
  id: string;
  /** `engine`: a pure call into the engine. `server`: a rule the app owns, checked by an env-gated DB test. */
  kind: "engine" | "server";
  /** The sports it sweeps. A single-sport example says why it is one. */
  sports: SportKey[] | "all";
  singleSportReason?: string;
  build(): ExampleResult;
  claims: Claim[];
}
