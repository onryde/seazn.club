// Design §4's scenario catalogue as data (W1b Task 4; rulings 26, 28, 30).
// Every expected value here is parsed from the design doc, the rulings in
// _INDEX.md, the W1b plan or W1a's own scenario registry — never read back
// from scenario-catalogue.ts. No count is typed (pre-flight ruling R-PF2): the
// design declares its own parent count and the test reads it.
//
// The catalogue is sport-free (a scenario id does not vary by sport); the one
// sport-shaped input, a regression's cell, is swept over the whole registry.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as TS from "typescript";
import { describe, expect, it } from "vitest";
import { ROW_KEYS, SPORT_KEYS } from "../lib/catalogue.ts";
import { SCENARIO_KEYS } from "../lib/slice.ts";
import {
  ATOMIC, HARNESS_SCENARIO, LIFECYCLE_ID, MATCH_REQUIRED_CHECKS, PARENTS, REGRESSIONS_PATH, l2Atomic, l3Atomic, loadRegressions, parseRegressions, replayFences,
} from "../lib/scenario-catalogue.ts";
import { productMessageOf } from "../lib/driver/types.ts";
import { FENCES } from "../lib/model/fences.ts";
import { NEXT_MATCH_CHECK, ORIENTATION_CHECK, ROSTER_LOCK_CHECK } from "../lib/model/state.ts";
import { STEP_INVARIANTS } from "../lib/invariants.ts";
import { thrownWords } from "./product-text.ts";

// `typescript` through require, not import: vite's transform chokes on the
// ~9 MB CJS bundle and the file then fails to collect (see
// apps/web/src/__tests__/app-module-exports.test.ts). The type side is erased.
const ts: typeof TS = createRequire(import.meta.url)("typescript");

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const design =readFileSync(resolve(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-design.md"), "utf8");
const INDEX = readFileSync(resolve(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/_INDEX.md"), "utf8");
const PLAN = readFileSync(resolve(REPO, "docs/superpowers/plans/2026-09-28-format-matrix-w1b.md"), "utf8");
const flat = design.replace(/\n/g, " ");
const section = design.slice(design.indexOf("Catalogue ("), design.indexOf("**Known 🚫"));
const ID = /\b([RMFDPQXCE]\d{1,2}) /g;
const PARENT_ID = /^[RMFDPQXCE]\d{1,2}$/;
/** Each design id with its text up to the next id or line end. */
const designTexts = (): Map<string, string> => {
  const out = new Map<string, string>();
  for (const line of section.split("\n").filter((l) => l.startsWith("- "))) {
    const hits = [...line.matchAll(ID)];
    hits.forEach((m, i) => out.set(m[1]!, line.slice(m.index! + m[0].length, hits[i + 1]?.index ?? line.length).replace(/ · $/, "")));
  }
  return out;
};
/** Design prose without its markdown emphasis or code ticks. */
const plain = (s: string): string => s.replace(/\*\*/g, "").replace(/`/g, "").replace(/\s+/g, " ").trim();
const words = (s: string): string[] => (plain(s).toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []).filter((w) => w.length >= 3);

describe("scenario catalogue — parents are the design's §4 list, in order", () => {
  it("the design declares its own count, and PARENTS has exactly those ids in design order", () => {
    const declared = Number(/Catalogue \((\d+) scenario IDs/.exec(design)?.[1]);
    const ids = [...designTexts().keys()];
    expect(declared).toBeGreaterThan(0);
    expect(ids.length).toBe(declared);
    expect(PARENTS.map((p) => p.id)).toEqual(ids);
  });
  it("titles are the design's: an unsplit parent's is its design text, a split parent's stem uses only the design's words", () => {
    const texts = designTexts();
    let whole = 0;
    let stems = 0;
    for (const p of PARENTS) {
      const text = texts.get(p.id);
      expect(text, p.id).toBeDefined();
      if (p.atoms.length === 0) {
        whole++;
        expect(p.title, p.id).toBe(plain(text!));
      } else {
        stems++;
        const vocab = new Set(words(text!));
        const stray = words(p.title).filter((w) => !vocab.has(w));
        expect(stray, `${p.id} "${p.title}" vs "${text}"`).toEqual([]);
      }
    }
    expect(whole).toBeGreaterThan(0);
    expect(stems).toBeGreaterThan(0);
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
  it("the atomisation is design §4's (final batch FB-15): every split parent names its atoms, (Xa)…(Xc) in order, and ATOMIC is exactly those", () => {
    // T4 review M-4: deleting an atom (R4c, X4c) must red, so each split
    // parent's atom ids are read from its own design text, never from the
    // plan or from catalogue.ts.
    const texts = designTexts();
    const named = [...texts].map(([id, text]) => ({ id, suffixes: [...text.matchAll(new RegExp(`\\((${id})([a-c])\\)`, "g"))].map((m) => m[2]!) }));
    // The parse is pinned to the design's parent list, so a broken one cannot pass as "no atoms".
    expect(named.map((p) => p.id)).toEqual(PARENTS.map((p) => p.id));
    let split = 0;
    for (const p of named) {
      if (p.suffixes.length === 0) continue;
      split++;
      expect(p.suffixes, `${p.id}: atoms named in order, from a`).toEqual(["a", "b", "c"].slice(0, p.suffixes.length));
    }
    expect(split, "design §4 names no atom").toBeGreaterThan(0);
    expect(split).toBe(PARENTS.filter((p) => p.atoms.length > 0).length);
    const ids = named.flatMap((p) => (p.suffixes.length === 0 ? [p.id] : p.suffixes.map((x) => `${p.id}${x}`)));
    expect(ATOMIC.map((a) => a.id)).toEqual(ids);
  });
  it("every atom id the design or ruling 26 names exists (M4a/M4b, M12a–c, E4a/E4b as of 2026-09-28)", () => {
    const named = [...section.matchAll(/\(([RMFDPQXCE]\d{1,2}[a-c])\)/g)].map((m) => m[1]!);
    const r26 = /\n26\. \*\*O9[^(]*\(([^)]*)\)/.exec(INDEX)?.[1] ?? "";
    const fromRuling = [...r26.matchAll(/\b([RMFDPQXCE]\d{1,2}[a-c])\b/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    expect(fromRuling.length).toBeGreaterThan(0);
    const ids = new Set(ATOMIC.map((a) => a.id));
    for (const id of [...named, ...fromRuling]) expect(ids.has(id), id).toBe(true);
  });
  it("atoms that declare distinguishing facts are pairwise disjoint (R4: half-played side, then finalized fixtures)", () => {
    let parents = 0;
    let pairs = 0;
    for (const p of PARENTS) {
      const withFacts = p.atoms.filter((a) => a.facts !== undefined);
      if (withFacts.length === 0) continue;
      parents++;
      // Facts on some atoms but not all would leave the others unjudged.
      expect(withFacts.length, `${p.id}: every atom states its facts`).toBe(p.atoms.length);
      for (let i = 0; i < p.atoms.length; i++) {
        for (let j = i + 1; j < p.atoms.length; j++) {
          const [x, y] = [p.atoms[i]!.facts!, p.atoms[j]!.facts!];
          const differs = Object.keys(x).some((k) => k in y && x[k] !== y[k]);
          expect(differs, `${p.id}${p.atoms[i]!.suffix} and ${p.id}${p.atoms[j]!.suffix} overlap: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`).toBe(true);
          pairs++;
        }
      }
    }
    expect(parents).toBeGreaterThan(0);
    expect(pairs).toBeGreaterThan(0);
  });
  it("needs times (design §4): every atom of a needs-times parent is off L3, except the atoms the design says run in L3", () => {
    const list = /Cases that need times\*\* \(([^)]+)\)/.exec(flat)?.[1];
    expect(list, "the design's 'Cases that need times' sentence is gone").toBeDefined();
    const items = list!.split(/,\s*/).map((s) => s.trim());
    const parents = items.filter((s) => PARENT_ID.test(s));
    const surfaces = items.filter((s) => !PARENT_ID.test(s));
    expect(parents.length).toBeGreaterThan(0); // E4, X1, D5 as of 2026-09-28
    // "Within D5 only **D5b** (…) needs times; **D5a** (…) runs in L3"
    const ex = /Within ([RMFDPQXCE]\d{1,2}) only \*\*([RMFDPQXCE]\d{1,2}[a-c])\*\*[^;]*? needs times; \*\*([RMFDPQXCE]\d{1,2}[a-c])\*\*[^.]*? runs in L3/.exec(flat);
    expect(ex, "the design's 'Within D5 only D5b needs times; D5a runs in L3' sentence is gone").not.toBeNull();
    const [, exParent, timed, runsInL3] = ex!;
    expect(parents).toContain(exParent);
    expect([timed, runsInL3].map((id) => ATOMIC.find((a) => a.id === id)?.parent)).toEqual([exParent, exParent]);
    let judged = 0;
    for (const a of ATOMIC.filter((x) => parents.includes(x.parent))) {
      judged++;
      if (a.id === runsInL3) expect(a.l3Excluded, `${a.id} runs in L3 (design §4)`).toBeNull();
      else expect(a.l3Excluded, `${a.id} needs times (design §4)`).not.toBeNull();
    }
    expect(judged).toBeGreaterThan(parents.length); // the parents are split
    // A non-id entry is a surface; each must name the atom that carries it.
    const SURFACE_ATOM: Readonly<Record<string, string>> = { "the printed-sheet surface": "E4b" };
    expect(surfaces.length).toBeGreaterThan(0);
    for (const s of surfaces) {
      const atom = ATOMIC.find((a) => a.id === SURFACE_ATOM[s]);
      expect(atom, `needs-times entry "${s}" is neither a scenario id nor a known surface`).toBeDefined();
      expect(atom!.l3Excluded, s).not.toBeNull();
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
  const base = { id: "MB-001", title: "t", issue: "#879", cell: "league|generic", variant: "score", check: "I7-rr-no-pair-over-legs", seed: 42, path: "0:1", replayPath: "CC:B", maxCommands: 30, fencesOn: false, fence: null, match: null, status: "open", found: "2026-09-28", runId: "fm-w1b-model" };
  const file = (...regressions: unknown[]) => ({ schemaVersion: 1, regressions });
  it("empty case first: the committed file parses to a list (empty until a shrunk failure is committed)", () => {
    const rs = parseRegressions(JSON.parse(readFileSync(resolve(REPO, REGRESSIONS_PATH), "utf8")));
    expect(Array.isArray(rs)).toBe(true);
  });
  it("loadRegressions' default root finds the committed file (a wrong root is ENOENT, not an empty list)", () => {
    expect(loadRegressions()).toEqual(parseRegressions(JSON.parse(readFileSync(resolve(REPO, REGRESSIONS_PATH), "utf8"))));
    expect(() => loadRegressions(resolve(REPO, "scripts"))).toThrow(/ENOENT/);
  });
  it("a well-formed entry parses; a duplicate id is refused", () => {
    expect(parseRegressions(file(base))).toHaveLength(1);
    expect(() => parseRegressions(file(base, base))).toThrow(/duplicate/);
  });
  it("every field is guarded: a missing one, and each wrong value for it, is refused", () => {
    // Keyed by the entry's own fields, so a new field without a refusal case is a type error.
    const BAD: Readonly<Record<keyof typeof base, readonly unknown[]>> = {
      id: ["X-1", "MB-NNN", "MB-01"],
      title: [""],
      issue: ["879", ""],
      cell: ["nope|generic", ""],
      variant: [""],
      check: [""],
      seed: [1.5, "42"],
      path: [""],
      replayPath: [""],
      maxCommands: [0, -1, 1.5, "30", null],
      fencesOn: ["true", 0, null],
      fence: ["", "no-such-fence"],
      match: ["", " ", "POST", "the second leg"],
      status: ["stale"],
      found: ["YYYY-MM-DD", "2026-9-28"],
      runId: [""],
    };
    expect(Object.keys(BAD).sort()).toEqual(Object.keys(base).sort());
    let refused = 0;
    for (const key of Object.keys(base) as (keyof typeof base)[]) {
      const { [key]: _gone, ...missing } = base;
      expect(() => parseRegressions(file(missing)), `missing ${key}`).toThrow();
      refused++;
      for (const bad of BAD[key]) {
        expect(() => parseRegressions(file({ ...base, [key]: bad })), `${key}: ${JSON.stringify(bad)}`).toThrow();
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(Object.keys(base).length);
  });
  it("the Task 14 paste stub, as the plan prints it, is refused until its id, title and date are filled", () => {
    const line = PLAN.split("\n").find((l) => l.includes("regression stub for scripts/matrix/catalogue/regressions.json"));
    expect(line, "the plan's Task 14 stub line is gone").toBeDefined();
    const body = /JSON\.stringify\(\{ (.*?) \}, null, 2\)/.exec(line!)?.[1];
    expect(body).toBeDefined();
    // Literal fields exactly as printed; run-time fields (r.cell, slugged, …) take valid values.
    const stub: Record<string, unknown> = {};
    for (const entry of body!.split(/, (?=\w+: )/)) {
      const [, key, expr] = /^(\w+): (.*)$/.exec(entry)!;
      stub[key!] = /^(".*"|null)$/.test(expr!) ? JSON.parse(expr!) : base[key as keyof typeof base];
    }
    // The plan's stub predates `match` (T15 fix round 2) and the replay
    // settings (W1c, W1b carry b): every other field, and those three only.
    const LATER = ["match", "maxCommands", "fencesOn"];
    expect(Object.keys(stub).sort()).toEqual(Object.keys(base).filter((k) => !LATER.includes(k)).sort());
    expect(stub.id).toBe("MB-NNN");
    expect(() => parseRegressions(file(stub))).toThrow();
    expect(() => parseRegressions(file({ ...stub, id: "MB-001" }))).toThrow(); // title and date still empty
    expect(() => parseRegressions(file({ ...stub, id: "MB-001", title: "named" }))).toThrow(); // date still YYYY-MM-DD
    // Completed as the plan knew it, it now lacks `match`: refused.
    expect(() => parseRegressions(file({ ...stub, id: "MB-001", title: "named", found: "2026-09-28" }))).toThrow(/match/);
    // …and, with match, the replay settings it never printed: refused.
    expect(() => parseRegressions(file({ ...stub, id: "MB-001", title: "named", found: "2026-09-28", match: null }))).toThrow(/maxCommands/);
    // Positive pair: completed by a human, with match and the settings, the same stub parses.
    expect(parseRegressions(file({ ...stub, id: "MB-001", title: "named", found: "2026-09-28", match: null, maxCommands: 30, fencesOn: false }))).toHaveLength(1);
  });
  // W1b carry (b): replay regenerates the counterexample from the seed, and
  // the command bound shapes what it generates — a case that does not say how
  // it was found replays under a guess.
  it("a regression case records how it was found: maxCommands (≥1) and fencesOn — without them replay guesses", () => {
    const { maxCommands: _m, fencesOn: _f, ...found } = base;
    expect(() => parseRegressions(file({ ...found }))).toThrow(/maxCommands/);
    expect(() => parseRegressions(file({ ...found, maxCommands: 0, fencesOn: true }))).toThrow(/maxCommands/);
    expect(() => parseRegressions(file({ ...found, maxCommands: 30 }))).toThrow(/fencesOn/);
    expect(() => parseRegressions(file({ ...found, fencesOn: true }))).toThrow(/maxCommands/);
    expect(parseRegressions(file({ ...found, maxCommands: 30, fencesOn: false }))[0]).toMatchObject({ maxCommands: 30, fencesOn: false });
    // Both values of each: none is a default the schema supplies.
    expect(parseRegressions(file({ ...found, maxCommands: 7, fencesOn: true }))[0]).toMatchObject({ maxCommands: 7, fencesOn: true });
  });
  it("the committed cases each record the settings their finding run's own report shows (truth-runs, W1b carry b)", () => {
    // Every committed case names its run; that run's committed model report
    // holds the cell it failed on, with the bound and fences it ran under.
    const reports = new Map<string, { cells: { cell: string; seed: number; maxCommands: number; fences: boolean; failure: { seed: number; path: string } | null }[] }[]>();
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (/^model-report.*\.json$/.test(e.name)) {
          const rep = JSON.parse(readFileSync(join(dir, e.name), "utf8")) as { runId: string; cells: { cell: string; seed: number; maxCommands: number; fences: boolean; failure: { seed: number; path: string } | null }[] };
          reports.set(rep.runId, [...(reports.get(rep.runId) ?? []), rep]);
        }
      }
    };
    walk(resolve(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs"));
    const cases = loadRegressions();
    expect(cases.length, "no committed case — the sweep would be vacuous").toBeGreaterThan(0);
    let checked = 0;
    for (const r of cases) {
      const found = (reports.get(r.runId) ?? []).flatMap((rep) => rep.cells).filter((c) => c.cell === r.cell && c.failure?.seed === r.seed && c.failure.path === r.path);
      expect(found.length, `${r.id}: no committed report of run ${r.runId} holds its failure on ${r.cell}`).toBeGreaterThan(0);
      for (const c of found) expect({ maxCommands: r.maxCommands, fencesOn: r.fencesOn }, r.id).toEqual({ maxCommands: c.maxCommands, fencesOn: c.fences });
      checked++;
    }
    expect(checked).toBe(cases.length);
  });
  // T15-R5 (W1-driving Task 16): a NEW product failure in committed W1-driving
  // model evidence is committed as a regression case (R29), so the next model
  // run judges it instead of rediscovering it. Scoped to the W1-driving runs
  // (run id `w1drv-…`): W1b's first reports (w1b-model-0928a/b) hold failures
  // found before W1b's own shrinks and harness fixes, committed as history.
  // Expected values are the finding report's, never the catalogue's.
  it("T15-R5: every new failure in a committed W1-driving model report is a committed open case — its cell, check, seed, path, replayPath, bound and fences", () => {
    type Cell = { cell: string; verdict: string; maxCommands: number; fences: boolean; failure: { check: string; seed: number; path: string; replayPath: string | null } | null };
    const found: { runId: string; cell: Cell; failure: NonNullable<Cell["failure"]> }[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (/^model-report.*\.json$/.test(e.name)) {
          const rep = JSON.parse(readFileSync(join(dir, e.name), "utf8")) as { runId: string; cells: Cell[] };
          if (!rep.runId.startsWith("w1drv-")) continue;
          for (const c of rep.cells) if (c.verdict === "new-failure" && c.failure !== null) found.push({ runId: rep.runId, cell: c, failure: c.failure });
        }
      }
    };
    walk(resolve(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs"));
    expect(found.length, "no NEW failure in W1-driving model evidence — the pin would be vacuous").toBeGreaterThan(0);
    const cases = loadRegressions();
    let checked = 0;
    for (const { runId, cell, failure } of found) {
      const r = cases.find((c) => c.cell === cell.cell && c.check === failure.check && c.seed === failure.seed && c.path === failure.path);
      expect(r, `${runId} ${cell.cell}: NEW ${failure.check} (seed ${failure.seed}, path ${failure.path}) is not a committed case`).toBeDefined();
      expect({ replayPath: r?.replayPath, maxCommands: r?.maxCommands, fencesOn: r?.fencesOn, runId: r?.runId, status: r?.status }, r?.id)
        .toEqual({ replayPath: failure.replayPath, maxCommands: cell.maxCommands, fencesOn: cell.fences, runId, status: "open" });
      checked++;
    }
    expect(checked).toBe(found.length);
    console.info(`T15-R5: ${checked} W1-driving NEW failure(s), each a committed case`);
  });
  // Controller ruling Q1 (W1c Task 2): a fence named for a case post-dates its
  // finding, so honouring it would fence out the very command the case exists
  // to reproduce. Expected values are the ruling's three branches, not the code.
  it("replay fences (ruling Q1): found fenced and naming no fence → on; found fenced but naming its own fence → off; found unfenced → off", () => {
    expect(FENCES.length, "no fence to name — the fenced-case branch would be vacuous").toBeGreaterThan(0);
    // (1) fencesOn true, fence null → on.
    expect(replayFences(parseRegressions(file({ ...base, fencesOn: true, fence: null }))[0]!)).toBe(true);
    // (3) fencesOn false → off, with or without a fence of its own.
    expect(replayFences(parseRegressions(file({ ...base, fencesOn: false, fence: null }))[0]!)).toBe(false);
    let checked = 0;
    for (const f of FENCES) {
      // (2) fencesOn true, fence set → off: every fence the model has, not one sample.
      expect(replayFences(parseRegressions(file({ ...base, fencesOn: true, fence: f.id }))[0]!), f.id).toBe(false);
      expect(replayFences(parseRegressions(file({ ...base, fencesOn: false, fence: f.id }))[0]!), f.id).toBe(false);
      checked++;
    }
    expect(checked).toBe(FENCES.length);
  });
  // W1-driving Task 16 (T15-R5): the catalogue grew past the 5 cases
  // w1b-model-final replayed, so the check reads EVERY committed --regressions
  // report rather than that one directory: a replay that fences out a case's
  // own command goes NOT REPRODUCED, whichever run made it.
  it("under the replay rule, every replay in every committed --regressions report ran with the fences the rule gives its case, and was known (truth-runs, ruling Q1)", () => {
    type Rep = { runId: string; settings: { regressions: boolean }; cells: { replayOf: string | null; verdict: string; fences: boolean }[] };
    const reps: Rep[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (/^model-report.*\.json$/.test(e.name)) {
          const rep = JSON.parse(readFileSync(join(dir, e.name), "utf8")) as Rep;
          if (rep.settings.regressions) reps.push(rep);
        }
      }
    };
    walk(resolve(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs"));
    expect(reps.length, "no committed replay report — the check would be vacuous").toBeGreaterThan(0);
    const cases = new Map(loadRegressions().map((r) => [r.id, r]));
    expect(cases.size).toBeGreaterThan(0);
    let checked = 0;
    for (const rep of reps) {
      for (const cell of rep.cells) {
        if (cell.replayOf === null) continue;
        const r = cases.get(cell.replayOf);
        if (r === undefined) throw new Error(`${rep.runId}: replays ${cell.replayOf}, which is no committed case`);
        expect([cell.verdict, replayFences(r)], `${rep.runId} ${r.id}`).toEqual(["known-failure", cell.fences]);
        checked++;
      }
    }
    expect(checked, "no replay read across the committed reports").toBeGreaterThan(0);
    console.info(`replay rule: ${checked} replays across ${reps.length} committed --regressions reports`);
  });
  it("…and some committed --regressions report replays EVERY committed case as known: a case added to regressions.json owes a live replay (T15-R5, Task 16)", () => {
    type Rep = { runId: string; settings: { regressions: boolean }; cells: { replayOf: string | null; verdict: string }[] };
    const ids = loadRegressions().map((r) => r.id).sort();
    expect(ids.length, "no committed case — the check would be vacuous").toBeGreaterThan(0);
    const full: string[] = [];
    let reports = 0;
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (/^model-report.*\.json$/.test(e.name)) {
          const rep = JSON.parse(readFileSync(join(dir, e.name), "utf8")) as Rep;
          if (!rep.settings.regressions) continue;
          reports++;
          const known = rep.cells.filter((c) => c.replayOf !== null && c.verdict === "known-failure").map((c) => c.replayOf!).sort();
          if (JSON.stringify(known) === JSON.stringify(ids)) full.push(rep.runId);
        }
      }
    };
    walk(resolve(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs"));
    expect(reports, "no committed --regressions report").toBeGreaterThan(0);
    expect(full, `no committed --regressions report replays all ${ids.length} committed cases known (${ids.join(", ")}) across ${reports} report(s)`).not.toEqual([]);
    console.info(`full replay: ${full.join(", ")} replay(s) all ${ids.length} committed cases known, of ${reports} --regressions report(s)`);
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
  // T15 fix round 2: a generic check (any refusal the model held legal, any
  // harness error) names WHICH failure only through `match`; without it one
  // open case would make every such failure on its cell "known".
  it("match: required on the generic checks (MATCH_REQUIRED_CHECKS) — null or missing refused naming match; a string parses", () => {
    expect(MATCH_REQUIRED_CHECKS.length).toBeGreaterThan(0);
    let checked = 0;
    for (const check of MATCH_REQUIRED_CHECKS) {
      const { match: _m, ...noMatch } = { ...base, check };
      expect(() => parseRegressions(file(noMatch)), `${check}: match missing`).toThrow(/match/);
      expect(() => parseRegressions(file({ ...base, check, match: null })), `${check}: match null`).toThrow(/match/);
      expect(() => parseRegressions(file({ ...base, check, match: "" })), `${check}: match empty`).toThrow(/match/);
      expect(parseRegressions(file({ ...base, check, match: "fixture has an unassigned entrant" }))[0]!.match).toBe("fixture has an unassigned entrant");
      checked++;
    }
    expect(checked).toBe(MATCH_REQUIRED_CHECKS.length);
    // Any other check leaves it null (final batch FB-3 supersedes T15 fix
    // round 3's "may still carry one": the next test).
    expect((MATCH_REQUIRED_CHECKS as readonly string[]).includes(base.check)).toBe(false);
    expect(parseRegressions(file({ ...base, match: null }))[0]!.match).toBeNull();
  });
  it("final batch FB-3: a match on a check that never carries the product's answer is refused — every other check the model throws; null parses there", () => {
    // The harness judges these alone (an invariant, fold parity, a lock): no
    // `said`, so a string match could only ever name nothing.
    const SAIDLESS = [...STEP_INVARIANTS.map((s) => s.id), ORIENTATION_CHECK, ROSTER_LOCK_CHECK, NEXT_MATCH_CHECK, "model-fold-parity"];
    let checked = 0;
    for (const check of SAIDLESS) {
      expect((MATCH_REQUIRED_CHECKS as readonly string[]).includes(check), check).toBe(false);
      expect(() => parseRegressions(file({ ...base, check, match: "fixture has an unassigned entrant" })), check).toThrow(/never carries the product's answer/);
      expect(parseRegressions(file({ ...base, check, match: null }))[0]!.check, check).toBe(check);
      checked++;
    }
    expect(checked).toBe(SAIDLESS.length);
    expect(checked).toBeGreaterThan(4);
  });
  it("final batch FB-3: a trivial match is refused on every check that owes one — too short, or RefusedCall's request line (arrow, status, placeholder, method, path, bare code)", () => {
    // Each rule has an entry only it refuses (the last six), so none rides on another.
    const TRIVIAL = [" ", "POST", "HTTP 500", "→ HTTP 500 INTERNAL", "(no code)", "POST /api/v1/stages/", "WRONG_PHASE",
      "   fixture   ", "a refusal → then a retry", "HTTP 422 WRONG_PHASE: fixture", "(no message)", "DELETE the whole fixture", "a refusal from /api/v1/entrants", "NEXT_MATCH_STARTED"];
    let checked = 0;
    for (const check of MATCH_REQUIRED_CHECKS) {
      for (const match of TRIVIAL) {
        expect(() => parseRegressions(file({ ...base, check, match })), `${check}: ${JSON.stringify(match)}`).toThrow(/match/);
        checked++;
      }
      // The positive pair: the committed product words parse on the same check.
      for (const match of ["fixture has an unassigned entrant", "would strand home_slot_label"]) expect(parseRegressions(file({ ...base, check, match }))[0]!.match).toBe(match);
    }
    expect(checked).toBe(MATCH_REQUIRED_CHECKS.length * TRIVIAL.length);
  });
  it("final batch F-2: fence names a fence the model has — an unknown id is refused; each of FENCES parses", () => {
    expect(FENCES.length).toBeGreaterThan(0);
    expect(() => parseRegressions(file({ ...base, fence: "no-such-fence" }))).toThrow(/fence/);
    expect(() => parseRegressions(file({ ...base, fence: "#879" }))).toThrow(/fence/);
    let checked = 0;
    for (const f of FENCES) {
      expect(parseRegressions(file({ ...base, fence: f.id }))[0]!.fence).toBe(f.id);
      checked++;
    }
    expect(checked).toBe(FENCES.length);
  });
  it("final batch F-2: every fence the model has is a committed OPEN case's fence — a fenced bug is still witnessed (fences.ts)", () => {
    const open = loadRegressions().filter((r) => r.status === "open");
    let checked = 0;
    for (const f of FENCES) {
      const witnesses = open.filter((r) => r.fence === f.id);
      expect(witnesses.map((r) => r.id), `fence ${f.id} names no open committed case`).not.toEqual([]);
      // …and the case and the fence agree on the issue (null when none is filed).
      for (const r of witnesses) expect(r.issue, `${r.id} vs fence ${f.id}`).toBe(f.issue);
      checked++;
    }
    expect(checked).toBe(FENCES.length);
  });
  it("final batch FB-3: every committed match is the product's own words — thrown in its source, and read from the product's message in the committed live evidence", () => {
    /** The product files whose thrown words the committed matches quote. */
    const SOURCES = ["apps/web/src/server/engine-db/append-event.ts", "apps/web/src/server/engine-db/fold.ts", "apps/web/src/server/usecases/stages.ts"];
    const words = new Map(SOURCES.map((p) => [p, thrownWords(p)]));
    const live: { cell: string; check: string; said: string }[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (/^model-report.*\.json$/.test(e.name)) {
          const rep = JSON.parse(readFileSync(join(dir, e.name), "utf8")) as { cells?: { cell: string; failure: { check: string; said?: string | null } | null }[] };
          for (const c of rep.cells ?? []) if (typeof c.failure?.said === "string") live.push({ cell: c.cell, check: c.failure.check, said: c.failure.said });
        }
      }
    };
    walk(resolve(REPO, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/truth-runs"));
    expect(live.length, "no committed live failure carries the product's answer").toBeGreaterThan(0);
    const cases = loadRegressions().filter((r) => r.status === "open" && r.match !== null);
    expect(cases.length, "no committed match — the pin would be vacuous").toBeGreaterThan(0);
    const used = new Set<string>();
    for (const r of cases) {
      const match = r.match ?? "";
      const from = SOURCES.filter((p) => (words.get(p) ?? []).some((w) => w.includes(match)));
      expect(from, `${r.id}: "${match}" is thrown by none of the pinned sources — pin the file that throws it`).not.toEqual([]);
      for (const p of from) used.add(p);
      const heard = live.filter((f) => f.cell === r.cell && f.check === r.check).map((f) => productMessageOf(f.said) ?? "");
      expect(heard.length, `${r.id}: no committed live ${r.check} failure on ${r.cell}`).toBeGreaterThan(0);
      expect(heard.some((m) => m.includes(match)), `${r.id}: "${match}" is in no product message heard on ${r.cell}`).toBe(true);
    }
    // No dead source: every pinned file backs at least one committed match.
    expect([...used].sort()).toEqual([...SOURCES].sort());
  });
  it("the committed file: every case on a generic check carries a match", () => {
    const rs = loadRegressions();
    const generic = rs.filter((r) => (MATCH_REQUIRED_CHECKS as readonly string[]).includes(r.check));
    expect(generic.length, "no committed case on a generic check — the sweep would be vacuous").toBeGreaterThan(0);
    for (const r of generic) expect(r.match, r.id).toEqual(expect.any(String));
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

// --- Q-A guard (ruling 28; W1-driving D7) -----------------------------------------
/** The deferral classes, each with the index of its wave argument. `ModelUnsupported`
 *  is constructed from W1-driving Task 14 on; reading a class nothing builds yet costs nothing. */
const DEFERRALS: Readonly<Record<string, number>> = { ScenarioUnsupported: 0, RowBuildDeferred: 1, NoOrganiserPath: 0, ModelUnsupported: 0 };
/** The one routing call (lib/routing.ts): its argument 0 is the wave. */
const ROUTE_CALL = "routeTo";
/** A wave-id token inside any literal text (T1-R2). Wider than routing.ts WAVE_ID on
 *  purpose: a wave-shaped token that names no programme wave (W11) is refused
 *  too, never read as prose. */
const WAVE_TOKEN = /\bW\d+[a-z]?\b|W1-driving/;
interface RouteScan { sites: number; waves: string[]; unread: string[] }
/** Every route in `src`, read from the TypeScript AST (so a comment is never a
 *  site). Two constructs name a wave: `routeTo(<wave>, …)` and a `new` of a
 *  deferral class. Either is read when its wave argument is a literal; any
 *  other argument — DRIVING_WAVE included, since W1-driving Task 13 deleted
 *  it — is unread. A deferral class's declaration,
 *  a plain import/re-export, `instanceof` and a type position construct
 *  nothing, and neither does routeTo's own declaration or a plain import. ANY
 *  other use — a subclass (its wave hides in `super(`), an `as` alias, a value
 *  alias, `Reflect.construct`, routeTo passed as a value — is unread.
 *  And a string, template or template span that carries a wave-id token
 *  (WAVE_TOKEN: a whole id, or one inside prose such as "lands with W2's
 *  rulebook") anywhere but a site's own wave argument is a stray wave literal
 *  (a map value, a const, a `routedTo:` field, a message, a route's why),
 *  unread by name: a new routing shape cannot hide from the guard (T1-R2).
 *  An unread use fails the guard. */
function scanRoutes(src: string, file = "synthetic.ts"): RouteScan {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: RouteScan = { sites: 0, waves: [], unread: [] };
  const at = (n: TS.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  // Fail closed on a parse error: an unclosed comment or template swallows
  // the code after it, and a deferral inside would read as "no sites".
  // `parseDiagnostics` is the parser's own list (not on the public type).
  for (const d of (sf as unknown as { parseDiagnostics: readonly TS.DiagnosticWithLocation[] }).parseDiagnostics) {
    out.unread.push(`${file}: parse error at ${d.start}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  }
  const waveOf = (arg: TS.Expression | undefined): string | null => {
    if (arg === undefined) return null;
    return ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) ? arg.text : null;
  };
  /** The literals that ARE a route's wave argument: never strays. */
  const declared = new Set<TS.Node>();
  const readSite = (arg: TS.Expression | undefined, where: string): void => {
    out.sites++;
    const w = waveOf(arg);
    if (w === null) { out.unread.push(where); return; }
    out.waves.push(w);
    if (arg !== undefined) declared.add(arg);
  };
  const classify = (id: TS.Identifier, waveIndex: number): void => {
    const p = id.parent;
    const callee: TS.Node = ts.isPropertyAccessExpression(p) && p.name === id ? p : id;
    const host = callee.parent;
    if (ts.isNewExpression(host) && host.expression === callee) { readSite(host.arguments?.[waveIndex], `${at(id)} ${host.getText(sf)}`); return; }
    if (ts.isClassDeclaration(p) && p.name === id) return;
    if ((ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && p.propertyName === undefined) return;
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && p.right === id) return;
    if (ts.isTypeReferenceNode(p)) return;
    out.unread.push(`${at(id)} ${id.text} used as ${ts.SyntaxKind[p.kind]}`);
  };
  const classifyRoute = (id: TS.Identifier): void => {
    const p = id.parent;
    if (ts.isCallExpression(p) && p.expression === id) { readSite(p.arguments[0], `${at(id)} ${p.getText(sf)}: routeTo's wave is not a literal`); return; }
    if (ts.isFunctionDeclaration(p) && p.name === id) return;
    if ((ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && p.propertyName === undefined) return;
    out.unread.push(`${at(id)} ${ROUTE_CALL} used as ${ts.SyntaxKind[p.kind]}`);
  };
  const literals: TS.Node[] = [];
  const visit = (n: TS.Node): void => {
    if (ts.isIdentifier(n)) {
      if (Object.hasOwn(DEFERRALS, n.text)) classify(n, DEFERRALS[n.text]!);
      else if (n.text === ROUTE_CALL) classifyRoute(n);
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      if (WAVE_TOKEN.test(n.text)) literals.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  for (const n of literals) {
    if (!declared.has(n)) out.unread.push(`${at(n)} stray wave literal ${n.getText(sf)}: name a wave only through routeTo or a deferral class`);
  }
  return out;
}
/** A Status-table state that is still owed work. Markdown emphasis is not part of the state. */
const isOpen = (state: string): boolean => /^(not started|in progress|awaiting)/i.test(state.replace(/[*_]/g, "").trim());
/** _INDEX.md's Status table: wave → state. */
function statusRows(): Map<string, string> {
  const start = INDEX.indexOf("## Status");
  const status = INDEX.slice(start, INDEX.indexOf("\n## ", start + 1));
  return new Map([...status.matchAll(/^\| (W[\w-]+) \| [^|]* \| (.*) \|$/gm)].map((m) => [m[1]!, m[2]!]));
}
/** The guard's judgement, apart from the tree it reads: nothing unread, at
 *  least one route read BY THE MODULE SCAN (R25: zero read is a failure, never
 *  "no deferral sites" — false premise 8; the scan's floor is its own, so the
 *  JSON's routes can never stand in for a walk that read nothing, T1-R1), and
 *  every wave a route names has an open Status row. `alsoNamed`: waves the
 *  catalogue's data names (knownNoPath / l2NoPath), judged too but not counted
 *  as routes read. */
function judgeRoutes(scans: readonly RouteScan[], jsonRoutes: readonly string[], rows: ReadonlyMap<string, string>, alsoNamed: readonly string[] = []): { read: number; waves: string[] } {
  expect(scans.flatMap((s) => s.unread), "a route names its wave in a shape this guard cannot read, or a bare wave literal sits outside routeTo").toEqual([]);
  const scanned = scans.reduce((n, s) => n + s.sites, 0);
  expect(scanned, "routes read across every construct by the module scan").toBeGreaterThan(0);
  const read = scanned + jsonRoutes.length;
  const waves = [...new Set([...scans.flatMap((s) => s.waves), ...jsonRoutes, ...alsoNamed])];
  for (const w of waves) {
    expect(rows.has(w), `${w} has no status row in _INDEX.md`).toBe(true);
    expect(isOpen(rows.get(w)!), `${w}: "${rows.get(w)}" is not open`).toBe(true);
  }
  return { read, waves };
}
/** Every module the harness ships (test files and fixtures excluded). */
const shipped = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === "__tests__" ? [] : shipped(join(d, e.name)))
    : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(d, e.name)] : []);

describe("Q-A guard — the route reader", () => {
  it("empty case first: an empty source reads no route and nothing unread", () => {
    expect(scanRoutes("")).toEqual({ sites: 0, waves: [], unread: [] });
  });
  it("reads a literal wave, RowBuildDeferred's second argument, and a namespaced class — and, DRIVING_WAVE being gone (Task 13), an identifier wave is unread", () => {
    expect(scanRoutes(`throw new ScenarioUnsupported("W3", "x");`)).toEqual({ sites: 1, waves: ["W3"], unread: [] });
    const gone = scanRoutes(`throw new ScenarioUnsupported(DRIVING_WAVE, "x");`);
    expect([gone.sites, gone.waves, gone.unread.length]).toEqual([1, [], 1]);
    expect(scanRoutes(`throw new RowBuildDeferred("ladder", "W7");`)).toEqual({ sites: 1, waves: ["W7"], unread: [] });
    expect(scanRoutes(`import * as T from "./types.ts";\nthrow new T.ScenarioUnsupported("W3", "x");`)).toEqual({ sites: 1, waves: ["W3"], unread: [] });
  });
  it("reads routeTo(<literal>, …) and the four deferral classes, NoOrganiserPath and ModelUnsupported included", () => {
    expect(scanRoutes(`export const r = routeTo("W4", "why");`)).toEqual({ sites: 1, waves: ["W4"], unread: [] });
    expect(scanRoutes(`throw new NoOrganiserPath("W2", "x");`)).toEqual({ sites: 1, waves: ["W2"], unread: [] });
    expect(scanRoutes(`throw new ModelUnsupported("W7", "x");`)).toEqual({ sites: 1, waves: ["W7"], unread: [] });
    // A route by identifier: the one construct's declaration and imports are not sites.
    expect(scanRoutes(`import { routeTo } from "./routing.ts";\nexport function routeTo(wave: string, why: string) { return { wave, why }; }\nconst r = routeTo("W1-driving", "why");`))
      .toEqual({ sites: 1, waves: ["W1-driving"], unread: [] });
  });
  it("ignores what constructs nothing: the declaration, a plain import, instanceof, a type, a comment, a string", () => {
    const src = [
      `import { ScenarioUnsupported, RowBuildDeferred } from "./types.ts";`,
      `export class ScenarioUnsupported extends Error {}`,
      `// a comment: new ScenarioUnsupported("W1a", "x")`,
      // A string that spells a construction is not a site (one that names a wave is a stray: T1-R2).
      `const name = "new RowBuildDeferred(row, wave)";`,
      `function f(e: ScenarioUnsupported | RowBuildDeferred) { return e instanceof ScenarioUnsupported; }`,
    ].join("\n");
    expect(scanRoutes(src)).toEqual({ sites: 0, waves: [], unread: [] });
  });
  it("refuses what hides the wave: an unreadable argument, a missing one, a subclass, an import alias, a value alias, Reflect.construct", () => {
    const hidden = {
      unreadable: `throw new ScenarioUnsupported(pick(), "x");`,
      missing: `throw new RowBuildDeferred("ladder");`,
      subclass: `class Late extends ScenarioUnsupported { constructor() { super("W1a", "x"); } }`,
      importAlias: `import { ScenarioUnsupported as SU } from "./types.ts";\nthrow new SU("W1a", "x");`,
      valueAlias: `const SU = ScenarioUnsupported;\nthrow new SU("W1a", "x");`,
      reflect: `throw Reflect.construct(ScenarioUnsupported, ["W1a", "x"]);`,
      // A parse error can swallow a deferral whole: fail closed, never "sites: 0".
      unclosedComment: `/* never closed\nthrow new ScenarioUnsupported("W1a", "x");`,
      unterminatedTemplate: `const s = \`never closed\nthrow new ScenarioUnsupported("W1a", "x");`,
    };
    for (const [shape, src] of Object.entries(hidden)) {
      const scan = scanRoutes(src);
      expect(scan.unread.length, `${shape}: ${JSON.stringify(scan)}`).toBeGreaterThan(0);
      expect(scan.waves, shape).not.toContain("W1a");
    }
  });
  it("a stray wave literal is refused by name: a map value, a const, a template, a W1-driving substring, a wave inside prose", () => {
    const stray = {
      mapValue: `const M = { D1: "W9" };`,
      constant: `export const OVERRIDE = "W1-driving";`,
      template: "const t = `W4`;",
      substring: `const s = "owed to W1-driving later";`,
      routedTo: `const c = { routedTo: "W2" };`,
      // A template span, not a whole literal: "rosters are W1-driving" in a message.
      span: "const m = `model: ${sport} fields teams — rosters are W1-driving`;",
      // A routeTo's WHY that names the wave is a stray too: the wave is argument 0's alone.
      why: `const r = routeTo("W2", "owed to W1-driving");`,
      // T1-R2: any wave inside prose, not only W1-driving — the shapes the tree carried at 00c2d8199.
      prose: "const m = `the tieBoard:'draw' shape lands with W2's carrom rulebook`;",
      closedOwner: `const o = "W1c (no task owns it)";`,
      trailing: `const w = "the engine refuses the cfg: a rulebook question for W2";`,
      // A wave-shaped token that is no programme wave is refused too, never read as prose.
      notAWave: `const a = "W11";`,
    };
    let refused = 0;
    for (const [shape, src] of Object.entries(stray)) {
      const scan = scanRoutes(src);
      expect(scan.unread.some((u) => u.includes("stray wave literal")), `${shape}: ${JSON.stringify(scan)}`).toBe(true);
      refused++;
    }
    expect(refused).toBe(Object.keys(stray).length);
  });
  it("a routeTo whose wave is not a literal is unread (a variable hides the wave), and so is routeTo passed as a value", () => {
    expect(scanRoutes(`const w = pick(); routeTo(w, "x");`).unread.length).toBeGreaterThan(0);
    expect(scanRoutes(`const w = pick(); routeTo(w, "x");`).sites).toBe(1);
    expect(scanRoutes(`routeTo();`).unread.length).toBeGreaterThan(0);
    expect(scanRoutes(`const r = routeTo; r(pick(), "x");`).unread.length).toBeGreaterThan(0);
  });
  it("text that only looks like a wave is not a site: a lowercase set name, a W inside a word, a W with no digit, a comment", () => {
    expect(scanRoutes(`const b = "w1-driving"; const c = "AW2"; const d = "W3C"; const e = "Wave"; // routeTo("W4", "x")`)).toEqual({ sites: 0, waves: [], unread: [] });
  });
  it("every programme wave id in the index is a wave token (the stray arm cannot miss a real wave)", () => {
    const rows = [...statusRows().keys()].filter((w) => w !== "Wave");
    expect(rows.length, "Status rows read").toBeGreaterThan(0);
    for (const w of rows) expect(scanRoutes(`const x = "${w}";`).unread.some((u) => u.includes("stray wave literal")), w).toBe(true);
  });
  it("a Status state is open when it says not started / in progress / awaiting, with or without emphasis", () => {
    // W1b's and W1a's cells as written on 2026-09-28, then the plain forms.
    expect(isOpen("**in progress** — plan `docs/superpowers/plans/2026-09-28-format-matrix-w1b.md` (rulings 25–30)")).toBe(true);
    expect(isOpen("**Tasks 1–11 done; final review (R21) fix batch landed**")).toBe(false);
    expect(isOpen("not started (ruling 28)")).toBe(true);
    expect(isOpen("_awaiting owner_")).toBe(true);
    expect(isOpen("done")).toBe(false);
  });
});

describe("Q-A guard — the judgement, apart from the tree", () => {
  it("empty case first: zero routes read is a failure, never a pass (R25)", () => {
    const rows = statusRows();
    expect(rows.size).toBeGreaterThan(0);
    expect(() => judgeRoutes([], [], rows)).toThrow(/routes read across every construct/);
    // A scan that read nothing is still zero, whatever the catalogue's data names.
    expect(() => judgeRoutes([{ sites: 0, waves: [], unread: [] }], [], rows, ["W2"])).toThrow(/routes read across every construct/);
  });
  it("T1-R1: a walk over modules that reads 0 routes fails on its own floor, whatever counts.json routes", () => {
    // Synthetic open rows (W1-driving Task 16): the real W1-driving row is
    // closed now, and this test is about the floor, not about the index.
    const rows = new Map([["W2", "not started"], ["W1-driving", "in progress"]]);
    // Two modules that name no wave: the walk found files, and read nothing.
    const walk = ["export const a = 1;", "export const b = 'x';"].map((src, i) => scanRoutes(src, `m${i}.ts`));
    expect(walk.map((w) => w.sites)).toEqual([0, 0]);
    expect(() => judgeRoutes(walk, ["W2", "W1-driving"], rows)).toThrow(/routes read across every construct by the module scan/);
    expect(() => judgeRoutes([{ sites: 0, waves: [], unread: [] }], ["W2"], rows)).toThrow(/by the module scan/);
    // The positive pair: one route read by the walk, and the same JSON routes pass.
    expect(judgeRoutes([...walk, scanRoutes(`routeTo("W2", "why");`, "m2.ts")], ["W2", "W1-driving"], rows).read).toBe(3);
  });
  it("a route to a wave whose Status row is closed fails naming the row; the same route to an open row passes", () => {
    // Synthetic rows: never the real W1-driving row, which Task 16 closes.
    const one: RouteScan[] = [{ sites: 1, waves: ["W1-driving"], unread: [] }];
    expect(() => judgeRoutes(one, [], new Map([["W1-driving", "done"]]))).toThrow(/W1-driving: "done" is not open/);
    expect(() => judgeRoutes(one, [], new Map([["W1-driving", "**Tasks 1–16 done** — merged"]]))).toThrow(/W1-driving: .* is not open/);
    expect(judgeRoutes(one, [], new Map([["W1-driving", "**in progress** — plan"]]))).toEqual({ read: 1, waves: ["W1-driving"] });
    // A counts.json route and a catalogue-named wave are judged the same way.
    expect(() => judgeRoutes([{ sites: 1, waves: [], unread: [] }], ["W1-driving"], new Map([["W1-driving", "done"]]))).toThrow(/W1-driving: "done" is not open/);
    expect(() => judgeRoutes(one, [], new Map([["W1-driving", "in progress"], ["W9", "done"]]), ["W9"])).toThrow(/W9: "done" is not open/);
    expect(() => judgeRoutes(one, [], new Map([["W1-driving", "in progress"]]), ["W9"])).toThrow(/W9 has no status row/);
  });
  it("an unread route fails the judgement, whatever else was read", () => {
    const rows = new Map([["W2", "not started"]]);
    expect(() => judgeRoutes([{ sites: 2, waves: ["W2"], unread: ["x.ts:1 stray wave literal \"W2\""] }], [], rows)).toThrow(/cannot read, or a bare wave literal/);
  });
});

describe("Q-A guard — a route never names a finished wave (ruling 28)", () => {
  it("every wave a route names — routeTo, a deferral class, the catalogue's knownNoPath / l2NoPath, counts.json's routedTo — has an _INDEX status row that is open", () => {
    const rows = statusRows();
    expect(rows.size).toBeGreaterThan(0);
    const modules = shipped(resolve(REPO, "scripts/matrix"));
    expect(modules.length).toBeGreaterThan(0);
    const scans = modules.map((f) => scanRoutes(readFileSync(f, "utf8"), f));
    const counts = JSON.parse(readFileSync(resolve(REPO, "scripts/matrix/catalogue/counts.json"), "utf8")) as { variants: Record<string, unknown> };
    const jsonRoutes = Object.values(counts.variants).flatMap((v) => (v !== null && typeof v === "object" && typeof (v as { routedTo?: unknown }).routedTo === "string" ? [(v as { routedTo: string }).routedTo] : []));
    // The reader is not blind to the JSON: counts.json routes its unscorable variant lists (committed-catalogue.test.ts).
    expect(jsonRoutes.length, "counts.json routes read").toBeGreaterThan(0);
    const owing = ATOMIC.flatMap((a) => [a.knownNoPath, a.l2NoPath]).filter((w): w is string => w !== null);
    expect(owing.length).toBeGreaterThan(0);
    const { read, waves } = judgeRoutes(scans, jsonRoutes, rows, owing);
    console.info(`Q-A guard: ${read} routes read (${read - jsonRoutes.length} in ${modules.length} modules, ${jsonRoutes.length} in counts.json); waves ${waves.join(", ")}`);
  });
});

// W1-driving Task 13: the last W1-driving routes are retired (DRIVING_ROUTE /
// DRIVING_WAVE, TEMPLATE_DRIVING). FP-1: the one T13 left, lib/model/state.ts's
// MODEL_ROSTERS (PF-3), was Task 14's: the model fields team rosters now
// (ruling 49), so the route is gone and nothing names the wave. Reuses
// scanRoutes, so a comment citing the wave is never a site (a raw text grep
// would read it).
describe("Q-A guard — no route names W1-driving (W1-driving Tasks 13 and 14)", () => {
  it("no route names W1-driving anywhere in the shipped harness (Task 14 retired the model's rosters route, FP-1)", () => {
    const root = resolve(REPO, "scripts/matrix");
    const scans = shipped(root).map((f) => ({ file: f.slice(root.length + 1), scan: scanRoutes(readFileSync(f, "utf8"), f) }));
    expect(scans.reduce((n, s) => n + s.scan.sites, 0)).toBeGreaterThan(0);
    expect(scans.flatMap((s) => s.scan.unread)).toEqual([]);
    const naming = scans.flatMap((s) => s.scan.waves.filter((w) => w === "W1-driving").map(() => s.file));
    expect(naming).toEqual([]);
  });
});
