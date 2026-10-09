// W2a Task 14 Step 4: the bracket policy and the counted check (finding 16). Expected values come from the engine's own
// declarations (SETTLE_METHODS, TIEBREAK_RUNGS, StageKind.options, supportsDraws) and the rule rows (BG-KO-1, GN-KO-1,
// X-ST-1), never from the policy's own text. Needs loop D's exports (merged into this lane).
import { SETTLE_METHODS, StageKind, forbidsLevelResult } from "@seazn/engine/core";
import { generatePagePlayoff } from "@seazn/engine/scheduling";
import { TIEBREAK_RUNGS } from "@seazn/engine/sports/boardgame";
import { describe, expect, it } from "vitest";
import { SPORT_KEYS } from "../lib/catalogue.ts";
import type { FixtureRow } from "../lib/driver/types.ts";
import { evaluateInvariants } from "../lib/invariants.ts";
import type { ObservedFixture, ObservedRun } from "../lib/observed.ts";
import { decideState } from "../lib/results.ts";
import { Recorder, bracketPolicy, hardPath, type DivisionSetup } from "../lib/scenarios/common.ts";
import { bracketDeciderExercised } from "../lib/scenarios/assertions.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import type { CaseSpec } from "../lib/scenarios/types.ts";
import { resolveSportCfg, stageCfg } from "../lib/sport-cfg.ts";
import { levelReachable } from "../lib/streams/index.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { FakeKnockoutDriver } from "./fake-driver.ts";

/** A setup that seeds by id order: "a" is seed 1, "b" seed 2. Only seedOf is read by the policy. */
const setup = { seedOf: (id: string) => (id === "a" ? 1 : 2) } as unknown as DivisionSetup;
const fixture = (home: string, away: string): FixtureRow => ({ home_entrant_id: home, away_entrant_id: away } as FixtureRow);
const cfgOf = (sport: string) => stageCfg(sport, resolveSportCfg(sport, offlineBuilderDefault(sport)), "knockout");

describe("bracketPolicy — the first of every three bracket fixtures asks for the hard path, the rest play out", () => {
  it("ordinal 0, 1, 2, 3 …: hard, win, win, hard; the win is the better seed's side, whichever side that is", () => {
    for (const [home, away, higher] of [["a", "b", "home"], ["b", "a", "away"]] as const) {
      const asked = [0, 1, 2, 3, 4, 5, 6].map((o) => bracketPolicy(setup, fixture(home, away), "generic", o, cfgOf("generic")).kind);
      expect(asked, `${home} v ${away}`).toEqual(["settle", "win", "win", "settle", "win", "win", "settle"]);
      for (const o of [1, 2, 4, 5]) expect(bracketPolicy(setup, fixture(home, away), "generic", o, cfgOf("generic")), `ordinal ${o}`).toEqual({ kind: "win", winner: higher });
      expect(bracketPolicy(setup, fixture(home, away), "generic", 0, cfgOf("generic")), "the hard path ends in the better seed's win too").toMatchObject({ then: higher });
    }
  });

  it("the settle method and the tie-break rung rotate through the ENGINE's own lists, one step per hard path", () => {
    const methods = [0, 3, 6, 9, 12].map((o) => (bracketPolicy(setup, fixture("a", "b"), "football", o, cfgOf("football")) as { method: string }).method);
    expect(methods).toEqual([0, 1, 2, 3, 4].map((n) => SETTLE_METHODS[n % SETTLE_METHODS.length]));
    expect(new Set(methods).size, "every settle method is reached").toBe(SETTLE_METHODS.length);
    const rungs = [0, 3, 6, 9, 12].map((o) => (bracketPolicy(setup, fixture("a", "b"), "boardgame", o, cfgOf("boardgame")) as { rung: string }).rung);
    expect(rungs).toEqual([0, 1, 2, 3, 4].map((n) => TIEBREAK_RUNGS[n % TIEBREAK_RUNGS.length]));
    expect(new Set(rungs).size, "every tie-break rung is reached").toBe(TIEBREAK_RUNGS.length);
  });

  it("swept over the registry: chess takes its tie-break (BG-KO-1), generic can only abandon then settle (GN-KO-1), every other sport settles after a level result or an abandon — whichever its generator can build", () => {
    let judged = 0;
    let level = 0;
    let abandon = 0;
    for (const sport of SPORT_KEYS) {
      const cfg = cfgOf(sport);
      const reach = levelReachable(sport, cfg, "knockout");
      for (const n of [0, 1, 2, 3]) {
        const asked = hardPath(sport, cfg, n, "home");
        if (sport === "boardgame") {
          expect(asked, `${sport} ${n}`).toMatchObject({ kind: "tiebreak", winner: "home" });
        } else {
          expect(asked, `${sport} ${n}`).toMatchObject({ kind: "settle", then: "home" });
          const after = (asked as { after: string }).after;
          expect(after === "level" ? reach : true, `${sport} ${n}: a level result is asked only where the generator can build one`).toBe(true);
          if (after === "level") level++; else abandon++;
        }
        judged++;
      }
      if (sport === "generic") expect(reach, "GN-KO-1: generic refuses a draw in a bracket, so it never asks for a level result").toBe(false);
    }
    expect(judged).toBe(SPORT_KEYS.length * 4);
    expect(judged).toBeGreaterThan(0);
    // The differing case on both sides: a level result is asked somewhere, and an abandon somewhere else.
    expect(level).toBeGreaterThan(0);
    expect(abandon).toBeGreaterThan(0);
  });
});

describe("life-bracket-decider-exercised — zero is a failure, never an abstention (R25)", () => {
  const fx = (id: string, method?: string): ObservedFixture =>
    ({ id, stageId: "s1", poolId: null, roundNo: 1, home: "a", away: "b", status: "decided", outcome: { kind: "win", winner: "a", ...(method === undefined ? {} : { method }) } as never, declared: null });
  const run = (kind: string, fixtures: ObservedFixture[]): ObservedRun => ({
    caseId: "c", facts: [], withdrawal: null, configEdit: null,
    stages: [{ id: "s1", seq: 1, kind, config: {}, field: ["a", "b"], fieldSource: "division", fixtures, standings: [], generates: [], pairRounds: [], complete: null }],
  });

  it("a run with no bracket stage abstains BY NAME (the rule says nothing about it); every bracket kind owes a decider, swept over StageKind.options", () => {
    let bracket = 0;
    let other = 0;
    for (const kind of StageKind.options) {
      const got = bracketDeciderExercised(new Recorder(), run(kind, [fx("f1")]));
      if (forbidsLevelResult(kind)) {
        expect(got, kind).toMatchObject({ id: "life-bracket-decider-exercised", verdict: "fail" });
        expect(got.evidence[0], kind).toMatch(/no decider posted/);
        bracket++;
      } else {
        expect(got, kind).toMatchObject({ verdict: "abstain", checked: 0 });
        expect(got.reason, kind).toMatch(/no bracket stage/);
        other++;
      }
    }
    expect(bracket + other).toBe(StageKind.options.length);
    expect(bracket).toBeGreaterThan(0);
    expect(other).toBeGreaterThan(0);
  });

  it("posted deciders must be the ones the product shows: a settle that left no settled_ win, or a tie-break with no tiebreak_ win, fails; the matching read-back passes", () => {
    const settled = new Recorder();
    settled.settlesPosted = 1;
    expect(bracketDeciderExercised(settled, run("knockout", [fx("f1", "settled_lot"), fx("f2")]))).toMatchObject({ verdict: "pass", checked: 3 });
    expect(bracketDeciderExercised(settled, run("knockout", [fx("f1"), fx("f2")]))).toMatchObject({ verdict: "fail", evidence: [expect.stringMatching(/posted 1 settle\(s\), the product shows 0/)] });
    const broken = new Recorder();
    broken.tiebreaksPosted = 1;
    expect(bracketDeciderExercised(broken, run("knockout", [fx("f1", "tiebreak_rapid")]))).toMatchObject({ verdict: "pass", checked: 3 });
    expect(bracketDeciderExercised(broken, run("knockout", [fx("f1", "settled_lot")]))).toMatchObject({ verdict: "fail" });
    // A tie-break posted and nothing of it on the product's side: ONLY the tie-break read-back is wrong here.
    expect(bracketDeciderExercised(broken, run("knockout", [fx("f1")]))).toMatchObject({ verdict: "fail", evidence: [expect.stringMatching(/posted 1 tie-break\(s\), the product shows 0/)] });
    // The product showing a settle the harness never posted is as wrong as the reverse.
    expect(bracketDeciderExercised(new Recorder(), run("knockout", [fx("f1", "settled_lot")]))).toMatchObject({ verdict: "fail" });
  });
});

// Review I-3: bracketPolicy asks the hard path of every third bracket fixture, but a walkover (M1) or a recorded
// withdrawal can finish that fixture before decideFixture reaches it. The decider is then not owed for that slot. The
// exemption is read from the run's own record (Recorder.hardPathSlots: the fixtures the policy asked a hard path of;
// hardPathPassedOver: those decideFixture found already finished) and needs the record to SAY so - a run that asked no
// slot at all (a bracket stage that was never reached) still owes the decider, because zero is a failure (R25).
describe("life-bracket-decider-exercised - owed only if a hard-path slot reached a fixture left to decide (I-3)", () => {
  const fx = (id: string, method?: string): ObservedFixture =>
    ({ id, stageId: "s1", poolId: null, roundNo: 1, home: "a", away: "b", status: "decided", outcome: { kind: "win", winner: "a", ...(method === undefined ? {} : { method }) } as never, declared: null });
  const run = (kind: string, fixtures: ObservedFixture[]): ObservedRun => ({
    caseId: "c", facts: [], withdrawal: null, configEdit: null,
    stages: [{ id: "s1", seq: 1, kind, config: {}, field: ["a", "b"], fieldSource: "division", fixtures, standings: [], generates: [], pairRounds: [], complete: null }],
  });
  const recorded = (slots: string[], passedOver: string[], posted: { settles?: number; tiebreaks?: number } = {}): Recorder => {
    const rec = new Recorder();
    rec.hardPathSlots.push(...slots);
    for (const id of passedOver) rec.hardPathPassedOver.add(id);
    rec.settlesPosted = posted.settles ?? 0;
    rec.tiebreaksPosted = posted.tiebreaks ?? 0;
    return rec;
  };
  const BRACKETS = StageKind.options.filter((k) => forbidsLevelResult(k));

  it("every slot the policy asked fell on a fixture already finished, and nothing was posted: not owed - the check abstains, saying why, on every bracket kind", () => {
    let judged = 0;
    for (const kind of BRACKETS) {
      const got = bracketDeciderExercised(recorded(["f1"], ["f1"]), run(kind, [fx("f1"), fx("f2")]));
      expect(got, kind).toMatchObject({ id: "life-bracket-decider-exercised", verdict: "abstain", checked: 0 });
      expect(got.reason, kind).toMatch(/not owed: .*1 hard-path slot/);
      judged++;
    }
    expect(judged).toBe(BRACKETS.length);
    expect(judged).toBeGreaterThan(0);
  });

  it("a slot reached a fixture left to decide and no decider was posted: owed, and it FAILS (the walkover took one slot, another was missed)", () => {
    const got = bracketDeciderExercised(recorded(["f1", "f4"], ["f1"]), run("knockout", [fx("f1"), fx("f4")]));
    expect(got).toMatchObject({ verdict: "fail" });
    expect(got.evidence[0]).toMatch(/no decider posted/);
  });

  it("owed and posted: passes on counted items, and the read-back is judged as before", () => {
    const got = bracketDeciderExercised(recorded(["f1", "f4"], ["f1"], { settles: 1 }), run("knockout", [fx("f1"), fx("f4", "settled_lot")]));
    expect(got).toMatchObject({ verdict: "pass", checked: 3 });
    expect(bracketDeciderExercised(recorded(["f1", "f4"], ["f1"], { settles: 1 }), run("knockout", [fx("f1"), fx("f4")]))).toMatchObject({ verdict: "fail", evidence: [expect.stringMatching(/posted 1 settle\(s\), the product shows 0/)] });
  });

  it("every slot was passed over but a decider WAS posted (another stage's): the exemption does not apply, the read-back is still enforced", () => {
    expect(bracketDeciderExercised(recorded(["f1"], ["f1"], { tiebreaks: 1 }), run("knockout", [fx("f1"), fx("f2", "tiebreak_rapid")]))).toMatchObject({ verdict: "pass", checked: 3 });
    expect(bracketDeciderExercised(recorded(["f1"], ["f1"], { tiebreaks: 1 }), run("knockout", [fx("f1"), fx("f2")]))).toMatchObject({ verdict: "fail" });
  });

  it("no slot asked at all (a bracket stage never reached) is NOT an exemption: zero is a failure, on every bracket kind", () => {
    let judged = 0;
    for (const kind of BRACKETS) {
      const got = bracketDeciderExercised(recorded([], []), run(kind, [fx("f1")]));
      expect(got, kind).toMatchObject({ verdict: "fail" });
      expect(got.evidence[0], kind).toMatch(/no decider posted/);
      judged++;
    }
    expect(judged).toBe(BRACKETS.length);
  });

  it("a slot passed over that the policy never asked is no exemption either: only an asked slot can be consumed", () => {
    expect(bracketDeciderExercised(recorded([], ["f9"]), run("knockout", [fx("f1")]))).toMatchObject({ verdict: "fail" });
    // …and an unasked pass-over cannot stand in for an asked slot that was reached (f4 is still owed).
    expect(bracketDeciderExercised(recorded(["f1", "f4"], ["f1", "f9"]), run("knockout", [fx("f1"), fx("f4")]))).toMatchObject({ verdict: "fail", evidence: [expect.stringMatching(/no decider posted/)] });
  });
});

describe("life-bracket-decider-exercised — a settle the recorded withdrawal struck is explained, not a missing read-back (M-6, R4 on a bracket)", () => {
  const settledFx = (id: string, status: string, method?: string): ObservedFixture =>
    ({ id, stageId: "s1", poolId: null, roundNo: 1, home: "a", away: "b", status, outcome: method === undefined ? null : ({ kind: "win", winner: "a", method } as never), declared: null });
  const withdrawn = (policy: "walkover" | "expunge", before: { id: string; status: string }[]) => ({ entrantId: "a", afterRound: 1, policy, walkovers: 0, voided: 0, skippedFinalized: 0, before: before.map((b) => ({ ...b, outcome: null })) });
  const runWith = (fixtures: ObservedFixture[], w: ReturnType<typeof withdrawn> | null): ObservedRun => ({
    caseId: "c", facts: [], withdrawal: w, configEdit: null,
    stages: [{ id: "s1", seq: 1, kind: "knockout", config: {}, field: ["a", "b"], fieldSource: "division", fixtures, standings: [], generates: [], pairRounds: [], complete: null }],
  });
  const settleDrive = (fixtureId: string) => ({ fixtureId, asked: { kind: "settle" } }) as never;

  it("an expunge that abandoned the settled fixture of the withdrawn entrant passes (the withdrawal explains the missing settled_ win); with NO recorded withdrawal the same read-back fails", () => {
    const rec = new Recorder();
    rec.settlesPosted = 2;
    rec.bracketDrives.push(settleDrive("f1"), settleDrive("f2"));
    const fixtures = [settledFx("f1", "abandoned"), settledFx("f2", "decided", "settled_lot")];
    const w = withdrawn("expunge", [{ id: "f1", status: "decided" }, { id: "f2", status: "decided" }]);
    expect(bracketDeciderExercised(rec, runWith(fixtures, w))).toMatchObject({ verdict: "pass" });
    expect(bracketDeciderExercised(rec, runWith(fixtures, null))).toMatchObject({ verdict: "fail", evidence: [expect.stringMatching(/posted 2 settle\(s\), the product shows 1/)] });
  });

  it("a tie-break the expunge struck is explained the same way, and a struck decider of one kind never explains a missing one of the other", () => {
    const tied = (id: string, status: string, method?: string) => settledFx(id, status, method);
    const drive = (fixtureId: string, kind: "settle" | "tiebreak") => ({ fixtureId, asked: { kind } }) as never;
    const w = withdrawn("expunge", [{ id: "t1", status: "decided" }, { id: "s1", status: "decided" }]);
    const onlyTiebreak = new Recorder();
    onlyTiebreak.tiebreaksPosted = 1;
    onlyTiebreak.bracketDrives.push(drive("t1", "tiebreak"));
    expect(bracketDeciderExercised(onlyTiebreak, runWith([tied("t1", "abandoned")], w))).toMatchObject({ verdict: "pass" });
    // One settle shown, one tie-break struck: the struck tie-break must not be counted toward the settles too.
    const both = new Recorder();
    both.settlesPosted = 2;
    both.tiebreaksPosted = 1;
    both.bracketDrives.push(drive("t1", "tiebreak"), drive("s1", "settle"), drive("s2", "settle"));
    const fixtures = [tied("t1", "abandoned"), tied("s1", "decided", "settled_lot"), tied("s2", "decided")];
    const got = bracketDeciderExercised(both, runWith(fixtures, w));
    expect(got).toMatchObject({ verdict: "fail" });
    expect(got.evidence).toEqual([expect.stringMatching(/posted 2 settle\(s\), the product shows 1/)]);
  });

  it("a strike on ANOTHER fixture does not explain this settle's missing read-back: the drive's own fixture is the one that must have been struck", () => {
    const rec = new Recorder();
    rec.settlesPosted = 1;
    rec.bracketDrives.push(settleDrive("s2"));
    // s2 was settled and is still `decided` with no settled_ win (the product lost the method); t1, a different fixture, was struck.
    const fixtures = [settledFx("t1", "abandoned"), settledFx("s2", "decided")];
    const w = withdrawn("expunge", [{ id: "t1", status: "decided" }, { id: "s2", status: "decided" }]);
    const got = bracketDeciderExercised(rec, runWith(fixtures, w));
    expect(got).toMatchObject({ verdict: "fail" });
    expect(got.evidence).toEqual([expect.stringMatching(/posted 1 settle\(s\), the product shows 0/)]);
    // The positive pair: the same run with s2 itself struck is explained.
    const own = [settledFx("t1", "decided"), settledFx("s2", "abandoned")];
    expect(bracketDeciderExercised(rec, runWith(own, withdrawn("expunge", [{ id: "t1", status: "decided" }, { id: "s2", status: "decided" }])))).toMatchObject({ verdict: "pass" });
  });

  it("a settle the withdrawal could NOT have struck (a walkover touches only pending fixtures, and the settled one was decided) is still a missing read-back", () => {
    const rec = new Recorder();
    rec.settlesPosted = 1;
    rec.bracketDrives.push(settleDrive("f1"));
    const w = withdrawn("walkover", [{ id: "f1", status: "decided" }]);
    expect(bracketDeciderExercised(rec, runWith([settledFx("f1", "abandoned")], w))).toMatchObject({ verdict: "fail", evidence: [expect.stringMatching(/posted 1 settle\(s\), the product shows 0/)] });
  });
});

describe("LIFECYCLE on the knockout fake — every sport plays its bracket to the end THROUGH a decider", () => {
  async function life(sport: string) {
    const variant = offlineBuilderDefault(sport);
    const spec: CaseSpec = { caseId: `knockout|${sport}|${variant}|LIFECYCLE`, row: "knockout", sport, variant, scenario: "LIFECYCLE", canary: false };
    const driver = new FakeKnockoutDriver();
    const out = await SCENARIOS.LIFECYCLE.run({ driver, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] });
    const checks = [...evaluateInvariants(out.observed), ...out.assertions];
    return { driver, out, checks, state: decideState({ checks, deferred: null, error: null }).state };
  }

  it("works, with life-bracket-decider-exercised passing on a counted item; chess ends a drawn game on a tie-break rung, every other sport on an organiser settle; the bracket champion is a real entrant", async () => {
    let judged = 0;
    let deciders = 0;
    for (const sport of SPORT_KEYS) {
      const { out, checks, state } = await life(sport);
      expect(checks.filter((c) => c.verdict === "fail").map((c) => `${c.id}: ${c.reason}`), sport).toEqual([]);
      expect(state, sport).toBe("works");
      const check = checks.find((c) => c.id === "life-bracket-decider-exercised")!;
      expect(check.verdict, sport).toBe("pass");
      expect(check.checked, sport).toBeGreaterThan(0);
      const stage = out.observed.stages[0]!;
      const played = stage.fixtures.filter((f) => f.outcome?.kind === "win");
      const methods = played.map((f) => (f.outcome as { method?: string }).method ?? "");
      const prefix = sport === "boardgame" ? "tiebreak_" : "settled_";
      const hard = methods.filter((m) => m.startsWith(prefix));
      // The policy asks for the hard path on the first of every three played bracket fixtures.
      expect(hard.length, `${sport}: ${played.length} played`).toBe(Math.ceil(played.length / 3));
      expect(methods.filter((m) => m.startsWith("settled_") || m.startsWith("tiebreak_")).length, sport).toBe(hard.length);
      for (const m of hard) expect((sport === "boardgame" ? TIEBREAK_RUNGS : SETTLE_METHODS).includes(m.slice(prefix.length) as never), `${sport}: ${m}`).toBe(true);
      deciders += hard.length;
      judged++;
    }
    expect(judged).toBe(SPORT_KEYS.length);
    expect(judged).toBeGreaterThan(0);
    expect(deciders).toBeGreaterThanOrEqual(judged);
  });
});

// Phase 3 fix round 1 (M-6): Step 8 states the decider rule for EVERY bracket-row run where bracketPolicy posts settles,
// not LIFECYCLE alone. F1, M1 and R4 play their divisions through the same playDivision, so a bracket stage in any of them
// (a knockout row, or the knockout stage of a league_ko row) owes the same posted-and-read-back decider. Only
// BRACKET_EXTRA_BOARD stays out (w2a-scenarios.test.ts pins why): its extra board is the pad's, and it posts no settle.
describe("F1, M1 and R4 on a bracket row play THROUGH a decider too (M-6)", () => {
  async function play(scenario: "F1" | "M1" | "R4", sport: string) {
    const variant = offlineBuilderDefault(sport);
    const spec: CaseSpec = { caseId: `knockout|${sport}|${variant}|${scenario}`, row: "knockout", sport, variant, scenario, canary: false };
    const out = await SCENARIOS[scenario].run({ driver: new FakeKnockoutDriver(), spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] });
    return { out, checks: [...evaluateInvariants(out.observed), ...out.assertions] };
  }

  it("each scenario carries the check on every sport; it passes on a counted item, and the deciders the product shows are the ones posted", async () => {
    let judged = 0;
    for (const scenario of ["F1", "M1", "R4"] as const) {
      for (const sport of SPORT_KEYS) {
        const { out, checks } = await play(scenario, sport);
        const check = checks.find((c) => c.id === "life-bracket-decider-exercised");
        expect(check, `${scenario}/${sport}: the check is in the scenario`).toBeDefined();
        expect(check!.verdict, `${scenario}/${sport}: ${check!.reason}`).toBe("pass");
        expect(check!.checked, `${scenario}/${sport}`).toBeGreaterThan(0);
        const prefix = sport === "boardgame" ? "tiebreak_" : "settled_";
        const shown = out.observed.stages[0]!.fixtures.filter((f) => f.outcome?.kind === "win" && (f.outcome as { method?: string }).method?.startsWith(prefix) === true);
        expect(shown.length, `${scenario}/${sport}: a decider is on the product's side`).toBeGreaterThan(0);
        judged++;
      }
    }
    expect(judged).toBe(3 * SPORT_KEYS.length);
  });

  // Review I-3 (whole-branch review, false premise 50). M1's walkover takes the first bracket match of the run (bracket
  // ordinal 0), and bracketPolicy's hard path is every third ordinal from 0. The decider is owed only if a hard-path slot
  // reached a fixture the harness then decided: the slot a walkover took is consumed. On a page playoff the walkover's
  // LOSER is not seated in q2 (the product records q2 as a bye award, E2's read of the database and CI's 9 reds
  // `page_playoff_only|*|M1`), so only q1, elim and the final are ever driven - ordinals 0, 1, 2 - and the only hard-path
  // slot is the walkover's own. An earlier version of this test seated the loser (the fake did) and so found a decider at
  // the final, a root the product never produces. Every expected number below is derived from the engine's own
  // generatePagePlayoff shape and the policy's every-third rule, never typed.
  it("M1 on the smallest bracket root, page_playoff_only with 4 entrants, as the product runs it: the walkover's loser is not seated, the walkover took the only hard-path slot, so no decider is owed - named, not silent - on every sport", async () => {
    let judged = 0;
    for (const sport of SPORT_KEYS) {
      const variant = offlineBuilderDefault(sport);
      const spec: CaseSpec = { caseId: `page_playoff_only|${sport}|${variant}|M1`, row: "page_playoff_only", sport, variant, scenario: "M1", canary: false };
      const out = await SCENARIOS.M1.run({ driver: new FakeKnockoutDriver({ pagePlayoff: true }), spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] });
      const checks = [...evaluateInvariants(out.observed), ...out.assertions];
      expect(checks.filter((c) => c.verdict === "fail").map((c) => `${c.id}: ${c.reason}`), sport).toEqual([]);
      const stage = out.observed.stages[0]!;
      expect(stage.kind, sport).toBe("page_playoff");
      // The engine's shape: the walkover is the first match; the matches its loser would have been seated in are never driven.
      const shape = generatePagePlayoff({ entrants: ["e1", "e2", "e3", "e4"] }).fixtures;
      expect(stage.field, sport).toHaveLength(4);
      expect(stage.fixtures, sport).toHaveLength(shape.length);
      const walkover = shape[0]!;
      const fedByItsLoser = shape.filter((g) => [g.homeFrom, g.awayFrom].some((r) => r?.fixtureId === walkover.id && r.side === "loser"));
      expect(fedByItsLoser.length, `${sport}: the page playoff's q1 loser plays on in q2`).toBeGreaterThan(0);
      const row = (ext: string) => stage.fixtures.find((f) => f.extKey === ext)!;
      expect(row(walkover.id).status, sport).toBe("forfeited");
      for (const g of fedByItsLoser) expect(row(g.id).outcome?.kind, `${sport}: ${g.id} is awarded through, the walkover's loser never seated`).toBe("award");
      // Driven = every match but the ones awarded through; the policy asks the hard path of each third one from ordinal 0.
      const driven = shape.length - fedByItsLoser.length;
      const hardSlots = Array.from({ length: driven }, (_, o) => o).filter((o) => o % 3 === 0);
      expect(hardSlots, `${sport}: the walkover's own slot is the ONLY hard-path slot of the run`).toEqual([0]);
      const owed = hardSlots.length - 1;
      expect(owed, sport).toBe(0);
      const deciders = stage.fixtures.filter((f) => f.outcome?.kind === "win" && /^(settled|tiebreak)_/.test((f.outcome as { method?: string }).method ?? ""));
      expect(deciders, `${sport}: no decider was posted, none was owed`).toHaveLength(owed);
      const check = checks.find((c) => c.id === "life-bracket-decider-exercised")!;
      expect(check, sport).toMatchObject({ verdict: "abstain", checked: 0 });
      expect(check.reason, sport).toMatch(/not owed/);
      judged++;
    }
    expect(judged).toBe(SPORT_KEYS.length);
    expect(judged).toBeGreaterThan(0);
  });

  it("M1 on a knockout of 8 entrants: the walkover takes slot 0 and the other hard-path slots are owed, posted and read back - the check passes on counted items, on every sport", async () => {
    let judged = 0;
    for (const sport of SPORT_KEYS) {
      const { out, checks } = await play("M1", sport);
      const stage = out.observed.stages[0]!;
      // Derived: a knockout of n entrants plays n - 1 matches, the hard path is every third ordinal from 0, the walkover took ordinal 0.
      const driven = out.observed.stages[0]!.fixtures.length;
      expect(driven, sport).toBe(7);
      const owed = Array.from({ length: driven }, (_, o) => o).filter((o) => o % 3 === 0).length - 1;
      expect(owed, sport).toBe(2);
      const prefix = sport === "boardgame" ? "tiebreak_" : "settled_";
      const shown = stage.fixtures.filter((f) => f.outcome?.kind === "win" && ((f.outcome as { method?: string }).method ?? "").startsWith(prefix));
      expect(shown, `${sport}: the deciders owed are on the product's side`).toHaveLength(owed);
      const check = checks.find((c) => c.id === "life-bracket-decider-exercised")!;
      expect(check.verdict, `${sport}: ${check.reason}`).toBe("pass");
      expect(check.checked, sport).toBeGreaterThan(0);
      judged++;
    }
    expect(judged).toBe(SPORT_KEYS.length);
  });
});
