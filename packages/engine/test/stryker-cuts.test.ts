// W1d Task 15, fix round 1, I1 / T15-CUT (D14; rulings 66, 67): a split file is cut at top-level STATEMENT boundaries named by
// the statement that starts the next part (an anchor), and scripts/stryker-cuts.mjs resolves the anchors to the `file:a-b` ranges
// Stryker reads, with the TypeScript parser. A blank line, a comment or a new statement above a cut must never move it, and so
// no mutant can be lost to an ordinary edit. The review copied the five split kernels and ran Stryker's own instrumenter over
// them with ONE blank line added at the top: the line-number cuts of the first build lost 3 mutants in cricket.ts, 2 in
// football.ts and 1 each in the period, setbased and nested kernels.
//
// What is held here, and against what:
//  - the parser reading (statements, their lines, their names) against a hand-numbered synthetic file;
//  - the resolver's refusals, one per way an anchor can be wrong;
//  - the cuts against Stryker's own instrumenter on the REAL kernels, and again after an edit at the top of cricket.ts
//    (the expected counts are the instrumenter's, never the resolver's);
//  - the recut helper's split against a brute-force enumeration of every split of a small file.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STRYKER_SPLITS } from "../stryker.groups.mjs";
import { planSplit, resolveEntries, resolveSplit, statementMutants, topLevelStatements } from "../scripts/stryker-cuts.mjs";
import { mutantsOfText } from "./stryker-coverage.ts";
import { SPAWN_MS, spawnBudget } from "./stryker-spawn.ts";

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTRUMENT_BUDGET_MS = 120_000;
const read = (file: string) => readFileSync(join(ENGINE, file), "utf8");

// Hand-numbered, so every expected line below is read off this list and never computed:
const SRC = [
  "// header comment",                      //  1
  "",                                       //  2
  'import { a } from "x";',                 //  3
  "",                                       //  4
  "/** about alpha */",                     //  5
  "export function alpha() {",              //  6
  "  return 1;",                            //  7
  "}",                                      //  8
  "",                                       //  9
  "// about beta",                          // 10
  "export const beta = {",                  // 11
  "  x: 1,",                                // 12
  "};",                                     // 13
  "export interface Gamma { g: number }",   // 14
  "type T = string; const d = 2;",          // 15  two statements on one line
  "export class Delta {}",                  // 16
].join("\n");

describe("topLevelStatements reads a file's statements, their lines and the names they declare", () => {
  it("each statement's first and last line (a leading comment is not part of it) and its names, from a hand-numbered file", () => {
    const rows = topLevelStatements(SRC).map((s) => [s.names, s.startLine, s.endLine]);
    expect(rows).toEqual([
      [[], 3, 3],        // the import
      [["alpha"], 6, 8], // its JSDoc on line 5 is not part of it
      [["beta"], 11, 13],
      [["Gamma"], 14, 14],
      [["T"], 15, 15],
      [["d"], 15, 15],
      [["Delta"], 16, 16],
    ]);
  });

  it("an empty file has no statements, and a file of comments only has none either (the empty case)", () => {
    expect(topLevelStatements("")).toEqual([]);
    expect(topLevelStatements("// nothing\n\n/* here */\n")).toEqual([]);
  });
});

describe("resolveSplit turns anchors into ranges that tile the file from line 1 to the end", () => {
  it("one cut: the first part ends on the last line of the statement before the anchor, the next starts on the line after it", () => {
    expect(resolveSplit(SRC, ["beta"])).toEqual([[1, 8], [9, 99999]]);
    expect(resolveSplit(SRC, ["alpha"])).toEqual([[1, 3], [4, 99999]]);
    expect(resolveSplit(SRC, ["Gamma"])).toEqual([[1, 13], [14, 99999]]);
  });

  it("two cuts, and no cut at all (one part is the whole file)", () => {
    expect(resolveSplit(SRC, ["beta", "Delta"])).toEqual([[1, 8], [9, 15], [16, 99999]]);
    expect(resolveSplit(SRC, [])).toEqual([[1, 99999]]);
  });

  it("a cut may sit between two statements that share a line only when it falls BETWEEN lines: before `T` is fine, before `d` is refused", () => {
    expect(resolveSplit(SRC, ["T"])).toEqual([[1, 14], [15, 99999]]);
    expect(() => resolveSplit(SRC, ["d"])).toThrow(/"d".*line 15.*same line|same line.*"d"/s);
  });

  it("refuses an anchor no top-level statement declares, one that declares nothing a cut can use, one out of order, and a repeat", () => {
    expect(() => resolveSplit(SRC, ["nosuch"])).toThrow(/no top-level statement declares "nosuch"/);
    expect(() => resolveSplit(SRC, ["Delta", "beta"])).toThrow(/"beta".*(before|after|order)/s);
    expect(() => resolveSplit(SRC, ["beta", "beta"])).toThrow(/"beta".*(before|after|order)/s);
  });

  it("refuses a name two statements declare (an overload set, a type and a value of one name): the cut would be ambiguous", () => {
    const text = ["export function f(a: number): number;", "export function f(a: string): string;", "export function f(a: unknown) { return a; }", "export const z = 1;"].join("\n");
    expect(() => resolveSplit(text, ["f"])).toThrow(/"f" is declared by 3 top-level statements/);
    expect(resolveSplit(text, ["z"])).toEqual([[1, 3], [4, 99999]]);
  });

  it("an anchor cannot be the first statement: there would be an empty part before it", () => {
    expect(() => resolveSplit("export const only = 1;\n", ["only"])).toThrow(/first statement/);
  });

  it("THE POINT: whitespace, comments and a new statement above a cut move the line numbers and never the cut (every boundary shifts by exactly the lines added)", () => {
    const anchors = ["beta", "Delta"];
    const before = resolveSplit(SRC, anchors);
    const lines = SRC.split("\n");
    // 1: a blank line; 2: a comment line; 3: a whole new statement (3 lines, one of them blank), each above every cut
    const edits: { name: string; added: number; text: string }[] = [
      { name: "a blank line", added: 1, text: `\n${SRC}` },
      { name: "a comment", added: 1, text: `// added\n${SRC}` },
      { name: "a new statement", added: 3, text: `export const first = 1;\nexport const second = first + 1;\n\n${SRC}` },
      // inside a statement: a line added in the middle of alpha moves every cut after it and none before it
      { name: "a line inside alpha", added: 1, text: [...lines.slice(0, 6), "  const inner = 1;", ...lines.slice(6)].join("\n") },
    ];
    for (const e of edits) {
      const after = resolveSplit(e.text, anchors);
      expect(after.length, e.name).toBe(before.length);
      // every cut after the edit moved by the lines added, so it is still after the same statement
      for (let i = 0; i < before.length - 1; i++) expect(after[i]![1], `${e.name}: cut ${i + 1}`).toBe(before[i]![1] + e.added);
      expect(after[after.length - 1]![1], e.name).toBe(99999);
    }
    // and the premise: the fixed line numbers the first build used DO fall inside a statement after the same edit
    const edited = `\n${SRC}`.split("\n");
    expect(edited[8 - 1], "line 8 was alpha's closing brace; after one blank line on top it is alpha's last body line").toBe("  return 1;");
  });
});

describe("resolveEntries swaps `file#N` for the range of part N and leaves every other entry as it is", () => {
  const splits = { "src/a.ts": ["beta", "Delta"] };
  const reader = (file: string) => {
    expect(file).toBe("src/a.ts");
    return SRC;
  };
  it("a part entry becomes `file:from-to`; globs and negations pass through, in order", () => {
    const entries = ["src/**/*.ts", "!src/a.ts", "src/a.ts#2", "!src/**/*.test.ts"];
    expect(resolveEntries(entries, splits, reader)).toEqual(["src/**/*.ts", "!src/a.ts", "src/a.ts:9-15", "!src/**/*.test.ts"]);
    expect(resolveEntries(["src/a.ts#1"], splits, reader)).toEqual(["src/a.ts:1-8"]);
    expect(resolveEntries(["src/a.ts#3"], splits, reader)).toEqual(["src/a.ts:16-99999"]);
  });
  it("refuses a part of a file that is not split, a part 0, and a part past the last", () => {
    expect(() => resolveEntries(["src/b.ts#1"], splits, reader)).toThrow(/src\/b\.ts.*no split/);
    expect(() => resolveEntries(["src/a.ts#0"], splits, reader)).toThrow(/part 0.*1 to 3/);
    expect(() => resolveEntries(["src/a.ts#4"], splits, reader)).toThrow(/part 4.*1 to 3/);
  });
});

describe("the real kernels: the cuts lose no mutant, and an edit at the top of cricket.ts moves none of them (Stryker's own instrumenter)", () => {
  const files = Object.keys(STRYKER_SPLITS);

  it("every split file's anchors resolve, and the parts' mutants add up to the whole file's, for every file", async () => {
    expect(files.length, "split files").toBeGreaterThanOrEqual(5);
    let parts = 0;
    for (const file of files) {
      const text = read(file);
      const ranges = resolveSplit(text, STRYKER_SPLITS[file]!);
      const whole = (await mutantsOfText(file, text, "all")).length;
      let sum = 0;
      for (const r of ranges) {
        sum += (await mutantsOfText(file, text, [r])).length;
        parts++;
      }
      expect(sum, `${file}: ${whole - sum} mutant(s) lost to a cut`).toBe(whole);
      expect(whole, `${file} has mutants`).toBeGreaterThan(0);
    }
    expect(parts).toBeGreaterThan(files.length);
  }, INSTRUMENT_BUDGET_MS);

  it("cricket.ts with a blank line, a comment and a new statement added at the top: the same anchors, the same statements, no mutant lost", async () => {
    const file = "src/sports/cricket/cricket.ts";
    const anchors = STRYKER_SPLITS[file]!;
    const text = read(file);
    const baseRanges = resolveSplit(text, anchors);
    const baseCounts: number[] = [];
    for (const r of baseRanges) baseCounts.push((await mutantsOfText(file, text, [r])).length);
    const baseWhole = (await mutantsOfText(file, text, "all")).length;
    expect(baseCounts.reduce((a, b) => a + b, 0)).toBe(baseWhole);

    const added = { blank: 1, comment: 1, statement: 2 };
    const NEW = "export const scratchAddedStatement = (n: number): number => n + 1;"; // one statement, with mutants of its own
    const edits = [
      { name: "a blank line", prefix: "\n", lines: added.blank, extra: 0 },
      { name: "a comment", prefix: "// a comment added above everything\n", lines: added.comment, extra: 0 },
      { name: "a new statement", prefix: `${NEW}\n\n`, lines: added.statement, extra: -1 }, // -1: read from the instrumenter below
    ];
    const newStatementMutants = (await mutantsOfText("scratch.ts", `${NEW}\n`, "all")).length;
    expect(newStatementMutants, "the new statement has mutants of its own, so a lost one can be told from an added one").toBeGreaterThan(0);

    for (const e of edits) {
      const edited = `${e.prefix}${text}`;
      const ranges = resolveSplit(edited, anchors);
      expect(ranges.length, e.name).toBe(baseRanges.length);
      // the cut lands on the same line of the same statement: shifted by the lines added, never by a statement
      for (let i = 0; i < ranges.length - 1; i++) expect(ranges[i]![1], `${e.name}: cut ${i + 1}`).toBe(baseRanges[i]![1] + e.lines);
      // the instrumenter, not the resolver, counts: the first part gains exactly what was added, every other part is unchanged
      const counts: number[] = [];
      for (const r of ranges) counts.push((await mutantsOfText(file, edited, [r])).length);
      const gained = e.extra === -1 ? newStatementMutants : 0;
      expect(counts, e.name).toEqual(baseCounts.map((c, i) => (i === 0 ? c + gained : c)));
      expect(counts.reduce((a, b) => a + b, 0), `${e.name}: no mutant lost`).toBe((await mutantsOfText(file, edited, "all")).length);
    }
  }, INSTRUMENT_BUDGET_MS);

  it("the premise: the line numbers of the first build, kept through the same blank line, DO lose mutants (so the test above can see the regression it exists for)", async () => {
    const file = "src/sports/cricket/cricket.ts";
    // the first build's four ranges for cricket.ts (the review's finding: 3 mutants lost to one blank line)
    const OLD_RANGES: [number, number][] = [[1, 1354], [1355, 2371], [2372, 3522], [3523, 99999]];
    const edited = `\n${read(file)}`;
    const whole = (await mutantsOfText(file, edited, "all")).length;
    let sum = 0;
    for (const r of OLD_RANGES) sum += (await mutantsOfText(file, edited, [r])).length;
    expect(whole - sum, "mutants the old line-number cuts lose to one blank line").toBeGreaterThan(0);
  }, INSTRUMENT_BUDGET_MS);
});

describe("statementMutants and planSplit: the recut helper's counting and its choice of cuts", () => {
  it("statementMutants gives each statement the mutants that start inside it, and refuses a mutant outside every statement", () => {
    const stmts = topLevelStatements(SRC);
    // 1-based start lines of mutants: two in alpha (7, 7), one in beta (12), one on line 15 (T), one in Delta (16)
    expect(statementMutants(stmts, [7, 7, 12, 15, 16])).toEqual([0, 2, 1, 0, 1, 0, 1]);
    expect(() => statementMutants(stmts, [1])).toThrow(/outside every top-level statement/);
    expect(statementMutants([], [])).toEqual([]);
  });

  /** Every way to put `parts - 1` cuts at the cut-able positions, tried one by one: the oracle for the DP. */
  function bruteForce(weights: number[], cutable: boolean[], parts: number, extra: number): { max: number; count: number } | null {
    const spots = weights.map((_, i) => i).filter((i) => i > 0 && cutable[i]);
    let best: number | null = null;
    let count = 0;
    const pick = (from: number, chosen: number[]): void => {
      if (chosen.length === parts - 1) {
        const bounds = [0, ...chosen, weights.length];
        const sizes = bounds.slice(0, -1).map((b, k) => weights.slice(b, bounds[k + 1]).reduce((a, w) => a + w, 0));
        if (sizes.some((s) => s <= 0)) return; // a part with no mutant is no part
        sizes[sizes.length - 1]! += extra;
        count++;
        const max = Math.max(...sizes);
        if (best === null || max < best) best = max;
        return;
      }
      for (let k = from; k < spots.length; k++) pick(k + 1, [...chosen, spots[k]!]);
    };
    pick(0, []);
    return best === null ? null : { max: best, count };
  }

  it("planSplit's largest part is the smallest any split can reach, over 400 small files (checked against every split, not against itself)", () => {
    // mulberry32: a fixed seed, so the 400 files are the same on every run (a plain LCG's low bits alternate)
    let a = 0x9e3779b9;
    const rnd = (n: number) => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    let compared = 0;
    let refused = 0;
    for (let t = 0; t < 400; t++) {
      const n = 3 + rnd(9);
      const weights = Array.from({ length: n }, () => rnd(7));
      const cutable = weights.map(() => rnd(3) > 0);
      const parts = 1 + rnd(4);
      const extra = rnd(5) === 0 ? rnd(9) : 0;
      const want = bruteForce(weights, cutable, parts, extra);
      const got = planSplit({ weights, cutable, parts, extra });
      if (want === null) {
        expect(got, `weights ${weights.join(",")} cutable ${cutable.map(Number).join("")} parts ${parts}: no split exists`).toBeNull();
        refused++;
        continue;
      }
      expect(got, `weights ${weights.join(",")} cutable ${cutable.map(Number).join("")} parts ${parts} extra ${extra}`).not.toBeNull();
      expect(got!.max, `weights ${weights.join(",")} cutable ${cutable.map(Number).join("")} parts ${parts} extra ${extra}`).toBe(want.max);
      // the plan is a real split: cuts increase, each is cut-able, every part has mutants, the sizes are the cuts' sums
      expect(got!.cuts).toHaveLength(parts - 1);
      expect(got!.cuts.every((c, k) => c > 0 && cutable[c] === true && (k === 0 || c > got!.cuts[k - 1]!))).toBe(true);
      expect(got!.sizes).toHaveLength(parts);
      expect(Math.max(...got!.sizes)).toBe(got!.max);
      expect(got!.sizes.reduce((a, b) => a + b, 0)).toBe(weights.reduce((a, b) => a + b, 0) + extra);
      compared++;
    }
    expect(compared, "splits compared").toBeGreaterThan(100);
    expect(refused, "inputs with no split at all, also checked").toBeGreaterThan(0);
  });

  it("one part needs no cut and its size is the whole file plus the extra; asking for more parts than cut points is refused, never padded", () => {
    expect(planSplit({ weights: [3, 4, 5], cutable: [false, true, true], parts: 1, extra: 2 })).toEqual({ cuts: [], sizes: [14], max: 14 });
    expect(planSplit({ weights: [3, 4, 5], cutable: [false, true, true], parts: 4, extra: 0 })).toBeNull();
    expect(planSplit({ weights: [3, 4, 5], cutable: [false, false, false], parts: 2, extra: 0 })).toBeNull();
    expect(planSplit({ weights: [], cutable: [], parts: 1, extra: 0 }), "an empty file has no mutant to size").toBeNull();
    expect(planSplit({ weights: [0, 0, 5], cutable: [false, true, true], parts: 2, extra: 0 }), "a part with no mutant is no part").toBeNull();
  });
});

describe("pnpm mutation:recut, the helper that proposes the cuts for a target leg count", () => {
  const recut = (args: string[]) => spawnSync(process.execPath, ["scripts/stryker-recut.mjs", ...args], { cwd: ENGINE, encoding: "utf8", timeout: SPAWN_MS });

  it("prints each part's range and mutants, and a STRYKER_SPLITS entry whose anchors resolve to exactly those ranges and counts (checked by the instrumenter)", async () => {
    const file = "src/sports/period/kernel.ts";
    const r = recut([file, "2"]);
    expect(r.status, r.stderr).toBe(0);
    const entry = /^\s*"src\/sports\/period\/kernel\.ts": \[([^\]]*)\],$/m.exec(r.stdout);
    expect(entry, `a STRYKER_SPLITS line in:\n${r.stdout}`).not.toBeNull();
    const anchors = [...entry![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(anchors).toHaveLength(1);
    const ranges = resolveSplit(read(file), anchors);
    const sizes: number[] = [];
    for (const [a, b] of ranges) sizes.push((await mutantsOfText(file, read(file), [[a, b]])).length);
    const printed = [...r.stdout.matchAll(/^\s*part (\d+): (\d+) mutants\b/gm)].map((m) => Number(m[2]));
    expect(printed, "one printed size per part").toHaveLength(2);
    expect(printed).toEqual(sizes);
    expect(r.stdout, "the output says which STRYKER_SPLITS table to paste it into").toMatch(/stryker\.groups\.mjs/);
  }, spawnBudget(1) + INSTRUMENT_BUDGET_MS);

  it("refuses a missing file, a part count under 1 or one the file cannot be cut into, and a stray flag, each with exit 2 and nothing on stdout", () => {
    let checked = 0;
    for (const args of [[], ["src/nosuch.ts", "2"], ["src/sports/period/kernel.ts", "0"], ["src/sports/period/kernel.ts", "x"], ["src/sports/period/kernel.ts", "999"], ["src/sports/period/kernel.ts", "2", "--bogus"]]) {
      const r = recut(args);
      expect(r.status, `args ${JSON.stringify(args)}: ${r.stderr}`).toBe(2);
      expect(r.stdout, `args ${JSON.stringify(args)}`).toBe("");
      expect(r.stderr).toMatch(/stryker-recut: /);
      expect(r.stderr, "a refusal shows how the helper is run").toContain("mutation:recut");
      checked++;
    }
    expect(checked).toBe(6);
  }, spawnBudget(6) + INSTRUMENT_BUDGET_MS);
});
