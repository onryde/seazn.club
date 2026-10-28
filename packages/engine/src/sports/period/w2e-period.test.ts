// W2e Task 9 (A1d, RB2B-10; D4, D18) — the period kernel's shoot-out order is each federation's own, and the dead
// `shootout.suddenDeath` key is gone.
//
// Every expected order below is read from the rulebook text verified in W2e Task 0 (a0-findings §A0.4), never from the
// code under test:
// - FIH General Tournament Regulations (Outdoor) May 2025, Appendix 12. 20c: "the team whose player took the first
//   shoot-out in a series defends the first shoot-out of the next series". 21b: "the team which starts each shoot-out
//   series alternates for each series". 20d: "when one team has scored or been awarded one more goal than the opposing
//   team after each team has taken the same number of shoot-outs, not necessarily being all five shoot-outs, that team
//   is the winner". A series is five attempts per side (20, 20a, 21).
// - IIHF Official Rule Book 2026-27, Rule 84.4. IX: "The team that shot second in the first five Penalty Shot will start
//   first in the "tie-break shots"." / "The game shall be finished as soon as a duel of two Players brings the decisive
//   result." No later alternation is named. XI: "Only the decisive goal will count in the result of the game."
// - Football is unchanged: kicks alternate in the order the first five set (football/DOMAIN.md "Shootout order and
//   alternation"; IFAB Law 10, cited by law only, a0-findings A0.9 item 7).
//
// The two period-kernel sports are tested one by one where the rule is a federation's own (FIH for hockey, IIHF for ice
// hockey); the deletion of `suddenDeath` sweeps the whole sport registry.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EngineError } from "../../core/errors.ts";
import { foldMatch, type EventEnvelope, type FoldOptions } from "../../core/events.ts";
import type { LineupPair } from "../../core/types.ts";
import type { AnySportModule, ModuleEvent } from "../../sport/module.ts";
import { declaredCfgs } from "../../testkit/declared-cfgs.ts";
import { defaultLineupPair, lineupFromCatalog, makeEnvelope } from "../../testkit/helpers.ts";
import { football, footballNextKicker, type FootballCfg } from "../football/football.ts";
import { hockey } from "../hockey/hockey.ts";
import { icehockey } from "../icehockey/icehockey.ts";
import { builtinModules } from "../index.ts";
import { expectedAdvance, type PeriodState } from "./kernel.ts";
import { expectedKicker, type ShootoutKick, type ShootoutSide } from "./shootout.ts";

/** A write: every event is new (`strictFromSeq: 0`), the pad's and the API's path. */
const STRICT_ALL: FoldOptions = { strictFromSeq: 0 };
/** A read: a stored ledger refolded with no `strictFromSeq` (apps/web fold.ts), every event lenient. An object, not
 *  `undefined`, so `fold`'s default below cannot turn a read into a write. */
const REPLAY: FoldOptions = {};

type Side = ShootoutSide;
const other = (side: Side): Side => (side === "home" ? "away" : "home");
const ID: Record<Side, string> = { home: "H", away: "A" };

/** The leader of each pair as the rulebook text gives it, one letter per pair (spaces ignored): `F` is the side that
 *  took the first attempt of the shoot-out, `x` the other side. */
const leaders = (table: string, first: Side): Side[] =>
  [...table.replace(/\s+/g, "")].map((c) => {
    if (c !== "F" && c !== "x") throw new Error(`table letter ${c}`);
    return c === "F" ? first : other(first);
  });

const envelopes = (events: readonly ModuleEvent[]): EventEnvelope[] => events.map((e, i) => makeEnvelope(i, e));

function refusalOf(fn: () => unknown): { code: string; message: string } | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof EngineError) return { code: err.code, message: err.message };
    throw err;
  }
}

interface ShootoutSport {
  readonly name: string;
  readonly module: AnySportModule;
  readonly cfg: unknown;
  readonly lineups: LineupPair;
  readonly attemptType: string;
  /** Regulation (and any overtime) at 0-0, ending in the SHOOTOUT phase. */
  readonly toShootout: readonly ModuleEvent[];
  readonly attempts: number;
}

const FIH: ShootoutSport = (() => {
  const cfg = hockey.configSchema.parse(hockey.variants["fih-shootout"]);
  const adv = (to: string): ModuleEvent => ({ type: "hockey.period.advance", payload: { to } });
  return {
    name: "hockey fih-shootout",
    module: hockey as AnySportModule,
    cfg,
    lineups: defaultLineupPair(hockey.positions),
    attemptType: "hockey.shootout.attempt",
    toShootout: [{ type: "core.start", payload: {} }, adv("Q2"), adv("Q3"), adv("Q4"), adv("FT")],
    attempts: cfg.shootout!.attempts,
  };
})();

const IIHF: ShootoutSport = (() => {
  const cfg = icehockey.configSchema.parse(icehockey.variants.iihf);
  const adv = (to: string): ModuleEvent => ({ type: "icehockey.period.advance", payload: { to } });
  return {
    name: "icehockey iihf",
    module: icehockey as AnySportModule,
    cfg,
    lineups: defaultLineupPair(icehockey.positions),
    attemptType: "icehockey.shootout.attempt",
    // 0-0 after P3 opens the overtime; the overtime's own close is `to: "FT"` too, and 0-0 there opens the shoot-out.
    toShootout: [{ type: "core.start", payload: {} }, adv("P2"), adv("P3"), adv("FT"), adv("FT")],
    attempts: cfg.shootout!.attempts,
  };
})();

const attempt = (sport: ShootoutSport, side: Side, scored: boolean): ModuleEvent => ({
  type: sport.attemptType,
  payload: { by: ID[side], scored },
});

const fold = (sport: ShootoutSport, events: readonly ModuleEvent[], opts: FoldOptions = STRICT_ALL) =>
  foldMatch(sport.module, sport.cfg, sport.lineups, envelopes(events), opts) as PeriodState;

const nextTaker = (sport: ShootoutSport, state: PeriodState): Side | null =>
  (sport.module.summary(state).detail as { shootoutNext: Side | null }).shootoutNext;

/**
 * Walks `pairs` pairs of missed attempts in the order `table` names, checking at every pair's start that the summary
 * names the table's leader, that the leader's attempt is accepted on the write path and the other side's is refused
 * for the alternation. Returns the ledger and how many pair starts it checked.
 */
function walkOrder(sport: ShootoutSport, expected: readonly Side[]): { ledger: ModuleEvent[]; checked: number } {
  const ledger = [...sport.toShootout];
  let checked = 0;
  for (const [pair, leader] of expected.entries()) {
    const at = fold(sport, ledger);
    expect(at.phase, `${sport.name} pair ${pair + 1}: still in the shoot-out`).toBe("SHOOTOUT");
    if (pair > 0) expect(nextTaker(sport, at), `${sport.name} pair ${pair + 1}: shootoutNext`).toBe(leader);
    if (pair > 0) {
      const wrong = refusalOf(() => fold(sport, [...ledger, attempt(sport, other(leader), false)]));
      expect(wrong?.code, `${sport.name} pair ${pair + 1}: ${other(leader)} first is refused`).toBe("INVALID_EVENT");
      expect(wrong?.message, "the refusal is the alternation's").toMatch(/attempts must alternate/);
    }
    ledger.push(attempt(sport, leader, false));
    expect(nextTaker(sport, fold(sport, ledger)), `${sport.name} pair ${pair + 1}: the pair completes`).toBe(other(leader));
    ledger.push(attempt(sport, other(leader), false));
    checked += 1;
  }
  return { ledger, checked };
}

describe("HK-SO-1 FIH shoot-out series order (RB2B-10)", () => {
  it("HK-SO-1 after 5–5 the team that started the first series defends first in the second (FIH App 12 §20c/21b)", () => {
    // single-sport: the series order is FIH's own rule (App 12); ice hockey's differs (IH-SO-1 below).
    // 20c and 21b as a table: F = the side that took the first attempt; each block of five pairs is one series.
    const table = "FFFFF xxxxx FFFFF";
    let checked = 0;
    for (const first of ["home", "away"] as const) checked += walkOrder(FIH, leaders(table, first)).checked;
    expect(FIH.attempts, "a series is five attempts per side (App 12 §20)").toBe(5);
    expect(checked, "pair starts checked, both sides starting, three series each").toBe(30);
  });

  it("HK-SO-1 the cfg's attempts reach the fold: at attempts 3 the second series opens at pair 4 with the other side (FIH App 12 §20c/21b)", () => {
    // single-sport: FIH's series order is hockey's own. The unit tests above call `expectedKicker` with attempts handed in
    // by the test; this one drives the real producer and consumers (the cfg parsed through the module's schema, the
    // strict fold's alternation refusal, and the summary's `shootoutNext`) so a kernel that passes a constant instead of
    // `state.cfg.shootout.attempts` reds. A series is `attempts` pairs: 3 here, so pair 4 is the first of series 2 and
    // pair 7 the first of series 3, the cfg's own number and not the rulebook's five.
    const base = hockey.variants["fih-shootout"] as { shootout: Record<string, unknown> };
    const three: ShootoutSport = {
      ...FIH,
      name: "hockey fih-shootout, attempts 3",
      cfg: hockey.configSchema.parse({ ...base, shootout: { ...base.shootout, attempts: 3 } }),
      attempts: 3,
    };
    expect((fold(three, three.toShootout).cfg.shootout as { attempts: number }).attempts, "the cfg the fold reads").toBe(3);
    let walkedPairs = 0;
    let pair4Checks = 0;
    for (const first of ["home", "away"] as const) {
      // F = the side that took the first attempt of the shoot-out; blocks of three pairs are series.
      const walked = walkOrder(three, leaders("FFF xxx FFF xxx", first));
      walkedPairs += walked.checked;
      // Three missed pairs, then pair 4 (the first of series 2) is the other side's to open: 20c. The same three pairs under
      // the preset's own five-attempt series leave the first side on, which is what separates the cfg from a constant.
      const threePairs: ModuleEvent[] = [...three.toShootout];
      for (let pair = 0; pair < 3; pair++) threePairs.push(attempt(three, first, false), attempt(three, other(first), false));
      expect(nextTaker(three, fold(three, threePairs)), `${first} started, attempts 3: pair 4`).toBe(other(first));
      expect(nextTaker(FIH, fold(FIH, threePairs)), `${first} started, attempts 5: still series 1`).toBe(first);
      expect(refusalOf(() => fold(three, [...threePairs, attempt(three, first, false)]))?.code, "the first side opening pair 4 is refused").toBe(
        "INVALID_EVENT",
      );
      expect(fold(three, [...threePairs, attempt(three, other(first), false)]).shootout!.kicks).toHaveLength(7);
      pair4Checks += 1;
    }
    expect(walkedPairs, "pair starts checked, both sides starting, four series of three").toBe(24);
    expect(pair4Checks, "pair 4 checked from both starting sides").toBe(2);
  });

  it("HK-SO-1 the early finish holds inside the second series, after equal numbers, before all five (FIH App 12 §20d)", () => {
    // single-sport: FIH App 12 §20d.
    const firstFive: ModuleEvent[] = [];
    for (let i = 0; i < 5; i++) firstFive.push(attempt(FIH, "home", true), attempt(FIH, "away", true));
    const level = [...FIH.toShootout, ...firstFive];
    expect(fold(FIH, level).outcome, "5–5 after the first series").toBeNull();
    // Series 2 is led by away (20c). Pair 6 both score; pair 7: away scores, and home's miss decides it.
    const pair6 = [attempt(FIH, "away", true), attempt(FIH, "home", true)];
    const awayScores = [...level, ...pair6, attempt(FIH, "away", true)];
    expect(fold(FIH, awayScores).outcome, "one attempt ahead is not yet the same number").toBeNull();
    const decided = fold(FIH, [...awayScores, attempt(FIH, "home", false)]);
    expect(decided.outcome).toEqual({ kind: "win", winner: "A", loser: "H", method: "shootout" });
    // The other way round in pair 7: away misses, home scores — home wins after equal numbers, two short of the series.
    const homeWins = fold(FIH, [...level, ...pair6, attempt(FIH, "away", false), attempt(FIH, "home", true)]);
    expect(homeWins.outcome).toEqual({ kind: "win", winner: "H", loser: "A", method: "shootout" });
    expect(homeWins.shootout!.kicks.length, "seven attempts each: inside the second series").toBe(14);
  });
});

describe("IH-SO-1 IIHF tie-break shots (RB2B-10)", () => {
  it("IH-SO-1 tie-break shots: the team that shot second in the first five starts (IIHF 84.4)", () => {
    // single-sport: the tie-break order is the IIHF's own rule (84.4 IX); field hockey's differs (HK-SO-1 above).
    // IX as a table: the first five alternate from F; every tie-break duel after them is started by the other side.
    const table = "FFFFF xxxxx xxxxx";
    let checked = 0;
    for (const first of ["home", "away"] as const) checked += walkOrder(IIHF, leaders(table, first)).checked;
    expect(IIHF.attempts, "the first five (84.4 IX)").toBe(5);
    expect(checked, "pair starts checked, both sides starting, fifteen duels each").toBe(30);
  });

  it("IH-SO-1 the first decisive duel finishes the game and only the decisive goal counts (IIHF 84.4 IX, XI)", () => {
    // single-sport: IIHF 84.4 IX and XI.
    const firstFive: ModuleEvent[] = [];
    for (const scored of [true, false, true, false, false]) {
      firstFive.push(attempt(IIHF, "home", scored), attempt(IIHF, "away", scored));
    }
    const level = [...IIHF.toShootout, ...firstFive];
    expect(nextTaker(IIHF, fold(IIHF, level)), "away shot second in the first five").toBe("away");
    const duel = [attempt(IIHF, "away", true), attempt(IIHF, "home", false)];
    const done = fold(IIHF, [...level, ...duel]);
    expect(done.outcome).toEqual({ kind: "win", winner: "A", loser: "H", method: "shootout" });
    // 0-0 in play, shoot-out tally 2–3: the result is 0 — 1, the decisive goal alone (XI), never the tally.
    expect(icehockey.summary(done).headline).toBe("0 — 1 (GWS 2–3)");
  });
});

describe("football keeps IFAB order (the positive pair)", () => {
  // single-sport: football is the third shoot-out sport and the one whose order does not change.
  const cfg: FootballCfg = football.configSchema.parse({ extraTime: { enabled: true, halfMinutes: 15 }, shootout: true });
  const lineups: LineupPair = { home: lineupFromCatalog(football.positions, "H"), away: lineupFromCatalog(football.positions, "A") };
  const period = (phase: string): ModuleEvent => ({ type: "football.period", payload: { phase } });
  const toShootout: ModuleEvent[] = [{ type: "core.start", payload: {} }, period("HT"), period("FT"), period("ET_HT"), period("ET_FT")];
  const kick = (side: Side, scored: boolean): ModuleEvent => ({ type: "football.shootout.kick", payload: { by: ID[side], scored } });
  const foldFb = (events: readonly ModuleEvent[]) => foldMatch(football, cfg, lineups, envelopes(events), STRICT_ALL);

  it("football keeps IFAB order: the side that kicked first leads every pair, through 5–5 and 10–10", () => {
    let checked = 0;
    for (const first of ["home", "away"] as const) {
      const ledger = [...toShootout];
      for (let pair = 0; pair < 15; pair++) {
        expect(foldFb(ledger).phase).toBe("SHOOTOUT");
        if (pair > 0) {
          const wrong = refusalOf(() => foldFb([...ledger, kick(other(first), false)]));
          expect(wrong?.code, `pair ${pair + 1}: ${other(first)} first is refused`).toBe("INVALID_EVENT");
          expect(wrong?.message).toMatch(/kicks must alternate/);
        }
        ledger.push(kick(first, false), kick(other(first), false));
        expect(foldFb(ledger).outcome, `pair ${pair + 1}`).toBeNull();
        checked += 1;
      }
    }
    expect(checked).toBe(30);
  });

  it("the pad's football kicker (footballNextKicker) names the side the fold asks for at every kick, past five pairs", () => {
    // The pad reads the folded state alone (no cfg), so its cue comes from football's own export; it must agree with
    // the fold's refusal at every step, or the pad would offer the kick the server refuses.
    let checked = 0;
    for (const first of ["home", "away"] as const) {
      const ledger = [...toShootout];
      expect(footballNextKicker([]), "no kick yet: either side may start").toBeNull();
      for (let k = 0; k < 24; k++) {
        const kicks = (foldFb(ledger) as unknown as { shootout: { kicks: ShootoutKick[] } }).shootout.kicks;
        const next = k === 0 ? first : footballNextKicker(kicks);
        expect(next, `kick ${k + 1}`).toBe(k % 2 === 0 ? first : other(first));
        if (k > 0) expect(refusalOf(() => foldFb([...ledger, kick(other(next!), false)]))?.code, `kick ${k + 1}`).toBe("INVALID_EVENT");
        ledger.push(kick(next!, false));
        checked += 1;
      }
    }
    expect(checked).toBe(48);
  });
});

describe("expectedKicker — the three orders at their boundaries (RB2B-10)", () => {
  /** One completed, missed pair per leader. */
  const kicksFor = (expected: readonly Side[]): ShootoutKick[] =>
    expected.flatMap((leader) => [
      { side: leader, scored: false },
      { side: other(leader), scored: false },
    ]);

  it("HK-SO-1 IH-SO-1 at every balanced count up to fifteen pairs, the next leader is the rulebook's", () => {
    const cases = [
      { order: "ifab", table: "FFFFF FFFFF FFFFF F" },
      { order: "fih-series", table: "FFFFF xxxxx FFFFF x" },
      { order: "iihf-tiebreak", table: "FFFFF xxxxx xxxxx x" },
    ] as const;
    let checked = 0;
    for (const { order, table } of cases) {
      for (const first of ["home", "away"] as const) {
        const expected = leaders(table, first);
        for (let pairs = 0; pairs < expected.length; pairs++) {
          const kicks = kicksFor(expected.slice(0, pairs));
          const want = pairs === 0 ? null : expected[pairs];
          expect(expectedKicker(kicks, order, 5), `${order} ${first} after ${pairs} pairs`).toBe(want);
          if (pairs > 0) {
            // Mid-pair the other side is due, whatever the order.
            expect(expectedKicker([...kicks, { side: expected[pairs]!, scored: true }], order, 5)).toBe(other(expected[pairs]!));
          }
          checked += 1;
        }
      }
    }
    expect(checked).toBe(3 * 2 * 16);
  });

  it("HK-SO-1 IH-SO-1 a series is the configured number of attempts, not a fixed five", () => {
    // FIH and IIHF both write five; a competition that configures three takes its series and its first round as three.
    const three = (order: "fih-series" | "iihf-tiebreak", table: string) =>
      leaders(table, "home").map((_, pairs, all) => expectedKicker(kicksFor(all.slice(0, pairs)), order, 3));
    expect(three("fih-series", "FFF xxx FFF")).toEqual([null, ...leaders("FF xxx FFF", "home")]);
    expect(three("iihf-tiebreak", "FFF xxx xxx")).toEqual([null, ...leaders("FF xxx xxx", "home")]);
  });

  it("HK-SO-1 a void kick (a retake) does not move a series boundary", () => {
    // Five each with home's fifth voided and retaken: still five each, so series 2 opens with away (20c).
    const kicks: ShootoutKick[] = kicksFor(leaders("FFFF", "home"));
    kicks.push({ side: "home", scored: false, void: true }, { side: "home", scored: false }, { side: "away", scored: false });
    expect(expectedKicker(kicks, "fih-series", 5)).toBe("away");
    expect(expectedKicker(kicks, "iihf-tiebreak", 5)).toBe("away");
    expect(expectedKicker(kicks, "ifab", 5)).toBe("home");
  });

  it("refuses an attempts count that cannot mark a series, and an order it does not know (assumptions the types hold)", () => {
    for (const attempts of [0, -1, 2.5, Number.NaN]) {
      expect(() => expectedKicker(kicksFor(leaders("F", "home")), "fih-series", attempts), String(attempts)).toThrow(
        /attempts must be a positive integer/,
      );
    }
    expect(() => expectedKicker(kicksFor(leaders("F", "home")), "abba" as never, 5)).toThrow(/unknown shoot-out order abba/);
  });
});

describe("HK-SO-1 IH-SO-1 a pre-W2e shoot-out recorded in the old order still replays", () => {
  // Before W2e the first side led every pair, so a stored ledger past the first five holds that order.
  const OLD_ORDER = (sport: ShootoutSport, pairs: number, lastPair: [boolean, boolean]): ModuleEvent[] => {
    const events = [...sport.toShootout];
    for (let i = 0; i < pairs - 1; i++) events.push(attempt(sport, "home", true), attempt(sport, "away", true));
    events.push(attempt(sport, "home", lastPair[0]), attempt(sport, "away", lastPair[1]));
    return events;
  };

  for (const sport of [FIH, IIHF]) {
    it(`HK-SO-1 IH-SO-1 ${sport.name}: replay folds a pre-W2e shoot-out recorded in the old order to its recorded result`, () => {
      // Six pairs, home first in the sixth: home scores, away misses. The old engine decided it for home.
      const ledger = OLD_ORDER(sport, 6, [true, false]);
      const replayed = fold(sport, ledger, REPLAY);
      expect(replayed.outcome).toEqual({ kind: "win", winner: "H", loser: "A", method: "shootout" });
      // The same ledger is refused as a WRITE, at the old order's first attempt of the sixth pair.
      const refused = refusalOf(() => fold(sport, ledger, STRICT_ALL));
      expect(refused?.code).toBe("INVALID_EVENT");
      expect(refused?.message).toMatch(/attempts must alternate/);
      const firstOld = sport.toShootout.length + 10;
      expect(refusalOf(() => fold(sport, ledger.slice(0, firstOld + 1), STRICT_ALL))?.code).toBe("INVALID_EVENT");
      expect(refusalOf(() => fold(sport, ledger.slice(0, firstOld), STRICT_ALL)), "the first five are the same in both orders").toBeNull();
    });

    it(`HK-SO-1 IH-SO-1 ${sport.name}: the next write after an old-order ledger follows the federation's order`, () => {
      // Six pairs recorded the old way, still level; the seventh pair is in the second series (FIH) or a tie-break duel
      // (IIHF), so either way away is due first.
      const ledger = OLD_ORDER(sport, 6, [true, true]);
      expect(fold(sport, ledger, REPLAY).outcome).toBeNull();
      const write = (side: Side) => fold(sport, [...ledger, attempt(sport, side, true)], { strictFromSeq: ledger.length });
      expect(nextTaker(sport, fold(sport, ledger, REPLAY))).toBe("away");
      expect(refusalOf(() => write("away"))).toBeNull();
      expect(refusalOf(() => write("home"))?.code).toBe("INVALID_EVENT");
    });
  }
});

describe("HK-SO-2 IH-SO-2 suddenDeath deleted; a level overtime is not repeated (D4, RB2B-38)", () => {
  /** Every key named `suddenDeath` anywhere in `value`, with its path. */
  const suddenDeathPaths = (value: unknown, path = "$"): string[] => {
    if (value === null || typeof value !== "object") return [];
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
      ...(k === "suddenDeath" ? [`${path}.${k}`] : []),
      ...suddenDeathPaths(v, `${path}.${k}`),
    ]);
  };

  it("HK-SO-2 IH-SO-2 no module declares suddenDeath (schema shape check)", () => {
    let modules = 0;
    let shootouts = 0;
    for (const module of builtinModules) {
      const schema = z.toJSONSchema(module.configSchema, { io: "input", target: "draft-2020-12" });
      expect(suddenDeathPaths(schema), `${module.key} config schema`).toEqual([]);
      for (const [variant, preset] of Object.entries(module.variants)) {
        expect(suddenDeathPaths(preset), `${module.key} ${variant} preset`).toEqual([]);
      }
      for (const { name, cfg } of declaredCfgs(module)) {
        expect(suddenDeathPaths(cfg), `${module.key} ${name}`).toEqual([]);
        const so = (cfg as { shootout?: unknown }).shootout;
        if (so !== null && typeof so === "object") shootouts += 1;
      }
      modules += 1;
    }
    expect(modules, "the whole registry").toBe(builtinModules.length);
    expect(modules).toBeGreaterThan(0);
    // The scan reached real shoot-out objects: hockey's fih-shootout, and ice hockey's defaults and iihf.
    expect(shootouts).toBeGreaterThanOrEqual(3);
  });

  it("HK-SO-2 IH-SO-2 an old config carrying shootout.suddenDeath parses and the key is gone (the pre-W2e presets)", () => {
    // The shapes the two presets declared before W2e, as their committed schema snapshots recorded them at W2e BASE
    // 08d3a0fc33 (`suddenDeath` required, `true` in both). The stored rows' own copies (a division, its fixtures' frozen
    // snapshots and their match states) are read by apps/web `w2e-suddendeath-strip.test.ts` from the W2d pin fixture:
    // this package's tests run in a Stryker sandbox that holds packages/engine alone. The strip serves a write from an
    // older client during the deploy (D18); stored rows lose the key in the Task 13b migration.
    const old = [
      { module: hockey as AnySportModule, raw: { shootout: { attempts: 5, suddenDeath: true, clockSeconds: 8 } }, kept: { attempts: 5, clockSeconds: 8 } },
      { module: icehockey as AnySportModule, raw: { shootout: { attempts: 5, suddenDeath: true } }, kept: { attempts: 5 } },
      { module: hockey as AnySportModule, raw: { shootout: { attempts: 3, suddenDeath: false } }, kept: { attempts: 3 } },
    ];
    let read = 0;
    for (const { module, raw, kept } of old) {
      const parsed = module.configSchema.safeParse(raw);
      expect(parsed.success, `${module.key} ${JSON.stringify(raw)}`).toBe(true);
      expect(suddenDeathPaths(parsed.data), module.key).toEqual([]);
      expect((parsed.data as { shootout: unknown }).shootout, `${module.key}: the rest is kept`).toEqual(kept);
      read += 1;
    }
    expect(read).toBe(old.length);
  });

  it("HK-SO-2 IH-SO-2 the strip is that one key: any other unknown shoot-out key is still refused", () => {
    for (const module of [hockey, icehockey] as AnySportModule[]) {
      const ok = module.configSchema.safeParse({ shootout: { attempts: 5, suddenDeath: false } });
      expect(ok.success, `${module.key}: suddenDeath false strips too`).toBe(true);
      const bad = module.configSchema.safeParse({ shootout: { attempts: 5, suddenDeat: true } });
      expect(bad.success, `${module.key}: a misspelt key`).toBe(false);
      expect(module.configSchema.safeParse({ shootout: { suddenDeath: true } }).success, `${module.key}: attempts still required`).toBe(
        false,
      );
    }
  });

  it("HK-SO-2 IH-SO-2 a level overtime goes to the shoot-out, or is a draw without one, and is never played again", () => {
    // the period kernel's two sports; football's extra time is its own module.
    const cases = [
      { module: hockey, adv: "hockey.period.advance", regulation: ["Q2", "Q3", "Q4", "FT"] },
      { module: icehockey, adv: "icehockey.period.advance", regulation: ["P2", "P3", "FT"] },
    ] as const;
    let checked = 0;
    for (const { module, adv, regulation } of cases) {
      const lineups = defaultLineupPair(module.positions);
      const events: ModuleEvent[] = [{ type: "core.start", payload: {} }, ...regulation.map((to) => ({ type: adv, payload: { to } }))];
      for (const shootout of [{ attempts: 5 }, null]) {
        const cfg = module.configSchema.parse({ overtime: { kind: "sudden_death", minutes: 5 }, shootout });
        const inOt = foldMatch(module, cfg, lineups, envelopes(events), STRICT_ALL);
        expect(inOt.phase, `${module.key}: 0-0 opens the overtime`).toBe("OT");
        const after = foldMatch(module, cfg, lineups, envelopes([...events, { type: adv, payload: { to: "FT" } }]), STRICT_ALL);
        if (shootout === null) {
          expect(after.outcome, `${module.key}: no shoot-out configured`).toEqual({ kind: "draw" });
        } else {
          expect(after.phase, `${module.key}: the shoot-out, not a second overtime`).toBe("SHOOTOUT");
          expect(expectedAdvance(after)).toBeNull();
          const again = refusalOf(() =>
            foldMatch(module, cfg, lineups, envelopes([...events, { type: adv, payload: { to: "FT" } }, { type: adv, payload: { to: "OT" } }]), STRICT_ALL),
          );
          expect(again?.code, `${module.key}: no second overtime`).toBe("WRONG_PHASE");
        }
        expect(after.periods.filter((p) => p.phase === "OT"), `${module.key}: one overtime`).toHaveLength(1);
        checked += 1;
      }
    }
    expect(checked).toBe(4);
  });
});

describe("premise", () => {
  it("the lineups address their entrants as H and A, the ids every attempt above names", () => {
    for (const sport of [FIH, IIHF]) expect([sport.lineups.home.entrantId, sport.lineups.away.entrantId]).toEqual(["H", "A"]);
  });
});
