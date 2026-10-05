// W1d Task 6 (item 6, D8): one meaning per exit code across every tools/matrix
// CLI. The CLIs disagreed: parity.ts and findings-table.ts spoke of "unreadable
// input" under 3 where merge-shards.ts, render.ts and lock-append-only.ts put it
// under 2, and findings-table.ts and draw-counts.ts filed a REFUSAL under 1,
// the code a verdict uses (a difference, drift, zero cases, a regression).
//
// Each CLI's header comment states its own codes; this test reads each header as
// text and holds it to lib/exit-codes.ts's table. A behavioural pin for each
// changed CLI lives in its own test (parity.test.ts, findings-table.test.ts,
// draw-counts.test.ts, judge.test.ts); this file is the sweep over the headers.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXIT_CODES } from "../lib/exit-codes.ts";

const MATRIX = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(MATRIX, "..", "..");

/** Every CLI under tools/matrix whose header declares exit codes (item 6). The package scripts' own set is checked against it below. */
const CLIS = ["run", "render", "parity", "findings-table", "draw-counts", "gen-catalogue", "single-sport", "model", "merge-shards", "judge", "lock-append-only", "ci/pr-rows", "ci/shard-matrix", "ci/summary", "ci/staleness", "ci/run-sample", "triage", "audit-ledger"] as const;
/** The CLIs that read a file the caller names: their header must declare unreadable input, under 2. */
const INPUT_READERS = ["render", "parity", "findings-table", "draw-counts", "merge-shards", "judge", "ci/pr-rows", "ci/shard-matrix", "triage", "audit-ledger"] as const;

interface Entry { readonly code: number; readonly text: string }

/** The header: the file's leading run of `//` lines. */
function headerOf(cli: string): string[] {
  const lines = readFileSync(resolve(MATRIX, `${cli}.ts`), "utf8").split("\n");
  const end = lines.findIndex((l) => !l.startsWith("//"));
  return lines.slice(0, end < 0 ? lines.length : end);
}

/** The codes a header declares: each `//   <digit>  <text>` line, with the indented lines that continue it. */
function entriesOf(header: readonly string[]): Entry[] {
  const out: { code: number; parts: string[] }[] = [];
  for (const line of header) {
    const start = /^\/\/ {2,3}(\d)  +(\S.*)$/.exec(line);
    if (start !== null) { out.push({ code: Number(start[1]), parts: [start[2]!] }); continue; }
    if (out.length === 0) continue; // prose before the first code
    const more = /^\/\/ {3,}(\S.*)$/.exec(line);
    if (more === null) break; // a blank `//` or a prose line: the codes block has ended
    out[out.length - 1]!.parts.push(more[1]!);
  }
  return out.map((e) => ({ code: e.code, text: e.parts.join(" ") }));
}

const ALL = CLIS.map((cli) => ({ cli, entries: entriesOf(headerOf(cli)) }));

describe("EXIT_CODES (D8): one meaning per code", () => {
  it("holds exactly 0, 1, 2 and 3, each with its own words, frozen", () => {
    expect(Object.keys(EXIT_CODES)).toEqual(["0", "1", "2", "3"]);
    expect(new Set(Object.values(EXIT_CODES)).size).toBe(4);
    expect(Object.values(EXIT_CODES).every((w) => w.length > 20)).toBe(true);
    expect(Object.isFrozen(EXIT_CODES)).toBe(true);
    // The one meaning of 2 includes unreadable input; 1 is never a refusal.
    expect(EXIT_CODES[2]).toMatch(/unreadable input/);
    expect(EXIT_CODES[2]).toMatch(/refused/);
    expect(EXIT_CODES[1]).not.toMatch(/refus/);
  });
});

describe("every CLI header holds to the table (D8)", () => {
  it("empty case first: the sweep reads 18 CLIs and each declares at least a 0 and a 2 (a header that parsed to nothing is a failure, not a pass)", () => {
    expect(CLIS).toHaveLength(18);
    let read = 0;
    for (const { cli, entries } of ALL) {
      const codes = entries.map((e) => e.code);
      expect(codes, `${cli} declares its exit codes in a \`//   <code>  <meaning>\` header`).toContain(0);
      expect(codes, `${cli} declares a 2`).toContain(2);
      read++;
    }
    expect(read).toBe(18);
  });

  it("the CLIs the package scripts run are all in the sweep (a new matrix:* script owes its row here)", () => {
    const scripts = (JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    const targets = Object.entries(scripts).filter(([k]) => k.startsWith("matrix:")).map(([k, v]) => ({ k, file: /tools\/matrix\/([\w/-]+)\.ts/.exec(v)?.[1] }));
    let checked = 0;
    for (const { k, file } of targets) {
      expect(file, `${k} runs a tools/matrix/<cli>.ts`).toBeDefined();
      expect(CLIS as readonly string[], `${k}: ${file}.ts is in exit-codes.test.ts's CLIS`).toContain(file);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(11);
    expect(targets.map((t) => t.k)).toContain("matrix:judge");
    expect(targets.map((t) => t.k)).toContain("matrix:pr-rows");
  });

  it("every code a header declares is in EXIT_CODES", () => {
    let declared = 0;
    for (const { cli, entries } of ALL) {
      for (const e of entries) {
        expect(Object.keys(EXIT_CODES), `${cli} declares exit ${e.code}`).toContain(String(e.code));
        declared++;
      }
    }
    expect(declared).toBeGreaterThanOrEqual(40);
  });

  it("an unreadable-input line is declared under 2 — in every header that has one, and the CLIs that read a named file do have one", () => {
    let readers = 0;
    for (const { cli, entries } of ALL) {
      for (const e of entries.filter((x) => /\bunreadable\b/i.test(x.text))) expect(e.code, `${cli}: "unreadable" is declared under ${e.code}`).toBe(2);
      if ((INPUT_READERS as readonly string[]).includes(cli)) {
        expect(entries.some((e) => e.code === 2 && /\bunreadable\b/i.test(e.text)), `${cli} declares unreadable input under 2`).toBe(true);
        readers++;
      }
    }
    expect(readers).toBe(INPUT_READERS.length);
    // The bound above is derived from the table, so a row dropped from it still agrees with itself: pin the table.
    expect(INPUT_READERS, "bump this when a CLI that reads a named file is added").toHaveLength(10);
    expect(INPUT_READERS).toContain("ci/pr-rows");
    expect(INPUT_READERS).toContain("ci/shard-matrix");
  });

  it("no header declares a refusal under 1: 1 is the verdict code (a difference, drift, zero cases, a regression, a harness fault)", () => {
    let ones = 0;
    for (const { cli, entries } of ALL) {
      for (const e of entries.filter((x) => x.code === 1)) {
        expect(e.text, `${cli}: exit 1 is declared "${e.text.slice(0, 60)}…"`).not.toMatch(/\brefus(?:ed|es)\b/i);
        ones++;
      }
    }
    expect(ones).toBeGreaterThanOrEqual(8);
  });

  it("a code 3 is only an abort or a crash (the CLIs that never abort declare it as the load crash alone)", () => {
    let threes = 0;
    for (const { cli, entries } of ALL) {
      for (const e of entries.filter((x) => x.code === 3)) {
        expect(e.text, `${cli}: exit 3 is declared "${e.text.slice(0, 60)}…"`).toMatch(/\b(?:crash|crashed|aborted)\b/i);
        expect(e.text, `${cli}: exit 3 is not the unreadable-input code`).not.toMatch(/\bunreadable input\b/i);
        threes++;
      }
    }
    expect(threes).toBeGreaterThanOrEqual(8);
  });
});
