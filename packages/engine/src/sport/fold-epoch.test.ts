// FOLD_EPOCH (engine-split D26, Task 1e-1). The sport list is the registry's own (builtinModules, walked with forEachSport,
// which refuses an empty registry); no expected key set is typed into this file. Every sweep reports how many it visited
// and a count of zero fails (TEST-STRATEGY rule 2).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { builtinModules } from "../sports/index.ts";
import { forEachSport } from "../testkit/for-each-sport.ts";
import { readCorpus, SPORT_DIRS } from "../testkit/golden.ts";
import { FOLD_EPOCH, foldEpochOf } from "./fold-epoch.ts";
import * as sportSubpath from "./index.ts";

// FOLD_EPOCH is `as const` (readonly) at the type level only. The differential test below moves one entry on the live
// object, synchronously and restored in a finally, to prove foldEpochOf reads the table and not a constant: today every
// entry is 1, so a function that answered 1 for any known sport would pass every other assertion here.
const table = FOLD_EPOCH as unknown as Record<string, number>;

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

  it("answers each registered sport's own entry, and moving one entry moves only that sport", () => {
    const original = { ...table };
    const swept = forEachSport(({ key }) => {
      expect(foldEpochOf(key), `${key} unmoved`).toBe(original[key]);
      const moved = (original[key] as number) + 6;
      table[key] = moved;
      try {
        expect(foldEpochOf(key), `${key} moved`).toBe(moved);
        for (const other of Object.keys(original)) {
          if (other !== key) expect(foldEpochOf(other), `${other} while ${key} moved`).toBe(original[other]);
        }
      } finally {
        table[key] = original[key] as number;
      }
    });
    expect(swept).toBe(Object.keys(original).length);
    expect({ ...table }).toEqual(original);
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
    expect(declared).toEqual(expect.arrayContaining(["FOLD_EPOCH", "foldEpochOf"]));
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
