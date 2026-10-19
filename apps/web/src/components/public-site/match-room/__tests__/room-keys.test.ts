// T14 — every dictionary key the match room names as a literal exists, in all
// four locales. TKey accepts any string (i18n-runtime.ts), so tsc never sees a
// missing key, and a key reached only behind an interaction (the resign and
// abort confirm buttons, found by the room e2e) is in no first-paint sweep:
// it paints the raw key. This reads the source, so it covers every branch.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..");
const PAGE = join(
  __dirname,
  "../../../../app/(public)/shared/(kiosk)/[orgSlug]/[competitionSlug]/[divisionSlug]/fixtures/[fixtureId]/play/page.tsx",
);
const KEY = /"((?:externalPlay|onlineChess|method)\.[A-Za-z0-9_.]+)"/g;

const dict = (l: string) =>
  JSON.parse(readFileSync(join(__dirname, `../../../../dictionaries/${l}/ui.json`), "utf8")) as Record<string, string>;

describe("the match room's dictionary keys", () => {
  it("every literal key in the room's source has copy in en, es, fr and nl (a plural base needs .one and .other)", () => {
    const files = [
      ...readdirSync(DIR)
        .filter((f) => /\.tsx?$/.test(f))
        .map((f) => join(DIR, f)),
      PAGE,
    ];
    const keys = new Set<string>();
    for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(KEY)) keys.add(m[1]!);
    expect(keys.size, "anti-vacuity: the room names its copy").toBeGreaterThan(50);
    let checked = 0;
    for (const locale of ["en", "es", "fr", "nl"]) {
      const d = dict(locale);
      const missing = [...keys].filter((k) => d[k] === undefined && !(d[`${k}.one`] !== undefined && d[`${k}.other`] !== undefined));
      expect(missing, `${locale}: keys the room names with no copy`).toEqual([]);
      checked += keys.size;
    }
    expect(checked).toBe(keys.size * 4);
  });
});
