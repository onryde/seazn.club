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
import { anchorRecords, anchorStarts, checkAnchorRecords, cutUnits, isOrdinalAnchor, planSplit, resolveEntries, resolveSplit, statementMutants, topLevelStatements, unitMutants } from "../scripts/stryker-cuts.mjs";
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

describe("the real kernels: a cut between statements loses no mutant, a cut inside a declaration loses exactly the mutants whose node spans it, and an edit at the top of cricket.ts moves none of them (Stryker's own instrumenter)", () => {
  const files = Object.keys(STRYKER_SPLITS);
  /** The mutants of a file whose node runs across the last line of a part (so no range holds them): `places` are the whole file's
   *  mutants as the instrumenter locates them (0-based lines), `ranges` the parts (1-based, inclusive). */
  const spanning = (places: { start: { line: number }; end: { line: number } }[], ranges: readonly (readonly [number, number])[]): number => {
    const bounds = ranges.slice(0, -1).map(([, to]) => to);
    return places.filter((m) => bounds.some((b) => m.start.line + 1 <= b && m.end.line + 1 > b)).length;
  };

  it("every split file's anchors resolve, and the parts' mutants add up to the whole file's, for every file", async () => {
    expect(files.length, "split files").toBeGreaterThanOrEqual(5);
    let parts = 0;
    let statementOnly = 0;
    let lost = 0;
    for (const file of files) {
      const text = read(file);
      const ranges = resolveSplit(text, STRYKER_SPLITS[file]!);
      const places = await mutantsOfText(file, text, "all");
      const whole = places.length;
      let sum = 0;
      for (const r of ranges) {
        sum += (await mutantsOfText(file, text, [r])).length;
        parts++;
      }
      // the loss is the instrumenter's own count of the nodes that span a cut, never the resolver's: Stryker keeps a mutant only if
      // its whole node is inside the range
      expect(whole - sum, `${file}: ${whole - sum} mutant(s) lost to a cut`).toBe(spanning(places, ranges));
      lost += whole - sum;
      // a split whose every cut is BETWEEN top-level statements (no \`Host.member\` anchor) loses nothing: the rule's own claim
      if (!STRYKER_SPLITS[file]!.some((a) => a.includes("."))) {
        expect(sum, `${file}: cut only between statements`).toBe(whole);
        statementOnly++;
      }
      expect(whole, `${file} has mutants`).toBeGreaterThan(0);
    }
    expect(parts).toBeGreaterThan(files.length);
    expect(statementOnly, "split files cut only between statements").toBeGreaterThan(0);
    expect(lost, "mutants lost to member cuts (the sizing test enumerates them by file)").toBeGreaterThan(0);
  }, INSTRUMENT_BUDGET_MS);

  it("cricket.ts with a blank line, a comment and a new statement added at the top: the same anchors, the same statements, the same mutants in every part", async () => {
    const file = "src/sports/cricket/cricket.ts";
    const anchors = STRYKER_SPLITS[file]!;
    const text = read(file);
    const baseRanges = resolveSplit(text, anchors);
    const baseCounts: number[] = [];
    for (const r of baseRanges) baseCounts.push((await mutantsOfText(file, text, [r])).length);
    const basePlaces = await mutantsOfText(file, text, "all");
    const baseWhole = basePlaces.length;
    const baseLoss = spanning(basePlaces, baseRanges);
    expect(baseCounts.reduce((a, b) => a + b, 0), "the parts hold the whole file's mutants but the ones whose node spans a cut").toBe(baseWhole - baseLoss);
    expect(baseLoss, "cricket.ts is cut inside its big declarations, which loses their containers").toBeGreaterThan(0);

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
      const editedPlaces = await mutantsOfText(file, edited, "all");
      expect(counts.reduce((a, b) => a + b, 0), `${e.name}: no mutant lost but the same ones that span a cut`).toBe(editedPlaces.length - baseLoss);
      expect(spanning(editedPlaces, ranges), `${e.name}: the same containers are lost`).toBe(baseLoss);
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

// W1d Task 20 PRE-STEP (T20-PRE): a statement of its own can hold more mutants than a leg may (cricket's module object is 1,017:
// over the 200-minute line at 36 runner-seconds a mutant or more, and the first full run measured up to 114), so a cut may also fall BETWEEN THE MEMBERS of one named
// declaration: `Host.member` names the member that starts the next part. The members of an object-literal `const`, of a class,
// of a function's body (its statements, and the members of a `return { ... }` that ends it). Such a cut cannot be loss-free:
// Stryker keeps a mutant only when its whole node lies inside one range, so the node that CONTAINS the cut (the object literal,
// or the function body) is in no part. The loss is exactly those container nodes and is accounted for below, never silent.
//
// Hand-numbered again, so every expected line is read off this list:
const HOSTS = [
  "// header",                                  //  1
  "export const mod = {",                       //  2
  "  key: 'k',",                                //  3
  "  apply(state) {",                           //  4
  "    return state;",                          //  5
  "  },",                                       //  6
  "  // about summary",                         //  7
  "  summary: (s) => s,",                       //  8
  "  ...rest,",                                 //  9  a spread names nothing
  "  last: 1,",                                 // 10
  "};",                                         // 11
  "",                                           // 12
  "export function make(p: number) {",          // 13
  "  const a = p + 1;",                         // 14
  "  const b = a * 2;",                         // 15
  "  function c() { return b; }",               // 16
  "  return {",                                 // 17
  "    one: a,",                                // 18
  "    two() { return c(); },",                 // 19
  "    three: b,",                              // 20
  "  };",                                       // 21
  "}",                                          // 22
  "",                                           // 23
  "export class K {",                           // 24
  "  x = 1;",                                   // 25
  "  m() { return 2; }",                        // 26
  "  n() { return 3; }",                        // 27
  "}",                                          // 28
  "export const plain = 1;",                    // 29
  "export const crowded = { a: 1, b: 2 };",     // 30  two members on one line
  "export const twice = {",                     // 31
  "  d: 1,",                                    // 32
  "  d: 2,",                                    // 33  a repeated key (legal, ambiguous as an anchor)
  "};",                                         // 34
  "export const big = {",                       // 35
  "  first: 1,",                                // 36
  "  work(x) {",                                // 37  a member that is a function: it can be opened in turn
  "    const p = x + 1;",                       // 38
  "    const q = p * 2;",                       // 39
  "    return q;",                              // 40
  "  },",                                       // 41
  "};",                                         // 42
].join("\n");

describe("a member cut: `Host.member` starts the next part, inside one declaration (T20-PRE)", () => {
  it("an object literal's member: the part before ends on the last line of the member before it, the next starts on the line after", () => {
    expect(resolveSplit(HOSTS, ["mod.apply"])).toEqual([[1, 3], [4, 99999]]);
    // a comment above `summary` (line 7) goes with the part BELOW the cut; apply's closing line 6 ends the part above
    expect(resolveSplit(HOSTS, ["mod.summary"])).toEqual([[1, 6], [7, 99999]]);
    // the spread on line 9 names nothing, but it is a member: `last` follows it
    expect(resolveSplit(HOSTS, ["mod.last"])).toEqual([[1, 9], [10, 99999]]);
    expect(resolveSplit(HOSTS, ["mod.apply", "mod.last"])).toEqual([[1, 3], [4, 9], [10, 99999]]);
  });

  it("a function's body statements, its final `return`, and the members of the object it returns", () => {
    expect(resolveSplit(HOSTS, ["make.b"])).toEqual([[1, 14], [15, 99999]]);
    expect(resolveSplit(HOSTS, ["make.c"])).toEqual([[1, 15], [16, 99999]]);
    expect(resolveSplit(HOSTS, ["make.return"])).toEqual([[1, 16], [17, 99999]]);
    expect(resolveSplit(HOSTS, ["make.two"])).toEqual([[1, 18], [19, 99999]]);
    expect(resolveSplit(HOSTS, ["make.three"])).toEqual([[1, 19], [20, 99999]]);
    expect(resolveSplit(HOSTS, ["make.b", "make.return", "make.three"])).toEqual([[1, 14], [15, 16], [17, 19], [20, 99999]]);
  });

  it("a class member, and a top-level cut mixed with a member cut in one list", () => {
    expect(resolveSplit(HOSTS, ["K.m"])).toEqual([[1, 25], [26, 99999]]);
    // `make` cuts after mod's closing line 11, `make.c` after `b` on line 15, `K` after make's closing line 22
    expect(resolveSplit(HOSTS, ["make", "make.c", "K"])).toEqual([[1, 11], [12, 15], [16, 22], [23, 99999]]);
  });

  it("a member that is itself a function is cut by a path of three names: `Host.member.statement`", () => {
    expect(resolveSplit(HOSTS, ["big.work.q"])).toEqual([[1, 38], [39, 99999]]);
    expect(resolveSplit(HOSTS, ["big.work.return"])).toEqual([[1, 39], [40, 99999]]);
    expect(resolveSplit(HOSTS, ["big.work", "big.work.return"])).toEqual([[1, 36], [37, 39], [40, 99999]]);
    expect(() => resolveSplit(HOSTS, ["big.work.p"])).toThrow(/"big\.work\.p" is the first member of "big\.work"/);
    expect(() => resolveSplit(HOSTS, ["big.nosuch.q"])).toThrow(/no member of "big" is named "nosuch"/);
    expect(() => resolveSplit(HOSTS, ["big.first.q"])).toThrow(/"big\.first" has no members a cut can use/);
    expect(() => resolveSplit(HOSTS, ["big.work.nosuch"])).toThrow(/no member of "big\.work" is named "nosuch"/);
  });

  it("refuses a host that is not there, a name that is not a member, a declaration with no members to cut, and a first member", () => {
    expect(() => resolveSplit(HOSTS, ["nosuch.x"])).toThrow(/no top-level statement declares "nosuch"/);
    expect(() => resolveSplit(HOSTS, ["mod.nosuch"])).toThrow(/no member of "mod" is named "nosuch"/);
    expect(() => resolveSplit(HOSTS, ["plain.x"])).toThrow(/"plain" has no members a cut can use/);
    // the first member would leave only the declaration's opening line before the cut
    expect(() => resolveSplit(HOSTS, ["mod.key"])).toThrow(/"mod\.key" is the first member of "mod"/);
    expect(() => resolveSplit(HOSTS, ["make.a"])).toThrow(/"make\.a" is the first member of "make"/);
    expect(() => resolveSplit(HOSTS, ["make.one"])).toThrow(/"make\.one" is the first member of "make"/);
    expect(() => resolveSplit(HOSTS, ["K.x"])).toThrow(/"K\.x" is the first member of "K"/);
  });

  it("refuses a member name that two members share, and members that share a line (a line range cannot cut between them)", () => {
    expect(() => resolveSplit(HOSTS, ["twice.d"])).toThrow(/"twice\.d" names 2 members/);
    expect(() => resolveSplit(HOSTS, ["crowded.b"])).toThrow(/"crowded\.b" starts on line 30, the same line the member before it ends/);
  });

  it("anchors stay in source order across top-level and member anchors, and a repeat is refused", () => {
    expect(() => resolveSplit(HOSTS, ["make.c", "mod.apply"])).toThrow(/"mod\.apply".*(before|after|order)/s);
    expect(() => resolveSplit(HOSTS, ["mod.apply", "mod.apply"])).toThrow(/"mod\.apply".*(before|after|order)/s);
    expect(() => resolveSplit(HOSTS, ["make.return", "make.c"])).toThrow(/"make\.c".*(before|after|order)/s);
  });

  it("an edit above or inside a member moves the cut with it and never off its member (every boundary shifts by the lines added)", () => {
    const anchors = ["mod.apply", "make.return", "make.three"];
    const before = resolveSplit(HOSTS, anchors);
    const lines = HOSTS.split("\n");
    const edits = [
      { name: "a blank line on top", added: 1, text: `\n${HOSTS}` },
      { name: "a comment on top", added: 1, text: `// added\n${HOSTS}` },
      // a statement added inside make's body, above `return`: only the cuts after it move
      { name: "a line inside make's body", added: 1, text: [...lines.slice(0, 15), "  const mid = 1;", ...lines.slice(15)].join("\n"), from: 1 },
    ];
    for (const e of edits) {
      const after = resolveSplit(e.text, anchors);
      expect(after.length, e.name).toBe(before.length);
      for (let i = 0; i < before.length - 1; i++) expect(after[i]![1], `${e.name}: cut ${i + 1}`).toBe(before[i]![1] + (e.from !== undefined && i < e.from ? 0 : e.added));
    }
  });
});

// W1d Task 20, step 2: a body statement that declares nothing (an `if`, a `for`, a call) is named by its kind and its place among
// the body's statements OF THAT KIND, `if#3` the third `if`. Football's `arbitraryEvent` is one `const roll` and an `if` chain that
// holds 261 of its 336 mutants, and no declared name falls inside it, so without this the chain could not be cut at all.
//
// Hand-numbered:
const CHAIN = [
  "export function chain(x: number) {",    //  1
  "  const r = x + 1;",                    //  2
  "  if (r > 1) { x++; }",                 //  3  if#1
  "  for (let i = 0; i < r; i++) {",       //  4  for#1
  "    x += i;",                           //  5
  "  }",                                   //  6
  "  if (r > 2) {",                        //  7  if#2
  "    x--;",                              //  8
  "  }",                                   //  9
  "  call(x);",                            // 10  expr#1
  "  switch (x) { case 1: break; }",       // 11  switch#1
  "  if (r > 3) { x = 0; }",               // 12  if#3
  "  return x;",                           // 13
  "}",                                     // 14
].join("\n");

describe("a statement that declares nothing is cut by its kind and ordinal: `Host.if#3` (T20)", () => {
  it("each kind counts on its own, a cut falls on the line after the statement before it, and the ordinal is per body", () => {
    expect(resolveSplit(CHAIN, ["chain.if#1"])).toEqual([[1, 2], [3, 99999]]);
    expect(resolveSplit(CHAIN, ["chain.for#1"])).toEqual([[1, 3], [4, 99999]]);
    expect(resolveSplit(CHAIN, ["chain.if#2"])).toEqual([[1, 6], [7, 99999]]);
    expect(resolveSplit(CHAIN, ["chain.expr#1"])).toEqual([[1, 9], [10, 99999]]);
    expect(resolveSplit(CHAIN, ["chain.switch#1"])).toEqual([[1, 10], [11, 99999]]);
    expect(resolveSplit(CHAIN, ["chain.if#3"])).toEqual([[1, 11], [12, 99999]]);
    expect(resolveSplit(CHAIN, ["chain.return"])).toEqual([[1, 12], [13, 99999]]);
    expect(resolveSplit(CHAIN, ["chain.if#1", "chain.expr#1", "chain.if#3"])).toEqual([[1, 2], [3, 9], [10, 11], [12, 99999]]);
  });

  it("a declared statement keeps its own name and does not count toward a kind; a first statement is still refused", () => {
    expect(() => resolveSplit(CHAIN, ["chain.r"])).toThrow(/"chain\.r" is the first member of "chain"/);
    expect(() => resolveSplit(CHAIN, ["chain.if#4"])).toThrow(/no member of "chain" is named "if#4"/);
    expect(() => resolveSplit(CHAIN, ["chain.if#0"])).toThrow(/no member of "chain" is named "if#0"/);
    expect(() => resolveSplit(CHAIN, ["chain.while#1"])).toThrow(/no member of "chain" is named "while#1"/);
    // the cut order is source order whatever the kind: if#3 is after expr#1
    expect(() => resolveSplit(CHAIN, ["chain.if#3", "chain.expr#1"])).toThrow(/"chain\.expr#1".*(before|after|order)/s);
  });

  it("a body that STARTS with an unnamed statement refuses a cut before it (it would be the first member), and the one after it is allowed", () => {
    const first = ["export function f(a: number) {", "  if (a) { a++; }", "  if (a > 1) { a--; }", "  return a;", "}"].join("\n");
    expect(() => resolveSplit(first, ["f.if#1"])).toThrow(/"f\.if#1" is the first member of "f"/);
    expect(resolveSplit(first, ["f.if#2"])).toEqual([[1, 2], [3, 99999]]);
  });

  it("cutUnits lists the unnamed statements as units when their host is opened, in source order, with the line the statement before ended on", () => {
    const rows = cutUnits(CHAIN, ["chain"]).map((u) => [u.names.join("|"), u.startLine, u.prevEnd]);
    expect(rows).toEqual([
      ["chain", 1, null],
      ["chain.if#1", 3, 2],
      ["chain.for#1", 4, 3],
      ["chain.if#2", 7, 6],
      ["chain.expr#1", 10, 9],
      ["chain.switch#1", 11, 10],
      ["chain.if#3", 12, 11],
      ["chain.return", 13, 12],
    ]);
  });

  it("an edit above or inside the chain moves the cut with its statement, and an `if` added BEFORE it renumbers it (the documented drift)", () => {
    const lines = CHAIN.split("\n");
    const edited = [...lines.slice(0, 1), "  // a note", ...lines.slice(1)].join("\n");
    expect(resolveSplit(edited, ["chain.if#3"])).toEqual([[1, 12], [13, 99999]]);
    // a new `if` on line 3, ahead of it: the old `if#3` is now `if#4`, so `if#3` names the old `if#2` (lines 8-10 now) and the cut moves up to it.
    // It stays loss-free (the parts still tile the file), it just no longer cuts where it did: re-run the recut helper after adding an `if` above a cut.
    const grown = [...lines.slice(0, 2), "  if (r > 0) { x += 2; }", ...lines.slice(2)].join("\n");
    expect(resolveSplit(grown, ["chain.if#3"])).toEqual([[1, 7], [8, 99999]]);
    expect(resolveSplit(grown, ["chain.if#4"])).toEqual([[1, 12], [13, 99999]]);
  });
});

// W1d Task 20 review, I1: an `if` added or removed above an ordinal anchor MOVES the cut, and nothing else noticed (the parts still tile, no
// mutant is lost, and the 10% count drift missed 8 of 9 deletions in the period kernel). So each ordinal anchor is pinned to the
// trimmed first line of the statement it starts (stryker-anchors.json), and these tests drive the real files through it.
const ANCHORS = JSON.parse(read("stryker-anchors.json")) as Record<string, Record<string, { starts: string }>>;
describe("an ordinal anchor is pinned to the statement it starts: an `if` added or removed above a cut is a loud red that says RE-CUT (T20 review I1)", () => {
  const ordinalOf = (anchor: string) => {
    const m = /^(.*)\.([a-z]+)#(\d+)$/.exec(anchor);
    if (m === null) throw new Error(`${anchor} is not an ordinal anchor`);
    return { host: m[1] as string, kind: m[2] as string, n: Number(m[3]) };
  };
  /** The real ordinal anchors, derived from STRYKER_SPLITS (any anchor with a '#'), never typed. */
  const real = Object.entries(STRYKER_SPLITS).flatMap(([file, anchors]) => anchors.filter((a) => a.includes("#")).map((anchor) => ({ file, anchor })));
  /** A statement of `kind`, written so that it parses where a statement of that kind can stand. */
  const STATEMENT: Record<string, string> = { if: "if (false) { /* inserted by the test */ }", expr: "void 0; // inserted by the test" };
  /** The text with lines `from..to` (1-based, inclusive) removed, or with `statement` put in before line `from` at its indentation. */
  const without = (text: string, from: number, to: number) => text.split("\n").filter((_, i) => i + 1 < from || i + 1 > to).join("\n");
  const within = (text: string, before: number, statement: string) => {
    const lines = text.split("\n");
    const indent = /^\s*/.exec(lines[before - 1] as string)![0];
    return [...lines.slice(0, before - 1), `${indent}${statement}`, ...lines.slice(before - 1)].join("\n");
  };
  /** The units of `kind` in the body that `anchor` cuts, from cutUnits with its hosts opened: name -> lines. */
  const unitsOf = (text: string, anchor: string) => {
    const { host, kind } = ordinalOf(anchor);
    const opens = host.split(".").map((_, i, all) => all.slice(0, i + 1).join("."));
    return cutUnits(text, opens).flatMap((u) => u.names.filter((n) => n.startsWith(`${host}.${kind}#`)).map((name) => ({ n: Number(name.slice(name.lastIndexOf("#") + 1)), startLine: u.startLine, endLine: u.endLine })));
  };
  const check = (file: string, edited: string) => checkAnchorRecords({ [file]: STRYKER_SPLITS[file] as string[] }, { [file]: ANCHORS[file] as Record<string, { starts: string }> }, () => edited);

  it("the real anchors: there are some, each is pinned, the pins hold today, and the record names exactly the ordinal anchors (nothing owed, nothing stale)", () => {
    expect(real.length, "ordinal anchors in STRYKER_SPLITS").toBeGreaterThan(2);
    for (const { anchor } of real) expect(isOrdinalAnchor(anchor), anchor).toBe(true);
    const verdict = checkAnchorRecords(STRYKER_SPLITS, ANCHORS, read);
    expect(verdict.problems, "the pins against the real files").toEqual([]);
    expect(verdict.checked, "anchors checked").toBe(real.length);
    expect(Object.values(ANCHORS).flatMap((byAnchor) => Object.keys(byAnchor)).sort(), "the record is exactly the ordinal anchors").toEqual(real.map((r) => r.anchor).sort());
    // the record is what the files say: regenerating it from the files gives it back
    expect(anchorRecords(STRYKER_SPLITS, read)).toEqual(ANCHORS);
  });

  it("an `if` ADDED above a cut reds, naming the anchor, saying RE-CUT, and finding the statement again one place down (each real ordinal anchor)", () => {
    let edits = 0;
    for (const { file, anchor } of real) {
      const text = read(file);
      const { host, kind, n } = ordinalOf(anchor);
      const above = unitsOf(text, anchor).filter((u) => u.n < n).sort((a, b) => a.n - b.n);
      expect(above.length, `${anchor}: a statement of its kind above it to put one before`).toBeGreaterThan(0);
      const statement = STATEMENT[kind];
      expect(statement, `a statement to insert for the kind "${kind}" (add one to STATEMENT)`).toBeDefined();
      const edited = within(text, above[0]!.startLine, statement as string);
      const problems = check(file, edited).problems.filter((p) => p.startsWith(`${file}: the ordinal anchor "${anchor}"`));
      expect(problems, `${anchor}: one problem`).toHaveLength(1);
      expect(problems[0], "says to re-cut").toMatch(/RE-CUT/);
      expect(problems[0], "says the statement is now one place down").toContain(`\`${host}.${kind}#${n + 1}\``);
      edits++;
    }
    expect(edits).toBe(real.length);
  });

  it("an `if` REMOVED above a cut reds just the same (the case the 10% drift missed 8 times in 9), finding the statement one place up", () => {
    let edits = 0;
    for (const { file, anchor } of real) {
      const text = read(file);
      const { host, kind, n } = ordinalOf(anchor);
      const above = unitsOf(text, anchor).filter((u) => u.n < n).sort((a, b) => b.n - a.n);
      expect(above.length, `${anchor}: a statement of its kind above it to remove`).toBeGreaterThan(0);
      const edited = without(text, above[0]!.startLine, above[0]!.endLine);
      const problems = check(file, edited).problems.filter((p) => p.startsWith(`${file}: the ordinal anchor "${anchor}"`));
      expect(problems, `${anchor}: one problem`).toHaveLength(1);
      expect(problems[0], "says to re-cut").toMatch(/RE-CUT/);
      expect(problems[0], "says the statement is now one place up").toContain(`\`${host}.${kind}#${n - 1}\``);
      edits++;
    }
    expect(edits).toBe(real.length);
  });

  it("what moves nothing stays green: a comment at the top, a comment above the cut, an `if` added BELOW every statement of the kind", () => {
    let green = 0;
    for (const { file, anchor } of real) {
      const text = read(file);
      const { kind } = ordinalOf(anchor);
      const units = unitsOf(text, anchor);
      const last = units.sort((a, b) => b.n - a.n)[0]!;
      const lines = text.split("\n");
      const at = anchorStarts(text, anchor, file);
      const cutLines = lines.flatMap((l, i) => (l.trim() === at.starts ? [i + 1] : []));
      expect(cutLines, `${anchor}: its line is in the file once`).toHaveLength(1);
      const cutLine = cutLines[0] as number;
      const below = within(text, last.endLine + 1, STATEMENT[kind] as string);
      for (const [name, edited] of [["a comment at the top", `// a comment\n${text}`], ["a comment above the cut", within(text, cutLine, "// a comment")], ["an `if` below every one of its kind", below]] as const) {
        expect(check(file, edited).problems, `${anchor}, ${name}`).toEqual([]);
        green++;
      }
    }
    expect(green).toBe(real.length * 3);
  });

  it("a cut with no record, a record with no cut, a statement gone, and a line two statements share are each a fault, and the fault says what to write", () => {
    const records = { "chain.ts": { "chain.if#2": { starts: "if (r > 2) {" } } };
    const splits = { "chain.ts": ["chain.if#2"] };
    expect(checkAnchorRecords(splits, records, () => CHAIN)).toEqual({ checked: 1, problems: [] });
    // no record: the cut is not pinned
    const none = checkAnchorRecords(splits, {}, () => CHAIN);
    expect(none.problems).toHaveLength(1);
    expect(none.problems[0]).toMatch(/has no record in packages\/engine\/stryker-anchors\.json/);
    expect(none.problems[0], "the hint is the file to write").toContain('"starts": "if (r > 2) {"');
    // a record for a cut no leg makes any more
    const orphan = checkAnchorRecords({ "chain.ts": [] }, records, () => CHAIN);
    expect(orphan).toMatchObject({ checked: 0 });
    expect(orphan.problems.join("\n")).toMatch(/records "chain\.if#2" of chain\.ts, which no leg is cut at any more/);
    // the statement is gone: the body has two ifs, so if#2 now names nothing
    const gone = CHAIN.split("\n").filter((l) => !l.includes("r > 3")).join("\n").replace("  if (r > 2) {\n    x--;\n  }\n", "");
    const lost = checkAnchorRecords(splits, records, () => gone);
    expect(lost.problems).toHaveLength(1);
    expect(lost.problems[0]).toMatch(/no longer names a statement/);
    expect(lost.problems[0]).toMatch(/RE-CUT/);
    // two ifs of the body start with the same line: a renumber could not be told from no change
    const twins = CHAIN.replace("  if (r > 3) { x = 0; }", "  if (r > 2) {\n    x = 0;\n  }");
    const ambiguous = checkAnchorRecords(splits, records, () => twins);
    expect(ambiguous.problems).toHaveLength(1);
    expect(ambiguous.problems[0]).toMatch(/a renumber could not be told from no change/);
    expect(ambiguous.problems[0]).toContain("if#3");
  });
});

describe("cutUnits and unitMutants: the recut helper's view of a file with some declarations opened up", () => {
  it("with nothing opened it is the top-level statements (each unit's names, lines and the line the statement before it ended on)", () => {
    const units = cutUnits(SRC, []);
    expect(units.map((u) => [u.names, u.startLine, u.endLine, u.prevEnd])).toEqual([
      [[], 3, 3, null],
      [["alpha"], 6, 8, 3],
      [["beta"], 11, 13, 8],
      [["Gamma"], 14, 14, 13],
      [["T"], 15, 15, 14],
      [["d"], 15, 15, 15],
      [["Delta"], 16, 16, 15],
    ]);
  });

  it("an opened declaration is its own head, then its members after the first, each named `Host.member`, in source order", () => {
    const units = cutUnits(HOSTS, ["mod", "make", "K"]);
    const rows = units.map((u) => [u.names.join("|"), u.startLine, u.prevEnd]);
    expect(rows).toEqual([
      ["mod", 2, null],
      ["mod.apply", 4, 3],
      ["mod.summary", 8, 6],   // the unit starts at the member, not at the comment above it; the cut sits after line 6
      ["mod.last", 10, 9],     // the spread on line 9 names nothing so it is no unit, but it is the member before `last`
      ["make", 13, 11],
      ["make.b", 15, 14],
      ["make.c", 16, 15],
      ["make.return", 17, 16],
      ["make.two", 19, 18],
      ["make.three", 20, 19],
      ["K", 24, 22],
      ["K.m", 26, 25],
      ["K.n", 27, 26],
      ["plain", 29, 28],
      ["crowded", 30, 29],
      ["twice", 31, 30],
      ["big", 35, 34],
    ]);
  });

  it("a member can be opened in turn, by its path: its own members follow it as `Host.member.sub`, and only an opened host's members can be", () => {
    const rows = cutUnits(HOSTS, ["big", "big.work"]).filter((u) => u.names[0]!.startsWith("big")).map((u) => [u.names.join("|"), u.startLine, u.prevEnd]);
    expect(rows).toEqual([["big", 35, 34], ["big.work", 37, 36], ["big.work.q", 39, 38], ["big.work.return", 40, 39]]);
    expect(() => cutUnits(HOSTS, ["big.work"])).toThrow(/"big\.work" is not a member of an opened declaration/);
    expect(() => cutUnits(HOSTS, ["big", "big.first"])).toThrow(/"big\.first" has no members a cut can use/);
    expect(() => cutUnits(HOSTS, ["big", "big.nosuch"])).toThrow(/"big\.nosuch" is not a member of an opened declaration/);
  });

  it("refuses to open a declaration that has no members, or that is not there", () => {
    expect(() => cutUnits(HOSTS, ["plain"])).toThrow(/"plain" has no members a cut can use/);
    expect(() => cutUnits(HOSTS, ["nosuch"])).toThrow(/no top-level statement declares "nosuch"/);
  });

  it("unitMutants gives each unit the mutants that start from its first line up to the next unit's, and refuses a mutant outside every statement", () => {
    const units = cutUnits(HOSTS, ["mod", "make"]);
    const statements = topLevelStatements(HOSTS);
    // 1-based start lines: 2 (mod's own line), 5 (inside apply), 8 (summary), 10 (last), 14 (make's first statement), 19 (two)
    const weights = unitMutants(units, statements, [2, 5, 8, 10, 14, 19]);
    expect(units.map((u, i) => [u.names.join("|"), weights[i]])).toEqual([
      ["mod", 1], ["mod.apply", 1], ["mod.summary", 1], ["mod.last", 1],
      ["make", 1], ["make.b", 0], ["make.c", 0], ["make.return", 0], ["make.two", 1], ["make.three", 0],
      ["K", 0], ["plain", 0], ["crowded", 0], ["twice", 0], ["big", 0],
    ]);
    expect(() => unitMutants(units, statements, [1])).toThrow(/outside every top-level statement/);
    expect(unitMutants([], [], [])).toEqual([]);
  });
});

describe("statementMutants and planSplit: the recut helper's counting and its choice of cuts", () => {
  it("statementMutants gives each statement the mutants that start inside it, and refuses a mutant outside every statement", () => {
    const stmts = topLevelStatements(SRC);
    // 1-based start lines of mutants: two in alpha (7, 7), one in beta (12), one on line 15 (T), one in Delta (16)
    expect(statementMutants(stmts, [7, 7, 12, 15, 16])).toEqual([0, 2, 1, 0, 1, 0, 1]);
    expect(() => statementMutants(stmts, [1])).toThrow(/outside every top-level statement/);
    expect(statementMutants([], [])).toEqual([]);
  });

  /** Every way to put `parts - 1` cuts at the cut-able positions, tried one by one, in lexicographic order: the oracle for the DP.
   *  `cuts` is the FIRST (earliest) of the splits that reach the smallest largest part, which is the tie rule a plan is stable by. */
  function bruteForce(weights: number[], cutable: boolean[], parts: number, extra: number): { max: number; cuts: number[]; count: number } | null {
    const spots = weights.map((_, i) => i).filter((i) => i > 0 && cutable[i]);
    let best: number | null = null;
    let cuts: number[] = [];
    let count = 0;
    const pick = (from: number, chosen: number[]): void => {
      if (chosen.length === parts - 1) {
        const bounds = [0, ...chosen, weights.length];
        const sizes = bounds.slice(0, -1).map((b, k) => weights.slice(b, bounds[k + 1]).reduce((a, w) => a + w, 0));
        if (sizes.some((s) => s <= 0)) return; // a part with no mutant is no part
        sizes[sizes.length - 1]! += extra;
        count++;
        const max = Math.max(...sizes);
        if (best === null || max < best) { best = max; cuts = chosen.slice(); }
        return;
      }
      for (let k = from; k < spots.length; k++) pick(k + 1, [...chosen, spots[k]!]);
    };
    pick(0, []);
    return best === null ? null : { max: best, cuts, count };
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
    let ties = 0;
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
      // among splits that tie on the largest part, the EARLIEST (first cut as early as it can be, then the next): a plan is stable
      expect(got!.cuts, `weights ${weights.join(",")} cutable ${cutable.map(Number).join("")} parts ${parts} extra ${extra}: the earliest of ${want.count} splits`).toEqual(want.cuts);
      if (want.count > 1 && parts > 1) ties++;
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
    expect(ties, "inputs with more than one split to choose between").toBeGreaterThan(20);
  });

  it("on a tie planSplit takes the earliest cuts (a zero-weight statement may go to either side: the first cut is the earlier one)", () => {
    expect(planSplit({ weights: [3, 0, 3], cutable: [true, true, true], parts: 2 })).toEqual({ cuts: [1], sizes: [3, 3], max: 3 });
    expect(planSplit({ weights: [2, 0, 2, 0, 2], cutable: [true, true, true, true, true], parts: 3 })).toEqual({ cuts: [1, 3], sizes: [2, 2, 2], max: 2 });
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

  it("--open: a declaration too big to cut around is opened, the anchors are `Host.member` paths, and the printed sizes are the instrumenter's counts of the resolved ranges, with the mutants the cuts drop reported (T20-PRE)", async () => {
    const file = "src/sports/period/kernel.ts";
    const text = read(file);
    // makePeriodModule alone is 938 mutants: no cut between top-level statements can split it
    const closed = recut([file, "3"]);
    expect(closed.status, closed.stderr).toBe(0);
    const closedMax = Number(/the largest (\d+) mutants/.exec(closed.stdout)![1]);
    expect(closedMax, "unopened, the biggest statement bounds the largest part").toBeGreaterThanOrEqual(938);

    const r = recut([file, "3", "--open", "makePeriodModule"]);
    expect(r.status, r.stderr).toBe(0);
    const entry = /^\s*"src\/sports\/period\/kernel\.ts": \[([^\]]*)\],$/m.exec(r.stdout);
    expect(entry, `a STRYKER_SPLITS line in:\n${r.stdout}`).not.toBeNull();
    const anchors = [...entry![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(anchors).toHaveLength(2);
    expect(anchors.filter((a) => a.startsWith("makePeriodModule.")).length, "the cuts fall inside the opened declaration").toBeGreaterThan(0);
    const ranges = resolveSplit(text, anchors);
    const whole = (await mutantsOfText(file, text, "all")).length;
    const sizes: number[] = [];
    for (const [a, b] of ranges) sizes.push((await mutantsOfText(file, text, [[a, b]])).length);
    const printed = [...r.stdout.matchAll(/^\s*part (\d+): (\d+) mutants\b/gm)].map((m) => Number(m[2]));
    expect(printed, "one printed size per part, each the instrumenter's count of that range").toEqual(sizes);
    const largest = Number(/the largest (\d+) mutants/.exec(r.stdout)![1]);
    expect(largest).toBe(Math.max(...sizes));
    expect(largest, "opening the declaration made the largest part smaller than the unopened plan's").toBeLessThan(closedMax);
    // the cuts drop the declaration's containers and the output says how many, by the instrumenter's own whole-minus-parts
    const dropped = whole - sizes.reduce((a, b) => a + b, 0);
    expect(dropped, "a cut inside a declaration drops its container's mutant").toBeGreaterThan(0);
    expect(r.stdout).toMatch(new RegExp(`mutants in no part: ${dropped}\\b`));
    expect(closed.stdout, "a plan with only statement cuts drops nothing, and says so").toMatch(/mutants in no part: 0\b/);
  }, spawnBudget(2) + INSTRUMENT_BUDGET_MS);

  it("--open refuses a declaration that is not there, a flag with no value and an empty entry, each exit 2 with nothing on stdout and ITS OWN reason", () => {
    // each case's reason is asserted, not only the exit: an empty entry that was let through would still be refused (exit 2) by the
    // declaration lookup, and a status-only check cannot tell the entry's own refusal from that one
    const cases: [string[], RegExp][] = [
      [["src/sports/period/kernel.ts", "2", "--open", "nosuchDeclaration"], /no top-level statement declares "nosuchDeclaration"/],
      [["src/sports/period/kernel.ts", "2", "--open"], /Option '--open <value>' argument missing/],
      [["src/sports/period/kernel.ts", "2", "--open", ""], /--open "" names an empty declaration/],
      [["src/sports/period/kernel.ts", "2", "--open", "makePeriodModule,"], /--open "makePeriodModule," names an empty declaration/],
    ];
    let checked = 0;
    for (const [args, why] of cases) {
      const r = recut(args);
      expect(r.status, `args ${JSON.stringify(args)}: ${r.stderr}`).toBe(2);
      expect(r.stdout, `args ${JSON.stringify(args)}`).toBe("");
      expect(r.stderr, `args ${JSON.stringify(args)}`).toMatch(/stryker-recut: /);
      expect(r.stderr, `args ${JSON.stringify(args)}`).toMatch(why);
      checked++;
    }
    expect(checked).toBe(cases.length);
  }, spawnBudget(4) + INSTRUMENT_BUDGET_MS);

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
