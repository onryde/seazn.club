// Reference family `walkover-credit` (format-matrix W2b, lane P2; spec 2026-10-08-format-matrix-w2b-design.md §5.2 and
// Appendix A; plan Task 15).
//
// Written FROM THE RULE ROWS — Appendix A's X-WO, X-RT, X-DW-4, X-PS and the per-sport WO/RT rows, read with the two
// W2 rulebooks (rulebook-W2-goals-boards.md, rulebook-W2-sets-cricket.md) — and the orchestrator's pre-flight rulings
// PF-6 (unlimited-overs cricket) and PF-7 (`withdrew` is phase-keyed), by a different agent than the engine fixer
// (R8). It reads no engine source and imports nothing from the engine (scripts/reference-boundary.ts proves it).
//
// One forfeited match, in the RULEBOOK's terms — the sport, the stage's own cfg (X-WO-1), the reason, the side at fault
// and, after play started, the scoresheet so far — answered as what the table credits each side: the metric values,
// the metric keys no ratio tie-break may read, the table points, and whether players' stats count it as a match.
//
// The answer names only the metric keys a rule row decides; a key it leaves out is not judged (a consumer compares
// the keys present, and reads an absent key as "no rule"). It never guesses: an input the rows cannot answer throws a
// `CreditRefused` naming why.
import { WALKOVER_CREDIT_DATA, type CreditCfgEntry, type PlayedScenario } from "./walkover-credit-cfgs.ts";

export type Side = "home" | "away";
/** X-RS-1's closed reason list, plus the double walkover (X-DW-1). */
export const CREDIT_REASONS = ["walkover", "retired", "disqualified", "withdrew", "double_walkover"] as const;
export type CreditReason = (typeof CREDIT_REASONS)[number];

export interface CreditCase {
  sport: string;
  /** The stage's own cfg (X-WO-1) — only the keys the sport's credit row reads (walkover-credit-cfgs.ts). */
  cfg: Record<string, unknown>;
  reason: CreditReason;
  /** Present once play started: each side's score per unit (period, set, game), the last unit possibly unfinished. */
  played?: { home: number[]; away: number[] };
  /** ADDITIVE (not in the plan's frozen interface): the side at fault. It is what "worse for the offender" (FB-RT-1)
   *  and "the retiring side keeps what it won" (VB-RT-1) read `played` against, so it is REQUIRED with a scoresheet:
   *  absent there, the case is refused `offender-unknown` — never read as "away". A double walkover ignores it (both
   *  sides are at fault), and so does a case with no scoresheet (the credit is the same whichever side defaulted). */
  by?: Side;
  /** ADDITIVE: the declared cfg name the case was built from (a module variant name, "(schema default)", or a named
   *  extra) — the consumer's handle on the engine's own cfg. A consumer folding a case through the engine parses the
   *  engine's DECLARED cfg of that name UNMODIFIED (`declaredCfgs(module)`, i.e. `configSchema.parse(variants[name])`,
   *  or `configSchema.parse({})` for the schema default) and passes that parsed cfg to `walkoverCredit` — `cfg` here is
   *  the rulebook's claim about the declared value (its test checks it against the engine's declaration, every known
   *  difference named), never an override. A named extra is not declared: it is a stage-match-rules cfg, built as its
   *  `source` says. Never read. */
  variant?: string;
  /** ADDITIVE: a readable name for the case. Never read. */
  label?: string;
}

export interface CreditAnswer {
  winner: Record<string, number>;
  loser: Record<string, number>;
  /** Metric keys this match must not feed into a ratio tie-break (plan D9's `excluded`, realised as a 0 credit). */
  excluded: string[];
  /** Table points: the winner's win points for a single forfeit; nothing for either side of a double walkover. */
  points: "win" | "zero";
  /** X-PS-1 / X-PS-2: whether players' stats count this as a match played. */
  statsMatch: boolean;
}

export const CREDIT_REFUSALS = {
  "unknown-sport": "no rule row credits a forfeit in this sport",
  "unknown-reason": "X-RS-1: a forfeit records one reason from a closed list (walkover, retired, disqualified, withdrew), or is a double walkover (X-DW-1)",
  "cfg-invalid": "X-WO-1: the credit is derived from the stage's own cfg, and the cfg lacks a value the row reads",
  "played-before-start": "X-RS-1: a walkover (and a double walkover) is recorded before play starts — only chess also after the session starts (FIDE 6.7.1, BG-WO-2)",
  "not-started": "X-RS-1: retired and disqualified are recorded after play started, so they carry the scoresheet so far",
  "played-malformed": "the scoresheet so far is not two equal-length lists of whole, non-negative unit scores the sport can reach",
  "unit-unfinished": "only the last unit of the scoresheet so far may be unfinished",
  "already-decided": "the scoresheet so far already decides the match, so nobody retired from it",
  "offender-unknown": "a scoresheet is read from the side at fault (FB-RT-1 \"worse for the offender\", VB-RT-1 \"the retiring side keeps what it won\"), so a forfeit with one names that side (`by`)",
} as const;
export type CreditRefusal = keyof typeof CREDIT_REFUSALS;

export class CreditRefused extends Error {
  readonly reason: CreditRefusal;
  constructor(reason: CreditRefusal, detail: string) {
    super(`walkover-credit: ${detail} (${CREDIT_REFUSALS[reason]})`);
    this.name = "CreditRefused";
    this.reason = reason;
  }
}

/** The goal sports: FB-WO-1/FB-RT-1, HK-WO-1/HK-RT-1, IH-WO-1/IH-RT-1. */
const GOALS = ["football", "hockey", "icehockey"];
/** The rally-point set sports: VB-WO-1/VB-RT-1, TT-WO-1/TT-RT-1, BD-WO-1/BD-RT-1. */
const SETS = ["volleyball", "tabletennis", "badminton"];
const CHESS = "boardgame"; // BG-WO-1, BG-WO-2
/** Every sport the rows credit, in the registry's (wave) order. */
export const CREDIT_SPORTS = ["football", "cricket", "boardgame", "carrom", "generic", "volleyball", "badminton", "tabletennis", "tennis", "icehockey", "hockey"] as const;

/** X-DW-4: the operands of each sport's ratio tie-breaks (set %, game %, NRR, the board and point ratios) — read from
 *  the rulebooks' cascades. The goal sports, generic and chess rank on differences and counts, never a ratio. */
const RATIO_OPERANDS: Readonly<Record<string, readonly string[]>> = {
  football: [], // rulebook-W2-goals-boards §1: GD, goals — no ratio
  hockey: [], // §2 (FIH App. 3): GD, GF — no ratio
  icehockey: [], // §3: GD, goals — no ratio
  boardgame: [], // §4 (FIDE C.07): direct encounter, wins, SB — no ratio
  generic: [], // §6: diff, for — no ratio
  carrom: ["sets_won", "sets_lost", "boards_won", "boards_lost", "points_won", "points_lost"], // §5: game, board and point ratio
  volleyball: ["sets_won", "sets_lost", "points_won", "points_lost"], // rulebook-W2-sets-cricket §5: set ratio, point ratio
  badminton: ["sets_won", "sets_lost", "points_won", "points_lost"], // §3 (BD-7): set ratio, point ratio
  tabletennis: ["sets_won", "sets_lost", "points_won", "points_lost"], // §4 (TT-7): games ratio, points ratio
  tennis: ["sets_won", "sets_lost", "games_won", "games_lost"], // §6 (TN-14): % sets, % games
  cricket: ["runs_for", "balls_faced_eff", "runs_against", "balls_bowled_eff"], // §7: NRR
};
/** X-DW-4 "no score credited": every score key each sport's credit rows decide, at 0 for both sides. */
const SCORE_KEYS: Readonly<Record<string, readonly string[]>> = {
  football: ["gf", "ga", "gd"],
  hockey: ["gf", "ga", "gd"],
  icehockey: ["gf", "ga", "gd"],
  boardgame: ["wins", "white", "black"],
  generic: ["for", "against", "diff"],
  carrom: RATIO_OPERANDS.carrom ?? [],
  volleyball: RATIO_OPERANDS.volleyball ?? [],
  badminton: RATIO_OPERANDS.badminton ?? [],
  tabletennis: RATIO_OPERANDS.tabletennis ?? [],
  tennis: RATIO_OPERANDS.tennis ?? [],
  cricket: RATIO_OPERANDS.cricket ?? [],
};

type Metrics = Record<string, number>;
interface Credit { winner: Metrics; loser: Metrics; excluded: string[] }
interface Played { off: readonly number[]; win: readonly number[] }

const zeros = (keys: readonly string[]): Metrics => Object.fromEntries(keys.map((k) => [k, 0]));
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

function wholeNumber(cfg: Record<string, unknown>, key: string, sport: string, min: number): number {
  const v = cfg[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) throw new CreditRefused("cfg-invalid", `${sport}: cfg.${key} is ${JSON.stringify(v)}`);
  return v;
}
/** A best-of count: odd and positive, so exactly one side can reach a majority. */
function bestOf(cfg: Record<string, unknown>, sport: string): number {
  const n = wholeNumber(cfg, "bestOf", sport, 1);
  if (n % 2 === 0) throw new CreditRefused("cfg-invalid", `${sport}: cfg.bestOf is even (${n})`);
  return n;
}
const needed = (n: number): number => (n + 1) / 2;

// ── Goal sports: FB-WO-1 / FB-RT-1 (FDC 2025 Art. 28.1), HK-WO-1 / HK-RT-1, IH-WO-1 / IH-RT-1 ──────────────────────
function goalCredit(sport: string, cfg: Record<string, unknown>, p: Played | null): Credit {
  const award = cfg.awardScore;
  const g = award !== null && typeof award === "object" ? (award as Record<string, unknown>).goals : undefined;
  if (typeof g !== "number" || !Number.isInteger(g) || g < 1) throw new CreditRefused("cfg-invalid", `${sport}: cfg.awardScore.goals is ${JSON.stringify(g)}`);
  let w = g;
  let o = 0;
  if (p !== null) {
    const realW = sum(p.win);
    const realO = sum(p.off);
    // FDC 28.1: "if the goal difference at the end of the match is LESS favourable to the team at fault, the result on
    // the pitch is upheld" — strictly: an equal difference (4-1 against 3-0) is not less favourable, so 3-0 stands.
    if (realW - realO > g) { w = realW; o = realO; }
  }
  return { winner: { gf: w, ga: o, gd: w - o }, loser: { gf: o, ga: w, gd: o - w }, excluded: [] };
}

// ── Rally-point set sports: VB-WO-1 / VB-RT-1 (FIVB 6.4), TT-WO-1 / TT-RT-1 (ITTF Handbook 2.3.7), BD-WO-1 / BD-RT-1 ─
interface SetRules { bestOf: number; setTo: number; finalSetTo: number; winBy: number; cap: number | null }
function setRules(sport: string, cfg: Record<string, unknown>): SetRules {
  const cap = cfg.cap;
  if (cap !== null && (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1)) throw new CreditRefused("cfg-invalid", `${sport}: cfg.cap is ${JSON.stringify(cap)}`);
  return { bestOf: bestOf(cfg, sport), setTo: wholeNumber(cfg, "setTo", sport, 1), finalSetTo: wholeNumber(cfg, "finalSetTo", sport, 1), winBy: wholeNumber(cfg, "winBy", sport, 1), cap };
}
/** The score a set ends on for the side that wins it, given the other side's score: the target, or two clear past it
 *  (FIVB 6.2, ITTF 2.11.1, BWF Law 7.4), never past the cap (BWF Law 7.5). */
function setEnd(r: SetRules, i: number, other_: number): number {
  const target = i === r.bestOf - 1 ? r.finalSetTo : r.setTo; // the deciding set (FIVB 6.3.2: the 5th to 15)
  const end = Math.max(target, other_ + r.winBy);
  return r.cap === null ? end : Math.min(end, r.cap);
}

function setCredit(sport: string, cfg: Record<string, unknown>, p: Played | null): Credit {
  const r = setRules(sport, cfg);
  const need = needed(r.bestOf);
  const win: number[] = [];
  const off: number[] = [];
  let setsW = 0;
  let setsO = 0;
  if (p !== null) {
    if (p.win.length > r.bestOf) throw new CreditRefused("played-malformed", `${sport}: ${p.win.length} sets in a best of ${r.bestOf}`);
    let unfinished = false;
    p.win.forEach((a, i) => {
      const b = p.off[i] ?? 0;
      if (setsW === need || setsO === need) throw new CreditRefused("already-decided", `${sport}: set ${i + 1} follows a decided match`);
      win.push(a);
      off.push(b);
      if (a === setEnd(r, i, b)) { setsW++; return; }
      if (b === setEnd(r, i, a)) { setsO++; return; }
      if (a > setEnd(r, i, b) || b > setEnd(r, i, a)) throw new CreditRefused("played-malformed", `${sport}: set ${i + 1} ${a}-${b} runs past its end`);
      if (i !== p.win.length - 1) throw new CreditRefused("unit-unfinished", `${sport}: set ${i + 1} ${a}-${b} is unfinished and is not the last`);
      // VB-RT-1 / TT-RT-1 / BD-RT-1: the unfinished set is completed for the winner — "given the points it needed"
      // (FIVB 6.4.3), "completed for the winner" (ITTF 2.3.7), "as if completed without the conceding side scoring
      // another point" (BWF GCR 16.3.8) — and the side at fault keeps its points.
      win[i] = setEnd(r, i, b);
      setsW++;
      unfinished = true;
    });
    // Every set finished and one side already has its majority: that match was won, not retired from.
    if (!unfinished && (setsW === need || setsO === need)) throw new CreditRefused("already-decided", `${sport}: the scoresheet ${JSON.stringify(p)} already decides the match`);
  }
  // The sets still needed, each target-0 — a walkover's "the sets needed to win, each 25-0" (VB-WO-1, TT-WO-1 11-0,
  // BD-WO-1 21-0, read through the stage's own setTo, X-WO-1); after a retirement, each remaining set's own target.
  while (setsW < need) {
    const i = win.length;
    win.push(p === null ? r.setTo : setEnd(r, i, 0));
    off.push(0);
    setsW++;
  }
  const W = { sets_won: setsW, sets_lost: setsO, points_won: sum(win), points_lost: sum(off) };
  return { winner: W, loser: { sets_won: setsO, sets_lost: setsW, points_won: W.points_lost, points_lost: W.points_won }, excluded: [] };
}
// ── Tennis: TN-WO-1 / TN-RT-1 (ATP 4.01 C.4) ────────────────────────────────────────────────────────────────────────
function tennisCredit(cfg: Record<string, unknown>): Credit {
  const n = needed(bestOf(cfg, "tennis"));
  // "a straight-set win or loss" for set %; "the games of every match with the retiring player are excluded from %
  // games" — credited 0 and named excluded (plan D9). The scoresheet so far is not read: TN-RT-1 is TN-WO-1's credit.
  return {
    winner: { sets_won: n, sets_lost: 0, games_won: 0, games_lost: 0 },
    loser: { sets_won: 0, sets_lost: n, games_won: 0, games_lost: 0 },
    excluded: ["games_won", "games_lost"],
  };
}

// ── Cricket: CK-WO-1 (ICC T20WC PC 16.10.7, 16.2); PF-6 (CK-WO-2) for unlimited overs ──────────────────────────────
function cricketCredit(cfg: Record<string, unknown>): Credit {
  const keys = SCORE_KEYS.cricket ?? [];
  const innings = wholeNumber(cfg, "inningsPerSide", "cricket", 1);
  if (cfg.ballsPerInnings === null) {
    // PF-6: no quota, so NRR is undefined — the result and its table points only, nothing credited, out of NRR.
    return { winner: zeros(keys), loser: zeros(keys), excluded: [...keys] };
  }
  const quota = wholeNumber(cfg, "ballsPerInnings", "cricket", 1) * innings;
  // "the defaulter is charged its full quota at 0 runs in NRR; the winner's NRR is unaffected" — whatever it had
  // scored before refusing to continue (a team cannot retire: a refusal to play is a forfeit, rulebook M3).
  return { winner: zeros(keys), loser: { ...zeros(keys), balls_faced_eff: quota }, excluded: [] };
}

// ── Chess: BG-WO-1 ──────────────────────────────────────────────────────────────────────────────────────────────────
function chessCredit(): Credit {
  // "1-0, counts as a game for table tie-breaks, excluded from colour history" — no colour is credited to either side.
  return { winner: { wins: 1, white: 0, black: 0 }, loser: { wins: 0, white: 0, black: 0 }, excluded: [] };
}

// ── Carrom: CA-WO-1 / CA-RT-1 ───────────────────────────────────────────────────────────────────────────────────────
function carromCredit(cfg: Record<string, unknown>, p: Played | null): Credit {
  const to = wholeNumber(cfg, "gameTo", "carrom", 1);
  const need = needed(bestOf(cfg, "carrom"));
  const win: number[] = [];
  const off: number[] = [];
  let gW = 0;
  let gO = 0;
  if (p !== null) {
    if (p.win.length > 2 * need - 1) throw new CreditRefused("played-malformed", `carrom: ${p.win.length} games in a best of ${2 * need - 1}`);
    let unfinished = false;
    p.win.forEach((a, i) => {
      const b = p.off[i] ?? 0;
      if (gW === need || gO === need) throw new CreditRefused("already-decided", `carrom: game ${i + 1} follows a decided match`);
      if (a >= to && b >= to) throw new CreditRefused("played-malformed", `carrom: game ${i + 1} ${a}-${b} has two winners`);
      win.push(a);
      off.push(b);
      if (a >= to) { gW++; return; }
      if (b >= to) { gO++; return; }
      // A game is finished only when a side reaches the target: the eight-board finish is not expressible here.
      if (i !== p.win.length - 1) throw new CreditRefused("unit-unfinished", `carrom: game ${i + 1} ${a}-${b} is unfinished and is not the last`);
      // CA-RT-1: "the unfinished game 25–(opponent's score)" — the winner takes the game at the target, the side at
      // fault keeps its points.
      win[i] = to;
      gW++;
      unfinished = true;
    });
    if (!unfinished && (gW === need || gO === need)) throw new CreditRefused("already-decided", `carrom: the scoresheet ${JSON.stringify(p)} already decides the match`);
  }
  // CA-WO-1 / CA-RT-1: "games needed to win, each 25-0" / "remaining games 25-0" (the stage's own gameTo, X-WO-1).
  while (gW < need) { win.push(to); off.push(0); gW++; }
  // Boards are not credited by either row (no board was played in the games it awards): not judged.
  const W = { sets_won: gW, sets_lost: gO, points_won: sum(win), points_lost: sum(off) };
  return { winner: W, loser: { sets_won: gO, sets_lost: gW, points_won: W.points_lost, points_lost: W.points_won }, excluded: [] };
}

// ── Generic: GN-WO-1 / GN-RT-1 ──────────────────────────────────────────────────────────────────────────────────────
function genericCredit(cfg: Record<string, unknown>, p: Played | null): Credit {
  const mode = cfg.resultMode;
  if (mode !== "score" && mode !== "win_loss") throw new CreditRefused("cfg-invalid", `generic: cfg.resultMode is ${JSON.stringify(mode)}`);
  // GN-WO-1: "win points, 0-0". GN-RT-1: "walkover credit, keeping any recorded score".
  if (p !== null && mode === "win_loss" && p.win.length > 0) throw new CreditRefused("played-malformed", "generic: a win/loss match records no score");
  const w = p === null ? 0 : sum(p.win);
  const o = p === null ? 0 : sum(p.off);
  return { winner: { for: w, against: o, diff: w - o }, loser: { for: o, against: w, diff: o - w }, excluded: [] };
}

function readPlayed(sport: string, played: CreditCase["played"], offender: Side): Played {
  const ok = (xs: unknown): xs is number[] => Array.isArray(xs) && xs.every((x) => typeof x === "number" && Number.isInteger(x) && x >= 0);
  if (played === undefined || !ok(played.home) || !ok(played.away) || played.home.length !== played.away.length) {
    throw new CreditRefused("played-malformed", `${sport}: ${JSON.stringify(played)}`);
  }
  return offender === "home" ? { off: played.home, win: played.away } : { off: played.away, win: played.home };
}

/** The credit one forfeited match earns each side, from the rule rows alone. Throws `CreditRefused`. */
export function walkoverCredit(c: CreditCase): CreditAnswer {
  if (!(CREDIT_SPORTS as readonly string[]).includes(c.sport)) throw new CreditRefused("unknown-sport", `sport ${JSON.stringify(c.sport)}`);
  if (!(CREDIT_REASONS as readonly string[]).includes(c.reason)) throw new CreditRefused("unknown-reason", `reason ${JSON.stringify(c.reason)}`);
  const chess = c.sport === CHESS;
  const started = c.played !== undefined;
  // X-RS-1: walkover before play started (chess also after the session starts); retired / disqualified after.
  if ((c.reason === "walkover" || c.reason === "double_walkover") && started && !chess) throw new CreditRefused("played-before-start", `${c.sport} ${c.reason} with a scoresheet`);
  if ((c.reason === "retired" || c.reason === "disqualified") && !started) throw new CreditRefused("not-started", `${c.sport} ${c.reason} with no scoresheet`);
  // The scoresheet is read from the side at fault's view, so a forfeit with one names that side — never a silent
  // default. A double walkover's sides are both at fault: its sheet (chess only) is read for its shape alone.
  if (started && c.reason !== "double_walkover" && c.by === undefined) throw new CreditRefused("offender-unknown", `${c.sport} ${c.reason} with a scoresheet names no side at fault`);
  const p = started ? readPlayed(c.sport, c.played, c.by ?? "home") : null; // "home": a double walkover's side is never read

  if (c.reason === "double_walkover") {
    // X-DW-1 / X-DW-4: both lose, P+1 L+1, 0 points each, no score credited, excluded from every ratio.
    const keys = SCORE_KEYS[c.sport] ?? [];
    return { winner: zeros(keys), loser: zeros(keys), excluded: [...(RATIO_OPERANDS[c.sport] ?? [])], points: "zero", statsMatch: false };
  }
  // PF-7: a withdrawal before start takes the walkover credit; after start (a held level result included, X-WD-1) the
  // retirement credit — the played score stands. X-RT-1: an in-match disqualification takes the retirement credit.
  const retirement = c.reason === "retired" || c.reason === "disqualified" || (c.reason === "withdrew" && started);
  const sp = retirement ? p : null;
  let credit: Credit;
  if (GOALS.includes(c.sport)) credit = goalCredit(c.sport, c.cfg, sp);
  else if (SETS.includes(c.sport)) credit = setCredit(c.sport, c.cfg, sp);
  else if (c.sport === "tennis") credit = tennisCredit(c.cfg);
  else if (c.sport === "cricket") credit = cricketCredit(c.cfg);
  else if (chess) credit = chessCredit();
  else if (c.sport === "carrom") credit = carromCredit(c.cfg, sp);
  else credit = genericCredit(c.cfg, sp);
  // X-PS-1: a walkover or a withdrawal is never a match played in players' stats; X-PS-2: a retirement or an in-match
  // disqualification is, W/L as decided.
  const statsMatch = c.reason === "retired" || c.reason === "disqualified";
  return { winner: credit.winner, loser: credit.loser, excluded: credit.excluded, points: "win", statsMatch };
}

/** The sport's declared cfg entries and played scenarios (walkover-credit-cfgs.ts). */
function dataOf(sport: string): { cfgs: readonly CreditCfgEntry[]; played: readonly PlayedScenario[] } {
  const d = WALKOVER_CREDIT_DATA[sport];
  if (d === undefined) throw new CreditRefused("unknown-sport", `no credit data for ${sport}`);
  return d;
}

/** Every case the family answers: per sport, the 5 BASE cases (its first cfg: walkover, withdrew before start and the
 *  double walkover; its first played scenario: retired and disqualified) — 11 × 5 = 55 — then every other cfg's
 *  walkover, withdrawal and double walkover, and every other played scenario's retirement, disqualification and
 *  withdrawal after start (PF-7). Deterministic, in the registry's order. */
export function enumerateCreditCases(): CreditCase[] {
  const base: CreditCase[] = [];
  const variants: CreditCase[] = [];
  for (const sport of CREDIT_SPORTS) {
    const { cfgs, played } = dataOf(sport);
    const cfgByName = new Map(cfgs.map((e) => [e.name, e.cfg]));
    const unplayed = (e: CreditCfgEntry, reason: CreditReason): CreditCase => ({ sport, cfg: { ...e.cfg }, reason, variant: e.name, label: `${sport} · ${e.name} · ${reason}` });
    const withPlay = (s: PlayedScenario, reason: CreditReason): CreditCase => {
      const cfg = cfgByName.get(s.cfg);
      if (cfg === undefined) throw new CreditRefused("cfg-invalid", `${sport}: scenario "${s.name}" names cfg "${s.cfg}", which is not declared`);
      return { sport, cfg: { ...cfg }, reason, played: { home: [...s.home], away: [...s.away] }, by: s.by ?? "away", variant: s.cfg, label: `${sport} · ${s.cfg} · ${reason} · ${s.name}` };
    };
    const [firstCfg, ...otherCfgs] = cfgs;
    const [firstPlay, ...otherPlays] = played;
    if (firstCfg === undefined || firstPlay === undefined) throw new CreditRefused("cfg-invalid", `${sport}: the data holds no cfg or no played scenario`);
    base.push(unplayed(firstCfg, "walkover"), withPlay(firstPlay, "retired"), withPlay(firstPlay, "disqualified"), unplayed(firstCfg, "withdrew"), unplayed(firstCfg, "double_walkover"));
    for (const e of otherCfgs) variants.push(unplayed(e, "walkover"), unplayed(e, "withdrew"), unplayed(e, "double_walkover"));
    for (const s of [firstPlay, ...otherPlays]) variants.push(withPlay(s, "withdrew"));
    for (const s of otherPlays) variants.push(withPlay(s, "retired"), withPlay(s, "disqualified"));
  }
  return [...base, ...variants];
}

/** The family record: what it answers from and which rows it covers (its test proves each row exists and is cited in
 *  a test title). Not in `FAMILIES`: its domain is a forfeited match, not a stage kind × sport pair. */
export interface WalkoverCreditFamily {
  readonly id: "walkover-credit";
  readonly rulebook: string;
  readonly rows: readonly string[];
  /** Orchestrator pre-flight rulings the family also encodes (rows T14 adds: CK-WO-2, X-WD-6). */
  readonly rulings: readonly string[];
  readonly sports: readonly string[];
  credit(c: CreditCase): CreditAnswer;
}

export const walkoverCreditFamily: WalkoverCreditFamily = Object.freeze({
  id: "walkover-credit",
  rulebook: "spec 2026-10-08-format-matrix-w2b-design.md Appendix A; rulebook-W2-goals-boards.md; rulebook-W2-sets-cricket.md",
  rows: Object.freeze([
    "X-RS-1", "X-DW-1", "X-DW-4", "X-WO-1", "X-RT-1", "X-WD-1", "X-PS-1", "X-PS-2",
    "FB-WO-1", "FB-RT-1", "HK-WO-1", "HK-RT-1", "IH-WO-1", "IH-RT-1",
    "VB-WO-1", "VB-RT-1", "TT-WO-1", "TT-RT-1", "TN-WO-1", "TN-RT-1", "BD-WO-1", "BD-RT-1",
    "CK-WO-1", "BG-WO-1", "BG-WO-2", "CA-WO-1", "CA-RT-1", "GN-WO-1", "GN-RT-1",
  ]),
  rulings: Object.freeze(["PF-6", "PF-7"]),
  sports: CREDIT_SPORTS,
  credit: (c: CreditCase): CreditAnswer => walkoverCredit(c),
} as const);

