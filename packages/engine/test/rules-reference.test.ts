import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ID, ROW_HEADER, RULES_DIR, STATUS, allRows, fileExists, isMatrixCase, parseRuleRows, proofProblems, ruleFiles, type RuleRow } from "./rules-reference.ts";

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
    const row = (provedBy: string[]): RuleRow => ({ id: "X-ZZ-1", rule: "r", citation: "c", status: "signed 1 2026-10-08", enforcedAt: [], provedBy, file: "synthetic.md" });
    expect(proofProblems(row([]))).toEqual(["X-ZZ-1 names no proving test"]);
    expect(proofProblems(row(["packages/engine/test/no-such.test.ts"]))).toEqual(["X-ZZ-1: packages/engine/test/no-such.test.ts does not exist"]);
    expect(proofProblems(row(["packages/engine/vitest.config.ts"]))).toEqual(['X-ZZ-1: packages/engine/vitest.config.ts does not contain "X-ZZ-1"']);
    expect(proofProblems(row(["packages/engine/test/rules-reference.test.ts"]))).toEqual([]); // the positive pair: this file names X-ZZ-1
  });

  it("the parser refuses a row that is not 6 cells, and ID refuses a malformed id (synthetic inputs)", () => {
    expect(() => parseRuleRows(`${ROW_HEADER}\n|---|---|---|---|---|---|\n| X-ZZ-1 | rule | cite | ⬜ open | — |\n`, "bad.md")).toThrow(/5 cells, not 6/);
    let checked = 0;
    for (const bad of ["x-br-1", "XBR-1", "X-BR-", "ABCD-BR-1"]) { expect(bad, bad).not.toMatch(ID); checked++; }
    expect(checked).toBe(4);
    expect("X-BR-1").toMatch(ID); // the positive pair
  });

  it("a rule table ends at the first non-row line, and a row's path cells split on <br>, strip backticks and read — as none (synthetic input)", () => {
    const text = [
      ROW_HEADER,
      "|---|---|---|---|---|---|",
      "| X-ZZ-1 | r | c | signed 1 2026-10-08 | `a/one.ts`<br>`b/two.ts` | `c/three.test.ts` |",
      "| X-ZZ-2 | r | c | ⬜ open | — | — |",
      "",
      "prose between two tables",
      "| X-ZZ-3 | r | c | ⬜ open | — | — |",
    ].join("\n");
    const rows = parseRuleRows(text, "synthetic.md");
    expect(rows.map((r) => r.id)).toEqual(["X-ZZ-1", "X-ZZ-2"]);
    expect(rows[0]).toMatchObject({ enforcedAt: ["a/one.ts", "b/two.ts"], provedBy: ["c/three.test.ts"], file: "synthetic.md" });
    expect(rows[1]).toMatchObject({ enforcedAt: [], provedBy: [] });
  });

  it("a matrix: entry is a case id, not a test path: it is skipped beside a real proving test (synthetic signed row)", () => {
    const row: RuleRow = { id: "X-ZZ-1", rule: "r", citation: "c", status: "signed 1 2026-10-08", enforcedAt: [], provedBy: ["packages/engine/test/rules-reference.test.ts", "matrix:SC-O1"], file: "synthetic.md" };
    expect(proofProblems(row)).toEqual([]);
    expect(isMatrixCase("matrix:SC-O1")).toBe(true);
    expect(isMatrixCase("packages/engine/test/rules-reference.test.ts")).toBe(false); // the negative pair
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
