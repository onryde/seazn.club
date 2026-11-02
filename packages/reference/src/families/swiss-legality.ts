// The Swiss legality and existence checker (format-matrix W3, Task 19; spec §6.4; rulebook-W3-swiss.md §2.3, bound
// RB3-24). Written from the RULEBOOK alone (§2.1 absolute rules, §2.3 what the reference checks, §3.1 round bounds),
// never from engine code (R8). It is not a second pairing engine: it judges one seated (or refused) round against
// the history it is handed.
//
// What it decides, in the rulebook's words (§2.3):
//   1. P-A1, P-A3, P-A4, P-A7 on the seated round, against the history it is handed.
//   2. P-A5 when chess colours are on: after the round, colour difference within [−2, +2], and never one colour three
//      times running (A1 r.6–7). [C3] — two non-topscorers with the same ABSOLUTE preference do not meet — needs no
//      check of its own here: an absolute preference is a difference beyond ±1 or one colour twice running, and two
//      such entrants wanting the same colour leave one of them past ±2 or three running, which the two limits catch.
//   3. Existence (P-A6): the compatibility graph over the active field (an edge = a pair that has not met and, with
//      chess, has a colour assignment within both entrants' limits — pairwise, so a plain graph). Even field: one
//      perfect-matching test. Odd field: for each bye-eligible entrant, delete it and test. A refusal is correct iff
//      no test succeeds AND it names a reason; zero boards returned as success is `empty_success` (SW-H1).
//   4. The bye (P-Q2's hard core): no eligible entrant with a strictly LOWER score may leave a pairable remainder.
//   5. Round 1 with seeds and no history: exactly the fold of the active field in seed order (S1[i] v S2[i]); an odd
//      field's bye is the last seed (lowest score — all are 0 — then lowest ranked).
//   6. Anti-vacuity: `examined` reports the boards, byes and perfect-matching tests the check looked at.

import { SwissOutOfScope, blossomMatching } from "./swiss-matching.ts";

export type SwissColour = "W" | "B";

/** Everything before the round, as the reference folds it. */
export type SwissHistoryIn = {
  /** Pairs that MET: played games only. A walkover or a double walkover is not a meeting (P-A2, A2 3.5). */
  met: [string, string][];
  /** Entrants who already received the pairing-allocated bye. */
  byes: string[];
  /** Entrants who scored a win's points without playing (a walkover win), so never bye-eligible (P-A4). */
  walkoverWinners: string[];
  /** Colours of PLAYED games, oldest first (A2 3.4). An entrant absent here has played none. */
  colours: Record<string, SwissColour[]>;
  /** Table points before the round. Every active entrant must carry one. */
  scores: Record<string, number>;
};

/**
 * One round to judge. `field` is every entrant of the stage IN SEED (TPN) ORDER — round 1 is checked as the exact fold
 * of that order (§2.3 item 5). `departed` are the withdrawn, disqualified and deleted entrants (P-A7); the active field
 * is `field` minus `departed`. With `chess` on, a board's `home` plays White and its `away` Black.
 */
export type SwissRoundIn = {
  field: string[];
  departed: string[];
  chess: boolean;
  history: SwissHistoryIn;
  outcome: { kind: "paired"; boards: { home: string; away: string }[]; bye: string | null } | { kind: "refused"; reason: string };
};

/** §2.1's absolute rows, P-Q2's hard core (§2.3 item 4), and the exact round 1 (§2.3 item 5, the P-Q3 fold). */
export type SwissRule = "P-A1" | "P-A3" | "P-A4" | "P-A5" | "P-A6" | "P-A7" | "P-Q2" | "P-Q3";
export type SwissViolation = { rule: SwissRule; detail: string };

export type SwissVerdict = {
  verdict: "legal" | "illegal" | "refusal_correct" | "refusal_wrong" | "empty_success";
  violations: SwissViolation[];
  /** Anti-vacuity (§2.3 item 6): what the check looked at — boards, byes, and the perfect-matching tests it ran. */
  examined: { boards: number; byes: number; candidates: number };
};

export function checkSwissRound(input: SwissRoundIn): SwissVerdict {
  const { field, chess, history, outcome } = input;
  const seen = new Set<string>();
  for (const id of field) {
    if (seen.has(id)) throw new Error(`checkSwissRound: the field names ${id} twice`);
    seen.add(id);
  }
  const departed = new Set(input.departed);
  const active = field.filter((id) => !departed.has(id));
  if (active.length === 0) throw new SwissOutOfScope("no active entrant — there is no round to judge");
  for (const id of active) {
    if (typeof history.scores[id] !== "number") throw new Error(`checkSwissRound: no score for ${id} (every active entrant carries one)`);
  }
  const metKeys = new Set<string>();
  for (const [a, b] of history.met) {
    if (a === b) throw new Error(`checkSwissRound: the history says ${a} met itself`);
    metKeys.add(pairOf(a, b));
  }
  const hadBye = new Set(history.byes);
  const walkoverWinners = new Set(history.walkoverWinners);
  const coloursOf = (id: string): readonly SwissColour[] => history.colours[id] ?? [];
  const scoreOf = (id: string): number => history.scores[id] ?? 0;
  const byeEligible = (id: string) => !hadBye.has(id) && !walkoverWinners.has(id);

  // §2.3 item 3: the compatibility graph and one perfect-matching test per candidate.
  const compatible = (a: string, b: string): boolean => {
    if (metKeys.has(pairOf(a, b))) return false; // P-A1
    if (!chess) return true;
    // P-A5, pairwise: one of the two colour assignments must suit both entrants.
    return (colourBreaks(coloursOf(a), "W").length === 0 && colourBreaks(coloursOf(b), "B").length === 0)
      || (colourBreaks(coloursOf(a), "B").length === 0 && colourBreaks(coloursOf(b), "W").length === 0);
  };
  let candidates = 0;
  const pairable = (ids: readonly string[]): boolean => {
    candidates++;
    const edges: [number, number][] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) if (compatible(ids[i] as string, ids[j] as string)) edges.push([i, j]);
    }
    return blossomMatching(ids.length, edges).every((m) => m !== -1);
  };
  const odd = active.length % 2 === 1;
  /** Odd field: each bye-eligible entrant, and whether the field without it pairs. Even field: empty. */
  const byeCandidates = new Map<string, boolean>();
  let exists: boolean;
  if (odd) {
    for (const id of active) if (byeEligible(id)) byeCandidates.set(id, pairable(active.filter((x) => x !== id)));
    exists = [...byeCandidates.values()].some(Boolean);
  } else {
    exists = pairable(active);
  }
  const witness = odd ? [...byeCandidates].find(([, ok]) => ok)?.[0] : undefined;

  if (outcome.kind === "refused") {
    const violations: SwissViolation[] = [];
    if (exists) violations.push({ rule: "P-A6", detail: `refused ("${outcome.reason}") while a legal pairing exists${witness === undefined ? "" : ` (with ${witness} on the bye)`}` });
    if (outcome.reason.trim() === "") violations.push({ rule: "P-A6", detail: "the refusal names no reason" });
    return { verdict: violations.length === 0 ? "refusal_correct" : "refusal_wrong", violations, examined: { boards: 0, byes: 0, candidates } };
  }

  const { boards, bye } = outcome;
  const examined = { boards: boards.length, byes: bye === null ? 0 : 1, candidates };
  // §2.3 items 3 and 6: zero boards on a round the stage owes is SW-H1, whatever else is wrong with it.
  if (boards.length === 0 && active.length >= 2) {
    const detail = exists
      ? `zero boards returned as success while a legal pairing exists${witness === undefined ? "" : ` (with ${witness} on the bye)`}`
      : "zero boards returned as success where no legal pairing exists — a named refusal was owed";
    return { verdict: "empty_success", violations: [{ rule: "P-A6", detail }], examined };
  }

  const violations: SwissViolation[] = [];
  const seats = new Map<string, number>();
  const seat = (id: string, where: string): void => {
    seats.set(id, (seats.get(id) ?? 0) + 1);
    if (departed.has(id)) violations.push({ rule: "P-A7", detail: `${id} has departed (withdrawn, disqualified or deleted) and is seated ${where}` });
    else if (!seen.has(id)) violations.push({ rule: "P-A3", detail: `${id} is not in the field and is seated ${where}` });
  };
  boards.forEach(({ home, away }, k) => {
    const where = `on board ${k + 1}`;
    if (home === away) violations.push({ rule: "P-A3", detail: `board ${k + 1} seats ${home} against itself` });
    seat(home, where);
    if (away !== home) seat(away, where);
    else seats.set(home, (seats.get(home) ?? 0) + 1);
    if (home !== away && metKeys.has(pairOf(home, away))) violations.push({ rule: "P-A1", detail: `${home} and ${away} have already met (board ${k + 1})` });
    if (chess) {
      for (const [id, c] of [[home, "W"], [away, "B"]] as const) {
        const broken = colourBreaks(coloursOf(id), c);
        if (broken.length > 0) violations.push({ rule: "P-A5", detail: `${id} with ${c === "W" ? "White" : "Black"} on board ${k + 1}: ${broken.join("; ")}` });
      }
    }
  });
  if (bye !== null) {
    seat(bye, "as the bye");
    if (hadBye.has(bye)) violations.push({ rule: "P-A4", detail: `${bye} already received the pairing-allocated bye` });
    if (walkoverWinners.has(bye)) violations.push({ rule: "P-A4", detail: `${bye} scored a win's points without playing (a walkover win)` });
  }
  for (const id of active) {
    const n = seats.get(id) ?? 0;
    if (n === 0) violations.push({ rule: "P-A3", detail: `${id} is not seated` });
    else if (n > 1) violations.push({ rule: "P-A3", detail: `${id} is seated ${n} times` });
  }
  if (odd && bye === null) violations.push({ rule: "P-A3", detail: `the active field of ${active.length} is odd and has no bye` });
  if (!odd && bye !== null) violations.push({ rule: "P-A3", detail: `the active field of ${active.length} is even and has a bye (${bye})` });

  // §2.3 item 4: no eligible entrant scoring strictly less than the bye may leave a pairable remainder.
  if (odd && bye !== null && active.includes(bye)) {
    const lower = [...byeCandidates].filter(([id, ok]) => ok && scoreOf(id) < scoreOf(bye)).map(([id]) => id);
    if (lower.length > 0) violations.push({ rule: "P-Q2", detail: `${bye} (${scoreOf(bye)}) has the bye while ${lower.map((id) => `${id} (${scoreOf(id)})`).join(", ")} scores less and leaves a pairable remainder` });
  }

  // §2.3 item 5: round 1 with seeds and no history is the exact fold.
  if (isRoundOne(history)) {
    const order = odd ? active.slice(0, -1) : active;
    const owedBye = odd ? (active[active.length - 1] ?? null) : null;
    const half = order.length / 2;
    const owed = order.slice(0, half).map((s1, i) => pairOf(s1, order[half + i] as string));
    const got = boards.map(({ home, away }) => pairOf(home, away));
    const same = owedBye === bye && owed.length === got.length && [...owed].sort().join() === [...got].sort().join();
    if (!same) {
      const show = (pairs: string[], b: string | null) => `${pairs.map((p) => (JSON.parse(p) as string[]).join("–")).join(", ")}${b === null ? "" : `, bye ${b}`}`;
      violations.push({ rule: "P-Q3", detail: `round 1 owes the fold ${show(owed, owedBye)}; got ${show(got, bye)}` });
    }
  }

  if (violations.length === 0 && !exists) {
    // A legal round IS a perfect matching of the compatibility graph (minus an eligible bye), so the oracle must have
    // found one. If it did not, the oracle is broken — refused, never reported as a verdict.
    throw new Error("checkSwissRound: a legal round, yet the matching oracle found no pairing — the oracle is broken");
  }
  return { verdict: violations.length === 0 ? "legal" : "illegal", violations, examined };
}

/** An unordered pair's key. JSON keeps any two ids apart, whatever characters they hold. */
function pairOf(a: string, b: string): string {
  return JSON.stringify(a < b ? [a, b] : [b, a]);
}

/** The colour limits (P-A5, A1 r.6–7) the entrant would break by taking `next`: an empty list when it breaks none. */
function colourBreaks(played: readonly SwissColour[], next: SwissColour): string[] {
  const after = [...played, next];
  const diff = after.reduce((d, c) => d + (c === "W" ? 1 : -1), 0);
  const broken: string[] = [];
  if (diff > 2 || diff < -2) broken.push(`colour difference ${diff > 0 ? "+" : ""}${diff} leaves [−2, +2]`);
  const k = after.length;
  if (k >= 3 && after[k - 2] === next && after[k - 3] === next) broken.push(`${next} three times running`);
  return broken;
}

/** No round has been paired: nobody met, nobody had a bye or a walkover, nobody has a colour or a point. */
function isRoundOne(h: SwissHistoryIn): boolean {
  return h.met.length === 0 && h.byes.length === 0 && h.walkoverWinners.length === 0
    && Object.values(h.colours).every((c) => c.length === 0) && Object.values(h.scores).every((s) => s === 0);
}
