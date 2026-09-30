// D7 (W1-driving plan, Task 1): the ONE construct that names an owning wave.
// The programme's wave ids are read from _INDEX.md's Status table, never from
// WAVE_ID (the declaration under test): a wave added to the programme without
// widening WAVE_ID, or a WAVE_ID that admits a wave with no status row, reds.
//
// Transitions: an empty wave or why (the empty case, first) → a wave outside
// the programme → every programme wave → the same set read from the index.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NotAWave, WAVE_ID, routeTo } from "../lib/routing.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const INDEX = readFileSync(resolve(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md"), "utf8");

/** The Status table's body rows' first cells: the programme's waves, as the index lists them. */
function statusWaves(): string[] {
  const start = INDEX.indexOf("## Status");
  const section = INDEX.slice(start, INDEX.indexOf("\n## ", start + 1)).split("\n");
  const sep = section.findIndex((l) => /^\| -+ \|/.test(l));
  expect(sep, "the Status table has no header separator").toBeGreaterThan(0);
  const body: string[] = [];
  for (const line of section.slice(sep + 1)) {
    if (!line.startsWith("|")) break;
    const m = /^\| (W[\w-]+) \|/.exec(line);
    expect(m, `a Status row whose first cell is not a wave: ${line.slice(0, 60)}`).not.toBeNull();
    body.push(m![1]!);
  }
  return body;
}

describe("routeTo", () => {
  it("empty case first: an empty wave or reason is refused by name", () => {
    expect(() => routeTo("", "x")).toThrow(/wave/);
    expect(() => routeTo("W2", "")).toThrow(/why/);
    expect(() => routeTo("W2", "   ")).toThrow(/why/);
  });
  it("a wave outside the programme's ids is refused (W11, w2, W1-drive)", () => {
    let refused = 0;
    for (const bad of ["W11", "w2", "W1-drive", "W1e", "W1", "W0", " W2", "W2 "]) {
      expect(() => routeTo(bad, "x"), bad).toThrow(NotAWave);
      expect(() => routeTo(bad, "x"), bad).toThrow(/not a programme wave/);
      refused++;
    }
    expect(refused).toBe(8);
  });
  it("every programme wave id is accepted and frozen", () => {
    const ids = ["W1a", "W1b", "W1c", "W1d", "W1-driving", ...Array.from({ length: 9 }, (_, i) => `W${i + 2}`)];
    expect(ids.length).toBe(14);
    for (const w of ids) {
      expect(WAVE_ID.test(w), w).toBe(true);
      const r = routeTo(w, "why");
      expect(Object.isFrozen(r)).toBe(true);
      expect(r).toEqual({ wave: w, why: "why" });
    }
  });
  it("the programme's waves are exactly _INDEX.md's Status rows (read from the index, never from WAVE_ID)", () => {
    const listed = statusWaves();
    expect(listed.length, "Status rows read").toBeGreaterThan(0);
    expect(new Set(listed).size, "a wave listed twice").toBe(listed.length);
    const typed = ["W1a", "W1b", "W1c", "W1d", "W1-driving", ...Array.from({ length: 9 }, (_, i) => `W${i + 2}`)];
    expect(new Set(listed)).toEqual(new Set(typed));
    for (const w of listed) expect(() => routeTo(w, "why"), w).not.toThrow();
  });
});
