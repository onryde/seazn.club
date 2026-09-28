import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RowBuildDeferred } from "../lib/catalogue.ts";
import { RefusedCall } from "../lib/driver/types.ts";
import type { CaseResult, CheckResult } from "../lib/results.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { ScenarioUnsupported, type ScenarioContext, type ScenarioOutput } from "../lib/scenarios/types.ts";
import { DataDirMismatch } from "../lib/seed-org.ts";
import { SLICE_ROWS } from "../lib/slice.ts";
import { runSlice, summariseRun, type RunDeps } from "../run.ts";
import { FakeLeagueDriver } from "./fake-driver.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RUN = join(REPO, "scripts/matrix/run.ts");

type Deps = RunDeps & { order: string[]; orgs: { name: string; slug: string }[]; emails: string[] };

function deps(over: Partial<RunDeps> = {}): Deps {
  const order: string[] = [];
  const orgs: { name: string; slug: string }[] = [];
  const emails: string[] = [];
  const d: Deps = {
    order,
    orgs,
    emails,
    env: { BENCH_EXPECTED_DATA_DIR: "/tmp/pg", SMOKE_BASE: "http://localhost:3999" },
    harnessCommit: async () => "abc1234",
    preflight: async () => { order.push("preflight"); return { ok: true, refusals: [] }; },
    openDb: async () => { order.push("openDb"); return {
      userIdForEmail: async (e: string) => { emails.push(`db ${e}`); return "u1"; },
      variantKeysInBuilderOrder: async (s: string) => (s === "generic" ? ["score", "win_loss"] : ["bwf", "short"]),
      chooseTopPublicPlan: async () => "pro",
      dispose: async () => { order.push("dispose"); },
    }; },
    signIn: async (_b, e) => { order.push("signIn"); emails.push(`signIn ${e}`); return { cookies: {} }; },
    prepareCaseOrg: async (_ctx, i) => { orgs.push(i); return { orgId: "org-fake", orgSlug: i.slug }; },
    driverFor: () => new FakeLeagueDriver("org-fake"),
    ...over,
  };
  return d;
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
  it.each([
    ["ScenarioUnsupported", () => new ScenarioUnsupported("W1b", "team rosters"), "W1b: team rosters"],
    ["RowBuildDeferred", () => new RowBuildDeferred("group_only", "W1b"), "W1b: catalogue: row 'group_only' is API-only; its stage bodies are built in W1b"],
  ] as const)("a %s is ⏳ later with its wave — never an error red — and, having checked nothing, is listed vacuous (PF4)", async (_name, make, reason) => {
    const io = capture();
    vi.spyOn(SCENARIOS.LIFECYCLE, "run").mockImplementation(async () => { throw make(); });
    const dir = dirFor();
    expect(await runSlice(deps(), ["--only", "league|generic", "--scenario", "LIFECYCLE", "--run-id", "t9", "--report-dir", dir])).toBe(0);
    expect(resultsIn(dir, "t9").cases[0]).toMatchObject({ state: "later", reason, checks: [] });
    expect(io.out()).toContain("vacuous: league|generic|score|LIFECYCLE");
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
    expect(cases[0]!.checks.filter((c) => c.verdict === "fail").map((c) => c.id)).toContain(want);
    expect(io.out()).toContain(`canary ${k}: red on ${want}, as designed`);
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

  it("zero cases: results.json and the 'No cases run' banner are written, exit 1", async () => {
    capture();
    const saved = [...SLICE_ROWS];
    const rows = SLICE_ROWS as unknown as string[];
    rows.splice(0);
    try {
      const dir = dirFor();
      expect(await runSlice(deps(), ["--run-id", "t8", "--report-dir", dir])).toBe(1);
      expect(resultsIn(dir, "t8").cases).toEqual([]);
      expect(readFileSync(join(dir, "t8", "MATRIX.md"), "utf8")).toContain("No cases run");
    } finally {
      rows.splice(0, rows.length, ...saved);
    }
    expect([...SLICE_ROWS]).toEqual(saved);
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
    expect(io.err()).toMatch(/DataDirMismatch/);
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
});

describe("summariseRun (PF4) — empty first", () => {
  const base = { row: "league", sport: "generic", variant: "score", scenario: "LIFECYCLE", canary: false, counts: { calls: 0, fixtures: 0, events: 0 }, durationMs: 0 };
  const chk = (verdict: CheckResult["verdict"], checked: number): CheckResult => ({ id: `k-${verdict}-${checked}`, kind: "invariant", verdict, checked, reason: "", evidence: [] });
  const kase = (caseId: string, state: CaseResult["state"], reason: string, checks: CheckResult[]): CaseResult => ({ ...base, caseId, state, reason, checks });

  it("no cases: nothing vacuous, no error reds", () => {
    expect(summariseRun([], new Map())).toEqual({ vacuous: [], errorReds: [] });
  });
  it("vacuous = a non-error case with no applied check over at least one item; error reds are listed apart, never as vacuous", () => {
    const cases = [
      kase("abstained", "red", "every check abstained (vacuous)", [chk("abstain", 0)]),
      kase("zero-items", "red", "checked zero items (vacuous): k", [chk("pass", 0)]),
      kase("deferred", "later", "W1b: team rosters", []),
      kase("works", "works", "1 checks, 3 items", [chk("pass", 3), chk("abstain", 0)]),
      kase("real-red", "red", "k: wrong", [chk("fail", 2)]),
      kase("refused", "red", "error: RefusedCall: POST /x → HTTP 400 VALIDATION: bad", []),
      kase("crashed", "red", "error: TypeError: boom", []),
    ];
    // decideState counts an abstain as not applied whatever its `checked` says; so does this.
    cases.splice(1, 0, kase("abstained-with-items", "red", "every check abstained (vacuous)", [chk("abstain", 2)]));
    const refusals = new Map([["refused", { method: "POST", path: "/x", status: 400, code: "VALIDATION" }]]);
    expect(summariseRun(cases, refusals)).toEqual({
      vacuous: ["abstained", "abstained-with-items", "zero-items", "deferred"],
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
