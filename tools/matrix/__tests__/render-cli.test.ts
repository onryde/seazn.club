import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = join(REPO, "tools/matrix/render.ts");
const cli = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], { cwd: REPO, encoding: "utf8", timeout: 25_000 });
const results = (cases: unknown[], grid = { rows: ["league", "knockout"], sports: ["generic", "badminton"] }) => ({ schemaVersion: 2, runId: "r", harnessCommit: "abc", startedAt: "s", finishedAt: "f", grid, cases });
const works = { caseId: "league|generic|score|LIFECYCLE", row: "league", sport: "generic", variant: "score", scenario: "LIFECYCLE", canary: false, state: "works", reason: "1 checks, 2 items", checks: [{ id: "I1", kind: "invariant", verdict: "pass", checked: 2, reason: "", evidence: [] }], counts: { calls: 3, fixtures: 1, events: 4 }, durationMs: 7, notes: [] };

describe("render CLI", () => {
  it("zero cases: writes the 'No cases run' banner and exits 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    writeFileSync(join(dir, "results.json"), JSON.stringify(results([])));
    const r = cli(join(dir, "results.json"));
    expect(r.status).toBe(1);
    expect(readFileSync(join(dir, "MATRIX.md"), "utf8")).toContain("No cases run");
  });
  it("canary results are never rendered", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    const c = { caseId: "c", row: "league", sport: "generic", variant: "score", scenario: "M1", canary: true, state: "red", reason: "", checks: [], counts: { calls: 0, fixtures: 0, events: 0 }, durationMs: 0, notes: [] };
    writeFileSync(join(dir, "results.json"), JSON.stringify(results([c])));
    const r = cli(join(dir, "results.json"));
    expect(r.status).toBe(1);
    expect(existsSync(join(dir, "MATRIX.md"))).toBe(false);
    // Exit 1 alone is also what a CLI that failed to LOAD returns; the refusal
    // must be the reason (this test passed at RED with no render.ts at all).
    expect(r.stderr).toMatch(/refusing to render canary/);
  });
  it("no argument: usage, exit 2", () => { expect(cli().status).toBe(2); });

  it("a real case renders beside results.json and exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    writeFileSync(join(dir, "results.json"), JSON.stringify(results([works])));
    const r = cli(join(dir, "results.json"));
    expect(r.status).toBe(0);
    const md = readFileSync(join(dir, "MATRIX.md"), "utf8");
    expect(md).toContain("| league |");
    expect(md).toContain("✅");
    expect(md).not.toContain("No cases run");
  });
  it("M4: the grid comes from results.json — a row and sport the live catalogue has never heard of render, in the file's order", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    const c = { ...works, caseId: "ladder|curling|score|LIFECYCLE", row: "ladder", sport: "curling" };
    writeFileSync(join(dir, "results.json"), JSON.stringify(results([c], { rows: ["ladder"], sports: ["curling", "generic"] })));
    const r = cli(join(dir, "results.json"));
    expect(r.status, r.stderr).toBe(0);
    const md = readFileSync(join(dir, "MATRIX.md"), "utf8");
    expect(md).toContain("| row | curling | generic |");
    expect(md).toContain("| ladder | ✅ | ░ |");
    expect(md).not.toContain("| league |");
  });
  it("--out writes where it is told, and nowhere else", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    writeFileSync(join(dir, "results.json"), JSON.stringify(results([works])));
    const out = join(dir, "elsewhere.md");
    expect(cli(join(dir, "results.json"), "--out", out).status).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("| league |");
    expect(existsSync(join(dir, "MATRIX.md"))).toBe(false);
  });
  it("an unknown flag or a second file is a usage error (exit 2), not 'zero cases' (exit 1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    writeFileSync(join(dir, "results.json"), JSON.stringify(results([works])));
    expect(cli(join(dir, "results.json"), "--output", "x.md").status).toBe(2);
    expect(cli(join(dir, "results.json"), join(dir, "results.json")).status).toBe(2);
    expect(existsSync(join(dir, "MATRIX.md"))).toBe(false);
  });
  // Review M2: an uncaught throw exits 1, which is the "zero cases / canary"
  // code. Every input failure is exit 2 with a reason, and writes nothing.
  it.each<[string, (dir: string) => string, RegExp]>([
    ["a missing file", (dir) => join(dir, "nope.json"), /render: .*ENOENT/],
    ["bad JSON", (dir) => { writeFileSync(join(dir, "results.json"), "{not json"); return join(dir, "results.json"); }, /render: SyntaxError/],
    ["results the schema refuses", (dir) => { writeFileSync(join(dir, "results.json"), JSON.stringify({ ...results([]), schemaVersion: 1 })); return join(dir, "results.json"); }, /render: ZodError/],
    ["a case off the catalogue grid", (dir) => { writeFileSync(join(dir, "results.json"), JSON.stringify(results([{ ...works, caseId: "leauge|generic", row: "leauge" }]))); return join(dir, "results.json"); }, /render: .*leauge\|generic/],
  ])("%s is an input error: exit 2, a reason on stderr, no MATRIX.md", (_name, setup, why) => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    const r = cli(setup(dir));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(why);
    expect(existsSync(join(dir, "MATRIX.md"))).toBe(false);
  });
  it("an input error never prints a secret: JSON.parse quotes short bad input whole, so the message is redacted (R14a)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fm-"));
    // V8 echoes an input this short in full: `Unexpected token 'o', "token=abc123secret" is not valid JSON`.
    writeFileSync(join(dir, "results.json"), "token=abc123secret");
    const r = cli(join(dir, "results.json"));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/render: SyntaxError: .*\[redacted\]/);
    expect(r.stderr).not.toContain("abc123secret");
  });
});
