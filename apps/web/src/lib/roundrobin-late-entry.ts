// W5 app PR A, Task 5 (X-CU-4, X-CU-7, X-CU-11; rulebook RB5-L3, L4, L6, L7, L8, L9, L15, L16, RB5-E9; design 2026-11-05 §4.1):
// the pure half of "Add late player" on a started league or group stage. Which case the add takes, which fixtures the newcomer
// owes and where each one goes, and which pool a group newcomer joins. `server/usecases/roundrobin-late-entry.ts` reads the stage,
// asks these questions and writes the answer.
//
// The catch-up set IS the engine's `lateEntryFixtures` (engine 10, `src/scheduling/catch-up.ts`; app PR B Task 3, FX-G1): this
// module only calls it and names its answers in the app's terms. The engine's rule, for the reader:
//
//   owed = {(newcomer, m, leg) : m in members, leg in 1..legs} minus every line already present for that key (order-free).
//   An owed key whose member holds an UNSTARTED bye slot in that leg -> that bye's round (`bye_slot`), the slot consumed (RB5-L3).
//   A started bye is never touched (RB5-L4). A slot whose member or newcomer already plays in that round is unusable.
//   Every other owed key -> its own catch-up round, lastRoundNo + 1, + 2, ... (one fixture per round), ordered by leg, then the
//   member's earliest round among `lines` (RB5-L6), then the member's position in `members` (listed/seed order, F5).
//   Home side (RB5-G2): in leg 1 the newcomer alternates along the leg's owed keys in `members` order, away first; in every later
//   leg each pair takes the opposite of its side in the previous leg.
//
// The engine refuses by name (CONFIG_INVALID). `nothing_to_add` (RB5-E9) is the app's EMPTY set here, which
// `decideRoundRobinLateEntry` turns into RR_LATE_ENTRY_NOTHING_TO_ADD (F8); every other refusal (`newcomer_is_member`,
// `legs_invalid`, `last_round_invalid`, `last_round_below_lines`) is a caller handing the rule something no stage can hold - a
// programming error, thrown as `CatchUpInputError` carrying the engine's reason name.
import { EngineError } from "@seazn/engine/core";
import { lateEntryFixtures } from "@seazn/engine/scheduling";

export interface ExistingLine {
  home: string;
  away: string;
  roundNo: number;
  leg: number;
}

export interface ByeSlot {
  entrantId: string;
  roundNo: number;
  leg: number;
  /** The caller's K4 predicate over the bye's round: a score event, live play, a decided result, or a call to a court. */
  started: boolean;
}

export interface CatchUpFixture {
  home: string;
  away: string;
  leg: number;
  placement: { kind: "bye_slot" | "catch_up_round"; roundNo: number };
}

export interface CatchUpInput {
  /** The pool's (or the league's) members still in the field, in listed (seed) order, the newcomer not among them. */
  members: readonly string[];
  newcomer: string;
  legs: number;
  lines: readonly ExistingLine[];
  byes: readonly ByeSlot[];
  /** The last drawn round (stage-wide: catch-up rounds are numbered after every round the stage holds, R24 assumption). */
  lastRoundNo: number;
}

export interface CatchUpSet {
  /** By placement round. */
  fixtures: CatchUpFixture[];
  /** The bye slots the set plays in, by round; the caller's own objects. */
  consumedByes: ByeSlot[];
  appendedRounds: number;
}

/** A caller handed the catch-up rule something no stage can hold: a programming error, thrown by name (never normalised). */
export class CatchUpInputError extends Error {
  constructor(reason: string) {
    super(`catchUpSet: ${reason}`);
    this.name = "CatchUpInputError";
  }
}

/** The fixtures `newcomer` owes in a started round robin and where each one goes (RB5-L3, L6, L16): the engine's
 *  `lateEntryFixtures`. Empty when nothing is owed (the engine's `nothing_to_add`). */
export function catchUpSet(input: CatchUpInput): CatchUpSet {
  try {
    return lateEntryFixtures(input);
  } catch (err) {
    if (!EngineError.is(err) || err.code !== "CONFIG_INVALID") throw err;
    const reason = (err.data as { reason?: unknown } | undefined)?.reason;
    if (reason === "nothing_to_add") return { fixtures: [], consumedByes: [], appendedRounds: 0 };
    throw new CatchUpInputError(`${String(reason)}: ${err.message}`);
  }
}

export type RoundRobinLateDecision =
  | { case: "refused"; code: "RR_LATE_ENTRY_STAGE_COMPLETE" | "RR_LATE_ENTRY_NOTHING_TO_ADD" }
  /** Nothing in the stage has started (RB5-L7): Rebuild is offered, with this catch-up set as the alternative on the same notice
   *  (RB5-L15) - the set the add writes unless the organiser asked to rebuild. */
  | ({ case: "rebuild_offered"; catchUp: CatchUpFixture[] } & Omit<CatchUpSet, "fixtures">)
  | ({ case: "catch_up" } & CatchUpSet);

/**
 * RB5-L15: the cases in order — the stage is complete -> refused by name (RB5-L8); nothing owed -> refused by name, never an
 * empty success (RB5-E9, F8); nothing in the stage started -> Rebuild offered beside the catch-up (RB5-L7); otherwise catch-up
 * (RB5-L3). There is no no-op.
 */
export function decideRoundRobinLateEntry(input: { stageComplete: boolean; stageStarted: boolean } & CatchUpInput): RoundRobinLateDecision {
  if (input.stageComplete) return { case: "refused", code: "RR_LATE_ENTRY_STAGE_COMPLETE" };
  const set = catchUpSet(input);
  if (set.fixtures.length === 0) return { case: "refused", code: "RR_LATE_ENTRY_NOTHING_TO_ADD" };
  if (!input.stageStarted) return { case: "rebuild_offered", catchUp: set.fixtures, consumedByes: set.consumedByes, appendedRounds: set.appendedRounds };
  return { case: "catch_up", ...set };
}

/** The pool keys in snake order (`A`, `B`, ...). */
const POOL_KEY_ORDER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The pool (its index in key order) the seeded snake gives the `i`-th entrant (0-based) over `count` pools — `snakeDistribute`'s
 *  own walk (stages/generators.ts): 1..N, then N..1, repeating. */
function snakePool(i: number, count: number): number {
  const lap = Math.floor(i / count);
  const pos = i % count;
  return lap % 2 === 0 ? pos : count - 1 - pos;
}

/**
 * RB5-L9 (X-CU-11): the pool a group newcomer joins by default — the smallest; ties go to the pool the seed snake would give the
 * (n+1)th seed, n being the members already in the pools. When that pool is not among the smallest, the next one the snake walks
 * to that is. `pools` maps a pool key to its members still in the field.
 */
export function choosePool(pools: ReadonlyMap<string, readonly string[]>): string {
  if (pools.size === 0) throw new CatchUpInputError("choosePool: no pool to choose");
  const keys = [...pools.keys()].sort((a, b) => POOL_KEY_ORDER.indexOf(a) - POOL_KEY_ORDER.indexOf(b));
  if (keys.some((k) => !POOL_KEY_ORDER.includes(k) || k.length !== 1)) throw new CatchUpInputError(`choosePool: a pool key is not a letter (${keys.join(",")})`);
  const smallest = Math.min(...keys.map((k) => pools.get(k)!.length));
  const tied = new Set(keys.filter((k) => pools.get(k)!.length === smallest));
  const n = keys.reduce((sum, k) => sum + pools.get(k)!.length, 0);
  for (let i = n; i < n + 2 * keys.length; i++) {
    const key = keys[snakePool(i, keys.length)]!;
    if (tied.has(key)) return key;
  }
  throw new CatchUpInputError("choosePool: the snake reached no smallest pool"); // two laps visit every pool: unreachable
}

/** A catch-up line's `ext_key`: `rr-by-` for a fixture played in a consumed bye's round, `rr-cu-` for an appended catch-up round,
 *  with the pool's `p{key}-` in front and the leg stored on the tail (`-L{leg}`), as every round-robin line carries it. */
export function rrCatchUpExtKey(prefix: string, kind: CatchUpFixture["placement"]["kind"], roundNo: number, seq: number, leg: number): string {
  return `${prefix}rr-${kind === "bye_slot" ? "by" : "cu"}-r${roundNo}-c${seq}-L${leg}`;
}

/** Whether a stored `ext_key` is a catch-up line's (`rrCatchUpExtKey`): the desk's unscheduled catch-up count reads it. */
export function isCatchUpExtKey(extKey: string | null): boolean {
  return extKey !== null && /^(?:p[^-]*-)?rr-(?:cu|by)-r\d+-c\d+-L\d+$/.test(extKey);
}

/** W5 T23 (X-CU-7; R24 pick 2A): whether a stored `ext_key` is a line of an APPENDED catch-up round (`rr-cu-`), never a consumed
 *  bye's (`rr-by-`, which plays in a round the draw already had). The board's and the public list's round bar say "Catch-up" on a
 *  round holding one: the round keeps its number (stage-wide), the tag adds the one new fact. */
export function isCatchUpRoundExtKey(extKey: string | null | undefined): boolean {
  return extKey != null && /^(?:p[^-]*-)?rr-cu-r\d+-c\d+-L\d+$/.test(extKey);
}
