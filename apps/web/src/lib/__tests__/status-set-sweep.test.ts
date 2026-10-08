// W2a Task 7 — spec §5.4.6 (risk row 2): every list of fixtures.status literals, in TS and SQL, is FOUND by scanning
// and CLASSIFIED in the ledger. Unclassified = failure; a ledger row no longer found = failure; zero found = failure.
// Later loops re-run it (preflight C19): lane P1 (tools/matrix/lib) and Task 17 (scripts/) report new sets for the
// ledger; a red sweep blocks the PR.
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
function findChains(text: string): { anchor: string; members: Set<string> }[] {
  const out: { anchor: string; members: Set<string> }[] = [];
  const cmp = new RegExp(`[!=]==?\\s*['"](${FIXTURE_STATUSES.join("|")})['"]`, "g");
  let offset = 0;
  for (const line of text.split("\n")) {
    const hits = [...line.matchAll(cmp)];
    const members = new Set(hits.map((x) => x[1]!));
    if (members.size >= 2) {
      const at = offset + hits[0]!.index;
      const before = text.slice(Math.max(0, at - 40), at).replace(/\s+/g, " ").trim();
      out.push({ anchor: `chain ${before.slice(-30)} :: ${[...members].sort().join(",")}`, members });
    }
    offset += line.length + 1;
  }
  return out;
}
function findMaps(text: string): { anchor: string; members: Set<string> }[] {
  const out: { anchor: string; members: Set<string> }[] = [];
  const key = new RegExp(`(?:^|[{,\\s])['"]?(${FIXTURE_STATUSES.join("|")})['"]?\\s*:`, "g");
  for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
    const members = new Set([...m[1]!.matchAll(key)].map((x) => x[1]!));
    if (members.size < 2) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index).replace(/\s+/g, " ").trim();
    out.push({ anchor: `map ${before.slice(-30)} :: ${[...members].sort().join(",")}`, members });
  }
  return out;
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

describe("spec §5.4.6: every fixture-status set is found, classified, and agrees with its class", () => {
  const files = ROOTS.flatMap((r) => walk(join(REPO, r), []));
  const found = files.flatMap((f) => {
    const text = readFileSync(f, "utf8");
    return [...findSets(text), ...findChains(text), ...findMaps(text)].map((s) => ({ ...s, file: relative(REPO, f) }));
  });
  const key = (s: { file: string; anchor: string }) => `${s.file} ## ${s.anchor}`;

  it("empty case first: a text with no status literal yields no set, in any of the three shapes", () => {
    expect(findSets("const x = ['a', 'b'];")).toEqual([]);
    expect(findChains('return s === "a" || s === "b";')).toEqual([]);
    expect(findMaps("const m = { a: 1, b: 2 };")).toEqual([]);
    // and ONE status literal is not a set either
    expect(findSets("const x = ['decided', 'b'];")).toEqual([]);
  });
  it("C19: the chain and map shapes are found (the positive pairs)", () => {
    expect(findSets("const x = ['decided', 'finalized'];").map((x) => [...x.members].sort())).toEqual([["decided", "finalized"]]);
    expect(findChains('return s === "decided" || s === "finalized";').map((x) => [...x.members].sort())).toEqual([["decided", "finalized"]]);
    expect(findMaps("const TONE: Record<Status, string> = { scheduled: 'x', in_play: 'y' };").map((x) => [...x.members].sort())).toEqual([["in_play", "scheduled"]]);
  });
  it("found at least one set, and every found set is in the ledger", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(found.length).toBeGreaterThan(0);
    const keys = new Set(STATUS_SET_LEDGER.map(key));
    expect(found.filter((s) => !keys.has(key(s))).map(key)).toEqual([]);
  });
  it("every ledger row is still found (a stale row is a failure), and no row is listed twice", () => {
    const keys = new Set(found.map(key));
    expect(STATUS_SET_LEDGER.filter((r) => !keys.has(key(r))).map(key)).toEqual([]);
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
