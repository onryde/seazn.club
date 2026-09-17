// Final review r2-m4: the public division documents are dropped by NAME, never
// by a `pub:v1:div:{id}:*` SCAN.
//
// A SCAN walks the whole Redis keyspace, rate-limit counters included, and
// every page of it is a billed Upstash command. It ran on every person write
// (photo uploads, API roster syncs), every schedule write and every stats
// refresh. The names are known, so each of those writers now DELs
// `publicDivisionCacheKeys(divisionId)` instead.
//
// A DEL by name only works while the list names EVERY key a reader writes. So
// this file reads the source tree: a `pub:v1:div:` key spelled anywhere but
// `division-doc-cache-keys.ts` fails here, and so does a builder added there but
// left out of the list. A glob (`…:*`) is a sweep, not a key, and is allowed.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import type * as TS from "typescript";
import { describe, expect, it } from "vitest";
import * as keys from "../division-doc-cache-keys";

// Through require: vite's import analysis cannot parse the 10 MB `typescript`
// bundle (pass-scoping-guard.test.ts says the same).
const ts: typeof TS = createRequire(import.meta.url)("typescript");
const SRC = resolve(import.meta.dirname, "../../..");
const MODULE = "server/public-site/division-doc-cache-keys.ts";
const PREFIX = "pub:v1:div:";

/** Every string or template literal in `source` that spells a `pub:v1:div:`
 *  key, with its line. Comments are not literals, so a comment naming a key is
 *  not a writer. */
function keyLiterals(fileName: string, source: string): Array<{ line: number; text: string }> {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: Array<{ line: number; text: string }> = [];
  const visit = (node: TS.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const text = node.getText(file);
      if (text.includes(PREFIX)) {
        found.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** A glob ends in `*` right before the literal's closing quote. */
const isGlob = (text: string) => /\*["'`]$/.test(text);

describe("the public division documents' Redis keys", () => {
  it("are exactly these three, pinned as literals the reader and every invalidator share", () => {
    expect([...keys.publicDivisionCacheKeys("div-1")].sort()).toEqual([
      "pub:v1:div:div-1:entrants-v2",
      "pub:v1:div:div-1:schedule",
      "pub:v1:div:div-1:standings",
    ]);
  });

  it("the list names every builder the module exports, once", () => {
    const builders = Object.entries(keys).filter(
      ([name, value]) => typeof value === "function" && name !== "publicDivisionCacheKeys",
    );
    expect(builders.length, "premise: the module exports its builders").toBeGreaterThan(0);
    const listed = keys.publicDivisionCacheKeys("div-1");
    expect(new Set(listed).size, "a key listed twice").toBe(listed.length);
    expect(builders.map(([name, build]) => [name, listed.includes((build as (id: string) => string)("div-1"))])).toEqual(
      builders.map(([name]) => [name, true]),
    );
    expect(listed).toHaveLength(builders.length);
  });

  it("the scan sees a writer, and ignores a comment and a glob (control)", () => {
    const found = keyLiterals(
      "probe.ts",
      [
        "// cached(`pub:v1:div:${id}:comment`)",
        "const a = cached(`pub:v1:div:${id}:stats`, load);",
        'const b = "pub:v1:div:" + id;',
        "const c = `pub:v1:div:${id}:*`;",
      ].join("\n"),
    );
    expect(found.map((f) => [f.line, isGlob(f.text)])).toEqual([
      [2, false],
      [3, false],
      [4, true],
    ]);
  });

  it("no source file outside the key module spells a `pub:v1:div:` key", () => {
    const files = sourceFiles(SRC);
    expect(files.map((f) => relative(SRC, f)), "premise: the walk reaches the module").toContain(MODULE);
    const inModule = keyLiterals(MODULE, readFileSync(join(SRC, MODULE), "utf8"));
    expect(inModule.length, "premise: the scan finds the module's own builders").toBeGreaterThanOrEqual(3);

    // Parse only the files that spell the prefix at all: an AST of every file
    // in `src` blows the test budget, and a file without the text has no key.
    const outside = files
      .filter((f) => relative(SRC, f) !== MODULE)
      .map((f) => [f, readFileSync(f, "utf8")] as const)
      .filter(([, source]) => source.includes(PREFIX))
      .flatMap(([f, source]) =>
        keyLiterals(f, source)
          .filter((hit) => !isGlob(hit.text))
          .map((hit) => `${relative(SRC, f)}:${hit.line} ${hit.text}`),
      );
    expect(outside, "a pub:v1:div: key not built by division-doc-cache-keys.ts").toEqual([]);
  }, 60_000);
});
