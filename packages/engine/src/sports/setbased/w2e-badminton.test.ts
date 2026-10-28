// W2e Task 3 (spec 2026-10-28 §5.1, §5.2; D1, D2, D3 (1), D12, D13): badminton's BWF 3×15 variant and its explicit 3×21,
// the badminton black card that ends the match, and volleyball's sanctions that never do (rows BD-VR-1, BD-SE-1, VB-SE-1;
// X-SE-1 on a real module).
//
// Expected values come from the rulebook and the rule rows, never from the code under test:
//  - RBS = docs/superpowers/specs/2026-09-27-format-matrix-prompts/rulebook-W2-sets-cricket.md. §3.2 "Legal game end
//    scores (exhaustive)" lists every legal final score of a game under 3×21 (BWF Laws 7.1, 7.3–7.5, source B1), 3×15
//    (B3, RB2A-1) and the product `short` variant, and says the third game is "played under the same target";
//  - BD-RT-1 (rules/badminton.md): a retirement's points played stand, "the current game completed for the winner to its
//    legal end (21, or two clear up to the 30 cap), remaining games 21-0" (X-RT-1 gives a disqualification that credit);
//  - VB-RT-1 (rules/volleyball.md): the winner is "given the sets and points it needed; the retiring side keeps what it won";
//  - the spec's §5.2 table and D12/D13: badminton's `disqualification` (the black card) ends the match, volleyball's
//    `expulsion` and `disqualification` only prompt the "can the team still field six?" question.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatchWithStoppage, type CoreEv, type EventEnvelope } from "../../core/events.ts";
import { lastLiveEvent, matchEndFacts, pendingEndingSanction, scorerMayForfeit } from "../../core/sanction-ending.ts";
import type { ForfeitReason, LineupPair } from "../../core/types.ts";
import { resolvePositions } from "../../sport/catalog.ts";
import type { PadSpec } from "../../sport/module.ts";
import { buildStream, defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { badminton } from "./badminton.ts";
import type { SetBasedCfg, SetBasedEv, SetBasedState } from "./kernel.ts";
import { tabletennis } from "./tabletennis.ts";
import { volleyball } from "./volleyball.ts";

type Mod = typeof badminton;
type Side = "home" | "away";

const H = "H";
const A = "A";
const sideOf = (entrant: string): Side => (entrant === H ? "home" : "away");
const other = (entrant: string): string => (entrant === H ? A : H);

const cfgOf = (m: Mod, variant?: string): SetBasedCfg =>
  m.configSchema.parse(variant === undefined ? {} : m.variants[variant]);
const lineupsOf = (m: Mod, cfg: SetBasedCfg): LineupPair => defaultLineupPair(resolvePositions(m, cfg));

const summaryType = (m: Mod) => `${m.key}.${m.key === "volleyball" ? "set" : "game"}.summary`;

/** A ledger built one append at a time through the WRITE path: each new event folds strictly over the history before
 *  it (append-event.ts's shape), so an append the write path refuses throws here. */
class Ledger {
  readonly events: EventEnvelope[] = [];
  readonly lineups: LineupPair;
  constructor(
    readonly m: Mod,
    readonly cfg: SetBasedCfg,
  ) {
    this.lineups = lineupsOf(m, cfg);
  }
  next(type: string, payload: unknown = {}): EventEnvelope {
    return makeEnvelope(this.events.length, { type, payload });
  }
  /** Folds `candidate` on the write path WITHOUT keeping it. */
  write(candidate: EventEnvelope) {
    return foldMatchWithStoppage(this.m, this.cfg, this.lineups, [...this.events, candidate], { strictFromSeq: candidate.seq });
  }
  append(type: string, payload: unknown = {}): this {
    const candidate = this.next(type, payload);
    this.write(candidate);
    this.events.push(candidate);
    return this;
  }
  rallies(...winners: string[]): this {
    for (const wonBy of winners) this.append(`${this.m.key}.rally`, { wonBy });
    return this;
  }
  summary(home: number, away: number): this {
    return this.append(summaryType(this.m), { home, away });
  }
  sanction(by: string, level: string): this {
    return this.append(`${this.m.key}.sanction`, { by, level });
  }
  forfeit(by: string, reason: ForfeitReason): this {
    return this.append("core.forfeit", { by, reason });
  }
  get state(): SetBasedState {
    return foldMatchWithStoppage(this.m, this.cfg, this.lineups, this.events).state;
  }
  pending() {
    const folded = foldMatchWithStoppage(this.m, this.cfg, this.lineups, this.events);
    return pendingEndingSanction(this.m, this.events, matchEndFacts(this.m, folded, this.events));
  }
  mayForfeit(by: string, reason: ForfeitReason): boolean {
    return scorerMayForfeit(this.m, lastLiveEvent(this.events), { by, reason });
  }
}

const started = (m: Mod, cfg: SetBasedCfg) => new Ledger(m, cfg).append("core.start");
const times = (n: number, entrant: string): string[] => Array.from({ length: n }, () => entrant);
/** Rallies that bring a game to `a` for `first` and `b` for `second` without ending it on the way: alternate up to the
 *  lower score, then the leader alone. */
const toScore = (first: string, a: number, second: string, b: number): string[] => [
  ...Array.from({ length: Math.min(a, b) }, () => [first, second]).flat(),
  ...times(Math.abs(a - b), a > b ? first : second),
];

function refusal(fn: () => unknown): EngineError {
  try {
    fn();
  } catch (e) {
    if (e instanceof EngineError) return e;
    throw e;
  }
  throw new Error("expected the write path to refuse the event; it admitted it");
}

// ---------------------------------------------------------------------------
// BD-VR-1 — the variants against RBS §3.2.
// ---------------------------------------------------------------------------

/** RBS §3.2, "Legal game end scores (exhaustive)", winner first, one row per rule set:
 *  - 3×21 (Laws today): "21–0 … 21–19; 22–20, 23–21, …, 29–27, 30–28 (every n–(n−2) for 22 ≤ n ≤ 30); 30–29";
 *  - 3×15 (from 4 Jan 2027): "15–0 … 15–13; 16–14, …, 21–19 (n–(n−2) for 16 ≤ n ≤ 21); 21–20";
 *  - product `short` (11, cap 15): "11–0 … 11–9; 12–10 … 15–13; 15–14".
 *  `plain` is the target and the most the loser may hold at it; `deuce` the n of every n–(n−2); `golden` the capped end.
 *  `rule` is the cfg RBS names for it (B1 Law 7.1 best of three, 7.3 21 points, 7.4 two clear from 20-all, 7.5 the 30th
 *  point at 29-all; B3 "to 15, win by 2 from 14-all, cap 21 (20-all → next point), best of three"; the third game is
 *  "played under the same target"). */
const RBS_GAME_ENDS = [
  {
    variant: "bwf",
    rule: { bestOf: 3, setTo: 21, finalSetTo: 21, winBy: 2, cap: 30 },
    plain: [21, 19],
    deuce: [22, 30],
    golden: [30, 29],
  },
  {
    variant: "bwf-3x15",
    rule: { bestOf: 3, setTo: 15, finalSetTo: 15, winBy: 2, cap: 21 },
    plain: [15, 13],
    deuce: [16, 21],
    golden: [21, 20],
  },
  {
    variant: "short",
    rule: { bestOf: 3, setTo: 11, finalSetTo: 11, winBy: 2, cap: 15 },
    plain: [11, 9],
    deuce: [12, 15],
    golden: [15, 14],
  },
] as const;

function rbsLegal(row: (typeof RBS_GAME_ENDS)[number]): Set<string> {
  const legal = new Set<string>();
  for (let lo = 0; lo <= row.plain[1]; lo++) legal.add(`${row.plain[0]}-${lo}`);
  for (let n = row.deuce[0]; n <= row.deuce[1]; n++) legal.add(`${n}-${n - 2}`);
  legal.add(`${row.golden[0]}-${row.golden[1]}`);
  return legal;
}

/** Whether the write path takes `home`-`away` as the completed summary of the game after `before` (each a won game). */
function summaryTaken(cfg: SetBasedCfg, before: readonly [number, number][], home: number, away: number): boolean {
  const ledger = started(badminton, cfg);
  for (const [h, a] of before) ledger.summary(h, a);
  try {
    ledger.write(ledger.next("badminton.game.summary", { home, away }));
    return true;
  } catch (e) {
    if (EngineError.is(e, "INVALID_EVENT")) return false;
    throw e;
  }
}

describe("BD-VR-1 badminton variants against RBS §3.2", () => {
  it("BD-VR-1 bwf-3x15 plays 15, win by 2, cap 21 (RB2A-1)", () => {
    const row = RBS_GAME_ENDS[1];
    const cfg = cfgOf(badminton, "bwf-3x15");
    expect(cfg).toMatchObject(row.rule);

    // 15–13 by rallies closes the game; 14–14 does not, and two clear closes it at 16–14.
    const plain = started(badminton, cfg).rallies(...times(13, A), ...times(15, H));
    expect(plain.state.sets).toEqual([{ home: 15, away: 13, closed: true }]);
    expect(plain.state.setsWon).toEqual({ home: 1, away: 0 });
    // 20–20 is live, and the next point wins it 21–20 (the cap; B3 "20-all → next point").
    const capped = started(badminton, cfg).rallies(...toScore(H, 20, A, 20));
    expect(capped.state.sets).toEqual([{ home: 20, away: 20, closed: false }]);
    capped.rallies(A);
    expect(capped.state.sets).toEqual([{ home: 20, away: 21, closed: true }]);
    expect(capped.state.setsWon).toEqual({ home: 0, away: 1 });

    // A 22–20 summary is past the cap: refused (RBS "anything above the cap").
    expect(summaryTaken(cfg, [], 22, 20)).toBe(false);
    expect(summaryTaken(cfg, [], 21, 20)).toBe(true);
    expect(summaryTaken(cfg, [], 15, 13)).toBe(true);

    // Best of three: two games decide it.
    const match = started(badminton, cfg).summary(15, 9).summary(21, 20);
    expect(badminton.outcome(match.state)).toMatchObject({ kind: "win", winner: H });
  });

  it("BD-VR-1 bwf stays 21/21/30 (BWF Laws 7.1, 7.3–7.5 as RBS cites them), named in the variant itself", () => {
    const row = RBS_GAME_ENDS[0];
    expect(cfgOf(badminton, "bwf")).toMatchObject(row.rule);
    // Spec §5.1 (author's call): the 3×21 values are written in the variant, so no later change to the module defaults can
    // move the variant labelled 3×21.
    expect(badminton.variants.bwf).toMatchObject({ setTo: 21, finalSetTo: 21, cap: 30 });
  });

  it("BD-VR-1 every variant takes exactly RBS §3.2's legal game ends, in the first game and the third (counted)", () => {
    let checked = 0;
    let taken = 0;
    for (const row of RBS_GAME_ENDS) {
      const cfg = cfgOf(badminton, row.variant);
      const legal = rbsLegal(row);
      // The first game, and the third after a game each (RBS: the decider is "played under the same target").
      for (const before of [[], [[row.plain[0], 0], [0, row.plain[0]]]] as [number, number][][]) {
        for (let hi = 1; hi <= row.rule.cap + 3; hi++) {
          for (let lo = 0; lo < hi; lo++) {
            const want = legal.has(`${hi}-${lo}`);
            expect(summaryTaken(cfg, before, hi, lo), `${row.variant} game ${before.length + 1}: ${hi}-${lo}`).toBe(want);
            expect(summaryTaken(cfg, before, lo, hi), `${row.variant} game ${before.length + 1}: ${lo}-${hi}`).toBe(want);
            checked += 2;
            if (want) taken += 2;
          }
        }
      }
      // Each row of RBS's table is exactly this many scores per game per side: 3×21 30, 3×15 21, short 15.
      expect(legal.size, row.variant).toBe({ bwf: 30, "bwf-3x15": 21, short: 15 }[row.variant]);
    }
    // Anti-vacuity: (30 + 21 + 15) legal scores × 2 sides × 2 games were taken, out of every pair swept.
    expect(taken).toBe((30 + 21 + 15) * 2 * 2);
    expect(checked).toBeGreaterThan(taken);
  });

  it("BD-VR-1 anti-goal 2: a recorded pre-W2e bwf division config parses to 21/21/30", () => {
    // Verbatim: `declarations.badminton.defaultConfig` of apps/web/src/server/engine-db/__tests__/fixtures/w2d-pin-before.json
    // (captured before W2e), the fully parsed config a `bwf` division stores.
    const stored = {
      bestOf: 3,
      setTo: 21,
      finalSetTo: 21,
      winBy: 2,
      cap: 30,
      pointsMap: { "*": [2, 0] },
      records: { timeouts: false, sanctions: true, substitutions: false, expedite: false },
    };
    const parsed = badminton.configSchema.parse(stored);
    expect(parsed).toEqual(stored);
    // The module defaults do not change either (spec §5.1: new divisions reach 3×15 through the creation pick only).
    expect(badminton.configSchema.parse({})).toMatchObject(RBS_GAME_ENDS[0].rule);
    // ...so the stored division keeps scoring under 3×21: 21–20 is no game end, 22–20 is, 15–13 is not.
    expect(summaryTaken(parsed, [], 21, 20)).toBe(false);
    expect(summaryTaken(parsed, [], 22, 20)).toBe(true);
    expect(summaryTaken(parsed, [], 15, 13)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BD-SE-1 — the black card ends the match, with X-RT-1's (BD-RT-1's) credit.
// ---------------------------------------------------------------------------

/** One credit case: game 1 is H's 21–15 (15–9 under 3×15); in game 2 the offender holds `offender` points and the other
 *  side `winner`; the offender takes the black card, then the ending. Expected by hand from BD-RT-1: the game in play is
 *  completed for the winner to its legal end (`gameTo`), and every game it still needs is credited at the target, 0. */
interface CreditCase {
  variant: string;
  game1: [number, number];
  offender: number;
  winner: number;
  gameTo: number;
}
const CREDIT_CASES: CreditCase[] = [
  { variant: "bwf", game1: [21, 15], offender: 7, winner: 4, gameTo: 21 }, // the target
  { variant: "bwf", game1: [21, 15], offender: 20, winner: 19, gameTo: 22 }, // two clear
  { variant: "bwf", game1: [21, 15], offender: 29, winner: 28, gameTo: 30 }, // the 30 cap
  { variant: "bwf-3x15", game1: [15, 9], offender: 7, winner: 4, gameTo: 15 },
  { variant: "bwf-3x15", game1: [15, 9], offender: 14, winner: 13, gameTo: 16 },
  { variant: "bwf-3x15", game1: [15, 9], offender: 20, winner: 19, gameTo: 21 }, // the 21 cap
];
/** The target a credited remaining game is played to (BD-RT-1 "21-0"; under 3×15, RB2A-1's 15). */
const TARGET: Record<string, number> = { bwf: 21, "bwf-3x15": 15 };

describe("BD-SE-1 a badminton black card ends the match", () => {
  it("BD-SE-1 a black card followed by core.forfeit{disqualified} ends the match for the other side with the retirement credit", () => {
    let checked = 0;
    for (const c of CREDIT_CASES) {
      for (const offender of [H, A]) {
        const winner = other(offender);
        const cfg = cfgOf(badminton, c.variant);
        const ledger = started(badminton, cfg)
          .summary(...c.game1)
          .rallies(...toScore(offender, c.offender, winner, c.winner))
          .sanction(offender, "disqualification")
          .forfeit(offender, "disqualified");
        const where = `${c.variant} ${offender} at ${c.offender}-${c.winner}`;
        expect(badminton.outcome(ledger.state), where).toEqual({ kind: "award", winner, loser: offender, reason: "disqualified" });

        // H won game 1. If H is the offender, A needs game 2 (completed) and game 3 (credited at the target, 0); if A is,
        // H needs game 2 only.
        const [g1Home, g1Away] = c.game1;
        const target = TARGET[c.variant]!;
        const expected =
          offender === H
            ? {
                home: { sets_won: 1, sets_lost: 2, points_won: g1Home + c.offender, points_lost: g1Away + c.gameTo + target },
                away: { sets_won: 2, sets_lost: 1, points_won: g1Away + c.gameTo + target, points_lost: g1Home + c.offender },
              }
            : {
                home: { sets_won: 2, sets_lost: 0, points_won: g1Home + c.gameTo, points_lost: g1Away + c.offender },
                away: { sets_won: 0, sets_lost: 2, points_won: g1Away + c.offender, points_lost: g1Home + c.gameTo },
              };
        const credit = badminton.forfeitCredit(cfg, ledger.state, "disqualified", sideOf(offender));
        expect(credit.perSide, where).toEqual([expected.home, expected.away]);
        checked++;
      }
    }
    expect(checked).toBe(CREDIT_CASES.length * 2);
  });

  it("BD-SE-1 X-SE-1 after a black card the write path takes only the ending or an abandon, and the scorer may send the ending", () => {
    let refused = 0;
    for (const offender of [H, A]) {
      const cfg = cfgOf(badminton, "bwf");
      const before = () => started(badminton, cfg).summary(21, 15).rallies(H, A);
      const carded = before().sanction(offender, "disqualification");
      // Every scoring or record event but the ending is refused, naming the card (X-SE-1).
      const candidates = [
        carded.next("badminton.rally", { wonBy: H }),
        carded.next("badminton.rally", { wonBy: A }),
        carded.next("badminton.game.summary", { home: 3, away: 1, partial: true }),
        carded.next("badminton.sanction", { by: other(offender), level: "warning" }),
        carded.next("core.note", { text: "umpire's note" }),
      ];
      for (const candidate of candidates) {
        const e = refusal(() => carded.write(candidate));
        expect(e.code, `${candidate.type} after ${offender}'s black card`).toBe("ENDING_SANCTION_PENDING");
        expect(e.data).toEqual({ by: offender, level: "disqualification" });
        refused++;
        // Differential: the same event after a red card (`penalty`) is admitted — the level is what ends a match.
        const red = before().sanction(offender, "penalty");
        expect(() => red.write({ ...candidate, seq: red.events.length, id: `e-${red.events.length}` }), `${candidate.type}`).not.toThrow();
      }
      expect(carded.pending()).toEqual({ by: offender, level: "disqualification" });
      // D13: the scorer may send `disqualified` against the carded side, never `retired`, never against the other side.
      expect(carded.mayForfeit(offender, "disqualified")).toBe(true);
      expect(carded.mayForfeit(offender, "retired")).toBe(false);
      expect(carded.mayForfeit(other(offender), "disqualified")).toBe(false);
      // The abandon stays admitted; the ending decides the match and lifts the refusal.
      expect(() => carded.write(carded.next("core.abandon", { reason: "venue closed" }))).not.toThrow();
      carded.forfeit(offender, "disqualified");
      expect(carded.pending()).toBeNull();
      expect(badminton.outcome(carded.state)).toMatchObject({ kind: "award", winner: other(offender), loser: offender });
    }
    expect(refused).toBe(10);
  });

  it("BD-SE-1 only the black card ends a badminton match: warning, red card and expulsion are records (spec §5.2)", () => {
    // Spec §5.2's table: badminton's ending level is `disqualification` (black card) and nothing else; D13 names no
    // badminton prompt level.
    const ENDS: Record<string, boolean> = { warning: false, penalty: false, expulsion: false, disqualification: true };
    let checked = 0;
    for (const [level, ends] of Object.entries(ENDS)) {
      for (const offender of [H, A]) {
        const ledger = started(badminton, cfgOf(badminton, "bwf")).rallies(H).sanction(offender, level);
        const rally = ledger.next("badminton.rally", { wonBy: H });
        if (ends) expect(refusal(() => ledger.write(rally)).code).toBe("ENDING_SANCTION_PENDING");
        else expect(() => ledger.write(rally), level).not.toThrow();
        expect(ledger.pending(), level).toEqual(ends ? { by: offender, level } : null);
        expect(ledger.mayForfeit(offender, "disqualified"), level).toBe(ends);
        expect(ledger.mayForfeit(offender, "retired"), level).toBe(false);
        checked++;
      }
    }
    expect(checked).toBe(8);
  });

  it("BD-SE-1 X-SE-1 coarsen closes the open game BEFORE a black card, so the coarse ledger is one the write path takes", () => {
    // §9.6 (dual fidelity): the coarse stream of a black card in the middle of a game must fold like the fine one. Only
    // the ending may follow the card on the write path, so the game's snapshot has to come before it; a warning stays
    // transparent (the game goes on after it, and one game is one coarse summary).
    let checked = 0;
    for (const [level, cardFirst] of [["disqualification", false], ["warning", true]] as const) {
      const fine = started(badminton, cfgOf(badminton, "bwf")).rallies(...toScore(H, 8, A, 4)).sanction(A, level);
      if (level === "disqualification") fine.forfeit(A, "disqualified");
      else fine.rallies(H);
      const coarse = badminton.coarsen!(fine.events as EventEnvelope<SetBasedEv | CoreEv>[]);
      const types = coarse.map((e) => e.type);
      const card = types.indexOf("badminton.sanction");
      const snapshot = types.indexOf("badminton.game.summary");
      expect(card, level).toBeGreaterThan(0);
      expect(snapshot, level).toBeGreaterThan(0);
      expect(card < snapshot, `${level}: ${types.join(", ")}`).toBe(cardFirst);
      const envelopes = coarse.map((e, i) => makeEnvelope(i, e));
      const folded = foldMatchWithStoppage(badminton, fine.cfg, fine.lineups, envelopes, { strictFromSeq: 0 }).state;
      expect(badminton.outcome(folded), level).toEqual(badminton.outcome(fine.state));
      expect(badminton.summary(folded), level).toEqual(badminton.summary(fine.state));
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("BD-SE-1 X-SE-1 replay folds a pre-W2e ledger with play after a black card to its recorded result; the write path refuses it", () => {
    const cfg = cfgOf(badminton, "bwf");
    const lineups = lineupsOf(badminton, cfg);
    // Recorded before W2e: A's black card, then H took both games.
    const legacy = [
      makeEnvelope(0, { type: "core.start", payload: {} }),
      makeEnvelope(1, { type: "badminton.sanction", payload: { by: A, level: "disqualification" } }),
      makeEnvelope(2, { type: "badminton.game.summary", payload: { home: 21, away: 0 } }),
      makeEnvelope(3, { type: "badminton.game.summary", payload: { home: 21, away: 0 } }),
    ];
    const replayed = foldMatchWithStoppage(badminton, cfg, lineups, legacy).state;
    expect(badminton.outcome(replayed)).toMatchObject({ kind: "win", winner: H });
    expect(replayed.setsWon).toEqual({ home: 2, away: 0 });
    const e = refusal(() => foldMatchWithStoppage(badminton, cfg, lineups, legacy, { strictFromSeq: 0 }));
    expect(e.code).toBe("ENDING_SANCTION_PENDING");
  });
});

// ---------------------------------------------------------------------------
// VB-SE-1 — a volleyball expulsion or disqualification never ends the match by itself (D12).
// ---------------------------------------------------------------------------

describe("VB-SE-1 volleyball sanctions never end the match by themselves (D12)", () => {
  it("VB-SE-1 a volleyball disqualification alone leaves the match live; forfeit{retired} after it ends it", () => {
    // D12/D13: `expulsion` and `disqualification` prompt "can the team still field six?"; `warning` and `penalty` do not.
    const PROMPTS: Record<string, boolean> = { warning: false, penalty: false, expulsion: true, disqualification: true };
    let checked = 0;
    for (const variant of ["indoor", "beach"]) {
      const cfg = cfgOf(volleyball, variant);
      for (const [level, prompts] of Object.entries(PROMPTS)) {
        for (const offender of [H, A]) {
          const where = `${variant} ${level} against ${offender}`;
          const ledger = started(volleyball, cfg).summary(cfg.setTo, cfg.setTo - 5).rallies(H, A).sanction(offender, level);
          // The match is live: the next rally and a whole set are taken, and no ending is pending.
          expect(() => ledger.write(ledger.next("volleyball.rally", { wonBy: other(offender) })), where).not.toThrow();
          expect(ledger.pending(), where).toBeNull();
          expect(volleyball.outcome(ledger.state), where).toBeNull();
          // D13: right after it, the scorer may send `retired` against the sanctioned side (the "no" answer), only at a
          // prompt level, and never `disqualified`.
          expect(ledger.mayForfeit(offender, "retired"), where).toBe(prompts);
          expect(ledger.mayForfeit(offender, "disqualified"), where).toBe(false);
          expect(ledger.mayForfeit(other(offender), "retired"), where).toBe(false);
          // "No": the incomplete-team ending (VB-RT-1) decides it for the other side.
          ledger.forfeit(offender, "retired");
          expect(volleyball.outcome(ledger.state), where).toEqual({ kind: "award", winner: other(offender), loser: offender, reason: "retired" });
          checked++;
        }
      }
    }
    expect(checked).toBe(2 * 4 * 2);
  });

  it("VB-SE-1 the incomplete-team ending after a disqualification credits VB-RT-1's score", () => {
    // Indoor, best of five to 25: H took set 1 25–20; set 2 stands at H 10, A 8 when H's player is disqualified and H
    // cannot field six. VB-RT-1: A is given the sets and points it needed (set 2 completed to 25, sets 3 and 4 at 25–0),
    // and H keeps what it won.
    const cfg = cfgOf(volleyball, "indoor");
    const ledger = started(volleyball, cfg)
      .summary(25, 20)
      .rallies(...times(10, H), ...times(8, A))
      .sanction(H, "disqualification")
      .forfeit(H, "retired");
    expect(volleyball.forfeitCredit(cfg, ledger.state, "retired", "home").perSide).toEqual([
      { sets_won: 1, sets_lost: 3, points_won: 25 + 10, points_lost: 20 + 25 + 25 + 25 },
      { sets_won: 3, sets_lost: 1, points_won: 20 + 25 + 25 + 25, points_lost: 25 + 10 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The set kernel's generator (W2e controller ruling, Task 3): it draws only the sanction levels the sport's pad offers.
// ---------------------------------------------------------------------------

function offeredLevels(m: Mod): readonly string[] {
  const spec: PadSpec = m.padSpec!(m.configSchema.parse({}));
  for (const panel of spec.panels) {
    for (const action of panel.actions) {
      if (action.type !== `${m.key}.sanction`) continue;
      const field = action.fields.find((f) => f.path === "level");
      if (field?.kind === "enum") return field.values;
    }
  }
  throw new Error(`${m.key}: its pad offers no sanction level`);
}

describe("set kernel arbitraryEvent draws only the sanction levels the sport's pad offers", () => {
  it("every generated sanction level is one the pad offers, and every offered level is drawn (counted)", () => {
    let sanctions = 0;
    for (const m of [volleyball, badminton, tabletennis]) {
      const offered = offeredLevels(m);
      const drawn = new Set<string>();
      for (const variant of Object.keys(m.variants)) {
        const cfg = cfgOf(m, variant);
        if (!cfg.records.sanctions) continue;
        for (let seed = 1; seed <= 60; seed++) {
          for (const event of buildStream(m, cfg, lineupsOf(m, cfg), seed, 300)) {
            if (event.type !== `${m.key}.sanction`) continue;
            drawn.add((event.payload as { level: string }).level);
            sanctions++;
          }
        }
      }
      expect([...drawn].sort(), m.key).toEqual([...offered].sort());
    }
    expect(sanctions).toBeGreaterThan(0);
  });
});
