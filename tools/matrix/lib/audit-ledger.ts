// W1d Task 18 (ruling 63, D22): the audit ledger. Every id in the five audit files (SW, FX, ST, SC, SH) is accounted for
// with EXACTLY ONE of five outcomes: `reproduced` (the triage keyed a red to it), or one of four verdicts a person
// wrote in catalogue/audit-verdicts.json: exercised-not-reproduced (a driven case passed — a false premise),
// not-exercised (no case reaches it), verified-by-read (file:line evidence), verified-by-failing-test (an `it.fails`
// witness that flips when the gap is fixed). An id with none or two is a finding, so "every audit id is accounted for"
// is a check and not a sentence.
//
// This module also READS the audit: the ID column's bare id (`H1`) takes its prefix from the file name (`SW-swiss.md`
// → `SW-H1`). SC holds two UMBRELLA rows (`X1 (=C1+O5+P9+O1)`) which explain per-sport rows the file counts elsewhere
// and are, in the file's own words, "NOT double-counted": they are no ledger id, and name their members.
//
// DB-free, like every tool: this reads files and folds them, nothing else.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as TS from "typescript";
import { z } from "zod";
import { LAYERS } from "./results.ts";
import { isClean, routeOf, type GapRouting, type TriageJson } from "./triage.ts";
import { HARNESS_SCENARIO } from "./scenario-catalogue.ts";

// `typescript` through require, not import: vite's transform chokes on the ~9 MB CJS bundle and a test importing this
// module would fail to collect (single-sport.ts does the same). The type side is erased.
const ts = createRequire(import.meta.url)("typescript") as typeof TS;

const MATRIX = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The repo root: tools/matrix/lib → three up. */
export const REPO_ROOT = resolve(MATRIX, "..", "..");
/** The 2026-09-27 audit the ledger accounts for. */
export const AUDIT_DIR = resolve(REPO_ROOT, "docs/superpowers/specs/2026-09-27-format-matrix-prompts/audit-2026-09-27");

/** Where a verified-by-failing-test witness may NOT live: this programme does not touch the engine's sources. */
const ENGINE_SRC = "packages/engine/src/";

// --- the audit files ------------------------------------------------------------------------------------------------------

/** A malformed audit file, naming the file and line. The Error's own `name`, printed by the CLIs as it is. */
export class AuditParse extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditParse";
  }
}

export interface AuditGap {
  /** `<PREFIX>-<id>`: SW-H1. */
  id: string;
  /** The audit file's name: SW-swiss.md. */
  file: string;
  /** The row's bold lead, or its Gap cell cut at 140 characters on a word. One line. */
  title: string;
  /** The row's own Sev cell, as written (High, Med, H, L …): the five files do not agree on a spelling. */
  severity: string;
}

/** A row that explains rows counted elsewhere: it owes no outcome of its own, its members do. */
export interface AuditUmbrella extends AuditGap {
  members: string[];
}

const AUDIT_FILE = /^([A-Z]{2})-.+\.md$/;
const BARE_ID = /^[A-Z]+\d+$/;
const NEW_ROW_ID = /^([A-Z]+\d+) \(new\)$/;
const UMBRELLA_ID = /^([A-Z]+\d+) \(=([A-Z]+\d+(?:\+[A-Z]+\d+)*)\)$/;
const TITLE_MAX = 140;

/** A gap section opens at a heading of level 2+ that is "Gap(s)", "Gap table" or "Cross-cutting gaps", after the
 *  numbering the files put before it ("2. ", "(2) "). "What is solid (no gap found)" is not one. */
const GAP_HEADING = /^(?:gaps?(?: table)?|cross-cutting gaps)\b/i;

/** The cells of a table row: split on a `|` that is not escaped, the outer pipes dropped, `\|` read as `|`. */
function cellsOf(line: string): string[] {
  const t = line.trim();
  const inner = t.slice(t.startsWith("|") ? 1 : 0, t.endsWith("|") && !t.endsWith("\\|") ? -1 : undefined);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "\\" && inner[i + 1] === "|") { cur += "|"; i++; continue; }
    if (c === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const isTableLine = (l: string): boolean => l.trimStart().startsWith("|");
const isSeparator = (cells: readonly string[]): boolean => cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));

/** The row's title: its bold lead when it has one, else the Gap cell cut at 140 characters on a word. */
function titleOf(cell: string): string {
  const lead = /^\*\*(.+?)\*\*/.exec(cell);
  const flat = (lead !== null ? lead[1] : cell).replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  if (flat.length <= TITLE_MAX) return flat;
  const cut = flat.slice(0, TITLE_MAX);
  const atWord = /\s/.test(flat[TITLE_MAX]) ? cut : cut.slice(0, Math.max(cut.lastIndexOf(" "), 1));
  return `${atWord.trimEnd()}…`;
}

interface RawRow { line: number; id: string; title: string; severity: string; members: string[] | null }

/** One audit file's gap rows, in file order. */
function readFileRows(file: string, text: string): RawRow[] {
  const lines = text.split("\n");
  const rows: RawRow[] = [];
  let sectionLevel = 0; // 0: outside a gap section, else the level of the heading that opened it
  for (let i = 0; i < lines.length; i++) {
    const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(lines[i]);
    if (heading !== null) {
      const level = heading[1].length;
      if (sectionLevel > 0 && level <= sectionLevel) sectionLevel = 0;
      const text_ = heading[2].replace(/^(?:\(\d+\)|\d+\.)\s*/, "");
      if (sectionLevel === 0 && level >= 2 && GAP_HEADING.test(text_)) sectionLevel = level;
      continue;
    }
    if (sectionLevel === 0 || !isTableLine(lines[i])) continue;

    // A table of the section: header, separator, rows, until the first line that is not a table line.
    const header = cellsOf(lines[i]).map((c) => c.toLowerCase());
    const col = { id: header.indexOf("id"), gap: header.indexOf("gap"), sev: header.indexOf("sev") };
    const at = `${file}:${i + 1}`;
    if (col.id < 0 || col.gap < 0 || col.sev < 0) {
      throw new AuditParse(`${at}: a gap table needs an ID, a Gap and a Sev column, this one has ${header.join(" | ")}`);
    }
    if (!(i + 1 < lines.length && isTableLine(lines[i + 1]) && isSeparator(cellsOf(lines[i + 1])))) {
      throw new AuditParse(`${at}: a gap table's header is followed by a |---| separator row`);
    }
    i += 2;
    for (; i < lines.length && isTableLine(lines[i]); i++) {
      const cells = cellsOf(lines[i]);
      const here = `${file}:${i + 1}`;
      if (cells.length !== header.length) throw new AuditParse(`${here}: a row of ${cells.length} cells, the header has ${header.length}`);
      const raw = cells[col.id];
      if (raw === "") throw new AuditParse(`${here}: a row with no id`);
      let id: string;
      let members: string[] | null = null;
      const umbrella = UMBRELLA_ID.exec(raw);
      const fresh = NEW_ROW_ID.exec(raw);
      if (BARE_ID.test(raw)) id = raw;
      else if (fresh !== null) id = fresh[1]!;
      else if (umbrella !== null) { id = umbrella[1]!; members = umbrella[2].split("+"); }
      else throw new AuditParse(`${here}: "${raw}" is not an id (expected H1, X3 (new) or X1 (=A1+B1))`);
      rows.push({ line: i + 1, id, title: titleOf(cells[col.gap]), severity: cells[col.sev], members });
    }
    i--; // the for-loop's own increment steps over the line that ended the table
  }
  return rows;
}

/** Every gap and umbrella of the audit directory: the `<PREFIX>-*.md` files, in name order. */
export function readAudit(dir: string): { gaps: AuditGap[]; umbrellas: AuditUmbrella[] } {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => AUDIT_FILE.test(n)).sort();
  } catch (e) {
    throw new AuditParse(`${dir}: cannot read the audit directory — ${e instanceof Error ? e.message : String(e)}`);
  }
  const gaps: AuditGap[] = [];
  const umbrellas: AuditUmbrella[] = [];
  const first = new Map<string, string>();
  for (const name of names) {
    const prefix = AUDIT_FILE.exec(name)![1];
    let text: string;
    try {
      text = readFileSync(resolve(dir, name), "utf8");
    } catch (e) {
      throw new AuditParse(`${name}: cannot read the file — ${e instanceof Error ? e.message : String(e)}`);
    }
    const rows = readFileRows(name, text);
    if (!rows.some((r) => r.members === null)) throw new AuditParse(`${name}: no gap row — a misparse reads as zero, not as clean`);
    const counted = new Set(rows.filter((r) => r.members === null).map((r) => `${prefix}-${r.id}`));
    for (const r of rows) {
      const id = `${prefix}-${r.id}`;
      const seen = first.get(id);
      if (seen !== undefined) throw new AuditParse(`${name}:${r.line}: duplicate id ${id} (first at ${seen})`);
      first.set(id, `${name}:${r.line}`);
      const base: AuditGap = { id, file: name, title: r.title, severity: r.severity };
      if (r.members === null) { gaps.push(base); continue; }
      const members = r.members.map((m) => `${prefix}-${m}`);
      for (const m of members) {
        if (!counted.has(m)) throw new AuditParse(`${name}:${r.line}: ${id} aliases ${m}, which is no row of ${name}`);
      }
      umbrellas.push({ ...base, members });
    }
  }
  if (gaps.length === 0) throw new AuditParse(`${dir}: zero gaps in ${names.length} audit files — nothing to account for (vacuous)`);
  return { gaps, umbrellas };
}

/** The ids the ledger owes an outcome: every counted row, never an umbrella. */
export function readAuditGaps(dir: string): AuditGap[] {
  return readAudit(dir).gaps;
}

// --- the verdicts file ------------------------------------------------------------------------------------------------------

/** The five outcomes of D22, in the order the ledger reports them. */
export const OUTCOMES = ["reproduced", "exercised-not-reproduced", "not-exercised", "verified-by-read", "verified-by-failing-test"] as const;
export type Outcome = (typeof OUTCOMES)[number];
/** The four a person writes: `reproduced` comes from the triage alone, never from a verdict. */
export const VERDICT_OUTCOMES = ["exercised-not-reproduced", "not-exercised", "verified-by-read", "verified-by-failing-test"] as const;
export type VerdictOutcome = (typeof VERDICT_OUTCOMES)[number];

const REPO_RELATIVE = z.string().min(1)
  .refine((p) => !p.startsWith("/") && !/^[A-Za-z]:/.test(p) && !p.split("/").includes(".."), "a path relative to the repo, never leaving it");

/** The baseline scenarios a run drives (HARNESS_SCENARIO's own values, never typed here): what a verdict's `drove` may name. */
export const DRIVEN_SCENARIOS: readonly string[] = [...new Set(Object.values(HARNESS_SCENARIO))].sort();

const VerdictSchema = z.strictObject({
  id: z.string().regex(/^[A-Z]{2}-[A-Z]+\d+$/, "an audit id"),
  outcome: z.enum(VERDICT_OUTCOMES),
  evidence: z.string().min(1),
  wave: z.string().regex(/^W\d+[a-z]?$/, "a wave id"),
  /** exercised-not-reproduced: the cases that drove the gap's path and passed. */
  cases: z.array(z.string().min(1)).optional(),
  /** verified-by-failing-test: the `it.fails` that witnesses the gap. */
  test: z.strictObject({ file: REPO_RELATIVE, title: z.string().min(1) }).optional(),
  /** The baseline scenarios whose run drove the code this verdict reads while no check read the property (review m2). An id a run
   *  drove is verified-by-read, exercised-not-reproduced or witnessed by a test — never not-exercised, which is for what no run reached. */
  drove: z.array(z.string().refine((x) => DRIVEN_SCENARIOS.includes(x), `a scenario the baseline drives (${DRIVEN_SCENARIOS.join(", ")})`)).min(1).optional(),
}).superRefine((v, ctx) => {
  const bad = (path: string, message: string): void => { ctx.addIssue({ code: "custom", path: [path], message: `${v.id}: ${message}` }); };
  if (v.outcome === "exercised-not-reproduced") {
    if (v.cases === undefined || v.cases.length === 0) bad("cases", "exercised-not-reproduced cites at least one case that passed");
    else if (new Set(v.cases).size !== v.cases.length) bad("cases", "a case is cited once");
  } else if (v.cases !== undefined) bad("cases", `cases belong to exercised-not-reproduced, not ${v.outcome}`);
  if (v.outcome === "verified-by-failing-test") {
    if (v.test === undefined) bad("test", "verified-by-failing-test names the test file and the it.fails title");
  } else if (v.test !== undefined) bad("test", `a test belongs to verified-by-failing-test, not ${v.outcome}`);
  if (v.outcome === "verified-by-read" && !/[\w./-]+\.\w+:\d+/.test(v.evidence)) bad("evidence", "verified-by-read cites a file:line");
  if (v.drove !== undefined) {
    if (v.outcome === "not-exercised") bad("drove", "a verdict that names the scenario that drove it is not not-exercised: read the code (verified-by-read) or cite the case that drove it");
    if (new Set(v.drove).size !== v.drove.length) bad("drove", "a scenario once");
  }
});

/** The evidence of a not-exercised verdict says a run drove the id: the scenario named as the driver ("…: LIFECYCLE builds and plays …",
 *  "…: F1 (odd field) drives …") or a case id cited ("americano|badminton|LIFECYCLE works"). The honest lines negate a drive ("no script",
 *  "L2 drives only F1, M1 and R4") and open with neither. A heuristic over text, backed by the structural `drove` field. */
const DRIVEN_SENTENCE = new RegExp(`:\\s*(?:${DRIVEN_SCENARIOS.join("|")})\\b[^.;]*?\\b(?:drives?|plays?|builds?|completes|reads|passes|passed)\\b`);
const CASE_ID_CITED = /\b[a-z_]+\|[a-z0-9_*-]+\|/;
export const claimsDriven = (evidence: string): boolean => DRIVEN_SENTENCE.test(evidence) || CASE_ID_CITED.test(evidence);
export type Verdict = z.infer<typeof VerdictSchema>;
const VerdictsSchema = z.strictObject({ verdicts: z.array(VerdictSchema) });
export const parseVerdicts = (json: unknown): { verdicts: Verdict[] } => VerdictsSchema.parse(json);

// --- the witness a verified-by-failing-test verdict names -------------------------------------------------------------------

export interface TestCall {
  title: string;
  /** The call carries the `fails` modifier. */
  fails: boolean;
  /** The call runs whenever the file does: no modifier but `fails` (no skip, todo, only, skipIf…), and every ancestor up to
   *  the file is a statement, a block or the callback of a bare `describe(...)` — never an `if`, an `&&`, a function nothing
   *  calls, or a `describe.skip`. A witness that does not run flips nothing when the gap is fixed. */
  runs: boolean;
}

/** Every `it(...)` / `test(...)` call with a literal title, with whatever modifiers it carries (`.fails`, `.skip`, …) and
 *  whether it runs, read from the TypeScript AST: a comment or a string that spells a test is no test. */
export function testCalls(src: string): TestCall[] {
  const sf = ts.createSourceFile("witness.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: TestCall[] = [];
  /** `live`: everything above `n` up to the file is certain to be reached. */
  const visit = (n: TS.Node, live: boolean): void => {
    let carries = ts.isSourceFile(n) || ts.isExpressionStatement(n) || ts.isBlock(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n);
    if (ts.isCallExpression(n)) {
      const mods: string[] = [];
      let cur: TS.Expression = n.expression;
      while (ts.isPropertyAccessExpression(cur)) { mods.unshift(cur.name.text); cur = cur.expression; }
      const arg = n.arguments[0];
      if (ts.isIdentifier(cur) && (cur.text === "it" || cur.text === "test") && arg !== undefined && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        out.push({ title: arg.text, fails: mods.includes("fails"), runs: live && mods.every((m) => m === "fails") });
      }
      // The callback of a bare describe is reached; any other call's arguments may never be.
      carries = ts.isIdentifier(cur) && cur.text === "describe" && mods.length === 0;
    }
    ts.forEachChild(n, (c) => visit(c, live && carries));
  };
  visit(sf, true);
  return out;
}

/** The titles of the file's `it.fails` / `test.fails` calls that run, in source order. */
export function failsTitles(src: string): string[] {
  return testCalls(src).filter((c) => c.fails && c.runs).map((c) => c.title);
}

/** The title carries the audit id as a whole token: SW-H1 is not in "SW-H10: …". */
function carriesId(title: string, id: string): boolean {
  for (let at = title.indexOf(id); at >= 0; at = title.indexOf(id, at + 1)) {
    const before = at === 0 ? "" : title[at - 1];
    const after = title[at + id.length] ?? "";
    if (!/[A-Za-z0-9-]/.test(before) && !/[A-Za-z0-9]/.test(after)) return true;
  }
  return false;
}

// --- the ledger -----------------------------------------------------------------------------------------------------------------

/** Every way the ledger refuses to build (exit 2). Each is the Error's own `name`. */
export class LedgerRefused extends Error {
  constructor(name: "NoIds" | "TriageNoRuns" | "TriageLayerMissing" | "TriageNoCases" | "TriageLayerEmpty" | "TriageNotClean", message: string) {
    super(message);
    this.name = name;
  }
}

export const TEST_REASONS = ["file-missing", "title-missing", "not-a-fails-test", "witness-not-run", "id-not-in-title", "engine-src"] as const;
export type TestReason = (typeof TEST_REASONS)[number];

export type Finding =
  | { kind: "no-outcome"; id: string }
  | { kind: "two-outcomes"; id: string; outcomes: Outcome[] }
  | { kind: "unknown-verdict-id"; id: string; umbrellaOf?: string[] }
  | { kind: "wave-mismatch"; id: string; wave: string; routed: string | null }
  | { kind: "case-not-works"; id: string; caseId: string }
  | { kind: "test-not-found"; id: string; file: string; title: string; reason: TestReason }
  | { kind: "unknown-triage-gap"; id: string }
  | { kind: "driven-not-exercised"; id: string };

export interface LedgerEntry {
  id: string;
  file: string;
  title: string;
  severity: string;
  /** The wave design §8 routes it to; null when the routing has none. */
  wave: string | null;
  /** Its one outcome; null while it has none or two (a finding says which). */
  outcome: Outcome | null;
  outcomes: Outcome[];
  /** reproduced: the triage's cases; exercised-not-reproduced: the cases the verdict cites. */
  cases: string[];
  evidence: string | null;
  test: { file: string; title: string } | null;
  /** The baseline scenarios that drove it with no check reading it (a verdict's `drove`); empty for any other id. */
  drove: string[];
}

export interface Ledger {
  entries: LedgerEntry[];
  findings: Finding[];
  counts: Record<Outcome, number>;
  /** Triage rows keyed to an umbrella: the umbrella is no id, so these are shown, and its members still owe an outcome. */
  umbrellaCases: { id: string; members: string[]; cases: string[] }[];
  /** The runs the triage read, so every claim of the ledger traces to a run id (D19). */
  runs: TriageJson["runs"];
}

export interface LedgerInput {
  gaps: readonly AuditGap[];
  umbrellas: readonly AuditUmbrella[];
  routing: GapRouting;
  triage: TriageJson;
  verdicts: readonly Verdict[];
  /** A repo-relative path's text, or null when the repo has no such file. */
  readFile: (repoRelative: string) => string | null;
}

const NEW_GAP = /^NEW-W1d-\d+$/;

function testFindings(v: Verdict, readFile: (p: string) => string | null): Finding[] {
  if (v.test === undefined) return [];
  const { file, title } = v.test;
  const at = (reason: TestReason): Finding => ({ kind: "test-not-found", id: v.id, file, title, reason });
  const out: Finding[] = [];
  if (file.startsWith(ENGINE_SRC)) out.push(at("engine-src"));
  const src = readFile(file);
  if (src === null) return [...out, at("file-missing")];
  if (!carriesId(title, v.id)) out.push(at("id-not-in-title"));
  const same = testCalls(src).filter((c) => c.title === title);
  if (same.some((c) => c.fails && c.runs)) return out;
  return [...out, at(same.length === 0 ? "title-missing" : same.some((c) => c.fails) ? "witness-not-run" : "not-a-fails-test")];
}

/** Every audit id with exactly one outcome, or a finding saying why not. Refuses a ledger with no id at all, and a triage
 *  that is not clean (an untriaged red could be the very gap a verdict calls not-exercised). */
export function buildLedger(input: LedgerInput): Ledger {
  const { gaps, umbrellas, routing, triage, verdicts, readFile } = input;
  if (gaps.length === 0) throw new LedgerRefused("NoIds", "the audit holds zero ids — nothing to account for (vacuous)");
  // The ledger reads a triage.json on faith, so it holds the file to the bar the triage CLI keeps: a triage that read nothing,
  // or only some of the baseline's layers, would call every id its missing runs could have shown `not-exercised`.
  if (triage.runs.length === 0) throw new LedgerRefused("TriageNoRuns", "the triage names no run — it read nothing (vacuous)");
  const missing = LAYERS.filter((l) => !triage.runs.some((r) => r.layer === l));
  if (missing.length > 0) {
    throw new LedgerRefused("TriageLayerMissing", `the triage has no run of ${missing.length === 1 ? "layer" : "layers"} ${missing.join(", ")} (it holds ${triage.runs.map((r) => r.layer).join(", ")}): the baseline reads all of ${LAYERS.join(", ")}, and an id only a missing layer could reproduce would read not-exercised`);
  }
  if (triage.scanned === 0) throw new LedgerRefused("TriageNoCases", "the triage read no case at all — nothing was checked (vacuous)");
  // N1: `scanned` is the file's own number, and a layer's run can hold no case while the others hold some (or while a hand-made
  // file claims some): an id only that layer could have reproduced would read not-exercised over a layer nobody read.
  const empty = LAYERS.filter((l) => !triage.runs.some((r) => r.layer === l && r.cases > 0));
  if (empty.length > 0) {
    throw new LedgerRefused("TriageLayerEmpty", `the triage read no case of ${empty.length === 1 ? "layer" : "layers"} ${empty.join(", ")} (its runs: ${triage.runs.map((r) => `${r.layer} ${r.cases}`).join(", ")}): an id only a layer that read nothing could reproduce would read not-exercised`);
  }
  if (!isClean(triage)) {
    throw new LedgerRefused("TriageNotClean", `the triage is not clean (${triage.untriaged.length} untriaged, ${triage.ambiguous.length} ambiguous, ${triage.misrouted.length} misrouted rules, ${triage.unknownGap.length} unknown gaps): an untriaged red could be the very gap a verdict calls not-exercised — fix the triage first`);
  }
  const ids = new Set(gaps.map((g) => g.id));
  const umbrella = new Map(umbrellas.map((u) => [u.id, u]));
  const works = new Set(triage.works);

  const reproduced = new Map<string, { cases: string[]; wave: string }>();
  for (const row of triage.rows) {
    // A case is keyed to one gap and may also fail a check another gap owns (`also`): it reproduces that one too.
    for (const g of [{ gap: row.gap, wave: row.wave }, ...(row.also ?? [])]) {
      const at = reproduced.get(g.gap) ?? { cases: [], wave: g.wave };
      at.cases.push(row.caseId);
      reproduced.set(g.gap, at);
    }
  }
  const byId = new Map<string, Verdict[]>();
  for (const v of verdicts) byId.set(v.id, [...(byId.get(v.id) ?? []), v]);

  const findings: Finding[] = [];
  const entries: LedgerEntry[] = [];
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
  for (const g of gaps) {
    const mine = byId.get(g.id) ?? [];
    const rep = reproduced.get(g.id);
    const outcomes: Outcome[] = [...(rep === undefined ? [] : (["reproduced"] as const)), ...mine.map((v) => v.outcome)];
    if (outcomes.length === 0) findings.push({ kind: "no-outcome", id: g.id });
    else if (outcomes.length > 1) findings.push({ kind: "two-outcomes", id: g.id, outcomes });
    const outcome = outcomes.length === 1 ? outcomes[0] : null;
    if (outcome !== null) counts[outcome]++;

    const routed = routeOf(routing, g.id);
    for (const v of mine) {
      if (v.wave !== routed) findings.push({ kind: "wave-mismatch", id: g.id, wave: v.wave, routed });
      for (const c of v.cases ?? []) if (!works.has(c)) findings.push({ kind: "case-not-works", id: g.id, caseId: c });
      if (v.outcome === "not-exercised" && claimsDriven(v.evidence)) findings.push({ kind: "driven-not-exercised", id: g.id });
      findings.push(...testFindings(v, readFile));
    }
    const verdict = mine[0];
    entries.push({
      id: g.id, file: g.file, title: g.title, severity: g.severity,
      wave: routed ?? rep?.wave ?? verdict?.wave ?? null,
      outcome, outcomes,
      cases: rep !== undefined ? rep.cases : (verdict?.cases ?? []),
      evidence: verdict?.evidence ?? null,
      test: verdict?.test ?? null,
      drove: verdict?.drove ?? [],
    });
  }
  for (const id of byId.keys()) {
    if (ids.has(id)) continue;
    const u = umbrella.get(id);
    findings.push({ kind: "unknown-verdict-id", id, ...(u === undefined ? {} : { umbrellaOf: u.members }) });
  }
  const umbrellaCases: Ledger["umbrellaCases"] = [];
  for (const [gap, at] of reproduced) {
    const u = umbrella.get(gap);
    if (u !== undefined) umbrellaCases.push({ id: gap, members: u.members, cases: at.cases });
    else if (!ids.has(gap) && !NEW_GAP.test(gap)) findings.push({ kind: "unknown-triage-gap", id: gap });
  }
  return { entries, findings, counts, umbrellaCases, runs: triage.runs };
}

// --- AUDIT-LEDGER.md ------------------------------------------------------------------------------------------------------------

/** One finding, in the words stdout and AUDIT-LEDGER.md both use. */
export function findingLine(f: Finding): string {
  switch (f.kind) {
    case "no-outcome": return `${f.id} has no outcome`;
    case "two-outcomes": return `${f.id} has two outcomes: ${f.outcomes.join(", ")}`;
    case "unknown-verdict-id": return f.umbrellaOf === undefined ? `${f.id} is a verdict for no audit id` : `${f.id} is an umbrella over ${f.umbrellaOf.join(", ")}: give each member its own verdict`;
    case "wave-mismatch": return `${f.id}: the verdict says ${f.wave}, design §8 ${f.routed === null ? "gives it no route" : `says ${f.routed}`}`;
    case "case-not-works": return `${f.id}: the cited case ${f.caseId} is not a works case of the triaged runs`;
    case "unknown-triage-gap": return `${f.id}: the triage keyed a red to an id this audit does not hold`;
    case "driven-not-exercised": return `${f.id}: not-exercised, but its evidence says a baseline run drove it — a driven id is verified-by-read (naming \`drove\`) or exercised-not-reproduced, never not-exercised`;
    case "test-not-found": {
      const where = `${f.id}: the failing test ${f.file}`;
      switch (f.reason) {
        case "file-missing": return `${where} is not in the repo`;
        case "title-missing": return `${where} holds no test titled "${f.title}"`;
        case "witness-not-run": return `${where}: "${f.title}" is an it.fails that never runs (skipped, todo, or under a skip or a condition) — it cannot flip when the gap is fixed`;
        case "not-a-fails-test": return `${where}: "${f.title}" is a plain test, not an it.fails — a passing test is no witness that flips when the gap is fixed`;
        case "id-not-in-title": return `${where}: the title "${f.title}" does not carry ${f.id}`;
        case "engine-src": return `${where} is under ${ENGINE_SRC}, which this wave does not touch`;
      }
    }
  }
}

/** A table cell: GFM splits on `|` even inside a code span, and a newline ends the row. */
const cell = (s: string): string => s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const SHOWN_CASES = 5;

export interface LedgerMeta {
  /** The ids the ledger accounts for. */
  audit: number;
  files: number;
  umbrellas: number;
  /** The reds the triage read. */
  checked: number;
}

export function renderLedger(ledger: Ledger, meta: LedgerMeta): string {
  const { entries, findings, counts } = ledger;
  const lines: string[] = [`# Audit ledger — ${plural(meta.audit, "audit id")} in ${plural(meta.files, "file")} (ruling 63, D22)`, ""];
  if (findings.length > 0) {
    lines.push(`**INCOMPLETE — ${plural(findings.length, "finding")}: this ledger does not yet account for every id exactly once.**`, "", "## Problems", "", ...findings.map((f) => `- ${findingLine(f)}`), "");
  }
  lines.push(
    `Each of the ${plural(meta.audit, "audit id")} has exactly one of five outcomes. ${plural(meta.umbrellas, "umbrella row")} (SC's, which explain rows counted elsewhere) ${meta.umbrellas === 1 ? "is" : "are"} no id. The triage read ${plural(meta.checked, "red")}.`, "",
    "| outcome | ids |", "|---|---|", ...OUTCOMES.map((o) => `| ${o} | ${counts[o]} |`), "",
  );
  // Review m2: an id a baseline scenario drove while no check read it is verified-by-read, and is counted apart so it never reads as unreached.
  const reads = entries.filter((e) => e.outcome === "verified-by-read");
  const driven = reads.filter((e) => e.drove.length > 0);
  const scenarios = [...new Set(driven.flatMap((e) => e.drove))].sort();
  lines.push(`Of the ${plural(reads.length, "verified-by-read id")}, ${driven.length} were driven by a baseline scenario${scenarios.length === 0 ? "" : ` (${scenarios.join(", ")})`} with no check reading the property: the run reached them, so they are read from the code and not counted as not exercised.`, "");
  lines.push(
    "## Runs", "", "The triage this ledger was built from, one run per layer:", "",
    "| layer | run | plan | cases | reds |", "|---|---|---|---|---|",
    ...ledger.runs.map((r) => `| ${r.layer} | ${cell(r.runId)} | ${cell(r.plan ?? "—")} | ${r.cases} | ${r.reds} |`), "",
  );
  const inOutcome = (o: Outcome): LedgerEntry[] => entries.filter((e) => e.outcome === o);
  const row = (e: LedgerEntry): string => `| ${e.id} | ${e.wave ?? "—"} | ${cell(e.severity)} | ${cell(e.title)} | ${cell(e.evidence ?? "")} |`;
  const head = ["| id | wave | sev | audit title | evidence |", "|---|---|---|---|---|"];

  const rep = inOutcome("reproduced");
  lines.push(`## Reproduced — ${plural(rep.length, "id")}`, "");
  for (const e of rep) {
    const shown = e.cases.slice(0, SHOWN_CASES).map((c) => `\`${c}\``).join(", ");
    lines.push(`- **${e.id}** (${e.wave ?? "no wave"}) ${e.title} — ${plural(e.cases.length, "case")}: ${shown}${e.cases.length > SHOWN_CASES ? ", …" : ""}`);
  }
  if (rep.length === 0) lines.push("None.");
  lines.push("");

  const fp = inOutcome("exercised-not-reproduced");
  lines.push(`## False premises found — ${plural(fp.length, "id")} the audit named that a driven case did not reproduce`, "");
  for (const e of fp) lines.push(`- **${e.id}** (${e.wave ?? "no wave"}) ${e.title} — ${e.evidence ?? ""}`, `  - ${plural(e.cases.length, "case")}: ${e.cases.map((c) => `\`${c}\``).join(", ")}`);
  if (fp.length === 0) lines.push("None.");
  lines.push("");

  for (const o of ["not-exercised", "verified-by-read", "verified-by-failing-test"] as const) {
    const list = inOutcome(o);
    lines.push(`## ${o} — ${plural(list.length, "id")}`, "");
    if (list.length === 0) { lines.push("None.", ""); continue; }
    lines.push(...head, ...list.map((e) => (o === "verified-by-failing-test" && e.test !== null ? row({ ...e, evidence: `${e.evidence ?? ""} (${e.test.file}: ${e.test.title})` }) : row(e))), "");
  }
  if (ledger.umbrellaCases.length > 0) {
    lines.push("## Umbrella rows keyed by the triage", "", "An umbrella is no ledger id; its members still owe an outcome of their own.", "");
    for (const u of ledger.umbrellaCases) lines.push(`- **${u.id}** over ${u.members.join(", ")} — ${plural(u.cases.length, "case")}: ${u.cases.slice(0, SHOWN_CASES).map((c) => `\`${c}\``).join(", ")}${u.cases.length > SHOWN_CASES ? ", …" : ""}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
