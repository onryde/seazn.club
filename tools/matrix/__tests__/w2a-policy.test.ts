// W2a Task 14 Step 4: the bracket policy and the counted check (finding 16). Expected values come from the engine's own
// declarations (SETTLE_METHODS, TIEBREAK_RUNGS, StageKind.options, supportsDraws) and the rule rows (BG-KO-1, GN-KO-1,
// X-ST-1), never from the policy's own text. Needs loop D's exports — red until D merges into the lane.
import { SETTLE_METHODS, StageKind, forbidsLevelResult } from "@seazn/engine/core";
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
