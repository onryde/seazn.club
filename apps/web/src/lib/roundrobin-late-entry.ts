// W5 app PR A, Task 5 (X-CU-4, X-CU-7, X-CU-11; rulebook RB5-L3, L4, L6, L7, L8, L9, L15, L16, RB5-E9; design 2026-11-05 §4.1):
// the pure half of "Add late player" on a started league or group stage. Which case the add takes, which fixtures the newcomer
// owes and where each one goes, and which pool a group newcomer joins. `server/usecases/roundrobin-late-entry.ts` reads the stage,
// asks these questions and writes the answer.
//
// The catch-up set is the engine's own `lateEntryFixtures` rule (engine plan T2, `src/scheduling/catch-up.ts` on the engine's
// main, unreleased in 9.1.0), written here with the engine's field names so app PR B's parity test is a direct compare when it
// swaps this for the engine function. Where the app plan and the engine disagree the engine wins (plan header, F2): appended
// fixtures are ordered leg first (the engine review's ruling G1), then the member's earliest round, then listed order.
//
//   owed = {(newcomer, m, leg) : m in members, leg in 1..legs} minus every line already present for that key (order-free).
//   An owed key whose member holds an UNSTARTED bye slot in that leg -> that bye's round (`bye_slot`), the slot consumed (RB5-L3).
//   A started bye is never touched (RB5-L4). A slot whose member or newcomer already plays in that round is unusable: no round
//   seats an entrant twice.
//   Every other owed key -> its own catch-up round, lastRoundNo + 1, + 2, ... (one fixture per round), ordered by leg, then the
//   member's earliest round among `lines` (RB5-L6), then the member's position in `members` (listed/seed order, F5); a member
//   with no line after every member with one.
//   Home side (RB5-G2): in leg 1 the newcomer alternates along the leg's owed keys in `members` order, away first; in every later
//   leg each pair takes the opposite of its side in the previous leg (an owed fixture's or a line already present).
//
// One difference from the engine, by the app brief (F8): nothing owed is an EMPTY set here and `decideRoundRobinLateEntry` turns
// it into the named refusal (RB5-E9), where the engine throws `nothing_to_add`. Client-safe and strip-types-safe: no import.

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

/** The order-free (pair, leg) key, `rrKey`'s pair-and-leg text without the pool (the set is computed inside one pool). */
const lineKey = (a: string, b: string, leg: number): string => `${a < b ? a : b}:${a < b ? b : a}:L${leg}`;

interface Owed {
  member: string;
  memberIndex: number;
  leg: number;
  home: string;
  away: string;
}

/** The fixtures `newcomer` owes in a started round robin and where each one goes (RB5-L3, L6, L16). Empty when nothing is owed. */
export function catchUpSet(input: CatchUpInput): CatchUpSet {
  const { members, newcomer, legs, lines, byes, lastRoundNo } = input;
  if (members.includes(newcomer)) throw new CatchUpInputError(`${newcomer} is already a member`);
  if (!Number.isInteger(legs) || legs < 1) throw new CatchUpInputError(`legs must be an integer of at least 1, got ${legs}`);
  if (!Number.isInteger(lastRoundNo) || lastRoundNo < 0) throw new CatchUpInputError(`lastRoundNo must be an integer of at least 0, got ${lastRoundNo}`);
  for (const at of [...lines.map((l) => l.roundNo), ...byes.map((b) => b.roundNo)]) {
    if (at > lastRoundNo) throw new CatchUpInputError(`a line or bye sits in round ${at}, after the last drawn round ${lastRoundNo}`);
  }

  const present = new Set(lines.map((l) => lineKey(l.home, l.away, l.leg)));
  // The newcomer's side on each line it already has (true = home): a later leg flips from it.
  const newcomerHome = new Map<string, boolean>();
  for (const l of lines) {
    if (l.home === newcomer || l.away === newcomer) newcomerHome.set(lineKey(l.home, l.away, l.leg), l.home === newcomer);
  }
  // Who already plays in each round: a bye slot there is unusable for anyone already seated.
  const seated = new Map<number, Set<string>>();
  for (const l of lines) seated.set(l.roundNo, (seated.get(l.roundNo) ?? new Set<string>()).add(l.home).add(l.away));
  const earliest = new Map<string, number>();
  for (const l of lines) {
    for (const id of [l.home, l.away]) {
      const seen = earliest.get(id);
      if (seen === undefined || l.roundNo < seen) earliest.set(id, l.roundNo);
    }
  }

  const owed: Owed[] = [];
  for (let leg = 1; leg <= legs; leg++) {
    const keys = new Set<string>();
    let position = 0;
    members.forEach((member, memberIndex) => {
      const key = lineKey(newcomer, member, leg);
      if (present.has(key) || keys.has(key)) return;
      keys.add(key);
      // Leg 1: alternate along the owed list, away first. Later legs: the opposite of this pair's previous-leg side.
      const previousHome = leg === 1 ? undefined : newcomerHome.get(lineKey(newcomer, member, leg - 1));
      const newcomerAway = previousHome === undefined ? position % 2 === 0 : previousHome;
      position++;
      newcomerHome.set(key, !newcomerAway);
      owed.push({ member, memberIndex, leg, home: newcomerAway ? member : newcomer, away: newcomerAway ? newcomer : member });
    });
  }

  const fixtures: CatchUpFixture[] = [];
  const consumedByes: ByeSlot[] = [];
  const toAppend: Owed[] = [];
  for (const o of owed) {
    const slot = byes.find(
      (b) =>
        !b.started &&
        b.entrantId === o.member &&
        b.leg === o.leg &&
        !(seated.get(b.roundNo)?.has(o.member) ?? false) &&
        !(seated.get(b.roundNo)?.has(newcomer) ?? false),
    );
    if (slot === undefined) {
      toAppend.push(o);
      continue;
    }
    consumedByes.push(slot);
    seated.set(slot.roundNo, (seated.get(slot.roundNo) ?? new Set<string>()).add(newcomer));
    fixtures.push({ home: o.home, away: o.away, leg: o.leg, placement: { kind: "bye_slot", roundNo: slot.roundNo } });
  }

  const firstRound = (o: Owed): number => earliest.get(o.member) ?? Number.POSITIVE_INFINITY;
  // An explicit three-way compare (Task 5 m4): two members with no line are both Infinity, and Infinity - Infinity is NaN — a tie
  // only because NaN is falsy. Spelt out, the tie falls to the listed order on purpose.
  const byFirstRound = (x: Owed, y: Owed): number => {
    const a = firstRound(x);
    const b = firstRound(y);
    return a === b ? 0 : a < b ? -1 : 1;
  };
  toAppend.sort((x, y) => x.leg - y.leg || byFirstRound(x, y) || x.memberIndex - y.memberIndex);
  toAppend.forEach((o, k) => {
    fixtures.push({ home: o.home, away: o.away, leg: o.leg, placement: { kind: "catch_up_round", roundNo: lastRoundNo + k + 1 } });
  });

  fixtures.sort((x, y) => x.placement.roundNo - y.placement.roundNo);
  consumedByes.sort((x, y) => x.roundNo - y.roundNo);
  return { fixtures, consumedByes, appendedRounds: toAppend.length };
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
