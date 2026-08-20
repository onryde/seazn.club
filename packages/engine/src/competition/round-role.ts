// Round names are a property of a round's POSITION in the bracket, never of
// how many matches it contains. A double-elim losers bracket has repeated
// 2-match and 1-match rounds, so a count-based namer produces several
// "Semi-finals" and several "Final"s in one bracket (design §2.3).
import { BRACKET_STAGE_KINDS } from "./progression.ts";

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

// The stage kinds whose rounds are BRACKET POSITIONS — imported, never
// re-declared. `progression.ts` already owns this set and apps/web's
// `bracket-kinds-sync.test.ts` already pins its hand-copied siblings against
// it; a fifth copy here would be one more thing that test does not know to
// check. Every other kind (`league`, `group`, `swiss`, `americano`, `ladder`)
// numbers its rounds as a plain dense sequence and gets `plain_round` below,
// which is what lets `roundRole()` answer for EVERY stage kind — its three
// display consumers each used to keep their own copy of this set purely as a
// GUARD in front of a call this function could not safely take.

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

  // A round-robin-kind stage (`league`/`group`) or any other non-bracket kind
  // has no bracket position to read a role off: its rounds are a dense
  // ordinal sequence, so the role IS the ordinal. Answered FIRST — ahead of
  // even `thirdPlace` — because every field below it (`lane`, the
  // `lastRoundInLane - roundInLane` distance, the `third_place` flag) is a
  // bracket fact that a non-bracket fixture carries only at its column
  // default, and reading those defaults as bracket positions is exactly how a
  // league's round 1 would come back as "Final" (`fromEnd === 0`).
  //
  // `roundInLane + 1` rather than the raw `round_no`: this is the fixture's
  // position within its own lane's SORTED round list (`laneRoundRank`), the
  // same 1-based rank `rung` and `losers_round` below already report, so a
  // sparse or non-1-based `round_no` sequence still names round one "Round 1".
  if (!BRACKET_STAGE_KINDS.has(stageKind)) return { kind: "plain_round", n: roundInLane + 1 };

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

// ---------------------------------------------------------------------------
// Round roles as a STORAGE KEY (#622 — round-scoped required court tags).
//
// A rule an organiser writes against one round of a stage ("only the final
// needs the championship court") has to name that round in a form that
// survives a round being added, removed or renumbered. `fixtures.round_no` is
// NOT that form, and `constraints.ts`'s own `FixtureSelector` already says why
// in as many words: "an elimination bracket numbers sparsely (1,2,3 winners /
// 7-10 losers / 14 grand final) and a USER-FACING RULE keyed on one would
// silently address the wrong fixtures". The same objection applies verbatim to
// a required-court-tag rule, so round-scoped tags are keyed by ROLE — the
// position-derived answer this module already computes for display — and the
// key below is that role's stable serialisation.
//
// Consequences worth stating, because they are the point rather than side
// effects:
//
//   * A knockout stage whose entrant count changes renumbers every round_no
//     and keeps every role: "the final" is still `final` at 8 entrants and at
//     64. A rule written once keeps addressing what the organiser meant.
//   * `plain_round_N` is a real, addressable role (see `roundRole` above), so
//     a round-robin-kind stage — where "round" is an ordinal and not a bracket
//     position — is expressible in the SAME vocabulary rather than needing a
//     second, parallel keying scheme. That is the open question #622 raised
//     ("how it interacts with round-robin-kind stages"), answered by making
//     the ordinal a role instead of making the role an ordinal.
//   * WB/LB/GF are distinct role families (`winners_final` vs `losers_final`
//     vs `grand_final`), so a double-elim stage can tag the grand final alone
//     without touching the losers bracket that feeds it — which raw round_no
//     could not express at all, the lanes sharing one numbering space.
// ---------------------------------------------------------------------------

/**
 * A role's stable, storable key: `snake_case` kind, with the role's own
 * parameter appended for the three parameterised families.
 *
 * Deliberately NOT `JSON.stringify(role)` — key order and future field
 * additions would both change the bytes of an already-stored key, and this
 * value is a primary-key column (`stage_round_court_tags.round_role`).
 */
export function roundRoleKey(role: RoundRole): string {
  switch (role.kind) {
    case "round_of":
      return `round_of_${role.entrants}`;
    case "losers_round":
      return `losers_round_${role.n}`;
    case "rung":
      return `rung_${role.n}`;
    case "plain_round":
      return `plain_round_${role.n}`;
    default:
      return role.kind;
  }
}

/** Every non-parameterised kind, as its own key. */
const SIMPLE_ROLE_KINDS: ReadonlySet<string> = new Set([
  "quarter_final",
  "semi_final",
  "final",
  "winners_final",
  "losers_final",
  "grand_final",
  "grand_final_reset",
  "third_place",
  "qualifier1",
  "eliminator",
  "qualifier2",
]);

const PARAMETERISED_ROLE_KEY = /^(round_of|losers_round|rung|plain_round)_([1-9]\d{0,3})$/;

/**
 * Parse a stored key back to a role, or `null` when it names no role at all.
 *
 * The WRITE path's validator (a stored key is a primary key: a typo becomes a
 * row that silently matches no fixture forever) and the only way back to a
 * `RoundRole` for display — `roundRoleLabel` takes the typed role, never a
 * string, so a stored key reaches a locale dictionary through here or not at
 * all.
 *
 * A parameter is bounded at four digits deliberately: `round_of_65536` is not
 * a bracket anybody plays, and an unbounded `\d+` lets a stored key carry an
 * arbitrarily long integer into `2 ** n` arithmetic downstream.
 */
export function parseRoundRoleKey(key: string): RoundRole | null {
  if (SIMPLE_ROLE_KINDS.has(key)) return { kind: key } as RoundRole;
  const m = PARAMETERISED_ROLE_KEY.exec(key);
  if (m === null) return null;
  const n = Number(m[2]);
  switch (m[1]) {
    case "round_of":
      return { kind: "round_of", entrants: n };
    case "losers_round":
      return { kind: "losers_round", n };
    case "rung":
      return { kind: "rung", n };
    default:
      return { kind: "plain_round", n };
  }
}

/** `parseRoundRoleKey(key) !== null`, named for the places that only ask. */
export function isRoundRoleKey(key: string): boolean {
  return parseRoundRoleKey(key) !== null;
}
