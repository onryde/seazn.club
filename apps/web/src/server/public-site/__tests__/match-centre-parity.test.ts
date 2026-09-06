// Spectator surface W1, Task 9 — the parity test that proves every key
// `buildMatchCentre` (match-centre.ts) can actually emit exists as a
// non-empty string in all four locale dictionaries. Unlike Task 8's
// dictionary-coverage test (match-centre-dictionary.test.ts), which derives
// its vocabulary from RENDERER-side sources (components/public-site/**,
// server/public-site/** as a whole, lib/timeline-keys.ts) plus a few
// hand-pinned dynamic families, THIS test derives its vocabulary from
// match-centre.ts's OWN exported kind lists (`DISMISSAL_KINDS`,
// `RESULT_KINDS`, `BALL_GLYPH_KINDS`) and a source scan of ONLY that one
// file — so a change to the builder's own vocabulary (a renamed kind, a new
// fixed key) is caught here even before any renderer names it.
//
// No DB needed — pure source/dictionary inspection.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BALL_GLYPH_KINDS, DISMISSAL_KINDS, RESULT_KINDS } from "../match-centre";
import type { Dict } from "@/lib/i18n-constants";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";

const HERE = dirname(fileURLToPath(import.meta.url));
// __tests__ -> public-site.
const MATCH_CENTRE_SOURCE = join(HERE, "../match-centre.ts");

const LOCALES = ["en", "es", "fr", "nl"] as const;
const DICTS: Record<(typeof LOCALES)[number], Dict> = { en, es, fr, nl } as unknown as Record<
  (typeof LOCALES)[number],
  Dict
>;

/** Strip `//` line comments and `/* ... *\/` block comments before scanning —
 *  the brief's own instruction ("exclude comments"). In practice every
 *  comment in match-centre.ts references a key via BACKTICKS
 *  (`` `matchCentre.result.forfeit` ``), never a double-quoted literal, so
 *  this makes no observable difference today (verified by hand: the one
 *  comment-line double-quoted match, a `dismissal.out_unknown` citation at
 *  the top of `dismissalMsg`, duplicates a REAL code literal two lines
 *  below it) — stripped anyway so a future comment written differently
 *  can't silently inflate the required vocabulary.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Every double-quoted `"matchCentre.…"` / `"timeline.…"` / `"term.…"`
 *  literal in match-centre.ts's own source — the fixed keys the builder
 *  emits outside its three dynamic kind families (which use backtick
 *  templates, e.g. `` `matchCentre.dismissal.${d.kind}` ``, and so never
 *  match this double-quote-only regex — the three families are covered
 *  separately below via the module's own exported kind lists). A key ending
 *  in "." is excluded (same guard as Task 8's scanner) though none of
 *  match-centre.ts's own literals are bare prefixes today.
 */
const KEY_LITERAL = /"((?:matchCentre|timeline|term)\.[A-Za-z0-9_.]+)"/g;

function scanFixedKeys(): string[] {
  const source = stripComments(readFileSync(MATCH_CENTRE_SOURCE, "utf8"));
  const keys = new Set<string>();
  for (const match of source.matchAll(KEY_LITERAL)) {
    const key = match[1]!;
    if (!key.endsWith(".")) keys.add(key);
  }
  return [...keys];
}

const FIXED_KEYS = scanFixedKeys();

const DERIVED_KEYS = [
  ...new Set([
    ...FIXED_KEYS,
    ...DISMISSAL_KINDS.map((k) => `matchCentre.dismissal.${k}`),
    ...RESULT_KINDS.map((k) => `matchCentre.result.${k}`),
    ...BALL_GLYPH_KINDS.map((k) => `matchCentre.ball.${k}`),
  ]),
].sort();

describe("match-centre parity — every key buildMatchCentre can emit exists in all four dictionaries", () => {
  it("the source scan and the exported kind families both found a real vocabulary, not an empty one", () => {
    expect(FIXED_KEYS.length).toBeGreaterThanOrEqual(15);
    expect(DISMISSAL_KINDS.length).toBe(12);
    expect(RESULT_KINDS.length).toBe(9);
    expect(BALL_GLYPH_KINDS.length).toBe(7);
    expect(DERIVED_KEYS.length).toBeGreaterThanOrEqual(30);
  });

  for (const locale of LOCALES) {
    it(`${locale} has every key buildMatchCentre can emit as a non-empty string`, () => {
      const dict = DICTS[locale];
      const missing: string[] = [];
      for (const key of DERIVED_KEYS) {
        const value = dict[key];
        if (typeof value !== "string" || value === "") missing.push(key);
      }
      expect(missing).toEqual([]);
    });
  }

  it("every locale's template names EXACTLY the same {param} set as English, for every key", () => {
    const paramsOf = (s: string): string[] =>
      [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();
    const mismatches: string[] = [];
    for (const key of DERIVED_KEYS) {
      const enValue = DICTS.en[key];
      if (typeof enValue !== "string") continue; // reported by the existence test above
      const enParams = paramsOf(enValue);
      for (const locale of LOCALES) {
        if (locale === "en") continue;
        const value = DICTS[locale][key];
        if (typeof value !== "string") continue; // ditto
        const params = paramsOf(value);
        if (params.join(",") !== enParams.join(",")) {
          mismatches.push(`${locale}:${key} — en=[${enParams.join(",")}] ${locale}=[${params.join(",")}]`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
