// lib/funnel-sport-keys.ts: the /start funnel's sports by key and name, the one list (start wizard T5 review m3). The
// client doors ask it whether /start takes a sport (the home hero's organiser link, /play's season link), so it imports
// nothing: through lib/funnel-sports.ts the hero's link carried match-length's table and server/external-play into the
// marketing home's client bundle. And lib/funnel-sports.ts builds FUNNEL_SPORTS from it, never typing the sports again.
// Pure: no DB, no browser. Not swept per sport: the subject is the funnel's own list, and every entry is checked.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FUNNEL_SPORT_IDS, funnelSportKeyByKeyOrName } from "@/lib/funnel-sport-keys";
import { FUNNEL_SPORTS } from "@/lib/funnel-sports";

const sourceOf = (file: string): string => readFileSync(join(import.meta.dirname, "..", file), "utf8");

/** Every module reference in a TS source: static and type-only imports, side-effect imports, re-exports, dynamic imports
 *  and requires. Comments are dropped first (the module's header talks ABOUT imports). */
function moduleReferences(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const patterns = [
    /^\s*import\s[^;]*?from\s*["'][^"']+["']/gm, // import x / { x } / type { x } / * as x from "m"
    /^\s*import\s*["'][^"']+["']/gm, // import "m"
    /^\s*export\s[^;]*?from\s*["'][^"']+["']/gm, // export { x } / * from "m"
    /\bimport\s*\(/g, // import("m")
    /\brequire\s*\(/g, // require("m")
  ];
  return patterns.flatMap((p) => code.match(p) ?? []);
}

describe("lib/funnel-sport-keys.ts is import-free, and the funnel's one list of sports", () => {
  it("the scanner finds every kind of module reference it is planted with, and none in comments", () => {
    const planted: [string, number][] = [
      ['import { defaultMatchMinutes } from "./match-length";', 1],
      ['import type { TimeControl } from "@/server/external-play/time-controls";', 1],
      ['import {\n  a,\n  b,\n} from "@/server/external-play/errors";', 1],
      ['import * as clock from "../server/external-play/clock";', 1],
      ['import "server-only";', 1],
      ['export { FUNNEL_SPORTS } from "./funnel-sports";', 1],
      ['export * from "./funnel-sports";', 1],
      ['const m = await import("./match-length");', 1],
      ['const m = require("./match-length");', 1],
      ['// import { x } from "./match-length";', 0],
      ['/* import "server-only"; */', 0],
      ["/** The list a client door can import, with no imports of its own. */", 0],
    ];
    let checked = 0;
    for (const [text, expected] of planted) {
      expect(moduleReferences(text), text).toHaveLength(expected);
      checked++;
    }
    expect(checked).toBe(planted.length);
  });

  it("imports nothing, so a client door carries no server code and no match-length table", () => {
    const src = sourceOf("funnel-sport-keys.ts");
    expect(src.length, "read the module").toBeGreaterThan(0);
    expect(src, "read the right module").toContain("export function funnelSportKeyByKeyOrName");
    expect(moduleReferences(src)).toEqual([]);
  });

  it("FUNNEL_SPORTS is this list: the same sports, keys and names, in the same order", () => {
    const ids = FUNNEL_SPORT_IDS.map(({ key, name }) => ({ key, name }));
    expect(ids.length, "the list has sports").toBeGreaterThan(0);
    expect(FUNNEL_SPORTS.map(({ key, name }) => ({ key, name }))).toEqual(ids);
  });

  it("lib/funnel-sports.ts builds from this list and never spells a sport's name itself (names checked reported)", () => {
    const src = sourceOf("funnel-sports.ts");
    expect(moduleReferences(src).some((ref) => /["']\.\/funnel-sport-keys["']/.test(ref))).toBe(true);
    let checked = 0;
    for (const { name } of FUNNEL_SPORT_IDS) {
      expect(src, name).not.toContain(`"${name}"`);
      expect(src, name).not.toContain(`'${name}'`);
      checked++;
    }
    expect(checked).toBe(FUNNEL_SPORT_IDS.length);
    expect(checked).toBeGreaterThan(0);
  });

  it("the list and its entries are frozen, so a caller holding one cannot change the next lookup", () => {
    expect(Object.isFrozen(FUNNEL_SPORT_IDS)).toBe(true);
    let frozen = 0;
    for (const id of FUNNEL_SPORT_IDS) {
      expect(Object.isFrozen(id), id.key).toBe(true);
      frozen++;
    }
    expect(frozen).toBe(FUNNEL_SPORT_IDS.length);
    expect(frozen).toBeGreaterThan(0);
  });

  it("funnelSportKeyByKeyOrName takes a key or a catalogue name in any case, trimmed, and nothing else", () => {
    // The names are the sports catalogue's (scripts/sync-sports.ts), typed here rather than read from the module.
    const hits: [string, string][] = [
      ["tabletennis", "tabletennis"],
      ["Table Tennis", "tabletennis"],
      ["  table tennis ", "tabletennis"],
      ["TABLETENNIS", "tabletennis"],
      ["boardgame", "boardgame"],
      ["Chess", "boardgame"],
      ["icehockey", "icehockey"],
      ["Ice Hockey", "icehockey"],
      ["Football", "football"],
      ["cricket", "cricket"],
      ["other", "other"],
    ];
    for (const [raw, key] of hits) expect(funnelSportKeyByKeyOrName(raw), raw).toBe(key);
    const misses = ["", "   ", "quidditch", "<script>", "generic", "Generic", "table-tennis", "constructor", "__proto__"];
    let missed = 0;
    for (const raw of misses) {
      expect(funnelSportKeyByKeyOrName(raw), raw).toBeNull();
      missed++;
    }
    expect(funnelSportKeyByKeyOrName(null as unknown as string), "not a string").toBeNull();
    expect(missed).toBe(misses.length);
  });
});
