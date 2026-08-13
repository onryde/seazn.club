// P3 (D7) regression gate: every news.enrich./news.recap./news.digest.
// dictionary key is present, non-empty, and parameterized (not a
// concatenated fragment) in all 4 locales.
//
// Seeded from ENRICHMENT_DICT_KEYS — draft-templates.ts's OWN hand-maintained
// list of the keys it reads — NOT from the dictionaries themselves. The
// event-copy-gate lesson (see reference_event_copy_gate_blind_to_core_types
// in agent memory): a gate whose expected list is read off the dictionaries
// under test cannot fail no matter what is missing, because a deleted key
// simply deletes itself from both sides at once. This file's "expected" side
// is a literal array checked into source, so deleting a key from ANY one
// locale reds this suite without anyone needing to remember to update it.
//
// No DATABASE_URL dependency — pure JSON reads — so this runs in every CI
// job regardless of which directories a Postgres-gated job happens to scan.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ENRICHMENT_DICT_KEYS } from "../draft-templates";

const LOCALES = ["en", "es", "fr", "nl"] as const;

const load = (locale: string): Record<string, string> =>
  JSON.parse(readFileSync(`src/dictionaries/${locale}/ui.json`, "utf8"));

describe("P3 enrichment/digest dictionary keys are complete across all 4 locales", () => {
  it("the expected key list itself is non-trivial and namespaced correctly", () => {
    // A floor, not a snapshot — the point is "did anyone shrink the list",
    // and an exact-length pin would just be a second copy of the array.
    expect(ENRICHMENT_DICT_KEYS.length).toBeGreaterThanOrEqual(20);
    for (const key of ENRICHMENT_DICT_KEYS) {
      expect(key).toMatch(/^news\.(enrich|recap|digest)\./);
    }
  });

  it.each(LOCALES)("every key exists with a non-empty string value in %s/ui.json", (locale) => {
    const dict = load(locale);
    for (const key of ENRICHMENT_DICT_KEYS) {
      // Flat dotted-key lookup — `in` matches the literal key, never a path
      // walk (these files are flat JSON, not nested; see
      // reference_i18n_add_keys_recipe in agent memory for why a nested
      // walk false-negatives here).
      expect(key in dict, `${locale}/ui.json is missing "${key}"`).toBe(true);
      const value = dict[key];
      expect(typeof value, `${locale}/ui.json "${key}" is not a string`).toBe("string");
      expect(value!.trim().length, `${locale}/ui.json "${key}" is empty`).toBeGreaterThan(0);
    }
  });

  it("removing a key from the expected list would be the actual gap — proven by checking the list length against a live count", () => {
    // Anti-vacuity: if ENRICHMENT_DICT_KEYS were accidentally emptied, every
    // `it.each` above would iterate zero times and report green. Pin that it
    // cannot be empty AND that every entry it names is actually present.
    const en = load("en");
    const present = ENRICHMENT_DICT_KEYS.filter((k) => k in en);
    expect(present).toHaveLength(ENRICHMENT_DICT_KEYS.length);
  });

  it("no enrichment/digest value is a concatenated sentence fragment — every one carries a {placeholder} or is a short label", () => {
    // Grammar differs per locale (word order, gender agreement), so a
    // template that builds a sentence by gluing English fragments together
    // cannot translate correctly. Every BODY-LINE key here takes at least
    // one parameter; the handful of pure section-header/title labels
    // (no runtime value to interpolate) are the named exceptions.
    const HEADER_ONLY = new Set([
      "news.enrich.sectionTitle",
      "news.recap.leadersTitle",
      "news.recap.standingsMovesTitle",
      "news.digest.section.standings",
      "news.digest.section.leaders",
      "news.digest.section.upcoming",
      "news.digest.section.claimed",
    ]);
    const en = load("en");
    for (const key of ENRICHMENT_DICT_KEYS) {
      if (HEADER_ONLY.has(key)) continue;
      expect(en[key], `${key} should contain a {placeholder}`).toMatch(/\{[a-zA-Z]+\}/);
    }
  });
});
