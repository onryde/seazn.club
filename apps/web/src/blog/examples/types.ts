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
export interface BracketFeed {
  /** The `id` of the match the seat is filled from. */
  id: string;
  /** `winner`: the winner goes on (a solid line). `loser`: the loser goes here (a dashed one). */
  side: "winner" | "loser";
}

/** One match of a bracket diagram: the two seats, who won, and where each seat's player came from. */
export interface BracketMatchModel {
  /** Names the match for a later `homeFrom` / `awayFrom`; a match nobody feeds from may leave it out. */
  id?: string;
  /** The seat's player as the page prints it ("Ana (1)"). `null`: a bye, nobody on that side. */
  home: string | null;
  away: string | null;
  /** One of the two seat strings above. */
  winner?: string;
  /** The product's name for the round ("Semi-finals", "Qualifier 1"), printed above the box. */
  label?: string;
  /** Matches of different lanes are stacked in separate blocks, each headed by its name (one figure, two formats). */
  lane?: string;
  homeFrom?: BracketFeed;
  awayFrom?: BracketFeed;
  /** A short word printed beside a seat's player ("plate", "walkover"), keyed by the seat string. */
  tags?: Record<string, string>;
}

export type DiagramModel =
  | {
      kind: "bracket";
      title: string;
      /** The COLUMNS, left to right; the builder lays them out so every feed comes from an earlier column. */
      rounds: { name: string; matches: BracketMatchModel[] }[];
    }
  | {
      kind: "swissRound";
      title: string;
      round: number;
      pairings: { board: number; first: string; second: string | null; result?: string }[];
      byes: string[];
    }
  | { kind: "roundRobinWheel"; title: string; fixed: string; rotating: string[]; round: number }
  | {
      kind: "groupsToBracket";
      title: string;
      groups: { name: string; entrants: string[]; advancing: number }[];
      bracket: { name: string; matches: { home: string | null; away: string | null }[] }[];
    }
  | { kind: "ladder"; title: string; rungs: string[]; challenger: string; target: string; swapped: boolean }
  // ---- batch 5, fix round 1 (M9): one picture for each of the walkover posts ----
  /** A walkover in a bracket: rounds left to right, each match with its two sides (a seat not filled reads as the words the
   *  example gives it), the sides to strike (the ones that left or did not turn up), the sides that are not a player at all ("nobody", "not known yet":
   *  drawn muted and italic, never as a name), the winner, and one short result line. `sides` is two strings, which the claims check. */
  | {
      kind: "walkoverBracket";
      title: string;
      rounds: { name: string; matches: { sides: string[]; struck?: string[]; vacant?: string[]; winner?: string; result: string }[] }[];
    }
  /** One tile per sport: its name and the score a walkover shows there (the example's own words, never a key). */
  | { kind: "scoreTiles"; title: string; tiles: { sport: string; score: string }[] };

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

interface BlogExampleBase {
  id: string;
  /** The sports it sweeps. A single-sport example says why it is one. */
  sports: SportKey[] | "all";
  singleSportReason?: string;
  claims: Claim[];
}

/** `engine`: a pure call into the engine (and the app's pure readers); `build()` regenerates the golden in the unit run. */
export interface EngineExample extends BlogExampleBase {
  kind: "engine";
  build(): ExampleResult;
}

/**
 * `server` (batch 5, Task 11): a rule the APP owns, run inside a database transaction with no pure function to call (the
 * ladder's challenge reach and swap). Its golden is regenerated and compared by the env-gated DB test named in `runner`,
 * which drives the real usecases; the unit harness checks the claims against the committed golden, and that the runner
 * exists and names this example. There is no `build()`: without a database there is nothing to run.
 */
export interface ServerExample extends BlogExampleBase {
  kind: "server";
  /** The DB test that runs the example through the real usecases, relative to apps/web. */
  runner: string;
}

export type BlogExample = EngineExample | ServerExample;
