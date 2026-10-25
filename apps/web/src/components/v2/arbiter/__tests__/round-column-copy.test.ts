// The Arbiter Panel round column's COPY (spec 2026-10-24-arbiter-round-column-design.md §9, pre-flight C19, plan Task 11): every key the
// column can render exists in all four locales, none of them carries a dash or an arrow, and the list of keys cannot fall behind
// the column. Pure: no DB, no render, the sources are read as text.
//
// What this file guarantees, and what it does not. Three sources feed the sweep, and each is checked against a declaration rather than
// against itself:
//   1. the literals the column's own files pass to msg( / plural( / t( / f.t( - read from the source (a literal that is not in
//      `ROUND_COLUMN_KEYS` fails; a listed key the column stopped asking for only widens the sweep). The files are the directory's own
//      listing, so a new file in components/v2/arbiter/ is scanned without anyone adding it here;
//   2. the calls whose first argument is NOT a literal (a key read out of a map, a variable): a scan cannot know which keys they
//      reach, so every such site is PINNED by its text and tied to the map that supplies it. A new site, a changed one or a lost one
//      fails until the pin is moved on purpose, and the map it names must be inside the two lists;
//   3. the key maps themselves (`INVITE_WORD_KEYS`, `HELD_TITLE_KEYS`, `heldBody`, the open's and the extension's own tables), each
//      required to be a SUBSET of the two lists, so a value added to a map cannot skip the sweep.
// The helper files the column renders through (open-round-control.tsx, checkin-extend-ui.ts, venue-clock.ts, `RoundExtend`, `boardStateWord`,
// `useFmt`'s venue label) are scanned
// both ways. NOT guaranteed: a key reached by a path none of this sees (a helper added outside these files, a key built by string
// concatenation). Every sweep reports how many items it checked, and a count of zero is a failure.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { EXTEND_REFUSAL_KEYS, EXTEND_ROUND_MIXED_WHY_KEY, EXTEND_ROUND_SKIP_COPY, EXTEND_WHY_KEYS } from "@/lib/checkin-extend";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import { INVITE_WORD_KEYS, SEAT_WORD_KEYS } from "@/lib/invite-status";
import {
  OPEN_ROUND_ALREADY_OPEN_KEY,
  OPEN_ROUND_INVITED_KEY,
  OPEN_ROUND_REFUSAL_KEYS,
  OPEN_ROUND_SKIP_KEYS,
  RESEND_REFUSAL_KEYS,
} from "@/lib/open-round";
import { ROUND_COLUMN_HELPER_KEYS, ROUND_COLUMN_KEYS } from "@/lib/round-column";
import { NEEDS_REASONS, SEAT_HOLD_REASONS } from "@/server/external-play/types";
import { HELD_TITLE_KEYS, heldBody } from "../../external-play-held-copy";
import { BANNED, BANNED_RE } from "./_banned-copy";

const DICTS: Record<Locale, Record<string, string>> = { en, es, fr, nl };
const SRC = join(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

// ---- what a key stands for -------------------------------------------------------------------------------------

/** The dictionary entries a key reads in one locale: the key itself, or - for the stem of a plural pair - both of its forms. Null: it
 *  is neither (a typo, or a key that left the dictionary). */
function formsOf(key: string, locale: Locale): string[] | null {
  const d = DICTS[locale];
  if (typeof d[key] === "string") return [key];
  if (typeof d[`${key}.one`] === "string" && typeof d[`${key}.other`] === "string") return [`${key}.one`, `${key}.other`];
  return null;
}

// ---- the sources ------------------------------------------------------------------------------------------------

/** The text between the parentheses of every msg( / plural( / t( call (f.t( and f.plural( included: a word boundary precedes the name).
 *  Parentheses inside a string do not count toward the call's end. */
function callBodies(src: string): string[] {
  const out: string[] = [];
  const call = /\b(?:msg|plural|t)\(/g;
  for (let m = call.exec(src); m !== null; m = call.exec(src)) {
    const start = call.lastIndex;
    let depth = 1;
    let quote: string | null = null;
    let i = start;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i]!;
      if (quote !== null) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

/** Every dictionary-shaped string literal inside the arguments of those calls, including the arms of a ternary. */
function literalsPassed(src: string): string[] {
  return callBodies(src).flatMap((body) => [...body.matchAll(/"([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)"/g)].map((lit) => lit[1]!));
}

/** The first argument of a call body: up to the first comma that is not inside a string or a bracket pair. */
function firstArgument(body: string): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quote !== null) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) return body.slice(0, i).replace(/\s+/g, " ").trim();
  }
  return body.replace(/\s+/g, " ").trim();
}

/** The first arguments that are NOT plain string literals (whitespace collapsed, sorted): `msg(map[reason])`, `t(key as MessageKey)`,
 *  `msg(isWhite ? "a.b" : "c.d")`. A scan of literals cannot see which keys these reach, which is why each is pinned below. A first
 *  argument that is only literals (and the `?` and `:` of a ternary between them) is not listed: `literalsPassed` reads it whole. */
function nonLiteralFirstArguments(src: string): string[] {
  return callBodies(src)
    .map(firstArgument)
    .filter((arg) => arg.replace(/"[^"]*"/g, "").replace(/[\s?:]/g, "") !== "")
    .sort();
}

/** The column's own files: every component file in components/v2/arbiter/, from the directory listing and not from a list typed here. */
const COLUMN_DIR = "components/v2/arbiter";
const COLUMN_FILES = readdirSync(join(SRC, COLUMN_DIR), { withFileTypes: true })
  .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
  .map((e) => `${COLUMN_DIR}/${e.name}`)
  .sort();
const HELPER_FILES = ["components/v2/desk/open-round-control.tsx", "components/v2/checkin-extend-ui.ts", "components/v2/venue-clock.ts"];

/** One function out of a file that holds dozens of keys the column never renders: from its opening to the first line that is a bare `}`. */
function functionBody(rel: string, opening: string): string {
  const src = read(rel);
  const from = src.indexOf(opening);
  expect(from, `premise: ${opening} is in ${rel}`).toBeGreaterThan(-1);
  const to = src.indexOf("\n}\n", from);
  expect(to, `premise: ${opening} ends`).toBeGreaterThan(from);
  return src.slice(from, to);
}
/** `RoundExtend` lives in the panel's file beside dozens of keys the column never renders: only its own function body is read. */
function roundExtendBody(): string {
  const panel = read("components/v2/arbiter-panel.tsx");
  const from = panel.indexOf("function RoundExtend(");
  const to = panel.indexOf("function RequestedNotice(");
  expect(from, "premise: RoundExtend is in arbiter-panel.tsx").toBeGreaterThan(-1);
  expect(to, "premise: RequestedNotice follows RoundExtend").toBeGreaterThan(from);
  return panel.slice(from, to);
}
/** The venue's name after a time of day (Task 16 D1): `arbiter.venueTime` is asked for by `useVenueClock` (venue-clock.ts, scanned whole) and by
 *  `useFmt` in arbiter-flag-cards.tsx, whose other keys (durations, flag words) the column never renders: only its `named` helper is read,
 *  from its declaration to the object `useFmt` returns. */
function venueLabelBody(): string {
  const src = read("components/v2/arbiter-flag-cards.tsx");
  const from = src.indexOf("const named = ");
  const to = src.indexOf("return {", from);
  expect(from, "premise: useFmt has the `named` helper that adds the venue's name").toBeGreaterThan(-1);
  expect(to, "premise: `named` is followed by the object useFmt returns").toBeGreaterThan(from);
  return src.slice(from, to);
}
/** The seven words of a board's state, which the queue's cards draw through `boardStateWord`. */
const boardStateWordBody = () => functionBody("components/v2/arbiter-flag-cards.tsx", "export function boardStateWord(");

// ---- the key maps -----------------------------------------------------------------------------------------------

/** The sentence key of every held card the column can draw: each reason of the engine's own vocabulary, and each seat a seat hold
 *  names (the sweep in external-play-reason-map.test.ts reads them the same way). */
function heldBodyKeys(): string[] {
  const names = { whiteName: "Ada L.", blackName: "Bo M." };
  const out: string[] = [];
  for (const reason of NEEDS_REASONS) {
    const seats = (SEAT_HOLD_REASONS as readonly string[]).includes(reason) ? (["white", "black", "both", null] as const) : ([null] as const);
    for (const revokedSeat of seats) out.push(heldBody({ reason, revokedSeat, ...names }).key);
  }
  return out;
}

const NON_NULL = <T>(xs: readonly (T | null)[]): T[] => xs.filter((x): x is T => x !== null);

/** Each map or table the column reads, with its keys read from the declaration and not typed here. */
const MAPS: Record<string, readonly string[]> = {
  "INVITE_WORD_KEYS": Object.values(INVITE_WORD_KEYS),
  "SEAT_WORD_KEYS": Object.values(SEAT_WORD_KEYS),
  "HELD_TITLE_KEYS": Object.values(HELD_TITLE_KEYS),
  "heldBody (each reason, each revoked seat)": heldBodyKeys(),
  "OPEN_ROUND_REFUSAL_KEYS": Object.values(OPEN_ROUND_REFUSAL_KEYS),
  "OPEN_ROUND_SKIP_KEYS": Object.values(OPEN_ROUND_SKIP_KEYS),
  "OPEN_ROUND_ALREADY_OPEN_KEY and OPEN_ROUND_INVITED_KEY (the open's answers)": [OPEN_ROUND_ALREADY_OPEN_KEY, OPEN_ROUND_INVITED_KEY],
  "RESEND_REFUSAL_KEYS": Object.values(RESEND_REFUSAL_KEYS),
  "EXTEND_WHY_KEYS (the reasons a +5 is not offered)": NON_NULL(Object.values(EXTEND_WHY_KEYS)),
  "EXTEND_ROUND_MIXED_WHY_KEY": [EXTEND_ROUND_MIXED_WHY_KEY],
  "EXTEND_ROUND_SKIP_COPY": Object.values(EXTEND_ROUND_SKIP_COPY),
  "EXTEND_REFUSAL_KEYS": Object.values(EXTEND_REFUSAL_KEYS),
};

/** The extension's copy: what a pass-through `t(key)` in checkin-extend-ui.ts, or the column's shim over it, can be asked for. */
const EXTEND_MAPS = [
  "EXTEND_WHY_KEYS (the reasons a +5 is not offered)",
  "EXTEND_ROUND_MIXED_WHY_KEY",
  "EXTEND_ROUND_SKIP_COPY",
  "EXTEND_REFUSAL_KEYS",
] as const;

/** Every call in the column's files and its helpers whose first argument is not a plain literal, PINNED by its text. `maps` names the
 *  entries of `MAPS` that supply the key (so the keys it can reach are swept); `arms` marks a ternary whose two arms are literals the
 *  literal scan reads whole. A site that is not here, or is here and gone, fails the pin test below. */
type Site = { expr: string; maps?: readonly (keyof typeof MAPS)[]; arms?: true };
const NON_LITERAL_SITES: Record<string, readonly Site[]> = {
  "components/v2/arbiter/round-column.tsx": [
    // WaitingList's `copy.t` shim: it forwards the keys checkin-extend-ui.ts asks for.
    { expr: "key as MessageKey", maps: EXTEND_MAPS },
    { expr: 'colour === "white" ? "arbiter.colour.white" : "arbiter.colour.black"', arms: true },
    { expr: "INVITE_WORD_KEYS[word] as MessageKey", maps: ["INVITE_WORD_KEYS"] },
  ],
  "components/v2/arbiter/round-queue-cards.tsx": [
    { expr: "HELD_TITLE_KEYS[row.reason]", maps: ["HELD_TITLE_KEYS"] },
    { expr: "body.key", maps: ["heldBody (each reason, each revoked seat)"] },
  ],
  "components/v2/desk/open-round-control.tsx": [
    // The reopen/reinvite confirmation's per-seat words (Task 16 D2): the waiting list's words, through the one `seatWords` helper.
    { expr: 'colour === "white" ? "arbiter.colour.white" : "arbiter.colour.black"', arms: true },
    { expr: "SEAT_WORD_KEYS[w] as MessageKey", maps: ["SEAT_WORD_KEYS"] },
    { expr: "OPEN_ROUND_REFUSAL_KEYS[r.reason] as MessageKey", maps: ["OPEN_ROUND_REFUSAL_KEYS"] },
    { expr: "OPEN_ROUND_INVITED_KEY", maps: ["OPEN_ROUND_ALREADY_OPEN_KEY and OPEN_ROUND_INVITED_KEY (the open's answers)"] },
    { expr: "OPEN_ROUND_ALREADY_OPEN_KEY as MessageKey", maps: ["OPEN_ROUND_ALREADY_OPEN_KEY and OPEN_ROUND_INVITED_KEY (the open's answers)"] },
    { expr: "OPEN_ROUND_SKIP_KEYS[s.reason] as MessageKey", maps: ["OPEN_ROUND_SKIP_KEYS"] },
    { expr: "RESEND_REFUSAL_KEYS[n.code] as MessageKey", maps: ["RESEND_REFUSAL_KEYS"] },
  ],
  "components/v2/checkin-extend-ui.ts": [
    { expr: "key", maps: ["EXTEND_WHY_KEYS (the reasons a +5 is not offered)"] }, // extendWhyLine
    { expr: "why.key", maps: ["EXTEND_WHY_KEYS (the reasons a +5 is not offered)", "EXTEND_ROUND_MIXED_WHY_KEY"] }, // roundWhyLine
    { expr: "key", maps: ["EXTEND_ROUND_SKIP_COPY"] }, // extendRoundLines
    { expr: "EXTEND_REFUSAL_KEYS[refusal]", maps: ["EXTEND_REFUSAL_KEYS"] },
  ],
  // The two single functions the column reaches inside bigger files: neither passes a variable.
  "RoundExtend (arbiter-panel.tsx)": [],
  "boardStateWord (arbiter-flag-cards.tsx)": [],
  // Task 16 D1: the venue's name after a time, asked for by a literal in both places.
  "components/v2/venue-clock.ts": [],
  "useFmt's venue label (arbiter-flag-cards.tsx)": [],
};

const LISTED = new Set<string>([...ROUND_COLUMN_KEYS, ...ROUND_COLUMN_HELPER_KEYS]);
/** The whole sweep: both lists and every map's values. Each map is also required to be inside `LISTED` (below), so this union
 *  is not what makes a map covered - it only makes the sweeps below read the maps even if the lists were wrong. */
const SWEPT = [...new Set<string>([...LISTED, ...Object.values(MAPS).flat()])].sort();

describe("the column's copy: premises", () => {
  it("the lists and the maps are not empty (a sweep over nothing is a failure)", () => {
    expect(ROUND_COLUMN_KEYS.length).toBeGreaterThan(0);
    expect(ROUND_COLUMN_HELPER_KEYS.length).toBeGreaterThan(0);
    for (const [name, keys] of Object.entries(MAPS)) expect(keys.length, name).toBeGreaterThan(0);
    expect(SWEPT.length).toBeGreaterThanOrEqual(LISTED.size);
    expect(Object.keys(INVITE_WORD_KEYS).length, "the six invite words").toBe(6);
    expect(NON_NULL(Object.values(EXTEND_WHY_KEYS)).length, "the four reasons a board has, a board that is over says nothing").toBe(4);
  });

  it("the column's files come from the directory: both known components are in it, and nothing but components", () => {
    expect(COLUMN_FILES, "the listing finds the two components the column is made of").toEqual(
      expect.arrayContaining([`${COLUMN_DIR}/round-column.tsx`, `${COLUMN_DIR}/round-queue-cards.tsx`]),
    );
    for (const file of COLUMN_FILES) expect(file, "a component file, not a test or a directory").toMatch(/^components\/v2\/arbiter\/[\w-]+\.tsx?$/);
    expect(Object.keys(NON_LITERAL_SITES), "every file the column is made of has its non-literal calls pinned").toEqual(
      expect.arrayContaining(COLUMN_FILES),
    );
  });

  it("no key is listed twice, and no list holds a key the other list holds", () => {
    expect(new Set(ROUND_COLUMN_KEYS).size, "ROUND_COLUMN_KEYS: no repeats").toBe(ROUND_COLUMN_KEYS.length);
    expect(new Set(ROUND_COLUMN_HELPER_KEYS).size, "ROUND_COLUMN_HELPER_KEYS: no repeats").toBe(ROUND_COLUMN_HELPER_KEYS.length);
    expect(LISTED.size, "the two lists are disjoint").toBe(ROUND_COLUMN_KEYS.length + ROUND_COLUMN_HELPER_KEYS.length);
  });

  it("the dash probe sees every banned character (it is not blind), and passes plain copy", () => {
    for (const ch of BANNED) expect(BANNED_RE.test(`before ${ch} after`), `U+${ch.charCodeAt(0).toString(16)}`).toBe(true);
    expect(BANNED_RE.test("Paired, not opened. Nobody has been invited yet.")).toBe(false);
    expect(BANNED.length).toBe(5);
  });
});

describe("every key the column can render exists in all four locales", () => {
  it("each listed key and each map value resolves, and a plural stem resolves both .one and .other", () => {
    let checked = 0;
    let stems = 0;
    for (const locale of LOCALES) {
      for (const key of SWEPT) {
        const forms = formsOf(key, locale);
        expect(forms, `${locale}: ${key} is a dictionary key or the stem of a plural pair`).not.toBeNull();
        for (const form of forms!) {
          expect(DICTS[locale][form]!.trim().length, `${locale}: ${form} is not blank`).toBeGreaterThan(0);
          checked += 1;
        }
        if (forms!.length === 2) stems += 1;
      }
    }
    expect(checked, "anti-vacuity: entries read").toBeGreaterThanOrEqual(SWEPT.length * LOCALES.length);
    expect(stems, "anti-vacuity: plural stems exist and were read").toBeGreaterThan(0);
  });
});

describe("no dash and no arrow in any locale", () => {
  it("none of the swept entries carries an en dash, an em dash, an arrow or a diagonal arrow (keys x locales, counted)", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      for (const key of SWEPT) {
        for (const form of formsOf(key, locale) ?? []) {
          expect(DICTS[locale][form], `${locale}: ${form}`).not.toMatch(BANNED_RE);
          checked += 1;
        }
      }
    }
    // Counted a second way: the entries per locale are the same in every locale (one, other, or the key), so the total is a multiple.
    expect(checked, "anti-vacuity: entries scanned").toBeGreaterThanOrEqual(SWEPT.length * LOCALES.length);
    expect(checked % LOCALES.length, "the four locales read the same entries").toBe(0);
  });
});

describe("the list cannot fall behind the column", () => {
  it("every literal the column's files (the directory's own listing) pass to msg( / plural( / t( / f.t( is in ROUND_COLUMN_KEYS", () => {
    let checked = 0;
    for (const file of COLUMN_FILES) {
      const literals = literalsPassed(read(file));
      expect(literals.length, `${file}: the scan found literals`).toBeGreaterThan(0);
      for (const key of literals) {
        expect((ROUND_COLUMN_KEYS as readonly string[]).includes(key), `${file}: ${key} is listed in ROUND_COLUMN_KEYS`).toBe(true);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: literals checked").toBeGreaterThanOrEqual(40);
  });

  it("the scan itself catches a key added to the column (a scratch copy with one more literal fails the check)", () => {
    const real = read(COLUMN_FILES[0]!);
    const scratch = `${real}\nconst extra = msg("arbiter.column.notAKeyYet");\nconst plain = f.t("arbiter.column.alsoNew", { n: 1 });\n`;
    const added = literalsPassed(scratch).filter((k) => !literalsPassed(real).includes(k));
    expect(added.sort(), "the two new literals, one through msg( and one through f.t(").toEqual(["arbiter.column.alsoNew", "arbiter.column.notAKeyYet"]);
    for (const k of added) expect((ROUND_COLUMN_KEYS as readonly string[]).includes(k), `${k} would fail the check above`).toBe(false);
    // A literal inside a ternary and a parenthesis inside a string do not hide a key.
    expect(literalsPassed(`msg(c ? "a.b" : "c.d")`)).toEqual(["a.b", "c.d"]);
    expect(literalsPassed(`msg("a.b", { x: "(" }); msg("c.d")`)).toEqual(["a.b", "c.d"]);
  });

  it("every literal the helpers pass is in one of the two lists (open-round-control.tsx, checkin-extend-ui.ts, venue-clock.ts, RoundExtend, boardStateWord, useFmt's venue label)", () => {
    let checked = 0;
    const sources: [string, string][] = [
      ...HELPER_FILES.map((f): [string, string] => [f, read(f)]),
      ["RoundExtend (arbiter-panel.tsx)", roundExtendBody()],
      ["boardStateWord (arbiter-flag-cards.tsx)", boardStateWordBody()],
      ["useFmt's venue label (arbiter-flag-cards.tsx)", venueLabelBody()],
    ];
    for (const [name, src] of sources) {
      const literals = literalsPassed(src);
      expect(literals.length, `${name}: the scan found literals`).toBeGreaterThan(0);
      for (const key of literals) {
        expect(LISTED.has(key), `${name}: ${key} is listed`).toBe(true);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: helper literals checked").toBeGreaterThanOrEqual(30);
  });

  it("every state word boardStateWord can return is listed (the seven arbiter.state.* keys come from the function, not from a typed list)", () => {
    const words = [...new Set(literalsPassed(boardStateWordBody()))].sort();
    expect(words.length, "anti-vacuity: the function names its words").toBeGreaterThanOrEqual(7);
    for (const key of words) expect(LISTED.has(key), `${key} is listed`).toBe(true);
    expect(words.every((k) => k.startsWith("arbiter.state."))).toBe(true);
  });

  it("every key map the column reads is inside the two lists: INVITE_WORD_KEYS, HELD_TITLE_KEYS, heldBody, the open's and the extension's tables", () => {
    let checked = 0;
    for (const [name, keys] of Object.entries(MAPS)) {
      for (const key of keys) {
        expect(LISTED.has(key), `${name}: ${key} is listed`).toBe(true);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: map values checked").toBeGreaterThanOrEqual(60);
    // The two maps the plan names, by name: their values are listed in full.
    expect(Object.values(INVITE_WORD_KEYS).every((k) => LISTED.has(k))).toBe(true);
    expect(Object.values(HELD_TITLE_KEYS).every((k) => LISTED.has(k))).toBe(true);
  });
});

describe("a call whose key is not a literal is pinned, and tied to the map that supplies it", () => {
  const sourceOf = (name: string): string =>
    name.startsWith("RoundExtend")
      ? roundExtendBody()
      : name.startsWith("boardStateWord")
        ? boardStateWordBody()
        : name.startsWith("useFmt")
          ? venueLabelBody()
          : read(name);
  const pinned = (name: string): string[] => NON_LITERAL_SITES[name]!.map((site) => site.expr).sort();

  it("the scanner reads first arguments: a variable, a map read and a ternary are reported; plain literals are not", () => {
    expect(nonLiteralFirstArguments("msg(someNewVar)")).toEqual(["someNewVar"]);
    expect(nonLiteralFirstArguments("f.t(MAP[k] as MessageKey, { x: \"(\" })")).toEqual(["MAP[k] as MessageKey"]);
    expect(nonLiteralFirstArguments('plural(\n  keys.one,\n  n)')).toEqual(["keys.one"]);
    expect(nonLiteralFirstArguments('msg(c ? "a.b" : "c.d")')).toEqual(['c ? "a.b" : "c.d"']);
    expect(nonLiteralFirstArguments('msg("a.b", { x: y }); plural("c.d", n); t(`a.${b}`)').length, "a literal first argument is not reported, a template is").toBe(1);
    expect(nonLiteralFirstArguments('msg("a.b", { x: y }); plural("c.d", n)')).toEqual([]);
  });

  it("each file's non-literal calls are exactly the pinned list (a new one, a changed one or a lost one fails)", () => {
    let files = 0;
    let sites = 0;
    for (const name of Object.keys(NON_LITERAL_SITES)) {
      expect(nonLiteralFirstArguments(sourceOf(name)), `${name}: the calls whose key is not a literal`).toEqual(pinned(name));
      files += 1;
      sites += NON_LITERAL_SITES[name]!.length;
    }
    expect(files, "anti-vacuity: the column's files, the helper files and the three functions").toBe(COLUMN_FILES.length + HELPER_FILES.length + 3);
    expect(sites, "anti-vacuity: sixteen sites are pinned").toBe(16);
  });

  it("a variable key added to the column's file is caught by the pin (a scratch copy with msg(someNewVar) differs from the list)", () => {
    const file = `${COLUMN_DIR}/round-column.tsx`;
    const scratch = `${read(file)}\nconst added = msg(someNewVar);\n`;
    expect(nonLiteralFirstArguments(scratch)).toContain("someNewVar");
    expect(nonLiteralFirstArguments(scratch), "the scratch copy no longer equals the pin").not.toEqual(pinned(file));
  });

  it("every pinned site is accounted for: it names a map that exists, is not empty, and (for a named table) is the table in its text", () => {
    let accounted = 0;
    for (const [name, sites] of Object.entries(NON_LITERAL_SITES)) {
      for (const site of sites) {
        if (site.arms) {
          const arms = literalsPassed(`msg(${site.expr})`);
          expect(arms.length, `${name}: ${site.expr} has literal arms`).toBe(2);
          for (const arm of arms) expect((ROUND_COLUMN_KEYS as readonly string[]).includes(arm), `${name}: ${arm} is listed`).toBe(true);
        } else {
          expect(site.maps?.length ?? 0, `${name}: ${site.expr} names the map that supplies it`).toBeGreaterThan(0);
          for (const map of site.maps!) {
            expect(Object.keys(MAPS), `${name}: ${site.expr} -> ${map}`).toContain(map);
            expect(MAPS[map]!.length, `${map} is not empty`).toBeGreaterThan(0);
          }
          // A call that reads a SCREAMING_SNAKE table by name must be tied to that table, not to an unrelated one.
          for (const ident of site.expr.match(/\b[A-Z][A-Z_]{4,}\b/g) ?? []) {
            expect(site.maps!.some((m) => m.includes(ident)), `${name}: ${site.expr} reads ${ident}, so it names that table`).toBe(true);
          }
        }
        accounted += 1;
      }
    }
    expect(accounted, "anti-vacuity: all sixteen sites accounted for").toBe(16);
  });
});

describe("the invite words never read as opened (A3)", () => {
  // The words say what happened to the MAIL. A seat's invite that was "opened" would be a read receipt, which the product does not track
  // (the owner rejected opened and clicked tracking in the outbox design). Each locale's own stem for "open".
  const OPENED: Record<Locale, RegExp> = { en: /open/i, es: /abiert/i, fr: /ouvert/i, nl: /geopend/i };

  it("the probe sees each locale's word for opened", () => {
    expect(OPENED.en.test("Opened")).toBe(true);
    expect(OPENED.es.test("Abierto")).toBe(true);
    expect(OPENED.fr.test("Ouvert")).toBe(true);
    expect(OPENED.nl.test("Geopend")).toBe(true);
  });

  it("no invite word, and not the help line, says opened - in any locale (4 locales x the words and the help, counted)", () => {
    const keys = [...Object.values(INVITE_WORD_KEYS), "arbiter.invite.help"];
    let checked = 0;
    for (const locale of LOCALES) {
      for (const key of keys) {
        expect(DICTS[locale][key], `${locale}: ${key}`).not.toMatch(OPENED[locale]);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: 4 locales x (6 words + the help line)").toBe(LOCALES.length * 7);
  });
});

describe("the reasons a +5 is not offered say what is off, and not what the clock above them says", () => {
  // The same lines stand where the +5 button would be, on the round bar (the hero, the playing block, the top of the panel) and on a
  // board's decision area. Read cold they must be a sentence about the extension, not a fragment ("Game started").
  const ABOUT_EXTENDING: Record<Locale, RegExp> = { en: /extend/i, es: /ampli/i, fr: /prolong/i, nl: /verleng/i };
  const CAUSES = NON_NULL(Object.values(EXTEND_WHY_KEYS));

  it("every reason, and the mixed one, names the extension in every locale (5 reasons x 4 locales, counted)", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      for (const key of [...CAUSES, EXTEND_ROUND_MIXED_WHY_KEY]) {
        expect(DICTS[locale][key], `${locale}: ${key}`).toMatch(ABOUT_EXTENDING[locale]);
        checked += 1;
      }
    }
    expect(checked).toBe(5 * LOCALES.length);
  });

  it("the four reasons share one lead-in in every locale: the text before the colon is the same, only the cause after it differs", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const parts = CAUSES.map((key) => DICTS[locale][key]!.split(":").map((p) => p.trim()));
      for (const [i, p] of parts.entries()) expect(p.length, `${locale}: ${CAUSES[i]} has one colon (a lead-in and a cause)`).toBe(2);
      const leads = new Set(parts.map((p) => p[0]));
      expect([...leads], `${locale}: one lead-in for ${CAUSES.length} reasons`).toHaveLength(1);
      expect(new Set(parts.map((p) => p[1])).size, `${locale}: the causes differ`).toBe(CAUSES.length);
      checked += parts.length;
    }
    expect(checked).toBe(4 * LOCALES.length);
  });

  it("a reason is never the clock's own label: 'Check-in has closed' stood twice, one line under the other", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const labels = ["arbiter.column.checkin.closed", "arbiter.column.checkin.closesIn", "arbiter.column.checkin.opensIn"].map((k) => DICTS[locale][k]);
      for (const key of CAUSES) {
        expect(labels, `${locale}: ${key} repeats a clock label`).not.toContain(DICTS[locale][key]);
        checked += 1;
      }
    }
    expect(checked).toBe(4 * LOCALES.length);
  });
});

describe("the reopen press says what it does", () => {
  // A round whose every invite failed (press `reopen`) is OPEN already; its press invites everyone again and starts the window now
  // (openRound: kind "reopened"). "Open round" there reads as if the round were not yet open.
  // The verb ("abrir", "ouvrir") and its past participle ("abierta", "ouverte"): a label that says the round IS open names the same
  // wrong action as one that says it is being opened, so the probe has to see both forms (final review m2).
  const OPEN_WORD: Record<Locale, RegExp> = { en: /open/i, es: /abr|abiert/i, fr: /ouvr|ouvert/i, nl: /open/i };

  it("the probe sees the verb AND the participle in every locale (so a participle in a label cannot slip past it)", () => {
    // Words typed here, from the languages themselves - not read from the dictionaries or from the probe under test.
    const SAMPLES: Record<Locale, { verb: string; participle: string; unrelated: string }> = {
      en: { verb: "Open round", participle: "The round is open", unrelated: "Invite again and restart check-in" },
      es: { verb: "Abrir ronda", participle: "La ronda esta abierta", unrelated: "Invitar de nuevo y reiniciar el registro" },
      fr: { verb: "Ouvrir la ronde", participle: "La ronde est ouverte", unrelated: "Inviter de nouveau et relancer l'enregistrement" },
      nl: { verb: "Ronde openen", participle: "De ronde is open", unrelated: "Nodig opnieuw uit en herstart de check-in" },
    };
    let checked = 0;
    for (const locale of LOCALES) {
      const s = SAMPLES[locale];
      expect(s.verb, `${locale}: the verb`).toMatch(OPEN_WORD[locale]);
      expect(s.participle, `${locale}: the participle`).toMatch(OPEN_WORD[locale]);
      expect(s.unrelated, `${locale}: a restart is not an open`).not.toMatch(OPEN_WORD[locale]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: locales checked").toBe(LOCALES.length);
  });

  it("it has a label of its own, which is not the real Open round press and does not say open (4 locales)", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const reopen = DICTS[locale]["arbiter.column.reopenCta"];
      expect(reopen, `${locale}: the key exists`).toBeTruthy();
      expect(reopen, `${locale}: not the Open round label`).not.toBe(DICTS[locale]["runsheet.round.openCta"]);
      expect(reopen, `${locale}: does not say the round is being opened`).not.toMatch(OPEN_WORD[locale]);
      checked += 1;
    }
    expect(checked).toBe(LOCALES.length);
    expect(DICTS.en["runsheet.round.openCta"], "premise: the real press keeps its label").toBe("Open round");
  });

  // An action keeps one name through the flow: the press, the confirmation's title and the confirmation's button say the SAME thing
  // ("restart check-in"), and none of them is the first-time open's wording ("Open Round 2 again?" under a button that did not say open).
  const RESTART: Record<Locale, RegExp> = { en: /restart check-in/i, es: /reinici/i, fr: /relanc/i, nl: /herstart/i };

  it("the press, the confirmation's title and both forms of its button all name the restart (4 locales x 4 strings, counted)", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const d = DICTS[locale];
      for (const key of ["arbiter.column.reopenCta", "arbiter.column.reopenConfirmTitle", "arbiter.column.reopenConfirmCta.one", "arbiter.column.reopenConfirmCta.other"]) {
        expect(d[key], `${locale}: ${key} exists`).toBeTruthy();
        expect(d[key], `${locale}: ${key} names the restart`).toMatch(RESTART[locale]);
        expect(d[key], `${locale}: ${key} does not say the round is being opened`).not.toMatch(OPEN_WORD[locale]);
        checked += 1;
      }
    }
    expect(checked).toBe(LOCALES.length * 4);
  });

  it("the status card's waiting clause uses the press's own words: it says RESTART check-in in both forms, not reopen, and is not the on-hold line (4 locales x 2 forms, counted)", () => {
    // One action keeps one name through the flow. The clause says what the press below it will do, in the press's own verb (restart
    // check-in; es reiniciar el registro, fr relancer l'enregistrement, nl herstarten): a clause that said "reopen" would name the same
    // action twice, and one that borrowed the on-hold words means something else.
    let checked = 0;
    for (const locale of LOCALES) {
      const d = DICTS[locale];
      for (const form of ["one", "other"] as const) {
        const text = d[`arbiter.column.waitingToRestart.${form}`];
        expect(text, `${locale}: ${form} exists`).toBeTruthy();
        expect(text, `${locale}: ${form} carries the count`).toContain("{count}");
        expect(text, `${locale}: ${form} names the restart`).toMatch(RESTART[locale]);
        expect(text, `${locale}: ${form} does not say reopen`).not.toMatch(OPEN_WORD[locale]);
        expect(text, `${locale}: ${form} is not the on-hold line`).not.toBe(d[`arbiter.column.onHold.${form}`]);
        checked += 1;
      }
      expect(d["arbiter.column.waitingToRestart.one"], `${locale}: the two forms differ`).not.toBe(d["arbiter.column.waitingToRestart.other"]);
    }
    expect(checked, "anti-vacuity: locales x forms").toBe(LOCALES.length * 2);
    expect((ROUND_COLUMN_KEYS as readonly string[]).includes("arbiter.column.waitingToRestart"), "the sweep lists the stem").toBe(true);
  });

  it("the confirmation is not the first-time open's: another title, another button, and the title still names the round", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const d = DICTS[locale];
      expect(d["arbiter.column.reopenConfirmTitle"], `${locale}: title`).not.toBe(d["runsheet.round.confirmTitle"]);
      expect(d["arbiter.column.reopenConfirmCta.one"], `${locale}: button, one`).not.toBe(d["runsheet.round.confirmCta.one"]);
      expect(d["arbiter.column.reopenConfirmCta.other"], `${locale}: button, other`).not.toBe(d["runsheet.round.confirmCta.other"]);
      expect(d["arbiter.column.reopenConfirmTitle"], `${locale}: the title keeps {round}`).toContain("{round}");
      expect(d["arbiter.column.reopenConfirmCta.one"], `${locale}: the button keeps {count}`).toContain("{count}");
      expect(d["arbiter.column.reopenConfirmCta.other"], `${locale}: the button keeps {count}`).toContain("{count}");
      checked += 1;
    }
    expect(checked).toBe(LOCALES.length);
    // The first-time open keeps its own wording: it IS opening the round.
    expect(DICTS.en["runsheet.round.confirmTitle"]).toBe("Open Round {round}?");
    expect(DICTS.en["runsheet.round.confirmCta.other"]).toBe("Open round and invite {count} players");
  });
});
