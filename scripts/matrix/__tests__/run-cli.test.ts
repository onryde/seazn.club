import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILDER_PREFERRED_VARIANT, ROW_KEYS, RowBuildDeferred, SPORT_KEYS, builderDefaultVariant, stagesForRow } from "../lib/catalogue.ts";
import { NoOrganiserPath, RefusedCall } from "../lib/driver/types.ts";
import { openBrowserRun, type OpenBrowserRun } from "../lib/browser/browser-run.ts";
import type { PageCtx } from "../lib/browser/pages/ctx.ts";
import type { CaseBrowser } from "../lib/browser/session.ts";
import { EMPTY_PADS, REAL_PAGES, type BrowserDriver, type BrowserPages } from "../lib/driver/browser-driver.ts";
import type { Transport } from "../lib/driver/http-driver.ts";
import { ADVANCED_KINDS, DOUBLE_ELIM_KINDS, expectedGate } from "../lib/format-gates-copy.ts";
import { INVARIANTS } from "../lib/invariants.ts";
import { PROBE_SET, makeProbePlanner, probeRows } from "../lib/probe-set.ts";
import { PAD_PROOF_SET } from "../lib/pad-proof-set.ts";
import { PAD_SPORTS } from "../lib/pad-sports.ts";
import { HOLD_MS_ENV_VAR, resolveHoldMs } from "../../../apps/web/src/components/v2/scorepad/queue.ts";
import { offlineBuilderDefault, offlineVariantOrder, type VariantCase } from "../lib/variants.ts";
import { LOCAL_BASE } from "../lib/redact.ts";
import { baseLiteralsIn } from "./loopback-literals.ts";
import { renderMatrix } from "../lib/render-matrix.ts";
import { main as renderMain } from "../render.ts";
import type { CaseResult, CheckResult, RunResults } from "../lib/results.ts";
import { CANARY_MARK } from "../lib/scenarios/assertions.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { ScenarioUnsupported, type ScenarioContext, type ScenarioOutput } from "../lib/scenarios/types.ts";
import type { Session } from "../../bench/lib/http.ts";
import { resolveSportCfg } from "../lib/sport-cfg.ts";
import { DataDirMismatch, ORG_COOKIE, OrgSwitchFailed, type MatrixSql } from "../lib/seed-org.ts";
import { SCENARIO_KEYS, SLICE_ROWS, SLICE_SPORTS, planSliceCases } from "../lib/slice.ts";
import { NOTES_CAP, closeHandles, describeCommit, gatesNeeded, keepNotes, realDeps, runSlice, summariseRun, withoutBareDashes, type BrowserRun, type CaseDriverOptions, type DbFactories, type RunDeps } from "../run.ts";
import { BROWSER_WIDTHS } from "../lib/widths.ts";
import { FakeDeniedDriver, FakeLeagueDriver } from "./fake-driver.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RUN = join(REPO, "scripts/matrix/run.ts");
/** Every case of the COMMITTED variant set (Task 8), read as a file. */
const committedVariants = (): VariantCase[] =>
  (JSON.parse(readFileSync(join(REPO, "scripts/matrix/catalogue/variants.json"), "utf8")) as { sports: { cases: VariantCase[] }[] }).sports.flatMap((s) => s.cases);

type PrepareCtx = Parameters<RunDeps["prepareCaseOrg"]>[0];
interface DriverCall { base: string; session: Session; orgId: string; driver: FakeLeagueDriver }
type PrepareInput = Parameters<RunDeps["prepareCaseOrg"]>[1];
type Deps = RunDeps & { order: string[]; orgs: PrepareInput[]; ctxs: PrepareCtx[]; emails: string[]; drivers: DriverCall[]; session: Session; planReads: string[] };
/** Every format gate the product declares, derived from the catalogue through the
 *  text-pinned gate map: the fake plan grants all of them unless a test says otherwise. */
const ALL_GATES: readonly string[] = [...new Set(ROW_KEYS.flatMap((r) => { const g = expectedGate(stagesForRow(r)); return g === null ? [] : [g]; }))];

/** Every case gets its OWN org id (`org-<slug>`), and driverFor records what it
 *  was handed — so a stale, constant or empty org id cannot pass unseen. */
function deps(over: Partial<RunDeps> = {}): Deps {
  const order: string[] = [];
  const orgs: PrepareInput[] = [];
  const ctxs: PrepareCtx[] = [];
  const emails: string[] = [];
  const drivers: DriverCall[] = [];
  const session: Session = { cookies: {} };
  const planReads: string[] = [];
  const d: Deps = {
    order,
    orgs,
    ctxs,
    emails,
    drivers,
    session,
    planReads,
    env: { BENCH_EXPECTED_DATA_DIR: "/tmp/pg", SMOKE_BASE: "http://localhost:3999" },
    harnessCommit: async () => "abc1234",
    preflight: async () => { order.push("preflight"); return { ok: true, refusals: [] }; },
    openDb: async () => { order.push("openDb"); return {
      userIdForEmail: async (e: string) => { emails.push(`db ${e}`); return "u1"; },
      variantKeysInBuilderOrder: async (s: string) => (s === "generic" ? ["score", "win_loss"] : ["bwf", "short"]),
      chooseTopPublicPlan: async () => "pro",
      planGrants: async (k: string) => { planReads.push(k); return [...ALL_GATES]; },
      planLimit: async () => null,
      dispose: async () => { order.push("dispose"); },
    }; },
    signIn: async (_b, e) => { order.push("signIn"); emails.push(`signIn ${e}`); return session; },
    prepareCaseOrg: async (ctx, i) => { orgs.push(i); ctxs.push(ctx); return { orgId: `org-${i.slug}`, orgSlug: i.slug, denied: [...(i.deny ?? [])] }; },
    driverFor: (base, s, orgId) => { const driver = new FakeLeagueDriver(orgId); drivers.push({ base, session: s, orgId, driver }); return driver; },
    render: renderMatrix,
    ...over,
  };
  return d;
}

/** Records every sport whose builder variant order the run reads from the DB,
 *  in call order; `deps(over)` builds a Deps whose openDb reports into it. */
function readsOf(base: Deps): { sports: string[]; lists: Map<string, string[]>; deps: (over?: Partial<RunDeps>) => Deps } {
  const sports: string[] = [];
  const lists = new Map<string, string[]>();
  const openDb: RunDeps["openDb"] = async () => {
    const db = await base.openDb();
    return { ...db, variantKeysInBuilderOrder: async (s: string) => {
      sports.push(s);
      const list = await db.variantKeysInBuilderOrder(s);
      lists.set(s, list);
      return list;
    } };
  };
  return { sports, lists, deps: (over = {}) => deps({ openDb, ...over }) };
}

const dirFor = () => mkdtempSync(join(tmpdir(), "fm-"));
const resultsIn = (dir: string, runId: string) => JSON.parse(readFileSync(join(dir, runId, "results.json"), "utf8")) as { cases: CaseResult[] };

/** Everything runSlice prints, captured (and kept off the reporter). */
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => { err.push(String(s)); return true; });
  return { out: () => out.join(""), err: () => err.join("") };
}

/** Wrap a real scenario's run (SCENARIOS is frozen; the scenario objects are not). */
function wrapScenario(key: keyof typeof SCENARIOS, f: (out: ScenarioOutput, ctx: ScenarioContext) => ScenarioOutput, ctxOf: (ctx: ScenarioContext) => ScenarioContext = (c) => c) {
  const s = SCENARIOS[key];
  const orig = s.run.bind(s);
  const seen: ScenarioOutput[] = [];
  vi.spyOn(s, "run").mockImplementation(async (ctx) => { const out = await orig(ctxOf(ctx)); seen.push(out); return f(out, ctx); });
  return seen;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("runSlice — refusals first", () => {
  it("BENCH_EXPECTED_DATA_DIR unset: exit 2 before preflight, DB or sign-in (Review Focus 3)", async () => {
    const io = capture();
    const d = deps({ env: { SMOKE_BASE: "http://localhost:3999" } });
    expect(await runSlice(d, ["--report-dir", dirFor()])).toBe(2);
    expect(d.order).toEqual([]);
    expect(io.err()).toMatch(/BENCH_EXPECTED_DATA_DIR is unset/);
  });
  it("FB-1: a base that is not an http(s) URL: exit 2 before preflight, DB or sign-in, naming it", async () => {
    let checked = 0;
    for (const bad of ["localhost:3999", "not a url", "ftp://localhost:3999"]) {
      const io = capture();
      const d = deps();
      expect(await runSlice(d, ["--report-dir", dirFor(), "--base", bad]), bad).toBe(2);
      expect(d.order, bad).toEqual([]);
      expect(io.err(), bad).toMatch(/BaseNotUrl/);
      vi.restoreAllMocks();
      checked++;
    }
    expect(checked).toBe(3);
  });
  it("a failed preflight: exit 2, no DB, no sign-in", async () => {
    const io = capture();
    const d = deps({ preflight: async () => ({ ok: false, refusals: [{ reason: "db", detail: "foreign data_directory" }] }) });
    expect(await runSlice(d, ["--report-dir", dirFor()])).toBe(2);
    expect(d.order).toEqual([]);
    expect(io.err()).toContain("preflight refused: db — foreign data_directory");
  });
  it("a preflight that throws is a refusal too (exit 2), with nothing after it run", async () => {
    const io = capture();
    const d = deps({ preflight: async () => { throw new Error("probe bug"); } });
    expect(await runSlice(d, ["--report-dir", dirFor()])).toBe(2);
    expect(d.order).toEqual([]);
    expect(io.err()).toMatch(/preflight: Error: probe bug/);
  });
  it("no base URL: exit 2", async () => {
    capture();
    expect(await runSlice(deps({ env: { BENCH_EXPECTED_DATA_DIR: "/tmp/pg" } }), [])).toBe(2);
  });
  it("a preflight refusal is printed redacted — its detail can quote DATABASE_URL (R14a)", async () => {
    const io = capture();
    const d = deps({ preflight: async () => ({ ok: false, refusals: [{ reason: "own_db_connection_failed", detail: "connect postgres://bench:hunter22@localhost:5433/seazn refused" }] }) });
    expect(await runSlice(d, [])).toBe(2);
    expect(io.err()).toContain("[redacted]");
    expect(io.err()).not.toContain("hunter22");
  });

  // PF13: the filter keys are static, so a typo is refused before the run
  // proves its DB, preflights, opens a connection or signs in. The data dir is
  // ALSO unset here: the refusal must name the filter, not the data dir.
  it.each([["--only", "league|genric"], ["--scenario", "M9"], ["--canary", "LIFECYCLE"], ["--only", ""]])(
    "%s '%s' is refused (exit 2, UnknownFilter on stderr) before the own-DB check, preflight, DB or sign-in", async (flag, value) => {
      const io = capture();
      const d = deps({ env: { SMOKE_BASE: "http://localhost:3999" } });
      expect(await runSlice(d, [flag, value, "--report-dir", dirFor()])).toBe(2);
      expect(d.order).toEqual([]);
      expect(io.err()).toMatch(/UnknownFilter: slice: unknown --(only cell|scenario|canary) '/);
      expect(io.err()).not.toMatch(/BENCH_EXPECTED_DATA_DIR/);
    });

  it.each<[string, string[], RegExp]>([
    ["an unknown flag", ["--scenaro", "M1"], /Unknown option '--scenaro'/],
    ["a positional", ["league|generic"], /positional/],
    ["--canary with --only", ["--canary", "M1", "--only", "swiss|badminton"], /--canary runs league\|generic alone/],
    ["--canary with --scenario", ["--canary", "M1", "--scenario", "F1"], /--canary runs league\|generic alone/],
    ["a run id with nothing slug-safe in it", ["--run-id", "!!!"], /--run-id/],
    ["a run id too long for its org slugs", ["--run-id", "a".repeat(41)], /--run-id/],
  ])("%s is a usage error: exit 2, usage on stderr, nothing run", async (_name, argv, why) => {
    const io = capture();
    const d = deps();
    expect(await runSlice(d, [...argv, "--report-dir", dirFor()])).toBe(2);
    expect(d.order).toEqual([]);
    expect(io.err()).toMatch(why);
    expect(io.err()).toMatch(/usage: run\.ts/);
  });

  // W1b Task 10: --set names a planner. A name that is not a set — a typo, the
  // empty string, or a key every object inherits — is refused before the DB.
  it.each(["nope", "", "toString", "__proto__", "constructor"])("an unknown --set '%s' is refused (UnknownSet, exit 2) before the DB", async (name) => {
    const d = deps();
    const io = capture();
    expect(await runSlice(d, ["--set", name, "--report-dir", dirFor()])).toBe(2);
    expect(d.order).toEqual([]);
    expect(io.err()).toContain(`UnknownSet: matrix: unknown --set '${name}' (allowed: ${PROBE_SET}, ${PAD_PROOF_SET})`);
  });
  // W1c Task 7: pad-proof scores every fixture on the pad, so over HTTP it has nothing to prove.
  it("--set pad-proof without --driver browser is refused (exit 2) before the DB, naming the driver it needs", async () => {
    let checked = 0;
    for (const extra of [[], ["--driver", "http"]]) {
      const d = deps();
      const io = capture();
      expect(await runSlice(d, ["--set", PAD_PROOF_SET, ...extra, "--report-dir", dirFor()]), extra.join(" ")).toBe(2);
      expect(d.order, extra.join(" ")).toEqual([]);
      expect(io.err()).toContain(`matrix: --set ${PAD_PROOF_SET} scores every fixture on the pad; it runs with --driver browser only`);
      vi.restoreAllMocks();
      checked++;
    }
    expect(checked).toBe(2);
  });
  it("--set with --only/--scenario/--canary is a usage refusal", async () => {
    for (const extra of [["--only", "league|generic"], ["--scenario", "M1"], ["--canary", "M1"]]) {
      const io = capture();
      const d = deps();
      expect(await runSlice(d, ["--set", PROBE_SET, ...extra])).toBe(2);
      expect(d.order).toEqual([]);
      expect(io.err()).toMatch(/--set runs a named set; it takes no --only, --scenario or --canary/);
      vi.restoreAllMocks();
    }
  });
  it("Review Focus 4: a planner that denies features refuses when REDIS_URL is set, naming it, before the DB", async () => {
    const d = deps({ env: { BENCH_EXPECTED_DATA_DIR: "/tmp/pg", SMOKE_BASE: "http://localhost:3999", REDIS_URL: "redis://localhost:6379" } });
    const io = capture();
    expect(await runSlice(d, ["--set", PROBE_SET, "--report-dir", dirFor()])).toBe(2);
    expect(io.err()).toMatch(/RedisHidesDeny: .*REDIS_URL/);
    // Fix round 1, m-2: the refusal says plainly WHICH environment it read.
    expect(io.err()).toContain("REDIS_URL is set in the harness's own environment");
    expect(io.err()).toContain("the server's environment is not visible to this check");
    expect(io.err()).not.toContain("redis://localhost:6379");
    expect(d.order).toEqual([]);
  });
  it("…and the slice (which denies nothing) still runs with REDIS_URL set", async () => {
    const d = deps({ env: { BENCH_EXPECTED_DATA_DIR: "/tmp/pg", SMOKE_BASE: "http://localhost:3999", REDIS_URL: "redis://x" } });
    capture();
    expect(await runSlice(d, ["--run-id", "rs", "--report-dir", dirFor(), "--only", "league|generic", "--scenario", "LIFECYCLE"])).toBe(0);
    expect(d.order).toEqual(["preflight", "openDb", "signIn", "dispose"]);
  });
  it.each([["absent", undefined], ["empty", ""], ["blank", "  "]])("…and the probe set runs when REDIS_URL is %s", async (_n, redis) => {
    const d = deps({ env: { BENCH_EXPECTED_DATA_DIR: "/tmp/pg", SMOKE_BASE: "http://localhost:3999", ...(redis === undefined ? {} : { REDIS_URL: redis }) } });
    const io = capture();
    expect(await runSlice(d, ["--set", PROBE_SET, "--run-id", "rz", "--report-dir", dirFor()])).toBe(0);
    expect(d.order).toEqual(["preflight", "openDb", "signIn", "dispose"]);
    expect(io.err()).not.toMatch(/RedisHidesDeny/);
  });
  it("a set whose bound variant the engine now refuses is refused before the DB (BoundVariantUnscorable, exit 2)", async () => {
    const d = deps({ planCases: makeProbePlanner({ rescore: () => "win-home: EngineError: refused now" }) });
    const io = capture();
    expect(await runSlice(d, ["--set", PROBE_SET, "--report-dir", dirFor()])).toBe(2);
    expect(io.err()).toMatch(/BoundVariantUnscorable: .*win-home: EngineError: refused now/);
    expect(d.order).toEqual([]);
  });
  it("fix round 1, m-1: a row whose stages cannot be derived refuses the set by name (exit 2, not the zero-cases 1) before the DB", async () => {
    const d = deps({ planCases: makeProbePlanner({ stagesFor: (row) => { if (row === "group_only") throw new Error("template removed"); return stagesForRow(row); } }) });
    const io = capture();
    expect(await runSlice(d, ["--set", PROBE_SET, "--report-dir", dirFor()])).toBe(2);
    expect(io.err()).toContain("matrix: ProbeRowUnderivable: probe-set: row 'group_only' cannot be derived (Error: template removed)");
    expect(d.order).toEqual([]);
  });
});

describe("runSlice — a run", () => {
  it("one league case: guard → preflight → db → sign-in once; writes results.json + MATRIX.md; exit 0", async () => {
    const io = capture();
    const dir = dirFor();
    const d = deps();
    expect(await runSlice(d, ["--only", "league|generic", "--scenario", "LIFECYCLE", "--run-id", "t1", "--report-dir", dir])).toBe(0);
    expect(d.order).toEqual(["preflight", "openDb", "signIn", "dispose"]);
    const results = JSON.parse(readFileSync(join(dir, "t1", "results.json"), "utf8"));
    expect(results.cases).toHaveLength(1);
    expect(results.cases[0].state).toBe("works");
    expect(readFileSync(join(dir, "t1", "MATRIX.md"), "utf8")).toContain("| league |");
    // The line Task 11's smoke reads.
    expect(io.out()).toMatch(/^\[1\/1\] league\|generic\|score\|LIFECYCLE → works \d+ checks, \d+ items$/m);
    expect(io.out()).toContain("vacuous: none");
    expect(io.out()).toContain("error reds: none");
  });
  // Fix round 1 (I-2): through the REAL runCase — scenarios.test's runOn is a
  // copy of its composition and cannot see runCase drop the invariants. A
  // scenario that does not declare `evaluatesInvariants` gets all of them.
  it("a LIFECYCLE case carries every registered invariant, in registry order, and each that applied checked > 0 items", async () => {
    capture();
    const dir = dirFor();
    expect(SCENARIOS.LIFECYCLE.evaluatesInvariants).toBeUndefined();
    expect(await runSlice(deps(), ["--only", "league|generic", "--scenario", "LIFECYCLE", "--run-id", "inv1", "--report-dir", dir])).toBe(0);
    const [c] = resultsIn(dir, "inv1").cases;
    const inv = (c?.checks ?? []).filter((k) => k.kind === "invariant");
    expect(INVARIANTS.length).toBeGreaterThan(0);
    expect(inv.map((k) => k.id)).toEqual(INVARIANTS.map((s) => s.id));
    const applied = inv.filter((k) => k.verdict !== "abstain");
    expect(applied.length, "no invariant applied to a built league — the check would be vacuous").toBeGreaterThan(0);
    for (const k of applied) {
      expect(k.verdict, `${k.id}: ${k.reason}`).toBe("pass");
      expect(k.checked, k.id).toBeGreaterThan(0);
    }
  });
  // W1c Task 3 (D9): an HTTP run is L3 over http with no width (Task 6 makes
  // these follow the CLI). Proven through the REAL producer (runSlice →
  // writeResults) and the REAL consumer (render.ts → parseResults →
  // renderMatrix), never a fixture on both ends.
  it("D9: results.json is schema v3 — the run and every case read L3 over http, width null — and the render CLI reads it back to the MATRIX.md the run wrote", async () => {
    capture();
    const dir = dirFor();
    expect(await runSlice(deps(), ["--only", "league|generic", "--run-id", "v3", "--report-dir", dir])).toBe(0);
    const raw = JSON.parse(readFileSync(join(dir, "v3", "results.json"), "utf8")) as { schemaVersion: unknown; layer: unknown; driver: unknown; cases: Record<string, unknown>[] };
    expect({ schemaVersion: raw.schemaVersion, layer: raw.layer, driver: raw.driver }).toEqual({ schemaVersion: 3, layer: "L3", driver: "http" });
    let checked = 0;
    for (const c of raw.cases) {
      expect({ layer: c.layer, driver: c.driver, width: c.width }, String(c.caseId)).toEqual({ layer: "L3", driver: "http", width: null });
      checked++;
    }
    expect(checked, "cases read").toBe(SCENARIO_KEYS.length);
    const out = join(dir, "re-rendered.md");
    expect(renderMain([join(dir, "v3", "results.json"), "--out", out])).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(readFileSync(join(dir, "v3", "MATRIX.md"), "utf8"));
  });
  it("M4: results.json snapshots the catalogue grid as it is at run time, and MATRIX.md is its render", async () => {
    capture();
    const dir = dirFor();
    expect(await runSlice(deps(), ["--only", "league|generic", "--scenario", "LIFECYCLE", "--run-id", "t1g", "--report-dir", dir])).toBe(0);
    const results = JSON.parse(readFileSync(join(dir, "t1g", "results.json"), "utf8"));
    expect(results.grid).toEqual({ rows: [...ROW_KEYS], sports: [...SPORT_KEYS] });
    expect(readFileSync(join(dir, "t1g", "MATRIX.md"), "utf8")).toContain(`| row | ${SPORT_KEYS.join(" | ")} |`);
  });
  it.each([
    ["ScenarioUnsupported", () => new ScenarioUnsupported("W1b", "team rosters"), "W1b: team rosters"],
    ["RowBuildDeferred", () => new RowBuildDeferred("group_only", "W1b"), "W1b: catalogue: row 'group_only' is API-only; its stage bodies are built in W1b"],
  ] as const)("a %s is ⏳ later with its wave — neither an error red nor vacuous: an honest owner-assigned state (PF4 ruling)", async (_name, make, reason) => {
    const io = capture();
    vi.spyOn(SCENARIOS.LIFECYCLE, "run").mockImplementation(async () => { throw make(); });
    const dir = dirFor();
    expect(await runSlice(deps(), ["--only", "league|generic", "--scenario", "LIFECYCLE", "--run-id", "t9", "--report-dir", dir])).toBe(0);
    expect(resultsIn(dir, "t9").cases[0]).toMatchObject({ state: "later", reason, checks: [] });
    expect(io.out()).toContain("vacuous: none");
    expect(io.out()).toContain("error reds: none");
  });
  it("a knockout case on the league-only fake is red with a redacted error, not a crash", async () => {
    capture();
    const dir = dirFor();
    expect(await runSlice(deps(), ["--only", "knockout|generic", "--scenario", "LIFECYCLE", "--run-id", "t2", "--report-dir", dir])).toBe(0);
    const c = JSON.parse(readFileSync(join(dir, "t2", "results.json"), "utf8")).cases[0];
    expect(c.state).toBe("red");
    expect(c.reason).toMatch(/error: .*league only/);
  });
  it("--canary M1: exit 0 only when the canary check itself is what went red; no MATRIX.md", async () => {
    capture();
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    expect(await runSlice(deps(), ["--canary", "M1", "--run-id", "c1", "--report-dir", dir])).toBe(0);
    expect(existsSync(join(dir, "c1", "MATRIX.md"))).toBe(false);
  });
  // Each pilot's own check, read from the registry — so a verdict that looked
  // up one fixed check would pass M1 and fail the other two.
  it.each(["M1", "R4", "F1"] as const)("--canary %s: results.json holds the one canary case, and it went red on its own check", async (k) => {
    const io = capture();
    const dir = dirFor();
    const want = SCENARIOS[k].canaryCheck!;
    expect(await runSlice(deps(), ["--canary", k, "--run-id", "c1", "--report-dir", dir])).toBe(0);
    const cases = resultsIn(dir, "c1").cases;
    expect(cases.map((c) => [c.caseId, c.canary])).toEqual([[`league|generic|score|${k}|canary`, true]]);
    expect(cases[0]!.checks.filter((c) => c.verdict === "fail").map((c) => c.id)).toEqual([want]);
    // m-1: red for the deliberately wrong expectation only — every failing line is marked.
    const own = cases[0]!.checks.find((c) => c.id === want)!;
    expect(own.evidence.length).toBeGreaterThan(0);
    expect(own.evidence.every((l) => l.startsWith(CANARY_MARK)), own.evidence.join(" | ")).toBe(true);
    expect(io.out()).toContain(`canary ${k}: red on ${want}, as designed`);
  });
  it("m-1 (the review's kill test): --canary M1 over a product that never seats seed 1 exits 1 — its own check is red for want of a target, not the wrong winner", async () => {
    const io = capture();
    const dir = dirFor();
    const driverFor = (_b: string, _s: Session, orgId: string) => new (class extends FakeLeagueDriver {
      override circle() {
        const all = this.entrants;
        this.entrants = all.filter((e) => e.seed !== 1);
        try { return super.circle(); } finally { this.entrants = all; }
      }
    })(orgId);
    expect(await runSlice(deps({ driverFor }), ["--canary", "M1", "--run-id", "k1", "--report-dir", dir])).toBe(1);
    expect(io.out()).toContain("m1-walkover-recorded failed for another reason: no round fixture seated seed 1");
  });
  it.each([
    ["an unmarked reason alone", ["no round fixture seated seed 1"], /failed for another reason: no round fixture seated seed 1/],
    ["the right answer failing beside the marked wrong one", ["winner e2, expected e1", `${CANARY_MARK}winner e2, expected e2`], /failed for another reason: winner e2, expected e1/],
    ["no evidence at all (vacuous)", [], /failed with no evidence: checked 0 items/],
  ] as const)("m-1: --canary M1 whose own check is the ONLY failure but with %s exits 1", async (_what, evidence, message) => {
    const io = capture();
    wrapScenario("M1", (out) => ({
      ...out,
      assertions: out.assertions.map((a) => (a.id === "m1-walkover-recorded"
        ? { ...a, verdict: "fail" as const, checked: evidence.length, reason: evidence[0] ?? "checked 0 items (vacuous, R25)", evidence: [...evidence] }
        : a)),
    }));
    const dir = dirFor();
    expect(await runSlice(deps(), ["--canary", "M1", "--run-id", "k2", "--report-dir", dir])).toBe(1);
    expect(resultsIn(dir, "k2").cases[0]!.checks.filter((c) => c.verdict === "fail").map((c) => c.id)).toEqual(["m1-walkover-recorded"]);
    expect(io.out()).toMatch(message);
  });
  it("m-1: --canary red on its own check (marked) AND another check exits 1 — exactly its own check", async () => {
    const io = capture();
    const other: CheckResult = { id: "other-check", kind: "assertion", verdict: "fail", checked: 1, reason: "unrelated", evidence: ["unrelated"] };
    wrapScenario("M1", (out) => ({ ...out, assertions: [...out.assertions, other] }));
    const dir = dirFor();
    expect(await runSlice(deps(), ["--canary", "M1", "--run-id", "k3", "--report-dir", dir])).toBe(1);
    expect(io.out()).toMatch(/did NOT go red on m1-walkover-recorded \(failed: m1-walkover-recorded, other-check; state red\)$/m);
  });
  it("--canary whose case is red for an UNRELATED reason (an error, no checks): exit 1", async () => {
    const io = capture();
    const dir = dirFor();
    const driverFor = () => new (class extends FakeLeagueDriver { override async createCompetition(): Promise<never> { throw new Error("fake: competitions refused"); } })("org-fake");
    expect(await runSlice(deps({ driverFor }), ["--canary", "M1", "--run-id", "c2", "--report-dir", dir])).toBe(1);
    expect(resultsIn(dir, "c2").cases[0]!.state).toBe("red");
    expect(io.out()).toMatch(/canary M1: did NOT go red on m1-walkover-recorded \(failed: none; state red\)/);
  });
  it("--canary red on ANOTHER check while its own check passes: exit 1", async () => {
    const io = capture();
    const other: CheckResult = { id: "other-check", kind: "assertion", verdict: "fail", checked: 1, reason: "unrelated", evidence: [] };
    // The scenario runs with canary OFF, so its own check passes; one unrelated check fails.
    wrapScenario("M1", (out) => ({ ...out, assertions: [...out.assertions, other] }), (ctx) => ({ ...ctx, spec: { ...ctx.spec, canary: false } }));
    const dir = dirFor();
    expect(await runSlice(deps(), ["--canary", "M1", "--run-id", "c3", "--report-dir", dir])).toBe(1);
    const c = resultsIn(dir, "c3").cases[0]!;
    expect(c.checks.find((k) => k.id === "m1-walkover-recorded")?.verdict).toBe("pass");
    expect(io.out()).toMatch(/did NOT go red on m1-walkover-recorded \(failed: other-check; state red\)/);
  });

  it("the whole of one cell signs in ONCE, and seeds one org per case with a distinct slug", async () => {
    capture();
    const dir = dirFor();
    const d = deps();
    expect(await runSlice(d, ["--only", "league|generic", "--run-id", "t3", "--report-dir", dir])).toBe(0);
    expect(d.order.filter((x) => x === "signIn")).toHaveLength(1);
    expect(d.orgs).toEqual([1, 2, 3, 4].map((n) => ({ name: `Matrix t3 ${n}`, slug: `m-t3-${n}` })));
    expect(d.emails).toEqual(["signIn delivered+matrix-t3@resend.dev", "db delivered+matrix-t3@resend.dev"]);
    expect(resultsIn(dir, "t3").cases.map((c) => c.caseId)).toEqual(["LIFECYCLE", "M1", "R4", "F1"].map((k) => `league|generic|score|${k}`));
    // Every case's org is seeded under the one signed-in session, the owner and the chosen plan…
    expect(d.ctxs).toEqual([1, 2, 3, 4].map(() => ({ base: "http://localhost:3999", session: d.session, userId: "u1", plan: "pro" })));
    expect(d.ctxs.every((c) => c.session === d.session)).toBe(true);
    // …and each case drives THE org it just switched to, over that same session.
    expect(d.drivers.map((x) => [x.base, x.orgId])).toEqual([1, 2, 3, 4].map((n) => ["http://localhost:3999", `org-m-t3-${n}`]));
    expect(d.drivers.every((x) => x.session === d.session)).toBe(true);
  });

  it("the scenario gets the case's own driver, org slug, spec, resolved cfg and tag", async () => {
    capture();
    const ctxs: ScenarioContext[] = [];
    wrapScenario("LIFECYCLE", (out) => out, (ctx) => { ctxs.push(ctx); return ctx; });
    const d = deps();
    expect(await runSlice(d, ["--only", "league|badminton", "--scenario", "LIFECYCLE", "--run-id", "t11", "--report-dir", dirFor()])).toBe(0);
    expect(ctxs).toHaveLength(1);
    const ctx = ctxs[0]!;
    expect(ctx.driver).toBe(d.drivers[0]!.driver);
    expect(ctx.orgSlug).toBe("m-t11-1");
    expect(ctx.tag).toBe("t11-1");
    expect(ctx.spec).toEqual({ caseId: "league|badminton|bwf|LIFECYCLE", row: "league", sport: "badminton", variant: "bwf", scenario: "LIFECYCLE", canary: false });
    expect(ctx.cfg).toEqual(resolveSportCfg("badminton", "bwf"));
  });

  it("a failed org switch reds ONLY its own case: no driver for it, and the rest of the cell still runs", async () => {
    const io = capture();
    const dir = dirFor();
    const base = deps();
    const d = deps({
      prepareCaseOrg: async (ctx, i) => {
        if (i.slug === "m-t12-1") throw new OrgSwitchFailed(`org-${i.slug}`, "POST /api/orgs/active → 500: You are not a member");
        return base.prepareCaseOrg(ctx, i);
      },
    });
    expect(await runSlice(d, ["--only", "league|generic", "--run-id", "t12", "--report-dir", dir])).toBe(0);
    const cases = resultsIn(dir, "t12").cases;
    expect(cases.map((c) => c.state)).toEqual(["red", "works", "works", "works"]);
    expect(cases[0]!.reason).toMatch(/^error: OrgSwitchFailed: seed-org: could not make org-m-t12-1 the active org/);
    expect(d.drivers.map((x) => x.orgId)).toEqual(["org-m-t12-2", "org-m-t12-3", "org-m-t12-4"]);
    expect(io.out()).toContain("error reds: 1");
    expect(io.out()).toContain("error-red league|generic|score|LIFECYCLE: OrgSwitchFailed: seed-org: could not make org-m-t12-1 the active org");
  });

  it("PF8: counts carry the scenario's own event count, the driver's call count and the observed fixtures", async () => {
    capture();
    let driver: FakeLeagueDriver | null = null;
    const seen = wrapScenario("LIFECYCLE", (out) => out);
    const dir = dirFor();
    expect(await runSlice(deps({ driverFor: () => (driver = new FakeLeagueDriver("org-fake")) }), ["--only", "league|generic", "--scenario", "LIFECYCLE", "--run-id", "t4", "--report-dir", dir])).toBe(0);
    const out = seen[0]!;
    expect(out.events).toBeGreaterThan(0);
    const c = resultsIn(dir, "t4").cases[0]!;
    expect(c.counts).toEqual({
      calls: driver!.callCount,
      fixtures: out.observed.stages.reduce((n, s) => n + s.fixtures.length, 0),
      events: out.events,
    });
    expect(c.counts.fixtures).toBeGreaterThan(0);
  });

  it("PF6: a secret-shaped check reason or evidence is redacted before writeResults, so the run is KEPT (exit 0)", async () => {
    const io = capture();
    const leaky: CheckResult = { id: "leaky", kind: "assertion", verdict: "pass", checked: 1, reason: "saw token=abcdefghijklmnopqrstuvwxyz0123456789ABCD", evidence: ["row from postgres://bench:hunter22@localhost:5433/seazn"] };
    wrapScenario("LIFECYCLE", (out) => ({ ...out, assertions: [...out.assertions, leaky] }));
    const dir = dirFor();
    expect(await runSlice(deps(), ["--only", "league|generic", "--scenario", "LIFECYCLE", "--run-id", "t5", "--report-dir", dir])).toBe(0);
    const k = resultsIn(dir, "t5").cases[0]!.checks.find((x) => x.id === "leaky")!;
    expect(k.reason).toBe("saw [redacted]");
    expect(k.evidence).toEqual(["row from [redacted]"]);
    expect(io.err()).not.toMatch(/SecretInResults/);
  });

  it("M-7 then FB-1: the run's base in a check's evidence or a case's error is written as LOCAL_BASE — in results.json and in MATRIX.md; another port is kept", async () => {
    capture();
    // SMOKE_BASE is http://localhost:3999 (deps). 127.0.0.1:5433 is a database, not the base.
    const local: CheckResult = { id: "local", kind: "assertion", verdict: "pass", checked: 1, reason: "GET http://localhost:3999/api/v1/x answered", evidence: ["from 127.0.0.1:5433", "then ::1:3999"] };
    wrapScenario("LIFECYCLE", (out) => ({ ...out, assertions: [...out.assertions, local] }));
    const dir = dirFor();
    expect(await runSlice(deps(), ["--only", "league|generic", "--scenario", "LIFECYCLE", "--run-id", "t5l", "--report-dir", dir])).toBe(0);
    const k = resultsIn(dir, "t5l").cases[0]!.checks.find((x) => x.id === "local")!;
    expect(k.reason).toBe(`GET ${LOCAL_BASE}/api/v1/x answered`);
    expect(k.evidence).toEqual(["from 127.0.0.1:5433", `then ${LOCAL_BASE}`]);
    // A case's error is the reason MATRIX.md renders.
    const driverFor = () => new (class extends FakeLeagueDriver { override async createCompetition(): Promise<never> { throw new Error("fetch http://localhost:3999/api/v1/competitions failed"); } })("org-fake");
    const dir2 = dirFor();
    expect(await runSlice(deps({ driverFor }), ["--only", "league|generic", "--scenario", "LIFECYCLE", "--run-id", "t6l", "--report-dir", dir2])).toBe(0);
    expect(resultsIn(dir2, "t6l").cases[0]!.reason).toMatch(new RegExp(`^error: Error: fetch ${LOCAL_BASE.replace(/[[\]]/g, "\\$&")}/api/v1/competitions failed`));
    let checked = 0;
    for (const [d, id] of [[dir, "t5l"], [dir2, "t6l"]] as const) {
      for (const f of ["results.json", "MATRIX.md"]) {
        const text = readFileSync(join(d, id, f), "utf8");
        expect(text.length, `${id}/${f}`).toBeGreaterThan(0);
        expect(baseLiteralsIn(text, 3999), `${id}/${f}`).toEqual([]);
        checked++;
      }
    }
    expect(checked).toBe(4);
    expect(readFileSync(join(dir2, "t6l", "MATRIX.md"), "utf8"), "the error reaches MATRIX.md, scrubbed").toContain(`fetch ${LOCAL_BASE}/api/v1/competitions failed`);
  });

  it("m-5: the scenario's own notes reach results.json — the stage status after start among them", async () => {
    capture();
    const seen = wrapScenario("LIFECYCLE", (out) => out);
    const dir = dirFor();
    expect(await runSlice(deps(), ["--only", "league|generic", "--scenario", "LIFECYCLE", "--run-id", "t5n", "--report-dir", dir])).toBe(0);
    const notes = resultsIn(dir, "t5n").cases[0]!.notes;
    expect(seen[0]!.notes.length).toBeGreaterThan(0);
    expect(notes).toEqual(seen[0]!.notes);
    expect(notes.some((n) => /^stage league status after start: /.test(n))).toBe(true);
  });

  it("m-5: a secret-shaped note is redacted before writeResults, so the run is KEPT (exit 0)", async () => {
    const io = capture();
    wrapScenario("LIFECYCLE", (out) => ({ ...out, notes: ["complete refused from postgres://bench:hunter22@localhost:5433/seazn"] }));
    const dir = dirFor();
    expect(await runSlice(deps(), ["--only", "league|generic", "--scenario", "LIFECYCLE", "--run-id", "t5r", "--report-dir", dir])).toBe(0);
    expect(resultsIn(dir, "t5r").cases[0]!.notes).toEqual(["complete refused from [redacted]"]);
    expect(io.err()).not.toMatch(/SecretInResults/);
  });

  it.each([
    ["none", 0, []],
    ["exactly the cap", NOTES_CAP, []],
    ["one over the cap", NOTES_CAP + 1, ["… 1 more note(s) not kept"]],
    ["ten over the cap", NOTES_CAP + 10, ["… 10 more note(s) not kept"]],
  ])("m-5: keepNotes keeps the first NOTES_CAP notes, then counts the rest — %s", (_t, n, tail) => {
    const notes = Array.from({ length: n }, (_, i) => `note ${i}`);
    expect(keepNotes(notes)).toEqual([...notes.slice(0, NOTES_CAP), ...tail]);
  });

  it("m-5: NOTES_CAP is 24, and keepNotes redacts every note it keeps", () => {
    expect(NOTES_CAP).toBe(24);
    expect(keepNotes(["ok", "saw token=abcdefghijklmnopqrstuvwxyz0123456789ABCD"])).toEqual(["ok", "saw [redacted]"]);
  });

  it("a case's error is redacted in results.json and on stdout (R14a)", async () => {
    const io = capture();
    const driverFor = () => new (class extends FakeLeagueDriver { override async createCompetition(): Promise<never> { throw new Error("config DATABASE_URL=postgres://bench:hunter22@localhost:5433/seazn"); } })("org-fake");
    const dir = dirFor();
    expect(await runSlice(deps({ driverFor }), ["--only", "league|generic", "--scenario", "LIFECYCLE", "--run-id", "t6", "--report-dir", dir])).toBe(0);
    const c = resultsIn(dir, "t6").cases[0]!;
    expect(c.state).toBe("red");
    expect(c.reason).toMatch(/^error: Error: config \[redacted\]/);
    expect(readFileSync(join(dir, "t6", "results.json"), "utf8")).not.toContain("hunter22");
    expect(io.out()).not.toContain("hunter22");
  });

  it("stdout is redacted at the line, not only at each source: even the user's own --report-dir is printed redacted", async () => {
    const io = capture();
    const dir = join(dirFor(), "token=abcdefghijklmnopqrstuvwxyz0123456789ABCD");
    expect(await runSlice(deps(), ["--only", "league|generic", "--scenario", "LIFECYCLE", "--run-id", "t10", "--report-dir", dir])).toBe(0);
    expect(existsSync(join(dir, "t10", "results.json"))).toBe(true);
    expect(io.out()).toMatch(/^results → .*\[redacted\]/m);
    expect(io.out()).not.toContain("abcdefghijklmnop");
  });

  it("PF4: a product refusal is listed as an error red with its code, method and path — and is not vacuous", async () => {
    const io = capture();
    const driverFor = () => new (class extends FakeLeagueDriver {
      override async postStages(): Promise<never> { throw new RefusedCall("POST", "/api/v1/divisions/d1/stages", 400, "VALIDATION", "bad stage body"); }
    })("org-fake");
    const dir = dirFor();
    expect(await runSlice(deps({ driverFor }), ["--only", "league|generic", "--scenario", "LIFECYCLE", "--run-id", "t7", "--report-dir", dir])).toBe(0);
    expect(resultsIn(dir, "t7").cases[0]!.reason).toMatch(/^error: RefusedCall: POST \/api\/v1\/divisions\/d1\/stages → HTTP 400 VALIDATION/);
    expect(io.out()).toContain("vacuous: none");
    expect(io.out()).toContain("error reds: 1");
    expect(io.out()).toContain("error-red league|generic|score|LIFECYCLE: POST /api/v1/divisions/d1/stages → 400 VALIDATION");
  });

  it("zero cases: results.json and the 'No cases run' banner are written, exit 1 (planner seam, no shared-state edit)", async () => {
    capture();
    const dir = dirFor();
    const planCases = () => ({ sports: [] as string[], deniesFeatures: false, plan: () => [] });
    const reads = readsOf(deps());
    expect(await runSlice(reads.deps({ planCases }), ["--run-id", "t8", "--report-dir", dir])).toBe(1);
    expect(resultsIn(dir, "t8").cases).toEqual([]);
    expect(readFileSync(join(dir, "t8", "MATRIX.md"), "utf8")).toContain("No cases run");
    expect(reads.sports).toEqual([]); // the planner's sports are what is read — none here
  });

  it("the default planner is the slice: rows × sports × scenarios, in that declared order, variants read once per slice sport", async () => {
    capture();
    const dir = dirFor();
    const reads = readsOf(deps());
    expect(await runSlice(reads.deps(), ["--run-id", "t8b", "--report-dir", dir])).toBe(0);
    expect(reads.sports).toEqual([...SLICE_SPORTS]); // once each, in the slice's own order
    // The builder default for a slice sport is the first variant the DB lists:
    // neither slice sport has a BUILDER_PREFERRED_VARIANT entry (guarded here).
    const variantOf = (sport: string): string => {
      expect(BUILDER_PREFERRED_VARIANT[sport], sport).toBeUndefined();
      const first = reads.lists.get(sport)?.[0];
      if (first === undefined) throw new Error(`test: no variant list was read for '${sport}'`);
      return first;
    };
    // Expected ids from the slice's DECLARED rows, sports and scenarios — not from planSliceCases.
    const expected = SLICE_ROWS.flatMap((row) => SLICE_SPORTS.flatMap((sport) => SCENARIO_KEYS.map((sc) => `${row}|${sport}|${variantOf(sport)}|${sc}`)));
    expect(expected.length).toBe(SLICE_ROWS.length * SLICE_SPORTS.length * SCENARIO_KEYS.length);
    expect(expected.length).toBeGreaterThan(0); // anti-vacuity
    expect(resultsIn(dir, "t8b").cases.map((c) => c.caseId)).toEqual(expected);
  });

  it("a sport the planner did not declare is refused by name (exit 3), never blamed on the catalogue", async () => {
    const io = capture();
    const dir = dirFor();
    const reads = readsOf(deps());
    const planCases = () => ({ sports: [] as string[], deniesFeatures: false, plan: (variantFor: (s: string) => string) => planSliceCases(variantFor, { only: "league|generic", scenario: "LIFECYCLE" }) });
    expect(await runSlice(reads.deps({ planCases }), ["--run-id", "t8c", "--report-dir", dir])).toBe(3);
    expect(io.err()).toMatch(/UndeclaredPlannerSport: .*'generic'/);
    expect(io.err()).not.toMatch(/has no system variants/);
    expect(reads.sports).toEqual([]);
    expect(existsSync(join(dir, "t8c"))).toBe(false);
  });

  // ⛔ (Task 9). A planner that plants a deny declares it (CasePlanner.deniesFeatures, Task 10).
  const deniedPlan = () => ({ sports: ["generic"], deniesFeatures: true, plan: (v: (s: string) => string) => [
    { caseId: "double_elim|generic|score|DENIED", row: "double_elim", sport: "generic", variant: v("generic"), scenario: "DENIED", canary: false, deny: ["formats.double_elim"] },
  ] as never });
  it("a DENIED case: deny keys reach prepareCaseOrg, invariants are skipped, the state is ⛔ refused", async () => {
    const dir = dirFor();
    const d = deps({ planCases: deniedPlan, driverFor: (_b, _s, orgId) => new FakeDeniedDriver(new Map([["double_elim", "formats.double_elim"]]), { deleteFirst: false }, orgId) });
    capture();
    expect(await runSlice(d, ["--run-id", "den", "--report-dir", dir])).toBe(0);
    expect(d.orgs[0]).toMatchObject({ deny: ["formats.double_elim"] });
    const [c] = resultsIn(dir, "den").cases;
    expect(c!.state).toBe("refused");
    expect(c!.reason).toBe("denied: formats.double_elim (ruling 24)");
    expect(c!.checks.map((k) => k.id)).toEqual(["denied-refused-named", "denied-nothing-created", "denied-put-keeps-stages"]);
    expect(c!.checks.every((k) => k.kind === "assertion")).toBe(true);
    expect(readFileSync(join(dir, "den", "MATRIX.md"), "utf8")).toContain("⛔");
  });
  it("a DENIED case whose PUT deletes the kept stages is ❌ red, never ⛔ — the mandate cannot hide a failed check", async () => {
    const dir = dirFor();
    const d = deps({ planCases: deniedPlan, driverFor: (_b, _s, orgId) => new FakeDeniedDriver(new Map([["double_elim", "formats.double_elim"]]), { deleteFirst: true }, orgId) });
    capture();
    expect(await runSlice(d, ["--run-id", "den2", "--report-dir", dir])).toBe(0);
    const [c] = resultsIn(dir, "den2").cases;
    expect(c!.state).toBe("red");
    expect(c!.reason).toMatch(/^denied-put-keeps-stages: /);
  });
  // Fix round 1 (m-1): what reaches the scenario is the deny prepareCaseOrg
  // APPLIED. One that did not land is a named harness error, never the
  // product "forgetting its paywall".
  it("a DENIED case whose org came back undenied is a named DeniedMisuse red, with no product call made", async () => {
    const dir = dirFor();
    const drivers: FakeDeniedDriver[] = [];
    const d = deps({
      planCases: deniedPlan,
      prepareCaseOrg: async (_c, i) => ({ orgId: `org-${i.slug}`, orgSlug: i.slug, denied: [] }),
      driverFor: (_b, _s, orgId) => { const f = new FakeDeniedDriver(new Map([["double_elim", "formats.double_elim"]]), { deleteFirst: false }, orgId); drivers.push(f); return f; },
    });
    capture();
    expect(await runSlice(d, ["--run-id", "den4", "--report-dir", dir])).toBe(0);
    const [c] = resultsIn(dir, "den4").cases;
    expect(c!.state).toBe("red");
    expect(c!.reason).toMatch(/^error: DeniedMisuse: denied: case double_elim\|generic\|score\|DENIED carries no deny for formats\.double_elim \(applied: none; asked: formats\.double_elim\)/);
    expect(drivers).toHaveLength(1);
    expect(drivers[0]!.callCount).toBe(0);
  });
  it("a slice case carries no deny to prepareCaseOrg", async () => {
    const dir = dirFor();
    const d = deps();
    capture();
    await runSlice(d, ["--run-id", "den3", "--report-dir", dir, "--only", "league|generic", "--scenario", "LIFECYCLE"]);
    expect(d.orgs).toHaveLength(1);
    expect(d.orgs[0]?.deny).toBeUndefined();
  });

  // W1b Task 10.
  it("runCase resolves the case cfg WITH its overrides (the scenario scores under what the division stores)", async () => {
    const cfgs: unknown[] = [];
    wrapScenario("LIFECYCLE", (out) => out, (ctx) => { cfgs.push(ctx.cfg); return ctx; });
    const planCases = () => ({ sports: ["generic"], deniesFeatures: false, plan: (v: (s: string) => string) => [
      { caseId: "league|generic|score|LIFECYCLE|v", row: "league", sport: "generic", variant: v("generic"), scenario: "LIFECYCLE", canary: false, overrides: { allowDraws: false } },
    ] as never });
    capture();
    expect(await runSlice(deps({ planCases }), ["--run-id", "ov", "--report-dir", dirFor()])).toBe(0);
    expect(cfgs.length).toBe(1);
    // The preset allows draws, so the override is what turns it off.
    expect((resolveSportCfg("generic", "score") as { allowDraws?: unknown }).allowDraws).toBe(true);
    expect((cfgs[0] as { allowDraws?: unknown }).allowDraws).toBe(false);
    expect(cfgs[0]).toEqual(resolveSportCfg("generic", "score", { allowDraws: false }));
  });
  it("--set w1b-probe through the REAL runSlice: every case runs in the planned order, DENIED orgs carry their gate and read ⛔, variant cases score under their override", async () => {
    const dir = dirFor();
    const cfgs = new Map<string, unknown>();
    wrapScenario("LIFECYCLE", (out) => out, (ctx) => { cfgs.set(ctx.spec.caseId, ctx.cfg); return ctx; });
    // The product's gate order (createStages: double-elim first, then advanced), from the text-pinned copy.
    const gates = new Map<string, string>([...DOUBLE_ELIM_KINDS.map((k) => [k, "formats.double_elim"] as const), ...ADVANCED_KINDS.map((k) => [k, "formats.advanced"] as const)]);
    const d: Deps = deps({
      driverFor: (_b, _s, orgId) => ((d.orgs.at(-1)?.deny ?? []).length > 0 ? new FakeDeniedDriver(gates, { deleteFirst: false }, orgId) : new FakeLeagueDriver(orgId)),
    });
    capture();
    expect(await runSlice(d, ["--set", PROBE_SET, "--run-id", "pr", "--report-dir", dir])).toBe(0);
    const cases = resultsIn(dir, "pr").cases;
    expect(cases.length).toBe(probeRows().api.length + 7 + 2);
    // Every case got its own org, and exactly the gated rows' orgs were denied their own gate.
    expect(d.orgs.length).toBe(cases.length);
    const deniedRows = ROW_KEYS.filter((r) => expectedGate(stagesForRow(r)) !== null);
    expect(cases.filter((c) => c.scenario === "DENIED").map((c) => c.row)).toEqual(deniedRows);
    cases.forEach((c, i) => {
      expect(d.orgs[i]?.deny, c.caseId).toEqual(c.scenario === "DENIED" ? [expectedGate(stagesForRow(c.row))] : undefined);
    });
    // Fix round 1, I-1: a gated row's ALLOWED path runs too, in an org denied nothing.
    const allowedGated = cases.flatMap((c, i) => (c.scenario === "LIFECYCLE" && expectedGate(stagesForRow(c.row)) !== null ? [{ row: c.row, deny: d.orgs[i]?.deny }] : []));
    expect(allowedGated).toEqual(probeRows().api.filter((r) => expectedGate(stagesForRow(r)) !== null).map((row) => ({ row, deny: undefined })));
    expect(allowedGated.length).toBeGreaterThan(0);
    expect(cases.filter((c) => c.scenario === "DENIED").map((c) => c.state)).toEqual(deniedRows.map(() => "refused"));
    // The two variant cases: generic and badminton, each scored under preset + its committed override.
    const bound = cases.filter((c) => /\|[a-z]+#\d{3}$/.test(c.caseId));
    expect(bound.map((c) => c.sport)).toEqual([...SLICE_SPORTS]);
    for (const c of bound) {
      const id = c.caseId.split("|").at(-1)!;
      const vc = committedVariants().find((x) => x.id === id)!;
      expect(vc, id).toBeDefined();
      expect(cfgs.get(c.caseId), c.caseId).toEqual(resolveSportCfg(vc.sport, vc.preset, { ...vc.overrides }));
      expect(cfgs.get(c.caseId), c.caseId).not.toEqual(resolveSportCfg(vc.sport, vc.preset));
      expect(c.state, `${c.caseId}: ${c.reason}`).toBe("works");
    }
  });
  it("a planner that plans a deny while declaring deniesFeatures false is aborted by name (exit 3) before any case — the Redis guard cannot be bypassed", async () => {
    const planCases = () => ({ sports: ["generic"], deniesFeatures: false, plan: (v: (s: string) => string) => [
      { caseId: "double_elim|generic|score|DENIED", row: "double_elim", sport: "generic", variant: v("generic"), scenario: "DENIED", canary: false, deny: ["formats.double_elim"] },
    ] as never });
    const d = deps({ planCases });
    const io = capture();
    const dir = dirFor();
    expect(await runSlice(d, ["--run-id", "ud", "--report-dir", dir])).toBe(3);
    expect(io.err()).toMatch(/UndeclaredDeny: .*double_elim\|generic\|score\|DENIED/);
    expect(d.orgs).toEqual([]);
    expect(existsSync(join(dir, "ud"))).toBe(false);
  });
});

describe("runSlice — aborts after the start gates", () => {
  it("a failed sign-in aborts (exit 3): the DB is still disposed, nothing is written, the reason is redacted", async () => {
    const io = capture();
    const dir = dirFor();
    const d = deps({ signIn: async () => { throw new Error("consume https://localhost:3999/login?x=1 token=abcdefghijklmnopqrstuvwxyz0123456789ABCD"); } });
    expect(await runSlice(d, ["--run-id", "a1", "--report-dir", dir])).toBe(3);
    expect(d.order).toEqual(["preflight", "openDb", "dispose"]);
    expect(existsSync(join(dir, "a1"))).toBe(false);
    expect(io.err()).toMatch(/matrix: aborted — Error: consume .*\[redacted\]/);
    expect(io.err()).not.toContain("abcdefghijklmnop");
  });
  it("the harness commit is read before the DB opens: a failure there aborts (exit 3) with no DB opened", async () => {
    capture();
    const d = deps({ harnessCommit: async () => { throw new Error("not a git checkout"); } });
    expect(await runSlice(d, ["--run-id", "a2", "--report-dir", dirFor()])).toBe(3);
    expect(d.order).toEqual(["preflight"]);
  });
  it("a DB that stops proving it is ours mid-run refuses the whole run (exit 2), writes nothing and runs no further case", async () => {
    const io = capture();
    const dir = dirFor();
    const d = deps({ prepareCaseOrg: async () => { throw new DataDirMismatch("/tmp/pg", "/var/other"); } });
    expect(await runSlice(d, ["--only", "league|generic", "--run-id", "a3", "--report-dir", dir])).toBe(2);
    expect(d.order).toEqual(["preflight", "openDb", "signIn", "dispose"]);
    expect(existsSync(join(dir, "a3"))).toBe(false);
    expect(io.err()).toMatch(/matrix: refused — DataDirMismatch/);
    expect(io.out()).not.toMatch(/\[2\/4\]/);
  });
  it("a failing dispose after the cases is reported, not allowed to lose the run", async () => {
    const io = capture();
    const dir = dirFor();
    const base = deps();
    const d = deps({ openDb: async () => ({ ...(await base.openDb()), dispose: async () => { throw new Error("end timed out"); } }) });
    expect(await runSlice(d, ["--only", "league|generic", "--scenario", "LIFECYCLE", "--run-id", "a4", "--report-dir", dir])).toBe(0);
    expect(resultsIn(dir, "a4").cases).toHaveLength(1);
    expect(io.err()).toMatch(/dispose failed — Error: end timed out/);
  });
  it("MATRIX.md failing to render still prints the PF4 summary and keeps results.json (exit 3)", async () => {
    const io = capture();
    const dir = dirFor();
    // Parked Task 9: the render is injected to throw (the refusal renderMatrix
    // makes for a case off the grid), rather than splicing the exported
    // SLICE_SPORTS in place — a test that needs a shared constant to be mutable.
    const rendered: RunResults[] = [];
    const render = (r: RunResults): string => { rendered.push(r); throw new Error("renderMatrix: case league|generic|score|LIFECYCLE (row 'league', sport 'generic') is not on this run's own grid (results.grid)"); };
    expect(await runSlice(deps({ render }), ["--only", "league|generic", "--scenario", "LIFECYCLE", "--run-id", "a5", "--report-dir", dir])).toBe(3);
    // The render was handed exactly what results.json holds.
    expect(rendered).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(rendered[0]))).toEqual(resultsIn(dir, "a5"));
    expect(resultsIn(dir, "a5").cases.map((c) => [c.caseId, c.state])).toEqual([["league|generic|score|LIFECYCLE", "works"]]);
    expect(existsSync(join(dir, "a5", "MATRIX.md"))).toBe(false);
    expect(io.out()).toContain("vacuous: none");
    expect(io.out()).toContain("error reds: none");
    expect(io.err()).toMatch(/matrix: results\.json kept at .*a5\/results\.json; MATRIX\.md failed — Error: renderMatrix: case league\|generic\|score\|LIFECYCLE .* is not on this run's own grid/);
  });
  it("realDeps renders MATRIX.md with renderMatrix (the seam is wired, not inert)", () => {
    expect(realDeps().render).toBe(renderMatrix);
  });

  // Review Focus 5 (W1b Task 10). The live lists are derived from the offline
  // order (engine variants, codepoint-sorted titles), never typed: reversed,
  // the builder's first pick changes for any sport with no preferred variant.
  const reversedDefault = (sport: string): string[] => {
    const live = [...offlineVariantOrder(sport)].reverse();
    expect(BUILDER_PREFERRED_VARIANT[sport], sport).toBeUndefined();
    expect(builderDefaultVariant(sport, live), `${sport}: reversing did not move the default`).not.toBe(offlineBuilderDefault(sport));
    return live;
  };
  const dbWith = (lists: (s: string) => string[]): Partial<RunDeps> => ({ openDb: async () => ({
    userIdForEmail: async () => "u1",
    variantKeysInBuilderOrder: async (s: string) => lists(s),
    chooseTopPublicPlan: async () => "pro",
    planGrants: async () => [...ALL_GATES],
    planLimit: async () => null,
    dispose: async () => {},
  }) });
  it("Review Focus 5: a live builder default that differs from the offline one refuses (exit 2) naming both keys, before any case", async () => {
    const drift = reversedDefault("generic");
    const d = deps(dbWith((s) => (s === "generic" ? drift : offlineVariantOrder(s))));
    const io = capture();
    const dir = dirFor();
    expect(await runSlice(d, ["--run-id", "drift", "--report-dir", dir])).toBe(2);
    // Fix round 1, m-3: a refusal says "refused" (exit 2), and names the remedy
    // that can work — regenerating the catalogue cannot (the offline default
    // is derived from the engine at run time).
    expect(io.err()).toContain(`matrix: refused — BuilderDefaultDrift: matrix: generic: the live builder default is '${builderDefaultVariant("generic", drift)}' but the committed catalogue assumes '${offlineBuilderDefault("generic")}' — the DB collation orders the system variants differently from codepoint order. Fix the ordering or BUILDER_PREFERRED_VARIANT (catalogue.ts); regenerating the catalogue cannot fix it, because the offline default is derived from the engine at run time.`);
    expect(io.err()).not.toMatch(/aborted|regenerate or fix/);
    expect(d.orgs).toEqual([]);
    expect(existsSync(join(dir, "drift"))).toBe(false);
  });
  it("…a drift on the planner's SECOND sport is caught too (every declared sport is compared, not the first)", async () => {
    const drift = reversedDefault("badminton");
    const d = deps(dbWith((s) => (s === "badminton" ? drift : offlineVariantOrder(s))));
    const io = capture();
    expect(await runSlice(d, ["--set", PROBE_SET, "--run-id", "drift2", "--report-dir", dirFor()])).toBe(2);
    expect(io.err()).toMatch(/BuilderDefaultDrift: matrix: badminton: /);
    expect(d.orgs).toEqual([]);
  });
  it("…and live lists whose default IS the offline one run, for the slice and for the probe set", async () => {
    for (const argv of [[], ["--set", PROBE_SET]]) {
      const d = deps(dbWith((s) => offlineVariantOrder(s)));
      capture();
      expect(await runSlice(d, [...argv, "--run-id", "nodrift", "--report-dir", dirFor()])).toBe(0);
      expect(d.orgs.length).toBeGreaterThan(0);
      vi.restoreAllMocks();
    }
  });
});

// Fix round 2, RR-1. The case orgs' plan is chosen by privilege COUNT, not for
// any gate. Gates are derived from the rows through the text-pinned gate map.
describe("RR-1: the case orgs' plan must grant every gate a planned case touches — refused before any case", () => {
  const gateOf = (row: string): string => {
    const g = expectedGate(stagesForRow(row));
    if (g === null) throw new Error(`test: row '${row}' is not gated`);
    return g;
  };
  const one = (spec: Record<string, unknown>) => () => ({ sports: ["generic"], deniesFeatures: spec.deny !== undefined, plan: (v: (s: string) => string) => [
    { sport: "generic", variant: v("generic"), canary: false, ...spec },
  ] as never });
  const allowed = one({ caseId: "page_playoff_only|generic|score|LIFECYCLE", row: "page_playoff_only", scenario: "LIFECYCLE" });
  const denied = one({ caseId: "double_elim|generic|score|DENIED", row: "double_elim", scenario: "DENIED", deny: [gateOf("double_elim")] });
  const grantsOnly = (grants: readonly string[]) => (d: Deps): Partial<RunDeps> => ({ openDb: async () => ({ ...(await deps().openDb()), planGrants: async (k: string) => { d.planReads.push(k); return [...grants]; } }) });
  const run = async (planCases: () => unknown, grants: readonly string[], id: string) => {
    const base = deps({ planCases: planCases as never });
    const d: Deps = { ...base, ...grantsOnly(grants)(base) };
    const io = capture();
    const dir = dirFor();
    const code = await runSlice(d, ["--run-id", id, "--report-dir", dir]);
    return { code, d, io, dir };
  };

  it("the fake plan's full grant list is non-empty (else every 'grants' case below proves nothing)", () => {
    expect(ALL_GATES.length).toBeGreaterThanOrEqual(2);
  });
  it("an ALLOWED case on a gated row, the plan lacking its gate: PlanLacksGate (exit 2), naming plan, case and gate; no org, nothing written", async () => {
    const gate = gateOf("page_playoff_only");
    const { code, d, io, dir } = await run(allowed, ALL_GATES.filter((g) => g !== gate), "rr1a");
    expect(code).toBe(2);
    expect(io.err()).toContain(`matrix: refused — PlanLacksGate: matrix: the case orgs' plan 'pro' does not grant ${gate}`);
    expect(io.err()).toContain(`page_playoff_only|generic|score|LIFECYCLE (allowed path: the plan's 402 would read as a product red)`);
    expect(d.planReads).toEqual(["pro"]);
    expect(d.orgs).toEqual([]);
    expect(existsSync(join(dir, "rr1a"))).toBe(false);
  });
  it("…the plan granting it: the allowed case runs, in an org denied nothing", async () => {
    const { code, d } = await run(allowed, [gateOf("page_playoff_only")], "rr1b");
    expect(code).toBe(0);
    expect(d.planReads).toEqual(["pro"]);
    expect(d.orgs.map((o) => o.deny)).toEqual([undefined]);
  });
  it("a DENIED case whose gate the plan lacks: PlanLacksGate (exit 2) — its ⛔ would come from the plan, not the planted deny", async () => {
    const gate = gateOf("double_elim");
    const { code, d, io } = await run(denied, ALL_GATES.filter((g) => g !== gate), "rr1c");
    expect(code).toBe(2);
    expect(io.err()).toContain(`double_elim|generic|score|DENIED (denied path: its refusal would come from the plan, not the deny under test)`);
    expect(d.orgs).toEqual([]);
  });
  it("…the plan granting it: the DENIED case runs and its org carries the deny", async () => {
    const { code, d } = await run(denied, [gateOf("double_elim")], "rr1d");
    expect(code).toBe(0);
    expect(d.orgs.map((o) => o.deny)).toEqual([[gateOf("double_elim")]]);
  });
  it("the probe set on a plan without formats.advanced refuses naming exactly the rows that gate needs, and no other", async () => {
    const lacking = gateOf("americano");
    const base = deps();
    const d: Deps = { ...base, ...grantsOnly(ALL_GATES.filter((g) => g !== lacking))(base) };
    const io = capture();
    expect(await runSlice(d, ["--set", PROBE_SET, "--run-id", "rr1e", "--report-dir", dirFor()])).toBe(2);
    const named = [...io.err().matchAll(/([a-z_]+)\|generic\|score\|(LIFECYCLE|DENIED) \(/g)].map((m) => `${m[1]}|${m[2]}`);
    const want = ROW_KEYS.filter((r) => expectedGate(stagesForRow(r)) === lacking).map((r) => `${r}|DENIED`);
    expect(want.length).toBeGreaterThan(0);
    expect(named).toEqual(want);
    expect(d.orgs).toEqual([]);
  });
  it("final batch FB-7: a case whose stages fire BOTH gates needs both — gatesNeeded takes every gate a row fires, not the first (task 10 review m-6)", () => {
    const spec = (row: string, deny?: readonly string[]) => ({ caseId: `${row}|generic|score|${deny === undefined ? "LIFECYCLE" : "DENIED"}`, row, sport: "generic", variant: "score", scenario: deny === undefined ? "LIFECYCLE" : "DENIED", canary: false, ...(deny === undefined ? {} : { deny }) }) as never;
    // No row needs both today (format-gates-copy.test.ts sweeps them), so the stages are injected.
    const bothStages = () => [{ kind: DOUBLE_ELIM_KINDS[0]! }, { kind: "league", config: { placements: [] } }];
    expect(gatesNeeded([spec("x")], bothStages).map((g) => [g.gate, g.path])).toEqual([["formats.double_elim", "allowed"], ["formats.advanced", "allowed"]]);
    // The pairs: a real gated row needs exactly its one gate; a DENIED case needs what it denies.
    expect(gatesNeeded([spec("double_elim")]).map((g) => g.gate)).toEqual([gateOf("double_elim")]);
    expect(gatesNeeded([spec("double_elim", [gateOf("double_elim")])]).map((g) => [g.gate, g.path])).toEqual([[gateOf("double_elim"), "denied"]]);
    expect(gatesNeeded([spec("league")])).toEqual([]);
  });
  it("a run whose cases touch no gate (the slice) never reads the plan's grants", async () => {
    const d = deps();
    capture();
    expect(await runSlice(d, ["--run-id", "rr1f", "--report-dir", dirFor(), "--only", "league|generic", "--scenario", "LIFECYCLE"])).toBe(0);
    expect(d.planReads).toEqual([]);
  });
  it("an allowed case whose row cannot be derived is not aborted by the gate check: it runs, and reds on its own derivation", async () => {
    // The render is stubbed: renderMatrix refuses a row off the grid, which is not what this pins.
    const d = deps({ planCases: one({ caseId: "nope|generic|score|LIFECYCLE", row: "nope", scenario: "LIFECYCLE" }) as never, render: () => "" });
    capture();
    const dir = dirFor();
    expect(await runSlice(d, ["--run-id", "rr1g", "--report-dir", dir])).toBe(0);
    expect(d.orgs).toHaveLength(1);
    const [c] = resultsIn(dir, "rr1g").cases;
    expect(c!.state).toBe("red");
    expect(c!.reason).toMatch(/UnknownRow/);
  });
  it("realDeps wires planGrants to the gated MatrixSql (the seam is not inert)", async () => {
    const log: string[] = [];
    const sql = { planGrants: async (k: string) => { log.push(`m.planGrants ${k}`); return ["formats.double_elim"]; } };
    const f: DbFactories = {
      matrixSql: () => ({ sql: sql as never, dispose: async () => {} }),
      planSql: () => ({ sql: {} as never, dispose: async () => {} }),
    };
    expect(await (await realDeps(f).openDb()).planGrants("pro")).toEqual(["formats.double_elim"]);
    expect(log).toEqual(["m.planGrants pro"]);
  });
  it("realDeps wires planLimit to the gated MatrixSql (T15 fix round 1: the seam is not inert)", async () => {
    const log: string[] = [];
    const sql = { planLimit: async (k: string, f: string) => { log.push(`m.planLimit ${k} ${f}`); return 20; } };
    const f: DbFactories = {
      matrixSql: () => ({ sql: sql as never, dispose: async () => {} }),
      planSql: () => ({ sql: {} as never, dispose: async () => {} }),
    };
    expect(await (await realDeps(f).openDb()).planLimit("pro", "divisions.per_competition.max")).toBe(20);
    expect(log).toEqual(["m.planLimit pro divisions.per_competition.max"]);
  });
});

describe("summariseRun (PF4) — empty first", () => {
  const base = { row: "league", sport: "generic", variant: "score", scenario: "LIFECYCLE", canary: false, counts: { calls: 0, fixtures: 0, events: 0 }, durationMs: 0, notes: [], layer: "L3" as const, driver: "http" as const, width: null };
  const chk = (verdict: CheckResult["verdict"], checked: number): CheckResult => ({ id: `k-${verdict}-${checked}`, kind: "invariant", verdict, checked, reason: "", evidence: [] });
  const kase = (caseId: string, state: CaseResult["state"], reason: string, checks: CheckResult[]): CaseResult => ({ ...base, caseId, state, reason, checks });

  it("no cases: nothing vacuous, no error reds", () => {
    expect(summariseRun([], new Map())).toEqual({ vacuous: [], errorReds: [] });
  });
  it("vacuous = a non-error, non-deferred case with no applied check over at least one item; error reds are listed apart; ⏳ deferrals are neither", () => {
    const cases = [
      kase("abstained", "red", "every check abstained (vacuous)", [chk("abstain", 0)]),
      kase("zero-items", "red", "checked zero items (vacuous): k", [chk("pass", 0)]),
      // Controller ruling (fix round 1): ⏳ is an honest owner-assigned state, never vacuity.
      kase("deferred", "later", "W1b: team rosters", []),
      // …and so is 🚫 (W1c Task 6, M-4 ruling): a path this layer does not drive, owned by a wave.
      kase("no-path", "no_path", "W1-driving: the division builder takes no rule override", []),
      kase("works", "works", "1 checks, 3 items", [chk("pass", 3), chk("abstain", 0)]),
      kase("real-red", "red", "k: wrong", [chk("fail", 2)]),
      kase("refused", "red", "error: RefusedCall: POST /x → HTTP 400 VALIDATION: bad", []),
      kase("crashed", "red", "error: TypeError: boom", []),
    ];
    // decideState counts an abstain as not applied whatever its `checked` says; so does this.
    cases.splice(1, 0, kase("abstained-with-items", "red", "every check abstained (vacuous)", [chk("abstain", 2)]));
    const refusals = new Map([["refused", { method: "POST", path: "/x", status: 400, code: "VALIDATION" }]]);
    expect(summariseRun(cases, refusals)).toEqual({
      vacuous: ["abstained", "abstained-with-items", "zero-items"],
      errorReds: [
        { caseId: "refused", error: "RefusedCall: POST /x → HTTP 400 VALIDATION: bad", refusal: { method: "POST", path: "/x", status: 400, code: "VALIDATION" } },
        { caseId: "crashed", error: "TypeError: boom", refusal: null },
      ],
    });
  });
});

describe("realDeps wiring (Task 7 M3)", () => {
  it("createRealMatrixSql() is called with NO argument — the same process.env DATABASE_URL createRealPlanSql reads", () => {
    // Line comments out, so a comment that spells the call cannot stand in for one.
    const code = readFileSync(RUN, "utf8").replace(/\/\/.*$/gm, "");
    const all = code.match(/createRealMatrixSql\(/g) ?? [];
    expect(all.length).toBeGreaterThan(0);
    expect(code.match(/createRealMatrixSql\(\)/g) ?? []).toHaveLength(all.length);
  });

  /** Fake handles for realDeps' two DB sites: what opened, what closed, and
   *  whether a close throws. No postgres client is ever built. */
  function fakeDb(opts: { mThrows?: boolean; pThrows?: boolean; insert?: Error } = {}) {
    const log: string[] = [];
    const sql: MatrixSql = {
      userIdForEmail: async () => "u1",
      insertCaseOrg: async () => { log.push("m.insertCaseOrg"); if (opts.insert) throw opts.insert; return { orgId: "o1", orgSlug: "s" }; },
      listPlanKeys: async () => [],
      variantKeysInBuilderOrder: async () => [],
      denyFeature: async () => { log.push("m.denyFeature"); },
      planGrants: async () => { log.push("m.planGrants"); return ["formats.double_elim"]; },
      planLimit: async () => null,
    };
    const f: DbFactories = {
      matrixSql: () => { log.push("m.open"); return { sql, dispose: async () => { log.push("m.dispose"); if (opts.mThrows) throw new Error("m end timed out"); } }; },
      planSql: () => { log.push("p.open"); return { sql: {} as never, dispose: async () => { log.push("p.dispose"); if (opts.pThrows) throw new Error("p end timed out"); } }; },
    };
    return { f, log };
  }

  it("closeHandles closes every handle even when one throws, warns each failure, and never throws", async () => {
    const io = capture();
    const closed: string[] = [];
    const h = (n: string, fail: boolean) => ({ dispose: async () => { closed.push(n); if (fail) throw new Error(`${n} failed`); } });
    await expect(closeHandles(h("a", true), h("b", true), h("c", false))).resolves.toBeUndefined();
    expect(closed).toEqual(["a", "b", "c"]);
    expect(io.err()).toContain("matrix: dispose failed — Error: a failed");
    expect(io.err()).toContain("matrix: dispose failed — Error: b failed");
  });

  it.each([["the first", { mThrows: true }], ["the second", { pThrows: true }]] as const)(
    "openDb's dispose: %s handle throwing still closes the other, and the dispose itself does not throw", async (_n, opts) => {
      const io = capture();
      const { f, log } = fakeDb(opts);
      const db = await realDeps(f).openDb();
      await expect(db.dispose()).resolves.toBeUndefined();
      expect(log).toEqual(["m.open", "p.open", "m.dispose", "p.dispose"]);
      expect(io.err()).toMatch(/matrix: dispose failed — Error: [mp] end timed out/);
    });

  // Fix round 1 (m-1): the deny's hop THROUGH realDeps — the one a refactor
  // rebuilding `{ name, slug }` there would silently drop. bench raw() and
  // request() run for real against a loopback server standing in for the
  // product's two routes; only the two SQL handles are fakes.
  it("prepareCaseOrg carries the deny through realDeps to denyFeature, after the provision, and returns what was applied", async () => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
      req.on("end", () => {
        hits.push(`${req.method} ${req.url}`);
        const reply = (status: number, v: unknown, cookie?: string) => {
          res.writeHead(status, { "content-type": "application/json", ...(cookie === undefined ? {} : { "set-cookie": cookie }) });
          res.end(JSON.stringify(v));
        };
        if (req.method === "POST" && req.url === "/api/orgs/active") return reply(200, { ok: true, data: {} }, `${ORG_COOKIE}=${(JSON.parse(body) as { org_id: string }).org_id}; Path=/`);
        if (req.url === "/api/admin/orgs/o1/entitlement-override") return reply(200, { ok: true, data: {} });
        return reply(404, { ok: false, error: "not found" });
      });
    });
    await new Promise<void>((r) => { server.listen(0, "127.0.0.1", r); });
    try {
      const { port } = server.address() as AddressInfo;
      const log: string[] = [];
      const m: MatrixSql = {
        userIdForEmail: async () => "u1",
        insertCaseOrg: async (i) => { log.push(`m.insert ${i.slug}`); return { orgId: "o1", orgSlug: i.slug }; },
        listPlanKeys: async () => [],
        variantKeysInBuilderOrder: async () => [],
        denyFeature: async (i) => { log.push(`m.deny ${i.orgId} ${i.featureKey}`); },
        planGrants: async () => [],
        planLimit: async () => null,
      };
      const p = {
        getOrgSubscriptionId: async (o: string) => { log.push(`p.subscription? ${o}`); return "sub1"; },
        updateSubscriptionPlan: async (s: string, plan: string) => { log.push(`p.plan ${s} ${plan}`); },
        createSubscriptionForOrg: async () => { log.push("p.create"); },
        setOwnerStaff: async (o: string, on: boolean) => { log.push(`p.staff ${o} ${String(on)}`); },
      };
      const f: DbFactories = { matrixSql: () => ({ sql: m, dispose: async () => {} }), planSql: () => ({ sql: p as never, dispose: async () => {} }) };
      const ctx = { base: `http://127.0.0.1:${port}`, session: { cookies: {} }, userId: "u1", plan: "pro" };
      const out = await realDeps(f).prepareCaseOrg(ctx, { name: "Matrix r 1", slug: "m-r-1", deny: ["formats.double_elim", "formats.advanced"] });
      expect(out).toEqual({ orgId: "o1", orgSlug: "m-r-1", denied: ["formats.double_elim", "formats.advanced"] });
      expect(log).toEqual(["m.insert m-r-1", "p.subscription? o1", "p.plan sub1 pro", "p.staff o1 true", "p.staff o1 false", "m.deny o1 formats.double_elim", "m.deny o1 formats.advanced"]);
      expect(hits).toEqual(["POST /api/orgs/active", "POST /api/admin/orgs/o1/entitlement-override", "DELETE /api/admin/orgs/o1/entitlement-override"]);
      // The second call, with no deny: nothing denied, nothing claimed.
      log.length = 0;
      const plain = await realDeps(f).prepareCaseOrg({ ...ctx, session: { cookies: {} } }, { name: "Matrix r 2", slug: "m-r-2" });
      expect(plain).toEqual({ orgId: "o1", orgSlug: "m-r-2", denied: [] });
      expect(log.filter((l) => l.startsWith("m.deny"))).toEqual([]);
      expect(log[0]).toBe("m.insert m-r-2");
    } finally {
      await new Promise<void>((r) => { server.close(() => { r(); }); });
    }
  });

  it("a case's org seeding: a throwing dispose neither leaks the other handle nor masks an in-flight DataDirMismatch", async () => {
    capture();
    const { f, log } = fakeDb({ mThrows: true, insert: new DataDirMismatch("/tmp/pg", "/var/other") });
    const ctx = { base: "http://localhost:3999", session: { cookies: {} }, userId: "u1", plan: "pro" };
    await expect(realDeps(f).prepareCaseOrg(ctx, { name: "Matrix r 1", slug: "m-r-1" })).rejects.toBeInstanceOf(DataDirMismatch);
    expect(log).toEqual(["m.open", "p.open", "m.insertCaseOrg", "m.dispose", "p.dispose"]);
  });
});

describe("run.ts as a CLI — refusal paths only (no DB, no server)", () => {
  const cli = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", RUN, ...args], { cwd: REPO, encoding: "utf8", timeout: 25_000, env: { PATH: process.env.PATH ?? "", ...env } });

  it("an unknown filter: exit 2 with UnknownFilter on stderr, before the own-DB refusal", () => {
    const r = cli(["--only", "league|genric"], { SMOKE_BASE: "http://localhost:3999" });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/UnknownFilter: slice: unknown --only cell 'league\|genric'/);
    expect(r.stderr).not.toMatch(/BENCH_EXPECTED_DATA_DIR/);
  });
  it("no BENCH_EXPECTED_DATA_DIR: exit 2 naming it", () => {
    const r = cli(["--base", "http://localhost:3999"], {});
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/BENCH_EXPECTED_DATA_DIR is unset/);
  });
  it("an unknown flag: exit 2 with usage — never the uncaught throw's exit 1", () => {
    const r = cli(["--bogus"], {});
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/usage: run\.ts/);
  });
});

describe("describeCommit (final review m-6) — evidence never names a commit that did not produce it", () => {
  it("clean → the short sha; a tracked change → <sha>-dirty; untracked files are not asked about", () => {
    const calls: string[][] = [];
    const git = (status: string) => (args: string[]) => { calls.push(args); return args[0] === "rev-parse" ? "abc1234\n" : status; };
    expect(describeCommit(git(""))).toBe("abc1234");
    expect(describeCommit(git("\n"))).toBe("abc1234");
    expect(describeCommit(git(" M scripts/matrix/run.ts\n"))).toBe("abc1234-dirty");
    expect(calls).toContainEqual(["status", "--porcelain", "--untracked-files=no"]);
    expect(calls).toContainEqual(["rev-parse", "--short", "HEAD"]);
  });

  it("against a real repository: committed → clean, a tracked edit → dirty, a staged edit → dirty, an untracked file alone → clean", () => {
    const root = mkdtempSync(join(tmpdir(), "fm-git-"));
    try {
      const g = (args: string[]) => execFileSync("git", ["-c", "user.name=Matrix Test", "-c", "user.email=matrix@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, encoding: "utf8" });
      g(["init", "-q"]);
      writeFileSync(join(root, "a.txt"), "one\n");
      g(["add", "a.txt"]);
      g(["commit", "-q", "-m", "one"]);
      const sha = g(["rev-parse", "--short", "HEAD"]).trim();
      expect(describeCommit(g)).toBe(sha);
      writeFileSync(join(root, "new.txt"), "untracked\n");
      expect(describeCommit(g)).toBe(sha);
      writeFileSync(join(root, "a.txt"), "two\n");
      expect(describeCommit(g)).toBe(`${sha}-dirty`);
      g(["add", "a.txt"]);
      expect(describeCommit(g)).toBe(`${sha}-dirty`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("realDeps' harnessCommit is describeCommit over real git (comments stripped, so a comment cannot stand in)", () => {
    const code = readFileSync(RUN, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const body = /harnessCommit: \(\) => ([^\n]+)/.exec(code)?.[1] ?? "";
    expect(body).toContain('describeCommit((args) => execFileSync("git", args');
    expect(code).not.toMatch(/execFileSync\("git", \["rev-parse"/);
  });
});

// W1c Task 6: --driver browser --width. The browser itself is injected
// (RunDeps.openBrowserRun); what is proven here is the runner's wiring: the
// refusals, one case driver per case closed in a finally, the driver's checks
// in the case, the D9 fields following the CLI, and one browser per run
// closed exactly once.
interface FakeBrowserRun { run: BrowserRun; log: string[]; opts: CaseDriverOptions[] }
/** A browser run whose case drivers are league fakes carrying one check of their own.
 *  `checksThrow`: reading the driver's checks throws (fix round 1, M-2). */
function fakeBrowserRun(o: { failCaseAt?: number; checksThrow?: boolean } = {}): FakeBrowserRun {
  const log: string[] = [];
  const opts: CaseDriverOptions[] = [];
  const run: BrowserRun = {
    caseDriver: async (co) => {
      opts.push(co);
      if (o.failCaseAt === opts.length) throw new Error("browser: newContext refused");
      log.push(`open ${co.evidenceId}`);
      const driver = Object.assign(new FakeLeagueDriver(co.orgId), {
        checks: (): CheckResult[] => {
          if (o.checksThrow) throw new Error("checks unreadable");
          return [{ id: "browser-probe", kind: "assertion", verdict: "pass", checked: 1, reason: `driver of ${co.evidenceId}`, evidence: [] }];
        },
      });
      return { driver, close: async () => { log.push(`close ${co.evidenceId}`); } };
    },
    close: async () => { log.push("run closed"); },
  };
  return { run, log, opts };
}

describe("runSlice — --driver browser --width (W1c Task 6)", () => {
  it("usage: browser without a width, a width outside BROWSER_WIDTHS, a width on an http run, and an unknown driver are each refused (exit 2) before anything runs", async () => {
    const io = capture();
    const cases: [string[], RegExp][] = [
      [["--driver", "browser"], /--driver browser needs --width/],
      [["--driver", "browser", "--width", "999"], new RegExp(`--width must be one of ${BROWSER_WIDTHS.join(", ")}, got 999`)],
      [["--driver", "browser", "--width", "320.5"], /--width must be one of .*, got 320\.5/],
      [["--driver", "browser", "--width", ""], /--width must be one of .*, got/],
      // Digits only: Number() reads both of these as 320 (found by mutation).
      [["--driver", "browser", "--width", "320.0"], /--width must be one of .*, got 320\.0/],
      [["--driver", "browser", "--width", "0x140"], /--width must be one of .*, got 0x140/],
      [["--width", "320"], /--width is a browser run's width; it takes --driver browser/],
      [["--driver", "http", "--width", "320"], /--width is a browser run's width; it takes --driver browser/],
      [["--driver", "chrome"], /--driver must be http or browser, got chrome/],
    ];
    let checked = 0;
    for (const [argv, want] of cases) {
      const fb = fakeBrowserRun();
      let opened = 0;
      const d = deps({ openBrowserRun: async () => { opened++; return fb.run; } });
      expect(await runSlice(d, [...argv, "--run-id", "u1", "--report-dir", dirFor()]), argv.join(" ")).toBe(2);
      expect(d.order, argv.join(" ")).toEqual([]);
      expect(opened, argv.join(" ")).toBe(0);
      expect(io.err(), argv.join(" ")).toMatch(want);
      checked++;
    }
    expect(checked).toBe(cases.length);
    // Positive pair: each allowed width is accepted (and the default driver is http).
    expect(BROWSER_WIDTHS.length).toBeGreaterThan(0);
  });

  it("every case gets its own case driver on its own org, closed after it; its checks carry the driver's; results read L1 over browser at the width asked, caseIds suffixed @<width>", async () => {
    capture();
    const dir = dirFor();
    const fb = fakeBrowserRun();
    let opened = 0;
    const d = deps({ openBrowserRun: async () => { opened++; return fb.run; } });
    expect(await runSlice(d, ["--only", "league|generic", "--driver", "browser", "--width", "320", "--run-id", "b1", "--report-dir", dir])).toBe(0);
    expect(opened).toBe(1);
    const raw = JSON.parse(readFileSync(join(dir, "b1", "results.json"), "utf8")) as { layer: unknown; driver: unknown; cases: CaseResult[] };
    expect({ layer: raw.layer, driver: raw.driver }).toEqual({ layer: "L1", driver: "browser" });
    expect(raw.cases).toHaveLength(SCENARIO_KEYS.length);
    let probed = 0;
    for (const [i, c] of raw.cases.entries()) {
      expect({ layer: c.layer, driver: c.driver, width: c.width }, c.caseId).toEqual({ layer: "L1", driver: "browser", width: 320 });
      expect(c.caseId).toMatch(/^league\|generic\|[^@]+@320$/);
      if (!c.reason.startsWith("error:")) {
        expect(c.checks.map((k) => k.id), c.caseId).toContain("browser-probe");
        expect(c.checks.find((k) => k.id === "browser-probe")?.reason).toBe(`driver of case-${i + 1}`);
        probed++;
      }
    }
    expect(probed, "no case carried its driver's checks").toBeGreaterThan(0);
    // One driver per case, each closed before the next opens; the run's browser closed once, last.
    expect(fb.log).toEqual([...raw.cases.flatMap((_c, i) => [`open case-${i + 1}`, `close case-${i + 1}`]), "run closed"]);
    expect(fb.opts.map((o) => [o.width, o.padPolicy, o.reportDir, o.base])).toEqual(raw.cases.map(() => [320, "first", join(dir, "b1"), "http://localhost:3999"]));
    expect(fb.opts.map((o) => o.orgId)).toEqual(d.orgs.map((org) => `org-${org.slug}`));
    expect(fb.opts.map((o) => o.orgSlug)).toEqual(d.orgs.map((org) => org.slug));
    expect(fb.opts.every((o) => o.session === d.session)).toBe(true);
    expect(fb.opts.map((o) => o.spec.caseId)).toEqual(raw.cases.map((c) => c.caseId.replace(/@320$/, "")));
    // The HTTP factory is not used on a browser run.
    expect(d.drivers).toEqual([]);
    expect(readFileSync(join(dir, "b1", "MATRIX.md"), "utf8")).toContain("| league |");
  });

  it("--set pad-proof --driver browser: one league PADPROOF case per pad sport, each case driver built with the scenario's padPolicy (all), its own org and case-<n>", async () => {
    capture();
    const dir = dirFor();
    const fb = fakeBrowserRun();
    const d = deps({ openBrowserRun: async () => fb.run });
    expect(await runSlice(d, ["--set", PAD_PROOF_SET, "--driver", "browser", "--width", "320", "--run-id", "pp1", "--report-dir", dir])).toBe(0);
    const raw = resultsIn(dir, "pp1");
    expect(raw.cases.map((c) => [c.sport, c.scenario])).toEqual(PAD_SPORTS.map((s) => [s, "PADPROOF"]));
    expect(fb.opts).toHaveLength(PAD_SPORTS.length);
    expect(fb.opts.map((o) => o.padPolicy)).toEqual(PAD_SPORTS.map(() => "all"));
    expect(fb.opts.map((o) => o.evidenceId)).toEqual(PAD_SPORTS.map((_s, i) => `case-${i + 1}`));
    expect(fb.opts.map((o) => o.orgId)).toEqual(d.orgs.map((org) => `org-${org.slug}`));
  });

  it("a case whose scenario throws is red, and its case driver is still closed (finally)", async () => {
    capture();
    vi.spyOn(SCENARIOS.LIFECYCLE, "run").mockImplementation(async () => { throw new Error("scenario boom"); });
    const dir = dirFor();
    const fb = fakeBrowserRun();
    const d = deps({ openBrowserRun: async () => fb.run });
    expect(await runSlice(d, ["--only", "league|generic", "--scenario", "LIFECYCLE", "--driver", "browser", "--width", "1280", "--run-id", "b2", "--report-dir", dir])).toBe(0);
    const [c] = resultsIn(dir, "b2").cases;
    expect(c).toMatchObject({ state: "red", width: 1280, driver: "browser" });
    expect(c!.reason).toMatch(/scenario boom/);
    expect(fb.log).toEqual(["open case-1", "close case-1", "run closed"]);
    // Fix round 1, M-2: the thrown case keeps what its driver recorded (its evidence).
    expect(c!.checks.map((k) => k.id)).toEqual(["browser-probe"]);
    expect(c!.checks[0]!.reason).toBe("driver of case-1");
  });

  it("M-2: a driver whose checks cannot be read after a throw leaves the case's own error as its outcome, warned, never replaced", async () => {
    const io = capture();
    vi.spyOn(SCENARIOS.LIFECYCLE, "run").mockImplementation(async () => { throw new Error("scenario boom"); });
    const dir = dirFor();
    const fb = fakeBrowserRun({ checksThrow: true });
    expect(await runSlice(deps({ openBrowserRun: async () => fb.run }), ["--only", "league|generic", "--scenario", "LIFECYCLE", "--driver", "browser", "--width", "1280", "--run-id", "b2t", "--report-dir", dir])).toBe(0);
    const [c] = resultsIn(dir, "b2t").cases;
    expect(c).toMatchObject({ state: "red", checks: [] });
    expect(c!.reason).toMatch(/^error: .*scenario boom/);
    expect(io.err()).toMatch(/its driver's checks could not be read — Error: checks unreadable/);
    expect(fb.log).toEqual(["open case-1", "close case-1", "run closed"]);
  });

  it("M-4 ruling: a case whose driver has no organiser path for it is 🚫 no_path naming the owning wave — never an error red, never vacuous", async () => {
    const io = capture();
    const dir = dirFor();
    const run: BrowserRun = {
      caseDriver: async (co) => {
        const driver = Object.assign(new FakeLeagueDriver(co.orgId), {
          createDivision: async () => { throw new NoOrganiserPath("W1-driving", "the division builder takes no rule override (pointsToWin)"); },
          checks: (): CheckResult[] => [],
        });
        return { driver, close: async () => undefined };
      },
      close: async () => undefined,
    };
    expect(await runSlice(deps({ openBrowserRun: async () => run }), ["--only", "league|generic", "--scenario", "LIFECYCLE", "--driver", "browser", "--width", "1280", "--run-id", "np", "--report-dir", dir])).toBe(0);
    const [c] = resultsIn(dir, "np").cases;
    expect(c).toMatchObject({ state: "no_path", reason: "W1-driving: the division builder takes no rule override (pointsToWin)", checks: [] });
    expect(io.out()).toMatch(/vacuous: none/);
    expect(io.out()).toMatch(/error reds: none/);
  });

  it("fix round 1 (a): pnpm 10 forwards the `--` of `pnpm run matrix:browser -- --width W` into argv mid-list; every bare `--` is dropped, so the flags after it are read", async () => {
    const io = capture();
    // Measured (pnpm 10.34.5): the script's own flags, then the `--`, then the user's.
    const opened: string[] = [];
    const d0 = deps({ openBrowserRun: async () => { opened.push("d0"); return fakeBrowserRun().run; } });
    expect(await runSlice(d0, ["--driver", "browser", "--", "--width", "999", "--run-id", "dd0", "--report-dir", dirFor()])).toBe(2);
    expect(io.err()).toMatch(/--width must be one of .*, got 999/);
    expect(io.err()).not.toMatch(/Unexpected argument/);
    // Both scripts' forms run: matrix:browser's (mid-list) and matrix:l3's (leading).
    let ran = 0;
    for (const [argv, id, driver] of [
      [["--driver", "browser", "--", "--width", "320", "--only", "league|generic", "--scenario", "LIFECYCLE"], "dd1", "browser"],
      [["--", "--only", "league|generic", "--scenario", "LIFECYCLE"], "dd2", "http"],
    ] as const) {
      const dir = dirFor();
      const d = deps({ openBrowserRun: async () => { opened.push(id); return fakeBrowserRun().run; } });
      expect(await runSlice(d, [...argv, "--run-id", id, "--report-dir", dir]), id).toBe(0);
      expect(resultsIn(dir, id).cases.map((c) => c.driver), id).toEqual([driver]);
      ran++;
    }
    expect(ran).toBe(2);
    expect(opened).toEqual(["dd1"]);
    // A bare `--` is never a flag's value — parseArgs refuses `--run-id --` as
    // ambiguous with or without the drop — and `--run-id=--` is one token, kept.
    expect(await runSlice(deps(), ["--run-id", "--", "--report-dir", dirFor()])).toBe(2);
    expect(withoutBareDashes(["--run-id=--", "--", "a", "--"])).toEqual(["--run-id=--", "a"]);
  });

  it("I-3: the REAL --driver browser path — openBrowserRun → caseDriver → BrowserDriver, faked only at the page and wire — carries each case's org slug, org id, expected org id, pad policy and evidence id into its driver", async () => {
    capture();
    const dir = dirFor();
    const runId = "i3";
    const seen: { n: number; orgSlug: string; base: string; holdMs: number }[] = [];
    const wire: { base: string; path: string; method: string | undefined; session: Session }[] = [];
    let current = "";
    const unexpected = async () => { throw new Error("an unexpected page call"); };
    const pages = {
      ...Object.fromEntries(Object.keys(REAL_PAGES).map((k) => [k, unexpected])),
      createCompetitionUi: async (ctx: PageCtx, input: { name: string }) => {
        const n = d.orgs.length; // prepareCaseOrg ran for this case first
        seen.push({ n, orgSlug: ctx.orgSlug, base: ctx.base, holdMs: ctx.holdMs });
        const shotPage = { evaluate: async () => ({ scrollWidth: 320, clientWidth: 320 }), screenshot: async () => new Uint8Array([137, 80, 78, 71]) };
        await ctx.evidence.shot(shotPage as unknown as Parameters<PageCtx["evidence"]["shot"]>[0], "01-competition");
        // The case org as the runner planned it — never read back from ctx.
        return { id: `comp-${n}`, org_id: `org-${d.orgs.at(-1)!.slug}`, name: input.name, slug: `prod-slug-${n}`, visibility: "unlisted", status: "draft" };
      },
      createDivisionUi: async () => { throw new Error("STOP: past what this test drives"); },
    } as unknown as BrowserPages;
    const transport: Transport = {
      raw: async (base, s, path, method, body) => {
        wire.push({ base, path, method, session: s });
        if (path === "/api/v1/competitions" && method === "POST") {
          return { status: 201, json: { ok: true, data: { id: "c-http", slug: (body as { slug: string }).slug, org_id: current, visibility: "unlisted" } } };
        }
        return { status: 404, json: { ok: false, error: "NOT_FOUND" } };
      },
    };
    const drivers: BrowserDriver[] = [];
    const wrap = (r: OpenBrowserRun): BrowserRun => ({
      caseDriver: async (o) => { const cd = await r.caseDriver(o); drivers.push(cd.driver); return cd; },
      close: () => r.close(),
    });
    // Carry M-6: the served build's hold is read once, on the run's own base.
    const preflights: string[] = [];
    // The page fakes above read `d` only when a case runs, after this line.
    const d = deps({
      openBrowserRun: async (b) => wrap(await openBrowserRun(b, {
        servedHold: async (base) => { preflights.push(base); return { holdMs: resolveHoldMs("2500"), found: 1, scanned: 1 }; },
        launch: async () => ({ close: async () => undefined }),
        newCase: async () => ({ page: { setDefaultTimeout: () => undefined } as unknown as CaseBrowser["page"], close: async () => undefined }),
        env: { [HOLD_MS_ENV_VAR]: "2500" }, pads: EMPTY_PADS, pages, transport,
      })),
    });
    expect(await runSlice(d, ["--only", "league|generic", "--driver", "browser", "--width", "320", "--run-id", runId, "--report-dir", dir])).toBe(0);
    const cases = resultsIn(dir, runId).cases;
    expect(cases.length).toBeGreaterThanOrEqual(2);
    // Every case reached the builder: nothing refused it earlier (an OrgMismatch on a wrong org id would).
    for (const c of cases) expect(c.reason, c.caseId).toMatch(/^error: Error: STOP/);
    // orgSlug and base reach the page context, per case.
    expect(seen.map((s) => s.n)).toEqual(cases.map((_c, i) => i + 1));
    expect(seen.map((s) => s.orgSlug)).toEqual(d.orgs.map((o) => o.slug));
    expect(seen.every((s) => s.base === "http://localhost:3999")).toBe(true);
    // Carry N-2: the build's hold window reaches every case's page context from
    // the run's env, as the product itself resolves it (not the default).
    expect(resolveHoldMs("2500")).not.toBe(resolveHoldMs(undefined));
    expect(seen.map((s) => s.holdMs)).toEqual(cases.map(() => resolveHoldMs("2500")));
    expect(preflights).toEqual(["http://localhost:3999"]);
    // The evidence id: each case's shot lands under its own case-<n>, and the case keeps it (M-2).
    let shots = 0;
    for (const [i, c] of cases.entries()) {
      expect(existsSync(join(dir, runId, "shots", `case-${i + 1}`, "01-competition.png")), c.caseId).toBe(true);
      expect(c.checks.find((k) => k.id === "visual-evidence"), c.caseId).toMatchObject({ verdict: "pass", checked: 1 });
      shots++;
    }
    expect(shots).toBe(cases.length);
    // padPolicy and the HTTP side's expected org id: the second createCompetition
    // goes over the wire ("first"), and lands only in the case's own org.
    expect(drivers).toHaveLength(cases.length);
    for (const [i, drv] of drivers.entries()) {
      expect(drv.padPolicy, `case ${i + 1}`).toBe("first");
      // Carry N-2: each driver scores the case it was built for.
      const c = cases[i]!;
      expect({ ...drv.spec }, `case ${i + 1}`).toEqual({ caseId: c.caseId.replace(/@320$/, ""), row: c.row, sport: c.sport, variant: c.variant, scenario: c.scenario, canary: c.canary });
      current = `org-${d.orgs[i]!.slug}`;
      await expect(drv.createCompetition({ name: "again", slug: `again-${i + 1}` }), `case ${i + 1}`).resolves.toMatchObject({ orgId: current });
    }
    expect(wire.map((w) => [w.base, w.path, w.method])).toEqual(drivers.map(() => ["http://localhost:3999", "/api/v1/competitions", "POST"]));
    expect(wire.every((w) => w.session === d.session)).toBe(true);
  });

  it("no browser (openBrowserRun rejects, the runner has none, or the served build's hold is not the shell's — M-6): exit 3 aborted with the message, nothing recorded, the DB still closed", async () => {
    let launched = 0;
    // Carry M-6, through the REAL openBrowserRun: a shell of 2500 against a
    // build left at the default is refused by name before chromium launches.
    const mismatched: Partial<RunDeps> = {
      openBrowserRun: (b) => openBrowserRun(b, {
        servedHold: async () => ({ holdMs: resolveHoldMs(undefined), found: 1, scanned: 1 }),
        launch: async () => { launched++; return { close: async () => undefined }; },
        newCase: async () => { throw new Error("no case may open"); },
        env: { [HOLD_MS_ENV_VAR]: "2500" }, pads: EMPTY_PADS,
      }),
    };
    for (const [name, over, why] of [
      ["rejects", { openBrowserRun: async () => { throw new Error("browserType.launch: Executable doesn't exist"); } }, /Executable doesn't exist/],
      ["absent", {}, /no browser/],
      ["hold mismatch", mismatched, /HoldMismatch: .*10000 ms.*2500 ms/],
    ] as const) {
      const io = capture();
      const dir = dirFor();
      const d = deps(over as Partial<RunDeps>);
      expect(await runSlice(d, ["--only", "league|generic", "--driver", "browser", "--width", "390", "--run-id", "b3", "--report-dir", dir]), name).toBe(3);
      expect(io.err(), name).toMatch(/aborted/);
      expect(io.err(), name).toMatch(why);
      expect(existsSync(join(dir, "b3", "results.json")), name).toBe(false);
      expect(d.order.at(-1), name).toBe("dispose");
      vi.restoreAllMocks();
    }
    expect(launched).toBe(0);
  });

  it("the browser run is closed exactly once, including when a case's browser cannot be set up (the run aborts, exit 3) or the DB stops proving it is ours (exit 2)", async () => {
    const io = capture();
    const failing = fakeBrowserRun({ failCaseAt: 2 });
    const d1 = deps({ openBrowserRun: async () => failing.run });
    expect(await runSlice(d1, ["--only", "league|generic", "--driver", "browser", "--width", "768", "--run-id", "b4", "--report-dir", dirFor()])).toBe(3);
    expect(failing.log).toEqual(["open case-1", "close case-1", "run closed"]);
    expect(io.err()).toMatch(/BrowserCaseAborted: .*newContext refused/);

    const lost = fakeBrowserRun();
    let n = 0;
    const d2 = deps({
      openBrowserRun: async () => lost.run,
      prepareCaseOrg: async (_ctx, i) => { if (++n === 2) throw new DataDirMismatch("/tmp/pg", "/tmp/other"); return { orgId: `org-${i.slug}`, orgSlug: i.slug, denied: [] }; },
    });
    expect(await runSlice(d2, ["--only", "league|generic", "--driver", "browser", "--width", "768", "--run-id", "b5", "--report-dir", dirFor()])).toBe(2);
    expect(lost.log).toEqual(["open case-1", "close case-1", "run closed"]);
  });

  it("an http run never opens a browser, and its results stay L3 over http", async () => {
    capture();
    const dir = dirFor();
    let opened = 0;
    const d = deps({ openBrowserRun: async () => { opened++; return fakeBrowserRun().run; } });
    expect(await runSlice(d, ["--only", "league|generic", "--scenario", "LIFECYCLE", "--run-id", "h1", "--report-dir", dir])).toBe(0);
    expect(opened).toBe(0);
    expect(resultsIn(dir, "h1").cases[0]).toMatchObject({ layer: "L3", driver: "http", width: null, caseId: "league|generic|score|LIFECYCLE" });
  });

  it("realDeps opens the browser run lazily: a dynamic import of lib/browser/browser-run.ts inside openBrowserRun, never a static one", () => {
    expect(typeof realDeps().openBrowserRun).toBe("function");
    const code = readFileSync(RUN, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(/openBrowserRun: [^\n]*await import\("\.\/lib\/browser\/browser-run\.ts"\)/.test(code)).toBe(true);
    expect(code).not.toMatch(/^import [^;]*lib\/browser\//m);
  });
});
