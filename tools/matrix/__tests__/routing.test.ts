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

// T1-R3 (review m-5), reshaped by I-3: every Status row's links resolve and
// every owner ruling a row cites exists, whatever state the row is in. The
// W1-driving row's own text is never pinned (brief: Task 16 closes it), and
// its openness is the Q-A guard's job (scenario-catalogue.test.ts: open
// exactly while a route names it). The sweep reads every row, so its counts
// stay above zero when any one row is rewritten.
/** "ruling 71", "rulings 72–79", "rulings 3, 5 and 9". A list item is a whole number not followed by "-<digit>": "(ruling 71,
 *  2026-10-08)" cites ruling 71 and a date, not a ruling 2026. */
const CITED_RULINGS = /\brulings? (\d+(?:–\d+)?(?:(?:,| and|, and) \d+(?:–\d+)?(?![\d]|-\d))*)/gi;
const citedIn = (text: string): number[] =>
  [...text.matchAll(CITED_RULINGS)].flatMap(([, list]) => [...list!.matchAll(/(\d+)(?:–(\d+))?/g)].flatMap(([, lo, hi]) => Array.from({ length: Number(hi ?? lo) - Number(lo) + 1 }, (_, i) => Number(lo) + i)));

describe("the cited-ruling reader", () => {
  it("reads lists and ranges, and leaves an ISO date after a comma alone", () => {
    expect(citedIn("rulings 72–79 signed")).toEqual([72, 73, 74, 75, 76, 77, 78, 79]);
    expect(citedIn("rulings 3, 5 and 9")).toEqual([3, 5, 9]);
    expect(citedIn("Split into W2a–W2e (ruling 71, 2026-10-08).")).toEqual([71]);
    expect(citedIn("no citation here")).toEqual([]);
  });
});

describe("the Status rows' links and cited rulings (any row, open or closed)", () => {
  const PROMPTS = "docs/superpowers/specs/2026-09-27-format-matrix-prompts";
  /** Each Status body row's cells after the wave and the scope: its state. */
  const states = (): Array<{ wave: string; state: string }> => {
    const start = INDEX.indexOf("## Status");
    const lines = INDEX.slice(start, INDEX.indexOf("\n## ", start + 1)).split("\n");
    const sep = lines.findIndex((l) => /^\| -+ \|/.test(l));
    const out: Array<{ wave: string; state: string }> = [];
    for (const line of lines.slice(sep + 1)) {
      if (!line.startsWith("|")) break;
      const cells = line.split(" | ");
      out.push({ wave: cells[0]!.slice(2), state: cells.slice(2).join(" | ") });
    }
    return out;
  };
  it("every backticked .md a row names resolves on disk (from the repo root, the prompts dir, or a directory the same row names)", () => {
    const rows = states();
    expect(rows.length, "Status rows read").toBeGreaterThan(0);
    let checked = 0;
    for (const { wave, state } of rows) {
      // A row may name a directory (`truth-runs/`) and then files inside it.
      const roots = [REPO, resolve(REPO, PROMPTS)];
      const bases = [...roots, ...[...state.matchAll(/`([^`\s]+\/)`/g)].flatMap(([, d]) => roots.map((r) => resolve(r, d!)))];
      for (const [, link] of state.matchAll(/`([^`]+\.md)`/g)) {
        expect(bases.some((b) => existsSync(resolve(b, link!))), `${wave}: ${link}`).toBe(true);
        checked++;
      }
    }
    expect(checked, ".md links checked").toBeGreaterThan(0);
    console.info(`Status rows: ${checked} .md links resolved across ${rows.length} rows`);
  });
  it("every owner ruling a row cites ('ruling N', 'rulings N–M, K and J') is an entry of ## Owner rulings", () => {
    // "## Owner rulings" numbers its entries "N." or, for a batch, "N–M.".
    const start = INDEX.indexOf("\n## Owner rulings");
    expect(start, "no Owner rulings section").toBeGreaterThan(0);
    const section = INDEX.slice(start, INDEX.indexOf("\n## ", start + 1));
    const numbered = new Set<number>();
    for (const [, lo, hi] of section.matchAll(/^(\d+)(?:–(\d+))?\. \*\*/gm)) {
      for (let n = Number(lo); n <= Number(hi ?? lo); n++) numbered.add(n);
    }
    expect(numbered.size, "owner rulings read").toBeGreaterThan(0);
    let checked = 0;
    for (const { wave, state } of states()) {
      for (const [, list] of state.matchAll(CITED_RULINGS)) {
        for (const [, lo, hi] of list!.matchAll(/(\d+)(?:–(\d+))?/g)) {
          for (let n = Number(lo); n <= Number(hi ?? lo); n++) {
            expect(numbered.has(n), `${wave} cites ruling ${n}`).toBe(true);
            checked++;
          }
        }
      }
    }
    expect(checked, "cited rulings checked").toBeGreaterThan(0);
    console.info(`Status rows: ${checked} cited owner rulings found among ${numbered.size}`);
  });
});
