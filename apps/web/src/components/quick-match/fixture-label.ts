// A quick match knockout fixture's label, and the label of the seat its winner fills (controller ruling 2026-11-08). The
// ONE place both are decided, so the setup preview (setup-form.tsx) and the home's draw (T5) read the same words:
//
// - a round's fixtures are numbered among its NON-BYE fixtures (a bye is not a match anyone plays);
// - a round with exactly one non-bye fixture is not numbered ("Semi-final", "Quarter-final");
// - the final is never numbered, nor is any role but the semi- and quarter-final (`roundRoleLabel`'s shared names);
// - "winner of" names the feeding card by its own label (ruling m8): the lone semi or quarter is "the semi-final"/"the
//   quarter-final", a numbered one "semi-final n"/"quarter-final n"; a round with no such name is "match n" (D12: the
//   1-based index in play order).
//
// Pure: no "use client", no server module, no copy. It answers a key and its params; the caller says them.
import type { RoundRole } from "@seazn/engine/competition";
import type { MessageKey } from "@/lib/messages";
import { roundRoleLabel } from "@/lib/round-role-label";

export interface FixtureLabel {
  key: MessageKey;
  params?: Record<string, string | number>;
}

function placeInRound(nonByeCount: number, nonByeIndex: number): void {
  if (!Number.isInteger(nonByeCount) || !Number.isInteger(nonByeIndex) || nonByeIndex < 0 || nonByeIndex >= nonByeCount) {
    throw new RangeError(`fixture ${nonByeIndex} of ${nonByeCount} non-bye fixtures: not a place in its round`);
  }
}

/** The shared bracket name of a role, as a key: `roundRoleLabel` stays the one role → word table. */
function roleKey(role: RoundRole): FixtureLabel {
  let out: FixtureLabel | undefined;
  roundRoleLabel((key, vars) => {
    out = vars ? { key, params: vars } : { key };
    return "";
  }, role);
  if (!out) throw new Error(`roundRoleLabel named no key for a ${role.kind} round`);
  return out;
}

/**
 * The card label of the fixture at `nonByeIndex` (0-based) among its round's `nonByeCount` non-bye fixtures. `roundNo`
 * (1-based) names a round that has no role ("Round 2").
 */
export function fixtureLabel(
  role: RoundRole | null,
  roundNo: number,
  nonByeCount: number,
  nonByeIndex: number,
): FixtureLabel {
  placeInRound(nonByeCount, nonByeIndex);
  const alone = nonByeCount === 1;
  if (role === null) {
    if (!Number.isInteger(roundNo) || roundNo < 1) throw new RangeError(`round ${roundNo}: rounds count from 1`);
    return { key: "bracket.round.plain", params: { n: roundNo } };
  }
  if (role.kind === "semi_final") {
    return alone ? { key: "quickMatch.home.semiFinalOnly" } : { key: "quickMatch.home.semiFinal", params: { n: nonByeIndex + 1 } };
  }
  if (role.kind === "quarter_final") {
    return alone
      ? { key: "quickMatch.home.quarterFinalOnly" }
      : { key: "quickMatch.home.quarterFinal", params: { n: nonByeIndex + 1 } };
  }
  return roleKey(role);
}

/**
 * The label of a seat filled by the winner of an earlier fixture: that fixture's round role, its place among the round's
 * non-bye fixtures, and its match number in play order (`matchNo`, 1-based).
 */
export function winnerOfLabel(
  role: RoundRole | null,
  nonByeCount: number,
  nonByeIndex: number,
  matchNo: number,
): FixtureLabel {
  placeInRound(nonByeCount, nonByeIndex);
  if (!Number.isInteger(matchNo) || matchNo < 1) throw new RangeError(`match ${matchNo}: matches count from 1`);
  const alone = nonByeCount === 1;
  if (role?.kind === "semi_final") {
    return alone ? { key: "quickMatch.home.winnerOfTheSemi" } : { key: "quickMatch.home.winnerOfSemi", params: { n: nonByeIndex + 1 } };
  }
  if (role?.kind === "quarter_final") {
    return alone
      ? { key: "quickMatch.home.winnerOfTheQuarter" }
      : { key: "quickMatch.home.winnerOfQuarter", params: { n: nonByeIndex + 1 } };
  }
  return { key: "quickMatch.home.winnerOfMatch", params: { n: matchNo } };
}
