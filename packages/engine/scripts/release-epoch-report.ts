// CLI: node --experimental-strip-types packages/engine/scripts/release-epoch-report.ts --from <ref> --to <ref> [--annotate] [--summary <file>]
// A release-time WARNING (owner-approved 2026-10-15): which sports a production release locks out for older capture apps.
//
// Native clients send their FOLD_EPOCH (src/sport/fold-epoch.ts) and the server refuses a score write from one whose epoch for the fixture's
// sport is LOWER than its own (426 ENGINE_OUTDATED, engine-split D31). Production deploys on any `v*.*.*` tag (.github/workflows/prod.yml), and
// nothing told whoever cut the tag that it raised an epoch, so every scorer on an older app would find out from a refused write. This reads the
// table at two refs and names every sport whose MAJOR rose between them. It WARNS and never gates: prod.yml runs it with `continue-on-error`.
//
// Per sport (reportEpochChanges is pure and carries the rule):
//   - FOLD_EPOCH rose:   `<sport>: FOLD_EPOCH a -> b — capture apps older than this engine will be refused for <sport> (426 ENGINE_OUTDATED)`
//   - FOLD_EPOCH fell:   reported as LOWERED (fold-epoch:check refuses a fall, so this means the guard was bypassed)
//   - sport added / removed between the refs: listed, not warned about
//   - FOLD_MINOR changed (the table may declare one; a ref that does not reads as minor 0 for every sport): information, "no app update needed"
// A comparison that cannot be made says which of five ways it could not (ReportStatus), in one line: the baseline has no table (older tags
// predate fold-epoch.ts: not a warning), the target has none, a ref git cannot read, a table that does not parse, or two tables with no sport
// in common (a run that compared nothing is never a clean pass, same rule as the guard). A table with a sport key outside [a-z0-9_-] is
// unparseable too: a key is printed at the start of a line, and GitHub reads `::error::...` from the start of any line.
//
// THE CLI reads the table from `git` at each ref (rev-parse, ls-tree, cat-file, all relative to this engine's directory, so it works with the
// engine at packages/engine or at a repository root) and EVALUATES it the way the guard evaluates its baseline: the source text is written to a
// temp .mts and imported, never imported from the ref by path, so the report is what that ref's own commit declared. That works only while
// src/sport/fold-epoch.ts imports nothing, which a test holds. The module is the repository's own code at a tag its maintainers cut: it is
// run, not sandboxed.
//   --from <ref>      required: the baseline (prod.yml: the previous `v*.*.*` tag).
//   --to <ref>        required: the release being cut (prod.yml: HEAD).
//   --annotate        also print a GitHub `::warning::` workflow command for every line that deserves one (a raised or lowered epoch, and any
//                     comparison that could not be made, except a baseline that has no table at all).
//   --summary <file>  append a Markdown section to <file> (prod.yml: $GITHUB_STEP_SUMMARY). A file it cannot write is reported on stderr.
// Exit codes:
//   0  always, for any table, ref or comparison: this is a report, and a report must never fail a deploy;
//   2  usage (a missing or unknown flag): a wiring mistake, caught by the tests;
//   3  a crash in the reporter itself (an unexpected error is not a verdict; a bare uncaught exception would exit 1).
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/main-module.ts";

// ------------------------------------------------------------------------------------------------------------ the rule (pure)

/** What a ref's table declares. `minors` is null when the file declares no FOLD_MINOR (a ref from before it): every sport reads as minor 0. */
export interface EpochTables {
  epochs: Readonly<Record<string, number>>;
  minors: Readonly<Record<string, number>> | null;
}

/** One side of the comparison, as read: what the ref holds at src/sport/fold-epoch.ts. */
export type SideRead =
  | { kind: "absent" } //                              the ref is a commit and has no such file
  | { kind: "unreadable"; reason: string } //          the ref, or git, could not be asked
  | { kind: "unparseable"; reason: string } //         the file is there and is not a table the guard would accept
  | { kind: "table"; tables: EpochTables };

/** Why a report ended where it did: `compared` is the only status that compared at least one sport. */
export type ReportStatus = "compared" | "no-baseline" | "no-target" | "unreadable" | "unparseable" | "nothing-compared";

export interface Change {
  sport: string;
  from: number;
  to: number;
}
export interface Presence {
  sport: string;
  epoch: number;
}
export interface Report {
  status: ReportStatus;
  /** Sports whose epoch was compared: present in BOTH tables. Zero is never a clean run (status `nothing-compared`). */
  compared: number;
  raised: Change[];
  lowered: Change[];
  added: Presence[];
  removed: Presence[];
  minor: Change[];
  /** The report, one line each: the changes, then the tally (or why nothing was compared). */
  lines: string[];
  /** The lines that deserve a `::warning::`: a raised or lowered epoch, and every comparison that could not be made but a missing baseline. */
  warnings: string[];
}

const own = (o: object, k: string): boolean => Object.hasOwn(o, k);
/** Own keys only: a plain `table[name]` answers "constructor" with a function from Object.prototype. */
const get = (o: Readonly<Record<string, number>> | null, k: string): number | undefined => (o !== null && own(o, k) ? o[k] : undefined);

const raisedLine = (sport: string, a: number, b: number): string =>
  `${sport}: FOLD_EPOCH ${a} -> ${b} — capture apps older than this engine will be refused for ${sport} (426 ENGINE_OUTDATED)`;
const loweredLine = (sport: string, a: number, b: number): string =>
  `${sport}: FOLD_EPOCH ${a} -> ${b} — LOWERED; an epoch only rises (fold-epoch:check refuses this)`;
const minorLine = (sport: string, a: number, b: number): string =>
  `${sport}: FOLD_MINOR ${a} -> ${b} — no app update needed (older capture apps are not refused for a minor change)`;

const empty = (status: ReportStatus, line: string, warn: boolean): Report => ({
  status, compared: 0, raised: [], lowered: [], added: [], removed: [], minor: [], lines: [line], warnings: warn ? [line] : [],
});

/** A side that cannot be compared, as its one-line report. `role` says which side it was, for the status. */
function unusable(side: Exclude<SideRead, { kind: "table" }>, ref: string, role: "baseline" | "target"): Report {
  switch (side.kind) {
    case "absent":
      // A baseline that predates fold-epoch.ts is expected for the first release that has one: information. A TARGET without it is a release
      // that drops every epoch, which the server's check would stop enforcing: a warning.
      return empty(role === "baseline" ? "no-baseline" : "no-target", `no FOLD_EPOCH at ${ref}; nothing to compare`, role === "target");
    case "unreadable":
      return empty("unreadable", `could not read FOLD_EPOCH at ${ref}: ${side.reason}; nothing to compare`, true);
    case "unparseable":
      return empty("unparseable", `FOLD_EPOCH at ${ref} could not be parsed (${side.reason}); nothing to compare`, true);
  }
}

/** The report for a release that goes from `from` to `to`. Pure. The baseline is judged first, so a baseline without a table is "no baseline"
 *  whatever the target holds. `refs` only name the sides in a message. */
export function reportEpochChanges(from: SideRead, to: SideRead, refs: { from: string; to: string }): Report {
  if (from.kind !== "table") return unusable(from, refs.from, "baseline");
  if (to.kind !== "table") return unusable(to, refs.to, "target");
  const before = from.tables;
  const after = to.tables;

  const raised: Change[] = [];
  const lowered: Change[] = [];
  const added: Presence[] = [];
  const removed: Presence[] = [];
  const minor: Change[] = [];
  let compared = 0;
  for (const sport of [...new Set([...Object.keys(before.epochs), ...Object.keys(after.epochs)])].sort()) {
    const a = get(before.epochs, sport);
    const b = get(after.epochs, sport);
    if (a === undefined && b !== undefined) added.push({ sport, epoch: b });
    else if (a !== undefined && b === undefined) removed.push({ sport, epoch: a });
    else if (a !== undefined && b !== undefined) {
      compared++;
      if (b > a) raised.push({ sport, from: a, to: b });
      else if (b < a) lowered.push({ sport, from: a, to: b });
      const ma = get(before.minors, sport) ?? 0;
      const mb = get(after.minors, sport) ?? 0;
      if (ma !== mb) minor.push({ sport, from: ma, to: mb });
    }
  }

  const lines = [
    ...raised.map((c) => raisedLine(c.sport, c.from, c.to)),
    ...lowered.map((c) => loweredLine(c.sport, c.from, c.to)),
    ...added.map((p) => `${p.sport}: sport added (FOLD_EPOCH ${p.epoch})`),
    ...removed.map((p) => `${p.sport}: sport removed (was FOLD_EPOCH ${p.epoch})`),
    ...minor.map((c) => minorLine(c.sport, c.from, c.to)),
  ];
  const warnings = [...raised.map((c) => raisedLine(c.sport, c.from, c.to)), ...lowered.map((c) => loweredLine(c.sport, c.from, c.to))];
  if (compared === 0) {
    // two tables that share no sport (or hold none) compared nothing, which is not "no change"
    const none = `no sport appears in FOLD_EPOCH at both ${refs.from} and ${refs.to}; nothing to compare`;
    return { status: "nothing-compared", compared, raised, lowered, added, removed, minor, lines: [...lines, none], warnings: [...warnings, none] };
  }
  lines.push(
    `${compared} sport(s) compared between ${refs.from} and ${refs.to}: ${raised.length} FOLD_EPOCH raised, ${lowered.length} lowered, ${minor.length} FOLD_MINOR changed, ${added.length} added, ${removed.length} removed`,
  );
  return { status: "compared", compared, raised, lowered, added, removed, minor, lines, warnings };
}

/** A workflow command's data, escaped the way GitHub reads it (`%`, CR and LF). */
export const annotationData = (s: string): string => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
/** Text for a Markdown line: `&` and `<` are the two characters that start an HTML entity or tag (`>` is left, `->` is in every line). */
const html = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** The Markdown section appended to the step summary: a heading naming both refs, then one bullet per report line. */
export function summaryMarkdown(report: Report, refs: { from: string; to: string }): string {
  return `### Engine fold epoch: ${html(refs.from)} -> ${html(refs.to)}\n\n${report.lines.map((l) => `- ${html(l)}`).join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------- reading a table's source

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 300);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const shown = (v: unknown): string => (typeof v === "string" ? JSON.stringify(v) : String(v));
const unparseable = (reason: string): SideRead => ({ kind: "unparseable", reason: oneLine(reason) });
/** What a sport key may be. A key is printed at the START of a report line, and GitHub reads a workflow command (`::error::...`) from the start of
 *  any stdout line, so a key with a newline in it would write one into the log. Every key in a table a ref declares is held to this before anything
 *  is printed, and shown JSON-escaped in the reason that refuses it. The registry's own keys (football, tabletennis, icehockey ...) all match. */
const SPORT_KEY = /^[a-z0-9_-]+$/;
const badKey = (table: "FOLD_EPOCH" | "FOLD_MINOR", sport: string): string =>
  `${table} has the sport key ${JSON.stringify(sport)}, and a sport key is lower-case letters, digits, "_" or "-"`;

/** What a table's source declares. The source is TypeScript: it is written to a temp .mts and imported under strip-types, so it is evaluated as
 *  its own commit wrote it and a relative import (which cannot resolve there) makes it unparseable. A source that does not load or is not a
 *  table the guard would accept comes back as `unparseable` with the reason; only a failure to make the temp directory throws. */
export async function readTables(source: string): Promise<SideRead> {
  const dir = mkdtempSync(join(tmpdir(), "release-epoch-report-"));
  try {
    const file = join(dir, "fold-epoch.mts");
    writeFileSync(file, source);
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    } catch (e) {
      return unparseable(`does not load: ${messageOf(e)}`);
    }
    const epochs = mod.FOLD_EPOCH;
    if (!isObject(epochs)) return unparseable("it has no FOLD_EPOCH object export");
    const entries = Object.entries(epochs);
    if (entries.length === 0) return unparseable("it declares no sport");
    for (const [sport, epoch] of entries) {
      if (!SPORT_KEY.test(sport)) return unparseable(badKey("FOLD_EPOCH", sport));
      if (!Number.isInteger(epoch) || (epoch as number) < 1) return unparseable(`FOLD_EPOCH.${sport} is ${shown(epoch)}, and an epoch is a positive integer`);
    }
    let minors: Record<string, number> | null = null;
    if ("FOLD_MINOR" in mod) {
      if (!isObject(mod.FOLD_MINOR)) return unparseable("FOLD_MINOR is not an object");
      for (const [sport, minor] of Object.entries(mod.FOLD_MINOR)) {
        if (!SPORT_KEY.test(sport)) return unparseable(badKey("FOLD_MINOR", sport));
        if (!Number.isInteger(minor) || (minor as number) < 0) return unparseable(`FOLD_MINOR.${sport} is ${shown(minor)}, and a minor is a non-negative integer`);
      }
      minors = { ...(mod.FOLD_MINOR as Record<string, number>) };
    }
    return { kind: "table", tables: { epochs: { ...(epochs as Record<string, number>) }, minors } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------------------------------------------------------ the CLI

const TABLE = "src/sport/fold-epoch.ts";
const ENGINE_DIR = fileURLToPath(new URL("..", import.meta.url));
const USAGE = "usage: release-epoch-report.ts --from <ref> --to <ref> [--annotate] [--summary <file>]";
const MAX_BUFFER = 64 * 1024 * 1024;

const out = (s: string): void => { process.stdout.write(`${s}\n`); };
const err = (s: string): void => { process.stderr.write(`${s}\n`); };

/** git could not be run at all (not on PATH, or an answer too big to hold): the ref is unreadable, which is not a "not a commit" that blames the ref. */
class GitFailure extends Error {}

function git(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd: ENGINE_DIR, encoding: "utf8", maxBuffer: MAX_BUFFER });
  if (r.error !== undefined) throw new GitFailure(`could not run git ${args[0] ?? ""}: ${r.error.message}`);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const unreadable = (reason: string): SideRead => ({ kind: "unreadable", reason: oneLine(reason) });

/** The table as `ref` held it. Paths are repo-root-relative to git and engine-relative to the rest of this file (`git rev-parse --show-prefix` is
 *  "packages/engine/" in the monorepo and "" in the engine's own repo). Anything git cannot list or read is `unreadable`: a ref it cannot answer
 *  for must not read as "no table", which is the one quiet answer. */
async function readRef(ref: string): Promise<SideRead> {
  try {
    const rev = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (rev.status !== 0) {
      const shallow = git(["rev-parse", "--is-shallow-repository"]).stdout.trim() === "true";
      return unreadable(`"${ref}" is not a commit in this repository${shallow ? " (this is a shallow clone: fetch the history, e.g. git fetch --unshallow --tags)" : ""}`);
    }
    const commit = rev.stdout.trim();
    const prefix = git(["rev-parse", "--show-prefix"]).stdout.trim();
    const ls = git(["ls-tree", "-r", "-z", "--name-only", "--full-name", commit, "--", TABLE]); // the pathspec is relative to cwd, the names printed are not
    if (ls.status !== 0) return unreadable(`git ls-tree ${ref} failed: ${ls.stderr.trim()}`);
    if (!ls.stdout.split("\0").includes(`${prefix}${TABLE}`)) return { kind: "absent" };
    const blob = git(["cat-file", "blob", `${commit}:${prefix}${TABLE}`]);
    if (blob.status !== 0) return unreadable(`git cat-file ${ref}:${TABLE} failed: ${blob.stderr.trim()}`);
    return await readTables(blob.stdout);
  } catch (e) {
    if (e instanceof GitFailure) return unreadable(e.message);
    throw e;
  }
}

/** A flag the caller got wrong: exit 2, never a report. */
class UsageError extends Error {}

interface Options {
  from: string;
  to: string;
  annotate: boolean;
  summary: string | undefined;
}

function parse(argv: string[]): Options {
  let values: { from?: string; to?: string; annotate?: boolean; summary?: string };
  try {
    values = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: { from: { type: "string" }, to: { type: "string" }, annotate: { type: "boolean" }, summary: { type: "string" } },
    }).values;
  } catch (e) {
    throw new UsageError(`${messageOf(e)}\n${USAGE}`);
  }
  for (const name of ["from", "to"] as const) {
    const v = values[name];
    if (v === undefined) throw new UsageError(`--${name} <ref> is required\n${USAGE}`);
    if (v === "" || v.startsWith("-")) throw new UsageError(`"${v}" is not a ref\n${USAGE}`);
  }
  if (values.summary === "") throw new UsageError(`--summary needs a file name\n${USAGE}`);
  return { from: values.from as string, to: values.to as string, annotate: values.annotate === true, summary: values.summary };
}


/** Runs one CLI invocation and returns its exit code (the entry point at the bottom sets `process.exitCode` from it). */
export async function main(argv: string[]): Promise<number> {
  let opts: Options;
  try {
    opts = parse(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`release-epoch: ${e.message}`);
    return 2;
  }
  const refs = { from: opts.from, to: opts.to };
  const report = reportEpochChanges(await readRef(opts.from), await readRef(opts.to), refs);
  for (const line of report.lines) out(line);
  if (opts.annotate) for (const warning of report.warnings) out(`::warning::${annotationData(warning)}`);
  if (opts.summary !== undefined) {
    try {
      appendFileSync(opts.summary, summaryMarkdown(report, refs));
    } catch (e) {
      err(`release-epoch: could not write the summary file ${opts.summary}: ${messageOf(e)}`);
    }
  }
  return 0;
}

// Main-module guard: importing this file from a test must not run it. isMainModule compares REAL paths (a checkout under a symlinked
// directory gives argv[1] the link and import.meta.url the target; a reporter that compared the two as given would print nothing and exit 0).
if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e: unknown) => {
      err(`release-epoch: the reporter itself crashed (this is not a verdict): ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      process.exitCode = 3;
    },
  );
}
