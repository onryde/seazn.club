// The package doors' four refusals, said in the organiser's own language (spec 2026-11-23-online-chess-credits-design.md §8.1; plan
// Task 11 carry): ONLINE_FORMAT_NOT_SUPPORTED, ONLINE_ROUNDS_NEED_SIZE, ONLINE_ROUNDS_ABOVE_MAX and ONLINE_CAMERAS_NEED_UPGRADE. The
// server's words are English by design, so a screen maps the CODE to dictionary copy (`lib/online-package-refusal.ts`, beside
// `online-entrant-cap-refusal.ts`, the sibling for the entrant cap's three).
//
// The refusals under test are the REAL ones the server's gates build (`formatNotSupported`, `roundsNeedSize`, `roundsAboveMax`,
// `camerasNeedUpgrade`), and each is checked in all four locales against the dictionary's own sentence: a screen that printed the
// server's English `err.message` would fail the comparison in es/fr/nl, and in English too because the expected text is the
// dictionary's, which is deliberately not the server's wording.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ONLINE_PACKAGE_CODES, ONLINE_SIZES, includedRounds } from "@/lib/online-chess-package";
import { LOCALES, type Dict } from "@/lib/i18n-constants";
import { t as tRuntime } from "@/lib/i18n-runtime";
import {
  isOnlinePackageRefusalCode,
  isOnlineSizeRaceCode,
  onlinePackageRefusalText,
  onlineSizeRaceText,
  ONLINE_PACKAGE_REFUSAL_KEYS,
  ONLINE_SIZE_FROZEN_CODE,
  ONLINE_SIZE_PAID_CODE,
  ONLINE_SIZE_RACE_KEYS,
} from "../online-package-refusal";
import { camerasNeedUpgrade, formatNotSupported, roundsAboveMax, roundsNeedSize } from "@/server/usecases/online-package/format";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

const DICTS: Record<(typeof LOCALES)[number], Dict> = { en: en as Dict, es: es as Dict, fr: fr as Dict, nl: nl as Dict };
const say = (dict: Dict) => (key: string, vars: Record<string, string | number>) => tRuntime(dict, key, vars);
/** The refusal as a client holds it (`ApiV1Error`: code and extra). */
const asClient = (e: { code?: string; extra?: unknown }) => ({ code: e.code, extra: (e.extra ?? {}) as Record<string, unknown> });

const MAX_ROUNDS = includedRounds(ONLINE_SIZES.at(-1)!);

describe("onlinePackageRefusalText: the code, in the organiser's language", () => {
  it("ONLINE_FORMAT_NOT_SUPPORTED says the format sentence in every locale, not the server's English", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const err = formatNotSupported("league");
      const text = onlinePackageRefusalText(asClient(err), say(DICTS[locale]));
      expect(text, locale).toBe(tRuntime(DICTS[locale], "onlineChess.format.refused", {}));
      expect(text, locale).not.toBe(err.message);
      checked += 1;
    }
    expect(checked).toBe(4);
    // The English sentence is the spec's: "Online Chess runs Swiss and knockout events."
    expect(onlinePackageRefusalText(asClient(formatNotSupported("group")), say(DICTS.en))).toBe("Online Chess runs Swiss and knockout events.");
  });

  it("ONLINE_FORMAT_NOT_SUPPORTED without a kind (the division does not play online) keeps the server's own words", () => {
    expect(onlinePackageRefusalText(asClient(formatNotSupported(null)), say(DICTS.en))).toBeNull();
  });

  it("ONLINE_ROUNDS_NEED_SIZE offers the next size, from the server's `nextSize`", () => {
    for (const locale of LOCALES) {
      const err = roundsNeedSize(16, 8); // 8 Swiss rounds on a 16: the smallest size that includes 8 is 64
      const text = onlinePackageRefusalText(asClient(err), say(DICTS[locale]));
      expect(text, locale).toBe(tRuntime(DICTS[locale], "onlineChess.roundsNeedSize", { nextSize: 64 }));
      expect(text, locale).toContain("64");
    }
  });

  it("ONLINE_ROUNDS_NEED_SIZE without a next size keeps the server's own words (never a half-filled sentence)", () => {
    expect(onlinePackageRefusalText({ code: ONLINE_PACKAGE_CODES.roundsNeedSize, extra: {} }, say(DICTS.en))).toBeNull();
    expect(onlinePackageRefusalText({ code: ONLINE_PACKAGE_CODES.roundsNeedSize, extra: { nextSize: null } }, say(DICTS.en))).toBeNull();
  });

  it("ONLINE_ROUNDS_ABOVE_MAX names the most any size includes - the leaf's, not a typed 10", () => {
    for (const locale of LOCALES) {
      const text = onlinePackageRefusalText(asClient(roundsAboveMax(11)), say(DICTS[locale]));
      expect(text, locale).toBe(tRuntime(DICTS[locale], "onlineChess.roundsAboveMax", { max: MAX_ROUNDS }));
      expect(text, locale).toContain(String(MAX_ROUNDS));
    }
    expect(MAX_ROUNDS).toBe(10); // P10, typed from the spec: the premise the sentence rests on
  });

  it("ONLINE_CAMERAS_NEED_UPGRADE names every division it lists", () => {
    for (const locale of LOCALES) {
      const one = camerasNeedUpgrade([{ id: "d1", name: "Open", owed: 1 }]);
      expect(onlinePackageRefusalText(asClient(one), say(DICTS[locale])), locale).toBe(tRuntime(DICTS[locale], "onlineChess.camerasNeedUpgrade", { names: "Open" }));
    }
    const two = camerasNeedUpgrade([{ id: "d1", name: "Open", owed: 1 }, { id: "d2", name: "Under 12", owed: 2 }]);
    const text = onlinePackageRefusalText(asClient(two), say(DICTS.en))!;
    expect(text).toContain("Open");
    expect(text).toContain("Under 12");
  });

  it("ONLINE_CAMERAS_NEED_UPGRADE with no division named keeps the server's words", () => {
    expect(onlinePackageRefusalText({ code: ONLINE_PACKAGE_CODES.camerasNeedUpgrade, extra: { divisions: [] } }, say(DICTS.en))).toBeNull();
    expect(onlinePackageRefusalText({ code: ONLINE_PACKAGE_CODES.camerasNeedUpgrade, extra: {} }, say(DICTS.en))).toBeNull();
  });

  it("any other code is not this module's: null, so the caller keeps its own handling", () => {
    for (const code of [undefined, "", "ONLINE_SIZE_FULL", "ONLINE_DIVISION_FULL", "PAYMENT_REQUIRED", ONLINE_PACKAGE_CODES.quoteChanged, ONLINE_PACKAGE_CODES.unpaid]) {
      expect(onlinePackageRefusalText({ code, extra: { nextSize: 32, kind: "league" } }, say(DICTS.en)), String(code)).toBeNull();
    }
  });

  it("the four codes are declared by the leaf, and each has its copy key in every dictionary (sweep)", () => {
    const codes = Object.keys(ONLINE_PACKAGE_REFUSAL_KEYS);
    expect(codes.sort()).toEqual(
      [ONLINE_PACKAGE_CODES.formatNotSupported, ONLINE_PACKAGE_CODES.roundsNeedSize, ONLINE_PACKAGE_CODES.roundsAboveMax, ONLINE_PACKAGE_CODES.camerasNeedUpgrade].sort(),
    );
    let checked = 0;
    for (const locale of LOCALES) {
      for (const key of Object.values(ONLINE_PACKAGE_REFUSAL_KEYS)) {
        expect((DICTS[locale] as Record<string, unknown>)[key], `${locale} ${key}`).toBeTypeOf("string");
        checked += 1;
      }
    }
    expect(checked).toBe(16);
    for (const code of codes) expect(isOnlinePackageRefusalCode(code)).toBe(true);
    expect(isOnlinePackageRefusalCode("ONLINE_SIZE_FULL")).toBe(false);
    expect(isOnlinePackageRefusalCode(undefined)).toBe(false);
  });
});

describe("the two size-write races (T11 fix round 1, review M3): said in the organiser's language, off the code", () => {
  const SERVER_SRC = readFileSync(resolve(__dirname, "../../server/usecases/online-package/size.ts"), "utf8");
  const RACES = [
    { code: ONLINE_SIZE_PAID_CODE, key: "onlineChess.err.sizePaid" },
    { code: ONLINE_SIZE_FROZEN_CODE, key: "onlineChess.err.sizeFrozen" },
  ] as const;

  it("the codes are the ones the server throws (read from its source, so a rename there breaks this), and each maps to its own key", () => {
    for (const r of RACES) {
      expect(SERVER_SRC, `${r.code} is thrown by size.ts`).toContain(`"${r.code}"`);
      expect(ONLINE_SIZE_RACE_KEYS[r.code]).toBe(r.key);
      expect(isOnlineSizeRaceCode(r.code)).toBe(true);
    }
    expect(RACES.length).toBe(2);
  });

  it("every locale: the dictionary's sentence, no open slot, a different sentence per locale, and the two races differ", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      for (const r of RACES) {
        const shown = onlineSizeRaceText({ code: r.code }, say(DICTS[locale]));
        expect(shown, `${locale} ${r.code}`).toBe(DICTS[locale][r.key]);
        expect(shown).not.toMatch(/\{\w+\}/);
        if (locale !== "en") expect(shown, `${locale} ${r.code}: not English`).not.toBe(DICTS.en[r.key]);
        checked += 1;
      }
      expect(onlineSizeRaceText({ code: ONLINE_SIZE_PAID_CODE }, say(DICTS[locale]))).not.toBe(onlineSizeRaceText({ code: ONLINE_SIZE_FROZEN_CODE }, say(DICTS[locale])));
    }
    expect(checked).toBe(LOCALES.length * RACES.length);
  });

  it("any other code, or none, is not a race (the caller keeps its own handling)", () => {
    for (const code of ["ONLINE_ROUNDS_NEED_SIZE", "SOME_OTHER", "ONLINE_SIZE_PAID", "", undefined]) {
      expect(onlineSizeRaceText({ code }, say(DICTS.en)), String(code)).toBeNull();
      expect(isOnlineSizeRaceCode(code)).toBe(false);
    }
  });
});
