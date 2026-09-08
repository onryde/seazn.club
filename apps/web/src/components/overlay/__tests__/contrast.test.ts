// The overlay's colour gate (spec §4.2, `_THEMES.md` §2, §4a, §5). Six claims,
// and every one of them is a comparison between TWO authorities rather than an
// assertion about a constant — a fixture on both ends proves the fixture.
//
//  1. overlay-tokens.ts holds NO second copy of the pad's palette layer:
//     ROOT_SPORT_DEFAULTS and paletteFor are the SAME objects as sport-theme.ts's
//     DEFAULT_SPORT_PALETTE and resolveSportPalette (asserted by identity), and
//     that one copy is proven equal to app/globals.css's `:root { --sport-* }`
//     block by parsing the stylesheet and resolving its `var()` aliases.
//  2. The overlay renders the same ELEVEN sports the pad's skin registry names
//     (`V3_SKINS`), not the NINE `SPORT_PALETTES` happens to hold — that table
//     is OVERRIDES ONLY, so cricket and generic have no entry at all and
//     boardgame and carrom omit `caution`/`dismissal`. A sweep driven off
//     `Object.keys(SPORT_PALETTES)` is silently short by four, and the four it
//     misses include cricket, whose OUT slab is the dismissal tone's headline
//     use (`_THEMES.md` §2, "Eleven sports, not nine"). The registry is the
//     authority; the module holds a literal so the overlay bundle does not pull
//     eleven `"use client"` skin modules, and THIS FILE is where the two are
//     proven equal — the shape `v3/__tests__/a11y-sweep-totality.test.ts` uses.
//  3. Every pair ROLE the overlay paints clears its floor for EVERY sport — the
//     per-sport values come from SPORT_PALETTES, never typed here. One sample is
//     not a parity sweep; this is the whole table. No role is scoped to fewer
//     sports: a pair that misses its floor is RECORDED as a two-sided exception,
//     never narrowed out of the sweep.
//  4. Each role's floor is justified by what the pixel IS. 4.5 for text; 3 for
//     large text and for graphical objects (WCAG 1.4.11) — a card chip, an LED
//     bar and a live dot are shapes in a colour, not words, and sport-theme.ts's
//     own note grants the discipline tones exactly that licence. The `where`
//     string states which, and the test holds it to it.
//  5. Alpha text (ink at 50 %, 65 %, 70 %, 75 %, 85 %, 92 % — §2, §3, §4, §4a)
//     is measured as the COMPOSITE the viewer sees, not as the solid ink.
//  6. The moments slab's `dismissal` ink is DERIVED per sport (owner pick 5C,
//     2026-09-08) and the derivation reproduces the eleven rows §5 records.
//
// A red row is a FINDING for the sheet, never a lowered floor.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SPORT_PALETTE,
  resolveSportPalette,
  SPORT_PALETTES,
  SPORT_TOKENS,
} from "@/components/v2/scorepad/v3/sport-theme";
import { V3_SKINS } from "@/components/v2/scorepad/v3/registry";
import { blendOver, contrastRatio } from "@/lib/contrast";
// ONE exported object (spec §4.2; T1/W1/R2 prompts bind on this name). Every
// group below is read off it — the granular exports exist for type reuse,
// but this test derives from the object the corpus cites.
import { OVERLAY_TOKENS } from "../overlay-tokens";

const {
  root: ROOT_SPORT_DEFAULTS,
  fixed: OVERLAY_FIXED,
  slate: SLATE_TOKENS,
  sportKeys: OVERLAY_SPORT_KEYS,
  pairRoles: OVERLAY_PAIR_ROLES,
  alphaRoles: OVERLAY_ALPHA_ROLES,
  pairExceptions: OVERLAY_PAIR_EXCEPTIONS,
  paletteFor,
  slabDismissalInkFor,
} = OVERLAY_TOKENS;

// ---------------------------------------------------------------------------
// Authority readers. Each PARSES the document that owns the fact, so the export
// is compared against the source rather than against itself.
//
// PATHS RESOLVE FROM `import.meta.url`, NOT `process.cwd()`, and every read is
// LAZY. A read at module scope throws before collection, and a suite that fails
// to collect reports `numTotalTests: 0` / `numFailedTests: 0` — this repo's
// documented class-9 trap, a green-looking run with nothing in it. With the
// reads inside test bodies (or made non-throwing where an `it.each` source
// genuinely needs them at collection time), a missing or renamed file fails a
// NAMED test that says which path it looked at.
// ---------------------------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS = join(HERE, "../../../app/globals.css");
const REPO_ROOT = join(HERE, "../../../../../..");
const SHEET_PATH = join(REPO_ROOT, "docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md");

/** `--name: value;` declarations from globals.css, first occurrence wins
 *  (the :root block declares each once; later media/theme blocks are not the
 *  default). `var(--x, fb)` resolves through the same map, falling back to
 *  `fb` when `--x` is undeclared (which is how `--sport-led` reaches #9ae600:
 *  `--color-lime-400` is Tailwind's, not globals.css's). */
let cssVarsCache: Map<string, string> | undefined;
function cssVars(): Map<string, string> {
  if (cssVarsCache) return cssVarsCache;
  const css = readFileSync(GLOBALS_CSS, "utf8");
  const vars = new Map<string, string>();
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    if (!vars.has(m[1]!)) vars.set(m[1]!, m[2]!.trim());
  }
  cssVarsCache = vars;
  return vars;
}

function resolveVar(vars: Map<string, string>, name: string, depth = 0): string {
  if (depth > 5) throw new Error(`var() chain too deep at ${name}`);
  const raw = vars.get(name);
  if (raw === undefined) throw new Error(`globals.css declares no ${name}`);
  const m = raw.match(/^var\((--[a-z0-9-]+)(?:\s*,\s*([^)]+))?\)$/);
  if (!m) return raw.toLowerCase();
  if (vars.has(m[1]!)) return resolveVar(vars, m[1]!, depth + 1);
  if (m[2]) return m[2].trim().toLowerCase();
  throw new Error(`${name} aliases ${m[1]} which is undeclared and has no fallback`);
}

/** `_THEMES.md`, or `""` if it cannot be read. Non-throwing ON PURPOSE: two
 *  `it.each` sources below are parsed from it at collection time, and a throw
 *  there would take the whole file down into a vacuous green. The strict read
 *  lives in a named test instead. */
let sheetCache: string | undefined;
function sheet(): string {
  if (sheetCache === undefined) {
    try {
      sheetCache = readFileSync(SHEET_PATH, "utf8");
    } catch {
      sheetCache = "";
    }
  }
  return sheetCache;
}

/** The text of one `## <heading>` section of `_THEMES.md`, up to the next one. */
function sheetSection(heading: string): string {
  const text = sheet();
  const start = text.indexOf(`\n## ${heading}`);
  if (start < 0) return "";
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

/** Markdown table rows of `text`, as trimmed cell arrays (header and rule rows
 *  included — callers filter on a cell they recognise). */
function tableRows(text: string, cellCount: number): string[][] {
  return text
    .split("\n")
    .filter((l) => l.trimStart().startsWith("|"))
    .map((l) => l.split("|").map((c) => c.trim()))
    .filter((cells) => cells.length === cellCount + 2)
    .map((cells) => cells.slice(1, -1));
}

const hexes = (cell: string): string[] => [...cell.matchAll(/#[0-9a-f]{6}/g)].map((m) => m[0]!);

/** `_THEMES.md` §5's recorded outcome table: sport → dismissal, slab ink, ratio.
 *  The sheet calls this "the sheet's record of the outcome, not the test's
 *  source of truth" — so it CROSS-CHECKS the derivation, in both directions,
 *  never supplies the value the derivation is copied from. */
function sheetSlabTable(): Map<string, { dismissal: string; ink: string; ratio: number }> {
  const out = new Map<string, { dismissal: string; ink: string; ratio: number }>();
  for (const cells of tableRows(sheetSection("5. Moments slab"), 4)) {
    const sport = cells[0]!;
    if (!OVERLAY_SPORT_KEYS.includes(sport)) continue;
    const dismissal = hexes(cells[1]!);
    const ink = hexes(cells[2]!);
    const ratio = cells[3]!.match(/\d+\.\d+/);
    if (dismissal.length !== 1 || ink.length === 0 || !ratio) continue;
    // The board-picked rows read "`--sport-board` `#06323c`": the LAST hex in
    // the cell is the colour, the token name is the reason.
    out.set(sport, { dismissal: dismissal[0]!, ink: ink[ink.length - 1]!, ratio: Number(ratio[0]) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 0. The EMPTY case, stated FIRST. Every sweep below is an `it.each` over a
//    product of two lists, and the empty set answers "yes" to every floor
//    question there is: an OVERLAY_SPORT_KEYS or OVERLAY_PAIR_ROLES that
//    silently emptied would report a clean, vacuous green. Three separate
//    "Finished" defects shipped in this repo behind exactly that shape.
// ---------------------------------------------------------------------------
describe("the gate is not vacuous (empty-set case first)", () => {
  it("has at least one sport, one pair role and one alpha role", () => {
    expect(OVERLAY_SPORT_KEYS.length).toBeGreaterThan(0);
    expect(OVERLAY_PAIR_ROLES.length).toBeGreaterThan(0);
    expect(OVERLAY_ALPHA_ROLES.length).toBeGreaterThan(0);
  });

  it("both authority documents are readable at the paths this suite resolves", () => {
    // The strict reads. Everything else in this file reads through the lazy,
    // non-throwing helpers, so a missing or renamed file lands HERE with the
    // path in the message instead of collapsing collection into a green run of
    // zero tests. Paths come from import.meta.url, so the verdict does not
    // depend on which directory the runner was launched from.
    expect(() => readFileSync(GLOBALS_CSS, "utf8"), `globals.css at ${GLOBALS_CSS}`).not.toThrow();
    expect(() => readFileSync(SHEET_PATH, "utf8"), `_THEMES.md at ${SHEET_PATH}`).not.toThrow();
    expect(sheet().length, "_THEMES.md is empty").toBeGreaterThan(1000);
    for (const heading of ["2. Colour", "4a. Theme C", "5. Moments slab"]) {
      expect(sheetSection(heading).length, `_THEMES.md has no "## ${heading}" section`).toBeGreaterThan(0);
    }
  });

  it("every sport resolves a palette naming all SEVEN tokens, each a 6-digit hex", () => {
    for (const sport of OVERLAY_SPORT_KEYS) {
      const p = paletteFor(sport);
      expect(Object.keys(p).sort(), `${sport} palette keys`).toEqual([...SPORT_TOKENS].sort());
      for (const token of SPORT_TOKENS) {
        expect(p[token], `${sport}.${token}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("the table IS the scope — these exact pairs are gated, at these exact floors", () => {
    // `_THEMES.md` §2: "The table is the scope: EVERY pair the picks introduce
    // is in it." A count alone cannot say that — sixteen rows minus one is
    // still "at least eight" — and an id list alone cannot say a floor was not
    // quietly downgraded 4.5 → 3. This pins BOTH. What each row measures is
    // still derived from the palette, never from here.
    expect(Object.fromEntries(OVERLAY_PAIR_ROLES.map((r) => [r.id, r.floor]))).toEqual({
      "ink-on-board": 4.5,
      "ink-on-board-2": 4.5,
      "board-on-led-line": 4.5,
      "board-on-caution": 4.5,
      "slab-ink-on-dismissal": 4.5,
      "board-on-led-headline": 3,
      "led-on-board": 3,
      "led-on-board-2": 3,
      "live-dot-on-board": 3,
      "live-dot-on-board-2": 3,
      "ink-hairline-on-board-2": 3,
      "advisory-swatch-on-board": 3,
      "advisory-swatch-on-board-2": 3,
      "caution-swatch-on-board": 3,
      "caution-swatch-on-board-2": 3,
      "dismissal-swatch-on-board": 3,
      "dismissal-swatch-on-board-2": 3,
    });
    expect(Object.fromEntries(OVERLAY_ALPHA_ROLES.map((r) => [r.id, r.floor]))).toEqual({
      "ink70-on-board": 4.5,
      "ink70-on-board-2": 4.5,
      "ink65-on-board": 4.5,
      "ink65-on-board-2": 4.5,
      "ink75-on-board": 4.5,
      "ink75-on-board-2": 4.5,
      "ink85-on-board": 4.5,
      "ink92-on-board": 4.5,
      "ink50-on-board": 3,
      "ink50-on-board-2": 3,
    });
  });

  it("every role names a real token, and its `where` justifies its floor", () => {
    // The `where` is not prose. A 4.5 row must describe TEXT; a 3 row must
    // describe LARGE TEXT or a GRAPHICAL object (WCAG 1.4.11). Without this,
    // "3" is a number somebody chose and the audit the brief left to a reviewer
    // has nothing to read. sport-theme.ts's SPORT_TOKENS note is the source of
    // the swatch licence: the discipline tones "carry the swatch obligations …
    // and not the 4.5 text floor".
    const ids = [...OVERLAY_PAIR_ROLES, ...OVERLAY_ALPHA_ROLES].map((r) => r.id);
    expect(new Set(ids).size, "duplicate role id").toBe(ids.length);
    for (const role of [...OVERLAY_PAIR_ROLES, ...OVERLAY_ALPHA_ROLES]) {
      expect(SPORT_TOKENS, `${role.id}.bg`).toContain(role.bg);
      expect(role.where, `${role.id} must open with TEXT / LARGE TEXT / GRAPHICAL`).toMatch(
        /^(TEXT|LARGE TEXT|GRAPHICAL)\b/,
      );
      expect(role.floor, `${role.id}: "${role.where.slice(0, 24)}…" against floor ${role.floor}`).toBe(
        role.where.startsWith("TEXT") ? 4.5 : 3,
      );
    }
    for (const role of OVERLAY_PAIR_ROLES) {
      if (role.fg !== "slabDismissalInk" && role.fg !== "liveDot") expect(SPORT_TOKENS).toContain(role.fg);
    }
    for (const role of OVERLAY_ALPHA_ROLES) {
      expect(SPORT_TOKENS).toContain(role.fg);
      expect(role.alpha).toBeGreaterThan(0);
      expect(role.alpha).toBeLessThan(1);
    }
  });

  it("both fixed colours are PAINTED on a ground, not merely declared", () => {
    // OVERLAY_FIXED holds two values and both reach the screen, so both owe a
    // pair role. `liveDot` had only a value-equality check in the first cut —
    // a colour nothing measures against a background, which is how hockey's
    // 2.75 on its own band went unnoticed.
    const markers = OVERLAY_PAIR_ROLES.map((r) => r.fg);
    for (const key of Object.keys(OVERLAY_FIXED)) {
      expect(markers, `OVERLAY_FIXED.${key} has no pair role`).toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// 1. The mirror — and, first, that there is only ONE thing to mirror.
// ---------------------------------------------------------------------------
describe("ROOT_SPORT_DEFAULTS is sport-theme.ts's own palette, mirrored to globals.css once", () => {
  it("is the SAME object as DEFAULT_SPORT_PALETTE, not a copy of it", () => {
    // Identity, not equality. Two byte-identical copies each with its own proof
    // is the failure this asserts against: a globals.css change that moves one
    // and not the other leaves the pad and the overlay disagreeing about a
    // colour with both suites green. `_THEMES.md`'s own rule — "a value typed
    // twice is a finding".
    expect(ROOT_SPORT_DEFAULTS).toBe(DEFAULT_SPORT_PALETTE);
    expect(paletteFor).toBe(resolveSportPalette);
  });

  it.each([...SPORT_TOKENS])("--sport-%s", (token) => {
    expect(ROOT_SPORT_DEFAULTS[token]).toBe(resolveVar(cssVars(), `--sport-${token}`));
  });

  it("the mirror has no token globals.css lacks, and vice versa", () => {
    const declared = [...cssVars().keys()]
      .filter((k) => k.startsWith("--sport-"))
      .map((k) => k.slice(8))
      .sort();
    expect(declared).toEqual([...SPORT_TOKENS].sort());
  });

  it("the aliases really are resolved, not read as literals", () => {
    // `--sport-board: var(--mk-night)` and `--sport-led: var(--color-lime-400,
    // #9ae600)` are the two shapes resolveVar exists for. If it ever returned
    // the raw declaration, this pair would read as `var(...)` and the rows
    // above would compare a hex against a function call.
    expect(resolveVar(cssVars(), "--sport-board")).toMatch(/^#[0-9a-f]{6}$/);
    expect(resolveVar(cssVars(), "--sport-led")).toMatch(/^#[0-9a-f]{6}$/);
    // …and the fallback arm is live: --color-lime-400 is Tailwind's, declared
    // nowhere in globals.css, so the declared #9ae600 is what must come back.
    expect(cssVars().has("--color-lime-400")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Which sports exist.
// ---------------------------------------------------------------------------
describe("OVERLAY_SPORT_KEYS is the pad's ELEVEN, not SPORT_PALETTES' nine", () => {
  it("is exactly the sport keys the pad's skin registry names (one authority)", () => {
    // The module holds a LITERAL so the overlay bundle does not pull eleven
    // "use client" skin modules and the engine with them (an OBS browser source
    // is the one page where weight IS the feature). The registry stays the
    // authority, and this is where the two are held equal — both directions, so
    // a twelfth skin reddens here until the literal covers it, and a key the
    // registry does not own reddens too. Same shape as
    // v3/__tests__/a11y-sweep-totality.test.ts's V3_SKIN_CASE_KEYS pin.
    expect([...OVERLAY_SPORT_KEYS].sort()).toEqual(Object.keys(V3_SKINS).sort());
    expect(Object.keys(V3_SKINS).length).toBe(11);
    expect(new Set(OVERLAY_SPORT_KEYS).size).toBe(OVERLAY_SPORT_KEYS.length);
  });

  it("covers the four sports SPORT_PALETTES does not name at all", () => {
    // The differential case for claim 2: the sweep would still look busy and
    // green if it enumerated only the palette table, and it would be missing
    // exactly the four sports whose dismissal falls through to :root.
    const fromPalettes = Object.keys(SPORT_PALETTES);
    expect(fromPalettes.length).toBe(9);
    const inherited = OVERLAY_SPORT_KEYS.filter((k) => !fromPalettes.includes(k));
    expect(inherited.sort()).toEqual(["cricket", "generic"]);
    for (const k of fromPalettes) expect(OVERLAY_SPORT_KEYS).toContain(k);
    // …and the two that DO have an entry but omit the card tones.
    for (const k of ["boardgame", "carrom"]) {
      expect(SPORT_PALETTES[k], `${k} should have a palette entry`).toBeDefined();
      expect(SPORT_PALETTES[k]!.dismissal, `${k} should NOT override dismissal`).toBeUndefined();
    }
  });

  it("paletteFor fills a missing token from the root defaults, never from another sport", () => {
    // boardgame declares no caution/dismissal (_THEMES.md §2 "inherit").
    const bg = paletteFor("boardgame");
    expect(bg.caution).toBe(ROOT_SPORT_DEFAULTS.caution);
    expect(bg.dismissal).toBe(ROOT_SPORT_DEFAULTS.dismissal);
    expect(bg.board).toBe(SPORT_PALETTES.boardgame!.board);
    // cricket and generic have no entry at all: every token is the default.
    expect(paletteFor("cricket")).toEqual(ROOT_SPORT_DEFAULTS);
    expect(paletteFor("generic")).toEqual(ROOT_SPORT_DEFAULTS);
    // A sport that does override must NOT come back as the defaults — without
    // this, a `paletteFor` that ignored SPORT_PALETTES entirely would pass
    // every line above.
    expect(paletteFor("football").board).toBe(SPORT_PALETTES.football!.board);
    expect(paletteFor("football").board).not.toBe(ROOT_SPORT_DEFAULTS.board);
    // …and an unknown key falls through to the defaults rather than throwing.
    expect(paletteFor("kabaddi")).toEqual(ROOT_SPORT_DEFAULTS);
  });
});

// ---------------------------------------------------------------------------
// 3. The parity sweep.
// ---------------------------------------------------------------------------
const pairRows = OVERLAY_SPORT_KEYS.flatMap((sport) =>
  OVERLAY_PAIR_ROLES.map((role) => ({ sport, role, title: `${sport} · ${role.id} (${role.where})` })),
);

function pairInk(sport: string, role: (typeof OVERLAY_PAIR_ROLES)[number]): string {
  const p = paletteFor(sport);
  if (role.fg === "slabDismissalInk") return slabDismissalInkFor(sport);
  if (role.fg === "liveDot") return OVERLAY_FIXED.liveDot;
  return p[role.fg];
}

/**
 * The sweep's own body, extracted so a HARNESS SELF-TEST can drive it with an
 * injected ratio. Without that, the sweep's floor is a test-side constant no
 * assertion can see: replacing `role.floor` with `1` here leaves every row green
 * and every other test in this file untouched — a measured survivor before this
 * function existed. The self-test below feeds it a ratio just under each floor
 * and requires it to throw, so the floor is now itself under test.
 */
function assertPairClearsFloor(sport: string, role: (typeof OVERLAY_PAIR_ROLES)[number], injected?: number): void {
  const p = paletteFor(sport);
  const fg = pairInk(sport, role);
  const bg = p[role.bg];
  const ratio = injected ?? contrastRatio(fg, bg);
  const seen = `${sport} ${role.id}: ${fg} on ${bg} = ${ratio.toFixed(2)}`;
  const exception = OVERLAY_PAIR_EXCEPTIONS.find((e) => e.roleId === role.id && e.sport === sport);
  if (exception) {
    // TWO-SIDED, the shape scorepad/v3/__tests__/contrast.test.ts already uses
    // for hockey's card swatch. A one-sided `>= atLeast` would keep passing if
    // the palette drifted upward and would never tell anyone the exception had
    // ENDED; a skip would say nothing at all.
    expect(ratio, `${seen} (${exception.status} exception, floor ${exception.atLeast})`).toBeGreaterThanOrEqual(
      exception.atLeast,
    );
    expect(ratio, `${seen} (exception ceiling ${exception.below} — delete the exception)`).toBeLessThan(exception.below);
    return;
  }
  expect(ratio, seen).toBeGreaterThanOrEqual(role.floor);
}

/** The alpha sweep's body, extracted for the same reason. */
function assertAlphaClearsFloor(sport: string, role: (typeof OVERLAY_ALPHA_ROLES)[number], injected?: number): void {
  const p = paletteFor(sport);
  const seen = blendOver(p[role.fg], p[role.bg], role.alpha);
  const ratio = injected ?? contrastRatio(seen, p[role.bg]);
  expect(
    ratio,
    `${sport} ${role.id}: ${p[role.fg]} @ ${role.alpha} over ${p[role.bg]} reads ${seen} = ${ratio.toFixed(2)}`,
  ).toBeGreaterThanOrEqual(role.floor);
}

const roleById = (id: string) => {
  const role = OVERLAY_PAIR_ROLES.find((r) => r.id === id);
  expect(role, `no pair role "${id}"`).toBeDefined();
  return role!;
};

describe("every pair role clears its floor for every sport", () => {
  it("the sweep is one row per sport per role, with nothing filtered out", () => {
    // No role is scoped to a subset of sports, so the product is exact. A
    // filter reappearing here — the mechanism that once kept football's 2.56
    // out of the sweep — changes this number.
    expect(pairRows.length).toBe(OVERLAY_SPORT_KEYS.length * OVERLAY_PAIR_ROLES.length);
    expect(OVERLAY_SPORT_KEYS.length).toBe(11);
    expect(OVERLAY_PAIR_ROLES.length).toBe(17);
  });

  it.each(pairRows)("$title", ({ sport, role }) => {
    assertPairClearsFloor(sport, role);
  });

  it("HARNESS SELF-TEST: the sweep's own check refuses a ratio under the floor", () => {
    // The positive pair for every row above. All of them pass, so nothing there
    // can say the floor is still 4.5 (or 3) rather than 1 — the floor is a
    // constant on the assertion side, and a mutant that lowers it leaves the
    // whole sweep green. These cases drive the same function with an injected
    // ratio on both sides of each floor.
    const text = roleById("ink-on-board");
    expect(text.floor).toBe(4.5);
    expect(() => assertPairClearsFloor("cricket", text, 4.49)).toThrow();
    expect(() => assertPairClearsFloor("cricket", text, 4.5)).not.toThrow();

    const ui = roleById("led-on-board");
    expect(ui.floor).toBe(3);
    expect(() => assertPairClearsFloor("cricket", ui, 2.99)).toThrow();
    expect(() => assertPairClearsFloor("cricket", ui, 3)).not.toThrow();

    // The exception branch is two-sided, so BOTH sides must refuse — for the
    // ruled exception and for an unruled one.
    const slab = roleById("slab-ink-on-dismissal");
    expect(() => assertPairClearsFloor("hockey", slab, 2.99)).toThrow();
    expect(() => assertPairClearsFloor("hockey", slab, 4.5)).toThrow();
    expect(() => assertPairClearsFloor("hockey", slab, 4.0)).not.toThrow();

    const dot = roleById("live-dot-on-board-2");
    expect(() => assertPairClearsFloor("hockey", dot, 2.5)).toThrow();
    expect(() => assertPairClearsFloor("hockey", dot, 3)).toThrow();
    expect(() => assertPairClearsFloor("hockey", dot, 2.8)).not.toThrow();

    // …and the alpha sweep's check, same argument.
    const alpha = OVERLAY_ALPHA_ROLES.find((r) => r.id === "ink70-on-board")!;
    expect(alpha.floor).toBe(4.5);
    expect(() => assertAlphaClearsFloor("cricket", alpha, 4.49)).toThrow();
    expect(() => assertAlphaClearsFloor("cricket", alpha, 4.5)).not.toThrow();
  });

  it("the sweep is not vacuous: a pair that CANNOT clear 4.5 is reported under it", () => {
    // Taken from the product rather than invented: `#fff5f5` on hockey's own
    // dismissal is the ink the owner ruling REPLACED, and it is 2.88. If the
    // helper scored this at 4.5 or more, every row above would be meaningless.
    const hockey = paletteFor("hockey");
    const rejected = contrastRatio(OVERLAY_FIXED.slabDismissalInk, hockey.dismissal);
    expect(rejected, `#fff5f5 on hockey dismissal = ${rejected.toFixed(2)}`).toBeLessThan(4.5);
    expect(rejected).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// 3a. The exception table — the ONE mechanism for a pair under its floor.
// ---------------------------------------------------------------------------
describe("exceptions are recorded and two-sided, never narrowed away", () => {
  it("is exactly these three rows, with the two fills COVERED and nothing left unruled", () => {
    // An exception is a licence to miss a floor, so the list is pinned: a
    // fourth row appearing without a sheet change or a ruling is a silent
    // waiver. The STATUS is pinned with it, because the three kinds are not
    // interchangeable — laundering a `covered` row into a `ruled` one would
    // drop the obligation that its covering element keeps existing.
    expect(OVERLAY_PAIR_EXCEPTIONS.map((e) => `${e.status}:${e.sport}/${e.roleId}`).sort()).toEqual([
      "covered:football/dismissal-swatch-on-board-2",
      "covered:hockey/live-dot-on-board-2",
      "ruled:hockey/slab-ink-on-dismissal",
    ]);
    // Nothing is awaiting a decision. A future `unruled` row is a deliberate
    // addition that reddens the pin above, which is the point of keeping the
    // status in the union.
    expect(OVERLAY_PAIR_EXCEPTIONS.filter((e) => e.status === "unruled")).toEqual([]);
  });

  it("a COVERED row names the pair that actually meets the criterion, and that pair clears", () => {
    // `_THEMES.md` §2: covered is "neither a pass nor a waiver" — some OTHER
    // pair is what satisfies WCAG 1.4.11. A `coveredBy` naming a role that does
    // not exist, or one that itself fails for that sport, would make the whole
    // arrangement a waiver wearing a better word.
    const covered = OVERLAY_PAIR_EXCEPTIONS.filter((e) => e.status === "covered");
    expect(covered.length).toBeGreaterThan(0);
    for (const e of covered) {
      expect(e.coveredBy, `${e.sport}/${e.roleId} is covered by nothing`).toBeDefined();
      const carrier = roleById(e.coveredBy!);
      const p = paletteFor(e.sport);
      const ratio = contrastRatio(pairInk(e.sport, carrier), p[carrier.bg]);
      expect(ratio, `${e.sport}: ${e.coveredBy} measures ${ratio.toFixed(2)} — it cannot carry the floor`).toBeGreaterThanOrEqual(
        carrier.floor,
      );
      // The carrier must be measured on the SAME ground as the pair it covers:
      // a boundary drawn somewhere else is not a boundary for this one.
      expect(carrier.bg, `${e.coveredBy} is not on the same ground as ${e.roleId}`).toBe(roleById(e.roleId).bg);
    }
    // A `ruled` row is a different animal and must NOT claim a carrier.
    for (const e of OVERLAY_PAIR_EXCEPTIONS.filter((x) => x.status === "ruled")) {
      expect(e.coveredBy, `${e.sport}/${e.roleId} is ruled, not covered`).toBeUndefined();
    }
  });

  it("the pad's own --sport-board hairline could NOT have carried it (the ruling's argument)", () => {
    // `_THEMES.md` §3: tokens.ts's "boundary carried by the --sport-board
    // hairline, NEVER by the fill" is scoped to the pad's PALE console sheet
    // and does not transfer here. board against board-2 are neighbouring
    // shades by design. Asserted rather than quoted, so a future wave that
    // reaches for the pad's rule finds the number instead of the habit.
    for (const sport of OVERLAY_SPORT_KEYS) {
      const p = paletteFor(sport);
      const ratio = contrastRatio(p.board, p["board-2"]);
      expect(ratio, `${sport}: a board hairline on board-2 measures ${ratio.toFixed(2)}`).toBeLessThan(3);
    }
    // …while the ink hairline the owner picked clears on every one of them.
    for (const sport of OVERLAY_SPORT_KEYS) {
      const p = paletteFor(sport);
      expect(contrastRatio(p.ink, p["board-2"]), `${sport} ink hairline`).toBeGreaterThanOrEqual(3);
    }
  });

  it("every exception names a real role and sport, and cannot license a wider miss than its floor", () => {
    for (const e of OVERLAY_PAIR_EXCEPTIONS) {
      const role = OVERLAY_PAIR_ROLES.find((r) => r.id === e.roleId);
      expect(role, `exception names unknown role ${e.roleId}`).toBeDefined();
      expect(OVERLAY_SPORT_KEYS, `exception names unknown sport ${e.sport}`).toContain(e.sport);
      // The ceiling IS the role's own floor.
      expect(e.below, `${e.roleId} exception ceiling`).toBe(role!.floor);
      expect(e.atLeast).toBeLessThan(e.below);
      expect(e.why.length, `${e.roleId}/${e.sport} has no reason`).toBeGreaterThan(40);
    }
  });

  it("every exception is a REAL miss — the pair genuinely fails its role floor today", () => {
    // An exception whose pair now clears its floor is stale, and a stale
    // exception is a floor that is no longer enforced for that sport. The
    // two-sided `< below` in the sweep says the same thing; this states it as
    // its own claim so the reason is legible.
    for (const e of OVERLAY_PAIR_EXCEPTIONS) {
      const role = roleById(e.roleId);
      const p = paletteFor(e.sport);
      const ratio = contrastRatio(pairInk(e.sport, role), p[role.bg]);
      expect(ratio, `${e.sport}/${e.roleId} measures ${ratio.toFixed(2)} — no longer an exception`).toBeLessThan(
        role.floor,
      );
      expect(ratio, `${e.sport}/${e.roleId} measures ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(e.atLeast);
    }
  });

  it("the two covered misses measure what the ruling says they measure", () => {
    // The numbers the owner ruled on, asserted rather than written down.
    const football = paletteFor("football");
    expect(contrastRatio(football.dismissal, football["board-2"])).toBeCloseTo(2.56, 2);
    const hockey = paletteFor("hockey");
    expect(contrastRatio(OVERLAY_FIXED.liveDot, hockey["board-2"])).toBeCloseTo(2.75, 2);
    // Both are ONE ground, not a systemic failure — the same colours clear on
    // the other ground. `_THEMES.md` §2 records darken-the-band as the live
    // alternative to the hairline, so these two keep their assertion.
    expect(contrastRatio(football.dismissal, football.board)).toBeCloseTo(3.01, 2);
    expect(contrastRatio(OVERLAY_FIXED.liveDot, hockey.board)).toBeCloseTo(3.65, 2);
  });
});

// ---------------------------------------------------------------------------
// 3b. `_THEMES.md` §2's graphical range table (addendum 2026-09-08). Six rows,
//     all on `board-2`, each recording a MIN and a MAX with the sport that
//     holds it. Unlike §2's panel table — whose hexes and ratios both come out
//     of the sheet — this one is a genuine two-authority check: the ranges come
//     from the sheet, the ratios from SPORT_PALETTES. A palette move reds here
//     and says which sport and which direction.
// ---------------------------------------------------------------------------
describe("§2's graphical range table is the range the palettes actually produce", () => {
  /** The colour a §2 graphical row names, for one sport. */
  function rowInk(label: string, sport: string): string | undefined {
    const p = paletteFor(sport);
    if (label.includes("live dot")) return OVERLAY_FIXED.liveDot;
    if (label.includes("--sport-ink")) return p.ink;
    if (label.includes("--sport-board")) return p.board;
    for (const token of ["advisory", "caution", "dismissal"] as const) {
      if (label.includes(`\`${token}\``)) return p[token];
    }
    return undefined;
  }

  const graphicalRows = tableRows(sheetSection("2. Colour"), 3)
    .map((cells) => {
      const m = cells[1]!.replace(/\*/g, "").match(/(\d+\.\d+)\s*\(([a-z]+)\)\s*[–—-]\s*(\d+\.\d+)\s*\(([a-z]+)\)/);
      return m
        ? { label: cells[0]!, min: Number(m[1]), minSport: m[2]!, max: Number(m[3]), maxSport: m[4]! }
        : undefined;
    })
    .filter((r): r is NonNullable<typeof r> => r !== undefined);

  it("has the six rows §2 states, each naming a colour this module knows", () => {
    expect(graphicalRows.length).toBe(6);
    for (const r of graphicalRows) {
      expect(rowInk(r.label, "cricket"), `§2 graphical row "${r.label}" names no colour`).toBeDefined();
      expect(OVERLAY_SPORT_KEYS, `${r.label} min sport`).toContain(r.minSport);
      expect(OVERLAY_SPORT_KEYS, `${r.label} max sport`).toContain(r.maxSport);
    }
  });

  it.each(graphicalRows)("$label — $min ($minSport) to $max ($maxSport)", ({ label, min, minSport, max, maxSport }) => {
    const ratios = OVERLAY_SPORT_KEYS.map((s) => ({
      sport: s,
      ratio: contrastRatio(rowInk(label, s)!, paletteFor(s)["board-2"]),
    }));
    // The NAMED sport's own value, not "whichever sport happens to be lowest" —
    // cricket and generic tie on every inherited row, so an argmin would be
    // deciding a tie the sheet did not.
    expect(ratios.find((r) => r.sport === minSport)!.ratio, `${label} at ${minSport}`).toBeCloseTo(min, 2);
    expect(ratios.find((r) => r.sport === maxSport)!.ratio, `${label} at ${maxSport}`).toBeCloseTo(max, 2);
    // …and they really are the extremes, so the sheet is not quoting a middle.
    for (const r of ratios) {
      expect(r.ratio, `${label}: ${r.sport} is below the recorded min`).toBeGreaterThanOrEqual(min - 0.005);
      expect(r.ratio, `${label}: ${r.sport} is above the recorded max`).toBeLessThanOrEqual(max + 0.005);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Alpha text.
// ---------------------------------------------------------------------------
const alphaRows = OVERLAY_SPORT_KEYS.flatMap((sport) =>
  OVERLAY_ALPHA_ROLES.map((role) => ({ sport, role, title: `${sport} · ${role.id} (${role.where})` })),
);

describe("alpha text is measured as the composite the viewer sees", () => {
  it("the sweep enumerates a row per sport per alpha role", () => {
    expect(alphaRows.length).toBe(OVERLAY_SPORT_KEYS.length * OVERLAY_ALPHA_ROLES.length);
    expect(OVERLAY_ALPHA_ROLES.length).toBe(10);
  });

  it.each(alphaRows)("$title", ({ sport, role }) => {
    assertAlphaClearsFloor(sport, role);
  });

  it("a composite is strictly lower-contrast than the solid ink (the test measures the right thing)", () => {
    for (const sport of OVERLAY_SPORT_KEYS) {
      const p = paletteFor(sport);
      expect(contrastRatio(blendOver(p.ink, p.board, 0.7), p.board), sport).toBeLessThan(contrastRatio(p.ink, p.board));
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The derived slab ink (owner pick 5C, `_THEMES.md` §5).
// ---------------------------------------------------------------------------
describe("the moments slab's dismissal ink is derived per sport, and matches §5's record", () => {
  it("§5 records a row for every one of the eleven sports", () => {
    expect([...sheetSlabTable().keys()].sort()).toEqual([...OVERLAY_SPORT_KEYS].sort());
  });

  it("the light candidate is the one §5 names, read out of the sheet", () => {
    // `_THEMES.md` §5: "whichever of `#fff5f5` and that sport's own
    // `--sport-board` measures the higher WCAG contrast". The sheet is the
    // authority, the export is the mirror, and this proves them equal the way
    // cssVars() proves ROOT_SPORT_DEFAULTS against globals.css.
    const m = sheetSection("5. Moments slab").match(/whichever of `(#[0-9a-f]{6})`/);
    expect(m, "_THEMES.md §5 no longer names the light slab-ink candidate").not.toBeNull();
    expect(OVERLAY_FIXED.slabDismissalInk).toBe(m![1]);
  });

  it.each([...OVERLAY_SPORT_KEYS])("%s picks the higher-contrast of the two candidates", (sport) => {
    const p = paletteFor(sport);
    const light = contrastRatio(OVERLAY_FIXED.slabDismissalInk, p.dismissal);
    const dark = contrastRatio(p.board, p.dismissal);
    const picked = slabDismissalInkFor(sport);
    const pickedRatio = contrastRatio(picked, p.dismissal);
    expect([OVERLAY_FIXED.slabDismissalInk, p.board], `${sport} picked ${picked}`).toContain(picked);
    // The derivation is a MAXIMUM, so the picked ink is at least as good as
    // either candidate — including the one it rejected.
    expect(pickedRatio, `${sport}: picked ${picked} = ${pickedRatio.toFixed(2)}`).toBe(Math.max(light, dark));
  });

  it.each([...OVERLAY_SPORT_KEYS])("%s's derived ink and ratio are the ones §5 records", (sport) => {
    const row = sheetSlabTable().get(sport)!;
    const p = paletteFor(sport);
    // Both directions: the palette the sheet transcribed is the palette the
    // code resolves, and the ink the code derives is the ink the sheet
    // recorded. A drift in either one reds, and says which.
    expect(p.dismissal, `§5 records ${sport}'s dismissal as ${row.dismissal}`).toBe(row.dismissal);
    expect(slabDismissalInkFor(sport), `§5 records ${sport}'s slab ink as ${row.ink}`).toBe(row.ink);
    expect(contrastRatio(row.ink, p.dismissal), `§5 records ${sport} at ${row.ratio}`).toBeCloseTo(row.ratio, 2);
  });

  it("six sports would FAIL 4.5 on the light candidate — that is why the rule is per-sport", () => {
    // The negative assertion's positive pair, and the reason option C exists.
    // If this list ever shrinks to nothing, the derivation has stopped doing
    // any work and the sheet's rule should be revisited, not the test.
    const failsOnLight = OVERLAY_SPORT_KEYS.filter(
      (s) => contrastRatio(OVERLAY_FIXED.slabDismissalInk, paletteFor(s).dismissal) < 4.5,
    );
    expect(failsOnLight.sort()).toEqual(
      ["badminton", "hockey", "icehockey", "tabletennis", "tennis", "volleyball"].sort(),
    );
    for (const s of failsOnLight) expect(slabDismissalInkFor(s)).toBe(paletteFor(s).board);
  });

  it("hockey is the named exception — pinned TWO-SIDED, >= 3.0 AND < 4.5", () => {
    // `_THEMES.md` §5: "Hockey is 4.46 — a named exception, recorded and not
    // waived." The shape is the pad's own hockey pin (scorepad/v3/__tests__/
    // contrast.test.ts): both halves live, so nudging the palette in EITHER
    // direction reds here. A one-sided `>= 3.0` would survive the exception
    // ending, which is the state everyone actually wants to hear about.
    const hockey = paletteFor("hockey");
    const ratio = contrastRatio(slabDismissalInkFor("hockey"), hockey.dismissal);
    expect(slabDismissalInkFor("hockey")).toBe(hockey.board);
    expect(ratio, `hockey slab ink on dismissal = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3.0);
    expect(ratio, `hockey slab ink on dismissal = ${ratio.toFixed(2)} — exception ended, delete it`).toBeLessThan(4.5);
  });

  it("ten of the eleven clear 4.5 outright, so the exception is one row and not a policy", () => {
    const clearing = OVERLAY_SPORT_KEYS.filter(
      (s) => contrastRatio(slabDismissalInkFor(s), paletteFor(s).dismissal) >= 4.5,
    );
    expect(clearing.length).toBe(10);
    expect(clearing).not.toContain("hockey");
  });
});

// ---------------------------------------------------------------------------
// 6. Slate (§4a). The three values are read out of the sheet, not restated.
// ---------------------------------------------------------------------------
describe("slate (§4a) reads on every board, and its values are the sheet's", () => {
  /** `<label>:  … ink NN %` from §4a's own layout block. */
  function slateInkAlpha(label: string): number {
    const m = sheetSection("4a. Theme C").match(new RegExp(`^${label}:\\s+.*?ink\\s+(\\d+)\\s*%`, "m"));
    expect(m, `_THEMES.md §4a no longer states an ink alpha for "${label}"`).not.toBeNull();
    return Number(m![1]) / 100;
  }

  it("the headline is the sport's own ink at full strength (§4a: 'ink 100 %')", () => {
    expect(slateInkAlpha("headline")).toBe(1);
    expect(SLATE_TOKENS.headlineInk).toBe("ink");
  });

  it("the line and brand alphas are §4a's own numbers", () => {
    expect(SLATE_TOKENS.lineInkAlpha).toBe(slateInkAlpha("line"));
    expect(SLATE_TOKENS.brandInkAlpha).toBe(slateInkAlpha("brand"));
    // Differential: the two are DIFFERENT numbers, so a mirror that copied one
    // into both cannot pass.
    expect(SLATE_TOKENS.lineInkAlpha).not.toBe(SLATE_TOKENS.brandInkAlpha);
  });

  it("the indicator is the live dot, and the live dot is what §2 names", () => {
    // `_THEMES.md` §2: "Fixed colours outside the sport set: live dot `#ef4444`".
    const fromTwo = sheetSection("2. Colour").match(/live dot `(#[0-9a-f]{6})`/);
    expect(fromTwo, "_THEMES.md §2 no longer names the live dot").not.toBeNull();
    expect(OVERLAY_FIXED.liveDot).toBe(fromTwo![1]);
    // §4a's signal-lost row uses the same hex — a cross-document relation, not
    // a value restated against itself.
    const fromFourA = sheetSection("4a. Theme C").match(/one 15-px `(#[0-9a-f]{6})` dot/);
    expect(fromFourA, "_THEMES.md §4a no longer names the signal-lost dot").not.toBeNull();
    expect(SLATE_TOKENS.indicator).toBe(fromFourA![1]);
    expect(SLATE_TOKENS.indicator).toBe(OVERLAY_FIXED.liveDot);
  });

  it.each([...OVERLAY_SPORT_KEYS])("%s: headline, line and brand all clear 4.5 on the slate ground", (sport) => {
    // The slate ground IS `--sport-board` (§4a), so every one of these is an
    // ink-on-board pair at the alpha §4a states.
    const p = paletteFor(sport);
    const headline = SLATE_TOKENS.headlineInk === "ink" ? p.ink : SLATE_TOKENS.headlineInk;
    expect(contrastRatio(headline, p.board), `${sport} slate headline`).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(blendOver(p.ink, p.board, SLATE_TOKENS.lineInkAlpha), p.board),
      `${sport} slate line @ ${SLATE_TOKENS.lineInkAlpha}`,
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(blendOver(p.ink, p.board, SLATE_TOKENS.brandInkAlpha), p.board),
      `${sport} slate brand @ ${SLATE_TOKENS.brandInkAlpha}`,
    ).toBeGreaterThanOrEqual(4.5);
  });
});

// ---------------------------------------------------------------------------
// 7. The organiser panel (§8a Phone tab, §8b credits card), whose pairs §2
//    tabulates. Light theme, so none of it is a sport pair — and note what this
//    block does and does NOT prove: the hexes AND the recorded ratios both come
//    out of `_THEMES.md`, so it catches a wrong number written into the sheet
//    (it would have caught the `text-slate-400` 2.63 row before §8a used it),
//    but no mutation of overlay-tokens.ts can red it. It is a DOCUMENT
//    regression, not a proof about this module's code.
// ---------------------------------------------------------------------------
describe("§2's panel pair table is arithmetically true and clears 4.5", () => {
  const panelRows = tableRows(sheetSection("2. Colour"), 3)
    .filter((cells) => hexes(cells[1]!).length === 2 && /\d+\.\d+/.test(cells[2]!))
    .map((cells) => ({
      title: `${cells[0]!} — ${cells[1]!}`,
      fg: hexes(cells[1]!)[0]!,
      bg: hexes(cells[1]!)[1]!,
      recorded: Number(cells[2]!.match(/\d+\.\d+/)![0]),
    }));

  it("the table has every row §2 claims it has (fifteen), and none is malformed", () => {
    expect(panelRows.length).toBe(15);
    for (const r of panelRows) expect(Number.isFinite(r.recorded), r.title).toBe(true);
  });

  it.each(panelRows)("$title", ({ fg, bg, recorded }) => {
    const ratio = contrastRatio(fg, bg);
    expect(ratio, `${fg} on ${bg} computes ${ratio.toFixed(2)}, §2 records ${recorded}`).toBeCloseTo(recorded, 2);
    expect(ratio, `${fg} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  });

  it("the colour §2 REJECTED for the done steps really does fail the floor it declares", () => {
    // §2: "`text-slate-400` … is 2.63:1 on white — it fails the floor this
    // section declares. §8a uses `text-slate-500` instead". The rejected value
    // and its ratio are read out of the same sentence; this is the negative
    // assertion whose positive pair is the fifteen rows above.
    const m = sheetSection("2. Colour").match(/is\s+\*\*(\d+\.\d+):1 on white\*\*[^.]*it fails the floor/);
    expect(m, "_THEMES.md §2 no longer records the rejected done-step ratio").not.toBeNull();
    expect(Number(m![1])).toBeLessThan(4.5);
  });
});
