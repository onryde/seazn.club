// W1d Task 7 (R27, D13): the per-PR sample. `--set pr-sample` runs the fixed sample (the slice's 24 cases
// plus league|<sport>|LIFECYCLE on the sports the slice lacks) and the w1-driving cases on the rows a PR
// declares, judged against the committed baseline. The expected values here come from the slice constants,
// the sport registry, the committed w1-driving set and the committed baseline — never from fixedSample().
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS } from "../lib/catalogue.ts";
import { regressions } from "../lib/judge.ts";
import {
  BaselineUnreadable, EmptyPrSample, PR_SAMPLE_SET, PrSampleNeedsRows, UnknownRow, baselineL3Path, fixedSample, formatRows, parseRows, planPrSample, prSamplePlanner,
} from "../lib/pr-sample.ts";
import { parseResults } from "../lib/results.ts";
import { SCENARIO_KEYS, SLICE_ROWS, SLICE_SPORTS, planSliceCases } from "../lib/slice.ts";
import { offlineBuilderDefault } from "../lib/variants.ts";
import { planW1Driving, readVariantsFile } from "../lib/w1-driving-set.ts";
import { REPO } from "./committed-plans.ts";

const ids = (cs: readonly { caseId: string }[]): string[] => cs.map((c) => c.caseId);
const dedupe = (xs: readonly string[]): string[] => [...new Set(xs)];
/** A variant authority no constant can fake: every sport's variant is its own. */
const own = (sport: string): string => `v-${sport}`;

/** The sports the slice lacks, from the registry and the slice's own constant. */
const OTHER_SPORTS: readonly string[] = SPORT_KEYS.filter((s) => !(SLICE_SPORTS as readonly string[]).includes(s));
/** The fixed sample, built here from the brief's rule (rows × sports × scenarios, then league LIFECYCLE on the others). */
const fixedIds = (v: (s: string) => string): string[] => [
  ...SLICE_ROWS.flatMap((row) => SLICE_SPORTS.flatMap((sport) => SCENARIO_KEYS.map((sc) => `${row}|${sport}|${v(sport)}|${sc}`))),
  ...OTHER_SPORTS.map((s) => `league|${s}|${v(s)}|LIFECYCLE`),
];

describe("the fixed sample's own arithmetic (anti-vacuity: the sets it is built from are non-empty)", () => {
  it("the slice is 3 rows x 2 sports x 4 scenarios, and 9 of the registry's 11 sports are outside it", () => {
    expect(SLICE_ROWS.length * SLICE_SPORTS.length * SCENARIO_KEYS.length).toBe(24);
    expect(OTHER_SPORTS).toHaveLength(SPORT_KEYS.length - SLICE_SPORTS.length);
    expect(OTHER_SPORTS.length).toBe(9);
    expect(ROW_KEYS.length).toBe(21);
  });
});

describe("parseRows (R27): what follows `Matrix rows:`", () => {
  it.each([
    ["league", ["league"]],
    ["league, swiss", ["league", "swiss"]],
    ["swiss,league", ["league", "swiss"]],
    ["  swiss ,  league  ", ["league", "swiss"]],
    ["league, league", ["league"]],
    ["all", "all"],
    ["none", []],
    ["none — copy only", []],
    ["none - copy only", []],
    ["none -- copy only", []],
    ["none – copy only", []],
  ] as const)("%j is %j", (text, want) => {
    expect(parseRows(text)).toEqual(want);
  });

  it("every catalogue row is accepted by name, one at a time (anti-vacuity: 21 rows)", () => {
    let checked = 0;
    for (const row of ROW_KEYS) {
      expect(parseRows(row), row).toEqual([row]);
      checked++;
    }
    expect(checked).toBe(ROW_KEYS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("an unknown row is refused by name, and the refusal lists the whole catalogue", () => {
    let thrown: unknown;
    try { parseRows("leage"); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(UnknownRow);
    const msg = (thrown as Error).message;
    expect((thrown as Error).name).toBe("UnknownRow");
    expect(msg).toMatch(/leage/);
    expect(msg).toContain(ROW_KEYS.join(", "));
    expect(ROW_KEYS.length).toBe(21);
  });

  it.each([
    ["the empty string", ""],
    ["blanks", "   "],
    ["a trailing comma", "league,"],
    ["an empty entry", "league,,swiss"],
    ["a row in the wrong case", "League"],
    ["ALL in the wrong case", "ALL"],
    ["all beside a row (it is no row)", "all, league"],
    ["none beside a row (it is no row)", "none, league"],
    ["none glued to a word", "none-ish"],
    ["none then a word with no dash", "none league"],
    ["a row and a reason", "league — copy only"],
  ])("%s is refused (UnknownRow), never read as a declaration", (_what, text) => {
    expect(() => parseRows(text)).toThrow(UnknownRow);
  });

  it("the first unknown entry is the one named, even beside valid ones", () => {
    expect(() => parseRows("league, leage, swiss")).toThrow(/'leage'/);
  });
});

describe("formatRows: the one canonical spelling of a declaration (what planOf records)", () => {
  it.each([
    [[], "none"],
    ["all", "all"],
    [["swiss"], "swiss"],
    [["swiss", "league"], "league,swiss"],
    [["league", "swiss", "league"], "league,swiss"],
  ] as const)("%j is %j", (rows, want) => {
    expect(formatRows(rows)).toBe(want);
  });

  it("round-trips through parseRows, for none, all and every single row", () => {
    let checked = 0;
    for (const rows of [[], "all", ...ROW_KEYS.map((r) => [r]), ["swiss", "league", "knockout"]] as const) {
      expect(parseRows(formatRows(rows))).toEqual(rows === "all" ? "all" : [...new Set(rows)].sort());
      checked++;
    }
    expect(checked).toBe(ROW_KEYS.length + 3);
  });
});

describe("fixedSample", () => {
  it("is the slice's 24 cases, then league LIFECYCLE on each of the 9 sports the slice lacks", () => {
    const cases = fixedSample(own);
    expect(ids(cases)).toEqual(fixedIds(own));
    expect(cases).toHaveLength(SLICE_ROWS.length * SLICE_SPORTS.length * SCENARIO_KEYS.length + (SPORT_KEYS.length - SLICE_SPORTS.length));
    expect(cases).toHaveLength(33);
  });

  it("variantFor is the only variant authority: every case's variant, and the id's, is what variantFor said for its sport", () => {
    const asked: string[] = [];
    const cases = fixedSample((s) => { asked.push(s); return own(s); });
    let checked = 0;
    for (const c of cases) {
      expect(c.variant, c.caseId).toBe(own(c.sport));
      expect(c.caseId.split("|")[2], c.caseId).toBe(own(c.sport));
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(new Set(asked)).toEqual(new Set(SPORT_KEYS));
  });

  it("the slice part is exactly planSliceCases (the one place the slice is planned)", () => {
    expect(fixedSample(own).slice(0, 24)).toEqual(planSliceCases(own));
  });

  it("the other nine are league LIFECYCLE specs, not canaries, one per sport the slice lacks, none of them a slice sport", () => {
    const rest = fixedSample(own).slice(24);
    expect(rest.map((c) => c.sport)).toEqual(OTHER_SPORTS);
    for (const c of rest) {
      expect(c).toEqual({ caseId: `league|${c.sport}|${own(c.sport)}|LIFECYCLE`, row: "league", sport: c.sport, variant: own(c.sport), scenario: "LIFECYCLE", canary: false });
    }
    expect(rest.length).toBe(9);
  });

  it("covers every sport in the registry, and no case twice (a slice sport's league LIFECYCLE is in the slice already)", () => {
    const cases = fixedSample(own);
    expect(new Set(cases.map((c) => c.sport))).toEqual(new Set(SPORT_KEYS));
    expect(new Set(ids(cases)).size).toBe(cases.length);
    for (const s of SLICE_SPORTS) expect(ids(cases).filter((id) => id === `league|${s}|${own(s)}|LIFECYCLE`), s).toHaveLength(1);
  });

  it("a second call is the same plan, and a result mutated by its caller does not reach the next one", () => {
    const first = fixedSample(own);
    const snapshot = ids(first);
    first.length = 0;
    expect(ids(fixedSample(own))).toEqual(snapshot);
    expect(snapshot).toHaveLength(33);
  });
});

describe("planPrSample", () => {
  const W1 = planW1Driving(offlineBuilderDefault, {});    // the committed w1-driving set, unfiltered, is the authority for row cases
  const onRows = (rows: readonly string[]): string[] => ids(W1.filter((c) => rows.includes(c.row)));

  it("the fixed sample is the 24 slice cases plus league LIFECYCLE on the 9 sports the slice lacks", () => {
    const cases = planPrSample([], offlineBuilderDefault);
    expect(cases).toHaveLength(SLICE_ROWS.length * SLICE_SPORTS.length * SCENARIO_KEYS.length + (SPORT_KEYS.length - SLICE_SPORTS.length));
    expect(ids(cases)).toEqual(fixedIds(offlineBuilderDefault));
  });

  it("a declared row adds exactly the w1-driving cases on that row, never twice", () => {
    const cases = planPrSample(["swiss"], offlineBuilderDefault);
    const want = new Set([...planPrSample([], offlineBuilderDefault).map((c) => c.caseId), ...W1.filter((c) => c.caseId.startsWith("swiss|")).map((c) => c.caseId)]);
    expect(new Set(cases.map((c) => c.caseId))).toEqual(want);
    expect(cases).toHaveLength(want.size);
    // The empty case's opposite, so the line above cannot hold with swiss absent: it adds cases the fixed sample lacks.
    expect(want.size).toBeGreaterThan(fixedIds(offlineBuilderDefault).length);
  });

  it("every row, one at a time: its w1-driving cases then the fixed sample, each case once, in that order", () => {
    let checked = 0;
    let adds = 0;
    for (const row of ROW_KEYS) {
      const got = ids(planPrSample([row], offlineBuilderDefault));
      expect(got, row).toEqual(dedupe([...onRows([row]), ...fixedIds(offlineBuilderDefault)]));
      expect(new Set(got).size, `${row}: no case twice`).toBe(got.length);
      adds += got.length - fixedIds(offlineBuilderDefault).length;
      checked++;
    }
    expect(checked).toBe(ROW_KEYS.length);
    expect(adds).toBeGreaterThan(0);
  });

  it("the row's cases come first, in w1-driving order, and the fixed sample's remaining cases follow in the fixed sample's own order", () => {
    const got = ids(planPrSample(["swiss"], offlineBuilderDefault));
    const w1Swiss = onRows(["swiss"]);
    expect(got.slice(0, w1Swiss.length)).toEqual(w1Swiss);
    const fixedRest = fixedIds(offlineBuilderDefault).filter((id) => !w1Swiss.includes(id));
    expect(got.slice(w1Swiss.length)).toEqual(fixedRest);
    expect(fixedRest.length).toBeGreaterThan(0);
  });

  it("two rows add both rows' cases; a row declared twice adds it once", () => {
    const both = ids(planPrSample(["league", "swiss"], offlineBuilderDefault));
    expect(both).toEqual(dedupe([...onRows(["league", "swiss"]), ...fixedIds(offlineBuilderDefault)]));
    expect(ids(planPrSample(["swiss", "swiss"], offlineBuilderDefault))).toEqual(ids(planPrSample(["swiss"], offlineBuilderDefault)));
  });

  it("'all' is the whole w1-driving set plus the fixed sample, each case once", () => {
    const all = ids(planPrSample("all", offlineBuilderDefault));
    expect(all).toEqual(dedupe([...ids(W1), ...fixedIds(offlineBuilderDefault)]));
    expect(all.length).toBeGreaterThanOrEqual(W1.length);
    expect(new Set(all).size).toBe(all.length);
    expect(W1.length).toBeGreaterThan(0);
  });

  it("w1-driving's cricket test cases ride with THEIR row, overrides intact (the plan is more than ids)", () => {
    // The committed variants say which rows hold cricket test cases and how many; the plan follows them row by row.
    const committed = readVariantsFile().sports.find((x) => x.sport === "cricket")!.cases.filter((c) => c.preset === "test");
    const rowsWithTests = [...new Set(committed.map((c) => c.row))];
    expect(committed.length).toBeGreaterThan(0);
    expect(rowsWithTests).toContain("league");
    let checked = 0;
    for (const row of ROW_KEYS) {
      const tests = planPrSample([row], offlineBuilderDefault).filter((c) => c.variant === "test");
      expect(tests.map((c) => c.caseId).sort(), row).toEqual(committed.filter((c) => c.row === row).map((c) => `${c.row}|${c.sport}|${c.preset}|LIFECYCLE|${c.id}`).sort());
      for (const c of tests) expect(c.overrides, c.caseId).toBeDefined();
      checked += tests.length;
    }
    expect(checked).toBe(committed.length);
    // None declared, none planned: the fixed sample carries no test case.
    expect(planPrSample([], offlineBuilderDefault).filter((c) => c.variant === "test")).toEqual([]);
  });

  it("variantFor reaches every case a row adds, not only the fixed sample", () => {
    const got = planPrSample(["swiss"], own).filter((c) => c.variant !== "test");
    for (const c of got) expect(c.caseId.split("|")[2], c.caseId).toBe(own(c.sport));
    expect(got.length).toBeGreaterThan(fixedIds(own).length);
  });

  it("a row the catalogue lacks is refused, never planned as 'the fixed sample only' (a silent no-op reads as a sampled row)", () => {
    expect(() => planPrSample(["nope"], offlineBuilderDefault)).toThrow(UnknownRow);
    expect(() => planPrSample(["swiss", "nope"], offlineBuilderDefault)).toThrow(/'nope'/);
    expect(() => planPrSample([""], offlineBuilderDefault)).toThrow(UnknownRow);
  });

  it("no declared rows never consults the w1-driving set (a none-sample runs whatever state those files are in); a declared row, or all, does — once", () => {
    const throwing = (): never => { throw new Error("the w1-driving set was consulted"); };
    expect(ids(planPrSample([], offlineBuilderDefault, { w1: throwing }))).toEqual(fixedIds(offlineBuilderDefault));
    let calls = 0;
    const counted = (v: (s: string) => string) => { calls++; return planW1Driving(v, {}); };
    planPrSample(["swiss"], offlineBuilderDefault, { w1: counted });
    expect(calls).toBe(1);
    planPrSample("all", offlineBuilderDefault, { w1: counted });
    expect(calls).toBe(2);
    expect(() => planPrSample(["swiss"], offlineBuilderDefault, { w1: throwing })).toThrow(/consulted/);
  });

  it("an empty plan is impossible, and is a named refusal when a fixed sample somehow plans nothing", () => {
    expect(planPrSample([], offlineBuilderDefault).length).toBeGreaterThan(0);
    expect(() => planPrSample([], offlineBuilderDefault, { fixed: () => [] })).toThrow(EmptyPrSample);
    // A declared row cannot rescue it: the fixed sample is the sample's floor, whatever the rows add.
    expect(() => planPrSample(["swiss"], offlineBuilderDefault, { fixed: () => [] })).toThrow(EmptyPrSample);
  });

  it("a second call is the same plan, and a result mutated by its caller does not reach the next one", () => {
    const first = planPrSample(["swiss"], offlineBuilderDefault);
    const snapshot = ids(first);
    first.length = 0;
    expect(ids(planPrSample(["swiss"], offlineBuilderDefault))).toEqual(snapshot);
    expect(snapshot.length).toBeGreaterThan(33);
  });
});

describe("prSamplePlanner (what run.ts's SETS['pr-sample'] is)", () => {
  it("is named pr-sample", () => {
    expect(PR_SAMPLE_SET).toBe("pr-sample");
  });

  it("with no rows it refuses by name: a sample no one declared rows for is no sample", () => {
    expect(() => prSamplePlanner({})).toThrow(PrSampleNeedsRows);
    expect(() => prSamplePlanner({ only: "league|generic", set: PR_SAMPLE_SET })).toThrow(PrSampleNeedsRows);
  });

  it("refuses a row the catalogue lacks when it is BUILT (before the DB), not when it plans", () => {
    expect(() => prSamplePlanner({ rows: ["nope"] })).toThrow(UnknownRow);
    expect(() => prSamplePlanner({ rows: ["swiss", ""] })).toThrow(UnknownRow);
  });

  it("plans planPrSample's cases for the rows it was given, and declares no deny", () => {
    for (const rows of [[], ["swiss"], "all"] as const) {
      const p = prSamplePlanner({ rows });
      expect(p.deniesFeatures).toBe(false);
      expect(ids(p.plan(offlineBuilderDefault)), formatRows(rows)).toEqual(ids(planPrSample(rows, offlineBuilderDefault)));
    }
  });

  it("declares every sport it plans (run.ts reads a sport's variant order only for the sports a planner declares), for none, one row and all", () => {
    let checked = 0;
    for (const rows of [[], ["swiss"], ["league", "knockout"], "all", ...ROW_KEYS.map((r) => [r])] as const) {
      const p = prSamplePlanner({ rows });
      const asked = new Set<string>();
      const cases = p.plan((s) => { asked.add(s); return offlineBuilderDefault(s); });
      for (const s of new Set(cases.map((c) => c.sport))) expect(p.sports, `${formatRows(rows)}: ${s}`).toContain(s);
      for (const s of asked) expect(p.sports, `${formatRows(rows)}: variantFor(${s})`).toContain(s);
      checked++;
    }
    expect(checked).toBe(4 + ROW_KEYS.length);
    expect(new Set(prSamplePlanner({ rows: [] }).sports)).toEqual(new Set(SPORT_KEYS));
  });
});

describe("the sample against the real baseline (review C3c)", () => {
  const baseline = () => parseResults(JSON.parse(readFileSync(baselineL3Path(), "utf8")));

  it("the real committed baseline against the real fixed sample: zero absent when now holds every planned case", () => {
    const b = baseline();
    const expected = planPrSample([], offlineBuilderDefault).map((c) => c.caseId);
    const now = { ...b, cases: b.cases.filter((c) => expected.includes(c.caseId)) };
    const r = regressions(b, now, expected);
    expect(r.absent).toEqual([]);
    expect(r.compared).toBeGreaterThan(0);
    expect(r.compared).toBe(now.cases.length);
    // review 2, R2-m3: every planned sample case has a baseline twin — a sample case the baseline lacks protects nothing.
    // 33 at HEAD (24 slice + 9 league LIFECYCLE), derived here, not typed in.
    expect(r.compared).toBe(expected.length);
  });

  it("…and the cell filter it replaced WOULD have reported the cricket test cases absent (the regression this guards)", () => {
    const b = baseline();
    expect(b.cases.filter((c) => c.caseId.startsWith("league|cricket|test|LIFECYCLE|")).length).toBeGreaterThan(0);
  });

  it("every case the sample plans for ANY declaration has a baseline twin, so no PR reports a case absent by construction", () => {
    const have = new Set(baseline().cases.map((c) => c.caseId));
    let checked = 0;
    for (const rows of ["all", ...ROW_KEYS.map((r) => [r])] as const) {
      const missing = ids(planPrSample(rows, offlineBuilderDefault)).filter((id) => !have.has(id));
      expect(missing, formatRows(rows)).toEqual([]);
      checked++;
    }
    expect(checked).toBe(ROW_KEYS.length + 1);
  });
});

describe("baselineL3Path (catalogue/baseline.json names the committed L3 baseline)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "w1d-t7-baseline-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  let n = 0;
  /** A fake repo: catalogue/baseline.json holds `file` (when not null); `made` are files created under the repo. */
  const fake = (file: string | null, made: readonly string[] = []): { catalogue: string; repo: string } => {
    const repo = join(tmp, `r${++n}`);
    mkdirSync(join(repo, "catalogue"), { recursive: true });
    if (file !== null) writeFileSync(join(repo, "catalogue", "baseline.json"), file);
    for (const m of made) { mkdirSync(resolve(repo, m, ".."), { recursive: true }); writeFileSync(resolve(repo, m), "{}"); }
    return { catalogue: join(repo, "catalogue"), repo };
  };

  it("the real one names the committed w1-driving L3 run, resolved against the repo root, and that file exists", () => {
    const p = baselineL3Path();
    expect(p).toBe(resolve(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs/w1drv-l3/results.json"));
    expect(readFileSync(p, "utf8").length).toBeGreaterThan(1000);
  });

  it("resolves the named path against the repo root it is given", () => {
    const d = fake(JSON.stringify({ L3: "evidence/l3/results.json" }), ["evidence/l3/results.json"]);
    expect(baselineL3Path(d)).toBe(resolve(d.repo, "evidence/l3/results.json"));
  });

  it("a missing baseline.json is refused by name (BaselineUnreadable), and the refusal names the file", () => {
    const d = fake(null);
    expect(() => baselineL3Path(d)).toThrow(BaselineUnreadable);
    expect(() => baselineL3Path(d)).toThrow(/baseline\.json/);
  });

  it.each([
    ["not JSON", "{ nope"],
    ["an array", "[]"],
    ["no L3 key", JSON.stringify({ L1: "a/results.json" })],
    ["an L3 that is not a string", JSON.stringify({ L3: 3 })],
    ["an empty L3", JSON.stringify({ L3: "" })],
  ])("%s is refused (BaselineUnreadable)", (_what, text) => {
    expect(() => baselineL3Path(fake(text, ["a/results.json"]))).toThrow(BaselineUnreadable);
  });

  it("an L3 that names a file that is not there is refused, naming that file — a baseline that cannot be read judges nothing", () => {
    const d = fake(JSON.stringify({ L3: "gone/results.json" }));
    expect(() => baselineL3Path(d)).toThrow(BaselineUnreadable);
    expect(() => baselineL3Path(d)).toThrow(/gone\/results\.json/);
  });

  it("other keys beside L3 are fine (PR-B adds L1 and L2)", () => {
    const d = fake(JSON.stringify({ L3: "x/results.json", L1: "y/results.json" }), ["x/results.json"]);
    expect(baselineL3Path(d)).toBe(resolve(d.repo, "x/results.json"));
  });
});
