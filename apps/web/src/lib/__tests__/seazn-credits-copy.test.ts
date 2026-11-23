// The credits a club spends on match streams are called "Seazn credits" (owner ruling 2026-11-23). Before that the
// copy called them "match credits", "streaming credits" and "stream credits", and each locale had its own pair of
// equivalents. This guard reads every value in the four locale dictionaries and every English help article (title and
// description included, since front matter ships as the page title) and refuses any of the old names.
//
// The brand word stays untranslated in every locale; "credits" is translated. The packs are named in credits, not
// matches, and the line under "Buy Seazn credits" says what one credit buys TODAY: one match stream, capped at the relay's
// own MAX_DURATION_MINUTES.
//
// No help page is excluded: an exclusion here would outlive its reason silently (review of #1290, I1).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STREAM_CREDIT_PACKS } from "@/lib/stream-credit-packs";
import { MAX_DURATION_MINUTES } from "@/server/relay/config";

const DICT_ROOT = fileURLToPath(new URL("../../dictionaries/", import.meta.url));
const HELP_ROOT = fileURLToPath(new URL("../../../content/help/", import.meta.url));

type Locale = "en" | "es" | "fr" | "nl";
const LOCALES: readonly Locale[] = ["en", "es", "fr", "nl"];

/** The retired names, per locale, as they stood in the dictionaries on 2026-11-23. English also catches the hyphenated
 *  adjective ("a match-credit pack"), but not the help SLUG `billing/match-credits`, which is a URL, not copy. */
const OLD_NAME: Record<Locale, RegExp> = {
  en: /(?<![/\w-])match[- ]credits?\b|(?<![/\w-])stream(?:ing)?[- ]credits?\b/i,
  es: /\bcr[ée]ditos? de (?:partido|retransmisi[oó]n|emisi[oó]n)\b/i,
  fr: /\bcr[ée]dits? de (?:match|diffusion)\b/i,
  // nl's stream panel said "tegoed" before 2026-11-23. Bounded, so "accounttegoed" and "AI-credittegoed" stay legal.
  nl: /wedstrijdcredits?|streamingcredits?|\btegoed(?:en)?\b/i,
};

/** The new name, per locale: the brand untranslated, "credit" translated. */
const NEW_NAME: Record<Locale, RegExp> = {
  en: /\bSeazn credits?\b/,
  es: /\b[Cc]r[ée]ditos? Seazn\b/,
  fr: /\b[Cc]r[ée]dits? Seazn\b/,
  nl: /\bSeazn-credits?\b/,
};

/** The word a pack is counted in, singular and plural. */
const CREDIT_WORD: Record<Locale, readonly [string, string]> = {
  en: ["credit", "credits"],
  es: ["crédito", "créditos"],
  fr: ["crédit", "crédits"],
  nl: ["credit", "credits"],
};

/** The retired "1 match = 1 credit" line, in every locale. */
const OLD_LINE = /^1 (?:match|partido|wedstrijd) = 1 /i;

function dictionary(locale: Locale): Map<string, string> {
  const out = new Map<string, string>();
  const dir = join(DICT_ROOT, locale);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out.set(`${file.replace(/\.json$/, "")}:${key}`, value);
    }
  }
  return out;
}

function helpFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return helpFiles(path);
    return name.endsWith(".md") ? [path] : [];
  });
}

describe("Seazn credits: the retired names are gone from the dictionaries", () => {
  for (const locale of LOCALES) {
    it(`${locale}: no dictionary value uses a retired name (counted)`, () => {
      const dict = dictionary(locale);
      const hits = [...dict].filter(([, v]) => OLD_NAME[locale].test(v)).map(([k, v]) => `${k}: ${v}`);
      console.info(`seazn-credits ${locale}: ${dict.size} dictionary values checked, ${hits.length} retired names`);
      expect(dict.size, `anti-vacuity: ${locale} dictionary values were read`).toBeGreaterThan(1000);
      expect(hits).toEqual([]);
    });
  }

  for (const locale of LOCALES) {
    it(`${locale}: the stream credit strings use the new name (the positive half)`, () => {
      const dict = dictionary(locale);
      const named = [
        "ui:stream.credits.title",
        "ui:settings.credits.stream.title",
        "ui:settings.nav.streamCreditsLeft",
        "ui:stream.error.no_credits",
        "marketing:pricing.streams.perMonth.other",
        "marketing:pricing.streams.passGrant.other",
        "marketing:product.streaming.ticket.kicker",
        "emails:staffDisputeAlert.kind.streamCredits",
      ];
      const missing = named.filter((k) => !NEW_NAME[locale].test(dict.get(k) ?? ""));
      console.info(`seazn-credits ${locale}: ${named.length} named strings checked for the new name`);
      expect(missing.map((k) => `${k}: ${dict.get(k) ?? "(absent)"}`)).toEqual([]);
    });

    it(`${locale}: each pack is named in credits, with its own count from STREAM_CREDIT_PACKS`, () => {
      const dict = dictionary(locale);
      const [one, many] = CREDIT_WORD[locale];
      const wrong = STREAM_CREDIT_PACKS.map((p) => {
        const label = dict.get(`ui:${p.labelKey}`) ?? "(absent)";
        return label === `${p.credits} ${p.credits === 1 ? one : many}` ? null : `${p.labelKey}: ${label}`;
      }).filter((x) => x !== null);
      console.info(`seazn-credits ${locale}: ${STREAM_CREDIT_PACKS.length} pack labels checked`);
      expect(STREAM_CREDIT_PACKS.length, "anti-vacuity: packs were read").toBeGreaterThan(0);
      expect(wrong).toEqual([]);
    });

    it(`${locale}: the line under the packs says 1 credit buys 1 match stream, capped at the relay's duration`, () => {
      const line = dictionary(locale).get("ui:stream.credits.line") ?? "";
      const hours = MAX_DURATION_MINUTES / 60;
      expect(Number.isInteger(hours), "the relay cap is a whole number of hours, as the line says").toBe(true);
      expect(line, "the retired '1 match = 1 credit' order").not.toMatch(OLD_LINE);
      expect(line.startsWith(`1 ${CREDIT_WORD[locale][0]} = 1 `), `${locale}: credit first — ${line}`).toBe(true);
      expect(line, `${locale}: the relay cap in hours — ${line}`).toMatch(new RegExp(`\\b${hours}\\b`));
    });
  }

  it("en: the line is the owner's wording, word for word", () => {
    expect(dictionary("en").get("ui:stream.credits.line")).toBe(
      `1 credit = 1 match stream, up to ${MAX_DURATION_MINUTES / 60} hours.`,
    );
  });
});

describe("Seazn credits: the retired names are gone from help", () => {
  it("no English help article uses a retired name, front matter included (counted, none excluded)", () => {
    const files = helpFiles(HELP_ROOT);
    let checked = 0;
    let lines = 0;
    const hits: string[] = [];
    for (const file of files) {
      const rel = relative(HELP_ROOT, file).split("\\").join("/");
      checked++;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((text, i) => {
          lines++;
          if (OLD_NAME.en.test(text) || OLD_LINE.test(text.trim())) hits.push(`${rel}:${i + 1}: ${text.trim().slice(0, 120)}`);
        });
    }
    console.info(`seazn-credits help: ${checked} articles checked (${lines} lines), 0 excluded, ${hits.length} retired names`);
    expect(checked, "anti-vacuity: help articles were read").toBeGreaterThan(50);
    expect(hits).toEqual([]);
  });

  it("the Seazn credits article carries the new name in its title", () => {
    const text = readFileSync(join(HELP_ROOT, "billing/match-credits.md"), "utf8");
    const title = /^title:\s*(.+)$/m.exec(text)?.[1] ?? "";
    expect(title).toMatch(NEW_NAME.en);
  });
});
