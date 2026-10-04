// W1-driving final review I-1 (FINAL-R1): truth-runs/W1-DRIVING-REBASES.md is
// the only map from the harness SHAs committed runs RECORDED (REBASE-R3 left
// them as recorded) to the commits HEAD's history now carries. So it is
// parsed and held here:
//   - every data line of both tables is `| old | new | subject |`;
//   - table 2 composes onto table 1: every rebase-1 commit was rebased again,
//     in order and under its subject, and every other table-2 row is a commit
//     made after rebase 1;
//   - every table-2 new SHA is an ancestor of HEAD, under the table's subject;
//   - every distinct harnessCommit a committed W1-driving run recorded sits in
//     a recorded column and reaches HEAD's history through the tables.
// Expected values come from the committed doc, the committed runs and git —
// never from a list typed here. The git checks need the full history (the CI
// gates job checks out with fetch-depth 0, pinned in ci-wiring.test.ts); a
// missing git, a shallow clone or a missing object fails by name.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TRUTH_RUNS = join(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs");
const DOC = join(TRUTH_RUNS, "W1-DRIVING-REBASES.md");

interface MapRow { readonly old: string; readonly neu: string; readonly subject: string }
interface RebaseMap { readonly t1: readonly MapRow[]; readonly t2: readonly MapRow[] }

const ROW = /^\| `([0-9a-f]{9})` \| `([0-9a-f]{9})` \| (.+) \|$/;

/** One table: its header, its separator, then data lines until the first non-table line. */
function table(md: string, title: string, column: string): MapRow[] {
  const at = md.indexOf(title);
  if (at < 0) throw new Error(`rebase map: no "${title}" section`);
  const lines = md.slice(at).split("\n");
  const head = lines.findIndex((l) => l === `| recorded | ${column} | subject |`);
  if (head < 0) throw new Error(`rebase map: "${title}" has no "| recorded | ${column} | subject |" header`);
  const rows: MapRow[] = [];
  for (let i = head + 2; i < lines.length && lines[i]!.startsWith("|"); i++) {
    const m = ROW.exec(lines[i]!);
    if (m === null) throw new Error(`rebase map: "${title}" data line ${i - head - 1} is not | old | new | subject |: ${lines[i]!.slice(0, 80)}`);
    rows.push({ old: m[1]!, neu: m[2]!, subject: m[3]!.replace(/\\\|/g, "|") });
  }
  if (rows.length === 0) throw new Error(`rebase map: "${title}" has no data row`);
  return rows;
}
function parseRebaseMap(md: string): RebaseMap {
  return { t1: table(md, "## Table 1", "rebased (rebase 1)"), t2: table(md, "## Table 2", "rebased (rebase 2)") };
}

/** git, or a refusal by name: never a silent pass. */
function git(args: readonly string[]): string {
  const r = spawnSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error !== undefined) throw new Error(`rebase map: git is unavailable (${r.error.message}) — the ancestry check cannot run`);
  if (r.status !== 0) throw new Error(`rebase map: git ${args.join(" ")} exited ${r.status}: ${r.stderr.trim()}`);
  return r.stdout;
}
/** Every commit reachable from HEAD, full hashes — refused on a shallow clone. */
function headHistory(run: (args: readonly string[]) => string = git): string[] {
  if (run(["rev-parse", "--is-shallow-repository"]).trim() !== "false") {
    throw new Error("rebase map: this clone is shallow, so ancestry of the mapped SHAs cannot be proven — check out with full history (fetch-depth 0)");
  }
  const history = run(["rev-list", "HEAD"]).split("\n").filter((l) => l !== "");
  if (history.length === 0) throw new Error("rebase map: git rev-list HEAD listed no commit");
  return history;
}

/** The distinct harnessCommits the committed W1-driving runs recorded: results.json and model reports under truth-runs/w1drv-*. */
function recordedHarnessCommits(): Map<string, number> {
  const seen = new Map<string, number>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (e.name !== "results.json" && !/^model-report.*\.json$/.test(e.name)) continue;
      const h = (JSON.parse(readFileSync(f, "utf8")) as { harnessCommit: unknown }).harnessCommit;
      if (typeof h !== "string") throw new Error(`${f}: no harnessCommit`);
      seen.set(h, (seen.get(h) ?? 0) + 1);
    }
  };
  const dirs = readdirSync(TRUTH_RUNS).filter((d) => d.startsWith("w1drv-"));
  expect(dirs.length, "no truth-runs/w1drv-* directory").toBeGreaterThan(0);
  for (const d of dirs) walk(join(TRUTH_RUNS, d));
  return seen;
}

describe("W1-DRIVING-REBASES.md (final review I-1)", () => {
  it("the empty case first: a doc with no table, a table with no row, or a malformed data line is refused by name", () => {
    expect(() => parseRebaseMap("# nothing\n")).toThrow(/no "## Table 1" section/);
    const header = (t: string, col: string, body: string) => `${t}\n\n| recorded | ${col} | subject |\n|---|---|---|\n${body}`;
    const good = "| `aaaaaaaaa` | `bbbbbbbbb` | feat: x |\n";
    expect(() => parseRebaseMap(header("## Table 1", "rebased (rebase 1)", ""))).toThrow(/"## Table 1" has no data row/);
    expect(() => parseRebaseMap(`${header("## Table 1", "rebased (rebase 1)", good)}\n${header("## Table 2", "rebased (rebase 2)", "| `aaaaaaaaabbbbbbbbbfeat: x` | `` |  |\n")}`))
      .toThrow(/"## Table 2" data line 1 is not \| old \| new \| subject \|/);
    const ok = parseRebaseMap(`${header("## Table 1", "rebased (rebase 1)", good)}\n${header("## Table 2", "rebased (rebase 2)", "| `bbbbbbbbb` | `ccccccccc` | feat: a \\| b |\n")}`);
    expect(ok.t2[0]).toEqual({ old: "bbbbbbbbb", neu: "ccccccccc", subject: "feat: a | b" });
    // The history read refuses a shallow clone and an empty listing by name, never a silent pass.
    const stub = (shallow: string, list: string) => (args: readonly string[]) => (args[0] === "rev-parse" ? shallow : list);
    expect(() => headHistory(stub("true\n", "x\n"))).toThrow(/this clone is shallow/);
    expect(() => headHistory(stub("false\n", ""))).toThrow(/listed no commit/);
    expect(headHistory(stub("false\n", "a\nb\n"))).toEqual(["a", "b"]);
  });

  it("both committed tables parse, every data line `| old | new | subject |`, with no SHA repeated in a column", () => {
    const { t1, t2 } = parseRebaseMap(readFileSync(DOC, "utf8"));
    for (const [name, t] of [["table 1", t1], ["table 2", t2]] as const) {
      expect(new Set(t.map((r) => r.old)).size, `${name}: an old SHA repeats`).toBe(t.length);
      expect(new Set(t.map((r) => r.neu)).size, `${name}: a new SHA repeats`).toBe(t.length);
    }
    expect(t1.length).toBeGreaterThan(0);
    expect(t2.length).toBeGreaterThan(t1.length);
    console.info(`rebase map: table 1 ${t1.length} rows, table 2 ${t2.length} rows`);
  });

  it("table 2 composes onto table 1: every rebase-1 commit was rebased again — the last rows, in table 1's order, under its subject — and every other row is a commit made after rebase 1", () => {
    const { t1, t2 } = parseRebaseMap(readFileSync(DOC, "utf8"));
    const news1 = new Set(t1.map((r) => r.neu));
    const olds1 = new Set(t1.map((r) => r.old));
    const traced = t2.filter((r) => news1.has(r.old));
    expect(traced.map((r) => r.old), "a rebase-1 commit is missing from table 2, or out of order").toEqual(t1.map((r) => r.neu));
    expect(traced.map((r) => r.subject)).toEqual(t1.map((r) => r.subject));
    // Newest first: the rebase-1 commits are the oldest, so they end the table.
    expect(t2.slice(t2.length - t1.length)).toEqual(traced);
    const after = t2.slice(0, t2.length - t1.length);
    expect(after.length, "no commit after rebase 1 — the composition would be vacuous on that side").toBeGreaterThan(0);
    for (const r of after) {
      expect(olds1.has(r.old), `${r.old}: a pre-rebase-1 SHA in table 2's recorded column`).toBe(false);
      expect(news1.has(r.old), `${r.old}: a rebase-1 commit above the rebase-1 block`).toBe(false);
    }
    console.info(`rebase map: ${traced.length} rows trace through table 1, ${after.length} are commits made after rebase 1`);
  });

  it("every table-2 new SHA is an ancestor of HEAD, and its subject is the table's (git, full history)", () => {
    const { t2 } = parseRebaseMap(readFileSync(DOC, "utf8"));
    const history = headHistory();
    expect(history.length).toBeGreaterThan(t2.length);
    let checked = 0;
    for (const r of t2) {
      const full = history.filter((h) => h.startsWith(r.neu));
      expect(full.length, `${r.neu} (${r.subject}) is not an ancestor of HEAD`).toBe(1);
      expect(git(["log", "-1", "--format=%s", full[0]!]).trim(), r.neu).toBe(r.subject);
      checked++;
    }
    expect(checked).toBe(t2.length);
    console.info(`rebase map: ${checked} table-2 SHAs are ancestors of HEAD, each under its subject`);
  });

  it("every distinct harnessCommit a committed W1-driving run recorded is in a recorded column, and reaches HEAD's history through the tables", () => {
    const { t1, t2 } = parseRebaseMap(readFileSync(DOC, "utf8"));
    const recorded = recordedHarnessCommits();
    expect(recorded.size, "no recorded harnessCommit — the check would be vacuous").toBeGreaterThan(0);
    const via1 = new Map(t1.map((r) => [r.old, r.neu]));
    const via2 = new Map(t2.map((r) => [r.old, r.neu]));
    const history = headHistory();
    let checked = 0;
    for (const sha of recorded.keys()) {
      expect(via1.has(sha) || via2.has(sha), `${sha}: recorded by a committed run, in neither table's recorded column`).toBe(true);
      const mid = via1.get(sha) ?? sha;
      const head = via2.get(mid);
      expect(head, `${sha}: maps to ${mid}, which table 2 does not carry`).toBeDefined();
      expect(history.some((h) => h.startsWith(head!)), `${sha} → ${head}: not an ancestor of HEAD`).toBe(true);
      checked++;
    }
    expect(checked).toBe(recorded.size);
    console.info(`rebase map: ${checked} distinct recorded harnessCommits (${[...recorded.values()].reduce((a, n) => a + n, 0)} reports) each reach HEAD — ${basename(DOC)}`);
  });
});
