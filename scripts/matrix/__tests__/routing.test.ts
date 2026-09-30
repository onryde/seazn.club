// D7 (W1-driving plan, Task 1): the ONE construct that names an owning wave.
// The programme's wave ids are read from _INDEX.md's Status table, never from
// WAVE_ID (the declaration under test): a wave added to the programme without
// widening WAVE_ID, or a WAVE_ID that admits a wave with no status row, reds.
//
// Transitions: an empty wave or why (the empty case, first) → a wave outside
// the programme → every programme wave → the same set read from the index.
import { existsSync, readFileSync } from "node:fs";
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

// T1-R3 (review m-5): the W1-driving row is open, cites the wave's rulings and
// points at its plan and its prompt. The pointers are read from the row and
// resolved on disk, so a moved file or a dropped pointer reds.
describe("the W1-driving status row", () => {
  const row = INDEX.split("\n").find((l) => l.startsWith("| W1-driving |"));
  const state = row?.split(" | ")[2] ?? "";
  it("is open: it starts 'in progress —'", () => {
    expect(row, "no W1-driving Status row").toBeDefined();
    expect(state.replace(/\*\*/g, "")).toMatch(/^in progress — /);
  });
  it("points at its plan and its prompt, and both exist", () => {
    const plan = /plan `([^`]+\.md)`/.exec(state)?.[1];
    const prompt = /prompt `([^`]+\.md)`/.exec(state)?.[1];
    expect(plan, "no plan pointer").toBeDefined();
    expect(prompt, "no prompt pointer").toBe("W1-driving.md");
    expect(existsSync(resolve(REPO, plan!)), plan).toBe(true);
    expect(existsSync(resolve(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts", prompt!)), prompt).toBe(true);
  });
  it("cites rulings 44–54, and each one is an owner ruling in the index", () => {
    const m = /rulings (\d+)–(\d+)/.exec(state);
    expect(m?.slice(1, 3), "the row cites no ruling range").toEqual(["44", "54"]);
    // "## Owner rulings" numbers its entries "N." or, for a batch, "N–M.".
    const start = INDEX.indexOf("\n## Owner rulings");
    expect(start, "no Owner rulings section").toBeGreaterThan(0);
    const section = INDEX.slice(start, INDEX.indexOf("\n## ", start + 1));
    const numbered = new Set<number>();
    for (const [, lo, hi] of section.matchAll(/^(\d+)(?:–(\d+))?\. \*\*/gm)) {
      for (let n = Number(lo); n <= Number(hi ?? lo); n++) numbered.add(n);
    }
    expect(numbered.size, "owner rulings read").toBeGreaterThan(0);
    const cited = Array.from({ length: 54 - 44 + 1 }, (_, i) => 44 + i);
    for (const n of cited) expect(numbered.has(n), `ruling ${n}`).toBe(true);
    expect(cited.length).toBe(11);
  });
});
