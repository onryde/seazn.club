// UI5 fix round 1 (review m2): a dictionary may not name a key twice. JSON.parse keeps the LAST copy silently, and
// `i18n:check` compares parsed key sets, so a second copy of `entrants.add.alreadyEntered` sat in all four `ui.json` files
// unseen: one edit to the first copy would ship and do nothing. This reads each file's raw text instead.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../dictionaries/", import.meta.url));

/** Every top-level key as written, in file order (the dictionaries are flat objects, one `"key": value` per line). */
function writtenKeys(text: string): string[] {
  return [...text.matchAll(/^ {2}"((?:[^"\\]|\\.)*)"\s*:/gm)].map((m) => JSON.parse(`"${m[1]}"`) as string);
}

describe("dictionaries: no key is written twice", () => {
  it("every locale x namespace file names each key once (counted)", () => {
    let files = 0;
    let keys = 0;
    const duplicates: string[] = [];
    for (const locale of readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      for (const file of readdirSync(join(ROOT, locale.name)).filter((f) => f.endsWith(".json"))) {
        const text = readFileSync(join(ROOT, locale.name, file), "utf8");
        const written = writtenKeys(text);
        const parsed = Object.keys(JSON.parse(text) as Record<string, unknown>);
        // The scanner's own guard: it saw every key the parser sees, so a formatting change cannot make it pass by seeing nothing.
        expect(new Set(written).size, `${locale.name}/${file}: the scanner reads every key`).toBe(parsed.length);
        const seen = new Set<string>();
        for (const k of written) {
          if (seen.has(k)) duplicates.push(`${locale.name}/${file}: ${k}`);
          seen.add(k);
        }
        files++;
        keys += written.length;
      }
    }
    console.info(`dictionary duplicate-key scan: ${files} files, ${keys} keys`);
    expect(files, "anti-vacuity: the four locales' files were read").toBeGreaterThanOrEqual(4);
    expect(keys, "anti-vacuity: keys were read").toBeGreaterThan(1000);
    expect(duplicates).toEqual([]);
  });
});
