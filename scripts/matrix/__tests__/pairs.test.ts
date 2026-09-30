// The L2 pair file (design §6.2, W1b Task 7). State transitions and empty
// cases first (TEST-STRATEGY rule 1): a scenario that applies nowhere, an empty
// or unknown `only`, an empty or partial `variants`, a missing rule, a second
// plan, the same inputs in another order, one scenario planned alone, a pair
// whose only drop is an L3 harness gap (controller ruling, T7 dispatch: L2
// plans it and marks it), another sport (every sweep walks the registry).
// A withdrawal or void is not an input here: the planner is a pure function of
// the rules, the catalogue and the committed variants.
// Expected values come from applicability.ts's own `decide` (its `applies` and
// `gapped` answers), the catalogue and apps/web/playwright.config.ts — never
// from pairs.ts.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS, type RowKey } from "../lib/catalogue.ts";
import { MissingRule, RULES, decide, gapReason, type Rule } from "../lib/applicability.ts";
import { GapUnbound, L2_WIDTHS, UnknownL2Scenario, VariantsIncomplete, planL2, type L2Run } from "../lib/pairs.ts";
import { routeTo } from "../lib/routing.ts";
import { l2Atomic, l3Atomic } from "../lib/scenario-catalogue.ts";
import { buildSportVariants, offlineBuilderDefault } from "../lib/variants.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const variants = SPORT_KEYS.map((s) => buildSportVariants(s));
const plan = planL2({ variants });
const L2_IDS = l2Atomic().map((a) => a.id);

/** What L2 owes one (row, sport) for a rule, judged from applicability.ts's
 *  `decide` alone: it applies (L3 plans it too), or its ONLY drop is the
 *  rule's harness gap (`gapped` non-empty — L2 plans it, marked), or it is
 *  genuinely inapplicable (null: never planned). A gap-only pair binds where
 *  decide found the gap first: its builder default, else that variant. */
type Owed = { readonly gap: string | null; readonly preset: string; readonly bound: string | null };
function owed(r: Rule, row: RowKey, sport: string): Owed | null {
  const d = decide(r, row, sport, variants);
  if (d.applies) return { gap: null, preset: d.preset, bound: d.bound };
  if (r.gap === undefined || d.gapped.length === 0) return null;
  const first = d.gapped[0]!;
  const def = offlineBuilderDefault(sport);
  if (first === `${def} (builder default)`) return { gap: gapReason(r.gap), preset: def, bound: null };
  const vc = variants.find((v) => v.sport === sport)!.cases.find((c) => c.id === first);
  expect(vc, `${row}|${sport}: gapped id ${first} is neither the default nor a committed variant`).toBeDefined();
  return { gap: gapReason(r.gap), preset: vc!.preset, bound: first };
}
const TRUTH = new Map<string, Map<string, Owed>>(L2_IDS.map((id) => {
  const m = new Map<string, Owed>();
  for (const row of ROW_KEYS) for (const s of SPORT_KEYS) {
    const o = owed(RULES[id]!, row, s);
    if (o !== null) m.set(`${row}|${s}`, o);
  }
  return [id, m];
}));
const owedRows = (id: string): RowKey[] => ROW_KEYS.filter((row) => SPORT_KEYS.some((s) => TRUTH.get(id)!.has(`${row}|${s}`)));
const owedSports = (id: string): string[] => SPORT_KEYS.filter((s) => ROW_KEYS.some((row) => TRUTH.get(id)!.has(`${row}|${s}`)));
const strip = (r: L2Run) => ({ scenario: r.scenario, row: r.row, sport: r.sport, preset: r.preset, bound: r.bound, covers: r.covers, l3Gap: r.l3Gap });

describe("L2 pair file", () => {
  it("the seven widths are the Playwright mobile viewport widths (W1c confirms, O3)", () => {
    const cfg = readFileSync(resolve(REPO, "apps/web/playwright.config.ts"), "utf8");
    const widths = [...cfg.matchAll(/viewport: \{ width: (\d+)/g)].map((m) => Number(m[1])).filter((w) => w < 1000);
    expect(widths.length).toBeGreaterThan(0);
    expect([...new Set(widths)].sort((a, b) => a - b)).toEqual([...L2_WIDTHS]);
  });

  it("empty case first: a scenario that applies nowhere gets zero runs and is reported, not hidden", () => {
    const id = l2Atomic()[0]!.id;
    const p = planL2({ variants, rules: { ...RULES, [id]: { ...RULES[id]!, when: () => false, variantDependent: false } }, only: [id] });
    expect(p.runs).toEqual([]);
    expect(p.perScenario[id]).toBe(0);
    expect(p.targets).toEqual({ rowScenario: 0, sportScenario: 0 });
  });

  it("refuses an empty, unknown or L3-only `only`, and a missing rule — never an empty plan that reads green", () => {
    expect(() => planL2({ variants, only: [] })).toThrow(UnknownL2Scenario);
    expect(() => planL2({ variants, only: [] })).toThrow(/'only' is empty/);
    expect(() => planL2({ variants, only: ["M99"] })).toThrow(UnknownL2Scenario);
    // E2 is an atom, but L3-only (the API path has no browser counterpart).
    const l3Only = l3Atomic().map((a) => a.id).filter((id) => !L2_IDS.includes(id));
    expect(l3Only.length).toBeGreaterThan(0);
    for (const id of l3Only) expect(() => planL2({ variants, only: [id] }), id).toThrow(UnknownL2Scenario);
    expect(planL2({ variants, only: ["M1"] }).runs.length).toBeGreaterThan(0);
    const { M1: _gone, ...noM1 } = RULES;
    expect(() => planL2({ variants, rules: noM1, only: ["M1"] })).toThrow(MissingRule);
  });

  it("refuses an empty or partial `variants` — decide reads a missing sport as 'no variants' and would plan less, silently", () => {
    expect(() => planL2({ variants: [] })).toThrow(VariantsIncomplete);
    let checked = 0;
    for (const s of SPORT_KEYS) {
      expect(() => planL2({ variants: variants.filter((v) => v.sport !== s), only: ["M1"] }), s).toThrow(new RegExp(`missing: ${s}\\b`));
      checked++;
    }
    expect(checked).toBe(SPORT_KEYS.length);
    const first = variants[0]!;
    expect(() => planL2({ variants: [...variants, first], only: ["M1"] })).toThrow(new RegExp(`duplicated: ${first.sport}\\b`));
    expect(() => planL2({ variants: [...variants, { ...first, sport: "quidditch" }], only: ["M1"] })).toThrow(/unknown: quidditch\b/);
  });

  it("every owed (row, scenario) and (sport, scenario) pair is covered by an owed run — counted", () => {
    let judged = 0;
    let runsChecked = 0;
    for (const id of L2_IDS) {
      const truth = TRUTH.get(id)!;
      const runs = plan.runs.filter((x) => x.scenario === id);
      for (const row of owedRows(id)) { judged++; expect(runs.some((x) => x.row === row), `${id} row ${row}`).toBe(true); }
      for (const s of owedSports(id)) { judged++; expect(runs.some((x) => x.sport === s), `${id} sport ${s}`).toBe(true); }
      // A genuinely inapplicable pair (neither applies nor gap-only) is never planned.
      for (const x of runs) { runsChecked++; expect(truth.has(`${x.row}|${x.sport}`), `${id} ${x.row}|${x.sport} is not owed`).toBe(true); }
    }
    expect(judged).toBe(plan.targets.rowScenario + plan.targets.sportScenario);
    expect(judged).toBeGreaterThan(0);
    expect(runsChecked).toBe(plan.runs.length);
    console.info(`pairs: ${judged} owed pairs judged (${plan.targets.rowScenario} row + ${plan.targets.sportScenario} sport), ${runsChecked} runs checked`);
  });

  it("a run carries the pair's decision: preset and bound as decide binds them, l3Gap only where the gap is the ONLY drop", () => {
    let gapRuns = 0;
    for (const x of plan.runs) {
      const o = TRUTH.get(x.scenario)!.get(`${x.row}|${x.sport}`)!;
      expect({ preset: x.preset, bound: x.bound, l3Gap: x.l3Gap }, `${x.scenario} ${x.row}|${x.sport}`).toEqual({ preset: o.preset, bound: o.bound, l3Gap: o.gap });
      if (x.l3Gap !== null) gapRuns++;
    }
    // Anti-vacuity: the gap arm is live in today's catalogue (M5, a cricket
    // tie in a bracket — Rule.gap). If W1-driving gives the generator a tie
    // outcome this legitimately reaches zero: then drop this line, the
    // synthetic gap test below still drives the arm.
    const gapOwed = L2_IDS.reduce((n, id) => n + [...TRUTH.get(id)!.values()].filter((o) => o.gap !== null).length, 0);
    expect(gapOwed).toBeGreaterThan(0);
    expect(gapRuns).toBeGreaterThan(0);
    console.info(`pairs: ${plan.runs.length} runs checked against decide, ${gapRuns} marked l3Gap (${gapOwed} gap-only pairs owed)`);
  });

  it("a gap-only pair is planned and marked; a genuinely inapplicable pair stays dropped (synthetic rule, every cell)", () => {
    // single-sport: the rule applies to ONE sport so the other ten witness the drop; it sweeps every row and cell.
    const id = "M1";
    const one = SPORT_KEYS[SPORT_KEYS.length - 1]!;
    const gapped: Rule = { when: (f) => f.sport === one, reason: "only one sport", variantDependent: false, witness: null, gap: { when: () => true, route: routeTo("W1-driving", "synthetic L3 gap") } };
    const p = planL2({ variants, rules: { ...RULES, [id]: gapped }, only: [id] });
    expect(p.runs.length).toBe(ROW_KEYS.length); // one per row, all on the one sport
    expect(p.targets).toEqual({ rowScenario: ROW_KEYS.length, sportScenario: 1 });
    for (const x of p.runs) {
      expect(x.sport).toBe(one);
      // The committed text: the why, then the wave it is routed to (l2-pairs.json's shape).
      expect(x.l3Gap).toBe("synthetic L3 gap — routed W1-driving");
      expect({ preset: x.preset, bound: x.bound }).toEqual({ preset: offlineBuilderDefault(one), bound: null });
    }
    // The same rule with no gap planned there: identical runs, none marked.
    const open = planL2({ variants, rules: { ...RULES, [id]: { ...gapped, gap: { when: () => false, route: routeTo("W1-driving", "never") } } }, only: [id] });
    expect(open.runs.map((x) => ({ ...x, l3Gap: "synthetic L3 gap — routed W1-driving" }))).toEqual(p.runs);
    expect(open.runs.every((x) => x.l3Gap === null)).toBe(true);
  });

  it("a gap-only pair that only a committed variant enables binds to that variant, not the builder default — every sport", () => {
    // Per sport: its first scorable committed variant off the builder-default
    // preset, in committed order (the order decide walks).
    const id = "M1";
    let checked = 0;
    for (const v of variants) {
      const vc = v.cases.find((c) => c.preset !== offlineBuilderDefault(v.sport) && c.scorable === null);
      if (vc === undefined) continue;
      const r: Rule = { when: (f) => f.sport === v.sport && f.preset !== offlineBuilderDefault(v.sport), reason: "off-default preset", variantDependent: true, witness: null, gap: { when: () => true, route: routeTo("W2", "variant gap") } };
      const p = planL2({ variants, rules: { ...RULES, [id]: r }, only: [id] });
      expect(p.runs.length, v.sport).toBe(ROW_KEYS.length);
      for (const x of p.runs) expect({ sport: x.sport, preset: x.preset, bound: x.bound, l3Gap: x.l3Gap }, `${v.sport} ${x.row}`).toEqual({ sport: v.sport, preset: vc.preset, bound: vc.id, l3Gap: "variant gap — routed W2" });
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    console.info(`pairs: variant-bound gap checked on ${checked} of ${variants.length} sports`);
  });

  it("greedy, registry order: row runs walk ROW_KEYS taking the first uncovered sport, else the row's first; leftover sports take their first row", () => {
    let checked = 0;
    for (const id of L2_IDS) {
      const truth = TRUTH.get(id)!;
      const runs = plan.runs.filter((x) => x.scenario === id);
      const rowRuns = runs.filter((x) => x.covers.includes("row"));
      expect(rowRuns.map((x) => x.row), id).toEqual(owedRows(id));
      const covered = new Set<string>();
      for (const x of rowRuns) {
        const offered = SPORT_KEYS.filter((s) => truth.has(`${x.row}|${s}`));
        const fresh = offered.filter((s) => !covered.has(s));
        expect(x.sport, `${id} ${x.row}`).toBe(fresh.length > 0 ? fresh[0] : offered[0]);
        covered.add(x.sport);
        checked++;
      }
      const sportRuns = runs.filter((x) => !x.covers.includes("row"));
      expect(sportRuns.map((x) => x.sport), id).toEqual(owedSports(id).filter((s) => !covered.has(s)));
      for (const x of sportRuns) {
        expect(x.row, `${id} ${x.sport}`).toBe(ROW_KEYS.find((row) => truth.has(`${row}|${x.sport}`)));
        checked++;
      }
      // Row runs first, then the leftover sports.
      expect(runs.map((x) => x.covers.includes("row")), id).toEqual(runs.map((_, i) => i < rowRuns.length));
    }
    expect(checked).toBe(plan.runs.length);
  });

  it("refuses a pair decide reports gapped that does not apply once the gap is lifted (the binding would be invented)", () => {
    // single-sport: the flip answers yes once, at the first cell decided — one cell by construction.
    const id = "M1";
    let calls = 0;
    // Answers yes only on its first call: decide sees it apply under the gap,
    // then the gap-lifted decision sees it not apply.
    const flip: Rule = { when: () => calls++ === 0, reason: "flip", variantDependent: false, witness: null, gap: { when: () => true, route: routeTo("W2", "g") } };
    expect(() => planL2({ variants, rules: { ...RULES, [id]: flip }, only: [id] })).toThrow(GapUnbound);
    expect(calls).toBe(2);
  });

  it("covers: each owed row and sport is claimed by exactly one run, every run claims something, runs per scenario are bounded", () => {
    let checked = 0;
    for (const id of L2_IDS) {
      const runs = plan.runs.filter((x) => x.scenario === id);
      const rows = owedRows(id);
      const sports = owedSports(id);
      for (const row of rows) expect(runs.filter((x) => x.row === row && x.covers.includes("row")).length, `${id} row ${row}`).toBe(1);
      for (const s of sports) expect(runs.filter((x) => x.sport === s && x.covers.includes("sport")).length, `${id} sport ${s}`).toBe(1);
      expect(runs.filter((x) => x.covers.includes("row")).length, id).toBe(rows.length);
      expect(runs.filter((x) => x.covers.includes("sport")).length, id).toBe(sports.length);
      for (const x of runs) expect(x.covers.length, `${id} ${x.row}|${x.sport} claims nothing`).toBeGreaterThan(0);
      expect(runs.length, id).toBeGreaterThanOrEqual(Math.max(rows.length, sports.length));
      expect(runs.length, id).toBeLessThanOrEqual(rows.length + sports.length);
      checked++;
    }
    expect(checked).toBe(L2_IDS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("every L2 scenario has at least one run (the L2 half of trap 1), and perScenario reports every one", () => {
    expect(Object.keys(plan.perScenario)).toEqual(L2_IDS);
    for (const id of L2_IDS) {
      expect(plan.perScenario[id] ?? 0, id).toBeGreaterThan(0);
      expect(plan.perScenario[id], id).toBe(plan.runs.filter((x) => x.scenario === id).length);
    }
    const counts = Object.values(plan.perScenario);
    console.info(`pairs: ${L2_IDS.length} scenarios, runs per scenario min ${Math.min(...counts)} max ${Math.max(...counts)}`);
  });

  it("widths rotate: each width's share differs from another's by at most one; n is 1..runs", () => {
    const by = L2_WIDTHS.map((w) => plan.runs.filter((r) => r.width === w).length);
    expect(Math.max(...by) - Math.min(...by)).toBeLessThanOrEqual(1);
    expect(by.reduce((a, b) => a + b, 0)).toBe(plan.runs.length);
    expect(plan.runs.map((r) => r.n)).toEqual(plan.runs.map((_, i) => i + 1));
    console.info(`pairs: runs per width ${L2_WIDTHS.map((w, i) => `${w}:${by[i]}`).join(" ")}`);
  });

  it("widths rotate within a scenario: consecutive runs change width, and k runs see min(k, 7) widths", () => {
    let checked = 0;
    for (const id of L2_IDS) {
      const ws = plan.runs.filter((x) => x.scenario === id).map((x) => x.width);
      for (let i = 1; i < ws.length; i++) expect(ws[i], `${id} run ${i + 1}`).not.toBe(ws[i - 1]);
      expect(new Set(ws).size, id).toBe(Math.min(ws.length, L2_WIDTHS.length));
      checked++;
    }
    expect(checked).toBe(L2_IDS.length);
  });

  it("widths spread per format and per sport (controller ruling, fix round 1): every row and every sport runs at every width — all (row, width) and (sport, width) pairs checked, none skipped", () => {
    const spread = (axis: string, keys: readonly string[], key: (x: L2Run) => string) => {
      let checked = 0;
      let min = Infinity;
      const skipped: string[] = [];
      for (const k of keys) {
        const runs = plan.runs.filter((x) => key(x) === k);
        // A key with fewer runs than widths cannot meet every width: it is
        // listed, and the exact-count assertion below reds on it (R-M1).
        if (runs.length < L2_WIDTHS.length) { skipped.push(`${k} (${runs.length} runs)`); continue; }
        for (const w of L2_WIDTHS) {
          const c = runs.filter((x) => x.width === w).length;
          expect(c, `${axis} ${k} never runs at ${w}`).toBeGreaterThan(0);
          min = Math.min(min, c);
          checked++;
        }
      }
      return { checked, min, skipped };
    };
    const rows = spread("row", ROW_KEYS, (x) => x.row);
    const sports = spread("sport", SPORT_KEYS, (x) => x.sport);
    // R-M1 (T7 re-review): the ruling is every row and every sport, so the
    // counts are exact — ROW_KEYS × widths and SPORT_KEYS × widths.
    expect(rows.skipped, "rows with fewer runs than widths").toEqual([]);
    expect(sports.skipped, "sports with fewer runs than widths").toEqual([]);
    expect(rows.checked).toBe(ROW_KEYS.length * L2_WIDTHS.length);
    expect(sports.checked).toBe(SPORT_KEYS.length * L2_WIDTHS.length);
    expect(rows.checked).toBeGreaterThan(0);
    expect(sports.checked).toBeGreaterThan(0);
    console.info(`pairs: (row, width) ${rows.checked} checked, min ${rows.min}; (sport, width) ${sports.checked} checked, min ${sports.min}`);
  });

  it("mobile-first: the rotation starts at the narrowest width, so a one-run plan runs at 320", () => {
    // single-sport: a one-run plan is the point — the first cell alone.
    const narrowest = Math.min(...L2_WIDTHS);
    expect(plan.runs[0]!.width).toBe(narrowest);
    const id = "M1";
    const cell: Rule = { when: (f) => f.row === ROW_KEYS[0] && f.sport === SPORT_KEYS[0], reason: "one cell", variantDependent: false, witness: null };
    const p = planL2({ variants, rules: { ...RULES, [id]: cell }, only: [id] });
    expect(p.runs.map((x) => [x.n, x.width])).toEqual([[1, narrowest]]);
  });

  it("deterministic: a second plan is byte-identical", () => {
    expect(JSON.stringify(planL2({ variants }))).toBe(JSON.stringify(plan));
  });

  it("deterministic across input order: reversed variants, rules and `only` plan byte-identically (registry order, never the caller's)", () => {
    const base = JSON.stringify(plan);
    const reversedRules = Object.fromEntries(Object.entries(RULES).reverse());
    expect(Object.keys(reversedRules)[0]).not.toBe(Object.keys(RULES)[0]);
    expect(JSON.stringify(planL2({ variants: [...variants].reverse() }))).toBe(base);
    expect(JSON.stringify(planL2({ variants, only: [...L2_IDS].reverse() }))).toBe(base);
    expect(JSON.stringify(planL2({ variants: [...variants].reverse(), rules: reversedRules, only: [...L2_IDS].reverse() }))).toBe(base);
  });

  it("a scenario planned alone gets the same cover as inside the full plan (no state leaks between scenarios)", () => {
    let checked = 0;
    for (const id of L2_IDS) {
      const alone = planL2({ variants, only: [id] });
      expect(alone.runs.map(strip), id).toEqual(plan.runs.filter((x) => x.scenario === id).map(strip));
      expect(alone.perScenario, id).toEqual({ [id]: plan.perScenario[id] });
      checked++;
    }
    expect(checked).toBe(L2_IDS.length);
  });
});
