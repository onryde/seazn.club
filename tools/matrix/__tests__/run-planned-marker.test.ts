// W1d Task 2 (items 3, 4, 21): what a RESULT records, driven through the real
// producer — runSlice → runCase / recordPlanned → writeResults → results.json
// read back through the schema. Every layered plan here goes through
// RunDeps.planCases, the way run-cli.test.ts already does; the L2 test goes
// through the REAL `--layer L2` planner over the committed l2-pairs.json, so
// the field is proven wired from the file to the evidence, never from a
// fixture on both ends (AGENTS class 1).
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROW_KEYS, stagesForRow } from "../lib/catalogue.ts";
import { BrowserDriver } from "../lib/driver/browser-driver.ts";
import type { FillerName } from "../lib/driver/mixed.ts";
import { expectedGate } from "../lib/format-gates-copy.ts";
import type { CaseIdentity, LayerCase } from "../lib/layers.ts";
import type { L2Run } from "../lib/pairs.ts";
import { renderMatrix } from "../lib/render-matrix.ts";
import { parseResults, type CaseResult, type CheckResult, type RunResults } from "../lib/results.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import type { CaseSpec } from "../lib/scenarios/types.ts";
import { SLICE_ROWS, SLICE_SPORTS } from "../lib/slice.ts";
import { runSlice, type BrowserRun, type PlanLayers, type RunDeps } from "../run.ts";
import { FakeLeagueDriver } from "./fake-driver.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ALL_GATES: readonly string[] = [...new Set(ROW_KEYS.flatMap((r) => { const g = expectedGate(stagesForRow(r)); return g === null ? [] : [g]; }))];

afterEach(() => { vi.restoreAllMocks(); });

/** Everything runSlice prints, captured (and kept off the reporter). */
function silence(): void {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

interface Deps extends RunDeps { orgs: string[] }
/** The run's seams, faked: a league fake per case, an org per case (`failOrgAt`:
 *  the 1-based case whose org provision throws — a case that ends red). */
function deps(over: Partial<RunDeps> = {}, o: { failOrgAt?: number } = {}): Deps {
  const orgs: string[] = [];
  const d: Deps = {
    orgs,
    env: { BENCH_EXPECTED_DATA_DIR: "/tmp/pg", SMOKE_BASE: "http://localhost:3999" },
    harnessCommit: async () => "abc1234",
    preflight: async () => ({ ok: true, refusals: [] }),
    openDb: async () => ({
      userIdForEmail: async () => "u1",
      variantKeysInBuilderOrder: async (s: string) => (s === "generic" ? ["score", "win_loss"] : ["bwf", "short"]),
      chooseTopPublicPlan: async () => "pro",
      planGrants: async () => [...ALL_GATES],
      planLimit: async () => null,
      dispose: async () => undefined,
    }),
    signIn: async () => ({ cookies: {} }),
    prepareCaseOrg: async (_ctx, i) => {
      orgs.push(i.slug);
      if (o.failOrgAt === orgs.length) throw new Error("org provision refused");
      return { orgId: `org-${i.slug}`, orgSlug: i.slug, denied: [...(i.deny ?? [])] };
    },
    driverFor: (_b, _s, orgId) => new FakeLeagueDriver(orgId),
    render: renderMatrix,
    ...over,
  };
  return d;
}

/** A layered plan, as run-cli.test.ts builds one: the cases are the test's own. */
const planOf = (layer: "L1" | "L2", cases: LayerCase[]): PlanLayers => () => ({ sports: ["generic"], deniesFeatures: false, layer, label: "a test plan", acceptsWidth: null, layered: () => cases });

const identity = (row: string, scenario: string): CaseIdentity => ({ caseId: `${row}|generic|score|${scenario}`, row: row as CaseIdentity["row"], sport: "generic", variant: "score", scenario });
const specOf = (row: string): CaseSpec => ({ ...identity(row, "LIFECYCLE"), scenario: "LIFECYCLE", canary: false });
const driven = (row: string, layer: "L1" | "L2" = "L1", width: 1280 | 390 = 1280, run: L2Run | null = null): LayerCase => ({ spec: specOf(row), layer, width, noPath: null, notRun: null, run });
const noPath = (row: string, layer: "L1" | "L2" = "L1", width: 1280 | 390 = 1280, run: L2Run | null = null): LayerCase => ({ spec: null, identity: identity(row, "LIFECYCLE"), layer, width, noPath: { wave: "W4", reason: "API-only (W4)" }, notRun: null, run });
const notRun = (row: string, scenario: string, layer: "L1" | "L2" = "L1", width: 1280 | 390 = 1280, run: L2Run | null = null): LayerCase => ({ spec: null, identity: identity(row, scenario), layer, width, noPath: null, notRun: `no scenario script yet (atom ${scenario})`, run });

/** A browser run whose case drivers are league fakes. `fillersAt(i)` is what the
 *  i-th case's driver reports — and only once it has made a call, so a read taken
 *  before the scenario ran (a stale read) sees nothing, exactly like the real
 *  ledger that BrowserDriver.fillers reads. */
function fakeBrowser(fillersAt: (i: number) => Readonly<Partial<Record<FillerName, number>>> = () => ({})): { run: BrowserRun; opened: () => number } {
  let n = 0;
  const run: BrowserRun = {
    caseDriver: async (co) => {
      const i = n++;
      const driver = new FakeLeagueDriver(co.orgId);
      Object.defineProperty(driver, "fillers", { get: () => (driver.callCount > 0 ? fillersAt(i) : {}) });
      const checks = (): CheckResult[] => [{ id: "browser-probe", kind: "assertion", verdict: "pass", checked: 1, reason: `driver ${i}`, evidence: [] }];
      return { driver: Object.assign(driver, { checks }), close: async () => undefined };
    },
    close: async () => undefined,
  };
  return { run, opened: () => n };
}

const resultsOf = (dir: string, runId: string): RunResults => parseResults(JSON.parse(readFileSync(join(dir, runId, "results.json"), "utf8"))) as RunResults;
const dirFor = () => mkdtempSync(join(tmpdir(), "fm-"));
const byId = (r: RunResults) => new Map(r.cases.map((c) => [c.caseId, c]));

/** Runs argv against `d` (a browser run when it carries a browser) and answers the parsed evidence. */
async function runWith(d: RunDeps, argv: string[], id: string): Promise<RunResults> {
  silence();
  const dir = dirFor();
  expect(await runSlice(d, [...argv, "--run-id", id, "--report-dir", dir]), argv.join(" ")).toBe(0);
  return resultsOf(dir, id);
}

describe("the planned marker (item 3): recordPlanned writes it, a driven case never does", () => {
  it("recordPlanned marks every case it writes; a driven case never carries the marker", async () => {
    const fb = fakeBrowser();
    const results = await runWith(deps({ planCases: planOf("L1", [driven("league"), noPath("page_playoff_only"), notRun("league", "M7")]), openBrowserRun: async () => fb.run }), ["--driver", "browser"], "pm1");
    const by = byId(results);
    expect(results.cases).toHaveLength(3);
    expect(by.get("league|generic|score|LIFECYCLE@1280")!.planned).toBeUndefined();
    expect("planned" in by.get("league|generic|score|LIFECYCLE@1280")!).toBe(false);
    expect(by.get("page_playoff_only|generic|score|LIFECYCLE@1280")!.planned).toBe(true);
    expect(by.get("league|generic|score|M7@1280")!.planned).toBe(true);
    expect(results.cases.filter((c) => c.planned === true)).toHaveLength(2);
    // The states the marker rides on are the planner's own: 🚫 and ░, nothing driven.
    expect(by.get("page_playoff_only|generic|score|LIFECYCLE@1280")!.state).toBe("no_path");
    expect(by.get("league|generic|score|M7@1280")!.state).toBe("not_run");
  });

  it("empty and all-planned plans: a plan with nothing planned writes no marker, and a plan of only planned cases marks every one (a second run on the same deps is the same)", async () => {
    const fb = fakeBrowser();
    const allDriven = await runWith(deps({ planCases: planOf("L1", [driven("league"), driven("knockout")]), openBrowserRun: async () => fb.run }), ["--driver", "browser"], "pm2a");
    expect(allDriven.cases).toHaveLength(2);
    expect(allDriven.cases.filter((c) => c.planned !== undefined)).toHaveLength(0);
    // Only planned cases: no browser is opened at all (run-cli.test.ts, the API-only set), and each case is marked.
    const none = fakeBrowser();
    const d = deps({ planCases: planOf("L1", [noPath("page_playoff_only"), noPath("stepladder_only"), notRun("league", "M7")]), openBrowserRun: async () => none.run });
    for (const id of ["pm2b", "pm2c"]) {
      const allPlanned = await runWith(d, ["--driver", "browser"], id);
      expect(allPlanned.cases.map((c) => c.planned), id).toEqual([true, true, true]);
    }
    expect(none.opened()).toBe(0);
  });
});

describe("the L2 run (item 4): n, covers and l3Gap are recorded from the committed pair file, never thrown away", () => {
  it("--layer L2 over the slice: every case records the l2-pairs.json run it IS — driven, 🚫 or ░ — and the file, not planL2, is the authority", async () => {
    const file = JSON.parse(readFileSync(join(REPO, "tools/matrix/catalogue/l2-pairs.json"), "utf8")) as { runs: L2Run[] };
    const cells = new Set(SLICE_ROWS.flatMap((r) => SLICE_SPORTS.map((s) => `${r}|${s}`)));
    const want = file.runs.filter((r) => cells.has(`${r.row}|${r.sport}`));
    const idOf = (r: L2Run) => `${r.row}|${r.sport}|${r.preset}|${r.scenario}${r.bound === null ? "" : `|${r.bound}`}@${r.width}`;
    const fb = fakeBrowser();
    const results = await runWith(deps({ openBrowserRun: async () => fb.run }), ["--driver", "browser", "--layer", "L2"], "l2a");
    expect(want.length).toBeGreaterThan(0);
    expect(results.cases).toHaveLength(want.length);
    const by = byId(results);
    let checked = 0;
    for (const r of want) {
      const c = by.get(idOf(r));
      expect(c, idOf(r)).toBeDefined();
      expect(c!.l2, idOf(r)).toEqual({ n: r.n, covers: [...r.covers], l3Gap: r.l3Gap });
      checked++;
    }
    expect(checked).toBe(want.length);
    // Anti-vacuity: the sweep covered a driven case and a planned one (each of 🚫/░ if the file holds one), and the
    // right answers differ — more than one n and more than one covers shape — so a constant would not pass.
    const drivenCases = results.cases.filter((c) => c.planned === undefined);
    const plannedCases = results.cases.filter((c) => c.planned === true);
    expect(drivenCases.length).toBeGreaterThan(0);
    expect(plannedCases.length).toBeGreaterThan(0);
    expect(drivenCases.length + plannedCases.length).toBe(results.cases.length);
    expect(new Set(results.cases.map((c) => c.l2!.n)).size).toBe(want.length);
    expect(new Set(results.cases.map((c) => JSON.stringify(c.l2!.covers))).size).toBeGreaterThan(1);
  });

  it("l3Gap round-trips as a reason where the file has none (every committed run's gap is null today): driven-works, driven-red, 🚫 and ░ all keep their own run", async () => {
    const run = (n: number, covers: L2Run["covers"], l3Gap: string | null): L2Run => ({ n, scenario: "M1", row: "league", sport: "generic", preset: "score", bound: null, width: 390, covers, l3Gap });
    const runs = { works: run(11, ["row", "sport"], null), red: run(12, ["sport"], "no M5 harness script (cricket tie stream)"), no_path: run(13, ["row"], null), not_run: run(14, ["row", "sport"], "the only coverage of this pair") };
    const fb = fakeBrowser();
    const plan = planOf("L2", [driven("league", "L2", 390, runs.works), driven("knockout", "L2", 390, runs.red), noPath("page_playoff_only", "L2", 390, runs.no_path), notRun("swiss", "M7", "L2", 390, runs.not_run)]);
    // The second driven case's org provision throws: it ends red, and still records its run.
    const results = await runWith(deps({ planCases: plan, openBrowserRun: async () => fb.run }, { failOrgAt: 2 }), ["--driver", "browser"], "l2b");
    const states = Object.fromEntries(results.cases.map((c) => [c.l2!.n, c.state]));
    expect(states).toEqual({ 11: "works", 12: "red", 13: "no_path", 14: "not_run" });
    for (const c of results.cases) {
      const want = Object.values(runs).find((r) => r.n === c.l2!.n)!;
      expect(c.l2, c.caseId).toEqual({ n: want.n, covers: [...want.covers], l3Gap: want.l3Gap });
    }
    expect(results.cases.filter((c) => c.l2!.l3Gap !== null)).toHaveLength(2);
    expect(results.cases).toHaveLength(4);
  });

  // runCase keeps every product or driver refusal as its case's error red, so a
  // throw PAST it is a harness defect (run-cli.test.ts: the progress line is the
  // one real seam that reaches it). The crash row is still the pair-run it was.
  it("an L2 case that crashed past runCase is still the pair-run it was: the crash row keeps its l2", async () => {
    const crashRun: L2Run = { n: 21, scenario: "M1", row: "league", sport: "generic", preset: "score", bound: null, width: 390, covers: ["sport"], l3Gap: "no harness script for this atom" };
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => {
      const line = String(s);
      if (line.startsWith("[1/") && !line.includes("crashed")) throw new Error("stdout closed");
      return true;
    });
    const fb = fakeBrowser();
    const dir = dirFor();
    expect(await runSlice(deps({ planCases: planOf("L2", [driven("league", "L2", 390, crashRun), driven("knockout", "L2", 390, { ...crashRun, n: 22, covers: ["row"], l3Gap: null })]), openBrowserRun: async () => fb.run }), ["--driver", "browser", "--run-id", "l2e", "--report-dir", dir])).toBe(0);
    const r = resultsOf(dir, "l2e");
    expect(r.cases).toHaveLength(2);
    expect(r.cases[0]).toMatchObject({ state: "red", reason: "error: crashed — Error: stdout closed", l2: { n: 21, covers: ["sport"], l3Gap: "no harness script for this atom" } });
    // The other case did not crash, and keeps its own pair-run (not the crashed one's).
    expect(r.cases[1]!.l2).toEqual({ n: 22, covers: ["row"], l3Gap: null });
  });

  it("a case that is not an L2 case records no l2: L1 cases, an L1-layer case that carries a run, and an HTTP run's cases", async () => {
    const stray: L2Run = { n: 99, scenario: "M1", row: "league", sport: "generic", preset: "score", bound: null, width: 390, covers: ["row"], l3Gap: null };
    const fb = fakeBrowser();
    const l1 = await runWith(deps({ planCases: planOf("L1", [driven("league"), noPath("page_playoff_only"), driven("knockout", "L1", 1280, stray)]), openBrowserRun: async () => fb.run }), ["--driver", "browser"], "l2c");
    expect(l1.cases).toHaveLength(3);
    expect(l1.cases.filter((c) => c.l2 !== undefined)).toHaveLength(0);
    const http = await runWith(deps(), ["--only", "league|generic", "--scenario", "LIFECYCLE"], "l2d");
    expect(http.cases.length).toBeGreaterThan(0);
    expect(http.cases.filter((c) => c.l2 !== undefined)).toHaveLength(0);
  });
});

describe("the setup fillers (item 21): a browser case records the ones it ran; an HTTP case records none", () => {
  const three: LayerCase[] = [driven("league"), driven("knockout"), driven("swiss")];

  it("a browser case records the setup fillers it ran, each case its own (non-zero names only); a case that ran none writes no field", async () => {
    const per: Readonly<Partial<Record<FillerName, number>>>[] = [{ setMembers: 3, putLineup: 1 }, {}, { setMembers: 0, challenge: 2 }];
    const fb = fakeBrowser((i) => per[i]!);
    const r = await runWith(deps({ planCases: planOf("L1", three), openBrowserRun: async () => fb.run }), ["--driver", "browser"], "fl1");
    expect(r.cases.map((c) => c.fillers)).toEqual([{ setMembers: 3, putLineup: 1 }, undefined, { challenge: 2 }]);
    expect("fillers" in r.cases[1]!).toBe(false);
    expect(fb.opened()).toBe(3);
  });

  it("a driver that reports no fillers at all (an http-shaped driver, an older fake) writes none, and an HTTP run's cases never carry the field", async () => {
    const plain: BrowserRun = { caseDriver: async (co) => ({ driver: Object.assign(new FakeLeagueDriver(co.orgId), { checks: (): CheckResult[] => [] }), close: async () => undefined }), close: async () => undefined };
    const noField = await runWith(deps({ planCases: planOf("L1", [driven("league")]), openBrowserRun: async () => plain }), ["--driver", "browser"], "fl2a");
    expect(noField.cases).toHaveLength(1);
    expect(noField.cases[0]!.fillers).toBeUndefined();
    const http = await runWith(deps(), ["--only", "league|generic", "--scenario", "LIFECYCLE"], "fl2b");
    expect(http.cases.length).toBeGreaterThan(0);
    expect(http.cases.filter((c) => c.fillers !== undefined)).toHaveLength(0);
  });

  it("a case that ended red keeps the fillers it ran before it threw (reading them must not replace the case's own outcome)", async () => {
    const fb = fakeBrowser(() => ({ setMembers: 2 }));
    const s = SCENARIOS.LIFECYCLE;
    const real = s.run.bind(s);
    let seen = 0;
    vi.spyOn(s, "run").mockImplementation(async (ctx) => {
      seen++;
      if (seen === 2) {
        // One real call first, so the driver has run something (the fake reports fillers only after that), then the throw.
        await ctx.driver.createCompetition({ name: "Matrix partial", slug: "matrix-partial" });
        throw new Error("scenario blew up after its first call");
      }
      return real(ctx);
    });
    const r = await runWith(deps({ planCases: planOf("L1", [driven("league"), driven("knockout")]), openBrowserRun: async () => fb.run }), ["--driver", "browser"], "fl3");
    expect(r.cases.map((c) => c.state)).toEqual(["works", "red"]);
    expect(r.cases[1]!.reason).toContain("scenario blew up after its first call");
    expect(r.cases.map((c) => c.fillers)).toEqual([{ setMembers: 2 }, { setMembers: 2 }]);
  });

  it("the real producer: BrowserDriver exposes `fillers` as a getter on its prototype — the name and shape the runner reads", () => {
    const d = Object.getOwnPropertyDescriptor(BrowserDriver.prototype, "fillers");
    expect(d?.get).toBeTypeOf("function");
    expect(d?.set).toBeUndefined();
  });
});

describe("the one-sided check on the evidence this file reads (a helper that parsed nothing would pass every test above)", () => {
  it("the results a run wrote parse through the strict schema with the new fields present", async () => {
    const fb = fakeBrowser(() => ({ setMembers: 1 }));
    const r = await runWith(deps({ planCases: planOf("L1", [driven("league"), noPath("page_playoff_only")]), openBrowserRun: async () => fb.run }), ["--driver", "browser"], "pm9");
    const all: CaseResult[] = r.cases;
    expect(all.some((c) => c.planned === true)).toBe(true);
    expect(all.some((c) => c.fillers !== undefined)).toBe(true);
    expect(r.schemaVersion).toBe(3);
  });
});
