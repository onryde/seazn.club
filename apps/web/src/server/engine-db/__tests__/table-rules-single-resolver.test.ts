// W2d Task 9 (spec §1 done-means 4, §6 W1–W11, anti-goal 2): ONE place in the web reads a stage's table rules — the
// loader, `server/engine-db/table-rules.ts`. Before W2d six readers each re-derived the order (`division.tiebreakers ??
// module.defaultTiebreakers(…)`) from the division's raw cfg, and a seventh ranked by yet another; the pin (OC2) is only
// a pin if nothing else reads around it. A source scan, because a second reader compiles, passes every unit test of its
// own surface, and quietly ranks or captions a started stage by today's division default instead of its pin.
//
// Scanned: every non-test source file under apps/web/src (tests legitimately call the engine's defaults to derive their
// expected values). Matched: a read of the sport's default order (`defaultTiebreakers`), the inherit-the-division
// fallback (`.tiebreakers ??`), or a call of the engine's resolver itself (`resolveTableRules(`, fix round 1 m11: a
// second caller would resolve a stage's rules around the pin). The one allowed file is the loader. W2d final review m6
// (PR A m5): the points half too — a call of the sport's own points rule (`tablePointsRule(`), which the loader never
// makes (the engine's resolver asks it), so for that pattern NO file is allowed and its one exemption is the witness that
// the scan reaches a hit.
//
// A hit that reads no stage's rules is exempted BY NAME (`EXEMPT`: the file, the pattern, the matched line's text, why),
// never by rewriting the line to slip past the pattern. Each exemption must match exactly one hit, so an exemption whose
// line moved or went away fails here instead of standing open for whatever lands there next.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "../../..");
const LOADER = "server/engine-db/table-rules.ts";
const READS = [/\bdefaultTiebreakers\b/, /\.tiebreakers\s*\?\?/, /\bresolveTableRules\s*\(/, /\btablePointsRule\s*\(/];
/** The patterns the loader itself reads. It never calls `tablePointsRule(` (the engine's `resolveTableRules` does), so
 *  for that pattern the allowed set is empty. */
const LOADER_READS: ReadonlySet<RegExp> = new Set([READS[0]!, READS[1]!, READS[2]!]);

/** Named exemptions: `text` is a substring of the line the match starts on. */
const EXEMPT: readonly { file: string; pattern: RegExp; text: string; reason: string }[] = [
  {
    file: "components/v2/stage-rules/stage-tiebreaks-model.ts",
    pattern: READS[0]!,
    text: "web's own call of `defaultTiebreakers`",
    reason: "a docblock naming the engine call the editor model does NOT make (it reads the loader's `sportDefault`)",
  },
  {
    file: "components/v2/stage-rules/stage-tiebreaks-model.ts",
    pattern: READS[1]!,
    text: "const named = presets?.tiebreakers ?? [];",
    reason: "reads the preset catalogue for the editor's Reset menu, not a stage's order",
  },
  {
    file: "server/slideshow-data.ts",
    pattern: READS[1]!,
    text: "cascade: rules?.tiebreakers ?? [],",
    reason:
      "reads the loader's own output (`stageTableRulesDocs` / `PublicStage.table_rules`); `?? []` is a refused or absent stage's empty cascade, never the division's or the module's default",
  },
  {
    file: "lib/stage-points-splits.ts",
    pattern: READS[3]!,
    text: "rule: module.tablePointsRule(parsed.data, stageKind.data)",
    reason:
      "the stage points EDITOR's sport layer (`sportStageRule` -> `stagePointsContext`): what a pending stage with no rule of its own and no pin opens with, for its rows, split labels and preset chips, over the loader's own `liveStageCfg` composition. The editor reads the stage's own rule and its pin first (`draftFromStored`, the section's `playing`), and nothing is ranked or paid from it",
  },
];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      sources(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("W2d T9: one table-rules resolver in the web", () => {
  it("no file under apps/web/src except server/engine-db/table-rules.ts reads `defaultTiebreakers`, `.tiebreakers ??` or calls `resolveTableRules(`, and none calls `tablePointsRule(` (files scanned > 0; the loader the one allowed hit per pattern it reads)", () => {
    const files = sources(SRC);
    const used = new Map<(typeof EXEMPT)[number], number>(EXEMPT.map((e) => [e, 0]));
    let checked = 0;
    for (const re of READS) {
      const hits: string[] = [];
      for (const file of files) {
        const rel = relative(SRC, file);
        const text = readFileSync(file, "utf8");
        // Every match, from where it starts (a match may span lines); an exempted one is counted, the rest are hits.
        let read = false;
        for (const m of text.matchAll(new RegExp(re.source, "g"))) {
          const start = text.lastIndexOf("\n", m.index) + 1;
          const end = text.indexOf("\n", m.index);
          const line = text.slice(start, end === -1 ? undefined : end);
          const named = EXEMPT.find((e) => e.file === rel && e.pattern === re && line.includes(e.text));
          if (named === undefined) read = true;
          else used.set(named, used.get(named)! + 1);
        }
        if (read) hits.push(rel);
      }
      const second = hits.filter((f) => f !== LOADER);
      expect(second, `a second reader of the table rules (${re}): ${second.join(", ")}`).toEqual([]);
      // Where the loader reads the pattern it is the one allowed hit (and the scan reaches it); where it does not, no file is.
      expect(hits, `the allowed hits for ${re}`).toEqual(LOADER_READS.has(re) ? [LOADER] : []);
      checked++;
    }
    expect(files.length, "anti-vacuity: source files scanned").toBeGreaterThan(500);
    expect(checked, "every pattern swept").toBe(READS.length);
    // No stale exemption: each names exactly one hit that is still there (and each carries its reason).
    for (const [e, n] of used) expect([n, e.reason.length > 0], `exemption ${e.file} ${e.pattern} "${e.text}"`).toEqual([1, true]);
    expect(used.size, "the exemptions asked").toBe(EXEMPT.length);
  });
});
