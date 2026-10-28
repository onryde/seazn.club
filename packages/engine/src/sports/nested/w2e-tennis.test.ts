// W2e Task 4 (spec 2026-10-28 §5.2, §5.5; D3 (1), D8, D13): a tennis `default` ends the match, and a set summary must be a
// score a set can reach (rows TN-SE-1, TN-SS-1; X-SE-1 on the nested kernel). W2e Task 5 (§5.5 RB2A-12, D8, D18): short sets
// and a set tie-break with its own margin (row TN-SS-2).
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
//  - TN-SS-2 (Task 5): ITF Rules of Tennis 2026, App VI, as quoted verbatim in the W2e A0 findings (A0.2): "§1 SHORT SETS
//    The first player/team to win four games wins the set, provided there is a margin of two games over the opponent(s).
//    If the score reaches four games all, a tie-break game shall be played. Alternatively (...) if the score reaches three
//    games all (...)"; "§2 SHORT SET TIE-BREAK (5 POINTS) (...) The first player/team to win five points wins the "Game"
//    and "Set", with a deciding point if the score reaches four all." No-Ad is a separate alternative, so the four-all
//    form plays ad games. RBS:345 "Short set, TB at 4-all | 4–0 … 4–2; 5–3; **5–4** with TB"; RBS:347 "Short-set TB |
//    first to 5 with a deciding point at 4-all: 5–0 … **5–4**"; RBS:339 "Tie-break game to 7 with a two-point lead (5b)";
//    RBS:348 "Match tie-break (…) to 10: 10–0 … 10–8, n–(n−2) n ≥ 11".
import { describe, expect, it } from "vitest";
import { EngineError } from "../../core/errors.ts";
import { foldMatchWithStoppage, type EventEnvelope } from "../../core/events.ts";
import { mulberry32 } from "../../core/rng.ts";
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

const cfgFor = (variant?: string, extra?: Record<string, unknown>): NestedCfg => {
  // A name the module does not declare would spread `undefined` and quietly test the tour default instead.
  if (variant !== undefined && !Object.hasOwn(tennis.variants, variant)) throw new Error(`premise: tennis declares no "${variant}" variant`);
  return tennis.configSchema.parse({ ...(variant === undefined ? {} : tennis.variants[variant]), ...(extra ?? {}) });
};

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

function rbsPlainLegal(row: { readonly plainTo: readonly [number, number]; readonly deuce: readonly [number, number] }): Set<string> {
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
    expect(reachableLiveGames(7, 6, custom.set)).toBe(true);
    expect(refusal(() => started(cfgFor("tour")).summary(8, 6)).code).toBe("SET_SCORE_UNREACHABLE");
    expect(reachableLiveGames(7, 6, cfgFor("tour").set)).toBe(false);
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

  it("TN-SS-1 a score past an already finished set (7–0, 8–0, 9–3) is SET_SCORE_UNREACHABLE in the tie-break set and the advantage set alike, and its message names no tie-break; a set that is not finished (6–5) stays INVALID_EVENT", () => {
    // RBS:343-344 (Rule 6): a set is won at six games two clear, so 6–0 and 6–3 end it and no game follows. Before W2e the
    // one-step check refused these as INVALID_EVENT; the walk-back answers them as unreachable (docs/api-v1-breaking-changes.md).
    // An advantage set has no tie-break, so a sentence about "this set's tie-break" would be false there (Task 4 review M4).
    let checked = 0;
    for (const [name, cfg] of [["tie-break set", cfgFor("tour")], ["advantage set", advantageCfg()]] as const) {
      for (const [home, away] of [[7, 0], [8, 0], [9, 3], [3, 9]] as const) {
        const e = refusal(() => started(cfg).summary(home, away));
        expect(e.code, `${name} ${home}-${away}`).toBe("SET_SCORE_UNREACHABLE");
        expect(e.message, `${name} ${home}-${away}`).not.toMatch(/tie-?break/i);
        checked++;
      }
      expect(refusal(() => started(cfg).summary(6, 5)).code, `${name} 6-5`).toBe("INVALID_EVENT");
      checked++;
    }
    expect(checked).toBe(10);
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

// ---------------------------------------------------------------------------
// TN-SS-2 — short sets, and a set tie-break with its own margin (RB2A-12; ITF App VI §1-2).
// ---------------------------------------------------------------------------

/** Awards games alternately, home first, until the set stands at `home`–`away`, each on the write path. */
function gamesAt(l: Ledger, home: number, away: number): Ledger {
  for (let g = 0; g < Math.max(home, away); g++) {
    if (g < home) l.append("tennis.game.award", { winner: H });
    if (g < away) l.append("tennis.game.award", { winner: A });
  }
  return l;
}

/** Tie-break points alternately, home first, up to `n`–`n`. */
function tbPointsAt(l: Ledger, n: number): Ledger {
  for (let p = 0; p < n; p++) l.points(H, A);
  return l;
}

/** The write path's answer to a first-set summary `home`–`away` carrying the tie-break block `tb`. */
function tbSetAnswer(cfg: NestedCfg, home: number, away: number, tb: { home: number; away: number }): string {
  const ledger = started(cfg);
  try {
    ledger.write(ledger.next("tennis.set_summary", { home, away, tb }));
    return "taken";
  } catch (e) {
    if (e instanceof EngineError) return e.code;
    throw e;
  }
}

/** App VI §2 (A0.2; RBS:347): the short-set tie-break is the first to five, with a deciding point at four all. */
const SHORT_TB_TO = 5;

describe("TN-SS-2 short sets and the set tie-break's own margin (RB2A-12; ITF App VI §1-2; RBS:345-347)", () => {
  it("TN-SS-2 short-sets: 4–2 and 5–3 accepted, 5–4 needs a tie-break, 6–4 refused", () => {
    const cfg = cfgFor("short-sets");
    // Premise, from App VI §1-2 (A0.2): four games two clear, the tie-break at four all to five with a deciding point at
    // four all (margin one), ad games (No-Ad is a separate alternative).
    expect(cfg.set).toEqual({ gamesTo: 4, winBy: 2, tiebreakAt: 4, tiebreakTo: SHORT_TB_TO, tiebreakWinBy: 1 });
    expect(cfg.game.noAd).toBe(false);
    let checked = 0;
    for (const [home, away] of [[4, 2], [2, 4], [5, 3], [3, 5]] as const) {
      expect(started(cfg).summary(home, away).state.sets, `${home}-${away}`).toEqual([{ home, away }]);
      checked++;
    }
    for (const [home, away] of [[5, 4], [4, 5]] as const) {
      const e = refusal(() => started(cfg).summary(home, away));
      expect(e.code, `${home}-${away}`).toBe("INVALID_EVENT");
      expect(e.message, `${home}-${away}`).toMatch(/tie-break/);
      checked++;
    }
    for (const [home, away] of [[6, 4], [4, 6]] as const) {
      expect(refusal(() => started(cfg).summary(home, away)).code, `${home}-${away}`).toBe("SET_SCORE_UNREACHABLE");
      checked++;
    }
    expect(checked).toBe(8);
    // Played game by game: 3-all is no tie-break here, 4–3 plays on and 5–3 closes; 4-all opens the tie-break.
    const at33 = gamesAt(started(cfg), 3, 3);
    expect(at33.state.points.kind).toBe("standard");
    const at43 = at33.append("tennis.game.award", { winner: H });
    expect(at43.state.sets).toEqual([]);
    expect(at43.append("tennis.game.award", { winner: H }).state.sets).toEqual([{ home: 5, away: 3 }]);
    expect(gamesAt(started(cfg), 4, 4).state.points.kind).toBe("tiebreak");
  });

  it("TN-SS-2 every plain final the write path takes under short sets is exactly RBS:345's list (counted)", () => {
    // RBS:345: "4–0 … 4–2; 5–3; 5–4 with TB" — the plain finals are 4–0 … 4–2 and 5–3, either way round.
    const row = { row: "RBS:345 short set, TB at 4-all", cfg: () => cfgFor("short-sets"), plainTo: [4, 2], deuce: [5, 5] } as const;
    const cfg = row.cfg();
    const legal = rbsPlainLegal(row);
    const taken = new Set<string>();
    let checked = 0;
    let unreachable = 0;
    for (let home = 0; home <= EDGE; home++) {
      for (let away = 0; away <= EDGE; away++) {
        if (home === away) continue;
        const answer = firstSetAnswer(cfg, home, away);
        expect(["taken", "INVALID_EVENT", "SET_SCORE_UNREACHABLE"], `${home}-${away}`).toContain(answer);
        if (answer === "taken") taken.add(`${home}-${away}`);
        if (answer === "SET_SCORE_UNREACHABLE") unreachable++;
        checked++;
      }
    }
    expect([...taken].sort()).toEqual([...legal].sort());
    expect(legal.size).toBe(8);
    expect(checked).toBe((EDGE + 1) * EDGE);
    expect(unreachable, "the enumeration reached TN-SS-1's refusal over the new variant").toBeGreaterThan(0);
  });

  it("TN-SS-2 the short-set tie-break closes at 5–4 (deciding point at 4–4, App VI §2)", () => {
    const cfg = cfgFor("short-sets");
    // Point by point: at four all in the tie-break the next point is the deciding point.
    const at44 = tbPointsAt(gamesAt(started(cfg), 4, 4), 4);
    expect(at44.state.points).toMatchObject({ kind: "tiebreak", home: 4, away: 4 });
    expect(at44.state.sets).toEqual([]);
    const first = at44.points(A);
    expect(first.state.sets).toEqual([{ home: 4, away: 5, tb: { home: 4, away: 5 } }]);
    expect(first.state.setsWon).toEqual({ home: 0, away: 1 });
    // The sequence: the second set's tie-break is the same, the other way round.
    const second = tbPointsAt(gamesAt(first, 4, 4), 4).points(H);
    expect(second.state.sets[1]).toEqual({ home: 5, away: 4, tb: { home: 5, away: 4 } });
    // After a void of the deciding point the tie-break is at four all again, and the other side's point closes it.
    const reopened = tbPointsAt(gamesAt(started(cfg), 4, 4), 4).points(A);
    reopened.voids(reopened.events.length - 1);
    expect(reopened.state.sets).toEqual([]);
    expect(reopened.state.points).toMatchObject({ kind: "tiebreak", home: 4, away: 4 });
    expect(reopened.points(H).state.sets).toEqual([{ home: 5, away: 4, tb: { home: 5, away: 4 } }]);
  });

  it("TN-SS-2 a short-set tie-break summary takes exactly RBS:347's scores, 5–0 … 5–4 (counted)", () => {
    // RBS:347: "first to 5 with a deciding point at 4-all: 5–0 … 5–4". 6–5, the margin-two form's deuce score, cannot happen.
    const cfg = cfgFor("short-sets");
    let checked = 0;
    for (const [home, away, winner] of [[5, 4, "home"], [4, 5, "away"]] as const) {
      const taken = new Set<string>();
      for (let h = 0; h <= EDGE; h++) {
        for (let a = 0; a <= EDGE; a++) {
          const answer = tbSetAnswer(cfg, home, away, { home: h, away: a });
          expect(["taken", "INVALID_EVENT"], `${home}-${away} tb ${h}-${a}`).toContain(answer);
          if (answer === "taken") taken.add(winner === "home" ? `${h}-${a}` : `${a}-${h}`);
          checked++;
        }
      }
      expect([...taken].sort(), `${home}-${away}`).toEqual(["5-0", "5-1", "5-2", "5-3", "5-4"]);
    }
    expect(checked).toBe(2 * (EDGE + 1) * (EDGE + 1));
    expect(tbSetAnswer(cfg, 5, 4, { home: 6, away: 5 })).toBe("INVALID_EVENT");
  });

  it("TN-SS-2 fast4: 5–3 refused, a 5–4 tie-break closes", () => {
    const cfg = cfgFor("fast4");
    // RBS:346: 5–3 is impossible (three all goes to the tie-break).
    expect(refusal(() => started(cfg).summary(5, 3)).code).toBe("SET_SCORE_UNREACHABLE");
    expect(refusal(() => started(cfg).summary(3, 5)).code).toBe("SET_SCORE_UNREACHABLE");
    // App VI §2: the tie-break at three all is the short-set tie-break, so four all in it is the deciding point.
    const at44 = tbPointsAt(gamesAt(started(cfg), 3, 3), 4);
    expect(at44.state.points).toMatchObject({ kind: "tiebreak", home: 4, away: 4 });
    expect(at44.points(H).state.sets).toEqual([{ home: 4, away: 3, tb: { home: 5, away: 4 } }]);
    expect(tbSetAnswer(cfg, 4, 3, { home: 5, away: 4 })).toBe("taken");
    expect(tbSetAnswer(cfg, 3, 4, { home: 4, away: 5 })).toBe("taken");
    expect(tbSetAnswer(cfg, 4, 3, { home: 6, away: 4 })).toBe("INVALID_EVENT");
    expect(tbSetAnswer(cfg, 4, 3, { home: 6, away: 5 })).toBe("INVALID_EVENT");
  });

  it("TN-SS-2 the match tie-break keeps its own margin: a 10–9 MTB plays on", () => {
    // Preflight F13: short sets with a match tie-break to 10 in place of the deciding set, so both tie-breaks are in one match.
    const cfg = cfgFor("short-sets", { finalSet: { matchTiebreakTo: 10 } });
    expect(cfg.tiebreak.winBy, "premise: the match tie-break's margin is the rulebook's two (RBS:348)").toBe(2);
    // Set 1: the short-set tie-break closes at 5–4.
    const ledger = tbPointsAt(gamesAt(started(cfg), 4, 4), 4).points(H);
    expect(ledger.state.sets).toEqual([{ home: 5, away: 4, tb: { home: 5, away: 4 } }]);
    // Set 2 to A, so the match tie-break replaces the deciding set.
    ledger.summary(2, 4);
    expect(ledger.state.points.kind).toBe("matchTiebreak");
    // 9–9, then 10–9: not over (RBS:348 "to 10: … n–(n−2) n ≥ 11").
    tbPointsAt(ledger, 9).points(H);
    expect(ledger.state.points).toMatchObject({ kind: "matchTiebreak", home: 10, away: 9 });
    expect(ledger.state.sets).toHaveLength(2);
    expect(tennis.outcome(ledger.state)).toBeNull();
    ledger.points(H);
    expect(ledger.state.sets[2]).toEqual({ home: 11, away: 9, mtb: true });
    expect(tennis.outcome(ledger.state)).toMatchObject({ kind: "win", winner: H });
    // The summary path agrees: a 10–9 match tie-break is no final score, 11–9 is.
    const viaSummary = started(cfg).summary(5, 4, { home: 5, away: 4 }).summary(2, 4);
    expect(refusal(() => viaSummary.write(viaSummary.next("tennis.set_summary", { home: 10, away: 9 }))).code).toBe("INVALID_EVENT");
    expect(tennis.outcome(viaSummary.summary(11, 9).state)).toMatchObject({ kind: "win", winner: H });
  });

  it("TN-SS-2 a final-set tie-break keeps the match's margin under short sets: the decider's 10–9 plays on, 11–9 closes (RBS:349)", () => {
    // RBS:349 "Final-set TB to 10 at 6-all (App VI §5) | set 7–6 with TB 10–0 … 10–8 or n–(n−2), n ≥ 11": App VI §5's
    // tie-break is not §2's short-set one, so a set's own margin of one never reaches it. Short sets with that decider
    // put both tie-breaks in one match: the ordinary sets' closes at 5–4, the decider's does not close at 10–9.
    const cfg = cfgFor("short-sets", { finalSet: { tiebreakTo: 10 } });
    expect(cfg.set.tiebreakWinBy, "premise: the short set's own margin is one").toBe(1);
    expect(cfg.tiebreak.winBy, "premise: the match's margin is the rulebook's two").toBe(2);
    const ledger = tbPointsAt(gamesAt(started(cfg), 4, 4), 4).points(H);
    expect(ledger.state.sets).toEqual([{ home: 5, away: 4, tb: { home: 5, away: 4 } }]);
    ledger.summary(2, 4);
    // The deciding set: a short set whose tie-break at four all is played to ten.
    tbPointsAt(gamesAt(ledger, 4, 4), 9).points(H);
    expect(ledger.state.points).toMatchObject({ kind: "tiebreak", home: 10, away: 9 });
    expect(ledger.state.sets).toHaveLength(2);
    expect(tennis.outcome(ledger.state)).toBeNull();
    ledger.points(H);
    expect(ledger.state.sets[2]).toEqual({ home: 5, away: 4, tb: { home: 11, away: 9 } });
    expect(tennis.outcome(ledger.state)).toMatchObject({ kind: "win", winner: H });
    // The summary path agrees: a 10–9 decider tie-break is no final score, 11–9 and 10–8 are; the ordinary set's 5–4 still is.
    const decider = () => started(cfg).summary(5, 4, { home: 5, away: 4 }).summary(2, 4);
    const at = decider();
    expect(refusal(() => at.write(at.next("tennis.set_summary", { home: 5, away: 4, tb: { home: 10, away: 9 } }))).code).toBe("INVALID_EVENT");
    expect(tennis.outcome(decider().summary(5, 4, { home: 11, away: 9 }).state)).toMatchObject({ kind: "win", winner: H });
    expect(tennis.outcome(decider().summary(5, 4, { home: 10, away: 8 }).state)).toMatchObject({ kind: "win", winner: H });
    // The pad's tie-break field is bounded by the decider at the match's margin: the same bound as the tour sets' slam
    // decider to ten, whose set margin IS the match's (relational, so no number is restated from the kernel).
    const tbMax = (c: NestedCfg): number => {
      const fields = tennis.padSpec!(c).panels.flatMap((p) => p.actions).filter((a) => a.type === "tennis.set_summary").flatMap((a) => a.fields);
      const f = fields.find((x) => x.path === "tb.home");
      if (f?.kind !== "number" || f.max === undefined) throw new Error("premise: tb.home declares a maximum");
      return f.max;
    };
    expect(tbMax(cfg)).toBe(tbMax(cfgFor("tour", { finalSet: { tiebreakTo: 10 } })));
    expect(tbMax(cfg), "the decider's 11–9 fits the field").toBeGreaterThanOrEqual(11);
  });

  it("TN-SS-2 a fast4 division created now plays margin 1", () => {
    // A division created from the variant stores it and reads it back through `configSchema` (sync:sports writes the raw
    // variant; the division keeps the parsed config). The key must survive both parses, or the set falls back to margin two.
    const stored = JSON.parse(JSON.stringify(tennis.configSchema.parse(JSON.parse(JSON.stringify(tennis.variants.fast4)))));
    const cfg = tennis.configSchema.parse(stored);
    expect(cfg.set.tiebreakWinBy).toBe(1);
    const at44 = tbPointsAt(gamesAt(new Ledger(cfg).append("core.start"), 3, 3), 4);
    expect(at44.points(A).state.sets).toEqual([{ home: 3, away: 4, tb: { home: 4, away: 5 } }]);
    // The differential: a Fast4 set stored without the key (before Task 13b's migration gives it an explicit two) plays
    // the tie-break to the match's `tiebreak.winBy` — 5–4 plays on, 6–4 closes.
    const { tiebreakWinBy: _dropped, ...legacySet } = cfg.set;
    const legacy = tennis.configSchema.parse({ ...stored, set: legacySet });
    expect(legacy.set.tiebreakWinBy).toBeUndefined();
    const legacy54 = tbPointsAt(gamesAt(new Ledger(legacy).append("core.start"), 3, 3), 4).points(A);
    expect(legacy54.state.sets).toEqual([]);
    expect(legacy54.state.points).toMatchObject({ kind: "tiebreak", home: 4, away: 5 });
    expect(legacy54.points(A).state.sets).toEqual([{ home: 3, away: 4, tb: { home: 4, away: 6 } }]);
  });

  it("TN-SS-2 a set with no tie-break margin of its own keeps the match's: tour's 7–6 and the slam decider's 10–9 play on", () => {
    // RBS:339 "Tie-break game to 7 with a two-point lead (5b)"; RBS:349 the final-set tie-break to 10 "n–(n−2), n ≥ 11".
    const tour = tbPointsAt(gamesAt(started(cfgFor("tour")), 6, 6), 6).points(H);
    expect(tour.state.points).toMatchObject({ kind: "tiebreak", home: 7, away: 6 });
    expect(tour.points(H).state.sets).toEqual([{ home: 7, away: 6, tb: { home: 8, away: 6 } }]);
    const slam = started(cfgFor("grand-slam")).summary(6, 4).summary(4, 6).summary(6, 4).summary(4, 6);
    tbPointsAt(gamesAt(slam, 6, 6), 9).points(H);
    expect(slam.state.points).toMatchObject({ kind: "tiebreak", home: 10, away: 9 });
    expect(tennis.outcome(slam.state)).toBeNull();
    slam.points(H);
    expect(slam.state.sets[4]).toEqual({ home: 7, away: 6, tb: { home: 11, away: 9 } });
  });

  it("TN-SS-2 a sudden-death tie-break takes no score past its target: 8–7 to seven is refused on the write path, and replays leniently", () => {
    // A tie-break with a margin of one ends the moment one side reaches the target, so the most it can stand at is
    // target–(target−1): 7–6 to seven, 10–9 for a match tie-break to ten. 8–7 would need 7–7, which 7–6 or 6–7 ended.
    const sudden = cfgFor("tour", { tiebreak: { winBy: 1 } });
    expect(tbSetAnswer(sudden, 7, 6, { home: 7, away: 6 })).toBe("taken");
    expect(tbSetAnswer(sudden, 7, 6, { home: 8, away: 7 })).toBe("INVALID_EVENT");
    const mtb = cfgFor("doubles-noad-mtb10", { tiebreak: { winBy: 1 } });
    const decider = () => started(mtb).summary(6, 4).summary(4, 6);
    expect(refusal(() => decider().summary(11, 10)).code).toBe("INVALID_EVENT");
    expect(tennis.outcome(decider().summary(10, 9).state)).toMatchObject({ kind: "win", winner: H });
    // A summary recorded before W2e (the one-step check took 8–7) still folds to its recorded result on a read.
    const legacy = [
      makeEnvelope(0, { type: "core.start", payload: {} }),
      makeEnvelope(1, { type: "tennis.set_summary", payload: { home: 7, away: 6, tb: { home: 8, away: 7 } } }),
      makeEnvelope(2, { type: "tennis.set_summary", payload: { home: 6, away: 4 } }),
    ];
    const replayed = foldMatchWithStoppage(tennis, sudden, lineups, legacy).state;
    expect(replayed.sets).toEqual([{ home: 7, away: 6, tb: { home: 8, away: 7 } }, { home: 6, away: 4 }]);
    expect(tennis.outcome(replayed)).toMatchObject({ kind: "win", winner: H });
    expect(refusal(() => foldMatchWithStoppage(tennis, sudden, lineups, legacy, { strictFromSeq: 0 })).code).toBe("INVALID_EVENT");
  });

  it("TN-SS-2 the pad's set-score fields admit every RBS:345-347 final, under short sets and Fast4", () => {
    let checked = 0;
    for (const [variant, games, tb] of [["short-sets", [5, 4], { home: 5, away: 4 }], ["fast4", [4, 3], { home: 5, away: 4 }]] as const) {
      const cfg = cfgFor(variant);
      const spec: PadSpec = tennis.padSpec!(cfg);
      // Every action that writes a set summary (the plain one and the one with the tie-break block).
      const fields = spec.panels.flatMap((p) => p.actions).filter((a) => a.type === "tennis.set_summary").flatMap((a) => a.fields);
      const max = (path: string): number => {
        const f = fields.find((x) => x.path === path);
        if (f?.kind !== "number" || f.max === undefined) throw new Error(`premise: ${variant} ${path} declares a maximum`);
        return f.max;
      };
      expect(max("home"), variant).toBeGreaterThanOrEqual(games[0]);
      expect(max("tb.home"), variant).toBeGreaterThanOrEqual(SHORT_TB_TO);
      expect(tbSetAnswer(cfg, games[0], games[1], tb), variant).toBe("taken");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("TN-SS-2 the generator's short-set tie-breaks are all ones the write path takes, and it reaches the deciding point (counted)", () => {
    const cfg = cfgFor("short-sets");
    let tbSummaries = 0;
    let decidingPoint = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const rng = mulberry32(seed);
      const ledger = started(cfg);
      for (let n = 0; n < 80 && tennis.outcome(ledger.state) === null && ledger.state.phase === "live"; n++) {
        const ev = tennis.arbitraryEvent!(ledger.state, rng);
        if (ev === null) break;
        if (ev.type !== "tennis.set_summary") {
          // A rally, a sanction, an interruption, an ending: kept only if the write path takes it.
          try {
            ledger.append(ev.type, ev.payload);
          } catch (e) {
            if (!(e instanceof EngineError)) throw e;
          }
          continue;
        }
        const tb = (ev.payload as { tb?: { home: number; away: number } }).tb;
        ledger.append(ev.type, ev.payload); // throws if the write path refuses the generator's own summary
        if (tb !== undefined) {
          tbSummaries++;
          if (Math.min(tb.home, tb.away) === SHORT_TB_TO - 1) decidingPoint++;
        }
      }
    }
    expect(tbSummaries, "the walks drew short-set tie-breaks").toBeGreaterThan(0);
    expect(decidingPoint, "a 5–4 tie-break (the deciding point) was drawn").toBeGreaterThan(0);
  });

  it("TN-SS-2 the generator's final-set tie-breaks under short sets are ones the write path takes, at the match's margin (RBS:349, counted)", () => {
    // Short sets with a final-set tie-break to 10: the decider's tie-break is won by the match's two, so the closest final
    // the generator may draw is 10–8. Every summary it draws is appended on the write path, which refuses 10–9.
    const cfg = cfgFor("short-sets", { finalSet: { tiebreakTo: 10 } });
    const to = 10;
    let deciderTbs = 0;
    let closest = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const rng = mulberry32(seed);
      const ledger = started(cfg);
      for (let n = 0; n < 80 && tennis.outcome(ledger.state) === null && ledger.state.phase === "live"; n++) {
        const ev = tennis.arbitraryEvent!(ledger.state, rng);
        if (ev === null) break;
        if (ev.type !== "tennis.set_summary") {
          try {
            ledger.append(ev.type, ev.payload);
          } catch (e) {
            if (!(e instanceof EngineError)) throw e;
          }
          continue;
        }
        const decider = ledger.state.setsWon.home === 1 && ledger.state.setsWon.away === 1;
        const tb = (ev.payload as { tb?: { home: number; away: number } }).tb;
        ledger.append(ev.type, ev.payload); // throws if the write path refuses the generator's own summary
        if (decider && tb !== undefined) {
          deciderTbs++;
          expect(Math.max(tb.home, tb.away), `seed ${seed}`).toBe(to);
          if (Math.min(tb.home, tb.away) === to - cfg.tiebreak.winBy) closest++;
        }
      }
    }
    expect(deciderTbs, "the walks drew final-set tie-breaks").toBeGreaterThan(0);
    expect(closest, "a 10–8 final-set tie-break (the closest the match's margin allows) was drawn").toBeGreaterThan(0);
  });
});
