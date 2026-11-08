// Swiss auto-advance: the constants and the pure derivation (spec
// docs/superpowers/specs/2026-11-08-swiss-auto-advance-design.md §4.1-§4.4 and §4.6; plan Task 3).
//
// From a stage's facts, this decides which auto action is due and whether it is blocked. The server arms and fires
// from it (`stage_auto_actions`, one live row per stage and kind), and the banner renders from it. It holds no state,
// so every call derives everything again from the facts it is given.
//
// Client-safe on purpose: the banner is a client component. The only import is lib/swiss-shell.ts, and the test
// pins that. Whether a board is decided is NOT restated here: the server computes `decided` from usecases/stages.ts's
// DECIDED, the one authority, and passes it in.

import { isSwissBoardSeated, nextUnseatedSwissRound } from "./swiss-shell.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------------

/** The settle window: an action fires only on facts that have been stable this long (spec §4.2, G3). A constant,
 *  not a setting. The e2e override (plan D8) is resolved elsewhere and never changes this default. */
export const AUTO_ADVANCE_SETTLE_MS = 60_000;
/** A `paused` confirm row (a person reviewing the proposal) is released after this long (spec §4.2). */
export const AUTO_ADVANCE_HOLD_MAX_MS = 1_800_000;
/** How long the banner keeps showing the most recent `done` row (spec §4.6). */
export const AUTO_ADVANCE_DONE_VISIBLE_MS = 600_000;
/** How often the banner polls while a live row exists (spec §4.6). */
export const AUTO_ADVANCE_POLL_MS = 10_000;
/** Unexpected errors are retried up to this many attempts, and then the row blocks (spec §4.3). */
export const AUTO_ADVANCE_MAX_ATTEMPTS = 5;
/** How long a firer's claim on a row lasts (the email outbox's lease shape, spec §4.2). */
export const AUTO_ADVANCE_LEASE_MS = 120_000;

// ---------------------------------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------------------------------

export type AutoActionKind = "pair_round" | "complete_stage" | "confirm_handoff";
/** The two kinds a Swiss stage arms on itself; `confirm_handoff` lives on the TARGET stage. */
export type SourceActionKind = Exclude<AutoActionKind, "confirm_handoff">;
export type AutoActionState = "waiting" | "pending" | "paused" | "blocked" | "done" | "cancelled";

/** The live states: at most one row in any of them per (stage, kind). The partial unique index of V497 is built on
 *  exactly this set, and the schema test reads this tuple, so the DB predicate and the code cannot drift. */
export const LIVE_AUTO_ACTION_STATES = ["waiting", "pending", "paused", "blocked"] as const satisfies readonly AutoActionState[];
export type LiveAutoActionState = (typeof LIVE_AUTO_ACTION_STATES)[number];

/** Why a row was cancelled. Only `skip` is sticky for its target; a switch-off then on re-arms. */
export type CancelReason = "skip" | "switch_off" | "superseded";

/** A board as the banner and the STAGE_NOT_READY refusal name it: `board` is the fixture's `seq_in_round`. */
export interface BoardRef {
  fixtureId: string;
  round: number;
  board: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// The source stage: pair the next round, or complete the stage after the last one
// ---------------------------------------------------------------------------------------------------------------------

export interface SourceFixtureFact {
  id: string;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  outcome: unknown;
  ext_key: string | null;
  status: string;
  /** Computed by the server from `DECIDED` (usecases/stages.ts), the one authority. Never restated in lib. */
  decided: boolean;
}

export interface SourceFacts {
  stageStatus: string;
  fixtures: readonly SourceFixtureFact[];
  /** Sticky skips, as `skipKey(kind, round)`: only `cancelled` rows whose reason is `skip`. */
  skipped: ReadonlySet<string>;
}

/** The key a sticky skip is stored and looked up under. It names the kind AND the round, so skipping the pair of
 *  round 3 never skips completing the stage after round 3. */
export function skipKey(kind: SourceActionKind, round: number): string {
  return `${kind}:${round}`;
}

export type DerivedSource =
  | { state: "none" }
  | { state: "waiting"; kind: SourceActionKind; round: number; openBoards: BoardRef[] }
  | { state: "pending"; kind: SourceActionKind; round: number }
  | { state: "blocked"; kind: SourceActionKind; round: number; code: "STAGE_NOT_READY"; boards: BoardRef[] };

const NONE: DerivedSource = { state: "none" };

/** Seated boards that will never settle on their own and need a person (spec §3: "abandoned/cancelled block"). An
 *  abandoned board waits for the organiser to decide or void it; a cancelled one is locked (lib/fixture-status.ts), so
 *  it can never become decided. Counted as merely open, either would hold the row in `waiting` for ever. */
const BLOCKING_BOARD_STATUSES: ReadonlySet<string> = new Set(["abandoned", "cancelled"]);

function boardRefs(fixtures: readonly SourceFixtureFact[]): BoardRef[] {
  return fixtures
    .map((f) => ({ fixtureId: f.id, round: f.round_no, board: f.seq_in_round }))
    .sort((a, b) => a.round - b.round || a.board - b.board);
}

/**
 * Which source action a Swiss stage is due, as a LADDER: the first rung that matches wins, and the order is part of
 * the meaning.
 *
 *  1. No fixtures: none. The empty case comes first, and rung 4's read of the last round needs a row.
 *  2. The stage is complete: none.
 *  3. The next unseated round is round 1: none. Round 1 is always paired by hand (spec §4.1).
 *  4. No unseated round left: complete the stage, and the target is its last round; the scope is every seated
 *     board. Otherwise pair round t, and the scope is the seated boards of round t-1 (what Pair itself checks).
 *  5. An empty scope: none. "The previous round has at least one seated board" (spec §4.1).
 *  6. That kind and round was skipped: none. A skip is sticky for its target only.
 *  7. A scope board is abandoned or cancelled and not decided: blocked STAGE_NOT_READY, naming those boards. Before
 *     rung 8, because such a board needs a person and waiting would never end.
 *  8. A scope board is not decided: waiting, naming the open boards.
 *  9. Otherwise: pending (the settle window counts down).
 */
export function deriveSourceAction(f: SourceFacts): DerivedSource {
  // 1.
  if (f.fixtures.length === 0) return NONE;
  // 2.
  if (f.stageStatus === "complete") return NONE;
  // 3.
  const t = nextUnseatedSwissRound(f.fixtures);
  if (t === 1) return NONE;
  // 4.
  const seated = f.fixtures.filter((x) => isSwissBoardSeated(x));
  const kind: SourceActionKind = t === null ? "complete_stage" : "pair_round";
  const round = t === null ? f.fixtures.reduce((max, x) => Math.max(max, x.round_no), f.fixtures[0]!.round_no) : t;
  const scope = t === null ? seated : seated.filter((x) => x.round_no === t - 1);
  // 5.
  if (scope.length === 0) return NONE;
  // 6.
  if (f.skipped.has(skipKey(kind, round))) return NONE;
  // 7.
  const stuck = scope.filter((x) => BLOCKING_BOARD_STATUSES.has(x.status) && !x.decided);
  if (stuck.length > 0) return { state: "blocked", kind, round, code: "STAGE_NOT_READY", boards: boardRefs(stuck) };
  // 8.
  const open = scope.filter((x) => !x.decided);
  if (open.length > 0) return { state: "waiting", kind, round, openBoards: boardRefs(open) };
  // 9.
  return { state: "pending", kind, round };
}

// ---------------------------------------------------------------------------------------------------------------------
// The target stage: confirm the hand-off proposal
// ---------------------------------------------------------------------------------------------------------------------

export interface ConfirmFacts {
  /** The target stage's most recent seed proposal, or null when none has been drafted. */
  latest: { id: string; status: "draft" | "confirmed" | "stale"; tieCount: number } | null;
  /** A person is reviewing the proposal: the target's live confirm row is `paused`. */
  livePaused: boolean;
}

export type DerivedConfirm =
  | { state: "none" }
  | { state: "pending" | "paused"; proposalId: string }
  | { state: "blocked"; proposalId: string; code: "SEEDING_TIE_UNRESOLVED" };

/**
 * Which confirm action a target stage is due, as a ladder: no proposal, or one that is not a draft, derives none; a
 * tie blocks at once (plan D4, and it outranks a hold: the tie is what the person must fix); a person's hold keeps
 * the row paused; otherwise the draft counts down.
 */
export function deriveConfirmAction(f: ConfirmFacts): DerivedConfirm {
  if (f.latest === null) return { state: "none" };
  if (f.latest.status !== "draft") return { state: "none" };
  if (f.latest.tieCount > 0) return { state: "blocked", proposalId: f.latest.id, code: "SEEDING_TIE_UNRESOLVED" };
  if (f.livePaused) return { state: "paused", proposalId: f.latest.id };
  return { state: "pending", proposalId: f.latest.id };
}

// ---------------------------------------------------------------------------------------------------------------------
// Retry backoff
// ---------------------------------------------------------------------------------------------------------------------

/** One delay per retry below the cap, for attempts 1 to AUTO_ADVANCE_MAX_ATTEMPTS - 1 and no more. The test holds
 *  its length to the constant: a fifth entry, or a cap of six, reds it. */
const RETRY_DELAYS_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000];

/**
 * How long to wait before retrying a row after an unexpected error, given how many attempts have been made. At
 * `AUTO_ADVANCE_MAX_ATTEMPTS` the caller blocks the row (AUTO_ADVANCE_FAILED) instead of retrying, so there is no
 * delay to give there: asking for one, or for anything that is not an attempt from 1 below the cap, is a caller bug
 * and throws.
 */
export function autoActionRetryDelayMs(attemptsMade: number): number {
  // An index off the table (0 or less, the cap or more, a fraction, NaN) reads undefined.
  const delay: number | undefined = RETRY_DELAYS_MS[attemptsMade - 1];
  if (delay === undefined) {
    throw new RangeError(
      `autoActionRetryDelayMs: attemptsMade must be a whole number from 1 to ${AUTO_ADVANCE_MAX_ATTEMPTS - 1}, got ${attemptsMade}`,
    );
  }
  return delay;
}
