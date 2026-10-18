// The check-in line's order checkers (spec §5.6.8, §8.1 test 13): pure functions over the ledger's own facts, shared by the
// load harness (which reads them off fixture_seat_line after a run) and by the vitest suite that proves the checkers can fail
// (external-play-line-order.test.ts). Times are epoch milliseconds. Every checker reports HOW MANY it looked at: zero looked
// at is a failure of the run, not a pass (TEST-STRATEGY, anti-vacuity).

export type StayFacts = {
  id: string;
  firstClaimAt: number;
  queuedAt: number | null;
  admittedAt: number | null;
  servedAt: number | null;
};

/** ADMISSION order is the order of arrival (§5.7.3, "Order is kept by admission, not by completion"): among the stays the budget
 *  held and then admitted, `a` arrived before `b` means `a` was admitted before `b`. An inversion is a pair where it was not. A
 *  stay admitted without ever being held is not in line and is out of the pairs, as it is out of the line itself. */
export function admissionInversions(stays: StayFacts[]): { pairs: number; inversions: number; examples: [string, string][] } {
  const admitted = stays.filter((s) => s.queuedAt !== null && s.admittedAt !== null);
  let pairs = 0;
  const examples: [string, string][] = [];
  for (let i = 0; i < admitted.length; i += 1) {
    for (let j = i + 1; j < admitted.length; j += 1) {
      const a = admitted[i]!;
      const b = admitted[j]!;
      if (a.firstClaimAt === b.firstClaimAt) continue; // a tie has no order to invert
      pairs += 1;
      const [early, late] = a.firstClaimAt < b.firstClaimAt ? [a, b] : [b, a];
      if (early.admittedAt! > late.admittedAt!) examples.push([early.id, late.id]);
    }
  }
  return { pairs, inversions: examples.length, examples };
}

/** COMPLETION order is not the line's order (fix 3): two stays warm their cameras at once and the faster is served first. A
 *  reorder is a pair admitted in one order and served in the other. Counted APART from inversions, never as one. */
export function completionReorders(stays: StayFacts[]): { pairs: number; reorders: number } {
  const served = stays.filter((s) => s.admittedAt !== null && s.servedAt !== null);
  let pairs = 0;
  let reorders = 0;
  for (let i = 0; i < served.length; i += 1) {
    for (let j = i + 1; j < served.length; j += 1) {
      const [a, b] = served[i]!.admittedAt! <= served[j]!.admittedAt! ? [served[i]!, served[j]!] : [served[j]!, served[i]!];
      if (a.admittedAt === b.admittedAt) continue;
      pairs += 1;
      if (a.servedAt! > b.servedAt!) reorders += 1;
    }
  }
  return { pairs, reorders };
}

/** One position a client was SHOWN (`line.position` of a `queued` answer). */
export type PositionSample = { id: string; at: number; position: number };

export type Rise = { id: string; from: number; to: number; between: [number, number]; cause: string | null };

/** A player's number must not go UP. It can, once and for a reason the ledger shows (§8.1 test 13 (e), the re-review's N3): a stay
 *  that arrived EARLIER was first held after the samples (a pass on an empty line whose next claim the budget then deferred), so it
 *  entered the line ahead of this one. A rise is EXCUSED when such a stay exists - one whose `queuedAt` falls between the two
 *  samples and whose `firstClaimAt` is before this stay's - and the cause is named; every other rise is UNEXCUSED. */
export function positionRises(
  samples: PositionSample[],
  stays: StayFacts[],
): { looked: number; excused: Rise[]; unexcused: Rise[] } {
  const byId = new Map<string, PositionSample[]>();
  for (const s of samples) byId.set(s.id, [...(byId.get(s.id) ?? []), s]);
  const excused: Rise[] = [];
  const unexcused: Rise[] = [];
  let looked = 0;
  for (const [id, list] of byId) {
    const mine = stays.find((s) => s.id === id);
    const ordered = [...list].sort((a, b) => a.at - b.at);
    for (let k = 1; k < ordered.length; k += 1) {
      const prev = ordered[k - 1]!;
      const cur = ordered[k]!;
      looked += 1;
      if (cur.position <= prev.position) continue;
      const cause =
        mine === undefined
          ? undefined
          : stays.find((x) => x.id !== id && x.queuedAt !== null && x.queuedAt > prev.at && x.queuedAt <= cur.at && x.firstClaimAt < mine.firstClaimAt);
      const rise: Rise = { id, from: prev.position, to: cur.position, between: [prev.at, cur.at], cause: cause?.id ?? null };
      (cause ? excused : unexcused).push(rise);
    }
  }
  return { looked, excused, unexcused };
}
