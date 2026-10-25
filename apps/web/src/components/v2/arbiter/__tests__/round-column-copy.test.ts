// The Arbiter Panel round column's COPY (spec 2026-10-24-arbiter-round-column-design.md §9, pre-flight C19, plan Task 11): every key the
// column can render exists in all four locales, none of them carries a dash or an arrow, and the list of keys cannot fall behind
// the column. Pure: no DB, no render, the sources are read as text.
//
// Three sources feed the sweep, and each is checked against a declaration rather than against itself:
//   1. the literals the column's own files pass to msg( / plural( / t( / f.t( - read from the source, ONE way (a literal that is not in
//      `ROUND_COLUMN_KEYS` fails; a listed key the column stopped asking for only widens the sweep);
//   2. the key maps the column reads (`INVITE_WORD_KEYS`, `HELD_TITLE_KEYS`, `heldBody`, the open's and the extension's own tables), each
//      required to be a SUBSET of the two lists, so a value added to a map cannot skip the sweep;
//   3. the helper files the column renders through (open-round-control.tsx, checkin-extend-ui.ts, `RoundExtend`), scanned the same way.
// Every sweep reports how many items it checked, and a count of zero is a failure.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { EXTEND_REFUSAL_KEYS, EXTEND_ROUND_MIXED_WHY_KEY, EXTEND_ROUND_SKIP_COPY, EXTEND_WHY_KEYS } from "@/lib/checkin-extend";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import { INVITE_WORD_KEYS } from "@/lib/invite-status";
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

const DICTS: Record<Locale, Record<string, string>> = { en, es, fr, nl };
const SRC = join(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

// Built from code points, not typed: `\u` in a source edit is mangled by tooling here. En dash, em dash, the two arrows, the diagonal.
const BANNED = [0x2013, 0x2014, 0x2192, 0x2190, 0x2197].map((c) => String.fromCharCode(c));
const DASH = new RegExp(`[${BANNED.join("")}]`);

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

/** Every dictionary-shaped string literal inside the arguments of a msg( / plural( / t( call (f.t( and f.plural( included: a word
 *  boundary precedes the name), including the arms of a ternary. Parentheses inside a string do not count toward the call's end. */
function literalsPassed(src: string): string[] {
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
    for (const lit of src.slice(start, i - 1).matchAll(/"([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)"/g)) out.push(lit[1]!);
  }
  return out;
}

const COLUMN_FILES = ["components/v2/arbiter/round-column.tsx", "components/v2/arbiter/round-queue-cards.tsx"];
const HELPER_FILES = ["components/v2/desk/open-round-control.tsx", "components/v2/checkin-extend-ui.ts"];
/** `RoundExtend` lives in the panel's file beside dozens of keys the column never renders: only its own function body is read. */
function roundExtendBody(): string {
  const panel = read("components/v2/arbiter-panel.tsx");
  const from = panel.indexOf("function RoundExtend(");
  const to = panel.indexOf("function RequestedNotice(");
  expect(from, "premise: RoundExtend is in arbiter-panel.tsx").toBeGreaterThan(-1);
  expect(to, "premise: RequestedNotice follows RoundExtend").toBeGreaterThan(from);
  return panel.slice(from, to);
}

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
  "HELD_TITLE_KEYS": Object.values(HELD_TITLE_KEYS),
  "heldBody (each reason, each revoked seat)": heldBodyKeys(),
  "OPEN_ROUND_REFUSAL_KEYS": Object.values(OPEN_ROUND_REFUSAL_KEYS),
  "OPEN_ROUND_SKIP_KEYS": Object.values(OPEN_ROUND_SKIP_KEYS),
  "the open's answers (already open, invited)": [OPEN_ROUND_ALREADY_OPEN_KEY, OPEN_ROUND_INVITED_KEY],
  "RESEND_REFUSAL_KEYS": Object.values(RESEND_REFUSAL_KEYS),
  "EXTEND_WHY_KEYS (the reasons a +5 is not offered)": NON_NULL(Object.values(EXTEND_WHY_KEYS)),
  "EXTEND_ROUND_MIXED_WHY_KEY": [EXTEND_ROUND_MIXED_WHY_KEY],
  "EXTEND_ROUND_SKIP_COPY": Object.values(EXTEND_ROUND_SKIP_COPY),
  "EXTEND_REFUSAL_KEYS": Object.values(EXTEND_REFUSAL_KEYS),
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

  it("no key is listed twice, and no list holds a key the other list holds", () => {
    expect(new Set(ROUND_COLUMN_KEYS).size, "ROUND_COLUMN_KEYS: no repeats").toBe(ROUND_COLUMN_KEYS.length);
    expect(new Set(ROUND_COLUMN_HELPER_KEYS).size, "ROUND_COLUMN_HELPER_KEYS: no repeats").toBe(ROUND_COLUMN_HELPER_KEYS.length);
    expect(LISTED.size, "the two lists are disjoint").toBe(ROUND_COLUMN_KEYS.length + ROUND_COLUMN_HELPER_KEYS.length);
  });

  it("the dash probe sees every banned character (it is not blind), and passes plain copy", () => {
    for (const ch of BANNED) expect(DASH.test(`before ${ch} after`), `U+${ch.charCodeAt(0).toString(16)}`).toBe(true);
    expect(DASH.test("Paired, not opened. Nobody has been invited yet.")).toBe(false);
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
          expect(DICTS[locale][form], `${locale}: ${form}`).not.toMatch(DASH);
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
  it("every literal the column's two files pass to msg( / plural( / t( / f.t( is in ROUND_COLUMN_KEYS", () => {
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

  it("every literal the helpers pass is in one of the two lists (open-round-control.tsx, checkin-extend-ui.ts, RoundExtend)", () => {
    let checked = 0;
    const sources: [string, string][] = [...HELPER_FILES.map((f): [string, string] => [f, read(f)]), ["RoundExtend (arbiter-panel.tsx)", roundExtendBody()]];
    for (const [name, src] of sources) {
      const literals = literalsPassed(src);
      expect(literals.length, `${name}: the scan found literals`).toBeGreaterThan(0);
      for (const key of literals) {
        expect(LISTED.has(key), `${name}: ${key} is listed`).toBe(true);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: helper literals checked").toBeGreaterThanOrEqual(25);
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
  const OPEN_WORD: Record<Locale, RegExp> = { en: /open/i, es: /abr/i, fr: /ouvr/i, nl: /open/i };

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
});
