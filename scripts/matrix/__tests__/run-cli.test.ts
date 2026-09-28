import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILDER_PREFERRED_VARIANT, ROW_KEYS, RowBuildDeferred, SPORT_KEYS } from "../lib/catalogue.ts";
import { RefusedCall } from "../lib/driver/types.ts";
import { renderMatrix } from "../lib/render-matrix.ts";
import type { CaseResult, CheckResult, RunResults } from "../lib/results.ts";
import { CANARY_MARK } from "../lib/scenarios/assertions.ts";
import { SCENARIOS } from "../lib/scenarios/index.ts";
import { ScenarioUnsupported, type ScenarioContext, type ScenarioOutput } from "../lib/scenarios/types.ts";
import type { Session } from "../../bench/lib/http.ts";
import { resolveSportCfg } from "../lib/sport-cfg.ts";
import { DataDirMismatch, OrgSwitchFailed, type MatrixSql } from "../lib/seed-org.ts";
import { SCENARIO_KEYS, SLICE_ROWS, SLICE_SPORTS, planSliceCases } from "../lib/slice.ts";
import { NOTES_CAP, closeHandles, describeCommit, keepNotes, realDeps, runSlice, summariseRun, type DbFactories, type RunDeps } from "../run.ts";
import { FakeDeniedDriver, FakeLeagueDriver } from "./fake-driver.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RUN = join(REPO, "scripts/matrix/run.ts");

type PrepareCtx = Parameters<RunDeps["prepareCaseOrg"]>[0];
interface DriverCall { base: string; session: Session; orgId: string; driver: FakeLeagueDriver }
type PrepareInput = Parameters<RunDeps["prepareCaseOrg"]>[1];
type Deps = RunDeps & { order: string[]; orgs: PrepareInput[]; ctxs: PrepareCtx[]; emails: string[]; drivers: DriverCall[]; session: Session };

/** Every case gets its OWN org id (`org-<slug>`), and driverFor records what it
 *  was handed — so a stale, constant or empty org id cannot pass unseen. */
function deps(over: Partial<RunDeps> = {}): Deps {
  const order: string[] = [];
  const orgs: PrepareInput[] = [];
  const ctxs: PrepareCtx[] = [];
  const emails: string[] = [];
  const drivers: DriverCall[] = [];
  const session: Session = { cookies: {} };
  const d: Deps = {
    order,
    orgs,
    ctxs,
    emails,
    drivers,
    session,
    env: { BENCH_EXPECTED_DATA_DIR: "/tmp/pg", SMOKE_BASE: "http://localhost:3999" },
    harnessCommit: async () => "abc1234",
    preflight: async () => { order.push("preflight"); return { ok: true, refusals: [] }; },
    openDb: async () => { order.push("openDb"); return {
      userIdForEmail: async (e: string) => { emails.push(`db ${e}`); return "u1"; },
      variantKeysInBuilderOrder: async (s: string) => (s === "generic" ? ["score", "win_loss"] : ["bwf", "short"]),
      chooseTopPublicPlan: async () => "pro",
      dispose: async () => { order.push("dispose"); },
    }; },
    signIn: async (_b, e) => { order.push("signIn"); emails.push(`signIn ${e}`); return session; },
    prepareCaseOrg: async (ctx, i) => { orgs.push(i); ctxs.push(ctx); return { orgId: `org-${i.slug}`, orgSlug: i.slug }; },
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
    const planCases = () => ({ sports: [] as string[], plan: () => [] });
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
    const planCases = () => ({ sports: [] as string[], plan: (variantFor: (s: string) => string) => planSliceCases(variantFor, { only: "league|generic", scenario: "LIFECYCLE" }) });
    expect(await runSlice(reads.deps({ planCases }), ["--run-id", "t8c", "--report-dir", dir])).toBe(3);
    expect(io.err()).toMatch(/UndeclaredPlannerSport: .*'generic'/);
    expect(io.err()).not.toMatch(/has no system variants/);
    expect(reads.sports).toEqual([]);
    expect(existsSync(join(dir, "t8c"))).toBe(false);
  });

  // ⛔ (Task 9). `deniesFeatures` belongs to CasePlanner from Task 10; here it
  // is an extra, harmless property of the injected planner.
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
  it("a slice case carries no deny to prepareCaseOrg", async () => {
    const dir = dirFor();
    const d = deps();
    capture();
    await runSlice(d, ["--run-id", "den3", "--report-dir", dir, "--only", "league|generic", "--scenario", "LIFECYCLE"]);
    expect(d.orgs).toHaveLength(1);
    expect(d.orgs[0]?.deny).toBeUndefined();
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
});

describe("summariseRun (PF4) — empty first", () => {
  const base = { row: "league", sport: "generic", variant: "score", scenario: "LIFECYCLE", canary: false, counts: { calls: 0, fixtures: 0, events: 0 }, durationMs: 0, notes: [] };
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
