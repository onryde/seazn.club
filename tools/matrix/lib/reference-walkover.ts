// The walkover credit the harness judges the product's table by (W2b Task 2 Step 4; spec §5.6; Appendix A). The
// interface is the reference family `walkover-credit`'s, frozen by the plan (Task 15: CreditCase, CreditAnswer,
// walkoverCredit), so the swap to that family is one import. Until it reaches this lane the answer is read here from
// the Appendix A rows and the case's cfg — written out per sport, NEVER from the engine (the plan's own rule: a credit
// expectation is computed from the cfg with the Appendix A rule, never from a module's forfeitCredit).
//
// What the interim answers: a walkover and a withdrawal before play (the *-WO-1 rows), and a double walkover (X-DW-4).
// A retirement or a disqualification credits the played score by sport-specific rules (the *-RT-1 rows) that only
// the family answers: asked here, it refuses by name (CreditNotCovered) and the caller counts it as not judged.

export interface CreditCase {
  readonly sport: string;
  readonly cfg: Record<string, unknown>;
  readonly reason: "walkover" | "retired" | "disqualified" | "withdrew" | "double_walkover";
  readonly played?: { readonly home: number[]; readonly away: number[] };
}
export interface CreditAnswer {
  /** The metrics the match credits the side it is awarded to (a double walkover: either side), in the module's own
   *  metric keys. Only these keys are judged. */
  readonly winner: Record<string, number>;
  readonly loser: Record<string, number>;
  /** Keys the match must not feed into a ratio tie-break. */
  readonly excluded: string[];
  /** "win": the awarded side takes the sport's win points; "zero": nobody scores (X-DW-4). */
  readonly points: "win" | "zero";
  /** Whether the match counts in a player's stats (X-PS-1: a walkover, a withdrawal or a double walkover never). */
  readonly statsMatch: boolean;
}

export class CreditNotCovered extends Error {
  constructor(c: CreditCase, why: string) {
    super(`reference-walkover: ${c.sport} ${c.reason} — ${why}`);
    this.name = "CreditNotCovered";
  }
}

const num = (c: CreditCase, key: string): number => {
  const v = c.cfg[key];
  if (typeof v !== "number") throw new CreditNotCovered(c, `the cfg carries no numeric '${key}'`);
  return v;
};
const gamesToWin = (c: CreditCase): number => Math.ceil(num(c, "bestOf") / 2);
const goals = (c: CreditCase): number => {
  const a = c.cfg.awardScore as { goals?: unknown } | undefined;
  if (typeof a?.goals !== "number") throw new CreditNotCovered(c, "the cfg carries no awardScore.goals");
  return a.goals;
};
type Pair = { winner: Record<string, number>; loser: Record<string, number>; excluded: string[] };
const goalRule = (c: CreditCase): Pair => { const g = goals(c); return { winner: { gf: g, ga: 0 }, loser: { gf: 0, ga: g }, excluded: [] }; };
/** Sets of `per`-0: the games or sets a win needs, each at its target (VB/TT/BD-WO-1, CA-WO-1). */
const setRule = (c: CreditCase, per: number): Pair => {
  const n = gamesToWin(c);
  return { winner: { sets_won: n, sets_lost: 0, points_won: n * per, points_lost: 0 }, loser: { sets_won: 0, sets_lost: n, points_won: 0, points_lost: n * per }, excluded: [] };
};

/** The walkover rows (Appendix A), per sport, from the cfg alone. */
const WALKOVER: Readonly<Record<string, (c: CreditCase) => Pair>> = Object.freeze({
  football: goalRule, // FB-WO-1: 3-0 — the awardScore the cfg declares
  hockey: goalRule, // HK-WO-1: 5-0 (the default moves from 3; a cfg that pins 3 keeps it)
  icehockey: goalRule, // IH-WO-1: 5-0
  volleyball: (c) => setRule(c, num(c, "setTo")), // VB-WO-1: the sets needed, each set's target-0 (FIVB 6.4.1)
  tabletennis: (c) => setRule(c, num(c, "setTo")), // TT-WO-1: the games needed, each 11-0
  badminton: (c) => setRule(c, num(c, "setTo")), // BD-WO-1: 2-0 games, each 21-0
  carrom: (c) => setRule(c, num(c, "gameTo")), // CA-WO-1: the games needed, each at the game target
  // TN-WO-1: straight sets for set %; the match's games are excluded from game %.
  tennis: (c) => { const n = gamesToWin(c); return { winner: { sets_won: n, sets_lost: 0, games_won: 0, games_lost: 0 }, loser: { sets_won: 0, sets_lost: n, games_won: 0, games_lost: 0 }, excluded: ["games_won", "games_lost"] }; },
  // CK-WO-1: full points to the winner; the defaulter is charged its full quota at 0 runs; the winner's NRR is unaffected.
  cricket: (c) => {
    const innings = typeof c.cfg.inningsPerSide === "number" ? c.cfg.inningsPerSide : 1;
    const quota = num(c, "ballsPerInnings") * innings;
    return { winner: { runs_for: 0, balls_faced_eff: 0, runs_against: 0, balls_bowled_eff: 0 }, loser: { runs_for: 0, balls_faced_eff: quota, runs_against: 0, balls_bowled_eff: 0 }, excluded: [] };
  },
  // BG-WO-1: 1-0, a game for table tie-breaks, excluded from colour history.
  boardgame: () => ({ winner: { wins: 1, white: 0, black: 0 }, loser: { wins: 0, white: 0, black: 0 }, excluded: ["white", "black"] }),
  // GN-WO-1: win points, 0-0.
  generic: () => ({ winner: { for: 0, against: 0 }, loser: { for: 0, against: 0 }, excluded: [] }),
});

/** The sports the interim answers, in its own table's order (anti-vacuity: a caller sweeps these). */
export const CREDIT_SPORTS: readonly string[] = Object.freeze(Object.keys(WALKOVER));

export function walkoverCredit(c: CreditCase): CreditAnswer {
  const rule = WALKOVER[c.sport];
  if (rule === undefined) throw new CreditNotCovered(c, "no Appendix A walkover row for this sport");
  if (c.reason === "retired" || c.reason === "disqualified") throw new CreditNotCovered(c, "a retirement's credit keeps the played score by the sport's own *-RT-1 row, which the walkover-credit family answers");
  if (c.reason === "withdrew" && c.played !== undefined && (c.played.home.length > 0 || c.played.away.length > 0)) {
    throw new CreditNotCovered(c, "a withdrawal after play takes the retirement credit (X-WD-1), which the walkover-credit family answers");
  }
  const pair = rule(c);
  if (c.reason === "double_walkover") {
    // X-DW-4: P+1, L+1, 0 points for both, no score credited, excluded from every ratio.
    const zero = (r: Record<string, number>) => Object.fromEntries(Object.keys(r).map((k) => [k, 0]));
    const keys = [...new Set([...Object.keys(pair.winner), ...Object.keys(pair.loser)])];
    return { winner: zero(pair.winner), loser: zero(pair.loser), excluded: keys, points: "zero", statsMatch: false };
  }
  return { winner: pair.winner, loser: pair.loser, excluded: pair.excluded, points: "win", statsMatch: false };
}
