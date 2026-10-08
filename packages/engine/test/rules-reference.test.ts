import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ID, REPO, ROW_HEADER, RULES_DIR, STATUS, allRows, fileExists, hasToken, isMatrixCase, parseRuleRows, proofProblems, readRepoFile, ruleFiles, testTitles, type ReadRepoFile, type RuleRow } from "./rules-reference.ts";

/** Signed rows whose proving test lands in a later W2a task. A task that adds
 *  the proof deletes its id here in the same commit; Task 16 Step 5 requires
 *  this map to be EMPTY. A row not named here must already be proved. */
const AWAITING_PROOF: ReadonlyMap<string, string> = new Map([
  ["X-DR-1", "Task 3"],
  ["X-ST-1", "Task 4"],
  ["BG-KO-1", "Task 5"],
  ["BG-KO-2", "Task 12"],
  ["CA-KO-1", "Task 5"],
  ["X-BR-2", "Task 7"],
  ["X-BR-1", "Task 8"],
  ["GN-KO-1", "Task 8"],
  ["CK-KO-1", "Task 8"],
  ["X-ST-2", "Task 9"],
]);

/** The ten ids W2a seeds, typed from spec §6 (2026-10-08-format-matrix-w2a-design.md, "W2a seeds only"). */
const SEEDED = ["X-BR-1", "X-BR-2", "X-ST-1", "X-ST-2", "X-DR-1", "BG-KO-1", "BG-KO-2", "CA-KO-1", "GN-KO-1", "CK-KO-1"];

/** In-memory files for synthetic rows: no synthetic row borrows a real file as its proof. Every path is repo-relative. */
const PROVES_TS = "apps/web/src/server/__tests__/proves.test.ts";
const PROVES_SPEC = "apps/web/e2e/proves.spec.ts";
const PROVES_TSX = "apps/web/src/components/__tests__/proves.test.tsx";
const NEAR_MISS = "apps/web/src/server/__tests__/near-miss.test.ts";
const COMMENT_ONLY = "apps/web/src/server/__tests__/comment-only.test.ts";
const BODY_STRING = "apps/web/src/server/__tests__/body-string.test.ts";
const WOULD_PROVE = 'it("X-ZZ-1: would prove, if its location counted", () => {});';
/** Locations that must be refused even though each file holds a proving title. */
const REFUSED_LOCATIONS: Array<[string, string]> = [
  ["packages/engine/rules/proves.test.ts", "is under packages/engine/rules/ or docs/, which cannot prove a rule"],
  ["docs/proves.test.ts", "is under packages/engine/rules/ or docs/, which cannot prove a rule"],
  ["packages/engine/test/rules-reference.test.ts", "is the checker itself, which holds every id as data"],
  ["packages/engine/test/rules-reference.ts", "is the checker itself, which holds every id as data"],
  ["apps/web/src/server/helper.ts", "is not a test file (*.test.ts, *.test.tsx or *.spec.ts)"],
  ["apps/web/src/server/notes.md", "is not a test file (*.test.ts, *.test.tsx or *.spec.ts)"],
  ["./apps/web/src/server/__tests__/proves.test.ts", "is not a normalised repo-relative path"],
  ["apps/web/src/other/../server/__tests__/proves.test.ts", "is not a normalised repo-relative path"],
  ["/apps/web/src/server/__tests__/proves.test.ts", "is not a normalised repo-relative path"],
  ["../elsewhere/proves.test.ts", "is not a normalised repo-relative path"],
];
const FIXTURES = new Map<string, string>([
  [PROVES_TS, 'it("X-ZZ-1: proves it", () => {});'],
  [PROVES_SPEC, 'test("X-ZZ-1: proves it in the browser", async () => {});'],
  [PROVES_TSX, 'describe("X-ZZ-1 group", () => {});'],
  [COMMENT_ONLY, '// it("X-ZZ-1: only a comment", () => {});\nit("unrelated", () => {});'],
  [BODY_STRING, 'it("unrelated", () => { expect("X-ZZ-1").toBe("X-ZZ-1"); });'],
  [NEAR_MISS, 'it("X-ZZ-10: a different rule", () => {});'],
  ...REFUSED_LOCATIONS.map(([p]): [string, string] => [p, WOULD_PROVE]),
]);
const read: ReadRepoFile = (p) => FIXTURES.get(p);
const row = (provedBy: string[]): RuleRow => ({ id: "X-ZZ-1", rule: "r", citation: "c", status: "signed 1 2026-10-08", enforcedAt: [], provedBy, file: "synthetic.md" });
const noTitle = (p: string) => `X-ZZ-1: ${p} has no it/test/describe title naming "X-ZZ-1"`;

describe("rules reference (ruling 75, spec §6)", () => {
  it("empty case first: a file with no rule table parses to no rows", () => {
    expect(parseRuleRows("# nothing here\n", "empty.md")).toEqual([]);
  });

  it("parses at least one row from every rule file, and zero rows overall is a failure", () => {
    const files = ruleFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(parseRuleRows(readFileSync(join(RULES_DIR, f), "utf8"), f).length, f).toBeGreaterThan(0);
    expect(allRows().length).toBeGreaterThan(0);
  });

  it("the ten ids W2a seeds are all present: the expectation is spec §6's list, not the parsed files", () => {
    expect(SEEDED).toHaveLength(10);
    const have = new Set(allRows().map((r) => r.id));
    expect(SEEDED.filter((id) => !have.has(id))).toEqual([]);
  });

  it("every id is well-formed and unique across all files", () => {
    const rows = allRows();
    const seen = new Map<string, string>();
    for (const r of rows) {
      expect(r.id, `${r.file}: ${r.id}`).toMatch(ID);
      expect(seen.get(r.id), `${r.id} in ${r.file} and ${seen.get(r.id)}`).toBeUndefined();
      seen.set(r.id, r.file);
    }
    expect(seen.size).toBe(rows.length);
  });

  it("every status is signed <ruling> <date>, deviation <ruling> <date> or ⬜ open", () => {
    const rows = allRows();
    for (const r of rows) expect(r.status, r.id).toMatch(STATUS);
    expect(rows.length).toBeGreaterThan(0);
    // The three forms and near-misses of each (synthetic: at Task 2 no real row is a deviation or open).
    let accepted = 0;
    for (const ok of ["signed 73 2026-10-08", "deviation 5 2026-10-08", "⬜ open"]) { expect(ok, ok).toMatch(STATUS); accepted++; }
    expect(accepted).toBe(3);
    let refused = 0;
    for (const bad of ["signed 73 08-10-2026", "signed 2026-10-08", "deviation 2026-10-08", "signed 73 2026-10-08 extra", "prefix signed 73 2026-10-08", "open", "⬜ open "]) { expect(bad, bad).not.toMatch(STATUS); refused++; }
    expect(refused).toBe(7);
  });

  it("every signed or deviation row names a proving test that exists and contains the id (or awaits proof by name)", () => {
    let checked = 0;
    for (const r of allRows()) {
      if (r.status.startsWith("⬜")) continue;
      if (AWAITING_PROOF.has(r.id)) {
        expect(r.provedBy, `${r.id} awaits ${AWAITING_PROOF.get(r.id)} and must not claim proof yet`).toEqual([]);
        checked++;
        continue;
      }
      expect(proofProblems(r), r.id).toEqual([]);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("the proof checks catch a row with no test, a missing file and a file that does not name the id (synthetic signed rows)", () => {
    expect(proofProblems(row([]), read)).toEqual(["X-ZZ-1 names no proving test"]);
    expect(proofProblems(row(["apps/web/src/server/__tests__/no-such.test.ts"]), read)).toEqual(["X-ZZ-1: apps/web/src/server/__tests__/no-such.test.ts does not exist"]);
    expect(proofProblems(row([BODY_STRING]), read)).toEqual([noTitle(BODY_STRING)]);
    expect(proofProblems(row([PROVES_TS]), read)).toEqual([]); // the positive pair: an in-memory file whose title names the id
  });

  it("the default reader reads the real repo: a missing file is undefined, any other failure is loud, and proofProblems uses it when none is injected", () => {
    expect(readRepoFile("packages/engine/rules/carrom.md")).toContain("CA-KO-1");
    expect(readRepoFile("packages/engine/rules/no-such.md")).toBeUndefined();
    expect(() => readRepoFile("packages/engine/rules")).toThrow(/EISDIR/);
    expect(proofProblems(row(["apps/web/src/no-such-file.test.ts"]))).toEqual(["X-ZZ-1: apps/web/src/no-such-file.test.ts does not exist"]);
    // A REAL test file, read through the default reader: it exists, and none of its titles names the synthetic id.
    const real = "packages/engine/test/source-bytes.test.ts";
    expect(proofProblems(row([real]))).toEqual([noTitle(real)]);
  });

  it("a matrix: entry is additional evidence only: skipped beside a real proving test, and a matrix-only row names no proving test (synthetic signed rows)", () => {
    expect(proofProblems(row([PROVES_TS, "matrix:SC-O1"]), read)).toEqual([]);
    expect(proofProblems(row(["matrix:SC-O1"]), read)).toEqual(["X-ZZ-1 names no proving test"]);
    expect(proofProblems(row(["matrix:SC-O1", "matrix:SC-O2"]), read)).toEqual(["X-ZZ-1 names no proving test"]);
    expect(isMatrixCase("matrix:SC-O1")).toBe(true);
    expect(isMatrixCase(PROVES_TS)).toBe(false); // the negative pair
  });

  it("a proof path must be a normalised repo-relative test file outside packages/engine/rules/, docs/ and the checker itself (synthetic signed rows)", () => {
    let checked = 0;
    for (const [p, why] of REFUSED_LOCATIONS) {
      expect(proofProblems(row([p]), read), p).toEqual([`X-ZZ-1: ${p} ${why}`]);
      checked++;
    }
    expect(checked).toBe(10);
    // The positive pairs: a test file, a spec file and a .tsx test file elsewhere in the repo are all accepted.
    for (const ok of [PROVES_TS, PROVES_SPEC, PROVES_TSX]) expect(proofProblems(row([ok]), read), ok).toEqual([]);
  });

  it("test titles are the first string argument of it/test/describe/test.describe calls: not a comment, a body string, a second argument, a skipped or generated test", () => {
    const source = [
      '// it("X-ZZ-1: in a line comment", () => {});',
      '/* test("X-ZZ-1: in a block comment", () => {}); */',
      'const note = "X-ZZ-1 in a plain string";',
      'describe("outer X-ZZ-1 suite", () => {',
      '  it("X-ZZ-1: nested title", () => { const inner = "X-ZZ-1 body string"; });',
      '  it.skip("X-ZZ-1: skipped", () => {});',
      '  it.each([1])("X-ZZ-1: generated", () => {});',
      "});",
      "test(`X-ZZ-1: template`, () => {});",
      'test.describe("pw X-ZZ-1 group", () => {});',
      'test.skip("X-ZZ-1: pw skipped", () => {});',
      'it("a title", "X-ZZ-1 second argument");',
      "it(TITLE, () => {});",
      'other("X-ZZ-1: not a test call");',
    ].join("\n");
    expect(testTitles("a.test.ts", source)).toEqual(["outer X-ZZ-1 suite", "X-ZZ-1: nested title", "X-ZZ-1: template", "pw X-ZZ-1 group", "a title"]);
    expect(testTitles("b.test.tsx", 'const view = () => <div>{1}</div>;\nit("X-ZZ-1: after jsx", () => {});')).toEqual(["X-ZZ-1: after jsx"]);
    expect(testTitles("c.test.ts", "")).toEqual([]); // the empty case
  });

  it("an id must be a whole token in the title: a longer id, a prefix or a suffix is a near-miss, not a proof (synthetic titles)", () => {
    const cases: Array<[string, boolean]> = [
      ["X-ZZ-1: a title", true], ["(X-ZZ-1)", true], ["X-ZZ-1", true], ["covers X-ZZ-1.", true],
      ["X-ZZ-10: another rule", false], ["X-ZZ-1-b", false], ["AX-ZZ-1", false], ["R-X-ZZ-1", false], ["1X-ZZ-1", false], ["X-ZZ-1a", false], ["X-ZZ-2", false],
    ];
    for (const [title, want] of cases) expect(hasToken(title, "X-ZZ-1"), title).toBe(want);
    expect(cases).toHaveLength(11);
    // End to end through a file: X-ZZ-1 against a file holding only X-ZZ-10 is refused, X-ZZ-10 against it is not.
    expect(proofProblems(row([NEAR_MISS]), read)).toEqual([noTitle(NEAR_MISS)]);
    expect(proofProblems({ ...row([NEAR_MISS]), id: "X-ZZ-10" }, read)).toEqual([]);
    expect(proofProblems(row([COMMENT_ONLY]), read)).toEqual([noTitle(COMMENT_ONLY)]);
  });

  it("every listed test path must prove the id, not just one of them (synthetic signed rows)", () => {
    const missing = "apps/web/src/server/__tests__/no-such.test.ts";
    expect(proofProblems(row([PROVES_TS, NEAR_MISS]), read)).toEqual([noTitle(NEAR_MISS)]);
    expect(proofProblems(row([NEAR_MISS, PROVES_TS]), read)).toEqual([noTitle(NEAR_MISS)]);
    expect(proofProblems(row([PROVES_TS, missing]), read)).toEqual([`X-ZZ-1: ${missing} does not exist`]);
    expect(proofProblems(row([PROVES_TS, PROVES_SPEC, PROVES_TSX]), read)).toEqual([]); // the positive pair: all three prove it
  });

  it("the parser refuses a row that is not 6 cells, and ID refuses a malformed id (synthetic inputs)", () => {
    expect(() => parseRuleRows(`${ROW_HEADER}\n|---|---|---|---|---|---|\n| X-ZZ-1 | rule | cite | ⬜ open | — |\n`, "bad.md")).toThrow(/5 cells, not 6/);
    let checked = 0;
    for (const bad of ["x-br-1", "XBR-1", "X-BR-", "ABCD-BR-1"]) { expect(bad, bad).not.toMatch(ID); checked++; }
    expect(checked).toBe(4);
    expect("X-BR-1").toMatch(ID); // the positive pair
  });

  it("a row's path cells split on <br>, strip backticks and read — as none, and prose after the table is not a row (synthetic input)", () => {
    const text = [
      ROW_HEADER,
      "|---|---|---|---|---|---|",
      "| X-ZZ-1 | r | c | signed 1 2026-10-08 | `a/one.ts`<br>`b/two.ts` | `c/three.test.ts` |",
      "| X-ZZ-2 | r | c | ⬜ open | — | — |",
      "",
      "Notes after the table are prose, not rows.",
    ].join("\n");
    const rows = parseRuleRows(text, "synthetic.md");
    expect(rows.map((r) => r.id)).toEqual(["X-ZZ-1", "X-ZZ-2"]);
    expect(rows[0]).toMatchObject({ enforcedAt: ["a/one.ts", "b/two.ts"], provedBy: ["c/three.test.ts"], file: "synthetic.md" });
    expect(rows[1]).toMatchObject({ enforcedAt: [], provedBy: [] });
  });

  it("a row-shaped line the parser did not read is a failure: a row after prose, a second table, or no table header (synthetic inputs)", () => {
    const head = [ROW_HEADER, "|---|---|---|---|---|---|", "| X-ZZ-1 | r | c | ⬜ open | — | — |"];
    // lines 1-3 are the table, 4 is blank, 5 is prose, 6 is a row after it: the table ended at the blank line
    const afterProse = [...head, "", "prose between", "| X-ZZ-3 | r | c | ⬜ open | — | — |"].join("\n");
    expect(() => parseRuleRows(afterProse, "skip.md")).toThrow(/skip\.md: 1 row-shaped line\(s\) not read as rows.*line 6: \| X-ZZ-3 \|/);
    const secondTable = [...head, "", ROW_HEADER, "|---|---|---|---|---|---|", "| X-ZZ-4 | r | c | ⬜ open | — | — |"].join("\n");
    expect(() => parseRuleRows(secondTable, "two.md")).toThrow(/two\.md: 1 row-shaped line\(s\) not read as rows.*line 7: \| X-ZZ-4 \|/);
    const noHeader = ["# A file whose header was mistyped", "", "| X-ZZ-5 | r | c | ⬜ open | — | — |"].join("\n");
    expect(() => parseRuleRows(noHeader, "nohead.md")).toThrow(/nohead\.md: 1 row-shaped line\(s\) not read as rows.*line 3: \| X-ZZ-5 \|/);
    // The positive pairs: the same rows in one table all read; a malformed id inside the table is read (ID reports it), not skipped.
    expect(parseRuleRows([...head, "| X-ZZ-3 | r | c | ⬜ open | — | — |"].join("\n"), "ok.md").map((r) => r.id)).toEqual(["X-ZZ-1", "X-ZZ-3"]);
    expect(parseRuleRows([...head, "| x-zz-9 | r | c | ⬜ open | — | — |"].join("\n"), "bad-id.md").map((r) => r.id)).toEqual(["X-ZZ-1", "x-zz-9"]);
  });

  it("every AWAITING_PROOF id is a real signed row (a stale entry is a failure)", () => {
    const signed = new Set(allRows().filter((r) => !r.status.startsWith("⬜")).map((r) => r.id));
    for (const id of AWAITING_PROOF.keys()) expect(signed.has(id), id).toBe(true);
  });

  it("every enforced-at path exists", () => {
    let checked = 0;
    for (const r of allRows()) for (const p of r.enforcedAt) { expect(fileExists(p), `${r.id}: ${p}`).toBe(true); checked++; }
    expect(checked).toBeGreaterThan(0);
  });
});

// Review I-3: the proofs live in apps/web, e2e and tools, so a PR that touches none of packages/engine/** must still
// run this checker. The engine job in ci.yml is path-filtered; the `gates` job is not.
describe("the checker runs on every pull request: CI wiring (review I-3)", () => {
  const lines = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8").split("\n");
  const code = (l: string) => l.trim() !== "" && !l.trimStart().startsWith("#");
  const HEAD = "      - name: Engine rules reference checker (DB-free)";
  const REPORT = "vitest-results-rules.json";
  const JUDGE = ".numTotalTests > 0 and .numFailedTests == 0 and .numFailedTestSuites == 0 and .numPendingTests == 0 and .numTodoTests == 0 and (.testResults | length) == 1";
  const at = lines.indexOf(HEAD);
  /** The step's own lines: everything after its `- name:` line indented 8 or more (its keys and its block scalar). */
  const stepLines = (): string[] => {
    const out: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (l.trim() !== "" && !l.startsWith("        ")) break;
      out.push(l);
    }
    return out;
  };

  it("one step, in the gates job, named for the checker", () => {
    expect(lines.filter((l) => l === HEAD)).toHaveLength(1);
    expect(at).toBeGreaterThan(0);
    const jobHead = lines.slice(0, at).filter((l) => /^ {2}[a-z][\w-]*:$/.test(l)).pop();
    expect(jobHead).toBe("  gates:");
  });

  it("nothing narrows it: the workflow triggers on every pull request, the job has no condition, the step is only a name and a run block", () => {
    const onAt = lines.indexOf("on:");
    const afterOn = lines.findIndex((l, i) => i > onAt && /^[a-z]/.test(l));
    expect(onAt).toBeGreaterThanOrEqual(0);
    expect(lines.slice(onAt + 1, afterOn).filter(code)).toEqual(["  pull_request:"]); // no paths:, paths-ignore: or branches: under it
    const gates = lines.indexOf("  gates:");
    const steps = lines.indexOf("    steps:", gates);
    expect(lines.slice(gates + 1, steps).filter(code)).toEqual(["    name: Typecheck + lint + drift gates", "    runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}"]);
    expect(stepLines().filter((l) => /^ {8}[a-z-]+:/.test(l)).map((l) => l.trim().replace(/:.*$/, ""))).toEqual(["run"]);
  });

  it("the step runs only this file with the JSON reporter, clears any stale report first, and judges the report", () => {
    const script = stepLines().filter((l) => l.startsWith("          ")).map((l) => l.slice(10));
    expect(script).toEqual([
      "set -euo pipefail",
      `rm -f ${REPORT}`,
      `./packages/engine/node_modules/.bin/vitest run --reporter=default --reporter=json --outputFile=${REPORT} --testTimeout=30000 packages/engine/test/rules-reference.test.ts`,
      `jq -r '"rules reference: \\(.numPassedTests)/\\(.numTotalTests) tests passed"' ${REPORT}`,
      `jq -e '${JUDGE}' ${REPORT}`,
    ]);
  });

  it("the judge is red on zero tests, a failed test, a failed suite, a skip, a todo and a stray file, and green on a clean single-file pass", () => {
    expect(spawnSync("jq", ["--version"], { encoding: "utf8" }).status, "jq must be installed to run this test").toBe(0);
    const report = (o: Record<string, unknown>) => ({ numTotalTests: 11, numPassedTests: 11, numFailedTests: 0, numFailedTestSuites: 0, numPendingTests: 0, numTodoTests: 0, testResults: [{ name: "a.test.ts" }], ...o });
    const judge = (r: object) => spawnSync("jq", ["-e", JUDGE], { input: JSON.stringify(r), encoding: "utf8" }).status;
    expect(judge(report({}))).toBe(0);
    // Each red changes exactly one field, so no condition is covered by another: a file that collected zero tests
    // still has its one testResults entry, and a stray second file leaves every count clean.
    const reds: Array<[string, object]> = [
      ["zero tests in the one file", report({ numTotalTests: 0, numPassedTests: 0 })],
      ["no file matched at all", report({ numTotalTests: 0, numPassedTests: 0, testResults: [] })],
      ["a failed test", report({ numFailedTests: 1 })],
      ["a failed suite", report({ numFailedTestSuites: 1 })],
      ["a skipped test", report({ numPendingTests: 1 })],
      ["a todo test", report({ numTodoTests: 1 })],
      ["a stray file", report({ testResults: [{ name: "a.test.ts" }, { name: "b.test.ts" }] })],
    ];
    for (const [what, r] of reds) expect(judge(r), what).not.toBe(0);
    expect(reds).toHaveLength(7);
  });
});
