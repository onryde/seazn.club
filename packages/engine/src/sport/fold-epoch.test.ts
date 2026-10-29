// FOLD_EPOCH (engine-split D26, Task 1e-1). The sport list is the registry's own (builtinModules, walked with forEachSport,
// which refuses an empty registry); no expected key set is typed into this file. Every sweep reports how many it visited
// and a count of zero fails (TEST-STRATEGY rule 2).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { readCorpus, SPORT_DIRS } from "../testkit/golden.ts";
import { FOLD_EPOCH, FOLD_MINOR, foldEpochOf, foldMinorOf } from "./fold-epoch.ts";
import * as sportSubpath from "./index.ts";

// FOLD_EPOCH is frozen (and `as const` at the type level): the server holds it for the life of the process. The differential test
// below therefore cannot move an entry on the live object; it imports a TEMPORARY COPY of the file (which imports nothing, so it
// loads from anywhere) with a different number for every sport, to prove foldEpochOf reads the table and not a constant: today
// every entry is 1, so a function that answered 1 for any known sport would pass every other assertion here.
const table = FOLD_EPOCH as unknown as Record<string, number>;
const minors = FOLD_MINOR as unknown as Record<string, number>;
const SOURCE = fileURLToPath(new URL("./fold-epoch.ts", import.meta.url));

describe("FOLD_EPOCH", () => {
  it(`has exactly one positive integer epoch per registered sport (${builtinModules.length}, never zero)`, () => {
    const registered = builtinModules.map((m) => m.key);
    expect(registered.length).toBeGreaterThan(0);
    expect(Object.keys(FOLD_EPOCH).sort()).toEqual([...registered].sort());
    const swept = forEachSport(({ key }) => {
      const epoch = table[key];
      expect(Number.isInteger(epoch) && (epoch as number) >= 1, `${key} has epoch ${String(epoch)}`).toBe(true);
    });
    expect(swept).toBe(registered.length);
    expect(swept).toBe(Object.keys(FOLD_EPOCH).length);
  });

  // A MANUAL major no corpus can ask for (W2c, owner 2026-10-15, commit 3abddb9c4): the opt-in cfg keys W2c added (football `shootoutAttempts`; hockey
  // `abandonPolicy: "q4_stands"`; carrom and generic `abandonPolicy: "share"`) are ones an older phone strips or refuses, and no pre-existing golden
  // stream sets them - W2c's own streams that do are APPENDED, which owes no bump - so `fold-epoch:check` cannot ask for the raise and reverting it
  // leaves every other test green. So this is a floor, stated as a literal and not derived: a git lookup of origin/main at test time would turn red the
  // day W2c merges (main's value is then this one) and cannot run in a shallow clone. MAIN holds each sport's value at origin/main cf3e64977
  // (`git show cf3e64977:packages/engine/src/sport/fold-epoch.ts`); the floor is that + 1. A ratchet: it stays true after the merge, and lowering
  // an entry here is a decision, not a cleanup.
  const W2C_MANUAL_MAJOR = { football: 1, hockey: 1, carrom: 2, generic: 2 } as const;
  it("W2c's four-sport manual MAJOR stays raised: football, hockey, carrom and generic are each at least their origin/main value + 1 (opt-in cfg keys no corpus can ask for)", () => {
    const registered = builtinModules.map((m) => m.key);
    let checked = 0;
    for (const [sport, main] of Object.entries(W2C_MANUAL_MAJOR)) {
      expect(registered, `${sport} is a registered sport`).toContain(sport);
      expect(table[sport], `${sport}: origin/main is at ${main}; W2c's opt-in cfg keys owe ${main + 1} (3abddb9c4)`).toBeGreaterThanOrEqual(main + 1);
      expect(foldEpochOf(sport), `${sport} through the accessor the server's gate reads`).toBeGreaterThanOrEqual(main + 1);
      checked++;
    }
    expect(checked, "anti-vacuity: all four sports were checked").toBe(4);
    expect(checked).toBe(Object.keys(W2C_MANUAL_MAJOR).length);
  });

  // The same kind of floor for W2e (PR B final review M-2). Football's 3 -> 4 (M12b, `squadsForLineup`: a core.lineup.* event is judged on football's own pitch) is
  // a MANUAL major, and PR B now records the stream that watches that fold (golden-branches `football.pitch_retirement`, oneSub#90015) - but the guard compares
  // each sport's epoch with its BASE's, so lowering this entry back to 3 is invisible to it: against an origin/main that holds 3 the CLI prints "epoch 3 -> 3 ...
  // 0 violation(s)" (run, exit 0, with the stream present). This floor is what turns that revert red. Stated as a literal for the reason above: MAIN is
  // football's value on the main this wave branched from (3; `git show origin/main:packages/engine/src/sport/fold-epoch.ts` while the branch is unmerged),
  // and the floor is that + 1.
  const W2E_MANUAL_MAJOR = { football: 3 } as const;
  it("W2e's football manual MAJOR stays raised: football is at least its origin/main value + 1 (the pitch judgement of a core.lineup.* event; the corpus witness cannot ask for it)", () => {
    const registered = builtinModules.map((m) => m.key);
    let checked = 0;
    for (const [sport, main] of Object.entries(W2E_MANUAL_MAJOR)) {
      expect(registered, `${sport} is a registered sport`).toContain(sport);
      expect(table[sport], `${sport}: origin/main is at ${main}; M12b's pitch judgement owes ${main + 1}`).toBeGreaterThanOrEqual(main + 1);
      expect(foldEpochOf(sport), `${sport} through the accessor the server's gate reads`).toBeGreaterThanOrEqual(main + 1);
      checked++;
    }
    expect(checked, "anti-vacuity: the sport was checked").toBe(1);
    expect(checked).toBe(Object.keys(W2E_MANUAL_MAJOR).length);
  });

  it("answers each registered sport's own entry: a copy of the file with a different number per sport answers each its own", async () => {
    const keys = builtinModules.map((m) => m.key);
    expect(keys.length).toBeGreaterThan(1);
    const wantEpoch = new Map(keys.map((k, i) => [k, 10 + 3 * i]));
    const wantMinor = new Map(keys.map((k, i) => [k, 100 + 7 * i]));
    let source = readFileSync(SOURCE, "utf8");
    // each table is rewritten inside its own literal (both name every sport), and every sport has exactly one entry in each
    for (const [name, want] of [["FOLD_EPOCH", wantEpoch], ["FOLD_MINOR", wantMinor]] as const) {
      const from = source.indexOf(`export const ${name} =`);
      const to = source.indexOf("} as const", from);
      expect(from, `${name} is declared`).toBeGreaterThanOrEqual(0);
      expect(to, `${name}'s literal ends`).toBeGreaterThan(from);
      let literal = source.slice(from, to);
      for (const [k, n] of want) {
        const entry = new RegExp(`\\b${k}: \\d+`, "g");
        expect(literal.match(entry), `${k} has one entry in ${name}`).toHaveLength(1);
        literal = literal.replace(entry, `${k}: ${n}`);
      }
      source = source.slice(0, from) + literal + source.slice(to);
    }
    const dir = mkdtempSync(join(tmpdir(), "fold-epoch-copy-"));
    try {
      const file = join(dir, "fold-epoch.mts");
      writeFileSync(file, source);
      const copy = (await import(pathToFileURL(file).href)) as { foldEpochOf: (sport: string) => number; foldMinorOf: (sport: string) => number; FOLD_EPOCH: Record<string, number> };
      let swept = 0;
      for (const k of keys) {
        expect(copy.foldEpochOf(k), `${k} (major) in the copy`).toBe(wantEpoch.get(k));
        expect(copy.foldMinorOf(k), `${k} (minor) in the copy`).toBe(wantMinor.get(k));
        expect(foldEpochOf(k), `${k} in the real table is untouched`).toBe(table[k]);
        expect(foldMinorOf(k), `${k} in the real minor table is untouched`).toBe(minors[k]);
        swept++;
      }
      expect(swept).toBe(keys.length);
      expect(new Set(wantEpoch.values()).size, "every sport got its own major").toBe(keys.length);
      expect(new Set(wantMinor.values()).size, "every sport got its own minor").toBe(keys.length);
      expect([...wantEpoch.values()].filter((n) => [...wantMinor.values()].includes(n)), "no major equals a minor, so a function reading the other table is visible").toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is frozen: the table a server holds for the life of the process cannot be edited, added to or emptied", () => {
    const first = builtinModules[0]!.key;
    const before = { ...table };
    expect(Object.isFrozen(FOLD_EPOCH)).toBe(true);
    expect(() => { table[first] = 99; }).toThrow(TypeError);
    expect(() => { table.quidditch = 1; }).toThrow(TypeError);
    expect(() => { delete table[first]; }).toThrow(TypeError);
    expect({ ...table }).toEqual(before);
    expect(foldEpochOf(first)).toBe(before[first]);
  });

  it("refuses a sport it does not know instead of answering a default", () => {
    expect(() => foldEpochOf("quidditch")).toThrow(/no FOLD_EPOCH for sport "quidditch"/);
    expect(() => foldEpochOf("")).toThrow(/no FOLD_EPOCH/);
    // Keys are exact: a registered key in another case is not a sport (the server's sport comes from a row, never typed).
    const first = builtinModules[0]!.key;
    expect(() => foldEpochOf(first.toUpperCase())).toThrow(/no FOLD_EPOCH/);
    expect(foldEpochOf(first)).toBe(table[first]);
  });

  it("does not answer from the Object prototype: constructor, toString and __proto__ are not sports", () => {
    const inherited = Object.getOwnPropertyNames(Object.prototype);
    expect(inherited.length).toBeGreaterThan(0);
    expect(inherited).toContain("constructor");
    for (const name of inherited) {
      expect(() => foldEpochOf(name), `foldEpochOf("${name}")`).toThrow(/no FOLD_EPOCH/);
    }
  });

  it("imports nothing at all, so the guard can load the baseline's copy of it from git into a temp file (parsed, not grepped)", () => {
    const file = fileURLToPath(new URL("./fold-epoch.ts", import.meta.url));
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const found: string[] = [];
    let nodes = 0;
    const visit = (n: ts.Node): void => {
      nodes++;
      const isCall = ts.isCallExpression(n);
      if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n) || ts.isImportTypeNode(n) || (ts.isExportDeclaration(n) && n.moduleSpecifier !== undefined)) found.push(n.getText(sf));
      else if (isCall && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) found.push(n.getText(sf));
      ts.forEachChild(n, visit);
    };
    visit(sf);
    // it read the real file: it declares the table and the accessor, and has far more than a handful of nodes
    expect(nodes).toBeGreaterThan(50);
    const declared = sf.statements.flatMap((st) => (ts.isVariableStatement(st) ? st.declarationList.declarations.map((d) => d.name.getText(sf)) : ts.isFunctionDeclaration(st) ? [st.name?.text ?? ""] : []));
    expect(declared).toEqual(expect.arrayContaining(["FOLD_EPOCH", "foldEpochOf", "FOLD_MINOR", "foldMinorOf"]));
    expect(found).toEqual([]);
  });

  it("is exported from the ./sport subpath, which is where a phone and the server's gate import it (the same table, not a copy)", () => {
    // src/sport/index.ts is the entry of the `./sport` export, a phone subpath: a declared-but-unexported epoch is an inert seam.
    expect(sportSubpath.FOLD_EPOCH).toBe(FOLD_EPOCH);
    expect(sportSubpath.foldEpochOf).toBe(foldEpochOf);
    expect(sportSubpath.foldEpochOf(builtinModules[0]!.key)).toBe(table[builtinModules[0]!.key]);
  });

  it("is backed by a golden corpus with streams for every sport, so the fold-epoch guard always has something to compare (D15)", () => {
    // An epoch for a sport whose corpus is missing or empty would never be enforced: the guard (Task 1e-2) compares corpora.
    expect(Object.keys(SPORT_DIRS).sort()).toEqual(Object.keys(FOLD_EPOCH).sort());
    let streams = 0;
    const swept = forEachSport(({ key }) => {
      const corpus = readCorpus(key);
      expect(corpus.key).toBe(key);
      expect(corpus.streams.length, `${key} golden streams`).toBeGreaterThan(0);
      streams += corpus.streams.length;
    });
    expect(swept).toBe(Object.keys(FOLD_EPOCH).length);
    expect(streams).toBeGreaterThanOrEqual(swept);
  });
});

// FOLD_MINOR (engine-split D34): the second half of the pair. A MAJOR says a phone must update (what it computes moved: FOLD_EPOCH, which
// the server's gate compares); a MINOR says only what the server computes moved (the standings deltas), which needs no app update. The table
// has the same guarantees as FOLD_EPOCH: registry-derived key set, frozen, own keys only, and the file imports nothing.
describe("FOLD_MINOR", () => {
  it(`has exactly one non-negative integer minor per registered sport (${builtinModules.length}), the same sports as FOLD_EPOCH`, () => {
    const registered = builtinModules.map((m) => m.key);
    expect(registered.length).toBeGreaterThan(0);
    expect(Object.keys(FOLD_MINOR).sort()).toEqual([...registered].sort());
    expect(Object.keys(FOLD_MINOR).sort()).toEqual(Object.keys(FOLD_EPOCH).sort());
    const swept = forEachSport(({ key }) => {
      const minor = minors[key];
      expect(Number.isInteger(minor) && (minor as number) >= 0, `${key} has minor ${String(minor)}`).toBe(true);
    });
    expect(swept).toBe(registered.length);
    expect(swept).toBe(Object.keys(FOLD_MINOR).length);
  });

  it("answers each sport's own minor, and a sport it does not know is refused instead of answered a default", () => {
    let swept = 0;
    forEachSport(({ key }) => {
      expect(foldMinorOf(key), key).toBe(minors[key]);
      swept++;
    });
    expect(swept).toBe(builtinModules.length);
    const first = builtinModules[0]!.key;
    expect(() => foldMinorOf("quidditch")).toThrow(/no FOLD_MINOR for sport "quidditch"/);
    expect(() => foldMinorOf("")).toThrow(/no FOLD_MINOR/);
    expect(() => foldMinorOf(first.toUpperCase())).toThrow(/no FOLD_MINOR/);
  });

  it("does not answer from the Object prototype: constructor, toString and __proto__ are not sports", () => {
    const inherited = Object.getOwnPropertyNames(Object.prototype);
    expect(inherited.length).toBeGreaterThan(0);
    expect(inherited).toContain("constructor");
    for (const name of inherited) {
      expect(() => foldMinorOf(name), `foldMinorOf("${name}")`).toThrow(/no FOLD_MINOR/);
    }
  });

  it("is frozen: the table a server holds for the life of the process cannot be edited, added to or emptied", () => {
    const first = builtinModules[0]!.key;
    const before = { ...minors };
    expect(Object.isFrozen(FOLD_MINOR)).toBe(true);
    expect(() => { minors[first] = 99; }).toThrow(TypeError);
    expect(() => { minors.quidditch = 0; }).toThrow(TypeError);
    expect(() => { delete minors[first]; }).toThrow(TypeError);
    expect({ ...minors }).toEqual(before);
    expect(foldMinorOf(first)).toBe(before[first]);
  });

  it("is exported from the ./sport subpath beside FOLD_EPOCH (the same table, not a copy), and the two accessors are different functions", () => {
    expect(sportSubpath.FOLD_MINOR).toBe(FOLD_MINOR);
    expect(sportSubpath.foldMinorOf).toBe(foldMinorOf);
    expect(sportSubpath.foldMinorOf).not.toBe(sportSubpath.foldEpochOf);
    expect(sportSubpath.foldMinorOf(builtinModules[0]!.key)).toBe(minors[builtinModules[0]!.key]);
  });
});
