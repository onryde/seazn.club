// The Arbiter page and its panel were retired into Match Day (Task 10, 2026-11-19): the organiser's surfaces are Match Day's round and board
// panels, and the division page's queue. A comment in server/ or lib/ that says "the arbiter panel" in the PRESENT tense sends the next reader
// to a screen that does not exist (final review M4, gaps wave A9). What may still name it is history, on a line that says so - the two
// allowed below, each by the words that make it past tense. Anything else is a defect to reword, not a line to add here.
//
// Anti-vacuity: the scan reads hundreds of files, and finds exactly the allowed lines (a deleted allowance is noticed, not silently kept).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../..");
const ROOTS = ["server", "lib"].map((d) => join(SRC, d));
const ALLOWED: { file: string; past: string }[] = [
  { file: "lib/round-column.ts", past: "first written for the Arbiter Panel" },
  { file: "server/online-boards-offered.ts", past: "It was the Arbiter Panel's 404 predicate until" },
];

function sourcesUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name) && !e.parentPath.split(sep).includes("__tests__") && !/\.test\.tsx?$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

describe("no comment in server/ or lib/ names the arbiter panel in the present tense", () => {
  it("every mention is one of the two historical lines", () => {
    const files = ROOTS.flatMap(sourcesUnder);
    const stale: string[] = [];
    const allowedSeen = new Set<string>();
    for (const f of files) {
      const rel = relative(SRC, f).split(sep).join("/");
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (!/arbiter panel/i.test(line)) return;
        const ok = ALLOWED.find((a) => a.file === rel && line.includes(a.past));
        if (ok) allowedSeen.add(ok.file);
        else stale.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}`);
      });
    }
    expect(files.length, "anti-vacuity: source files scanned").toBeGreaterThan(500);
    expect([...allowedSeen].sort(), "anti-vacuity: both historical lines are still there to allow").toEqual(ALLOWED.map((a) => a.file).sort());
    expect(stale, "a present-tense mention of the arbiter panel").toEqual([]);
  });
});
