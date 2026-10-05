// CLI: pnpm --filter @seazn/engine mutation:floor <mode> ...        (node --experimental-strip-types scripts/stryker-floor.ts)
// W1d Task 15 (D14; rulings 66, 67): the Stryker floor. Run from packages/engine: the floor file, the equivalents file and
// every relative path below are read against the working directory.
//
//   --check <group> <mutation.json> [--skip-if-no-floors]
//       judges the group's report against its floor in stryker-floor.json. The score is Stryker's TOTAL score:
//       (Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage), so an uncovered line is a survivor, with Ignored,
//       CompileError and RuntimeError outside the denominator, and the mutants stryker-equivalent.json records (by
//       `file:line:col mutator → replacement`) taken out of it. --skip-if-no-floors passes a floor file whose `groups` is
//       EMPTY (PR-A's state: it prints "no floor yet: PR-B sets it", still refusing a report that measured nothing); once
//       any floor exists a group without one is refused.
//   --set-floor <group> <mutation.json>
//       PR-B only: writes floor = floor(score, 1 dp) into stryker-floor.json, and refuses to lower an existing floor.
//   --check-file-against <ref>
//       the floor only rises: exit 1 when any group's floor in the working file is LOWER than at <ref>, or a group was
//       removed. stryker-floor.json ABSENT at <ref> means "no floors yet" (PR-A's own first run, where HEAD^1 is main, which
//       lacks the file): exit 0, printing `no floors at <ref>: nothing to compare`. The file absent in the WORKING TREE is
//       always exit 2: PR-A commits it, so a missing file is a deletion, and after PR-B a deleted floor file must never read
//       as "no floors" (fail closed). The ref is read with `git rev-parse --verify <ref>^{commit}`, `git ls-tree` and
//       `git show <commit>:./stryker-floor.json`, all relative to the working directory; the compared count is printed.
//   --survivors <group> <mutation.json> --out <file>
//       writes `file:line:col mutator → replacement` for each Survived / NoCoverage mutant not in stryker-equivalent.json.
//
// Exit codes, each with one meaning (the one convention, D8):
//   0  done: the score is at or above the floor / the floor was written / nothing fell / the survivors were written;
//   1  a negative signal: the score is BELOW the floor (survivors listed on stdout), or a floor fell or was removed;
//   2  refused, nothing judged or written: usage, unreadable or malformed input, zero mutants, no floor for the group, an
//      unknown group, the probe (it has no floor), a report of another group's files, a floor that would be lowered, or the
//      floor file missing from the working tree.
//   (3, a crash while loading, is not claimed: this runs under plain `node`, where a load crash exits 1.)
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, matchesGlob, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { STRYKER_GROUPS } from "../stryker.groups.mjs";

const FLOOR_FILE = "stryker-floor.json";
const EQUIVALENT_FILE = "stryker-equivalent.json";
const USAGE = [
  "usage: stryker-floor.ts --check <group> <mutation.json> [--skip-if-no-floors]",
  "       stryker-floor.ts --set-floor <group> <mutation.json>",
  "       stryker-floor.ts --check-file-against <ref>",
  "       stryker-floor.ts --survivors <group> <mutation.json> --out <file>",
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

/** stryker-floor.json: `{note?, groups: {group: floor}}` with each floor 0-100 and at most one decimal. */
export function parseFloors(text: string): Floors {
  const raw = parseJson(text, FLOOR_FILE);
  if (!isObject(raw) || !isObject(raw.groups)) throw new Refusal(`${FLOOR_FILE} has no \`groups\` map`);
  const floors: Floors = {};
  for (const [g, v] of Object.entries(raw.groups)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100 || Math.abs(v * 10 - Math.round(v * 10)) > 1e-9) {
      throw new Refusal(`${FLOOR_FILE}: the floor for "${g}" must be a number from 0 to 100 with at most one decimal (got ${JSON.stringify(v)})`);
    }
    floors[g] = v;
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

/** What a group's `mutate` entries select of one file, read in order as Stryker reads them (a glob adds the file, `!glob`
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

/** What of `report` the group's `mutate` entries do not select: a file the group does not select, or, for a file the group
 *  selects only by line range (a leg of a split file), a mutant that STARTS outside every range (`file:line`). A report of
 *  another leg of the same file is the wrong report too. */
function outsideGroup(group: string, report: Report): string[] {
  const entries = GROUPS[group] ?? [];
  const out: string[] = [];
  for (const [file, { mutants }] of Object.entries(report.files)) {
    const sel = selection(entries, file);
    if (sel === null) out.push(file);
    else if (sel !== "all") for (const m of mutants) if (!sel.some(([from, to]) => m.location.start.line >= from && m.location.start.line <= to)) out.push(`${file}:${m.location.start.line}`);
  }
  return out;
}

type Refused = { exit: 2; why: string };

/** What every judgement needs first: a real group that has a floor to speak of, a report of THAT group's files, and mutants to count. */
function prepare(group: string, report: Report, equivalents: readonly string[]): Refused | { t: Tally } {
  if (GROUPS[group] === undefined) return { exit: 2, why: `unknown group "${group}": expected one of ${Object.keys(STRYKER_GROUPS).join(", ")}` };
  if (group === "probe") return { exit: 2, why: "the probe has no floor: it is the PR self-proof (D3), not a measured group" };
  const outside = outsideGroup(group, report);
  if (outside.length > 0) return { exit: 2, why: `the report is not group "${group}"'s: it mutated ${outside.slice(0, 3).join(", ")}${outside.length > 3 ? ` and ${outside.length - 3} more` : ""}, outside the group's files and line ranges` };
  const t = tally(report, equivalents);
  if (t.valid === 0) return { exit: 2, why: `zero mutants counted for group "${group}" (killed ${t.killed}, timeout ${t.timeout}, survived ${t.survived}, no coverage ${t.noCoverage}, ignored or errored ${t.outOfScore}, equivalent ${t.equivalent}): a report that measured nothing is refused, never passed` };
  return { t };
}

const describeScore = (t: Tally): string =>
  `${fmt(t.tenths)}% (${t.detected} of ${t.valid} detected: killed ${t.killed}, timeout ${t.timeout}; survived ${t.survived}, no coverage ${t.noCoverage}; ${t.equivalent} equivalent excluded)`;

export type Verdict = Refused | { exit: 0 | 1; why: string; scoreTenths: number; floorTenths: number; survivors: string[] };

/** 0 at or above the group's floor, 1 below it (survivors listed), 2 refused. */
export function check(group: string, report: Report, floors: Floors, equivalents: readonly string[] = []): Verdict {
  const p = prepare(group, report, equivalents);
  if ("exit" in p) return p;
  const floor = floors[group];
  if (floor === undefined) return { exit: 2, why: `no floor for group "${group}" in ${FLOOR_FILE}: PR-B sets it` };
  const floorTenths = Math.round(floor * 10);
  const ok = p.t.tenths >= floorTenths;
  return { exit: ok ? 0 : 1, why: `${group}: score ${describeScore(p.t)} ${ok ? "is at or above" : "is BELOW"} the floor ${fmt(floorTenths)}%`, scoreTenths: p.t.tenths, floorTenths, survivors: p.t.survivors };
}

/** The floors with `group`'s set to floor(score, 1 dp), refusing to lower one that exists. */
export function setFloor(group: string, report: Report, floors: Floors, equivalents: readonly string[] = []): Refused | { exit: 0; why: string; floors: Floors } {
  const p = prepare(group, report, equivalents);
  if ("exit" in p) return p;
  const was = floors[group];
  if (was !== undefined && p.t.tenths < Math.round(was * 10)) return { exit: 2, why: `refusing to lower the floor of "${group}" from ${fmt(Math.round(was * 10))}% to ${fmt(p.t.tenths)}%: a floor only rises` };
  return { exit: 0, why: `${group}: floor ${was === undefined ? "set" : `${fmt(Math.round(was * 10))}% ->`} ${fmt(p.t.tenths)}% (score ${describeScore(p.t)})`, floors: { ...floors, [group]: p.t.tenths / 10 } };
}

/** The groups whose floor is lower in `now` than in `was`, or gone, in the order `was` lists them. A group added in `now` is not one. */
export function floorDiff(was: Floors, now: Floors): { group: string; was: number; now: number | null }[] {
  const out: { group: string; was: number; now: number | null }[] = [];
  for (const [group, w] of Object.entries(was)) {
    const n = now[group];
    if (n === undefined) out.push({ group, was: w, now: null });
    else if (Math.round(n * 10) < Math.round(w * 10)) out.push({ group, was: w, now: n });
  }
  return out;
}

/** The non-probe groups with no floor, once ANY floor exists (a missing entry is a failure, never a skip: review 4, R4-m3).
 *  Nothing is missing while no floor exists at all: that is PR-A's state. */
export function missingFloors(groups: readonly string[], floors: Floors): string[] {
  if (Object.keys(floors).length === 0) return [];
  return groups.filter((g) => g !== "probe" && floors[g] === undefined);
}

/** SURVIVORS.md: one `file:line:col mutator → replacement` line for each Survived / NoCoverage mutant not recorded equivalent. */
export function survivorsMarkdown(group: string, report: Report, equivalents: readonly string[]): string {
  const t = tally(report, equivalents);
  const lines = [`# Survivors: ${group}`, ""];
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
  out(`stryker-floor: compared ${Object.keys(was).length} group(s) against ${ref}: ${diff.length} lowered or removed`);
  for (const d of diff) out(`  ${d.group}: ${d.was} -> ${d.now ?? "(removed)"}`);
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
        "set-floor": { type: "boolean" },
        "check-file-against": { type: "string" },
        survivors: { type: "boolean" },
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
    const modes = (["check", "set-floor", "check-file-against", "survivors"] as const).filter((m) => values[m] !== undefined);
    if (modes.length !== 1) throw new Refusal(`exactly one mode is required\n${USAGE}`);
    const mode = modes[0]!;
    const need = mode === "check-file-against" ? 0 : 2;
    if (positionals.length !== need) throw new Refusal(`${mode} takes ${need === 0 ? "no positional arguments" : "<group> <mutation.json>"}\n${USAGE}`);
    if (values.out !== undefined && mode !== "survivors") throw new Refusal(`--out belongs to --survivors\n${USAGE}`);
    if (values["skip-if-no-floors"] !== undefined && mode !== "check") throw new Refusal(`--skip-if-no-floors belongs to --check\n${USAGE}`);

    if (mode === "check-file-against") return checkFileAgainst(values["check-file-against"] ?? "");

    const [group = "", reportPath = ""] = positionals;
    const report = parseReport(readText(reportPath, "the mutation report"));

    if (mode === "survivors") {
      if (values.out === undefined || values.out === "") throw new Refusal(`--survivors needs --out <file>\n${USAGE}`);
      if (GROUPS[group] === undefined) throw new Refusal(`unknown group "${group}": expected one of ${Object.keys(STRYKER_GROUPS).join(", ")}`);
      const outside = outsideGroup(group, report);
      if (outside.length > 0) throw new Refusal(`the report is not group "${group}"'s: it mutated ${outside.slice(0, 3).join(", ")}, outside the group's files and line ranges`);
      const equivalents = readEquivalents();
      const md = survivorsMarkdown(group, report, equivalents);
      mkdirSync(dirname(resolve(values.out)), { recursive: true });
      writeFileSync(resolve(values.out), md);
      const t = tally(report, equivalents);
      out(`stryker-floor: survivors ${group}: ${t.survivors.length} listed, ${t.equivalent} equivalent excluded -> ${values.out}`);
      return 0;
    }

    const floorText = readText(FLOOR_FILE, FLOOR_FILE);
    const floors = parseFloors(floorText);
    const equivalents = readEquivalents();

    if (mode === "set-floor") {
      const r = setFloor(group, report, floors, equivalents);
      if (r.exit === 2) throw new Refusal(r.why);
      const raw = JSON.parse(floorText) as Record<string, unknown>;
      writeFileSync(resolve(FLOOR_FILE), `${JSON.stringify({ ...raw, groups: r.floors }, null, 2)}\n`);
      out(`stryker-floor: ${r.why}`);
      return 0;
    }

    // --check
    if (values["skip-if-no-floors"] === true && Object.keys(floors).length === 0) {
      // PR-A's state. The report must still prove the group ran: a refusal here is a refusal, never a skip.
      const p = prepare(group, report, equivalents);
      if ("exit" in p) throw new Refusal(p.why);
      out(`stryker-floor: no floor yet: PR-B sets it (${group}: score ${describeScore(p.t)})`);
      return 0;
    }
    const v = check(group, report, floors, equivalents);
    if (v.exit === 2) throw new Refusal(v.why);
    out(`stryker-floor: ${v.why}`);
    if (v.exit === 1) for (const s of v.survivors) out(s);
    return v.exit;
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    err(`stryker-floor: ${e.message}`);
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
