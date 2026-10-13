// W2c Task 9 — X-PT-1 (spec items 10–11; owner Q9, P-3 "A") and Q1.
//
// X-PT-1 as signed (rules/cross-sport.md, ruling 129): "A forfeit is an award with nothing played (a walkover, or a
// withdrawal or disqualification before play): it pays the rule's walkover row, and its awarded score replaces the
// credit. A bye never receives the awarded score. An award after play earns normal points."
//
// Expected values come from the rule row above and the rule's OWN fields (`rule.forfeit.winnerPoints`, `rule.base.win`,
// `rule.forfeit.awardScore`), never from `applyPointsRule`; the award shapes from W2b's AWARD_REASONS; the played fact
// from W2b's `playRecorded` over a real ledger (the one authority, rulings 112–115, 118, 120, 127), never typed in.
// The rule pays a forfeit DIFFERENTLY from a result (2 / −1 against 3 / 0), so every wrong branch names itself.
import { describe, expect, it } from "vitest";
import { foldMatchWithStoppage, outcomeOf, playRecorded, type EventEnvelope } from "../core/events.ts";
import { AWARD_REASONS, FORFEIT_REASONS, type EntrantId, type LineupPair, type MatchOutcome } from "../core/types.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { declaredCfgs } from "../testkit/declared-cfgs.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { buildStream, lineupFromCatalog, makeEnvelope } from "../testkit/helpers.ts";
import { applyPointsRule, forfeitShaped, isUnplayedForfeit, pointsRuleAwardReachesTable, pointsRuleExpressible, PointsRule } from "./points.ts";
import { foldResults, type FixtureResult } from "./standings.ts";
import { AGAINST_KEYS, DIFF_KEYS, FOR_KEYS, metricKeyOf, rankStandings } from "./tiebreakers.ts";

const rule = PointsRule.parse({ base: { win: 3, draw: 1, loss: 0 }, forfeit: { winnerPoints: 2, loserPoints: -1, awardScore: [5, 0] } });
const FORFEIT = rule.forfeit!;
const AWARDED = FORFEIT.awardScore!;
const delta = (entrantId: string, won: 0 | 1, lost: 0 | 1, gf: number, ga: number) =>
  ({ entrantId, played: 1, won, drawn: 0, lost, points: 0, metrics: { for: gf, against: ga, diff: gf - ga } });
type D = ReturnType<typeof delta>;
/** A generic-sport-shaped pair: the sport's OWN ledger is for/against/diff, so "replaces" and "adds" differ. */
const pair = (gf: number, ga: number) => [delta("H", 1, 0, gf, ga), delta("A", 0, 1, ga, gf)] as unknown as FixtureResult;
const award = (reason: string): MatchOutcome => ({ kind: "award", winner: "H", loser: reason === "bye" ? null : "A", reason }) as never;
const win = (method: string): MatchOutcome => ({ kind: "win", winner: "H", loser: "A", method });
/** The generic-shaped pair's own keys ARE for/against/diff, so no further score keys are named (`undefined`). */
const apply = (o: MatchOutcome, p: FixtureResult, played: boolean, r = rule) => applyPointsRule(o, p, r, played, undefined) as unknown as [D, D];

const mod = (key: string): AnySportModule => {
  const m = builtinModules.find((x) => x.key === key);
  if (m === undefined) throw new Error(`no module ${key}`);
  return m;
};
const ev = (id: string, type: string, voids?: string) => ({ id, type, ...(voids === undefined ? {} : { voids }) });
// The played fact is read from ledgers through the ONE authority, never typed in.
const football = mod("football");
const NOTHING = playRecorded([ev("1", "core.start"), ev("2", "core.forfeit")], football);
const SOMETHING = playRecorded([ev("1", "core.start"), ev("2", "football.goal"), ev("3", "core.forfeit")], football);
/** Ruling 127: play that a void took back is no play. */
const VOIDED_AWAY = playRecorded([ev("1", "core.start"), ev("2", "football.goal"), ev("3", "core.void", "2"), ev("4", "core.forfeit")], football);

/** Reasons a side can forfeit for after play: every non-bye reason but the walkover (a walkover is a no-show by its
 *  own reason — X-PT-1's parenthetical, Q9 "only walkover = forfeit", ruling 118's chess no-show). */
const AFTER_PLAY_REASONS = FORFEIT_REASONS.filter((r) => r !== "walkover");

describe("X-PT-1 a forfeit is an award with nothing played, whatever its reason", () => {
  it("preconditions: the ledgers read as intended through playRecorded", () => {
    expect([NOTHING, SOMETHING, VOIDED_AWAY]).toEqual([false, true, false]);
  });

  it("covers every award reason W2b declares (counted)", () => {
    expect([...AWARD_REASONS].sort()).toEqual(["bye", "disqualified", "retired", "walkover", "withdrew"]);
    expect([...AFTER_PLAY_REASONS].sort()).toEqual(["disqualified", "retired", "withdrew"]);
  });

  it("empty case first: a rule with no forfeit row pays base points to every award, played or not, and adds no score (counted)", () => {
    const plain = PointsRule.parse({ base: { win: 3, draw: 1, loss: 0 } });
    let checked = 0;
    for (const reason of AWARD_REASONS)
      for (const played of [false, true]) {
        const [h, a] = apply(award(reason), pair(3, 0), played, plain);
        expect([h.points, a.points], `${reason}/${played}`).toEqual([plain.base.win, plain.base.loss]);
        expect(h.metrics, `${reason}/${played}: no awarded score without a forfeit row`).toEqual({ for: 3, against: 0, diff: 3 });
        checked++;
      }
    expect(checked).toBe(AWARD_REASONS.length * 2);
  });

  it("every non-bye reason with nothing played pays the forfeit row, and its awarded score REPLACES the credit (counted)", () => {
    let checked = 0;
    for (const reason of FORFEIT_REASONS) {
      const [h, a] = apply(award(reason), pair(3, 0), NOTHING);
      expect([h.points, a.points], reason).toEqual([FORFEIT.winnerPoints, FORFEIT.loserPoints]);
      // Replaced: the rule's 5-0, not the credit's 3-0 plus it (8-0).
      expect(h.metrics, reason).toEqual({ for: AWARDED[0], against: AWARDED[1], diff: AWARDED[0] - AWARDED[1] });
      expect(a.metrics, reason).toEqual({ for: AWARDED[1], against: AWARDED[0], diff: AWARDED[1] - AWARDED[0] });
      checked++;
    }
    expect(checked).toBe(AWARD_REASONS.length - 1);
  });

  it("a withdrawal or disqualification after play that a void took back is still nothing played (ruling 127)", () => {
    let checked = 0;
    for (const reason of ["withdrew", "disqualified"]) {
      const [h, a] = apply(award(reason), pair(3, 0), VOIDED_AWAY);
      expect([h.points, a.points], reason).toEqual([FORFEIT.winnerPoints, FORFEIT.loserPoints]);
      expect(h.metrics.for, reason).toBe(AWARDED[0]);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("every reason but the walkover AFTER play earns normal points and keeps the sport's credit (Q9, counted)", () => {
    let checked = 0;
    for (const reason of AFTER_PLAY_REASONS) {
      const [h, a] = apply(award(reason), pair(2, 1), SOMETHING);
      expect([h.points, a.points], reason).toEqual([rule.base.win, rule.base.loss]);
      expect(h.metrics, reason).toEqual({ for: 2, against: 1, diff: 1 });
      expect(a.metrics, reason).toEqual({ for: 1, against: 2, diff: -1 });
      expect(isUnplayedForfeit(award(reason), SOMETHING), reason).toBe(false);
      checked++;
    }
    expect(checked).toBe(AFTER_PLAY_REASONS.length);
  });

  it("a walkover is nothing played whatever the ledger reads: a chess no-show after Start pays the forfeit row (ruling 118)", () => {
    // single-sport: chess is the one module whose Start is play (startIsPlay) AND that admits a walkover after it.
    const chess = mod("boardgame");
    const cfg = chess.configSchema.parse({});
    const events = [makeEnvelope(1, { type: "core.start", payload: {} }), makeEnvelope(2, { type: "core.forfeit", payload: { by: "A", reason: "walkover" } })];
    const folded = foldMatchWithStoppage(chess as never, cfg as never, sides(chess, "H", "A"), events);
    const outcome = outcomeOf(chess as never, folded as never)!;
    expect(outcome, "the fold of a chess walkover after Start").toEqual({ kind: "award", winner: "H", loser: "A", reason: "walkover" });
    const played = playRecorded(events, chess);
    expect(played, "precondition: in chess the Start itself is play").toBe(true);
    expect(isUnplayedForfeit(outcome, played)).toBe(true);
    const [h, a] = applyPointsRule(outcome, chess.standingsDelta(outcome, cfg, { kind: "swiss" }, folded.state), rule, played, chess.awardScoreKeys);
    expect([h.points, a.points]).toEqual([FORFEIT.winnerPoints, FORFEIT.loserPoints]);
    expect([h.metrics.for, a.metrics.against]).toEqual([AWARDED[0], AWARDED[0]]);
  });

  it("a bye keeps the forfeit row's points but NEVER the awarded score, played or not", () => {
    let checked = 0;
    for (const played of [false, true]) {
      const [h] = apply(award("bye"), pair(0, 0), played);
      expect(h.points, `played=${played}`).toBe(FORFEIT.winnerPoints);
      expect(h.metrics, `played=${played}`).toEqual({ for: 0, against: 0, diff: 0 });
      expect(isUnplayedForfeit(award("bye"), played), `played=${played}`).toBe(false);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a second call is the first: the awarded score replaces, so the rule laid over its own result changes nothing", () => {
    const once = apply(award("walkover"), pair(3, 0), NOTHING);
    const twice = apply(award("walkover"), once, NOTHING);
    expect(twice).toEqual(once);
  });

  it("forfeitShaped covers a win by forfeit (chess) or walkover as well as every award; a regulation win and the rest are not", () => {
    let checked = 0;
    for (const reason of AWARD_REASONS) {
      expect(forfeitShaped(award(reason)), reason).toBe(true);
      checked++;
    }
    expect(forfeitShaped(win("forfeit"))).toBe(true);
    expect(forfeitShaped(win("walkover"))).toBe(true);
    for (const o of [win("regulation"), { kind: "win", winner: "H", loser: "A" }, { kind: "draw" }, { kind: "tie" }, { kind: "no_result" }, { kind: "double_walkover" }] as MatchOutcome[]) {
      expect(forfeitShaped(o), JSON.stringify(o)).toBe(false);
      checked++;
    }
    expect(checked).toBe(AWARD_REASONS.length + 6);
  });

  it("a chess win by forfeit AFTER moves were played earns normal points (the played flag reaches win outcomes)", () => {
    const won = win("forfeit");
    expect(isUnplayedForfeit(won, SOMETHING)).toBe(false);
    expect(apply(won, pair(1, 0), SOMETHING)[0].points).toBe(rule.base.win);
    expect(apply(won, pair(1, 0), NOTHING)[0].points).toBe(FORFEIT.winnerPoints);
  });

  it("a walkover win method is a forfeit, played flag or not; a regulation win is not", () => {
    expect(isUnplayedForfeit(win("walkover"), NOTHING)).toBe(true);
    expect(isUnplayedForfeit(win("walkover"), SOMETHING)).toBe(true);
    expect(isUnplayedForfeit(win("regulation"), NOTHING)).toBe(false);
    expect(isUnplayedForfeit(win("regulation"), SOMETHING)).toBe(false);
  });

  it("a double walkover stays 0 points for both whatever the flag (X-DW-4 unchanged)", () => {
    for (const played of [false, true]) {
      const [h, a] = apply({ kind: "double_walkover" }, pair(0, 0), played);
      expect([h.points, a.points], `played=${played}`).toEqual([0, 0]);
    }
  });

  it("bonuses follow the same split: after play the real score earns its margin bonus and no forfeit bonus; nothing played the reverse; a bye keeps its forfeit bonus", () => {
    // Every bonus pays a different power of two, so the sum names exactly which fired.
    const bonused = PointsRule.parse({
      base: { win: 3, draw: 1, loss: 0 },
      bonuses: [
        { when: "win_margin_gte", param: 1, points: 1 },
        { when: "loss_margin_lte", param: 5, points: 2 },
        { when: "forfeit_win", points: 4 },
        { when: "forfeit_loss", points: 8 },
      ],
      forfeit: { winnerPoints: 2, loserPoints: -1 },
    });
    let checked = 0;
    for (const reason of AFTER_PLAY_REASONS) {
      const [h, a] = apply(award(reason), pair(2, 1), SOMETHING, bonused);
      expect([h.points, a.points], `${reason} after play`).toEqual([bonused.base.win + 1, bonused.base.loss + 2]);
      const [hn, an] = apply(award(reason), pair(2, 1), NOTHING, bonused);
      expect([hn.points, an.points], `${reason} nothing played`).toEqual([bonused.forfeit!.winnerPoints + 4, bonused.forfeit!.loserPoints + 8]);
      checked++;
    }
    const [bye] = apply(award("bye"), pair(0, 0), false, bonused);
    expect(bye.points, "a bye: the forfeit row and the forfeit-win bonus, as before W2c").toBe(bonused.forfeit!.winnerPoints + 4);
    expect(checked).toBe(AFTER_PLAY_REASONS.length);
  });

  it("the loss-margin bonus an award after play earns pays at exactly its margin and not one past it (boundary, counted)", () => {
    const LOSS_BONUS = { when: "loss_margin_lte", param: 5, points: 2 } as const;
    const r = PointsRule.parse({ base: { win: 3, draw: 1, loss: 0 }, bonuses: [LOSS_BONUS] });
    let checked = 0;
    for (const reason of AFTER_PLAY_REASONS) {
      for (const [beatenBy, paid] of [[LOSS_BONUS.param, true], [LOSS_BONUS.param + 1, false]] as const) {
        const [, a] = apply(award(reason), pair(1 + beatenBy, 1), SOMETHING, r);
        expect(a.points, `${reason} beaten by ${beatenBy}`).toBe(r.base.loss + (paid ? LOSS_BONUS.points : 0));
        checked++;
      }
    }
    expect(checked).toBe(AFTER_PLAY_REASONS.length * 2);
  });
});

const sides = (m: AnySportModule, home: EntrantId, away: EntrantId): LineupPair => ({
  home: lineupFromCatalog(m.positions, home),
  away: lineupFromCatalog(m.positions, away),
});

/** A real ledger: `core.start`, then the module's own generated events up to the FIRST point where something is played
 *  (`playRecorded`) and nothing is decided yet, then `core.forfeit` with `reason` by the away side. Null when this cfg's
 *  generator never stands in such a state (a sport whose first sport event decides it). */
function playedThenForfeit(m: AnySportModule, cfg: unknown, reason: string): EventEnvelope[] | null {
  const l = sides(m, "H", "A");
  for (let seed = 1; seed <= 60; seed++) {
    const stream = buildStream(m as never, cfg as never, l, seed, 400);
    for (let i = 0; i < stream.length; i++) {
      const prefix = stream.slice(0, i + 1);
      if (prefix.some((e) => e.type === "core.forfeit" || e.type === "core.abandon")) break;
      if (!playRecorded(prefix, m)) continue;
      const folded = foldMatchWithStoppage(m as never, cfg as never, l, prefix);
      if (outcomeOf(m as never, folded as never) !== null) break;
      return [...prefix, makeEnvelope(prefix.length, { type: "core.forfeit", payload: { by: "A", reason } })];
    }
  }
  return null;
}

describe("X-PT-1 through every sport's own producer (fold → standingsDelta → applyPointsRule)", () => {
  it("a walkover with nothing played pays the forfeit row, and the awarded score replaces for/against/diff AND the sport's declared score keys — every sport, every declared cfg (counted)", () => {
    let checked = 0;
    let ownKeys = 0;
    forEachSport(({ module: m }) => {
      for (const { name, cfg } of declaredCfgs(m as never)) {
        const events = [makeEnvelope(1, { type: "core.forfeit", payload: { by: "A", reason: "walkover" } })];
        const folded = foldMatchWithStoppage(m as never, cfg as never, sides(m, "H", "A"), events);
        const outcome = outcomeOf(m as never, folded as never)!;
        expect(outcome, `${m.key}/${name}`).toEqual({ kind: "award", winner: "H", loser: "A", reason: "walkover" });
        const played = playRecorded(events, m);
        expect(played, `${m.key}/${name}: nothing played`).toBe(false);
        const credit = m.standingsDelta(outcome, cfg, { kind: "league" }, folded.state) as FixtureResult;
        const [h, a] = applyPointsRule(outcome, credit, rule, played, m.awardScoreKeys);
        expect([h.points, a.points], `${m.key}/${name}`).toEqual([FORFEIT.winnerPoints, FORFEIT.loserPoints]);
        // The generic keys ARE the awarded score, and so are the sport's own score keys where it declares them (gap a,
        // held to its metrics by the declaration guard below); every other key stands as the sport credited it.
        const k = m.awardScoreKeys;
        const own = (mine: number, theirs: number) => (k === undefined ? {} : { [k.for]: mine, [k.against]: theirs, [k.diff]: mine - theirs });
        expect(h.metrics, `${m.key}/${name} home`).toEqual({ ...credit[0].metrics, for: AWARDED[0], against: AWARDED[1], diff: AWARDED[0] - AWARDED[1], ...own(AWARDED[0], AWARDED[1]) });
        expect(a.metrics, `${m.key}/${name} away`).toEqual({ ...credit[1].metrics, for: AWARDED[1], against: AWARDED[0], diff: AWARDED[1] - AWARDED[0], ...own(AWARDED[1], AWARDED[0]) });
        if (k !== undefined) ownKeys++;
        checked++;
      }
    });
    expect(checked).toBeGreaterThanOrEqual(builtinModules.length);
    expect(ownKeys, "some sport declares its own score keys, so the spread above is not vacuous").toBeGreaterThan(0);
  });

  it("a withdrawal, a disqualification and a retirement after play earn normal points and keep the sport's own credit — every sport (counted)", () => {
    const covered = new Set<string>();
    let checked = 0;
    forEachSport(({ module: m }) => {
      for (const { name, cfg } of declaredCfgs(m as never)) {
        for (const reason of AFTER_PLAY_REASONS) {
          const events = playedThenForfeit(m, cfg, reason);
          if (events === null) continue;
          const folded = foldMatchWithStoppage(m as never, cfg as never, sides(m, "H", "A"), events);
          const outcome = outcomeOf(m as never, folded as never)!;
          expect(outcome, `${m.key}/${name}/${reason}`).toEqual({ kind: "award", winner: "H", loser: "A", reason });
          const played = playRecorded(events, m);
          expect(played, `${m.key}/${name}/${reason}: something played`).toBe(true);
          const credit = m.standingsDelta(outcome, cfg, { kind: "league" }, folded.state) as FixtureResult;
          const [h, a] = applyPointsRule(outcome, credit, rule, played, m.awardScoreKeys);
          expect([h.points, a.points], `${m.key}/${name}/${reason}`).toEqual([rule.base.win, rule.base.loss]);
          expect([h.metrics, a.metrics], `${m.key}/${name}/${reason}: the sport's credit, untouched`).toEqual([credit[0].metrics, credit[1].metrics]);
          covered.add(m.key);
          checked++;
        }
      }
    });
    expect(checked).toBeGreaterThan(0);
    // Every module reaches "something played, nothing decided" in some declared cfg, so none is skipped.
    expect([...covered].sort()).toEqual(builtinModules.map((m) => m.key).sort());
  });
});

// ---------------------------------------------------------------------------
// W2c X-PT-1 gap (a) (coordinator's overnight ruling under the owner's standing instruction, 2026-10-13): the signed rule
// says the awarded score REPLACES the credit, and the tie-breaks read a sport's own score keys BEFORE the generic ones
// (tiebreakers.ts FOR_KEYS / DIFF_KEYS: `gd` before `diff`, `gf` before `for`) — so a rule writing only the generic keys
// never reached football's table. Which keys a sport keeps its match score under is the module's own declaration
// (`awardScoreKeys`); the guard holds it to the module's metrics and the tie-break alias lists, never a hand list.
// ---------------------------------------------------------------------------

/** The score triples the tie-breaks know, index for index (`for` / `against` / `diff` under each sport's spelling). */
const ALIAS_TRIPLES = DIFF_KEYS.map((diff, i) => ({ for: FOR_KEYS[i]!, against: AGAINST_KEYS[i]!, diff }));
/** A sport whose metrics carry a score triple but whose table takes no awarded score — by name, with the reason. */
const NO_AWARD_SCORE: Readonly<Record<string, string>> = {
  cricket:
    "its runs are NRR operands beside the balls; a walkover credits no runs and is out of NRR (CK-WO-2, ruling 125), and P1 (2026-09-24) keeps a rule's award off the runs (tiebreak-rule-award-alias.test.ts)",
};

/** A real decided match (a win) from the module's own generator: the row a sport's table builds from real play. */
function playedWin(m: AnySportModule, cfg: unknown): FixtureResult | null {
  const l = sides(m, "H", "A");
  for (let seed = 1; seed <= 60; seed++) {
    const stream = buildStream(m as never, cfg as never, l, seed, 400);
    if (stream.some((e) => e.type === "core.forfeit" || e.type === "core.abandon")) continue;
    const folded = foldMatchWithStoppage(m as never, cfg as never, l, stream);
    const outcome = outcomeOf(m as never, folded as never);
    if (outcome?.kind !== "win" || outcome.winner !== "H") continue;
    return m.standingsDelta(outcome, cfg, { kind: "league" }, folded.state);
  }
  return null;
}

/** A walkover by A through the module's own fold, then the rule, with the module's declared score keys. */
function ruledWalkover(m: AnySportModule, cfg: unknown, r: PointsRule = rule): { credit: FixtureResult; ruled: FixtureResult } {
  const events = [makeEnvelope(1, { type: "core.forfeit", payload: { by: "A", reason: "walkover" } })];
  const folded = foldMatchWithStoppage(m as never, cfg as never, sides(m, "H", "A"), events);
  const outcome = outcomeOf(m as never, folded as never)!;
  const credit = m.standingsDelta(outcome, cfg, { kind: "league" }, folded.state) as FixtureResult;
  return { credit, ruled: applyPointsRule(outcome, credit, r, playRecorded(events, m), m.awardScoreKeys) };
}

describe("X-PT-1 gap (a) — the awarded score reaches the sport's own score keys", () => {
  it("every module declares exactly the score triple its own metrics carry; cricket alone is exempt, by name (counted)", () => {
    let checked = 0;
    let declared = 0;
    const exempt: string[] = [];
    for (const m of builtinModules) {
      const metricKeys = new Set(m.metrics.map((x) => x.key));
      const triples = ALIAS_TRIPLES.filter((t) => metricKeys.has(t.for) && metricKeys.has(t.against) && metricKeys.has(t.diff));
      expect(triples.length, `${m.key}: at most one score triple`).toBeLessThanOrEqual(1);
      if (NO_AWARD_SCORE[m.key] !== undefined) {
        expect(triples.length, `${m.key}: an exemption is for a sport that HAS a score triple`).toBe(1);
        expect(m.awardScoreKeys, m.key).toBeUndefined();
        exempt.push(m.key);
      } else if (triples.length === 1) {
        expect(m.awardScoreKeys, m.key).toEqual(triples[0]);
        declared++;
      } else {
        expect(m.awardScoreKeys, `${m.key}: no score triple, nothing to declare`).toBeUndefined();
      }
      checked++;
    }
    expect(checked).toBe(builtinModules.length);
    expect(declared, "some sport declares its score keys").toBeGreaterThan(0);
    expect(exempt, "every exemption names a real module").toEqual(Object.keys(NO_AWARD_SCORE));
  });

  it("football: a walkover under a stage rule awarding 5-0 reads gd +5 on the table, not the division's own 3-0 — and ranks by it", () => {
    // single-sport: the differential the ruling names; the sweep above and the reach test below cover the registry.
    const cfg = football.configSchema.parse({}) as { awardScore: { goals: number } };
    const divisionGoals = cfg.awardScore.goals;
    expect(AWARDED[0] - AWARDED[1], "premise: the rule's margin differs from the division's").not.toBe(divisionGoals);
    const { credit, ruled: [h, a] } = ruledWalkover(football, cfg);
    expect(credit[0].metrics.gd, "precondition: the sport's own credit is the division's awardScore").toBe(divisionGoals);
    expect([h.metrics.gf, h.metrics.ga, h.metrics.gd]).toEqual([AWARDED[0], AWARDED[1], AWARDED[0] - AWARDED[1]]);
    expect([a.metrics.gf, a.metrics.ga, a.metrics.gd]).toEqual([AWARDED[1], AWARDED[0], AWARDED[1] - AWARDED[0]]);
    // Through the tie-break reader: B won 4-0 for real, level with H on points. The `diff` key reads `gd` first, so H's
    // rule-awarded +5 ranks it above B's +4; on the division's 3-0 it would rank below.
    const realWin = (id: string, opp: string, gf: number) =>
      [
        { entrantId: id, played: 1, won: 1, drawn: 0, lost: 0, points: FORFEIT.winnerPoints, metrics: { gf, ga: 0, gd: gf } },
        { entrantId: opp, played: 1, won: 0, drawn: 0, lost: 1, points: 0, metrics: { gf: 0, ga: gf, gd: -gf } },
      ] as unknown as FixtureResult;
    const RIVAL_GD = divisionGoals + 1;
    expect(RIVAL_GD, "premise: the rival sits between the division's credit and the rule's").toBeLessThan(AWARDED[0] - AWARDED[1]);
    const rows = rankStandings(foldResults(["H", "A", "B", "C"], [[h, a] as unknown as FixtureResult, realWin("B", "C", RIVAL_GD)]), { cascade: ["points", "diff"] }).rows;
    expect(rows.map((r) => r.entrantId).slice(0, 2)).toEqual(["H", "B"]);
  });

  it("pointsRuleAwardReachesTable: true exactly where the key the sport's OWN table ranks `diff` by takes the awarded score — every sport, read through the tie-break alias reader (counted)", () => {
    // An award no sport credits by itself (ice hockey's own walkover is 5-0, the shared rule's), so "the table now reads
    // the award" cannot be a coincidence — the precondition below holds it.
    const odd = PointsRule.parse({ ...rule, forfeit: { ...FORFEIT, awardScore: [9, 1] } });
    const oddDiff = odd.forfeit!.awardScore![0] - odd.forfeit!.awardScore![1];
    let checked = 0;
    const reaching: string[] = [];
    for (const m of builtinModules) {
      const cfg = declaredCfgs(m as never)[0]!.cfg;
      const real = playedWin(m, cfg);
      expect(real, `${m.key}: a real win from its own generator`).not.toBeNull();
      // The key this sport's table reads for `diff`, off a row holding only real play.
      const readKey = metricKeyOf(foldResults(["H", "A"], [real!]).find((r) => r.entrantId === "H")!, DIFF_KEYS);
      const { credit, ruled: [h] } = ruledWalkover(m, cfg, odd);
      if (readKey !== undefined) expect(credit[0].metrics[readKey], `${m.key}: precondition, the credit is not already the award`).not.toBe(oddDiff);
      const takes = readKey !== undefined && h.metrics[readKey] === oddDiff;
      expect(pointsRuleAwardReachesTable(m), `${m.key} (its table reads ${readKey ?? "no score difference"})`).toBe(takes);
      if (takes) reaching.push(m.key);
      checked++;
    }
    expect(checked).toBe(builtinModules.length);
    expect(reaching.length, "some sport's table takes the award").toBeGreaterThan(0);
    expect(reaching.length, "and some sport's does not (the set sports)").toBeLessThan(builtinModules.length);
  });

  it("the division's awardScore still decides a football award AFTER play under the same rule (FB-RT-1 goalCredit), so a stage rule never makes it irrelevant", () => {
    // single-sport: the premise the ruling's step 3 rests on, checked where it fails (period sports share goalCredit).
    // A real 1-0 lead, then the away side retires. FB-RT-1: the awarded score unless the real margin is worse for the
    // offender — 1 is not worse than 3 or 4 — so the credit is the division's awardScore-0, and the rule (an award after
    // play is a result, X-PT-1) leaves it standing.
    const seen = new Set<number>();
    for (const goals of [3, 4]) {
      const cfg = football.configSchema.parse({ awardScore: { goals } });
      const events = [
        makeEnvelope(1, { type: "core.start", payload: {} }),
        makeEnvelope(2, { type: "football.goal", payload: { by: "H" } }),
        makeEnvelope(3, { type: "core.forfeit", payload: { by: "A", reason: "retired" } }),
      ];
      const folded = foldMatchWithStoppage(football as never, cfg as never, sides(football, "H", "A"), events);
      const outcome = outcomeOf(football as never, folded as never)!;
      const played = playRecorded(events, football);
      expect(played, "precondition: a goal is play").toBe(true);
      const credit = football.standingsDelta(outcome, cfg, { kind: "league" }, folded.state) as FixtureResult;
      const [h] = applyPointsRule(outcome, credit, rule, played, football.awardScoreKeys);
      expect(h.metrics.gd, `division awardScore ${goals}`).toBe(goals);
      seen.add(h.metrics.gd as number);
    }
    expect(seen.size, "two division values, two different tables under one stage rule").toBe(2);
  });
});

/** Q1 / spec §2 routing (b): the per-sport point systems a stage PointsRule (win/draw/loss + bonuses + forfeit) cannot
 *  express — routed to W2d — named per module and preset. Ice hockey's OT/SO (default and iihf), hockey's shoot-out
 *  split (fih-shootout), cricket's tie / no-result (every preset, plan finding 29), and volleyball's set-score map
 *  (FIVB 3-2 → 2:1, indoor and the default; beach pays one pair). Every other preset is expressible. */
const INEXPRESSIBLE: Record<string, readonly string[]> = {
  "icehockey/(schema default)": ["otWin", "otLoss"],
  "icehockey/iihf": ["otWin", "otLoss"],
  "hockey/fih-shootout": ["shootoutWin", "shootoutLoss"],
  "cricket/(schema default)": ["tie", "noResult"],
  "cricket/t20": ["tie", "noResult"],
  "cricket/odi": ["tie", "noResult"],
  "cricket/hundred": ["tie", "noResult"],
  "cricket/test": ["tie", "noResult"],
  "volleyball/(schema default)": ["pointsMap"],
  "volleyball/indoor": ["pointsMap"],
};

describe("Q1 pointsRuleExpressible — refused, never silently dropped", () => {
  it("empty / null division cfg is expressible (the empty case)", () => {
    expect(pointsRuleExpressible({})).toEqual({ ok: true });
    expect(pointsRuleExpressible(null)).toEqual({ ok: true });
    expect(pointsRuleExpressible(undefined)).toEqual({ ok: true });
  });

  it("every builtin division preset: refused exactly where the sport splits its points, naming the split keys (counted)", () => {
    let checked = 0;
    const seen = new Set<string>();
    forEachSport(({ module: m }) => {
      for (const { name, cfg } of declaredCfgs(m as never)) {
        const id = `${m.key}/${name}`;
        const want = INEXPRESSIBLE[id];
        const got = pointsRuleExpressible(cfg);
        if (want === undefined) expect(got, id).toEqual({ ok: true });
        else {
          expect(got, id).toMatchObject({ ok: false });
          expect(got.ok === false ? [...got.keys].sort() : [], id).toEqual([...want].sort());
          expect(got.ok === false ? got.reason : "", id).toMatch(/cannot express/);
          seen.add(id);
        }
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(builtinModules.length);
    expect([...seen].sort(), "every refusal the table names was reached").toEqual(Object.keys(INEXPRESSIBLE).sort());
  });

  it("a null split value is not a split; one set-score pair repeated is not a split", () => {
    expect(pointsRuleExpressible({ points: { win: 3, draw: 1, loss: 0, otWin: null } })).toEqual({ ok: true });
    expect(pointsRuleExpressible({ pointsMap: { "2-0": [2, 0], "2-1": [2, 0], "*": [2, 0] } })).toEqual({ ok: true });
    expect(pointsRuleExpressible({ pointsMap: { "3-2": [2, 1], "*": [3, 0] } })).toMatchObject({ ok: false, keys: ["pointsMap"] });
  });

  it("the refusal names every split key, comma-separated, in the brief's declared sentence", () => {
    expect(pointsRuleExpressible({ points: { win: 2, loss: 0, otWin: 2, otLoss: 1 } })).toEqual({
      ok: false,
      keys: ["otWin", "otLoss"],
      reason: "this division awards otWin, otLoss, which a stage points rule cannot express yet",
    });
  });
});
