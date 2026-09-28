// The w1b-probe set (W1b Task 10). Expected values come from the catalogue's
// row registry, the text-pinned product gate map (format-gates-copy.ts) and
// the COMMITTED variants.json — never from probe-set.ts itself.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_ONLY_ROWS, ROW_KEYS, stagesForRow } from "../lib/catalogue.ts";
import { expectedGate } from "../lib/format-gates-copy.ts";
import {
  BoundVariantUnscorable, NoProbeVariant, PROBE_API_ROWS, PROBE_SET, SetTakesNoFilter, makeProbePlanner, pickProbeVariant, probePlanner, requireScorable,
} from "../lib/probe-set.ts";
import { resolveSportCfg } from "../lib/sport-cfg.ts";
import { SLICE_ROWS, SLICE_SPORTS } from "../lib/slice.ts";
import { offlineBuilderDefault, scorable, type VariantCase } from "../lib/variants.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
interface Committed { sports: { sport: string; cases: VariantCase[] }[] }
const committed = JSON.parse(readFileSync(resolve(REPO, "scripts/matrix/catalogue/variants.json"), "utf8")) as Committed;
const casesOf = (sport: string): VariantCase[] => {
  const s = committed.sports.find((x) => x.sport === sport);
  if (s === undefined) throw new Error(`test: variants.json has no sport '${sport}'`);
  return s.cases;
};
const specs = probePlanner({ set: PROBE_SET }).plan(offlineBuilderDefault);

describe("the w1b-probe set", () => {
  it("names its set and needs the DB's variant order for generic and badminton only", () => {
    expect(PROBE_SET).toBe("w1b-probe");
    expect([...probePlanner({ set: PROBE_SET }).sports]).toEqual(["generic", "badminton"]);
    expect(probePlanner({ set: PROBE_SET }).deniesFeatures).toBe(true);
  });
  it("API-only LIFECYCLE: exactly the single-stage, ungated API-only rows, on generic (multi-stage stays deferred to W1-driving)", () => {
    // single-sport: the rows' shapes are sport-independent; generic is the cheapest sport to drive.
    const want = API_ONLY_ROWS.filter((r) => stagesForRow(r).length === 1 && expectedGate(stagesForRow(r)) === null);
    expect(want.length).toBeGreaterThan(0);
    // The filter has something to drop on both sides: a multi-stage API-only
    // row, and a gated one (else the test could not see either filter go).
    expect(API_ONLY_ROWS.some((r) => stagesForRow(r).length > 1)).toBe(true);
    expect(API_ONLY_ROWS.some((r) => stagesForRow(r).length === 1 && expectedGate(stagesForRow(r)) !== null)).toBe(true);
    expect([...PROBE_API_ROWS]).toEqual(want);
    const got = specs.filter((s) => s.scenario === "LIFECYCLE" && s.overrides === undefined);
    expect(got.map((s) => s.row)).toEqual(want);
    expect(got.every((s) => s.sport === "generic" && s.deny === undefined)).toBe(true);
  });
  it("DENIED: one case per gated row in registry order, each denying exactly its own gate", () => {
    const gated = ROW_KEYS.filter((r) => expectedGate(stagesForRow(r)) !== null);
    expect(gated.length).toBe(7); // false premise 7: seven gated rows today
    const got = specs.filter((s) => s.scenario === "DENIED");
    expect(got.map((s) => s.row)).toEqual(gated);
    for (const s of got) expect(s.deny).toEqual([expectedGate(stagesForRow(s.row))]);
    expect(got.every((s) => s.sport === "generic" && s.overrides === undefined)).toBe(true);
  });
  it("variant LIFECYCLE: per sport, the FIRST committed case with a non-empty override, scorable, on a slice row", () => {
    let n = 0;
    for (const sport of ["generic", "badminton"]) {
      const want = casesOf(sport).find((c) => Object.keys(c.overrides).length > 0 && c.scorable === null && (SLICE_ROWS as readonly string[]).includes(c.row));
      expect(want, `${sport}: no committed variant case qualifies`).toBeDefined();
      const got = specs.find((s) => s.sport === sport && s.overrides !== undefined)!;
      expect({ row: got.row, variant: got.variant, overrides: got.overrides }).toEqual({ row: want!.row, variant: want!.preset, overrides: want!.overrides });
      expect(got.caseId.endsWith(`|${want!.id}`)).toBe(true);
      expect(got.scenario).toBe("LIFECYCLE");
      expect(got.deny).toBeUndefined();
      n++;
    }
    expect(n).toBe(2);
  });
  it("each bound variant's override CHANGES the cfg it scores under (else the case proves nothing a default case does not)", () => {
    const bound = specs.filter((s) => s.overrides !== undefined);
    expect(bound.length).toBe(2);
    for (const s of bound) expect(resolveSportCfg(s.sport, s.variant, { ...s.overrides })).not.toEqual(resolveSportCfg(s.sport, s.variant));
  });
  it("case ids are unique; the whole set is the three parts and nothing else", () => {
    expect(new Set(specs.map((s) => s.caseId)).size).toBe(specs.length);
    expect(specs.length).toBe(PROBE_API_ROWS.length + 7 + 2);
    expect(specs.every((s) => s.canary === false)).toBe(true);
  });
  it("the API and DENIED cases take the LIVE builder default; the variant cases keep their committed preset", () => {
    const asked: string[] = [];
    const live = probePlanner({ set: PROBE_SET }).plan((s) => { asked.push(s); return `live-${s}`; });
    const plain = live.filter((s) => s.overrides === undefined);
    expect(plain.length).toBe(PROBE_API_ROWS.length + 7);
    expect(plain.every((s) => s.variant === "live-generic" && s.caseId.includes("|live-generic|"))).toBe(true);
    const bound = live.filter((s) => s.overrides !== undefined);
    expect(bound.map((s) => s.variant)).toEqual(SLICE_SPORTS.map((sp) => casesOf(sp).find((c) => Object.keys(c.overrides).length > 0 && c.scorable === null && (SLICE_ROWS as readonly string[]).includes(c.row))!.preset));
    // Only declared sports are asked about.
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((s) => probePlanner({ set: PROBE_SET }).sports.includes(s))).toBe(true);
  });
  it("a second planner and a second plan are identical (no clock, no randomness)", () => {
    expect(probePlanner({ set: PROBE_SET }).plan(offlineBuilderDefault)).toEqual(specs);
    const p = probePlanner({ set: PROBE_SET });
    expect(p.plan(offlineBuilderDefault)).toEqual(p.plan(offlineBuilderDefault));
  });
  it("a filter handed to the set is refused by name, never silently ignored", () => {
    for (const cli of [{ only: "league|generic" }, { scenario: "M1" }, { canary: "M1" }, { only: "" }]) {
      expect(() => probePlanner({ set: PROBE_SET, ...cli })).toThrow(SetTakesNoFilter);
    }
  });
});

describe("pickProbeVariant — the selection rule, empty case first", () => {
  const base = casesOf("generic").find((c) => Object.keys(c.overrides).length > 0 && c.scorable === null && (SLICE_ROWS as readonly string[]).includes(c.row))!;
  it("no cases at all is a named refusal", () => {
    expect(() => pickProbeVariant("generic", [])).toThrow(NoProbeVariant);
  });
  it.each<[string, Partial<VariantCase>]>([
    ["an empty override", { overrides: {} }],
    ["a recorded unscorable reason", { scorable: "win-home: EngineError: nope" }],
    ["an API-only row", { row: "group_only" }],
    ["a template row outside the slice", { row: "triple_rr" }],
  ])("a case with %s alone does not qualify", (_what, over) => {
    expect(() => pickProbeVariant("generic", [{ ...base, ...over }])).toThrow(NoProbeVariant);
  });
  it("the FIRST qualifying case in file order wins, past ones that do not qualify", () => {
    const second = { ...base, id: "generic#999" };
    expect(pickProbeVariant("generic", [{ ...base, id: "generic#000", overrides: {} }, second, { ...base, id: "generic#1000" }]).id).toBe("generic#999");
  });
});

describe("the run-time scorability re-check (T6/T8 carry)", () => {
  it("re-scores every bound case with the REAL scorable, and binds exactly the two chosen", () => {
    const seen: string[] = [];
    makeProbePlanner({ rescore: (vc) => { seen.push(vc.id); return scorable(vc); } })({ set: PROBE_SET });
    const want = SLICE_SPORTS.map((sp) => casesOf(sp).find((c) => Object.keys(c.overrides).length > 0 && c.scorable === null && (SLICE_ROWS as readonly string[]).includes(c.row))!.id);
    expect(seen).toEqual(want);
    expect(seen.length).toBe(2);
  });
  it("a bound case the engine now refuses is a named refusal (BoundVariantUnscorable), carrying its id and the reason", () => {
    const make = makeProbePlanner({ rescore: () => "win-home: EngineError: refused now" });
    expect(() => make({ set: PROBE_SET })).toThrow(BoundVariantUnscorable);
    expect(() => make({ set: PROBE_SET })).toThrow(/generic#\d{3}.*win-home: EngineError: refused now/);
  });
  it("requireScorable refuses a case whose COMMITTED record is unscorable, even when a re-score would pass", () => {
    const unscorable = committed.sports.flatMap((s) => s.cases).find((c) => c.scorable !== null);
    expect(unscorable, "variants.json holds no unscorable case to witness with").toBeDefined();
    expect(() => requireScorable(unscorable!, () => null)).toThrow(BoundVariantUnscorable);
    expect(() => requireScorable(unscorable!, () => null)).toThrow(unscorable!.scorable!);
  });
  it("requireScorable: a case recorded scorable that re-scores as refused is refused on the RE-SCORE alone", () => {
    const ok = casesOf("badminton").find((c) => c.scorable === null)!;
    expect(() => requireScorable(ok, () => "win-away: OutcomeUnreachable: x")).toThrow(/win-away: OutcomeUnreachable: x/);
  });
  it("a scorable case (recorded and re-scored with the real scorable) passes through unchanged", () => {
    const ok = casesOf("badminton").find((c) => c.scorable === null)!;
    expect(requireScorable(ok)).toBe(ok);
  });
});
