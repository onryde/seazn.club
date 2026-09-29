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
// new one, and a known unexpected refusal displacing one (fix round 2, RR-1);
// a failure the time box left unshrunk; a request that timed out, beside a
// cell that did not (RR-2); two cells, --seed, a by-hand replay.
// Empty cases FIRST where they exist: --regressions with nothing committed on
// the cells; a cell that ran one command. Refusals are proven by SPAWNING the
// CLI (ruling R-h), through a symlink (isMainModule).
//
// Single-sport by design (a file-level reason: the scanner's `// single-sport:`
// grammar heads a block, and a header heads none): every run here is league|generic but the per-cell seed test
// (which needs two cells) — the model fake is a round-robin product and #879
// is a league fault (the slice's sports are swept in model-run-cell.test.ts).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { DIVISION_CAP_KEY, MODEL_DEFAULTS, MODEL_USAGE, fnv1a32, runModel, seedFor, type ModelDeps } from "../model.ts";
import { REQUEST_TIMEOUT_MS } from "../lib/driver/http-driver.ts";
import { LOCAL_BASE } from "../lib/redact.ts";
import { RefusedCall, RequestTimedOut, type FixtureRow, type PostedEvent } from "../lib/driver/types.ts";
import { MODEL_ERROR } from "../lib/model/run-cell.ts";
import { REFUSAL_NAMED, ROSTER_LOCK_FINDING, UNEXPECTED_REFUSAL } from "../lib/model/state.ts";
import { MATCH_MIN_LENGTH, MATCH_REQUIRED_CHECKS, parseRegressions, type RegressionCase } from "../lib/scenario-catalogue.ts";
import { DataDirMismatch } from "../lib/seed-org.ts";
import type { StreamEvent } from "../lib/streams/types.ts";
import { baseLiteralsIn } from "./loopback-literals.ts";
import { ModelFakeDriver } from "./model-fake-driver.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MODEL = resolve(REPO, "scripts/matrix/model.ts");
const CELL = "league|generic";
const I7 = "I7-rr-no-pair-over-legs";
const FOLD = "model-fold-parity";
/** An open committed regression on CELL for `check` (R29); `match` as the schema requires it. */
const openReg = (id: string, check: string, match: string | null = null): RegressionCase => ({ id, title: "t", issue: null, cell: CELL, variant: "score", check, seed: 1, path: "0", replayPath: null, fence: null, match, status: "open", found: "2026-09-29", runId: "t" });
/** The words both fake post refusals below give — the product's message, which
 *  a match reads (never RefusedCall's request line: final batch FB-3). */
const POST_REFUSED = "test: refuses";
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

/** Fix round 2, RR-1 (the reviewer's product; twin in model-run-cell.test.ts):
 *  per division, results are refused by NAME until an entrant is added after
 *  the build, then taken and their outcome lied about (fold parity). */
class GatedLiar extends ModelFakeDriver {
  #adds = 0;
  constructor() { super({ lieOutcome: true }); }
  override createDivision(...a: Parameters<ModelFakeDriver["createDivision"]>) { this.#adds = 0; return super.createDivision(...a); }
  override addEntrants(...a: Parameters<ModelFakeDriver["addEntrants"]>) { return super.addEntrants(...a).then((r) => { this.#adds++; return r; }); }
  override postStream(id: string, events: readonly StreamEvent[], prefix = ""): Promise<PostedEvent[]> {
    if (this.#adds < 2) return Promise.reject(new RefusedCall("POST", `/api/v1/fixtures/${id}/events`, 409, "TEST_POST_REFUSED", "test: refuses results until a late entrant"));
    return super.postStream(id, events, prefix);
  }
}

/** T15 fix round 3: every Generate refused 500 with no code — the shape of the
 *  knockout bye-award crash (MB-004/005), which the model reads as
 *  model-refusal-named through its ordinary refusal branch. */
const STRAND = "test: the bulk UPDATE would strand home_slot_label";
class CrashingGenerate extends ModelFakeDriver {
  override generate(): ReturnType<ModelFakeDriver["generate"]> {
    return Promise.reject(new RefusedCall("POST", "/api/v1/stages/s1/generate", 500, null, STRAND));
  }
}
/** T15 fix round 3: a harness fault on every post — an Error that is no
 *  refusal, so model-error with no product answer. */
class BrokenPosts extends ModelFakeDriver {
  override postStream(): Promise<PostedEvent[]> { return Promise.reject(new Error("test: the socket closed")); }
}
const stubOf = (printed: string): Record<string, unknown> => JSON.parse(/regression stub for [^\n]*\n(\{[\s\S]*?\n\})/.exec(printed)?.[1] ?? "{}") as Record<string, unknown>;

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
      planLimit: async () => null,
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
      ["--seed", "-1.5"],
      ["--seed", "-x"],
      ["--seed", "-4294967296"],
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

  // T15 fix round 2 (R-h): the loader refuses a case on a generic check with
  // no `match`, and the CLI exits 2 on it — before the base, the DB or the preflight.
  it("the CLI itself refuses a committed case on a generic check without `match` (--root): exit 2 naming match, nothing written; the same file with its match gets past the loader", () => {
    const committed = JSON.parse(readFileSync(resolve(REPO, "scripts/matrix/catalogue/regressions.json"), "utf8")) as { schemaVersion: 1; regressions: Record<string, unknown>[] };
    const generic = committed.regressions.filter((r) => r.check === UNEXPECTED_REFUSAL);
    expect(generic.length, "no committed case on model-unexpected-refusal to strip").toBeGreaterThan(0);
    const spawnWith = (regressions: Record<string, unknown>[]) => {
      const root = mkdtempSync(join(scratch, "root-"));
      mkdirSync(join(root, "scripts/matrix/catalogue"), { recursive: true });
      writeFileSync(join(root, "scripts/matrix/catalogue/regressions.json"), JSON.stringify({ schemaVersion: 1, regressions }));
      const via = join(root, "link-model.ts");
      symlinkSync(MODEL, via);
      const dir = reportDir();
      const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", via, "--report-dir", dir, "--root", root, "--regressions"], { cwd: REPO, encoding: "utf8", timeout: 25_000, env: { PATH: process.env.PATH ?? "" } });
      return { ...r, wrote: existsSync(join(dir, "w1b-model")) };
    };
    const stripped = committed.regressions.map((r) => {
      if (r.check !== UNEXPECTED_REFUSAL) return r;
      const { match: _m, ...rest } = r;
      return rest;
    });
    const refused = spawnWith(stripped);
    expect(refused.stderr, "main never ran").toMatch(/^model: /m);
    expect(refused.stderr).toMatch(/match/);
    expect(refused.status, refused.stderr).toBe(2);
    expect(refused.wrote).toBe(false);
    // Control: the committed file as is passes the loader and stops at the next gate (no base URL).
    const passed = spawnWith(committed.regressions);
    expect(passed.stderr).toMatch(/no --base and no SMOKE_BASE/);
    expect(passed.stderr).not.toMatch(/match/);
    expect(passed.status, passed.stderr).toBe(2);
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

  it("T15 fix round 2: an open case on the same cell and check whose match is NOT in the evidence leaves a refusal NEW (exit 1, a stub); the matching case makes it known (exit 0)", async () => {
    const io = capture();
    const tbd = openReg("MB-002", UNEXPECTED_REFUSAL, "fixture has an unassigned entrant");
    expect(await runModel(deps({ driverFor: () => new RefusingPosts(), regs: [tbd] }), ["--run-id", "mn", "--report-dir", reportDir(), ...ONE])).toBe(1);
    expect(failureLine(io.out())).toMatch(new RegExp(`^FAILURE ${UNEXPECTED_REFUSAL} \\(NEW\\): `));
    expect(io.out()).toContain("regression stub");
    // The product's own text reaches the printed evidence.
    expect(io.out()).toMatch(/\n {4}evidence: [^\n]*HTTP 409 TEST_POST_REFUSED: test: refuses every result/);
    const io2 = capture();
    expect(await runModel(deps({ driverFor: () => new RefusingPosts(), regs: [tbd, openReg("MB-003", UNEXPECTED_REFUSAL, "refuses every result")] }), ["--run-id", "mn", "--report-dir", reportDir(), ...ONE])).toBe(0);
    expect(failureLine(io2.out())).toMatch(/\(known MB-003\)/);
  });

  it("T15 fix round 3, I-1/I-2: an unnamed refusal (model-refusal-named — MB-004/005's only path) is known only by a case matching the product's answer; its stub prints the match EMPTY, owed, never null", async () => {
    const io = capture();
    expect(await runModel(deps({ driverFor: () => new CrashingGenerate() }), ["--run-id", "mg", "--report-dir", reportDir(), ...ONE])).toBe(1);
    expect(failureLine(io.out())).toMatch(new RegExp(`^FAILURE ${REFUSAL_NAMED} \\(NEW\\): `));
    expect(stubOf(io.out()).match).toBe("");
    // Final batch FB-3: the owed line quotes the product's words alone — never the request line a match cannot read.
    expect(io.out()).toContain(`\n  match owed: ${REFUSAL_NAMED} names no single failure — set "match" to at least ${MATCH_MIN_LENGTH} characters of the product's own words below (never the request line, never the model's own line), or regressions.json is refused: ${STRAND}\n`);
    expect(io.out()).not.toMatch(/match owed: [^\n]*HTTP 500/);
    // As printed, the stub is refused; with the product's words as its match it is a valid case.
    expect(() => completedStub(io.out(), { issue: null, fence: null })).toThrow(/match/);
    const reg = completedStub(io.out(), { id: "MB-004", issue: null, fence: null, match: "would strand home_slot_label" });
    const io2 = capture();
    expect(await runModel(deps({ driverFor: () => new CrashingGenerate(), regs: [reg] }), ["--run-id", "mg", "--report-dir", reportDir(), ...ONE])).toBe(0);
    expect(failureLine(io2.out())).toMatch(/\(known MB-004\)/);
    // A case whose match is only in the model's own line stays NEW.
    let checked = 0;
    for (const harness of ["→ 500 (no code)", "Generate("]) {
      const io3 = capture();
      expect(await runModel(deps({ driverFor: () => new CrashingGenerate(), regs: [{ ...reg, match: harness }] }), ["--run-id", "mg", "--report-dir", reportDir(), ...ONE]), harness).toBe(1);
      expect(io3.out(), `the premise: the model's line carries ${harness}`).toMatch(new RegExp(`\\n {4}evidence: [^\\n]*${harness.replace(/[()]/g, "\\$&")}`));
      expect(failureLine(io3.out()), harness).toMatch(/\(NEW\)/);
      checked++;
    }
    expect(checked).toBe(2);
    // The committed case replays exactly.
    capture();
    expect(await runModel(deps({ driverFor: () => new CrashingGenerate(), regs: [reg] }), ["--run-id", "mgr", "--report-dir", reportDir(), "--regressions"])).toBe(0);
  });

  it("T15 fix round 3, I-2: on EVERY check that owes a match the printed stub carries an empty match and says what is owed — never `match: null`; a check that owes none (I7) prints null", async () => {
    const producers: Record<string, () => ModelFakeDriver> = { [UNEXPECTED_REFUSAL]: () => new RefusingPosts(), [REFUSAL_NAMED]: () => new CrashingGenerate(), [MODEL_ERROR]: () => new BrokenPosts() };
    expect(Object.keys(producers).sort(), "one producer per check that owes a match").toEqual([...MATCH_REQUIRED_CHECKS].sort());
    let checked = 0;
    for (const [i, check] of MATCH_REQUIRED_CHECKS.entries()) {
      const io = capture();
      expect(await runModel(deps({ driverFor: producers[check] }), ["--run-id", `ms${i}`, "--report-dir", reportDir(), ...ONE]), check).toBe(1);
      expect(failureLine(io.out()), check).toMatch(new RegExp(`^FAILURE ${check} \\(NEW\\): `));
      expect(stubOf(io.out()).match, check).toBe("");
      expect(io.out(), check).not.toContain('"match": null');
      expect(io.out(), check).toMatch(new RegExp(`\\n {2}match owed: ${check} names no single failure`));
      expect(() => completedStub(io.out(), { issue: null, fence: null }), check).toThrow(/match/);
      checked++;
    }
    expect(checked).toBe(MATCH_REQUIRED_CHECKS.length);
    expect(checked).toBeGreaterThan(0);
    // A harness fault carries no product answer: the owed line says so, rather than inviting a match.
    const io = capture();
    await runModel(deps({ driverFor: () => new BrokenPosts() }), ["--run-id", "msb", "--report-dir", reportDir(), ...ONE]);
    expect(io.out()).toContain(`\n  match owed: ${MODEL_ERROR} names no single failure, and this one carries no product answer to match — it is the harness's to fix, not a case to commit\n`);
    // Final batch FB-3: a refusal the product gave no words for has nothing a match can read either.
    const silent = capture();
    const Silent = class extends ModelFakeDriver {
      override generate(): ReturnType<ModelFakeDriver["generate"]> { return Promise.reject(new RefusedCall("POST", "/api/v1/stages/s1/generate", 500, null, null)); }
    };
    expect(await runModel(deps({ driverFor: () => new Silent() }), ["--run-id", "msn", "--report-dir", reportDir(), ...ONE])).toBe(1);
    expect(failureLine(silent.out())).toMatch(new RegExp(`^FAILURE ${REFUSAL_NAMED} \\(NEW\\): `));
    expect(silent.out()).toContain(`\n  match owed: ${REFUSAL_NAMED} names no single failure, and the product's answer carries no words past its request line to match — it cannot be committed as a case: POST /api/v1/stages/s1/generate → HTTP 500 (no code): (no message)\n`);
    const io2 = capture();
    expect(await runModel(deps({ fault879: true }), ["--run-id", "ms-i7", "--report-dir", reportDir(), ...ONE, "--no-fences"])).toBe(1);
    expect(stubOf(io2.out()).check).toBe(I7);
    expect(stubOf(io2.out()).match).toBeNull();
    expect(io2.out()).not.toContain("match owed");
  });

  it("T15 fix round 2: --seed takes a negative seed as `--seed -N` too (the logs print `seed=-N`), the same as `--seed=-N`", async () => {
    capture();
    type Rep = { cells: { seed: number }[] };
    const seedOf = (dir: string, id: string) => (JSON.parse(readFileSync(join(dir, id, "model-report.json"), "utf8")) as Rep).cells.map((c) => c.seed);
    const a = reportDir();
    const b = reportDir();
    expect(await runModel(deps(), ["--run-id", "neg", "--report-dir", a, "--cell", CELL, "--runs", "1", "--max-commands", "1", "--seed", "-355591138"])).toBe(1);
    expect(await runModel(deps(), ["--run-id", "neg", "--report-dir", b, "--cell", CELL, "--runs", "1", "--max-commands", "1", "--seed=-355591138"])).toBe(1);
    expect(seedOf(a, "neg")).toEqual([-355591138]);
    expect(seedOf(b, "neg")).toEqual([-355591138]);
    // …and the path that goes with it, as a replay is copied from a log.
    const c = reportDir();
    expect(await runModel(deps(), ["--run-id", "negp", "--report-dir", c, "--cell", CELL, "--runs", "1", "--seed", "-7", "--path", "0"])).not.toBe(2);
    expect(seedOf(c, "negp")).toEqual([-7]);
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
    const d = deps({ driverFor: () => new RefusingPosts({ fault879: true }), regs: [openReg("MB-003", UNEXPECTED_REFUSAL, POST_REFUSED)] });
    expect(await runModel(d, ["--run-id", "i1b", "--report-dir", dir, "--cell", CELL, "--runs", "40", "--max-commands", "12", "--seed", "62", "--no-fences"])).toBe(1);
    expect(failureLine(io.out())).toMatch(/\(known MB-003\)/);
    expect(io.out()).toMatch(/\n {2}NEW I7-rr-no-pair-over-legs \(passed over while shrinking toward model-unexpected-refusal\): [^\n]*Generate\(/);
    expect(io.out()).toMatch(/no stub for I7-rr-no-pair-over-legs/);
    expect(io.out()).not.toContain("regression stub");
    const rep = JSON.parse(readFileSync(join(dir, "i1b", "model-report.json"), "utf8")) as { cells: { verdict: string; maskedNew: Record<string, string[]> }[] };
    expect(rep.cells.map((c) => [c.verdict, Object.keys(c.maskedNew)])).toEqual([["new-failure", [I7]]]);
  });

  it("fix round 2, RR-1: a NEW failure the shrink was following, displaced by a KNOWN unexpected refusal, makes the cell NEW (exit 1) and is printed (the reviewer's seed 15)", async () => {
    const io = capture();
    const dir = reportDir();
    const d = deps({ driverFor: () => new GatedLiar(), regs: [openReg("MB-003", UNEXPECTED_REFUSAL, POST_REFUSED)] });
    expect(await runModel(d, ["--run-id", "rr1", "--report-dir", dir, "--cell", CELL, "--runs", "40", "--max-commands", "12", "--seed", "15"])).toBe(1);
    expect(failureLine(io.out())).toMatch(/^FAILURE model-unexpected-refusal \(known MB-003\): /);
    expect(io.out()).toMatch(/\n {2}NEW model-fold-parity \(passed over while shrinking toward model-unexpected-refusal\): [^\n]*AddEntrant\([^\n]*(Score|Walkover)\(/);
    expect(io.out()).toMatch(/no stub for model-fold-parity/);
    expect(io.out()).toMatch(/model: 1 cell\(s\) — 0 ok, 0 known, 1 NEW/);
    const rep = JSON.parse(readFileSync(join(dir, "rr1", "model-report.json"), "utf8")) as { cells: { verdict: string; maskedNew: Record<string, string[]> }[] };
    expect(rep.cells.map((c) => [c.verdict, Object.keys(c.maskedNew).includes(FOLD)])).toEqual([["new-failure", true]]);
  });

  it("fix round 2, RR-2: a request timeout aborts its cell: a TIMEOUT line, no stub, no model-error; the report is written, the next cell still runs, and exit 3 outranks the next cell's NEW failure", async () => {
    const io = capture();
    const dir = reportDir();
    let drivers = 0;
    const hanging = class extends ModelFakeDriver {
      override postStream(id: string, _e: readonly StreamEvent[], _p = ""): Promise<PostedEvent[]> {
        return Promise.reject(new RequestTimedOut("POST", `/api/v1/fixtures/${id}/events`, 60_000));
      }
    };
    // The first cell's product hangs on every post; the second refuses every post by name (a NEW failure).
    const d = deps({ driverFor: () => (++drivers === 1 ? new hanging() : new RefusingPosts()) });
    const cells = [CELL, "league|badminton"];
    expect(await runModel(d, ["--run-id", "rr2", "--report-dir", dir, ...cells.flatMap((c) => ["--cell", c]), "--runs", "40"])).toBe(3);
    expect(drivers).toBe(2);
    const out = io.out();
    expect(out).toMatch(/\n {2}TIMEOUT: driver: POST \/api\/v1\/fixtures\/[^\n]* did not answer within 60000 ms[^\n]*re-run/);
    expect(out).not.toContain("model-error");
    // The aborted cell prints no verdict line of its own — no FAILURE, no ok, no VACUOUS.
    expect(out.match(/\n {2}FAILURE /g)?.length).toBe(1);
    expect(failureLine(out)).toMatch(new RegExp(`^FAILURE ${UNEXPECTED_REFUSAL} \\(NEW\\): `));
    expect(out).not.toMatch(/\n {2}(ok|VACUOUS)/);
    // One stub, for the other cell's failure; none for the timeout.
    expect(out.match(/regression stub for/g)?.length).toBe(1);
    expect(out).toMatch(/"cell": "league\|badminton"/);
    expect(out).toMatch(/model: 2 cell\(s\) — 0 ok, 0 known, 1 NEW, 0 vacuous, 0 not reproduced, 1 aborted/);
    const rep = JSON.parse(readFileSync(join(dir, "rr2", "model-report.json"), "utf8")) as { cells: { cell: string; verdict: string; timeout: string | null; failure: unknown }[] };
    expect(rep.cells.map((c) => [c.cell, c.verdict, c.timeout !== null, c.failure === null])).toEqual([[CELL, "aborted", true, true], ["league|badminton", "new-failure", false, false]]);
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
      expect(io2.out()).toMatch(/NOT REPRODUCED MB-001: the replay failed on model-fold-parity \(known MB-002\) instead/);
      const rep = JSON.parse(readFileSync(join(dir, "k5r", "model-report.json"), "utf8")) as { cells: { replayOf: string | null; verdict: string }[] };
      expect(rep.cells.map((c) => [c.replayOf, c.verdict])).toEqual([["MB-001", "not-reproduced"], ["MB-002", "known-failure"]]);
    });

    it("T15 fix round 2: a replay that fails on its own check but as ANOTHER case (that case's match, not its own) did not reproduce — NOT REPRODUCED (exit 1)", async () => {
      const io = capture();
      expect(await runModel(deps({ driverFor: () => new RefusingPosts() }), ["--run-id", "mm", "--report-dir", reportDir(), ...ONE])).toBe(1);
      // The stub of a generic check says match is owed, and is refused without one.
      expect(io.out()).toMatch(/\n {2}match owed: [^\n]*model-unexpected-refusal/);
      expect(() => completedStub(io.out())).toThrow(/match/);
      // One failure committed twice: MB-002 names the knockout TBD refusal, MB-003 this one.
      const tbd = completedStub(io.out(), { id: "MB-002", issue: null, fence: null, match: "fixture has an unassigned entrant" });
      const own = completedStub(io.out(), { id: "MB-003", issue: null, fence: null, match: "refuses every result" });
      const io2 = capture();
      const dir = reportDir();
      expect(await runModel(deps({ driverFor: () => new RefusingPosts(), regs: [tbd, own] }), ["--run-id", "mmr", "--report-dir", dir, "--regressions"])).toBe(1);
      expect(io2.out()).toMatch(/NOT REPRODUCED MB-002: the replay failed on model-unexpected-refusal \(known MB-003\) instead/);
      const rep = JSON.parse(readFileSync(join(dir, "mmr", "model-report.json"), "utf8")) as { cells: { replayOf: string | null; verdict: string }[] };
      expect(rep.cells.map((c) => [c.replayOf, c.verdict])).toEqual([["MB-002", "not-reproduced"], ["MB-003", "known-failure"]]);
      // Its own case alone replays exactly: known, exit 0.
      capture();
      expect(await runModel(deps({ driverFor: () => new RefusingPosts(), regs: [own] }), ["--run-id", "mmo", "--report-dir", reportDir(), "--regressions"])).toBe(0);
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
      const bad: RegressionCase = { id: "MB-009", title: "t", issue: null, cell: CELL, variant: "bwf", check: I7, seed: 1, path: "0", replayPath: null, fence: null, match: null, status: "open", found: "2026-09-29", runId: "t" };
      expect(await runModel(deps({ openDb: noDb(), regs: [bad] }), ["--run-id", "g2", "--report-dir", reportDir(), "--regressions"])).toBe(2);
      expect(await runModel(deps({ openDb: noDb(), regs: [bad] }), ["--run-id", "g2", "--report-dir", reportDir(), ...ONE])).toBe(2);
      expect(io.err()).toMatch(/MB-009.*'bwf'.*generic/);
    });
  });

  it("Review Focus 5: a live builder default that is not the offline one is refused (exit 2) before any case org", async () => {
    const io = capture();
    let orgs = 0;
    const d = deps({
      openDb: async () => ({ userIdForEmail: async () => "u1", variantKeysInBuilderOrder: async () => ["win_loss"], chooseTopPublicPlan: async () => "pro", planGrants: async () => [], planLimit: async () => null, dispose: async () => {} }),
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

  it("M-7 then FB-1: the run's base in a failure's evidence reaches the report as LOCAL_BASE, in any loopback spelling — and nothing else is rewritten", async () => {
    const io = capture();
    // SMOKE_BASE is http://localhost:3999 (deps): node names that server
    // 127.0.0.1:3999 too. 127.0.0.1:5433 is a database, not the base: kept,
    // port and all, so the outage is not misattributed to the app server.
    class LocalAnswer extends ModelFakeDriver {
      override generate(): ReturnType<ModelFakeDriver["generate"]> {
        return Promise.reject(new RefusedCall("POST", "/api/v1/stages/s1/generate", 500, null, "upstream http://localhost:3999/api/v1/stages/s1/generate, 127.0.0.1:3999 and 127.0.0.1:5433 refused"));
      }
    }
    const dir = reportDir();
    expect(await runModel(deps({ driverFor: () => new LocalAnswer() }), ["--run-id", "rl", "--report-dir", dir, ...ONE])).toBe(1);
    const text = readFileSync(join(dir, "rl", "model-report.json"), "utf8");
    expect(text).toContain(`upstream ${LOCAL_BASE}/api/v1/stages/s1/generate, ${LOCAL_BASE} and 127.0.0.1:5433 refused`);
    expect(baseLiteralsIn(text, 3999), "no spelling of the run's base is left").toEqual([]);
    // The terminal is not committed: the operator reads the base as it is.
    expect(io.out()).toContain("upstream http://localhost:3999/api/v1/stages/s1/generate");
  });

  it("FB-1: a base that is not an http(s) URL is refused (exit 2) before the DB, naming it", async () => {
    let checked = 0;
    for (const bad of ["localhost:3999", "not a url", "ftp://localhost:3999"]) {
      const io = capture();
      expect(await runModel(deps({ openDb: noDb() }), ["--run-id", "rb", "--report-dir", reportDir(), "--base", bad, ...ONE]), bad).toBe(2);
      expect(io.err(), bad).toMatch(/BaseNotUrl/);
      vi.restoreAllMocks();
      checked++;
    }
    expect(checked).toBe(3);
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

// W1b Task 15, fix round 1 (b): live, one competition per cell met the plan's
// `divisions.per_competition.max` at its 21st property run — a 402 the shrink
// then masked as a model-error, silently truncating it. The model now reads
// the cap from the case org's plan entitlement (plan_entitlements, read as
// the product's getLimit reads it) and moves to a fresh
// competition before it is reached.
describe("the per-competition division cap (T15 fix round 1)", () => {
  /** The key the product's createDivision gate reads (divisions.ts), lifted from its source — never typed. */
  const DIVISIONS_TS = readFileSync(resolve(REPO, "apps/web/src/server/usecases/divisions.ts"), "utf8");
  const PRODUCT_KEY = /const divisionCap = await getLimit\(\s*auth\.orgId,\s*"([^"]+)",\s*competitionId,?\s*\)/.exec(DIVISIONS_TS)?.[1];
  /** The product's gate as the fake enforces it: the (cap+1)-th division in ONE competition is a 402 naming the key. */
  class CappedDivisions extends ModelFakeDriver {
    readonly cap: number | null;
    comps = 0;
    readonly perComp = new Map<string, number>();
    constructor(cap: number | null) { super(); this.cap = cap; }
    override createCompetition(i: { name: string; slug: string }) {
      return super.createCompetition(i).then((c) => ({ ...c, id: `c${++this.comps}` }));
    }
    override createDivision(c: string, i: Parameters<ModelFakeDriver["createDivision"]>[1]) {
      const n = this.perComp.get(c) ?? 0;
      if (this.cap !== null && n >= this.cap) return Promise.reject(new RefusedCall("POST", `/api/v1/competitions/${c}/divisions`, 402, "PAYMENT_REQUIRED", `${PRODUCT_KEY ?? "?"} reached`));
      this.perComp.set(c, n + 1);
      return super.createDivision(c, i);
    }
  }
  /** The plan the case org is provisioned on (deps: chooseTopPublicPlan). */
  const PLAN = "pro";
  type Rep = { cells: { verdict: string; executions: number; failure: { check: string } | null }[] };
  const run = async (cap: number | null, runId: string) => {
    const reads: [string, string][] = [];
    const fake = new CappedDivisions(cap);
    const dir = reportDir();
    const exit = await runModel(deps({
      openDb: async () => ({ ...(await deps().openDb()), planLimit: async (planKey: string, key: string) => { reads.push([planKey, key]); return cap; } }),
      driverFor: () => fake,
    }), ["--run-id", runId, "--report-dir", dir, ...ONE]);
    const rep = existsSync(join(dir, runId, "model-report.json")) ? JSON.parse(readFileSync(join(dir, runId, "model-report.json"), "utf8")) as Rep : null;
    return { exit, reads, fake, rep };
  };

  it("the premise: the model reads the key the product's division gate reads", () => {
    expect(PRODUCT_KEY, "divisions.ts no longer reads its cap as getLimit(auth.orgId, \"<key>\", competitionId)").toBeDefined();
    expect(DIVISION_CAP_KEY).toBe(PRODUCT_KEY);
  });

  it("empty case first: an UNLIMITED cap (a null int_value) keeps the cell in one competition", async () => {
    capture();
    const { exit, reads, fake, rep } = await run(null, "cp0");
    expect(exit).toBe(0);
    expect(reads).toEqual([[PLAN, DIVISION_CAP_KEY]]);
    expect(fake.comps).toBe(1);
    expect(rep?.cells[0]?.executions).toBe(fake.perComp.get("c1"));
  });

  it.each([2, 3])("a cap of %i, read from the case org's plan: every competition stays within it, and the cell runs past it (execution cap+1 and on)", async (cap) => {
    capture();
    const { exit, reads, fake, rep } = await run(cap, `cp${cap}`);
    const [cell] = rep?.cells ?? [];
    expect(cell?.failure ?? null).toBeNull();
    expect(cell?.verdict).toBe("ok");
    expect(exit).toBe(0);
    expect(reads).toEqual([[PLAN, DIVISION_CAP_KEY]]);
    const executions = cell?.executions ?? 0;
    // Anti-vacuity: the rotation had to fire — the cell ran past the cap.
    expect(executions).toBeGreaterThan(cap);
    expect([...fake.perComp.values()].every((n) => n <= cap)).toBe(true);
    expect([...fake.perComp.values()].reduce((a, b) => a + b, 0)).toBe(executions);
    expect(fake.comps).toBe(Math.ceil(executions / cap));
  });

  it("a plan that allows NO division (the key absent from its matrix reads as 0, getLimit) aborts the cell before any competition", async () => {
    const io = capture();
    const { exit, fake } = await run(0, "cpz");
    expect(exit).toBe(3);
    expect(fake.comps).toBe(0);
    expect(io.err()).toMatch(/divisions\.per_competition\.max/);
  });
});
