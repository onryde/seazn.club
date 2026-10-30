// Pad wave P0.2 — THE LITERAL GUARD.
//
// Each skin under `scorepad/v3/skins/` used to carry its own copy of sport rule
// facts (card colours, wicket kinds, sanction levels, ...). The pad wave moves
// every such fact into the engine (`@seazn/engine/pad`) and deletes the skin's
// copy. This file stops a copy growing back: `BANNED` maps a skin file to the
// constant names that may no longer be DECLARED in it, and one source scan over
// the whole skins tree fails when a banned name is declared again.
//
// It is a list of names, not a heuristic (spec §3.4), and it sees ONE thing: a
// line that starts `const NAME` or `export const NAME`, for a banned NAME, in the
// skin file that BANNED lists it under. It does NOT see:
//   - a RENAMED copy (`WICKET_KIND_LIST` for `WICKET_KINDS`), or the same name
//     declared in a SIBLING skin file that BANNED does not list for it;
//   - a copy held as a property of another object (`const RULES = { WICKET_KINDS: [...] }`)
//     or bound by a destructure (`const { WICKET_KINDS } = { WICKET_KINDS: [...] }`);
//   - a multi-declarator (`const A = 1, WICKET_KINDS = [...]`), a declaration that
//     follows another statement on the same line, or a function;
//   - an inline number or an inline array.
// (`let` and `var` are already errors under the repo's eslint: prefer-const, no-var.)
// Every one of those is the per-sport DRIFT TEST's job: it drives the skin's
// builder against the engine's declaration, so a copy that drifts goes red
// whatever it is called. The two guards cover different gaps; neither is a
// substitute for the other, and a reviewer must not read this scan as wider than
// the list above.
//
// `BANNED` is EMPTY at P0 and each of P1..P4 appends its own entries as it
// deletes the literals. An empty list must not make this file vacuous, so:
//   - the scanner is proven against the REAL skin sources: it must see a
//     declaration in every skin file, using names read out of those files with
//     plain string operations (not the scanner's own pattern);
//   - `RULE_CONSTANTS_AT_BASE` inventories the (file, name) pairs the plan will
//     delete. Each must still be declared in its file or be listed in `BANNED`,
//     so a misspelt entry, or a batch that deletes a constant and forgets to
//     append it, goes red with the pair named.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * skin file basename -> constant names that may no longer be declared in it.
 * One region per batch: P1, P2 and P3 run in parallel, so each inserts its own
 * entries under its own marker and the merges do not touch one another's lines.
 * An entry's names must appear in `RULE_CONSTANTS_AT_BASE`.
 */
export const BANNED: Readonly<Record<string, readonly string[]>> = {
  // P1: period sports (period-shared, hockey, icehockey, football)
  "period-shared.ts": ["SWAP_BAND"],
  "hockey.tsx": ["HOCKEY_REASONS"],
  "icehockey.tsx": ["ICEHOCKEY_REASONS"],
  // football.tsx keeps CARD_TONES (presentation) and POST_PHASES (P4); the rest of its inventory is read from footballPadRules.
  "football.tsx": ["CARD_COLORS", "CARD_REASONS", "PENALTY_OUTCOMES", "PENALTY_OFFENCES", "EVENT_BAND", "PLAY_PHASES", "PLAY_PHASE_ONLY"],
  // P2: cricket
  "cricket.tsx": [
    "WICKET_KINDS",
    "EXTRA_KINDS",
    "FIELDER_ELIGIBLE_KINDS",
    "VARIABLE_OUT_KINDS",
    "FREE_HIT_WICKET_KINDS",
    "BOWLER_CREDITED_KINDS",
    "CLOSE_REASONS",
  ],
  // P3: set-based sports + tennis (badminton, tabletennis, volleyball, tennis)
  "badminton.tsx": ["SANCTION_LEVELS", "EVENT_BAND"],
  "tabletennis.tsx": ["SANCTION_LEVELS", "EVENT_BAND", "EXPEDITE_RETURNS_THRESHOLD", "EXPEDITE_SCORE_FLOOR"],
  "volleyball.tsx": ["SANCTION_LEVELS", "EVENT_BAND", "LIBERO_BAND", "ROTATION_CYCLE", "ROTATION_VALUES"],
  "tennis.tsx": ["POINT_KINDS", "INTERRUPTION_KINDS", "SANCTION_LEVELS", "EVENT_BAND", "CALLS"],
  // P4: carrom, boardgame, generic, and POST_PHASES in every file that declares it
  // P4.1: carrom, boardgame, generic (read from carromPadRules / boardgamePadRules / genericPadRules). POST_PHASES is P4.2's.
  "carrom.tsx": ["ADJUST_REASONS", "EVENT_BAND"],
  "boardgame.tsx": ["EVENT_BAND", "BOARD_MAX"],
  "generic.tsx": ["EVENT_BAND", "MAX_PLAUSIBLE_SCORE", "MAX_TALLY_STEP"],
};

/**
 * Every (skin file, constant name) pair that plan 2026-10-29-engine-split-pad-wave
 * has P1..P4 delete from the skins, taken from the plan's "Step 5" BANNED lists
 * (P1.x period-shared/hockey/icehockey/football; P2 cricket; P3 badminton/
 * tabletennis/volleyball/tennis; P4 carrom/boardgame/generic) plus `POST_PHASES`
 * in the nine files that declare it (P4.2), and volleyball's two rotation names
 * (P3.1 review m2). Typed from the plan, not from the skins: all 49 are declared
 * at 17948f93a8. Presentation constants the plan keeps
 * (`CARD_TONES`, `HOCKEY_CLASSES`, ...) are deliberately absent. A name the plan
 * later adds or drops is edited here and in `BANNED` together.
 */
export const RULE_CONSTANTS_AT_BASE: Readonly<Record<string, readonly string[]>> = {
  "period-shared.ts": ["SWAP_BAND", "POST_PHASES"],
  "hockey.tsx": ["HOCKEY_REASONS"],
  "icehockey.tsx": ["ICEHOCKEY_REASONS"],
  "football.tsx": [
    "CARD_COLORS",
    "CARD_REASONS",
    "PENALTY_OUTCOMES",
    "PENALTY_OFFENCES",
    "EVENT_BAND",
    "PLAY_PHASES",
    "PLAY_PHASE_ONLY",
    "POST_PHASES",
  ],
  "cricket.tsx": [
    "WICKET_KINDS",
    "EXTRA_KINDS",
    "FIELDER_ELIGIBLE_KINDS",
    "VARIABLE_OUT_KINDS",
    "FREE_HIT_WICKET_KINDS",
    "BOWLER_CREDITED_KINDS",
    "CLOSE_REASONS",
  ],
  "badminton.tsx": ["SANCTION_LEVELS", "EVENT_BAND", "POST_PHASES"],
  "tabletennis.tsx": [
    "SANCTION_LEVELS",
    "EVENT_BAND",
    "EXPEDITE_RETURNS_THRESHOLD",
    "EXPEDITE_SCORE_FLOOR",
    "POST_PHASES",
  ],
  // ROTATION_CYCLE / ROTATION_VALUES: not in the plan's Step 5 list; added by the P3.1 review (m2), since a value-equal copy
  // of the cycle is invisible to every behavioural test and only this name guard can catch one growing back.
  "volleyball.tsx": ["SANCTION_LEVELS", "EVENT_BAND", "LIBERO_BAND", "ROTATION_CYCLE", "ROTATION_VALUES", "POST_PHASES"],
  "tennis.tsx": ["POINT_KINDS", "INTERRUPTION_KINDS", "SANCTION_LEVELS", "EVENT_BAND", "CALLS", "POST_PHASES"],
  "carrom.tsx": ["ADJUST_REASONS", "EVENT_BAND", "POST_PHASES"],
  "boardgame.tsx": ["EVENT_BAND", "BOARD_MAX", "POST_PHASES"],
  "generic.tsx": ["EVENT_BAND", "MAX_PLAUSIBLE_SCORE", "MAX_TALLY_STEP", "POST_PHASES"],
};

/** Pairs in `RULE_CONSTANTS_AT_BASE`: the plan's Step 5 lists (P1 9 + P2 7 + P3 14 + P4 7 = 37) + POST_PHASES in 9 files,
 *  + volleyball's ROTATION_CYCLE and ROTATION_VALUES (P3.1 review m2), + 1 the plan missed: football's `PLAY_PHASE_ONLY`
 *  (the list of event types that are only legal in play, now `EVENT_PHASES` in the engine; P1.2 review). */
const PLANNED_PAIRS = 49;

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

/** basename -> source text. Basenames are unique (asserted below), so this loses nothing. */
function skinByBasename(): ReadonlyMap<string, string> {
  return new Map([...skinSources()].map(([file, text]) => [base(file), text]));
}

type NameMap = Readonly<Record<string, readonly string[]>>;

function scanSkins(banned: NameMap): Scan {
  const all = skinSources();
  const byBase = skinByBasename();
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

interface InventoryGaps {
  /** (file, name) pairs looked at. Zero is a failure. */
  pairs: number;
  /** `file:NAME` in the inventory that is neither declared in its file nor in BANNED: a typo, or a deletion with no BANNED append. */
  undeclaredAndUnbanned: string[];
  /** `file:NAME` in BANNED that the inventory does not list: a typo, or a name the plan never named. */
  bannedNotInInventory: string[];
  /** Inventory keys naming no skin file. */
  missingFiles: string[];
}

function inventoryGaps(inventory: NameMap, banned: NameMap): InventoryGaps {
  const byBase = skinByBasename();
  const gaps: InventoryGaps = { pairs: 0, undeclaredAndUnbanned: [], bannedNotInInventory: [], missingFiles: [] };
  for (const [file, names] of Object.entries(inventory)) {
    const text = byBase.get(file);
    if (text === undefined) {
      gaps.missingFiles.push(file);
      continue;
    }
    const declared = findDeclarations(text, names);
    for (const name of new Set(names)) {
      gaps.pairs++;
      if (!declared.includes(name) && !(banned[file] ?? []).includes(name)) {
        gaps.undeclaredAndUnbanned.push(`${file}:${name}`);
      }
    }
  }
  for (const [file, names] of Object.entries(banned)) {
    for (const name of new Set(names)) {
      if (!(inventory[file] ?? []).includes(name)) gaps.bannedNotInInventory.push(`${file}:${name}`);
    }
  }
  return gaps;
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

describe("the inventory of planned deletions", () => {
  it("holds the planned number of pairs, each file a skin and each name listed once", () => {
    const entries = Object.entries(RULE_CONSTANTS_AT_BASE);
    const pairs = entries.reduce((n, [, names]) => n + names.length, 0);
    expect(pairs, "(file, name) pairs in RULE_CONSTANTS_AT_BASE").toBe(PLANNED_PAIRS);
    const files = new Set(skinByBasename().keys());
    for (const [file, names] of entries) {
      expect(files.has(file), `${file} is not a skin file`).toBe(true);
      expect(new Set(names).size, `${file} lists a name twice`).toBe(names.length);
    }
  });

  it("gaps: a still-declared name passes, a misspelt one is named, a deleted-and-banned one passes", () => {
    // Real declarations, read by the string-op reader, so this does not rot
    // when P2 deletes WICKET_KINDS.
    const real = firstConstName(skinSources().get("cricket.tsx")!)!;
    const clean = inventoryGaps({ "cricket.tsx": [real] }, {});
    expect(clean).toEqual({ pairs: 1, undeclaredAndUnbanned: [], bannedNotInInventory: [], missingFiles: [] });

    const typo = inventoryGaps({ "cricket.tsx": [real, "WICKET_KIND_TYPO"] }, {});
    expect(typo.pairs).toBe(2);
    expect(typo.undeclaredAndUnbanned).toEqual(["cricket.tsx:WICKET_KIND_TYPO"]);

    // A batch that deleted the constant and appended it: declared nowhere, banned.
    const banned = inventoryGaps({ "cricket.tsx": [real, "WICKET_KIND_TYPO"] }, { "cricket.tsx": ["WICKET_KIND_TYPO"] });
    expect(banned.undeclaredAndUnbanned).toEqual([]);
    expect(banned.bannedNotInInventory).toEqual([]);
  });

  it("gaps: a BANNED name the inventory does not list, and a file that is no skin, are named", () => {
    const real = firstConstName(skinSources().get("cricket.tsx")!)!;
    const gaps = inventoryGaps(
      { "cricket.tsx": [real], "no-such-skin.tsx": ["A"] },
      { "cricket.tsx": ["WICKET_KINDS_MISSPELT"] },
    );
    expect(gaps.bannedNotInInventory).toEqual(["cricket.tsx:WICKET_KINDS_MISSPELT"]);
    expect(gaps.missingFiles).toEqual(["no-such-skin.tsx"]);
    expect(gaps.pairs).toBe(1);
  });
});

describe("the literal guard", () => {
  it("every planned rule constant is still declared in its skin or listed in BANNED", () => {
    const gaps = inventoryGaps(RULE_CONSTANTS_AT_BASE, BANNED);
    console.info(
      `[no-rule-literals] inventory pairs checked: ${gaps.pairs}, banned: ${Object.values(BANNED).flat().length}`,
    );
    // A deletion with no BANNED append, or a misspelt name in either list, lands here with the pair named.
    expect(gaps.missingFiles, "inventory files that are no skin").toEqual([]);
    expect(gaps.undeclaredAndUnbanned, `of ${gaps.pairs} inventory pairs, not declared and not banned`).toEqual([]);
    expect(gaps.bannedNotInInventory, `of ${gaps.pairs} inventory pairs, BANNED names the inventory lacks`).toEqual([]);
    expect(gaps.pairs, "inventory pairs checked").toBe(PLANNED_PAIRS);
  });


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
