// Round names are a property of a round's POSITION in the bracket, never of
// how many matches it contains. A double-elim losers bracket has repeated
// 2-match and 1-match rounds, so a count-based namer produces several
// "Semi-finals" and several "Final"s in one bracket (design §2.3).
export type RoundRole =
  | { kind: "round_of"; entrants: number }
  | { kind: "quarter_final" }
  | { kind: "semi_final" }
  | { kind: "final" }
  | { kind: "winners_final" }
  | { kind: "losers_round"; n: number }
  | { kind: "losers_final" }
  | { kind: "grand_final" }
  | { kind: "grand_final_reset" }
  | { kind: "third_place" }
  | { kind: "qualifier1" }
  | { kind: "eliminator" }
  | { kind: "qualifier2" }
  | { kind: "rung"; n: number }
  | { kind: "plain_round"; n: number };

export interface RoundRoleInput {
  stageKind: string;
  lane: "WB" | "LB" | "GF" | null;
  roundInLane: number;
  lastRoundInLane: number;
  isFinal: boolean;
  thirdPlace: boolean;
  conditional: boolean;
  extKey: string | null;
}

// Page-playoff nodes are identified by the generator's own stable ids, which
// is the only place Qualifier 1 and the Eliminator are distinguishable — they
// share a round and a match count.
const PP_ROLE: Record<string, RoundRole> = {
  "pp-q1": { kind: "qualifier1" },
  "pp-elim": { kind: "eliminator" },
  "pp-q2": { kind: "qualifier2" },
  "pp-final": { kind: "final" },
};

export function roundRole(input: RoundRoleInput): RoundRole {
  const { stageKind, lane, roundInLane, lastRoundInLane, thirdPlace, conditional, extKey } = input;

  if (thirdPlace) return { kind: "third_place" };

  if (stageKind === "page_playoff" && extKey) {
    const role = PP_ROLE[extKey];
    if (role) return role;
  }

  if (stageKind === "stepladder") {
    return roundInLane === lastRoundInLane ? { kind: "final" } : { kind: "rung", n: roundInLane + 1 };
  }

  if (lane === "GF") return conditional ? { kind: "grand_final_reset" } : { kind: "grand_final" };
  if (lane === "LB") {
    return roundInLane === lastRoundInLane
      ? { kind: "losers_final" }
      : { kind: "losers_round", n: roundInLane + 1 };
  }

  const fromEnd = lastRoundInLane - roundInLane;
  // In a double-elim the winners' bracket final is NOT the tournament final —
  // the grand final is, and it lives in the GF lane handled above.
  if (fromEnd === 0) return lane === "WB" ? { kind: "winners_final" } : { kind: "final" };
  if (fromEnd === 1) return { kind: "semi_final" };
  if (fromEnd === 2) return { kind: "quarter_final" };
  return { kind: "round_of", entrants: 2 ** (fromEnd + 1) };
}
