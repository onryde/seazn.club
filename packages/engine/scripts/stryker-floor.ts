// CLI: pnpm --filter @seazn/engine mutation:floor <mode> ...        (node --experimental-strip-types scripts/stryker-floor.ts)
// W1d Task 15 (D14; rulings 66, 67; T15-CUT): the Stryker floor. Run from packages/engine: the floor file, the equivalents file
// and every relative path below are read against the working directory.
//
// A floor is kept per FAMILY (STRYKER_FAMILIES: ruling 66's ten groups), never per leg: the score of a family is Stryker's
// TOTAL score over ALL its legs' mutants added together, so cutting a file again, or adding a leg, never removes a floor key.
// A leg's report is the file `<leg>.json` (mutation.yml's per-leg artifact holds reports/mutation/<leg>.json); a mode that
// judges a family takes the DIRECTORY holding its legs' reports and finds each by that name, anywhere under it.
//
//   --check <family> <dir> [--skip-if-no-floors]
//       judges the family against its floor in stryker-floor.json. The score is Stryker's TOTAL score:
//       (Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage), so an uncovered line is a survivor, with Ignored,
//       CompileError and RuntimeError outside the denominator, and the mutants stryker-equivalent.json records (by
//       `file:line:col mutator → replacement`) taken out of it. Every leg of the family must have a report of its own files
//       (and its own line ranges, for a leg of a split file) holding at least one mutant. --skip-if-no-floors passes a floor
//       file whose `families` is EMPTY (PR-A's state: it prints "no floor yet: PR-B sets it", still refusing a report that
//       measured nothing); once any floor exists a family without one is refused.
//   --check-all <dir> --legs <leg,leg,...> [--skip-if-no-floors]
//       --check for every family all of whose legs are in --legs (the legs the run planned: mutation.yml's matrix). A family
//       with only some of its legs planned (a dispatch of one leg) is printed as not judged, never judged on part of its
//       mutants; a planned leg without a report is a refusal, never a skip. Exit 2 if any family was refused, else 1 if any was
//       below its floor, else 0.
//   --set-floor <family> <dir>
//       PR-B only: writes floor = floor(score, 1 dp) into stryker-floor.json, and refuses to lower an existing floor.
//   --check-file-against <ref>
//       the floor only rises: exit 1 when any family's floor in the working file is LOWER than at <ref>, or a family was
//       removed. stryker-floor.json ABSENT at <ref> means "no floors yet" (PR-A's own first run, where HEAD^1 is main, which
//       lacks the file): exit 0, printing `no floors at <ref>: nothing to compare`. The file absent in the WORKING TREE is
//       always exit 2: PR-A commits it, so a missing file is a deletion, and after PR-B a deleted floor file must never read
//       as "no floors" (fail closed). The ref is read with `git rev-parse --verify <ref>^{commit}`, `git ls-tree` and
//       `git show <commit>:./stryker-floor.json`, all relative to the working directory; the compared count is printed.
//   --survivors <leg> <mutation.json> --out <file>
//       writes `file:line:col mutator → replacement` for each Survived / NoCoverage mutant not in stryker-equivalent.json:
//       one LEG's evidence (a leg is what a CI job runs), not a floor.
//   --check-selection <leg> <report.json>
//       judges only WHERE a report's mutants are: exit 0 when every one lies inside the leg's files and line ranges (the check
//       --survivors makes first), 2 when one does not, or when there are none. It reads a report or Stryker's INCREMENTAL file
//       (the same shape, written whole or, after an interrupt, partial), whose statuses it does not read: the workflow runs it on
//       the incremental file before saving that to the cache, so a file Survivors would refuse is never cached (W1d T20).
//
// Exit codes, each with one meaning (the one convention, D8):
//   0  done: the score is at or above the floor / the floor was written / nothing fell / the survivors were written;
//   1  a negative signal: the score is BELOW the floor (survivors listed on stdout), or a floor fell or was removed;
//   2  refused, nothing judged or written: usage, unreadable or malformed input, zero mutants (in a leg or in all), no floor
//      for the family, an unknown family, the probe (it has no floor), a leg without a report or a report of another leg's
//      files, a floor that would be lowered, or the floor file missing from the working tree.
//   (3, a crash while loading, is not claimed: this runs under plain `node`, where a load crash exits 1.)
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, matchesGlob, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { resolveGroup } from "./stryker-cuts.mjs";
import { STRYKER_FAMILIES, STRYKER_GROUPS } from "../stryker.groups.mjs";

const FLOOR_FILE = "stryker-floor.json";
const EQUIVALENT_FILE = "stryker-equivalent.json";
const USAGE = [
  "usage: stryker-floor.ts --check <family> <dir> [--skip-if-no-floors]",
  "       stryker-floor.ts --check-all <dir> --legs <leg,leg,...> [--skip-if-no-floors]",
  "       stryker-floor.ts --set-floor <family> <dir>",
  "       stryker-floor.ts --check-file-against <ref>",
  "       stryker-floor.ts --survivors <leg> <mutation.json> --out <file>",
  "       stryker-floor.ts --check-selection <leg> <report.json>",
].join("\n");

export interface Mutant {
  id?: string;
  mutatorName: string;
  replacement?: string;
  status: string;
  location: { start: { line: number; column: number }; end?: { line: number; column: number } };
}
/** The part of a mutation-testing-elements report (the schema Stryker 10 writes) the floor reads. */
export interface Report { files: Record<string, { mutants: Mutant[] }> }
export type Floors = Record<string, number>;
/** A family's reports: leg name -> that leg's report. */
export type LegReports = Record<string, Report>;

/** An input the CLI refuses to judge: exit 2, never a verdict. */
class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

const DETECTED = new Set(["Killed", "Timeout"]);
const UNDETECTED = new Set(["Survived", "NoCoverage"]);
const OUT_OF_SCORE = new Set(["Ignored", "CompileError", "RuntimeError"]);

const GROUPS: Record<string, string[] | undefined> = STRYKER_GROUPS;
const FAMILIES: Record<string, string[] | undefined> = STRYKER_FAMILIES;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new Refusal(`${what} is not valid JSON: ${(e as Error).message}`);
  }
}

/** The mutation report, validated: every mutant has a name, a position and a status this file knows how to count. An unknown
 *  status is refused (it would silently skew the score), and so is Pending (the run did not finish). */
export function parseReport(text: string): Report {
  const raw = parseJson(text, "the mutation report");
  if (!isObject(raw) || !isObject(raw.files)) throw new Refusal("the mutation report has no `files` map");
  const files: Report["files"] = {};
  for (const [file, entry] of Object.entries(raw.files)) {
    if (!isObject(entry) || !Array.isArray(entry.mutants)) throw new Refusal(`the mutation report's ${file} has no \`mutants\` array`);
    const mutants: Mutant[] = [];
    for (const [i, m] of (entry.mutants as unknown[]).entries()) {
      const where = `${file} mutant #${i}`;
      if (!isObject(m) || typeof m.mutatorName !== "string" || typeof m.status !== "string") throw new Refusal(`the mutation report's ${where} has no mutatorName or status`);
      const start = isObject(m.location) && isObject(m.location.start) ? m.location.start : null;
      if (start === null || !isCount(start.line) || !isCount(start.column)) throw new Refusal(`the mutation report's ${where} has no location.start line and column`);
      if (m.status === "Pending") throw new Refusal(`the mutation report's ${where} is Pending: the run did not finish`);
      if (!DETECTED.has(m.status) && !UNDETECTED.has(m.status) && !OUT_OF_SCORE.has(m.status)) throw new Refusal(`the mutation report's ${where} has status "${m.status}", which this floor does not count`);
      mutants.push({
        ...(typeof m.id === "string" ? { id: m.id } : {}),
        mutatorName: m.mutatorName,
        ...(typeof m.replacement === "string" ? { replacement: m.replacement } : {}),
        status: m.status,
        location: { start: { line: start.line, column: start.column } },
      });
    }
    files[file] = { mutants };
  }
  return { files };
}

/** stryker-floor.json: `{note?, families: {family: floor}}` with each floor 0-100 and at most one decimal. */
export function parseFloors(text: string): Floors {
  const raw = parseJson(text, FLOOR_FILE);
  if (!isObject(raw) || !isObject(raw.families)) throw new Refusal(`${FLOOR_FILE} has no \`families\` map`);
  const floors: Floors = {};
  for (const [f, v] of Object.entries(raw.families)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100 || Math.abs(v * 10 - Math.round(v * 10)) > 1e-9) {
      throw new Refusal(`${FLOOR_FILE}: the floor for "${f}" must be a number from 0 to 100 with at most one decimal (got ${JSON.stringify(v)})`);
    }
    floors[f] = v;
  }
  return floors;
}

/** stryker-equivalent.json: `{note?, equivalent: [{mutant: "file:line:col mutator → replacement", reason}]}`. A recorded
 *  equivalent mutant owes a reason (at least 10 characters), and is recorded once. Returns the mutant keys. */
export function parseEquivalents(text: string): string[] {
  const raw = parseJson(text, EQUIVALENT_FILE);
  if (!isObject(raw) || !Array.isArray(raw.equivalent)) throw new Refusal(`${EQUIVALENT_FILE} has no \`equivalent\` array`);
  const keys: string[] = [];
  for (const [i, e] of (raw.equivalent as unknown[]).entries()) {
    if (!isObject(e) || typeof e.mutant !== "string" || e.mutant === "" || typeof e.reason !== "string" || e.reason.length < 10) {
      throw new Refusal(`${EQUIVALENT_FILE} entry #${i} needs a \`mutant\` (file:line:col mutator → replacement) and a \`reason\` of at least 10 characters`);
    }
    if (keys.includes(e.mutant)) throw new Refusal(`${EQUIVALENT_FILE} records "${e.mutant}" twice`);
    keys.push(e.mutant);
  }
  return keys;
}

/** A mutant's identity, stable across runs (Stryker's own ids are not): `file:line:col mutator → replacement`, with a
 *  multi-line replacement on one line (a newline written `\n`). */
export function mutantKey(file: string, m: Mutant): string {
  const replacement = (m.replacement ?? "").replace(/\r\n|\r|\n/g, "\\n");
  return `${file}:${m.location.start.line}:${m.location.start.column} ${m.mutatorName} → ${replacement}`;
}

interface Tally {
  killed: number; timeout: number; survived: number; noCoverage: number; outOfScore: number; equivalent: number;
  detected: number; valid: number;
  /** floor(score x 10): the score in tenths of a percent, by integer arithmetic (a float quotient can read 73.3999… for 73.4). */
  tenths: number;
  /** The keys of every Survived / NoCoverage mutant that is not recorded equivalent, by file, line, column. */
  survivors: string[];
}

function tally(report: Report, equivalents: readonly string[]): Tally {
  const eq = new Set(equivalents);
  const t = { killed: 0, timeout: 0, survived: 0, noCoverage: 0, outOfScore: 0, equivalent: 0 };
  const survivors: { key: string; file: string; line: number; col: number }[] = [];
  for (const [file, { mutants }] of Object.entries(report.files)) {
    for (const m of mutants) {
      if (m.status === "Killed") t.killed++;
      else if (m.status === "Timeout") t.timeout++;
      else if (OUT_OF_SCORE.has(m.status)) t.outOfScore++;
      else {
        const key = mutantKey(file, m);
        if (eq.has(key)) { t.equivalent++; continue; }
        if (m.status === "Survived") t.survived++;
        else t.noCoverage++;
        survivors.push({ key, file, line: m.location.start.line, col: m.location.start.column });
      }
    }
  }
  const detected = t.killed + t.timeout;
  const valid = detected + t.survived + t.noCoverage;
  survivors.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || a.col - b.col || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)));
  return { ...t, detected, valid, tenths: valid === 0 ? 0 : Math.floor((detected * 1000) / valid), survivors: survivors.map((s) => s.key) };
}

const fmt = (tenths: number): string => (tenths / 10).toFixed(1);

/** A leg's `mutate` entries as Stryker reads them: its parts of a split file (`file#N`) resolved to `file:a-b` by the TypeScript
 *  parser (scripts/stryker-cuts.mjs), once per leg. */
const resolvedEntries = new Map<string, string[]>();
function entriesOf(leg: string): string[] {
  let entries = resolvedEntries.get(leg);
  if (entries === undefined) {
    entries = resolveGroup(leg);
    resolvedEntries.set(leg, entries);
  }
  return entries;
}

/** What a leg's `mutate` entries select of one file, read in order as Stryker reads them (a glob adds the file, `!glob`
 *  removes it, a later glob adds it back): null when none, "all", or the line ranges of the `file:a-b` entries. */
function selection(entries: readonly string[], file: string): "all" | [number, number][] | null {
  let sel: "all" | [number, number][] | null = null;
  for (const e of entries) {
    if (e.startsWith("!")) {
      if (matchesGlob(file, e.slice(1))) sel = null;
      continue;
    }
    const range = /^(.*):(\d+)-(\d+)$/.exec(e);
    if (!matchesGlob(file, range === null ? e : (range[1] as string))) continue;
    sel = range === null || sel === "all" ? "all" : [...(sel ?? []), [Number(range[2]), Number(range[3])]];
  }
  return sel;
}

/** What of `report` the leg's `mutate` entries do not select: a file the leg does not select, or, for a file the leg selects
 *  only by line range (a leg of a split file), a mutant that STARTS outside every range (`file:line`). A report of another leg
 *  of the same file is the wrong report too. */
function outsideGroup(leg: string, report: { files: Record<string, { mutants: { location: { start: { line: number } } }[] }> }): string[] {
  const entries = entriesOf(leg);
  const out: string[] = [];
  for (const [file, { mutants }] of Object.entries(report.files)) {
    const sel = selection(entries, file);
    if (sel === null) out.push(file);
    else if (sel !== "all") for (const m of mutants) if (!sel.some(([from, to]) => m.location.start.line >= from && m.location.start.line <= to)) out.push(`${file}:${m.location.start.line}`);
  }
  return out;
}

/** The places of a report's (or an incremental file's) mutants, and nothing else: the statuses of a partial file are not judged
 *  here (a Pending one is the interrupted run's own). Refuses what is not a `files` map of mutants with a start line. */
function parsePlaces(text: string, what: string): { files: Record<string, { mutants: { location: { start: { line: number } } }[] }>; mutants: number } {
  const raw = parseJson(text, what);
  if (!isObject(raw) || !isObject(raw.files)) throw new Refusal(`${what} has no \`files\` map`);
  const files: Record<string, { mutants: { location: { start: { line: number } } }[] }> = {};
  let mutants = 0;
  for (const [file, entry] of Object.entries(raw.files)) {
    if (!isObject(entry) || !Array.isArray(entry.mutants)) throw new Refusal(`${what}'s ${file} has no \`mutants\` array`);
    files[file] = { mutants: [] };
    for (const [i, m] of (entry.mutants as unknown[]).entries()) {
      const start = isObject(m) && isObject(m.location) && isObject(m.location.start) ? m.location.start : null;
      if (start === null || !isCount(start.line)) throw new Refusal(`${what}'s ${file} mutant #${i} has no location.start line`);
      files[file].mutants.push({ location: { start: { line: start.line } } });
      mutants++;
    }
  }
  return { files, mutants };
}

/** The legs' reports as one: a file two legs both report (the parts of a split file) lists the mutants of all of them. */
export function mergeReports(reports: LegReports): Report {
  const files: Report["files"] = {};
  for (const leg of Object.keys(reports)) {
    for (const [file, { mutants }] of Object.entries((reports[leg] as Report).files)) files[file] = { mutants: [...(files[file]?.mutants ?? []), ...mutants] };
  }
  return { files };
}

type Refused = { exit: 2; why: string };

/** What every judgement needs first: a real FAMILY (a leg is not one: floors are not kept per leg), exactly its legs' reports,
 *  each of THAT leg's files and line ranges and each holding mutants, and mutants to count in all. */
function prepare(family: string, reports: LegReports, equivalents: readonly string[]): Refused | { t: Tally; legs: number } {
  const legs = FAMILIES[family];
  if (family === "probe") return { exit: 2, why: "the probe has no floor: it is the PR self-proof (D3), not a measured family" };
  if (legs === undefined) {
    const of = Object.entries(STRYKER_FAMILIES).find(([, l]) => l.includes(family))?.[0];
    return { exit: 2, why: `unknown family "${family}": expected one of ${Object.keys(STRYKER_FAMILIES).join(", ")}${of === undefined ? "" : ` ("${family}" is a leg of "${of}": floors are kept per family, never per leg, so a re-split cannot remove one)`}` };
  }
  const given = Object.keys(reports);
  const missing = legs.filter((l) => !given.includes(l));
  const extra = given.filter((l) => !legs.includes(l));
  if (missing.length > 0 || extra.length > 0) {
    return { exit: 2, why: `the reports are not family "${family}"'s legs (${legs.join(", ")}): ${missing.length > 0 ? `missing ${missing.join(", ")}` : ""}${missing.length > 0 && extra.length > 0 ? "; " : ""}${extra.length > 0 ? `unexpected ${extra.join(", ")}` : ""}: a family is judged on all its legs, never on some of them` };
  }
  for (const leg of legs) {
    const report = reports[leg] as Report;
    const outside = outsideGroup(leg, report);
    if (outside.length > 0) return { exit: 2, why: `the report is not leg "${leg}"'s: it mutated ${outside.slice(0, 3).join(", ")}${outside.length > 3 ? ` and ${outside.length - 3} more` : ""}, outside the leg's files and line ranges` };
    const own = tally(report, equivalents);
    if (own.valid === 0) return { exit: 2, why: `zero mutants counted for leg "${leg}" of family "${family}" (killed ${own.killed}, timeout ${own.timeout}, survived ${own.survived}, no coverage ${own.noCoverage}, ignored or errored ${own.outOfScore}, equivalent ${own.equivalent}): a leg that measured nothing is refused, never passed` };
  }
  return { t: tally(mergeReports(reports), equivalents), legs: legs.length };
}

const describeScore = (t: Tally): string =>
  `${fmt(t.tenths)}% (${t.detected} of ${t.valid} detected: killed ${t.killed}, timeout ${t.timeout}; survived ${t.survived}, no coverage ${t.noCoverage}; ${t.equivalent} equivalent excluded)`;

export type Verdict = Refused | { exit: 0 | 1; why: string; scoreTenths: number; floorTenths: number; survivors: string[] };

/** 0 at or above the family's floor, 1 below it (survivors listed), 2 refused. */
export function check(family: string, reports: LegReports, floors: Floors, equivalents: readonly string[] = []): Verdict {
  const p = prepare(family, reports, equivalents);
  if ("exit" in p) return p;
  const floor = floors[family];
  if (floor === undefined) return { exit: 2, why: `no floor for family "${family}" in ${FLOOR_FILE}: PR-B sets it` };
  const floorTenths = Math.round(floor * 10);
  const ok = p.t.tenths >= floorTenths;
  return { exit: ok ? 0 : 1, why: `${family}: score ${describeScore(p.t)} over ${p.legs} leg(s) ${ok ? "is at or above" : "is BELOW"} the floor ${fmt(floorTenths)}%`, scoreTenths: p.t.tenths, floorTenths, survivors: p.t.survivors };
}

/** The floors with `family`'s set to floor(score, 1 dp), refusing to lower one that exists. */
export function setFloor(family: string, reports: LegReports, floors: Floors, equivalents: readonly string[] = []): Refused | { exit: 0; why: string; floors: Floors } {
  const p = prepare(family, reports, equivalents);
  if ("exit" in p) return p;
  const was = floors[family];
  if (was !== undefined && p.t.tenths < Math.round(was * 10)) return { exit: 2, why: `refusing to lower the floor of "${family}" from ${fmt(Math.round(was * 10))}% to ${fmt(p.t.tenths)}%: a floor only rises` };
  return { exit: 0, why: `${family}: floor ${was === undefined ? "set" : `${fmt(Math.round(was * 10))}% ->`} ${fmt(p.t.tenths)}% (score ${describeScore(p.t)} over ${p.legs} leg(s))`, floors: { ...floors, [family]: p.t.tenths / 10 } };
}

/** The families whose floor is lower in `now` than in `was`, or gone, in the order `was` lists them. A family added in `now` is not one. */
export function floorDiff(was: Floors, now: Floors): { family: string; was: number; now: number | null }[] {
  const out: { family: string; was: number; now: number | null }[] = [];
  for (const [family, w] of Object.entries(was)) {
    const n = now[family];
    if (n === undefined) out.push({ family, was: w, now: null });
    else if (Math.round(n * 10) < Math.round(w * 10)) out.push({ family, was: w, now: n });
  }
  return out;
}

/** The families with no floor, once ANY floor exists (a missing entry is a failure, never a skip: review 4, R4-m3).
 *  Nothing is missing while no floor exists at all: that is PR-A's state. */
export function missingFloors(families: readonly string[], floors: Floors): string[] {
  if (Object.keys(floors).length === 0) return [];
  return families.filter((f) => floors[f] === undefined);
}

/** SURVIVORS.md: one `file:line:col mutator → replacement` line for each Survived / NoCoverage mutant not recorded equivalent.
 *  One LEG's evidence (a leg is what a CI job runs). */
export function survivorsMarkdown(leg: string, report: Report, equivalents: readonly string[]): string {
  const t = tally(report, equivalents);
  const lines = [`# Survivors: ${leg}`, ""];
  lines.push(t.valid === 0
    ? `No valid mutants in this report (killed ${t.killed}, timeout ${t.timeout}, ignored or errored ${t.outOfScore}).`
    : `Score ${describeScore(t)}.`);
  lines.push("", `${t.survivors.length} listed, ${t.equivalent} equivalent excluded (recorded in ${EQUIVALENT_FILE}).`, "");
  if (t.survivors.length === 0) lines.push("No survivors.");
  else lines.push("~~~", ...t.survivors, "~~~");
  return `${lines.join("\n")}\n`;
}

// ---- the CLI -------------------------------------------------------------------------------------------------------------

const out = (s: string): void => { process.stdout.write(`${s}\n`); };
const err = (s: string): void => { process.stderr.write(`${s}\n`); };

function readText(path: string, what: string): string {
  try {
    return readFileSync(resolve(path), "utf8");
  } catch {
    throw new Refusal(`${what} is unreadable or missing: ${path}`);
  }
}
const readFloors = (): Floors => parseFloors(readText(FLOOR_FILE, FLOOR_FILE));
/** The equivalents are optional DATA: a missing file records none (which only makes the score stricter); a malformed one is refused. */
function readEquivalents(): string[] {
  let text: string;
  try {
    text = readFileSync(resolve(EQUIVALENT_FILE), "utf8");
  } catch {
    return [];
  }
  return parseEquivalents(text);
}

/** The report of each of `legs` under `dir`: the one file named `<leg>.json`, wherever below `dir` it is (mutation.yml's per-leg
 *  artifacts unpack to `<dir>/mutation-<leg>/reports/mutation/<leg>.json`; a local run writes `reports/mutation/<leg>.json`).
 *  A leg with no such file is refused, and so is one with two: neither can be guessed. */
function readLegReports(dir: string, legs: readonly string[]): LegReports {
  let names: string[];
  try {
    names = readdirSync(resolve(dir), { recursive: true, encoding: "utf8" });
  } catch {
    throw new Refusal(`the reports directory is unreadable or missing: ${dir}`);
  }
  const reports: LegReports = {};
  for (const leg of legs) {
    const found = names.filter((n) => basename(n) === `${leg}.json`);
    if (found.length === 0) throw new Refusal(`no report for leg "${leg}" under ${dir} (a file named ${leg}.json): a leg that wrote no report is refused, never skipped`);
    if (found.length > 1) throw new Refusal(`${found.length} reports named ${leg}.json under ${dir} (${found.slice(0, 3).join(", ")}): which is the leg's?`);
    reports[leg] = parseReport(readText(resolve(dir, found[0] as string), `the report of leg ${leg}`));
  }
  return reports;
}

/** One family's verdict from the reports under `dir`, printed. Returns the exit code; a refusal throws. */
function judgeFamily(family: string, dir: string, floors: Floors, equivalents: readonly string[], skipIfNoFloors: boolean): 0 | 1 {
  const legs = FAMILIES[family];
  const reports = readLegReports(dir, legs ?? []);
  if (skipIfNoFloors && Object.keys(floors).length === 0) {
    // PR-A's state. The reports must still prove the family ran: a refusal here is a refusal, never a skip.
    const p = prepare(family, reports, equivalents);
    if ("exit" in p) throw new Refusal(p.why);
    out(`stryker-floor: no floor yet: PR-B sets it (${family}: score ${describeScore(p.t)} over ${p.legs} leg(s))`);
    return 0;
  }
  const v = check(family, reports, floors, equivalents);
  if (v.exit === 2) throw new Refusal(v.why);
  out(`stryker-floor: ${v.why}`);
  if (v.exit === 1) for (const s of v.survivors) out(s);
  return v.exit;
}

/** `--check` for every family all of whose legs were planned. */
function checkAll(dir: string, legsCsv: string, floors: Floors, equivalents: readonly string[], skipIfNoFloors: boolean): number {
  const planned = legsCsv.split(",").map((l) => l.trim());
  if (planned.some((l) => l === "")) throw new Refusal(`--legs "${legsCsv}" has an empty entry (a list of legs, comma-separated)`);
  const unknown = planned.filter((l) => GROUPS[l] === undefined);
  if (unknown.length > 0) throw new Refusal(`--legs names unknown leg(s) ${unknown.join(", ")}: expected legs of ${Object.keys(STRYKER_GROUPS).join(", ")}`);
  if (planned.includes("probe")) throw new Refusal("--legs names the probe, which has no floor: it is the PR self-proof (D3)");
  if (new Set(planned).size !== planned.length) throw new Refusal(`--legs "${legsCsv}" names a leg twice`);
  let judged = 0;
  let below = 0;
  let refused = 0;
  let partial = 0;
  for (const [family, legs] of Object.entries(FAMILIES) as [string, string[]][]) {
    const ran = legs.filter((l) => planned.includes(l));
    if (ran.length === 0) continue;
    if (ran.length < legs.length) {
      out(`stryker-floor: ${family}: not judged, only ${ran.length} of its ${legs.length} legs were planned (${legs.filter((l) => !ran.includes(l)).join(", ")} not): a family floor is the sum of all its legs`);
      partial++;
      continue;
    }
    try {
      const code = judgeFamily(family, dir, floors, equivalents, skipIfNoFloors);
      judged++;
      if (code === 1) below++;
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      err(`stryker-floor: ${family}: ${e.message}`);
      refused++;
    }
  }
  out(`stryker-floor: ${judged} famil(ies) judged, ${below} below the floor; ${partial} not judged (partly planned), ${refused} refused`);
  return refused > 0 ? 2 : below > 0 ? 1 : 0;
}

function git(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function checkFileAgainst(ref: string): number {
  // The working file first, whatever the ref says: absent here is a deletion (exit 2), never "no floors".
  const now = readFloors();
  if (ref === "" || ref.startsWith("-")) throw new Refusal(`"${ref}" is not a ref`);
  const rev = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const commit = rev.stdout.trim();
  if (rev.status !== 0 || commit === "") throw new Refusal(`"${ref}" is not a commit in this repository (git rev-parse --verify ${ref}^{commit} failed)`);
  const tree = git(["ls-tree", "--name-only", commit, "--", FLOOR_FILE]);
  if (tree.status !== 0) throw new Refusal(`git ls-tree ${ref} failed: ${tree.stderr.trim()}`);
  if (tree.stdout.trim() === "") {
    out(`stryker-floor: no floors at ${ref}: nothing to compare`);
    return 0;
  }
  const show = git(["show", `${commit}:./${FLOOR_FILE}`]);
  if (show.status !== 0) throw new Refusal(`git show ${ref}:./${FLOOR_FILE} failed: ${show.stderr.trim()}`);
  const was = parseFloors(show.stdout);
  const diff = floorDiff(was, now);
  out(`stryker-floor: compared ${Object.keys(was).length} floor(s) against ${ref}: ${diff.length} lowered or removed`);
  for (const d of diff) out(`  ${d.family}: ${d.was} -> ${d.now ?? "(removed)"}`);
  return diff.length === 0 ? 0 : 1;
}

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        check: { type: "boolean" },
        "check-all": { type: "boolean" },
        legs: { type: "string" },
        "set-floor": { type: "boolean" },
        "check-file-against": { type: "string" },
        survivors: { type: "boolean" },
        "check-selection": { type: "boolean" },
        out: { type: "string" },
        "skip-if-no-floors": { type: "boolean" },
      },
    });
  } catch (e) {
    throw new Refusal(`${(e as Error).message}\n${USAGE}`);
  }
}

/** Runs one CLI invocation and returns its exit code (the entry point at the bottom sets `process.exitCode` from it). */
export function main(argv: string[]): number {
  try {
    const parsed = parse(argv);
    const { values, positionals } = parsed;
    const modes = (["check", "check-all", "set-floor", "check-file-against", "survivors", "check-selection"] as const).filter((m) => values[m] !== undefined);
    if (modes.length !== 1) throw new Refusal(`exactly one mode is required\n${USAGE}`);
    const mode = modes[0]!;
    const takes = { check: "<family> <dir>", "set-floor": "<family> <dir>", survivors: "<leg> <mutation.json>", "check-all": "<dir>", "check-file-against": "", "check-selection": "<leg> <report.json>" } as const;
    const need = mode === "check-file-against" ? 0 : mode === "check-all" ? 1 : 2;
    if (positionals.length !== need) throw new Refusal(`${mode} takes ${need === 0 ? "no positional arguments" : takes[mode]}\n${USAGE}`);
    if (values.out !== undefined && mode !== "survivors") throw new Refusal(`--out belongs to --survivors\n${USAGE}`);
    if (values["skip-if-no-floors"] !== undefined && mode !== "check" && mode !== "check-all") throw new Refusal(`--skip-if-no-floors belongs to --check and --check-all\n${USAGE}`);
    if (values.legs !== undefined && mode !== "check-all") throw new Refusal(`--legs belongs to --check-all\n${USAGE}`);
    if (mode === "check-all" && (values.legs === undefined || values.legs === "")) throw new Refusal(`--check-all needs --legs <leg,leg,...>: the legs the run planned\n${USAGE}`);

    if (mode === "check-file-against") return checkFileAgainst(values["check-file-against"] ?? "");

    if (mode === "check-selection") {
      const [leg = "", reportPath = ""] = positionals;
      if (GROUPS[leg] === undefined) throw new Refusal(`unknown group "${leg}": expected one of ${Object.keys(STRYKER_GROUPS).join(", ")}`);
      const places = parsePlaces(readText(reportPath, "the incremental file"), "the incremental file");
      if (places.mutants === 0) throw new Refusal(`the incremental file holds no mutants: nothing to judge, and nothing earned to keep`);
      const outside = outsideGroup(leg, places);
      if (outside.length > 0) throw new Refusal(`the incremental file is not group "${leg}"'s: it holds ${outside.slice(0, 3).join(", ")}, outside the group's files and line ranges`);
      out(`stryker-floor: check-selection ${leg}: ${places.mutants} mutants in ${Object.keys(places.files).length} files, all inside the group's files and line ranges`);
      return 0;
    }

    if (mode === "survivors") {
      const [leg = "", reportPath = ""] = positionals;
      const report = parseReport(readText(reportPath, "the mutation report"));
      if (values.out === undefined || values.out === "") throw new Refusal(`--survivors needs --out <file>\n${USAGE}`);
      if (GROUPS[leg] === undefined) throw new Refusal(`unknown group "${leg}": expected one of ${Object.keys(STRYKER_GROUPS).join(", ")}`);
      const outside = outsideGroup(leg, report);
      if (outside.length > 0) throw new Refusal(`the report is not group "${leg}"'s: it mutated ${outside.slice(0, 3).join(", ")}, outside the group's files and line ranges`);
      const equivalents = readEquivalents();
      const md = survivorsMarkdown(leg, report, equivalents);
      mkdirSync(dirname(resolve(values.out)), { recursive: true });
      writeFileSync(resolve(values.out), md);
      const t = tally(report, equivalents);
      out(`stryker-floor: survivors ${leg}: ${t.survivors.length} listed, ${t.equivalent} equivalent excluded -> ${values.out}`);
      return 0;
    }

    const floorText = readText(FLOOR_FILE, FLOOR_FILE);
    const floors = parseFloors(floorText);
    const equivalents = readEquivalents();
    const skip = values["skip-if-no-floors"] === true;

    if (mode === "check-all") return checkAll(positionals[0] ?? "", values.legs ?? "", floors, equivalents, skip);

    const [family = "", dir = ""] = positionals;
    if (mode === "set-floor") {
      const r = setFloor(family, readLegReports(dir, FAMILIES[family] ?? []), floors, equivalents);
      if (r.exit === 2) throw new Refusal(r.why);
      const raw = JSON.parse(floorText) as Record<string, unknown>;
      writeFileSync(resolve(FLOOR_FILE), `${JSON.stringify({ ...raw, families: r.floors }, null, 2)}\n`);
      out(`stryker-floor: ${r.why}`);
      return 0;
    }

    // --check
    return judgeFamily(family, dir, floors, equivalents, skip);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    err(`stryker-floor: ${e.message}`);
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
