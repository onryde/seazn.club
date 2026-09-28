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
import { DRIVING_WAVE } from "../lib/scenarios/common.ts";
import { SCENARIO_KEYS } from "../lib/slice.ts";
import {
  ATOMIC, HARNESS_SCENARIO, LIFECYCLE_ID, PARENTS, REGRESSIONS_PATH, l2Atomic, l3Atomic, loadRegressions, parseRegressions,
} from "../lib/scenario-catalogue.ts";

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
  it("the atomisation is the reviewed W1b plan's (Task 4 PARENTS block): every atom id, in order", () => {
    // Until design §4 names every split parent's atoms (as it does for M4 and
    // M12), the reviewed plan is the written source of the atomisation.
    const start = PLAN.indexOf("export const PARENTS");
    expect(start, "the plan's Task 4 PARENTS block is gone").toBeGreaterThan(-1);
    const block = PLAN.slice(start, PLAN.indexOf("\n]);", start));
    const planned: { id: string; atoms: string[] }[] = [];
    for (const m of block.matchAll(/\bP\("([A-Z]\d{1,2})"|\bA\("([a-c])"/g)) {
      if (m[1] !== undefined) planned.push({ id: m[1], atoms: [] });
      else planned.at(-1)!.atoms.push(m[2]!);
    }
    // The plan parse is itself pinned to the design's parent list, so a broken
    // parse cannot pass as "no atoms".
    expect(planned.map((p) => p.id)).toEqual([...designTexts().keys()]);
    const ids = planned.flatMap((p) => (p.atoms.length === 0 ? [p.id] : p.atoms.map((s) => `${p.id}${s}`)));
    expect(ids.length).toBeGreaterThan(planned.length); // some parent is split
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
      fence: [""],
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
    expect(Object.keys(stub).sort()).toEqual(Object.keys(base).sort());
    expect(stub.id).toBe("MB-NNN");
    expect(() => parseRegressions(file(stub))).toThrow();
    expect(() => parseRegressions(file({ ...stub, id: "MB-001" }))).toThrow(); // title and date still empty
    expect(() => parseRegressions(file({ ...stub, id: "MB-001", title: "named" }))).toThrow(); // date still YYYY-MM-DD
    // Positive pair: completed by a human, the same stub parses.
    expect(parseRegressions(file({ ...stub, id: "MB-001", title: "named", found: "2026-09-28" }))).toHaveLength(1);
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

// --- Q-A guard (ruling 28) ------------------------------------------------------
/** The deferral classes, each with the index of its wave argument. */
const DEFERRALS: Readonly<Record<string, number>> = { ScenarioUnsupported: 0, RowBuildDeferred: 1 };
interface DeferralScan { sites: number; waves: string[]; unread: string[] }
/** Every use of a deferral class in `src`, read from the TypeScript AST (so a
 *  comment or a string is never a site). A `new` with a literal or
 *  DRIVING_WAVE wave is read; the declaration, a plain import/re-export,
 *  `instanceof` and a type position construct nothing. ANY other use — a
 *  subclass (its wave hides in `super(`), an `as` alias, a value alias,
 *  `Reflect.construct` — is unread, and an unread use fails the guard. */
function scanDeferrals(src: string, file = "synthetic.ts"): DeferralScan {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: DeferralScan = { sites: 0, waves: [], unread: [] };
  const at = (n: TS.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  // Fail closed on a parse error: an unclosed comment or template swallows
  // the code after it, and a deferral inside would read as "no sites".
  // `parseDiagnostics` is the parser's own list (not on the public type).
  for (const d of (sf as unknown as { parseDiagnostics: readonly TS.DiagnosticWithLocation[] }).parseDiagnostics) {
    out.unread.push(`${file}: parse error at ${d.start}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  }
  const waveOf = (arg: TS.Expression | undefined): string | null => {
    if (arg === undefined) return null;
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
    return ts.isIdentifier(arg) && arg.text === "DRIVING_WAVE" ? DRIVING_WAVE : null;
  };
  const classify = (id: TS.Identifier, waveIndex: number): void => {
    const p = id.parent;
    const callee: TS.Node = ts.isPropertyAccessExpression(p) && p.name === id ? p : id;
    const host = callee.parent;
    if (ts.isNewExpression(host) && host.expression === callee) {
      out.sites++;
      const w = waveOf(host.arguments?.[waveIndex]);
      if (w === null) out.unread.push(`${at(id)} ${host.getText(sf)}`); else out.waves.push(w);
      return;
    }
    if (ts.isClassDeclaration(p) && p.name === id) return;
    if ((ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && p.propertyName === undefined) return;
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && p.right === id) return;
    if (ts.isTypeReferenceNode(p)) return;
    out.unread.push(`${at(id)} ${id.text} used as ${ts.SyntaxKind[p.kind]}`);
  };
  const visit = (n: TS.Node): void => {
    if (ts.isIdentifier(n) && Object.hasOwn(DEFERRALS, n.text)) classify(n, DEFERRALS[n.text]!);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
/** A Status-table state that is still owed work. Markdown emphasis is not part of the state. */
const isOpen = (state: string): boolean => /^(not started|in progress|awaiting)/i.test(state.replace(/[*_]/g, "").trim());
/** Every module the harness ships (test files and fixtures excluded). */
const shipped = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === "__tests__" ? [] : shipped(join(d, e.name)))
    : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(d, e.name)] : []);

describe("Q-A guard — the deferral reader", () => {
  it("reads a literal wave, DRIVING_WAVE by value, RowBuildDeferred's second argument, and a namespaced class", () => {
    expect(scanDeferrals(`throw new ScenarioUnsupported("W3", "x");`)).toEqual({ sites: 1, waves: ["W3"], unread: [] });
    expect(scanDeferrals(`throw new ScenarioUnsupported(DRIVING_WAVE, "x");`)).toEqual({ sites: 1, waves: [DRIVING_WAVE], unread: [] });
    expect(scanDeferrals(`throw new RowBuildDeferred("ladder", "W7");`)).toEqual({ sites: 1, waves: ["W7"], unread: [] });
    expect(scanDeferrals(`import * as T from "./types.ts";\nthrow new T.ScenarioUnsupported("W3", "x");`)).toEqual({ sites: 1, waves: ["W3"], unread: [] });
  });
  it("ignores what constructs nothing: the declaration, a plain import, instanceof, a type, a comment, a string", () => {
    const src = [
      `import { ScenarioUnsupported, RowBuildDeferred } from "./types.ts";`,
      `export class ScenarioUnsupported extends Error {}`,
      `// a comment: new ScenarioUnsupported("W1a", "x")`,
      `const name = "new RowBuildDeferred(row, \\"W1a\\")";`,
      `function f(e: ScenarioUnsupported | RowBuildDeferred) { return e instanceof ScenarioUnsupported; }`,
    ].join("\n");
    expect(scanDeferrals(src)).toEqual({ sites: 0, waves: [], unread: [] });
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
      const scan = scanDeferrals(src);
      expect(scan.unread.length, `${shape}: ${JSON.stringify(scan)}`).toBeGreaterThan(0);
      expect(scan.waves, shape).not.toContain("W1a");
    }
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

describe("Q-A guard — a deferral or an owning wave never names a finished wave (ruling 28)", () => {
  it("every wave a deferral or the catalogue's knownNoPath / l2NoPath names has an _INDEX status row that is open", () => {
    const start = INDEX.indexOf("## Status");
    const status = INDEX.slice(start, INDEX.indexOf("\n## ", start + 1));
    const rows = new Map([...status.matchAll(/^\| (W[\w-]+) \| [^|]* \| (.*) \|$/gm)].map((m) => [m[1]!, m[2]!]));
    expect(rows.size).toBeGreaterThan(0);
    const modules = shipped(resolve(REPO, "scripts/matrix"));
    expect(modules.length).toBeGreaterThan(0);
    const scans = modules.map((f) => scanDeferrals(readFileSync(f, "utf8"), f));
    // A site whose wave the reader cannot see would be skipped silently.
    expect(scans.flatMap((s) => s.unread), "a deferral names its wave in a shape this guard cannot read").toEqual([]);
    expect(scans.reduce((n, s) => n + s.sites, 0)).toBeGreaterThan(0);
    const deferred = new Set(scans.flatMap((s) => s.waves));
    const owing = new Set(ATOMIC.flatMap((a) => [a.knownNoPath, a.l2NoPath]).filter((w): w is string => w !== null));
    expect(deferred.size).toBeGreaterThan(0);
    expect(owing.size).toBeGreaterThan(0);
    for (const w of new Set([...deferred, ...owing])) {
      expect(rows.has(w), `${w} has no status row in _INDEX.md`).toBe(true);
      expect(isOpen(rows.get(w)!), `${w}: "${rows.get(w)}" is not open`).toBe(true);
    }
  });
});
