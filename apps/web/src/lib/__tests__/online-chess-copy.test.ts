// Online chess copy truth (owner 2026-11-18). Online chess is played on SEAZN'S board; every move goes to a real
// Lichess game that Seazn creates, and Lichess runs the clock, checks each move and records the result. The copy must
// never say the game is played ON Lichess, and never claim Seazn analyses move timing.
//
// Three claims, checked against the four shipped dictionaries (every file in each locale's folder):
//  - the five product sentences are the owner-approved wording VERBATIM in en. Typed here from the ruling, the
//    authority, never read back from the dictionary; es/fr/nl are checked structurally (they name Seazn's board AND
//    Lichess, differ from en, and keep their {division} slot).
//  - a sweep: no string in any locale says games are played on Lichess, and none says "Seazn Hosted Chess" or claims
//    move-timing analysis. The sweep reports how many strings it checked, and each pattern is shown to FIRE on the
//    old wording, so a pattern that matches nothing cannot pass for a clean tree.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCALES, type Dict } from "@/lib/i18n-constants";
import { t as tRuntime } from "@/lib/i18n-runtime";
import { ONLINE_PACKAGE_CODES } from "@/lib/online-chess-package";
import { ONLINE_ENTRANT_CAP_KEYS, onlineEntrantCapText } from "@/components/v2/online-entrant-cap-refusal";
import { ONLINE_PACKAGE_REFUSAL_KEYS, onlinePackageRefusalText } from "@/lib/online-package-refusal";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

type Locale = (typeof LOCALES)[number];
const DICT_ROOT = join(__dirname, "..", "..", "dictionaries");

/** Every dictionary file of a locale, flattened to `file:key -> text` (a new dictionary file is swept without an edit here). */
function load(loc: Locale): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(join(DICT_ROOT, loc)).filter((n) => n.endsWith(".json"))) {
    const json = JSON.parse(readFileSync(join(DICT_ROOT, loc, f), "utf8")) as Record<string, unknown>;
    for (const [k, v] of Object.entries(json)) if (typeof v === "string") out.set(`${f}:${k}`, v);
  }
  return out;
}
const DICTS = Object.fromEntries(LOCALES.map((l) => [l, load(l)])) as Record<Locale, Map<string, string>>;
const get = (loc: Locale, file: string, key: string): string => {
  const v = DICTS[loc].get(`${file}.json:${key}`);
  expect(v, `${loc} ${file}.json ${key}`).toBeTypeOf("string");
  return v!;
};

// The owner's sentences (2026-11-18), verbatim.
const HELP =
  "Players link Lichess in Settings. They play on Seazn's board, and every move goes to a real Lichess game that Seazn creates with this time control. Lichess runs the clock, checks each move and records the result; Seazn flags any move made outside its board.";
const NOTE = "Played on Seazn's board, recorded on Lichess. Entering needs a linked Lichess account.";
const NOTE_NAMED = "{division} is played on Seazn's board, recorded on Lichess. Entering needs a linked Lichess account.";
const DETAILS_ONLINE = "Online — Seazn board, Lichess game";

const PRODUCT_KEYS: readonly { file: string; key: string; en: string }[] = [
  { file: "ui", key: "divset.onlinePlay.help", en: HELP },
  { file: "public", key: "info.onlinePlay.body", en: NOTE },
  { file: "public", key: "info.onlinePlay.named", en: NOTE_NAMED },
  { file: "ui", key: "register.online.lichess", en: NOTE },
  { file: "ui", key: "externalPlay.watch.details.online", en: DETAILS_ONLINE },
  // Spec 2026-11-23 §10.3 (owner-approved, later than the 2026-11-18 ruling): the control's summary leads with the product's name.
  { file: "ui", key: "divset.onlinePlay.summaryOn", en: "Online Chess — Seazn board, Lichess game" },
  { file: "ui", key: "divBuilder.review.lichess", en: DETAILS_ONLINE + ", {control}" },
];

describe("online chess copy: the five product sentences", () => {
  it("en is the owner's wording verbatim", () => {
    for (const p of PRODUCT_KEYS) expect(get("en", p.file, p.key), p.key).toBe(p.en);
  });

  it("every locale says Seazn's board AND Lichess, is its own translation, and keeps the {division} slot where en has it", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      for (const p of PRODUCT_KEYS) {
        const v = get(loc, p.file, p.key);
        expect(v, `${loc} ${p.key}: names Seazn`).toContain("Seazn");
        expect(v, `${loc} ${p.key}: names Lichess`).toContain("Lichess");
        if (loc !== "en") expect(v, `${loc} ${p.key}: translated`).not.toBe(p.en);
        if (p.en.includes("{control}")) expect(v.split("{control}").length - 1, `${loc} ${p.key}: {control} slot`).toBe(1);
        expect(v.split("{division}").length - 1, `${loc} ${p.key}: {division} slot`).toBe(p.en.split("{division}").length - 1);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: 4 locales x 7 sentences").toBe(LOCALES.length * PRODUCT_KEYS.length);
  });
});

/** "Games are played ON Lichess", per locale. The Lichess GAME being aborted / still running on Lichess is true and is
 *  not this claim; only the where-it-is-played sentence is. */
const PLAYED_ON_LICHESS: Record<Locale, RegExp> = {
  en: /\bplay(?:ed|s)?\s+(?:online\s+)?on Lichess\b/i,
  es: /\b(?:se juegan?|jugad[oa]s?)\s+(?:en línea\s+)?en Lichess\b/i,
  fr: /\b(?:se jouent?|jou[ée]s?)\s+(?:en ligne\s+)?sur Lichess\b/i,
  nl: /\b(?:op Lichess gespeeld|gespeeld op Lichess)\b/i,
};
/** Claims the product does not make. ENGLISH-ONLY: es/fr/nl are not swept for these phrases (the played-on-Lichess sweep above is per-locale). */
const NEVER_CLAIMED = /seazn hosted chess|hosted chess|timing integrity|move[- ]timing|timing analysis|analy[sz]es? (?:the )?(?:move )?timing/i;

/** The wording this change replaces: each pattern must fire on it, or the sweep below proves nothing. */
const OLD_WORDING: Record<Locale, string> = {
  en: "games in this division are played on Lichess, and your Lichess account isn't linked to play yet",
  es: "las partidas de esta división se juegan en Lichess y tu cuenta de Lichess aún no está vinculada",
  fr: "les parties de cette division se jouent sur Lichess, et votre compte Lichess n'est pas encore lié",
  nl: "de partijen in deze divisie worden op Lichess gespeeld, en je Lichess-account is nog niet gekoppeld",
};

describe("online chess copy: no string says it is played on Lichess, or claims move-timing analysis", () => {
  it("the patterns fire on the old wording (a pattern that fires on nothing is not a sweep)", () => {
    for (const loc of LOCALES) expect(OLD_WORDING[loc], loc).toMatch(PLAYED_ON_LICHESS[loc]);
    for (const claim of ["Seazn Hosted Chess", "timing integrity checks", "Seazn analyses move timing", "move timing analysis"]) {
      expect(claim, claim).toMatch(NEVER_CLAIMED);
    }
  });

  it("every string of every dictionary file, in every locale", () => {
    let scanned = 0;
    let mentioningLichess = 0;
    for (const loc of LOCALES) {
      let perLocale = 0;
      for (const [id, text] of DICTS[loc]) {
        scanned += 1;
        expect(text, `${loc} ${id}`).not.toMatch(NEVER_CLAIMED);
        if (!/lichess/i.test(text)) continue;
        perLocale += 1;
        mentioningLichess += 1;
        expect(text, `${loc} ${id}`).not.toMatch(PLAYED_ON_LICHESS[loc]);
      }
      expect(perLocale, `anti-vacuity: ${loc} has Lichess strings in the sweep`).toBeGreaterThan(50);
    }
    expect(scanned, "anti-vacuity: strings swept").toBeGreaterThan(4 * 1000);
    expect(mentioningLichess).toBeGreaterThan(4 * 50);
  });

  it("the Lichess-mentioning keys are the same set in every locale (a locale cannot dodge the sweep by dropping a key)", () => {
    const keysOf = (loc: Locale) => [...DICTS[loc]].filter(([, t]) => /lichess/i.test(t)).map(([id]) => id).sort();
    const base = keysOf("en");
    expect(base.length).toBeGreaterThan(50);
    for (const loc of LOCALES) expect(keysOf(loc), loc).toEqual(base);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Online Chess, paid with Seazn credits: the copy (spec 2026-11-23-online-chess-credits-design.md §8, §10.3; Task 13).
//
// Tasks 11 and 12 wrote the strings as they built each screen. This is the coverage that stands behind them: every key in all four
// locales, the proper names the same way in each, no "External Play" in anything an organiser reads, and a verdict for every refusal
// code the package doors answer with. Each sweep reports what it checked and fails on zero.
// ---------------------------------------------------------------------------------------------------------------------
const UI: Record<Locale, Dict> = { en: enUi as Dict, es: esUi as Dict, fr: frUi as Dict, nl: nlUi as Dict };

/** The key families the credits feature owns (plan Task 13 interfaces): `onlineChess.*` (size, price, payLine, receipt, chip, flag,
 *  format, review, refusals, switch-off, ...) and the three credit-history row kinds. */
const PACKAGE_KEY = /^(?:onlineChess\.|settings\.credits\.stream\.kind\.onlinePackage)/;
const packageKeys = (): string[] => Object.keys(UI.en).filter((k) => PACKAGE_KEY.test(k));
const placeholders = (v: string): string[] => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

/** The proper names, as each locale writes them (spec §3 decision 1 and §10.3; the es/fr/nl forms are the ones Tasks 11 and 12 shipped
 *  and the owner saw). Typed here, never read back from the dictionary under test. */
const NAMES: Record<Locale, { game: string; camera: string }> = {
  en: { game: "Online Chess", camera: "Fair-play camera" },
  es: { game: "Ajedrez en línea", camera: "Cámara de juego limpio" },
  fr: { game: "Échecs en ligne", camera: "Caméra fair-play" },
  nl: { game: "Online schaken", camera: "Fairplay-camera" },
};

describe("Online Chess credits copy: every key exists in all four locales", () => {
  /** Strings that read the same in another locale on purpose; each must still BE the same, or it is a stale excuse. */
  const SAME_AS_EN: { key: string; locales: Locale[]; why: string }[] = [
    { key: "onlineChess.size.plan.community", locales: ["es", "fr", "nl"], why: "a plan's brand name is not translated" },
    { key: "onlineChess.size.plan.pro", locales: ["es", "fr", "nl"], why: "a plan's brand name is not translated" },
    { key: "onlineChess.size.plan.enterprise", locales: ["es", "fr", "nl"], why: "a plan's brand name is not translated" },
    { key: "onlineChess.receipt.row.total", locales: ["es", "fr"], why: "'Total' is the same word" },
    { key: "onlineChess.receipt.credits.one", locales: ["nl"], why: "nl writes 'credit' as en does" },
    { key: "onlineChess.receipt.credits.other", locales: ["nl"], why: "nl writes 'credits' as en does" },
    { key: "onlineChess.receipt.size.price.one", locales: ["nl"], why: "nl writes 'credit' as en does" },
    { key: "onlineChess.receipt.size.price.other", locales: ["nl"], why: "nl writes 'credits' as en does" },
  ];

  it("the three credit-history kinds and the key families are all present in en (the sweep has something to sweep)", () => {
    const keys = packageKeys();
    for (const k of ["onlinePackagePaid", "onlinePackageResized", "onlinePackageRefunded"]) {
      expect(keys, k).toContain(`settings.credits.stream.kind.${k}`);
    }
    for (const family of ["size", "price", "payLine", "receipt", "chip", "format"]) {
      expect(keys.filter((k) => k.startsWith(`onlineChess.${family}.`)).length, `family onlineChess.${family}`).toBeGreaterThan(0);
    }
    expect(keys.length, "anti-vacuity: keys swept").toBeGreaterThan(100);
  });

  it("each key is a non-empty string in es, fr and nl, with en's placeholders, and is its own translation", () => {
    const keys = packageKeys();
    let checked = 0;
    const sameUsed = new Set<string>();
    for (const loc of LOCALES) {
      if (loc === "en") continue;
      for (const key of keys) {
        const en = UI.en[key] as string;
        const v = UI[loc][key];
        expect(typeof v, `${loc} ${key}`).toBe("string");
        expect((v as string).trim().length, `${loc} ${key}: empty`).toBeGreaterThan(0);
        expect(placeholders(v as string), `${loc} ${key}: placeholders`).toEqual(placeholders(en));
        const allowed = SAME_AS_EN.find((e) => e.key === key && e.locales.includes(loc));
        if (allowed) {
          // The excuse is that the string IS the same word(s): assert it, or a translation could drift behind a stale excuse.
          expect(v, `${loc} ${key}: excused as the same as English (${allowed.why}), so it must be`).toBe(en);
          sameUsed.add(`${loc} ${key}`);
        } else expect(v, `${loc} ${key}: left in English`).not.toBe(en);
        checked += 1;
      }
    }
    expect(checked, "anti-vacuity: every key in every other locale").toBe(keys.length * (LOCALES.length - 1));
    expect(checked).toBeGreaterThan(40);
    // A stale excuse is one that no longer excuses anything.
    const expected = SAME_AS_EN.flatMap((e) => e.locales.map((l) => `${l} ${e.key}`));
    expect([...sameUsed].sort(), "every same-as-English excuse still holds").toEqual(expected.sort());
  });

  it("no locale has an Online Chess key en lacks (a key nothing reads is a string nobody sees)", () => {
    const en = new Set(packageKeys());
    let checked = 0;
    for (const loc of LOCALES) {
      const own = Object.keys(UI[loc]).filter((k) => PACKAGE_KEY.test(k));
      for (const k of own) expect(en.has(k), `${loc} ${k}`).toBe(true);
      expect(own.length, `${loc}: same key set`).toBe(en.size);
      checked += own.length;
    }
    expect(checked).toBe(en.size * LOCALES.length);
  });
});

describe("Online Chess credits copy: the proper names", () => {
  it("every string that names Online Chess or the Fair-play camera in en does so in each locale's own form, and none keeps the English name", () => {
    const keys = packageKeys();
    let checked = 0;
    for (const loc of LOCALES) {
      let named = 0;
      let camera = 0;
      for (const key of keys) {
        const en = UI.en[key] as string;
        const v = UI[loc][key] as string;
        if (en.includes(NAMES.en.game)) {
          named += 1;
          expect(v.toLowerCase(), `${loc} ${key}: names the feature`).toContain(NAMES[loc].game.toLowerCase());
        }
        if (en.includes(NAMES.en.camera)) {
          camera += 1;
          expect(v.toLowerCase(), `${loc} ${key}: names the camera`).toContain(NAMES[loc].camera.toLowerCase());
        }
        if (loc !== "en") expect(v, `${loc} ${key}: the English name`).not.toMatch(/Online Chess|Fair-play camera/i);
        checked += 1;
      }
      expect(named, `anti-vacuity: ${loc} strings that name the feature`).toBeGreaterThan(15);
      expect(camera, `anti-vacuity: ${loc} strings that name the camera`).toBeGreaterThanOrEqual(3);
    }
    expect(checked).toBe(keys.length * LOCALES.length);
  });

  it("the Online play control's label and its summary say Online Chess (spec §10.3), in every locale", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      for (const key of ["divset.onlinePlay.label", "divset.onlinePlay.summaryOn"]) {
        expect((UI[loc][key] as string).toLowerCase(), `${loc} ${key}`).toContain(NAMES[loc].game.toLowerCase());
        checked += 1;
      }
    }
    expect(checked).toBe(LOCALES.length * 2);
  });

  it("the English summary keeps the owner's 2026-11-18 wording after the name", () => {
    expect(UI.en["divset.onlinePlay.summaryOn"]).toBe("Online Chess — Seazn board, Lichess game");
  });
});

describe("Online Chess credits copy: nothing an organiser reads says External Play", () => {
  /** "External Play" is the internal name of the code path (spec §3 decision 1); each locale's literal rendering of it is swept too. */
  const EXTERNAL_PLAY: Record<Locale, RegExp> = {
    en: /external[ -]play/i,
    es: /juego externo|partida externa/i,
    fr: /jeu externe|partie externe/i,
    nl: /extern(?:e)? spel/i,
  };
  const helpFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? helpFiles(path) : name.endsWith(".md") ? [path] : [];
    });

  it("the patterns fire on the wording they ban (a pattern that fires on nothing is not a sweep)", () => {
    const planted: Record<Locale, string> = {
      en: "Turn on External Play for this division",
      es: "Activa el Juego externo en esta división",
      fr: "Activez le Jeu externe pour cette division",
      nl: "Zet Extern spel aan voor deze divisie",
    };
    for (const loc of LOCALES) expect(planted[loc], loc).toMatch(EXTERNAL_PLAY[loc]);
  });

  it("every string of every dictionary file in every locale, and every English help article", () => {
    let scanned = 0;
    for (const loc of LOCALES) {
      for (const [id, text] of DICTS[loc]) {
        scanned += 1;
        expect(text, `${loc} ${id}`).not.toMatch(EXTERNAL_PLAY[loc]);
      }
    }
    expect(scanned, "anti-vacuity: strings swept").toBeGreaterThan(4 * 1000);
    const helpRoot = join(__dirname, "..", "..", "..", "content", "help");
    const files = helpFiles(helpRoot);
    for (const f of files) expect(readFileSync(f, "utf8"), relative(helpRoot, f)).not.toMatch(EXTERNAL_PLAY.en);
    expect(files.length, "anti-vacuity: help articles swept").toBeGreaterThan(50);
  });
});

describe("Online Chess credits copy: every refusal code has words, in every locale", () => {
  const say = (loc: Locale) => (key: string, vars: Record<string, string | number>) => tRuntime(UI[loc], key, vars);
  const RECEIPT = readFileSync(join(__dirname, "..", "..", "components", "v2", "online-chess", "receipt.tsx"), "utf8");

  /** The verdict for each of the package doors' codes (plan Global Constraints, `ONLINE_PACKAGE_CODES`), typed here: the dictionary key
   *  that says it, and how a screen reaches it. A code with no row is a failure, so a ninth code cannot ship unsaid.
   *   `producer`: the real function the screens call (it maps the code and its `extra` to the sentence);
   *   `receipt`: said by the receipt itself (its short line, its redraw line, its pay-and-open title). */
  const VERDICT: Record<string, { key: string; vars?: Record<string, string | number>; extra?: Record<string, unknown>; via: "entrantCap" | "refusal" | "receipt"; plural?: boolean }> = {
    ONLINE_SIZE_FULL: { key: "onlineChess.sizeFull", vars: { size: 64, nextSize: 128 }, extra: { size: 64, nextSize: 128 }, via: "entrantCap" },
    ONLINE_FORMAT_NOT_SUPPORTED: { key: "onlineChess.format.refused", extra: { kind: "league" }, via: "refusal" },
    ONLINE_ROUNDS_NEED_SIZE: { key: "onlineChess.roundsNeedSize", vars: { nextSize: 64 }, extra: { nextSize: 64 }, via: "refusal" },
    ONLINE_ROUNDS_ABOVE_MAX: { key: "onlineChess.roundsAboveMax", vars: { max: 10 }, extra: {}, via: "refusal" },
    ONLINE_CAMERAS_NEED_UPGRADE: {
      key: "onlineChess.camerasNeedUpgrade", vars: { names: "Open" }, extra: { divisions: [{ id: "d1", name: "Open" }] }, via: "refusal",
    },
    ONLINE_QUOTE_CHANGED: { key: "onlineChess.receipt.changed", via: "receipt" },
    ONLINE_CHESS_NO_CREDITS: { key: "onlineChess.receipt.short", via: "receipt", plural: true },
    ONLINE_CHESS_UNPAID: { key: "onlineChess.receipt.title.payAndOpen", via: "receipt" },
  };

  it("the table has a verdict for exactly the codes the doors answer with, and there are eight of them", () => {
    expect(Object.keys(VERDICT).sort()).toEqual(Object.values(ONLINE_PACKAGE_CODES).sort());
    expect(Object.keys(VERDICT)).toHaveLength(8);
  });

  it("each code reaches its sentence in each locale, through the function the screens use", () => {
    let checked = 0;
    for (const [code, v] of Object.entries(VERDICT)) {
      for (const loc of LOCALES) {
        const keys = v.plural ? [`${v.key}.one`, `${v.key}.other`] : [v.key];
        for (const k of keys) {
          const raw = UI[loc][k];
          expect(typeof raw, `${loc} ${code}: ${k}`).toBe("string");
          expect((raw as string).trim().length, `${loc} ${k}`).toBeGreaterThan(0);
        }
        if (v.via !== "receipt") {
          const err = { code, extra: v.extra };
          const got = v.via === "entrantCap" ? onlineEntrantCapText(err, say(loc)) : onlinePackageRefusalText(err, say(loc));
          const want = tRuntime(UI[loc], v.key, v.vars ?? {});
          expect(got, `${loc} ${code}: the screen's sentence`).toBe(want);
          expect(got, `${loc} ${code}: not an unfilled template`).not.toMatch(/\{\w+\}/);
          if (loc !== "en") expect(got, `${loc} ${code}: not the English sentence`).not.toBe(tRuntime(UI.en, v.key, v.vars ?? {}));
        }
        checked += 1;
      }
      if (v.via === "receipt") {
        expect(RECEIPT, `${code}: the receipt reads ${v.key}`).toContain(`"${v.key}"`);
      }
    }
    expect(checked, "anti-vacuity: 8 codes x 4 locales").toBe(Object.values(ONLINE_PACKAGE_CODES).length * LOCALES.length);
    expect(checked).toBe(32);
  });

  it("the production code-to-key maps agree with the verdicts (a screen re-pointed at another sentence fails here)", () => {
    expect(ONLINE_ENTRANT_CAP_KEYS[ONLINE_PACKAGE_CODES.sizeFull]).toBe(VERDICT.ONLINE_SIZE_FULL!.key);
    for (const [code, key] of Object.entries(ONLINE_PACKAGE_REFUSAL_KEYS)) expect(key, code).toBe(VERDICT[code]!.key);
    expect(Object.keys(ONLINE_PACKAGE_REFUSAL_KEYS)).toHaveLength(4);
  });
});
