// W1d Task 19 (ruling 63, ruling 70): the committed triage rules against REAL reds.
//
// fixtures/triage-shapes.json holds real reds of the third truth-run dispatches (L1, L2, L3) — one per committed rule, the
// browser layer's own, the three cells owner ruling 70 names (each from the dispatch where it is red) and the swiss_playoff
// cells that flip between two defects from one dispatch to the next — with the gap and wave an INDEPENDENT reading of each
// case's mechanism gives (W1-driving TRIAGE.md P1-P7 against the audit rows), written when the fixture was cut and never
// taken from the rules. The producer end is the real harness's output, the consumer end the real rules through the real
// `triage()`: a fixture that agreed with itself would prove the fixture (class 1).
//
// The limit this file cannot close, and says: a rule keys a RED. Ruling 70 holds three cells red whatever a dispatch shows;
// a dispatch where one is green has nothing to key. That is a property of the tooling, reported with the task, not of a rule.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { AUDIT_DIR, OUTCOMES, buildLedger, parseVerdicts, readAudit } from "../lib/audit-ledger.ts";
import { CATALOGUE_DIR, loadCatalogue, triage, triageJson, type TriageResult, type TriageRun } from "../lib/triage.ts";
import { LAYERS, type CaseResult, type Layer } from "../lib/results.ts";
import { kase, mergedRun } from "./summary-fixtures.ts";

type Pin = "row" | "sport" | "scenario" | "layer" | "reason" | "failing";
interface Shape {
  why: string; run: number; layer: Layer; caseId: string; row: string; sport: string; variant: string; scenario: string;
  width: number | null; reason: string; failing: string[]; pins?: Pin[]; expect: { gap: string; wave: string };
}
const FIXTURE = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures/triage-shapes.json"), "utf8")) as { shapes: Shape[]; flips: Shape[] };
const SHAPES = FIXTURE.shapes;
const FLIPS = FIXTURE.flips;

const asCase = (s: Shape): CaseResult => kase(s.layer, {
  caseId: s.caseId, row: s.row, sport: s.sport, variant: s.variant, scenario: s.scenario, state: "red", reason: s.reason, ...(s.width === null ? {} : { width: s.width }),
  checks: s.failing.map((id) => ({ id, kind: "invariant" as const, verdict: "fail" as const, checked: 1, reason: "x", evidence: [] })),
});
/** One run per layer holding the given shapes, plus one case that works so a layer is never empty of a green neighbour. */
const runsOf = (shapes: readonly Shape[]): TriageRun[] => {
  const layers = LAYERS.filter((l) => shapes.some((s) => s.layer === l));
  return layers.map((l) => {
    const r = mergedRun(l, `shapes-${l.toLowerCase()}`, [...shapes.filter((s) => s.layer === l).map(asCase), kase(l, { caseId: `green|x|y|M1@${l}`, scenario: "M1" })]);
    return { layer: l, runId: r.runId, plan: r.plan, cases: r.cases };
  });
};

describe("the committed triage rules over real reds (the seam: real producer output, real consumer)", () => {
  let cat: ReturnType<typeof loadCatalogue>;
  let result: TriageResult;
  let ledger: { id: string }[];
  beforeAll(() => {
    cat = loadCatalogue(CATALOGUE_DIR);
    const audit = readAudit(AUDIT_DIR);
    ledger = [...audit.gaps, ...audit.umbrellas].map((g) => ({ id: g.id }));
    result = triage(runsOf(SHAPES), cat.rules, cat.routing, ledger, cat.newGaps);
  });

  it("the fixture is non-empty, spans the three layers' reds, every case id once per layer, and each shape is a real red (anti-vacuity: counted)", () => {
    expect(SHAPES.length).toBeGreaterThanOrEqual(50);
    expect(new Set(SHAPES.map((s) => `${s.caseId}@${s.layer}`)).size).toBe(SHAPES.length);
    expect(new Set(SHAPES.map((s) => s.layer))).toEqual(new Set(["L1", "L2", "L3"]));
    for (const s of SHAPES) expect(s.reason.length, s.caseId).toBeGreaterThan(0);
    expect(result.checked).toBe(SHAPES.length);
  });

  it("every real red keys to exactly one rule: none untriaged, none ambiguous, no rule misrouted or naming an unknown gap", () => {
    expect(result.untriaged).toEqual([]);
    expect(result.ambiguous).toEqual([]);
    expect(result.misrouted).toEqual([]);
    expect(result.unknownGap).toEqual([]);
    expect(result.rows).toHaveLength(SHAPES.length);
  });

  it("each keys to the gap and wave an independent reading of its mechanism gives, and the count of each gap is what the fixture's own expectations count", () => {
    const rowOf = new Map(result.rows.map((r) => [`${r.caseId}@${r.layer}`, r]));
    let checked = 0;
    for (const s of SHAPES) {
      const r = rowOf.get(`${s.caseId}@${s.layer}`);
      expect(r, s.caseId).toBeDefined();
      expect({ gap: r!.gap, wave: r!.wave }, `${s.caseId} (${s.why})`).toEqual(s.expect);
      checked++;
    }
    expect(checked).toBe(SHAPES.length);
    const want = new Map<string, number>();
    for (const s of SHAPES) want.set(s.expect.gap, (want.get(s.expect.gap) ?? 0) + 1);
    const got = new Map<string, number>();
    for (const r of result.rows) got.set(r.gap, (got.get(r.gap) ?? 0) + 1);
    expect(got).toEqual(want);
    // Every declared NEW gap is keyed by a real red, and nothing keys a NEW id nobody declared (that would be an unknown gap above):
    // a NEW gap no red reaches is a claim the runs never made.
    expect([...got.keys()].filter((g) => g.startsWith("NEW-W1d-")).sort()).toEqual(cat.newGaps.gaps.map((g) => g.id).sort());
    expect(cat.newGaps.gaps.length).toBeGreaterThanOrEqual(5);
  });

  it("no committed rule is dead: every one keys at least one real red (a rule no red reaches is a guard nothing exercises)", () => {
    const used = new Set(result.rows.map((r) => r.rule));
    const dead = cat.rules.rules.filter((r) => !used.has(r.id)).map((r) => r.id);
    expect(dead).toEqual([]);
    expect(used.size).toBe(cat.rules.rules.length);
    expect(cat.rules.rules.length).toBeGreaterThanOrEqual(40);
  });

  /** The same cases as other dispatches showed them: triaged one dispatch at a time, since a case id is one case in a triage. */
  const flipsOf = (run: number): Shape[] => FLIPS.filter((f) => f.run === run);
  const triageDispatch = (run: number): TriageResult => triage(runsOf(flipsOf(run)), cat.rules, cat.routing, ledger, cat.newGaps);

  it("owner ruling 70: the three lots cells (swiss_knockout football, carrom, generic at R4) key to SW-H1 at W3 in whichever dispatch each is red, whatever the others show", () => {
    const named = ["swiss_knockout|football|11-a-side|R4", "swiss_knockout|carrom|club-29|R4", "swiss_knockout|generic|score|R4"];
    const seen = new Map<string, number[]>();
    let checked = 0;
    for (const run of [1, 2, 3]) {
      const r = triageDispatch(run);
      expect(r.untriaged, `dispatch ${run}`).toEqual([]);
      expect(r.ambiguous, `dispatch ${run}`).toEqual([]);
      for (const id of named) {
        const row = r.rows.find((x) => x.caseId === id);
        if (row === undefined) continue;
        expect(row, `${id} in dispatch ${run}`).toMatchObject({ gap: "SW-H1", wave: "W3" });
        seen.set(id, [...(seen.get(id) ?? []), run]);
        checked++;
      }
    }
    // Each named cell is red in at least one dispatch (so each assertion above ran), and they are NOT all red in the same one:
    // the lots flip is the reason for the ruling, and a fixture where they agreed would not witness it.
    expect([...seen.keys()].sort()).toEqual([...named].sort());
    expect(checked).toBeGreaterThanOrEqual(3);
    expect(new Set([...seen.values()].flat()).size).toBeGreaterThanOrEqual(2);
  });

  it("the two draw defects are told apart on the same cells: boardgame -> SC-O1, generic page playoff -> SC-O2; a swiss_playoff round that paired nobody is SW-H1 on either sport, a stalled playoff is the draw", () => {
    const flips = FLIPS.filter((f) => f.row === "swiss_playoff" && f.scenario === "R4");
    let sw = 0;
    let draw = 0;
    for (const run of [1, 2, 3]) {
      const r = triageDispatch(run);
      for (const f of flipsOf(run).filter((x) => x.row === "swiss_playoff")) {
        const got = r.rows.find((x) => x.caseId === f.caseId)!;
        if (f.reason.includes("paired nobody (SW-H1)")) { expect(got.gap, `${f.caseId} in dispatch ${run}`).toBe("SW-H1"); sw++; }
        else { expect(got.gap, `${f.caseId} in dispatch ${run}`).toBe(f.sport === "boardgame" ? "SC-O1" : "SC-O2"); draw++; }
      }
    }
    expect(sw + draw).toBe(flips.length);
    // Both outcomes are present, on both sports, so neither branch above is vacuous: the same cell is one defect in one dispatch and the other in the next.
    expect(sw).toBeGreaterThan(0);
    expect(draw).toBeGreaterThan(0);
    expect(new Set(flips.filter((f) => f.reason.includes("paired nobody")).map((f) => f.sport))).toEqual(new Set(["boardgame", "generic"]));
    expect(new Set(flips.filter((f) => !f.reason.includes("paired nobody")).map((f) => f.sport))).toEqual(new Set(["boardgame", "generic"]));
  });

  /** A shape's twin: the SAME red with ONE pinned segment changed to a value no real case holds (so no rule can match it by accident). */
  const TWIN_VALUE = { row: "twin-row", sport: "twin-sport", scenario: "ZZ9", failing: "twin-extra-check" } as const;
  const twinOf = (s: Shape, pin: Pin): Shape => {
    const id = `${s.caseId}~twin-${pin}`;
    switch (pin) {
      case "row": return { ...s, caseId: id, row: TWIN_VALUE.row };
      case "sport": return { ...s, caseId: id, sport: TWIN_VALUE.sport };
      case "scenario": return { ...s, caseId: id, scenario: TWIN_VALUE.scenario };
      // The same red in another layer's run (an L2 organiser-path red moved to L3 has no browser width).
      case "layer": return { ...s, caseId: id, layer: s.layer === "L3" ? "L1" : "L3", width: null };
      // Another failure of the same cell: the failing checks stay, the text is no rule's.
      case "reason": return { ...s, caseId: id, reason: `${s.failing[0] ?? "error"}: twin, a different failure of the same cell` };
      // A second, unrelated failing check beside the keyed ones (review m1).
      case "failing": return { ...s, caseId: id, failing: [...s.failing, TWIN_VALUE.failing], reason: `${s.reason}; ${TWIN_VALUE.failing}: x` };
    }
  };

  it("fails closed on every segment a rule's mechanism pins (review I1): a twin of each real red, one pinned segment changed, is untriaged — never swept into the nearest gap", () => {
    // The pins are the fixture's own (typed from each rule's mechanism when the fixture was cut), never read off the rules under test:
    // a rule loosened by deleting a segment loses its own twin only if the pins came from it.
    const twins: Shape[] = [];
    const perPin = new Map<Pin, number>();
    const covered = new Set<string>();
    for (const s of SHAPES) {
      expect(s.pins, `${s.caseId} carries its pins`).toBeDefined();
      expect(s.pins!.length, s.caseId).toBeGreaterThan(0);
      covered.add(/^rule (\S+)/.exec(s.why)![1]!);
      for (const pin of s.pins!) { twins.push(twinOf(s, pin)); perPin.set(pin, (perPin.get(pin) ?? 0) + 1); }
    }
    // Anti-vacuity: twins were made, every kind of segment has some, and every committed rule is twinned.
    expect(twins.length).toBe(SHAPES.reduce((n, s) => n + s.pins!.length, 0));
    expect(twins.length).toBeGreaterThanOrEqual(200);
    for (const pin of ["row", "sport", "scenario", "layer", "reason", "failing"] as const) expect(perPin.get(pin) ?? 0, `twins of the ${pin}`).toBeGreaterThan(0);
    expect([...covered].sort()).toEqual(cat.rules.rules.map((r) => r.id).sort());
    // The positive pair: each twin's base red keys (the sibling test), so "untriaged" below is the segment's doing and nothing else.
    expect(result.rows).toHaveLength(SHAPES.length);
    const r = triage(runsOf(twins), cat.rules, cat.routing, ledger, cat.newGaps);
    expect(r.checked).toBe(twins.length);
    expect(r.rows, "no twin is keyed").toEqual([]);
    expect(r.ambiguous).toEqual([]);
    expect(r.untriaged.slice().sort()).toEqual(twins.map((t) => t.caseId).sort());
  });

  it("every committed rule carries a closed failing set, and an `also` names a check of it (review m1)", () => {
    let closed = 0;
    for (const rule of cat.rules.rules) {
      expect(rule.match.failing, `${rule.id} closes its failing set`).toBeDefined();
      closed++;
      for (const a of rule.also ?? []) expect(rule.match.failing, `${rule.id} also ${a.check}`).toContain(a.check);
    }
    expect(closed).toBe(cat.rules.rules.length);
    expect(closed).toBeGreaterThanOrEqual(40);
    // The three rules a hidden D7 failure rides in (an L2 case of a cell no builder control builds) say so.
    expect(cat.rules.rules.filter((x) => x.also !== undefined).map((x) => [x.id, x.also![0]!.gap]).sort()).toEqual([
      ["group-pool-membership-from-results", "NEW-W1d-5"], ["page-playoff-withdraw-voids", "NEW-W1d-4"], ["stepladder-withdraw-wrong-phase", "NEW-W1d-4"],
    ]);
  });

  it("the L2 case a product defect keys also lists under the no-builder gap it fails: NEW-W1d-4 and -5 hold the three cases the first triage hid", () => {
    const jr = triageJson(result, runsOf(SHAPES), new Map());
    const co = (gap: string): string[] => (jr.gaps.find((g) => g.gap === gap)?.alsoCaseIds ?? []).slice().sort();
    // The shapes are one red per rule, so each of the three co-failing L2 rules shows once; the real dispatches show these ids (new-gaps.json).
    expect(co("NEW-W1d-4").map((c) => c.split("|")[0])).toEqual(["page_playoff_only", "stepladder_only"]);
    expect(co("NEW-W1d-5").map((c) => c.split("|")[0])).toEqual(["group_group_ko"]);
    for (const c of [...co("NEW-W1d-4"), ...co("NEW-W1d-5")]) expect(result.rows.find((x) => x.caseId === c)?.layer, c).toBe("L2");
  });

  it("the committed verdicts and the committed rules account for every audit id exactly once: a clean ledger over the real reds' triage (150 ids, none missing, none twice, no verdict at a wave the routing does not give)", () => {
    const audit = readAudit(AUDIT_DIR);
    const verdicts = parseVerdicts(JSON.parse(readFileSync(resolve(CATALOGUE_DIR, "audit-verdicts.json"), "utf8"))).verdicts;
    const runs = runsOf(SHAPES);
    const ledger = buildLedger({
      gaps: audit.gaps, umbrellas: audit.umbrellas, routing: cat.routing, triage: triageJson(result, runs, new Map()), verdicts,
      // No committed verdict is a failing-test witness yet; a reader that returned text for one would hide a missing file.
      readFile: () => null,
    });
    expect(ledger.findings).toEqual([]);
    expect(ledger.entries).toHaveLength(audit.gaps.length);
    expect(audit.gaps.length).toBe(150);
    // The expected reproduced set is the fixture's own: the audit ids its independently-read expectations name, never the ledger's.
    const wantReproduced = new Set(SHAPES.map((s) => s.expect.gap).filter((g) => !g.startsWith("NEW-W1d-")));
    expect(wantReproduced.size).toBeGreaterThanOrEqual(7);
    expect(new Set(ledger.entries.filter((e) => e.outcome === "reproduced").map((e) => e.id))).toEqual(wantReproduced);
    expect(ledger.counts.reproduced).toBe(wantReproduced.size);
    expect(verdicts).toHaveLength(audit.gaps.length - wantReproduced.size);
    expect(OUTCOMES.reduce((n, o) => n + ledger.counts[o], 0)).toBe(audit.gaps.length);
    expect(ledger.entries.every((e) => e.outcomes.length === 1)).toBe(true);
  });

  it("fails closed: a red of a known cell with a reason no rule knows is untriaged, not swept into the nearest gap (m9)", () => {
    const base = { ...SHAPES.find((s) => s.row === "knockout" && s.sport === "boardgame")!, scenario: "M1" };
    expect(base.caseId, "a knockout boardgame shape").toBeDefined();
    const unknown: Shape[] = [
      { ...base, caseId: "knockout|boardgame|blitz|M1", variant: "blitz", reason: "I1-rr-pair-once-per-leg: a|b appears twice", failing: ["I1-rr-pair-once-per-leg"], expect: base.expect },
      // the scenario matters as much as the cell: the same stall text at an R4 the withdrawal owns is not a draw
      { ...SHAPES.find((s) => s.row === "page_playoff_only" && s.scenario === "M1" && s.sport === "boardgame")!, caseId: "page_playoff_only|boardgame|blitz|F1", scenario: "F1" },
      { ...base, caseId: "knockout|football|11-a-side|M1", sport: "football", variant: "11-a-side" },
    ];
    const r = triage(runsOf(unknown), cat.rules, cat.routing, ledger, cat.newGaps);
    expect(r.checked).toBe(3);
    expect(r.untriaged.slice().sort()).toEqual(unknown.map((s) => s.caseId).sort());
    expect(r.rows).toEqual([]);
  });
});
