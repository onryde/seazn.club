// W1d Task 18 (ruling 63, D18): the triage tool.
//
// Ruling 63 asks every ❌ to carry an audit gap id (or NEW-W1d-<n>) and its design §8 wave, and W1-driving's 164 product
// reds to be re-keyed from triage rule P1-P7 to those ids. triage() maps each red to EXACTLY ONE rule (none is untriaged,
// two is ambiguous); a rule that routes a gap away from §8 is misrouted; a rule naming a gap nobody knows is unknown.
//
// Four kinds of test:
//   - the pure function, on small hand-built runs, each match key and each list its own row;
//   - the schemas and the committed catalogue files (anti-vacuity: the routing's floor, its keys against the real audit);
//   - the CLI: exit codes, the three files, redaction, and the refusals that write nothing;
//   - the REAL committed results (TR/w1drv-l3, w1drv-l1, w1c-l2) through the CLI (class 1: a fixture proves the fixture),
//     with every expected count read from the raw JSON by a second implementation, never from triage().
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseVerdicts, readAudit } from "../lib/audit-ledger.ts";
import { CASE_STATES, type CaseResult, type CaseState, type Layer, type RunResults } from "../lib/results.ts";
import {
  CATALOGUE_DIR, TriageRefused, isClean, loadCatalogue, parseNewGaps, parseRouting, parseRules, parseTriage, rekey, renderRekey, renderTriage, routeOf, triage, triageJson, unkeyedReds,
  type GapRouting, type NewGaps, type TriageRules,
} from "../lib/triage.ts";
import { main } from "../triage.ts";
import { REPO, TRUTH_RUNS } from "./committed-plans.ts";
import { kase, mergedRun } from "./summary-fixtures.ts";

const AUDIT_DIR = resolve(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/audit-2026-09-27");

// --- builders --------------------------------------------------------------------------------------------------------

/** A red case. The failing checks are read off the reason's `<check id>: <message>` heads (`error: …` is a product error, no check). */
function red(caseId: string, reason: string, over: Partial<CaseResult> = {}, layer: Layer = "L3"): CaseResult {
  const [row, sport, variant, last] = caseId.split("|") as [string, string, string, string];
  const failing = reason.split("; ").flatMap((p) => { const m = /^([\w-]+): /.exec(p); return m !== null && m[1] !== "error" ? [m[1]!] : []; });
  const checks = failing.map((id) => ({ id, kind: "invariant" as const, verdict: "fail" as const, checked: 1, reason: "x", evidence: [] }));
  return kase(layer, { caseId, row, sport, variant, scenario: last.split("@")[0]!, state: "red", reason, checks, ...(layer === "L2" ? { width: 375 } : {}), ...over });
}
const ok = (caseId: string, layer: Layer = "L3", state: CaseState = "works", over: Partial<CaseResult> = {}): CaseResult => {
  const [row, sport, variant, last] = caseId.split("|") as [string, string, string, string];
  const passing = state === "works" || state === "refused";
  return kase(layer, { caseId, row, sport, variant, scenario: last.split("@")[0]!, state, reason: passing ? "1 checks, 3 items" : "", checks: passing ? [{ id: "k1", kind: "invariant", verdict: "pass", checked: 3, reason: "", evidence: [] }] : [], ...(layer === "L2" ? { width: 375 } : {}), ...over });
};
const run = (cases: CaseResult[], layer: Layer = "L3"): RunResults => mergedRun(layer, `r-${layer.toLowerCase()}`, cases);
const rules = (list: Record<string, unknown>[]): TriageRules => parseRules({ rules: list.map((r) => ({ note: "test", ...r })) });
const ROUTING: GapRouting = parseRouting({ note: "test", routes: { "SC-O1": "W2", "ST-G3": "W5", "SW-*": "W3", "SH-*": "W8", "SC-X1": "W2" } });
const LEDGER = ["SC-O1", "ST-G3", "SW-H1", "SW-H2", "SH-G1", "SC-X1"].map((id) => ({ id }));
const NONE: NewGaps = parseNewGaps({ gaps: [] });

// --- routeOf ---------------------------------------------------------------------------------------------------------

describe("routeOf: exact ids win over a <PREFIX>-* wildcard", () => {
  const r = parseRouting({ note: "t", routes: { "SW-*": "W3", "SW-M8": "W7", "FX-G13": "W3", "FX-*": "W5" } });
  it("an exact id, a wildcard, the exact id beating its own prefix wildcard (both orders), and an id with no route", () => {
    expect(routeOf(r, "SW-H1")).toBe("W3");
    expect(routeOf(r, "SW-M8")).toBe("W7");
    expect(routeOf(r, "FX-G13")).toBe("W3");
    expect(routeOf(r, "FX-G1")).toBe("W5");
    expect(routeOf(r, "ST-G1")).toBeNull();
    // Key order must not matter: the exact id listed AFTER its wildcard (SW-M8) and BEFORE it (FX-G13) both win.
    expect(Object.keys(r.routes).indexOf("SW-M8")).toBeGreaterThan(Object.keys(r.routes).indexOf("SW-*"));
    expect(Object.keys(r.routes).indexOf("FX-G13")).toBeLessThan(Object.keys(r.routes).indexOf("FX-*"));
  });

  it("a wildcard covers its own prefix only (SW-* is not SWX-1 and not SC-S1)", () => {
    expect(routeOf(parseRouting({ note: "t", routes: { "SW-*": "W3" } }), "SC-S1")).toBeNull();
    expect(routeOf(parseRouting({ note: "t", routes: { "SC-*": "W2" } }), "SC-S1")).toBe("W2");
    expect(routeOf(parseRouting({ note: "t", routes: { "SC-*": "W2" } }), "SCX-S1")).toBeNull();
  });
});

// --- the schemas -----------------------------------------------------------------------------------------------------

describe("catalogue schemas", () => {
  const rule = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ id: "T-1", match: { cell: "league|*" }, gap: "ST-G3", wave: "W5", note: "n", ...over });

  it("accepts the brief's shapes, every optional key set and absent", () => {
    const parsed = parseRules({ rules: [rule({ match: { cell: "league|*", scenario: "M1", layer: "L3", check: "standings", reason: "x" }, was: "P1" }), rule({ id: "T-2", gap: "NEW-W1d-2", match: {} })] });
    expect(parsed.rules).toHaveLength(2);
    expect(parsed.rules[0]!.was).toBe("P1");
    expect(parsed.rules[1]!.was).toBeUndefined();
    expect(parseRules({ rules: [] }).rules).toEqual([]);
    expect(parseNewGaps({ gaps: [{ id: "NEW-W1d-1", wave: "W4", title: "t", evidence: "a|b|c|M1" }] }).gaps).toHaveLength(1);
  });

  it("refuses each malformed rule on its own field", () => {
    const bad: [string, Record<string, unknown>][] = [
      ["a cell with no pipe", rule({ match: { cell: "league" } })],
      ["a cell of three segments (it is row|sport)", rule({ match: { cell: "a|b|c" } })],
      ["an unknown match key", rule({ match: { sport: "x" } })],
      ["a layer that is not a layer", rule({ match: { layer: "L4" } })],
      ["an empty reason substring (it would match every red)", rule({ match: { reason: "" } })],
      ["a gap that is no id", rule({ gap: "ledger-3" })],
      ["a NEW id of the wrong shape", rule({ gap: "NEW-1" })],
      ["a wave that is not a wave", rule({ wave: "five" })],
      ["a missing note", (() => { const r = rule(); delete r.note; return r; })()],
      ["an empty note", rule({ note: "" })],
      ["an empty rule id", rule({ id: "" })],
      ["an unknown key", rule({ extra: 1 })],
    ];
    let refused = 0;
    for (const [what, r] of bad) { expect(() => parseRules({ rules: [r] }), what).toThrow(); refused++; }
    expect(refused).toBe(bad.length);
  });

  it("refuses two rules with one id: ambiguity is named by rule id, so a repeated id would hide which rule fired", () => {
    expect(() => parseRules({ rules: [rule(), rule()] })).toThrow(/duplicate rule id T-1/);
  });

  it("routing: keys are an exact audit id or <PREFIX>-*, values waves, the note is required", () => {
    expect(() => parseRouting({ note: "t", routes: { "SW-H1": "W3" } })).not.toThrow();
    for (const [what, r] of [["a key with no prefix", { H1: "W3" }], ["a wildcard mid-id", { "S*-H1": "W3" }], ["a NEW id", { "NEW-W1d-1": "W3" }], ["a bad wave", { "SW-H1": "three" }], ["a lowercase prefix", { "sw-*": "W3" }]] as const) {
      expect(() => parseRouting({ note: "t", routes: r }), what).toThrow();
    }
    expect(() => parseRouting({ routes: {} })).toThrow();
    expect(() => parseRouting({ note: "", routes: {} })).toThrow();
  });

  it("new gaps: ids NEW-W1d-<n>, unique, each with a wave, a title and its evidence", () => {
    const g = { id: "NEW-W1d-1", wave: "W4", title: "t", evidence: "e" };
    expect(() => parseNewGaps({ gaps: [g, g] })).toThrow(/duplicate/);
    expect(() => parseNewGaps({ gaps: [{ ...g, id: "SW-H1" }] })).toThrow();
    expect(() => parseNewGaps({ gaps: [{ ...g, title: "" }] })).toThrow();
    expect(() => parseNewGaps({ gaps: [{ ...g, wave: "x" }] })).toThrow();
  });
});

// --- triage() --------------------------------------------------------------------------------------------------------

describe("triage (ruling 63)", () => {
  it("every red maps to exactly one rule; a red with none is untriaged, with two is ambiguous", () => {
    const r = triage([run([red("league|generic|default|M1", "standings: x", { sport: "generic" }), red("swiss|chess|default|R4", "round 5 paired nobody (SW-H1)"), red("knockout|generic|default|F1", "nothing matches")])], rules([
      { id: "T-1", match: { cell: "league|*", check: "standings" }, gap: "ST-G3", wave: "W5" },
      { id: "T-2", match: { reason: "SW-H1" }, gap: "SW-H1", wave: "W3" },
      { id: "T-3", match: { cell: "swiss|*" }, gap: "SW-H1", wave: "W3" },
    ]), ROUTING, LEDGER, NONE);
    expect(r.rows.map((x) => [x.caseId, x.gap])).toEqual([["league|generic|default|M1", "ST-G3"]]);
    expect(r.ambiguous).toEqual([{ caseId: "swiss|chess|default|R4", rules: ["T-2", "T-3"] }]);
    expect(r.untriaged).toEqual(["knockout|generic|default|F1"]);
    expect(r.checked).toBe(3);
    expect(isClean(r)).toBe(false);
  });

  it("a rule that routes a gap away from §8 is misrouted (never re-route a gap §8 assigns)", () => {
    const r = triage([run([red("a|b|c|M1", "x")])], rules([{ id: "T-1", match: {}, gap: "SC-O1", wave: "W4" }]), ROUTING, LEDGER, NONE);
    expect(r.misrouted).toEqual([{ rule: "T-1", gap: "SC-O1", wave: "W4", routed: "W2" }]);
    expect(r.unknownGap).toEqual([]);
    expect(isClean(r)).toBe(false);
  });

  it("the same rule at §8's wave is clean; a known gap with NO route is misrouted too (routed null), never waved through", () => {
    const fine = triage([run([red("a|b|c|M1", "x")])], rules([{ id: "T-1", match: {}, gap: "SC-O1", wave: "W2" }]), ROUTING, LEDGER, NONE);
    expect(fine.misrouted).toEqual([]);
    expect(isClean(fine)).toBe(true);
    const unrouted = triage([run([red("a|b|c|M1", "x")])], rules([{ id: "T-1", match: {}, gap: "ST-G3", wave: "W5" }]), parseRouting({ note: "t", routes: { "SW-*": "W3" } }), LEDGER, NONE);
    expect(unrouted.misrouted).toEqual([{ rule: "T-1", gap: "ST-G3", wave: "W5", routed: null }]);
  });

  it("a rule is judged whether or not it matched a red: a bad rule is bad today, not only when data finds it", () => {
    const r = triage([run([ok("a|b|c|M1")])], rules([{ id: "T-1", match: { cell: "none|*" }, gap: "SC-O1", wave: "W4" }, { id: "T-2", match: { cell: "none|*" }, gap: "SC-Z9", wave: "W2" }]), ROUTING, LEDGER, NONE);
    expect(r.misrouted).toEqual([{ rule: "T-1", gap: "SC-O1", wave: "W4", routed: "W2" }]);
    expect(r.unknownGap).toEqual([{ rule: "T-2", gap: "SC-Z9" }]);
    expect(r.checked).toBe(0);
  });

  it("a gap id that is neither in the audit ledger nor in new-gaps.json is unknown", () => {
    const r = triage([run([red("a|b|c|M1", "x")])], rules([{ id: "T-1", match: {}, gap: "SC-Z9", wave: "W2" }]), ROUTING, LEDGER, NONE);
    expect(r.unknownGap).toEqual([{ rule: "T-1", gap: "SC-Z9" }]);
    // Unknown is not also misrouted: there is no route to compare to.
    expect(r.misrouted).toEqual([]);
    expect(isClean(r)).toBe(false);
  });

  it("a NEW-W1d-<n> gap is known only if new-gaps.json holds it, and its wave is the one new-gaps.json gives (misrouted otherwise)", () => {
    const newGaps = parseNewGaps({ gaps: [{ id: "NEW-W1d-1", wave: "W4", title: "t", evidence: "e" }] });
    const at = (gap: string, wave: string) => triage([run([red("a|b|c|M1", "x")])], rules([{ id: "T-1", match: {}, gap, wave }]), ROUTING, LEDGER, newGaps);
    expect(isClean(at("NEW-W1d-1", "W4"))).toBe(true);
    expect(at("NEW-W1d-1", "W5").misrouted).toEqual([{ rule: "T-1", gap: "NEW-W1d-1", wave: "W5", routed: "W4" }]);
    expect(at("NEW-W1d-2", "W4").unknownGap).toEqual([{ rule: "T-1", gap: "NEW-W1d-2" }]);
  });

  it("works, refused, later, no_path, needs_ruling and planned not_run cases are never triaged; a zero-red run checks zero and is fine", () => {
    const states = CASE_STATES.filter((s) => s !== "red");
    expect(states).toHaveLength(6);
    const cases = states.map((s) => ok(`a|b|c|S-${s}`, "L3", s, s === "not_run" ? { planned: true } : {}));
    const r = triage([run(cases)], rules([]), ROUTING, LEDGER, NONE);
    expect(r).toMatchObject({ rows: [], untriaged: [], ambiguous: [], checked: 0, scanned: 6 });
    // `works` is the cases that PASSED: a refused case (a ⛔ by design) is no evidence that a gap's path was exercised and passed.
    expect(r.works).toEqual(["a|b|c|S-works"]);
    expect(isClean(r)).toBe(true);
    // The red among them is the only one that is read.
    const withRed = triage([run([...cases, red("a|b|c|M1", "x")])], rules([]), ROUTING, LEDGER, NONE);
    expect(withRed).toMatchObject({ untriaged: ["a|b|c|M1"], checked: 1, scanned: 7 });
  });

  it("each match key is its own term: a red differing from the match in that key alone is not matched, for every key", () => {
    const base = red("league|generic|default|M1", "standings: x", {}, "L3");
    // [key, a value the base satisfies, a red that differs in that key ONLY]
    const table: [string, Record<string, unknown>, CaseResult][] = [
      ["cell (row)", { cell: "league|generic" }, red("knockout|generic|default|M1", "standings: x")],
      ["cell (sport)", { cell: "league|generic" }, red("league|badminton|default|M1", "standings: x")],
      ["scenario", { scenario: "M1" }, red("league|generic|default|R4", "standings: x")],
      ["check", { check: "standings" }, red("league|generic|v2|M1", "ranks: x")],
      ["reason", { reason: "standings: x" }, red("league|generic|v3|M1", "standings: y")],
    ];
    let checked = 0;
    for (const [key, match, other] of table) {
      const r = triage([run([base, other])], rules([{ id: "T-1", match, gap: "ST-G3", wave: "W5" }]), ROUTING, LEDGER, NONE);
      expect(r.rows.map((x) => x.caseId), `${key}: the base is matched`).toEqual([base.caseId]);
      expect(r.untriaged, `${key}: the differing red is not`).toEqual([other.caseId]);
      checked++;
    }
    expect(checked).toBe(5);
    // layer: the same fields on an L1 case.
    const l1 = red("league|generic|default|M1@1280", "standings: x", {}, "L1");
    const rl = triage([run([base], "L3"), run([l1], "L1")], rules([{ id: "T-1", match: { layer: "L1" }, gap: "ST-G3", wave: "W5" }]), ROUTING, LEDGER, NONE);
    expect(rl.rows.map((x) => [x.caseId, x.layer])).toEqual([[l1.caseId, "L1"]]);
    expect(rl.untriaged).toEqual([base.caseId]);
  });

  it("the keys are ANDed, and the empty match is every red", () => {
    const a = red("league|generic|default|M1", "standings: x");
    const b = red("league|generic|default|R4", "standings: x");
    const both = triage([run([a, b])], rules([{ id: "T-1", match: { cell: "league|*", scenario: "R4" }, gap: "ST-G3", wave: "W5" }]), ROUTING, LEDGER, NONE);
    expect(both.rows.map((x) => x.caseId)).toEqual([b.caseId]);
    const all = triage([run([a, b])], rules([{ id: "T-1", match: {}, gap: "ST-G3", wave: "W5" }]), ROUTING, LEDGER, NONE);
    expect(all.rows).toHaveLength(2);
  });

  it("`check` reads FAILING checks only: a passing or abstaining check of that id, and an error red, never match", () => {
    const mk = (verdict: "pass" | "abstain" | "fail"): CaseResult => red("a|b|c|M1", "other: x", { checks: [{ id: "standings", kind: "invariant", verdict, checked: 1, reason: "", evidence: [] }, { id: "other", kind: "invariant", verdict: "fail", checked: 1, reason: "x", evidence: [] }] });
    const rule = rules([{ id: "T-1", match: { check: "standings" }, gap: "ST-G3", wave: "W5" }]);
    expect(triage([run([mk("fail")])], rule, ROUTING, LEDGER, NONE).rows).toHaveLength(1);
    expect(triage([run([mk("pass")])], rule, ROUTING, LEDGER, NONE).untriaged).toHaveLength(1);
    expect(triage([run([mk("abstain")])], rule, ROUTING, LEDGER, NONE).untriaged).toHaveLength(1);
    expect(triage([run([red("a|b|c|M1", "error: RefusedCall: x")])], rule, ROUTING, LEDGER, NONE).untriaged).toHaveLength(1);
  });

  it("a cell glob: * stays inside a segment, a literal is a literal (a dot or a plus is not a wildcard)", () => {
    const hit = (cell: string, id: string): boolean => triage([run([red(id, "x")])], rules([{ id: "T-1", match: { cell }, gap: "ST-G3", wave: "W5" }]), ROUTING, LEDGER, NONE).rows.length === 1;
    expect(hit("swiss_*|*", "swiss_knockout|chess|d|M1")).toBe(true);
    expect(hit("*|chess", "swiss|chess|d|M1")).toBe(true);
    expect(hit("sw*ss|chess", "swiss|chess|d|M1")).toBe(true);
    expect(hit("swiss|*", "swiss_knockout|chess|d|M1")).toBe(false);
    expect(hit("swiss|chess", "swiss|chess_x|d|M1")).toBe(false);
    expect(hit("sw.ss|chess", "swiss|chess|d|M1")).toBe(false);
    expect(hit("sw+iss|chess", "swiss|chess|d|M1")).toBe(false);
    // Not even a row that holds a pipe (no valid id does) lets a * reach across the separator: a*|c is not a|b|c.
    const piped = (cell: string): number => triage([run([red("x|y|z|M1", "x", { row: "a|b", sport: "c" })])], rules([{ id: "T-1", match: { cell }, gap: "ST-G3", wave: "W5" }]), ROUTING, LEDGER, NONE).rows.length;
    expect(piped("a*|c")).toBe(0);
  });

  it("rows carry the rule's id, `was` when it has one (and no key when it has none), the layer, and the run order", () => {
    const l1 = red("league|generic|default|M1@1280", "x", {}, "L1");
    const l3 = red("league|generic|default|M1", "x");
    const r = triage([run([l3], "L3"), run([l1], "L1")], rules([{ id: "T-1", match: { layer: "L3" }, gap: "ST-G3", wave: "W5", was: "P1" }, { id: "T-2", match: { layer: "L1" }, gap: "ST-G3", wave: "W5" }]), ROUTING, LEDGER, NONE);
    expect(r.rows).toEqual([
      { caseId: l3.caseId, layer: "L3", gap: "ST-G3", wave: "W5", rule: "T-1", was: "P1" },
      { caseId: l1.caseId, layer: "L1", gap: "ST-G3", wave: "W5", rule: "T-2" },
    ]);
    expect(Object.hasOwn(r.rows[1]!, "was")).toBe(false);
  });

  it("a red matched by one INVALID rule is still a row (the rule is listed misrouted); it is neither untriaged nor lost", () => {
    const r = triage([run([red("a|b|c|M1", "x")])], rules([{ id: "T-1", match: {}, gap: "SC-O1", wave: "W4" }]), ROUTING, LEDGER, NONE);
    expect(r.rows.map((x) => [x.caseId, x.gap, x.wave])).toEqual([["a|b|c|M1", "SC-O1", "W4"]]);
    expect(r.untriaged).toEqual([]);
    expect(r.checked).toBe(r.rows.length + r.untriaged.length + r.ambiguous.length);
  });

  it("works lists the case ids that passed, in run order, across every run", () => {
    const r = triage([run([ok("a|b|c|M1"), red("a|b|c|M2", "x"), ok("a|b|c|M3")], "L3"), run([ok("a|b|c|M1@1280", "L1")], "L1")], rules([]), ROUTING, LEDGER, NONE);
    expect(r.works).toEqual(["a|b|c|M1", "a|b|c|M3", "a|b|c|M1@1280"]);
    expect(r.scanned).toBe(4);
  });

  it("is pure: a second call on the same inputs answers the same, and nothing it was given moves", () => {
    const runs = [run([red("a|b|c|M1", "x"), red("a|b|c|M2", "y"), ok("a|b|c|M3")])];
    const rs = rules([{ id: "T-1", match: { reason: "x" }, gap: "ST-G3", wave: "W5" }]);
    const before = structuredClone({ runs, rs, ROUTING, LEDGER });
    const first = triage(runs, rs, ROUTING, LEDGER, NONE);
    const second = triage(runs, rs, ROUTING, LEDGER, NONE);
    expect(second).toEqual(first);
    expect({ runs, rs, ROUTING, LEDGER }).toEqual(before);
    expect(first.untriaged).toEqual(["a|b|c|M2"]);
  });

  it("refuses runs it cannot judge: two runs of one layer, one case id in two runs, a case whose layer is not its run's, and no case at all", () => {
    const rs = rules([]);
    expect(() => triage([run([ok("a|b|c|M1")], "L3"), mergedRun("L3", "r-other", [ok("a|b|c|M2")])], rs, ROUTING, LEDGER, NONE)).toThrow(/two runs of layer L3/);
    expect(() => triage([run([ok("a|b|c|M1")], "L3"), run([ok("a|b|c|M1", "L1")], "L1")], rs, ROUTING, LEDGER, NONE)).toThrow(/case a\|b\|c\|M1 is in two runs/);
    const wrong = mergedRun("L3", "r-wrong", [ok("a|b|c|M1")]);
    wrong.cases[0]!.layer = "L1";
    expect(() => triage([wrong], rs, ROUTING, LEDGER, NONE)).toThrow(/says layer L1 but sits in the L3 run/);
    expect(() => triage([], rs, ROUTING, LEDGER, NONE)).toThrow(/no run/);
    expect(() => triage([run([])], rs, ROUTING, LEDGER, NONE)).toThrow(/no case/);
    for (const f of [() => triage([], rs, ROUTING, LEDGER, NONE)]) expect(f).toThrow(TriageRefused);
  });
});

// --- rekey ---------------------------------------------------------------------------------------------------------

describe("rekey: W1-driving's red cases, each with its P-rule and its new gap", () => {
  const W1DRV = { cases: [{ caseId: "league|boardgame|default|F1", state: "red" as const }, { caseId: "knockout|generic|default|F1", state: "red" as const }, { caseId: "league|generic|default|M1", state: "works" as const }] };
  const baseline = (cases: CaseResult[], rl: Record<string, unknown>[] = [{ id: "T-1", match: { cell: "league|*" }, gap: "SC-O1", wave: "W2" }]) => triage([run(cases)], rules(rl), ROUTING, LEDGER, NONE);

  it("lists a case with its P-rule and the gap the new triage gave it", () => {
    const r = rekey(W1DRV, { "league|boardgame|default|F1": "P1" }, baseline([red("league|boardgame|default|F1", "x")]));
    expect(r).toEqual([{ caseId: "league|boardgame|default|F1", was: "P1", now: "SC-O1" }]);
  });

  it("a case with no gap says why: not red in the baseline, untriaged, ambiguous, or not in the baseline at all", () => {
    const result = baseline(
      [ok("league|boardgame|default|F1"), red("knockout|generic|default|F1", "x"), red("league_ko|generic|default|F1", "y")],
      [{ id: "T-1", match: { cell: "league_ko|*" }, gap: "SC-O1", wave: "W2" }, { id: "T-2", match: { cell: "league_ko|*" }, gap: "SC-O1", wave: "W2" }],
    );
    const w1drv = { cases: [...W1DRV.cases, { caseId: "league_ko|generic|default|F1", state: "red" as const }, { caseId: "gone|generic|default|F1", state: "red" as const }] };
    const r = rekey(w1drv, { "league|boardgame|default|F1": "P1", "knockout|generic|default|F1": "P2", "league_ko|generic|default|F1": "P3", "gone|generic|default|F1": "P4" }, result);
    expect(r).toEqual([
      { caseId: "gone|generic|default|F1", was: "P4", now: null, why: "not-in-baseline" },
      { caseId: "knockout|generic|default|F1", was: "P2", now: null, why: "untriaged" },
      { caseId: "league_ko|generic|default|F1", was: "P3", now: null, why: "ambiguous" },
      { caseId: "league|boardgame|default|F1", was: "P1", now: null, why: "not-red" },
    ]);
  });

  it("refuses a mapped case the W1-driving results do not hold, and an empty map (vacuous)", () => {
    const result = baseline([red("league|boardgame|default|F1", "x")]);
    expect(() => rekey(W1DRV, { "league|boardgame|default|F9": "P1" }, result)).toThrow(/league\|boardgame\|default\|F9 is not a case of the keyed results/);
    expect(() => rekey(W1DRV, {}, result)).toThrow(/maps no case/);
  });

  it("the reds of the W1-driving results that the map does not key are listed, so a gap in the map is seen", () => {
    expect(unkeyedReds(W1DRV, { "league|boardgame|default|F1": "P1" })).toEqual(["knockout|generic|default|F1"]);
    expect(unkeyedReds(W1DRV, { "league|boardgame|default|F1": "P1", "knockout|generic|default|F1": "P2" })).toEqual([]);
    expect(unkeyedReds({ cases: [] }, { "a|b|c|M1": "P1" })).toEqual([]);
  });
});

// --- the files: triage.json, TRIAGE.md, REKEY.md ----------------------------------------------------------------------

describe("triage.json, TRIAGE.md and REKEY.md", () => {
  const cases = [red("a|b|c|M1", "x"), red("a|b|c|M2", "x"), red("d|e|f|M1", "y"), ok("g|h|i|M1")];
  const rs = rules([
    { id: "T-1", match: { reason: "x" }, gap: "SC-O1", wave: "W2", was: "P1" },
    { id: "T-2", match: { reason: "y" }, gap: "ST-G3", wave: "W5", was: "P2" },
  ]);
  const result = triage([run(cases)], rs, ROUTING, LEDGER, NONE);
  const titles = new Map([["SC-O1", "boardgame draws in brackets"], ["ST-G3", "unequal pools"]]);

  it("triage.json is the schema's own and groups the rows by gap, with every case id and the layers", () => {
    const j = parseTriage(triageJson(result, [run(cases)], titles));
    expect(j.gaps).toEqual([
      { gap: "SC-O1", wave: "W2", title: "boardgame draws in brackets", layers: ["L3"], caseIds: ["a|b|c|M1", "a|b|c|M2"] },
      { gap: "ST-G3", wave: "W5", title: "unequal pools", layers: ["L3"], caseIds: ["d|e|f|M1"] },
    ]);
    expect(j.runs).toEqual([{ layer: "L3", runId: "r-l3", plan: "--layer L3", cases: 4, reds: 3 }]);
    expect(j).toMatchObject({ scanned: 4, checked: 3, works: ["g|h|i|M1"], untriaged: [] });
    expect(isClean(j)).toBe(true);
  });

  it("triage.json lists the gaps in wave order, numerically (W2 < W10), then by id within a wave", () => {
    const rr = triage([run([red("a|b|c|M1", "a"), red("a|b|c|M2", "b"), red("a|b|c|M3", "c")])], rules([
      { id: "T-1", match: { reason: "a" }, gap: "SW-H1", wave: "W10" },
      { id: "T-2", match: { reason: "b" }, gap: "SC-O1", wave: "W2" },
      { id: "T-3", match: { reason: "c" }, gap: "SW-H2", wave: "W10" },
    ]), parseRouting({ note: "t", routes: { "SC-O1": "W2", "SW-*": "W10" } }), LEDGER, NONE);
    expect(parseTriage(triageJson(rr, [run([])], new Map())).gaps.map((g) => [g.gap, g.wave])).toEqual([["SC-O1", "W2"], ["SW-H1", "W10"], ["SW-H2", "W10"]]);
  });

  it("a gap with cases in two layers lists both, in layer order", () => {
    const l1 = red("a|b|c|M1@1280", "x", {}, "L1");
    const rr = triage([run(cases), run([l1], "L1")], rs, ROUTING, LEDGER, NONE);
    const g = parseTriage(triageJson(rr, [run(cases), run([l1], "L1")], titles)).gaps.find((x) => x.gap === "SC-O1");
    expect(g?.layers).toEqual(["L1", "L3"]);
    expect(g?.caseIds).toHaveLength(3);
  });

  it("TRIAGE.md: one section per wave in wave order (W2 < W3 < W10, numerically), one per gap, with the case list and counts", () => {
    const ordered = triage([run([red("a|b|c|M1", "w10"), red("a|b|c|M2", "w2"), red("a|b|c|M3", "w3")])], rules([
      { id: "T-1", match: { reason: "w10" }, gap: "SH-G1", wave: "W8" },
      { id: "T-2", match: { reason: "w2" }, gap: "SC-O1", wave: "W2" },
      { id: "T-3", match: { reason: "w3" }, gap: "SW-H1", wave: "W3" },
    ]), parseRouting({ note: "t", routes: { "SH-*": "W8", "SC-O1": "W2", "SW-*": "W3" } }), LEDGER, NONE);
    const md = renderTriage(ordered, titles);
    expect(md.indexOf("## W2")).toBeGreaterThan(-1);
    expect(md.indexOf("## W2")).toBeLessThan(md.indexOf("## W3"));
    expect(md.indexOf("## W3")).toBeLessThan(md.indexOf("## W8"));
    const wide = triage([run([red("a|b|c|M1", "a"), red("a|b|c|M2", "b")])], rules([{ id: "T-1", match: { reason: "a" }, gap: "SC-O1", wave: "W2" }, { id: "T-2", match: { reason: "b" }, gap: "SW-H1", wave: "W10" }]), parseRouting({ note: "t", routes: { "SC-O1": "W2", "SW-*": "W10" } }), LEDGER, NONE);
    const w = renderTriage(wide, titles);
    expect(w.indexOf("## W2")).toBeLessThan(w.indexOf("## W10"));
    const md2 = renderTriage(result, titles);
    expect(md2).toMatch(/## W2 — 2 reds in 1 gap\n/);
    expect(md2).toMatch(/### SC-O1 — boardgame draws in brackets\n/);
    expect(md2).toContain("`a|b|c|M1` (T-1, was P1)");
    expect(md2).toContain("`d|e|f|M1` (T-2, was P2)");
    expect(md2).not.toContain("## Problems");
  });

  it("TRIAGE.md leads with the problems when there are any: untriaged, ambiguous, misrouted, unknown", () => {
    const bad = triage([run([red("a|b|c|M1", "x"), red("a|b|c|M2", "y")])], rules([
      { id: "T-1", match: { reason: "x" }, gap: "SC-O1", wave: "W4" },
      { id: "T-2", match: { reason: "x" }, gap: "SC-O1", wave: "W2" },
      { id: "T-3", match: { reason: "zzz" }, gap: "SC-Z9", wave: "W2" },
    ]), ROUTING, LEDGER, NONE);
    const md = renderTriage(bad, titles);
    expect(md).toMatch(/^# Triage[^\n]*\n\n\*\*NOT CLEAN/);
    expect(md).toContain("## Problems");
    expect(md).toContain("`a|b|c|M2`");
    expect(md).toContain("ambiguous: `a|b|c|M1` matches T-1, T-2");
    expect(md).toContain("misrouted: T-1 routes SC-O1 to W4, design §8 says W2");
    expect(md).toContain("unknown gap: T-3 names SC-Z9");
  });

  it("REKEY.md: a count per P-rule and gap, then every case; 'not red in the baseline' is said in those words", () => {
    const rows = rekey({ cases: [{ caseId: "a|b|c|M1", state: "red" }, { caseId: "a|b|c|M2", state: "red" }, { caseId: "g|h|i|M1", state: "red" }] }, { "a|b|c|M1": "P1", "a|b|c|M2": "P1", "g|h|i|M1": "P3" }, result);
    const md = renderRekey(rows, result, ["x|y|z|M1"]);
    expect(md).toContain("| P1 | SC-O1 | W2 | 2 |");
    expect(md).toContain("| P3 | not red in the baseline | — | 1 |");
    // A case id holds pipes, so in a table cell each is escaped.
    expect(md).toContain("| `a\\|b\\|c\\|M1` | P1 | SC-O1 | W2 |");
    expect(md).toContain("Reds the map does not key: 1");
    expect(md).toContain("`x|y|z|M1`");
  });
});

// --- the CLI -------------------------------------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "w1d-t18-triage-"));
let n = 0;
const fresh = (): string => { const d = join(scratch, `d${++n}`); mkdirSync(d, { recursive: true }); return d; };
const put = (name: string, body: unknown): string => { const p = join(fresh(), name); writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body)); return p; };
/** A catalogue directory: the three files the triage reads. */
function catalogue(over: { rules?: unknown; routing?: unknown; newGaps?: unknown } = {}): string {
  const d = fresh();
  writeFileSync(join(d, "triage-rules.json"), JSON.stringify(over.rules ?? { rules: [] }));
  writeFileSync(join(d, "gap-routing.json"), JSON.stringify(over.routing ?? { note: "t", routes: { "SC-O1": "W2", "ST-G3": "W5", "SW-*": "W3" } }));
  writeFileSync(join(d, "new-gaps.json"), JSON.stringify(over.newGaps ?? { gaps: [] }));
  return d;
}
/** A small audit dir holding SC-O1, ST-G3, SW-H1 and SW-H2. */
function auditDir(): string {
  const d = fresh();
  const t = (ids: string[]): string => `## Gaps\n\n| ID | Gap | Evidence | Sev |\n|---|---|---|---|\n${ids.map((id) => `| ${id} | **title of ${id}** | f.ts:1 | Med |`).join("\n")}\n`;
  writeFileSync(join(d, "SC-scoring.md"), t(["O1"]));
  writeFileSync(join(d, "ST-standings.md"), t(["G3"]));
  writeFileSync(join(d, "SW-swiss.md"), t(["H1", "H2"]));
  return d;
}
const runFile = (r: RunResults): string => put("results.json", r);

let out: string[] = [];
let err: string[] = [];
beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => { err.push(String(s)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); });
const said = (): string => `${out.join("")}${err.join("")}`;
const argsFor = (o: { runs: string[]; cat?: string; audit?: string; outDir?: string; extra?: string[] }): { argv: string[]; outDir: string } => {
  const outDir = o.outDir ?? join(fresh(), "triage-out");
  return { argv: ["--runs", ...o.runs, "--catalogue", o.cat ?? catalogue(), "--audit", o.audit ?? auditDir(), ...(o.extra ?? []), "--out", outDir], outDir };
};
const CASES = [red("a|b|c|M1", "standings: x"), red("a|b|c|M2", "round 5 paired nobody (SW-H1)"), ok("a|b|c|M3")];
const RULES_OK = { rules: [{ id: "T-1", match: { check: "standings" }, gap: "ST-G3", wave: "W5", note: "n", was: "P2" }, { id: "T-2", match: { reason: "SW-H1" }, gap: "SW-H1", wave: "W3", note: "n", was: "P6" }] };

describe("triage CLI", () => {
  it("exit 0, every red triaged: triage.json, TRIAGE.md written (no REKEY.md unless asked); the counts printed", () => {
    const { argv, outDir } = argsFor({ runs: [runFile(run(CASES))], cat: catalogue({ rules: RULES_OK }) });
    expect(main(argv), said()).toBe(0);
    expect(readdirSync(outDir).sort()).toEqual(["TRIAGE.md", "triage.json"]);
    const j = parseTriage(JSON.parse(readFileSync(join(outDir, "triage.json"), "utf8")));
    expect(j.rows.map((r) => [r.caseId, r.gap, r.wave, r.rule, r.was])).toEqual([["a|b|c|M1", "ST-G3", "W5", "T-1", "P2"], ["a|b|c|M2", "SW-H1", "W3", "T-2", "P6"]]);
    expect(j.gaps.map((g) => [g.gap, g.title])).toEqual([["SW-H1", "title of H1"], ["ST-G3", "title of G3"]]); // wave order: W3, then W5
    expect(said()).toMatch(/3 cases in 1 run; 2 reds checked: 2 triaged, 0 untriaged, 0 ambiguous/);
    expect(said()).toContain("exit 0:");
    expect(readFileSync(join(outDir, "TRIAGE.md"), "utf8")).toContain("### SW-H1 — title of H1");
  });

  it("exit 1 with untriaged reds: the files are still written and each red is named on stdout with its reason", () => {
    const { argv, outDir } = argsFor({ runs: [runFile(run(CASES))] });
    expect(main(argv)).toBe(1);
    expect(existsSync(join(outDir, "triage.json"))).toBe(true);
    expect(readFileSync(join(outDir, "TRIAGE.md"), "utf8")).toContain("**NOT CLEAN");
    expect(said()).toContain("untriaged a|b|c|M1 (L3) — standings: x");
    expect(said()).toContain("untriaged a|b|c|M2 (L3) — round 5 paired nobody (SW-H1)");
    expect(said()).toContain("2 untriaged");
  });

  it("exit 1 for an ambiguous red, a misrouted rule and a rule naming an unknown gap — each listed", () => {
    const rl = (list: Record<string, unknown>[]): unknown => ({ rules: list.map((r) => ({ note: "n", ...r })) });
    const cases: [string, unknown, RegExp][] = [
      ["ambiguous", rl([{ id: "T-1", match: {}, gap: "SW-H1", wave: "W3" }, { id: "T-2", match: { check: "standings" }, gap: "ST-G3", wave: "W5" }]), /ambiguous a\|b\|c\|M1 — T-1, T-2/],
      ["misrouted", rl([{ id: "T-1", match: {}, gap: "SC-O1", wave: "W4" }]), /misrouted T-1: SC-O1 is W2 in design §8, the rule says W4/],
      ["unknown", rl([{ id: "T-1", match: {}, gap: "SC-Z9", wave: "W2" }]), /unknown gap T-1: SC-Z9 is in neither the audit ledger nor new-gaps\.json/],
    ];
    for (const [what, rules_, re] of cases) {
      out = []; err = [];
      const { argv } = argsFor({ runs: [runFile(run(CASES))], cat: catalogue({ rules: rules_ }) });
      expect(main(argv), what).toBe(1);
      expect(said(), what).toMatch(re);
    }
  });

  it("zero reds is exit 0: the cases are counted, nothing to triage is not a fault", () => {
    const { argv } = argsFor({ runs: [runFile(run([ok("a|b|c|M1"), ok("a|b|c|M2")]))] });
    expect(main(argv)).toBe(0);
    expect(said()).toMatch(/2 cases in 1 run; 0 reds checked/);
  });

  it("--runs takes its files as positionals after the flag or as a repeated flag, and three layers together triage together", () => {
    const l1 = runFile(run([red("a|b|c|M1@1280", "standings: x", {}, "L1")], "L1"));
    const l2 = runFile(run([ok("a|b|c|M1@375", "L2")], "L2"));
    const l3 = runFile(run([red("a|b|c|M1", "standings: x")], "L3"));
    const cat = catalogue({ rules: { rules: [{ id: "T-1", match: { check: "standings" }, gap: "ST-G3", wave: "W5", note: "n" }] } });
    const a = argsFor({ runs: [l1, l2, l3], cat });
    expect(main(a.argv)).toBe(0);
    expect(parseTriage(JSON.parse(readFileSync(join(a.outDir, "triage.json"), "utf8"))).rows.map((r) => r.layer)).toEqual(["L1", "L3"]);
    out = []; err = [];
    const b = argsFor({ runs: [], cat, extra: ["--runs", l1, "--runs", l2, "--runs", l3] });
    b.argv.splice(0, 1);
    expect(main(b.argv)).toBe(0);
    expect(parseTriage(JSON.parse(readFileSync(join(b.outDir, "triage.json"), "utf8"))).runs.map((r) => r.layer)).toEqual(["L1", "L2", "L3"]);
  });

  it("exit 2 and nothing written: usage, unreadable files, a v2 run, two runs of one layer, no case at all, a missing catalogue file", () => {
    const good = runFile(run(CASES));
    const v2 = put("v2.json", { schemaVersion: 2, runId: "x", harnessCommit: "abc", startedAt: "2026-10-04T00:00:00Z", finishedAt: "2026-10-04T00:00:00Z", grid: { rows: ["league"], sports: ["generic"] }, cases: [] });
    const brokenCat = (() => { const d = catalogue(); writeFileSync(join(d, "triage-rules.json"), "{ not json"); return d; })();
    const missingCat = fresh();
    const cases: [string, string[], RegExp][] = [
      ["no flags", [], /usage: triage\.ts/],
      ["no runs", ["--runs", "--out", "x"], /usage: triage\.ts/],
      ["an unknown flag", [...argsFor({ runs: [good] }).argv, "--bogus"], /usage/],
      ["a missing run file", argsFor({ runs: [join(scratch, "nope.json")] }).argv, /RunUnreadable/],
      ["a run that is not JSON", argsFor({ runs: [put("bad.json", "{ no")] }).argv, /RunUnreadable.*not JSON/],
      ["a run the schema refuses", argsFor({ runs: [put("bad.json", { schemaVersion: 3 })] }).argv, /RunUnreadable.*not a results\.json/],
      ["a v2 run (no layer)", argsFor({ runs: [v2] }).argv, /RunNotV3/],
      ["two runs of one layer", argsFor({ runs: [good, runFile(mergedRun("L3", "other", [ok("z|z|z|M1")]))] }).argv, /two runs of layer L3/],
      ["runs that hold no case", argsFor({ runs: [runFile(run([]))] }).argv, /no case/],
      ["unreadable rules", argsFor({ runs: [good], cat: brokenCat }).argv, /CatalogueUnreadable.*triage-rules\.json/],
      ["a catalogue dir with no files", argsFor({ runs: [good], cat: missingCat }).argv, /CatalogueUnreadable/],
      ["rules the schema refuses", argsFor({ runs: [good], cat: catalogue({ rules: { rules: [{ id: "T-1" }] } }) }).argv, /CatalogueUnreadable/],
      ["--rekey without --rekey-map", argsFor({ runs: [good], extra: ["--rekey", good] }).argv, /usage/],
      ["--rekey-map without --rekey", argsFor({ runs: [good], extra: ["--rekey-map", put("m.json", { "a|b|c|M1": "P1" })] }).argv, /usage/],
      ["an audit dir with no gaps", argsFor({ runs: [good], audit: fresh() }).argv, /AuditParse.*zero gaps/],
    ];
    let refused = 0;
    for (const [what, argv, re] of cases) {
      out = []; err = [];
      const at = argv.indexOf("--out");
      expect(main(argv), what).toBe(2);
      expect(said(), what).toMatch(re);
      if (at >= 0) expect(existsSync(argv[at + 1]!), `${what}: nothing written`).toBe(false);
      refused++;
    }
    expect(refused).toBe(cases.length);
  });

  it("--rekey: REKEY.md is written with the P-rule and the new gap of each mapped case; a map the W1-driving results do not fit is exit 2", () => {
    const w1drv = runFile(run([red("a|b|c|M1", "standings: x"), red("d|e|f|M1", "gone"), ok("a|b|c|M3")]));
    const map = put("p-map.json", { "a|b|c|M1": "P2", "a|b|c|M3": "P9" });
    const cat = catalogue({ rules: RULES_OK });
    const baseline = runFile(run(CASES));
    const a = argsFor({ runs: [baseline], cat, extra: ["--rekey", w1drv, "--rekey-map", map] });
    expect(main(a.argv), said()).toBe(0);
    const md = readFileSync(join(a.outDir, "REKEY.md"), "utf8");
    expect(md).toContain("| P2 | ST-G3 | W5 | 1 |");
    expect(md).toContain("| P9 | not red in the baseline | — | 1 |");
    expect(said()).toMatch(/rekey: 2 mapped cases, 1 re-keyed, 1 with no gap in the triage/);
    out = []; err = [];
    const bad = argsFor({ runs: [baseline], cat, extra: ["--rekey", w1drv, "--rekey-map", put("p-map.json", { "q|q|q|M1": "P1" })] });
    expect(main(bad.argv)).toBe(2);
    expect(said()).toMatch(/RekeyUnknownCase/);
    expect(existsSync(bad.outDir)).toBe(false);
    out = []; err = [];
    // Each is refused BY NAME: a generic crash would also exit 2, so the exit code alone proves nothing.
    const bodies: [string | object, string][] = [["{ no", "RekeyMapUnreadable"], ["[]", "RekeyMapUnreadable"], ["{}", "RekeyMapEmpty"], [{ "a|b|c|M1": "" }, "RekeyMapUnreadable"], [{ "a|b|c|M1": 1 }, "RekeyMapUnreadable"]];
    for (const [body, name] of bodies) {
      out = []; err = [];
      const e = argsFor({ runs: [baseline], cat, extra: ["--rekey", w1drv, "--rekey-map", put("m.json", body)] });
      expect(main(e.argv), JSON.stringify(body)).toBe(2);
      expect(said(), JSON.stringify(body)).toContain(`triage: ${name}: `);
      expect(existsSync(e.outDir)).toBe(false);
    }
  });

  it("what is written and printed is redacted: a synthetic bearer token in a red's reason reaches neither a file nor stdout", () => {
    const secret = `Bearer ${"a".repeat(8)}.${"b".repeat(30)}`;
    const { argv, outDir } = argsFor({ runs: [runFile(run([red("a|b|c|M1", `error: RefusedCall: sent ${secret} to the log`)]))] });
    expect(main(argv)).toBe(1);
    for (const f of readdirSync(outDir)) expect(readFileSync(join(outDir, f), "utf8"), f).not.toContain(secret);
    expect(said()).not.toContain(secret);
  });

  it("the files are redacted too, not only stdout: a synthetic bearer token in an audit title reaches neither TRIAGE.md, triage.json nor REKEY.md", () => {
    const secret = `Bearer ${"c".repeat(8)}.${"d".repeat(30)}`;
    const d = fresh();
    writeFileSync(join(d, "ST-standings.md"), `## Gaps\n\n| ID | Gap | Evidence | Sev |\n|---|---|---|---|\n| G3 | **title with ${secret} in it** | f.ts:1 | Med |\n`);
    const w1 = runFile(run([red("a|b|c|M1", "standings: x")]));
    // The P-rule map is a person's file too: a token in one of its values reaches REKEY.md unless that is redacted.
    const { argv, outDir } = argsFor({ runs: [runFile(run([red("a|b|c|M1", "standings: x")]))], audit: d, cat: catalogue({ rules: { rules: [{ id: "T-1", match: { check: "standings" }, gap: "ST-G3", wave: "W5", note: "n" }] } }), extra: ["--rekey", w1, "--rekey-map", put("m.json", { "a|b|c|M1": `P1 ${secret}` })] });
    expect(main(argv), said()).toBe(0);
    const files = readdirSync(outDir).sort();
    expect(files).toEqual(["REKEY.md", "TRIAGE.md", "triage.json"]);
    // The title is in the triage.json and TRIAGE.md (so the scan below is not vacuous): its text, without the secret.
    expect(readFileSync(join(outDir, "TRIAGE.md"), "utf8")).toContain("### ST-G3 — title with ");
    expect(readFileSync(join(outDir, "triage.json"), "utf8")).toContain('"title": "title with ');
    expect(readFileSync(join(outDir, "REKEY.md"), "utf8")).toContain("| P1 ");
    for (const f of files) expect(readFileSync(join(outDir, f), "utf8"), f).not.toContain(secret);
    expect(said()).not.toContain(secret);
  });

  it("a long reason is cut on stdout at 160 characters, with its head kept", () => {
    const reason = `standings: ${"x".repeat(300)}`;
    const { argv } = argsFor({ runs: [runFile(run([red("a|b|c|M1", reason)]))] });
    expect(main(argv)).toBe(1);
    const line = said().split("\n").find((l) => l.startsWith("untriaged a|b|c|M1")) ?? "";
    expect(line).toContain(`— ${reason.slice(0, 160)}…`);
    expect(line).not.toContain(reason.slice(0, 161));
  });

  it("a long list is capped on stdout and complete in triage.json", () => {
    const many = Array.from({ length: 60 }, (_, i) => red(`a|b|c|M${i}`, `standings: ${i}`));
    const { argv, outDir } = argsFor({ runs: [runFile(run(many))] });
    expect(main(argv)).toBe(1);
    expect(said()).toMatch(/… and 10 more \(triage\.json has every one\)/);
    expect(parseTriage(JSON.parse(readFileSync(join(outDir, "triage.json"), "utf8"))).untriaged).toHaveLength(60);
  });
});

// --- the committed catalogue ---------------------------------------------------------------------------------------

describe("the committed catalogue files", () => {
  // Read in beforeAll, not at collection: a loader or reader that breaks on the real files must fail THESE tests by name.
  let cat: ReturnType<typeof loadCatalogue>;
  let audit: ReturnType<typeof readAudit>;
  let ids: Set<string>;
  let prefixes: Set<string>;
  beforeAll(() => {
    cat = loadCatalogue(CATALOGUE_DIR);
    audit = readAudit(AUDIT_DIR);
    ids = new Set([...audit.gaps, ...audit.umbrellas].map((g) => g.id));
    prefixes = new Set([...ids].map((id) => id.split("-")[0]!));
  });

  it("the four files exist and parse (rules, routing, new gaps through the loader; the verdicts through the ledger's parser)", () => {
    expect(Object.keys(cat).sort()).toEqual(["newGaps", "routing", "rules"]);
    expect(CATALOGUE_DIR.endsWith("tools/matrix/catalogue")).toBe(true);
    expect(existsSync(join(CATALOGUE_DIR, "audit-verdicts.json"))).toBe(true);
  });

  it("the routing has a floor and names only real audit ids and real prefixes (a typed id nobody can cite is dead)", () => {
    const keys = Object.keys(cat.routing.routes);
    expect(keys.length).toBeGreaterThanOrEqual(3);
    expect(keys).toEqual(expect.arrayContaining(["SC-O1", "SW-*", "SH-*"]));
    let checked = 0;
    for (const k of keys) {
      if (k.endsWith("-*")) expect(prefixes.has(k.slice(0, 2)), `${k}: no audit file has that prefix`).toBe(true);
      else expect(ids.has(k), `${k} is no audit id`).toBe(true);
      checked++;
    }
    expect(checked).toBe(keys.length);
    // Design §8, read by hand: SC-O1 is W2's ("boardgame/generic draws in brackets"), SW-* is W3's, SH-* is W8's.
    expect(routeOf(cat.routing, "SC-O1")).toBe("W2");
    expect(routeOf(cat.routing, "SW-H1")).toBe("W3");
    expect(routeOf(cat.routing, "SH-G7")).toBe("W8");
  });

  it("every committed rule names a gap that exists, every verdict an id that exists at the wave routing gives it (zero of each is allowed until Task 19 fills them; the loops report what they checked)", () => {
    const newIds = new Set(cat.newGaps.gaps.map((g) => g.id));
    let checked = 0;
    for (const r of cat.rules.rules) {
      expect(ids.has(r.gap) || newIds.has(r.gap), `${r.id}: ${r.gap} is no gap`).toBe(true);
      checked++;
    }
    expect(checked).toBe(cat.rules.rules.length);
    const verdicts = parseVerdicts(JSON.parse(readFileSync(join(CATALOGUE_DIR, "audit-verdicts.json"), "utf8"))).verdicts;
    const counted = new Set(audit.gaps.map((g) => g.id));
    for (const x of verdicts) {
      expect(counted.has(x.id), `${x.id} is no counted audit id`).toBe(true);
      expect(x.wave, x.id).toBe(routeOf(cat.routing, x.id));
      checked++;
    }
    expect(checked).toBe(cat.rules.rules.length + verdicts.length);
  });
});

// --- the real seam: the real committed results through the real CLI ----------------------------------------------------

describe("the real committed results (TR/w1drv-l3, w1drv-l1, w1c-l2) through the CLI (class 1: no fixture on either end)", () => {
  const L3 = join(REPO, TRUTH_RUNS, "w1drv-l3/results.json");
  const L1 = join(REPO, TRUTH_RUNS, "w1drv-l1/w1drv-l1-r1/results.json");
  const L2 = join(REPO, TRUTH_RUNS, "w1c-l2/results.json");
  type Raw = { runId: string; cases: { caseId: string; row: string; scenario: string; state: string; reason: string; checks: { id: string; verdict: string }[] }[] };
  const raw = (p: string): Raw => JSON.parse(readFileSync(p, "utf8")) as Raw;
  const R3 = raw(L3), R1 = raw(L1), R2 = raw(L2);
  const reds = (r: Raw) => r.cases.filter((c) => c.state === "red");
  const failing = (c: Raw["cases"][number]): string[] => c.checks.filter((k) => k.verdict === "fail").map((k) => k.id);
  const RULES = {
    rules: [
      { id: "T-MEX", match: { cell: "mexicano|*" }, gap: "SW-H1", wave: "W3", note: "seam test only: mexicano reds", was: "P7" },
      { id: "T-F1", match: { check: "f1-round-size" }, gap: "SW-H2", wave: "W3", note: "seam test only: f1-round-size reds" },
      { id: "T-ERR", match: { reason: "error: RefusedCall" }, gap: "SW-H2", wave: "W3", note: "seam test only: RefusedCall error reds (P5's 11)" },
    ],
  };
  const catalogue_ = (rules_: unknown): string => catalogue({ rules: rules_, routing: { note: "seam test", routes: { "SW-*": "W3", "SC-*": "W2" } } });

  it("the oracle itself reads the committed files as their own tallies say: 937 / 7 / 68 cases, 194 / 1 / 0 reds", () => {
    expect([R3.cases.length, R1.cases.length, R2.cases.length]).toEqual([937, 7, 68]);
    expect([reds(R3).length, reds(R1).length, reds(R2).length]).toEqual([194, 1, 0]);
  });

  it("every red of three real layers is read; each rule matches the reds an independent filter finds; the overlap is ambiguous, the rest untriaged", () => {
    const a = argsFor({ runs: [L1, L2, L3], cat: catalogue_(RULES), audit: AUDIT_DIR });
    expect(main(a.argv), said()).toBe(1);
    const j = parseTriage(JSON.parse(readFileSync(join(a.outDir, "triage.json"), "utf8")));
    const all = [...reds(R1), ...reds(R2), ...reds(R3)];
    expect(all).toHaveLength(195);
    expect(j.checked).toBe(195);
    expect(j.scanned).toBe(937 + 7 + 68);
    // The second implementation: which reds each rule matches, from the raw JSON.
    const mex = (c: Raw["cases"][number]): boolean => c.row === "mexicano";
    const f1 = (c: Raw["cases"][number]): boolean => failing(c).includes("f1-round-size");
    const err = (c: Raw["cases"][number]): boolean => c.reason.includes("error: RefusedCall");
    const hits = (c: Raw["cases"][number]): number => [mex(c), f1(c), err(c)].filter(Boolean).length;
    const expectAmbiguous = all.filter((c) => hits(c) >= 2).map((c) => c.caseId).sort();
    const expectRows = all.filter((c) => hits(c) === 1).map((c) => c.caseId).sort();
    const expectUntriaged = all.filter((c) => hits(c) === 0).map((c) => c.caseId).sort();
    expect(expectRows.length + expectAmbiguous.length + expectUntriaged.length).toBe(195);
    // The data must be able to tell the three outcomes apart, or this test proves nothing.
    expect(expectAmbiguous.length).toBeGreaterThan(0);
    expect(expectRows.length).toBeGreaterThan(0);
    expect(expectUntriaged.length).toBeGreaterThan(0);
    expect(j.rows.map((r) => r.caseId).sort()).toEqual(expectRows);
    expect(j.ambiguous.map((x) => x.caseId).sort()).toEqual(expectAmbiguous);
    expect(j.untriaged.slice().sort()).toEqual(expectUntriaged);
    // P5's 11 error reds are what the committed TRIAGE.md says (stepladder R4 withdraw refused).
    expect(all.filter(err)).toHaveLength(11);
    // The works list holds exactly the committed works cases: 743 + 6 + 3.
    expect(j.works).toHaveLength(743 + 6 + 3);
    expect(said()).toMatch(/195 reds checked/);
  });

  it("with no --catalogue and no --audit the committed files are read: the real reds are counted and none is lost", () => {
    const dir = join(fresh(), "defaults");
    expect(main(["--runs", L1, L2, L3, "--out", dir]), said()).toBe(1);
    const j = parseTriage(JSON.parse(readFileSync(join(dir, "triage.json"), "utf8")));
    expect(j.scanned).toBe(937 + 7 + 68);
    expect(j.checked).toBe(195);
    // Whatever the committed rules are, every red is exactly one of keyed, untriaged or ambiguous.
    expect(j.rows.length + j.untriaged.length + j.ambiguous.length).toBe(195);
    // The committed routing's own gaps are in the real audit, or the triage would have said unknown.
    expect(j.unknownGap).toEqual([]);
  });

  it("a catch-all rule triages all 195 reds (exit 0), and --rekey over the real W1-driving results lists each mapped case with the gap it now has", () => {
    const all = reds(R3);
    const sample = all.slice(0, 5).map((c) => c.caseId);
    const map = put("p-map.json", Object.fromEntries([...sample.map((id) => [id, "P1"]), [R3.cases.find((c) => c.state === "works")!.caseId, "P9"]]));
    const catAll = catalogue_({ rules: [{ id: "T-ALL", match: {}, gap: "SW-H1", wave: "W3", note: "seam test only: every red" }] });
    const a = argsFor({ runs: [L1, L2, L3], cat: catAll, audit: AUDIT_DIR, extra: ["--rekey", L3, "--rekey-map", map] });
    expect(main(a.argv), said()).toBe(0);
    const j = parseTriage(JSON.parse(readFileSync(join(a.outDir, "triage.json"), "utf8")));
    expect(j.rows).toHaveLength(195);
    expect(j.untriaged).toEqual([]);
    expect(j.gaps).toHaveLength(1);
    expect(j.gaps[0]).toMatchObject({ gap: "SW-H1", wave: "W3", layers: ["L1", "L3"] });
    expect(j.gaps[0]!.caseIds).toHaveLength(195);
    const md = readFileSync(join(a.outDir, "REKEY.md"), "utf8");
    // A case id holds pipes: in a table cell each is escaped.
    for (const id of sample) expect(md, id).toContain(`\`${id.replaceAll("|", "\\|")}\``);
    expect(md).toContain("| P1 | SW-H1 | W3 | 5 |");
    // The one mapped case that WORKS in the real results is "not red in the baseline", said so.
    expect(md).toContain("| P9 | not red in the baseline | — | 1 |");
    // 194 reds in the W1-driving file, 5 keyed: the rest are listed as unkeyed.
    expect(md).toContain("Reds the map does not key: 189");
  });
});
