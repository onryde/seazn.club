// The overlay's colour gate (spec §4.2, `_THEMES.md` §2, §4a, §5). Five claims,
// and every one of them is a comparison between TWO authorities rather than an
// assertion about a constant — a fixture on both ends proves the fixture.
//
//  1. ROOT_SPORT_DEFAULTS in overlay-tokens.ts is EXACTLY what app/globals.css's
//     `:root { --sport-* }` block resolves to. globals.css is the authority
//     (the pad's own sport-theme.ts says the same); this file's typed mirror
//     exists so a test can iterate it, and this claim is what keeps the mirror
//     honest. `var(--x)` and `var(--x, fallback)` are resolved against the same
//     stylesheet.
//  2. The overlay renders the same ELEVEN sports the pad's skin registry names
//     (`V3_SKINS`), not the NINE `SPORT_PALETTES` happens to hold — that table
//     is OVERRIDES ONLY (sport-theme.ts's own header), so cricket and generic
//     have no entry at all and boardgame and carrom omit `caution`/`dismissal`.
//     A sweep driven off `Object.keys(SPORT_PALETTES)` is silently short by
//     four, and the four it misses include cricket, whose OUT slab is the
//     dismissal tone's headline use (`_THEMES.md` §2, "Eleven sports, not nine").
//  3. Every pair ROLE the overlay paints clears its floor for every sport that
//     paints it — the per-sport values come from SPORT_PALETTES, never typed
//     here. One sample is not a parity sweep; this is the whole table.
//  4. Alpha text (ink at 50 %, 65 %, 70 %, 75 %, 85 %, 92 % — `_THEMES.md` §2,
//     §3, §4, §4a) is measured as the COMPOSITE the viewer sees, not as the
//     solid ink.
//  5. The moments slab's `dismissal` ink is DERIVED per sport (owner pick 5C,
//     2026-09-08) and the derivation reproduces the eleven rows `_THEMES.md` §5
//     records. Hockey's 4.46 is a named exception, pinned TWO-SIDED so the
//     exception's end is asserted as well as its floor.
//
// A red row is a FINDING for the sheet, never a lowered floor.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SPORT_PALETTES, SPORT_TOKENS } from "@/components/v2/scorepad/v3/sport-theme";
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
// Authority readers. Each one PARSES the document that owns the fact, so the
// export is compared against the source rather than against itself.
// ---------------------------------------------------------------------------

/** `--name: value;` declarations from globals.css, first occurrence wins
 *  (the :root block declares each once; later media/theme blocks are not the
 *  default). `var(--x, fb)` resolves through the same map, falling back to
 *  `fb` when `--x` is undeclared (which is how `--sport-led` reaches #9ae600:
 *  `--color-lime-400` is Tailwind's, not globals.css's). */
function cssVars(): Map<string, string> {
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
  const vars = new Map<string, string>();
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    if (!vars.has(m[1]!)) vars.set(m[1]!, m[2]!.trim());
  }
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

const SHEET_PATH = join(process.cwd(), "../../docs/superpowers/specs/2026-09-05-stream-overlay-prompts/_THEMES.md");
const SHEET = readFileSync(SHEET_PATH, "utf8");

/** The text of one `## <heading>` section of `_THEMES.md`, up to the next one. */
function sheetSection(heading: string): string {
  const start = SHEET.indexOf(`\n## ${heading}`);
  expect(start, `_THEMES.md has no "## ${heading}" section`).toBeGreaterThanOrEqual(0);
  const end = SHEET.indexOf("\n## ", start + 1);
  return SHEET.slice(start, end < 0 ? undefined : end);
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
 *  source of truth" — so it is used to CROSS-CHECK the derivation, in both
 *  directions, never as the value the derivation is copied from. */
function sheetSlabTable(): Map<string, { dismissal: string; ink: string; ratio: number }> {
  const out = new Map<string, { dismissal: string; ink: string; ratio: number }>();
  for (const cells of tableRows(sheetSection("5. Moments slab"), 4)) {
    const sport = cells[0]!;
    if (!OVERLAY_SPORT_KEYS.includes(sport)) continue;
    const dismissal = hexes(cells[1]!);
    const ink = hexes(cells[2]!);
    const ratio = cells[3]!.match(/\d+\.\d+/);
    expect(dismissal.length, `§5 row "${sport}" names no dismissal hex`).toBe(1);
    expect(ink.length, `§5 row "${sport}" names no slab-ink hex`).toBeGreaterThanOrEqual(1);
    expect(ratio, `§5 row "${sport}" names no ratio`).not.toBeNull();
    // The board-picked rows read "`--sport-board` `#06323c`": the LAST hex in
    // the cell is the colour, the token name is the reason.
    out.set(sport, { dismissal: dismissal[0]!, ink: ink[ink.length - 1]!, ratio: Number(ratio![0]) });
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

  it("every sport resolves a palette naming all SEVEN tokens, each a 6-digit hex", () => {
    for (const sport of OVERLAY_SPORT_KEYS) {
      const p = paletteFor(sport);
      expect(Object.keys(p).sort(), `${sport} palette keys`).toEqual([...SPORT_TOKENS].sort());
      for (const token of SPORT_TOKENS) {
        expect(p[token], `${sport}.${token}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("the table IS the scope — these exact pairs are gated, by id", () => {
    // `_THEMES.md` §2: "The table is the scope: EVERY pair the picks introduce
    // is in it." A count alone cannot say that — nine rows minus one is still
    // "at least eight" — so a deleted or renamed row would slip through every
    // other assertion in this file. This pins WHICH pairs are gated; what each
    // one measures is still derived from the palette, never from here.
    expect([...OVERLAY_PAIR_ROLES].map((r) => r.id).sort()).toEqual([
      "board-on-advisory",
      "board-on-caution",
      "board-on-led-headline",
      "board-on-led-line",
      "dismissal-on-board",
      "dismissal-on-board-2",
      "ink-on-board",
      "ink-on-board-2",
      "led-on-board",
      "led-on-board-2",
      "slab-ink-on-dismissal",
    ]);
    expect([...OVERLAY_ALPHA_ROLES].map((r) => r.id).sort()).toEqual([
      "ink50-on-board",
      "ink50-on-board-2",
      "ink65-on-board",
      "ink65-on-board-2",
      "ink70-on-board",
      "ink70-on-board-2",
      "ink75-on-board",
      "ink75-on-board-2",
      "ink85-on-board",
      "ink92-on-board",
    ]);
  });

  it("no role id repeats, and every role names a real token and a real floor", () => {
    const ids = [...OVERLAY_PAIR_ROLES, ...OVERLAY_ALPHA_ROLES].map((r) => r.id);
    expect(new Set(ids).size, "duplicate role id").toBe(ids.length);
    for (const role of OVERLAY_PAIR_ROLES) {
      expect(SPORT_TOKENS).toContain(role.bg);
      expect([4.5, 3]).toContain(role.floor);
      expect(role.where.length, `${role.id} has no "where"`).toBeGreaterThan(0);
    }
    for (const role of OVERLAY_ALPHA_ROLES) {
      expect(SPORT_TOKENS).toContain(role.fg);
      expect(SPORT_TOKENS).toContain(role.bg);
      expect(role.alpha).toBeGreaterThan(0);
      expect(role.alpha).toBeLessThan(1);
    }
  });

  it("a role scoped to a subset of sports names a NON-EMPTY subset of the eleven", () => {
    // A `sports` list is how a pair only one sport paints stays in the table
    // without reddening ten sports that never paint it. A typo'd key would
    // empty the row instead — the same vacuous green this block opens on.
    for (const role of OVERLAY_PAIR_ROLES) {
      if (role.sports === "all") continue;
      expect(role.sports.length, `${role.id} is scoped to no sport at all`).toBeGreaterThan(0);
      for (const s of role.sports) expect(OVERLAY_SPORT_KEYS, `${role.id} names unknown sport ${s}`).toContain(s);
    }
  });
});

// ---------------------------------------------------------------------------
// 1. The mirror.
// ---------------------------------------------------------------------------
describe("ROOT_SPORT_DEFAULTS mirrors globals.css :root exactly", () => {
  const vars = cssVars();

  it.each([...SPORT_TOKENS])("--sport-%s", (token) => {
    expect(ROOT_SPORT_DEFAULTS[token]).toBe(resolveVar(vars, `--sport-${token}`));
  });

  it("the mirror has no token globals.css lacks, and vice versa", () => {
    const declared = [...vars.keys()]
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
    expect(resolveVar(vars, "--sport-board")).toMatch(/^#[0-9a-f]{6}$/);
    expect(resolveVar(vars, "--sport-led")).toMatch(/^#[0-9a-f]{6}$/);
  });
});

// ---------------------------------------------------------------------------
// 2. Which sports exist.
// ---------------------------------------------------------------------------
describe("OVERLAY_SPORT_KEYS is the pad's ELEVEN, not SPORT_PALETTES' nine", () => {
  it("is exactly the sport keys the pad's skin registry names (one authority)", () => {
    // V3_SKINS (scorepad/v3/registry.ts) is the working list of eleven keys.
    // Derived from it, never typed here — a twelfth skin reddens this until
    // OVERLAY_SPORT_KEYS covers it.
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
  OVERLAY_PAIR_ROLES.filter((role) => role.sports === "all" || role.sports.includes(sport)).map((role) => ({
    sport,
    role,
    title: `${sport} · ${role.id} (${role.where})`,
  })),
);

function pairInk(sport: string, role: (typeof OVERLAY_PAIR_ROLES)[number]): string {
  const p = paletteFor(sport);
  return role.fg === "slabDismissalInk" ? slabDismissalInkFor(sport) : p[role.fg];
}

/**
 * The sweep's own body, extracted so a HARNESS SELF-TEST can drive it with an
 * injected ratio. Without that, the sweep's floor is a test-side constant no
 * assertion can see: replacing `role.floor` with `1` here leaves all 121 rows
 * green and every other test in this file untouched — a measured survivor
 * before this function existed. The self-test below feeds it a ratio just under
 * each floor and requires it to throw, so the floor is now itself under test.
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
    expect(ratio, `${seen} (exception floor ${exception.atLeast})`).toBeGreaterThanOrEqual(exception.atLeast);
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

describe("every pair role clears its floor for every sport that paints it", () => {
  it("the sweep enumerates a row per sport per applicable role, and there are many", () => {
    // Pins the SHAPE of the product so a filter bug (or an emptied role list)
    // cannot shrink the sweep into a quiet green. Ten roles apply to all
    // eleven sports and one is scoped to cricket alone.
    const expected = OVERLAY_SPORT_KEYS.reduce(
      (n, sport) => n + OVERLAY_PAIR_ROLES.filter((r) => r.sports === "all" || r.sports.includes(sport)).length,
      0,
    );
    expect(pairRows.length).toBe(expected);
    expect(pairRows.length).toBeGreaterThanOrEqual(OVERLAY_SPORT_KEYS.length * 8);
  });

  it.each(pairRows)("$title", ({ sport, role }) => {
    assertPairClearsFloor(sport, role);
  });

  it("HARNESS SELF-TEST: the sweep's own check refuses a ratio under the floor", () => {
    // The positive pair for all 121 rows above. Every one of them passes, so
    // nothing there can say the floor is still 4.5 (or 3) rather than 1 — the
    // floor is a constant on the assertion side, and a mutant that lowers it
    // leaves the whole sweep green. These four cases drive the same function
    // with an injected ratio on both sides of each floor.
    const text = roleById("ink-on-board");
    expect(text.floor).toBe(4.5);
    expect(() => assertPairClearsFloor("cricket", text, 4.49)).toThrow();
    expect(() => assertPairClearsFloor("cricket", text, 4.5)).not.toThrow();

    const ui = roleById("led-on-board");
    expect(ui.floor).toBe(3);
    expect(() => assertPairClearsFloor("cricket", ui, 2.99)).toThrow();
    expect(() => assertPairClearsFloor("cricket", ui, 3)).not.toThrow();

    // The exception branch is two-sided, so BOTH sides must refuse.
    const slab = roleById("slab-ink-on-dismissal");
    expect(() => assertPairClearsFloor("hockey", slab, 2.99)).toThrow();
    expect(() => assertPairClearsFloor("hockey", slab, 4.5)).toThrow();
    expect(() => assertPairClearsFloor("hockey", slab, 4.0)).not.toThrow();

    // …and the alpha sweep's check, same argument.
    const alpha = OVERLAY_ALPHA_ROLES.find((r) => r.id === "ink70-on-board")!;
    expect(alpha.floor).toBe(4.5);
    expect(() => assertAlphaClearsFloor("cricket", alpha, 4.49)).toThrow();
    expect(() => assertAlphaClearsFloor("cricket", alpha, 4.5)).not.toThrow();
  });

  it("the sweep is not vacuous: a pair that CANNOT clear 4.5 is reported under it", () => {
    // The positive pair for the assertion above, taken from the product rather
    // than invented: `#fff5f5` on hockey's own dismissal is the ink the owner
    // ruling REPLACED, and it is 2.88. If the helper scored this at 4.5 or
    // more, every row above would be meaningless.
    const hockey = paletteFor("hockey");
    const rejected = contrastRatio(OVERLAY_FIXED.slabDismissalInk, hockey.dismissal);
    expect(rejected, `#fff5f5 on hockey dismissal = ${rejected.toFixed(2)}`).toBeLessThan(4.5);
    expect(rejected).toBeGreaterThan(1);
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
    expect(alphaRows.length).toBeGreaterThan(0);
  });

  it.each(alphaRows)("$title", ({ sport, role }) => {
    assertAlphaClearsFloor(sport, role);
  });

  it("a composite is strictly lower-contrast than the solid ink (the test measures the right thing)", () => {
    for (const sport of OVERLAY_SPORT_KEYS) {
      const p = paletteFor(sport);
      expect(contrastRatio(blendOver(p.ink, p.board, 0.7), p.board), sport).toBeLessThan(
        contrastRatio(p.ink, p.board),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The derived slab ink (owner pick 5C, `_THEMES.md` §5).
// ---------------------------------------------------------------------------
describe("the moments slab's dismissal ink is derived per sport, and matches §5's record", () => {
  const sheetTable = sheetSlabTable();

  it("§5 records a row for every one of the eleven sports", () => {
    expect([...sheetTable.keys()].sort()).toEqual([...OVERLAY_SPORT_KEYS].sort());
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
    const row = sheetTable.get(sport)!;
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

  it("the exception table names hockey's slab row and nothing else", () => {
    // An exception is a licence to miss a floor, so the list is pinned: a
    // second row appearing without a sheet change is a silent waiver.
    expect(OVERLAY_PAIR_EXCEPTIONS.map((e) => `${e.sport}/${e.roleId}`)).toEqual(["hockey/slab-ink-on-dismissal"]);
    for (const e of OVERLAY_PAIR_EXCEPTIONS) {
      const role = OVERLAY_PAIR_ROLES.find((r) => r.id === e.roleId);
      expect(role, `exception names unknown role ${e.roleId}`).toBeDefined();
      expect(OVERLAY_SPORT_KEYS).toContain(e.sport);
      // The ceiling IS the role's own floor — an exception may not quietly
      // license a wider miss than the floor it excuses.
      expect(e.below, `${e.roleId} exception ceiling`).toBe(role!.floor);
      expect(e.atLeast).toBeLessThan(e.below);
      expect(e.why.length).toBeGreaterThan(0);
    }
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
  const slate = sheetSection("4a. Theme C");

  /** `<label>:  … ink NN %` from §4a's own layout block. */
  function slateInkAlpha(label: string): number {
    const m = slate.match(new RegExp(`^${label}:\\s+.*?ink\\s+(\\d+)\\s*%`, "m"));
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
    const fromFourA = slate.match(/one 15-px `(#[0-9a-f]{6})` dot/);
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
    // The warming indicator is three `--sport-led` dots on that ground: a
    // graphical object, so the 3:1 UI floor (WCAG 1.4.11).
    expect(contrastRatio(p.led, p.board), `${sport} slate warming dots`).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// 7. The organiser panel (§8a Phone tab, §8b credits card), whose pairs §2
//    tabulates. Light theme, so none of it is a sport pair — but §2 states the
//    same 4.5 floor for every pair the T1 picks introduce, and the table is
//    declared to BE the scope. This block recomputes the sheet's own
//    arithmetic: the hexes and the ratios both come out of §2, so a row whose
//    recorded number is wrong reds here rather than at a reviewer's eye.
// ---------------------------------------------------------------------------
describe("§2's panel pair table is arithmetically true and clears 4.5", () => {
  const panelRows = tableRows(sheetSection("2. Colour"), 3)
    .filter((cells) => hexes(cells[1]!).length === 2)
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
