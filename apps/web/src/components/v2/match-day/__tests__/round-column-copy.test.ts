// The round column's COPY (spec 2026-10-24-arbiter-round-column-design.md §9, pre-flight C19, plan Task 11): every key the
// column can render exists in all four locales, none of them carries a dash or an arrow, and the list of keys cannot fall behind
// the column. Pure: no DB, no render, the sources are read as text.
//
// MOVED to Match Day (Match Day all-in-one, Task 10): the Arbiter page and its `components/v2/arbiter/` column were retired into Match
// Day's round and board panels (`match-day/round-focus.tsx`, `match-day/board-focus.tsx`), which render the column's words now. The sweep
// is kept whole, re-pointed at those files; deleting the old directory did not delete it.
//
// What this file guarantees, and what it does not. Three sources feed the sweep, and each is checked against a declaration rather than
// against itself:
//   1. the literals the column's own files pass to msg( / plural( / t( / f.t( - read from the source (a literal that is not in
//      `ROUND_COLUMN_KEYS` fails; a listed key the column stopped asking for only widens the sweep). The files are the two Match Day
//      panels (`COLUMN_FILES`), and a third Match Day file that passes one of the column's own words (`arbiter.column.*`,
//      `runsheet.round.*`) fails until it is added, so the list cannot fall behind the directory;
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
import { EXTEND_REFUSAL_KEYS, EXTEND_ROUND_SKIP_COPY } from "@/lib/checkin-extend";
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

/** The column's own files, now Match Day's two online panels: the round panel (the check-in hero, the waiting list, the playing status,
 *  the open-round block, the round's own press - the bodies that were `round-column.tsx`) and the board panel (the held reason, the seat
 *  words, the decision). Both are scanned both ways: a literal they pass is listed, a variable key stays pinned. */
const COLUMN_DIR = "components/v2/match-day";
const COLUMN_FILES = [`${COLUMN_DIR}/round-focus.tsx`, `${COLUMN_DIR}/board-focus.tsx`];
const HELPER_FILES = [
  "components/v2/desk/open-round-control.tsx",
  "components/v2/checkin-extend-ui.ts",
  "components/v2/venue-clock.ts",
];

/** Every source file under Match Day's component directory (top level and `online/`), from the directory listing: the drift guard's
 *  universe, so a new file is looked at without anyone adding it to a list typed here. */
function matchDayFiles(): string[] {
  const out: string[] = [];
  for (const dir of [COLUMN_DIR, `${COLUMN_DIR}/online`]) {
    for (const e of readdirSync(join(SRC, dir), { withFileTypes: true })) {
      if (e.isFile() && /\.tsx?$/.test(e.name)) out.push(`${dir}/${e.name}`);
    }
  }
  return out.sort();
}

/** One function out of a file that holds dozens of keys the column never renders: from its opening to the first line that is a bare `}`. */
function functionBody(rel: string, opening: string): string {
  const src = read(rel);
  const from = src.indexOf(opening);
  expect(from, `premise: ${opening} is in ${rel}`).toBeGreaterThan(-1);
  const to = src.indexOf("\n}\n", from);
  expect(to, `premise: ${opening} ends`).toBeGreaterThan(from);
  return src.slice(from, to);
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

/** The values of `SUMMARY_CHIP` (board-focus.tsx), read from its declaration: the chip a flag wears for a reader who is not an editor. */
function summaryChipKeys(): string[] {
  const src = read("components/v2/match-day/board-focus.tsx");
  const from = src.indexOf("const SUMMARY_CHIP");
  expect(from, "premise: board-focus.tsx declares SUMMARY_CHIP").toBeGreaterThan(-1);
  const body = src.slice(src.indexOf("= {", from), src.indexOf("\n};", from));
  return [...body.matchAll(/:\s*"([A-Za-z][A-Za-z0-9.]+)"/g)].map((m) => m[1]!);
}

/** Each map or table the column reads, with its keys read from the declaration and not typed here. */
const MAPS: Record<string, readonly string[]> = {
  "SUMMARY_CHIP (board-focus.tsx, a viewer's flag chips)": summaryChipKeys(),
  "INVITE_WORD_KEYS": Object.values(INVITE_WORD_KEYS),
  "SEAT_WORD_KEYS": Object.values(SEAT_WORD_KEYS),
  "HELD_TITLE_KEYS": Object.values(HELD_TITLE_KEYS),
  "heldBody (each reason, each revoked seat)": heldBodyKeys(),
  "OPEN_ROUND_REFUSAL_KEYS": Object.values(OPEN_ROUND_REFUSAL_KEYS),
  "OPEN_ROUND_SKIP_KEYS": Object.values(OPEN_ROUND_SKIP_KEYS),
  "OPEN_ROUND_ALREADY_OPEN_KEY and OPEN_ROUND_INVITED_KEY (the open's answers)": [OPEN_ROUND_ALREADY_OPEN_KEY, OPEN_ROUND_INVITED_KEY],
  "RESEND_REFUSAL_KEYS": Object.values(RESEND_REFUSAL_KEYS),
  "EXTEND_ROUND_SKIP_COPY": Object.values(EXTEND_ROUND_SKIP_COPY),
  "EXTEND_REFUSAL_KEYS": Object.values(EXTEND_REFUSAL_KEYS),
};

/** The extension's copy: what a pass-through `t(key)` in checkin-extend-ui.ts, or the column's shim over it, can be asked for. */
const EXTEND_MAPS = [
  "EXTEND_ROUND_SKIP_COPY",
  "EXTEND_REFUSAL_KEYS",
] as const;

/** Every call in the column's files and its helpers whose first argument is not a plain literal, PINNED by its text. `maps` names the
 *  entries of `MAPS` that supply the key (so the keys it can reach are swept); `arms` marks a ternary whose arms (that many) are literals the
 *  literal scan reads whole. A site that is not here, or is here and gone, fails the pin test below. */
type Site = { expr: string; maps?: readonly (keyof typeof MAPS)[]; arms?: number };
const NON_LITERAL_SITES: Record<string, readonly Site[]> = {
  "components/v2/match-day/round-focus.tsx": [
    // WaitingList's `copy.t` shim and the panel's `extendCopyOf`: both forward the keys checkin-extend-ui.ts asks for.
    { expr: "key as MessageKey", maps: EXTEND_MAPS },
    { expr: "key as MessageKey", maps: EXTEND_MAPS },
    { expr: 'colour === "white" ? "arbiter.colour.white" : "arbiter.colour.black"', arms: 2 },
    { expr: "INVITE_WORD_KEYS[word] as MessageKey", maps: ["INVITE_WORD_KEYS"] },
    // The link-hold block: each held board's reason, and the window's own word when it has run out (MD-R2/R22) - the open's skip words.
    { expr: "OPEN_ROUND_SKIP_KEYS[reason] as MessageKey", maps: ["OPEN_ROUND_SKIP_KEYS"] },
    { expr: "OPEN_ROUND_SKIP_KEYS.window_closed as MessageKey", maps: ["OPEN_ROUND_SKIP_KEYS"] },
  ],
  // The board panel: the held reason's chip and sentence (a link hold or a held board), the seat words, the viewer's flag chips and the
  // ternaries that pick between listed words (the colour, the state line, the flags lede, the camera switch).
  "components/v2/match-day/board-focus.tsx": [
    { expr: "HELD_TITLE_KEYS[holdReason]", maps: ["HELD_TITLE_KEYS"] },
    { expr: "holdBody.key", maps: ["heldBody (each reason, each revoked seat)"] },
    { expr: "SEAT_WORD_KEYS[w]", maps: ["SEAT_WORD_KEYS"] },
    { expr: "SUMMARY_CHIP[flag.kind]", maps: ["SUMMARY_CHIP (board-focus.tsx, a viewer's flag chips)"] },
    { expr: 'colour === "white" ? "arbiter.colour.white" : "arbiter.colour.black"', arms: 2 },
    { expr: 'editor ? "arbiter.flags.lede" : "matchDay.board.flagsViewer"', arms: 2 },
    {
      expr: 'boardIsOver(board.state) ? "externalPlay.room.board.final" : position.turn === "white" ? "externalPlay.room.board.whiteToMove" : "externalPlay.room.board.blackToMove"',
      arms: 3,
    },
    { expr: 'mode === "cameras" ? "matchDay.cameras.viewCameras" : "matchDay.cameras.viewBoard"', arms: 2 },
  ],
  "components/v2/desk/open-round-control.tsx": [
    // The reopen/reinvite confirmation's per-seat words (Task 16 D2): the waiting list's words, through the one `seatWords` helper.
    { expr: 'colour === "white" ? "arbiter.colour.white" : "arbiter.colour.black"', arms: 2 },
    { expr: "SEAT_WORD_KEYS[w] as MessageKey", maps: ["SEAT_WORD_KEYS"] },
    { expr: "OPEN_ROUND_REFUSAL_KEYS[r.reason] as MessageKey", maps: ["OPEN_ROUND_REFUSAL_KEYS"] },
    { expr: "OPEN_ROUND_INVITED_KEY", maps: ["OPEN_ROUND_ALREADY_OPEN_KEY and OPEN_ROUND_INVITED_KEY (the open's answers)"] },
    { expr: "OPEN_ROUND_ALREADY_OPEN_KEY as MessageKey", maps: ["OPEN_ROUND_ALREADY_OPEN_KEY and OPEN_ROUND_INVITED_KEY (the open's answers)"] },
    { expr: "OPEN_ROUND_SKIP_KEYS[s.reason] as MessageKey", maps: ["OPEN_ROUND_SKIP_KEYS"] },
    { expr: "RESEND_REFUSAL_KEYS[n.code] as MessageKey", maps: ["RESEND_REFUSAL_KEYS"] },
  ],
  "components/v2/checkin-extend-ui.ts": [
    { expr: "key", maps: ["EXTEND_ROUND_SKIP_COPY"] }, // extendRoundLines
    { expr: "EXTEND_REFUSAL_KEYS[refusal]", maps: ["EXTEND_REFUSAL_KEYS"] },
  ],
  // The two single functions the column reaches inside bigger files: neither passes a variable.
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
  });

  it("the column's files are the two Match Day panels, each exists, and each has its non-literal calls pinned", () => {
    const listing = matchDayFiles();
    expect(listing.length, "anti-vacuity: the directory listing found Match Day's files").toBeGreaterThan(10);
    for (const file of COLUMN_FILES) {
      expect(listing, `${file} is in Match Day's directory`).toContain(file);
      expect(read(file).length, `${file} is not empty`).toBeGreaterThan(0);
    }
    expect(Object.keys(NON_LITERAL_SITES), "every file the column is made of has its non-literal calls pinned").toEqual(
      expect.arrayContaining(COLUMN_FILES),
    );
  });

  it("no Match Day file outside the column's files passes one of the column's own words (the list cannot fall behind the directory)", () => {
    // The column's own vocabulary: the round column's keys (`arbiter.column.*`) and the open-round block's (`runsheet.round.*`).
    const OWN = /^(?:arbiter\.column\.|runsheet\.round\.)/;
    const known = new Set<string>([...COLUMN_FILES, ...HELPER_FILES]);
    let scanned = 0;
    let rendering = 0;
    for (const file of matchDayFiles()) {
      const own = literalsPassed(read(file)).filter((k) => OWN.test(k));
      scanned += 1;
      if (own.length > 0) rendering += 1;
      if (own.length > 0) expect(known.has(file), `${file} passes the column's words (${[...new Set(own)].slice(0, 3).join(", ")}) but is not scanned: add it to COLUMN_FILES`).toBe(true);
    }
    expect(scanned, "anti-vacuity: Match Day files scanned").toBeGreaterThan(10);
    expect(rendering, "anti-vacuity: the two panels render the column's words, so the guard saw them").toBeGreaterThanOrEqual(2);
    // The guard is not blind: a scratch file that asks for a column key outside the known set trips it.
    expect(literalsPassed('const x = msg("arbiter.column.here");').some((k) => OWN.test(k))).toBe(true);
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
  it("every literal the column's files (the round panel and the board panel) pass to msg( / plural( / t( / f.t( is in one of the two lists", () => {
    let checked = 0;
    const missing: string[] = [];
    for (const file of COLUMN_FILES) {
      const literals = literalsPassed(read(file));
      expect(literals.length, `${file}: the scan found literals`).toBeGreaterThan(0);
      for (const key of literals) {
        if (!LISTED.has(key)) missing.push(`${file}: ${key}`);
        checked += 1;
      }
    }
    expect([...new Set(missing)].sort().join("\n"), "literals the panels ask for that no list names (add each to ROUND_COLUMN_KEYS)").toBe("");
    expect(checked, "anti-vacuity: literals checked (85 measured when the sweep moved to Match Day's panels: 65 + 20)").toBeGreaterThanOrEqual(85);
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

  it("every literal the helpers pass is in one of the two lists (open-round-control.tsx, checkin-extend-ui.ts, venue-clock.ts, boardStateWord, useFmt's venue label)", () => {
    let checked = 0;
    const sources: [string, string][] = [
      ...HELPER_FILES.map((f): [string, string] => [f, read(f)]),
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
    expect(checked, "anti-vacuity: helper literals checked (53 measured once the panels left the helper list)").toBeGreaterThanOrEqual(53);
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
    expect(checked, "anti-vacuity: map values checked (78 measured at B1: the five reasons' keys left the maps)").toBeGreaterThanOrEqual(78);
    // The two maps the plan names, by name: their values are listed in full.
    expect(Object.values(INVITE_WORD_KEYS).every((k) => LISTED.has(k))).toBe(true);
    expect(Object.values(HELD_TITLE_KEYS).every((k) => LISTED.has(k))).toBe(true);
  });
});

describe("a call whose key is not a literal is pinned, and tied to the map that supplies it", () => {
  const sourceOf = (name: string): string =>
    name.startsWith("boardStateWord") ? boardStateWordBody() : name.startsWith("useFmt") ? venueLabelBody() : read(name);
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
    expect(files, "anti-vacuity: the column's files, the helper files and the two functions").toBe(COLUMN_FILES.length + HELPER_FILES.length + 2);
    expect(sites, "anti-vacuity: twenty-three sites are pinned (15 + the board panel's 8; B1 deleted the two reason helpers' calls)").toBe(23);
  });

  it("a variable key added to the column's file is caught by the pin (a scratch copy with msg(someNewVar) differs from the list)", () => {
    const file = `${COLUMN_DIR}/board-focus.tsx`;
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
          expect(arms.length, `${name}: ${site.expr} has literal arms`).toBe(site.arms);
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
    expect(accounted, "anti-vacuity: all twenty-three sites accounted for").toBe(23);
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
