// W2a Task 7 — spec §5.4.6 (risk row 2): every list of fixtures.status literals, in TS and SQL, is FOUND by scanning
// and CLASSIFIED in the ledger. Unclassified = failure; a ledger row no longer found = failure; zero found = failure.
// Later loops re-run it (preflight C19): lane P1 (tools/matrix/lib) and Task 17 (scripts/) report new sets for the
// ledger; a red sweep blocks the PR.
//
// What "a set" means here — four shapes, each holding >= 2 DISTINCT status literals (loop R, M4):
//  - set:    a bracketed or parenthesised list  `["decided", "finalized"]`, `in ('decided','finalized')`;
//  - chain:  comparisons joined in one expression, on one line or broken across lines at `||` / `&&`;
//  - map:    an object literal whose KEYS are statuses (no nested brace inside it);
//  - switch: a `switch` whose `case` labels are statuses, whatever its body holds (nested braces included).
// BLIND SPOT, stated rather than swept: a SINGLE-literal comparison (`status === "in_play"`, `if (s === "decided")`) is a
// one-member set, and none is found or classified. Measured on the W2a branch (2026-10-09): 194 such lines in 81 files
// across ROOTS, mostly live checks (in_play 51, scheduled 50). A one-literal predicate that should have learned
// `needs_decision` (an "is it over" test spelled `=== "decided"`) is therefore NOT caught here; review such a site by
// hand, or rewrite it as a set this sweep can see.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import { STATUS_SET_LEDGER, type StatusSetClass } from "./status-set-ledger";

const REPO = resolve(__dirname, "../../../../..");
const ROOTS = ["apps/web/src", "packages/engine/src", "db/migration", "tools/matrix/lib", "scripts"];
const LIT = new RegExp(`['"](${FIXTURE_STATUSES.join("|")})['"]`, "g");

/** A "set" is a bracketed or parenthesised span holding ≥ 2 distinct fixture-status literals. Its anchor is the
 *  file plus the sorted literals plus the 40 characters before the span (a const name, a SQL clause). */
function findSets(text: string): { anchor: string; members: Set<string> }[] {
  const out: { anchor: string; members: Set<string> }[] = [];
  const span = /[[(]([^[\]()]*)[\])]/g;
  for (const m of text.matchAll(span)) {
    const members = new Set([...m[1]!.matchAll(LIT)].map((x) => x[1]!));
    if (members.size < 2) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index).replace(/\s+/g, " ").trim();
    out.push({ anchor: `${before.slice(-30)} :: ${[...members].sort().join(",")}`, members });
  }
  return out;
}

/** Preflight C19: two set shapes a bracket span misses. (1) A comparison chain on one line —
 *  `return s === "decided" || s === "finalized";` — whose literals follow `===`/`!==`. (2) A status-keyed map —
 *  `{ scheduled: …, in_play: … }` or `Record<FixtureStatus, …>` — whose KEYS are statuses. Same anchor shape. */
function findChains(text: string): { anchor: string; members: Set<string>; multiLine?: true }[] {
  const out: { anchor: string; members: Set<string>; multiLine?: true }[] = [];
  const cmp = new RegExp(`[!=]==?\\s*['"](${FIXTURE_STATUSES.join("|")})['"]`, "g");
  // Loop R M4: a chain broken across lines is ONE expression — a line ending in `||`/`&&`, or the next one starting
  // with it, continues the chain. Two statements on adjacent lines are not joined.
  const continues = (a: string, b: string) => /(\|\||&&)\s*$/.test(a) || /^\s*(\|\||&&)/.test(b);
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length; ) {
    let j = i;
    let end = offset + lines[i]!.length;
    while (j + 1 < lines.length && continues(lines[j]!, lines[j + 1]!)) end += 1 + lines[++j]!.length;
    const hits = [...text.slice(offset, end).matchAll(cmp)];
    const members = new Set(hits.map((x) => x[1]!));
    if (members.size >= 2) {
      const at = offset + hits[0]!.index;
      const before = text.slice(Math.max(0, at - 40), at).replace(/\s+/g, " ").trim();
      out.push({ anchor: `chain ${before.slice(-30)} :: ${[...members].sort().join(",")}`, members, ...(j > i ? { multiLine: true as const } : {}) });
    }
    offset = end + 1;
    i = j + 1;
  }
  return out;
}
function findMaps(text: string): { anchor: string; members: Set<string> }[] {
  const out: { anchor: string; members: Set<string> }[] = [];
  // Loop R M4: a `case "decided":` label is the switch shape's, never a map key (one site, one shape).
  const key = new RegExp(`(?:^|[{,\\s])(?<!\\bcase\\s+)['"]?(${FIXTURE_STATUSES.join("|")})['"]?\\s*:`, "g");
  for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
    const members = new Set([...m[1]!.matchAll(key)].map((x) => x[1]!));
    if (members.size < 2) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index).replace(/\s+/g, " ").trim();
    out.push({ anchor: `map ${before.slice(-30)} :: ${[...members].sort().join(",")}`, members });
  }
  return out;
}

/** Loop R M4: a `switch` whose `case` labels are statuses. The body is read to its MATCHING brace, so a nested
 *  `{ … }` inside a case (an object literal, a block) does not hide it as it hid `court-card.tsx`'s from the map
 *  shape. A brace inside a string literal would mis-count; none in ROOTS does today, and the per-shape count above
 *  would not notice one, so this is the scanner's stated limit. */
function findSwitches(text: string): { anchor: string; members: Set<string> }[] {
  const out: { anchor: string; members: Set<string> }[] = [];
  const label = new RegExp(`\\bcase\\s+['"](${FIXTURE_STATUSES.join("|")})['"]\\s*:`, "g");
  for (const m of text.matchAll(/\bswitch\s*\(/g)) {
    let i = m.index + m[0].length;
    for (let depth = 1; i < text.length && depth > 0; i++) depth += text[i] === "(" ? 1 : text[i] === ")" ? -1 : 0;
    const open = text.indexOf("{", i);
    if (open < 0 || text.slice(i, open).trim() !== "") continue;
    let close = open + 1;
    for (let depth = 1; close < text.length && depth > 0; close++) depth += text[close] === "{" ? 1 : text[close] === "}" ? -1 : 0;
    const members = new Set([...text.slice(open, close).matchAll(label)].map((x) => x[1]!));
    if (members.size < 2) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index).replace(/\s+/g, " ").trim();
    out.push({ anchor: `switch ${before.slice(-30)} :: ${[...members].sort().join(",")}`, members });
  }
  return out;
}

/** The shape that found a set, read off its anchor's prefix (a bracket span carries none). */
function shapeOf(anchor: string): "switch" | "chain" | "map" | "set" {
  return anchor.startsWith("switch ") ? "switch" : anchor.startsWith("chain ") ? "chain" : anchor.startsWith("map ") ? "map" : "set";
}

function walk(dir: string, out: string[]): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== "node_modules" && e !== "__tests__" && e !== ".next") walk(p, out);
    } else if (/\.(ts|tsx|sql|mjs)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

describe("spec §5.4.6: every fixture-status set of two or more literals (four shapes; single-literal comparisons are the stated blind spot) is found, classified, and agrees with its class", () => {
  const files = ROOTS.flatMap((r) => walk(join(REPO, r), []));
  const found = files.flatMap((f) => {
    const text = readFileSync(f, "utf8");
    return [...findSets(text), ...findChains(text), ...findMaps(text), ...findSwitches(text)].map((s) => ({
      multiLine: undefined as true | undefined,
      ...s,
      file: relative(REPO, f),
    }));
  });
  const key = (s: { file: string; anchor: string }) => `${s.file} ## ${s.anchor}`;

  it("empty case first: a text with no status literal yields no set, in any of the three shapes", () => {
    expect(findSets("const x = ['a', 'b'];")).toEqual([]);
    expect(findChains('return s === "a" || s === "b";')).toEqual([]);
    expect(findMaps("const m = { a: 1, b: 2 };")).toEqual([]);
    // and ONE status literal is not a set either
    expect(findSets("const x = ['decided', 'b'];")).toEqual([]);
  });
  it("loop R M4: a braced switch, a chain broken across lines, and a `case` label that is not a map key", () => {
    // A switch whose body holds a nested brace (`court-card.tsx` `statusChip`) was invisible: the map shape's span
    // cannot cross a brace, and a `case` literal follows no `===`. Its members are its `case` labels.
    const braced = 'switch (s) { case "decided": return { a: 1 }; case "finalized": { break; } default: return null; }';
    expect(findSwitches(braced).map((x) => [...x.members].sort())).toEqual([["decided", "finalized"]]);
    expect(findSwitches('switch (f(s)) {\n  case "in_play":\n  case "scheduled":\n    return 1;\n}').map((x) => [...x.members].sort())).toEqual([["in_play", "scheduled"]]);
    // empty cases: no status label, and ONE status label, are not sets
    expect(findSwitches('switch (s) { case "a": return 1; case "b": return 2; }')).toEqual([]);
    expect(findSwitches('switch (s) { case "decided": return 1; default: return 2; }')).toEqual([]);
    // the map shape no longer reads a `case` label as a key (one site, one shape)
    expect(findMaps('switch (s) { case "decided": x(); case "finalized": y(); }')).toEqual([]);
    // a comparison chain broken across lines, at either end of the break
    expect(findChains('return s === "decided" ||\n  s === "finalized";').map((x) => [...x.members].sort())).toEqual([["decided", "finalized"]]);
    expect(findChains('return s === "decided"\n  && s !== "finalized";').map((x) => [...x.members].sort())).toEqual([["decided", "finalized"]]);
    // two separate statements on adjacent lines are not one chain
    expect(findChains('const a = s === "decided";\nconst b = s === "finalized";')).toEqual([]);
  });
  it("C19: the chain and map shapes are found (the positive pairs)", () => {
    expect(findSets("const x = ['decided', 'finalized'];").map((x) => [...x.members].sort())).toEqual([["decided", "finalized"]]);
    expect(findChains('return s === "decided" || s === "finalized";').map((x) => [...x.members].sort())).toEqual([["decided", "finalized"]]);
    expect(findMaps("const TONE: Record<Status, string> = { scheduled: 'x', in_play: 'y' };").map((x) => [...x.members].sort())).toEqual([["in_play", "scheduled"]]);
  });
  it("found at least one set, and every found set is in the ledger", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(found.length).toBeGreaterThan(0);
    // Loop R M4, anti-vacuity per shape: each shape this sweep claims finds at least one real set in the tree, so a
    // scanner broken to return nothing reads red here, not as a smaller green ledger.
    for (const shape of ["switch", "chain", "map", "set"] as const) {
      const n = found.filter((s) => shapeOf(s.anchor) === shape).length;
      expect(n, `sets found by the ${shape} shape`).toBeGreaterThan(0);
    }
    expect(
      found.filter((s) => s.anchor.startsWith("chain ") && s.multiLine).length,
      "chains broken across lines (division-phase.ts, the fixture page)",
    ).toBeGreaterThan(0);
    const keys = new Set(STATUS_SET_LEDGER.map(key));
    const unclassified = found.filter((s) => !keys.has(key(s))).map(key);
    expect(unclassified, `unclassified sets (add a ledger row):\n${unclassified.join("\n")}`).toEqual([]);
  });
  it("every ledger row is still found (a stale row is a failure), and no row is listed twice", () => {
    const keys = new Set(found.map(key));
    const stale = STATUS_SET_LEDGER.filter((r) => !keys.has(key(r))).map(key);
    expect(stale, `stale ledger rows:\n${stale.join("\n")}`).toEqual([]);
    expect(new Set(STATUS_SET_LEDGER.map(key)).size).toBe(STATUS_SET_LEDGER.length);
  });
  it("each set holds needs_decision exactly when its class says it must", () => {
    let checked = 0;
    let inSets = 0;
    const want: Record<StatusSetClass, boolean | null> = {
      played: false,
      "to-play": false,
      locked: false,
      void: false,
      "falls-through": false,
      "not-finished": true,
      "took-place": true,
      "not-live": true,
      "needs-attention": true,
      "status-domain": true,
      "historical-sql": null,
      "other-vocabulary": null,
      unreachable: null,
      "not-a-set": null,
    };
    for (const s of found) {
      const row = STATUS_SET_LEDGER.find((r) => r.file === s.file && r.anchor === s.anchor)!;
      const must = want[row.class];
      if (must === null) continue;
      expect(s.members.has("needs_decision"), `${s.file} ## ${s.anchor} (${row.class}: ${row.why})`).toBe(must);
      checked++;
      if (must) inSets++;
    }
    // Both directions are reached, not one: a sweep whose every row is OUT could not see a missing IN.
    expect(checked).toBeGreaterThan(0);
    expect(inSets).toBeGreaterThan(0);
    expect(checked - inSets).toBeGreaterThan(0);
  });
});
