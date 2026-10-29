// Pad wave P0.2 — THE LITERAL GUARD.
//
// Each skin under `scorepad/v3/skins/` used to carry its own copy of sport rule
// facts (card colours, wicket kinds, sanction levels, ...). The pad wave moves
// every such fact into the engine (`@seazn/engine/pad`) and deletes the skin's
// copy. This file stops a copy growing back: `BANNED` maps a skin file to the
// constant names that may no longer be DECLARED in it, and one source scan over
// the whole skins tree fails when a banned name is declared again.
//
// It is a list of names, not a heuristic (spec §3.4). It does NOT see an inline
// number or an inline array: that is the per-sport drift test's job, which
// drives the skin's builder against the engine's declaration. The two guards
// cover different gaps; neither is a substitute for the other.
//
// `BANNED` is EMPTY at P0 and each of P1..P4 appends its own entries as it
// deletes the literals. An empty list must not make this file vacuous, so the
// scanner is also proven against the REAL skin sources: it must see a
// declaration in every skin file, using names read out of those files with
// plain string operations (not the scanner's own pattern).
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** skin file basename -> constant names that may no longer be declared in it. */
export const BANNED: Readonly<Record<string, readonly string[]>> = {};

/** Skin source files (`*.ts`/`*.tsx`, `__tests__` excluded) at 17948f93a8. Re-pin when a skin file is added. */
const PINNED_SKIN_FILES = 13;

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The subset of `names` this source DECLARES with `const` (optionally exported)
 * at the start of a line. An import, a property access, a comment line and a
 * longer name that merely contains the name are not declarations.
 */
export function findDeclarations(source: string, names: readonly string[]): string[] {
  const lines = source.split(/\r?\n/);
  const found: string[] = [];
  for (const name of new Set(names)) {
    // The name goes into a RegExp: a dotted or bracketed "name" would match
    // far more than it says. Refuse it rather than scan with a wrong pattern.
    if (!PLAIN_IDENTIFIER.test(name)) {
      throw new Error(`findDeclarations: "${name}" is not a plain identifier`);
    }
    const declaration = new RegExp(`^\\s*(?:export\\s+)?const\\s+${name}\\b`);
    if (lines.some((line) => declaration.test(line))) found.push(name);
  }
  return found;
}

const SKINS_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Every `*.ts`/`*.tsx` under skins/, relative to skins/, sorted. `__tests__` is not a skin. */
function skinFiles(dir = SKINS_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") out.push(...skinFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(relative(SKINS_DIR, full));
    }
  }
  return out.sort();
}

let sources: ReadonlyMap<string, string> | undefined;
/** relative path -> source text, read once. */
function skinSources(): ReadonlyMap<string, string> {
  sources ??= new Map(skinFiles().map((f) => [f, readFileSync(join(SKINS_DIR, f), "utf8")]));
  return sources;
}

const base = (file: string) => file.slice(file.lastIndexOf("/") + 1);

interface Scan {
  /** How many skin files were read. Zero is a failure, whatever BANNED holds. */
  scannedFiles: number;
  /** Names looked for, in files that exist. */
  namesChecked: number;
  violations: { file: string; names: string[] }[];
  /** BANNED keys naming no skin file: a typo would otherwise check nothing. */
  missingFiles: string[];
  /** BANNED keys with an empty name list: they would check nothing. */
  emptyEntries: string[];
}

function scanSkins(banned: Readonly<Record<string, readonly string[]>>): Scan {
  const all = skinSources();
  const byBase = new Map([...all].map(([file, text]) => [base(file), text]));
  const scan: Scan = {
    scannedFiles: all.size,
    namesChecked: 0,
    violations: [],
    missingFiles: [],
    emptyEntries: [],
  };
  for (const [file, names] of Object.entries(banned)) {
    const text = byBase.get(file);
    if (text === undefined) {
      scan.missingFiles.push(file);
      continue;
    }
    if (names.length === 0) scan.emptyEntries.push(file);
    scan.namesChecked += new Set(names).size;
    const found = findDeclarations(text, names);
    if (found.length > 0) scan.violations.push({ file, names: found });
  }
  return scan;
}

/**
 * First `const NAME` / `export const NAME` in a source, read with string
 * operations only, so the self-check below does not share a pattern with
 * `findDeclarations`.
 */
function firstConstName(source: string): string | undefined {
  for (const raw of source.split("\n")) {
    let line = raw.trimStart();
    if (line.startsWith("export ")) line = line.slice("export ".length).trimStart();
    if (!line.startsWith("const ")) continue;
    const rest = line.slice("const ".length).trimStart();
    let end = 0;
    while (end < rest.length && /[A-Za-z0-9_]/.test(rest[end]!)) end++;
    if (end > 0) return rest.slice(0, end);
  }
  return undefined;
}

describe("findDeclarations", () => {
  it("finds a const and an export const", () => {
    const source = [
      "const PLAIN = 1;",
      "export const EXPORTED: readonly string[] = [",
      '  "a",',
      "];",
      "\tconst TABBED = 2;",
      "  export   const SPACED=3;",
      "function f() {",
      "  const NESTED = 4;",
      "}",
    ].join("\n");
    expect(findDeclarations(source, ["PLAIN", "EXPORTED", "TABBED", "SPACED", "NESTED"])).toEqual([
      "PLAIN",
      "EXPORTED",
      "TABBED",
      "SPACED",
      "NESTED",
    ]);
  });

  it("finds a declaration in a CRLF source", () => {
    expect(findDeclarations("const A = 1;\r\nexport const B = 2;\r\n", ["A", "B"])).toEqual(["A", "B"]);
  });

  it("ignores an import and a property access of the same name", () => {
    const source = [
      'import { WICKET_KINDS } from "@seazn/engine/pad";',
      "import { WICKET_KINDS as kinds } from './x';",
      "const picked = pad.WICKET_KINDS;",
      "const { WICKET_KINDS: local } = pad;",
      "export { WICKET_KINDS };",
      "use(WICKET_KINDS);",
      "const x = WICKET_KINDS;",
    ].join("\n");
    expect(findDeclarations(source, ["WICKET_KINDS"])).toEqual([]);
  });

  it("ignores a comment line, and a longer name that contains the banned one", () => {
    const source = [
      "// const WICKET_KINDS = [];",
      " * export const WICKET_KINDS = [];",
      "const WICKET_KINDS_EXTRA = [];",
      "const MY_WICKET_KINDS = [];",
      "const WICKET_KINDSX = [];",
    ].join("\n");
    expect(findDeclarations(source, ["WICKET_KINDS"])).toEqual([]);
  });

  it("returns only the names it found, once each, in the order asked", () => {
    const source = "const B = 1;\nconst B2 = 2;\nconst A = 3;\nconst A = 4;\n";
    expect(findDeclarations(source, ["A", "C", "B", "A"])).toEqual(["A", "B"]);
  });

  it("answers [] for no names and for an empty source, and gives the same answer on a second call", () => {
    const source = "const A = 1;\n";
    expect(findDeclarations(source, [])).toEqual([]);
    expect(findDeclarations("", ["A"])).toEqual([]);
    expect(findDeclarations(source, ["A"])).toEqual(["A"]);
    expect(findDeclarations(source, ["A"])).toEqual(["A"]);
  });

  it("refuses a name that is not a plain identifier instead of scanning with a wider pattern", () => {
    for (const bad of ["A.B", "A|B", ".*", "A B", "", "A[0]", "1A"]) {
      expect(() => findDeclarations("const AxB = 1;", [bad]), `"${bad}"`).toThrow(/not a plain identifier/);
    }
  });
});

describe("the skins tree the guard reads", () => {
  it("reads the pinned number of skin files, none of them a test", () => {
    const files = [...skinSources().keys()];
    console.info(`[no-rule-literals] skin files read: ${files.length}`);
    expect(files.length, `skin files read: ${files.join(", ")}`).toBe(PINNED_SKIN_FILES);
    expect(files.filter((f) => f.includes("__tests__") || /\.test\.tsx?$/.test(f))).toEqual([]);
    // A key of BANNED is a basename, so two skins with one basename would make it ambiguous.
    expect(new Set(files.map(base)).size).toBe(files.length);
  });

  it("every skin file's source is non-empty text the scanner can see a declaration in", () => {
    // The empty-BANNED case. With nothing banned the main scan checks no name
    // at all, so this is what proves the scanner is not blind to the real
    // sources (a broken pattern, a wrong directory, an unreadable file).
    let declarationsSeen = 0;
    for (const [file, text] of skinSources()) {
      expect(text.length, file).toBeGreaterThan(0);
      const name = firstConstName(text);
      expect(name, `${file}: no const declaration found by the string-op reader`).toBeDefined();
      expect(findDeclarations(text, [name!]), file).toEqual([name]);
      declarationsSeen++;
    }
    console.info(`[no-rule-literals] declarations seen by the scanner: ${declarationsSeen}`);
    expect(declarationsSeen).toBe(PINNED_SKIN_FILES);
  });

  it("scanSkins reports a real declaration as a violation, and a name nobody declares as none", () => {
    const probe: Record<string, string[]> = {};
    for (const [file, text] of skinSources()) probe[base(file)] = [firstConstName(text)!];
    const hit = scanSkins(probe);
    expect(hit.scannedFiles).toBe(PINNED_SKIN_FILES);
    expect(hit.namesChecked).toBe(PINNED_SKIN_FILES);
    expect(hit.violations.map((v) => v.file).sort()).toEqual(Object.keys(probe).sort());

    const miss = scanSkins(Object.fromEntries(Object.keys(probe).map((f) => [f, ["NOBODY_DECLARES_THIS_NAME"]])));
    expect(miss.namesChecked).toBe(PINNED_SKIN_FILES);
    expect(miss.violations).toEqual([]);
  });

  it("scanSkins flags a BANNED key that names no skin file, and an entry with no names", () => {
    const scan = scanSkins({ "no-such-skin.tsx": ["A"], "cricket.tsx": [] });
    expect(scan.missingFiles).toEqual(["no-such-skin.tsx"]);
    expect(scan.emptyEntries).toEqual(["cricket.tsx"]);
    expect(scan.namesChecked).toBe(0);
  });
});

describe("the literal guard", () => {
  it("skins declare no banned rule literal", () => {
    const scan = scanSkins(BANNED);
    console.info(
      `[no-rule-literals] scanned files: ${scan.scannedFiles}, names checked: ${scan.namesChecked}, ` +
        `BANNED entries: ${Object.keys(BANNED).length}`,
    );
    expect(scan.scannedFiles, "scanned files").toBe(PINNED_SKIN_FILES);
    expect(scan.missingFiles, "BANNED keys that name no skin file").toEqual([]);
    expect(scan.emptyEntries, "BANNED entries with no names").toEqual([]);
    // P0: BANNED is empty, so no name is checked. That is allowed only while it is empty.
    expect(Object.keys(BANNED).length === 0 || scan.namesChecked > 0, "names checked").toBe(true);
    expect(scan.violations).toEqual([]);
  });
});
