// W2e Task 4 (spec 2026-10-28 §5.2, §5.5; D3 (1), D8, D13): a tennis `default` ends the match, and a set summary must be a
// score a set can reach (rows TN-SE-1, TN-SS-1; X-SE-1 on the nested kernel).
//
// Expected values come from the rulebook and the rule rows, never from the code under test:
//  - RBS = docs/superpowers/specs/2026-09-27-format-matrix-prompts/rulebook-W2-sets-cricket.md, §6.2's table of legal final
//    set scores (ITF Rules of Tennis 2026, Rules 5-7 and App VI):
//      :343 "Tie-break set (6b) | 6–0 … 6–4; 7–5; **7–6** with TB …";
//      :344 "Advantage set (6a) | 6–0 … 6–4; n–(n−2), n ≥ 7 (8–6, 9–7, …)";
//      :346 "Short set, TB at 3-all (App VI §1, the alternative; "Fast4") | 4–0 … 4–2; **4–3** with TB. 5–3 is
//           **impossible** (3-all goes to the TB)";
//      :350 "**Illegal in any tie-break set** | 8–6, 9–7 (7–6 is terminal in a TB set); 7–7; 6–5";
//  - TN-RT-1 / TN-WO-1 (rules/tennis.md): a retirement (and X-RT-1's disqualification) credits "straight sets for set %; the
//    match's games excluded from game %";
//  - the spec's §5.2 table and D13: tennis's `default` ends the match, no tennis level only prompts; the scorer may send
//    `core.forfeit{disqualified}` right after a default against the same player.
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatchWithStoppage, type EventEnvelope } from "../../core/events.ts";
import { lastLiveEvent, matchEndFacts, pendingEndingSanction, scorerMayForfeit } from "../../core/sanction-ending.ts";
import type { ForfeitReason, LineupPair } from "../../core/types.ts";
import type { PadSpec } from "../../sport/module.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { tennis } from "../tennis/tennis.ts";
import { reachableLiveGames, type NestedCfg, type NestedState } from "./kernel.ts";

const lineups: LineupPair = defaultLineupPair(tennis.positions);
const H = lineups.home.entrantId;
const A = lineups.away.entrantId;
const other = (entrant: string): string => (entrant === H ? A : H);

const cfgFor = (variant?: string, extra?: Record<string, unknown>): NestedCfg =>
  tennis.configSchema.parse({ ...(variant === undefined ? {} : tennis.variants[variant]), ...(extra ?? {}) });

/** A ledger built one append at a time through the WRITE path: each new event folds strictly over the history before it
 *  (append-event.ts's shape), so an append the write path refuses throws here. */
class Ledger {
  readonly events: EventEnvelope[] = [];
  constructor(readonly cfg: NestedCfg) {}
  next(type: string, payload: unknown = {}, voids?: string): EventEnvelope {
    return makeEnvelope(this.events.length, { type, payload }, voids);
  }
  /** Folds `candidate` on the write path WITHOUT keeping it. */
  write(candidate: EventEnvelope) {
    return foldMatchWithStoppage(tennis, this.cfg, lineups, [...this.events, candidate], { strictFromSeq: candidate.seq });
  }
  append(type: string, payload: unknown = {}, voids?: string): this {
    const candidate = this.next(type, payload, voids);
    this.write(candidate);
    this.events.push(candidate);
    return this;
  }
  points(...by: string[]): this {
    for (const b of by) this.append("tennis.point", { by: b });
    return this;
  }
  summary(home: number, away: number, tb?: { home: number; away: number }): this {
    return this.append("tennis.set_summary", { home, away, ...(tb === undefined ? {} : { tb }) });
  }
  sanction(by: string, level: string): this {
    return this.append("tennis.sanction", { by, level });
  }
  forfeit(by: string, reason: ForfeitReason): this {
    return this.append("core.forfeit", { by, reason });
  }
  /** Voids the event at `seq`. */
  voids(seq: number): this {
    return this.append("core.void", {}, this.events[seq]!.id);
  }
  get state(): NestedState {
    return foldMatchWithStoppage(tennis, this.cfg, lineups, this.events).state;
  }
  pending() {
    const folded = foldMatchWithStoppage(tennis, this.cfg, lineups, this.events);
    return pendingEndingSanction(tennis, this.events, matchEndFacts(tennis, folded, this.events));
  }
  mayForfeit(by: string, reason: ForfeitReason): boolean {
    return scorerMayForfeit(tennis, lastLiveEvent(this.events), { by, reason });
  }
}

const started = (cfg: NestedCfg) => new Ledger(cfg).append("core.start");

function refusal(fn: () => unknown): EngineError {
  try {
    fn();
  } catch (e) {
    if (e instanceof EngineError) return e;
    throw e;
  }
  throw new Error("expected the write path to refuse the event; it admitted it");
}

/** The write path's answer to `home`-`away` as the summary of the first set of a fresh match: "taken", or the refusal code. */
function firstSetAnswer(cfg: NestedCfg, home: number, away: number): string {
  const ledger = started(cfg);
  try {
    ledger.write(ledger.next("tennis.set_summary", { home, away }));
    return "taken";
  } catch (e) {
    if (e instanceof EngineError) return e.code;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// TN-SS-1 — a set summary must be a score the set can reach (SC-S1).
// ---------------------------------------------------------------------------

/** A tour config whose set is an ADVANTAGE set (RBS:344, Rule 6a): no tie-break at all. */
const advantageCfg = () => cfgFor("tour", { set: { gamesTo: 6, winBy: 2, tiebreakAt: null, tiebreakTo: 7 } });

/** RBS §6.2's legal PLAIN final set scores (no tie-break block), winner first. `plainTo`: the target, and the most games
 *  the loser may hold at it; `deuce`: every n–(n−2) for n in the range (RBS:343's "7–5" is n = 7 alone; RBS:344's "n ≥ 7"
 *  is cut at the enumeration's edge, `EDGE`). The 7–6 and 4–3 ends take a tie-break block, so they are no plain final. */
const EDGE = 14;
const RBS_PLAIN_FINALS = [
  { row: "RBS:343 tie-break set (6b), the tour default", cfg: () => cfgFor("tour"), plainTo: [6, 4], deuce: [7, 7] },
  { row: "RBS:344 advantage set (6a)", cfg: advantageCfg, plainTo: [6, 4], deuce: [7, EDGE] },
  { row: "RBS:346 short set, TB at 3-all (Fast4)", cfg: () => cfgFor("fast4"), plainTo: [4, 2], deuce: [0, -1] },
] as const;

function rbsPlainLegal(row: (typeof RBS_PLAIN_FINALS)[number]): Set<string> {
  const legal = new Set<string>();
  const add = (w: number, l: number) => legal.add(`${w}-${l}`).add(`${l}-${w}`);
  for (let lo = 0; lo <= row.plainTo[1]; lo++) add(row.plainTo[0], lo);
  for (let n = row.deuce[0]; n <= row.deuce[1]; n++) add(n, n - 2);
  return legal;
}

describe("TN-SS-1 a set summary must be a score the set can reach (SC-S1; RBS:343-350)", () => {
  it("TN-SS-1 tour: 8–6, 9–7 and 10–8 are refused; 6–4 and 7–5 are accepted", () => {
    // RBS:350: "Illegal in any tie-break set: 8–6, 9–7 (7–6 is terminal in a TB set)"; 10–8 is on RBS:343's closed list as
    // neither a plain final nor a tie-break one. RBS:343: "6–0 … 6–4; 7–5".
    const cfg = cfgFor("tour");
    let checked = 0;
    for (const [w, l] of [[8, 6], [9, 7], [10, 8]] as const) {
      for (const [home, away] of [[w, l], [l, w]]) {
        const e = refusal(() => started(cfg).summary(home!, away!));
        expect(e.code, `${home}-${away}`).toBe("SET_SCORE_UNREACHABLE");
        expect(e.data, `${home}-${away}`).toMatchObject({ home, away });
        checked++;
      }
    }
    for (const [w, l] of [[6, 4], [7, 5]] as const) {
      for (const [home, away] of [[w, l], [l, w]]) {
        const state = started(cfg).summary(home!, away!).state;
        expect(state.sets, `${home}-${away}`).toEqual([{ home, away }]);
        checked++;
      }
    }
    expect(checked).toBe(10);
  });

  it("TN-SS-1 fast4: 5–3 and 6–4 refused; 4–2 accepted", () => {
    // RBS:346: "4–0 … 4–2; 4–3 with TB. 5–3 is impossible (3-all goes to the TB)"; 6–4 is on neither list.
    const cfg = cfgFor("fast4");
    let checked = 0;
    for (const [w, l] of [[5, 3], [6, 4]] as const) {
      for (const [home, away] of [[w, l], [l, w]]) {
        expect(refusal(() => started(cfg).summary(home!, away!)).code, `${home}-${away}`).toBe("SET_SCORE_UNREACHABLE");
        checked++;
      }
    }
    for (const [home, away] of [[4, 2], [2, 4]]) {
      expect(started(cfg).summary(home!, away!).state.sets, `${home}-${away}`).toEqual([{ home, away }]);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("TN-SS-1 a custom set {gamesTo 6, winBy 2, tiebreakAt 3} accepts 8–6 (the walk-back, not the closed form)", () => {
    // `set` is an API rule key, so any shape can be stored. With the tie-break at 3-all, 3–3 can be stepped around
    // (3–2 → 4–2 → 4–3 → … → 6–6 → 7–6 → 8–6): the score before the last game, 7–6, is reachable, so 8–6 is a real set.
    // The closed form "the loser's games < tiebreakAt" would refuse it. Differential: the same 8–6 under the tour set
    // (tie-break at 6-all, where 7–6 can only come from 6–6) is refused.
    const custom = cfgFor("tour", { set: { gamesTo: 6, winBy: 2, tiebreakAt: 3, tiebreakTo: 7 } });
    expect(started(custom).summary(8, 6).state.sets).toEqual([{ home: 8, away: 6 }]);
    expect(started(custom).summary(6, 8).state.sets).toEqual([{ home: 6, away: 8 }]);
    expect(reachableLiveGames(7, 6, { ...custom.set, mtbTo: null })).toBe(true);
    expect(refusal(() => started(cfgFor("tour")).summary(8, 6)).code).toBe("SET_SCORE_UNREACHABLE");
    expect(reachableLiveGames(7, 6, { ...cfgFor("tour").set, mtbTo: null })).toBe(false);
  });

  it("TN-SS-1 every plain final the write path takes is exactly RBS §6.2's legal list, for the tie-break set, the advantage set and Fast4 (counted)", () => {
    let checked = 0;
    let unreachable = 0;
    for (const row of RBS_PLAIN_FINALS) {
      const cfg = row.cfg();
      const legal = rbsPlainLegal(row);
      const taken = new Set<string>();
      for (let home = 0; home <= EDGE; home++) {
        for (let away = 0; away <= EDGE; away++) {
          if (home === away) continue;
          const answer = firstSetAnswer(cfg, home, away);
          // A refusal is a score that is not a finished set (INVALID_EVENT, as before W2e), or one no set can reach.
          expect(["taken", "INVALID_EVENT", "SET_SCORE_UNREACHABLE"], `${row.row} ${home}-${away}`).toContain(answer);
          if (answer === "taken") taken.add(`${home}-${away}`);
          if (answer === "SET_SCORE_UNREACHABLE") unreachable++;
          checked++;
        }
      }
      expect([...taken].sort(), row.row).toEqual([...legal].sort());
    }
    expect(checked).toBe(RBS_PLAIN_FINALS.length * (EDGE + 1) * EDGE);
    // Anti-vacuity: the enumeration reached the new refusal, not only the old "not a finished set" one.
    expect(unreachable).toBeGreaterThan(0);
  });

  it("TN-SS-1 the walk-back is bounded by the pad's own games field: the advantage set's bound is taken, one past it refused", () => {
    // The pad's set-score fields carry the engine's declared maximum (padSpec); an advantage set has no games ceiling in
    // the rulebook (RBS:344, n ≥ 7), so the write path takes every n–(n−2) up to that declared maximum and nothing past it.
    const cfg = advantageCfg();
    const spec: PadSpec = tennis.padSpec!(cfg);
    const field = spec.panels.flatMap((p) => p.actions).find((a) => a.type === "tennis.set_summary")!.fields.find((f) => f.path === "home");
    if (field?.kind !== "number" || field.max === undefined) throw new Error("premise: the set-score action declares a games maximum");
    const max = field.max;
    expect(max, "premise: the advantage set's bound is past every RBS example").toBeGreaterThan(EDGE);
    expect(started(cfg).summary(max, max - 2).state.sets).toEqual([{ home: max, away: max - 2 }]);
    expect(refusal(() => started(cfg).summary(max + 1, max - 1)).code).toBe("SET_SCORE_UNREACHABLE");
  });

  it("TN-SS-1 the sequence: the second set and a set re-entered after a void are judged the same way", () => {
    const cfg = cfgFor("tour");
    // Second set: 6–4 banked, then 8–6 refused and 7–5 taken.
    const second = started(cfg).summary(6, 4);
    expect(refusal(() => second.write(second.next("tennis.set_summary", { home: 8, away: 6 }))).code).toBe("SET_SCORE_UNREACHABLE");
    second.summary(5, 7);
    expect(second.state.sets).toEqual([{ home: 6, away: 4 }, { home: 5, away: 7 }]);
    // After a void of the first set's summary the set is open again, and 9–7 is refused there too; 6–0 is taken.
    const voided = started(cfg).summary(6, 4).voids(1);
    expect(voided.state.sets).toEqual([]);
    expect(refusal(() => voided.write(voided.next("tennis.set_summary", { home: 9, away: 7 }))).code).toBe("SET_SCORE_UNREACHABLE");
    voided.summary(6, 0);
    expect(voided.state.sets).toEqual([{ home: 6, away: 0 }]);
    // A tie-break set and a match tie-break are not plain games and keep their own checks: 7–6(5) and an MTB 10–8 are taken.
    const mtb = started(cfgFor("doubles-noad-mtb10")).summary(7, 6, { home: 7, away: 5 }).summary(4, 6).summary(10, 8);
    expect(tennis.outcome(mtb.state)).toMatchObject({ kind: "win", winner: H });
  });

  it("TN-SS-1 replay folds a pre-W2e 8–6 summary leniently", () => {
    // Recorded before W2e (the old one-step check took it): 8–6, 6–4 to H. A read folds it to its recorded result; the
    // write path refuses the same ledger.
    const cfg = cfgFor("tour");
    const legacy = [
      makeEnvelope(0, { type: "core.start", payload: {} }),
      makeEnvelope(1, { type: "tennis.set_summary", payload: { home: 8, away: 6 } }),
      makeEnvelope(2, { type: "tennis.set_summary", payload: { home: 6, away: 4 } }),
    ];
    const replayed = foldMatchWithStoppage(tennis, cfg, lineups, legacy).state;
    expect(replayed.sets).toEqual([{ home: 8, away: 6 }, { home: 6, away: 4 }]);
    expect(tennis.outcome(replayed)).toMatchObject({ kind: "win", winner: H });
    const e = refusal(() => foldMatchWithStoppage(tennis, cfg, lineups, legacy, { strictFromSeq: 0 }));
    expect(e.code).toBe("SET_SCORE_UNREACHABLE");
  });
});

// ---------------------------------------------------------------------------
// TN-SE-1 — a tennis default ends the match (X-SE-1 on the nested kernel).
// ---------------------------------------------------------------------------

/** Where in a match the default falls, each a different scoring state of the nested kernel. */
const POSITIONS: readonly { name: string; variant: string; build: (l: Ledger) => Ledger }[] = [
  { name: "mid-game, tour", variant: "tour", build: (l) => l.points(H, A) },
  { name: "between sets, grand slam (best of five)", variant: "grand-slam", build: (l) => l.summary(6, 4) },
  {
    name: "in the tie-break at 6-all, tour",
    variant: "tour",
    build: (l) => {
      // Twelve games awarded alternately reach 6-all, where the tie-break starts.
      for (let g = 0; g < 12; g++) l.append("tennis.game.award", { winner: g % 2 === 0 ? H : A });
      return l.points(H);
    },
  },
  { name: "in the match tie-break, doubles", variant: "doubles-noad-mtb10", build: (l) => l.summary(6, 4).summary(4, 6).points(H) },
];

describe("TN-SE-1 a tennis default ends the match", () => {
  it("TN-SE-1 a default followed by forfeit{disqualified} ends the match; a rally in between is refused ENDING_SANCTION_PENDING", () => {
    let refused = 0;
    let ended = 0;
    for (const position of POSITIONS) {
      for (const offender of [H, A]) {
        const where = `${position.name}, default against ${offender}`;
        const cfg = cfgFor(position.variant);
        const before = () => position.build(started(cfg));
        const defaulted = before().sanction(offender, "default");
        // Every scoring or record event but the ending is refused, naming the default (X-SE-1).
        const candidates = [
          defaulted.next("tennis.point", { by: H }),
          defaulted.next("tennis.point", { by: A }),
          defaulted.next("tennis.set_summary", { home: 6, away: 0 }),
          defaulted.next("tennis.game.award", { winner: other(offender) }),
          defaulted.next("tennis.sanction", { by: other(offender), level: "warning" }),
          defaulted.next("core.note", { text: "chair's note" }),
        ];
        for (const candidate of candidates) {
          const e = refusal(() => defaulted.write(candidate));
          expect(e.code, `${where}: ${candidate.type}`).toBe("ENDING_SANCTION_PENDING");
          expect(e.data, `${where}: ${candidate.type}`).toEqual({ by: offender, level: "default" });
          refused++;
        }
        // Differential: a rally after a game penalty (a record, not an ending) is admitted.
        const penalised = before().sanction(offender, "game_penalty");
        expect(() => penalised.write(penalised.next("tennis.point", { by: H })), where).not.toThrow();

        defaulted.forfeit(offender, "disqualified");
        const winner = other(offender);
        expect(tennis.outcome(defaulted.state), where).toEqual({ kind: "award", winner, loser: offender, reason: "disqualified" });
        // TN-RT-1 (X-RT-1's credit): straight sets for set %, the match's games out of game %.
        const need = (cfg.bestOf + 1) / 2;
        const credit = tennis.forfeitCredit(cfg, defaulted.state, "disqualified", offender === H ? "home" : "away");
        const winnerSets = { sets_won: need, sets_lost: 0 };
        const loserSets = { sets_won: 0, sets_lost: need };
        expect(credit.perSide, where).toEqual(offender === H ? [loserSets, winnerSets] : [winnerSets, loserSets]);
        expect([...credit.excluded].sort(), where).toEqual(["games_lost", "games_won"]);
        ended++;
      }
    }
    expect(refused).toBe(POSITIONS.length * 2 * 6);
    expect(ended).toBe(POSITIONS.length * 2);
  });

  it("TN-SE-1 only the default ends a tennis match: a warning, a point penalty and a game penalty are records (spec §5.2)", () => {
    // Spec §5.2's table: tennis's ending level is `default` and nothing else; D13 names no tennis prompt level.
    const ENDS: Record<string, boolean> = { warning: false, point_penalty: false, game_penalty: false, default: true };
    let checked = 0;
    for (const [level, ends] of Object.entries(ENDS)) {
      for (const offender of [H, A]) {
        const ledger = started(cfgFor("tour")).points(H).sanction(offender, level);
        const point = ledger.next("tennis.point", { by: A });
        if (ends) expect(refusal(() => ledger.write(point)).code, level).toBe("ENDING_SANCTION_PENDING");
        else expect(() => ledger.write(point), level).not.toThrow();
        expect(ledger.pending(), level).toEqual(ends ? { by: offender, level } : null);
        // D13: the scorer may send `disqualified` against the defaulted player only, never `retired`, never the other side.
        expect(ledger.mayForfeit(offender, "disqualified"), level).toBe(ends);
        expect(ledger.mayForfeit(offender, "retired"), level).toBe(false);
        expect(ledger.mayForfeit(other(offender), "disqualified"), level).toBe(false);
        checked++;
      }
    }
    expect(checked).toBe(8);
  });

  it("TN-SE-1 X-SE-1 void sequences: void the ending and it is pending again; void the default too and play resumes; void the default alone and the match stays ended", () => {
    const cfg = cfgFor("tour");
    // [start, H, A, default(A), forfeit(A)] — seq 3 is the default, seq 4 the ending.
    const ended = () => started(cfg).points(H, A).sanction(A, "default").forfeit(A, "disqualified");

    const reopened = ended().voids(4);
    expect(reopened.pending()).toEqual({ by: A, level: "default" });
    expect(refusal(() => reopened.write(reopened.next("tennis.point", { by: H }))).code).toBe("ENDING_SANCTION_PENDING");
    expect(reopened.mayForfeit(A, "disqualified"), "the scorer may confirm the ending again").toBe(true);

    const resumed = ended().voids(4).voids(3);
    expect(resumed.pending()).toBeNull();
    resumed.points(H);
    expect(tennis.outcome(resumed.state)).toBeNull();

    const stillEnded = ended().voids(3);
    expect(tennis.outcome(stillEnded.state)).toEqual({ kind: "award", winner: H, loser: A, reason: "disqualified" });
    expect(stillEnded.pending()).toBeNull();
  });

  it("TN-SE-1 X-SE-1 replay folds a pre-W2e ledger with play after a default to its recorded result; the write path refuses it", () => {
    const cfg = cfgFor("tour");
    // Recorded before W2e: A defaulted, then H took both sets.
    const legacy = [
      makeEnvelope(0, { type: "core.start", payload: {} }),
      makeEnvelope(1, { type: "tennis.sanction", payload: { by: A, level: "default" } }),
      makeEnvelope(2, { type: "tennis.set_summary", payload: { home: 6, away: 0 } }),
      makeEnvelope(3, { type: "tennis.set_summary", payload: { home: 6, away: 0 } }),
    ];
    const replayed = foldMatchWithStoppage(tennis, cfg, lineups, legacy).state;
    expect(tennis.outcome(replayed)).toMatchObject({ kind: "win", winner: H });
    expect(replayed.setsWon).toEqual({ home: 2, away: 0 });
    const e = refusal(() => foldMatchWithStoppage(tennis, cfg, lineups, legacy, { strictFromSeq: 0 }));
    expect(e.code).toBe("ENDING_SANCTION_PENDING");
    expect(e.data).toEqual({ by: A, level: "default" });
  });

  it("TN-SE-1 X-SE-1 the generator follows a default with its ending at once, drawing no rng", () => {
    let checked = 0;
    for (const offender of [H, A]) {
      for (const position of POSITIONS) {
        const ledger = position.build(started(cfgFor(position.variant))).sanction(offender, "default");
        const noRng = () => {
          throw new Error("the generator drew rng after a default");
        };
        expect(tennis.arbitraryEvent!(ledger.state, noRng), `${position.name} ${offender}`).toEqual({
          type: "core.forfeit",
          payload: { by: offender, reason: "disqualified" },
        });
        checked++;
      }
    }
    expect(checked).toBe(POSITIONS.length * 2);
  });
});
