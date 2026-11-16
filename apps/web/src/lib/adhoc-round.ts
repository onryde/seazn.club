// W5 app PR A, Task 3 (X-BD-6; RB5-S5, FX-G15): which round an ad-hoc match ("Add match") lands in, and which rounds the form may
// offer. One pure module, so the server's default and the form's select can never disagree about it.
//
// Main put an added match at `max(round_no) + 1`: in a league whose A-B fixture had been voided, the missing match then sat
// in a brand-new round 6 while A and B both had a free slot in round 3. Now the default is the LATEST round where neither side
// is seated, and a new round (`max + 1`) only when there is none. The form offers every existing round where neither side
// plays, plus the new round, and lists the rounds where a side already plays with the reason, unselectable (owner pick, R24
// section 6 option A: no round seats a team twice).
//
// "Seated" is `AdhocRoundRow.seats`: a fixture the table still counts. Each reader decides it from what it holds (the server
// excludes a voided line and a withdrawal's expunge; the form, which has no ledger, excludes a voided line), and this module
// takes it as given. Client-safe and strip-types-safe: no import.

/** One fixture of the stage, as the planner reads it. */
export interface AdhocRoundRow {
  round_no: number;
  home: string | null;
  away: string | null;
  /** Does this line seat its two sides in its round? False for a voided line (and, server-side, a withdrawal's expunge). */
  seats: boolean;
}

export type AdhocRoundChoice =
  /** An existing round where neither side plays. */
  | { round_no: number; kind: "free" }
  /** The round after the last one: always available. */
  | { round_no: number; kind: "new" }
  /** An existing round where a side already plays: `entrantId` is that side, `opponentId` who it plays there. */
  | { round_no: number; kind: "clash"; entrantId: string; opponentId: string | null };

export interface AdhocRoundPlan {
  /** Every round 1..max + 1, newest first. */
  choices: AdhocRoundChoice[];
  /** The round a match lands in when nobody names one. */
  suggested: number;
  /** `max + 1`. */
  newRound: number;
}

/** What `addFixture` does when the caller names no round: the latest free round, or a new one (`append`: always a new one;
 *  the quick-match decider's documented rule, `quick-match-add.ts`). */
export type AdhocRoundDefault = "latest_free" | "append";

export function adhocRoundPlan(rows: readonly AdhocRoundRow[], home: string, away: string, roundDefault: AdhocRoundDefault = "latest_free"): AdhocRoundPlan {
  const maxRound = rows.reduce((m, r) => Math.max(m, r.round_no), 0);
  const newRound = maxRound + 1;
  const choices: AdhocRoundChoice[] = [{ round_no: newRound, kind: "new" }];
  for (let round = maxRound; round >= 1; round--) {
    const seated = rows.filter((r) => r.seats && r.round_no === round && (r.home === home || r.away === home || r.home === away || r.away === away));
    const first = seated[0];
    if (first === undefined) {
      choices.push({ round_no: round, kind: "free" });
      continue;
    }
    // The reason names the home side when it plays there, else the away side.
    const side = first.home === home || first.away === home ? home : away;
    const line = seated.find((r) => r.home === side || r.away === side)!;
    choices.push({ round_no: round, kind: "clash", entrantId: side, opponentId: line.home === side ? line.away : line.home });
  }
  const latestFree = choices.find((c) => c.kind === "free");
  return { choices, newRound, suggested: roundDefault === "append" || latestFree === undefined ? newRound : latestFree.round_no };
}

/** Is `round` a round the match may land in (an existing round with both sides free, or the new one)? */
export function isOfferedRound(plan: AdhocRoundPlan, round: number): boolean {
  const c = plan.choices.find((x) => x.round_no === round);
  return c !== undefined && c.kind !== "clash";
}

/** The round the form holds: the person's pick while the match may still go in it, else the suggestion. A pick made for one pair of
 *  sides does not survive a change of sides that fills it (the round is then listed as unselectable); it falls back, never submits. */
export function chosenAdhocRound(plan: AdhocRoundPlan, pick: number | null): number {
  return pick !== null && isOfferedRound(plan, pick) ? pick : plan.suggested;
}

/** A line of the select, in the order drawn. `clashRange` folds a long run of rounds the match cannot go in. */
export type AdhocRoundOption =
  | { kind: "new"; round_no: number; suggested: boolean }
  | { kind: "free"; round_no: number; suggested: boolean }
  | { kind: "clash"; round_no: number; entrantId: string; opponentId: string | null }
  | { kind: "clashRange"; from: number; to: number };

/** At most this many unselectable rounds are listed one by one at the end of a run of them: a 20-round league stays a short list. */
const CLASH_LISTED = 2;

/** The select's lines: newest first; each run of unselectable rounds lists its newest {@link CLASH_LISTED} with the reason and folds
 *  the older ones into one range (R24 section 6: "Round 5 · ... plays ...", "Rounds 1 to 3 · a side already plays"). */
export function adhocRoundOptions(plan: AdhocRoundPlan): AdhocRoundOption[] {
  const out: AdhocRoundOption[] = [];
  let run: Extract<AdhocRoundChoice, { kind: "clash" }>[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const listed = run.length - CLASH_LISTED >= 2 ? run.slice(0, CLASH_LISTED) : run;
    for (const c of listed) out.push({ kind: "clash", round_no: c.round_no, entrantId: c.entrantId, opponentId: c.opponentId });
    const folded = run.slice(listed.length);
    if (folded.length > 0) out.push({ kind: "clashRange", from: folded[folded.length - 1]!.round_no, to: folded[0]!.round_no });
    run = [];
  };
  for (const c of plan.choices) {
    if (c.kind === "clash") {
      run.push(c);
      continue;
    }
    flush();
    out.push({ kind: c.kind, round_no: c.round_no, suggested: c.round_no === plan.suggested });
  }
  flush();
  return out;
}
