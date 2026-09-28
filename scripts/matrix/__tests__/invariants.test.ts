import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INVARIANTS, evaluateInvariant, evaluateInvariants, type InvariantSpec } from "../lib/invariants.ts";
import type { CaseFact, ObservedFixture, ObservedOutcome, ObservedRun, ObservedStage } from "../lib/observed.ts";
import { GENERIC_ERROR_CODES, TERMINAL_STATUSES, isNamedRefusal, isTerminal, sameResult, toObservedOutcome } from "../lib/observed.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const spec = (id: string): InvariantSpec => INVARIANTS.find((s) => s.id === id)!;
const win = (w: string): ObservedOutcome => ({ kind: "win", winner: w });
let n = 0;
const fx = (p: Partial<ObservedFixture>): ObservedFixture => ({
  id: `f${++n}`, stageId: "s1", poolId: null, roundNo: 1, home: null, away: null, status: "decided", outcome: null, declared: null, ...p,
});
const stage = (p: Partial<ObservedStage>): ObservedStage => ({
  id: "s1", seq: 1, kind: "league", config: {}, field: [], fixtures: [], standings: [], generates: [], pairRounds: [], complete: null, ...p,
});
const run = (stages: ObservedStage[], p: Partial<ObservedRun> = {}): ObservedRun => ({ caseId: "t", facts: [], stages, withdrawal: null, configEdit: null, ...p });
/** Full single round robin; home always wins. */
function rr(ids: string[]): ObservedFixture[] {
  const out: ObservedFixture[] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) out.push(fx({ home: ids[i]!, away: ids[j]!, outcome: win(ids[i]!) }));
  return out;
}
const facts = (...f: CaseFact[]) => f;

it("registry: six invariants, unique ids, I1..I6 in order", () => {
  expect(INVARIANTS.map((s) => s.id)).toEqual([
    "I1-rr-pair-once-per-leg", "I2-bracket-one-champion-ranks-permutation", "I3-table-points-equal-declared",
    "I4-nothing-ends-stuck", "I5-config-edit-never-rescores", "I6-swiss-no-rematch",
  ]);
});

// R25: the guard lives in evaluateInvariant, not in any one check, so every
// present and future spec (W1b's, W10's) inherits it. Proven per spec with a
// check that claims a pass over zero items — the only way to witness the guard
// for I4, whose real check cannot return a vacuous pass (see I4's zero test).
describe("R25: the anti-vacuity guard every spec inherits", () => {
  it.each(INVARIANTS.map((s) => [s.id, s] as const))("%s: a check that passes over zero items is a fail", (_id, s) => {
    const vacuous: InvariantSpec = { ...s, check: () => ({ verdict: "pass", checked: 0, evidence: [] }) };
    const kind = s.stageKinds === "any" ? "league" : s.stageKinds[0]!;
    const r = evaluateInvariant(vacuous, run([stage({ kind, complete: { status: 200, code: null, completed: true, finalRanks: [] } })]));
    expect(r).toMatchObject({ verdict: "fail", checked: 0 });
    expect(r.evidence[0]).toMatch(/vacuous, R25/);
  });
  // M-3: "any" is not a data precondition, so an empty run has nothing to
  // abstain on — it is a zero-item check. Kind-bound specs still abstain.
  it("a run with NO stages fails every 'any'-kind spec and abstains the kind-bound ones", () => {
    const anyKind = INVARIANTS.filter((s) => s.stageKinds === "any");
    expect(anyKind.map((s) => s.id)).toEqual(["I4-nothing-ends-stuck", "I5-config-edit-never-rescores"]); // the loop below is not vacuous
    for (const s of INVARIANTS) {
      const r = evaluateInvariant(s, run([]));
      if (s.stageKinds === "any") {
        expect(r, s.id).toMatchObject({ verdict: "fail", checked: 0 });
        expect(r.evidence[0], s.id).toMatch(/no stages observed \(vacuous, R25\)/);
      } else expect(r.verdict, s.id).toBe("abstain");
    }
    // A case fact still abstains first: a deliberately cut-short run owes nothing.
    expect(evaluateInvariant(spec("I4-nothing-ends-stuck"), run([], { facts: facts("cut_short") })).verdict).toBe("abstain");
  });
});

// M-6: a config key that is present but null is ABSENT, as the product reads
// it (competition.ts applies carry_deltas/rank_overrides only when an array,
// points only when truthy). JSON cannot carry undefined, so null is the case.
describe("abstainOnStageConfig treats a null key as absent", () => {
  it("I3 checks (does not abstain) a stage whose points/carry_deltas/rank_overrides are null", () => {
    const I3 = spec("I3-table-points-equal-declared");
    expect(I3.abstainOnStageConfig.length).toBeGreaterThan(0);
    const decided = fx({ home: "a", away: "b", outcome: win("a"), declared: { home: 3, away: 0, forOutcome: win("a") } });
    for (const k of I3.abstainOnStageConfig) {
      const s = stage({ config: { [k]: null }, field: ["a", "b"], fixtures: [decided], standings: [{ poolId: null, rows: [{ entrantId: "a", rank: 1, points: 3 }, { entrantId: "b", rank: 2, points: 0 }] }] });
      expect(evaluateInvariant(I3, run([s])), k).toMatchObject({ verdict: "pass", checked: 2 });
    }
  });
});

describe("I1 rr-pair-once-per-leg", () => {
  const I1 = spec("I1-rr-pair-once-per-leg");
  it("zero-count: a league stage with an empty field fails (R25)", () => {
    expect(evaluateInvariant(I1, run([stage({})]))).toMatchObject({ verdict: "fail", checked: 0 });
  });
  it("positive: 4 entrants, 6 pairs, each once", () => {
    expect(evaluateInvariant(I1, run([stage({ field: ["a", "b", "c", "d"], fixtures: rr(["a", "b", "c", "d"]) })]))).toMatchObject({ verdict: "pass", checked: 6 });
  });
  it("negative: a missing pair and a repeated pair (sides reversed) both fail, named", () => {
    const fixtures = rr(["a", "b", "c", "d"]).filter((f) => !(f.home === "a" && f.away === "d"));
    fixtures.push(fx({ home: "c", away: "b", outcome: win("c") }));
    const r = evaluateInvariant(I1, run([stage({ field: ["a", "b", "c", "d"], fixtures })]));
    expect(r.verdict).toBe("fail");
    expect(r.evidence.join(" ")).toMatch(/a~d met 0/);
    expect(r.evidence.join(" ")).toMatch(/b~c met 2/);
    const self = evaluateInvariant(I1, run([stage({ field: ["a", "b"], fixtures: [...rr(["a", "b"]), fx({ home: "a", away: "a" })] })]));
    expect(self.evidence.join(" ")).toMatch(/self-play a/);
  });
  it("a league entrant with NO fixture is still owed every pairing — the field is the pool (PF9: checked 3, not 1)", () => {
    const r = evaluateInvariant(I1, run([stage({ field: ["a", "b", "c"], fixtures: rr(["a", "b"]) })]));
    expect(r).toMatchObject({ verdict: "fail", checked: 3 });
    expect(r.evidence.join(" ")).toMatch(/a~c met 0/);
  });
  it("a meeting that is NOT owed fails (M-1): an opponent outside a league's field", () => {
    const r = evaluateInvariant(I1, run([stage({ field: ["a", "b"], fixtures: [...rr(["a", "b"]), fx({ home: "a", away: "x", outcome: win("a") })] })]));
    expect(r.verdict).toBe("fail");
    expect(r.evidence.join(" ")).toMatch(/a~x met 1, not owed/);
  });
  it("group, no table observed (pools inferred from fixtures): owed within a pool; in no pool, in two pools, or outside the field fails", () => {
    const pooled = [fx({ poolId: "A", home: "a", away: "b", outcome: win("a") }), fx({ poolId: "B", home: "c", away: "d", outcome: win("c") })];
    expect(evaluateInvariant(I1, run([stage({ kind: "group", field: ["a", "b", "c", "d"], fixtures: pooled })]))).toMatchObject({ verdict: "pass", checked: 2 });
    const orphan = evaluateInvariant(I1, run([stage({ kind: "group", field: ["a", "b", "c", "d", "e"], fixtures: pooled })]));
    expect(orphan.verdict).toBe("fail");
    expect(orphan.evidence.join(" ")).toMatch(/e in no pool/);
    // A cross-pool fixture with a null pool forms its own pool {a,c}: every
    // count is 1, so only the two-pools check can see it.
    const nullPool = evaluateInvariant(I1, run([stage({ kind: "group", field: ["a", "b", "c", "d"], fixtures: [...pooled, fx({ poolId: null, home: "a", away: "c", outcome: win("a") })] })]));
    expect(nullPool.verdict).toBe("fail");
    expect(nullPool.evidence.join(" ")).toMatch(/a in 2 pools/);
    // The same meeting labelled with a different pool drags c into pool A.
    const relabelled = evaluateInvariant(I1, run([stage({ kind: "group", field: ["a", "b", "c", "d"], fixtures: [...pooled, fx({ poolId: "A", home: "a", away: "c", outcome: win("a") })] })]));
    expect(relabelled.evidence.join(" ")).toMatch(/c in 2 pools/);
    const outsider = evaluateInvariant(I1, run([stage({ kind: "group", field: ["a", "b", "c", "d"], fixtures: [...pooled, fx({ poolId: "A", home: "a", away: "x", outcome: win("a") })] })]));
    expect(outsider.evidence.join(" ")).toMatch(/x in pool A but not in the field/);
  });
  it("group WITH a table: the product's standings pools are the membership (M-2) — a fixtureless member is owed its pairs; a wrong partition and a cross-pool meeting fail", () => {
    const table = (pools: Record<string, string[]>) => Object.entries(pools).map(([poolId, ids]) => ({ poolId, rows: ids.map((entrantId, i) => ({ entrantId, rank: i + 1, points: 0 })) }));
    const pooled = [fx({ poolId: "A", home: "a", away: "b", outcome: win("a") }), fx({ poolId: "B", home: "c", away: "d", outcome: win("c") })];
    const grp = (field: string[], fixtures: ObservedFixture[], pools: Record<string, string[]>) => stage({ kind: "group", field, fixtures, standings: table(pools) });
    expect(evaluateInvariant(I1, run([grp(["a", "b", "c", "d"], pooled, { A: ["a", "b"], B: ["c", "d"] })]))).toMatchObject({ verdict: "pass", checked: 2 });
    // e sits in pool A's table with no fixture: owed a~e and b~e (fixture inference would only say "in no pool", checked 2).
    const fixtureless = evaluateInvariant(I1, run([grp(["a", "b", "c", "d", "e"], pooled, { A: ["a", "b", "e"], B: ["c", "d"] })]));
    expect(fixtureless).toMatchObject({ verdict: "fail", checked: 4 });
    expect(fixtureless.evidence.join(" ")).toMatch(/a~e met 0/);
    // The fixtures pair a~c and b~d (and label them consistently), the table says {a,b} {c,d}: inference alone would pass this.
    const wrong = [fx({ poolId: "A", home: "a", away: "c", outcome: win("a") }), fx({ poolId: "B", home: "b", away: "d", outcome: win("b") })];
    const w = evaluateInvariant(I1, run([grp(["a", "b", "c", "d"], wrong, { A: ["a", "b"], B: ["c", "d"] })]));
    expect(w.evidence.join(" ")).toMatch(/a~b met 0/);
    expect(w.evidence.join(" ")).toMatch(/a~c met 1, not owed/);
    // Every owed pair met once; the extra cross-pool meeting (null pool) is the only defect.
    const cross = evaluateInvariant(I1, run([grp(["a", "b", "c", "d"], [...pooled, fx({ poolId: null, home: "a", away: "c", outcome: win("a") })], { A: ["a", "b"], B: ["c", "d"] })]));
    expect(cross.verdict).toBe("fail");
    expect(cross.evidence.join(" ")).toMatch(/a~c met 1, not owed/);
  });
  it("legs: 2 legs expects every pair twice", () => {
    const f = [...rr(["a", "b"]), ...rr(["a", "b"])];
    expect(evaluateInvariant(I1, run([stage({ config: { legs: 2 }, field: ["a", "b"], fixtures: f })])).verdict).toBe("pass");
    expect(evaluateInvariant(I1, run([stage({ config: { legs: 2 }, field: ["a", "b"], fixtures: rr(["a", "b"]) })])).verdict).toBe("fail");
  });
  it("abstain: a withdrawal case, and a run with no league/group stage", () => {
    expect(evaluateInvariant(I1, run([stage({ field: ["a", "b"], fixtures: rr(["a", "b"]) })], { facts: facts("withdrawn") })).verdict).toBe("abstain");
    expect(evaluateInvariant(I1, run([stage({ kind: "knockout" })])).verdict).toBe("abstain");
  });
});

describe("I2 bracket-one-champion-ranks-permutation", () => {
  const I2 = spec("I2-bracket-one-champion-ranks-permutation");
  const bracket = (finalRanks: string[] | null, completed = true, finalWinner = "a") => stage({
    kind: "knockout", field: ["a", "b", "c", "d"],
    fixtures: [fx({ roundNo: 1, home: "a", away: "d", outcome: win("a") }), fx({ roundNo: 1, home: "b", away: "c", outcome: win("b") }), fx({ roundNo: 2, home: "a", away: "b", outcome: win(finalWinner) })],
    complete: { status: 200, code: null, completed, finalRanks },
  });
  it("zero-count: a completed bracket with no field and no ranks fails (R25)", () => {
    expect(evaluateInvariant(I2, run([stage({ kind: "knockout", complete: { status: 200, code: null, completed: true, finalRanks: [] } })]))).toMatchObject({ verdict: "fail", checked: 0 });
  });
  it("positive: ranks cover the field once and rank 1 is the only unbeaten entrant", () => {
    expect(evaluateInvariant(I2, run([bracket(["a", "b", "c", "d"])]))).toMatchObject({ verdict: "pass", checked: 5 });
  });
  it("rank 1 is judged against the bracket, not the seed order: b (field[1]) wins the final", () => {
    expect(evaluateInvariant(I2, run([bracket(["b", "a", "c", "d"], true, "b")]))).toMatchObject({ verdict: "pass", checked: 5 });
    expect(evaluateInvariant(I2, run([bracket(["a", "b", "c", "d"], true, "b")])).evidence.join(" ")).toMatch(/rank 1 is a, unbeaten is b/);
  });
  it("negative: champion mismatch, and a missing entrant", () => {
    expect(evaluateInvariant(I2, run([bracket(["b", "a", "c", "d"])])).verdict).toBe("fail");
    expect(evaluateInvariant(I2, run([bracket(["a", "b", "c"])])).evidence.join(" ")).toMatch(/d .*not ranked/);
    expect(evaluateInvariant(I2, run([bracket(["a", "b", "c", "d", "x"])])).evidence.join(" ")).toMatch(/x ranked but not in the field/);
  });
  it("negative: a final never played leaves two unbeaten; a drawn bracket fixture is named", () => {
    const unplayed = { ...bracket(["a", "b", "c", "d"]) };
    unplayed.fixtures = unplayed.fixtures.map((f) => (f.roundNo === 2 ? { ...f, status: "scheduled", outcome: null } : f));
    expect(evaluateInvariant(I2, run([unplayed])).evidence.join(" ")).toMatch(/2 unbeaten entrants: a,b/);
    const drawn = { ...bracket(["a", "b", "c", "d"]) };
    drawn.fixtures = drawn.fixtures.map((f) => (f.roundNo === 2 ? { ...f, outcome: { kind: "draw" as const } } : f));
    expect(evaluateInvariant(I2, run([drawn])).evidence.join(" ")).toMatch(/bracket fixture ended draw/);
  });
  it("abstain: stage not completed; shared place declared", () => {
    expect(evaluateInvariant(I2, run([bracket(null, false)])).verdict).toBe("abstain");
    expect(evaluateInvariant(I2, run([bracket(["a", "b", "c", "d"])], { facts: facts("shared_place_declared") })).verdict).toBe("abstain");
  });
});

describe("I3 table-points-equal-declared", () => {
  const I3 = spec("I3-table-points-equal-declared");
  const decided = fx({ home: "a", away: "b", outcome: win("a"), declared: { home: 3, away: 0, forOutcome: win("a") } });
  const withRows = (a: number | null, b: number | null) => stage({
    field: ["a", "b"], fixtures: [decided],
    standings: [{ poolId: null, rows: [{ entrantId: "a", rank: 1, points: a }, { entrantId: "b", rank: 2, points: b }] }],
  });
  it("zero-count: a league stage with no rows and no fixtures fails (R25)", () => {
    expect(evaluateInvariant(I3, run([stage({})]))).toMatchObject({ verdict: "fail", checked: 0 });
  });
  it("positive: rows equal Σ declared", () => {
    expect(evaluateInvariant(I3, run([withRows(3, 0)]))).toMatchObject({ verdict: "pass", checked: 2 });
  });
  it("reads the DECLARED points, never an assumed 3/1/0: an away win declared 1–4 (right answer differs from the default)", () => {
    const f = fx({ home: "a", away: "b", outcome: win("b"), declared: { home: 1, away: 4, forOutcome: win("b") } });
    const s = (pa: number, pb: number) => stage({ field: ["a", "b"], fixtures: [f], standings: [{ poolId: null, rows: [{ entrantId: "b", rank: 1, points: pb }, { entrantId: "a", rank: 2, points: pa }] }] });
    expect(evaluateInvariant(I3, run([s(1, 4)]))).toMatchObject({ verdict: "pass", checked: 2 });
    expect(evaluateInvariant(I3, run([s(0, 3)])).verdict).toBe("fail");
  });
  it("negative: a row off by one; a row without points; an entrant with results but no row", () => {
    expect(evaluateInvariant(I3, run([withRows(2, 0)])).verdict).toBe("fail");
    expect(evaluateInvariant(I3, run([withRows(null, 0)])).verdict).toBe("fail");
    expect(evaluateInvariant(I3, run([withRows(3, null)])).evidence.join(" ")).toMatch(/b: row has no points/); // Σ 0: null must not read as 0
    const noRow = stage({ field: ["a", "b"], fixtures: [decided], standings: [{ poolId: null, rows: [{ entrantId: "a", rank: 1, points: 3 }] }] });
    expect(evaluateInvariant(I3, run([noRow])).evidence.join(" ")).toMatch(/b has results but no row/);
  });
  // Final review I-1 corrects a frozen bug here. This test used to pin a
  // CHANGED result with no cascade recorded as "skipped (a server cascade)"
  // and read ✅. A result the harness posted and the product then stores
  // differently is a defect unless the recorded cascade explains it.
  describe("I-1: a result the harness did not post, or one stored differently, FAILS unless a bye or the recorded cascade explains it", () => {
    const table = (a: number, b: number, c: number) => [{ poolId: null, rows: [{ entrantId: "a", rank: 2, points: a }, { entrantId: "b", rank: 3, points: b }, { entrantId: "c", rank: 1, points: c }] }];
    const ca = () => fx({ home: "c", away: "a", outcome: win("c"), declared: { home: 3, away: 0, forOutcome: win("c") } });
    it("the review's shape: a 4-entrant league where one fixture was stored with the OTHER winner and the table follows it", () => {
      const flipped = fx({ id: "flip", home: "a", away: "b", outcome: win("b"), declared: { home: 3, away: 0, forOutcome: win("a") } });
      const cd = fx({ home: "c", away: "d", outcome: win("c"), declared: { home: 3, away: 0, forOutcome: win("c") } });
      const s = stage({ field: ["a", "b", "c", "d"], fixtures: [flipped, cd], standings: [{ poolId: null, rows: [
        { entrantId: "b", rank: 1, points: 3 }, { entrantId: "c", rank: 2, points: 3 }, { entrantId: "a", rank: 3, points: 0 }, { entrantId: "d", rank: 4, points: 0 },
      ] }] });
      const r = evaluateInvariant(I3, run([s]));
      expect(r).toMatchObject({ verdict: "fail", checked: 4 });
      expect(r.evidence).toEqual(["flip: stored decided win b, but the harness posted win a"]);
    });
    it("a changed result with NO withdrawal recorded fails, naming what was stored and what was posted", () => {
      const changed = fx({ id: "chg", home: "a", away: "b", status: "forfeited", outcome: { kind: "award", winner: "b" }, declared: { home: 3, away: 0, forOutcome: win("a") } });
      const r = evaluateInvariant(I3, run([stage({ field: ["a", "b", "c"], fixtures: [changed, ca()], standings: table(0, 3, 3) })]));
      expect(r).toMatchObject({ verdict: "fail", checked: 3 });
      expect(r.evidence).toEqual(["chg: stored forfeited award b, but the harness posted win a"]);
    });
    it("a two-sided result the harness never posted (the product decided it by itself) fails", () => {
      const own = fx({ id: "own", home: "a", away: "b", status: "decided", outcome: win("b"), declared: null });
      const r = evaluateInvariant(I3, run([stage({ field: ["a", "b", "c"], fixtures: [own, ca()], standings: table(0, 3, 3) })]));
      expect(r).toMatchObject({ verdict: "fail", checked: 3 });
      expect(r.evidence).toEqual(["own: decided win b that the harness never posted, and no bye or recorded cascade explains"]);
    });
    it("a walkover the RECORDED cascade wrote (pending before it, forfeited to the opponent after) is skipped and counted", () => {
      const wo = fx({ id: "wo", home: "a", away: "b", status: "forfeited", outcome: { kind: "award", winner: "b" }, declared: null });
      const w = { entrantId: "a", afterRound: 1, policy: "walkover" as const, walkovers: 1, voided: 0, skippedFinalized: 0, before: [{ id: "wo", status: "scheduled", outcome: null }] };
      const r = evaluateInvariant(I3, run([stage({ field: ["a", "b", "c"], fixtures: [wo, ca()], standings: table(0, 3, 3) })], { facts: facts("withdrawn"), withdrawal: w }));
      expect(r).toMatchObject({ verdict: "pass", checked: 1 });
      expect(r.evidence).toEqual(["skipped 2 entrant(s) whose results a bye or the recorded cascade wrote"]);
      // The cascade touches only what was PENDING: the same row finished before it is not the cascade's.
      const played = { ...w, before: [{ id: "wo", status: "decided", outcome: win("a") }] };
      expect(evaluateInvariant(I3, run([stage({ field: ["a", "b", "c"], fixtures: [wo, ca()], standings: table(0, 3, 3) })], { withdrawal: played })))
        .toMatchObject({ verdict: "fail", evidence: ["wo: forfeited award b that the harness never posted, and no bye or recorded cascade explains"] });
      // …nor a fixture of ANOTHER entrant.
      expect(evaluateInvariant(I3, run([stage({ field: ["a", "b", "c"], fixtures: [wo, ca()], standings: table(0, 3, 3) })], { withdrawal: { ...w, entrantId: "c" } })).verdict).toBe("fail");
      // …nor a forfeit under EXPUNGE: that cascade only abandons.
      expect(evaluateInvariant(I3, run([stage({ field: ["a", "b", "c"], fixtures: [wo, ca()], standings: table(0, 3, 3) })], { withdrawal: { ...w, policy: "expunge" } })).verdict).toBe("fail");
    });
    // Parked Task-5 (a), review R-a: the engine's only legitimate one-sided
    // finished shape is a forfeited AWARD to the seated side.
    it("a one-sided finished row that is not a bye fails, instead of being skipped with a note", () => {
      const sides = (over: Partial<ObservedFixture>) => {
        const one = fx({ id: "one", home: "a", away: null, declared: null, ...over });
        return evaluateInvariant(I3, run([stage({ field: ["a", "b", "c"], fixtures: [one, ca()], standings: table(0, 0, 3) })]));
      };
      expect(sides({ status: "decided", outcome: win("a") })).toMatchObject({ verdict: "fail", evidence: ["one: one-sided decided win a that the harness never posted, and no bye or recorded cascade explains"] });
      expect(sides({ status: "abandoned", outcome: null })).toMatchObject({ verdict: "fail", evidence: ["one: one-sided abandoned no outcome that the harness never posted, and no bye or recorded cascade explains"] });
      // An award to the EMPTY seat is not a bye either.
      expect(sides({ status: "forfeited", outcome: { kind: "award", winner: "z" } }).verdict).toBe("fail");
      // Nor an award row that is not forfeited.
      expect(sides({ status: "decided", outcome: { kind: "award", winner: "a" } }).verdict).toBe("fail");
      // The bye itself is the one shape that is skipped (declared by the harness in practice — snapshot's byeDeclared).
      expect(sides({ status: "forfeited", outcome: { kind: "award", winner: "a" } })).toMatchObject({ verdict: "pass", checked: 2 });
    });
    it("a walkover cascade's void of a TBD opponent (one-sided, abandoned, pending before) is the cascade's, skipped", () => {
      const tbd = fx({ id: "tbd", home: "a", away: null, status: "abandoned", outcome: { kind: "no_result" }, declared: null });
      const w = { entrantId: "a", afterRound: 1, policy: "walkover" as const, walkovers: 0, voided: 1, skippedFinalized: 0, before: [{ id: "tbd", status: "scheduled", outcome: null }] };
      expect(evaluateInvariant(I3, run([stage({ field: ["a", "b", "c"], fixtures: [tbd, ca()], standings: table(0, 0, 3) })], { withdrawal: w })))
        .toMatchObject({ verdict: "pass", checked: 2, evidence: ["skipped 1 entrant(s) whose results a bye or the recorded cascade wrote"] });
    });
  });
  it("a voided fixture (no outcome) the harness never posted contributes 0; one it DID post and the product voided with no cascade fails", () => {
    const voided = fx({ home: "a", away: "b", status: "abandoned", outcome: null, declared: null });
    const s = stage({ field: ["a", "b", "c"], fixtures: [voided, fx({ home: "c", away: "a", outcome: win("c"), declared: { home: 3, away: 0, forOutcome: win("c") } })],
      standings: [{ poolId: null, rows: [{ entrantId: "a", rank: 2, points: 0 }, { entrantId: "b", rank: 3, points: 0 }, { entrantId: "c", rank: 1, points: 3 }] }] });
    expect(evaluateInvariant(I3, run([s]))).toMatchObject({ verdict: "pass", checked: 3 });
    const stale = stage({ ...s, standings: [{ poolId: null, rows: [{ entrantId: "a", rank: 1, points: 3 }, { entrantId: "b", rank: 3, points: 0 }, { entrantId: "c", rank: 2, points: 3 }] }] });
    expect(evaluateInvariant(I3, run([stale])).evidence.join(" ")).toMatch(/a: table 3, declared Σ 0/);
    const postedThenVoided = stage({ ...s, fixtures: [{ ...voided, id: "pv", declared: { home: 3, away: 0, forOutcome: win("a") } }, s.fixtures[1]!] });
    expect(evaluateInvariant(I3, run([postedThenVoided]))).toMatchObject({ verdict: "fail", evidence: ["pv: stored abandoned no outcome, but the harness posted win a"] });
  });
  // Task 11 live run (fm-w1a-a, league|generic|score|R4): generic folds
  // core.abandon to {kind:"no_result"} (badminton to null), so an expunge
  // cascade leaves the withdrawn entrant's fixtures abandoned WITH an outcome.
  // Keying "struck" on outcome === null skipped all 8 entrants and I3 checked
  // 0. Under the expunge policy the engine reported, a struck fixture is worth
  // nothing — the live table showed the other 7 at P6 and the withdrawn one at
  // P0. Scoped to that policy and that entrant: any other abandon stays
  // unjudged (its per-sport meaning is W2's rulebook).
  describe("an expunge cascade's struck fixtures contribute 0, whatever outcome the sport folds abandon to", () => {
    const noResult: ObservedOutcome = { kind: "no_result" };
    const struckAB = fx({ home: "a", away: "b", status: "abandoned", outcome: noResult, declared: { home: 3, away: 0, forOutcome: win("a") } });
    const struckBC = fx({ home: "b", away: "c", status: "abandoned", outcome: noResult, declared: null });
    const lockedBD = fx({ home: "b", away: "d", status: "finalized", outcome: win("d"), declared: { home: 0, away: 3, forOutcome: win("d") } });
    const playedAC = fx({ home: "a", away: "c", outcome: win("a"), declared: { home: 3, away: 0, forOutcome: win("a") } });
    const table = (a: number, c: number, d: number) => [{ poolId: null, rows: [
      { entrantId: "a", rank: 1, points: a }, { entrantId: "d", rank: 2, points: d }, { entrantId: "c", rank: 3, points: c }, { entrantId: "b", rank: 4, points: 0 },
    ] }];
    const s = (a: number, c: number, d: number) => stage({ field: ["a", "b", "c", "d"], fixtures: [struckAB, struckBC, lockedBD, playedAC], standings: table(a, c, d) });
    const withdrawal = (policy: "expunge" | "walkover", entrantId = "b") => ({ entrantId, afterRound: 1, policy, walkovers: 0, voided: 2, skippedFinalized: 1, before: [] });
    const expunged = (st: ObservedStage, entrantId = "b") => run([st], { facts: facts("withdrawn", "expunged"), withdrawal: withdrawal("expunge", entrantId) });

    it("positive: every entrant is judged — the struck no_result rows count 0, the locked result still counts", () => {
      expect(evaluateInvariant(I3, expunged(s(3, 0, 3)))).toMatchObject({ verdict: "pass", checked: 4 });
    });
    it("negative: a table that still credits a struck fixture (generic no_result = shared draw points) reds", () => {
      expect(evaluateInvariant(I3, expunged(s(4, 1, 3))).evidence.join(" ")).toMatch(/a: table 4, declared Σ 3/);
    });
    it("negative: a table that drops the LOCKED result (finalized, never struck) reds", () => {
      expect(evaluateInvariant(I3, expunged(s(3, 0, 0))).evidence.join(" ")).toMatch(/d: table 0, declared Σ 3/);
    });
    // Final review I-1 corrects two frozen bugs here. Both tests used to pin
    // "skipped 3, pass": an abandon that nothing recorded explains read ✅.
    it("scoped to expunge: with no withdrawal, or under WALKOVER (which never abandons a played game), the same abandons are unexplained and FAIL", () => {
      for (const r of [run([s(3, 0, 3)]), run([s(3, 0, 3)], { facts: facts("withdrawn"), withdrawal: withdrawal("walkover") })]) {
        const out = evaluateInvariant(I3, r);
        expect(out.verdict).toBe("fail");
        expect(out.evidence.slice(0, 2)).toEqual([
          `${struckAB.id}: stored abandoned no_result, but the harness posted win a`,
          `${struckBC.id}: abandoned no_result that the harness never posted, and no bye or recorded cascade explains`,
        ]);
      }
    });
    it("scoped to the withdrawn entrant: another entrant's no_result abandon under expunge is unexplained and FAILS", () => {
      const out = evaluateInvariant(I3, expunged(s(3, 0, 3), "d"));
      expect(out.verdict).toBe("fail");
      expect(out.evidence.slice(0, 2)).toEqual([
        `${struckAB.id}: stored abandoned no_result, but the harness posted win a`,
        `${struckBC.id}: abandoned no_result that the harness never posted, and no bye or recorded cascade explains`,
      ]);
    });
    // Task 11 review Minor 1: the no-row check keyed "struck" on a null outcome.
    it("M1: the withdrawn entrant's row may be OMITTED under expunge — its struck no_result rows are worth 0, not 'results but no row'", () => {
      const omitted = stage({ field: ["a", "b", "c", "d"], fixtures: [struckAB, struckBC, playedAC], standings: [{ poolId: null, rows: [
        { entrantId: "a", rank: 1, points: 3 }, { entrantId: "d", rank: 2, points: 0 }, { entrantId: "c", rank: 3, points: 0 },
      ] }] });
      expect(evaluateInvariant(I3, expunged(omitted))).toMatchObject({ verdict: "pass", checked: 3 });
      // Its twin: a LOCKED result on the withdrawn entrant still stands, so an omitted row is a defect.
      const withLocked = stage({ ...omitted, fixtures: [...omitted.fixtures, lockedBD] });
      expect(evaluateInvariant(I3, expunged(withLocked)).evidence).toContain("b has results but no row");
    });
    // Task 11 review Minor 2: "struck" is the ABANDONED status only.
    it("M2: under expunge, a decided or forfeited fixture of the withdrawn entrant with a declared result still COUNTS — never struck", () => {
      for (const status of ["decided", "forfeited"]) {
        const kept = fx({ home: "b", away: "c", status, outcome: win("c"), declared: { home: 0, away: 3, forOutcome: win("c") } });
        const st = (c: number) => stage({ field: ["a", "b", "c", "d"], fixtures: [struckAB, kept, lockedBD, playedAC], standings: table(3, c, 3) });
        expect(evaluateInvariant(I3, expunged(st(3))), status).toMatchObject({ verdict: "pass", checked: 4 });
        expect(evaluateInvariant(I3, expunged(st(0))).evidence, status).toContain("c: table 0, declared Σ 3");
      }
    });
  });
  it("only FINISHED fixtures count: an in_play fixture carrying a provisional outcome is not a result yet", () => {
    const live = fx({ home: "a", away: "b", status: "in_play", outcome: win("a"), declared: null });
    const s = stage({ field: ["a", "b"], fixtures: [live], standings: [{ poolId: null, rows: [{ entrantId: "a", rank: 1, points: 0 }, { entrantId: "b", rank: 2, points: 0 }] }] });
    expect(evaluateInvariant(I3, run([s]))).toMatchObject({ verdict: "pass", checked: 2 });
  });
  // I-2: the engine's odd-field Swiss bye is its own row — forfeited, an award,
  // the other seat null (engine competition/stage.ts TableFixture.awardDelta) —
  // and the fold credits it as a win. The harness did not post it, so it is a
  // server-written result: the recipient is skipped and counted, never judged
  // against a Σ that omits the bye.
  it("an odd-field Swiss bye row (forfeited award, other seat null) reaches the skip — no false red on the bye credit", () => {
    const bye = fx({ home: "c", away: null, status: "forfeited", outcome: { kind: "award", winner: "c" }, declared: null });
    const table = (c: number) => [{ poolId: null, rows: [{ entrantId: "a", rank: 1, points: 3 }, { entrantId: "c", rank: 2, points: c }, { entrantId: "b", rank: 3, points: 0 }] }];
    const r = evaluateInvariant(I3, run([stage({ kind: "swiss", field: ["a", "b", "c"], fixtures: [decided, bye], standings: table(3) })]));
    expect(r).toMatchObject({ verdict: "pass", checked: 2 });
    expect(r.evidence.join(" ")).toMatch(/skipped 1/);
    // If the harness DOES declare the bye's award, the recipient is judged against it.
    const declaredBye = { ...bye, declared: { home: 3, away: 0, forOutcome: { kind: "award" as const, winner: "c" } } };
    expect(evaluateInvariant(I3, run([stage({ kind: "swiss", field: ["a", "b", "c"], fixtures: [decided, declaredBye], standings: table(3) })]))).toMatchObject({ verdict: "pass", checked: 3 });
    expect(evaluateInvariant(I3, run([stage({ kind: "swiss", field: ["a", "b", "c"], fixtures: [decided, declaredBye], standings: table(0) })])).evidence.join(" ")).toMatch(/c: table 0, declared Σ 3/);
  });
  it("abstain: a stage with its own points rule", () => {
    expect(evaluateInvariant(I3, run([stage({ ...withRows(3, 0), config: { points: { base: { win: 2, draw: 1, loss: 0 } } } })])).verdict).toBe("abstain");
  });
});

describe("I4 nothing-ends-stuck", () => {
  const I4 = spec("I4-nothing-ends-stuck");
  const done = { status: 200, code: null, completed: true, finalRanks: null };
  it("zero-count: a stage nobody generated, paired or completed fails (on its own evidence — I4 cannot return a vacuous pass; the guard is witnessed above)", () => {
    const r = evaluateInvariant(I4, run([stage({})]));
    expect(r).toMatchObject({ verdict: "fail", checked: 0 });
    expect(r.evidence.join(" ")).toMatch(/never asked to complete/);
  });
  it("positive: generate returned fixtures, pair rounds seated, stage completed, all terminal", () => {
    const s = stage({ generates: [{ status: 201, code: null, total: 1, created: 1 }], pairRounds: [{ roundNo: 1, seated: 1 }], fixtures: [fx({ home: "a", away: "b", outcome: win("a") })], complete: done });
    expect(evaluateInvariant(I4, run([s]))).toMatchObject({ verdict: "pass", checked: 4 });
  });
  it("negative: an empty 2xx generate; an empty pair round; completed:false; a live fixture in a completed stage", () => {
    const base = { generates: [{ status: 201, code: null, total: 1, created: 1 }], complete: done };
    expect(evaluateInvariant(I4, run([stage({ ...base, generates: [{ status: 200, code: null, total: 0, created: 0 }] })])).evidence.join(" ")).toMatch(/empty generate/);
    expect(evaluateInvariant(I4, run([stage({ ...base, pairRounds: [{ roundNo: 2, seated: 0 }] })])).verdict).toBe("fail");
    expect(evaluateInvariant(I4, run([stage({ ...base, complete: { ...done, completed: false } })])).verdict).toBe("fail");
    // A code on a 2xx is not a refusal: "not completed" without a 4xx is stuck, named or not.
    expect(evaluateInvariant(I4, run([stage({ ...base, complete: { ...done, code: "STAGE_NOT_READY", completed: false } })])).verdict).toBe("fail");
    expect(evaluateInvariant(I4, run([stage({ ...base, fixtures: [fx({ home: "a", away: "b", status: "scheduled" })] })])).verdict).toBe("fail");
  });
  it("a refused generate or complete with a NAMED code passes; an unnamed refusal fails", () => {
    const named = stage({ generates: [{ status: 422, code: "STAGE_NOT_READY", total: 0, created: 0 }], complete: { status: 409, code: "STAGE_COMPLETED_SEEDING_FAILED", completed: false, finalRanks: null } });
    expect(evaluateInvariant(I4, run([named])).verdict).toBe("pass");
    const unnamed = stage({ generates: [{ status: 500, code: null, total: 0, created: 0 }], complete: done });
    expect(evaluateInvariant(I4, run([unnamed])).verdict).toBe("fail");
    const locked = stage({ generates: [{ status: 409, code: "FORMAT_LOCKED", total: 0, created: 0 }], complete: { status: 409, code: "FORMAT_LOCKED", completed: false, finalRanks: null } });
    expect(evaluateInvariant(I4, run([locked])).verdict).toBe("pass");
  });
  // I-1: api-v1 puts a code on EVERY error (http.ts statusCode(), and 500
  // "INTERNAL" for any unhandled throw), so "has a code" is not "named".
  it("a crash is never a named refusal: any 5xx fails whatever its code — the real shapes 500 INTERNAL and 500 MODULE_DUPLICATE", () => {
    const gen = { status: 201, code: null, total: 1, created: 1 };
    for (const code of ["INTERNAL", "MODULE_DUPLICATE"]) {
      // MODULE_DUPLICATE is a domain code the product maps to 500: only the 5xx rule can fail it.
      expect(evaluateInvariant(I4, run([stage({ generates: [gen], complete: { status: 500, code, completed: false, finalRanks: null } })])).verdict, `complete ${code}`).toBe("fail");
      expect(evaluateInvariant(I4, run([stage({ generates: [{ status: 500, code, total: 0, created: 0 }], complete: done })])).verdict, `generate ${code}`).toBe("fail");
    }
  });
  it("a generic statusCode() code is not a named reason: 404 NOT_FOUND, 409 CONFLICT, 400 VALIDATION fail", () => {
    const gen = { status: 201, code: null, total: 1, created: 1 };
    // [404, null]: a 4xx with no code at all (a body outside the api-v1 envelope, e.g. a framework 404 page).
    for (const [status, code] of [[404, "NOT_FOUND"], [409, "CONFLICT"], [400, "VALIDATION"], [404, null]] as const) {
      expect(evaluateInvariant(I4, run([stage({ generates: [gen], complete: { status, code, completed: false, finalRanks: null } })])).verdict, `complete ${code}`).toBe("fail");
      expect(evaluateInvariant(I4, run([stage({ generates: [{ status, code, total: 0, created: 0 }], complete: done })])).verdict, `generate ${code}`).toBe("fail");
    }
  });
  it("GENERIC_ERROR_CODES is exactly what api-v1's statusCode() emits (derived from http.ts, not typed)", () => {
    const src = readFileSync(resolve(REPO, "apps/web/src/server/api-v1/http.ts"), "utf8");
    const fns = [...src.matchAll(/\nfunction statusCode\(status: number\): string \{\n([\s\S]*?)\n\}\n/g)];
    expect(fns).toHaveLength(1);
    const body = fns[0]![1]!;
    const codes = [...body.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]!);
    expect(codes).toHaveLength((body.split('"').length - 1) / 2); // a literal the regex cannot read is not silently dropped
    expect(codes).toContain("INTERNAL");
    expect([...GENERIC_ERROR_CODES].sort()).toEqual([...new Set(codes)].sort());
    for (const c of codes) expect(isNamedRefusal(422, c), c).toBe(false);
    expect(isNamedRefusal(422, "STAGE_NOT_READY")).toBe(true);
  });
  it("abstain: a case deliberately cut short", () => {
    expect(evaluateInvariant(I4, run([stage({})], { facts: facts("cut_short") })).verdict).toBe("abstain");
  });
});

describe("I5 config-edit-never-rescores", () => {
  const I5 = spec("I5-config-edit-never-rescores");
  const before = [{ id: "f1", status: "decided", outcome: win("a") }];
  const edit = (after: typeof before) => ({ attempts: [{ kind: "format" as const, status: 409, code: "FORMAT_LOCKED" }], before, after });
  it("zero-count: an edit attempted with no finished fixture before it fails (R25)", () => {
    expect(evaluateInvariant(I5, run([stage({})], { configEdit: { attempts: [{ kind: "format", status: 409, code: "FORMAT_LOCKED" }], before: [], after: [] } }))).toMatchObject({ verdict: "fail", checked: 0 });
  });
  it("positive: the finished fixture is unchanged after the edit", () => {
    expect(evaluateInvariant(I5, run([stage({})], { configEdit: edit(before) }))).toMatchObject({ verdict: "pass", checked: 1 });
  });
  it("negative: the winner changed; the fixture vanished; only the status changed", () => {
    expect(evaluateInvariant(I5, run([stage({})], { configEdit: edit([{ id: "f1", status: "decided", outcome: win("b") }]) })).verdict).toBe("fail");
    expect(evaluateInvariant(I5, run([stage({})], { configEdit: edit([]) })).verdict).toBe("fail");
    expect(evaluateInvariant(I5, run([stage({})], { configEdit: edit([{ id: "f1", status: "abandoned", outcome: win("a") }]) })).verdict).toBe("fail");
  });
  it("abstain: no config edit was attempted (no record, or a record with zero attempts)", () => {
    expect(evaluateInvariant(I5, run([stage({})])).verdict).toBe("abstain");
    expect(evaluateInvariant(I5, run([stage({})], { configEdit: { attempts: [], before, after: before } })).verdict).toBe("abstain");
  });
});

describe("I6 swiss-no-rematch", () => {
  const I6 = spec("I6-swiss-no-rematch");
  const sw = (fixtures: ObservedFixture[]) => stage({ kind: "swiss", field: ["a", "b", "c", "d"], fixtures });
  it("zero-count: a swiss stage with no seated pair fails (R25)", () => {
    expect(evaluateInvariant(I6, run([sw([fx({ home: "a", away: null, roundNo: 1 })])]))).toMatchObject({ verdict: "fail", checked: 0 });
  });
  it("positive: four distinct pairings", () => {
    const f = [fx({ home: "a", away: "b" }), fx({ home: "c", away: "d" }), fx({ roundNo: 2, home: "a", away: "c" }), fx({ roundNo: 2, home: "b", away: "d" })];
    expect(evaluateInvariant(I6, run([sw(f)]))).toMatchObject({ verdict: "pass", checked: 4 });
  });
  it("negative: a rematch with sides reversed is still a rematch", () => {
    const f = [fx({ home: "a", away: "b" }), fx({ roundNo: 2, home: "b", away: "a" })];
    expect(evaluateInvariant(I6, run([sw(f)])).evidence.join(" ")).toMatch(/a~b/);
  });
  it("negative (M-4): an entrant paired with itself fails", () => {
    const r = evaluateInvariant(I6, run([sw([fx({ home: "a", away: "b" }), fx({ roundNo: 2, home: "c", away: "c" })])]));
    expect(r.verdict).toBe("fail");
    expect(r.evidence.join(" ")).toMatch(/c paired with itself/);
  });
  it("abstain: no swiss stage", () => {
    expect(evaluateInvariant(I6, run([stage({})])).verdict).toBe("abstain");
  });
});

describe("evaluateInvariants + observed helpers", () => {
  it("emits one invariant CheckResult per spec, carrying verdict, checked and reason", () => {
    // Harness-posted (declared) results, so I3's first reason is the missing row — not an unposted result (final review I-1).
    const posted = rr(["a", "b"]).map((f) => ({ ...f, declared: { home: 3, away: 0, forOutcome: f.outcome! } }));
    const out = evaluateInvariants(run([stage({ field: ["a", "b"], fixtures: posted })]));
    expect(out.map((c) => c.id)).toEqual(INVARIANTS.map((s) => s.id));
    expect(out.every((c) => c.kind === "invariant" && Number.isInteger(c.checked))).toBe(true);
    expect(out.map((c) => [c.verdict, c.checked])).toEqual([["pass", 1], ["abstain", 0], ["fail", 0], ["fail", 0], ["abstain", 0], ["abstain", 0]]);
    expect(out[0]!.reason).toBe(INVARIANTS[0]!.description);
    expect(out[2]!.reason).toMatch(/has results but no row/);
  });
  it("TERMINAL_STATUSES partitions the product's fixture-status enum (derived, not typed): every status is terminal or live", () => {
    const src = readFileSync(resolve(REPO, "apps/web/src/server/api-v1/schemas.ts"), "utf8");
    const enums = [...src.matchAll(/status: z\.enum\(\[([^\]]*"forfeited"[^\]]*)\]\)/g)];
    expect(enums).toHaveLength(1);
    const body = enums[0]![1]!;
    const product = [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(product).toHaveLength(body.split(",").length); // an entry the regex cannot read is not silently dropped
    const LIVE = ["scheduled", "in_play"];
    expect(LIVE.every((s) => product.includes(s))).toBe(true);
    expect([...TERMINAL_STATUSES].sort()).toEqual(product.filter((s) => !LIVE.includes(s)).sort());
    for (const s of product) expect(isTerminal(s), s).toBe(!LIVE.includes(s));
  });
  it("sameResult: status, kind and winner must all match; the method does not", () => {
    const a = { status: "decided", outcome: { kind: "win" as const, winner: "a", method: "regulation" } };
    expect(sameResult(a, { status: "decided", outcome: win("a") })).toBe(true);
    expect(sameResult(a, { status: "forfeited", outcome: win("a") })).toBe(false);
    expect(sameResult(a, { status: "decided", outcome: win("b") })).toBe(false);
    expect(sameResult(a, { status: "decided", outcome: { kind: "award", winner: "a" } })).toBe(false);
    expect(sameResult({ status: "abandoned", outcome: null }, { status: "abandoned", outcome: null })).toBe(true);
  });
  it("toObservedOutcome: junk → null; win/award keep winner; draw/tie/no_result keep kind", () => {
    expect(toObservedOutcome(null)).toBeNull();
    expect(toObservedOutcome({ kind: "win" })).toBeNull();
    expect(toObservedOutcome({ kind: "win", winner: "a", loser: "b" })).toEqual({ kind: "win", winner: "a" });
    expect(toObservedOutcome({ kind: "award", winner: "a", method: "walkover" })).toEqual({ kind: "award", winner: "a", method: "walkover" });
    expect(toObservedOutcome({ kind: "tie" })).toEqual({ kind: "tie" });
  });
});
