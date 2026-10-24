// W2c Task 16b (X-WO-1 part B; Task 9 P-3 "A"): ONE walkover score everywhere. A stage PointsRule that carries
// `forfeit.awardScore` is offered to the fold (`FoldOptions.forfeitAward`); the kernel hands it to the sport module for a
// forfeit with NOTHING PLAYED only, and the module's forfeit credit and summary read it from its own state, so the
// headline, the table's credit and the rule's award are one number.
//
// Every expected number below is the RULE's (typed in this file as the organiser's award), the DEFAULT credit is read off
// the engine's own no-offer fold so the rule is always a different number (the right answer differs from the wrong one's
// constant), and whether the rule applies to a given forfeit is `isUnplayedForfeit` (competition/points.ts: the table's
// authority) - never the kernel's own predicate read back.
import { describe, expect, it } from "vitest";
import { decidedInFor } from "../competition/decided-in.ts";
import { forfeitAwardOffer, isUnplayedForfeit, legacyPointsRule, payout, pointsRuleAwardReachesTable, type PointsRule } from "../competition/points.ts";
import { foldMatchWithStoppage, outcomeOf, playRecorded, summaryOf, unplayedForfeitEvent, type EventEnvelope } from "../core/events.ts";
import { FORFEIT_REASONS, type ForfeitReason } from "../core/types.ts";
import { builtinModules } from "../sports/index.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";
import { onePlayEvent } from "../testkit/play-event.ts";
import type { AnySportModule } from "./module.ts";

const H = "H";
const A = "A";
const ev = (seq: number, type: string, payload: unknown = {}, voids?: string): EventEnvelope => makeEnvelope(seq, { type, payload }, voids);
const forfeit = (seq: number, by: string, reason: ForfeitReason): EventEnvelope => ev(seq, "core.forfeit", { by, reason });

type Shape = "nothing" | "started" | "played";
const SHAPES: readonly Shape[] = ["nothing", "started", "played"];

/** The first cfg a sport declares (generic has no bare default), and its lineups. */
function rig(m: AnySportModule) {
  const cfg = declaredCfgs(m as never)[0]!.cfg;
  return { cfg, lineups: defaultLineupPair(m.positions) };
}

/** The ledger a forfeit follows: nothing, a Start alone (ruling 112: still nothing played), or a Start and a real sport
 *  event (play). Null when the sport has no play event under this cfg (chess: its one sport event decides the game). */
function ledgerFor(m: AnySportModule, shape: Shape): EventEnvelope[] | null {
  const { cfg, lineups } = rig(m);
  if (shape === "nothing") return [];
  const start = ev(1, "core.start");
  if (shape === "started") return [start];
  const play = onePlayEvent(m, cfg, lineups, [start]);
  return play === null ? null : [start, play];
}

function fold(m: AnySportModule, events: readonly EventEnvelope[], forfeitAward?: readonly [number, number]) {
  const { cfg, lineups } = rig(m);
  const folded = foldMatchWithStoppage(m as never, cfg as never, lineups, events, forfeitAward === undefined ? undefined : { forfeitAward });
  return { folded, outcome: outcomeOf(m as never, folded as never), summary: summaryOf(m as never, folded as never) };
}
const lines = (s: { perSide: { line: string }[] }) => s.perSide.map((p) => p.line);
const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};

/** The sports whose table a stage rule's award reaches (the engine's declaration), and the rest. */
const reaching = (): AnySportModule[] => builtinModules.filter((m) => pointsRuleAwardReachesTable(m));
const notReaching = (): AnySportModule[] => builtinModules.filter((m) => !pointsRuleAwardReachesTable(m));

/** The rule's award for a sport: the sport's default walkover credit (read off its own no-offer fold) + 4 to the side that
 *  turned up, 1 to the side that did not - never equal to the default, and the offender is not nil. */
function ruleAwardFor(m: AnySportModule): readonly [number, number] {
  const keys = m.awardScoreKeys!;
  const base = fold(m, [forfeit(1, A, "walkover")]);
  const credit = m.forfeitCredit(rig(m).cfg, base.folded.state, "walkover", "away"); // A (the away seat) walks over
  const defaultWinner = credit.perSide[0][keys.for]!;
  expect(Number.isFinite(defaultWinner), `${m.key}: the default credit reads a number`).toBe(true);
  return [defaultWinner + 4, 1];
}

const ruleOf = (award: readonly [number, number]): PointsRule =>
  legacyPointsRule({ base: { win: 3, draw: 1, loss: 0 }, forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [...award] } });

describe("X-WO-1 B: the registry partition (anti-vacuity)", () => {
  it("states how many sports the stage rule's award reaches, and how many it does not; neither side is empty", () => {
    const yes = reaching();
    const no = notReaching();
    expect(yes.length + no.length).toBe(builtinModules.length);
    expect(yes.length, `reaching: ${yes.map((m) => m.key).join(",")}`).toBeGreaterThan(0);
    expect(no.length, `not reaching: ${no.map((m) => m.key).join(",")}`).toBeGreaterThan(0);
  });
});

describe("X-WO-1 B: an unplayed walkover under a stage award reads the RULE's number on the headline, the credit and the table", () => {
  it("every sport the award reaches: both orientations, headline = credit = the table's number = the rule's award", () => {
    let checked = 0;
    for (const m of reaching()) {
      const keys = m.awardScoreKeys!;
      const award = ruleAwardFor(m);
      const [w, l] = award;
      for (const offender of [A, H] as const) {
        const events = [forfeit(1, offender, "walkover")];
        const base = fold(m, events);
        const offered = fold(m, events, award);
        expect(base.outcome, `${m.key}/${offender}: the walkover decides an award`).toMatchObject({ kind: "award", reason: "walkover" });
        expect(offered.outcome).toEqual(base.outcome);
        // Premise: the rule differs from what the division credits, so the right answer is not the wrong one's constant.
        expect(lines(base.summary), `${m.key}: the default headline is not the rule's`).not.toEqual(offender === A ? [String(w), String(l)] : [String(l), String(w)]);
        // The headline, side order home-first: the side that turned up gets the rule's winner figure.
        expect(lines(offered.summary), `${m.key}/${offender} headline`).toEqual(offender === A ? [String(w), String(l)] : [String(l), String(w)]);
        expect(offered.summary.headline, `${m.key}/${offender}`).toContain(offender === A ? `${w} — ${l}` : `${l} — ${w}`);
        // The module's own forfeit credit (read by its standingsDelta) says the same.
        const { cfg } = rig(m);
        const credit = m.forfeitCredit(cfg, offered.folded.state, "walkover", offender === A ? "away" : "home");
        const [winnerSide, offenderSide] = offender === A ? [credit.perSide[0], credit.perSide[1]] : [credit.perSide[1], credit.perSide[0]];
        expect([winnerSide[keys.for], winnerSide[keys.against], winnerSide[keys.diff]], `${m.key} winner credit`).toEqual([w, l, w - l]);
        expect([offenderSide[keys.for], offenderSide[keys.against], offenderSide[keys.diff]], `${m.key} offender credit`).toEqual([l, w, l - w]);
        // The table: standingsDelta over the offered state equals `payout` over the un-offered one (the two authorities).
        const stage = { kind: "league" } as never;
        const viaState = m.standingsDelta(offered.outcome!, cfg, stage, offered.folded.state);
        const viaRule = payout(base.outcome!, decidedInFor(m, base.outcome), m.standingsDelta(base.outcome!, cfg, stage, base.folded.state), false, ruleOf(award), m.awardScoreKeys);
        for (const side of [0, 1] as const) {
          for (const key of [keys.for, keys.against, keys.diff]) {
            expect(viaState[side].metrics[key], `${m.key} side ${side} ${key}: the state's credit and the rule's overlay agree`).toBe(viaRule[side].metrics[key]);
          }
        }
        checked++;
      }
    }
    expect(checked, "orientations checked").toBe(reaching().length * 2);
    expect(checked).toBeGreaterThan(0);
  });

  it("a nil-nil award is an award, not 'no award': headline, credit and table all read 0 - 0 for a forfeit with nothing played", () => {
    let checked = 0;
    let differsFromDefault = 0;
    for (const m of reaching()) {
      const keys = m.awardScoreKeys!;
      const { cfg } = rig(m);
      for (const offender of [A, H] as const) {
        const events = [forfeit(1, offender, "walkover")];
        const base = fold(m, events);
        const nil = fold(m, events, [0, 0]);
        expect(lines(nil.summary), `${m.key}/${offender}: the headline is the rule's nil-nil`).toEqual(["0", "0"]);
        expect(Object.hasOwn(nil.folded.state as object, "forfeitAward"), `${m.key}/${offender}: the award is held in state, not dropped as falsy`).toBe(true);
        const credit = m.forfeitCredit(cfg, nil.folded.state, "walkover", offender === A ? "away" : "home");
        for (const side of [0, 1] as const) expect([credit.perSide[side][keys.for], credit.perSide[side][keys.against], credit.perSide[side][keys.diff]], `${m.key}/${offender}/${side}: credit`).toEqual([0, 0, 0]);
        // The table: the state's credit and the rule's overlay agree on nil-nil (the two authorities).
        const stage = { kind: "league" } as never;
        const viaState = m.standingsDelta(nil.outcome!, cfg, stage, nil.folded.state);
        const viaRule = payout(base.outcome!, decidedInFor(m, base.outcome), m.standingsDelta(base.outcome!, cfg, stage, base.folded.state), false, ruleOf([0, 0]), m.awardScoreKeys);
        for (const side of [0, 1] as const) {
          for (const key of [keys.for, keys.against, keys.diff]) {
            expect(viaState[side].metrics[key], `${m.key} side ${side} ${key}: the state's credit and the rule's overlay agree on nil-nil`).toBe(viaRule[side].metrics[key]);
            expect(viaState[side].metrics[key], `${m.key} side ${side} ${key}: nil`).toBe(0);
          }
        }
        // Premise: the headline is the RULE's where the sport's own reading is not already nil-nil (football's 3-0).
        if (JSON.stringify(lines(base.summary)) !== JSON.stringify(["0", "0"])) differsFromDefault++;
        checked++;
      }
    }
    expect(checked, "orientations checked").toBe(reaching().length * 2);
    expect(differsFromDefault, "sport x orientation cases where nil-nil is not the sport's own reading").toBeGreaterThan(0);
  });

  it("every sport the award does NOT reach: the offered fold is the un-offered fold, byte for byte", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      if (pointsRuleAwardReachesTable(m)) return;
      // Chess has no `awardScoreKeys` and its walkover is a win-count credit: the offer must not leak into its state.
      const events = [forfeit(1, A, "walkover")];
      const base = fold(m, events);
      const offered = fold(m, events, [9, 1]);
      expect(JSON.stringify(offered.folded.state), m.key).toBe(JSON.stringify(base.folded.state));
      expect(JSON.stringify(offered.summary), m.key).toBe(JSON.stringify(base.summary));
      checked++;
    });
    expect(checked, "sports the award does not reach").toBe(notReaching().length);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("X-WO-1 B (Task 9 P-3 'A'): the rule's award replaces the credit ONLY for a forfeit with nothing played", () => {
  it("every reaching sport x ledger shape x forfeit reason x offender: applied exactly when isUnplayedForfeit says so", () => {
    let applied = 0;
    let withheld = 0;
    let refused = 0;
    let skippedShapes = 0;
    for (const m of reaching()) {
      const award = ruleAwardFor(m);
      for (const shape of SHAPES) {
        const ledger = ledgerFor(m, shape);
        if (ledger === null) {
          skippedShapes++;
          continue;
        }
        const played = playRecorded(ledger, m);
        for (const reason of FORFEIT_REASONS) {
          for (const offender of [A, H] as const) {
            const events = [...ledger, forfeit(ledger.length + 1, offender, reason)];
            const label = `${m.key}/${shape}/${reason}/${offender}`;
            const baseCode = codeOf(() => fold(m, events));
            const offeredCode = codeOf(() => fold(m, events, award));
            // The offer never changes WHETHER the engine takes the forfeit (the phase guard is untouched).
            expect(offeredCode, `${label}: the same refusal with or without the offer`).toBe(baseCode);
            if (baseCode !== null) {
              refused++;
              continue;
            }
            const base = fold(m, events);
            const offered = fold(m, events, award);
            const unplayed = isUnplayedForfeit(base.outcome!, played);
            if (unplayed) {
              expect(lines(offered.summary), `${label}: the rule's award is the headline`).toEqual(offender === A ? [String(award[0]), String(award[1])] : [String(award[1]), String(award[0])]);
              applied++;
            } else {
              expect(JSON.stringify(offered.folded.state), `${label}: a forfeit after play keeps the module's own credit`).toBe(JSON.stringify(base.folded.state));
              expect(JSON.stringify(offered.summary), label).toBe(JSON.stringify(base.summary));
              withheld++;
            }
          }
        }
      }
    }
    // Anti-vacuity: both arms were driven, on more than one sport, and the engine's refusals are counted.
    expect(applied, "forfeits the rule applied to").toBeGreaterThan(0);
    expect(withheld, "forfeits the rule was withheld from").toBeGreaterThan(0);
    // Every combination is accounted for: nothing was silently skipped (4 reasons x 2 offenders per ledger shape).
    expect(applied + withheld + refused, "combinations visited").toBe(reaching().length * SHAPES.length * FORFEIT_REASONS.length * 2);
    expect(skippedShapes, "a reaching sport with no play event would hide its played arm").toBe(0);
  });

  it("a retirement after play keeps the real score when it is worse for the offender, whatever the rule offers", () => {
    // Football's FB-RT-1 (FDC Art. 28) and the period sports' FIH GTR 13: the played margin stands when it beats the award.
    // The sweep above proves the withheld arm sport by sport; this one pins that the played score IS what a retirement shows.
    let checked = 0;
    for (const m of reaching()) {
      const ledger = ledgerFor(m, "played")!;
      const retired = [...ledger, forfeit(ledger.length + 1, A, "retired")];
      if (codeOf(() => fold(m, retired)) !== null) continue;
      const offered = fold(m, retired, ruleAwardFor(m));
      expect(lines(offered.summary), `${m.key}: the retirement reads what its own credit says`).toEqual(lines(fold(m, retired).summary));
      checked++;
    }
    expect(checked, "retirements after play").toBeGreaterThan(0);
  });
});

describe("X-WO-1 B: the kernel's predicate over the EVENT is the table's predicate over the decided OUTCOME", () => {
  // The sweep above reaches this only where a sport admits the forfeit (a walkover after play is refused by every sport the
  // award reaches, so it cannot see the `walkover` arm), so the predicate is pinned directly, against `isUnplayedForfeit`
  // (competition/points.ts: the table's authority), over every reason, both kinds of offender and both ledger facts.
  it("every reason x offender x {nothing played, play recorded}: the same verdict the table gives the outcome that forfeit decides; a double walkover is never one", () => {
    let checked = 0;
    let yes = 0;
    let no = 0;
    for (const reason of FORFEIT_REASONS) {
      for (const played of [false, true]) {
        const outcome = { kind: "award" as const, winner: H, loser: A, reason };
        const expected = isUnplayedForfeit(outcome, played);
        expect(unplayedForfeitEvent({ by: A, reason }, played), `${reason}/played=${played}`).toBe(expected);
        if (expected) yes++;
        else no++;
        checked++;
      }
    }
    expect(checked, "combinations").toBe(FORFEIT_REASONS.length * 2);
    // Both verdicts were reached, and the arm the sports cannot reach is among them: a walkover after play is unplayed.
    expect(yes, "unplayed verdicts").toBeGreaterThan(0);
    expect(no, "played verdicts").toBeGreaterThan(0);
    expect(unplayedForfeitEvent({ by: A, reason: "walkover" }, true), "a walkover after play is still nothing played").toBe(true);
    // A double walkover forfeits to no one: the table pays it its own row, never the award (its schema admits one reason).
    for (const played of [false, true]) expect(unplayedForfeitEvent({ by: "both", reason: "walkover" }, played), `double walkover/played=${played}`).toBe(false);
  });
});

describe("X-WO-1 B: the sequence - a double walkover, a second forfeit, a void then a re-decide, the empty offer", () => {
  it("a double walkover is no award: the offer changes nothing", () => {
    let checked = 0;
    for (const m of reaching()) {
      const events = [forfeit(1, "both", "walkover")];
      const base = fold(m, events);
      const offered = fold(m, events, ruleAwardFor(m));
      expect(base.outcome, m.key).toMatchObject({ kind: "double_walkover" });
      expect(JSON.stringify(offered.folded.state), m.key).toBe(JSON.stringify(base.folded.state));
      checked++;
    }
    expect(checked).toBe(reaching().length);
  });

  it("a second forfeit on a decided match is refused with or without the offer", () => {
    let checked = 0;
    for (const m of reaching()) {
      const events = [forfeit(1, A, "walkover"), forfeit(2, H, "walkover")];
      const base = codeOf(() => fold(m, events));
      expect(base, `${m.key}: premise - the second forfeit is refused`).toBe("ALREADY_DECIDED");
      expect(codeOf(() => fold(m, events, ruleAwardFor(m))), m.key).toBe(base);
      checked++;
    }
    expect(checked).toBe(reaching().length);
  });

  it("a void of the walkover then a different forfeit: the award follows the LATER forfeit (a withdrawal, still nothing played)", () => {
    let checked = 0;
    for (const m of reaching()) {
      const award = ruleAwardFor(m);
      const events = [forfeit(1, A, "walkover"), ev(2, "core.void", {}, "e-1"), forfeit(3, H, "withdrew")];
      const offered = fold(m, events, award);
      expect(offered.outcome, m.key).toMatchObject({ kind: "award", reason: "withdrew" });
      // H withdrew, so A is credited the rule's winner figure: home line = the rule's loser figure.
      expect(lines(offered.summary), m.key).toEqual([String(award[1]), String(award[0])]);
      checked++;
    }
    expect(checked).toBe(reaching().length);
  });

  it("a void of the walkover, then play, then a retirement: the voided forfeit leaves nothing of the award behind", () => {
    let checked = 0;
    for (const m of reaching()) {
      const { cfg, lineups } = rig(m);
      const play = onePlayEvent(m, cfg, lineups, [ev(1, "core.start")]);
      expect(play, `${m.key}: premise - the sport has a play event`).not.toBeNull();
      // Active ledger after the void is [Start, play, retired]: the same stream `onePlayEvent` drew its event against.
      const events = [forfeit(1, A, "walkover"), ev(2, "core.void", {}, "e-1"), ev(3, "core.start"), ev(4, play!.type, play!.payload), forfeit(5, A, "retired")];
      const offered = fold(m, events, ruleAwardFor(m));
      const plain = fold(m, events);
      expect(plain.outcome, `${m.key}: premise - the retirement is taken`).toMatchObject({ kind: "award", reason: "retired" });
      expect(JSON.stringify(offered.folded.state), `${m.key}: played, so the module's own credit`).toBe(JSON.stringify(plain.folded.state));
      expect(Object.hasOwn(offered.folded.state as object, "forfeitAward"), m.key).toBe(false);
      checked++;
    }
    expect(checked).toBe(reaching().length);
  });

  it("the empty case: no offer, or an offer of nothing, leaves no trace in any sport's state", () => {
    let checked = 0;
    forEachSport(({ module: m }) => {
      const events = [forfeit(1, A, "walkover")];
      for (const state of [fold(m, events).folded.state, fold(m, events, undefined).folded.state]) {
        expect(Object.hasOwn(state as object, "forfeitAward"), `${m.key}: no key without an offer`).toBe(false);
      }
      checked++;
    });
    expect(checked).toBe(builtinModules.length);
  });
});

describe("X-WO-1 B: the offer a stage rule makes to a fold (`forfeitAwardOffer`)", () => {
  it("a rule's award is offered, winner first, exactly where the award reaches the table", () => {
    let offered = 0;
    let withheld = 0;
    forEachSport(({ module: m }) => {
      const rule = ruleOf([7, 1]);
      if (pointsRuleAwardReachesTable(m)) {
        expect(forfeitAwardOffer(rule, m), m.key).toEqual([7, 1]);
        offered++;
      } else {
        expect(forfeitAwardOffer(rule, m), `${m.key}: the award never reaches this table, so no fold is offered one`).toBeUndefined();
        withheld++;
      }
    });
    expect(offered, "sports offered").toBe(reaching().length);
    expect(withheld, "sports not offered").toBe(notReaching().length);
    expect(offered).toBeGreaterThan(0);
    expect(withheld).toBeGreaterThan(0);
  });

  it("no rule, a rule with no forfeit row, a forfeit row with no award: nothing is offered (the empty cases)", () => {
    const football = builtinModules.find((m) => m.key === "football")!;
    const base = { base: { win: 3, draw: 1, loss: 0 }, bonuses: [] };
    expect(forfeitAwardOffer(null, football)).toBeUndefined();
    expect(forfeitAwardOffer(undefined, football)).toBeUndefined();
    expect(forfeitAwardOffer(legacyPointsRule(base), football)).toBeUndefined();
    expect(forfeitAwardOffer(legacyPointsRule({ ...base, forfeit: { winnerPoints: 2, loserPoints: 0 } }), football)).toBeUndefined();
    // A 0-0 award is a score like any other (Task 9 fix round 2): it IS offered.
    expect(forfeitAwardOffer(legacyPointsRule({ ...base, forfeit: { winnerPoints: 2, loserPoints: 0, awardScore: [0, 0] } }), football)).toEqual([0, 0]);
  });

  it("the offer is a copy: the rule's own tuple is never handed to a state", () => {
    const football = builtinModules.find((m) => m.key === "football")!;
    const rule = ruleOf([7, 1]);
    const offer = forfeitAwardOffer(rule, football)!;
    expect(offer).not.toBe(rule.forfeit!.awardScore);
  });
});
