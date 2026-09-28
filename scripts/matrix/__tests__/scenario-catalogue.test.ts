// Design §4's scenario catalogue as data (W1b Task 4; rulings 26, 28, 30).
// Every expected value here is parsed from the design doc, the rulings in
// _INDEX.md or W1a's own scenario registry — never read back from
// scenario-catalogue.ts. No count is typed (pre-flight ruling R-PF2): the
// design declares its own parent count and the test reads it.
//
// The catalogue is sport-free (a scenario id does not vary by sport); the one
// sport-shaped input, a regression's cell, is swept over the whole registry.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS } from "../lib/catalogue.ts";
import { DRIVING_WAVE } from "../lib/scenarios/common.ts";
import { SCENARIO_KEYS } from "../lib/slice.ts";
import {
  ATOMIC, HARNESS_SCENARIO, LIFECYCLE_ID, PARENTS, REGRESSIONS_PATH, l2Atomic, l3Atomic, loadRegressions, parseRegressions,
} from "../lib/scenario-catalogue.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const design = readFileSync(resolve(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-design.md"), "utf8");
const flat = design.replace(/\n/g, " ");
const section = design.slice(design.indexOf("Catalogue ("), design.indexOf("**Known 🚫"));
const ID = /\b([RMFDPQXCE]\d{1,2}) /g;
/** Each design id with its text up to the next id or line end. */
const designTexts = (): Map<string, string> => {
  const out = new Map<string, string>();
  for (const line of section.split("\n").filter((l) => l.startsWith("- "))) {
    const hits = [...line.matchAll(ID)];
    hits.forEach((m, i) => out.set(m[1]!, line.slice(m.index! + m[0].length, hits[i + 1]?.index ?? line.length).replace(/ · $/, "")));
  }
  return out;
};

describe("scenario catalogue — parents are the design's §4 list, in order", () => {
  it("the design declares its own count, and PARENTS has exactly those ids in design order", () => {
    const declared = Number(/Catalogue \((\d+) scenario IDs/.exec(design)?.[1]);
    const ids = [...designTexts().keys()];
    expect(declared).toBeGreaterThan(0);
    expect(ids.length).toBe(declared);
    expect(PARENTS.map((p) => p.id)).toEqual(ids);
  });
  it("every compound the design names is split", () => {
    const named = /such as ([A-Z0-9, ]+) become/.exec(flat)?.[1]?.split(/,\s*/).map((s) => s.trim()) ?? [];
    expect(named.length).toBeGreaterThan(0);
    for (const id of named) expect(PARENTS.find((p) => p.id === id)?.atoms.length ?? 0, id).toBeGreaterThan(1);
  });
  it("an alternative wording (vs / or / slash) is split or carries a written noSplit reason", () => {
    let judged = 0;
    for (const [id, text] of designTexts()) {
      if (!/\bvs\b|\bor\b|\//.test(text)) continue;
      judged++;
      const p = PARENTS.find((x) => x.id === id)!;
      expect(p.atoms.length > 1 || (p.noSplit ?? "").length > 10, `${id}: "${text}"`).toBe(true);
    }
    expect(judged).toBeGreaterThan(0);
  });
  it("noSplit is only ever on an unsplit parent", () => {
    let judged = 0;
    for (const p of PARENTS) if (p.noSplit !== undefined) { judged++; expect(p.atoms.length, p.id).toBe(0); }
    expect(judged).toBeGreaterThan(0);
  });
});

describe("atomic cases", () => {
  it("empty-case guard: ATOMIC is non-empty and derived (a split parent yields its atoms, others yield themselves)", () => {
    const expected = PARENTS.reduce((n, p) => n + Math.max(1, p.atoms.length), 0);
    expect(expected).toBeGreaterThan(0);
    expect(ATOMIC.length).toBe(expected);
    expect(new Set(ATOMIC.map((a) => a.id)).size).toBe(ATOMIC.length);
    for (const a of ATOMIC) expect(a.id).toMatch(/^[RMFDPQXCE]\d{1,2}[a-c]?$/);
  });
  it("catalogue order: atoms follow PARENTS order, and a split parent's suffixes run a, b[, c] with no gap", () => {
    const parentsInOrder = ATOMIC.map((a) => a.parent).filter((p, i, xs) => xs.indexOf(p) === i);
    expect(parentsInOrder).toEqual(PARENTS.map((p) => p.id));
    let split = 0;
    for (const p of PARENTS) {
      const ids = ATOMIC.filter((a) => a.parent === p.id).map((a) => a.id);
      if (p.atoms.length === 0) { expect(ids, p.id).toEqual([p.id]); continue; }
      split++;
      expect(ids, p.id).toEqual(["a", "b", "c"].slice(0, p.atoms.length).map((s) => `${p.id}${s}`));
      for (const a of ATOMIC.filter((x) => x.parent === p.id)) expect(a.family, a.id).toBe(p.id[0]);
    }
    expect(split).toBeGreaterThan(0);
  });
  it("every atom id the design or ruling 26 names exists (M4a/M4b, M12a–c, E4a/E4b as of 2026-09-28)", () => {
    const named = [...section.matchAll(/\(([RMFDPQXCE]\d{1,2}[a-c])\)/g)].map((m) => m[1]!);
    const index = readFileSync(resolve(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md"), "utf8");
    const r26 = /\n26\. \*\*O9[^(]*\(([^)]*)\)/.exec(index)?.[1] ?? "";
    const fromRuling = [...r26.matchAll(/\b([RMFDPQXCE]\d{1,2}[a-c])\b/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    expect(fromRuling.length).toBeGreaterThan(0);
    const ids = new Set(ATOMIC.map((a) => a.id));
    for (const id of [...named, ...fromRuling]) expect(ids.has(id), id).toBe(true);
  });
  it("the design's needs-times parents each have an L3-excluded atom", () => {
    const named = (/Cases that need times\*\* \(([^)]+)\)/.exec(flat)?.[1] ?? "")
      .split(/,\s*/).filter((s) => /^[RMFDPQXCE]\d{1,2}$/.test(s));
    expect(named.length).toBeGreaterThan(0); // E4, X1, D5 as of 2026-09-28
    for (const p of named) {
      const atoms = ATOMIC.filter((a) => a.parent === p);
      expect(atoms.some((a) => a.l3Excluded !== null), p).toBe(true);
    }
  });
  it("ruling 26: E2 is the only entry-path atom in L3", () => {
    expect(l3Atomic().filter((a) => a.family === "E").map((a) => a.id)).toEqual(["E2"]);
  });
  it("every atom is on at least one layer; L2 excludes only the API-only E2", () => {
    for (const a of ATOMIC) expect(a.layers.length, a.id).toBeGreaterThan(0);
    expect(ATOMIC.filter((a) => !a.layers.includes("L2")).map((a) => a.id)).toEqual(["E2"]);
    expect(l2Atomic().length + 1).toBe(ATOMIC.length);
  });
  it("l3Excluded and the L3 layer agree on every atom (a reason means off L3, no reason means on it)", () => {
    for (const a of ATOMIC) expect(a.layers.includes("L3"), a.id).toBe(a.l3Excluded === null);
    expect(l3Atomic().length + ATOMIC.filter((a) => a.l3Excluded !== null).length).toBe(ATOMIC.length);
  });
  it("the design's known 🚫 parents are marked, each with the owning wave the design names", () => {
    const text = design.slice(design.indexOf("**Known 🚫"), design.indexOf("**Cases that need times")).replace(/\n/g, " ");
    const listed = new Set([...text.matchAll(/\b([RMFDPQXCE]\d{1,2})\b/g)].map((m) => m[1]!));
    listed.delete("X3"); // named in that paragraph as "built in W2", not as 🚫
    // "division-level D1, D2, R13 in W9; D4 in W4; Q4 in W4; C5 in W5"
    const owner = new Map<string, string>();
    for (const m of text.matchAll(/((?:[RMFDPQXCE]\d{1,2}(?:, )?)+) in (W\d+)/g)) {
      for (const id of m[1]!.split(/,\s*/).filter((s) => s.length > 0)) owner.set(id, m[2]!);
    }
    const marked = new Set(ATOMIC.filter((a) => a.knownNoPath !== null).map((a) => a.parent));
    expect(listed.size).toBeGreaterThan(0);
    expect(new Set(owner.keys())).toEqual(listed);
    expect(marked).toEqual(listed);
    let judged = 0;
    for (const a of ATOMIC.filter((x) => x.knownNoPath !== null)) { judged++; expect(a.knownNoPath, a.id).toBe(owner.get(a.parent)); }
    expect(judged).toBeGreaterThanOrEqual(listed.size);
  });
  it("ruling 30: the design's UI-only 🚫 atoms carry l2NoPath with the named wave, and stay in both layers", () => {
    const from = design.slice(design.indexOf("**Known UI-only 🚫"));
    const para = from.slice(0, from.indexOf("\n\n"));
    const listed = [...para.matchAll(/\b([RMFDPQXCE]\d{1,2}[a-c])\b/g)].map((m) => m[1]!);
    const wave = /owed to (W\d+)/.exec(para)?.[1];
    expect(listed.length).toBeGreaterThan(0); // M12b as of 2026-09-28
    expect(wave).toBeDefined();
    expect(ATOMIC.filter((a) => a.l2NoPath !== null).map((a) => a.id)).toEqual(listed);
    for (const id of listed) {
      const a = ATOMIC.find((x) => x.id === id)!;
      expect(a.l2NoPath, id).toBe(wave);
      expect(a.layers, id).toEqual(["L2", "L3"]); // L3 runs over HTTP; the L2 run records the 🚫
      expect(a.knownNoPath, id).toBeNull(); // not a design-wide 🚫: the API route exists
    }
  });
  it("the W1a harness map is a one-to-one cover of W1a's scenarios, onto real atoms", () => {
    const ids = new Set([LIFECYCLE_ID, ...ATOMIC.map((a) => a.id)]);
    const entries = Object.entries(HARNESS_SCENARIO);
    expect(entries.length).toBeGreaterThan(0);
    for (const [atom, key] of entries) {
      expect(ids.has(atom), atom).toBe(true);
      expect(SCENARIO_KEYS).toContain(key);
    }
    // Every W1a scenario is mapped, and no two atoms claim the same one.
    expect(new Set(entries.map(([, key]) => key))).toEqual(new Set(SCENARIO_KEYS));
    expect(entries.length).toBe(SCENARIO_KEYS.length);
  });
});

describe("regression cases (R29)", () => {
  const base = { id: "MB-001", title: "t", issue: "#879", cell: "league|generic", variant: "score", check: "I7-rr-no-pair-over-legs", seed: 42, path: "0:1", replayPath: "CC:B", fence: null, status: "open", found: "2026-09-28", runId: "fm-w1b-model" };
  const file = (...regressions: unknown[]) => ({ schemaVersion: 1, regressions });
  it("empty case first: the committed file parses to a list (empty until a shrunk failure is committed)", () => {
    const rs = parseRegressions(JSON.parse(readFileSync(resolve(REPO, REGRESSIONS_PATH), "utf8")));
    expect(Array.isArray(rs)).toBe(true);
  });
  it("loadRegressions' default root finds the committed file (a wrong root is ENOENT, not an empty list)", () => {
    expect(loadRegressions()).toEqual(parseRegressions(JSON.parse(readFileSync(resolve(REPO, REGRESSIONS_PATH), "utf8"))));
    expect(() => loadRegressions(resolve(REPO, "scripts"))).toThrow(/ENOENT/);
  });
  it("a well-formed entry parses; an unknown cell, a duplicate id, a bad id or a missing seed is refused", () => {
    expect(parseRegressions(file(base))).toHaveLength(1);
    expect(() => parseRegressions(file({ ...base, cell: "nope|generic" }))).toThrow();
    expect(() => parseRegressions(file(base, base))).toThrow(/duplicate/);
    expect(() => parseRegressions(file({ ...base, id: "X-1" }))).toThrow();
    const { seed: _s, ...noSeed } = base;
    expect(() => parseRegressions(file(noSeed))).toThrow();
  });
  it("a stray key or another schema version is refused (the file is reviewed, so drift is loud)", () => {
    expect(() => parseRegressions(file({ ...base, extra: 1 }))).toThrow();
    expect(() => parseRegressions({ schemaVersion: 2, regressions: [base] })).toThrow();
  });
  it("second call: the duplicate-id check is per file, so parsing the same file twice passes both times", () => {
    expect(parseRegressions(file(base))).toHaveLength(1);
    expect(parseRegressions(file(base))).toHaveLength(1);
  });
  it("replayPath (R-PF9): a null one parses, a missing or empty one is refused", () => {
    expect(parseRegressions(file({ ...base, replayPath: null }))[0]!.replayPath).toBeNull();
    const { replayPath: _r, ...noReplay } = base;
    expect(() => parseRegressions(file(noReplay))).toThrow();
    expect(() => parseRegressions(file({ ...base, replayPath: "" }))).toThrow();
  });
  it("every cell on the grid (every row × every registered sport) is accepted", () => {
    let checked = 0;
    for (const row of ROW_KEYS) {
      for (const sport of SPORT_KEYS) {
        expect(parseRegressions(file({ ...base, cell: `${row}|${sport}` }))[0]!.cell).toBe(`${row}|${sport}`);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(checked).toBe(ROW_KEYS.length * SPORT_KEYS.length);
  });
});

describe("Q-A guard — a deferral never names a finished wave (ruling 28)", () => {
  const MATRIX = resolve(REPO, "scripts/matrix");
  /** Every module the harness ships (test files and fixtures excluded). */
  const shipped = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "__tests__" ? [] : shipped(join(d, e.name)))
      : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(d, e.name)] : []);
  /** A deferral's wave argument: a string literal, or DRIVING_WAVE by value. */
  const waveOf = (arg: string): string | null => {
    const a = arg.trim();
    const lit = /^["'`]([^"'`]+)["'`]$/.exec(a)?.[1];
    if (lit !== undefined) return lit;
    return a === "DRIVING_WAVE" ? DRIVING_WAVE : null;
  };
  it("every wave a ScenarioUnsupported/RowBuildDeferred names has an _INDEX status row that is not done", () => {
    const index = readFileSync(resolve(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md"), "utf8");
    const start = index.indexOf("## Status");
    const status = index.slice(start, index.indexOf("\n## ", start + 1));
    const rows = new Map([...status.matchAll(/^\| (W[\w-]+) \| [^|]* \| (.*) \|$/gm)].map((m) => [m[1]!, m[2]!]));
    expect(rows.size).toBeGreaterThan(0);
    const waves = new Set<string>();
    const unread: string[] = [];
    let sites = 0;
    const modules = shipped(MATRIX);
    expect(modules.length).toBeGreaterThan(0);
    for (const f of modules) {
      const src = readFileSync(f, "utf8");
      const args = [
        ...[...src.matchAll(/new ScenarioUnsupported\(\s*([^,)]+)[,)]/g)].map((m) => m[1]!),
        ...[...src.matchAll(/new RowBuildDeferred\(\s*[^,)]+,\s*([^,)]+)[,)]/g)].map((m) => m[1]!),
      ];
      for (const arg of args) {
        sites++;
        const w = waveOf(arg);
        if (w === null) unread.push(`${f}: ${arg}`); else waves.add(w);
      }
    }
    // A site whose wave the guard cannot read would be skipped silently.
    expect(unread, "a deferral names its wave by an expression this guard cannot read").toEqual([]);
    expect(sites).toBeGreaterThan(0);
    expect(waves.size).toBeGreaterThan(0);
    for (const w of waves) {
      expect(rows.has(w), `${w} has no status row in _INDEX.md`).toBe(true);
      expect(rows.get(w), w).toMatch(/^(not started|in progress|awaiting)/i);
    }
  });
});
