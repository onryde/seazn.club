// The model runner's CLI (W1b Task 14): model.ts seeds each cell from
// (run id, cell), runs it through runCell, writes one redacted
// model-report.json and exits by the matrix CLIs' contract — 0 ok, 1 a NEW
// failure / a vacuous cell / an open regression that no longer reproduces /
// nothing to run, 2 refused, 3 aborted. Driven DB-free: every dep is a fake,
// and the product is ModelFakeDriver.
//
// State transitions under test: a clean fenced run; a run that finds a NEW
// failure and prints its stub; the stub completed and replayed (--regressions)
// as KNOWN; the same regression replayed against a fixed product (not
// reproduced), a replay failing on another open case's check, and a fixed
// regression that comes back; an unexpected refusal; a known failure hiding a
// new one; a failure the time box left unshrunk; two cells, --seed, a by-hand
// replay.
// Empty cases FIRST where they exist: --regressions with nothing committed on
// the cells; a cell that ran one command. Refusals are proven by SPAWNING the
// CLI (ruling R-h), through a symlink (isMainModule).
//
// single-sport: every run here is league|generic but the per-cell seed test
// (which needs two cells) — the model fake is a round-robin product and #879
// is a league fault (the slice's sports are swept in model-run-cell.test.ts).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_DEFAULTS, MODEL_USAGE, fnv1a32, runModel, seedFor, type ModelDeps } from "../model.ts";
import { REQUEST_TIMEOUT_MS } from "../lib/driver/http-driver.ts";
import { RefusedCall, type FixtureRow, type PostedEvent } from "../lib/driver/types.ts";
import { ROSTER_LOCK_FINDING, UNEXPECTED_REFUSAL } from "../lib/model/state.ts";
import { parseRegressions, type RegressionCase } from "../lib/scenario-catalogue.ts";
import { DataDirMismatch } from "../lib/seed-org.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import { ModelFakeDriver } from "./model-fake-driver.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MODEL = resolve(REPO, "scripts/matrix/model.ts");
const CELL = "league|generic";
const I7 = "I7-rr-no-pair-over-legs";
const FOLD = "model-fold-parity";
/** An open committed regression on CELL for `check` (R29). */
const openReg = (id: string, check: string): RegressionCase => ({ id, title: "t", issue: null, cell: CELL, variant: "score", check, seed: 1, path: "0", replayPath: null, fence: null, status: "open", found: "2026-09-29", runId: "t" });
const scratch = mkdtempSync(join(tmpdir(), "w1b-model-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => { vi.restoreAllMocks(); });

const capture = () => {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => { out.push(String(s)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => { err.push(String(s)); return true; });
  return { out: () => out.join(""), err: () => err.join("") };
};
const reportDir = () => mkdtempSync(join(scratch, "r-"));

/** Every post refused by NAME — a product that will not take a result. */
class RefusingPosts extends ModelFakeDriver {
  override postStream(id: string, _events: readonly StreamEvent[], _prefix = ""): Promise<PostedEvent[]> {
    return Promise.reject(new RefusedCall("POST", `/api/v1/fixtures/${id}/events`, 409, "TEST_POST_REFUSED", "test: refuses every result"));
  }
}

type Over = Partial<ModelDeps> & { fault879?: boolean; regs?: RegressionCase[] };
const deps = (over: Over = {}): ModelDeps => {
  const { fault879, regs, ...rest } = over;
  return {
    env: { BENCH_EXPECTED_DATA_DIR: "/tmp/pg", SMOKE_BASE: "http://localhost:3999" },
    harnessCommit: async () => "abc1234",
    preflight: async () => ({ ok: true, refusals: [] }),
    openDb: async () => ({
      userIdForEmail: async () => "u1",
      variantKeysInBuilderOrder: async (s: string) => (s === "generic" ? ["score", "win_loss"] : ["bwf", "short"]),
      chooseTopPublicPlan: async () => "pro",
      planGrants: async () => [],
      dispose: async () => {},
    }),
    signIn: async () => ({ cookies: {} }),
    prepareCaseOrg: async (_c, i) => ({ orgId: `org-${i.slug}`, orgSlug: i.slug, denied: [] }),
    driverFor: () => new ModelFakeDriver({ fault879: fault879 === true }),
    loadRegressions: () => regs ?? [],
    ...rest,
  };
};
const noDb = (): ModelDeps["openDb"] => async () => { throw new Error("must not open the DB"); };
/** One cell at the default --max-commands: a replay regenerates the
 *  counterexample under the defaults, so a case meant to replay is found there. */
const ONE = ["--cell", CELL, "--runs", "40"];

/** The stub model.ts prints for a NEW failure, completed as a person would. */
function completedStub(printed: string, fill: Partial<RegressionCase> = {}): RegressionCase {
  const m = /regression stub for [^\n]*\n(\{[\s\S]*?\n\})/.exec(printed);
  if (m === null) throw new Error(`no stub printed:\n${printed}`);
  const stub = JSON.parse(m[1] ?? "") as Record<string, unknown>;
  const [done] = parseRegressions({ schemaVersion: 1, regressions: [{ ...stub, id: "MB-001", title: "late entrant then Generate duplicates round-robin pairs", issue: "#879", fence: "late-entry-then-generate", found: "2026-09-29", ...fill }] });
  if (done === undefined) throw new Error("unreachable");
  return done;
}
const failureLine = (printed: string) => /FAILURE [^\n]*/.exec(printed)?.[0] ?? "";
const shrunk = (printed: string) => failureLine(printed).replace(/^[^:]*: /, "");

describe("model.ts", () => {
  it("fnv1a32 matches the published FNV-1a 32-bit vectors; seedFor hashes `${runId}|${cell}`", () => {
    // Test vectors from the FNV reference (isthe.com/chongo/tech/comp/fnv): "" → 0x811c9dc5, "a" → 0xe40c292c, "foobar" → 0xbf9cf968.
    expect(fnv1a32("")).toBe(0x811c9dc5 | 0);
    expect(fnv1a32("a")).toBe(0xe40c292c | 0);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968 | 0);
    expect(seedFor("a", "league|generic")).toBe(fnv1a32("a|league|generic"));
    expect(seedFor("a", "league|generic")).not.toBe(seedFor("b", "league|generic"));
  });

  it("usage refusals exit 2 before any DB work", async () => {
    const io = capture();
    const d = deps({ openDb: noDb(), harnessCommit: async () => { throw new Error("must not read git"); } });
    const refused: readonly (readonly string[])[] = [
      ["--cell", "nope|generic"],
      ["--cell", "league|cricket"],
      ["--runs", "0"],
      ["--max-commands", "0"],
      ["--time-limit", "10"],
      ["--path", "0:1"],
      ["--seed", "1", "--replay-path", "CC:B"],
      ["--seed", "1.5"],
      ["--seed", "4294967296"],
      ["--seed", "1", "--path", "0:x"],
      ["--regressions", "--seed", "1"],
      ["--run-id", "!!!"],
      ["extra"],
      ["--bogus"],
    ];
    for (const argv of refused) expect(await runModel(d, [...argv]), argv.join(" ")).toBe(2);
    expect(io.err()).toContain(MODEL_USAGE);
    expect(MODEL_USAGE).toMatch(/--no-fences/);
    expect(MODEL_USAGE).toMatch(/--replay-path/);
    expect(MODEL_USAGE).toMatch(/--regressions/);
  });

  it("environment refusals exit 2 before any DB work: no base, no own-DB proof, a failed or throwing preflight", async () => {
    capture();
    expect(await runModel(deps({ openDb: noDb(), env: { BENCH_EXPECTED_DATA_DIR: "/tmp/pg" } }), [...ONE])).toBe(2);
    expect(await runModel(deps({ openDb: noDb(), env: { SMOKE_BASE: "http://localhost:3999" } }), [...ONE])).toBe(2);
    expect(await runModel(deps({ openDb: noDb(), preflight: async () => ({ ok: false, refusals: [{ reason: "x", detail: "y" }] }) }), [...ONE])).toBe(2);
    expect(await runModel(deps({ openDb: noDb(), preflight: async () => { throw new Error("down"); } }), [...ONE])).toBe(2);
  });

  // Ruling R-h: a test that says "the CLI refuses" runs the CLI. Through a
  // symlinked path, so a CLI that skipped its main would exit 0 here, silently.
  const SPAWNED: readonly (readonly [string, readonly string[]])[] = [
    ["--runs 0", ["--runs", "0"]],
    ["an unknown cell", ["--cell", "nope|generic"]],
    ["--replay-path without --path", ["--seed", "1", "--replay-path", "CC:B"]],
    ["a positional", ["extra"]],
  ];
  it.each(SPAWNED)("the CLI itself refuses %s: exit 2, the usage on stderr, nothing written", (_why, args) => {
    const via = join(scratch, `link-model-${args.join("-").replace(/[^a-z0-9]+/gi, "_")}.ts`);
    symlinkSync(MODEL, via);
    const dir = reportDir();
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", via, "--report-dir", dir, ...args], { cwd: REPO, encoding: "utf8", timeout: 25_000, env: { PATH: process.env.PATH ?? "" } });
    expect(r.stderr, "main never ran").toContain("usage: model.ts");
    expect(r.status, r.stderr).toBe(2);
    expect(existsSync(join(dir, "w1b-model"))).toBe(false);
  });

  it("one leading `--` (pnpm passes it through) is dropped; a second is still a usage refusal", async () => {
    capture();
    const dir = reportDir();
    expect(await runModel(deps(), ["--", "--run-id", "dd", "--report-dir", dir, "--cell", CELL, "--runs", "1", "--max-commands", "1"])).toBe(1);
    expect(existsSync(join(dir, "dd", "model-report.json"))).toBe(true);
    expect(await runModel(deps({ openDb: noDb() }), ["--", "--", "--run-id", "dd"])).toBe(2);
  });

  it("a fenced run over one cell exits 0 and writes model-report.json with the logged seed, the unknowns, the findings and the informative steps; the known finding is printed and changes nothing", async () => {
    const io = capture();
    const dir = reportDir();
    expect(await runModel(deps(), ["--run-id", "mr", "--report-dir", dir, ...ONE])).toBe(0);
    const rep = JSON.parse(readFileSync(join(dir, "mr", "model-report.json"), "utf8")) as {
      runId: string; harnessCommit: string;
      cells: { cell: string; seed: number; failure: unknown; vacuous: string[]; verdict: string; unknowns: Record<string, number>; findings: Record<string, { count: number; evidence: string[] }>; informativeSteps: number; replayOf: string | null }[];
    };
    expect(rep.runId).toBe("mr");
    expect(rep.harnessCommit).toBe("abc1234");
    expect(rep.cells.map((c) => c.cell)).toEqual([CELL]);
    const [c] = rep.cells;
    if (c === undefined) throw new Error("unreachable");
    expect(c.seed).toBe(seedFor("mr", CELL));
    expect(c.failure).toBeNull();
    expect(c.vacuous).toEqual([]);
    expect(c.verdict).toBe("ok");
    expect(c.replayOf).toBeNull();
    expect(c.unknowns).toEqual({ retried: 0, "tip-moved": 0, "next-match-unverified": 0 });
    expect(c.informativeSteps).toBeGreaterThan(0);
    const lock = c.findings[ROSTER_LOCK_FINDING];
    expect(lock?.count).toBeGreaterThan(0);
    expect(io.out()).toContain(`seed=${seedFor("mr", CELL)}`);
    expect(io.out()).toContain(`finding ${ROSTER_LOCK_FINDING} ×${lock?.count ?? -1}`);
    expect(io.out().match(/^\s*finding /gm)?.length).toBe(Object.keys(c.findings).length);
  });

  it("a NEW failure exits 1 and prints a regression stub carrying seed and path — a stub that, once named and dated, is a valid committed case", async () => {
    const io = capture();
    const dir = reportDir();
    expect(await runModel(deps({ fault879: true }), ["--run-id", "mr2", "--report-dir", dir, ...ONE, "--no-fences"])).toBe(1);
    expect(io.out() + io.err()).toMatch(/"check": "I7-rr-no-pair-over-legs"[\s\S]*"seed": -?\d+[\s\S]*"path": "/);
    expect(failureLine(io.out())).toMatch(/^FAILURE I7-rr-no-pair-over-legs \(NEW\): /);
    const reg = completedStub(io.out());
    expect(reg).toMatchObject({ cell: CELL, variant: "score", check: I7, seed: seedFor("mr2", CELL), status: "open", runId: "mr2" });
    expect(reg.replayPath).toMatch(/\S/);
    // Found at the defaults, unfenced: exactly how --regressions replays it.
    expect(io.out()).not.toContain("replay caveat");
    const rep = JSON.parse(readFileSync(join(dir, "mr2", "model-report.json"), "utf8")) as { cells: { verdict: string; fences: boolean; maxCommands: number }[] };
    expect(rep.cells.map((x) => [x.verdict, x.fences, x.maxCommands])).toEqual([["new-failure", false, MODEL_DEFAULTS.maxCommands]]);
  });

  it("fix round 1, M-6: a stub for a failure found at another --max-commands says how to replay it; a SHRUNK failure found with fences on carries no fences caveat", async () => {
    const io = capture();
    expect(await runModel(deps({ driverFor: () => new RefusingPosts() }), ["--run-id", "mc", "--report-dir", reportDir(), ...ONE, "--max-commands", "12"])).toBe(1);
    const caveat = /replay caveat: [^\n]*/.exec(io.out())?.[0] ?? "";
    expect(caveat).toMatch(/found at --max-commands 12, and the committed case does not record it: replay it with --regressions --max-commands 12/);
    // The shrinker keeps only commands that ran, and a fence only ever stops
    // one: a shrunk counterexample replays the same with fences off.
    expect(caveat).not.toMatch(/fence/);
  });

  it("fix round 1, M-4/M-6: a failure the time box cut short says TIME BOX HIT on its own line and in the tally, and its unshrunk stub carries the fences caveat", async () => {
    const io = capture();
    let refused = false;
    class RefusingThenLate extends RefusingPosts {
      override postStream(id: string, events: readonly StreamEvent[], prefix = ""): Promise<PostedEvent[]> { refused = true; return super.postStream(id, events, prefix); }
    }
    // The clock stands still until the first refusal, then jumps past the box:
    // the failing run completes, and the shrink never starts.
    const d = deps({ driverFor: () => new RefusingThenLate(), now: () => (refused ? Number.MAX_SAFE_INTEGER : 0) });
    const dir = reportDir();
    expect(await runModel(d, ["--run-id", "tb", "--report-dir", dir, ...ONE])).toBe(1);
    expect(io.out()).toMatch(/\n {4}seed=-?\d+ path=\d+ replayPath=\S+, TIME BOX HIT \(unshrunk\)\n/);
    expect(io.out()).toMatch(/model: 1 cell\(s\) — [^\n]*, 1 TIME BOX HIT/);
    expect(/replay caveat: [^\n]*/.exec(io.out())?.[0]).toMatch(/fences on/);
    const rep = JSON.parse(readFileSync(join(dir, "tb", "model-report.json"), "utf8")) as { cells: { interrupted: boolean; verdict: string }[] };
    expect(rep.cells.map((c) => [c.verdict, c.interrupted])).toEqual([["new-failure", true]]);
  });

  it("a failure an OPEN committed regression names is known: exit 0, and the run says which", async () => {
    const io = capture();
    await runModel(deps({ fault879: true }), ["--run-id", "mk", "--report-dir", reportDir(), ...ONE, "--no-fences"]);
    const reg = completedStub(io.out());
    const io2 = capture();
    expect(await runModel(deps({ fault879: true, regs: [reg] }), ["--run-id", "mk", "--report-dir", reportDir(), ...ONE, "--no-fences"])).toBe(0);
    expect(failureLine(io2.out())).toMatch(/\(known MB-001\)/);
    expect(io2.out()).not.toContain("regression stub");
  });

  it("empty case: a vacuous cell exits 1 (R25), and says why", async () => {
    const io = capture();
    const dir = reportDir();
    expect(await runModel(deps(), ["--run-id", "mr3", "--report-dir", dir, "--cell", CELL, "--runs", "1", "--max-commands", "1"])).toBe(1);
    expect(io.out()).toContain("VACUOUS");
    const rep = JSON.parse(readFileSync(join(dir, "mr3", "model-report.json"), "utf8")) as { cells: { verdict: string }[] };
    expect(rep.cells.map((x) => x.verdict)).toEqual(["vacuous"]);
  });

  it("an unexpected refusal is a NEW failure: exit 1, on model-unexpected-refusal", async () => {
    const io = capture();
    expect(await runModel(deps({ driverFor: () => new RefusingPosts() }), ["--run-id", "mu", "--report-dir", reportDir(), ...ONE])).toBe(1);
    expect(failureLine(io.out())).toMatch(new RegExp(`^FAILURE ${UNEXPECTED_REFUSAL} \\(NEW\\): `));
    // Shrunk, at the defaults, fences on: the time box was not hit and no caveat applies (M-4, M-6).
    expect(io.out()).not.toContain("TIME BOX HIT (unshrunk)");
    expect(io.out()).toMatch(/model: 1 cell\(s\) — [^\n]*, 0 TIME BOX HIT/);
    expect(io.out()).not.toContain("replay caveat");
  });

  it("fix round 1, I-1: a NEW failure met while shrinking toward a KNOWN one is reported NEW and exits 1 (the reviewer's probe)", async () => {
    const io = capture();
    const d = deps({ driverFor: () => new ModelFakeDriver({ fault879: true, lieOutcome: true }), regs: [openReg("MB-002", FOLD)] });
    expect(await runModel(d, ["--run-id", "i1", "--report-dir", reportDir(), "--cell", CELL, "--runs", "40", "--max-commands", "12", "--seed", "62", "--no-fences"])).toBe(1);
    expect(failureLine(io.out())).toMatch(/^FAILURE I7-rr-no-pair-over-legs \(NEW\): /);
    expect(io.out()).toMatch(/model: 1 cell\(s\) — 0 ok, 0 known, 1 NEW/);
  });

  it("fix round 1, I-1: a NEW check passed over under a KNOWN unexpected refusal makes the cell NEW (exit 1): printed with what it ran, and no stub it could not replay", async () => {
    const io = capture();
    const dir = reportDir();
    const d = deps({ driverFor: () => new RefusingPosts({ fault879: true }), regs: [openReg("MB-003", UNEXPECTED_REFUSAL)] });
    expect(await runModel(d, ["--run-id", "i1b", "--report-dir", dir, "--cell", CELL, "--runs", "40", "--max-commands", "12", "--seed", "62", "--no-fences"])).toBe(1);
    expect(failureLine(io.out())).toMatch(/\(known MB-003\)/);
    expect(io.out()).toMatch(/\n {2}NEW I7-rr-no-pair-over-legs \(passed over while shrinking toward model-unexpected-refusal\): [^\n]*Generate\(/);
    expect(io.out()).toMatch(/no stub for I7-rr-no-pair-over-legs/);
    expect(io.out()).not.toContain("regression stub");
    const rep = JSON.parse(readFileSync(join(dir, "i1b", "model-report.json"), "utf8")) as { cells: { verdict: string; maskedNew: Record<string, string[]> }[] };
    expect(rep.cells.map((c) => [c.verdict, Object.keys(c.maskedNew)])).toEqual([["new-failure", [I7]]]);
  });

  it("fix round 1, M-2: every cell gets its own seed, FNV-1a of `${runId}|${cell}`", async () => {
    capture();
    const dir = reportDir();
    const cells = [CELL, "league|badminton"];
    expect(await runModel(deps(), ["--run-id", "two", "--report-dir", dir, ...cells.flatMap((c) => ["--cell", c]), "--runs", "40"])).toBe(0);
    const rep = JSON.parse(readFileSync(join(dir, "two", "model-report.json"), "utf8")) as { cells: { cell: string; seed: number }[] };
    expect(rep.cells.map((c) => [c.cell, c.seed])).toEqual(cells.map((c) => [c, seedFor("two", c)]));
    expect(new Set(rep.cells.map((c) => c.seed)).size).toBe(cells.length);
  });

  it("fix round 1, M-2: --seed, --path and --replay-path are USED — a NEW failure's reported seed, path and replayPath replay it by hand to the same FAILURE line; --seed alone overrides the derived seed", async () => {
    const io = capture();
    const dir = reportDir();
    expect(await runModel(deps({ fault879: true }), ["--run-id", "ms", "--report-dir", dir, ...ONE, "--no-fences"])).toBe(1);
    type Rep = { cells: { seed: number; failure: { seed: number; path: string; replayPath: string | null } | null }[] };
    const f = (JSON.parse(readFileSync(join(dir, "ms", "model-report.json"), "utf8")) as Rep).cells[0]?.failure;
    if (f === null || f === undefined || f.replayPath === null) throw new Error("the fences-off cell found nothing to replay");
    expect(f.path).toMatch(/:/);
    const io2 = capture();
    const dir2 = reportDir();
    expect(await runModel(deps({ fault879: true }), ["--run-id", "ms2", "--report-dir", dir2, "--cell", CELL, "--runs", "1", "--no-fences", "--seed", String(f.seed), "--path", f.path, "--replay-path", f.replayPath])).toBe(1);
    expect(failureLine(io2.out())).toBe(failureLine(io.out()));
    const again = (JSON.parse(readFileSync(join(dir2, "ms2", "model-report.json"), "utf8")) as Rep).cells[0];
    expect([again?.seed, again?.failure?.path, again?.failure?.replayPath]).toEqual([f.seed, f.path, f.replayPath]);
    capture();
    const dir3 = reportDir();
    expect(await runModel(deps(), ["--run-id", "ms3", "--report-dir", dir3, ...ONE, "--seed", "12345"])).toBe(0);
    expect((JSON.parse(readFileSync(join(dir3, "ms3", "model-report.json"), "utf8")) as Rep).cells.map((c) => c.seed)).toEqual([12345]);
    expect(seedFor("ms3", CELL)).not.toBe(12345);
  });

  it("fix round 1, M-5: one request's timeout is shorter than a cell's time box, so a hung request cannot eat the box", () => {
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(REQUEST_TIMEOUT_MS).toBeLessThan(MODEL_DEFAULTS.timeLimitMs);
  });

  describe("--regressions: replay every committed case on the cells", () => {
    it("empty case first: nothing committed on the cells — exit 1 before the DB is opened", async () => {
      const io = capture();
      expect(await runModel(deps({ openDb: noDb(), regs: [] }), ["--run-id", "rr0", "--report-dir", reportDir(), "--regressions"])).toBe(1);
      expect(io.err()).toMatch(/nothing to run/);
    });

    it("the printed stub, committed, replays as KNOWN (exit 0) with the same shrunk commands; against a fixed product it is NOT REPRODUCED (exit 1)", async () => {
      const io = capture();
      await runModel(deps({ fault879: true }), ["--run-id", "rr1", "--report-dir", reportDir(), ...ONE, "--no-fences"]);
      const found = io.out();
      const reg = completedStub(found);
      const io2 = capture();
      const dir = reportDir();
      expect(await runModel(deps({ fault879: true, regs: [reg] }), ["--run-id", "rr2", "--report-dir", dir, "--regressions"])).toBe(0);
      expect(failureLine(io2.out())).toMatch(/^FAILURE I7-rr-no-pair-over-legs \(known MB-001\): /);
      expect(shrunk(io2.out())).toBe(shrunk(found));
      expect(io2.out()).toContain(`seed=${reg.seed} path=${reg.path}`);
      const rep = JSON.parse(readFileSync(join(dir, "rr2", "model-report.json"), "utf8")) as { cells: { replayOf: string | null; verdict: string; seed: number }[] };
      expect(rep.cells.map((c) => [c.replayOf, c.verdict, c.seed])).toEqual([["MB-001", "known-failure", reg.seed]]);
      const io3 = capture();
      expect(await runModel(deps({ fault879: false, regs: [reg] }), ["--run-id", "rr3", "--report-dir", reportDir(), "--regressions"])).toBe(1);
      expect(io3.out()).toMatch(/NOT REPRODUCED MB-001/);
    });

    it("fix round 1, M-3: a replay that fails on ANOTHER open case's check did not reproduce its own — NOT REPRODUCED (exit 1), never known", async () => {
      const lies = () => new ModelFakeDriver({ lieOutcome: true });
      const io = capture();
      expect(await runModel(deps({ driverFor: lies }), ["--run-id", "k5", "--report-dir", reportDir(), ...ONE, "--no-fences"])).toBe(1);
      // One failure, committed twice: as MB-001 on I7 (the check it was filed
      // for), and as MB-002 on the check the product now trips at that path.
      const other = completedStub(io.out(), { id: "MB-002", title: "an outcome nobody posted", issue: null, fence: null });
      expect(other.check).toBe(FOLD);
      const own = completedStub(io.out(), { check: I7 });
      const io2 = capture();
      const dir = reportDir();
      expect(await runModel(deps({ driverFor: lies, regs: [own, other] }), ["--run-id", "k5r", "--report-dir", dir, "--regressions"])).toBe(1);
      expect(io2.out()).toMatch(/NOT REPRODUCED MB-001: the replay failed on model-fold-parity instead/);
      const rep = JSON.parse(readFileSync(join(dir, "k5r", "model-report.json"), "utf8")) as { cells: { replayOf: string | null; verdict: string }[] };
      expect(rep.cells.map((c) => [c.replayOf, c.verdict])).toEqual([["MB-001", "not-reproduced"], ["MB-002", "known-failure"]]);
    });

    it("a FIXED regression that comes back is a NEW failure (exit 1); one that stays fixed is ok (exit 0)", async () => {
      const io = capture();
      await runModel(deps({ fault879: true }), ["--run-id", "rf1", "--report-dir", reportDir(), ...ONE, "--no-fences"]);
      const reg = completedStub(io.out(), { status: "fixed" });
      const io2 = capture();
      expect(await runModel(deps({ fault879: true, regs: [reg] }), ["--run-id", "rf2", "--report-dir", reportDir(), "--regressions"])).toBe(1);
      expect(failureLine(io2.out())).toMatch(/\(NEW\)/);
      capture();
      expect(await runModel(deps({ fault879: false, regs: [reg] }), ["--run-id", "rf3", "--report-dir", reportDir(), "--regressions"])).toBe(0);
    });

    it("carry G-2: a committed case whose variant is not its sport's is refused (exit 2) before the DB", async () => {
      const io = capture();
      const bad: RegressionCase = { id: "MB-009", title: "t", issue: null, cell: CELL, variant: "bwf", check: I7, seed: 1, path: "0", replayPath: null, fence: null, status: "open", found: "2026-09-29", runId: "t" };
      expect(await runModel(deps({ openDb: noDb(), regs: [bad] }), ["--run-id", "g2", "--report-dir", reportDir(), "--regressions"])).toBe(2);
      expect(await runModel(deps({ openDb: noDb(), regs: [bad] }), ["--run-id", "g2", "--report-dir", reportDir(), ...ONE])).toBe(2);
      expect(io.err()).toMatch(/MB-009.*'bwf'.*generic/);
    });
  });

  it("Review Focus 5: a live builder default that is not the offline one is refused (exit 2) before any case org", async () => {
    const io = capture();
    let orgs = 0;
    const d = deps({
      openDb: async () => ({ userIdForEmail: async () => "u1", variantKeysInBuilderOrder: async () => ["win_loss"], chooseTopPublicPlan: async () => "pro", planGrants: async () => [], dispose: async () => {} }),
      prepareCaseOrg: async (_c, i) => { orgs++; return { orgId: "o", orgSlug: i.slug, denied: [] }; },
    });
    expect(await runModel(d, ["--run-id", "bd", "--report-dir", reportDir(), ...ONE])).toBe(2);
    expect(orgs).toBe(0);
    expect(io.err()).toMatch(/BuilderDefaultDrift/);
  });

  it("R14a: a secret in a failure's evidence never reaches the report or the terminal", async () => {
    const io = capture();
    class Leaky extends ModelFakeDriver {
      override listFixtures(): Promise<FixtureRow[]> { return Promise.reject(new Error("connect postgres://matrix:hunter2@db.local/x refused")); }
    }
    const dir = reportDir();
    expect(await runModel(deps({ driverFor: () => new Leaky() }), ["--run-id", "rs", "--report-dir", dir, ...ONE])).toBe(1);
    const text = readFileSync(join(dir, "rs", "model-report.json"), "utf8");
    expect(text).toContain("model-error");
    expect(text).toContain("[redacted]");
    expect(text).not.toContain("hunter2");
    expect(io.out() + io.err()).not.toContain("hunter2");
  });

  it("aborts (exit 3): a case org that cannot be prepared, and a report that cannot be written; a DB that stops proving it is ours is refused (exit 2)", async () => {
    capture();
    expect(await runModel(deps({ prepareCaseOrg: async () => { throw new Error("insert failed"); } }), ["--run-id", "ab", "--report-dir", reportDir(), ...ONE])).toBe(3);
    expect(await runModel(deps({ prepareCaseOrg: async () => { throw new DataDirMismatch("/tmp/pg", "/elsewhere"); } }), ["--run-id", "ab", "--report-dir", reportDir(), ...ONE])).toBe(2);
    const file = join(scratch, "not-a-dir");
    writeFileSync(file, "");
    expect(await runModel(deps(), ["--run-id", "ab", "--report-dir", file, ...ONE])).toBe(3);
  });

  it("package.json runs the CLI under strip-types", () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["matrix:model"]).toBe("node --experimental-strip-types scripts/matrix/model.ts");
  });
});
