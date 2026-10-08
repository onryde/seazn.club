// W2a (controller ruling T15-R3): the harness judges every bracket match it drives against the reference family
// `bracket-finish` (@seazn/reference). The oracle's answers here are the rulebook's (X-BR-1, X-BR-2, X-ST-1, X-ST-2,
// BG-KO-1, CA-KO-1); the products are hand-built or a fake made wrong on purpose. Needs the reference lane merged
// into this one (the family's exports): red until then.
import { StageKind } from "@seazn/engine/core";
import { NoReferenceFamily } from "@seazn/reference";
import { describe, expect, it } from "vitest";
import { SPORT_KEYS } from "../lib/catalogue.ts";
import { evaluateInvariants } from "../lib/invariants.ts";
import type { ObservedFixture, ObservedOutcome, ObservedRun } from "../lib/observed.ts";
import { Recorder } from "../lib/scenarios/common.ts";
import { referenceBracketFinish } from "../lib/scenarios/assertions.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import type { CaseSpec } from "../lib/scenarios/types.ts";
import { bracketCaseOf, judgeDrive, oracleMethod, type BracketDrive } from "../lib/reference-bracket.ts";
import { resolveSportCfg } from "../lib/sport-cfg.ts";
import type { RequestedOutcome } from "../lib/streams/types.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { FakeKnockoutDriver } from "./fake-driver.ts";

const drive = (over: Partial<BracketDrive> & { asked: RequestedOutcome }): BracketDrive =>
  ({ fixtureId: "f1", stageKind: "knockout", sport: "football", home: "a", away: "b", status: "decided", outcome: null, ...over });
const win = (winner: string, method?: string): ObservedOutcome => ({ kind: "win", winner, ...(method === undefined ? {} : { method }) });

describe("oracleMethod — the product's method as the oracle names it", () => {
  it("settled_* and tiebreak_* keep their names; every play win, named or not, is `play`", () => {
    for (const m of ["settled_lot", "settled_higher_seed", "settled_organiser", "tiebreak_rapid", "tiebreak_blitz", "tiebreak_armageddon"]) expect(oracleMethod(m), m).toBe(m);
    for (const m of [undefined, "checkmate", "resign", "points", "walkover", "settled", "tiebreak"]) expect(oracleMethod(m), String(m)).toBe("play");
  });
});

describe("bracketCaseOf — the harness's drive, in the rulebook's terms", () => {
  it("each request kind maps to its play result and actions, and a walkover has no oracle vocabulary", () => {
    const of = (asked: RequestedOutcome, over: Partial<BracketDrive> = {}) => bracketCaseOf(drive({ asked, ...over }));
    expect(of({ kind: "win", winner: "away" })).toMatchObject({ play: { kind: "win", winner: "away" }, actions: [] });
    for (const kind of ["level", "draw", "tie"] as const) expect(of({ kind }), kind).toMatchObject({ play: { kind: "level" }, actions: [] });
    expect(of({ kind: "settle", then: "home", method: "lot", after: "level" })).toMatchObject({ play: { kind: "level" }, actions: [{ kind: "settle", winner: "home", method: "lot", by: "organiser" }] });
    expect(of({ kind: "settle", then: "away", method: "organiser", after: "abandon" })).toMatchObject({ play: { kind: "none" }, actions: [{ kind: "abandon" }, { kind: "settle", winner: "away", method: "organiser", by: "organiser" }] });
    expect(of({ kind: "tiebreak", rung: "blitz", winner: "home" }, { sport: "boardgame" })).toMatchObject({ play: { kind: "level" }, actions: [{ kind: "tiebreak", rung: "blitz", winner: "home" }] });
    expect(of({ kind: "abandon" })).toMatchObject({ play: { kind: "none" }, actions: [{ kind: "abandon" }] });
    expect(of({ kind: "forfeit", by: "home", reason: "walkover" })).toEqual({ notJudged: expect.stringMatching(/walkover is not one of the oracle's actions/) });
    // The stage kind and the sport go through as the drive's own.
    expect(of({ kind: "win", winner: "home" }, { stageKind: "double_elim", sport: "carrom" })).toMatchObject({ stageKind: "double_elim", sport: "carrom" });
  });
});

describe("judgeDrive — the product agrees with the oracle on every way a bracket match can finish (positive), and each field wrong on its own reds (negative)", () => {
  /** [label, the drive with the product's CORRECT answer by the rulebook]. */
  const AGREE: readonly [string, BracketDrive][] = [
    ["a play win (X-BR-1)", drive({ asked: { kind: "win", winner: "home" }, status: "decided", outcome: win("a", "points") })],
    ["a play win, the away side, no method", drive({ asked: { kind: "win", winner: "away" }, status: "decided", outcome: win("b") })],
    ["a level result is HELD (X-BR-2)", drive({ asked: { kind: "level" }, status: "needs_decision", outcome: { kind: "draw" } })],
    ["a held level result, settled by lot (X-ST-1)", drive({ asked: { kind: "settle", then: "away", method: "lot", after: "level" }, status: "decided", outcome: win("b", "settled_lot") })],
    ["an abandon at score, settled by the organiser", drive({ asked: { kind: "settle", then: "home", method: "organiser", after: "abandon" }, status: "decided", outcome: win("a", "settled_organiser") })],
    ["an abandon alone stays abandoned (X-BR-2)", drive({ asked: { kind: "abandon" }, status: "abandoned", outcome: null })],
    ["a drawn chess game decided by its tie-break (BG-KO-1)", drive({ asked: { kind: "tiebreak", rung: "armageddon", winner: "away" }, sport: "boardgame", status: "decided", outcome: win("b", "tiebreak_armageddon") })],
    ["the same level result in a ladder", drive({ asked: { kind: "level" }, stageKind: "ladder", status: "needs_decision", outcome: { kind: "tie" } })],
  ];
  it("positive: every rulebook-correct product answer agrees, counted", () => {
    let judged = 0;
    for (const [label, d] of AGREE) {
      const j = judgeDrive(d);
      expect(j, label).toMatchObject({ judged: true, ok: true });
      judged++;
    }
    expect(judged).toBe(AGREE.length);
    expect(judged).toBeGreaterThan(0);
  });

  it("negative: a deliberately wrong product reds on exactly the field that is wrong — status, who advances, the method, or an advance the oracle withholds", () => {
    const wrong: readonly [string, BracketDrive, RegExp][] = [
      ["a level result decided instead of held", drive({ asked: { kind: "level" }, status: "decided", outcome: { kind: "draw" } }), /status: oracle needs_decision, product decided/],
      ["a held match that advanced somebody", drive({ asked: { kind: "level" }, status: "needs_decision", outcome: win("a") }), /oracle says nobody advances, product advanced a/],
      ["a settle that left the match abandoned", drive({ asked: { kind: "settle", then: "home", method: "lot", after: "abandon" }, status: "abandoned", outcome: win("a", "settled_lot") }), /status: oracle decided, product abandoned/],
      ["a settle that advanced the other side", drive({ asked: { kind: "settle", then: "home", method: "lot", after: "level" }, status: "decided", outcome: win("b", "settled_lot") }), /oracle says home advances, product advanced away/],
      ["a settle recorded with a different method", drive({ asked: { kind: "settle", then: "home", method: "lot", after: "level" }, status: "decided", outcome: win("a", "settled_organiser") }), /method: oracle settled_lot, product settled_organiser/],
      ["a settle recorded as an ordinary win", drive({ asked: { kind: "settle", then: "home", method: "lot", after: "level" }, status: "decided", outcome: win("a") }), /method: oracle settled_lot, product play/],
      ["a plain win recorded as a settle", drive({ asked: { kind: "win", winner: "home" }, status: "decided", outcome: win("a", "settled_lot") }), /method: oracle play, product settled_lot/],
      ["a settled match that advanced nobody", drive({ asked: { kind: "settle", then: "home", method: "lot", after: "level" }, status: "decided", outcome: null }), /product advanced nobody/],
      ["an abandoned match that decided", drive({ asked: { kind: "abandon" }, status: "decided", outcome: win("a") }), /status: oracle abandoned, product decided/],
      ["a tie-break recorded on the wrong rung", drive({ asked: { kind: "tiebreak", rung: "rapid", winner: "home" }, sport: "boardgame", status: "decided", outcome: win("a", "tiebreak_blitz") }), /method: oracle tiebreak_rapid, product tiebreak_blitz/],
      // GN-KO-1: generic refuses a level result in a bracket, so the oracle refuses the play AND the settle after it; a
      // product that sat at "scheduled" with nobody advancing agrees on every other field — only the refusals differ.
      ["a driven sequence the rules refuse (generic level, then settle)", drive({ asked: { kind: "settle", then: "home", method: "lot", after: "level" }, sport: "generic", status: "scheduled", outcome: null }), /the oracle refuses action -1 with LEVEL_RESULT_IN_BRACKET, which the harness drove as legal/],
      ["a winner who is not in the match", drive({ asked: { kind: "win", winner: "home" }, status: "decided", outcome: win("zz") }), /a stranger \(zz\)/],
    ];
    let reds = 0;
    for (const [label, d, why] of wrong) {
      const j = judgeDrive(d);
      expect(j, label).toMatchObject({ judged: true, ok: false });
      expect(j.judged ? j.note : "", label).toMatch(why);
      reds++;
    }
    expect(reds).toBe(wrong.length);
    expect(reds).toBeGreaterThan(0);
  });

  it("not judged, named: a walkover, a driver that answered no status, and the oracle's own RuledOut; a stage kind with no family is the LOUD NoReferenceFamily", () => {
    expect(judgeDrive(drive({ asked: { kind: "forfeit", by: "home", reason: "walkover" }, status: "forfeited", outcome: win("b") }))).toEqual({ judged: false, why: expect.stringMatching(/forfeit/) });
    expect(judgeDrive(drive({ asked: { kind: "win", winner: "home" }, status: null }))).toEqual({ judged: false, why: expect.stringMatching(/no status/) });
    // CA-KO-1: a carrom bracket match never ends level; BG-KO-1: only chess records a tie-break.
    expect(judgeDrive(drive({ asked: { kind: "level" }, sport: "carrom", status: "needs_decision", outcome: { kind: "draw" } }))).toEqual({ judged: false, why: expect.stringMatching(/rules it out \(carrom-level\)/) });
    expect(judgeDrive(drive({ asked: { kind: "tiebreak", rung: "rapid", winner: "home" }, sport: "football", status: "decided", outcome: win("a", "tiebreak_rapid") }))).toEqual({ judged: false, why: expect.stringMatching(/rules it out \(tiebreak-not-chess\)/) });
    // Not a bracket kind: no family, and that is an error, not a skip.
    expect(() => judgeDrive(drive({ asked: { kind: "win", winner: "home" }, stageKind: "league" }))).toThrow(NoReferenceFamily);
  });

  it("every bracket kind has the family and answers the same way (swept over StageKind.options)", () => {
    let judged = 0;
    let noFamily = 0;
    for (const kind of StageKind.options) {
      const d = drive({ asked: { kind: "level" }, stageKind: kind, status: "needs_decision", outcome: { kind: "draw" } });
      try {
        expect(judgeDrive(d), kind).toMatchObject({ judged: true, ok: true });
        judged++;
      } catch (e) {
        expect(e, kind).toBeInstanceOf(NoReferenceFamily);
        noFamily++;
      }
    }
    expect(judged + noFamily).toBe(StageKind.options.length);
    expect(judged).toBeGreaterThan(0);
    expect(noFamily).toBeGreaterThan(0); // league, group, swiss and americano are the draw kinds: no bracket family
  });
});

describe("life-reference-bracket-finish — the counted assertion", () => {
  const run = (kind: string): ObservedRun => ({
    caseId: "c", facts: [], withdrawal: null, configEdit: null,
    stages: [{ id: "s1", seq: 1, kind, config: {}, field: ["a", "b"], fieldSource: "division", fixtures: [] as ObservedFixture[], standings: [], generates: [], pairRounds: [], complete: null }],
  });
  const recWith = (...drives: BracketDrive[]): Recorder => {
    const rec = new Recorder();
    rec.bracketDrives.push(...drives);
    return rec;
  };
  const good = drive({ asked: { kind: "win", winner: "home" }, outcome: win("a") });

  it("empty case first: no bracket stage abstains BY NAME; a bracket stage with nothing judged FAILS (R25), even with drives that were all not judged", () => {
    expect(referenceBracketFinish(new Recorder(), run("league"))).toMatchObject({ id: "life-reference-bracket-finish", verdict: "abstain", checked: 0 });
    expect(referenceBracketFinish(new Recorder(), run("knockout"))).toMatchObject({ verdict: "fail", checked: 0 });
    const walkover = drive({ asked: { kind: "forfeit", by: "home", reason: "walkover" }, status: "forfeited", outcome: win("b") });
    expect(referenceBracketFinish(recWith(walkover), run("knockout"))).toMatchObject({ verdict: "fail", checked: 0 });
  });

  it("agreement passes with the judged count; the not-judged drives are counted and named in the reason; one disagreement fails with its note", () => {
    expect(referenceBracketFinish(recWith(good, { ...good, fixtureId: "f2" }), run("knockout"))).toMatchObject({ verdict: "pass", checked: 2 });
    const walkover = drive({ asked: { kind: "forfeit", by: "home", reason: "walkover" }, status: "forfeited", outcome: win("b") });
    const mixed = referenceBracketFinish(recWith(good, walkover), run("knockout"));
    expect(mixed).toMatchObject({ verdict: "pass", checked: 1 });
    expect(mixed.reason).toMatch(/1 drive\(s\) not judged \(forfeit: a walkover/);
    const bad = referenceBracketFinish(recWith(good, drive({ fixtureId: "f9", asked: { kind: "level" }, status: "decided", outcome: { kind: "draw" } })), run("knockout"));
    expect(bad).toMatchObject({ verdict: "fail", checked: 2 });
    expect(bad.evidence[0]).toMatch(/^f9 \(knockout x football, asked level\): status: oracle needs_decision, product decided/);
  });
});

describe("LIFECYCLE on the knockout fake — the oracle agrees with every sport's bracket, and a wrong product reds the check", () => {
  async function life(sport: string, driver: FakeKnockoutDriver) {
    const variant = offlineBuilderDefault(sport);
    const spec: CaseSpec = { caseId: `knockout|${sport}|${variant}|LIFECYCLE`, row: "knockout", sport, variant, scenario: "LIFECYCLE", canary: false };
    const out = await SCENARIOS.LIFECYCLE.run({ driver, spec, orgSlug: "o", cfg: resolveSportCfg(sport, variant), tag: "t", denied: [] });
    return [...evaluateInvariants(out.observed), ...out.assertions];
  }

  it("positive: every sport's bracket is judged and agrees, with a counted item and the deciders among them", async () => {
    let sports = 0;
    let items = 0;
    for (const sport of SPORT_KEYS) {
      const check = (await life(sport, new FakeKnockoutDriver())).find((c) => c.id === "life-reference-bracket-finish")!;
      expect(check, sport).toMatchObject({ verdict: "pass" });
      expect(check.checked, sport).toBeGreaterThan(0);
      items += check.checked;
      sports++;
    }
    expect(sports).toBe(SPORT_KEYS.length);
    expect(items).toBeGreaterThanOrEqual(sports);
  });

  it("negative: a product that leaves every settled match ABANDONED reds the reference check on its status (and the positive pair above passes)", async () => {
    class SettleLeavesAbandoned extends FakeKnockoutDriver {
      override async postStream(id: string, events: Parameters<FakeKnockoutDriver["postStream"]>[1], prefix = "") {
        const out = await super.postStream(id, events, prefix);
        if (events.at(-1)?.type !== "core.settle") return out;
        const f = this.fixtures.find((x) => x.id === id)!;
        f.status = "abandoned";
        return out.map((p, i) => (i === out.length - 1 ? { ...p, status: "abandoned" } : p));
      }
    }
    const checks = await life("football", new SettleLeavesAbandoned());
    const check = checks.find((c) => c.id === "life-reference-bracket-finish")!;
    expect(check.verdict).toBe("fail");
    expect(check.evidence.join("\n")).toMatch(/status: oracle decided, product abandoned/);
  });
});
