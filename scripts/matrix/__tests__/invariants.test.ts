import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INVARIANTS, evaluateInvariant, evaluateInvariants, type InvariantSpec } from "../lib/invariants.ts";
import type { CaseFact, ObservedFixture, ObservedOutcome, ObservedRun, ObservedStage } from "../lib/observed.ts";
import { TERMINAL_STATUSES, isTerminal, sameResult, toObservedOutcome } from "../lib/observed.ts";

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
  it("group: pairs are owed within a pool, never across; a field entrant in no pool fails", () => {
    const pooled = [fx({ poolId: "A", home: "a", away: "b", outcome: win("a") }), fx({ poolId: "B", home: "c", away: "d", outcome: win("c") })];
    expect(evaluateInvariant(I1, run([stage({ kind: "group", field: ["a", "b", "c", "d"], fixtures: pooled })]))).toMatchObject({ verdict: "pass", checked: 2 });
    const orphan = evaluateInvariant(I1, run([stage({ kind: "group", field: ["a", "b", "c", "d", "e"], fixtures: pooled })]));
    expect(orphan.verdict).toBe("fail");
    expect(orphan.evidence.join(" ")).toMatch(/e in no pool/);
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
  it("skips an entrant whose result changed after the harness declared it (a server cascade), counting the skip", () => {
    const changed = fx({ home: "a", away: "b", status: "forfeited", outcome: { kind: "award", winner: "b" }, declared: { home: 3, away: 0, forOutcome: win("a") } });
    const s = stage({ field: ["a", "b", "c"], fixtures: [changed, fx({ home: "c", away: "a", outcome: win("c"), declared: { home: 3, away: 0, forOutcome: win("c") } })],
      standings: [{ poolId: null, rows: [{ entrantId: "a", rank: 2, points: 0 }, { entrantId: "b", rank: 3, points: 3 }, { entrantId: "c", rank: 1, points: 3 }] }] });
    const r = evaluateInvariant(I3, run([s]));
    expect(r).toMatchObject({ verdict: "pass", checked: 1 });
    expect(r.evidence.join(" ")).toMatch(/skipped 2/);
  });
  it("a voided fixture (no outcome) contributes 0 — expunged results are checked, not skipped", () => {
    const voided = fx({ home: "a", away: "b", status: "abandoned", outcome: null, declared: { home: 3, away: 0, forOutcome: win("a") } });
    const s = stage({ field: ["a", "b", "c"], fixtures: [voided, fx({ home: "c", away: "a", outcome: win("c"), declared: { home: 3, away: 0, forOutcome: win("c") } })],
      standings: [{ poolId: null, rows: [{ entrantId: "a", rank: 2, points: 0 }, { entrantId: "b", rank: 3, points: 0 }, { entrantId: "c", rank: 1, points: 3 }] }] });
    expect(evaluateInvariant(I3, run([s]))).toMatchObject({ verdict: "pass", checked: 3 });
    const stale = stage({ ...s, standings: [{ poolId: null, rows: [{ entrantId: "a", rank: 1, points: 3 }, { entrantId: "b", rank: 3, points: 0 }, { entrantId: "c", rank: 2, points: 3 }] }] });
    expect(evaluateInvariant(I3, run([stale])).evidence.join(" ")).toMatch(/a: table 3, declared Σ 0/);
  });
  it("only FINISHED fixtures count: an in_play fixture carrying a provisional outcome is not a result yet", () => {
    const live = fx({ home: "a", away: "b", status: "in_play", outcome: win("a"), declared: null });
    const s = stage({ field: ["a", "b"], fixtures: [live], standings: [{ poolId: null, rows: [{ entrantId: "a", rank: 1, points: 0 }, { entrantId: "b", rank: 2, points: 0 }] }] });
    expect(evaluateInvariant(I3, run([s]))).toMatchObject({ verdict: "pass", checked: 2 });
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
  it("abstain: no swiss stage", () => {
    expect(evaluateInvariant(I6, run([stage({})])).verdict).toBe("abstain");
  });
});

describe("evaluateInvariants + observed helpers", () => {
  it("emits one invariant CheckResult per spec, carrying verdict, checked and reason", () => {
    const out = evaluateInvariants(run([stage({ field: ["a", "b"], fixtures: rr(["a", "b"]) })]));
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
