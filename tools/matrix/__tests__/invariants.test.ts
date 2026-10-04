import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateDoubleElim, generatePagePlayoff, generateStepladder } from "@seazn/engine/scheduling";
import { ENGINE_HTTP_STATUS } from "../lib/driver/engine-http.ts";
import { SEEDING_FAILED_AFTER_COMMIT } from "../lib/driver/types.ts";
import { INVARIANTS, STEP_INVARIANTS, evaluateInvariant, evaluateInvariants, evaluateStepInvariants, type InvariantSpec } from "../lib/invariants.ts";
import type { CaseFact, CompleteObs, ObservedFixture, ObservedOutcome, ObservedRun, ObservedStage, WithdrawalObs } from "../lib/observed.ts";
import { BRACKET_KINDS, BRACKET_OF, STRUCTURAL_FINAL_KINDS, terminalFinalKeys } from "../lib/scenarios/terminal-finals.ts";
import { structuralBracketFrom, structuralBracketText } from "./product-text.ts";
import { GENERIC_ERROR_CODES, TERMINAL_STATUSES, isNamedRefusal, isTerminal, sameResult, toObservedOutcome } from "../lib/observed.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const spec = (id: string): InvariantSpec => INVARIANTS.find((s) => s.id === id)!;
const win = (w: string): ObservedOutcome => ({ kind: "win", winner: w });
let n = 0;
const fx = (p: Partial<ObservedFixture>): ObservedFixture => ({
  id: `f${++n}`, stageId: "s1", poolId: null, roundNo: 1, home: null, away: null, status: "decided", outcome: null, declared: null, ...p,
});
const stage = (p: Partial<ObservedStage>): ObservedStage => ({
  id: "s1", seq: 1, kind: "league", config: {}, field: [], fieldSource: "division", fixtures: [], standings: [], generates: [], pairRounds: [], complete: null, ...p,
});
const run = (stages: ObservedStage[], p: Partial<ObservedRun> = {}): ObservedRun => ({ caseId: "t", facts: [], stages, withdrawal: null, configEdit: null, ...p });
/** Full single round robin; home always wins. */
function rr(ids: string[]): ObservedFixture[] {
  const out: ObservedFixture[] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) out.push(fx({ home: ids[i]!, away: ids[j]!, outcome: win(ids[i]!) }));
  return out;
}
const facts = (...f: CaseFact[]) => f;

it("registry: ten invariants in id order (W1-driving Task 9 appends I9 and I10)", () => {
  expect(INVARIANTS.map((s) => s.id)).toEqual([
    "I1-rr-pair-once-per-leg", "I2-bracket-one-champion-ranks-permutation", "I3-table-points-equal-declared", "I4-nothing-ends-stuck",
    "I5-config-edit-never-rescores", "I6-swiss-no-rematch", "I7-rr-no-pair-over-legs", "I8-generate-named",
    "I9-ladder-order-is-the-field", "I10-americano-seats-each-person-once",
  ]);
});
it("'any'-kind invariants are I4, I5 and I8", () => {
  expect(INVARIANTS.filter((s) => s.stageKinds === "any").map((s) => s.id)).toEqual(["I4-nothing-ends-stuck", "I5-config-edit-never-rescores", "I8-generate-named"]);
});
it("the step-safe subset is exactly I6, I7, I8 — the ones that hold after EVERY organiser step", () => {
  expect(STEP_INVARIANTS.map((s) => s.id)).toEqual(["I6-swiss-no-rematch", "I7-rr-no-pair-over-legs", "I8-generate-named"]);
  expect(STEP_INVARIANTS.length).toBeGreaterThan(0);
  // Every spec DECLARES its step-safety (a boolean, never absent), and the
  // subset is the registry filtered in registry order — never re-sorted.
  expect(INVARIANTS.every((s) => typeof s.stepSafe === "boolean")).toBe(true);
  expect(STEP_INVARIANTS).toEqual(INVARIANTS.filter((s) => s.stepSafe));
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
    expect(anyKind.map((s) => s.id)).toEqual(["I4-nothing-ends-stuck", "I5-config-edit-never-rescores", "I8-generate-named"]); // the loop below is not vacuous
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
  // W1a carry 1, review M-2: I2 reads s.field too. This later bracket is a
  // correct bracket over its field, so without the guard it would PASS — judged
  // against the division's entrants instead of the ones seeded into it.
  it("a later-stage bracket (seq 2) with a division-wide field FAILS by name; seeded is judged; the root is still judged beside it", () => {
    const carry1 = "stage seq 2: field is division-wide — per-stage entrants were not observed";
    const later = (fieldSource: "division" | "seeded"): ObservedStage => ({ ...bracket(["a", "b", "c", "d"]), id: "s2", seq: 2, fieldSource });
    expect(evaluateInvariant(I2, run([later("division")]))).toMatchObject({ verdict: "fail", checked: 0, evidence: [carry1] });
    expect(evaluateInvariant(I2, run([later("seeded")]))).toMatchObject({ verdict: "pass", checked: 5 });
    expect(evaluateInvariant(I2, run([bracket(["a", "b", "c", "d"]), later("division")]))).toMatchObject({ verdict: "fail", checked: 5, evidence: [carry1] });
  });
});

// W1-driving Task 9, owner ruling 45: on double elim, stepladder and page
// playoff I2 is STRUCTURAL — finalRanks is a permutation of the field and its
// rank 1 is the winner of the TERMINAL final (the engine's own isFinal
// fixture). No rank order beyond rank 1 is asserted, and "one unbeaten
// entrant" stays knockout-only. The keys are an engine-derived expectation the
// snapshot carries (ObservedStage.terminalFinals); the invariant layer stays
// type-only (boundary PF7).
describe("I2 structural (W1-driving Task 9, ruling 45)", () => {
  const I2 = spec("I2-bracket-one-champion-ranks-permutation");
  const kinds = ["page_playoff", "stepladder", "double_elim"] as const;
  const F = ["a", "b", "c", "d"];
  const done = (finalRanks: string[] | null): CompleteObs => ({ status: 200, code: null, completed: true, finalRanks, seedProposal: null });
  const finalsOf = (fx: readonly { id: string; isFinal?: boolean }[]) => fx.filter((x) => x.isFinal === true).map((x) => x.id);
  it("the structural kinds are exactly I2's kinds less knockout — the snapshot and I2 cannot disagree on which stages carry terminal keys", () => {
    expect(I2.stageKinds).not.toBe("any");
    const bracketKinds = (I2.stageKinds as readonly string[]).filter((k) => k !== "knockout");
    expect(bracketKinds).toHaveLength(3);
    expect([...STRUCTURAL_FINAL_KINDS].sort()).toEqual([...bracketKinds].sort());
    expect([...kinds].sort()).toEqual([...STRUCTURAL_FINAL_KINDS].sort());
  });
  it("final review m-3: I2's stage kinds are terminal-finals.ts's bracket table — every kind it lays out, none other, and the structural kinds a subset of it", () => {
    expect(BRACKET_KINDS.length, "the bracket table is empty — the binding would be vacuous").toBeGreaterThan(0);
    expect(BRACKET_KINDS).toEqual(Object.keys(BRACKET_OF));
    expect(I2.stageKinds).not.toBe("any");
    expect([...(I2.stageKinds as readonly string[])].sort()).toEqual([...BRACKET_KINDS].sort());
    for (const k of STRUCTURAL_FINAL_KINDS) expect(BRACKET_KINDS, k).toContain(k);
    console.info(`m-3: I2 judges the ${BRACKET_KINDS.length} bracket kinds of terminal-finals.ts`);
  });
  it("terminal keys come from the engine's generators, not a table — and they move with the field's size and the reset flag", () => {
    expect(terminalFinalKeys("page_playoff", F, {})).toEqual(finalsOf(generatePagePlayoff({ entrants: F }).fixtures));
    expect(terminalFinalKeys("stepladder", F, {})).toEqual(finalsOf(generateStepladder({ entrants: F }).fixtures));
    expect(terminalFinalKeys("double_elim", F, { bracketReset: true })).toEqual(finalsOf(generateDoubleElim({ entrants: F, bracketReset: true }).fixtures));
    expect(terminalFinalKeys("double_elim", F, {})).toEqual(finalsOf(generateDoubleElim({ entrants: F }).fixtures));
    // The differing cases: a reset adds a terminal key; a stepladder's last game moves with the field.
    expect(terminalFinalKeys("double_elim", F, { bracketReset: true }).length).toBe(terminalFinalKeys("double_elim", F, {}).length + 1);
    expect(terminalFinalKeys("stepladder", F.slice(0, 3), {})).not.toEqual(terminalFinalKeys("stepladder", F, {}));
    // A page playoff of anything but 4 is refused by the engine, as the product's Start refuses it.
    expect(() => terminalFinalKeys("page_playoff", F.slice(0, 3), {})).toThrow();
    expect(() => terminalFinalKeys("knockout", F, {})).toThrow(/'knockout' has no structural final/);
  });
  it("m-1: the product facts the keys rest on are pinned as text — ext_key IS the engine fixture id, each structural kind is laid out by its engine generator, and the reset key the product reads is the one terminalFinalKeys honours", () => {
    const pin = structuralBracketText();
    expect([...pin.kinds].sort()).toEqual([...STRUCTURAL_FINAL_KINDS].sort());
    expect(terminalFinalKeys("double_elim", F, { [pin.resetKey]: true })).toEqual(finalsOf(generateDoubleElim({ entrants: F, bracketReset: true }).fixtures));
    expect(terminalFinalKeys("double_elim", F, { [`${pin.resetKey}X`]: true })).toEqual(finalsOf(generateDoubleElim({ entrants: F }).fixtures)); // any other key: no reset
    // The pin's own guards, each reached: a product that stopped storing the engine id, or stopped reading the reset.
    const src = readFileSync(resolve(REPO, "apps/web/src/server/usecases/stages.ts"), "utf8");
    expect(src).toContain("extKey: f.id,");
    expect(() => structuralBracketFrom(src.replace("extKey: f.id,", "extKey: `k-${f.id}`,"))).toThrow(/no longer stores the engine fixture id as ext_key/);
    expect(() => structuralBracketFrom(src.replace(/, bracketReset: cfg\.\w+ === true/, ""))).toThrow(/no longer reads double elim's bracket reset/);
    expect(() => structuralBracketFrom(src.replace("generateStepladder({ entrants: ids, seeds })", "generateSingleElim({ entrants: ids, seeds })"))).toThrow(/no longer lays out stepladder with generateStepladder/);
  });
  /** A completed bracket of `kind` over F whose terminal final (by the
   *  ENGINE's key) is won by `champ`; the other row is a filler decided
   *  fixture. The expected champion is the one the test sets on that row. */
  const bracketOf = (kind: (typeof kinds)[number], champ: string, finalRanks: string[], cfg: Record<string, unknown> = {}) => {
    const keys = terminalFinalKeys(kind, F, cfg);
    const last = keys.at(-1)!;
    return stage({
      kind, field: F, config: cfg, terminalFinals: keys,
      fixtures: [
        fx({ roundNo: 1, home: "a", away: "b", outcome: win("b"), extKey: "r1" }),
        fx({ roundNo: 9, home: champ, away: F.find((x) => x !== champ)!, outcome: win(champ), extKey: last, isFinal: true }),
      ],
      complete: done(finalRanks),
    });
  };
  it("empty cases first: a structural stage with no fixtures, and one whose terminal final is seated but undecided, each fail naming the keys; checked counts the field and the champion item", () => {
    for (const kind of kinds) {
      const keys = terminalFinalKeys(kind, F, {});
      const named = `no decided fixture carries a terminal final key (${keys.join(" / ")})`;
      const bare = stage({ kind, field: F, terminalFinals: keys, complete: done(["c", "a", "b", "d"]) });
      expect(evaluateInvariant(I2, run([bare])), kind).toMatchObject({ verdict: "fail", checked: F.length + 1, evidence: [named] });
      const s = bracketOf(kind, "c", ["c", "a", "b", "d"]);
      const undecided = { ...s, fixtures: s.fixtures.map((f) => (f.extKey === keys.at(-1) ? { ...f, status: "scheduled", outcome: null } : f)) };
      expect(evaluateInvariant(I2, run([undecided])).evidence, kind).toEqual([named]);
    }
  });
  it.each(kinds)("%s: rank 1 is the winner of the terminal final — passes", (kind) => {
    expect(evaluateInvariant(I2, run([bracketOf(kind, "c", ["c", "a", "b", "d"])]))).toMatchObject({ verdict: "pass", checked: F.length + 1 });
  });
  it.each(kinds)("%s: rank 1 is not the terminal final's winner — fails by name", (kind) => {
    const r = evaluateInvariant(I2, run([bracketOf(kind, "c", ["a", "c", "b", "d"])]));
    expect(r.verdict).toBe("fail");
    expect(r.evidence.join(" ")).toMatch(new RegExp(`rank 1 is a, the ${terminalFinalKeys(kind, F, {}).at(-1)} winner is c`));
  });
  it.each(kinds)("%s: a permutation is still owed — a missing entrant and an outsider each fail; no order beyond rank 1 is asserted", (kind) => {
    expect(evaluateInvariant(I2, run([bracketOf(kind, "c", ["c", "a", "b"])])).evidence.join(" ")).toMatch(/d not ranked/);
    expect(evaluateInvariant(I2, run([bracketOf(kind, "c", ["c", "a", "b", "d", "x"])])).evidence.join(" ")).toMatch(/x ranked but not in the field/);
    expect(evaluateInvariant(I2, run([bracketOf(kind, "c", ["c", "d", "b", "a"])])).verdict).toBe("pass");
  });
  it("double_elim with a played gf-reset: the reset's winner, not gf's, is the champion", () => {
    const cfg = { bracketReset: true };
    const [gf, reset] = terminalFinalKeys("double_elim", F, cfg);
    expect([gf, reset].every((k) => typeof k === "string")).toBe(true);
    const s = stage({
      kind: "double_elim", field: F, config: cfg, terminalFinals: terminalFinalKeys("double_elim", F, cfg),
      fixtures: [
        fx({ roundNo: 8, home: "a", away: "b", outcome: win("b"), extKey: gf, isFinal: true }),
        fx({ roundNo: 9, home: "b", away: "a", outcome: win("a"), extKey: reset, isFinal: true }),
      ],
      complete: done(["a", "b", "c", "d"]),
    });
    expect(evaluateInvariant(I2, run([s])).verdict).toBe("pass");
    const r = evaluateInvariant(I2, run([{ ...s, complete: done(["b", "a", "c", "d"]) }]));
    expect(r.verdict).toBe("fail");
    expect(r.evidence).toEqual([`rank 1 is b, the ${reset} winner is a`]);
    // The reset never played (voided, or never seated): gf's winner is the champion.
    const unplayed = { ...s, fixtures: s.fixtures.map((f) => (f.extKey === reset ? { ...f, status: "void", outcome: null } : f)), complete: done(["b", "a", "c", "d"]) };
    expect(evaluateInvariant(I2, run([unplayed])).verdict).toBe("pass");
  });
  it("page_playoff: the champion lost pp-q1 and still passes — no unbeaten rule outside knockout", () => {
    const pp = generatePagePlayoff({ entrants: F }).fixtures.map((f) => f.id);
    const [final] = terminalFinalKeys("page_playoff", F, {});
    expect(pp.at(-1)).toBe(final);
    const s = stage({
      kind: "page_playoff", field: F, terminalFinals: [final!],
      fixtures: [
        fx({ roundNo: 1, home: "a", away: "b", outcome: win("b"), extKey: pp[0] }),
        fx({ roundNo: 1, home: "c", away: "d", outcome: win("c"), extKey: pp[1] }),
        fx({ roundNo: 2, home: "a", away: "c", outcome: win("a"), extKey: pp[2] }),
        fx({ roundNo: 3, home: "b", away: "a", outcome: win("a"), extKey: final, isFinal: true }),
      ],
      complete: done(["a", "b", "c", "d"]),
    });
    expect(evaluateInvariant(I2, run([s]))).toMatchObject({ verdict: "pass", checked: F.length + 1 });
  });
  it("no fixture carries the terminal key: fails naming the key", () => {
    const s = bracketOf("stepladder", "c", ["c", "a", "b", "d"]);
    const stripped = { ...s, fixtures: s.fixtures.map((f) => ({ ...f, extKey: null })) };
    const keys = terminalFinalKeys("stepladder", F, {});
    expect(keys).toHaveLength(1);
    expect(evaluateInvariant(I2, run([stripped])).evidence.join(" ")).toContain(`no decided fixture carries a terminal final key (${keys[0]})`);
  });
  it("a structural stage the snapshot gave no terminal keys fails by name — never a champion read off a guess", () => {
    const s = bracketOf("page_playoff", "c", ["c", "a", "b", "d"]);
    const { terminalFinals: _drop, ...bare } = s;
    expect(evaluateInvariant(I2, run([bare]))).toMatchObject({ verdict: "fail", evidence: ["stage seq 1: page_playoff carries no terminal final keys — the champion cannot be read"] });
    expect(evaluateInvariant(I2, run([{ ...s, terminalFinals: [] }])).evidence).toEqual(["stage seq 1: page_playoff carries no terminal final keys — the champion cannot be read"]);
  });
  it("knockout keeps the unbeaten rule and ignores terminal keys", () => {
    const ko = stage({
      kind: "knockout", field: F, terminalFinals: ["nowhere"],
      fixtures: [fx({ roundNo: 1, home: "a", away: "d", outcome: win("a") }), fx({ roundNo: 1, home: "b", away: "c", outcome: win("b") }), fx({ roundNo: 2, home: "a", away: "b", outcome: win("a") })],
      complete: done(["a", "b", "c", "d"]),
    });
    expect(evaluateInvariant(I2, run([ko]))).toMatchObject({ verdict: "pass", checked: F.length + 1 });
  });
  // T6 carry (progress.md): ko_plate and qualifying_main stage 1 is a knockout
  // whose /complete committed and answered 409 STAGE_COMPLETED_SEEDING_FAILED;
  // finishStage records it complete with finalRanks null. Judging it would
  // red every entrant "not ranked" on top of the real seeding failure, which
  // the advance check already owns.
  describe("T6 carry: a completion whose seeding failed after commit", () => {
    const ko = (complete: CompleteObs, p: Partial<ObservedStage> = {}) => stage({
      kind: "knockout", field: F,
      fixtures: [fx({ roundNo: 1, home: "a", away: "d", outcome: win("a") }), fx({ roundNo: 1, home: "b", away: "c", outcome: win("b") }), fx({ roundNo: 2, home: "a", away: "b", outcome: win("a") })],
      complete, ...p,
    });
    const seedingFailed: CompleteObs = { status: 409, code: SEEDING_FAILED_AFTER_COMMIT, completed: true, finalRanks: null, seedProposal: null };
    it("ABSTAINS by name when it is the only stage I2 would judge", () => {
      const r = evaluateInvariant(I2, run([ko(seedingFailed)]));
      expect(r).toMatchObject({ verdict: "abstain", checked: 0 });
      expect(r.evidence).toEqual([`abstain: stage seq 1 completed, but /complete answered 409 ${SEEDING_FAILED_AFTER_COMMIT} — its finalRanks were never read (the advance check owns the seeding failure)`]);
    });
    it("the positive pair: finalRanks null with any other answer is still judged, and every entrant reds 'not ranked'", () => {
      const r = evaluateInvariant(I2, run([ko(done(null))]));
      expect(r.verdict).toBe("fail");
      expect(r.evidence.filter((e) => / not ranked$/.test(e))).toHaveLength(F.length);
      expect(evaluateInvariant(I2, run([ko({ ...seedingFailed, code: "SOMETHING_ELSE" })])).verdict).toBe("fail");
    });
    it("beside a judged stage, that stage keeps its verdict and the skipped one is named in the evidence", () => {
      const r = evaluateInvariant(I2, run([ko(done(["a", "b", "c", "d"])), ko(seedingFailed, { id: "s2", seq: 2, fieldSource: "seeded" })]));
      expect(r).toMatchObject({ verdict: "pass", checked: F.length + 1 });
      expect(r.evidence).toEqual([`skipped stage seq 2: completed, but /complete answered 409 ${SEEDING_FAILED_AFTER_COMMIT} — its finalRanks were never read`]);
      const bad = evaluateInvariant(I2, run([ko(done(["b", "a", "c", "d"])), ko(seedingFailed, { id: "s2", seq: 2, fieldSource: "seeded" })]));
      expect(bad.verdict).toBe("fail");
      expect(bad.evidence[0]).toBe("rank 1 is b, unbeaten is a");
    });
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
  // Parked Task 5 (b): http.ts also hands errorResponse literal codes of its own
  // (ZodError → VALIDATION, PaymentRequiredError, AuthError, the unhandled 500).
  // A new literal there would reach the harness as a "named" refusal unseen.
  /** The literal codes in `errorResponse(requestId, <status>, "<CODE>"` calls, and
   *  how many calls pass a literal at all — so one the regex cannot read is not dropped. */
  const directCodes = (src: string) => ({
    codes: [...src.matchAll(/errorResponse\(\s*requestId,\s*\d{3},\s*"([A-Z_]+)"/g)].map((m) => m[1]!),
    literalCalls: (src.match(/errorResponse\(\s*requestId,\s*[^,()]+,\s*"/g) ?? []).length,
  });
  it("GENERIC_ERROR_CODES also covers every code http.ts emits DIRECTLY — the pin is statusCode() ∪ those literals", () => {
    const src = readFileSync(resolve(REPO, "apps/web/src/server/api-v1/http.ts"), "utf8");
    const direct = directCodes(src);
    expect(direct.codes.length).toBe(direct.literalCalls);
    expect(direct.codes.length).toBeGreaterThanOrEqual(4);
    const body = /\nfunction statusCode\(status: number\): string \{\n([\s\S]*?)\n\}\n/.exec(src)![1]!;
    const fromStatus = [...body.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]!);
    expect([...GENERIC_ERROR_CODES].sort()).toEqual([...new Set([...fromStatus, ...direct.codes])].sort());
    // The reader finds a literal it has never seen, and one that is not generic.
    expect(directCodes('return errorResponse(requestId, 402, "PAYWALL", m);')).toEqual({ codes: ["PAYWALL"], literalCalls: 1 });
    expect(directCodes("return errorResponse(requestId, 402, code, m);").literalCalls).toBe(0);
    expect(directCodes('return errorResponse(requestId, st, "PAYWALL", m);')).toEqual({ codes: [], literalCalls: 1 });
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
    // I7 judges the one a~b meeting (pass, 1); I8 has no generate recorded (abstain).
    // I9 and I10 (Task 9) are kind-bound to ladder and americano: a league run abstains on both.
    expect(out.map((c) => [c.verdict, c.checked])).toEqual([["pass", 1], ["abstain", 0], ["fail", 0], ["fail", 0], ["abstain", 0], ["abstain", 0], ["pass", 1], ["abstain", 0], ["abstain", 0], ["abstain", 0]]);
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

describe("I7 — no round-robin pair over its legs (step-safe, no abstentions)", () => {
  const I7 = INVARIANTS.find((s) => s.id === "I7-rr-no-pair-over-legs")!;
  it("empty case first: no league/group stage → abstain", () => {
    expect(evaluateInvariant(I7, run([stage({ kind: "knockout" })])).verdict).toBe("abstain");
  });
  it("no two-sided fixture yet → abstain (nothing generated), never a vacuous pass", () => {
    const r = evaluateInvariant(I7, run([stage({ fixtures: [] })]));
    expect(r).toMatchObject({ verdict: "abstain", checked: 0 });
  });
  it("a 4-field single round robin: 6 pairs, each once → pass, checked 6", () => {
    const f = [["a", "b"], ["c", "d"], ["a", "c"], ["b", "d"], ["a", "d"], ["b", "c"]].map(([h, w], i) => fx({ id: `f${i}`, home: h!, away: w! }));
    expect(evaluateInvariant(I7, run([stage({ fixtures: f })]))).toMatchObject({ verdict: "pass", checked: 6 });
  });
  it("#879's shape: a late entrant, then Generate duplicates a pair → I7 FAILS while I1 abstains on late_entry", () => {
    const f = [["a", "b"], ["a", "b"], ["a", "e"]].map(([h, w], i) => fx({ id: `f${i}`, home: h!, away: w! }));
    const r = run([stage({ fixtures: f, field: ["a", "b", "e"] })], { facts: ["late_entry"] });
    expect(evaluateInvariant(I7, r).verdict).toBe("fail");
    expect(evaluateInvariant(I7, r).evidence[0]).toMatch(/a~b meets 2× in stage 1 \(legs 1\)/);
    expect(evaluateInvariant(INVARIANTS[0]!, r).verdict).toBe("abstain"); // the witness I7 exists for
  });
  it("legs from the stage config: 2 meetings at legs 2 pass, 3 fail", () => {
    const two = [0, 1].map((i) => fx({ id: `f${i}`, home: "a", away: "b" }));
    expect(evaluateInvariant(I7, run([stage({ fixtures: two, config: { legs: 2 } })])).verdict).toBe("pass");
    const three = [0, 1, 2].map((i) => fx({ id: `f${i}`, home: "a", away: "b" }));
    expect(evaluateInvariant(I7, run([stage({ fixtures: three, config: { legs: 2 } })])).verdict).toBe("fail");
  });
  // Review M-1: I1 flags self-play but abstains on every fact below and is not
  // step-safe; I6 covers swiss only. I7 is the model's only step check that sees it.
  it("an entrant seated against itself fails as a step failure, named — even where I1 abstains", () => {
    const r = run([stage({ fixtures: [fx({ id: "sp", home: "a", away: "a" }), fx({ id: "ok", home: "a", away: "b" })] })], { facts: ["late_entry"] });
    expect(evaluateInvariant(spec("I1-rr-pair-once-per-leg"), r).verdict).toBe("abstain");
    expect(evaluateInvariant(I7, r)).toMatchObject({ verdict: "fail", checked: 2, evidence: ["sp: self-play a"] });
  });
  // Beyond the brief: the other state transitions I1 goes silent on.
  it("still speaks under EVERY fact I1 abstains on — withdrawal, expunge, void, cut short, late entry (swept from I1's own declaration)", () => {
    const I1 = spec("I1-rr-pair-once-per-leg");
    const dup = [fx({ id: "d1", home: "a", away: "b" }), fx({ id: "d2", home: "b", away: "a" })];
    let swept = 0;
    for (const fact of I1.abstainOn) {
      const r = run([stage({ field: ["a", "b"], fixtures: dup })], { facts: [fact] });
      expect(evaluateInvariant(I1, r).verdict, fact).toBe("abstain");
      expect(evaluateInvariant(I7, r), fact).toMatchObject({ verdict: "fail", checked: 1, evidence: ["a~b meets 2× in stage 1 (legs 1): d1, d2"] });
      swept++;
    }
    expect(swept).toBe(I1.abstainOn.length);
    expect(swept).toBeGreaterThan(0);
  });
  it("judged where I1 is — league AND group — and per stage: a pair met once in each of two stages is no repeat", () => {
    expect(I7.stageKinds).toEqual(spec("I1-rr-pair-once-per-leg").stageKinds);
    const dup = [fx({ id: "g1", poolId: "A", home: "a", away: "b" }), fx({ id: "g2", poolId: "A", home: "a", away: "b" })];
    expect(evaluateInvariant(I7, run([stage({ kind: "group", fixtures: dup })]))).toMatchObject({ verdict: "fail", checked: 1 });
    const once = (id: string, stageSeq: number) => stage({ id: `s${stageSeq}`, seq: stageSeq, kind: "group", fixtures: [fx({ id, stageId: `s${stageSeq}`, home: "a", away: "b" })] });
    expect(evaluateInvariant(I7, run([once("x1", 1), once("x2", 2)]))).toMatchObject({ verdict: "pass", checked: 2 });
    const twiceIn2 = stage({ id: "s2", seq: 2, fixtures: [fx({ id: "y1", home: "c", away: "d" }), fx({ id: "y2", home: "d", away: "c" })] });
    expect(evaluateInvariant(I7, run([once("x1", 1), twiceIn2])).evidence).toEqual(["c~d meets 2× in stage 2 (legs 1): y1, y2"]);
  });
});

describe("I8 — every Generate answer is fixtures or a named refusal", () => {
  const I8 = INVARIANTS.find((s) => s.id === "I8-generate-named")!;
  // `total` is the stage's full fixture list as the answer carried it
  // (recordGenerate: total = fixtures.length); a refusal carries none.
  const g = (status: number, code: string | null, total = 0, created = total) => ({ status, code, total, created });
  it("empty case first: no generate recorded → abstain", () => {
    expect(evaluateInvariant(I8, run([stage({ generates: [] })])).verdict).toBe("abstain");
  });
  it("200 and 422 STAGE_NOT_READY pass (checked 2); 409 CONFLICT, 500 INTERNAL and a code-less 422 fail", () => {
    expect(evaluateInvariant(I8, run([stage({ generates: [g(200, null, 6), g(422, "STAGE_NOT_READY")] })]))).toMatchObject({ verdict: "pass", checked: 2 });
    for (const bad of [g(409, "CONFLICT"), g(500, "INTERNAL"), g(422, null)]) {
      expect(evaluateInvariant(I8, run([stage({ generates: [bad] })])).verdict).toBe("fail");
    }
  });
  // Beyond the brief: the statuses come from the product's own EngineErrorCode
  // table (engine-http.ts, text-pinned against api-v1 http.ts by engine-http.test.ts).
  it("every engine refusal the product answers with a 4xx passes; one it answers with a 5xx fails (swept from ENGINE_HTTP_STATUS)", () => {
    let fourxx = 0;
    let swept = 0;
    for (const [code, status] of Object.entries(ENGINE_HTTP_STATUS)) {
      const r = evaluateInvariant(I8, run([stage({ generates: [g(status, code)] })]));
      if (status >= 400 && status < 500) { fourxx++; expect(r, code).toMatchObject({ verdict: "pass", checked: 1 }); }
      else expect(r, code).toMatchObject({ verdict: "fail", evidence: [`stage 1: generate → ${status} ${code}`] });
      swept++;
    }
    expect(swept).toBe(Object.keys(ENGINE_HTTP_STATUS).length);
    expect(fourxx).toBeGreaterThan(0);
  });
  it("a second Generate is judged too, in any stage: one unnamed answer among named ones fails, naming its stage", () => {
    const r = evaluateInvariant(I8, run([
      stage({ generates: [g(200, null, 6), g(422, "STAGE_NOT_READY")] }),
      stage({ id: "s2", seq: 2, generates: [g(200, null, 3), g(409, "CONFLICT")] }),
    ]));
    expect(r).toMatchObject({ verdict: "fail", checked: 4, evidence: ["stage 2: generate → 409 CONFLICT"] });
  });
  // Review I-1. R13 (_RULES.md): "an empty result is a failure: … an empty
  // generate". I4 carries that clause but is not step-safe, and the model
  // evaluates only the step-safe set — so I8 has to carry it too, or its
  // "fixtures (2xx)" pass reason would print over an answer with none.
  it("R13: a 2xx Generate that answered NO fixtures fails, named — any 2xx, beside named refusals", () => {
    expect(evaluateInvariant(I8, run([stage({ generates: [g(422, "STAGE_NOT_READY"), g(200, null, 0)] })])))
      .toMatchObject({ verdict: "fail", checked: 2, evidence: ["stage 1: empty generate (R13)"] });
    expect(evaluateInvariant(I8, run([stage({ generates: [g(201, null, 0)] })]))).toMatchObject({ verdict: "fail", evidence: ["stage 1: empty generate (R13)"] });
  });
  // The product's Generate answers EVERY fixture of the stage, not only the new
  // ones (server/usecases/stages.ts generate's return), so a repeat call has
  // total > 0 and created 0. Keying R13 on `created` would red every re-Generate.
  it("a repeat Generate (the stage's full list, nothing new created) passes — no false red on a second call", () => {
    expect(evaluateInvariant(I8, run([stage({ generates: [g(200, null, 6, 6), g(200, null, 6, 0)] })]))).toMatchObject({ verdict: "pass", checked: 2 });
  });
});

describe("I1 — a later stage's field must be observed per stage (W1a carry 1)", () => {
  it("seq 2 with a division-wide field FAILS by name rather than judging the wrong entrants", () => {
    const r = evaluateInvariant(INVARIANTS[0]!, run([stage({ seq: 2, fieldSource: "division" })]));
    expect(r.verdict).toBe("fail");
    expect(r.evidence.join(" ")).toMatch(/stage seq 2: field is division-wide/);
  });
  it("seq 2 with a seeded field is judged normally", () => {
    const f = [fx({ id: "f1", home: "a", away: "b" })];
    expect(evaluateInvariant(INVARIANTS[0]!, run([stage({ seq: 2, fieldSource: "seeded", field: ["a", "b"], fixtures: f })])).verdict).toBe("pass");
    expect(evaluateInvariant(INVARIANTS[0]!, run([stage({ seq: 2, fieldSource: "seeded", field: ["a", "b"], fixtures: f })]))).toMatchObject({ verdict: "pass", checked: 1 });
  });
  it("the root stage keeps a division-wide field, and a refused later stage does not silence the root's own judgement", () => {
    const root = stage({ field: ["a", "b"], fixtures: [fx({ id: "r1", home: "a", away: "b" })] });
    expect(evaluateInvariant(INVARIANTS[0]!, run([root]))).toMatchObject({ verdict: "pass", checked: 1 });
    const r = evaluateInvariant(INVARIANTS[0]!, run([root, stage({ id: "s2", seq: 2, fieldSource: "division", field: ["a", "b"], fixtures: [fx({ id: "r2", stageId: "s2", home: "a", away: "b" })] })]));
    expect(r).toMatchObject({ verdict: "fail", checked: 1 });
    expect(r.evidence).toEqual(["stage seq 2: field is division-wide — per-stage entrants were not observed"]);
  });
});

it("evaluateStepInvariants returns exactly the step-safe ids", () => {
  const out = evaluateStepInvariants(run([stage({})]));
  expect(out.map((c) => c.id)).toEqual(STEP_INVARIANTS.map((s) => s.id));
});
it("evaluateStepInvariants reports each step-safe spec exactly as evaluateInvariants does (one mapping, not two)", () => {
  const f = [fx({ id: "e1", home: "a", away: "b" }), fx({ id: "e2", home: "a", away: "b" })];
  const r = run([stage({ fixtures: f, generates: [{ status: 200, code: null, total: 2, created: 2 }] })], { facts: ["late_entry"] });
  const ids = new Set(STEP_INVARIANTS.map((s) => s.id));
  const full = evaluateInvariants(r).filter((c) => ids.has(c.id));
  expect(full.length).toBe(STEP_INVARIANTS.length);
  expect(evaluateStepInvariants(r)).toEqual(full);
  expect(evaluateStepInvariants(r).find((c) => c.id === "I7-rr-no-pair-over-legs")).toMatchObject({ verdict: "fail", reason: "a~b meets 2× in stage 1 (legs 1): e1, e2" });
});

// W1-driving Task 9. The product's ladder finalRanks is the RAW
// config.ladder_order (engine-db/competition.ts:606), written on the first
// challenge and on every decided swap, never pruned (stages.ts:5538-5551,
// scoring.ts:774-786). T7 carry r1-b: a permutation, not membership.
describe("I9 ladder", () => {
  const I9 = spec("I9-ladder-order-is-the-field");
  const done = (finalRanks: string[] | null): CompleteObs => ({ status: 200, code: null, completed: true, finalRanks, seedProposal: null });
  const ladder = (finalRanks: string[] | null, order: string[] | undefined, fixtures = [fx({ home: "d", away: "c", outcome: win("d") })]) => stage({
    kind: "ladder", field: ["a", "b", "c", "d"], config: order === undefined ? {} : { ladder_order: order }, fixtures,
    complete: done(finalRanks),
  });
  const withdrawn = (entrantId: string): WithdrawalObs => ({ entrantId, afterRound: 3, policy: "none", walkovers: 0, voided: 0, skippedFinalized: 0, before: [] });
  it("empty cases first: no stage abstains; a ladder stage with no decided challenge fails, checked counted; an incomplete ladder abstains", () => {
    expect(evaluateInvariant(I9, run([]))).toMatchObject({ verdict: "abstain", checked: 0 });
    const r = evaluateInvariant(I9, run([ladder(["a", "b", "d", "c"], ["a", "b", "d", "c"], [])]));
    expect(r).toMatchObject({ verdict: "fail", checked: 4 });
    expect(r.evidence).toEqual(["stage seq 1: no decided challenge on the ladder"]);
    // A challenge issued but never played is not a decided one.
    const open = evaluateInvariant(I9, run([ladder(["a", "b", "c", "d"], ["a", "b", "c", "d"], [fx({ home: "d", away: "c", status: "scheduled" })])]));
    expect(open.evidence).toEqual(["stage seq 1: no decided challenge on the ladder"]);
    expect(evaluateInvariant(I9, run([{ ...ladder(null, ["a", "b", "c", "d"]), complete: { status: 200, code: null, completed: false, finalRanks: null, seedProposal: null } }])).verdict).toBe("abstain");
  });
  it("a drawn challenge and a walked-over challenge are decided challenges (both move nobody)", () => {
    expect(evaluateInvariant(I9, run([ladder(["a", "b", "c", "d"], ["a", "b", "c", "d"], [fx({ home: "d", away: "c", outcome: { kind: "draw" } })])])).verdict).toBe("pass");
    expect(evaluateInvariant(I9, run([ladder(["a", "b", "c", "d"], ["a", "b", "c", "d"], [fx({ home: "d", away: "c", status: "forfeited", outcome: { kind: "award", winner: "c" } })])])).verdict).toBe("pass");
  });
  it("finalRanks = ladder_order over the active field passes; missing, duplicate, outsider and ranks ≠ order each fail by name", () => {
    expect(evaluateInvariant(I9, run([ladder(["a", "b", "d", "c"], ["a", "b", "d", "c"])]))).toMatchObject({ verdict: "pass", checked: 4 });
    expect(evaluateInvariant(I9, run([ladder(["a", "b", "d"], ["a", "b", "d"])])).evidence.join(" ")).toMatch(/c not ranked/);
    expect(evaluateInvariant(I9, run([ladder(["a", "a", "b", "d", "c"], ["a", "a", "b", "d", "c"])])).evidence.join(" ")).toMatch(/a ranked 2×/);
    expect(evaluateInvariant(I9, run([ladder(["a", "b", "d", "c", "x"], ["a", "b", "d", "c", "x"])])).evidence.join(" ")).toMatch(/x ranked but not in the field/);
    const differ = evaluateInvariant(I9, run([ladder(["a", "b", "c", "d"], ["a", "b", "d", "c"])]));
    expect(differ.verdict).toBe("fail");
    expect(differ.evidence).toEqual(["stage seq 1: finalRanks differ from ladder_order: a,b,c,d vs a,b,d,c"]);
  });
  // T9-R1: the raw stored order is the product's own (never pruned, field-complete), so every
  // case below keeps it realistic and plants ONE defect in finalRanks.
  it("T7 carry r1-b / T9-R1: a duplicate, a foreign id, a missing active entrant and a swapped active pair each red on their own", () => {
    const raw = ["a", "b", "d", "c"];
    expect(evaluateInvariant(I9, run([ladder(raw, raw)]))).toMatchObject({ verdict: "pass", checked: 4 }); // the clean baseline
    const dup = evaluateInvariant(I9, run([ladder(["a", "b", "d", "c", "a"], raw)]));
    expect(dup.verdict).toBe("fail");
    expect(dup.evidence).toContain("a ranked 2×");
    expect(evaluateInvariant(I9, run([ladder(["a", "b", "d", "c", "x"], raw)])).evidence).toEqual(["x ranked but not in the field"]);
    const missing = evaluateInvariant(I9, run([ladder(["a", "d", "c"], raw)]));
    expect(missing.verdict).toBe("fail");
    expect(missing.evidence).toContain("b not ranked");
    expect(evaluateInvariant(I9, run([ladder(["b", "a", "d", "c"], raw)])).evidence).toEqual(["stage seq 1: finalRanks differ from ladder_order: b,a,d,c vs a,b,d,c"]);
    // At the right length, a duplicate or a foreign id standing in for an entrant still reds.
    expect(evaluateInvariant(I9, run([ladder(["a", "a", "d", "c"], raw)])).evidence).toEqual(expect.arrayContaining(["a ranked 2×", "b not ranked"]));
    expect(evaluateInvariant(I9, run([ladder(["a", "x", "d", "c"], raw)])).evidence).toEqual(expect.arrayContaining(["b not ranked", "x ranked but not in the field"]));
  });
  it("a ladder with no ladder_order observed fails by name, and so does one with no finalRanks", () => {
    expect(evaluateInvariant(I9, run([ladder(["a", "b", "c", "d"], undefined)])).evidence).toEqual(["stage seq 1: no ladder_order observed — finalRanks cannot be compared"]);
    const noRanks = evaluateInvariant(I9, run([ladder(null, ["a", "b", "c", "d"])]));
    expect(noRanks.verdict).toBe("fail");
    expect(noRanks.evidence.filter((e) => / not ranked$/.test(e))).toHaveLength(4);
  });
  it("the PRODUCT shape (review 2 m-4, ruling 53): a withdrawn entrant stays ranked at its held rung, since finalRanks = raw ladder_order — pass, and the rung is a W7 note", () => {
    // competition.ts:606 snapshots the raw ladder_order, which stages.ts:5562-5572 never prunes; D8 leaves policy "none".
    const r = evaluateInvariant(I9, run([ladder(["a", "c", "b", "d"], ["a", "c", "b", "d"])], { withdrawal: withdrawn("c") }));
    expect(r.verdict).toBe("pass");                                 // "ranked but withdrawn" is NOT an I9 failure (W7's question)
    expect(r.checked).toBe(4);
  });
  // T9-R1: the raw stored order keeps the withdrawn entrant's rung (ruling 53), whatever finalRanks do.
  it("T9-R1: the withdrawn entrant may be ranked anywhere or not at all against the UNPRUNED raw order — the active entrants' relative order is what is judged", () => {
    const raw = ["a", "c", "b", "d"];
    const w = { withdrawal: withdrawn("c") };
    expect(evaluateInvariant(I9, run([ladder(raw, raw)], w))).toMatchObject({ verdict: "pass", checked: 4 });                     // keeps its rung
    expect(evaluateInvariant(I9, run([ladder(["a", "b", "d"], raw)], w))).toMatchObject({ verdict: "pass", checked: 4 });         // a pruning product
    expect(evaluateInvariant(I9, run([ladder(["a", "b", "d", "c"], raw)], w))).toMatchObject({ verdict: "pass", checked: 4 });    // moved to the bottom
    // The same pruned finalRanks with NO withdrawal recorded is a missing active entrant (the differing case).
    expect(evaluateInvariant(I9, run([ladder(["a", "b", "d"], raw)])).evidence).toContain("c not ranked");
  });
  it("T9-R1: beside a withdrawal, a swapped active pair, a missing active entrant and the withdrawn entrant ranked twice each still red", () => {
    const raw = ["a", "c", "b", "d"];
    const w = { withdrawal: withdrawn("c") };
    expect(evaluateInvariant(I9, run([ladder(["b", "a", "d"], raw)], w)).evidence).toEqual(["stage seq 1: finalRanks differ from ladder_order: b,a,d vs a,b,d (active entrants; withdrawn c set aside)"]);
    const missing = evaluateInvariant(I9, run([ladder(["a", "d"], raw)], w));
    expect(missing.verdict).toBe("fail");
    expect(missing.evidence).toContain("b not ranked");
    expect(evaluateInvariant(I9, run([ladder(["a", "c", "b", "d", "c"], raw)], w)).evidence).toEqual(["c ranked 2×"]);
  });
  it("a later ladder stage judged on a division-wide field fails by name (W1a carry 1)", () => {
    expect(evaluateInvariant(I9, run([{ ...ladder(["a", "b", "c", "d"], ["a", "b", "c", "d"]), seq: 2, fieldSource: "division" }])).evidence)
      .toEqual(["stage seq 2: field is division-wide — per-stage entrants were not observed"]);
  });
  it("cut short: abstains (a capped run owes nothing)", () => {
    expect(evaluateInvariant(I9, run([ladder(["a", "b", "c", "d"], ["a", "b", "d", "c"])], { facts: facts("cut_short") })).verdict).toBe("abstain");
  });
});

// W1-driving Task 9. The product folds americano as a league over the stage's
// SIDES — the pair entrants it minted (engine-db/competition.ts:360-365, :399;
// Task 8 Step 0) — so finalRanks ranks pair entrants, not people. The persons
// are the product's own members (ObservedStage.persons: the division
// entrants' from setup, the pairs' from GET /entrants/{id}).
describe("I10 americano", () => {
  const I10 = spec("I10-americano-seats-each-person-once");
  const I4 = spec("I4-nothing-ends-stuck");   // T9-R4: which not-complete shape I4 reds, beside I10's note
  const persons = { A: ["p1"], B: ["p2"], C: ["p3"], D: ["p4"], P12: ["p1", "p2"], P34: ["p3", "p4"], P13: ["p1", "p3"], P24: ["p2", "p4"], P11: ["p1", "p1"] };
  const sidesOf = (fixtures: readonly ObservedFixture[]) => [...new Set(fixtures.flatMap((f) => [f.home, f.away]).filter((e): e is string => e !== null))];
  /** finalRanks defaults to the sides the fixtures seat — what the product's fold ranks. */
  const am = (fixtures: ObservedFixture[], finalRanks: string[] | null = sidesOf(fixtures), p: Partial<ObservedStage> = {}) => stage({
    kind: "americano", field: ["A", "B", "C", "D"], persons, fixtures,
    complete: { status: 200, code: null, completed: true, finalRanks, seedProposal: null }, ...p,
  });
  const r1 = () => fx({ roundNo: 1, home: "P12", away: "P34", outcome: win("P12") });
  const r2 = () => fx({ roundNo: 2, home: "P13", away: "P24", outcome: win("P24") });
  it("empty cases first: no stage abstains; a stage that seated nobody fails on checked 0", () => {
    expect(evaluateInvariant(I10, run([]))).toMatchObject({ verdict: "abstain", checked: 0 });
    expect(evaluateInvariant(I10, run([am([])]))).toMatchObject({ verdict: "fail", checked: 0, evidence: ["stage seq 1: no round seated anyone"] });
    expect(evaluateInvariant(I10, run([am([fx({ roundNo: 1, status: "scheduled" })])]))).toMatchObject({ verdict: "fail", checked: 0 });
  });
  it("two rounds, each person once per round, everyone plays, every seated pair ranked once — passes; checked counts round items, field persons and seated sides", () => {
    const r = evaluateInvariant(I10, run([am([r1(), r2()])]));
    expect(r.verdict).toBe("pass");
    // 4 persons × 2 rounds + 4 field persons + 4 seated pair entrants.
    expect(r.checked).toBe(4 * 2 + 4 + 4);
  });
  it("a person seated twice in one round fails naming the round and the person — across two seats, and within one seat", () => {
    const r = evaluateInvariant(I10, run([am([fx({ roundNo: 1, home: "P12", away: "P13", outcome: win("P12") })])]));
    expect(r.evidence).toContain("round 1: p1 seated 2×");
    const self = evaluateInvariant(I10, run([am([fx({ roundNo: 1, home: "P11", away: "P34", outcome: win("P11") })])]));
    expect(self.evidence).toContain("round 1: p1 seated 2×");
    // The same person in two DIFFERENT rounds is the rotation, not a repeat.
    expect(evaluateInvariant(I10, run([am([r1(), r2()])])).evidence.some((e) => /seated/.test(e))).toBe(false);
  });
  it("a round is judged on every seat, whatever its status (PF-8: seated is seated)", () => {
    const r = evaluateInvariant(I10, run([am([fx({ roundNo: 1, home: "P12", away: "P13", status: "scheduled", outcome: null })], null)]));
    expect(r.evidence).toContain("round 1: p1 seated 2×");
  });
  it("PF-8: a field person seated in 0 fixtures 'never played'; seated in one that never finished still played", () => {
    const r = evaluateInvariant(I10, run([am([fx({ roundNo: 1, home: "P12", away: "P13", outcome: win("P12") })])]));
    expect(r.evidence).toContain("p4 never played");
    expect(r.evidence.filter((e) => /never played/.test(e))).toEqual(["p4 never played"]);
    const unfinished = evaluateInvariant(I10, run([am([r1(), fx({ roundNo: 2, home: "P13", away: "P24", status: "void", outcome: null })])]));
    expect(unfinished.evidence.some((e) => /never played/.test(e))).toBe(false);
  });
  it("a TEAM field entrant (its persons are the roster) is judged per ENTRANT: one member seated is enough; none seated reds '<entrant> never played'", () => {
    const team = { T: ["p1", "p2", "p3"], U: ["p4", "p5", "p6"], X2: ["p2"], Y4: ["p4"] };
    const teams = (fixtures: ObservedFixture[]) => stage({
      kind: "americano", field: ["T", "U"], persons: team, fixtures,
      complete: { status: 200, code: null, completed: true, finalRanks: sidesOf(fixtures), seedProposal: null },
    });
    const played = evaluateInvariant(I10, run([teams([fx({ roundNo: 1, home: "X2", away: "Y4", outcome: win("X2") })])]));
    expect(played.verdict).toBe("pass");
    const r = evaluateInvariant(I10, run([teams([fx({ roundNo: 1, home: "X2", away: "X2", outcome: win("X2") })])]));
    expect(r.evidence).toContain("U never played");
    expect(r.evidence).not.toContain("T never played");
    expect(r.evidence.some((e) => /^p\d never played$/.test(e))).toBe(false);
  });
  it("a field entrant or a seated side with no observed persons fails by name — never read as nobody", () => {
    const missingField = evaluateInvariant(I10, run([am([r1()], undefined, { field: ["A", "B", "C", "D", "Z"] })]));
    expect(missingField.evidence).toContain("Z: no persons observed");
    const missingSide = evaluateInvariant(I10, run([am([fx({ roundNo: 1, home: "P12", away: "Q", outcome: win("P12") })])]));
    expect(missingSide.evidence).toContain("round 1: Q has no observed persons");
    const { persons: _drop, ...bare } = am([r1()]);
    expect(evaluateInvariant(I10, run([bare]))).toMatchObject({ verdict: "fail", evidence: ["stage seq 1: no persons observed — who sat cannot be read"] });
  });
  it("finalRanks: each pair entrant the stage seated, exactly once, and nothing it did not seat", () => {
    const ok = [r1(), r2()];
    expect(evaluateInvariant(I10, run([am(ok, ["P12", "P34", "P13"])])).evidence).toEqual(["P24 not ranked"]);
    expect(evaluateInvariant(I10, run([am(ok, ["P12", "P34", "P13", "P24", "P12"])])).evidence).toEqual(["P12 ranked 2×"]);
    // An individual entrant is not a side the fold ranks.
    expect(evaluateInvariant(I10, run([am(ok, ["P12", "P34", "P13", "P24", "A"])])).evidence).toEqual(["A ranked but not seated in this stage"]);
  });
  it("PF-8 / T9-R2 / T9-R4: the rank items are skipped silently when /complete was never asked, and with a NAMED note when it answered not complete (the unnamed 200, which I4 also reds); the round and person items still judge", () => {
    const never = evaluateInvariant(I10, run([am([r1(), r2()], null, { complete: null })]));
    expect(never).toMatchObject({ verdict: "pass", checked: 4 * 2 + 4 });
    expect(never.evidence).toEqual([]);                             // never asked: nothing to note (I4 reds "never asked")
    // T9-R4: the not-complete skip is NAMED, never silent. T9-R5: the only not-complete shape the recorder
    // emits on an americano is the unnamed 200 — finishStage records the seeding-failed 409 as completed:true,
    // and an americano has no successor stage to seed.
    const unnamed = { status: 200, code: null, completed: false, finalRanks: null, seedProposal: null };
    const notDone = evaluateInvariant(I10, run([am([r1(), r2()], null, { complete: unnamed })]));
    expect(notDone).toMatchObject({ verdict: "pass", checked: 4 * 2 + 4 });
    expect(notDone.evidence).toEqual(["skipped the rank items of stage seq 1 (/complete answered 200 (no code)): stage not complete — no ranks to judge"]);
    expect(evaluateInvariant(I4, run([am([r1(), r2()], null, { complete: unnamed })])).verdict).toBe("fail");   // I4 reds this shape too
  });
  it("T9-R2: a COMPLETED stage that read no finalRanks reds by name; the same stage with its ranks passes (the positive pair)", () => {
    const withRanks = evaluateInvariant(I10, run([am([r1(), r2()])]));
    expect(withRanks).toMatchObject({ verdict: "pass", checked: 4 * 2 + 4 + 4 });
    const noRanks = evaluateInvariant(I10, run([am([r1(), r2()], null)]));
    expect(noRanks).toMatchObject({ verdict: "fail", checked: 4 * 2 + 4 + 1, evidence: ["stage seq 1: completed, but no finalRanks were read — the pair ranking cannot be judged"] });
    // A completed stage with WRONG ranks is judged item by item.
    expect(evaluateInvariant(I10, run([am([r1(), r2()], ["P12"])])).verdict).toBe("fail");
  });
  it("cut short: abstains", () => {
    expect(evaluateInvariant(I10, run([am([fx({ roundNo: 1, home: "P12", away: "P13", outcome: win("P12") })])], { facts: facts("cut_short") })).verdict).toBe("abstain");
  });
});
