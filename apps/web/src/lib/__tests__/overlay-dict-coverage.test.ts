// Every `overlay.*` / `stream.*` key the source actually references exists in
// all four locales (R14). The key list is DERIVED FROM THE SOURCE, never typed
// here: a typed list drifts the moment a component adds a key, and then the
// test proves only that the list matches itself.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..");
const DICT = join(SRC, "dictionaries");
const LOCALES = ["en", "fr", "es", "nl"] as const;

const SCAN_DIRS = [
  join(SRC, "components", "overlay"),
  join(SRC, "components", "v2"),
  join(SRC, "lib"),
  join(SRC, "app", "overlay"),
  join(SRC, "app", "(public)"),
];

function files(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      out = out.concat(files(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Every string literal in the source that looks like one of this wave's keys.
 *  Deliberately a literal scan: a key built by concatenation would be missed,
 *  which is why the model builds none (see `headerContext`'s explicit switch). */
function referencedKeys(prefix: string): Set<string> {
  const re = new RegExp(`["'\`](${prefix}\\.[A-Za-z0-9_.]+)["'\`]`, "g");
  const found = new Set<string>();
  for (const dir of SCAN_DIRS) {
    for (const file of files(dir)) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(re)) found.add(m[1]!);
    }
  }
  return found;
}

const dictOf = (locale: string, ns: string): Record<string, string> =>
  JSON.parse(readFileSync(join(DICT, locale, `${ns}.json`), "utf8"));

describe("overlay + panel copy is complete in every locale", () => {
  it("finds the keys at all — a scan that matched nothing would pass vacuously", () => {
    expect(referencedKeys("overlay").size).toBeGreaterThanOrEqual(8);
    // RE-PIN (2026-09-09, task 5e): the floor moves again with `slate`.
    // `theme-registry.ts` now references THREE `stream.tab.*` literals —
    // `stream.tab.bar`, `stream.tab.bug`, `stream.tab.slate` — so the true
    // floor today is 3, not the 2 the previous re-pin recorded (when only
    // bar/bug existed). The organiser panel that will reference
    // `stream.setup.*`/`stream.link.*` is still Task 6's, unscanned here, so
    // this is not yet the brief's own `>= 12` either. Raise it again once
    // the panel lands.
    expect(referencedKeys("stream").size).toBeGreaterThanOrEqual(3);
  });

  for (const locale of LOCALES) {
    it(`${locale}/public.json carries every overlay.* key the source uses`, () => {
      const dict = dictOf(locale, "public");
      const missing = [...referencedKeys("overlay")].filter((k) => typeof dict[k] !== "string").sort();
      expect(missing, `${locale} is missing these overlay keys`).toEqual([]);
    });

    it(`${locale}/ui.json carries every stream.* key the source uses`, () => {
      const dict = dictOf(locale, "ui");
      const missing = [...referencedKeys("stream")].filter((k) => typeof dict[k] !== "string").sort();
      expect(missing, `${locale} is missing these stream keys`).toEqual([]);
    });
  }

  it("no locale carries an overlay/stream key en has dropped", () => {
    const en = { ...dictOf("en", "public"), ...dictOf("en", "ui") };
    for (const locale of LOCALES.filter((l) => l !== "en")) {
      const other = { ...dictOf(locale, "public"), ...dictOf(locale, "ui") };
      const orphans = Object.keys(other)
        .filter((k) => (k.startsWith("overlay.") || k.startsWith("stream.")) && !(k in en))
        .sort();
      expect(orphans, `${locale} has keys en does not`).toEqual([]);
    }
  });
});
