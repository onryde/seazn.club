import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { AWAITING_PROOF, ENGINE, ID, ROW_HEADER, RULES_DIR, STATUS, allRows, engineFileExists, hasToken, inEngine, isMatrixCase, parseRuleRows, proofBudget, proofProblems, readEngineFile, ruleFiles, testTitles, type ReadRepoFile, type RuleRow } from "./rules-reference.ts";
import { OPEN, W2B_PER_FILE, W2B_ROWS, X_BR_1, readAppendixA, signed, w2bIds, w2bProblems } from "./w2b-rows.ts";

/** The (row, proving test path) pairs this file's proof check reads: every signed or deviation row not awaiting proof, each
 *  of its non-matrix paths under packages/engine/ (the monorepo's checker reads the rest). Counted from the table, not from
 *  the check's own reads. */
const PROOF_PAIRS = allRows()
  .filter((r) => !r.status.startsWith("⬜") && !AWAITING_PROOF.has(r.id))
  .reduce((n, r) => n + r.provedBy.filter((p) => !isMatrixCase(p) && inEngine(p)).length, 0);

/** The ten ids W2a seeds, typed from spec §6 (2026-10-08-format-matrix-w2a-design.md, "W2a seeds only"). */
const SEEDED = ["X-BR-1", "X-BR-2", "X-ST-1", "X-ST-2", "X-DR-1", "BG-KO-1", "BG-KO-2", "CA-KO-1", "GN-KO-1", "CK-KO-1"];

/** A row's test paths (matrix cases excluded). */
const testPaths = (r: RuleRow): number => r.provedBy.filter((p) => !isMatrixCase(p)).length;

/** In-memory files for synthetic rows: no synthetic row borrows a real file as its proof. Every path is repo-relative. */
const PROVES_TS = "apps/web/src/server/__tests__/proves.test.ts";
const PROVES_SPEC = "apps/web/e2e/proves.spec.ts";
const PROVES_TSX = "apps/web/src/components/__tests__/proves.test.tsx";
const NEAR_MISS = "apps/web/src/server/__tests__/near-miss.test.ts";
const COMMENT_ONLY = "apps/web/src/server/__tests__/comment-only.test.ts";
const BODY_STRING = "apps/web/src/server/__tests__/body-string.test.ts";
const DB_GATED = "apps/web/src/server/__tests__/db-gated.test.ts";
const GATED_GROUP = "apps/web/src/server/__tests__/gated-group.test.ts";
const SKIPPED_GROUP = "apps/web/src/server/__tests__/skipped-group.test.ts";
const SERIAL_SPEC = "apps/web/e2e/serial.spec.ts";
const WOULD_PROVE = 'it("X-ZZ-1: would prove, if its location counted", () => {});';
/** Locations that must be refused even though each file holds a proving title. */
const REFUSED_LOCATIONS: Array<[string, string]> = [
  ["packages/engine/rules/proves.test.ts", "is under packages/engine/rules/ or docs/, which cannot prove a rule"],
  ["docs/proves.test.ts", "is under packages/engine/rules/ or docs/, which cannot prove a rule"],
  ["packages/engine/test/rules-reference.test.ts", "is the checker itself, which holds every id as data"],
  ["packages/engine/test/rules-reference.ts", "is the checker itself, which holds every id as data"],
  ["scripts/__tests__/rules-reference.test.ts", "is the checker itself, which holds every id as data"],
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
  // The shapes later W2a proofs are written in: DB-gated unit tests and serial Playwright groups (re-review M-2).
  [DB_GATED, 'it.skipIf(!HAS_DB)("X-ZZ-1: needs a database", async () => {});'],
  [GATED_GROUP, 'describe.skipIf(!HAS_DB)("db group", () => { it("X-ZZ-1: inside a gated group", () => {}); });'],
  [SERIAL_SPEC, 'test.describe.serial("X-ZZ-1 walkthrough", () => { test("step one", async () => {}); });'],
  // An unconditional skip proves nothing, and neither does anything inside it (re-review M-1).
  [SKIPPED_GROUP, 'describe.skip("db group", () => { it("X-ZZ-1: inside a skipped group", () => {}); });'],
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

  it("every signed or deviation row names a proving test that exists and contains the id (or awaits proof by name) (engine paths)", (ctx) => {
    const reads: string[] = [];
    // The reader the check calls once per (row, proving test path): counting it is counting the work the budget is for.
    const read: ReadRepoFile = (p) => { reads.push(p); return readEngineFile(p); };
    let rows = 0;
    let paths = 0;
    for (const r of allRows()) {
      if (r.status.startsWith("⬜")) continue;
      if (AWAITING_PROOF.has(r.id)) {
        expect(r.provedBy, `${r.id} awaits ${AWAITING_PROOF.get(r.id)} and must not claim proof yet`).toEqual([]);
        rows++;
        continue;
      }
      // The row-level refusals (a row naming no test) plus every proof under packages/engine/; the monorepo's checker reads the rest.
      expect(proofProblems(r, read, inEngine), r.id).toEqual([]);
      const mine = r.provedBy.filter((p) => !isMatrixCase(p) && inEngine(p)).length;
      paths += mine;
      if (mine > 0) rows++;
    }
    expect(rows, "signed rows with a proof path under packages/engine/").toBeGreaterThan(0);
    expect(paths, "proof paths under packages/engine/, each read and its titles checked").toBeGreaterThan(0);
    // the split is observed, not assumed: every path this half read is the engine's (a literal, not the predicate under test)
    expect(reads.filter((p) => !p.startsWith("packages/engine/")), "paths outside the engine this half read").toEqual([]);
    expect(reads.length, "paths this half read").toBe(paths);
    // Batch 4 review M7 (AGENTS.md class 20): one read and, per distinct file, one TypeScript parse for every pair, so the
    // cost grows with the table. The budget is stated from the pairs the table has, and the run made exactly those.
    expect(reads.length, "the reads the budget was derived from are the reads made").toBe(PROOF_PAIRS);
    expect(ctx.task.timeout, "the timeout vitest applied is the one stated from those pairs, not a default").toBe(proofBudget(reads.length));
  }, proofBudget(PROOF_PAIRS));

  it("the proof checks catch a row with no test, a missing file and a file that does not name the id (synthetic signed rows)", () => {
    expect(proofProblems(row([]), read)).toEqual(["X-ZZ-1 names no proving test"]);
    expect(proofProblems(row(["apps/web/src/server/__tests__/no-such.test.ts"]), read)).toEqual(["X-ZZ-1: apps/web/src/server/__tests__/no-such.test.ts does not exist"]);
    expect(proofProblems(row([BODY_STRING]), read)).toEqual([noTitle(BODY_STRING)]);
    expect(proofProblems(row([PROVES_TS]), read)).toEqual([]); // the positive pair: an in-memory file whose title names the id
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
    expect(checked).toBe(11);
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

  it("a conditional skip and a Playwright describe mode carry a title; an unconditional skip, todo or fixme neither yields one nor is entered (re-review M-1, M-2)", () => {
    const source = [
      'it.skipIf(!HAS_DB)("X-ZZ-1: db gated", () => {});',
      'it.runIf(HAS_DB)("X-ZZ-1: db only", () => {});',
      'test.skipIf(browserName === "webkit")("X-ZZ-1: not on webkit", async () => {});',
      'test.runIf(isCi)("X-ZZ-1: only in ci", async () => {});',
      'describe.skipIf(!HAS_DB)("X-ZZ-1 gated group", () => { it("X-ZZ-1: inside gated", () => {}); });',
      'describe.runIf(HAS_DB)("X-ZZ-1 run group", () => {});',
      'test.describe.serial("X-ZZ-1 serial group", () => { test("X-ZZ-1: in serial", async () => {}); });',
      'test.describe.parallel("X-ZZ-1 parallel group", () => {});',
      // None of the following is a proof, and nothing inside any of them is either.
      'describe.skip("X-ZZ-1 skipped group", () => { it("X-ZZ-1: in skipped group", () => {}); });',
      'describe.todo("X-ZZ-1 todo group", () => { it("X-ZZ-1: in todo group", () => {}); });',
      'it.skip("X-ZZ-1: skipped", () => {});',
      'it.todo("X-ZZ-1: todo");',
      'test.fixme("X-ZZ-1: fixme", async () => {});',
      'test.describe.skip("X-ZZ-1 pw skipped group", () => { test("X-ZZ-1: in pw skipped", async () => {}); });',
      'test.describe.fixme("X-ZZ-1 pw fixme group", () => { test("X-ZZ-1: in pw fixme", async () => {}); });',
      'describe.skip.each([1])("X-ZZ-1 skipped each", () => { it("X-ZZ-1: in skipped each", () => {}); });',
      // Wrong shapes are not title-bearing calls, whatever their names.
      'it.skipIf("X-ZZ-1: gate used as the test", () => {});',
      'it(HAS_DB)("X-ZZ-1: a call, not a gate", () => {});',
      'other.skipIf(c)("X-ZZ-1: not a test root", () => {});',
      // A skip that is not a test's skip hides nothing: its body is still read.
      'unrelated.skip(() => { it("X-ZZ-1: beside a skip that is not a test skip", () => {}); });',
      'test.describe.configure({ mode: "serial" });',
    ].join("\n");
    const titles = testTitles("gated.test.ts", source);
    expect(titles).toEqual([
      "X-ZZ-1: db gated", "X-ZZ-1: db only", "X-ZZ-1: not on webkit", "X-ZZ-1: only in ci",
      "X-ZZ-1 gated group", "X-ZZ-1: inside gated", "X-ZZ-1 run group",
      "X-ZZ-1 serial group", "X-ZZ-1: in serial", "X-ZZ-1 parallel group", "X-ZZ-1: beside a skip that is not a test skip",
    ]);
    expect(titles).toHaveLength(11); // anti-vacuity: eleven titles read, not an empty list that happens to agree
  });

  it("a DB-gated or serial proof counts; the same id inside an unconditional skip is refused, and inside a conditional one is accepted (probe pin, synthetic signed rows)", () => {
    for (const ok of [DB_GATED, GATED_GROUP, SERIAL_SPEC]) expect(proofProblems(row([ok]), read), ok).toEqual([]);
    expect(proofProblems(row([SKIPPED_GROUP]), read)).toEqual([noTitle(SKIPPED_GROUP)]);
    // The pair that differs in one word: skip vs skipIf around the same body.
    const body = (wrap: string) => `${wrap}("db group", () => { it("X-ZZ-1: inside", () => {}); });`;
    expect(testTitles("p.test.ts", body("describe.skip"))).toEqual([]);
    expect(testTitles("p.test.ts", body("describe.skipIf(!HAS_DB)"))).toEqual(["db group", "X-ZZ-1: inside"]);
  });

  it("the title memo (M-3) keys on the source, not just the path: one path, two sources, back again; a caller's edit never reaches the memo", () => {
    const path = "memo.test.ts";
    const a = 'it("X-ZZ-1: first source", () => {});';
    const b = 'it("X-ZZ-2: second source", () => {});';
    const seen: string[][] = [];
    for (const source of [a, b, a, a]) seen.push(testTitles(path, source));
    expect(seen).toEqual([["X-ZZ-1: first source"], ["X-ZZ-2: second source"], ["X-ZZ-1: first source"], ["X-ZZ-1: first source"]]);
    // The list handed out is the caller's own: pushing into it must not change the next answer for the same source.
    seen[3]!.push("X-ZZ-9: smuggled");
    expect(testTitles(path, a)).toEqual(["X-ZZ-1: first source"]);
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

  it("every enforced-at path exists (engine paths)", () => {
    const checked: string[] = [];
    for (const r of allRows()) for (const p of r.enforcedAt) {
      if (!inEngine(p)) continue; // not the engine's: checked by scripts/__tests__/rules-reference.test.ts
      expect(engineFileExists(p), `${r.id}: ${p}`).toBe(true);
      checked.push(p);
    }
    expect(checked.length, "enforced-at paths under packages/engine/").toBeGreaterThan(0);
    expect(checked.filter((p) => !p.startsWith("packages/engine/")), "paths outside the engine this half checked").toEqual([]);
  });

  // ---- Added by engine-split 1d-5 (the split of the checker between the engine and the monorepo, and the testkit export).

  it("the checker's scope splits a row's proofs: the engine's reader resolves packages/engine/ paths against the engine directory (the standalone-repo layout is proven by the 1d-6 sim run, not here) and reads nothing else (synthetic signed rows)", () => {
    const seen: string[] = [];
    const spy: ReadRepoFile = (p) => { seen.push(p); return FIXTURES.get(p); };
    const mine = "packages/engine/src/no-such.test.ts";
    // a row proved by an app test and an engine test: the engine half reads only the engine's path, and names it when it is missing
    expect(proofProblems(row([PROVES_TS, mine]), spy, inEngine)).toEqual([`X-ZZ-1: ${mine} does not exist`]);
    expect(seen).toEqual([mine]);
    // the other half sees the complement: the app test only
    seen.length = 0;
    expect(proofProblems(row([PROVES_TS, mine]), spy, (p) => !inEngine(p))).toEqual([]);
    expect(seen).toEqual([PROVES_TS]);
    // a row none of whose proofs are in scope has nothing to read here; the row-level refusal is the same under any scope
    expect(proofProblems(row([PROVES_TS]), spy, inEngine)).toEqual([]);
    for (const none of [[], ["matrix:SC-O1"]]) expect(proofProblems(row(none), spy, inEngine)).toEqual(["X-ZZ-1 names no proving test"]);
    // the reader: an engine path resolves under the engine directory, whether it sits at packages/engine/ or at a repo root
    expect(readEngineFile("packages/engine/rules/carrom.md")).toContain("CA-KO-1");
    expect(readEngineFile("packages/engine/rules/no-such.md")).toBeUndefined();
    expect(readEngineFile("apps/web/package.json")).toBeUndefined(); // not the engine's, though the monorepo holds it
    expect(engineFileExists("packages/engine/rules/carrom.md")).toBe(true);
    expect(engineFileExists("packages/engine/no-such-file")).toBe(false);
    expect(engineFileExists("apps/web/package.json")).toBe(false);
    // a path outside the prefix whose tail names a real engine file is still not the engine's (the prefix is checked, not just sliced off)
    expect(engineFileExists("x".repeat("packages/engine/".length) + "rules/carrom.md")).toBe(false);
    expect(readEngineFile("x".repeat("packages/engine/".length) + "rules/carrom.md")).toBeUndefined();
    expect(inEngine("packages/engine/x")).toBe(true);
    expect(inEngine("packages/engineer/x")).toBe(false); // a prefix is a directory, not a string prefix of a sibling
    expect(inEngine("apps/packages/engine/x")).toBe(false);
  });

  it("the published testkit barrel exports the rules parser, and its disk-reading closure is exactly the rules reference", async () => {
    const testkit = join(ENGINE, "src/testkit");
    const seen = new Set<string>();
    const readers: string[] = [];
    const queue = [join(testkit, "index.ts")];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      // the compiler's own import scan, so a comment that happens to hold `/*` or `//` can never hide an import
      for (const { fileName: spec } of ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles) {
        if (spec.startsWith(".")) queue.push(join(file, "..", spec));
        else if (/^(?:node:)?fs(?:\/|$)/.test(spec) && !readers.includes(file)) readers.push(file);
      }
    }
    expect(seen.size, "files in the testkit barrel's closure").toBeGreaterThan(10);
    // node:fs must not creep into the barrel again: the one exception is the module whose input ships with the package
    expect(readers.map((f) => f.slice(ENGINE.length + 1))).toEqual(["src/testkit/rules-reference.ts"]);
    // the seam, not just the module: the barrel itself hands a consumer the parser, and what it parses is the package's rules
    const barrel = await import("../src/testkit/index.ts");
    expect(typeof barrel.allRows).toBe("function");
    expect(typeof barrel.parseRuleRows).toBe("function");
    expect(barrel.ruleFiles()).toEqual(ruleFiles());
    expect(barrel.allRows().length).toBe(allRows().length);
    expect(barrel.allRows().length).toBeGreaterThan(0);
  });
});

describe("W2b rows (spec §6, Appendix A; plan PF-6, PF-7, PF-13; rulings 108, 112, 113, 114, 115, 118)", () => {
  it("W2b: the 55 new ids (Appendix A's 53, plus CK-WO-2 and X-WD-6) are present, each in its file and signed or deviation with its ruling number from Appendix A (108, 113, 115, 118 or 124 where that ruling changed the text; 125 signed PF-6's CK-WO-2), and X-BR-1's text says 'a win or a double walkover'", () => {
    const ids = w2bIds();
    expect(ids).toHaveLength(55);
    expect(new Set(ids).size).toBe(55); // no id pinned twice
    expect(ids.filter((id) => SEEDED.includes(id))).toEqual([]); // spec §6: new and unique against the W2a seed
    for (const [file, n] of Object.entries(W2B_PER_FILE)) expect(Object.keys(W2B_ROWS[file] ?? {}), file).toHaveLength(n);
    expect(Object.keys(W2B_ROWS).sort()).toEqual(Object.keys(W2B_PER_FILE).sort());
    expect(Object.values(W2B_PER_FILE).reduce((a, b) => a + b, 0)).toBe(55);
    // Appendix A's 53 are signed or deviation, X-WD-6 since ruling 113 and PF-6's CK-WO-2 since ruling 125: none is open.
    const open = Object.values(W2B_ROWS).flatMap((ids) => Object.entries(ids)).filter(([, s]) => s === OPEN).map(([id]) => id);
    expect(open.sort()).toEqual([]);
    expect(Object.values(W2B_ROWS).flatMap((ids) => Object.values(ids)).filter((s) => s.startsWith("signed ")).length, "signed rows").toBe(53);
    expect(w2bProblems(allRows())).toEqual([]);
  });

  it("the W2b pin sees a dropped row, a row in the wrong file, a wrong status and X-BR-1's old text (synthetic edits of the real rows)", () => {
    const rows = allRows();
    const edit = (id: string, patch: Partial<RuleRow>) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    expect(w2bProblems(rows.filter((r) => r.id !== "HK-WO-1"))).toEqual(["HK-WO-1: missing (owed in hockey.md)"]);
    expect(w2bProblems(edit("CK-AB-2", { file: "cross-sport.md" }))).toEqual(["CK-AB-2: in cross-sport.md, not cricket.md"]);
    expect(w2bProblems(edit("X-WO-1", { status: signed(86) }))).toEqual([`X-WO-1: status "${signed(86)}", not "${signed(108, "2026-10-11")}"`]);
    const br = rows.find((r) => r.id === "X-BR-1");
    expect(br).toBeDefined();
    const old = (br?.rule ?? "").replace(X_BR_1.says, "decided only by a win");
    expect(w2bProblems(edit("X-BR-1", { rule: old }))).toHaveLength(1);
    expect(w2bProblems(edit("X-BR-1", { provedBy: ["apps/web/src/server/engine-db/__tests__/settle-seating.test.ts"] }))).toHaveLength(1);
  });

  it("Appendix A's reader refuses no section, no stated total, a row before any file subsection, a 5-cell row and a table with no row; a new file's \"(new)\" heading counts and the next ## heading ends it (synthetic spec text)", () => {
    const head = "\n## Appendix A — rows\n\n1 rows: x.md 1.\n\n";
    const table = "| id | rule | citation | status | enforced at | proved by |\n|---|---|---|---|---|---|\n";
    expect(() => readAppendixA("# a spec\n")).toThrow(/no "## Appendix A" section/);
    expect(() => readAppendixA("\n## Appendix A\n\n### `x.md`\n" + table + "| X-ZZ-1 | r | c | s | — | — |\n")).toThrow(/states its own total/);
    expect(() => readAppendixA(head + table + "| X-ZZ-1 | r | c | s | — | — |\n")).toThrow(/X-ZZ-1 sits before any/);
    expect(() => readAppendixA(head + "### `x.md`\n" + table + "| X-ZZ-1 | r | c | s | — |\n")).toThrow(/5 cells, not 6/);
    expect(() => readAppendixA(head + "### `x.md`\n" + table)).toThrow(/no row parsed/);
    // The positive pair: one row read, and a row under the next ## heading is not Appendix A's.
    const next = "## Appendix B\n\n### `y.md`\n" + table + "| X-ZZ-2 | r2 | c | s | — | — |\n";
    const two = "### `z.md (new)`\n" + table + "| X-ZZ-3 | r3 | c | s | — | — |\n";
    expect(readAppendixA(head + "### `x.md`\n" + table + "| X-ZZ-1 | r | c | s | — | — |\n| X-ZZ-1 (amend) | a | c | s | — | — |\n" + two + next)).toEqual({
      rows: [{ id: "X-ZZ-1", rule: "r", file: "x.md" }, { id: "X-ZZ-3", rule: "r3", file: "z.md" }],
      amendments: ["X-ZZ-1 (amend)"],
      stated: 1,
    });
  });

  it("every W2b row names a proving test and an enforcement site, and the open row's proofs prove it too, so no listed proof is unchecked evidence (the signed rows' are proved by the check above)", () => {
    const byId = new Map(allRows().map((r) => [r.id, r]));
    let named = 0;
    let openProved = 0;
    for (const id of [...w2bIds(), "X-BR-1"]) {
      const r = byId.get(id);
      expect(r, id).toBeDefined();
      if (r === undefined) continue;
      expect(testPaths(r), `${id} lists no proving test`).toBeGreaterThan(0);
      expect(r.enforcedAt.length, `${id} names no enforcement site`).toBeGreaterThan(0);
      named++;
      if (r.status !== OPEN) continue;
      expect(proofProblems(r), id).toEqual([]);
      openProved++;
    }
    expect(named).toBe(56);
    // Ruling 125 signed the one open row (CK-WO-2): no W2b row is open, so no open row owes a proof here.
    expect(openProved).toBe(0);
  });
});
