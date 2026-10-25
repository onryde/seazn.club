// W2d Task 9 (spec §1 done-means 4, §6 W1–W11, anti-goal 2): ONE place in the web reads a stage's table rules — the
// loader, `server/engine-db/table-rules.ts`. Before W2d six readers each re-derived the order (`division.tiebreakers ??
// module.defaultTiebreakers(…)`) from the division's raw cfg, and a seventh ranked by yet another; the pin (OC2) is only
// a pin if nothing else reads around it. A source scan, because a second reader compiles, passes every unit test of its
// own surface, and quietly ranks or captions a started stage by today's division default instead of its pin.
//
// Scanned: every non-test source file under apps/web/src (tests legitimately call the engine's defaults to derive their
// expected values). Matched: a read of the sport's default order (`defaultTiebreakers`) or the inherit-the-division
// fallback (`.tiebreakers ??`). The one allowed file is the loader.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "../../..");
const LOADER = "server/engine-db/table-rules.ts";
const READS = [/\bdefaultTiebreakers\b/, /\.tiebreakers\s*\?\?/];

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
  it("no file under apps/web/src except server/engine-db/table-rules.ts reads `defaultTiebreakers` or `.tiebreakers ??` (files scanned > 0; the one allowed hit = 1)", () => {
    const files = sources(SRC);
    const hits: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (READS.some((re) => re.test(text))) hits.push(relative(SRC, file));
    }
    expect(files.length, "anti-vacuity: source files scanned").toBeGreaterThan(500);
    expect(hits.filter((f) => f !== LOADER), "a second reader of the table rules").toEqual([]);
    expect(hits, "the loader is the one allowed hit (and the scan reaches it)").toEqual([LOADER]);
  });
});
