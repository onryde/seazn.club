// W1d Task 18 (ruling 63, D18, D22): the audit reader and the audit ledger.
//
// readAuditGaps reads every gap row of the five audit files (SW, FX, ST, SC, SH) so the ledger can give each one
// exactly one of five outcomes (D22): reproduced (triage), or exercised-not-reproduced, not-exercised, verified-by-read,
// verified-by-failing-test (a verdict file). Three kinds of test:
//   - the REAL audit directory, against counts read by hand from each file's own tally (never from the parser);
//   - synthetic audit directories, one defect each, so every refusal is reached;
//   - the ledger over a real triage.json written by the real triage CLI over real committed results (class 1: a
//     fixture on both ends proves the fixture).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../audit-ledger.ts";
import {
  AuditParse, LedgerRefused, OUTCOMES, VERDICT_OUTCOMES, buildLedger, failsTitles, findingLine, parseVerdicts, readAudit, readAuditGaps, renderLedger, testCalls,
  type AuditGap, type Verdict,
} from "../lib/audit-ledger.ts";
import { LAYERS } from "../lib/results.ts";
import { parseRouting, parseTriage, type GapRouting, type TriageJson } from "../lib/triage.ts";
import { main as triageMain } from "../triage.ts";
import { REPO, TRUTH_RUNS } from "./committed-plans.ts";
import { SPAWN_MS, spawnBudget } from "./spawn-budget.ts";

const AUDIT_DIR = resolve(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/audit-2026-09-27");
const PACKAGE_SCRIPTS = (JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

const scratch = mkdtempSync(join(tmpdir(), "w1d-t18-ledger-"));
// Every test dir lives under this one, so one removal leaves nothing in the temp dir (a leak of ~700 KB per run otherwise).
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });
let n = 0;
const fresh = (): string => { const d = join(scratch, `d${++n}`); mkdirSync(d, { recursive: true }); return d; };
/** A directory of files: { "SW-swiss.md": text }. */
const auditDir = (files: Record<string, string>): string => {
  const d = fresh();
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
  return d;
};
const put = (name: string, body: unknown): string => { const p = join(fresh(), name); writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body)); return p; };

/** A gaps table the way the audit files write one. */
const table = (rows: readonly string[], header = "| ID | Gap | Evidence | Sev |"): string => [header, "|---|---|---|---|", ...rows].join("\n");
const row = (id: string, gap = "A gap", sev = "Med"): string => `| ${id} | ${gap} | file.ts:1 | ${sev} |`;

// --- the real audit directory ---------------------------------------------------------------------------------

/** Read by hand, file by file, from each file's own tally line (SW "Counts … (29 total)", FX "Total 24", ST "Total 33",
 *  SH "(20 total)") and, for SC, its own severity tally ("5 H / 17 M / 22 L (44)"). Never from the parser. */
const STEP0_COUNTS = { SW: 29, FX: 24, ST: 33, SC: 44, SH: 20 } as const;

describe("readAuditGaps — the real audit files", () => {
  // Read in beforeAll, not at collection: a reader that breaks on the real files must fail THESE tests by name, not the whole file.
  let gaps: AuditGap[] = [];
  beforeAll(() => { gaps = readAuditGaps(AUDIT_DIR); });
  const by = (p: string): AuditGap[] => gaps.filter((g) => g.id.startsWith(`${p}-`));

  it("reads every gap row of the five audit files, prefixed by file, none twice", () => {
    const counts: Record<string, number> = {};
    for (const g of gaps) counts[g.id.split("-")[0]!] = (counts[g.id.split("-")[0]!] ?? 0) + 1;
    expect(counts).toEqual(STEP0_COUNTS);
    expect(new Set(gaps.map((g) => g.id)).size).toBe(gaps.length);
    expect(gaps.length).toBeGreaterThanOrEqual(150);
    expect(gaps).toHaveLength(150);
    for (const g of gaps) expect(g.id, g.id).toMatch(/^(?:SW|FX|ST|SC|SH)-[A-Z]+\d+$/);
  });

  it("the prefix comes from the file name, and each gap carries its file", () => {
    const files = new Map(Object.entries({ SW: "SW-swiss.md", FX: "FX-fixtures.md", ST: "ST-standings.md", SC: "SC-scoring.md", SH: "SH-sheets.md" }));
    let checked = 0;
    for (const g of gaps) { expect(g.file, g.id).toBe(files.get(g.id.split("-")[0]!)); checked++; }
    expect(checked).toBe(150);
  });

  it("an independent oracle agrees: every table row whose first cell is an id, per file, is a gap or an umbrella (46 SC rows = 44 + 2)", () => {
    const { gaps: g2, umbrellas } = readAudit(AUDIT_DIR);
    expect(g2).toEqual(gaps);
    const rowsIn = (file: string): number => readFileSync(join(AUDIT_DIR, file), "utf8").split("\n").filter((l) => /^\| [A-Z]+\d+(?: \((?:=[^)]*|new)\))?\s*\|/.test(l)).length;
    // spec-review.md and the plan-facts files hold other tables with an ID column: they are no audit file and are not read.
    expect(rowsIn("SW-swiss.md")).toBe(29);
    expect(rowsIn("FX-fixtures.md")).toBe(24);
    expect(rowsIn("ST-standings.md")).toBe(33);
    expect(rowsIn("SC-scoring.md")).toBe(46);
    expect(rowsIn("SH-sheets.md")).toBe(20);
    expect(umbrellas.map((u) => u.id)).toEqual(["SC-X1", "SC-X2"]);
    expect(by("SC").length + umbrellas.length).toBe(rowsIn("SC-scoring.md"));
  });

  it("SC's two extra rows are umbrellas: X1 and X2 alias rows the file counts elsewhere (read: its tally says 'X1 and X2 are umbrellas over H rows already counted')", () => {
    const { umbrellas } = readAudit(AUDIT_DIR);
    expect(umbrellas.map((u) => [u.id, u.members])).toEqual([
      ["SC-X1", ["SC-C1", "SC-O5", "SC-P9", "SC-O1"]],
      ["SC-X2", ["SC-P1", "SC-C2", "SC-O4"]],
    ]);
    // Not counted, so not owed an outcome of their own — but their members are, and X3, X4 ("new") are ids in their own right.
    const sc = new Set(by("SC").map((g) => g.id));
    expect(sc.has("SC-X1")).toBe(false);
    expect(sc.has("SC-X2")).toBe(false);
    expect(sc.has("SC-X3") && sc.has("SC-X4")).toBe(true);
    for (const u of umbrellas) for (const m of u.members) expect(sc.has(m), `${u.id} aliases ${m}`).toBe(true);
    // The per-sport rows: S 9, P 13, C 8, O 12 (read from the four Gaps tables), plus X3 and X4.
    const letters: Record<string, number> = {};
    for (const id of sc) letters[id.slice(3, 4)] = (letters[id.slice(3, 4)] ?? 0) + 1;
    expect(letters).toEqual({ S: 9, P: 13, C: 8, O: 12, X: 2 });
  });

  it("spot rows, read by hand: id, severity cell and title", () => {
    const g = (id: string): AuditGap | undefined => gaps.find((x) => x.id === id);
    expect(g("SW-H1")).toMatchObject({ file: "SW-swiss.md", severity: "High", title: "Pairing can dead-end, and Pair next then reports success." });
    expect(g("SW-M13")).toMatchObject({ severity: "Med", title: "A bye shell can be scheduled onto a court." });
    expect(g("SW-L12")?.severity).toBe("Low");
    expect(g("FX-G1")).toMatchObject({ severity: "H" });
    expect(g("FX-G1")?.title.startsWith("Generate after roster growth reconciles by POSITION key")).toBe(true);
    expect(g("FX-G24")?.severity).toBe("L");
    expect(g("ST-G1")?.severity).toBe("H");
    expect(g("ST-G33")?.severity).toBe("L");
    expect(g("SC-S1")?.severity).toBe("M");
    expect(g("SC-O12")?.severity).toBe("L");
    expect(g("SC-X3")?.severity).toBe("M");
    expect(g("SH-G1")).toMatchObject({ severity: "H", title: "#885/#886 (print one division, date range, group by division) have no UI, and the route is session-only." });
    expect(g("SH-G20")?.severity).toBe("L");
  });

  it("a title is one line, never empty, never markdown-bold, and short enough for a table cell", () => {
    let checked = 0;
    for (const g of gaps) {
      expect(g.title.length, g.id).toBeGreaterThan(0);
      expect(g.title.length, g.id).toBeLessThanOrEqual(141);
      expect(g.title, g.id).not.toMatch(/\n|\*\*/);
      expect(g.severity.length, g.id).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBe(150);
  });
});

// --- the reader's refusals, one synthetic directory each -----------------------------------------------------------

describe("readAuditGaps — refusals and shapes (synthetic directories)", () => {
  const one = (text: string, name = "SW-swiss.md"): string => auditDir({ [name]: text });

  it("the empty directory is refused (vacuous): zero gaps", () => {
    expect(() => readAuditGaps(auditDir({}))).toThrow(AuditParse);
    expect(() => readAuditGaps(auditDir({}))).toThrow(/zero gaps/);
  });

  it("a directory that cannot be read is an AuditParse naming it, not a bare ENOENT", () => {
    expect(() => readAuditGaps(join(scratch, "no-such-dir"))).toThrow(AuditParse);
    expect(() => readAuditGaps(join(scratch, "no-such-dir"))).toThrow(/cannot read/);
  });

  it("only <PREFIX>-*.md files are audit files: other files, even with gap tables, are never read", () => {
    const text = `## Gaps\n\n${table([row("H1")])}\n`;
    const d = auditDir({ "SW-swiss.md": text, "spec-review.md": text, "bench-reuse.md": text, "notes.txt": text, "S-short.md": text, "sw-lower.md": text });
    expect(readAuditGaps(d).map((g) => g.id)).toEqual(["SW-H1"]);
  });

  it("a row without an id is an AuditParse naming the file and line", () => {
    const text = `## Gaps\n\n${table([row("H1"), "|  | a gap with no id | f.ts:1 | Low |"])}\n`;
    expect(() => readAuditGaps(one(text))).toThrow(AuditParse);
    expect(() => readAuditGaps(one(text))).toThrow(/SW-swiss\.md:6: .*no id/);
  });

  it("a duplicate id is an AuditParse naming both rows, within a file and across two tables of one file", () => {
    const text = `## Gaps\n\n${table([row("H1"), row("H2"), row("H1")])}\n`;
    expect(() => readAuditGaps(one(text))).toThrow(/duplicate id SW-H1/);
    const two = `## Gaps\n\n${table([row("H1")])}\n\n## (2) Gaps\n\n${table([row("H1")])}\n`;
    expect(() => readAuditGaps(one(two))).toThrow(/duplicate id SW-H1/);
  });

  it("a gap table whose header has no |---| row under it is refused (a misread header would hide every row)", () => {
    expect(() => readAuditGaps(one(`## Gaps\n\n| ID | Gap | Evidence | Sev |\n${row("H1")}\n`))).toThrow(/separator row/);
  });

  it("a level-1 heading is the file's title and never opens a gap section, even one named Gaps", () => {
    expect(() => readAuditGaps(one(`# Gaps\n\n${table([row("H1")])}\n`))).toThrow(/no gap row/);
    expect(readAuditGaps(one(`# Gaps\n\n${table([row("Z9")])}\n\n## Gaps\n\n${table([row("H1")])}\n`)).map((g) => g.id)).toEqual(["SW-H1"]);
  });

  it("an id cell that is not an id is refused (a hyphen, a word, a number)", () => {
    for (const bad of ["-", "gap one", "12", "h1", "H"]) {
      expect(() => readAuditGaps(one(`## Gaps\n\n${table([row(bad)])}\n`)), bad).toThrow(/not an id/);
    }
  });

  it("every heading spelling the five files use opens a gap section: Gaps, Gap table, '2. Gap table', '(2) Gaps', Cross-cutting gaps", () => {
    for (const heading of ["## Gaps", "## Gap table", "## 2. Gap table", "## (2) Gaps", "## Cross-cutting gaps (umbrella rows)", "### Gaps"]) {
      expect(readAuditGaps(one(`${heading}\n\n${table([row("H1")])}\n`)).map((g) => g.id), heading).toEqual(["SW-H1"]);
    }
  });

  it("a table outside a gap section is never read, even with an ID column; the section ends at the next heading of its level", () => {
    const text = [`## Matrix`, "", table([row("Z9")]), "", "## Gaps", "", table([row("H1")]), "", "### Sub-heading stays in the section", "", table([row("H2")]), "", "## Counts", "", table([row("Z8")]), ""].join("\n");
    expect(readAuditGaps(one(text)).map((g) => g.id)).toEqual(["SW-H1", "SW-H2"]);
  });

  it("a heading on the line right after a table closes the section: the table's last line is not the heading's (the loop steps back one)", () => {
    // No blank line between the table and `## Counts`: that heading is the very line that ended the table, and it must be
    // read as a heading, or the section stays open and the ID table below it is read as gaps.
    const text = ["## Gaps", "", table([row("H1")]), "## Counts", "", table([row("Z9", "not a gap")]), ""].join("\n");
    expect(readAuditGaps(one(text)).map((g) => g.id)).toEqual(["SW-H1"]);
  });

  it("two tables in one gap section are both read, in file order, and files are read in name order", () => {
    const sw = `## Gaps\n\n${table([row("H2")])}\n\n${table([row("H1")])}\n`;
    const fx = `## Gap table\n\n${table([row("G1")])}\n`;
    expect(readAuditGaps(auditDir({ "SW-swiss.md": sw, "FX-fixtures.md": fx })).map((g) => g.id)).toEqual(["FX-G1", "SW-H2", "SW-H1"]);
  });

  it("an escaped pipe stays inside its cell; an unescaped one makes the row's cell count differ from the header's, which is refused", () => {
    const ok = `## Gaps\n\n${table(["| H1 | a \\| b | f.ts:1 | High |"])}\n`;
    expect(readAuditGaps(one(ok))[0]).toMatchObject({ id: "SW-H1", severity: "High", title: "a | b" });
    const bad = `## Gaps\n\n${table(["| H1 | a | b | f.ts:1 | High |"])}\n`;
    expect(() => readAuditGaps(one(bad))).toThrow(/5 cells, the header has 4/);
  });

  it("a gap table without an ID, a Gap or a Sev column is refused rather than skipped (it would hide gaps)", () => {
    for (const header of ["| Name | Gap | Evidence | Sev |", "| ID | Text | Evidence | Sev |", "| ID | Gap | Evidence | Impact |"]) {
      expect(() => readAuditGaps(one(`## Gaps\n\n${table([row("H1")], header)}\n`)), header).toThrow(AuditParse);
    }
  });

  it("an audit file with no gap row is refused: a misparse reads as zero, not as clean", () => {
    expect(() => readAuditGaps(auditDir({ "SW-swiss.md": `## Gaps\n\nnothing here\n`, "FX-fixtures.md": `## Gap table\n\n${table([row("G1")])}\n` }))).toThrow(/SW-swiss\.md: no gap row/);
  });

  it("the title is the bold lead when the cell has one, else the cell cut at 140 characters on a word", () => {
    const long = `${"word ".repeat(40)}end`;
    const text = `## Gaps\n\n${table([row("H1", "**Bold lead.** and the rest of the cell"), row("H2", long), row("H3", "short and plain")])}\n`;
    const g = readAuditGaps(one(text));
    expect(g[0]!.title).toBe("Bold lead.");
    expect(g[1]!.title.length).toBeLessThanOrEqual(141);
    expect(g[1]!.title.endsWith("…")).toBe(true);
    expect(g[1]!.title.startsWith("word word")).toBe(true);
    expect(g[2]!.title).toBe("short and plain");
  });

  it("an umbrella (`X1 (=A1+B1)`) is no gap id but names its members; '(new)' is an ordinary id; an alias to no row, or any other note, is refused", () => {
    const text = `## Gaps\n\n${table([row("A1"), row("B1"), row("X1 (=A1+B1)"), row("X2 (new)")])}\n`;
    const r = readAudit(one(text, "SC-scoring.md"));
    expect(r.gaps.map((g) => g.id)).toEqual(["SC-A1", "SC-B1", "SC-X2"]);
    expect(r.umbrellas).toMatchObject([{ id: "SC-X1", members: ["SC-A1", "SC-B1"], severity: "Med" }]);
    expect(() => readAudit(one(`## Gaps\n\n${table([row("A1"), row("X1 (=A1+Q9)")])}\n`, "SC-scoring.md"))).toThrow(/aliases SC-Q9, which is no row/);
    expect(() => readAudit(one(`## Gaps\n\n${table([row("A1"), row("X1 (see A1)")])}\n`, "SC-scoring.md"))).toThrow(/not an id/);
  });
});

// --- the verdicts file ---------------------------------------------------------------------------------------------

const v = (over: Record<string, unknown>): Record<string, unknown> => ({ id: "SW-H2", outcome: "not-exercised", evidence: "no driven case reaches the round-count guidance (atom R7)", wave: "W3", ...over });

describe("parseVerdicts (D22)", () => {
  it("the four verdict outcomes plus 'reproduced' are the five of D22, and reproduced is never a verdict", () => {
    expect(OUTCOMES).toEqual(["reproduced", "exercised-not-reproduced", "not-exercised", "verified-by-read", "verified-by-failing-test"]);
    expect(VERDICT_OUTCOMES).toEqual(["exercised-not-reproduced", "not-exercised", "verified-by-read", "verified-by-failing-test"]);
    expect(() => parseVerdicts({ verdicts: [v({ outcome: "reproduced" })] })).toThrow();
  });

  it("accepts one verdict of each outcome with its own required fields, and the empty list", () => {
    const list = [
      v({}),
      v({ id: "SW-H3", outcome: "exercised-not-reproduced", cases: ["swiss|chess|default|M1"], evidence: "the case drove it and passed" }),
      v({ id: "SW-H4", outcome: "verified-by-read", evidence: "packages/engine/src/core/x.ts:10 shows the cascade" }),
      v({ id: "SW-M1", outcome: "verified-by-failing-test", test: { file: "packages/engine/test/audit-witnesses.test.ts", title: "SW-M1: buchholz counts a round-1 bye last" } }),
    ];
    expect(parseVerdicts({ verdicts: list }).verdicts).toHaveLength(4);
    expect(parseVerdicts({ verdicts: [] }).verdicts).toEqual([]);
  });

  it("refuses each malformed verdict on its own field", () => {
    const bad: [string, Record<string, unknown>][] = [
      ["unknown outcome", v({ outcome: "probably-fine" })],
      ["empty evidence", v({ evidence: "" })],
      ["a wave that is not a wave", v({ wave: "later" })],
      ["an id that is not an audit id", v({ id: "NEW-W1d-1" })],
      ["exercised-not-reproduced with no cases", v({ outcome: "exercised-not-reproduced" })],
      ["exercised-not-reproduced with an empty case list", v({ outcome: "exercised-not-reproduced", cases: [] })],
      ["exercised-not-reproduced citing a case twice", v({ outcome: "exercised-not-reproduced", cases: ["a|b|c|M1", "a|b|c|M1"] })],
      ["cases on a not-exercised verdict", v({ cases: ["a|b|c|M1"] })],
      ["verified-by-read with no file:line", v({ outcome: "verified-by-read", evidence: "it is obviously fine" })],
      ["verified-by-failing-test with no test", v({ outcome: "verified-by-failing-test" })],
      ["a test on a verified-by-read verdict", v({ outcome: "verified-by-read", evidence: "a.ts:1 shows", test: { file: "a.ts", title: "SW-H2" } })],
      ["a test file outside the repo", v({ outcome: "verified-by-failing-test", test: { file: "../x.test.ts", title: "SW-H2 x" } })],
      ["an absolute test file", v({ outcome: "verified-by-failing-test", test: { file: "/etc/x.test.ts", title: "SW-H2 x" } })],
      ["an unknown key", v({ extra: 1 })],
    ];
    let refused = 0;
    for (const [what, verdict] of bad) {
      expect(() => parseVerdicts({ verdicts: [verdict] }), what).toThrow();
      refused++;
    }
    expect(refused).toBe(bad.length);
  });
});

// --- failsTitles: the witness a verified-by-failing-test verdict names -----------------------------------------------

describe("failsTitles", () => {
  it("reads the title of every it.fails / test.fails call, in each quote style and across lines, and no other test", () => {
    const src = [
      `it("SW-H1: a plain test, not a witness", () => {});`,
      `it.fails("SW-H2: double quoted", () => {});`,
      `test.fails('SW-H3: single quoted', () => {});`,
      "it.fails(`SW-H4: backticked`, () => {});",
      `it.fails(\n  "SW-H5: on the next line",\n  () => {},\n);`,
      `it.skip("SW-H6: skipped", () => {});`,
      `// it.fails("SW-H7: in a comment", () => {});`,
      `const s = 'it.fails("SW-H8: in a string", () => {})';`,
    ].join("\n");
    // A comment is no test: a commented-out witness must not satisfy a verified-by-failing-test verdict.
    expect(failsTitles(src)).toEqual(["SW-H2: double quoted", "SW-H3: single quoted", "SW-H4: backticked", "SW-H5: on the next line"]);
    expect(failsTitles("")).toEqual([]);
    expect(failsTitles(`it("x", () => {})`)).toEqual([]);
  });
});

// --- buildLedger: exactly one outcome per id -------------------------------------------------------------------------

const G = (id: string, severity = "Med"): AuditGap => ({ id, file: `${id.slice(0, 2)}-x.md`, title: `title of ${id}`, severity });
const GAPS = [G("SW-H1"), G("SW-H2"), G("FX-G1"), G("SC-O1"), G("ST-G3"), G("SH-G1")];
const ROUTING: GapRouting = parseRouting({ note: "test", routes: { "SW-*": "W3", "FX-G1": "W5", "SC-O1": "W2", "SC-C1": "W2", "SC-O5": "W2", "ST-G3": "W5", "SH-*": "W8" } });
const WITNESS = "packages/engine/test/audit-witnesses.test.ts";
const WITNESS_SRC = `it.fails("ST-G3: tiebreak validation never rejects an unknown key", () => {});\nit("SH-G1: not a failing test", () => {});\n`;
const readFile = (p: string): string | null => (p === WITNESS ? WITNESS_SRC : null);

/** The runs a baseline triage reads: one per layer (D19: L1, L2, L3), each with its run id. */
const RUNS: TriageJson["runs"] = [
  { layer: "L1", runId: "run-l1-a1", plan: null, cases: 1, reds: 0 },
  { layer: "L2", runId: "run-l2-b2", plan: null, cases: 1, reds: 0 },
  { layer: "L3", runId: "run-l3-c3", plan: "--set w1-driving", cases: 2, reds: 2 },
];
/** A triage.json as the CLI writes it: SW-H1 reproduced by two cases, one works case to cite. */
const triageJson = (over: Partial<TriageJson> = {}): TriageJson => parseTriage({
  version: 1, runs: RUNS, scanned: 4, checked: 2,
  rows: [{ caseId: "swiss|chess|default|M1", layer: "L3", gap: "SW-H1", wave: "W3", rule: "T-1" }, { caseId: "swiss|chess|default|R4", layer: "L3", gap: "SW-H1", wave: "W3", rule: "T-1" }],
  untriaged: [], ambiguous: [], misrouted: [], unknownGap: [],
  works: ["league|generic|default|M1", "knockout|generic|default|F1"],
  gaps: [{ gap: "SW-H1", wave: "W3", title: "title of SW-H1", layers: ["L3"], caseIds: ["swiss|chess|default|M1", "swiss|chess|default|R4"] }],
  ...over,
});
const verdicts = (list: Record<string, unknown>[]): Verdict[] => parseVerdicts({ verdicts: list }).verdicts;
const FULL = verdicts([
  v({ id: "SW-H2" }),
  v({ id: "FX-G1", outcome: "exercised-not-reproduced", wave: "W5", cases: ["league|generic|default|M1"], evidence: "league M1 drove the generate and passed" }),
  v({ id: "SC-O1", outcome: "verified-by-read", wave: "W2", evidence: "packages/engine/src/sport/generic.ts:650 excludes only three kinds" }),
  v({ id: "ST-G3", outcome: "verified-by-failing-test", wave: "W5", test: { file: WITNESS, title: "ST-G3: tiebreak validation never rejects an unknown key" } }),
  v({ id: "SH-G1", wave: "W8" }),
]);
const input = (over: Partial<Parameters<typeof buildLedger>[0]> = {}): Parameters<typeof buildLedger>[0] => ({ gaps: GAPS, umbrellas: [], routing: ROUTING, triage: triageJson(), verdicts: FULL, readFile, ...over });

describe("buildLedger (D22): each id gets exactly one outcome", () => {
  it("the whole ledger: one outcome per id, each from its own source, counted", () => {
    const l = buildLedger(input());
    expect(l.findings).toEqual([]);
    expect(l.entries.map((e) => [e.id, e.outcome, e.wave])).toEqual([
      ["SW-H1", "reproduced", "W3"], ["SW-H2", "not-exercised", "W3"], ["FX-G1", "exercised-not-reproduced", "W5"],
      ["SC-O1", "verified-by-read", "W2"], ["ST-G3", "verified-by-failing-test", "W5"], ["SH-G1", "not-exercised", "W8"],
    ]);
    expect(l.counts).toEqual({ reproduced: 1, "exercised-not-reproduced": 1, "not-exercised": 2, "verified-by-read": 1, "verified-by-failing-test": 1 });
    expect(Object.values(l.counts).reduce((a, b) => a + b, 0)).toBe(GAPS.length);
    expect(l.entries[0]!.cases).toEqual(["swiss|chess|default|M1", "swiss|chess|default|R4"]);
  });

  it("an id with no outcome is a finding naming it", () => {
    const l = buildLedger(input({ verdicts: FULL.filter((x) => x.id !== "SH-G1") }));
    expect(l.findings).toEqual([{ kind: "no-outcome", id: "SH-G1" }]);
    expect(l.entries.find((e) => e.id === "SH-G1")?.outcome).toBeNull();
    expect(l.counts["not-exercised"]).toBe(1);
  });

  it("an id with two outcomes is a finding naming both: reproduced by triage and given a verdict, or two verdicts", () => {
    const both = buildLedger(input({ verdicts: [...FULL, ...verdicts([v({ id: "SW-H1", outcome: "not-exercised" })])] }));
    expect(both.findings).toEqual([{ kind: "two-outcomes", id: "SW-H1", outcomes: ["reproduced", "not-exercised"] }]);
    const twice = buildLedger(input({ verdicts: [...FULL, ...verdicts([v({ id: "SW-H2", outcome: "verified-by-read", evidence: "a.ts:1 shows it" })])] }));
    expect(twice.findings).toEqual([{ kind: "two-outcomes", id: "SW-H2", outcomes: ["not-exercised", "verified-by-read"] }]);
    // Counted nowhere: an id with two outcomes has none yet.
    expect(Object.values(twice.counts).reduce((a, b) => a + b, 0)).toBe(GAPS.length - 1);
  });

  it("a verdict naming no ledger id is a finding — a typo would otherwise verdict nothing (an umbrella says its members)", () => {
    const typo = buildLedger(input({ verdicts: [...FULL, ...verdicts([v({ id: "SW-H99" })])] }));
    expect(typo.findings).toEqual([{ kind: "unknown-verdict-id", id: "SW-H99" }]);
    const umbrella = buildLedger(input({
      gaps: [...GAPS, G("SC-C1"), G("SC-O5")], umbrellas: [{ ...G("SC-X1"), members: ["SC-C1", "SC-O5"] }],
      verdicts: [...FULL, ...verdicts([v({ id: "SC-C1", wave: "W2" }), v({ id: "SC-O5", wave: "W2" }), v({ id: "SC-X1", wave: "W2" })])],
    }));
    expect(umbrella.findings).toEqual([{ kind: "unknown-verdict-id", id: "SC-X1", umbrellaOf: ["SC-C1", "SC-O5"] }]);
  });

  it("a verdict's wave is the routing's: a different wave, or no route at all, is a finding", () => {
    const moved = buildLedger(input({ verdicts: FULL.map((x) => (x.id === "SW-H2" ? { ...x, wave: "W4" } : x)) }));
    expect(moved.findings).toEqual([{ kind: "wave-mismatch", id: "SW-H2", wave: "W4", routed: "W3" }]);
    const unrouted = buildLedger(input({ routing: parseRouting({ note: "t", routes: { "SW-*": "W3" } }) }));
    expect(unrouted.findings.filter((f) => f.kind === "wave-mismatch").map((f) => [f.id, f.routed])).toEqual([["FX-G1", null], ["SC-O1", null], ["ST-G3", null], ["SH-G1", null]]);
  });

  it("exercised-not-reproduced must cite cases the triaged runs hold as works: a red case, an absent case and a typo are findings", () => {
    const mk = (cases: string[]): Verdict[] => FULL.map((x) => (x.id === "FX-G1" ? { ...x, cases } : x));
    expect(buildLedger(input({ verdicts: mk(["league|generic|default|M1", "knockout|generic|default|F1"]) })).findings).toEqual([]);
    expect(buildLedger(input({ verdicts: mk(["swiss|chess|default|M1"]) })).findings).toEqual([{ kind: "case-not-works", id: "FX-G1", caseId: "swiss|chess|default|M1" }]);
    expect(buildLedger(input({ verdicts: mk(["league|generic|default|M1", "league|generic|default|M2"]) })).findings).toEqual([{ kind: "case-not-works", id: "FX-G1", caseId: "league|generic|default|M2" }]);
  });

  it("verified-by-failing-test: the named file must hold an it.fails whose title is the verdict's and carries the audit id", () => {
    const mk = (test: { file: string; title: string }): Verdict[] => FULL.map((x) => (x.id === "ST-G3" ? { ...x, test } : x));
    const t = "ST-G3: tiebreak validation never rejects an unknown key";
    expect(buildLedger(input({ verdicts: mk({ file: WITNESS, title: t }) })).findings).toEqual([]);
    const reason = (test: { file: string; title: string }, readF = readFile) => buildLedger(input({ verdicts: mk(test), readFile: readF })).findings.map((f) => (f.kind === "test-not-found" ? f.reason : f.kind));
    expect(reason({ file: "packages/engine/test/missing.test.ts", title: t })).toEqual(["file-missing"]);
    expect(reason({ file: WITNESS, title: "ST-G3: a title the file does not hold" })).toEqual(["title-missing"]);
    // The title IS in the file, but on a plain test: a passing test is no witness that flips when the gap is fixed.
    expect(reason({ file: WITNESS, title: "SH-G1: not a failing test" })).toEqual(["id-not-in-title", "not-a-fails-test"]);
    expect(reason({ file: WITNESS, title: "tiebreak validation never rejects an unknown key" })).toEqual(["id-not-in-title", "title-missing"]);
    expect(reason({ file: WITNESS, title: t }, (p) => (p === WITNESS ? `it("${t}", () => {});` : null))).toEqual(["not-a-fails-test"]);
    // It goes OUTSIDE packages/engine/src (this wave does not touch it).
    expect(reason({ file: "packages/engine/src/x.test.ts", title: t }, () => `it.fails("${t}", () => {});`)).toEqual(["engine-src"]);
  });

  it("the failing test's title carries the audit id as a whole token: SW-H1 is not in 'SW-H10: …'", () => {
    const src = (title: string): string => `it.fails("${title}", () => {});`;
    const at = (id: string, title: string): string[] => buildLedger(input({
      gaps: [...GAPS, G("SW-H10")], verdicts: [...FULL.filter((x) => x.id !== "SW-H2"), ...verdicts([v({ id, outcome: "verified-by-failing-test", test: { file: WITNESS, title } }), v({ id: id === "SW-H1" ? "SW-H10" : "SW-H1", wave: "W3" })])],
      triage: triageJson({ rows: [], gaps: [] }), readFile: (p) => (p === WITNESS ? `${src(title)}\n${WITNESS_SRC}` : null),
    })).findings.flatMap((f) => (f.kind === "test-not-found" ? [f.reason] : []));
    expect(at("SW-H1", "SW-H10: buchholz")).toEqual(["id-not-in-title"]);
    expect(at("SW-H1", "SW-H1: buchholz")).toEqual([]);
    expect(at("SW-H1", "see SW-H1, buchholz")).toEqual([]);
    expect(at("SW-H1", "XSW-H1: buchholz")).toEqual(["id-not-in-title"]);
    expect(at("SW-H1", "SW-H1")).toEqual([]);
  });

  it("a triage row for an id the audit does not hold is a finding (a triage run against another audit); a NEW- gap is no audit id and is never one", () => {
    const rows = (gap: string) => [{ caseId: "a|b|c|M1", layer: "L3" as const, gap, wave: "W3", rule: "T-1" }];
    const f = (gap: string) => buildLedger(input({ triage: triageJson({ rows: rows(gap), gaps: [] }), verdicts: [...FULL, ...verdicts([v({ id: "SW-H1" })])] })).findings;
    expect(f("SW-H77")).toEqual([{ kind: "unknown-triage-gap", id: "SW-H77" }]);
    expect(f("NEW-W1d-3")).toEqual([]);
  });

  it("an empty ledger is refused: zero ids is vacuous, never clean", () => {
    expect(() => buildLedger(input({ gaps: [] }))).toThrow(LedgerRefused);
    expect(() => buildLedger(input({ gaps: [] }))).toThrow(/zero ids/);
  });

  it("a triage that is not clean is refused: an untriaged red might be the very gap a verdict calls not-exercised", () => {
    for (const dirty of [{ untriaged: ["a|b|c|M1"] }, { ambiguous: [{ caseId: "a|b|c|M1", rules: ["T-1", "T-2"] }] }, { misrouted: [{ rule: "T-1", gap: "SC-O1", wave: "W4", routed: "W2" }] }, { unknownGap: [{ rule: "T-1", gap: "SC-Z9" }] }]) {
      expect(() => buildLedger(input({ triage: triageJson(dirty) })), JSON.stringify(dirty)).toThrow(/not clean/);
    }
  });

  /** The refusal a ledger build throws, or a failure when it builds. */
  const refusal = (over: Partial<TriageJson>): LedgerRefused => {
    try {
      buildLedger(input({ triage: triageJson(over) }));
    } catch (e) {
      expect(e).toBeInstanceOf(LedgerRefused);
      return e as LedgerRefused;
    }
    throw new Error(`the ledger built over ${JSON.stringify(Object.keys(over))}: it should have refused`);
  };

  it("a triage that read nothing is refused, each way by its own name: no run, no case, or a layer of the baseline missing (I1)", () => {
    // D19's baseline is three layers; the declaration the ledger reads is pinned here so a fourth layer is a decision.
    expect([...LAYERS]).toEqual(["L1", "L2", "L3"]);
    const without = (layer: string): TriageJson["runs"] => RUNS.filter((r) => r.layer !== layer);
    const emptied = (...layers: string[]): TriageJson["runs"] => RUNS.map((r) => (layers.includes(r.layer) ? { ...r, cases: 0, reds: 0 } : r));
    const nothing = { scanned: 0, checked: 0, runs: RUNS.map((r) => ({ ...r, cases: 0, reds: 0 })), rows: [], gaps: [], works: [] };
    const cases: [string, Partial<TriageJson>, string, RegExp][] = [
      ["no run at all", { runs: [] }, "TriageNoRuns", /names no run/],
      ["no run and no case (a file that read nothing)", { runs: [], scanned: 0, checked: 0, rows: [], gaps: [], works: [] }, "TriageNoRuns", /names no run/],
      ["runs that hold no case", nothing, "TriageNoCases", /read no case/],
      ["L1 missing", { runs: without("L1") }, "TriageLayerMissing", /layer L1\b/],
      ["L2 missing", { runs: without("L2") }, "TriageLayerMissing", /layer L2\b/],
      ["L3 missing", { runs: without("L3") }, "TriageLayerMissing", /layer L3\b/],
      ["only L3 (a one-layer triage)", { runs: without("L1").filter((r) => r.layer !== "L2") }, "TriageLayerMissing", /layers L1, L2\b/],
      // N1: `scanned` is the file's own number and may be non-zero while a layer's run read nothing.
      ["L1 run holds no case (N1)", { runs: emptied("L1") }, "TriageLayerEmpty", /layer L1\b/],
      ["L2 run holds no case (N1)", { runs: emptied("L2") }, "TriageLayerEmpty", /layer L2\b/],
      ["L3 run holds no case (N1)", { runs: emptied("L3") }, "TriageLayerEmpty", /layer L3\b/],
      ["two runs hold no case (N1)", { runs: emptied("L1", "L3") }, "TriageLayerEmpty", /layers L1, L3\b/],
    ];
    let refused = 0;
    for (const [what, over, name, message] of cases) {
      const e = refusal(over);
      expect(e.name, what).toBe(name);
      expect(e.message, what).toMatch(message);
      refused++;
    }
    expect(refused).toBe(cases.length);
    // …and the same ledger over the full baseline builds: the refusals are the triage's, not the fixture's.
    expect(buildLedger(input()).findings).toEqual([]);
  });

  it("a layer is present only when a run of it holds a case: one case is enough, none is a refusal of its own name (N1)", () => {
    // Before N1 this test said the opposite: a triage whose three runs all read nothing built a clean ledger as long as the
    // file's own `scanned` was not 0 — every id a layer could have reproduced then read not-exercised.
    expect(() => buildLedger(input({ triage: triageJson({ runs: RUNS.map((r) => ({ ...r, cases: 0, reds: 0 })) }) }))).toThrow(/layers L1, L2, L3\b/);
    let built = 0;
    for (const layer of ["L1", "L2", "L3"]) {
      const one = RUNS.map((r) => (r.layer === layer ? { ...r, cases: 1 } : { ...r, cases: 0, reds: 0 }));
      // a layer holds one case and its neighbours none: the neighbours are what is refused, never the layer with the case
      expect(() => buildLedger(input({ triage: triageJson({ runs: one }) })), layer).toThrow(new RegExp(`layers? ${["L1", "L2", "L3"].filter((l) => l !== layer).join(", ")}\\b`));
      built++;
    }
    expect(built).toBe(3);
    expect(buildLedger(input({ triage: triageJson({ runs: RUNS.map((r) => ({ ...r, cases: 1 })) }) })).findings).toEqual([]);
  });

  it("the ledger names the runs it was built from, each with its layer, id, plan and counts, in the data and on the page (D19: every claim traceable to a run id)", () => {
    const l = buildLedger(input());
    expect(l.runs).toEqual(RUNS);
    const md = renderLedger(l, { audit: GAPS.length, files: 5, umbrellas: 0, checked: 2 });
    expect(md).toContain("## Runs");
    expect(md).toContain("| L1 | run-l1-a1 | — | 1 | 0 |");
    expect(md).toContain("| L2 | run-l2-b2 | — | 1 | 0 |");
    expect(md).toContain("| L3 | run-l3-c3 | --set w1-driving | 2 | 2 |");
    expect(RUNS).toHaveLength(3);
    // The runs table comes after the problems, so an INCOMPLETE ledger still leads with them.
    const partial = renderLedger(buildLedger(input({ verdicts: FULL.filter((x) => x.id !== "SH-G1") })), { audit: GAPS.length, files: 5, umbrellas: 0, checked: 2 });
    expect(partial.indexOf("## Problems")).toBeGreaterThan(0);
    expect(partial.indexOf("## Problems")).toBeLessThan(partial.indexOf("## Runs"));
  });

  it("a plan with a pipe is escaped in the runs table", () => {
    const md = renderLedger(buildLedger(input({ triage: triageJson({ runs: RUNS.map((r) => (r.layer === "L3" ? { ...r, plan: "--set a|b" } : r)) }) })), { audit: GAPS.length, files: 5, umbrellas: 0, checked: 2 });
    expect(md).toContain("| L3 | run-l3-c3 | --set a\\|b | 2 | 2 |");
  });

  it("a triage row for an umbrella reproduces the umbrella only: its members still owe their own outcome", () => {
    const l = buildLedger(input({
      gaps: [...GAPS, G("SC-C1")], umbrellas: [{ ...G("SC-X1"), members: ["SC-C1"] }],
      triage: triageJson({ rows: [{ caseId: "knockout|cricket|t20|F1", layer: "L3", gap: "SC-X1", wave: "W2", rule: "T-9" }, { caseId: "swiss|chess|default|M1", layer: "L3", gap: "SW-H1", wave: "W3", rule: "T-1" }] }),
      verdicts: [...FULL, ...verdicts([v({ id: "SC-C1", wave: "W2" })])],
    }));
    expect(l.findings).toEqual([]);
    expect(l.umbrellaCases).toEqual([{ id: "SC-X1", members: ["SC-C1"], cases: ["knockout|cricket|t20|F1"] }]);
    expect(l.entries.find((e) => e.id === "SC-C1")?.outcome).toBe("not-exercised");
  });
});

// A witness that never runs flips nothing when the gap is fixed (task 19's brief: "a real, running witness"). The reader
// accepts a `.fails` call only when every ancestor up to the file is a statement, a block or a bare describe's callback.
describe("testCalls: only an it.fails that runs is a witness (m2)", () => {
  const T = "ST-G3: a witness";
  /** [what, source, whether the file's one it.fails runs]. */
  const FORMS: readonly (readonly [string, string, boolean])[] = [
    ["a bare it.fails", `it.fails("${T}", () => {});`, true],
    ["a bare test.fails", `test.fails("${T}", () => {});`, true],
    ["an it.fails in a describe", `describe("d", () => { it.fails("${T}", () => {}); });`, true],
    ["an it.fails two describes deep", `describe("d", () => { describe("e", () => { it.fails("${T}", () => {}); }); });`, true],
    ["it.skip.fails", `it.skip.fails("${T}", () => {});`, false],
    ["it.fails.skip", `it.fails.skip("${T}", () => {});`, false],
    ["test.skip.fails", `test.skip.fails("${T}", () => {});`, false],
    ["it.fails.todo", `it.fails.todo("${T}");`, false],
    ["an it.fails in describe.skip", `describe.skip("d", () => { it.fails("${T}", () => {}); });`, false],
    ["an it.fails two describes deep, the outer one skipped", `describe.skip("d", () => { describe("e", () => { it.fails("${T}", () => {}); }); });`, false],
    ["an it.fails in describe.skipIf(true)", `describe.skipIf(true)("d", () => { it.fails("${T}", () => {}); });`, false],
    ["an it.fails under if (false)", `if (false) { it.fails("${T}", () => {}); }`, false],
    ["an it.fails under if (false) in a describe", `describe("d", () => { if (false) { it.fails("${T}", () => {}); } });`, false],
    ["an it.fails behind a && that is false", `const on = false;\non && it.fails("${T}", () => {});`, false],
    ["an it.fails in a function nothing calls", `function never() { it.fails("${T}", () => {}); }`, false],
  ];

  it("each form is read as one it.fails call carrying the title, and it runs exactly when nothing above it can stop it", () => {
    let live = 0;
    let dead = 0;
    for (const [what, src, runs] of FORMS) {
      const mine = testCalls(src).filter((c) => c.title === T);
      expect(mine, `${what}: one call with the title`).toHaveLength(1);
      expect(mine[0]!.fails, `${what}: it is a fails call`).toBe(true);
      expect(mine[0]!.runs, what).toBe(runs);
      expect(failsTitles(src), what).toEqual(runs ? [T] : []);
      if (runs) live++; else dead++;
    }
    // Anti-vacuity: the table has both kinds, and every row was checked.
    expect(live).toBeGreaterThanOrEqual(3);
    expect(dead).toBeGreaterThanOrEqual(5);
    expect(live + dead).toBe(FORMS.length);
  });

  it("a verdict whose it.fails never runs is a finding naming why, never a witness; a running one is none", () => {
    const verdict = (src: string) => buildLedger(input({ readFile: (p) => (p === WITNESS ? src : null) })).findings.flatMap((f) => (f.kind === "test-not-found" ? [f.reason] : []));
    const title = "ST-G3: tiebreak validation never rejects an unknown key";
    let refused = 0;
    for (const [what, src, runs] of FORMS) {
      const body = src.replaceAll(T, title);
      expect(verdict(body), what).toEqual(runs ? [] : ["witness-not-run"]);
      if (!runs) refused++;
    }
    expect(refused).toBe(FORMS.filter(([, , runs]) => !runs).length);
    expect(refused).toBeGreaterThan(0);
    const f = buildLedger(input({ readFile: () => `it.skip.fails("${title}", () => {});` })).findings.find((x) => x.kind === "test-not-found");
    expect(f && findingLine(f)).toMatch(/never runs/);
  });

  it("a plain test and a missing title keep their own reasons, and a plain test beside a skipped witness of the same title is the witness's reason", () => {
    const title = "ST-G3: tiebreak validation never rejects an unknown key";
    const reason = (src: string) => buildLedger(input({ readFile: () => src })).findings.flatMap((f) => (f.kind === "test-not-found" ? [f.reason] : []));
    expect(reason(`it("${title}", () => {});`)).toEqual(["not-a-fails-test"]);
    expect(reason(`it.fails("ST-G3: another", () => {});`)).toEqual(["title-missing"]);
    expect(reason(`it.skip.fails("${title}", () => {});`)).toEqual(["witness-not-run"]);
  });
});

// --- renderLedger ---------------------------------------------------------------------------------------------------

describe("renderLedger", () => {
  it("states the counts per outcome, one section per outcome with its ids, and the false premises with their cases", () => {
    const md = renderLedger(buildLedger(input()), { audit: GAPS.length, files: 5, umbrellas: 0, checked: 2 });
    expect(md).toContain("| reproduced | 1 |");
    expect(md).toContain("| exercised-not-reproduced | 1 |");
    expect(md).toContain("| not-exercised | 2 |");
    expect(md).toContain("6 audit ids");
    expect(md).toMatch(/## False premises found[^\n]*\n[\s\S]*FX-G1[\s\S]*league\|generic\|default\|M1/);
    expect(md).toMatch(/## Reproduced[\s\S]*SW-H1[\s\S]*2 cases/);
    expect(md).not.toContain("## Problems");
  });

  it("a pipe in a title or evidence is escaped in its table cell, so the row keeps its columns", () => {
    const md = renderLedger(buildLedger(input({ verdicts: FULL.map((x) => (x.id === "SW-H2" ? { ...x, evidence: "a | b" } : x)), gaps: GAPS.map((g) => (g.id === "SW-H2" ? { ...g, title: "t | u" } : g)) })), { audit: GAPS.length, files: 5, umbrellas: 0, checked: 2 });
    expect(md).toContain("| SW-H2 | W3 | Med | t \\| u | a \\| b |");
  });

  it("a ledger with findings leads with them, so a partial ledger never reads as complete", () => {
    const md = renderLedger(buildLedger(input({ verdicts: FULL.filter((x) => x.id !== "SH-G1") })), { audit: GAPS.length, files: 5, umbrellas: 0, checked: 2 });
    expect(md).toMatch(/^# Audit ledger[^\n]*\n\n\*\*INCOMPLETE/);
    expect(md).toContain("SH-G1 has no outcome");
  });
});

// --- the CLI -------------------------------------------------------------------------------------------------------

let out: string[] = [];
let err: string[] = [];
beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => { out.push(String(s)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => { err.push(String(s)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); });
const said = (): string => `${out.join("")}${err.join("")}`;

/** A small audit directory whose gaps are GAPS' ids (SW-H1, SW-H2, FX-G1, SC-O1, ST-G3, SH-G1). */
function smallAudit(): string {
  const t = (ids: string[], hdr = "## Gaps"): string => `${hdr}\n\n${table(ids.map((id) => row(id, `**title of ${id}**`)))}\n`;
  return auditDir({ "SW-swiss.md": t(["H1", "H2"]), "FX-fixtures.md": t(["G1"], "## Gap table"), "SC-scoring.md": t(["O1"]), "ST-standings.md": t(["G3"]), "SH-sheets.md": t(["G1"]) });
}
const routingFile = (): string => put("gap-routing.json", { note: "test", routes: { "SW-*": "W3", "FX-G1": "W5", "SC-O1": "W2", "ST-G3": "W5", "SH-*": "W8" } });
const cliArgs = (o: { audit?: string; triage?: unknown; verdicts?: unknown; outDir?: string; routing?: string; repo?: string } = {}): { argv: string[]; ledger: string } => {
  const ledger = join(o.outDir ?? fresh(), "AUDIT-LEDGER.md");
  return {
    argv: ["--audit", o.audit ?? smallAudit(), "--triage", put("triage.json", o.triage ?? triageJson()), "--verdicts", put("audit-verdicts.json", o.verdicts ?? { verdicts: FULL }), "--routing", o.routing ?? routingFile(), ...(o.repo === undefined ? [] : ["--repo", o.repo]), "--out", ledger],
    ledger,
  };
};
const witnessRepo = (): string => { const r = fresh(); mkdirSync(join(r, dirname(WITNESS)), { recursive: true }); writeFileSync(join(r, WITNESS), WITNESS_SRC); return r; };

describe("audit-ledger CLI", () => {
  it("exit 0: every id has one outcome, AUDIT-LEDGER.md is written, the counts per outcome are printed", () => {
    const { argv, ledger } = cliArgs({ repo: witnessRepo() });
    expect(main(argv)).toBe(0);
    const md = readFileSync(ledger, "utf8");
    expect(md).toContain("| not-exercised | 2 |");
    expect(said()).toMatch(/reproduced 1, exercised-not-reproduced 1, not-exercised 2, verified-by-read 1, verified-by-failing-test 1 \(6 audit ids\)/);
    expect(said()).toContain("exit 0:");
  });

  it("exit 1: an id with no outcome, still written (a reviewer reads the partial), the id named on stdout", () => {
    const { argv, ledger } = cliArgs({ repo: witnessRepo(), verdicts: { verdicts: FULL.filter((x) => x.id !== "SH-G1") } });
    expect(main(argv)).toBe(1);
    expect(readFileSync(ledger, "utf8")).toContain("**INCOMPLETE");
    expect(said()).toContain("SH-G1 has no outcome");
  });

  it("exit 1: an id with two outcomes names it, and a failing-test verdict whose file is not there is a finding", () => {
    const two = cliArgs({ repo: witnessRepo(), verdicts: { verdicts: [...FULL, v({ id: "SW-H1" })] } });
    expect(main(two.argv)).toBe(1);
    expect(said()).toMatch(/SW-H1 has two outcomes: reproduced, not-exercised/);
    out = []; err = [];
    const gone = cliArgs({ repo: fresh() });
    expect(main(gone.argv)).toBe(1);
    expect(said()).toMatch(/ST-G3: the failing test .* is not in the repo/);
  });

  it("exit 2, nothing written: usage, an unreadable file, a verdicts file the schema refuses, an audit dir with zero gaps, a triage that is not clean, and a triage that read nothing", () => {
    const cases: [string, string[]][] = [
      ["no flags", []],
      ["a missing required flag", (() => { const a = cliArgs().argv; return a.slice(0, a.indexOf("--out")); })()],
      ["an unknown flag", [...cliArgs().argv, "--bogus"]],
      ["a missing triage file", (() => { const a = cliArgs().argv; a[a.indexOf("--triage") + 1] = join(scratch, "nope.json"); return a; })()],
      ["a triage that is not JSON", cliArgs({ triage: "{ not json" }).argv],
      ["a triage the schema refuses", cliArgs({ triage: { version: 2 } }).argv],
      ["a verdicts file the schema refuses", cliArgs({ verdicts: { verdicts: [v({ outcome: "fine" })] } }).argv],
      ["an empty audit dir", cliArgs({ audit: auditDir({}) }).argv],
      ["a triage that is not clean", cliArgs({ triage: triageJson({ untriaged: ["a|b|c|M1"] }) }).argv],
      ["a triage with no run", cliArgs({ triage: triageJson({ runs: [] }) }).argv],
      ["a triage that read no case", cliArgs({ triage: triageJson({ scanned: 0, checked: 0, runs: RUNS.map((r) => ({ ...r, cases: 0, reds: 0 })), rows: [], gaps: [], works: [] }) }).argv],
      ["a triage with one layer of the three", cliArgs({ triage: triageJson({ runs: RUNS.filter((r) => r.layer === "L3") }) }).argv],
    ];
    let refused = 0;
    for (const [what, argv] of cases) {
      out = []; err = [];
      const at = argv.indexOf("--out");
      expect(main(argv), what).toBe(2);
      expect(said(), what).toMatch(/audit-ledger: /);
      if (at >= 0) expect(readdirSync(dirname(argv[at + 1]!)), `${what}: nothing written`).not.toContain("AUDIT-LEDGER.md");
      refused++;
    }
    expect(refused).toBe(cases.length);
  });

  it("the refusal names itself and is not mangled: the clean-triage refusal prints its own name", () => {
    expect(main(cliArgs({ triage: triageJson({ untriaged: ["a|b|c|M1"] }) }).argv)).toBe(2);
    expect(said()).toMatch(/audit-ledger: TriageNotClean: /);
  });

  it("a triage that read nothing is refused with the name of what is missing, never a bare exit 2 (I1)", () => {
    const cases: [string, Partial<TriageJson>, RegExp][] = [
      ["no run", { runs: [] }, /audit-ledger: TriageNoRuns: /],
      ["no case", { scanned: 0, checked: 0, runs: RUNS.map((r) => ({ ...r, cases: 0, reds: 0 })), rows: [], gaps: [], works: [] }, /audit-ledger: TriageNoCases: /],
      ["one layer of three", { runs: RUNS.filter((r) => r.layer === "L3") }, /audit-ledger: TriageLayerMissing: .*layers L1, L2/],
      ["a layer's run read no case (N1)", { runs: RUNS.map((r) => (r.layer === "L2" ? { ...r, cases: 0, reds: 0 } : r)) }, /audit-ledger: TriageLayerEmpty: .*layer L2\b/],
    ];
    for (const [what, over, re] of cases) {
      out = []; err = [];
      const { argv, ledger } = cliArgs({ repo: witnessRepo(), triage: triageJson(over) });
      expect(main(argv), what).toBe(2);
      expect(said(), what).toMatch(re);
      expect(readdirSync(dirname(ledger)), `${what}: nothing written`).toEqual([]);
    }
  });

  it("the run ids the ledger was built from are printed and written (D19), one layer each", () => {
    const { argv, ledger } = cliArgs({ repo: witnessRepo() });
    expect(main(argv), said()).toBe(0);
    expect(said()).toContain("runs: L1 run-l1-a1, L2 run-l2-b2, L3 run-l3-c3");
    const md = readFileSync(ledger, "utf8");
    for (const r of RUNS) expect(md, r.runId).toContain(r.runId);
    expect(RUNS).toHaveLength(3);
  });

  it("the documented form `pnpm run matrix:ledger -- <flags>` works: pnpm hands the script a literal `--` first (m1)", () => {
    const a = cliArgs({ repo: witnessRepo() });
    expect(main(["--", ...a.argv]), said()).toBe(0);
    expect(readFileSync(a.ledger, "utf8")).toContain("# Audit ledger");
    // …and through a real process, its argv built as pnpm builds it: the package script's words, then `--`, then the flags.
    const words = PACKAGE_SCRIPTS["matrix:ledger"]!.split(" ");
    expect(words[0]).toBe("node");
    expect(words.at(-1)).toBe("tools/matrix/audit-ledger.ts");
    const b = cliArgs({ repo: witnessRepo() });
    const r = spawnSync(process.execPath, [...words.slice(1), "--", ...b.argv], { cwd: REPO, encoding: "utf8", timeout: SPAWN_MS, env: { PATH: process.env.PATH ?? "" } });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("exit 0:");
    expect(readFileSync(b.ledger, "utf8")).toContain("# Audit ledger");
  }, spawnBudget(1));

  it("the defaults are the committed ones: without --routing the committed gap-routing.json judges the wave, without --repo this repo's files are read", () => {
    const wrong = v({ id: "SW-H2", wave: "W4" });
    const witness = v({ id: "SW-H1", outcome: "verified-by-failing-test", test: { file: "tools/matrix/__tests__/audit-ledger.test.ts", title: "SW-H1: a title the file does not hold" } });
    const a = cliArgs({ verdicts: { verdicts: [wrong, witness] } });
    const argv = a.argv.filter((_, i) => a.argv[i] !== "--routing" && a.argv[i - 1] !== "--routing");
    expect(argv).not.toContain("--routing");
    expect(main(argv)).toBe(1);
    // SW-* is W3 in the committed routing; a verdict at W4 disagrees with it.
    expect(said()).toContain("SW-H2: the verdict says W4, design §8 says W3");
    // The file was found under this repo (title-missing, not file-missing): the default repo root is the repo's.
    expect(said()).toContain('holds no test titled "SW-H1: a title the file does not hold"');
    expect(said()).not.toContain("is not in the repo");
  });

  it("what is written and printed is redacted: a synthetic bearer token in a verdict's evidence reaches neither", () => {
    const secret = `Bearer ${"a".repeat(8)}.${"b".repeat(30)}`;
    const { argv, ledger } = cliArgs({ repo: witnessRepo(), verdicts: { verdicts: FULL.map((x) => (x.id === "SW-H2" ? { ...x, evidence: `looked at ${secret} in the log` } : x)) } });
    expect(main(argv)).toBe(0);
    expect(readFileSync(ledger, "utf8")).not.toContain(secret);
    expect(said()).not.toContain(secret);
  });

  it("…and a token in a failing test's title reaches neither the printed finding nor the ledger (the finding line quotes the title)", () => {
    const secret = `Bearer ${"e".repeat(8)}.${"f".repeat(30)}`;
    const title = `ST-G3: a title with ${secret} in it`;
    const { argv, ledger } = cliArgs({ repo: witnessRepo(), verdicts: { verdicts: FULL.map((x) => (x.id === "ST-G3" ? { ...x, test: { file: WITNESS, title } } : x)) } });
    expect(main(argv)).toBe(1);
    expect(said()).toContain("holds no test titled");
    expect(readFileSync(ledger, "utf8")).toContain("holds no test titled");
    expect(readFileSync(ledger, "utf8")).not.toContain(secret);
    expect(said()).not.toContain(secret);
  });
});

// --- the real seam: the real triage CLI's triage.json, the real audit files, the real ledger -----------------------

describe("the ledger over a triage.json the triage CLI wrote, on real committed results and the real audit files (class 1)", () => {
  it("every one of the 150 real ids gets exactly one outcome, and the id the triage reproduced is the one counted as reproduced", () => {
    // The three layers of the baseline (D19), each a committed results.json: the ledger refuses a triage of fewer.
    const l1 = join(REPO, TRUTH_RUNS, "w1drv-l1/w1drv-l1-r1/results.json");
    const l2 = join(REPO, TRUTH_RUNS, "w1c-l2/results.json");
    const l3 = join(REPO, TRUTH_RUNS, "w1drv-l3/results.json");
    type Raw = { runId: string; layer: string; cases: { state: string }[] };
    const raws = [l1, l2, l3].map((f) => JSON.parse(readFileSync(f, "utf8")) as Raw);
    expect(raws.map((r) => r.layer)).toEqual(["L1", "L2", "L3"]);
    // A catalogue of one rule: every red is SW-H1 (the real id, routed by the real prefix route).
    const cat = fresh();
    writeFileSync(join(cat, "triage-rules.json"), JSON.stringify({ rules: [{ id: "T-ALL", match: { cell: "*|*" }, gap: "SW-H1", wave: "W3", note: "every red, for the seam test" }] }));
    writeFileSync(join(cat, "gap-routing.json"), JSON.stringify({ note: "seam test", routes: { "SW-*": "W3", "FX-*": "W5", "ST-*": "W5", "SC-*": "W2", "SH-*": "W8" } }));
    writeFileSync(join(cat, "new-gaps.json"), JSON.stringify({ gaps: [] }));
    const tdir = fresh();
    expect(triageMain(["--runs", l1, l2, l3, "--catalogue", cat, "--audit", AUDIT_DIR, "--out", tdir])).toBe(0);
    const triage = parseTriage(JSON.parse(readFileSync(join(tdir, "triage.json"), "utf8")));
    // 194 + 1 + 0 reds in the committed runs (each file's own tally), independent of the tool.
    const redsOf = (r: Raw): number => r.cases.filter((c) => c.state === "red").length;
    const reds = raws.map(redsOf).reduce((a, b) => a + b, 0);
    expect(raws.map(redsOf)).toEqual([1, 0, 194]);
    expect(reds).toBe(195);
    expect(triage.rows).toHaveLength(reds);
    expect(triage.runs.map((r) => [r.layer, r.runId])).toEqual(raws.map((r) => [r.layer, r.runId]));

    // Every other id gets a verdict, typed from an independent regexp scan of the real files (never from readAuditGaps).
    const ids = readdirSync(AUDIT_DIR).filter((f) => /^(?:SW|FX|ST|SC|SH)-.*\.md$/.test(f)).flatMap((f) => {
      const p = f.slice(0, 2);
      return readFileSync(join(AUDIT_DIR, f), "utf8").split("\n").flatMap((l) => { const m = /^\| ([A-Z]+\d+)(?: \(([^)]*)\))?\s*\|/.exec(l); return m !== null && !(m[2] ?? "").startsWith("=") ? [`${p}-${m[1]!}`] : []; });
    });
    expect(ids).toHaveLength(150);
    const wave = (id: string): string => ({ SW: "W3", FX: "W5", ST: "W5", SC: "W2", SH: "W8" })[id.slice(0, 2)]!;
    const verdictList = ids.filter((id) => id !== "SW-H1").map((id) => ({ id, outcome: "not-exercised", evidence: "seam test: no driven case", wave: wave(id) }));
    const vfile = put("audit-verdicts.json", { verdicts: verdictList });
    const ledger = join(fresh(), "AUDIT-LEDGER.md");
    expect(main(["--audit", AUDIT_DIR, "--triage", join(tdir, "triage.json"), "--verdicts", vfile, "--routing", join(cat, "gap-routing.json"), "--out", ledger]), said()).toBe(0);
    expect(said()).toMatch(/reproduced 1, exercised-not-reproduced 0, not-exercised 149, verified-by-read 0, verified-by-failing-test 0 \(150 audit ids\)/);
    const md = readFileSync(ledger, "utf8");
    expect(md).toMatch(/## Reproduced[\s\S]*SW-H1[\s\S]*195 cases/);
    // Every claim traces to a run: the committed runs' own ids are on the page and on stdout.
    for (const r of raws) {
      expect(md, r.runId).toContain(r.runId);
      expect(said(), r.runId).toContain(r.runId);
    }

    // …and one verdict short is exit 1 naming exactly the id left out.
    out = []; err = [];
    const short = put("audit-verdicts.json", { verdicts: verdictList.filter((x) => x.id !== "ST-G17") });
    expect(main(["--audit", AUDIT_DIR, "--triage", join(tdir, "triage.json"), "--verdicts", short, "--routing", join(cat, "gap-routing.json"), "--out", join(fresh(), "AUDIT-LEDGER.md")])).toBe(1);
    expect(said()).toContain("ST-G17 has no outcome");
    expect((said().match(/has no outcome/g) ?? []).length).toBe(1);

    // …and with no verdict at all, 149 ids have none: stdout lists 50 and says how many more the ledger holds.
    out = []; err = [];
    const none = join(fresh(), "AUDIT-LEDGER.md");
    expect(main(["--audit", AUDIT_DIR, "--triage", join(tdir, "triage.json"), "--verdicts", put("audit-verdicts.json", { verdicts: [] }), "--routing", join(cat, "gap-routing.json"), "--out", none])).toBe(1);
    expect((said().match(/has no outcome/g) ?? []).length).toBe(50);
    expect(said()).toContain("… and 99 more (the ledger has every one)");
    expect((readFileSync(none, "utf8").match(/has no outcome/g) ?? []).length).toBe(149);
  });

  it("a one-layer triage, which the triage CLI writes without complaint, is refused by the ledger CLI naming the layers it lacks (I1)", () => {
    const cat = fresh();
    writeFileSync(join(cat, "triage-rules.json"), JSON.stringify({ rules: [{ id: "T-ALL", match: { cell: "*|*" }, gap: "SW-H1", wave: "W3", note: "every red, for the seam test" }] }));
    writeFileSync(join(cat, "gap-routing.json"), JSON.stringify({ note: "seam test", routes: { "SW-*": "W3", "FX-*": "W5", "ST-*": "W5", "SC-*": "W2", "SH-*": "W8" } }));
    writeFileSync(join(cat, "new-gaps.json"), JSON.stringify({ gaps: [] }));
    const tdir = fresh();
    expect(triageMain(["--runs", join(REPO, TRUTH_RUNS, "w1drv-l3/results.json"), "--catalogue", cat, "--audit", AUDIT_DIR, "--out", tdir])).toBe(0);
    out = []; err = [];
    const ledger = join(fresh(), "AUDIT-LEDGER.md");
    const verdictFile = put("audit-verdicts.json", { verdicts: [] });
    expect(main(["--audit", AUDIT_DIR, "--triage", join(tdir, "triage.json"), "--verdicts", verdictFile, "--routing", join(cat, "gap-routing.json"), "--out", ledger])).toBe(2);
    expect(said()).toMatch(/audit-ledger: TriageLayerMissing: .*layers L1, L2/);
    expect(readdirSync(dirname(ledger))).toEqual([]);
  });
});
